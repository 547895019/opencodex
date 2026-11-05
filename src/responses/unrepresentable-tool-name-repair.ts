import { collectResponsesToolGroups } from "./tool-groups";

/**
 * The charset Codex/OpenAI enforces on every tool-call `name` it receives, on tool declarations
 * and on replayed `input` items alike (`Invalid 'input[N].name': string does not match pattern`);
 * one relayed item that violates it refuses the WHOLE request, every time the history replays.
 * Deliberately its own pattern, not `tool-name-aliases.ts`: that one (`^[a-zA-Z0-9_-]+$`) predates
 * Codex allowing `.` in tool names, and judging against the stricter regex would rewrite names the
 * destination actually accepts — e.g. a flattened `ns.name` alias — which this repair must not do.
 */
export const UPSTREAM_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_.-]+$/;

/** Item types whose `name` the upstream validates against the tool-name pattern. */
const NAMED_CALL_ITEM_TYPES = new Set(["function_call", "custom_tool_call"]);

const NAMED_OUTPUT_ITEM_TYPES = new Set(["function_call_output", "custom_tool_call_output"]);

/** Replacement text when a damaged call cannot be resolved to any declared tool. */
const UNRESOLVED_CALL_NOTE = "[unrecoverable damaged tool call from earlier history; not executed]";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Names the request's own catalog declares as callable identities. Namespace children count: the
 * caller can still invoke them through the namespace, so a damaged name may resolve to one — the
 * catalog here is the set of intents a call could plausibly have, not the flat wire spellings.
 */
function declaredToolNames(body: Record<string, unknown>): ReadonlySet<string> {
  const names = new Set<string>();
  const add = (tool: unknown): void => {
    if (!isPlainObject(tool)) return;
    const nested = tool.type === "function" && isPlainObject(tool.function) ? tool.function : undefined;
    const name = typeof tool.name === "string"
      ? tool.name
      : typeof nested?.name === "string" ? nested.name : undefined;
    if (name) names.add(name);
  };
  for (const group of collectResponsesToolGroups(body)) {
    for (const spec of group) {
      if (!isPlainObject(spec)) continue;
      add(spec);
      if (spec.type === "namespace" && Array.isArray(spec.tools)) {
        for (const child of spec.tools) add(child);
      }
    }
  }
  return names;
}

/**
 * The one plausible recovery: a degraded stream spliced prose or quoting INTO the call name, and
 * the model's real intent is usually the leading legal run (`Bash忒dedup="1"` → `Bash`). Only
 * returns when that run names EXACTLY one declared tool — more than that is a guess, and fewer
 * means there is nothing to re-point the call at.
 */
function repairablePrefixName(name: string, declared: ReadonlySet<string>): string | undefined {
  let end = 0;
  while (end < name.length && UPSTREAM_TOOL_NAME_PATTERN.test(name[end])) end++;
  if (end === 0 || end === name.length) return undefined;
  const prefix = name.slice(0, end);
  return declared.has(prefix) ? prefix : undefined;
}

type DamagedCall = {
  index: number;
  item: Record<string, unknown>;
};

/**
 * One pass over the replayed history, mapping each repaired position to what it becomes. Calls
 * resolved to a declared tool keep their item (renamed, `call_id`/`arguments` untouched, so the
 * paired output still matches); unresolved ones become an explicit note. Output items paired with
 * an unresolved call are mapped to undefined, which the caller filters.
 */
function planRepairedInput(
  input: unknown[],
  declared: ReadonlySet<string>,
): Array<unknown | undefined> {
  const unresolvedCallIds = new Set<string>();
  for (const item of input) {
    if (!isPlainObject(item)) continue;
    if (typeof item.type !== "string" || !NAMED_CALL_ITEM_TYPES.has(item.type)) continue;
    if (item.namespace !== undefined) continue;
    const name = item.name;
    if (typeof name !== "string" || name.length === 0 || UPSTREAM_TOOL_NAME_PATTERN.test(name)) continue;
    // Unresolved by construction here: a resolvable name is replaced wholesale below, but its
    // OUTPUT only pairs through `call_id`, and computing that set once keeps both passes aligned.
    if (repairablePrefixName(name, declared) !== undefined) continue;
    if (typeof item.call_id === "string" && item.call_id.length > 0) unresolvedCallIds.add(item.call_id);
  }
  return input.map(item => {
    if (!isPlainObject(item)) return item;
    const type = typeof item.type === "string" ? item.type : "";
    if (NAMED_CALL_ITEM_TYPES.has(type) && item.namespace === undefined) {
      const name = item.name;
      if (typeof name !== "string" || name.length === 0 || UPSTREAM_TOOL_NAME_PATTERN.test(name)) return item;
      const repairedName = repairablePrefixName(name, declared);
      if (repairedName !== undefined) return { ...item, name: repairedName };
      return {
        type: "message",
        role: "assistant",
        content: [
          { type: "output_text", text: `${UNRESOLVED_CALL_NOTE} (original name: ${JSON.stringify(name)})` },
        ],
      };
    }
    if (NAMED_OUTPUT_ITEM_TYPES.has(type) && unresolvedCallIds.has(item.call_id as string)) {
      // Its call was rewritten to the note above, so this would be an orphan output the upstream
      // has no call to pair with.
      return undefined;
    }
    return item;
  });
}

/**
 * Make an already-damaged conversation replayable — the recovery half for call names a degraded
 * upstream stream left violating `^[a-zA-Z0-9_.-]+$` (`Invalid 'input[335].name': ...`). The emit
 * boundary cannot prevent them — the name arrived from the provider as a parsed tool call — so
 * like the dotted repair (`repairLegacyDottedToolCallNames`, #5095) this runs on replay, before
 * the body reaches the destination that validates the pattern.
 *
 * Two recoveries, both fail-closed. A damaged name whose leading legal run names exactly one
 * declared tool is re-pointed there with `call_id` and `arguments` untouched, so the paired
 * `function_call_output` still matches. Anything else — no prefix match, or several — is rewritten
 * to an explicit "not executed" note, with its paired output dropped, so the request never carries
 * an orphan output item. The caller's tool catalog is never rewritten, and a body with nothing to
 * repair is returned by reference.
 */
export function repairUnrepresentableToolCallNames(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  const declared = declaredToolNames(body);
  const damaged = body.input.some(item => {
    if (!isPlainObject(item)) return false;
    if (typeof item.type !== "string" || !NAMED_CALL_ITEM_TYPES.has(item.type)) return false;
    if (item.namespace !== undefined) return false;
    const name = item.name;
    return typeof name === "string" && name.length > 0 && !UPSTREAM_TOOL_NAME_PATTERN.test(name);
  });
  if (!damaged) return body;

  const planned = planRepairedInput(body.input, declared);
  // `undefined` entries are the paired outputs a dropped call leaves orphaned; compaction removes
  // them while the surviving neighbors keep their order.
  const repaired = planned.filter(item => item !== undefined);
  return { ...body, input: repaired };
}
