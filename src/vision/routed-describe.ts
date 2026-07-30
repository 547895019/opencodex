import type { OcxConfig, OcxParsedRequest, OcxContentPart } from "../types";
import { routeModel } from "../router";
import { resolveAdapter, resolveWireProtocolOverride } from "../server/adapter-resolve";
import { resolveProviderTransport } from "../providers/xai-transport";
import { providerFetch, fetchWithHeaderTimeout } from "../server/responses/fetch-helpers";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { redactSecretString } from "../lib/redact";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import { getValidAccessToken } from "../oauth";
import { validateImageUrl, type DescribeOutcome, type VisionSettings } from "./describe";

const DESCRIBE_INSTRUCTION =
  "You are a vision describer for a text-only model that cannot see the image. Describe the image " +
  "thoroughly and factually so that model can fully reason about it: transcribe any visible text " +
  "verbatim, and note UI/layout, colors, branding/logos, charts, and notable details. Focus on " +
  "what's relevant to the user's request. Output only the description.";

/**
 * Describe ONE image via an arbitrary routed provider/model through the normal routing pipeline —
 * the path that lets users pick any configured vision-capable model (gemini, openrouter, ollama/llava,
 * …) as the sidecar instead of only the ChatGPT forward / Anthropic OAuth backends. The describe
 * request is built by the routed model's own adapter (so image normalization covers every wire
 * format) and never re-enters `handleResponses`, so it can't trip the reactive vision-mark branch.
 * Never throws — returns `{error}` on failure so the caller can inject a graceful marker.
 */
export async function describeImageRouted(
  imageUrl: string,
  detail: string | undefined,
  contextText: string,
  modelId: string,
  config: OcxConfig,
  settings: VisionSettings,
  abortSignal?: AbortSignal,
): Promise<DescribeOutcome> {
  const invalid = validateImageUrl(imageUrl);
  if (invalid) return { text: "", error: invalid };

  // 1. Route the sidecar model id to its provider/adapter.
  let route;
  try {
    route = routeModel(config, modelId);
  } catch (e) {
    return { text: "", error: `routed vision sidecar: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 2. Build a minimal synthetic OcxParsedRequest — one user turn, text + image, stream:true.
  const userParts: OcxContentPart[] = [];
  if (contextText) userParts.push({ type: "text", text: `The user's request about this image: ${contextText}` });
  userParts.push({ type: "image", imageUrl, ...(detail ? { detail } : {}) });
  const parsed: OcxParsedRequest = {
    modelId: route.modelId,
    context: {
      systemPrompt: [DESCRIBE_INSTRUCTION],
      messages: [{ role: "user", content: userParts, timestamp: Date.now() }],
    },
    stream: true,
    options: {},
  };

  // 3. Resolve the adapter exactly as the main path does (core.ts:913-942). OAuth providers
  //    (kimi, xai, github-copilot, kiro, …) carry no static apiKey — the main path swaps in a
  //    fresh access token as the Bearer key before buildRequest. Mirror that here, or the
  //    openai-chat/anthropic adapters reject the request as credential-less.
  let routedProvider = route.provider;
  if (route.provider.authMode === "oauth") {
    try {
      const token = await getValidAccessToken(route.providerName);
      // A stored credential can exist with an empty/blank `access` field (e.g. a partially
      // imported or not-yet-refreshed grant) — getValidAccessToken returns "" without throwing
      // in that case. Failing closed here surfaces a clear auth error instead of letting the
      // request reach buildRequest with an empty apiKey, which throws the opaque
      // "openai-chat requires a non-empty credential" downstream.
      if (!token.trim()) return { text: "", error: `routed vision sidecar auth: empty access token for ${route.providerName}` };
      routedProvider = { ...route.provider, apiKey: token };
    } catch (e) {
      return { text: "", error: `routed vision sidecar auth: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const provider = resolveProviderTransport(route.providerName, routedProvider, undefined, undefined);
  const adapterProvider = resolveWireProtocolOverride(route.providerName, route.modelId, provider);
  let adapter;
  try {
    adapter = resolveAdapter(adapterProvider, config.cacheRetention);
  } catch (e) {
    return { text: "", error: `routed vision sidecar: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 4. buildRequest (may be async; may throw on missing apiKey — becomes an error outcome).
  let request;
  try {
    request = await adapter.buildRequest(parsed, { headers: new Headers() });
  } catch (e) {
    return { text: "", error: `routed vision sidecar buildRequest: ${e instanceof Error ? e.message : String(e)}` };
  }

  // 5. Fetch with timeout. Reuse the same path as core.ts:1515-1533.
  const linked = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("vision");
  const t0 = Date.now();
  try {
    let res: Response;
    if (adapter.fetchResponse) {
      res = await adapter.fetchResponse(request, { abortSignal: linked.signal, timeoutMs: settings.timeoutMs, stream: true });
    } else {
      res = await fetchWithResetRetry(
        () => fetchWithHeaderTimeout(
          request.url,
          { method: request.method, headers: request.headers, body: request.body },
          linked.signal,
          settings.timeoutMs,
          true,
          providerFetch(routedProvider),
        ),
        { abortSignal: linked.signal, label: "routed-vision-sidecar" },
      );
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      console.warn(`[vision] routed sidecar HTTP ${res.status} (${Date.now() - t0}ms)`);
      return { text: "", error: `routed vision sidecar HTTP ${res.status}: ${redactSecretString(t.slice(0, 200))}` };
    }
    const detachBodyGuard = cancelBodyOnAbort(res.body, linked.signal);
    let text = "";
    let errMsg = "";
    try {
      for await (const ev of adapter.parseStream(res)) {
        if (ev.type === "text_delta") text += ev.text;
        else if (ev.type === "error") errMsg = ev.message;
        else if (ev.type === "incomplete") errMsg = ev.reason || "incomplete";
        // ignore thinking_delta, tool_call_*, heartbeat, done, web_search_*
      }
    } finally {
      detachBodyGuard();
    }
    if (!text.trim() && errMsg) return { text: "", error: errMsg };
    return { text };
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[vision] routed sidecar ${kind} (${Date.now() - t0}ms)`);
    return { text: "", error: `routed vision sidecar ${kind}: ${e instanceof Error ? e.message : String(e)}` };
  } finally {
    sidecarExit();
    linked.cleanup();
  }
}