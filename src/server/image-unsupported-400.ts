/**
 * Tolerant detection of an upstream 400 that says the routed model can't take image
 * inputs — the reactive trigger for auto-marking a model text-only (added to
 * `provider.noVisionModels`) so the user never has to hand-edit config.
 *
 * ollama replies `{"error":"this model does not support image input (ref: …)"}`. Other
 * vendors phrase it differently across `error`/`message`/`detail`/`error_message` (with a
 * nested `.message`). We require BOTH an "image" token AND a "not supported / unsupported"
 * signal, so a 400 that merely happens to mention an image (e.g. "image url malformed") does
 * not falsely mark a vision-capable model text-only. Mirrors `isAllowListedCodexAccountModel400`
 * (core.ts): status gate, bounded clone read, tolerant JSON parse, displaySafe && !truncated.
 */
import { readBoundedResponseBody } from "../lib/bounded-body";
import { parseUpstreamJsonPayload } from "../adapters/upstream-http-error";

const IMAGE_UNSUPPORTED_PATTERNS: ReadonlyRegExp[] = [
  /does not support image[ -]?input/i,
  /image input (is )?not supported/i,
  /does not support images?\b/i,
  /images? (are )?not supported/i,
  /image[ -]?(input )?unsupported/i,
];

// `RegExp` is a readonly structural type at runtime; a named alias keeps the array literal tidy.
type ReadonlyRegExp = RegExp;

function textMentionsImageUnsupported(text: string): boolean {
  if (!text) return false;
  return IMAGE_UNSUPPORTED_PATTERNS.some(re => re.test(text));
}

/**
 * Pure predicate over a status + already-read body string. Unit-testable without a Response.
 * Extracts candidate human-readable strings from the common JSON error fields (including a
 * nested `error.message`), then falls back to the raw body text. Any candidate matching wins.
 */
export function isImageUnsupported400Body(status: number, bodyText: string): boolean {
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
  return candidates.some(textMentionsImageUnsupported);
}

/**
 * Read a cloned copy of the response body under strict bounds and decide whether it is an
 * image-unsupported 400. Reads `response.clone()` so the original body remains available for
 * the fallthrough error surfacing path. Returns false on any read/parse failure or truncated
 * body (a partial fragment must never drive a persistent config mutation).
 */
export async function isImageUnsupported400(res: Response, signal?: AbortSignal): Promise<boolean> {
  if (res.status !== 400) return false;
  try {
    const body = await readBoundedResponseBody(res.clone(), { signal });
    if (!body.displaySafe || body.truncated) return false;
    return isImageUnsupported400Body(res.status, body.text);
  } catch {
    return false;
  }
}