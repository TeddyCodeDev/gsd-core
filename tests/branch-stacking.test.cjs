'use strict';

/**
 * Branch Stacking Module — unit tests
 *
 * Seam: gsd-core/bin/lib/branch-stacking.cjs
 * Interface: readDependencyPhaseNumbers, isBranchPushedToOrigin,
 *            isBranchMergedIntoDefault, resolveStackBase, recordStackBase,
 *            readStackBase, cmdStackBase, cmdRecordStackBase
 *
 * All git-level tests use dependency injection (inline execGit stubs) — no
 * real git process is exercised. `readDependencyPhaseNumbers`/`resolveStackBase`
 * tests that need `ROADMAP.md` content use a real temp directory (matching
 * roadmap-parser.test.cjs's own convention for getRoadmapPhaseInternal, which
 * this module calls directly and does not inject).
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const { createTempProject, cleanup } = require('./helpers.cjs');

const MODULE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'branch-stacking.cjs'
);

const {
  readDependencyPhaseNumbers,
  isBranchPushedToOrigin,
  isBranchMergedIntoDefault,
  resolveStackBase,
  recordStackBase,
  readStackBase,
  cmdStackBase,
  cmdRecordStackBase,
} = require(MODULE_PATH);

const PASSTHROUGH = Object.freeze({ exitCode: 0, stdout: '', stderr: '', signal: null, error: null, timedOut: false });

function writeRoadmap(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

// ─── readDependencyPhaseNumbers ─────────────────────────────────────────────

describe('readDependencyPhaseNumbers', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns [] when ROADMAP.md is missing', () => {
    fs.rmSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), { force: true });
    assert.deepStrictEqual(readDependencyPhaseNumbers(tmpDir, '2'), []);
  });

  test('extracts a single dependency phase, zero-padded', () => {
    writeRoadmap(tmpDir, [
      '## v1.0: Current',
      '### Phase 2: Steps',
      '**Goal:** do things',
      '**Depends on:** Phase 9',
    ].join('\n'));
    assert.deepStrictEqual(readDependencyPhaseNumbers(tmpDir, '2'), ['09']);
  });

  test('preserves a decimal sub-phase dependency', () => {
    writeRoadmap(tmpDir, [
      '### Phase 9.2: MVF Core',
      '**Goal:** g',
      '**Depends on:** Phase 9.1',
    ].join('\n'));
    assert.deepStrictEqual(readDependencyPhaseNumbers(tmpDir, '9.2'), ['09.1']);
  });

  test('returns [] for "None"', () => {
    writeRoadmap(tmpDir, [
      '### Phase 1: Foundation',
      '**Goal:** g',
      '**Depends on:** None',
    ].join('\n'));
    assert.deepStrictEqual(readDependencyPhaseNumbers(tmpDir, '1'), []);
  });

  test('returns [] when the phase has no Depends on field at all', () => {
    writeRoadmap(tmpDir, [
      '### Phase 1: Foundation',
      '**Goal:** g',
    ].join('\n'));
    assert.deepStrictEqual(readDependencyPhaseNumbers(tmpDir, '1'), []);
  });

  test('extracts and dedupes multiple dependency phases', () => {
    writeRoadmap(tmpDir, [
      '### Phase 3: Foo',
      '**Goal:** g',
      '**Depends on:** Phase 1, Phase 2 and Phase 1 again',
    ].join('\n'));
    assert.deepStrictEqual(readDependencyPhaseNumbers(tmpDir, '3'), ['01', '02']);
  });

  test('returns [] when the phase itself is not found in ROADMAP.md', () => {
    writeRoadmap(tmpDir, '### Phase 1: Foundation\n**Goal:** g\n');
    assert.deepStrictEqual(readDependencyPhaseNumbers(tmpDir, '99'), []);
  });
});

// ─── isBranchPushedToOrigin ──────────────────────────────────────────────────

describe('isBranchPushedToOrigin', () => {
  test('true when the remote-tracking ref verifies after fetch', () => {
    const execGit = (args) => {
      if (args[0] === 'fetch') return { ...PASSTHROUGH };
      if (args[0] === 'rev-parse') return { ...PASSTHROUGH, exitCode: 0 };
      return { ...PASSTHROUGH };
    };
    assert.strictEqual(isBranchPushedToOrigin('/repo', 'v1.1/phase-09.1-x', { execGit }), true);
  });

  test('false when the remote-tracking ref does not verify', () => {
    const execGit = (args) => {
      if (args[0] === 'rev-parse') return { ...PASSTHROUGH, exitCode: 1 };
      return { ...PASSTHROUGH };
    };
    assert.strictEqual(isBranchPushedToOrigin('/repo', 'unpushed-branch', { execGit }), false);
  });

  // Counter-test: a fetch failure alone must not short-circuit to false —
  // only the verify step decides, so a stale-but-present remote-tracking ref
  // (fetch blocked by network, ref already known locally) still counts.
  test('a failed fetch does not by itself make the branch look unpushed', () => {
    const execGit = (args) => {
      if (args[0] === 'fetch') return { ...PASSTHROUGH, exitCode: 1 };
      if (args[0] === 'rev-parse') return { ...PASSTHROUGH, exitCode: 0 };
      return { ...PASSTHROUGH };
    };
    assert.strictEqual(isBranchPushedToOrigin('/repo', 'some-branch', { execGit }), true);
  });

  test('degrades to false on timeout, does not throw', () => {
    const execGit = () => ({ ...PASSTHROUGH, timedOut: true });
    assert.doesNotThrow(() => {
      assert.strictEqual(isBranchPushedToOrigin('/repo', 'x', { execGit }), false);
    });
  });
});

// ─── isBranchMergedIntoDefault ───────────────────────────────────────────────

describe('isBranchMergedIntoDefault', () => {
  test('true (merged) when merge-base --is-ancestor exits 0', () => {
    const execGit = () => ({ ...PASSTHROUGH, exitCode: 0 });
    assert.strictEqual(isBranchMergedIntoDefault('/repo', 'x', 'develop', { execGit }), true);
  });

  test('false (not merged) when merge-base --is-ancestor exits 1', () => {
    const execGit = () => ({ ...PASSTHROUGH, exitCode: 1 });
    assert.strictEqual(isBranchMergedIntoDefault('/repo', 'x', 'develop', { execGit }), false);
  });

  // Fail-closed direction: an indeterminate result must read as "merged" (no
  // stacking) rather than "not merged" (would fabricate a stack base from an
  // unverified relationship).
  test('fails closed to true (merged) on an indeterminate exit code', () => {
    const execGit = () => ({ ...PASSTHROUGH, exitCode: 128 });
    assert.strictEqual(isBranchMergedIntoDefault('/repo', 'x', 'develop', { execGit }), true);
  });

  test('fails closed to true (merged) on timeout', () => {
    const execGit = () => ({ ...PASSTHROUGH, timedOut: true });
    assert.strictEqual(isBranchMergedIntoDefault('/repo', 'x', 'develop', { execGit }), true);
  });
});

// ─── resolveStackBase ────────────────────────────────────────────────────────

describe('resolveStackBase', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  const WORKTREE_LIST = [
    'worktree /repo',
    'branch refs/heads/develop',
    '',
    'worktree /repo/.worktrees/phase-091',
    'branch refs/heads/v1.1/phase-09.1-wizard-shell',
    '',
  ].join('\n');

  function makeExecGit({ mergedIntoDefault = false, pushed = true } = {}) {
    return (args) => {
      if (args[0] === 'worktree') return { ...PASSTHROUGH, stdout: WORKTREE_LIST };
      if (args[0] === 'log') return { ...PASSTHROUGH, stdout: '2026-09-04T00:00:00-06:00' };
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ...PASSTHROUGH, stdout: tmpDir };
      if (args[0] === 'fetch') return { ...PASSTHROUGH };
      if (args[0] === 'rev-parse' && args.includes('--verify')) {
        return pushed ? { ...PASSTHROUGH, exitCode: 0 } : { ...PASSTHROUGH, exitCode: 1 };
      }
      if (args[0] === 'merge-base') {
        return mergedIntoDefault ? { ...PASSTHROUGH, exitCode: 0 } : { ...PASSTHROUGH, exitCode: 1 };
      }
      if (args[0] === 'rev-parse') return { ...PASSTHROUGH, stdout: 'c8951135deadbeefc8951135deadbeefc8951135' };
      return { ...PASSTHROUGH };
    };
  }

  test('returns no-stack with reason no_dependencies when the phase has none', () => {
    writeRoadmap(tmpDir, '### Phase 9.2: MVF Core\n**Goal:** g\n');
    const result = resolveStackBase(tmpDir, '9.2', 'develop', { execGit: makeExecGit() });
    assert.strictEqual(result.stackBase, null);
    assert.strictEqual(result.reason, 'no_dependencies');
    assert.deepStrictEqual(result.dependencyPhases, []);
  });

  test('resolves the single unmerged pushed dependency branch as the stack base', () => {
    writeRoadmap(tmpDir, [
      '### Phase 9.2: MVF Core',
      '**Goal:** g',
      '**Depends on:** Phase 9.1',
    ].join('\n'));
    const result = resolveStackBase(tmpDir, '9.2', 'develop', { execGit: makeExecGit({ mergedIntoDefault: false, pushed: true }) });
    assert.strictEqual(result.stackBase, 'origin/v1.1/phase-09.1-wizard-shell');
    assert.strictEqual(result.dependencyBranch, 'v1.1/phase-09.1-wizard-shell');
    assert.strictEqual(result.dependencySha, 'c8951135deadbeefc8951135deadbeefc8951135');
    assert.strictEqual(result.reason, null);
  });

  test('falls back to no-stack when the dependency branch is already merged', () => {
    writeRoadmap(tmpDir, [
      '### Phase 9.2: MVF Core',
      '**Goal:** g',
      '**Depends on:** Phase 9.1',
    ].join('\n'));
    const result = resolveStackBase(tmpDir, '9.2', 'develop', { execGit: makeExecGit({ mergedIntoDefault: true, pushed: true }) });
    assert.strictEqual(result.stackBase, null);
    assert.strictEqual(result.reason, 'all_dependencies_merged_or_unavailable');
  });

  test('falls back to no-stack when the dependency branch is not pushed to origin', () => {
    writeRoadmap(tmpDir, [
      '### Phase 9.2: MVF Core',
      '**Goal:** g',
      '**Depends on:** Phase 9.1',
    ].join('\n'));
    const result = resolveStackBase(tmpDir, '9.2', 'develop', { execGit: makeExecGit({ mergedIntoDefault: false, pushed: false }) });
    assert.strictEqual(result.stackBase, null);
    assert.strictEqual(result.reason, 'all_dependencies_merged_or_unavailable');
  });

  test('falls back to no-stack, ambiguous, when more than one unmerged dependency branch is eligible', () => {
    writeRoadmap(tmpDir, [
      '### Phase 3: Foo',
      '**Goal:** g',
      '**Depends on:** Phase 1, Phase 2',
    ].join('\n'));
    const twoWorktrees = [
      'worktree /repo',
      'branch refs/heads/develop',
      '',
      'worktree /repo/.worktrees/p1',
      'branch refs/heads/v1/phase-01-a',
      '',
      'worktree /repo/.worktrees/p2',
      'branch refs/heads/v1/phase-02-b',
      '',
    ].join('\n');
    const execGit = (args) => {
      if (args[0] === 'worktree') return { ...PASSTHROUGH, stdout: twoWorktrees };
      if (args[0] === 'log') return { ...PASSTHROUGH, stdout: '2026-09-04T00:00:00-06:00' };
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ...PASSTHROUGH, stdout: tmpDir };
      if (args[0] === 'fetch') return { ...PASSTHROUGH };
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { ...PASSTHROUGH, exitCode: 0 };
      if (args[0] === 'merge-base') return { ...PASSTHROUGH, exitCode: 1 };
      if (args[0] === 'rev-parse') return { ...PASSTHROUGH, stdout: 'abc' };
      return { ...PASSTHROUGH };
    };
    const result = resolveStackBase(tmpDir, '3', 'develop', { execGit });
    assert.strictEqual(result.stackBase, null);
    assert.strictEqual(result.reason, 'multiple_unmerged_dependencies_ambiguous');
  });

  // Regression: a whole-number dependency ("09") that has already merged (no
  // branch of its own left) must not be confused for "ambiguous" just because
  // several of its sub-phases ("09.1", "09.2", ...) still have open branches —
  // a sub-phase branch is never that whole-number phase's own branch.
  test('a merged whole-number dependency is not confused with its still-open sub-phase branches', () => {
    writeRoadmap(tmpDir, [
      '### Phase 09.1: Wizard Shell',
      '**Goal:** g',
      '**Depends on:** Phase 09',
    ].join('\n'));
    const subPhaseWorktrees = [
      'worktree /repo',
      'branch refs/heads/develop',
      '',
      'worktree /repo/.worktrees/p91',
      'branch refs/heads/v1.1/phase-09.1-wizard-shell',
      '',
      'worktree /repo/.worktrees/p92',
      'branch refs/heads/v1.1/phase-09.2-mvf-core',
      '',
    ].join('\n');
    const execGit = (args) => {
      if (args[0] === 'worktree') return { ...PASSTHROUGH, stdout: subPhaseWorktrees };
      if (args[0] === 'log') return { ...PASSTHROUGH, stdout: '2026-09-04T00:00:00-06:00' };
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { ...PASSTHROUGH, stdout: tmpDir };
      // These stubs would prove eligible if the sub-phase branches were
      // (wrongly) treated as phase 09's own branch — the test only passes if
      // resolveStackBase never gets far enough to call them for either branch.
      if (args[0] === 'fetch') return { ...PASSTHROUGH };
      if (args[0] === 'rev-parse' && args.includes('--verify')) return { ...PASSTHROUGH, exitCode: 0 };
      if (args[0] === 'merge-base') return { ...PASSTHROUGH, exitCode: 1 };
      return { ...PASSTHROUGH };
    };
    const result = resolveStackBase(tmpDir, '09.1', 'develop', { execGit });
    assert.strictEqual(result.stackBase, null);
    assert.strictEqual(result.reason, 'all_dependencies_merged_or_unavailable');
  });

  test('never throws when git fails outright', () => {
    writeRoadmap(tmpDir, [
      '### Phase 9.2: MVF Core',
      '**Goal:** g',
      '**Depends on:** Phase 9.1',
    ].join('\n'));
    const execGit = () => ({ ...PASSTHROUGH, exitCode: 128, stderr: 'fatal: not a git repository' });
    assert.doesNotThrow(() => {
      const result = resolveStackBase(tmpDir, '9.2', 'develop', { execGit });
      assert.strictEqual(result.stackBase, null);
    });
  });
});

// ─── recordStackBase / readStackBase ─────────────────────────────────────────

describe('recordStackBase / readStackBase', () => {
  test('round-trips through an injected in-memory store', () => {
    const store = new Map();
    const writeFile = (p, content) => store.set(p, content);
    const readFile = (p) => (store.has(p) ? store.get(p) : null);

    recordStackBase('/repo', '09.2', 'v1.1/phase-09.1-x', 'deadbeef', { writeFile });
    const result = readStackBase('/repo', { readFile });

    assert.strictEqual(result.phase, '09.2');
    assert.strictEqual(result.dependency_branch, 'v1.1/phase-09.1-x');
    assert.strictEqual(result.dependency_sha, 'deadbeef');
    assert.match(result.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('readStackBase returns null when nothing has been recorded', () => {
    const readFile = () => null;
    assert.strictEqual(readStackBase('/repo', { readFile }), null);
  });

  test('readStackBase returns null on unparseable content rather than throwing', () => {
    const readFile = () => 'not json';
    assert.doesNotThrow(() => {
      assert.strictEqual(readStackBase('/repo', { readFile }), null);
    });
  });

  test('recordStackBase does not throw when the write itself fails', () => {
    const writeFile = () => { throw new Error('disk full'); };
    assert.doesNotThrow(() => {
      recordStackBase('/repo', '09.2', 'x', 'y', { writeFile });
    });
  });
});

// ─── cmdStackBase / cmdRecordStackBase (CLI entrypoints) ────────────────────

describe('cmdStackBase', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('writes the resolved JSON result to stdout', () => {
    writeRoadmap(tmpDir, '### Phase 9.2: MVF Core\n**Goal:** g\n');
    let written = '';
    const write = (s) => { written += s; };
    const execGit = () => ({ ...PASSTHROUGH });
    cmdStackBase(tmpDir, ['9.2', 'develop'], { execGit, write });
    const parsed = JSON.parse(written);
    assert.strictEqual(parsed.reason, 'no_dependencies');
  });

  test('defaults the default-branch argument to "main" when omitted', () => {
    writeRoadmap(tmpDir, '### Phase 1: Foo\n**Goal:** g\n');
    let written = '';
    const write = (s) => { written += s; };
    cmdStackBase(tmpDir, ['1'], { execGit: () => ({ ...PASSTHROUGH }), write });
    const parsed = JSON.parse(written);
    assert.strictEqual(parsed.phase, '01');
  });
});

describe('cmdRecordStackBase', () => {
  test('records and reports ok:true when all arguments are present', () => {
    const store = new Map();
    let written = '';
    cmdRecordStackBase('/repo', ['09.2', 'v1.1/phase-09.1-x', 'deadbeef'], {
      writeFile: (p, c) => store.set(p, c),
      write: (s) => { written += s; },
    });
    assert.deepStrictEqual(JSON.parse(written), { ok: true });
    assert.strictEqual(store.size, 1);
  });

  test('reports ok:false and does not write when an argument is missing', () => {
    const store = new Map();
    let written = '';
    cmdRecordStackBase('/repo', ['09.2', 'v1.1/phase-09.1-x'], {
      writeFile: (p, c) => store.set(p, c),
      write: (s) => { written += s; },
    });
    assert.deepStrictEqual(JSON.parse(written), { ok: false, reason: 'missing_arguments' });
    assert.strictEqual(store.size, 0);
  });
});
