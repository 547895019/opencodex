/**
 * Tests for the `backend:"routed"` vision sidecar — pre-describing images via an arbitrary
 * routed provider/model through the normal routing pipeline (src/vision/routed-describe.ts),
 * plus the planning/management-validation branches that admit the new backend.
 *
 * The executor is driven end-to-end with a real OcxConfig (an openai-chat provider whose
 * baseUrl points at a mocked globalThis.fetch returning chat-completions SSE), mirroring the
 * responses-vision-mark-400 test harness. providerFetch falls through to globalThis.fetch, and
 * the private-network guard is config-validation-time only, so no network egress occurs.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as oauthModule from "../src/oauth";

// OAuth providers (kimi/xai/github-copilot/kiro) carry no static apiKey — the routed executor
// must resolve an access token via getValidAccessToken before buildRequest. Mock it so the test
// never touches real OAuth state.
mock.module("../src/oauth", () => ({ ...oauthModule, getValidAccessToken: async () => "routed-oauth-token" }));

import type { OcxConfig, OcxProviderConfig } from "../src/types";
import { parseRequest } from "../src/responses/parser";
import { describeImageRouted } from "../src/vision/routed-describe";
import { planVisionSidecar, shouldResolveOpenAiVisionSidecar } from "../src/vision";

const originalFetch = globalThis.fetch;

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";

const routedProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://routed.test/v1",
  authMode: "key",
  apiKey: "routed-key",
};

const oauthRoutedProvider: OcxProviderConfig = {
  adapter: "openai-chat",
  baseUrl: "https://oauth-routed.test/v1",
  authMode: "oauth",
};

function routedConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "routed",
    providers: { routed: routedProvider },
    ...overrides,
  } as OcxConfig;
}

/** A chat-completions 200 SSE stream (openai-chat parseStream shape): one content delta + finish + [DONE]. */
function chatSseStream(text: string): Response {
  const body = [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

const settings = { model: "routed/llava", timeoutMs: 5000 };

beforeEach(() => {
  globalThis.fetch = originalFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("routed vision sidecar executor (describeImageRouted)", () => {
  test("happy path: accumulates text_delta chunks into a description", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return chatSseStream("A red square with the word STOP transcribed verbatim.");
    }) as typeof fetch;
    const out = await describeImageRouted(
      PNG_DATA_URL, "high", "what is in this picture?", "routed/llava", routedConfig(), settings,
    );
    expect(calls).toBe(1);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("A red square with the word STOP transcribed verbatim.");
  });

  test("happy path with empty contextText omits the text part but still describes", async () => {
    globalThis.fetch = (async () => chatSseStream("a chart trending up")) as typeof fetch;
    const out = await describeImageRouted(PNG_DATA_URL, undefined, "", "routed/llava", routedConfig(), settings);
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("a chart trending up");
  });

  test("HTTP 400 -> {error: 'routed vision sidecar HTTP 400: ...'}", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "this model does not support image input" }), { status: 400 })) as typeof fetch;
    const out = await describeImageRouted(PNG_DATA_URL, undefined, "", "routed/llava", routedConfig(), settings);
    expect(out.text).toBe("");
    expect(out.error).toContain("routed vision sidecar HTTP 400:");
    expect(out.error).toContain("this model does not support image input");
  });

  test("invalid image URL scheme -> {error} before any fetch", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return chatSseStream("x"); }) as typeof fetch;
    const out = await describeImageRouted("ftp://example/x.png", undefined, "", "routed/llava", routedConfig(), settings);
    expect(called).toBe(false);
    expect(out.text).toBe("");
    expect(out.error).toBe("unsupported image URL scheme (expected data: or https:)");
  });

  test("unresolvable routed model -> {error} before any fetch", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return chatSseStream("x"); }) as typeof fetch;
    // No configured provider can resolve "ghost/llava" (empty providers, no default) -> routeModel throws.
    const noProviderConfig = { port: 10100, defaultProvider: "none", providers: {} } as OcxConfig;
    const out = await describeImageRouted(PNG_DATA_URL, undefined, "", "ghost/llava", noProviderConfig, settings);
    expect(called).toBe(false);
    expect(out.text).toBe("");
    expect(out.error).toContain("routed vision sidecar:");
    expect(out.error).toContain("ghost/llava");
  });

  test("upstream 200 with an inline error frame -> {error} (no truncated description)", async () => {
    const body = `data: ${JSON.stringify({ error: { message: "model has no vision capability" } })}\n\ndata: [DONE]\n\n`;
    globalThis.fetch = (async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } })) as typeof fetch;
    const out = await describeImageRouted(PNG_DATA_URL, undefined, "", "routed/llava", routedConfig(), settings);
    expect(out.text).toBe("");
    expect(out.error).toBe("model has no vision capability");
  });

  test("OAuth provider: resolves an access token and sends it as Bearer before buildRequest", async () => {
    let capturedAuth: string | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      const headers = new Headers(init?.headers as HeadersInit);
      capturedAuth = headers.get("authorization");
      return chatSseStream("described via oauth provider");
    }) as typeof fetch;
    const oauthConfig = routedConfig({
      defaultProvider: "oauth-routed",
      providers: { "oauth-routed": oauthRoutedProvider },
    });
    const out = await describeImageRouted(
      PNG_DATA_URL, undefined, "", "oauth-routed/k3", oauthConfig, { ...settings, model: "oauth-routed/k3" },
    );
    expect(out.error).toBeUndefined();
    expect(out.text).toBe("described via oauth provider");
    // The mocked getValidAccessToken returns "routed-oauth-token" — it must reach the upstream
    // as a Bearer header (the openai-chat adapter sets Authorization from apiKey).
    expect(capturedAuth).toBe("Bearer routed-oauth-token");
  });
});

describe("routed vision planning (planVisionSidecar / shouldResolveOpenAiVisionSidecar)", () => {
  const blindProvider: OcxProviderConfig = { ...routedProvider, noVisionModels: ["blind"] };

  function imageRequest() {
    return parseRequest({
      model: "routed/blind",
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "describe this" },
        { type: "input_image", image_url: PNG_DATA_URL },
      ]}],
    });
  }

  test("backend routed + cfg.model -> routed plan carrying the routed model id", () => {
    const cfg = routedConfig({
      providers: { routed: blindProvider },
      visionSidecar: { backend: "routed", model: "routed/llava" },
    });
    const plan = planVisionSidecar(cfg, blindProvider, "blind", imageRequest(), undefined);
    expect(plan).toMatchObject({ backend: "routed", routedModel: "routed/llava" });
    expect(plan!.settings.model).toBe("routed/llava");
    expect(plan!.maxDescriptionsPerTurn).toBeGreaterThan(0);
  });

  test("backend routed without cfg.model -> undefined (fail closed; caller strips the image)", () => {
    const cfg = routedConfig({
      providers: { routed: blindProvider },
      visionSidecar: { backend: "routed" },
    });
    expect(planVisionSidecar(cfg, blindProvider, "blind", imageRequest(), undefined)).toBeUndefined();
  });

  test("shouldResolveOpenAiVisionSidecar is false for routed backend (no ChatGPT forward needed)", () => {
    const cfg = routedConfig({
      providers: { routed: blindProvider },
      visionSidecar: { backend: "routed", model: "routed/llava" },
    });
    expect(shouldResolveOpenAiVisionSidecar(cfg, blindProvider, "blind", imageRequest())).toBe(false);
  });
});