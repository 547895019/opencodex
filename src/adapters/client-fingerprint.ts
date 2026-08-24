/**
 * First-party client fingerprints.
 *
 * These helpers make opencodex's Anthropic OAuth requests structurally match the real
 * Claude Code CLI's request signature: User-Agent, per-process session id, attribution
 * header (with fingerprint and native-client attestation placeholder), CLI system prefix,
 * and request metadata.
 *
 * The `cch=00000` placeholder in the attribution header is what real Claude Code sends
 * before Bun's native HTTP stack overwrites it with a cryptographic attestation token.
 * opencodex cannot compute the real token, so we send the same placeholder to keep the
 * string-level signature identical.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import type { OcxMessage, OcxTextContent, OcxUserMessage } from "../types";

// ── Version / User-Agent ──

/** Fixed fallback version that matches the first-party Claude Code CLI major family. */
const CLAUDE_CODE_VERSION_FALLBACK = "2.1.232";

/** Cache for the resolved Claude Code version. */
let resolvedClaudeCodeVersion: string | undefined;

/**
 * Resolve the version used in `cc_version`. Prefer the locally installed `claude` CLI version
 * when available; otherwise fall back to a fixed first-party version.
 *
 * Note: this intentionally does NOT read opencodex's own package.json. The attribution header
 * is meant to match Anthropic's first-party client signature, and a mismatched proxy version
 * would stand out at the API boundary.
 */
export function getOpenCodexVersion(): string {
  if (resolvedClaudeCodeVersion) return resolvedClaudeCodeVersion;

  let version: string | undefined;
  try {
    version = execSync("claude --version", { encoding: "utf8", stdio: ["pipe", "pipe", "ignore"], timeout: 2000 }).trim();
    // The CLI prints either "2.1.232" or "2.1.232 (Claude Code)"; keep the leading numeric part.
    const match = /^(\d+\.\d+\.\d+)/.exec(version);
    if (match) version = match[1];
  } catch {
    /* fall through */
  }

  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    version = CLAUDE_CODE_VERSION_FALLBACK;
  }

  resolvedClaudeCodeVersion = version;
  return version;
}

/** Test-only: reset the resolved version cache. */
export function resetClaudeCodeVersionForTests(): void {
  resolvedClaudeCodeVersion = undefined;
}

/**
 * User-Agent matching Claude Code's first-party shape.
 *
 * The official client sends `claude-cli/<VERSION> (<USER_TYPE>, <ENTRYPOINT>...)`.
 * We keep the entrypoint generic (`cli`) because opencodex exposes the same proxy to
 * multiple clients. The `claude-cli` prefix is important for backend log filtering.
 */
export function getClaudeCodeUserAgent(): string {
  return `claude-cli/${getOpenCodexVersion()}`;
}

// ── Session id ──

let CLAUDE_CODE_SESSION_ID: string | undefined;

/**
 * Random UUIDv4 session id, generated once per process. Matches real Claude Code, which
 * creates one session id per CLI invocation (not per token or per request).
 */
export function claudeCodeSessionId(): string {
  if (!CLAUDE_CODE_SESSION_ID) {
    CLAUDE_CODE_SESSION_ID = randomUUID();
  }
  return CLAUDE_CODE_SESSION_ID;
}

/** Test-only: reset the memoized session id. */
export function resetClaudeCodeSessionIdForTests(): void {
  CLAUDE_CODE_SESSION_ID = undefined;
}

// ── Fingerprint ──

/** Hardcoded salt shared with the official Claude Code client. */
export const FINGERPRINT_SALT = "59cf53e54c78";

/** Memoized fingerprint result so a request's header and metadata stay in sync. */
let memoizedFingerprint: { input: string; value: string } | undefined;

/**
 * Extract text from the first user/developer message. Anthropic's fingerprint is
 * computed from the first user-visible text, regardless of whether it arrived as a
 * plain string or a content-part array.
 */
export function extractFirstUserMessageText(messages: readonly OcxMessage[] | readonly unknown[]): string {
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as { role?: string }).role;
    if (role !== "user" && role !== "developer") continue;
    const content = (msg as OcxUserMessage).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const text = content.find((part): part is OcxTextContent =>
        part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: string }).text === "string"
      );
      if (text) return text.text;
    }
  }
  return "";
}


// ── Attribution header ──

/**
 * Returns the `x-anthropic-billing-header` pseudo-header that real Claude Code injects
 * as the first system prompt text block.
 *
 * - `cc_version` embeds the first-party version and the per-request fingerprint.
 * - `cc_entrypoint` is fixed to `cli`.
 * - `cch=00000` is the native-client attestation placeholder; Bun would overwrite it.
 * - `cc_workload` is fixed to `interactive` (no cron/workload context in opencodex).
 */
export function getAttributionHeader(fingerprint: string): string {
  const version = `${getOpenCodexVersion()}.${fingerprint}`;
  return `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=cli; cch=00000; cc_workload=interactive`;
}

/**
 * Computes the 3-character first-party fingerprint used in the attribution header.
 *
 * Algorithm (must stay in sync with Claude Code): SHA256(salt + msg[4] + msg[7] +
 * msg[20] + version).slice(0, 3), using "0" for missing characters.
 */
export function computeFingerprint(messageText: string, version: string): string {
  const input = fingerprintInput(messageText, version);
  if (memoizedFingerprint?.input === input) return memoizedFingerprint.value;
  const chars = [messageText[4] ?? "0", messageText[7] ?? "0", messageText[20] ?? "0"].join("");
  const hashInput = `${FINGERPRINT_SALT}${chars}${version}`;
  const value = createHash("sha256").update(hashInput).digest("hex").slice(0, 3);
  memoizedFingerprint = { input, value };
  return value;
}

function fingerprintInput(messageText: string, version: string): string {
  return `${messageText}\0${version}`;
}

// ── CLI system prompt prefix ──

const DEFAULT_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude.";
const AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.";
const AGENT_SDK_PREFIX = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

/**
 * Official Claude Code system prompt prefix.
 *
 * Interactive sessions get the canonical prefix. Non-interactive sessions get one of the
 * Agent SDK variants depending on whether an appended system prompt is present.
 */
export function getClaudeCodeSystemPrefix(options: { isNonInteractive?: boolean; hasAppendSystemPrompt?: boolean } = {}): string {
  if (options.isNonInteractive) {
    return options.hasAppendSystemPrompt ? AGENT_SDK_CLAUDE_CODE_PRESET_PREFIX : AGENT_SDK_PREFIX;
  }
  return DEFAULT_PREFIX;
}

// ── Device id ──

const DEVICE_ID_FILE = "device-id";
let memoizedDeviceId: string | undefined;

function getConfigDir(): string {
  const raw = process.env["OPENCODEX_HOME"]?.trim() || undefined;
  return raw ? require("node:path").resolve(expandUserPath(raw)) : join(require("node:os").homedir(), ".opencodex");
}

function expandUserPath(value: string): string {
  if (value.startsWith("~/")) return join(require("node:os").homedir(), value.slice(2));
  return value;
}

/** Stable per-opencodex-installation device id persisted in the config dir. */
export function getOrCreateDeviceId(): string {
  if (memoizedDeviceId) return memoizedDeviceId;

  const configDir = getConfigDir();
  const path = join(configDir, DEVICE_ID_FILE);
  try {
    if (existsSync(path)) {
      const id = readFileSync(path, "utf8").trim();
      if (isValidUuid(id)) {
        memoizedDeviceId = id;
        return id;
      }
    }
  } catch {
    /* fall through to create */
  }

  const id = randomUUID();
  try {
    assertNotRealHomeUnderTest(configDir);
    if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${id}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, path);
  } catch {
    /* If we cannot persist, still use the in-process id. */
  }
  memoizedDeviceId = id;
  return id;
}

/** Test-only: reset the in-memory device id and optionally delete the persisted file. */
export function resetDeviceIdForTests(removeFile = false): void {
  memoizedDeviceId = undefined;
  if (removeFile) {
    try {
      unlinkSync(join(getConfigDir(), DEVICE_ID_FILE));
    } catch {
      /* best-effort */
    }
  }
}

function isValidUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// ── Beta header value ──

/** HTTP `anthropic-beta` value for Anthropic OAuth (Claude Pro/Max) requests. */
export const CLAUDE_CODE_OAUTH_BETA = "oauth-2025-04-20";

// ── Legacy exports (kept for importers that only need the value; do not use for headers) ──

/**
 * @deprecated Hand-copied Stainless headers are no longer needed; the SDK injects its
 * own, and the official client only sends x-app, User-Agent, session id, and request id.
 */
export const CLAUDE_CODE_HEADERS: Record<string, string> = {
  "X-App": "cli",
};

// ── Antigravity CLI (unchanged) ──

/** Pinned fallback Antigravity CLI version (real client fetches a manifest; we pin to avoid the network dependency). */
export const ANTIGRAVITY_CLI_VERSION = "1.0.13";
const ANTIGRAVITY_CLI_CLIENT_NAME = "aidev_client";
const ANTIGRAVITY_CLI_PLATFORM = "darwin/arm64";
/** Secondary Google API client UA the Antigravity client library reports. */
export const ANTIGRAVITY_GOOG_API_CLIENT_UA = "google-api-nodejs-client/10.3.0";

/**
 * The real Antigravity CLI User-Agent, e.g.
 * `antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)`.
 * A `GOOGLE_ANTIGRAVITY_USER_AGENT` override (set by the caller) takes precedence upstream.
 */
export function antigravityUserAgent(version = ANTIGRAVITY_CLI_VERSION): string {
  const [osType, arch] = ANTIGRAVITY_CLI_PLATFORM.split("/");
  return `antigravity/cli/${version} (${ANTIGRAVITY_CLI_CLIENT_NAME}; os_type=${osType}; arch=${arch})`;
}
