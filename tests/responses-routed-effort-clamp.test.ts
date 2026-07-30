/**
 * Routed-model effort clamp on the openai-responses path. The responses adapter is a
 * verbatim passthrough and never called mapReasoningEffort, so routed models (e.g.
 * Ollama /v1/responses) received the caller's reasoning.effort unclamped and 400'd on
 * tiers they don't expose (xhigh/ultra). core.ts now clamps routed effort to the
 * provider's supported ladder (nearest rung, tie -> higher) before forwarding.
 */
import { afterEach, describe, expect, test } from "bun:test";
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