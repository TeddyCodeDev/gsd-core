# Plan: Fork a dependent phase's branch from its unmerged dependency, not always `origin/<default>`

## Context

`execute-phase.md`'s `handle_branching` step always forks a new phase branch from
`origin/<default-branch>` (never the current HEAD, never another branch) — deliberately, per
`#2916`, to stop phases from compounding onto whatever was locally checked out and staying
unpushed. There is no `stacked` `branching_strategy`; only `none` / `phase` / `milestone`, and both
of the latter always base on `origin/<default-branch>`.

Separately, phase-to-phase dependencies (`Depends on:` in `ROADMAP.md`) gate *whether* `gsd-manager`
recommends `discuss`/`plan`/`execute` for a phase (`deps_satisfied`, in `init.cts`) — but
`deps_satisfied` only means "the dependency's ROADMAP checkbox is checked in this checkout," not
"the dependency's code is merged into `origin/<default-branch>`." A phase can be marked complete
(planned, executed, verified) while its PR is still open.

This is unrelated to the `status_stack` redesign in this same branch (`.plans/status-stack-tracking-
branch-redesign.md`) — that fixes how `gsd-status` learns about phase-branch *progress* without a
destructive merge. This plan is about where a *new* phase branch's code comes from at creation time.

## The problem

Reproduced live in Anti-Budget (2026-09-04): Phase 9.1's branch
(`v1.1/phase-09.1-wizard-shell-progress-persistence-and-resume`) was fully executed and verified —
ROADMAP.md checkbox checked, `deps_satisfied` for Phase 9.2 reads true — but its PR (#120) had not
yet merged into `develop`. Phase 9.2's branch
(`v1.1/phase-09.2-steps-1-3-plus-early-preview-mvf-core`) was forked from `origin/develop` per the
current `handle_branching` step, so it never received Phase 9.1's wizard-shell source. Phase 9.2's
own execution halted on its first precondition check (missing wizard shell source) — the phase
plan's own runtime check caught this, not any dependency- or branch-basing check, because none
exists for this.

`deps_satisfied` being checkbox-based rather than merge-based is *not* the bug to fix here — tightening
it to require merge status would block `discuss`/`plan` work that doesn't need the dependency's code
present at all (just its spec/contract), which is concurrency this project's workflow already
legitimately relies on. The actual gap is narrower: `handle_branching` has no way to make a dependent
phase's branch actually contain its dependency's code before that dependency merges.

## Proposed design

### 1. Detect an eligible unmerged dependency at branch-creation time

In `handle_branching`, before forking, resolve the phase's `dep_phases` (already computed by
`init.cts` from ROADMAP's `Depends on:`). For each dependency phase number:

- Reuse `phase-preflight.cts`'s existing `findMatchingWorktrees` / `matchesPhaseBranch` to locate a
  branch for that phase.
- New check (not currently exposed by `phase-preflight`): confirm the branch is **pushed to
  `origin`** — `git rev-parse --verify --quiet "refs/remotes/origin/<branch>"` after a `git fetch
  --quiet origin <branch>`. A local-only branch is never a valid stack base (this is the same
  "always fork from a real `origin/*` ref" invariant `#2916` established — just applied to a
  different, resolved ref instead of a hardcoded default).
- Confirm it is **not already merged**: `git merge-base --is-ancestor origin/<dep-branch>
  origin/<default-branch>` — if true, it's already in `develop`, so no stacking is needed; use
  today's path unchanged.

### 2. Fork from the dependency branch when exactly one eligible match exists

If exactly one dependency resolves to a single, pushed, unmerged branch: fork the new phase branch
from `origin/<dep-branch>` instead of `origin/<default-branch>`, using the same fetch-and-pin
pattern the existing step already uses for the default branch (mirrors lines ~298-319 of
`execute-phase.md`'s current `handle_branching`, parameterized by the resolved ref).

Any other case — no match, branch not pushed, already merged, or **more than one** unmerged
dependency — falls back to exactly today's behavior (fork from `origin/<default-branch>`), plus an
explicit warning naming which dependency/dependencies won't be included yet. Never silently guess
which of several unmerged dependencies to stack on.

### 3. Record the stack base for later reconciliation

When a phase branch is created stacked on a dependency branch, record `{dependency_branch,
dependency_sha}` somewhere durable and per-branch (candidate locations: a frontmatter field in the
phase's `*-CONTEXT.md`, or a sibling entry to the `status-stack-sync.json` shape the `status_stack`
redesign proposes, if that lands first — worth aligning shapes rather than inventing a second
tracking file). This is what a later check needs to answer "has this phase's stack-base since
merged into `develop`? If so, the phase branch should merge latest `develop` in now" — i.e., turn
the manual `git merge develop` reconciliation done by hand across 8 Anti-Budget worktrees this
session into a repeatable, surfaced check rather than something only discovered by chance.

That reconciliation *check* (surfacing "stack base merged, refresh now") is out of scope for this
plan's first cut — recording the fact is enough to make it buildable later without re-deriving it
via commit-graph archaeology, which is genuinely expensive (see the diff/reachability analysis this
took in Anti-Budget's own recovery-branch investigation this session).

## What this fixes

- A dependent phase's `execute` step can actually contain its dependency's code before that
  dependency's PR merges, enabling real concurrent execution across a dependency chain — not just
  concurrent `discuss`/`plan`.
- Preserves `#2916`'s guarantee: every fork point is still a freshly-fetched, verified `origin/*`
  ref — never local HEAD, never an unpushed branch.
- Fails closed: any ambiguity (multiple unmerged deps, unpushed branch, no match) falls back to
  today's exact behavior rather than guessing.

## What this does not fix (by design)

- `deps_satisfied` itself stays checkbox-based — this plan does not change when `gsd-manager`
  recommends `discuss`/`plan`/`execute`, only what a phase branch is forked from when `execute`
  actually runs.
- Multi-dependency stacking (more than one unmerged dependency at once) is explicitly not handled —
  falls back with a warning. Worth revisiting only if it comes up in practice.
- The "stack base has since merged, refresh me" reconciliation check is recorded for but not built
  in this pass.

## Open questions for review

1. Where should `{dependency_branch, dependency_sha}` be recorded — phase `*-CONTEXT.md`
   frontmatter, or piggyback on `status-stack-sync.json`'s shape if the `status_stack` redesign
   lands first? They're conceptually adjacent (both are "what does this phase branch's history
   relate to") but serve different consumers (dashboard freshness vs. branch-basing).
2. Should the "branch pushed to origin + unmerged" check live as new exports on
   `phase-preflight.cts` (natural home, same file already has the worktree/PR matching this needs)
   or a new sibling module, given `phase-preflight.cts`'s own docstring frames it as narrowly
   "does phase N exist elsewhere," not "what should I fork from"?
3. `gsd-plan-phase`/`gsd-discuss-phase` don't call `phase-preflight` at all yet (a separate,
   already-reported gap, not part of this plan) — does adding dependency-branch resolution here
   make it more or less pressing to wire preflight into those too, since both would now share the
   same "find the dependency's branch" primitive?

## Resolution (implemented 2026-09-04)

1. **New sibling module** (`src/branch-stacking.cts`), not folded into `phase-preflight.cts` —
   keeps that module's own stated scope ("does phase N exist elsewhere," not "what should I fork
   from") intact. It imports `findMatchingWorktrees`/`normalizePhaseNumber` from the compiled
   `phase-preflight.cjs` rather than duplicating them.
2. **Tracked JSON file**, `.planning/.stack-base.json`, one record per checkout — not
   `*-CONTEXT.md` frontmatter (that's a planning doc, not obviously a home for git-branch
   metadata) and not piggybacked on `status-stack-sync.json` (that file's shape is itself still
   just proposed, not implemented — coupling to it now would mean changing both together later).
   `readDependencyPhaseNumbers` reads `ROADMAP.md`'s `**Depends on:**` field directly via
   `getRoadmapPhaseInternal` (not injected — matches that function's use elsewhere in the
   codebase as a plain `require()`, not a DI seam), so `resolveStackBase` stays self-sufficient
   like `checkPhaseWorktree` — callers only need to pass a phase number and default branch.
3. **Left open** — not addressed by this pass, tracked as a separate follow-up.

Wired into `execute-phase.md`'s `handle_branching` step: `gsd_run query worktree stack-base
"$phase_number" "$DEFAULT_BRANCH"` resolves the fork point before the `git checkout -b` that
creates a new phase branch (existing-branch reuse path is untouched); `gsd_run query worktree
record-stack-base` records the choice immediately after. Added `tests/branch-stacking.test.cjs`
(29 tests, dependency-injected `execGit` + real-tempdir `ROADMAP.md` fixtures, matching
`phase-preflight.test.cjs`'s and `roadmap-parser.test.cjs`'s own conventions respectively).
Verified against Anti-Budget's real Phase 9.2 → 9.1 case: correctly resolves
`origin/v1.1/phase-09.1-wizard-shell-progress-persistence-and-resume` as the stack base.

The reconciliation check ("stack base has since merged, refresh `develop` in now") described in
"What this does not fix" is still not built — `readStackBase` exists so it can be, without
re-deriving the relationship later.
