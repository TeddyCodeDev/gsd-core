/**
 * Dependent-phase branch stacking — resolves whether a new phase branch should
 * fork from an unmerged dependency's own branch instead of the project's
 * default branch, so a phase's `execute` step can actually contain its
 * dependency's code before that dependency's PR merges.
 *
 * Motivating incident (2026-09-04, a GSD consumer project's v1.1 Phase 9.2):
 * Phase 9.1 was fully executed and verified (ROADMAP.md checkbox checked,
 * `deps_satisfied` true) but its PR had not yet merged into `develop`. Phase
 * 9.2's branch was forked from `origin/develop` per execute-phase's
 * `handle_branching` step (`#2916`'s fork-from-default-only rule), so it
 * never received Phase 9.1's wizard-shell source and halted on its own
 * precondition check. `deps_satisfied` being checkbox- rather than
 * merge-based is not the bug — tightening it would block `discuss`/`plan`
 * concurrency that doesn't need the dependency's code present at all. The gap
 * is narrower: nothing made a dependent phase's branch actually contain its
 * dependency's code before that dependency merged. See
 * `.plans/dependent-phase-branch-stacking.md` for the full design and open
 * questions this module answers a subset of.
 *
 * Deliberately conservative: only stacks when exactly one dependency phase
 * resolves to exactly one branch that is (a) pushed to `origin` and (b) not
 * yet merged into the default branch. Any ambiguity — no match, multiple
 * unmerged dependencies, an unpushed branch — returns `stackBase: null` so
 * the caller falls back to its existing `origin/<default>` behavior. This
 * module never invents a fork point that isn't a freshly-verified `origin/*`
 * ref, preserving `#2916`'s guarantee that a phase branch is never based on
 * local, possibly-stale HEAD.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execGit as execGitSeam } from './shell-command-projection.cjs';
import { findMatchingWorktrees, normalizePhaseNumber } from './phase-preflight.cjs';
import roadmapParser = require('./roadmap-parser.cjs');
import phaseId = require('./phase-id.cjs');

const { PHASE_NUMBER_TOKEN_SOURCE } = phaseId;
const { getRoadmapPhaseInternal } = roadmapParser;

type ExecGitFn = typeof execGitSeam;

export interface BranchStackingDeps {
  execGit?: ExecGitFn;
  readFile?: (p: string) => string | null;
  writeFile?: (p: string, content: string) => void;
}

export interface StackBaseResult {
  ok: boolean;
  phase: string | null;
  dependencyPhases: string[];
  stackBase: string | null;
  dependencyBranch: string | null;
  dependencySha: string | null;
  reason: string | null;
}

export interface RecordedStackBase {
  phase: string;
  dependency_branch: string;
  dependency_sha: string;
  recorded_at: string;
}

/**
 * Reads this phase's `**Depends on:**` field from `ROADMAP.md` and returns the
 * referenced phase numbers, normalized to `phase-preflight`'s zero-padded form
 * (the form branch names and `findMatchingWorktrees` expect). Returns `[]` on
 * any missing section, missing field, "None", or parse failure — never throws;
 * a preflight-adjacent check that can crash the caller defeats its purpose.
 */
export function readDependencyPhaseNumbers(cwd: string, phaseNumber: string): string[] {
  try {
    const roadmapPhase = getRoadmapPhaseInternal(cwd, phaseNumber);
    const section = roadmapPhase?.section;
    if (!section) return [];
    const dependsMatch = section.match(/\*\*Depends on(?::\*\*|\*\*:)\s*([^\n]+)/i);
    if (!dependsMatch) return [];
    const raw = dependsMatch[1].trim();
    if (!raw || /^none$/i.test(raw)) return [];
    const tokens = raw.match(new RegExp(PHASE_NUMBER_TOKEN_SOURCE, 'gi')) || [];
    return [...new Set(tokens.map((t) => normalizePhaseNumber(t)))];
  } catch {
    return [];
  }
}

/**
 * Is `branch` pushed to `origin`? Fetches first (best-effort — a fetch failure
 * doesn't short-circuit, the verify step below is what actually decides) so a
 * stale local remote-tracking ref can't produce a false positive. Fails closed
 * to `false` (never eligible to stack on) on any git error or timeout.
 */
export function isBranchPushedToOrigin(cwd: string, branch: string, deps: BranchStackingDeps = {}): boolean {
  const execGit = deps.execGit ?? execGitSeam;
  execGit(['fetch', '--quiet', 'origin', branch], { cwd });
  const result = execGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], { cwd });
  return !result.timedOut && result.exitCode === 0;
}

/**
 * Is `origin/<branch>` already an ancestor of `origin/<defaultBranch>` — i.e.
 * already merged, so stacking on it would be pointless (today's
 * `origin/<default>` path already has its content)? Fails closed to `true`
 * (treat as "already merged, don't stack") on any git error or an
 * indeterminate exit code, since that's the direction that falls back to
 * `handle_branching`'s existing, proven-safe behavior rather than fabricating
 * a stack base from an unverified relationship.
 */
export function isBranchMergedIntoDefault(cwd: string, branch: string, defaultBranch: string, deps: BranchStackingDeps = {}): boolean {
  const execGit = deps.execGit ?? execGitSeam;
  const result = execGit(['merge-base', '--is-ancestor', `origin/${branch}`, `origin/${defaultBranch}`], { cwd });
  if (result.timedOut) return true;
  // git merge-base --is-ancestor: exit 0 = is an ancestor (merged), 1 = is not.
  // Any other exit code means the relationship couldn't be determined (e.g. a
  // missing ref) — fail closed to "merged" rather than stack on an unverified ref.
  return result.exitCode !== 1;
}

/**
 * Resolves the single eligible unmerged-dependency branch to stack a new
 * phase branch on, if any. Reads `dep_phases` from `ROADMAP.md` itself
 * (self-sufficient, matching `checkPhaseWorktree`'s style) rather than
 * requiring the caller to pre-parse and pass it.
 */
export function resolveStackBase(
  cwd: string,
  phaseNumber: string,
  defaultBranch: string,
  deps: BranchStackingDeps = {},
): StackBaseResult {
  const phase = normalizePhaseNumber(phaseNumber);
  const dependencyPhases = readDependencyPhaseNumbers(cwd, phase);

  const noStack = (reason: string): StackBaseResult => ({
    ok: true,
    phase,
    dependencyPhases,
    stackBase: null,
    dependencyBranch: null,
    dependencySha: null,
    reason,
  });

  if (dependencyPhases.length === 0) return noStack('no_dependencies');

  const execGit = deps.execGit ?? execGitSeam;
  const eligible: Array<{ branch: string; sha: string }> = [];

  for (const depPhase of dependencyPhases) {
    const worktrees = findMatchingWorktrees(cwd, depPhase, deps);
    const branchNames = [...new Set(worktrees.map((w) => w.branch))];
    for (const branch of branchNames) {
      if (!isBranchPushedToOrigin(cwd, branch, deps)) continue;
      if (isBranchMergedIntoDefault(cwd, branch, defaultBranch, deps)) continue;
      const shaResult = execGit(['rev-parse', `origin/${branch}`], { cwd });
      const sha = !shaResult.timedOut && shaResult.exitCode === 0 ? shaResult.stdout.trim() : null;
      if (sha) eligible.push({ branch, sha });
    }
  }

  if (eligible.length === 0) return noStack('all_dependencies_merged_or_unavailable');
  if (eligible.length > 1) return noStack('multiple_unmerged_dependencies_ambiguous');

  const { branch, sha } = eligible[0];
  return {
    ok: true,
    phase,
    dependencyPhases,
    stackBase: `origin/${branch}`,
    dependencyBranch: branch,
    dependencySha: sha,
    reason: null,
  };
}

const STACK_BASE_FILENAME = '.stack-base.json';

function stackBasePath(cwd: string): string {
  return join(cwd, '.planning', STACK_BASE_FILENAME);
}

/**
 * Records which branch/sha a phase branch was stacked on, so a later
 * reconciliation check (not built by this module — see the design doc's
 * "what this does not fix") can detect "this stack base has since merged,
 * refresh `develop` into this branch now" without re-deriving it via
 * commit-graph archaeology. Best-effort: a failed write here must never block
 * the branch creation it's documenting.
 */
export function recordStackBase(
  cwd: string,
  phase: string,
  dependencyBranch: string,
  dependencySha: string,
  deps: BranchStackingDeps = {},
): void {
  const writeFile = deps.writeFile ?? ((p: string, content: string) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  });
  try {
    const record: RecordedStackBase = {
      phase,
      dependency_branch: dependencyBranch,
      dependency_sha: dependencySha,
      recorded_at: new Date().toISOString(),
    };
    writeFile(stackBasePath(cwd), `${JSON.stringify(record, null, 2)}\n`);
  } catch {
    // best-effort — see docstring
  }
}

/** Reads a previously recorded stack base for the current checkout, or `null` if none/unreadable. */
export function readStackBase(cwd: string, deps: BranchStackingDeps = {}): RecordedStackBase | null {
  const readFile = deps.readFile ?? ((p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });
  const content = readFile(stackBasePath(cwd));
  if (!content) return null;
  try {
    return JSON.parse(content) as RecordedStackBase;
  } catch {
    return null;
  }
}

/** CLI entrypoint: `gsd-tools query worktree stack-base <phase> <defaultBranch>`. */
export function cmdStackBase(
  cwd: string,
  args: string[] = [],
  deps: BranchStackingDeps & { write?: (s: string) => void } = {},
): StackBaseResult {
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const positional = args.filter((a) => !a.startsWith('--'));
  const phaseArg = positional[0] ?? '';
  const defaultBranchArg = positional[1] ?? 'main';
  const result = resolveStackBase(cwd, phaseArg, defaultBranchArg, deps);
  write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** CLI entrypoint: `gsd-tools query worktree record-stack-base <phase> <dependencyBranch> <dependencySha>`. */
export function cmdRecordStackBase(
  cwd: string,
  args: string[] = [],
  deps: BranchStackingDeps & { write?: (s: string) => void } = {},
): void {
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const positional = args.filter((a) => !a.startsWith('--'));
  const [phaseArg, dependencyBranchArg, dependencyShaArg] = positional;
  if (!phaseArg || !dependencyBranchArg || !dependencyShaArg) {
    write(`${JSON.stringify({ ok: false, reason: 'missing_arguments' }, null, 2)}\n`);
    return;
  }
  recordStackBase(cwd, phaseArg, dependencyBranchArg, dependencyShaArg, deps);
  write(`${JSON.stringify({ ok: true }, null, 2)}\n`);
}
