'use strict';

/**
 * Phase Dispatch Guard — PreToolUse hook unit tests
 *
 * Seam: hooks/gsd-phase-dispatch-guard.js
 * Interface: evaluateDispatch, isGsdProject, formatBlockReason
 *
 * All tests inject `checkPhaseWorktree` / `extractDispatchIdentifiers` via the
 * `deps` parameter — no real git, gh, or filesystem I/O is exercised except
 * `isGsdProject`'s own dedicated tests, which use a real temp directory (matching
 * `gsd-agent-isolation-guard.test.cjs`'s convention for its own project-detection
 * helper).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MODULE_PATH = path.join(__dirname, '..', 'hooks', 'gsd-phase-dispatch-guard.js');
const { evaluateDispatch, isGsdProject, formatBlockReason, formatStatusStackBlockReason } = require(MODULE_PATH);

function makeTempGsdProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-phase-dispatch-guard-'));
  fs.mkdirSync(path.join(dir, '.planning'));
  fs.writeFileSync(path.join(dir, '.planning', 'config.json'), '{}');
  return dir;
}

const EXTRACT_PHASE_08 = () => ({ plan: '01', phase: '08' });
const EXTRACT_NO_MATCH = () => ({ plan: null, phase: null });

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

const MISALIGNED_STATUS_STACK = {
  configured: true,
  verdict: 'misaligned',
  reason: 'status_not_propagated:gsd-status->v1.1/phase-09-input-wizard',
  status_branch: 'gsd-status',
  edges: [{ from: 'gsd-status', to: 'v1.1/phase-09-input-wizard', aligned: false }],
};

const NOW = Date.parse('2026-08-11T18:00:00Z');

// ─── isGsdProject ───────────────────────────────────────────────────────────────

describe('isGsdProject', () => {
  test('returns true when .planning/config.json exists', () => {
    const dir = makeTempGsdProject();
    assert.strictEqual(isGsdProject(dir), true);
  });

  test('returns false for a directory with no .planning/config.json', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-phase-dispatch-guard-not-gsd-'));
    assert.strictEqual(isGsdProject(dir), false);
  });

  test('returns false for a nonexistent directory (does not throw)', () => {
    assert.doesNotThrow(() => {
      assert.strictEqual(isGsdProject('/definitely/does/not/exist/xyz'), false);
    });
  });
});

// ─── formatBlockReason ────────────────────────────────────────────────────────

describe('formatBlockReason', () => {
  test('lists every matching worktree and PR, not just the first', () => {
    const reason = formatBlockReason('08', EXISTING_WORK_RESULT, NOW);
    assert.match(reason, /\/repo\/\.worktrees\/pr99-fix/);
    assert.match(reason, /v1\.1\/phase-08-onboarding/);
    assert.match(reason, /#99/);
    assert.match(reason, /Phase 8: Onboarding/);
  });

  test('omits the age clause when lastCommitAt is null (degrades gracefully)', () => {
    const reason = formatBlockReason('08', EXISTING_WORK_RESULT, NOW);
    assert.doesNotMatch(reason, /last commit/);
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
    assert.match(reason, /check whether another session is currently active/);
  });

  test('does not add the active-session-check prompt when anyRecentMatch is false', () => {
    const reason = formatBlockReason('08', EXISTING_WORK_RESULT, NOW);
    assert.doesNotMatch(reason, /currently active/);
  });

  test('adds the "looks abandoned" note when every match is stale and anyRecentMatch is false', () => {
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

  // Counter-test: a mix of stale and unknown-age matches must NOT trigger the
  // "looks abandoned" note — that note is only warranted when EVERY match is
  // affirmatively old, not merely "not known to be recent."
  test('does not add the "looks abandoned" note when any match has an unknown age', () => {
    const reason = formatBlockReason('08', EXISTING_WORK_RESULT, NOW);
    assert.doesNotMatch(reason, /worth confirming/);
  });
});

describe('formatStatusStackBlockReason', () => {
  test('names the status branch and the pending stack edge', () => {
    const reason = formatStatusStackBlockReason(MISALIGNED_STATUS_STACK);
    assert.match(reason, /gsd-status/);
    assert.match(reason, /phase-09-input-wizard/);
  });
});

// ─── evaluateDispatch ─────────────────────────────────────────────────────────

describe('evaluateDispatch', () => {
  test('allows a malformed payload', () => {
    assert.deepStrictEqual(evaluateDispatch(null), { action: 'allow' });
    assert.deepStrictEqual(evaluateDispatch(undefined), { action: 'allow' });
  });

  test('allows a tool that is not Agent or Task', () => {
    const result = evaluateDispatch({ tool_name: 'Bash', tool_input: {} });
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('allows an Agent dispatch whose subagent_type is not gsd-executor', () => {
    const result = evaluateDispatch({
      tool_name: 'Agent',
      tool_input: { subagent_type: 'gsd-planner', description: 'plan phase 08' },
    });
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('allows when not a GSD project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-phase-dispatch-guard-nongsd-'));
    const result = evaluateDispatch({
      tool_name: 'Agent',
      cwd: dir,
      tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan 01 of phase 08' },
    });
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('allows when no phase number can be extracted from the dispatch text', () => {
    const dir = makeTempGsdProject();
    const result = evaluateDispatch(
      { tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'gsd-executor', description: 'do something unrelated' } },
      { extractDispatchIdentifiers: EXTRACT_NO_MATCH }
    );
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('allows when the preflight check resolves safe_to_create', () => {
    const dir = makeTempGsdProject();
    const result = evaluateDispatch(
      { tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan 01 of phase 09' } },
      { extractDispatchIdentifiers: EXTRACT_PHASE_08, checkPhaseWorktree: () => SAFE_RESULT }
    );
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('BLOCKS when a configured status branch has not been propagated through the phase stack', () => {
    const dir = makeTempGsdProject();
    const result = evaluateDispatch(
      { tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan 01 of phase 09' } },
      {
        extractDispatchIdentifiers: EXTRACT_PHASE_08,
        checkStatusStack: () => MISALIGNED_STATUS_STACK,
        checkPhaseWorktree: () => SAFE_RESULT,
      }
    );
    assert.strictEqual(result.action, 'block');
    assert.match(result.reason, /Status-stack guard/);
  });

  test('allows when the status-stack check is unavailable', () => {
    const dir = makeTempGsdProject();
    const result = evaluateDispatch(
      { tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan 01 of phase 09' } },
      {
        extractDispatchIdentifiers: EXTRACT_PHASE_08,
        checkStatusStack: () => ({ configured: true, verdict: 'unavailable' }),
        checkPhaseWorktree: () => SAFE_RESULT,
      }
    );
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  // Counter-test: a preflight check that throws (git error, unreadable state,
  // any environment gap) must fail open, not block a dispatch that might have
  // no conflict at all — this guard's default is the opposite of the isolation
  // guard's fail-closed default, by design (see module docstring).
  test('allows when the preflight check throws (fails open, not closed)', () => {
    const dir = makeTempGsdProject();
    const result = evaluateDispatch(
      { tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan 01 of phase 08' } },
      {
        extractDispatchIdentifiers: EXTRACT_PHASE_08,
        checkPhaseWorktree: () => { throw new Error('git exploded'); },
      }
    );
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  test('allows when the preflight check could not resolve (ok: false)', () => {
    const dir = makeTempGsdProject();
    const result = evaluateDispatch(
      { tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan 01 of phase 08' } },
      { extractDispatchIdentifiers: EXTRACT_PHASE_08, checkPhaseWorktree: () => ({ ok: false, verdict: null }) }
    );
    assert.deepStrictEqual(result, { action: 'allow' });
  });

  // Positive case: this is the actual incident this hook exists to prevent.
  test('BLOCKS when the preflight check finds existing work elsewhere', () => {
    const dir = makeTempGsdProject();
    const result = evaluateDispatch(
      { tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan 01 of phase 08' } },
      { extractDispatchIdentifiers: EXTRACT_PHASE_08, checkPhaseWorktree: () => EXISTING_WORK_RESULT }
    );
    assert.strictEqual(result.action, 'block');
    assert.match(result.reason, /phase 08 already has work elsewhere/);
    assert.match(result.reason, /pr99-fix/);
  });

  test('also matches the Task tool name (not just Agent)', () => {
    const dir = makeTempGsdProject();
    const result = evaluateDispatch(
      { tool_name: 'Task', cwd: dir, tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan 01 of phase 08' } },
      { extractDispatchIdentifiers: EXTRACT_PHASE_08, checkPhaseWorktree: () => EXISTING_WORK_RESULT }
    );
    assert.strictEqual(result.action, 'block');
  });

  test('passes the phase number through to checkPhaseWorktree correctly', () => {
    const dir = makeTempGsdProject();
    let receivedPhase = null;
    evaluateDispatch(
      { tool_name: 'Agent', cwd: dir, tool_input: { subagent_type: 'gsd-executor', description: 'Execute plan 01 of phase 08' } },
      {
        extractDispatchIdentifiers: EXTRACT_PHASE_08,
        checkPhaseWorktree: (_cwd, phase) => { receivedPhase = phase; return SAFE_RESULT; },
      }
    );
    assert.strictEqual(receivedPhase, '08');
  });
});
