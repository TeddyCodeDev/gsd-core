#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Codex Phase Dispatch Guard — PreToolUse hook
//
// Codex dispatches subagents through its native `spawn_agent` local function
// tool. Its hook payload is consequently different from Claude Code's
// Agent/Task shape: `tool_input.agent_type` identifies the role and
// `tool_input.message` carries the task. This guard is the Codex-native
// counterpart of gsd-phase-dispatch-guard.js. Both hard-block only when
// checkPhaseWorktree returns positive evidence (`existing_work_found`). Any
// missing project metadata, unrecognised task text, or git/gh/check failure
// allows the dispatch: unlike the isolation guard, an inability to check is
// not evidence that creating work would be unsafe.

'use strict';

const fs = require('fs');
const path = require('path');

const CODEX_DISPATCH_TOOL = 'spawn_agent';
const EXECUTOR_AGENT_TYPES = new Set(['gsd-executor']);

function isGsdProject(cwd) {
  try {
    fs.accessSync(path.join(cwd, '.planning', 'config.json'), fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function extractPhase(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const match = /execute\s+plan\s+\S+\s+of\s+phase\s+(\S+)/i.exec(text);
  return match ? match[1] : null;
}

/**
 * Same message shape as the Claude-side guard's formatBlockReason (kept in sync
 * by hand — both hooks predate a shared-formatter extraction and this is a
 * small enough function that duplicating it beats adding a require-cycle risk
 * between the two hook entry points). See that file's docstring for the
 * anyRecentMatch/isStale rationale. `now` defaults to Date.now(); tests
 * inject a fixed value for determinism.
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
 * Process Codex's native `spawn_agent` PreToolUse payload without process I/O.
 * `checkPhaseWorktree` is injected by tests; production uses the compiled
 * preflight module rather than duplicating git/gh conflict detection here.
 */
function evaluateCodexDispatch(data, deps = {}) {
  if (!data || typeof data !== 'object' || data.tool_name !== CODEX_DISPATCH_TOOL) {
    return { action: 'allow' };
  }

  const toolInput = data.tool_input && typeof data.tool_input === 'object' ? data.tool_input : {};
  if (typeof toolInput.agent_type !== 'string' || !EXECUTOR_AGENT_TYPES.has(toolInput.agent_type)) {
    return { action: 'allow' };
  }

  const cwd = data.cwd || process.cwd();
  if (!isGsdProject(cwd)) return { action: 'allow' };

  const phase = extractPhase(toolInput.message ?? toolInput.prompt ?? toolInput.description);
  if (!phase) return { action: 'allow' };

  const checkStatusStack = deps.checkStatusStack
    ?? require('../gsd-core/bin/lib/worktree-safety.cjs').checkStatusStack;
  let stackResult;
  try {
    stackResult = checkStatusStack(cwd, {});
  } catch {
    // Like the phase preflight, an unreadable local state is not positive
    // evidence that dispatching would be unsafe.
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
      const decision = evaluateCodexDispatch(JSON.parse(input));
      if (decision.action === 'block') {
        process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }));
        process.stderr.write(decision.reason);
        process.exit(2);
      }
    } catch {
      // Fail open: malformed hook input is never evidence of a conflict.
    }
    process.exit(0);
  });
}

if (require.main === module) main();

module.exports = {
  evaluateCodexDispatch,
  extractPhase,
  formatBlockReason,
  formatStatusStackBlockReason,
  isGsdProject,
};
