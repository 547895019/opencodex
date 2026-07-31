/**
 * Unit tests for the invalid-reasoning-effort 400 matcher (src/server/effort-unsupported-400.ts).
 * The matcher is the reactive trigger for auto-learning a routed model's accepted reasoning
 * ladder into `provider.modelReasoningEfforts`. It must fire on upstream rejections of an
 * effort tier but NOT on unrelated 400s or bodies that merely mention reasoning.
 */
import { describe, expect, test } from "bun:test";
import {
  isInvalidReasoningEffort400,
  isInvalidReasoningEffort400Body,
  parseAcceptedReasoningEfforts,
} from "../src/server/effort-unsupported-400";

const USER_ERROR = `{"error":{"message":"invalid reasoning value: 'xhigh' (must be \"high\", \"medium\", \"low\", \"max\", or \"none\")","type":"invalid_request_error","param":null,"code":null}}`;

describe("isInvalidReasoningEffort400Body (pure predicate)", () => {
  test("the user's exact ollama-style 400 body -> true", () => {
    expect(isInvalidReasoningEffort400Body(400, USER_ERROR)).toBe(true);
  });

  test("top-level error string", () => {
    expect(isInvalidReasoningEffort400Body(400, `{"error":"invalid reasoning effort: 'xhigh'"}`)).toBe(true);
  });

  test("OpenAI-style nested error.message", () => {
    expect(isInvalidReasoningEffort400Body(400, `{"error":{"message":"unsupported reasoning value 'ultra'","type":"invalid_request_error"}}`)).toBe(true);
  });

  test("detail field", () => {
    expect(isInvalidReasoningEffort400Body(400, `{"detail":"reasoning_effort is not supported for this model"}`)).toBe(true);
  });

  test("error_message field", () => {
    expect(isInvalidReasoningEffort400Body(400, `{"error_message":"reasoning_effort not valid"}`)).toBe(true);
  });

  test("plain text body (no JSON) falls back to raw text", () => {
    expect(isInvalidReasoningEffort400Body(400, "invalid reasoning value: 'xhigh'")).toBe(true);
  });

  test("non-400 status is false even with a matching body", () => {
    expect(isInvalidReasoningEffort400Body(413, `{"error":"invalid reasoning value: 'xhigh'"}`)).toBe(false);
    expect(isInvalidReasoningEffort400Body(500, `{"error":"unsupported reasoning effort"}`)).toBe(false);
  });

  test("unrelated 400 is false", () => {
    expect(isInvalidReasoningEffort400Body(400, `{"error":"invalid model id"}`)).toBe(false);
    expect(isInvalidReasoningEffort400Body(400, `{"error":"bad request"}`)).toBe(false);
  });

  test("body that mentions reasoning but not invalid/unsupported is false (false-positive guard)", () => {
    expect(isInvalidReasoningEffort400Body(400, `{"error":"reasoning_effort budget exceeded"}`)).toBe(false);
    expect(isInvalidReasoningEffort400Body(400, `{"error":"reasoning summary too long"}`)).toBe(false);
    expect(isInvalidReasoningEffort400Body(400, `{"error":"reasoning content blocked"}`)).toBe(false);
  });

  test("empty / whitespace body is false", () => {
    expect(isInvalidReasoningEffort400Body(400, "")).toBe(false);
    expect(isInvalidReasoningEffort400Body(400, "   ")).toBe(false);
  });
});

describe("parseAcceptedReasoningEfforts", () => {
  test("parses the user's exact error body, drops 'none', sorts by Codex ladder order", () => {
    expect(parseAcceptedReasoningEfforts(USER_ERROR)).toEqual(["low", "medium", "high", "max"]);
  });

  test("must-be clause with quoted tokens", () => {
    expect(parseAcceptedReasoningEfforts(`{"error":"invalid reasoning value: 'xhigh' (must be \"high\", \"medium\", \"low\", \"max\", or \"none\")"}`))
      .toEqual(["low", "medium", "high", "max"]);
  });

  test("must be one of: ... clause", () => {
    expect(parseAcceptedReasoningEfforts(`invalid; must be one of: "low", "high", "max"`))
      .toEqual(["low", "high", "max"]);
  });

  test("allowed values are: ... clause", () => {
    expect(parseAcceptedReasoningEfforts(`bad effort; allowed values are: "low" or "high"`))
      .toEqual(["low", "high"]);
  });

  test("single accepted value", () => {
    expect(parseAcceptedReasoningEfforts(`invalid reasoning value 'xhigh' (must be "max")`))
      .toEqual(["max"]);
  });

  test("no accepted-values clause -> undefined (no guessing)", () => {
    expect(parseAcceptedReasoningEfforts(`{"error":"invalid reasoning value: 'xhigh'"}`)).toBeUndefined();
    expect(parseAcceptedReasoningEfforts(`invalid reasoning effort`)).toBeUndefined();
  });

  test("accepted clause with only non-Codex values -> undefined", () => {
    expect(parseAcceptedReasoningEfforts(`invalid; must be "none" or "auto"`)).toBeUndefined();
  });

  test("single-quoted tokens also work", () => {
    expect(parseAcceptedReasoningEfforts(`invalid reasoning value 'xhigh' (must be 'high', 'medium', 'low', 'max')`))
      .toEqual(["low", "medium", "high", "max"]);
  });

  test("empty body -> undefined", () => {
    expect(parseAcceptedReasoningEfforts("")).toBeUndefined();
  });
});

describe("isInvalidReasoningEffort400 (Response reader)", () => {
  async function check(status: number, body: string): Promise<boolean> {
    return isInvalidReasoningEffort400(new Response(body, { status }));
  }

  test("ollama 400 body -> true", async () => {
    expect(await check(400, USER_ERROR)).toBe(true);
  });

  test("200 ok -> false (status gate)", async () => {
    expect(await check(200, `{"error":"invalid reasoning value: 'xhigh'"}`)).toBe(false);
  });

  test("unrelated 400 -> false", async () => {
    expect(await check(400, `{"error":"invalid model id"}`)).toBe(false);
  });

  test("empty 400 body -> false", async () => {
    expect(await check(400, "")).toBe(false);
  });

  test("truncated (oversized) body -> false", async () => {
    // A body far beyond BOUNDED_BODY_MAX_BYTES (64 KiB) is not displaySafe; it must not drive a
    // persistent config mutation from a partial fragment.
    const huge = `{"error":"invalid reasoning value: 'xhigh' (must be ` + "x".repeat(200_000) + `)"}`;
    expect(await check(400, huge)).toBe(false);
  });
});