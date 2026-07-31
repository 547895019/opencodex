/**
 * Full prompt-body capture (debug only).
 *
 * Unlike {@link ../claude/inbound-debug.ts} (allowlist scalars only — "no prompt text"),
 * this module stores the FULL inbound request body so the user can inspect exactly what
 * Claude Desktop/Code or Codex sent (messages, tools, system, output_config, metadata).
 * Because that breaks the scalar-only privacy contract, capture is:
 *   - gated on the `promptCapture` debug flag (default OFF, env OCX_PROMPT_CAPTURE_DEBUG=1),
 *   - flushed the moment the flag turns off,
 *   - redacted by default (`secrets`), with a stricter `secrets-pii` level, and
 *   - bounded by a configurable rotation limit (maxEntries).
 *
 * Redaction level + maxEntries are config-persisted (`config.debug.promptCapture`); the
 * on/off flag is runtime-only like the other debug flags. Changing the redaction level
 * clears the ring (existing entries were redacted at the old level — no retroactive re-redaction).
 */
import { isPromptCaptureEnabled } from "./debug-settings";
import { REDACTED_SECRET, redactHeaders, redactSecrets, redactUserPath } from "./redact";
import type { OcxConfig } from "../types";

export type PromptCaptureRedaction = "none" | "secrets" | "secrets-pii";

export type PromptCaptureSurface = "claude-messages" | "claude-count-tokens" | "codex-responses";

export interface PromptCaptureEntry {
  at: number;
  surface: PromptCaptureSurface;
  model: string;
  resolvedModel?: string;
  redaction: PromptCaptureRedaction;
  bodySize: number;
  body: unknown;
  headers?: Record<string, string>;
}

export interface PromptCaptureOptions {
  redaction?: PromptCaptureRedaction;
  maxEntries?: number;
}

const DEFAULT_REDACTION: PromptCaptureRedaction = "secrets";
const DEFAULT_MAX_ENTRIES = 20;
export const MAX_ENTRIES_CAP = 200;

const ring: PromptCaptureEntry[] = [];
let redaction: PromptCaptureRedaction = DEFAULT_REDACTION;
let maxEntries = DEFAULT_MAX_ENTRIES;
let lastEnabled = false;

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Anthropic metadata.user_id typically carries "device_id:session_id" style identifiers.
const PII_KEY_PATTERN = /^(user_?id|device_?id|session_?id|client_?id|email|sub)$/i;

/** Mask PII-looking string values in place within a cloned object tree. */
function redactPiiWalk(value: unknown): unknown {
  if (typeof value === "string") {
    let masked = value.replace(EMAIL_PATTERN, "[EMAIL]");
    // Only run the (heavier) path mask if it looks like an absolute path.
    if (/(?:^|[\s"'])(\/(?:Users|home)\/|[A-Za-z]:\\Users\\)/.test(masked)) {
      masked = redactUserPath(masked);
    }
    return masked;
  }
  if (Array.isArray(value)) return value.map(redactPiiWalk);
  if (!isRec(value)) return value;
  const result: Rec = {};
  for (const [key, entry] of Object.entries(value)) {
    if (PII_KEY_PATTERN.test(key) && typeof entry === "string") {
      result[key] = REDACTED_SECRET;
    } else {
      result[key] = redactPiiWalk(entry);
    }
  }
  return result;
}

/** Redact a full request body according to `level`. */
export function redactPromptBody(body: unknown, level: PromptCaptureRedaction): unknown {
  if (level === "none") {
    try {
      return structuredClone(body);
    } catch {
      // Uncloneable (e.g. contains functions) — fall back to the original reference.
      return body;
    }
  }
  const secretsRedacted = redactSecrets(body);
  if (level === "secrets") return secretsRedacted;
  return redactPiiWalk(secretsRedacted);
}

function trim(): void {
  while (ring.length > maxEntries) ring.shift();
}

/** Update redaction/maxEntries. Redaction change clears the ring. */
export function setPromptCaptureOptions(opts: PromptCaptureOptions): void {
  if (opts.redaction !== undefined && opts.redaction !== redaction) {
    redaction = opts.redaction;
    ring.length = 0;
  }
  if (opts.maxEntries !== undefined) {
    const clamped = Math.max(1, Math.min(MAX_ENTRIES_CAP, Math.floor(opts.maxEntries)));
    maxEntries = clamped;
    trim();
  }
}

/** Load persisted options from config at startup. */
export function loadPromptCaptureConfig(config: OcxConfig): void {
  const pc = config.debug?.promptCapture;
  if (pc?.redaction === "none" || pc?.redaction === "secrets" || pc?.redaction === "secrets-pii") {
    redaction = pc.redaction;
  }
  if (typeof pc?.maxEntries === "number" && Number.isFinite(pc.maxEntries)) {
    maxEntries = Math.max(1, Math.min(MAX_ENTRIES_CAP, Math.floor(pc.maxEntries)));
  }
}

/** Current option snapshot (for API responses). */
export function getPromptCaptureOptions(): { redaction: PromptCaptureRedaction; maxEntries: number } {
  return { redaction, maxEntries };
}

/** Record one inbound request. No-op (and ring flush) when the flag is off. */
export function capturePromptInbound(
  surface: PromptCaptureSurface,
  body: unknown,
  opts: { resolvedModel?: string; headers?: Headers } = {},
): void {
  const enabled = isPromptCaptureEnabled();
  if (!enabled) {
    if (lastEnabled) ring.length = 0; // flag turned off: drop captured entries
    lastEnabled = false;
    return;
  }
  lastEnabled = true;
  const model = isRec(body) && typeof body.model === "string" ? body.model : "unknown";
  const entry: PromptCaptureEntry = {
    at: Date.now(),
    surface,
    model,
    ...(opts.resolvedModel ? { resolvedModel: opts.resolvedModel } : {}),
    redaction,
    bodySize: (() => {
      try {
        return JSON.stringify(body).length;
      } catch {
        return -1;
      }
    })(),
    body: redactPromptBody(body, redaction),
    ...(opts.headers ? { headers: redactHeaders(opts.headers) } : {}),
  };
  ring.push(entry);
  trim();
}

/** Newest-first snapshot for /api/debug/prompt-capture. */
export function getPromptCaptureEntries(): PromptCaptureEntry[] {
  return [...ring].reverse();
}

/** Test isolation / explicit clear. */
export function clearPromptCapture(): void {
  ring.length = 0;
  lastEnabled = false;
}