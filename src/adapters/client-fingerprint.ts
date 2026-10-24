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

// ── Antigravity IDE ──
/** Pinned fallback Antigravity IDE language-server version (matches the bundled LS 2.5.5). */
export const ANTIGRAVITY_IDE_VERSION = "2.5.5";
const ANTIGRAVITY_IDE_CLIENT_NAME = "aidev_client";
const ANTIGRAVITY_IDE_PLATFORM = "windows/amd64";


/**
 * Real Antigravity IDE User-Agent format, decompiled from 2.5.5 Go LS (`setHeaders` @ `0x1018fbe00`):
 * `antigravity/ide/${version} (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`
 *
 * Token ordering from decompiled binary: `os_type` -> `arch` -> `aidev_client` -> `auth_method=oauth`.
 *
 * Must be the IDE client family (`antigravity/ide/...`): Cloud Code Assist backend gates
 * newer agent models (e.g. `gemini-3.7-flash`) by User-Agent and answers 404 NOT_FOUND to
 * CLI-shaped UAs even with a valid OAuth token. Only `antigravity/ide/<ver>` unlocks them.
 * The one exception is Gemini 4 Argon, which CCA serves ONLY to the CLI family; see
 * `antigravityCliUserAgent`.
 * A `GOOGLE_ANTIGRAVITY_USER_AGENT` override (set by the caller) takes precedence upstream.
 */
export function antigravityUserAgent(version = ANTIGRAVITY_IDE_VERSION, authMethod = "oauth"): string {
  const ov = process.env.GOOGLE_ANTIGRAVITY_USER_AGENT?.trim();
  if (ov) return ov;
  const [osType, arch] = ANTIGRAVITY_IDE_PLATFORM.split("/");
  return `antigravity/ide/${version} (os_type=${osType}; arch=${arch}; ${ANTIGRAVITY_IDE_CLIENT_NAME}; auth_method=${authMethod})`;
}

// ── Antigravity CLI ──
/** Antigravity CLI version whose User-Agent CCA was verified to serve Gemini 4 Argon to. */
export const ANTIGRAVITY_CLI_VERSION = "1.3.4";
const ANTIGRAVITY_CLI_PLATFORM = "darwin/arm64";

/**
 * Antigravity CLI User-Agent:
 * `antigravity/cli/${version} (os_type=${osType}; arch=${arch}; aidev_client; auth_method=oauth)`.
 *
 * Verified 2026-10-14 against live CCA: `gemini-4-argon-{low,medium,high}` answer only to this
 * family and return 404 "Requested entity was not found" to the IDE UA above, while
 * `gemini-3.7-flash-tiered` and `gemini-3.1-pro-low` 404 under this one. So it is used ONLY for
 * Argon requests and for model discovery, never as a general replacement for the IDE UA.
 *
 * `GOOGLE_ANTIGRAVITY_USER_AGENT` deliberately does not apply here: that override names the IDE
 * header, and letting it replace this one would re-lock Argon for anyone who set it.
 */
export function antigravityCliUserAgent(version = ANTIGRAVITY_CLI_VERSION, authMethod = "oauth"): string {
  const [osType, arch] = ANTIGRAVITY_CLI_PLATFORM.split("/");
  return `antigravity/cli/${version} (os_type=${osType}; arch=${arch}; ${ANTIGRAVITY_IDE_CLIENT_NAME}; auth_method=${authMethod})`;
}
