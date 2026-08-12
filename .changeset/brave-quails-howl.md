---
type: Added
pr: 0
---
Add gsd-phase-dispatch-guard.js, a Claude Code PreToolUse hook that hard-blocks an executor Agent/Task dispatch when phase-preflight (worktree.phase-preflight) finds a sibling worktree or open PR already matching the target phase, and wire the same check into execute-phase.md and manager.md so a conflict surfaces before dispatch is even attempted. Fails open on any check error or unresolvable evidence. Each match's block message now includes a relative-age clause ("last commit 3 hours ago" / "updated 6 weeks ago") and, when any match was touched within the last 6 hours, an explicit prompt to check other active sessions before routing around it — the hook itself can't see other running sessions, but the model reading the block message can.
<!-- docs-exempt: internal safety-hook enforcement, not a user-invoked command/workflow surface — its direct precedent, gsd-agent-isolation-guard.js, has no docs/ entry either (grepped USER-GUIDE.md and ARCHITECTURE.md, zero hits for "isolation guard"). Behavior is observable at the point it fires (a BLOCK message), same as that precedent. -->

