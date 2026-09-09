import type {
  AdapterEvent,
  OcxAssistantContentPart,
  OcxParsedRequest,
  OcxUsage,
} from "../../types";

/**
 * Routed chat models occasionally hallucinate a call to a tool that exists only in a
 * NEIGHBORING agent harness (Claude Code's `Grep`/`Read`/`Glob`/...) even though this
 * turn's catalog never listed it. The bridge's declaredToolNames check then fails the
 * whole request closed with a 502 "undeclared client tool" — a hard user-visible error
 * for what is really a model slip.
 *
 * This guard sits between the adapter event stream and the bridge: on the FIRST such
 * hallucinated call it swallows the poisoned turn (the bad call plus everything after
 * it), appends the model's own text/thinking plus a corrective developer note, and
 * re-asks the same upstream ONCE. A second offense fails closed exactly like today —
 * the security property (only request-declared tools may execute) is never relaxed.
 */

/** Sum two adapter usage reports (the swallowed turn's tokens still count). */
function mergeAdapterUsage(first: OcxUsage | undefined, second: OcxUsage | undefined): OcxUsage | undefined {
  if (!first) return second;
  if (!second) return first;
  const sumOptional = (key: keyof OcxUsage): number | undefined => {
    const left = first[key];
    const right = second[key];
    return typeof left === "number" || typeof right === "number"
      ? (typeof left === "number" ? left : 0) + (typeof right === "number" ? right : 0)
      : undefined;
  };
  const cachedInputTokens = sumOptional("cachedInputTokens");
  const cacheReadInputTokens = sumOptional("cacheReadInputTokens");
  const cacheCreationInputTokens = sumOptional("cacheCreationInputTokens");
  const reasoningOutputTokens = sumOptional("reasoningOutputTokens");
  const inputTokens = first.inputTokens + second.inputTokens;
  const outputTokens = first.outputTokens + second.outputTokens;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(first.estimated || second.estimated ? { estimated: true } : {}),
  };
}

export const UNDECLARED_TOOL_NUDGE = (badName: string, validNames: readonly string[]): string =>  `You just tried to call the tool "${badName}", which does not exist in this session. ` +
  `It belongs to a different agent harness. The ONLY tools you may call right now are: ` +
  `${validNames.length > 0 ? validNames.join(", ") : "(none)"}. ` +
  `Do not invent, translate, or rename tools. Re-examine the task and call one of the listed tools by its exact name, ` +
  `or answer in plain text if no listed tool fits.`;

/** Rebuild an assistant message (text/thinking only) from a swallowed turn's events. */
function assistantContentFromEvents(events: readonly AdapterEvent[]): OcxAssistantContentPart[] {
  let text = "";
  let thinking = "";
  for (const event of events) {
    if (event.type === "text_delta") text += event.text;
    else if (event.type === "thinking_delta") thinking += event.thinking;
  }
  const content: OcxAssistantContentPart[] = [];
  if (thinking) content.push({ type: "thinking", thinking });
  if (text) content.push({ type: "text", text });
  return content;
}

export function buildUndeclaredToolContinuation(
  parsed: OcxParsedRequest,
  events: readonly AdapterEvent[],
  badToolName: string,
  validToolNames: readonly string[],
): OcxParsedRequest {
  const messages = [...parsed.context.messages];
  const content = assistantContentFromEvents(events);
  if (content.length > 0) {
    messages.push({ role: "assistant", content, timestamp: Date.now() });
  }
  messages.push({ role: "developer", content: UNDECLARED_TOOL_NUDGE(badToolName, validToolNames), timestamp: Date.now() });
  return { ...parsed, context: { ...parsed.context, messages } };
}

/**
 * Wrap an adapter event stream: the first tool_call_start for an undeclared name
 * triggers a single corrective re-ask; a repeat hallucination surfaces the fail-closed
 * error event the bridge would have produced. Streams with no declared tools pass
 * through untouched (nothing to enforce — and the bridge skips its check too).
 */
export function guardUndeclaredToolCalls(
  parsed: OcxParsedRequest,
  declaredToolNames: ReadonlySet<string> | undefined,
  events: AsyncIterable<AdapterEvent>,
  continuation: (nextParsed: OcxParsedRequest) => AsyncIterable<AdapterEvent> | Promise<AsyncIterable<AdapterEvent>>,
): AsyncGenerator<AdapterEvent> {
  if (!declaredToolNames || declaredToolNames.size === 0) {
    return (async function* () { yield* events; })();
  }
  return (async function* () {
    const maxRetries = 1;
    let currentParsed = parsed;
    let source = events;
    let retries = 0;
    let accumulatedUsage: OcxUsage | undefined;

    while (true) {
      const seen: AdapterEvent[] = [];
      let badCallName: string | undefined;
      let doneUsage: OcxUsage | undefined;

      for await (const event of source) {
        // After the first hallucinated call, keep consuming to the terminal WITHOUT
        // yielding: the adapter finishes its stream deterministically and the done
        // event's usage still counts toward the merged total.
        if (badCallName !== undefined) {
          if (event.type === "done" || event.type === "incomplete") doneUsage = event.usage;
          continue;
        }
        if (event.type === "tool_call_start" && !declaredToolNames.has(event.name)) {
          badCallName = event.name;
          continue;
        }
        if (event.type === "done" || event.type === "incomplete") {
          const merged = mergeAdapterUsage(accumulatedUsage, event.usage);
          yield merged && merged !== event.usage ? { ...event, usage: merged } : event;
          return;
        }
        if (event.type === "error") {
          yield event;
          return;
        }
        seen.push(event);
        yield event;
      }

      if (badCallName === undefined) return; // stream ended without a terminal — upstream's call

      if (retries >= maxRetries) {
        // Second offense: fail closed exactly like the bridge's own check.
        yield {
          type: "error",
          message: `routed provider emitted undeclared client tool "${badCallName}"; only request-declared tools may be called`,
          status: 502,
          errorType: "upstream_error",
        };
        return;
      }

      retries += 1;
      accumulatedUsage = mergeAdapterUsage(accumulatedUsage, doneUsage);
      const nextParsed = buildUndeclaredToolContinuation(currentParsed, seen, badCallName, [...declaredToolNames]);
      yield { type: "assistant_boundary" };
      try {
        source = await continuation(nextParsed);
      } catch (error) {
        yield { type: "error", message: error instanceof Error ? error.message : String(error) };
        return;
      }
      currentParsed = nextParsed;
    }
  })();
}
