'use strict';

/**
 * Codex-native phase-dispatch guard unit tests.
 *
 * The unit seam is evaluateCodexDispatch. Every preflight outcome is injected,
 * so this suite performs no git or gh I/O.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'hooks', 'gsd-codex-phase-dispatch-guard.js');
const { evaluateCodexDispatch, extractPhase, formatBlockReason, isGsdProject } = require(MODULE_PATH);
const { ensureCodexHooksJsonScriptEvent } = require('../bin/install.js');

function makeTempGsdProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-phase-dispatch-guard-'));
  fs.mkdirSync(path.join(dir, '.planning'));
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');
  return dir;
}

const EXISTING_WORK_RESULT = {
  ok: true,
  phase: '08',
  verdict: 'existing_work_found',
  matchingWorktrees: [{ path: '/repo/.worktrees/pr99-fix', branch: 'v1.1/phase-08-onboarding', lastCommitAt: null }],
  matchingPullRequests: [{ number: 99, title: 'Phase 8: Onboarding', url: 'https://x/99', updatedAt: 'now' }],
  anyRecentMatch: false,
};

const SAFE_RESULT = {
  ok: true,
  phase: '08',
  verdict: 'safe_to_create',
  matchingWorktrees: [],
  matchingPullRequests: [],
};

const NOW = Date.parse('2026-08-11T18:00:00Z');

function executorPayload(cwd, message = 'Execute plan 01 of phase 08') {
  return { tool_name: 'spawn_agent', cwd, tool_input: { agent_type: 'gsd-executor', message } };
}

describe('Codex phase dispatch guard helpers', () => {
  test('recognises only the phase syntax embedded in an executor message', () => {
    assert.strictEqual(extractPhase('Execute plan 01 of phase 08-onboarding'), '08-onboarding');
    assert.strictEqual(extractPhase('inspect an unrelated file'), null);
  });

  test('detects a GSD project by its config file without throwing for absent paths', () => {
    const project = makeTempGsdProject();
    assert.strictEqual(isGsdProject(project), true);
    assert.strictEqual(isGsdProject('/definitely/does/not/exist/gsd-codex-guard'), false);
  });

  test('formats each positive worktree and pull-request signal', () => {
    const reason = formatBlockReason('08', EXISTING_WORK_RESULT, NOW);
    assert.match(reason, /pr99-fix/);
    assert.match(reason, /#99/);
  });

  test('includes a relative-age clause for a worktree with a known lastCommitAt', () => {
    const result = {
      ...EXISTING_WORK_RESULT,
      matchingWorktrees: [{ path: '/repo/.worktrees/pr99-fix', branch: 'v1.1/phase-08-onboarding', lastCommitAt: '2026-08-11T13:07:10Z' }],
      matchingPullRequests: [],
    };
    const reason = formatBlockReason('08', result, NOW);
    assert.match(reason, /last commit 5 hours ago/);
  });

  test('adds the active-session-check prompt when anyRecentMatch is true', () => {
    const result = { ...EXISTING_WORK_RESULT, anyRecentMatch: true };
    const reason = formatBlockReason('08', result, NOW);
    assert.match(reason, /touched within the last 6 hours/);
  });

  test('adds the "looks abandoned" note when every match is affirmatively stale', () => {
    const result = {
      ok: true,
      phase: '08',
      verdict: 'existing_work_found',
      matchingWorktrees: [{ path: '/repo/.worktrees/pr99-fix', branch: 'v1.1/phase-08-onboarding', lastCommitAt: '2026-06-01T00:00:00Z' }],
      matchingPullRequests: [],
      anyRecentMatch: false,
    };
    const reason = formatBlockReason('08', result, NOW);
    assert.match(reason, /worth confirming they're not simply abandoned/);
  });
});

describe('evaluateCodexDispatch', () => {
  test('allows malformed data and every non-native dispatch surface', () => {
    assert.deepStrictEqual(evaluateCodexDispatch(null), { action: 'allow' });
    assert.deepStrictEqual(evaluateCodexDispatch({ tool_name: 'Agent', tool_input: {} }), { action: 'allow' });
    assert.deepStrictEqual(evaluateCodexDispatch({ tool_name: 'send_message', tool_input: {} }), { action: 'allow' });
  });

  test('allows native dispatches for non-executor agent types', () => {
    const result = evaluateCodexDispatch({
      tool_name: 'spawn_agent',
      tool_input: { agent_type: 'gsd-planner', message: 'Execute plan 01 of phase 08' },
    });
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('allows executor dispatches outside a GSD project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-phase-non-project-'));
    assert.deepStrictEqual(evaluateCodexDispatch(executorPayload(dir)), { action: 'allow' });
  });

  test('allows executor dispatches when the message carries no phase', () => {
    const result = evaluateCodexDispatch(executorPayload(makeTempGsdProject(), 'Review the current implementation'));
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('allows a safe preflight result', () => {
    const result = evaluateCodexDispatch(executorPayload(makeTempGsdProject()), {
      checkPhaseWorktree: () => SAFE_RESULT,
    });
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('fails open when the preflight check throws', () => {
    const result = evaluateCodexDispatch(executorPayload(makeTempGsdProject()), {
      checkPhaseWorktree: () => { throw new Error('git exploded'); },
    });
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('fails open when preflight cannot resolve a phase verdict', () => {
    const result = evaluateCodexDispatch(executorPayload(makeTempGsdProject()), {
      checkPhaseWorktree: () => ({ ok: false, verdict: null }),
    });
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('BLOCKS the real Codex spawn_agent shape on positive conflict evidence', () => {
    const result = evaluateCodexDispatch(executorPayload(makeTempGsdProject()), {
      checkPhaseWorktree: () => EXISTING_WORK_RESULT,
    });
    assert.strictEqual(result.action, 'block');
    assert.match(result.reason, /phase 08 already has work elsewhere/);
  });

  test('passes the extracted phase to the shared preflight checker', () => {
    let receivedPhase = null;
    evaluateCodexDispatch(executorPayload(makeTempGsdProject(), 'Execute plan 03 of phase 11-recovery'), {
      checkPhaseWorktree: (_cwd, phase) => { receivedPhase = phase; return SAFE_RESULT; },
    });
    assert.strictEqual(receivedPhase, '11-recovery');
  });
});

describe('Codex hooks.json registration', () => {
  test('registers the native spawn_agent guard without removing another PreToolUse handler', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-phase-hook-install-'));
    const options = { absoluteRunner: '"/usr/local/bin/node"', platform: 'linux' };

    ensureCodexHooksJsonScriptEvent(targetDir, 'PreToolUse', 'gsd-context-monitor.js', {
      ...options,
      matcher: 'Bash',
      timeout: 10,
    });
    ensureCodexHooksJsonScriptEvent(targetDir, 'PreToolUse', 'gsd-codex-phase-dispatch-guard.js', {
      ...options,
      matcher: '^spawn_agent$',
      timeout: 8,
    });

    const hooksJson = JSON.parse(fs.readFileSync(path.join(targetDir, 'hooks.json'), 'utf8'));
    const handlers = hooksJson.hooks.PreToolUse.flatMap((entry) => entry.hooks.map((hook) => ({ ...hook, matcher: entry.matcher })));
    const guard = handlers.find((handler) => handler.command.includes('gsd-codex-phase-dispatch-guard.js'));
    const monitor = handlers.find((handler) => handler.command.includes('gsd-context-monitor.js'));

    assert.ok(guard, `Codex phase guard must be registered: ${JSON.stringify(hooksJson)}`);
    assert.strictEqual(guard.matcher, '^spawn_agent$');
    assert.strictEqual(guard.timeout, 8);
    assert.ok(monitor, 'registering the guard must preserve existing PreToolUse handlers');
  });
});
