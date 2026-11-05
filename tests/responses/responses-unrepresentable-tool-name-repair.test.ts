/**
 * Recovery half for call names a degraded provider stream left violating the upstream tool-name
 * charset (`^[a-zA-Z0-9_.-]+$`, seen live as `ToolSearchOutputFunctionToolNameParam` /
 * `Invalid 'input[335].name'`). Namespaced dotted spellings stay the dotted repair's business
 * (`responses-legacy-dotted-tool-name-repair.test.ts`): a name like `default.view_image` is legal
 * under THIS pattern, so the two repairs are disjoint by construction. Fail-closed in both
 * directions — a name whose leading legal run names exactly one declared tool is re-pointed there;
 * anything unresolvable is replaced by an explicit not-executed note with its paired output
 * dropped, never silently guessed at.
 */
import { describe, expect, test } from "bun:test";
import { repairUnrepresentableToolCallNames } from "../../src/responses/unrepresentable-tool-name-repair";

/** The two call names observed in the reported conversation. */
const DAMAGED_BASH = { type: "function_call", call_id: "call_a", name: 'Bash忒dedup="1"', arguments: "{}" };
const DAMAGED_PROSE = {
  type: "function_call",
  call_id: "call_b",
  name: "Update memory file with delta chain completion, then report to user.\n\nNow let me update.",
  arguments: "{}",
};

const SHELL_TOOLS = [
  { type: "function", name: "Bash", parameters: { type: "object" } },
  { type: "function", name: "Write", parameters: { type: "object" } },
];

function replay(tools: unknown[], input: unknown[]): Record<string, unknown> {
  return { model: "gpt-6-astra", tools, input };
}

function namesAfter(body: Record<string, unknown>): unknown[] {
  const repaired = repairUnrepresentableToolCallNames(body) as { input: Array<Record<string, unknown>> };
  return repaired.input.map(item => item.type === "message" ? `note:${(item.content as Array<{ text?: string }>)[0]?.text?.slice(0, 40)}` : item.name ?? item.call_id ?? item.type);
}

describe("replaying a damaged history", () => {
  test("a name whose leading legal run names exactly one declared tool resolves to it", () => {
    expect(namesAfter(replay(SHELL_TOOLS, [DAMAGED_BASH])))
      .toEqual(["Bash"]);
  });

  test("the resolved call keeps call_id and arguments, so the paired output still matches", () => {
    const output = { type: "function_call_output", call_id: "call_a", output: "<tool_use_error>No such tool</tool_use_error>" };
    const repaired = repairUnrepresentableToolCallNames(
      replay(SHELL_TOOLS, [DAMAGED_BASH, output]),
    ) as { input: Array<Record<string, unknown>> };
    expect(repaired.input[0]).toEqual({ type: "function_call", call_id: "call_a", name: "Bash", arguments: "{}" });
    expect(repaired.input[1]).toBe(output);
  });

  test("a name with no plausible prefix run resolves through the leading run only", () => {
    // `Bash` declared, but the damaged name starts with prose — the leading legal run (`Update`)
    // names no declared tool, so the item is unresolved.
    const damaged = { type: "function_call", call_id: "call_c", name: 'Update memory file...', arguments: "{}" };
    expect(namesAfter(replay(SHELL_TOOLS, [damaged]))).toEqual(["note:[unrecoverable damaged tool call from ea"]);
  });

  test("a wholly prose name is replaced by a note and its paired output is dropped", () => {
    const output = { type: "function_call_output", call_id: "call_b", output: "No such tool available" };
    const message = { type: "message", role: "user", content: [{ type: "input_text", text: "continue" }] };
    const repaired = repairUnrepresentableToolCallNames(
      replay(SHELL_TOOLS, [DAMAGED_PROSE, output, message]),
    ) as { input: unknown[] };
    expect(repaired.input).toHaveLength(2);
    expect(repaired.input[0]).toEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: expect.stringContaining("[unrecoverable damaged tool call") }],
    });
    expect(repaired.input[1]).toBe(message);
  });

  test("both damaged shapes can coexist in one repair pass", () => {
    const bashOutput = { type: "function_call_output", call_id: "call_a", output: "noop error" };
    const proseOutput = { type: "function_call_output", call_id: "call_b", output: "noop error" };
    const repaired = repairUnrepresentableToolCallNames(
      replay(SHELL_TOOLS, [DAMAGED_BASH, bashOutput, DAMAGED_PROSE, proseOutput]),
    ) as { input: unknown[] };
    expect((repaired.input as Array<Record<string, unknown>>)[0]).toEqual({
      type: "function_call", call_id: "call_a", name: "Bash", arguments: "{}",
    });
    expect(repaired.input).toHaveLength(3); // renamed call + its output + the note
  });

  test("custom_tool_call items get the same repair", () => {
    const damaged = { type: "custom_tool_call", call_id: "call_d", name: 'Bash忒x', input: "raw" };
    const repaired = repairUnrepresentableToolCallNames(replay(SHELL_TOOLS, [damaged])) as { input: Array<Record<string, unknown>> };
    expect(repaired.input[0]).toEqual({ type: "custom_tool_call", call_id: "call_d", name: "Bash", input: "raw" });
  });
});

describe("names the repair refuses to guess at", () => {
  test("a leading run naming no declared tool is unresolved even with similar names present", () => {
    // Exact-set membership, not prefix search: `Bash忒x` resolves to `Bash` only when `Bash` is
    // DECLARED. With only `BashOutput` declared, the run is a name nothing answers to. This is
    // also the "similar name present, exact match absent" case the old dotted rule knew.
    const tools = [{ type: "function", name: "BashOutput", parameters: { type: "object" } }];
    const damaged = { type: "function_call", call_id: "call_e", name: 'Bash忒x', arguments: "{}" };
    expect(namesAfter(replay(tools, [damaged]))).toEqual(["note:[unrecoverable damaged tool call from ea"]);
  });

  test("a call item carrying an explicit namespace is left alone", () => {
    const body = replay(SHELL_TOOLS, [
      { type: "function_call", call_id: "call_f", name: 'Bash忒x', namespace: "mcp__x", arguments: "{}" },
    ]);
    expect(repairUnrepresentableToolCallNames(body)).toBe(body);
  });

  test("the caller's tool catalog is never rewritten", () => {
    const tools = [...SHELL_TOOLS, { type: "function", name: "Read", parameters: { type: "object" } }];
    const body = replay(tools, [DAMAGED_BASH]);
    const repaired = repairUnrepresentableToolCallNames(body) as Record<string, unknown>;
    expect(repaired.tools).toBe(tools);
  });

  test("a namespace child's name may resolve a damaged call (still a declared identity)", () => {
    const body = replay([
      { type: "namespace", name: "tools", tools: [{ type: "function", name: "Bash", parameters: { type: "object" } }] },
    ], [DAMAGED_BASH]);
    expect(namesAfter(body)).toEqual(["Bash"]);
  });
});

describe("the undamaged path", () => {
  test("a history with only legal names is returned by reference", () => {
    const body = replay(SHELL_TOOLS, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", call_id: "call_g", name: "Bash", arguments: "{}" },
      { type: "function_call_output", call_id: "call_g", output: "ok" },
      // A dotted name is legal under the upstream charset — the OTHER repair's shape.
      { type: "function_call", call_id: "call_h", name: "default.view_image", arguments: "{}" },
    ]);
    expect(repairUnrepresentableToolCallNames(body)).toBe(body);
  });

  test("a body with no input array is returned by reference", () => {
    const body = { model: "gpt-6-astra", tools: SHELL_TOOLS };
    expect(repairUnrepresentableToolCallNames(body)).toBe(body);
    expect(repairUnrepresentableToolCallNames(undefined)).toBeUndefined();
  });

  test("an empty call name is not damage this repair owns", () => {
    const body = replay(SHELL_TOOLS, [{ type: "function_call", call_id: "call_i", name: "", arguments: "{}" }]);
    expect(repairUnrepresentableToolCallNames(body)).toBe(body);
  });
});
