import { describe, expect, test, mock } from "bun:test";
import {
  ANTIGRAVITY_CLI_VERSION,
  ANTIGRAVITY_GOOG_API_CLIENT_UA,
  CLAUDE_CODE_HEADERS,
  CLAUDE_CODE_OAUTH_BETA,
  FINGERPRINT_SALT,
  antigravityUserAgent,
  claudeCodeSessionId,
  computeFingerprint,
  extractFirstUserMessageText,
  getAttributionHeader,
  getClaudeCodeSystemPrefix,
  getClaudeCodeUserAgent,
  getOpenCodexVersion,
  resetClaudeCodeSessionIdForTests,
} from "../src/adapters/client-fingerprint";
import { createAnthropicAdapter } from "../src/adapters/anthropic";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

function parsed(): OcxParsedRequest {
  return {
    modelId: "claude-opus-4-6",
    stream: false,
    options: {},
    context: { systemPrompt: ["You are Codex, a coding agent based on GPT-5."], messages: [{ role: "user", content: "hi" }, { role: "assistant", content: [{ type: "text", text: "hello" }] }] },
  } as unknown as OcxParsedRequest;
}

describe("client fingerprint — helpers", () => {
  test("antigravity UA has the real CLI shape, never the literal giveaway", async () => {
    const ua = antigravityUserAgent();
    expect(ua).toBe(`antigravity/cli/${ANTIGRAVITY_CLI_VERSION} (aidev_client; os_type=darwin; arch=arm64)`);
    expect(ua).not.toBe("antigravity");
  });

  test("antigravity UA honors an explicit version override", async () => {
    expect(antigravityUserAgent("9.9.9")).toBe("antigravity/cli/9.9.9 (aidev_client; os_type=darwin; arch=arm64)");
  });

  test("GOOGLE_ANTIGRAVITY_USER_AGENT env override wins over the default UA", async () => {
    const prev = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
    process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = "custom-ua/1.2.3";
    try {
      // Fresh module instance so the env-driven constant is re-evaluated at import time.
      const mod = await import(`../src/adapters/google-antigravity-wire?override=${Date.now()}`);
      expect(mod.ANTIGRAVITY_REQUEST_UA).toBe("custom-ua/1.2.3");
    } finally {
      if (prev === undefined) delete process.env.GOOGLE_ANTIGRAVITY_USER_AGENT;
      else process.env.GOOGLE_ANTIGRAVITY_USER_AGENT = prev;
    }
  });

  test("secondary google api client UA is pinned", async () => {
    expect(ANTIGRAVITY_GOOG_API_CLIENT_UA).toMatch(/^google-api-nodejs-client\/[\d.]+$/);
  });

  test("version and UA match the official claude-cli shape", async () => {
    expect(getOpenCodexVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(getClaudeCodeUserAgent()).toBe(`claude-cli/${getOpenCodexVersion()}`);
  });

  test("claude session id is a random v4-shaped uuid per process", async () => {
    resetClaudeCodeSessionIdForTests();
    const a = claudeCodeSessionId();
    const b = claudeCodeSessionId();
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(a).not.toContain("oauth-tok");
  });

  test("fresh module instance gives a different session id", async () => {
    resetClaudeCodeSessionIdForTests();
    const first = claudeCodeSessionId();
    const mod = await import(`../src/adapters/client-fingerprint?override=${Date.now()}`);
    mod.resetClaudeCodeSessionIdForTests();
    const second = mod.claudeCodeSessionId();
    expect(first).not.toBe(second);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("fingerprint uses the official salt and first-message characters", async () => {
    expect(FINGERPRINT_SALT).toBe("59cf53e54c78");
    const msg = "hello world, this is a test message";
    const version = "2.15.1";
    const chars = [msg[4] ?? "0", msg[7] ?? "0", msg[20] ?? "0"].join("");
    const expected = require("node:crypto").createHash("sha256").update(`${FINGERPRINT_SALT}${chars}${version}`).digest("hex").slice(0, 3);
    expect(computeFingerprint(msg, version)).toBe(expected);
  });

  test("extractFirstUserMessageText pulls text from string or content-part messages", async () => {
    expect(extractFirstUserMessageText([{ role: "user", content: "plain text" } as any])).toBe("plain text");
    expect(
      extractFirstUserMessageText([
        { role: "assistant", content: [{ type: "text", text: "assistant" }] },
        { role: "user", content: [{ type: "text", text: "part text" }] },
      ] as any)
    ).toBe("part text");
    expect(extractFirstUserMessageText([{ role: "developer", content: "dev text" }] as any)).toBe("dev text");
    expect(extractFirstUserMessageText([{ role: "user", content: [] }] as any)).toBe("");
  });

  test("attribution header contains version+fingerprint, cch placeholder, and workload", async () => {
    const header = getAttributionHeader("abc");
    expect(header).toMatch(/^x-anthropic-billing-header: cc_version=.+\.abc; cc_entrypoint=cli; cch=00000; cc_workload=interactive$/);
    expect(header).toContain(`cc_version=${getOpenCodexVersion()}.abc`);
  });

  test("CLI system prefix matches the official interactive default", async () => {
    expect(getClaudeCodeSystemPrefix()).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(getClaudeCodeSystemPrefix({ isNonInteractive: true, hasAppendSystemPrompt: true })).toBe(
      "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
    );
    expect(getClaudeCodeSystemPrefix({ isNonInteractive: true })).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
  });

  test("OAuth beta constant is just the OAuth value", async () => {
    expect(CLAUDE_CODE_OAUTH_BETA).toBe("oauth-2025-04-20");
  });

  test("CLAUDE_CODE_HEADERS legacy constant only carries x-app", async () => {
    expect(CLAUDE_CODE_HEADERS["X-App"]).toBe("cli");
    expect(CLAUDE_CODE_HEADERS["X-Stainless-Runtime"]).toBeUndefined();
  });
});

describe("client fingerprint — anthropic OAuth headers", () => {
  const oauthProvider = { adapter: "anthropic", authMode: "oauth", baseUrl: "https://api.anthropic.com", apiKey: "oauth-tok-123" } as unknown as OcxProviderConfig;
  const apiKeyProvider = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", apiKey: "sk-ant-123" } as unknown as OcxProviderConfig;

  test("OAuth request carries the first-party x-app/session/request-id headers", async () => {
    mock.module("../src/oauth", () => ({ getValidAccessTokenSnapshot: async () => ({ provider: "anthropic", accountId: "00000000-0000-4000-8000-000000000001", generation: "g1", accessToken: "oauth-tok-123" }) }));
    const { headers } = await createAnthropicAdapter(oauthProvider, undefined, "anthropic").buildRequest(parsed());
    expect(headers["x-app"]).toBe("cli");
    expect(headers["X-Claude-Code-Session-Id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(headers["x-client-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(headers["User-Agent"]).toBe(`claude-cli/${getOpenCodexVersion()}`);
    expect(headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(headers["Authorization"]).toBe("Bearer oauth-tok-123");
    expect(headers["X-Stainless-Runtime"]).toBeUndefined();
  });

  test("session id is stable across requests in the same process", async () => {
    mock.module("../src/oauth", () => ({ getValidAccessTokenSnapshot: async () => ({ provider: "anthropic", accountId: "00000000-0000-4000-8000-000000000001", generation: "g1", accessToken: "oauth-tok-123" }) }));
    const a = (await createAnthropicAdapter(oauthProvider, undefined, "anthropic").buildRequest(parsed())).headers["X-Claude-Code-Session-Id"];
    const b = (await createAnthropicAdapter(oauthProvider, undefined, "anthropic").buildRequest(parsed())).headers["X-Claude-Code-Session-Id"];
    expect(a).toBe(b);
  });

  test("per-request id differs between requests", async () => {
    mock.module("../src/oauth", () => ({ getValidAccessTokenSnapshot: async () => ({ provider: "anthropic", accountId: "00000000-0000-4000-8000-000000000001", generation: "g1", accessToken: "oauth-tok-123" }) }));
    const a = (await createAnthropicAdapter(oauthProvider, undefined, "anthropic").buildRequest(parsed())).headers["x-client-request-id"];
    const b = (await createAnthropicAdapter(oauthProvider, undefined, "anthropic").buildRequest(parsed())).headers["x-client-request-id"];
    expect(a).not.toBe(b);
  });

  test("API-key mode does NOT get OAuth-only headers", async () => {
    const { headers } = await createAnthropicAdapter(apiKeyProvider).buildRequest(parsed());
    expect(headers["x-api-key"]).toBe("sk-ant-123");
    expect(headers["x-app"]).toBeUndefined();
    expect(headers["X-Claude-Code-Session-Id"]).toBeUndefined();
    expect(headers["anthropic-beta"]).toBeUndefined();
  });

  test("OAuth system prompt starts with attribution header then CLI prefix", async () => {
    mock.module("../src/oauth", () => ({ getValidAccessTokenSnapshot: async () => ({ provider: "anthropic", accountId: "00000000-0000-4000-8000-000000000001", generation: "g1", accessToken: "oauth-tok-123" }) }));
    const { body } = await createAnthropicAdapter(oauthProvider, undefined, "anthropic").buildRequest(parsed());
    const parsedBody = JSON.parse(body as string);
    const system = parsedBody.system as Array<{ type: string; text: string }>;
    expect(system[0].text).toMatch(/^x-anthropic-billing-header: cc_version=/);
    expect(system[1].text).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(system[2].text).toContain("coding agent");
  });

  test("OAuth request body carries metadata.user_id with device/account/session", async () => {
    mock.module("../src/oauth", () => ({ getValidAccessTokenSnapshot: async () => ({ provider: "anthropic", accountId: "00000000-0000-4000-8000-000000000002", generation: "g1", accessToken: "oauth-tok-123" }) }));
    const { body } = await createAnthropicAdapter(oauthProvider, undefined, "anthropic").buildRequest(parsed());
    const parsedBody = JSON.parse(body as string);
    const userId = JSON.parse(parsedBody.metadata.user_id as string) as { device_id: string; account_uuid: string; session_id: string };
    expect(userId.device_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(userId.account_uuid).toBe("00000000-0000-4000-8000-000000000002");
    expect(userId.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  test("Accept negotiates SSE for a streaming request", async () => {
    mock.module("../src/oauth", () => ({ getValidAccessTokenSnapshot: async () => ({ provider: "anthropic", accountId: "00000000-0000-4000-8000-000000000001", generation: "g1", accessToken: "oauth-tok-123" }) }));
    const streaming = { ...parsed(), stream: true } as OcxParsedRequest;
    const { headers } = await createAnthropicAdapter(oauthProvider, undefined, "anthropic").buildRequest(streaming);
    expect(headers["Accept"]).toBe("text/event-stream");
    expect(headers["User-Agent"]).toBe(`claude-cli/${getOpenCodexVersion()}`);
  });
});
