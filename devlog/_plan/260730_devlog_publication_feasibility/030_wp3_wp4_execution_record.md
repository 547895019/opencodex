# 030 — WP3/WP4 execution record

What actually happened when the conversion ran, including the two places the plan was
wrong. Written during execution, not reconstructed after.

## Excision (WP3 step 1)

Both units moved to a scratch directory outside the repository, then removed from the
devlog index:

```
_plan/260730_open_pr_backlog_triage  -> /tmp/ocx-devlog-security-yXZLMN/
_plan/260730_new_issue_pr_triage     -> /tmp/ocx-devlog-security-yXZLMN/
git rm -r --cached <both>
git ls-files | rg "260730_(open_pr_backlog|new_issue_pr)_triage"  ->  no output
```

## An excision note is itself part of the publication set

The plan's collateral step said to rewrite one dangling citation. That was not enough.

`003` had reproduced the per-document breakdown — which file described which weakness —
and `010` had quoted the offending table row verbatim as its own BEFORE example. Both
would have published the substance of the excision at lower fidelity while claiming to
remove it.

Fixed: `003` now records the category and the reason without restating individual
findings, and `010`'s BEFORE/AFTER example describes the shape instead of quoting it. The
general rule, now stated in `003`: **an excision note must pass the same test as the
material it removes.** An instruction that says "delete this sensitive sentence" must not
carry the sentence as its example.

## Conversion (WP3 steps 3-4)

- `.gitmodules` deleted (devlog was its only stanza).
- `.gitignore` devlog stanza replaced with seven path rules ported from devlog's own
  ignore file, which stopped applying the moment devlog joined this repository.
- `git rm --cached devlog` then `git add devlog`. Index shows the gitlink as a deletion
  and the files as additions:

```
:160000 000000 a9cd169cd 000000000 D  devlog
:000000 100644 000000000 fb960c54a A  devlog/.gitignore
1617 files changed, 186525 insertions(+), 1 deletion(-)
```

- `devlog/.git` was MOVED to scratch, not deleted, so the private-remote binding is
  recoverable.
- Preflight before staging confirmed zero candidates matching `_chase/_litellm`,
  `_chase/_cca`, `_fin/opencode-cursor`, either excised unit, or `_ref_`, while 1401
  `_fin` and 83 `_plan` markdown files were included.
- Final index: **0 gitlinks**, 1616 tracked devlog files.

## Privacy-scan coverage: the plan understated the work

Removing `devlog/` from `EXCLUDED_PREFIXES` produced **1254 findings** — 1168 home-path,
77 email, 9 token-looking. The plan had said "if it fails, treat the failure as signal",
which was right in spirit and wrong about volume: the failures were not content that
should be private, they were the scanner meeting a corpus it had never seen.

Resolved by narrowing the allowances, not by re-excluding the directory:

| Finding | Allowance | Why it is narrow |
|---|---|---|
| 1168 home-path | the maintainer's own account name, under `devlog/` only | any OTHER username still fails, anywhere; a contributor's or reporter's home path is somebody else's data |
| 9 token-looking | shape-based: a token must SAY it is fake (`sk-test-`, `sk-rawsentinel`, `sk-...placeholder`) | a real key is high-entropy and matches none of those words |
| 77 email | GitHub noreply, three explicit placeholders, and git-attribution CONTEXT | the last is the important one |

The email allowance is context-shaped rather than a list of addresses. A `Co-authored-by:`
trailer, an `author Name <addr>` citation, a `handle <addr>` form, or a markdown table row
carrying a 7+ hex SHA is git provenance — already public as commit authorship in this
repository, and the attribution these notes exist to preserve. A bare address pasted as
contact detail still fails, and a new contributor needs no scanner change.

Four addresses were also removed from `003` outright: an analysis document had no reason
to list them, and generalizing the prose was cheaper than allowlisting.

### Proof the scanner is not dead

A probe file carrying a live-shaped key, a foreign home path, and a third-party email was
staged. All three were caught:

```
zz_scan_probe.md:3 token-looking: sk-liveKeyShaped9x8w7v6u5t4s3r2q1p0
zz_scan_probe.md:4 home-path: /Users/someoneelse/
zz_scan_probe.md:5 email: stranger@third-party.example.org
```

Probe removed; scan green. Note that the first attempt planted the probe as an UNTRACKED
file and nothing fired — the scanner reads `git ls-files`, so an unstaged probe proves
nothing. Stage the probe.

## Hygiene test rewrite (WP3 step 5)

The old `devlog submodule stays loose` block asserted the shape that just went away. It is
now `devlog is tracked, with no submodule left behind`, with five assertions: no gitlink
anywhere, devlog markdown tracked as ordinary blobs, no `.gitmodules`, vendored clones
untracked, excised triage untracked. The workflow-submodule test was kept verbatim.

Both new guards were driven RED before being trusted:

```
restore one excised file      -> (fail) security triage excised before publication stays untracked
plant devlog/_chase/_litellm  -> (fail) vendored reference clones stay untracked
```

## The tripwire caught its own documentation, then missed the real thing

Two failures worth recording, because each would have shipped a check that reads as
coverage without providing it.

**First:** the tripwire flagged `003`, `004`, and `020` — the documents that DEFINE it.
They quote the verdict markers and boundary terms in order to describe the rule. Fixed
with a path-pinned exemption for this one unit; a new unit gets no exemption.

**Second, and worse:** with the exemption in place the tripwire passed while a genuinely
offending document was staged. The English-only vocabulary list missed it, because this
devlog is written in mixed Korean and English — the verdicts are English markers
(`NEEDS-CHANGES`) but the prose is Korean (`크리덴셜 경계 보안 리뷰`). A tripwire that
misses the exact case it was built for is worse than no tripwire.

Fixed by extending the pattern to both languages (`크리덴셜`, `계정 경계`, `인증 우회`,
`미인증`, plus `account pool`). Re-driven red with the same probe:

```
(fail) no open devlog plan carries an unresolved security verdict
```

Then probe removed, 10/10 pass.

**Lesson for any future content check in this repository: the corpus is bilingual.** An
English-only pattern over devlog prose is a false sense of coverage.

## Documentation (WP4)

- `AGENTS.md`: the `## The devlog submodule` section became `## The devlog directory`.
  Every sentence in the old one was false after the conversion. The Security working notes
  section now states the rule binds maintainers, cites the violation that motivated the
  excision, and gives the deciding test — is there already a public diff?
- `devlog/README.md`: no longer describes itself as a private repository. States why the
  notes are public and what the trade requires.

## Gates

```
bun run typecheck              -> clean
bun run privacy:scan           -> Privacy scan passed (devlog now IN scope)
bun test tests/repo-hygiene.ts -> 10 pass, 0 fail
```

## Outcome

`DONE` for WP3 and WP4. Nothing pushed.
