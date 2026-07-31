/**
 * Persist a model's accepted reasoning ladder into
 * `config.providers[name].modelReasoningEfforts[modelId]` after an upstream
 * invalid-reasoning-effort 400, so the user never has to hand-edit config for a routed model
 * that rejects an effort tier (e.g. `xhigh`) it doesn't expose.
 *
 * Writes the FULL model id (e.g. `glm-5.2:cloud`), not the colon-family stem: `modelInList`
 * already falls back to the stem, and the full id avoids over-covering a sibling that DOES
 * expose the tier. Mutates the persisted config source (`config.providers[route.providerName]`)
 * and calls `saveConfig` for set-and-forget durability, then mirrors the entry into the merged
 * `route.provider.modelReasoningEfforts` clone so a same-request recheck of the effort gate
 * passes.
 *
 * Combo/derived providers have no `config.providers[name]` entry; for those we skip
 * persistence (the in-memory mirror still lets this request's retry clamp) — combos route
 * through a separate path and are out of scope for persistent marking. Mirrors
 * `markModelNoVision` (src/server/vision-mark.ts).
 */
import { saveConfig, getConfigPath } from "../config";
import type { OcxConfig } from "../types";
import type { RouteResult } from "../router";

export function markModelReasoningEfforts(
  config: OcxConfig,
  route: RouteResult,
  modelId: string,
  ladder: string[],
): void {
  const cfgProvider = config.providers[route.providerName];
  if (cfgProvider) {
    const existing = cfgProvider.modelReasoningEfforts ?? {};
    if (!Object.prototype.hasOwnProperty.call(existing, modelId)) {
      cfgProvider.modelReasoningEfforts = { ...existing, [modelId]: ladder };
      try {
        saveConfig(config);
      } catch {
        // Best-effort: the in-memory mutation still fixes this process; persistence is a bonus.
      }
    }
  }

  // Mirror into the merged clone so configuredReasoningEfforts(route.provider, ...) sees the
  // new ladder now for any same-request recheck (the persistence source above does not feed
  // this object).
  const merged = route.provider.modelReasoningEfforts;
  if (!merged || !Object.prototype.hasOwnProperty.call(merged, modelId)) {
    route.provider.modelReasoningEfforts = { ...(merged ?? {}), [modelId]: ladder };
  }

  console.warn(
    `[opencodex] learned reasoning ladder for "${modelId}" = [${ladder.join(", ")}] `
    + `(saved to providers.${route.providerName}.modelReasoningEfforts in ${getConfigPath()}); `
    + `unsupported effort tiers will be clamped to the nearest rung going forward. `
    + `Adjust the entry there if this is wrong.`,
  );
}