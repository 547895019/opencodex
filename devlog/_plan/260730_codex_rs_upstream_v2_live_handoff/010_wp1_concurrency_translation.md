# 010 — WP1: fix the v1↔v2 concurrency translation

One full PABCD cycle. Depends on nothing. Must land before WP2 because WP2 extends the
same TOML edit helpers.

## The defect

Upstream `codex-rs/core/src/config/mod.rs:2674` (`resolve_multi_agent_v2_config`) reads
the V2-native key first and falls back to the `[agents]` key **plus one**:

```rust
let max_concurrent_threads_per_session = base
    .and_then(|config| config.max_concurrent_threads_per_session)
    .or_else(|| {
        config_toml
            .agents
            .as_ref()
            .and_then(|agents| agents.max_concurrent_threads_per_session)
            .map(|max_threads| max_threads.saturating_add(1))
    })
    .unwrap_or(DEFAULT_MULTI_AGENT_V2_MAX_CONCURRENT_THREADS_PER_SESSION);
```

The `+1` accounts for the root agent's own slot: the `[agents]` number counts spawned
children, the V2 number counts total threads including the root.

OpenCodex treats them as the same number in both directions.

## Change map

| Path | Action |
|---|---|
| `src/codex/features.ts` | MODIFY — add the translation helpers, apply them in `getLogicalMaxThreads` and `transitionMultiAgentV2` |
| `tests/codex-v2-gate.test.ts` | MODIFY — add round-trip and boundary tests (path verified; see the audit fold-back below) |

The test path above was verified to exist. `tests/v2-agent-message-failfast.test.ts`
also exists but is unrelated to config migration.

## Diff 1 — translation helpers

MODIFY `src/codex/features.ts`. Insert immediately after `getMaxConcurrentThreads`
(currently ends at line 158, before the `setMaxConcurrentThreads` doc comment).

NEW:

```ts
/**
 * Upstream counts the root agent inside the V2 thread limit but not inside the
 * legacy `[agents]` limit (codex-rs core/src/config/mod.rs resolve_multi_agent_v2_config
 * applies saturating_add(1) to the [agents] value). These two helpers keep our
 * migrations on the same side of that boundary.
 */
export function v1ChildLimitToV2TotalLimit(childLimit: number): number {
  return childLimit + 1;
}

/**
 * Inverse of `v1ChildLimitToV2TotalLimit`. A V2 total limit of 1 means "root only,
 * no children", which has no representable legacy child count >= 1, so it clamps to 1
 * rather than producing 0 and tripping the `>= 1` validation on the legacy key.
 */
export function v2TotalLimitToV1ChildLimit(totalLimit: number): number {
  return Math.max(1, totalLimit - 1);
}
```

## Diff 2 — `getLogicalMaxThreads`

MODIFY `src/codex/features.ts:317`.

BEFORE:

```ts
export function getLogicalMaxThreads(configPath?: string): number | null {
  return isMultiAgentV2Enabled(configPath)
    ? getMaxConcurrentThreads(configPath) ?? getAgentsMaxThreads(configPath)
    : getAgentsMaxThreads(configPath) ?? getMaxConcurrentThreads(configPath);
}
```

AFTER:

```ts
export function getLogicalMaxThreads(configPath?: string): number | null {
  if (isMultiAgentV2Enabled(configPath)) {
    const v2 = getMaxConcurrentThreads(configPath);
    if (v2 !== null) return v2;
    const legacy = getAgentsMaxThreads(configPath);
    return legacy === null ? null : v1ChildLimitToV2TotalLimit(legacy);
  }
  const legacy = getAgentsMaxThreads(configPath);
  if (legacy !== null) return legacy;
  const v2 = getMaxConcurrentThreads(configPath);
  return v2 === null ? null : v2TotalLimitToV1ChildLimit(v2);
}
```

Rationale: the function's contract becomes "the effective limit in the units of the
currently active backend", which is what every caller wants. Under V2 it reports the
total-thread limit upstream will actually enforce; under V1 it reports the child limit.

## Diff 3 — the migration itself

MODIFY `src/codex/features.ts` inside `transitionMultiAgentV2` (starts at line 392).
Read the current body at P; the shape is:

```ts
if (enabled) {
  if (!beforeEnabled) {
    const staged = applyConfigEditsAtomically(path, tempPath => {
      const v2 = ensureDisabledV2Config(threadLimit, tempPath, migratedComment);
      if (!v2.ok) return v2;
      return editAgentsMaxThreads(null, tempPath);
    });
```

The change: when the transition derives its V2 value from an existing legacy
`[agents].max_threads` rather than from an explicit caller-supplied `threadLimit`, feed
`v1ChildLimitToV2TotalLimit(legacy)` into `ensureDisabledV2Config`. Symmetrically, the
disable path writes `v2TotalLimitToV1ChildLimit(v2Total)` into `[agents].max_threads`.

An explicit `options.threadLimit` from the caller is already in the target backend's
units and must NOT be translated. This distinction is the whole point of the phase:
translate on *migration of an existing value*, never on a caller-specified value.

Write the exact before/after for this hunk at P after re-reading lines 392-450; the
surrounding rollback machinery must stay byte-identical.

## Accept criteria

1. `[agents].max_threads = 3` + `ocx v2 on` → `features.multi_agent_v2.max_concurrent_threads_per_session = 4`.
2. `features.multi_agent_v2.max_concurrent_threads_per_session = 4` + `ocx v2 off` → `[agents].max_threads = 3`.
3. Round trip 1→2 is identity for every value 1..10.
4. `ocx v2 threads 5` under V2 writes exactly `5`, untranslated.
5. V2 total limit of `1` disabling to V1 writes `1`, not `0`.
6. `getLogicalMaxThreads` returns `null` when neither key is present.

### Activation scenarios (C-ACTIVATION-GROUNDING-01)

Each conditional path needs a test that drives it and an observable proving it ran:

| Path | Trigger | Observable |
|---|---|---|
| V2 active, V2 key present | config with only the V2 key | returned value equals the raw V2 key, no translation |
| V2 active, only legacy key | config with only `[agents].max_threads` | returned value is legacy + 1 |
| V1 active, only V2 key | V2 key present, feature disabled | returned value is V2 − 1 |
| clamp branch | V2 total limit `1`, disable | written legacy value is `1`, and the clamp is exercised rather than inferred |

The clamp branch is the one most likely to be silently dead: assert the written value
directly rather than relying on the suite being green.

## Verification gate

`bun run typecheck` and the features test file, both green, with the six criteria above
as explicit assertions.

## Appendix — translation executed, and the one asymmetry

The two helpers were run under Bun during this planning cycle:

```
round-trip v1 -> v2 -> v1, values 1..10
  child=1  -> v2=2  -> child=1   OK
  child=2  -> v2=3  -> child=2   OK
  ...
  child=10 -> v2=11 -> child=10  OK

v2 total -> v1 child
  total=1 -> child=1
  total=2 -> child=1
  total=3 -> child=2
  total=5 -> child=4
```

**The v1→v2→v1 direction is identity for every value. The v2→v1→v2 direction is not,
and cannot be.** A V2 total limit of 1 means "root only, no children". There is no
legal legacy child count for that state, because upstream constrains the legacy key to
`>= 1`. So `total=1` and `total=2` both map to `child=1`, and re-enabling V2 from
`child=1` yields `total=2`.

Implementation consequences:

1. Do not write a round-trip test asserting identity in the v2→v1→v2 direction. It will
   fail at `total=1` for a correct implementation. Assert identity only for
   v1→v2→v1, and assert the specific clamp behavior separately.
2. Accept criterion 3 in this doc is deliberately scoped to "round trip 1→2 is identity
   for every value 1..10" for exactly this reason. Do not generalize it.
3. If the user's config genuinely holds a V2 total limit of 1, disabling V2 silently
   grants one extra child slot. That is the least-bad option: the alternative is
   writing an invalid `0` that breaks upstream config parsing. Note it in the D summary
   rather than treating it as a bug to fix.

This asymmetry is why the clamp is called out as the branch most likely to ship dead:
it only fires for `total <= 2`, which no realistic default config produces.

---

# Audit fold-back (A-phase, blockers 3, 5, 6)

An independent adversarial review raised three blockers against this doc. All three are
accepted and resolved below. This section supersedes the corresponding parts of Diff 3
and the change map above.

## Blocker 6 (accepted) — the test file does not exist

`tests/codex-features.test.ts` is not a real path. The relevant existing test file is
[`tests/codex-v2-gate.test.ts`](/Users/jun/Developer/new/700_projects/opencodex/tests/codex-v2-gate.test.ts).
The change map's second row is corrected to that path. There is also
`tests/v2-agent-message-failfast.test.ts`, which is unrelated to config migration.

## Blocker 3 (accepted) — Diff 3 must not be deferred, and naive translation double-counts

The full current body, read at `src/codex/features.ts:398-440`:

```ts
  const beforeEnabled = isMultiAgentV2Enabled(path);
  const threadLimit = options.threadLimit ?? getLogicalMaxThreads(path);
  const migratedComment = activeThreadComment(original, beforeEnabled);
  try {
    if (enabled) {
      if (!beforeEnabled) {
        const staged = applyConfigEditsAtomically(path, tempPath => {
          const v2 = ensureDisabledV2Config(threadLimit, tempPath, migratedComment);
          if (!v2.ok) return v2;
          return editAgentsMaxThreads(null, tempPath);
        });
        if (!staged.ok) throw new Error(staged.error);
        toggleFeature(true);
      }
      ...
      if (hasAgentsMaxThreads(path) || getMaxConcurrentThreads(path) !== threadLimit) throw new Error("v2 thread-limit migration postcondition failed");
    } else {
      ...
        return editAgentsMaxThreads(threadLimit, tempPath, migratedComment);
      ...
      if (getMaxConcurrentThreads(path) !== null || getAgentsMaxThreads(path) !== threadLimit) throw new Error("v1 thread-limit migration postcondition failed");
    }
    return { ok: true, changed: readConfigText(path) !== original, threadLimit };
```

**The critical interaction Diff 2 creates.** After Diff 2, `getLogicalMaxThreads`
returns a value already expressed in the *currently active* backend's units. But
`transitionMultiAgentV2` is called precisely when the backend is about to change, so
`threadLimit` at line 406 is in the units of the backend being left, while every write
below it targets the backend being entered.

Translating again inside the branches would therefore double-count. Translating in
neither place leaves the original defect. The correct shape is to translate exactly
once, at the point where the source value crosses the boundary.

AFTER, replacing line 406 and leaving the branch bodies and both postconditions
structurally untouched:

```ts
  const beforeEnabled = isMultiAgentV2Enabled(path);
  // `options.threadLimit` is caller-supplied and already expressed in the DESTINATION
  // backend's units, so it is never translated. A value discovered from config is in
  // the SOURCE backend's units and must cross the root-slot boundary exactly once:
  // enabling V2 means child-count -> total-count (+1), disabling means total -> child (-1).
  // getLogicalMaxThreads already reports in the source backend's units after Diff 2,
  // so translating here and nowhere else keeps the count single-applied.
  const discoveredLimit = getLogicalMaxThreads(path);
  const threadLimit = options.threadLimit ?? (
    discoveredLimit === null
      ? null
      : enabled
        ? v1ChildLimitToV2TotalLimit(discoveredLimit)
        : v2TotalLimitToV1ChildLimit(discoveredLimit)
  );
```

Both postconditions (lines 428 and 438) then remain correct **unchanged**, because
`threadLimit` is now in destination units and those assertions compare the written
destination key against it. That is the reason to translate at line 406 rather than
inside the branches: it keeps the two postconditions honest without editing them.

One subtlety the implementer must not miss. When `beforeEnabled` is already `true` and
`enabled` is `true` (a no-op re-enable), `getLogicalMaxThreads` returns the V2 total and
the code above would add 1 to it. Guard the translation on an actual backend change:

```ts
  const backendChanges = enabled !== beforeEnabled;
  const threadLimit = options.threadLimit ?? (
    discoveredLimit === null || !backendChanges
      ? discoveredLimit
      : enabled
        ? v1ChildLimitToV2TotalLimit(discoveredLimit)
        : v2TotalLimitToV1ChildLimit(discoveredLimit)
  );
```

This is the version to implement. The idempotent-call path is a real code path —
`ocx v2 on` on an already-V2 config reaches it — so it needs its own test.

## Blocker 5 (accepted, scope-bounded) — `saturating_add` versus `+ 1`

Upstream's field is `Option<usize>` and it uses `usize::saturating_add(1)`, which
cannot overflow. JavaScript `childLimit + 1` has no such guarantee at the top of the
numeric range.

In practice the reachable range is bounded by the existing readers: both
`getAgentsMaxThreads` and `getMaxConcurrentThreads` parse `\d+` and reject anything
that is not an integer `>= 1`, and `transitionMultiAgentV2` already rejects a
caller-supplied limit that is not an integer `>= 1`. So a value large enough to lose
precision cannot reach the helpers through any current path.

That makes this a latent rather than live defect, and the fix is a cheap explicit
bound rather than a saturating numeric type:

```ts
/** Largest thread limit we will translate. Well below Number.MAX_SAFE_INTEGER and far
 *  above any real concurrency setting; upstream's usize cannot overflow, ours can. */
const MAX_TRANSLATABLE_THREAD_LIMIT = 1_000_000;

export function v1ChildLimitToV2TotalLimit(childLimit: number): number {
  if (!Number.isInteger(childLimit) || childLimit < 1 || childLimit > MAX_TRANSLATABLE_THREAD_LIMIT) {
    throw new RangeError(`thread limit out of translatable range: ${childLimit}`);
  }
  return childLimit + 1;
}
```

`v2TotalLimitToV1ChildLimit` takes the same guard. Add a boundary test at
`MAX_TRANSLATABLE_THREAD_LIMIT` and one past it asserting the throw, rather than
asserting semantic equivalence with Rust.

## Revised accept criteria

Criteria 1-6 above stand, plus:

7. A no-op re-enable (`ocx v2 on` while already V2) leaves the thread limit unchanged,
   proving the `backendChanges` guard fires.
8. A no-op re-disable leaves the legacy limit unchanged.
9. Both postconditions at lines 428 and 438 still pass unmodified after the change.
10. A limit above `MAX_TRANSLATABLE_THREAD_LIMIT` throws `RangeError` rather than
    silently producing an imprecise value.

### Added activation scenarios

| Path | Trigger | Observable |
|---|---|---|
| `backendChanges` guard false | `transitionMultiAgentV2(true, ...)` on an already-V2 config | written V2 limit equals the pre-call value, not value+1 |
| range guard | limit `1_000_001` | `RangeError`, config bytes unchanged |
| `discoveredLimit === null` | config with neither key | `threadLimit` stays null; `removeMaxConcurrentThreads` path taken |

The `backendChanges` guard is now the highest-risk branch in this phase: without it the
change introduces a *new* off-by-one on idempotent calls while fixing the original one.
