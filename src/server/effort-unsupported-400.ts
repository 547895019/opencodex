/**
 * Tolerant detection of an upstream 400 that says the requested `reasoning.effort` is not a
 * value the routed model accepts — the reactive trigger for auto-learning the model's
 * accepted reasoning ladder into `provider.modelReasoningEfforts` so the user never has to
 * hand-edit config.
 *
 * Routed openai-responses backends echo the accepted set, e.g.:
 *   `{"error":{"message":"invalid reasoning value: 'xhigh' (must be \"high\", \"medium\", \"low\", \"max\", or \"none\")","type":"invalid_request_error"}}`
 * We require BOTH a "reasoning" token AND an invalid/unsupported signal, so a 400 that merely
 * mentions reasoning (e.g. "reasoning_effort budget exceeded") does not falsely trigger a
 * ladder rewrite. Mirrors `isImageUnsupported400` (src/server/image-unsupported-400.ts):
 * status gate, bounded clone read, tolerant JSON parse, displaySafe && !truncated.
 */
import { readBoundedResponseBody } from "../lib/bounded-body";
import { parseUpstreamJsonPayload } from "../adapters/upstream-http-error";
import { sanitizeCodexReasoningEfforts } from "../reasoning-effort";

const INVALID_REASONING_EFFORT_PATTERNS: ReadonlyRegExp[] = [
  /invalid reasoning (?:effort|value)\b/i,
  /unsupported reasoning (?:effort|value)\b/i,
  /reasoning(?:_effort)?(?:[^.]{0,60}?)(?:is )?(?:invalid|not (?:valid|supported))\b/i,
  /unsupported (?:value|parameter)[^.]{0,40}?reasoning/i,
  /reasoning(?:_effort)? not (?:valid|supported)\b/i,
];

// `RegExp` is a readonly structural type at runtime; a named alias keeps the array literal tidy.
type ReadonlyRegExp = RegExp;

/** Anchors that introduce the accepted-values clause following the rejection. */
const ACCEPTED_VALUES_ANCHORS: ReadonlyRegExp[] = [
  /must be\s+(?:one of\s+)?/i,
  /allowed values(?:\s+are)?\s*:?\s*/i,
  /valid values(?:\s+are)?\s*:?\s*/i,
  /expected (?:one of|a value) of\s*:?\s*/i,
  /supported (?:values|efforts)(?:\s+are)?\s*:?\s*/i,
];

function textMentionsInvalidReasoningEffort(text: string): boolean {
  if (!text) return false;
  return INVALID_REASONING_EFFORT_PATTERNS.some(re => re.test(text));
}

/**
 * Extract the accepted reasoning-effort tokens the upstream itself echoes in its 400 body
 * (the `must be "high", "medium", "low", "max", or "none"` clause), filtered to Codex-ladder
 * members and sorted. Returns `undefined` when no Codex-shaped value can be recovered — the
 * caller must NOT mutate config without a parseable ladder, since a guessed ladder would
 * silently over- or under-clamp the user's intent.
 *
 * Runs on the UNESCAPED human-readable error strings (parsed `error`/`message`/`detail`/
 * `error_message`, incl. a nested `error.message`), NOT the raw JSON: upstreams JSON-encode
 * the accepted list with escaped quotes (`\"high\"`), which a quote-matching regex cannot
 * recover from the raw body. Quoted tokens (double or single) are pulled from the substring
 * that follows an anchor like `must be` / `allowed values are` / `valid values:`. An anchor is
 * required — without one we cannot distinguish the rejected value (e.g. `'xhigh'`) from the
 * accepted list, so we refuse to guess. The `sanitizeCodexReasoningEfforts` helper does the
 * Codex-set filter + dedup + ladder-order sort.
 */
export function parseAcceptedReasoningEfforts(bodyText: string): string[] | undefined {
  if (!bodyText) return undefined;

  const candidates: string[] = [];
  const payload = parseUpstreamJsonPayload(bodyText);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    for (const key of ["error", "message", "detail", "error_message"] as const) {
      const v = obj[key];
      if (typeof v === "string") {
        candidates.push(v);
      } else if (v && typeof v === "object") {
        const inner = (v as Record<string, unknown>).message;
        if (typeof inner === "string") candidates.push(inner);
      }
    }
  }
  candidates.push(bodyText);

  for (const candidate of candidates) {
    for (const anchor of ACCEPTED_VALUES_ANCHORS) {
      const match = anchor.exec(candidate);
      if (!match) continue;
      const clause = candidate.slice(match.index! + match[0].length, match.index! + match[0].length + 240);
      const tokens = extractQuotedTokens(clause);
      const sanitized = sanitizeCodexReasoningEfforts(tokens);
      if (sanitized && sanitized.length > 0) return sanitized;
    }
  }

  return undefined;
}

function extractQuotedTokens(text: string): string[] {
  const out: string[] = [];
  // Match "word" or 'word' (single/double quoted), allowing word chars + dashes.
  const re = /["']([a-zA-Z][a-zA-Z0-9_-]*)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/**
 * Pure predicate over a status + already-read body string. Unit-testable without a Response.
 * Extracts candidate human-readable strings from the common JSON error fields (including a
 * nested `error.message`), then falls back to the raw body text. Any candidate matching wins.
 */
export function isInvalidReasoningEffort400Body(status: number, bodyText: string): boolean {
  if (status !== 400) return false;
  const candidates: string[] = [];
  const payload = parseUpstreamJsonPayload(bodyText);
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const obj = payload as Record<string, unknown>;
    for (const key of ["error", "message", "detail", "error_message"] as const) {
      const v = obj[key];
      if (typeof v === "string") {
        candidates.push(v);
      } else if (v && typeof v === "object") {
        const inner = (v as Record<string, unknown>).message;
        if (typeof inner === "string") candidates.push(inner);
      }
    }
  }
  candidates.push(bodyText);
  return candidates.some(textMentionsInvalidReasoningEffort);
}

/**
 * Read a cloned copy of the response body under strict bounds and decide whether it is an
 * invalid-reasoning-effort 400. Reads `response.clone()` so the original body remains
 * available for the fallthrough error surfacing path. Returns false on any read/parse
 * failure or truncated body (a partial fragment must never drive a persistent config
 * mutation).
 */
export async function isInvalidReasoningEffort400(res: Response, signal?: AbortSignal): Promise<boolean> {
  if (res.status !== 400) return false;
  try {
    const body = await readBoundedResponseBody(res.clone(), { signal });
    if (!body.displaySafe || body.truncated) return false;
    return isInvalidReasoningEffort400Body(res.status, body.text);
  } catch {
    return false;
  }
}