'use strict';

/**
 * Phase Preflight Module — unit tests
 *
 * Seam: gsd-core/bin/lib/phase-preflight.cjs
 * Interface: normalizePhaseNumber, resolveCurrentPhaseFromState, matchesPhaseBranch,
 *            parseWorktreeListPorcelain, findMatchingWorktrees, findMatchingPullRequests,
 *            checkPhaseWorktree, cmdPhasePreflight
 *
 * All tests use dependency injection (inline stubs) — no real filesystem, git, or
 * gh process is exercised.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'phase-preflight.cjs'
);

const {
  normalizePhaseNumber,
  resolveCurrentPhaseFromState,
  matchesPhaseBranch,
  parseWorktreeListPorcelain,
  findMatchingWorktrees,
  findMatchingPullRequests,
  checkPhaseWorktree,
  cmdPhasePreflight,
} = require(MODULE_PATH);

const PASSTHROUGH = Object.freeze({ exitCode: 0, stdout: '', stderr: '', signal: null, error: null, timedOut: false });

// ─── normalizePhaseNumber ──────────────────────────────────────────────────────

describe('normalizePhaseNumber', () => {
  test('zero-pads a single-digit phase number', () => {
    assert.strictEqual(normalizePhaseNumber('8'), '08');
  });

  test('leaves an already-padded phase number unchanged', () => {
    assert.strictEqual(normalizePhaseNumber('08'), '08');
  });

  test('preserves a decimal sub-phase suffix', () => {
    assert.strictEqual(normalizePhaseNumber('8.1'), '08.1');
  });

  test('handles a phase number already >= 10 without truncation', () => {
    assert.strictEqual(normalizePhaseNumber('11'), '11');
  });

  test('passes through unrecognizable input unchanged', () => {
    assert.strictEqual(normalizePhaseNumber('abc'), 'abc');
  });
});

// ─── matchesPhaseBranch ─────────────────────────────────────────────────────────

describe('matchesPhaseBranch', () => {
  test('matches this project\'s v{milestone}/phase-{NN}-{slug} convention', () => {
    assert.strictEqual(matchesPhaseBranch('v1.1/phase-08-onboarding', '08'), true);
  });

  test('matches GSD\'s own gsd/phase-{NN}-{slug} template', () => {
    assert.strictEqual(matchesPhaseBranch('gsd/phase-08-onboarding', '08'), true);
  });

  test('does not match an unrelated branch', () => {
    assert.strictEqual(matchesPhaseBranch('v1.1/phase-09-input-wizard', '08'), false);
  });

  // Counter-test (negative space): a shorter phase number must not false-positive
  // on a longer one that happens to start with the same digits.
  test('does not false-positive on phase 1 matching phase-10 or phase-11', () => {
    assert.strictEqual(matchesPhaseBranch('gsd/phase-10-foo', '1'), false);
    assert.strictEqual(matchesPhaseBranch('gsd/phase-11-bar', '1'), false);
  });

  test('matches when the phase number is the entire remaining branch suffix', () => {
    assert.strictEqual(matchesPhaseBranch('gsd/phase-08', '08'), true);
  });

  test('returns false for an empty branch name', () => {
    assert.strictEqual(matchesPhaseBranch('', '08'), false);
  });
});

// ─── parseWorktreeListPorcelain ─────────────────────────────────────────────────

describe('parseWorktreeListPorcelain', () => {
  test('parses multiple worktree entries', () => {
    const output = [
      'worktree /repo',
      'HEAD abc123',
      'branch refs/heads/develop',
      '',
      'worktree /repo/.worktrees/pr99-fix',
      'HEAD def456',
      'branch refs/heads/v1.1/phase-08-onboarding',
      '',
    ].join('\n');
    assert.deepStrictEqual(parseWorktreeListPorcelain(output), [
      { path: '/repo', branch: 'develop' },
      { path: '/repo/.worktrees/pr99-fix', branch: 'v1.1/phase-08-onboarding' },
    ]);
  });

  test('omits a detached-HEAD worktree (no branch line)', () => {
    const output = [
      'worktree /repo/.worktrees/detached',
      'HEAD abc123',
      'detached',
      '',
    ].join('\n');
    assert.deepStrictEqual(parseWorktreeListPorcelain(output), []);
  });

  test('returns an empty array for empty input', () => {
    assert.deepStrictEqual(parseWorktreeListPorcelain(''), []);
  });
});

// ─── findMatchingWorktrees ───────────────────────────────────────────────────────

/**
 * Builds an arg-aware execGit stub: `git worktree list --porcelain` returns
 * `worktreeListStdout`, `git rev-parse --show-toplevel` returns `ownToplevel`.
 * Real `execGit` behaves differently per subcommand — a stub that ignores
 * `args` would silently mis-test the self-exclusion logic below (contract 5,
 * "complete mocks": mock the dependency's actual branching, not a flattened
 * stand-in for it).
 */
function makeWorktreeExecGit(worktreeListStdout, ownToplevel = '/repo') {
  return (args) => {
    if (args[0] === 'rev-parse') return { ...PASSTHROUGH, stdout: ownToplevel };
    return { ...PASSTHROUGH, stdout: worktreeListStdout };
  };
}

describe('findMatchingWorktrees', () => {
  const TWO_WORKTREES = [
    'worktree /repo',
    'branch refs/heads/develop',
    '',
    'worktree /repo/.worktrees/pr99-fix',
    'branch refs/heads/v1.1/phase-08-onboarding',
    '',
  ].join('\n');

  test('returns only worktrees whose branch matches the phase', () => {
    const execGit = makeWorktreeExecGit(TWO_WORKTREES, '/repo/main-checkout-not-in-list');
    const result = findMatchingWorktrees('/repo', '08', { execGit });
    assert.deepStrictEqual(result, [{ path: '/repo/.worktrees/pr99-fix', branch: 'v1.1/phase-08-onboarding' }]);
  });

  // Counter-test: a session running FROM the matching worktree itself must not
  // see itself reported back as "existing work found elsewhere" — that would
  // block a session from continuing legitimate work in its own checkout.
  test('excludes the caller\'s own checkout from the results (self-exclusion)', () => {
    const execGit = makeWorktreeExecGit(TWO_WORKTREES, '/repo/.worktrees/pr99-fix');
    const result = findMatchingWorktrees('/repo/.worktrees/pr99-fix', '08', { execGit });
    assert.deepStrictEqual(result, []);
  });

  test('self-exclusion degrades to no exclusion when the toplevel lookup fails', () => {
    const execGit = (args) => {
      if (args[0] === 'rev-parse') return { ...PASSTHROUGH, exitCode: 128 };
      return { ...PASSTHROUGH, stdout: TWO_WORKTREES };
    };
    const result = findMatchingWorktrees('/repo/.worktrees/pr99-fix', '08', { execGit });
    assert.deepStrictEqual(result, [{ path: '/repo/.worktrees/pr99-fix', branch: 'v1.1/phase-08-onboarding' }]);
  });

  // Counter-test: git failure must degrade to an empty list, not throw.
  test('degrades to an empty list on git error, does not throw', () => {
    const execGit = () => ({ ...PASSTHROUGH, exitCode: 128, stderr: 'fatal: not a git repository' });
    assert.doesNotThrow(() => {
      const result = findMatchingWorktrees('/repo', '08', { execGit });
      assert.deepStrictEqual(result, []);
    });
  });

  test('degrades to an empty list on git timeout', () => {
    const execGit = () => ({ ...PASSTHROUGH, timedOut: true });
    assert.deepStrictEqual(findMatchingWorktrees('/repo', '08', { execGit }), []);
  });
});

// ─── findMatchingPullRequests ─────────────────────────────────────────────────────

describe('findMatchingPullRequests', () => {
  test('returns matching PRs parsed from gh output', () => {
    const execTool = () => ({
      ...PASSTHROUGH,
      stdout: JSON.stringify([
        { number: 99, headRefName: 'v1.1/phase-08-onboarding', title: 'Phase 8: Onboarding', url: 'https://github.com/x/y/pull/99', updatedAt: '2026-08-11T16:25:05Z' },
        { number: 100, headRefName: 'v1.1/phase-09-input-wizard', title: 'Phase 9', url: 'https://github.com/x/y/pull/100', updatedAt: '2026-08-11T00:00:00Z' },
      ]),
    });
    const result = findMatchingPullRequests('/repo', '08', { execTool });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.matches.length, 1);
    assert.strictEqual(result.matches[0].number, 99);
  });

  test('returns no matches (not skipped) when gh succeeds with an empty list', () => {
    const execTool = () => ({ ...PASSTHROUGH, stdout: '[]' });
    const result = findMatchingPullRequests('/repo', '08', { execTool });
    assert.deepStrictEqual(result, { matches: [], skipped: false, skipReason: null });
  });

  // Counter-test: gh not installed must be reported as skipped with a specific
  // reason, not silently treated as "no PRs found" (those are different verdicts
  // for the caller — one means "checked, nothing there," the other means "did
  // not check").
  test('skips with gh_not_installed reason on exit 127', () => {
    const execTool = () => ({ ...PASSTHROUGH, exitCode: 127, stderr: 'gh: not found' });
    const result = findMatchingPullRequests('/repo', '08', { execTool });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skipReason, 'gh_not_installed');
    assert.deepStrictEqual(result.matches, []);
  });

  test('skips with gh_error reason when gh exits non-zero for another reason', () => {
    const execTool = () => ({ ...PASSTHROUGH, exitCode: 1, stderr: 'gh: not authenticated' });
    const result = findMatchingPullRequests('/repo', '08', { execTool });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(result.skipReason, 'gh_error');
  });

  test('skips with gh_timeout reason on timeout', () => {
    const execTool = () => ({ ...PASSTHROUGH, timedOut: true });
    const result = findMatchingPullRequests('/repo', '08', { execTool });
    assert.strictEqual(result.skipReason, 'gh_timeout');
  });

  test('skips with gh_output_unparseable reason on malformed JSON', () => {
    const execTool = () => ({ ...PASSTHROUGH, stdout: 'not json' });
    const result = findMatchingPullRequests('/repo', '08', { execTool });
    assert.strictEqual(result.skipReason, 'gh_output_unparseable');
  });
});

// ─── resolveCurrentPhaseFromState ────────────────────────────────────────────────

describe('resolveCurrentPhaseFromState', () => {
  test('reads current_phase from STATE.md frontmatter', () => {
    const readFile = () => '---\ncurrent_phase: "08"\ncurrent_phase_name: onboarding\n---\n';
    assert.strictEqual(resolveCurrentPhaseFromState('/repo', { readFile }), '08');
  });

  test('reads an unquoted current_phase value', () => {
    const readFile = () => '---\ncurrent_phase: 9\n---\n';
    assert.strictEqual(resolveCurrentPhaseFromState('/repo', { readFile }), '9');
  });

  test('returns null when STATE.md is missing', () => {
    const readFile = () => null;
    assert.strictEqual(resolveCurrentPhaseFromState('/repo', { readFile }), null);
  });

  test('returns null when current_phase field is absent', () => {
    const readFile = () => '---\nmilestone: v1.1\n---\n';
    assert.strictEqual(resolveCurrentPhaseFromState('/repo', { readFile }), null);
  });
});

// ─── checkPhaseWorktree (integration of the above) ───────────────────────────────

describe('checkPhaseWorktree', () => {
  test('verdict is existing_work_found when a matching worktree exists', () => {
    const execGit = makeWorktreeExecGit('worktree /repo/.worktrees/pr99-fix\nbranch refs/heads/v1.1/phase-08-onboarding\n', '/repo');
    const execTool = () => ({ ...PASSTHROUGH, stdout: '[]' });
    const result = checkPhaseWorktree('/repo', '08', { execGit, execTool });
    assert.strictEqual(result.verdict, 'existing_work_found');
    assert.strictEqual(result.matchingWorktrees.length, 1);
  });

  test('verdict is existing_work_found when only a matching PR exists (no local worktree)', () => {
    const execGit = makeWorktreeExecGit('worktree /repo\nbranch refs/heads/develop\n', '/repo');
    const execTool = () => ({
      ...PASSTHROUGH,
      stdout: JSON.stringify([{ number: 99, headRefName: 'v1.1/phase-08-onboarding', title: 't', url: 'u', updatedAt: 'now' }]),
    });
    const result = checkPhaseWorktree('/repo', '08', { execGit, execTool });
    assert.strictEqual(result.verdict, 'existing_work_found');
    assert.strictEqual(result.matchingPullRequests.length, 1);
  });

  test('verdict is safe_to_create when nothing matches', () => {
    const execGit = makeWorktreeExecGit('worktree /repo\nbranch refs/heads/develop\n', '/repo');
    const execTool = () => ({ ...PASSTHROUGH, stdout: '[]' });
    const result = checkPhaseWorktree('/repo', '09', { execGit, execTool });
    assert.strictEqual(result.verdict, 'safe_to_create');
    assert.strictEqual(result.matchingWorktrees.length, 0);
    assert.strictEqual(result.matchingPullRequests.length, 0);
  });

  test('falls back to STATE.md current_phase when no phase argument is given', () => {
    const execGit = makeWorktreeExecGit('worktree /repo/.worktrees/pr99-fix\nbranch refs/heads/v1.1/phase-08-onboarding\n', '/repo');
    const execTool = () => ({ ...PASSTHROUGH, stdout: '[]' });
    const readFile = () => '---\ncurrent_phase: "08"\n---\n';
    const result = checkPhaseWorktree('/repo', null, { execGit, execTool, readFile });
    assert.strictEqual(result.phase, '08');
    assert.strictEqual(result.verdict, 'existing_work_found');
  });

  // Counter-test: an unresolvable phase must produce a distinct, honest verdict
  // (null), not silently default to "safe" or "found" — a caller that dispatches
  // on a null verdict without checking `ok` would be trusting a check that never
  // actually ran.
  test('verdict is null and ok is false when the phase cannot be resolved', () => {
    const readFile = () => null;
    const result = checkPhaseWorktree('/repo', null, { readFile });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.verdict, null);
    assert.strictEqual(result.reason, 'phase_unresolved');
  });

  test('still reports a verdict when the PR check is skipped, driven by the worktree check alone', () => {
    const execGit = makeWorktreeExecGit('worktree /repo/.worktrees/pr99-fix\nbranch refs/heads/v1.1/phase-08-onboarding\n', '/repo');
    const execTool = () => ({ ...PASSTHROUGH, exitCode: 127 });
    const result = checkPhaseWorktree('/repo', '08', { execGit, execTool });
    assert.strictEqual(result.prCheckSkipped, true);
    assert.strictEqual(result.verdict, 'existing_work_found');
  });
});

// ─── cmdPhasePreflight (CLI entrypoint contract) ─────────────────────────────────

describe('cmdPhasePreflight', () => {
  test('sets exitCode 1 and prints the report when existing work is found', () => {
    const execGit = makeWorktreeExecGit('worktree /repo/.worktrees/pr99-fix\nbranch refs/heads/v1.1/phase-08-onboarding\n', '/repo');
    const execTool = () => ({ ...PASSTHROUGH, stdout: '[]' });
    let written = '';
    const write = (s) => { written += s; };
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    cmdPhasePreflight('/repo', ['08'], { execGit, execTool, write });
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;
    assert.strictEqual(exitCode, 1);
    const parsed = JSON.parse(written);
    assert.strictEqual(parsed.verdict, 'existing_work_found');
  });

  test('sets exitCode 0 when nothing is found', () => {
    const execGit = makeWorktreeExecGit('worktree /repo\nbranch refs/heads/develop\n', '/repo');
    const execTool = () => ({ ...PASSTHROUGH, stdout: '[]' });
    let written = '';
    const write = (s) => { written += s; };
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    cmdPhasePreflight('/repo', ['09'], { execGit, execTool, write });
    const exitCode = process.exitCode;
    process.exitCode = originalExitCode;
    assert.strictEqual(exitCode, 0);
    const parsed = JSON.parse(written);
    assert.strictEqual(parsed.verdict, 'safe_to_create');
  });
});
