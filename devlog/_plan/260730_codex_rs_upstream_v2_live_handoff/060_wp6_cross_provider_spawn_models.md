# 060 — WP6: allow cross-provider subagent spawns (DECIDED: option B)

One full PABCD cycle. Independent of WP1-WP5; it touches the model catalog, not the
config TOML helpers or the live relay.

## The decision

Upstream `92938d880` restricts V2 `spawn_agent` models to the active backend:

```rust
pub(crate) fn model_supports_multi_agent_backend(
    model: &ModelPreset,
    multi_agent_version: MultiAgentVersion,
) -> bool {
    multi_agent_version != MultiAgentVersion::V2
        || model.multi_agent_version == Some(multi_agent_version)
}
```

That equality test assumes one backend serves every model. OpenCodex is a multi-provider
proxy, so importing it verbatim rejects exactly the cross-provider delegation OpenCodex
exists to enable.

**User decision (2026-07-30): option B — widen the compatible set to every model
OpenCodex actually routes, while keeping upstream's unknown-model guardrail and error
shape.** The gate stays; the guest list widens. A typo still gets a clear tool-level
message instead of an opaque provider error.

## Where the restriction actually lives in OpenCodex

OpenCodex does not re-implement upstream's validator. It *generates the catalog* the
native binary then validates against, and it already replicates the single-backend
filter in two places inside `effectiveSubagentRoster`
([src/codex/catalog/sync.ts:75](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/sync.ts:75)):

- line 89, which drops non-`v2` entries from the advertised candidate list
- line 113, which reports a configured model as `surface_incompatible`

So this phase is a catalog-filter change, not a validator change. That is a smaller and
safer surface than the phase looked like when it was first recorded as an open question
in `002` §A8.

## Change map

| Path | Action |
|---|---|
| `src/codex/catalog/sync.ts` | MODIFY — replace the `=== "v2"` equality with a routed-model predicate |
| `src/codex/catalog.ts` | MODIFY — re-export the new predicate if tests need it directly |
| `tests/multi-agent-compat.test.ts` | MODIFY — the existing roster tests; verified as the only file referencing `effectiveSubagentRoster` |

`MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5` ([sync.ts:43](/Users/jun/Developer/new/700_projects/opencodex/src/codex/catalog/sync.ts:43))
stays as is. Widening eligibility must not widen how many models are advertised, or the
tool schema grows and every spawn prompt pays for it.

## Diff 1 — the eligibility predicate

NEW in `src/codex/catalog/sync.ts`, above `effectiveSubagentRoster`:

```ts
/**
 * Whether a catalog entry may be offered as a V2 subagent model.
 *
 * Upstream (codex-rs 92938d880) requires `multi_agent_version === "v2"` exactly, because
 * upstream assumes a single backend serves every model. opencodex routes many providers,
 * so that equality would reject the cross-provider spawns this proxy exists to enable.
 *
 * Decision (option B): any model opencodex actually routes is eligible. Entries pinned to
 * a DIFFERENT multi-agent backend (`v1`) stay excluded, because that pin is a real
 * capability statement rather than an absence of information. An unpinned entry
 * (`multi_agent_version` null or absent) is a routed third-party model and is allowed.
 */
export function isEligibleV2SubagentEntry(entry: RawEntry): boolean {
  const pinned = entry.multi_agent_version;
  return pinned === "v2" || pinned === null || pinned === undefined;
}
```

The three-way distinction is the whole substance of this phase, so it must not be
flattened into a truthiness check:

| `multi_agent_version` | Meaning | Eligible? |
|---|---|---|
| `"v2"` | native model, V2-capable | yes |
| `null` / absent | routed third-party model, no upstream claim | **yes (this is the change)** |
| `"v1"` | pinned to the other multi-agent backend | no |

Evidence that all three occur in the shipped data: `src/codex/data/upstream-models.json`
contains `"multi_agent_version": "v2"` (lines 21, 135), `"v1"` (line 247), and `null`
(lines 355, 461, 562, 658, 754).

## Diff 2 — candidate filter

MODIFY `src/codex/catalog/sync.ts:89`.

BEFORE:

```ts
    .filter(({ entry }) => surface !== "v2" || entry.multi_agent_version === "v2")
```

AFTER:

```ts
    .filter(({ entry }) => surface !== "v2" || isEligibleV2SubagentEntry(entry))
```

## Diff 3 — exclusion reporting

MODIFY `src/codex/catalog/sync.ts:113`.

BEFORE:

```ts
    if (surface === "v2" && entry.multi_agent_version !== "v2") {
      return [{ configured: model, catalogModel, reason: "surface_incompatible" }];
    }
```

AFTER:

```ts
    if (surface === "v2" && !isEligibleV2SubagentEntry(entry)) {
      return [{ configured: model, catalogModel, reason: "surface_incompatible" }];
    }
```

The `surface_incompatible` reason string is unchanged, so every consumer of
`SubagentRosterExclusion` keeps working. After this change it means "pinned to a
different multi-agent backend" rather than "not pinned to v2", which is a narrower and
more accurate use of the same label.

Consumers to leave alone, verified present:
`src/codex/catalog.ts:12` re-exports the types, and
`src/server/responses/{collaboration,core,compact,fetch-helpers,encrypted-payload}.ts`
consume `EffectiveSubagentRoster` / `SpawnAgentSurface` without inspecting
`multi_agent_version` themselves.

## What deliberately does NOT change

- `surface === "v1"` behavior. Upstream imposes no equality filter for V1, and neither
  does OpenCodex today.
- `visibility === "list"` gating. A picker-hidden model stays hidden; eligibility is not
  visibility.
- The advertised cap of 5.
- The `picker_hidden`, `missing_catalog_entry`, and `outside_display_limit` exclusion
  reasons.
- Any native-binary validation. OpenCodex supplies the catalog; the binary still applies
  its own check against what it was given.

## Risk: does the native binary re-reject what we now advertise?

This is the one real unknown in the phase and B must settle it empirically before C
claims success. Upstream's validator compares against *its* `available_models` list. If
that list is the catalog OpenCodex writes, widening the catalog is sufficient. If the
binary carries an independent pin, an unpinned model could be advertised and then
refused at spawn time — a worse user experience than today's clean exclusion.

Resolve it by running a real cross-provider spawn against a routed model and reading the
result, not by reasoning from the Rust source. If the binary does re-reject, the phase's
honest outcome is `BLOCKED` with that evidence recorded, and the fallback is to keep the
narrow filter and surface a clearer explanation instead of silently advertising models
that cannot spawn.

## Accept criteria

1. A routed third-party model with `multi_agent_version` null or absent is advertised as
   a V2 subagent candidate.
2. A model pinned `"v1"` is still excluded, with reason `surface_incompatible`.
3. A model pinned `"v2"` is still advertised, unchanged from today.
4. `surface === "v1"` rosters are byte-identical before and after.
5. Picker-hidden models stay excluded with reason `picker_hidden`, taking precedence over
   the eligibility check exactly as it does today.
6. At most `MAX_SPAWN_AGENT_MODEL_OVERRIDES` models are advertised, unchanged.
7. A cross-provider spawn of a newly eligible model **actually succeeds end to end**, or
   the phase closes `BLOCKED` with the refusal captured.

### Activation scenarios (C-ACTIVATION-GROUNDING-01)

| Path | Trigger | Observable |
|---|---|---|
| unpinned-eligible branch | catalog fixture with `multi_agent_version: null` | model appears in `advertised`; this is the branch the whole phase exists for |
| absent-key branch | fixture with the key omitted entirely, not null | same result as null; proves `undefined` is handled, not just `null` |
| v1-pinned exclusion | fixture pinned `"v1"` | excluded with `surface_incompatible` |
| precedence | fixture that is BOTH picker-hidden and unpinned | reason is `picker_hidden`, proving order is unchanged |
| live spawn | real cross-provider spawn request | child agent starts and returns; log or response captured |

The absent-key case is the one most likely to ship broken: a predicate written as
`pinned === "v2" || pinned === null` passes the null fixture and fails on a real entry
that simply omits the field. Drive both.

## Verification gate

`bun run typecheck`, `tests/multi-agent-compat.test.ts` green with all seven criteria
asserted, and the live cross-provider spawn evidence from criterion 7 pasted into the phase's
`checkOutput`. A green suite alone does not close this phase, because the suite cannot
observe the native binary's own validation.
