import { describe, expect, test } from "bun:test";
import {
  buildUndeclaredToolContinuation,
  guardUndeclaredToolCalls,
  UNDECLARED_TOOL_NUDGE,
} from "../src/server/responses/undeclared-tool-guard";
import type { AdapterEvent, OcxParsedRequest } from "../src/types";

function parsedRequest(): OcxParsedRequest {
  return {
    modelId: "mimo-v2.5",
    stream: true,
    options: {},
    context: {
      messages: [{ role: "user", content: "find the bug", timestamp: 1 }],
      tools: [
        { name: "shell", description: "run a command", parameters: {} },
        { name: "apply_patch", description: "edit a file", parameters: {} },
      ],
    },
  };
}

async function* eventsOf(list: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  yield* list;
}

function collect(gen: AsyncGenerator<AdapterEvent>): Promise<AdapterEvent[]> {
  const out: AdapterEvent[] = [];
  return (async () => {
    for await (const event of gen) out.push(event);
    return out;
  })();
}

describe("undeclared tool guard", () => {
  test("declared tools pass through untouched", async () => {
    const declared = new Set(["shell", "apply_patch"]);
    const input: AdapterEvent[] = [
      { type: "text_delta", text: "checking " },
      { type: "tool_call_start", id: "call_1", name: "shell" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"ls\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ];

    const out = await collect(
      guardUndeclaredToolCalls(parsedRequest(), declared, eventsOf(input), () => {
        throw new Error("continuation must not be requested");
      }),
    );

    expect(out).toEqual(input);
  });

  test("first hallucinated call is swallowed and retried once; retry may succeed", async () => {
    const declared = new Set(["shell", "apply_patch"]);
    const poisoned: AdapterEvent[] = [
      { type: "text_delta", text: "I will search the codebase." },
      { type: "tool_call_start", id: "call_1", name: "Grep" },
      { type: "tool_call_delta", arguments: "{\"pattern\":\"foo\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ];
    const retry: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_2", name: "shell" },
      { type: "tool_call_delta", arguments: "{\"cmd\":\"rg foo\"}" },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } },
    ];

    let continuationParsed: OcxParsedRequest | undefined;
    const out = await collect(
      guardUndeclaredToolCalls(
        parsedRequest(),
        declared,
        eventsOf(poisoned),
        nextParsed => {
          continuationParsed = nextParsed;
          return eventsOf(retry);
        },
      ),
    );

    // Text before the bad call is preserved; the Grep call and its deltas never surface.
    expect(out.map(e => e.type)).toEqual(["text_delta", "assistant_boundary", "tool_call_start", "tool_call_delta", "tool_call_end", "done"]);
    expect(out.some(e => e.type === "tool_call_start" && e.name === "Grep")).toBe(false);
    // Usage from the swallowed turn merges into the retry's done event.
    const done = out.find(e => e.type === "done") as Extract<AdapterEvent, { type: "done" }>;
    expect(done.usage?.inputTokens).toBe(22);
    expect(done.usage?.outputTokens).toBe(13);
    // The continuation carries the swallowed text plus a corrective developer note.
    expect(continuationParsed).toBeDefined();
    const messages = continuationParsed!.context.messages;
    const assistant = messages.find(m => m.role === "assistant");
    expect(assistant).toBeDefined();
    expect((assistant as { content: Array<{ type: string; text?: string }> }).content.some(
      p => p.type === "text" && p.text === "I will search the codebase.",
    )).toBe(true);
    const nudge = messages.find(m => m.role === "developer") as { content: string } | undefined;
    expect(nudge?.content).toContain("Grep");
    expect(nudge?.content).toContain("shell");
  });

  test("second hallucination fails closed with the bridge's error", async () => {
    const declared = new Set(["shell"]);
    const first: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "Grep" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
    ];
    const second: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_2", name: "Read" },
      { type: "done", usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 } },
    ];
    let calls = 0;
    const out = await collect(
      guardUndeclaredToolCalls(
        parsedRequest(),
        declared,
        eventsOf(first),
        () => {
          calls += 1;
          return eventsOf(second);
        },
      ),
    );

    expect(calls).toBe(1);
    const error = out.find(e => e.type === "error") as Extract<AdapterEvent, { type: "error" }>;
    expect(error?.message).toContain('undeclared client tool "Read"');
    expect(error?.status).toBe(502);
    expect(out.some(e => e.type === "tool_call_start")).toBe(false);
  });

  test("stream with no declared tools passes through (bridge skips its check too)", async () => {
    const input: AdapterEvent[] = [
      { type: "tool_call_start", id: "call_1", name: "Grep" },
      { type: "done" },
    ];
    const out = await collect(
      guardUndeclaredToolCalls(parsedRequest(), undefined, eventsOf(input), () => {
        throw new Error("continuation must not be requested");
      }),
    );
    expect(out).toEqual(input);
  });

  test("upstream error events surface immediately", async () => {
    const declared = new Set(["shell"]);
    const input: AdapterEvent[] = [
      { type: "text_delta", text: "hmm" },
      { type: "error", message: "upstream exploded", status: 500 },
    ];
    const out = await collect(
      guardUndeclaredToolCalls(parsedRequest(), declared, eventsOf(input), () => {
        throw new Error("continuation must not be requested");
      }),
    );
    expect(out).toEqual(input);
  });

  test("continuation build folds swallowed text into an assistant message and adds the nudge", () => {
    const parsed = parsedRequest();
    const events: AdapterEvent[] = [
      { type: "text_delta", text: "Let me look. " },
      { type: "thinking_delta", thinking: "planning" },
    ];
    const next = buildUndeclaredToolContinuation(parsed, events, "Grep", ["shell"]);
    expect(next.context.messages.length).toBe(parsed.context.messages.length + 2);
    const assistant = next.context.messages[next.context.messages.length - 2] as {
      role: string; content: Array<{ type: string }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content.map(p => p.type)).toEqual(["thinking", "text"]);
    const dev = next.context.messages[next.context.messages.length - 1] as { role: string; content: string };
    expect(dev.role).toBe("developer");
    expect(dev.content).toBe(UNDECLARED_TOOL_NUDGE("Grep", ["shell"]));
  });

  test("empty swallowed turn still gets a nudge without an assistant message", () => {
    const parsed = parsedRequest();
    const next = buildUndeclaredToolContinuation(parsed, [], "LS", ["shell"]);
    expect(next.context.messages.length).toBe(parsed.context.messages.length + 1);
    const dev = next.context.messages[next.context.messages.length - 1] as { role: string };
    expect(dev.role).toBe("developer");
  });
});
