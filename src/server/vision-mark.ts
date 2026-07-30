/**
 * Persist a model into `config.providers[name].noVisionModels` after an upstream
 * image-unsupported 400, so the user never has to hand-edit config for a text-only model.
 *
 * Writes the FULL model id (e.g. `glm-5.2:cloud`), not the colon-family stem: `modelInList`
 * already falls back to the stem, and the full id avoids over-covering a sibling that CAN see
 * images. Mutates the persisted config source (`config.providers[route.providerName]`) and
 * calls `saveConfig` for set-and-forget durability, then mirrors the entry into the merged
 * `route.provider.noVisionModels` clone so a same-request recheck of the vision gate passes.
 *
 * Combo/derived providers have no `config.providers[name]` entry; for those we skip persistence
 * (the in-memory mirror still lets this request's retry strip) — combos route through a
 * separate path and are out of scope for persistent marking.
 */
import { saveConfig, getConfigPath } from "../config";
import type { OcxConfig } from "../types";
import type { RouteResult } from "../router";

export function markModelNoVision(config: OcxConfig, route: RouteResult, modelId: string): void {
  const cfgProvider = config.providers[route.providerName];
  if (cfgProvider) {
    const list = Array.isArray(cfgProvider.noVisionModels) ? cfgProvider.noVisionModels : [];
    if (!list.includes(modelId)) {
      cfgProvider.noVisionModels = [...list, modelId];
      try {
        saveConfig(config);
      } catch {
        // Best-effort: the in-memory mutation still fixes this process; persistence is a bonus.
      }
    }
  }

  // Mirror into the merged clone so modelInList(route.provider.noVisionModels, ...) passes now
  // for any same-request recheck (the persistence source above does not feed this object).
  const merged = Array.isArray(route.provider.noVisionModels) ? route.provider.noVisionModels : [];
  if (!merged.includes(modelId)) route.provider.noVisionModels = [...merged, modelId];

  console.warn(
    `[opencodex] marked "${modelId}" as text-only (added to providers.${route.providerName}.noVisionModels in ${getConfigPath()}); `
    + `images will be stripped/described going forward. Remove the entry there if this is wrong.`,
  );
}