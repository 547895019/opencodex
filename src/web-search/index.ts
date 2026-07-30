import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../types";
import { modelInList } from "../types";
import type { SidecarSettings } from "./executor";
import type { ResolvedOpenAiForwardSidecar } from "../providers/openai-sidecar";
import { getAccountSet } from "../oauth/store";
import { DEFAULT_STALL_TIMEOUT_SEC } from "../stall-timeout";

export { runWithWebSearch } from "./loop";
export { buildWebSearchTool, extractHostedWebSearch, WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";
export { runAnthropicWebSearch, parseAnthropicSidecarSSE } from "./anthropic-executor";
export { runOllamaWebSearch } from "./ollama-executor";

const DEFAULT_SIDECAR_MODEL = "gpt-5.6-luna";
// Default Claude model for the anthropic-backed sidecar (used when cfg.model is unset).
const DEFAULT_ANTHROPIC_SIDECAR_MODEL = "claude-sonnet-5";
// "low" is the lightest effort the ChatGPT backend allows with web_search ("minimal" is rejected:
// "tools cannot be used with reasoning.effort 'minimal'") — keeps the sidecar fast/cheap.
const DEFAULT_SIDECAR_REASONING = "low";
const DEFAULT_MAX_SEARCHES = 3;
// Per-search sidecar deadline. Lowered from 200_000 to 60_000 (#398): a hung
// hosted web_search used to run the full 200s, so the client cancelled first
// (turn 499) or the forced-answer routed iteration failed (502). Hosted-search
// p90 is ~43s, so 60s bounds hangs while leaving tail margin. `cfg.timeoutMs`
// still overrides. Distinct from DEFAULT_ROUTED_MODEL_STALL_TIMEOUT_MS below,
// which is the routed-model body-inactivity budget (unchanged).
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ROUTED_MODEL_STALL_TIMEOUT_MS = 200_000;
const MAX_ROUTED_MODEL_STALL_TIMEOUT_MS = 2_147_483_647;
const STALL_MARGIN_SEC = 30;

/**
 * Strip a leading "provider/" prefix from a model id the GUI stored. The Dashboard model dropdown
 * stores the BARE model id (e.g. "glm-5.2:cloud"), but subagentModels and manual config may carry the
 * "ollama/" prefix; ollama wants the bare native name. Returns undefined for empty input.
 */
function stripProviderPrefix(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/**
 * Resolve the config-file-only routed-model raw-byte inactivity budget. Runtime config loading is
 * deliberately permissive, so malformed values fall back locally without rejecting or rewriting
 * the caller's config object.
 */
export function resolveRoutedModelStallTimeoutMs(value: unknown): number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 1
    && value <= MAX_ROUTED_MODEL_STALL_TIMEOUT_MS
    ? value
    : DEFAULT_ROUTED_MODEL_STALL_TIMEOUT_MS;
}

function finiteCeil(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.ceil(value))
    : fallback;
}

/**
 * Effective bridge stall deadline (seconds) for the web-search loop. The loop's silent work units
 * are individually bounded by the configured bridge stall, response-header connect timeout,
 * routed-model response-body inactivity timeout, or sidecar timeout. The stall deadline must cover
 * the largest unit plus a margin;
 * otherwise a legitimately slow search trips the bridge's default upstream_stall_timeout and
 * kills the whole turn. Stays finite so a genuine hang is still cut off.
 */
export function webSearchStallTimeoutSec(
  configuredSec: number | undefined,
  connectTimeoutMs: number | undefined,
  routedModelStallTimeoutMs: number,
  sidecarTimeoutMs: number = routedModelStallTimeoutMs,
): number {
  const largestUnitSec = Math.max(
    finiteCeil(configuredSec, DEFAULT_STALL_TIMEOUT_SEC),
    finiteCeil(connectTimeoutMs, 0) / 1000,
    finiteCeil(routedModelStallTimeoutMs, 0) / 1000,
    finiteCeil(sidecarTimeoutMs, 0) / 1000,
  );
  return Math.min(Number.MAX_VALUE, Math.ceil(largestUnitSec) + STALL_MARGIN_SEC);
}

/** A configured anthropic-adapter OAuth provider whose ACTIVE stored account is usable (not needs-reauth). */
export interface AnthropicSidecarProvider {
  providerName: string;
  provider: OcxProviderConfig;
}

/**
 * A configured ollama provider resolved for the web-search sidecar. Unlike the openai/anthropic
 * backends, ollama has no model-internal search tool — the sidecar calls the standalone web_search
 * REST endpoint and then summarizes via a chat/responses completion on the SAME provider. So we need
 * the provider's baseUrl/adapter/apiKey, and the native model id comes from `cfg.model` (the GUI
 * stores the bare model id; no routeModel lookup is needed, mirroring the anthropic backend).
 *
 * Both `openai-chat` (→ /chat/completions) and `openai-responses` (→ /responses) adapters are
 * accepted: the ollama daemon's OpenAI-compatible surface speaks either, and users may run their main
 * model through the responses adapter. The executor branches the summarize wire format on adapter.
 * Ollama needs no credential for local web_search — the daemon signs requests to ollama cloud
 * internally — so "usable" just means "present, not disabled, and an OpenAI-compatible adapter".
 */
export interface OllamaSidecarProvider {
  providerName: string;
  provider: OcxProviderConfig;
}

/**
 * First enabled anthropic-adapter OAuth provider whose ACTIVE account holds a usable credential — the
 * only path that can run web_search_20250305 without a ChatGPT forward provider. Presence is decided by
 * getAccountSet + the active account's `needsReauth` marker (audit F1: getCredential alone can pick a
 * terminally-invalid account); token refresh happens later at executor time.
 */
export function findAnthropicSidecarProvider(config: OcxConfig): AnthropicSidecarProvider | undefined {
  for (const [name, prov] of Object.entries(config.providers)) {
    if (prov.disabled === true) continue;
    if (prov.adapter !== "anthropic" || prov.authMode !== "oauth") continue;
    const set = getAccountSet(name);
    const active = set?.accounts.find(a => a.id === set.activeAccountId);
    if (active && active.needsReauth !== true) return { providerName: name, provider: prov };
  }
  return undefined;
}

/**
 * Find the ollama provider for the sidecar by scanning config.providers (NOT routeModel): the GUI
 * stores the BARE model id, so routeModel would route `glm-5.2:cloud` to the default provider
 * (often "openai") — wrong. Instead we identify the ollama provider directly, by config key "ollama"
 * (the registry default id) or by an ollama host root (the local daemon on :11434, or ollama.com).
 * The web_search endpoint lives at the daemon's host root, so the baseUrl host is the principled
 * discriminator. Only OpenAI-compatible adapters qualify, since the executor summarizes via
 * /chat/completions or /responses.
 */
export function findOllamaSidecarProvider(config: OcxConfig): OllamaSidecarProvider | undefined {
  for (const [name, prov] of Object.entries(config.providers)) {
    if (prov.disabled === true) continue;
    if (prov.adapter !== "openai-chat" && prov.adapter !== "openai-responses") continue;
    // Identify the ollama provider: by the conventional registry key, or by an ollama host root
    // (local daemon on :11434, or ollama.com / *.ollama.com). Strip a trailing /v1 before parsing.
    let host = "";
    try {
      const stripped = (prov.baseUrl ?? "").replace(/\/v1\/?$/, "").replace(/\/+$/, "");
      host = stripped ? new URL(stripped).host.toLowerCase() : "";
    } catch {
      host = "";
    }
    const isOllamaHost =
      host === "ollama.com" ||
      host.endsWith(".ollama.com") ||
      host === "localhost:11434" ||
      host === "127.0.0.1:11434";
    if (name === "ollama" || isOllamaHost) return { providerName: name, provider: prov };
  }
  return undefined;
}

/**
 * Precedence: explicit config wins; unset defaults to "openai" (ChatGPT forward path). The
 * anthropic backend (web_search_20250305) is only used when explicitly configured — auto-selecting
 * it from credential availability caused the sidecar to send incompatible models (e.g. gpt-5.6-luna)
 * to the Anthropic API. The ollama backend is likewise opt-in only.
 */
export function resolveSidecarBackend(
  explicit: "openai" | "anthropic" | "ollama" | undefined,
): "openai" | "anthropic" | "ollama" {
  if (explicit === "anthropic") return "anthropic";
  if (explicit === "ollama") return "ollama";
  return "openai";
}

export interface SidecarPlan {
  /** Which executor runs the search. Anthropic/Ollama do not require a forward provider. */
  backend: "openai" | "anthropic" | "ollama";
  /** Present for the openai backend (ChatGPT forward path); undefined for anthropic/ollama. */
  forwardSidecar?: ResolvedOpenAiForwardSidecar;
  /** Present for the anthropic backend (stored-OAuth /v1/messages path); undefined for openai/ollama. */
  anthropicSidecar?: AnthropicSidecarProvider;
  /** Present for the ollama backend (local/hosted web_search + summarize); undefined for openai/anthropic. */
  ollamaSidecar?: OllamaSidecarProvider;
  hostedTool: Record<string, unknown>;
  settings: SidecarSettings;
  maxSearches: number;
  /** Resolved routed-model response-body raw-byte inactivity deadline (ms). */
  routedModelStallTimeoutMs: number;
  /** Effective bridge stall deadline for the sidecar turn (see webSearchStallTimeoutSec). */
  stallTimeoutSec: number;
}

export function shouldResolveOpenAiWebSearchSidecar(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  isPassthrough: boolean,
): boolean {
  if (!parsed._webSearch || isPassthrough) return false;
  const cfg = config.webSearchSidecar ?? {};
  return cfg.enabled !== false && resolveSidecarBackend(cfg.backend) === "openai";
}

/**
 * Decide whether the web-search sidecar should handle this request, returning the plan if so. Active
 * when: web_search was requested (`parsed._webSearch`), the route is NOT the passthrough adapter
 * (native gpt already searches server-side), a forward provider exists, the sidecar isn't disabled,
 * and the caller forwarded ChatGPT auth. Returns undefined otherwise (request takes the normal path).
 */
export function planWebSearch(
  config: OcxConfig,
  parsed: OcxParsedRequest,
  isPassthrough: boolean,
  provider: OcxProviderConfig,
  modelId: string,
  openAiSidecar?: ResolvedOpenAiForwardSidecar,
): SidecarPlan | undefined {
  if (!parsed._webSearch || isPassthrough) return undefined;
  const cfg = config.webSearchSidecar ?? {};
  if (cfg.enabled === false) return undefined;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const routedModelStallTimeoutMs = resolveRoutedModelStallTimeoutMs(cfg.routedModelStallTimeoutMs);
  // Same `?? 200_000` default the server applies when threading connectTimeoutMs into the loop.
  const connectTimeoutMs = config.connectTimeoutMs ?? 200_000;
  const anthropicSidecar = findAnthropicSidecarProvider(config);
  const backend = resolveSidecarBackend(cfg.backend);
  const maxSearches = cfg.maxSearchesPerTurn ?? DEFAULT_MAX_SEARCHES;
  const stallTimeoutSec = webSearchStallTimeoutSec(
    config.stallTimeoutSec,
    connectTimeoutMs,
    routedModelStallTimeoutMs,
    timeoutMs,
  );
  // The routed model being text-only means the search model must verbalize image results (either backend).
  const describeImages = modelInList(provider.noVisionModels, modelId);
  const reasoning = cfg.reasoning ?? DEFAULT_SIDECAR_REASONING;

  // Anthropic backend authenticates with the STORED credential — no forward provider or ChatGPT login gate.
  // resolveSidecarBackend only returns "anthropic" when it was explicitly configured OR a usable credential
  // exists; an EXPLICIT anthropic choice with no usable credential FAILS CLOSED (no plan) rather than
  // silently borrowing ChatGPT credentials (audit round-2 F1).
  if (backend === "anthropic") {
    if (!anthropicSidecar) return undefined;
    return {
      backend: "anthropic",
      anthropicSidecar,
      hostedTool: parsed._webSearch,
      settings: { model: cfg.model ?? DEFAULT_ANTHROPIC_SIDECAR_MODEL, reasoning, timeoutMs, describeImages },
      maxSearches,
      routedModelStallTimeoutMs,
      stallTimeoutSec,
    };
  }

  // Ollama backend: calls the ollama web_search REST endpoint (local daemon keyless, or hosted
  // ollama.com with a bearer API key) and summarizes the results via the SAME ollama provider. The
  // model is mandatory — there is no sensible default ollama model, so fail closed without one
  // (mirrors the vision routed backend). The provider is found by scanning config.providers
  // (findOllamaSidecarProvider), NOT routeModel: the GUI stores the BARE model id, so routeModel
  // would mis-route it to the default provider. cfg.model is sent to ollama verbatim as the native
  // model id (any "ollama/" prefix is stripped defensively).
  if (backend === "ollama") {
    const ollamaSidecar = findOllamaSidecarProvider(config);
    if (!ollamaSidecar) return undefined;
    const nativeModelId = stripProviderPrefix(cfg.model);
    if (!nativeModelId) return undefined;
    return {
      backend: "ollama",
      ollamaSidecar,
      hostedTool: parsed._webSearch,
      settings: { model: nativeModelId, reasoning, timeoutMs, describeImages },
      maxSearches,
      routedModelStallTimeoutMs,
      stallTimeoutSec,
    };
  }

  // OpenAI backend: needs a ChatGPT login (main) and a forward provider to reach server-side web_search.
  if (!openAiSidecar) return undefined;
  return {
    backend: "openai",
    forwardSidecar: openAiSidecar,
    hostedTool: parsed._webSearch,
    settings: { model: cfg.model ?? DEFAULT_SIDECAR_MODEL, reasoning, timeoutMs, describeImages },
    maxSearches,
    routedModelStallTimeoutMs,
    stallTimeoutSec,
  };
}
