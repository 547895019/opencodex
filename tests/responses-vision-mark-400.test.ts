/**
 * End-to-end tests for reactive auto-marking of `noVisionModels` on the responses path
 * (src/server/responses/core.ts). When a routed text-only model 400s on an image-unsupported
 * error, the proxy marks it text-only (persisted to config), strips the image, and retries —
 * so the user never hand-edits config. Ollama is registry-pinned to the openai-chat wire, whose
 * adapter rebuilds from `parsed.context.messages`, so `stripImagesInPlace` reaches the upstream.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleResponses } from "../src/server/responses";
import type { OcxConfig } from "../src/types";

const originalFetch = globalThis.fetch;
let testDir = "";
let previousHome: string | undefined;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-vision-mark-"));
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

function ollamaConfig(noVisionModels?: string[]): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "ollama",
    providers: {
      ollama: {
        adapter: "openai-responses",
        baseUrl: "http://localhost:11434/v1",
        authMode: "key",
        apiKey: "test-ollama-key",
        allowPrivateNetwork: true,
        ...(noVisionModels && noVisionModels.length > 0 ? { noVisionModels } : {}),
      },
    },
  } as OcxConfig;
}

const PNG_DATA_URL = "data:image/png;base64,aGVsbG8taW1hZ2UtYnl0ZXM=";

function imageRequest(stream: boolean) {
  return new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "ollama/glm-5.2:cloud",
      stream,
      input: [{ type: "message", role: "user", content: [
        { type: "input_text", text: "what is in this picture?" },
        { type: "input_image", image_url: PNG_DATA_URL },
      ]}],
    }),
  });
}

/** A chat-completions 200 JSON body (openai-chat parseResponse shape). */
function chatOkBody(): string {
  return JSON.stringify({
    id: "chatcmpl-1", object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: "I see a red square." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  });
}

/** A chat-completions 200 SSE stream (openai-chat parseStream shape). */
function chatOkStream(): string {
  return [
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "I see a red square." } }] })}`,
    "",
    `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })}`,
    "",
    "data: [DONE]",
    "",
    "",
  ].join("\n");
}

function imageUnsupported400(): string {
  return JSON.stringify({ error: "this model does not support image input (ref: test)" });
}

interface ScenarioResult {
  status: number;
  forwardedBodies: string[];
  config: OcxConfig;
}

/**
 * Drive handleResponses with a scripted upstream. `responses` is a queue of response factories
 * consumed in order (one per upstream call). Each forwarded body is recorded.
 */
async function runScenario(
  config: OcxConfig,
  responses: Array<() => Response>,
  stream: boolean,
): Promise<ScenarioResult> {
  const forwardedBodies: string[] = [];
  let call = 0;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const factory = responses[Math.min(call, responses.length - 1)];
    call += 1;
    if (typeof init?.body === "string") forwardedBodies.push(init.body);
    return factory();
  }) as typeof fetch;

  const res = await handleResponses(imageRequest(stream), config, { model: "", provider: "" });
  return { status: res.status, forwardedBodies, config };
}

function readDiskConfig(): Record<string, unknown> {
  const path = join(testDir, "config.json");
  if (!existsSync(path)) throw new Error(`config.json not written to ${path}`);
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
}

describe("responses-path reactive vision marking (auto noVisionModels)", () => {
  test("R1: image-unsupported 400 -> mark + strip + retry -> 200, persisted", async () => {
    const config = ollamaConfig(); // no noVisionModels yet
    const { status, forwardedBodies, config: after } = await runScenario(
      config,
      [() => new Response(imageUnsupported400(), { status: 400 }), () => new Response(chatOkBody(), { status: 200 })],
      false,
    );

    expect(status).toBe(200);
    expect(forwardedBodies).toHaveLength(2);
    // First attempt forwarded the image verbatim (model not yet known text-only).
    expect(forwardedBodies[0]).toContain(PNG_DATA_URL);
    // Retry body: image stripped, strip marker present, no image bytes.
    expect(forwardedBodies[1]).not.toContain(PNG_DATA_URL);
    expect(forwardedBodies[1]).toContain("image omitted");
    // In-memory config mutated.
    expect(after.providers.ollama.noVisionModels).toContain("glm-5.2:cloud");
    // Persisted to disk (set-and-forget).
    const disk = readDiskConfig();
    const diskProvider = (disk.providers as Record<string, { noVisionModels?: string[] }>).ollama;
    expect(diskProvider?.noVisionModels).toContain("glm-5.2:cloud");
  });

  test("R2: persistent 400 -> honest 400, one-shot retry, model still marked", async () => {
    const config = ollamaConfig();
    const { status, forwardedBodies, config: after } = await runScenario(
      config,
      [() => new Response(imageUnsupported400(), { status: 400 }), () => new Response(imageUnsupported400(), { status: 400 })],
      false,
    );

    // The retried (stripped) request still 400'd -> honest 400 surfaces.
    expect(status).toBe(400);
    expect(forwardedBodies).toHaveLength(2);
    // Marking happened before the retry regardless of retry outcome.
    expect(after.providers.ollama.noVisionModels).toContain("glm-5.2:cloud");
  });

  test("R3: follow-up request after marking strips pre-emptively (no 400)", async () => {
    const config = ollamaConfig();
    // First request: 400 then 200 -> marks the model.
    await runScenario(
      config,
      [() => new Response(imageUnsupported400(), { status: 400 }), () => new Response(chatOkBody(), { status: 200 })],
      false,
    );
    // Second request reuses the now-marked config: pre-emptive strip, single upstream call, 200.
    const { status, forwardedBodies } = await runScenario(
      config,
      [() => new Response(chatOkBody(), { status: 200 })],
      false,
    );
    expect(status).toBe(200);
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).not.toContain(PNG_DATA_URL);
    expect(forwardedBodies[0]).toContain("image omitted");
  });

  test("R4: model already in noVisionModels -> branch does not fire (no extra retry)", async () => {
    const config = ollamaConfig(["glm-5.2"]);
    const { status, forwardedBodies, config: after } = await runScenario(
      config,
      [() => new Response(chatOkBody(), { status: 200 })],
      false,
    );
    // Pre-emptive strip handled it in one call; the reactive branch never fired.
    expect(status).toBe(200);
    expect(forwardedBodies).toHaveLength(1);
    expect(forwardedBodies[0]).not.toContain(PNG_DATA_URL);
    // No duplicate / spurious marking.
    expect(after.providers.ollama.noVisionModels).toEqual(["glm-5.2"]);
  });

  test("R5: unrelated 400 with image -> branch does not fire, model NOT marked", async () => {
    const config = ollamaConfig();
    const { status, forwardedBodies, config: after } = await runScenario(
      config,
      [() => new Response(JSON.stringify({ error: "invalid model id" }), { status: 400 })],
      false,
    );
    expect(status).toBe(400);
    expect(forwardedBodies).toHaveLength(1);
    // The image was forwarded (no strip) and the model was NOT marked text-only.
    expect(forwardedBodies[0]).toContain(PNG_DATA_URL);
    expect(after.providers.ollama.noVisionModels ?? []).not.toContain("glm-5.2:cloud");
  });

  test("R6: streaming — 400 then SSE 200 -> 200, retry body stripped", async () => {
    const config = ollamaConfig();
    const { status, forwardedBodies } = await runScenario(
      config,
      [
        () => new Response(imageUnsupported400(), { status: 400 }),
        () => new Response(chatOkStream(), { status: 200, headers: { "content-type": "text/event-stream" } }),
      ],
      true,
    );
    expect(status).toBe(200);
    expect(forwardedBodies).toHaveLength(2);
    expect(forwardedBodies[0]).toContain(PNG_DATA_URL);
    expect(forwardedBodies[1]).not.toContain(PNG_DATA_URL);
    expect(forwardedBodies[1]).toContain("image omitted");
  });
});