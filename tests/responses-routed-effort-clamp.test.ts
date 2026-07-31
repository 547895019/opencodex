/**
 * Routed-model effort clamp on the openai-responses path. The responses adapter is a
 * verbatim passthrough and never called mapReasoningEffort, so routed models (e.g.
 * Ollama /v1/responses) received the caller's reasoning.effort unclamped and 400'd on
 * tiers they don't expose (xhigh/ultra). core.ts now clamps routed effort to the
 * provider's supported ladder (nearest rung, tie -> higher) before forwarding.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function ollamaConfig(reasoningEfforts?: string[]): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "ollama",
    providers: {
      ollama: {
        adapter: "openai-responses",
        baseUrl: "http://localhost:11434/v1",
        authMode: "key",
        apiKey: "test-ollama-key",
        ...(reasoningEfforts ? { reasoningEfforts } : {}),
      },
    },
  } as OcxConfig;
}

async function post(config: OcxConfig, effort: string): Promise<{ status: number; effort: string | undefined }> {
  let forwarded: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    forwarded = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return Response.json({
      id: "resp_test",
      object: "response",
      status: "completed",
      model: "glm-5.2:cloud",
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
  }) as typeof fetch;

  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "ollama/glm-5.2:cloud",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: false,
      reasoning: { effort },
    }),
  }), config, { model: "", provider: "" });

  // The openai-responses adapter serializes effort as top-level `reasoning_effort`.
  const reasoning = forwarded.reasoning as { effort?: string } | undefined;
  const effort2 = typeof forwarded.reasoning_effort === "string" ? forwarded.reasoning_effort : undefined;
  return { status: response.status, effort: effort2 ?? reasoning?.effort };
}

describe("responses-path routed effort clamp", () => {
  test("xhigh maps to max on a [low,medium,high,max] ladder (tie -> higher)", async () => {
    const { status, effort } = await post(ollamaConfig(["low", "medium", "high", "max"]), "xhigh");
    expect(status).toBe(200);
    expect(effort).toBe("max");
  });

  test("a supported effort passes through unchanged", async () => {
    const { status, effort } = await post(ollamaConfig(["low", "medium", "high", "max"]), "high");
    expect(status).toBe(200);
    expect(effort).toBe("high");
  });

  test("max stays max (in ladder)", async () => {
    const { effort } = await post(ollamaConfig(["low", "medium", "high", "max"]), "max");
    expect(effort).toBe("max");
  });

  test("ultra (client-converted to max) maps to max", async () => {
    const { effort } = await post(ollamaConfig(["low", "medium", "high", "max"]), "ultra");
    expect(effort).toBe("max");
  });

  test("xhigh above a [low,medium,high] ladder clamps down to high (no tie)", async () => {
    const { effort } = await post(ollamaConfig(["low", "medium", "high"]), "xhigh");
    expect(effort).toBe("high");
  });

  test("no declared ladder -> passthrough unchanged (no clamp, no rewrite)", async () => {
    const { effort } = await post(ollamaConfig(undefined), "xhigh");
    expect(effort).toBe("xhigh");
  });
});

const REACTIVE_USER_ERROR = `{"error":{"message":"invalid reasoning value: 'xhigh' (must be \\"high\\", \\"medium\\", \\"low\\", \\"max\\", or \\"none\\")","type":"invalid_request_error","param":null,"code":null}}`;

describe("responses-path reactive effort clamp (no declared ladder)", () => {
  let testDir = "";
  let previousHome: string | undefined;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "ocx-effort-clamp-"));
    previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = testDir;
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test("xhigh 400s once, persists learned ladder, retries with max -> 200", async () => {
    const config = ollamaConfig(undefined);
    let callCount = 0;
    let lastForwarded: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      callCount += 1;
      lastForwarded = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (callCount === 1) {
        return new Response(REACTIVE_USER_ERROR, {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return Response.json({
        id: "resp_test",
        object: "response",
        status: "completed",
        model: "glm-5.2:cloud",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ollama/glm-5.2:cloud",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        stream: false,
        reasoning: { effort: "xhigh" },
      }),
    }), config, { model: "", provider: "" });

    // Exactly two upstream calls: first 400'd, second succeeded with the clamped effort.
    expect(callCount).toBe(2);
    expect(response.status).toBe(200);
    const reasoning = lastForwarded.reasoning as { effort?: string } | undefined;
    const effort2 = typeof lastForwarded.reasoning_effort === "string" ? lastForwarded.reasoning_effort : undefined;
    expect(effort2 ?? reasoning?.effort).toBe("max");

    // In-memory config mutated with the learned ladder.
    expect(config.providers.ollama?.modelReasoningEfforts?.["glm-5.2:cloud"]).toEqual(["low", "medium", "high", "max"]);

    // Persisted to disk (set-and-forget).
    const configPath = join(testDir, "config.json");
    expect(existsSync(configPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as OcxConfig;
    expect(persisted.providers.ollama?.modelReasoningEfforts?.["glm-5.2:cloud"]).toEqual(["low", "medium", "high", "max"]);
  });

  test("explicit user-declared ladder is never clobbered by the reactive clamp", async () => {
    // User declared a ladder that does NOT include xhigh or max — reactive clamp must not touch it.
    const config = ollamaConfig(["low", "medium", "high"]);
    let callCount = 0;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      callCount += 1;
      JSON.parse(String(init?.body ?? "{}"));
      // First call: xhigh was pre-clamped to high (in-ladder), upstream still 400s for some reason.
      if (callCount === 1) {
        return new Response(REACTIVE_USER_ERROR, { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({
        id: "resp_test", object: "response", status: "completed", model: "glm-5.2:cloud",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }) as typeof fetch;

    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "ollama/glm-5.2:cloud",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
        stream: false,
        reasoning: { effort: "xhigh" },
      }),
    }), config, { model: "", provider: "" });

    // Ladder was already declared, so the reactive branch's clobber-guard skips it; the 400
    // surfaces to the client (no infinite retry loop).
    expect(callCount).toBe(1);
    expect(response.status).toBe(400);
    expect(config.providers.ollama?.modelReasoningEfforts).toBeUndefined();
  });
});