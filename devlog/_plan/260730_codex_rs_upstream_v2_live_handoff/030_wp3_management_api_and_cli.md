# 030 — WP3: expose the WP2 keys through the management API and CLI

One full PABCD cycle. Depends on WP2 (`020`): the readers and writers must exist first.

## Scope

`GET`/`PUT /api/v2` currently carries `enabled`, `maxConcurrentThreadsPerSession`, and
`multiAgentMode`, plus `agentsMaxThreadsConflict` on read. This phase adds the three
WP2 keys to that route and reports them in `ocx v2 status`.

## Change map

| Path | Action |
|---|---|
| `src/server/management/agent-settings-routes.ts` | MODIFY — extend `GET`/`PUT /api/v2` |
| `src/cli/v2.ts` | MODIFY — report the new values in status |
| `src/cli/help.ts` | MODIFY — document new subcommands if added |
| the route test file | MODIFY — request/response coverage |

Test files verified to exist: `tests/codex-v2-gate.test.ts` already covers the
`/api/v2` surface and is the primary target; `tests/cli-headless-parity.test.ts` also
references it and may need updating if the CLI status output changes.

## Diff 1 — `GET /api/v2` response

MODIFY `src/server/management/agent-settings-routes.ts:106`.

The current response shape is:

```
{ enabled, agentsMaxThreadsConflict, maxConcurrentThreadsPerSession, multiAgentMode }
```

AFTER, additively:

```
{
  enabled,
  agentsMaxThreadsConflict,
  maxConcurrentThreadsPerSession,
  multiAgentMode,
  agentsEnabled,                  // boolean | null  (null = unset, upstream default true)
  agentsMaxDepth,                 // number  | null  (V1 only; ignored by V2 upstream)
  subagentDeveloperInstructions,  // string  | null  (null = inherit, "" = clear)
  agentsMaxDepthAppliesToActiveBackend  // boolean: false whenever V2 is active
}
```

The last field exists so the GUI cannot accidentally present `max_depth` as an
effective V2 limit. Upstream ignores it under V2; a client that shows it as active
would be lying to the user. Deriving it server-side keeps that rule in one place.

Read the three new values with the WP2 readers. Do not re-implement TOML parsing here.

## Diff 2 — `PUT /api/v2` request

MODIFY `src/server/management/agent-settings-routes.ts:116`.

BEFORE:

```ts
let body: { enabled?: unknown; maxConcurrentThreadsPerSession?: unknown; multiAgentMode?: unknown };
try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
const wantsFlag = body.enabled !== undefined;
const wantsThreads = body.maxConcurrentThreadsPerSession !== undefined;
const wantsMode = body.multiAgentMode !== undefined;
```

AFTER:

```ts
let body: {
  enabled?: unknown;
  maxConcurrentThreadsPerSession?: unknown;
  multiAgentMode?: unknown;
  agentsEnabled?: unknown;
  agentsMaxDepth?: unknown;
  subagentDeveloperInstructions?: unknown;
};
try { body = await req.json(); } catch { return jsonResponse({ error: "invalid JSON body" }, 400); }
const wantsFlag = body.enabled !== undefined;
const wantsThreads = body.maxConcurrentThreadsPerSession !== undefined;
const wantsMode = body.multiAgentMode !== undefined;
const wantsAgentsEnabled = body.agentsEnabled !== undefined;
const wantsMaxDepth = body.agentsMaxDepth !== undefined;
const wantsSubagentInstructions = body.subagentDeveloperInstructions !== undefined;
```

Validation rules, each returning `400` with a specific message:

| Field | Accepted | Rejected |
|---|---|---|
| `agentsEnabled` | `boolean`, or `null` to unset | anything else |
| `agentsMaxDepth` | integer, or `null` to unset | non-integer, non-null |
| `subagentDeveloperInstructions` | `string` including `""`, or `null` to unset | non-string, non-null |

The `""` versus `null` distinction must survive the route boundary. JSON gives us both,
so the only risk is a falsy check collapsing them; use explicit `=== null` and
`typeof === "string"` tests.

Extend the existing "at least one field required" guard to count the three new flags,
otherwise a body containing only `agentsEnabled` is rejected as empty.

## Diff 3 — the `agents.enabled` + V2 interaction warning

The existing route already rejects a mode/flag conflict. Add a non-fatal warning, not a
rejection, for this combination:

- `agentsEnabled: false` while `features.multi_agent_v2` is enabled

Upstream resolves this in V2's favor: an enabled feature flag overrides
`[agents].enabled = false` entirely. So the write should succeed and the response
should carry a warning explaining that V2 remains active despite the off switch.
Rejecting would be wrong; silently accepting would leave the user thinking they turned
multi-agent off.

Warning text, appended to the existing `warnings: string[]`:

```
agents.enabled = false has no effect while features.multi_agent_v2 is enabled; upstream keeps V2 active.
```

## Diff 4 — CLI status

MODIFY `src/cli/v2.ts:76` (`cmdV2`). Status currently reports the flag, multi-agent
mode, and thread limit (lines 87-96). Add the three values, with `max_depth` explicitly
labeled as V1-only when V2 is active, so the CLI carries the same honesty the API does.

If `ocx v2` gains write subcommands for these keys, update the `v2` entry in
`src/cli/help.ts:225`. If the GUI is the only writer, leave the CLI read-only and say
so in the phase's D summary.

## Accept criteria

1. `GET /api/v2` returns all four new fields with correct tri-state values.
2. `PUT /api/v2` writes each new field independently and rejects wrong types with a
   field-specific 400.
3. `subagentDeveloperInstructions: ""` writes an empty string; `null` removes the key.
4. `agentsEnabled: false` with V2 enabled returns 200 plus the warning above.
5. `agentsMaxDepthAppliesToActiveBackend` is `false` whenever V2 is active.
6. A body containing only a new field is accepted, not rejected as empty.
7. `ocx v2 status` shows the new values and marks `max_depth` V1-only under V2.

### Activation scenarios

| Path | Trigger | Observable |
|---|---|---|
| warning branch | `agentsEnabled: false` + V2 on | response `warnings` contains the exact string; status still 200 |
| tri-state read | config with key absent | field is `null`, not `false` or `0` |
| empty-string write | `""` payload | config gains the key with an empty value; re-read returns `""` |
| unset write | `null` payload | key removed; re-read returns `null` |
| depth-inapplicable flag | V2 enabled | flag `false`; with V2 disabled, `true` |
| empty-body guard | `{}` | 400, unchanged from today |

The warning branch is the one worth watching: it is easy to implement as a rejection by
reflex, which would contradict upstream precedence.

## Verification gate

`bun run typecheck`, the route test file, and the CLI test file all green, with the
seven criteria asserted and each activation scenario driven.
