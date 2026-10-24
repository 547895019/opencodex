import { createHash } from "node:crypto";
import type { OcxContentPart, OcxMessage, OcxParsedRequest, OcxTextContent } from "../types";
import { describeImage, type DescribeOutcome } from "./describe";
import { describeImageAnthropic } from "./anthropic-describe";
import { describeImageRouted } from "./routed-describe";
import type { CodexAuthContext } from "../codex/auth-context";
import type { SidecarOutcomeRecorder } from "../web-search/executor";
import { enforceAppOwnedMemoryBudget } from "../lib/app-owned-memory";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { VisionPlan } from "./plan";
import { carriesImages, descriptionEncoder, syncRawBodyImageDescriptions } from "./image-rewrite";

export { describeImage } from "./describe";
export { isModelVisionSidecarConsumer as isModelTextOnly } from "./eligibility";
export { describeImageAnthropic, parseAnthropicVisionSSE } from "./anthropic-describe";
export {
  BASELINE_VISION_MODELS,
  isModelVisionSidecarConsumer,
  isVisionEligibleModel,
  isVisionSidecarConsumer,
  modelAcceptsImageInput,
  visionBackendForCandidate,
  visionEligibleModelOptions,
} from "./eligibility";
export type { VisionCandidateModel, VisionModelOption, VisionSidecarBackend } from "./eligibility";
export { DEFAULT_VISION_TIMEOUT_MS, MAX_VISION_TIMEOUT_MS, MIN_VISION_TIMEOUT_MS } from "./timeout-bounds";
export {
  DEFAULT_MAX_DESCRIPTIONS_PER_TURN,
  resolveMaxDescriptionsPerTurn,
  isValidVisionTimeoutMs,
  resolveVisionTimeoutMs,
  findAnthropicVisionProvider,
  resolveVisionBackend,
  resolveOpenAiVisionModel,
  resolveEffectiveVisionModel,
  shouldResolveOpenAiVisionSidecar,
  planVisionSidecar,
  requiresVisionPreprocessing,
} from "./plan";
export type { AnthropicVisionProvider, VisionPlan } from "./plan";
export { stripImagesInPlace } from "./image-rewrite";


const DESCRIPTION_CACHE_MAX_ENTRIES = 256;
export const VISION_DESCRIPTION_CACHE_MAX_BYTES = 1024 * 1024;
/** Max images described in parallel — keeps first-token latency bounded without flooding the backend. */
const VISION_CONCURRENCY = 3;
/** Per-image description hard cap (chars) so multi-image turns can't blow the main model's context. */
const DESC_MAX_CHARS = 2000;
/** User-text context passed to the describer, capped. */
const CONTEXT_MAX_CHARS = 800;

export interface VisionDescriptionCache {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  clear(): void;
  snapshot?(): { count: number; bytes: number; oldestAt: number | null };
  evictOldest?(): number;
}

class BoundedLruDescriptionCache implements VisionDescriptionCache {
  private readonly entries = new Map<string, { value: string; sizeBytes: number; storedAt: number }>();
  private bytes = 0;

  constructor(private readonly maxEntries: number, private readonly maxBytes: number) {}

  get(key: string): string | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    entry.storedAt = Date.now();
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: string): void {
    const existing = this.entries.get(key);
    if (existing) {
      this.entries.delete(key);
      this.bytes -= existing.sizeBytes;
    }
    const sizeBytes = descriptionEncoder.encode(key).byteLength + descriptionEncoder.encode(value).byteLength;
    if (sizeBytes > this.maxBytes || this.maxEntries <= 0) return;
    while (this.entries.size + 1 > this.maxEntries || this.bytes + sizeBytes > this.maxBytes) {
      if (this.evictOldest() === 0) return;
    }
    this.entries.set(key, { value, sizeBytes, storedAt: Date.now() });
    this.bytes += sizeBytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  snapshot(): { count: number; bytes: number; oldestAt: number | null } {
    return {
      count: this.entries.size,
      bytes: this.bytes,
      oldestAt: this.entries.values().next().value?.storedAt ?? null,
    };
  }

  evictOldest(): number {
    const oldest = this.entries.keys().next().value;
    if (oldest === undefined) return 0;
    const entry = this.entries.get(oldest);
    if (!entry) return 0;
    this.entries.delete(oldest);
    this.bytes -= entry.sizeBytes;
    return entry.sizeBytes;
  }
}

let descriptionCacheLimits = {
  maxEntries: DESCRIPTION_CACHE_MAX_ENTRIES,
  maxBytes: VISION_DESCRIPTION_CACHE_MAX_BYTES,
};

function defaultDescriptionCache(): VisionDescriptionCache {
  return new BoundedLruDescriptionCache(descriptionCacheLimits.maxEntries, descriptionCacheLimits.maxBytes);
}

let descriptionCache: VisionDescriptionCache = defaultDescriptionCache();

/** Replace the process cache (primarily for deterministic tests). Passing undefined restores the default LRU. */
export function setVisionDescriptionCache(cache?: VisionDescriptionCache): void {
  descriptionCache = cache ?? defaultDescriptionCache();
}

export function resetVisionDescriptionCache(): void {
  descriptionCache.clear();
}

export function setVisionDescriptionCacheLimitsForTests(
  limits?: { maxEntries?: number; maxBytes?: number },
): void {
  descriptionCacheLimits = limits
    ? { maxEntries: limits.maxEntries ?? DESCRIPTION_CACHE_MAX_ENTRIES, maxBytes: limits.maxBytes ?? VISION_DESCRIPTION_CACHE_MAX_BYTES }
    : { maxEntries: DESCRIPTION_CACHE_MAX_ENTRIES, maxBytes: VISION_DESCRIPTION_CACHE_MAX_BYTES };
  descriptionCache = defaultDescriptionCache();
}

export function visionDescriptionRetainedStoreSnapshot(): {
  count: number;
  bytes: number;
  evictableBytes: number;
  pinnedBytes: number;
  oldestAt: number | null;
} {
  const snapshot = descriptionCache.snapshot?.();
  if (!snapshot) return { count: 0, bytes: 0, evictableBytes: 0, pinnedBytes: 0, oldestAt: null };
  return { ...snapshot, evictableBytes: snapshot.bytes, pinnedBytes: 0 };
}

export function evictOldestVisionDescriptionForBudget(): number {
  return descriptionCache.evictOldest?.() ?? 0;
}


/** Run `worker` over `items` with bounded concurrency, preserving input order in the result array. */
async function runBounded<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[description truncated]`;
}


/** First enabled Anthropic OAuth provider whose active stored account is not marked for reauth. */
export function findAnthropicVisionProvider(config: OcxConfig): AnthropicVisionProvider | undefined {
  for (const [providerName, provider] of Object.entries(config.providers)) {
    if (provider.disabled === true || provider.adapter !== "anthropic" || provider.authMode !== "oauth") continue;
    const accountSet = getAccountSet(providerName);
    const active = accountSet?.accounts.find(account => account.id === accountSet.activeAccountId);
    if (active && active.needsReauth !== true) return { providerName, provider };
  }
  return undefined;
}

export function resolveVisionBackend(
  explicit: "openai" | "anthropic" | "routed" | undefined,
  anthropicSidecar: AnthropicVisionProvider | undefined,
): "openai" | "anthropic" | "routed" {
  if (explicit === "openai" || explicit === "anthropic" || explicit === "routed") return explicit;
  return anthropicSidecar ? "anthropic" : "openai";
}

/** Native model used by the OpenAI vision helper, including its bounded default. */
export function resolveOpenAiVisionModel(config: Pick<OcxConfig, "visionSidecar">): string {
  return config.visionSidecar?.model || DEFAULT_VISION_MODEL;
}

/** Effective describer model for the backend `planVisionSidecar` selected. */
export function resolveEffectiveVisionModel(
  config: Pick<OcxConfig, "visionSidecar">,
  backend: "openai" | "anthropic",
): string {
  return backend === "anthropic"
    ? config.visionSidecar?.model || DEFAULT_ANTHROPIC_VISION_MODEL
    : resolveOpenAiVisionModel(config);
}

/** A user/developer/toolResult message can carry images (toolResult: e.g. Codex view_image output). */
function carriesImages(role: string): boolean {
  return role === "user" || role === "developer" || role === "toolResult";
}

export function messagesHaveImage(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(m =>
    carriesImages(m.role) && Array.isArray(m.content) && (m.content as OcxContentPart[]).some(p => p.type === "image"));
}

export function shouldResolveOpenAiVisionSidecar(
  config: OcxConfig,
  provider: OcxProviderConfig,
  modelId: string,
  parsed: OcxParsedRequest,
): boolean {
  if (!modelInList(provider.noVisionModels, modelId) || !messagesHaveImage(parsed)) return false;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return false;
  return resolveVisionBackend(cfg.backend, findAnthropicVisionProvider(config)) === "openai";
}

export interface VisionPlan {
  backend: "openai" | "anthropic" | "routed";
  forwardSidecar?: ResolvedOpenAiForwardSidecar;
  anthropicSidecar?: AnthropicVisionProvider;
  /** For `backend:"routed"`: the routed model id to describe images through (cfg.model). */
  routedModel?: string;
  settings: VisionSettings;
  maxDescriptionsPerTurn: number;
}

/**
 * Decide whether the vision sidecar should pre-describe images for this request, returning the plan
 * if so. Active when: the routed model is in `provider.noVisionModels`, the request actually carries
 * an image, the sidecar isn't disabled, and the selected backend has usable auth. Returns undefined
 * otherwise (the caller strips images before sending to a text-only model).
 */
export function planVisionSidecar(
  config: OcxConfig,
  provider: OcxProviderConfig,
  modelId: string,
  parsed: OcxParsedRequest,
  openAiSidecar?: ResolvedOpenAiForwardSidecar,
): VisionPlan | undefined {
  if (!modelInList(provider.noVisionModels, modelId)) return undefined;
  if (!messagesHaveImage(parsed)) return undefined;
  const cfg = config.visionSidecar ?? {};
  if (cfg.enabled === false) return undefined;
  const anthropicSidecar = findAnthropicVisionProvider(config);
  const backend = resolveVisionBackend(cfg.backend, anthropicSidecar);
  const maxDescriptionsPerTurn = resolveMaxDescriptionsPerTurn(cfg.maxDescriptionsPerTurn);

  if (backend === "routed") {
    const routedModel = cfg.model;
    if (!routedModel) return undefined; // no sensible default routed model — fail closed (caller strips)
    return {
      backend: "routed",
      routedModel,
      settings: {
        model: routedModel,
        reasoning: normalizeVisionReasoningForModel(routedModel, cfg.reasoning) ?? DEFAULT_REASONING,
        timeoutMs: cfg.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS,
      },
      maxDescriptionsPerTurn,
    };
  }

  if (backend === "anthropic") {
    if (!anthropicSidecar) return undefined;
    const model = resolveEffectiveVisionModel(config, backend);
    return {
      backend,
      anthropicSidecar,
      settings: {
        model,
        reasoning: normalizeVisionReasoningForModel(model, cfg.reasoning) ?? DEFAULT_REASONING,
        timeoutMs: resolveVisionTimeoutMs(cfg.timeoutMs),
      },
      maxDescriptionsPerTurn,
    };
  }

  const model = resolveEffectiveVisionModel(config, "openai");
  if (!openAiSidecar) return undefined;
  return {
    backend,
    forwardSidecar: openAiSidecar,
    settings: {
      model,
      reasoning: normalizeVisionReasoningForModel(model, cfg.reasoning) ?? DEFAULT_REASONING,
        timeoutMs: resolveVisionTimeoutMs(cfg.timeoutMs),
    },
    maxDescriptionsPerTurn,
  };
}