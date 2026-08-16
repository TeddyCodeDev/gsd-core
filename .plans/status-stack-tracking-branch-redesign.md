# Plan: Redesign `status_stack` as a tracking side branch, not an ancestor requirement

## Context

`feat/phase-preflight-guard` currently implements `checkStatusStack` in
`src/worktree-safety.cts` (commits `28556428`, `8acbc3a8`, `a176d78f`,
`eee8e5a9`, `55696323`). The feature is unreleased (not present in the
installed `gsd-tools` 1.10.0) and is being dogfooded against a real project
(Anti-Budget), which is where this design gap surfaced.

## The problem

`checkStatusStack`'s policy requires, for every configured phase branch
(matched by `phase_branch_prefix`):

1. **Ancestry**: `status_branch` must be an ancestor of the phase branch
   (`git merge-base --is-ancestor <status_branch> <phase_branch>`).
2. **Content identity**: `dashboard_paths` (typically `STATE.md`,
   `ROADMAP.md`) must be byte-identical between `status_branch` and the
   phase branch (`git diff --quiet <status_branch> <phase_branch> -- <paths>`).

Both requirements model `gsd-status` as something every phase branch must
*absorb* — the phase branch's own history must contain a merge from
`gsd-status`, and its dashboard files must match `gsd-status`'s exactly.

This is backwards for what `gsd-status` actually is: **the orchestrator's
branch for kicking off worktree work and tracking milestone-wide state** —
a side branch that *observes* phase branches, not one they need to merge
in.

Concrete failure mode, reproduced live in Anti-Budget:

- `v1.1/phase-09.1-wizard-shell` has real, independent implementation
  commits (plans 09.1-01 through mid-09.1-04) with its own accurate
  `STATE.md` (`3/7 plans, plan 04 in progress`).
- `gsd-status`'s `STATE.md` describes the *milestone* and, because nobody
  had synced Phase 9.1's real progress into it yet, still showed `1/7`
  for that phase — accurate to when it was last written, not stale in a
  way `checkStatusStack` could detect (its check only looks at ancestry
  and byte-identity, never "does this phase branch have progress
  `gsd-status` hasn't seen yet").
- Attempting to satisfy the *current* policy (`git merge gsd-status` into
  the phase branch) produces real conflicts in exactly these two files,
  because both branches independently — and legitimately — describe
  different things under the same paths. Resolving that conflict either
  destroys the phase branch's own accurate local progress or discards
  `gsd-status`'s milestone-wide view. There is no correct resolution
  under the current model, because the model conflates two different
  documents (per-phase state vs. milestone state) that happen to share a
  file path.

## Proposed redesign

### 1. Replace the ancestry check with a freshness check

Track, per phase branch, the commit sha `gsd-status` last aggregated from
it — not require `gsd-status` to be in the phase branch's history.

```jsonc
// .planning/config.json
{
  "git": {
    "status_stack": {
      "base_branch": "develop",
      "status_branch": "gsd-status",
      "phase_branch_prefix": "v1.1/phase-",
      "dashboard_paths": [".planning/STATE.md", ".planning/ROADMAP.md"]
    }
  }
}
```

```jsonc
// .planning/status-stack-sync.json (new — lives ONLY on status_branch)
{
  "synced": {
    "v1.1/phase-09-input-wizard": "bc9f39a...",
    "v1.1/phase-09.1-wizard-shell": "5f94a3d..."
  }
}
```

`checkStatusStack` becomes: for each discovered phase branch, compare its
current tip against `synced[branch]` on `status_branch`. `fresh` if equal,
`stale` if the phase branch has moved since. No `merge-base --is-ancestor`
call, no requirement that either branch appear in the other's history.

### 2. Replace the content-identity check with one-way aggregation

Add a sync command (`gsd-tools worktree sync-status`, or a `manager`
subcommand) that:

1. For each phase branch, reads its `STATE.md` via
   `git show <phase_branch>:.planning/STATE.md` — **no checkout, no
   merge**.
2. Extracts that phase's own progress fields (plan counts, `last_activity`,
   `status`) from the per-phase file.
3. Rewrites the corresponding row in `gsd-status`'s own aggregated
   `STATE.md` (the "By Phase" progress table) to match.
4. Updates `status-stack-sync.json`'s `synced[branch]` to the phase
   branch's current tip.
5. Commits the result on `status_branch` only.

This is explicitly **one-way**: information flows phase branch →
`gsd-status`, never the reverse. A phase branch's own `STATE.md` is never
touched by this command, and `gsd-status` never needs to be merged
anywhere for the sync to be valid.

### 3. Dispatch guards check freshness, not ancestry

`phase-preflight` / the dispatch guard's use of `checkStatusStack` changes
its blocking condition from `verdict !== 'aligned'` to `verdict !==
'fresh'` (per-phase, from the new freshness model). A `stale` phase
(has moved since `gsd-status` last synced it) is exactly the useful
signal the guard wants — "this phase branch has activity the orchestrator
hasn't accounted for yet" — without ever requiring that activity be
merged anywhere.

## What this fixes

- No more spurious merge conflicts between a phase branch's legitimately
  different local `STATE.md` and `gsd-status`'s milestone-wide one.
- `gsd-status` stays a true side branch — safe to rewind, rebase, or
  regenerate from scratch (re-run the sync command against every phase
  branch) without ever touching phase branch history.
- The staleness signal becomes genuinely useful: it tells the orchestrator
  "phase branch X has moved since I last looked," which is what the
  dispatch guard actually needs, instead of an ancestry/byte-identity
  check that can't distinguish "phase branch has new real progress" from
  "gsd-status needs merging in."

## Migration for the current branch

`checkStatusStack`, `cmdWorktreeStatusStack`, and their tests (`28556428`,
`8acbc3a8`) need to change from the ancestry/identity model to the
freshness model above. `a176d78f` (executor: allow configured manual
stack branches) and the `eee8e5a9`/`55696323` manager commits should be
re-examined against the new model — they may still be correct if they're
about *reading* the stack, but any code path that *merges* `gsd-status`
into a phase branch (or expects that merge to have happened) needs to be
replaced with a call to the new sync command instead.

## Open questions for review

1. Should `status-stack-sync.json` live in `.planning/` (tracked,
   phase-visible) or somewhere more clearly orchestrator-internal (e.g.
   `.gsd/`, matching the existing `dispatch-isolation-sentinel.json`
   convention already seen in Anti-Budget's worktrees)?
2. Does the sync command need to handle a phase branch that's been force-
   pushed / rebased (its "current tip" changing without linear history from
   what was last synced)? The freshness check as specced only compares
   sha equality, which handles this correctly (any change → stale) — but
   worth confirming no caller assumes monotonic history.
3. Multi-workstream case: if two phase branches both touch the same
   milestone-wide row (unlikely given `phase_branch_prefix` scoping, but
   worth a test), does aggregation need conflict handling, or is "last
   sync wins" sufficient given sync is orchestrator-driven and
   sequential, not concurrent?
