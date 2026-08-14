#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Phase Dispatch Guard — PreToolUse hook
//
// Problem: `gsd-core/workflows/execute-phase.md`'s `phase_preflight_check` step
// resolves whether a phase already has work elsewhere (a sibling worktree, an open
// PR) via `gsd_run query worktree phase-preflight`, and instructs the model to STOP
// before dispatching an executor when it does. That instruction is prose — nothing
// verifies the model actually obeyed it. A model that skips straight to
// `Agent(subagent_type="gsd-executor", ...)` without running the check (or runs it,
// sees the warning, and dispatches anyway) hits the exact incident this guard exists
// to prevent: a real duplicate-work run happened this way (2026-08-11, a GSD
// consumer project's v1.1 Phase 8) — a session in the main checkout re-executed a
// phase already fully built and pushed on an open PR from a different worktree.
//
// "A prose backstop cannot fix a prose defect" (see gsd-agent-isolation-guard.js,
// the direct precedent for this hook) — this enforces the same invariant at the
// tooling layer: HARD-BLOCKING.
//
// Applicability (must positively determine all of the following — otherwise inert):
//   1. this is a GSD project (`.planning/config.json` exists under cwd),
//   2. the dispatch target is an executor (`subagent_type === "gsd-executor"`),
//   3. a phase number can be extracted from the dispatch's own prompt/description
//      text (via the shared `extractDispatchIdentifiers` helper — the same seam
//      `gsd-agent-isolation-guard.js` uses).
//
// Fail-open by design (the opposite default from the isolation guard, deliberately):
// the isolation guard's job is "never dispatch unisolated when isolation was
// promised" — a guard that cannot verify must deny, because the unverified default
// (unisolated) is itself dangerous. THIS guard's job is narrower: block only on
// POSITIVE evidence that a phase already has work elsewhere. An environment gap
// (git error, no `gh`, unresolvable phase number, unreadable config) must never
// block a dispatch that may have no conflict at all — that would turn a warning
// system into a source of false-positive outages. See `phase-preflight.cts`'s
// module docstring for the same design principle applied to the underlying check.
//
// Self-exclusion: a session legitimately running its own phase's executor FROM the
// one true worktree for that phase must never see itself reported back as
// "existing work found elsewhere" — `findMatchingWorktrees` in phase-preflight.cts
// already excludes the caller's own checkout from its results, so this guard
// inherits that correctness for free.
//
// Triggers on: Agent/Task tool calls with subagent_type === "gsd-executor"
// Action: BLOCK (exit 2) when the phase already has matching work elsewhere
// No-op: any tool other than Agent/Task, non-executor targets, no phase number
//        extractable from the dispatch text, non-GSD projects, malformed
//        payloads, or a preflight check that errors/cannot resolve.

'use strict';

const fs = require('fs');
const path = require('path');

const PHASE_DISPATCH_SUBAGENT_TYPES = new Set(['gsd-executor']);

/**
 * Does `.planning/config.json` exist under `cwd`? Mirrors the GSD-project signal
 * used by `gsd-agent-isolation-guard.js` and `gsd-workflow-guard.js` — existence
 * alone, not readability, since an unreadable-but-present config still means
 * "this is a GSD project" for applicability purposes.
 */
function isGsdProject(cwd) {
  try {
    fs.accessSync(path.join(cwd, '.planning', 'config.json'), fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Formats the block message from a `checkPhaseWorktree` result whose verdict is
 * `existing_work_found`. Lists every matching worktree and PR, not just the first
 * — a phase could plausibly have both a stray local worktree AND an open PR from
 * different sessions. Each entry gets a relative-age clause ("last commit 3 hours
 * ago" / "updated 6 weeks ago") so the reader can judge active-vs-abandoned
 * themselves — this never changes the block itself, only how it's described.
 *
 * `result.anyRecentMatch` (any match touched within RECENT_THRESHOLD_MS) adds an
 * explicit prompt to check other active sessions before proceeding: the hook
 * itself has no way to see other running sessions (that's a model-facing
 * capability, e.g. a peer-session listing tool), but the model reading this
 * block message does, and a recent match is exactly the case where a live
 * session collision is plausible enough to be worth that extra check.
 *
 * `now` defaults to Date.now(); tests inject a fixed value for determinism
 * (matches phase-preflight.cts's `deps.now` convention).
 */
function formatBlockReason(phase, result, now = Date.now()) {
  const { formatRelativeAge, isStale } = require('../gsd-core/bin/lib/phase-preflight.cjs');
  const lines = [
    `Phase dispatch guard: phase ${phase} already has work elsewhere — refusing to ` +
    `dispatch a fresh gsd-executor from this checkout. Re-executing it would ` +
    `duplicate work already done, possibly by a different session.`,
  ];
  for (const wt of result.matchingWorktrees) {
    const age = formatRelativeAge(wt.lastCommitAt, now);
    const ageClause = age ? ` — last commit ${age}` : '';
    lines.push(`  worktree: ${wt.path} [${wt.branch}]${ageClause}`);
  }
  for (const pr of result.matchingPullRequests) {
    lines.push(`  PR #${pr.number}: ${pr.title} (${pr.url}, updated ${pr.updatedAt})`);
  }
  if (result.anyRecentMatch) {
    lines.push(
      'At least one match was touched within the last 6 hours — before routing around ' +
      'it, check whether another session is currently active on this project (e.g. list ' +
      'other running agent sessions) rather than assuming it\'s safe to proceed elsewhere.'
    );
  } else {
    const allStale =
      result.matchingWorktrees.every((wt) => isStale(wt.lastCommitAt, now)) &&
      result.matchingPullRequests.every((pr) => isStale(pr.updatedAt, now)) &&
      (result.matchingWorktrees.length > 0 || result.matchingPullRequests.length > 0);
    if (allStale) {
      lines.push('All matches look old enough to be worth confirming they\'re not simply abandoned.');
    }
  }
  lines.push(
    'Enter that worktree (or inspect the PR) instead. If the other work is genuinely ' +
    'abandoned, remove or merge it first, then re-run this dispatch.'
  );
  return lines.join('\n');
}

function formatStatusStackBlockReason(result) {
  const pending = result.edges
    .filter((edge) => !edge.aligned)
    .map((edge) => `${edge.from} -> ${edge.to}`);
  const suffix = pending.length > 0
    ? ` Pending propagation: ${pending.join(', ')}.`
    : '';
  return `Status-stack guard: ${result.reason}. Update ${result.status_branch} first, then merge it through the configured phase branch chain before dispatching new phase work.${suffix}`;
}

/**
 * Process one PreToolUse payload (already JSON-parsed) and return the decision
 * without touching stdin/stdout/process.exit — the directly-testable core of this
 * hook's logic, mirroring `gsd-agent-isolation-guard.js`'s `evaluateDispatch` shape.
 *
 * `deps.checkPhaseWorktree` defaults to the real compiled module's export; tests
 * inject a stub so no real git/gh process is exercised.
 *
 * Returns `{ action: 'allow' } | { action: 'block', reason: string }`.
 */
function evaluateDispatch(data, deps = {}) {
  if (!data || typeof data !== 'object') return { action: 'allow' };
  if (data.tool_name !== 'Agent' && data.tool_name !== 'Task') return { action: 'allow' };

  const toolInput = (data.tool_input && typeof data.tool_input === 'object') ? data.tool_input : {};
  const subagentType = toolInput.subagent_type;
  if (typeof subagentType !== 'string' || !PHASE_DISPATCH_SUBAGENT_TYPES.has(subagentType)) {
    return { action: 'allow' };
  }

  const cwd = data.cwd || process.cwd();
  if (!isGsdProject(cwd)) return { action: 'allow' };

  const extractDispatchIdentifiers = deps.extractDispatchIdentifiers
    ?? require('./lib/isolation-sentinel.js').extractDispatchIdentifiers;
  const { phase } = extractDispatchIdentifiers(toolInput.description ?? toolInput.prompt);
  if (!phase) return { action: 'allow' };

  const checkStatusStack = deps.checkStatusStack
    ?? require('../gsd-core/bin/lib/worktree-safety.cjs').checkStatusStack;
  let stackResult;
  try {
    stackResult = checkStatusStack(cwd, {});
  } catch {
    // The phase-dispatch guard is intentionally fail-open for unavailable
    // environmental checks; only a confirmed stale status chain blocks work.
    stackResult = null;
  }
  if (stackResult?.configured && stackResult.verdict === 'misaligned') {
    return { action: 'block', reason: formatStatusStackBlockReason(stackResult) };
  }

  const checkPhaseWorktree = deps.checkPhaseWorktree
    ?? require('../gsd-core/bin/lib/phase-preflight.cjs').checkPhaseWorktree;

  let result;
  try {
    result = checkPhaseWorktree(cwd, phase, {});
  } catch {
    // A preflight check that throws is an environment gap, not evidence of a
    // conflict — fail open (see module docstring: this guard is opposite-default
    // from the isolation guard by design).
    return { action: 'allow' };
  }

  if (!result || !result.ok || result.verdict !== 'existing_work_found') {
    return { action: 'allow' };
  }

  return { action: 'block', reason: formatBlockReason(phase, result, deps.now) };
}

/* istanbul ignore next -- stdin adapter, exercised via spawnSync in tests */
function main() {
  let input = '';
  const stdinTimeout = setTimeout(() => process.exit(0), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    try {
      const data = JSON.parse(input);
      const decision = evaluateDispatch(data);
      if (decision.action === 'block') {
        const out = { decision: 'block', reason: decision.reason };
        process.stdout.write(JSON.stringify(out));
        process.stderr.write(decision.reason);
        process.exit(2);
      }
      process.exit(0);
    } catch {
      // Silent fail — never block valid tool calls due to hook errors
      // (malformed payload, etc.).
      process.exit(0);
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateDispatch,
  isGsdProject,
  formatBlockReason,
  formatStatusStackBlockReason,
};
