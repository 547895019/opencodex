import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CatalogModel } from "../../codex/catalog";
import { catalogModelSlug, invalidateCodexModelsCache, nativeModelRows, uniqueCatalogModelsForPublicList } from "../../codex/catalog";
import {
  DEFAULT_SUBAGENT_MODELS,
  codexAutoStartEnabled,
  hasOwnProvider,
  isValidProviderName,
  multiAgentGuidanceEnabled,
  providerBaseUrlConfigError,
  providerHeadersConfigError,
  saveConfig,
} from "../../config";
import {
  clearLoginState,
  getLoginStatus,
  isPublicOAuthProvider,
  listOAuthProviders,
  startLoginFlow,
  submitManualLoginCode,
  upsertOAuthProvider,
} from "../../oauth";
import { removeCredential } from "../../oauth/store";
import { providerDestinationResolvedError } from "../../lib/destination-policy";
import { enrichProviderFromCatalog, listKeyLoginProviders } from "../../oauth/key-providers";
import { deriveProviderPresets } from "../../providers/derive";
import { providerCodexAccountMode } from "../../providers/registry";
import { routedSlug, slugEquals } from "../../providers/slug-codec";
import { clearProviderQuotaCache, fetchProviderQuotaReports } from "../../providers/quota";
import { isCanonicalOpenAiForwardProvider } from "../../providers/openai-tiers";
import { clearThreadAccountMap } from "../../codex/routing";
import { primeCodexPoolQuotas } from "../../codex/auth-api";
import { DEFAULT_PROVIDER_CONTEXT_CAP, globalContextCapValue, providerContextCap, providerContextCaps, setAllProviderContextCaps, setGlobalContextCapValue, setProviderContextCap } from "../../providers/context-cap";
import { resolveCodexHomeDir } from "../../codex/home";
import { scanStorage } from "../../storage/scanner";
import { readUsageEntries } from "../../usage/log";
import { getUsageDebugLogEntries } from "../../usage/debug";
import { parseRange, parseUsageSurface, summarizeUsage } from "../../usage/summary";
import { stripCodexRuntimeProviderFields } from "../../codex/auth-context";
import { getProviderRegistryEntry } from "../../providers/registry";
import { getDebugLogEntries } from "../../lib/debug-log-buffer";
import { getInjectionDebugLogEntries } from "../../lib/injection-debug-log";
import {
  clearDebugSettings,
  clearDebugSetting,
  getDebugSettings,
  setDebugSettings,
  type DebugFlag,
} from "../../lib/debug-settings";
import {
  clearPromptCapture,
  getPromptCaptureEntries,
  getPromptCaptureOptions,
  loadPromptCaptureConfig,
  MAX_ENTRIES_CAP,
  setPromptCaptureOptions,
  type PromptCaptureRedaction,
} from "../../lib/prompt-capture";
import type { OcxClaudeCodeConfig, OcxConfig, OcxCustomModel, OcxProviderConfig } from "../../types";
import { drainAndShutdown } from "../lifecycle";
import { filterRequestLogs, getRequestLogEntries, type RequestLogEntry } from "../request-log";
import { estimateComboCost, estimateRequestCost, normalizeCostTokens, tokensPerSecond } from "../../usage/cost";
import type { PersistedUsageAttempt } from "../../usage/log";
import { isAllowedRequestOrigin, jsonResponse, providerManagementConfigError, publicProviderBaseUrl, safeConfigDTO } from "../auth-cors";
import { applySystemEnvToggle } from "../system-env";

import { isPlainRecord, parseDebugLogQuery, tokPerSecondResult, unavailableCostReason, costResult, requestLogDto, stripRegistryOnlyStaticHeaders, fetchAllModels } from "./shared";
import type { MetricUnavailableReason, TokPerSecondResult, CostEstimateReason, CostResult, MetricSource } from "./shared";
import type { ManagementContext } from "./context";

export async function handleLogsUsageRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url, config, deps, refreshCodexCatalogBestEffort, syncClaudeAgentDefsBestEffort } = ctx;

  if (url.pathname === "/api/logs" && req.method === "GET") {
    const logs = filterRequestLogs(getRequestLogEntries(), url.searchParams);
    return jsonResponse(logs.map(requestLogDto));
  }

  if (url.pathname === "/api/debug" && req.method === "GET") {
    return jsonResponse(getDebugSettings());
  }

  if (url.pathname === "/api/debug/logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/debug/usage-logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getUsageDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/claude/inbound-debug" && req.method === "GET") {
    const { getClaudeInboundDebugEntries } = await import("../../claude/inbound-debug");
    const { isClaudeDebugEnabled } = await import("../../lib/debug-settings");
    return jsonResponse({ enabled: isClaudeDebugEnabled(), entries: getClaudeInboundDebugEntries() });
  }

  if (url.pathname === "/api/debug/prompt-capture" && req.method === "GET") {
    const { isPromptCaptureEnabled } = await import("../../lib/debug-settings");
    const opts = getPromptCaptureOptions();
    return jsonResponse({
      enabled: isPromptCaptureEnabled(),
      redaction: opts.redaction,
      maxEntries: opts.maxEntries,
      entries: getPromptCaptureEntries(),
    });
  }

  if (url.pathname === "/api/debug/prompt-capture" && req.method === "PUT") {
    let raw: unknown;
    try { raw = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (!isPlainRecord(raw)) return jsonResponse({ error: "body must be a JSON object" }, 400);
    const body = raw as { redaction?: unknown; maxEntries?: unknown };
    const opts: { redaction?: PromptCaptureRedaction; maxEntries?: number } = {};
    if (body.redaction !== undefined) {
      if (body.redaction !== "none" && body.redaction !== "secrets" && body.redaction !== "secrets-pii") {
        return jsonResponse({ error: "redaction must be none, secrets, or secrets-pii" }, 400);
      }
      opts.redaction = body.redaction;
    }
    if (body.maxEntries !== undefined) {
      if (typeof body.maxEntries !== "number" || !Number.isInteger(body.maxEntries)
        || body.maxEntries < 1 || body.maxEntries > MAX_ENTRIES_CAP) {
        return jsonResponse({ error: `maxEntries must be a positive integer <= ${MAX_ENTRIES_CAP}` }, 400);
      }
      opts.maxEntries = body.maxEntries;
    }
    if (opts.redaction === undefined && opts.maxEntries === undefined) {
      return jsonResponse({ error: "provide redaction and/or maxEntries" }, 400);
    }
    setPromptCaptureOptions(opts);
    config.debug = { ...(config.debug ?? {}) };
    config.debug.promptCapture = {
      ...(config.debug.promptCapture ?? {}),
      ...(opts.redaction !== undefined ? { redaction: opts.redaction } : {}),
      ...(opts.maxEntries !== undefined ? { maxEntries: opts.maxEntries } : {}),
    };
    saveConfig(config);
    const snap = getPromptCaptureOptions();
    return jsonResponse({ ok: true, redaction: snap.redaction, maxEntries: snap.maxEntries });
  }

  if (url.pathname === "/api/debug/prompt-capture/clear" && req.method === "POST") {
    clearPromptCapture();
    return jsonResponse({ ok: true });
  }

  if (url.pathname === "/api/debug/injection-logs" && req.method === "GET") {
    const { after, limit } = parseDebugLogQuery(url);
    return jsonResponse(getInjectionDebugLogEntries({ after, limit }));
  }

  if (url.pathname === "/api/debug" && req.method === "PUT") {
    let body: { debug?: unknown; usage?: unknown; injection?: unknown; claude?: unknown; promptCapture?: unknown; reset?: unknown };
    try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
    if (body.reset === true) return jsonResponse(clearDebugSettings());
    if (body.reset === "debug" || body.reset === "provider") return jsonResponse(clearDebugSetting("debug"));
    if (body.reset === "usage") return jsonResponse(clearDebugSetting("usage"));
    if (body.reset === "injection") return jsonResponse(clearDebugSetting("injection"));
    if (body.reset === "claude") return jsonResponse(clearDebugSetting("claude"));
    if (body.reset === "promptCapture") return jsonResponse(clearDebugSetting("promptCapture"));
    const partial: Partial<Record<DebugFlag, boolean>> = {};
    for (const key of ["debug", "usage", "injection", "claude", "promptCapture"] as const) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== "boolean") return jsonResponse({ error: `${key} must be a boolean` }, 400);
      partial[key] = body[key];
    }
    if (Object.keys(partial).length === 0) {
      return jsonResponse({ error: "provide debug/usage/injection/claude/promptCapture booleans or reset:true" }, 400);
    }
    // Turning capture off should also flush already-captured entries (privacy contract).
    if (partial.claude === false) {
      const { clearClaudeInboundDebug } = await import("../../claude/inbound-debug");
      clearClaudeInboundDebug();
    }
    if (partial.promptCapture === false) {
      clearPromptCapture();
    }
    return jsonResponse(setDebugSettings(partial));
  }

  if (url.pathname === "/api/usage" && req.method === "GET") {
    const range = parseRange(url.searchParams.get("range"));
    const surface = parseUsageSurface(url.searchParams.get("surface"));
    const now = Date.now();
    try {
      return jsonResponse(summarizeUsage(readUsageEntries(), range, now, surface));
    } catch {
      return jsonResponse({
        range,
        surface,
        since: null,
        generatedAt: now,
        summary: {
          requests: 0,
          attemptCount: 0,
          measuredRequests: 0,
          reportedRequests: 0,
          unreportedRequests: 0,
          unsupportedRequests: 0,
          estimatedRequests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningOutputTokens: 0,
          totalTokens: 0,
          coverageRatio: 0,
          estimatedCostUsd: 0,
          pricedRequests: 0,
          unpricedRequests: 0,
          unmeteredRequests: 0,
        },
        days: [],
        models: [],
        providers: [],
        error: "read_failed",
      });
    }
  }

  if (url.pathname === "/api/storage" && req.method === "GET") {
    try {
      return jsonResponse(scanStorage());
    } catch {
      return jsonResponse({
        codexHome: resolveCodexHomeDir(),
        generatedAt: Date.now(),
        total: { bytes: 0, fileCount: 0 },
        buckets: [],
        error: "scan_failed",
      });
    }
  }
  return null;
}
