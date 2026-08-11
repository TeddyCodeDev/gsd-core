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

function formatBlockReason(phase, result) {
  const lines = [
    `Phase dispatch guard: phase ${phase} already has work elsewhere — refusing to ` +
    `dispatch a fresh gsd-executor from this checkout. Re-executing it would ` +
    `duplicate work already done, possibly by a different session.`,
  ];
  for (const wt of result.matchingWorktrees) {
    lines.push(`  worktree: ${wt.path} [${wt.branch}]`);
  }
  for (const pr of result.matchingPullRequests) {
    lines.push(`  PR #${pr.number}: ${pr.title} (${pr.url}, updated ${pr.updatedAt})`);
  }
  lines.push(
    'Enter that worktree (or inspect the PR) instead. If the other work is genuinely ' +
    'abandoned, remove or merge it first, then re-run this dispatch.'
  );
  return lines.join('\n');
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
  return { action: 'block', reason: formatBlockReason(phase, result) };
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

module.exports = { evaluateCodexDispatch, extractPhase, formatBlockReason, isGsdProject };
