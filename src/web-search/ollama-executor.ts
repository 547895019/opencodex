import type { OcxProviderConfig } from "../types";
import { signalWithTimeout, cancelBodyOnAbort } from "../lib/abort";
import { redactSecretString } from "../lib/redact";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import type { WebSearchSource } from "./parse";
import { parseOllamaChatSSE, parseSidecarSSE, extractTrailingSources } from "./parse";
import { BASE_INSTRUCTION, IMAGE_INSTRUCTION, type SidecarOutcome, type SidecarSettings } from "./executor";

/** Max search results requested from the ollama web_search endpoint (API max is 10). */
const OLLAMA_MAX_RESULTS = 5;
/** Answer budget for the summarize step; the injected tool_result is clamped downstream anyway. */
const OLLAMA_SUMMARY_MAX_TOKENS = 2048;
/**
 * Per-hit content cap and total snippet cap for the summarize prompt. The ollama web_search endpoint
 * returns each result's `content` as full page text — 5 hits can run to 500k+ tokens and blow the
 * summarize model's context (e.g. kimi 262k). The URLs (authoritative sources) are captured separately
 * and unaffected, so truncating content only loses prose detail the model would paraphrase anyway.
 * ~8k chars ≈ 2-3k tokens, comfortably under every supported model's context window.
 */
const OLLAMA_MAX_HIT_CONTENT_CHARS = 1200;
const OLLAMA_MAX_SNIPPET_CHARS = 8000;

interface OllamaSearchHit {
  title?: string;
  url?: string;
  content?: string;
}

function isHit(v: unknown): v is OllamaSearchHit {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Derive the ollama web_search endpoint URL from a provider baseUrl.
 *
 * Both OpenAI-compatible adapters (openai-chat, openai-responses) carry `/v1` on the baseUrl (e.g.
 * `http://localhost:11434/v1` or `https://ollama.com/v1`); the web_search endpoint lives at the HOST
 * ROOT, not under `/v1`, so strip the trailing `/v1`. Local daemons expose `/api/experimental/web_search`
 * (the daemon signs and forwards to ollama cloud, so no key is needed); the hosted `ollama.com` API
 * exposes `/api/web_search` (bearer API key required). Returns `{ searchUrl, hosted }`.
 */
function deriveSearchUrl(baseUrl: string): { searchUrl: string; hosted: boolean } {
  const base = baseUrl.replace(/\/v1\/?$/, "").replace(/\/+$/, "");
  let host = "";
  try { host = new URL(base).host.toLowerCase(); } catch { /* leave host empty */ }
  const hosted = host === "ollama.com" || host.endsWith(".ollama.com");
  return { searchUrl: `${base}${hosted ? "/api/web_search" : "/api/experimental/web_search"}`, hosted };
}

/**
 * Execute ONE web search via the ollama backend: call the ollama web_search REST endpoint for the
 * query, then summarize the results into a concise answer + `Sources:` via one chat-completions call
 * to the routed ollama model. Unlike the OpenAI/Anthropic backends, the model has no built-in
 * server-side search tool, so the search is a standalone REST call and the model only summarizes.
 *
 * The local daemon needs no API key (it signs to ollama cloud internally); a hosted `ollama.com`
 * baseUrl requires a bearer key from `provider.apiKey`. Never throws — returns `{error}` so the
 * caller injects a graceful tool result (honors the F5 never-throws contract).
 */
export async function runOllamaWebSearch(
  query: string,
  _providerName: string,
  provider: OcxProviderConfig,
  settings: SidecarSettings,
  abortSignal?: AbortSignal,
): Promise<SidecarOutcome> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (provider.apiKey) headers["Authorization"] = `Bearer ${provider.apiKey}`;
  if (provider.headers) Object.assign(headers, provider.headers);

  const { searchUrl } = deriveSearchUrl(provider.baseUrl);
  // Summarize wire format branches on the provider adapter. openai-responses → POST to the
  // responses endpoint (parsed by parseSidecarSSE, which already strips the Sources block and
  // extracts citations). openai-chat → POST {base}/chat/completions with a chat body (parsed by
  // parseOllamaChatSSE; Sources block stripped via extractTrailingSources). The responses URL is
  // built the SAME way the openai-responses adapter builds it (src/adapters/openai-responses.ts:628):
  // if responsesPath is unset, strip a trailing /v1 and re-append /v1/responses; otherwise append the
  // configured responsesPath to the baseUrl. This keeps the sidecar consistent with the main route.
  const useResponses = provider.adapter === "openai-responses";
  const summarizeUrl = useResponses
    ? provider.responsesPath === undefined
      ? `${provider.baseUrl.replace(/\/v1\/?$/, "")}/v1/responses`
      : `${provider.baseUrl.replace(/\/$/, "")}${provider.responsesPath}`
    : `${(provider.baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`;

  const instruction = settings.describeImages ? BASE_INSTRUCTION + IMAGE_INSTRUCTION : BASE_INSTRUCTION;
  const linkedSignal = signalWithTimeout(settings.timeoutMs, abortSignal);
  const sidecarExit = sidecarEnter("web-search");
  const t0 = Date.now();
  try {
    // 1) Run the search.
    const searchRes = await fetchWithResetRetry(
      () => fetch(searchUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ query, max_results: OLLAMA_MAX_RESULTS }),
        signal: linkedSignal.signal,
      }),
      { abortSignal: linkedSignal.signal, label: "web-search-sidecar-ollama-search" },
    );
    if (!searchRes.ok) {
      const t = await searchRes.text().catch(() => "");
      console.warn(`[web-search] ollama search HTTP ${searchRes.status} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
      return { text: "", sources: [], error: `ollama search HTTP ${searchRes.status}: ${redactSecretString(t.slice(0, 200))}` };
    }
    const searchJson = await searchRes.json().catch(() => null) as { results?: unknown } | null;
    const rawHits = Array.isArray(searchJson?.results) ? searchJson.results : [];
    const hits = rawHits.filter(isHit);
    if (hits.length === 0) {
      console.warn(`[web-search] ollama search returned no results for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
      return { text: "", sources: [], error: "ollama web search returned no results" };
    }

    // Authoritative sources come from the search results; the summarize stream only verbalizes them.
    const sources: WebSearchSource[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      if (typeof hit.url !== "string" || hit.url.length === 0 || seen.has(hit.url)) continue;
      seen.add(hit.url);
      sources.push(typeof hit.title === "string" && hit.title.length > 0 ? { url: hit.url, title: hit.title } : { url: hit.url });
    }

    // 2) Summarize the results via the SAME ollama provider. Branch the body on adapter.
    // Truncate each hit's content and the total snippet: ollama web_search returns full page text per
    // result, which can blow the summarize model's context (500k+ tokens). URLs are captured above as
    // authoritative sources, so truncating content only drops prose the model would paraphrase anyway.
    const parts: string[] = [];
    let totalLen = 0;
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const title = typeof hit.title === "string" ? hit.title : "";
      const url = typeof hit.url === "string" ? hit.url : "";
      const content = (typeof hit.content === "string" ? hit.content : "").slice(0, OLLAMA_MAX_HIT_CONTENT_CHARS);
      const entry = `[${i + 1}] ${title}\nURL: ${url}\n${content}`;
      if (totalLen + entry.length > OLLAMA_MAX_SNIPPET_CHARS && parts.length > 0) break;
      parts.push(entry);
      totalLen += entry.length;
    }
    const snippet = parts.join("\n\n");
    const userText = `${query}\n\nUse these web search results to answer. Cite sources inline and end with a Sources: section.\n\n${snippet}`;
    const summarizeBody = useResponses
      ? {
          model: settings.model,
          instructions: instruction,
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: userText }] }],
          stream: true,
        }
      : {
          model: settings.model,
          max_tokens: OLLAMA_SUMMARY_MAX_TOKENS,
          stream: true,
          messages: [
            { role: "system", content: instruction },
            { role: "user", content: userText },
          ],
        };
    const summarizeRes = await fetchWithResetRetry(
      () => fetch(summarizeUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(summarizeBody),
        signal: linkedSignal.signal,
      }),
      { abortSignal: linkedSignal.signal, label: "web-search-sidecar-ollama-summarize" },
    );
    if (!summarizeRes.ok) {
      const t = await summarizeRes.text().catch(() => "");
      console.warn(`[web-search] ollama summarize HTTP ${summarizeRes.status} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms) url=${summarizeUrl} resp=${redactSecretString(t.slice(0, 300))}`);
      // The search succeeded, so still return the sources; the main model can fall back to the raw
      // search snippets the tool_result would otherwise carry — but the contract wants text, so mark error.
      return { text: "", sources, error: `ollama summarize HTTP ${summarizeRes.status}: ${redactSecretString(t.slice(0, 200))}` };
    }
    console.log(`[web-search] ollama summarize ok model=${settings.model} adapter=${provider.adapter ?? "?"} hits=${hits.length} snippet=${snippet.length}chars query="${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
    const detachBodyGuard = cancelBodyOnAbort(summarizeRes.body, linkedSignal.signal);
    try {
      if (useResponses) {
        // parseSidecarSSE already strips the trailing Sources block and collects citation annotations.
        const parsed = await parseSidecarSSE(summarizeRes);
        if (parsed.error) return { text: "", sources, error: parsed.error };
        // Merge: search-derived sources first (authoritative), then any model-cited URLs not present.
        const merged = [...sources];
        const seenMerge = new Set(merged.map(s => s.url));
        for (const s of parsed.sources) {
          if (s.url && !seenMerge.has(s.url)) { seenMerge.add(s.url); merged.push(s); }
        }
        return { text: parsed.text, sources: merged };
      }
      const parsed = await parseOllamaChatSSE(summarizeRes);
      if (parsed.error) return { text: "", sources, error: parsed.error };
      // parseOllamaChatSSE returns raw text (with the Sources block) and no sources; strip the block
      // so the tool_result renderer doesn't print sources twice, then merge the search-derived sources.
      const { text: body } = extractTrailingSources(parsed.text);
      return { text: body, sources };
    } finally {
      detachBodyGuard();
    }
  } catch (e) {
    const kind = e instanceof Error && e.name === "TimeoutError" ? "timeout" : "connect_error";
    console.warn(`[web-search] ollama sidecar ${kind} for query "${query.slice(0, 80)}" (${Date.now() - t0}ms)`);
    return { text: "", sources: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    sidecarExit();
    linkedSignal.cleanup();
  }
}