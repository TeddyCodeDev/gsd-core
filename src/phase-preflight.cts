/**
 * Phase preflight check — detects phase work that already exists somewhere other
 * than the current checkout (a git worktree on a matching branch, or an open GitHub
 * PR with a matching head branch) before an orchestrator dispatches a fresh executor.
 *
 * Motivating incident (2026-08-11, a GSD consumer project's v1.1 Phase 8): a session
 * running the manager workflow from the project's main checkout had no way to know a
 * phase was already fully built on an open PR in a separate worktree, driven by a
 * different session. It re-executed the phase from scratch, producing a functionally
 * identical duplicate that had to be discarded. `.planning/STATE.md` only reflects
 * what has been committed in the checkout that's reading it — it has no visibility
 * into sibling worktrees or open PRs. This module is the check that would have
 * caught it: run before dispatch, not after.
 *
 * Deliberately narrow: this module answers "does phase N already exist elsewhere?"
 * It does not create, merge, or clean up anything — callers (workflows) decide what
 * to do with the verdict.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execGit as execGitSeam, execTool as execToolSeam } from './shell-command-projection.cjs';

type ExecGitFn = typeof execGitSeam;
type ExecToolFn = typeof execToolSeam;

export interface PhasePreflightDeps {
  execGit?: ExecGitFn;
  execTool?: ExecToolFn;
  readFile?: (p: string) => string | null;
}

export interface MatchingWorktree {
  path: string;
  branch: string;
}

export interface MatchingPullRequest {
  number: number;
  headRefName: string;
  title: string;
  url: string;
  updatedAt: string;
}

export interface PullRequestCheckResult {
  matches: MatchingPullRequest[];
  skipped: boolean;
  skipReason: string | null;
}

export interface PhasePreflightResult {
  ok: boolean;
  phase: string | null;
  reason: string | null;
  matchingWorktrees: MatchingWorktree[];
  matchingPullRequests: MatchingPullRequest[];
  prCheckSkipped: boolean;
  prCheckSkipReason: string | null;
  verdict: 'existing_work_found' | 'safe_to_create' | null;
}

/** Escapes a string for safe interpolation into a RegExp source. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Zero-pads the integer portion of a phase number to two digits, preserving any
 * decimal sub-phase suffix. Accepts "8", "08", "8.1", "08.1" and normalizes all
 * of them to "08" / "08.1" — this repo's phase numbering (and GSD's own
 * `phase_branch_template`) is always two-digit-padded for the integer part.
 */
export function normalizePhaseNumber(raw: string): string {
  const trimmed = (raw || '').trim();
  const dotIndex = trimmed.indexOf('.');
  const intPart = dotIndex === -1 ? trimmed : trimmed.slice(0, dotIndex);
  const fracPart = dotIndex === -1 ? '' : trimmed.slice(dotIndex);
  const asNumber = Number.parseInt(intPart, 10);
  if (!Number.isFinite(asNumber) || asNumber < 0) {
    return trimmed; // not a recognizable phase number — pass through unchanged
  }
  return `${String(asNumber).padStart(2, '0')}${fracPart}`;
}

/**
 * Reads `current_phase` out of `.planning/STATE.md`'s YAML frontmatter, for callers
 * that don't have an explicit phase number to check (e.g. a dashboard refresh).
 * Returns null if the file is missing or the field isn't present — callers must
 * treat that as "cannot resolve a phase," not as any particular phase number.
 */
export function resolveCurrentPhaseFromState(cwd: string, deps: PhasePreflightDeps = {}): string | null {
  const readFile = deps.readFile ?? ((p: string) => {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return null;
    }
  });
  const content = readFile(join(cwd, '.planning', 'STATE.md'));
  if (!content) return null;
  const match = content.match(/^current_phase:\s*"?([0-9]+(?:\.[0-9]+)?)"?\s*$/m);
  return match ? match[1] : null;
}

/**
 * Does this branch name look like it belongs to the given phase? Matches a
 * `phase-{NN}` substring with a non-digit (or end-of-string) boundary immediately
 * after the number, so phase "1" does not false-positive on "phase-10-foo" or
 * "phase-11-bar". Covers both this project's `v{milestone}/phase-{NN}-{slug}`
 * convention and GSD's own `gsd/phase-{NN}-{slug}` template without hard-coding
 * either one.
 */
export function matchesPhaseBranch(branchName: string, phaseNumber: string): boolean {
  if (!branchName || !phaseNumber) return false;
  const pattern = new RegExp(`phase-${escapeRegExp(phaseNumber)}(?:[^0-9]|$)`);
  return pattern.test(branchName);
}

/**
 * Parses `git worktree list --porcelain` output into {path, branch} pairs.
 * Detached-HEAD worktrees (no `branch` line) are omitted — they cannot match a
 * phase branch pattern by definition.
 */
export function parseWorktreeListPorcelain(output: string): MatchingWorktree[] {
  const entries: MatchingWorktree[] = [];
  let currentPath = '';
  let currentBranch = '';
  const flush = (): void => {
    if (currentPath && currentBranch) {
      entries.push({ path: currentPath, branch: currentBranch });
    }
    currentPath = '';
    currentBranch = '';
  };
  for (const line of (output || '').split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      currentPath = line.slice('worktree '.length).trim();
    } else if (line.startsWith('branch ')) {
      currentBranch = line.slice('branch '.length).replace(/^refs\/heads\//, '').trim();
    } else if (line.trim() === '') {
      flush();
    }
  }
  flush();
  return entries;
}

/**
 * Finds local worktrees whose checked-out branch matches the given phase number.
 * Fails closed to an empty list (never throws) on a git error or timeout — a
 * preflight check that can crash the caller is worse than one that silently misses
 * a signal; the PR check and any `ListAgents`-equivalent check are independent
 * signals that can still catch what this one missed.
 *
 * Excludes the CALLER's own checkout from the results (resolved via `git
 * rev-parse --show-toplevel` at `cwd`) — a session legitimately running phase
 * commands from inside the one true worktree for that phase must never see
 * itself reported back as "existing work found elsewhere." Self-exclusion is
 * best-effort: if the toplevel lookup fails, no entry is excluded (degrades to
 * the pre-self-exclusion behavior, never throws).
 */
export function findMatchingWorktrees(cwd: string, phaseNumber: string, deps: PhasePreflightDeps = {}): MatchingWorktree[] {
  const execGit = deps.execGit ?? execGitSeam;
  const result = execGit(['worktree', 'list', '--porcelain'], { cwd });
  if (result.timedOut || result.exitCode !== 0) return [];

  const ownToplevelResult = execGit(['rev-parse', '--show-toplevel'], { cwd });
  const ownToplevel = (!ownToplevelResult.timedOut && ownToplevelResult.exitCode === 0)
    ? posixNormalizePath(ownToplevelResult.stdout.trim())
    : null;

  return parseWorktreeListPorcelain(result.stdout)
    .filter((entry) => matchesPhaseBranch(entry.branch, phaseNumber))
    .filter((entry) => ownToplevel === null || posixNormalizePath(entry.path) !== ownToplevel);
}

/** Normalizes path separators for cross-platform string comparison (Windows `git` emits `\`). */
function posixNormalizePath(p: string): string {
  return (p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * Finds open GitHub PRs whose head branch matches the given phase number, via the
 * `gh` CLI. This is the portable path (works identically under Claude Code, Codex,
 * CI, or a human at a terminal) — a Claude Code caller should prefer
 * `mcp__github__list_pull_requests` per this project's WORKFLOW-018 and treat this
 * as a fallback / cross-check, not the only source of truth.
 *
 * Skips (never fails the overall preflight) when `gh` isn't installed or isn't
 * authenticated — those are environment gaps, not evidence either way about
 * whether the phase has existing work.
 *
 * Bounded to a 5s timeout (well under `execTool`'s 30s default) — this check now
 * also runs synchronously inside `gsd-phase-dispatch-guard.js`'s PreToolUse hook,
 * on every executor dispatch, so a slow or hung `gh` call must degrade quickly
 * rather than stall every dispatch for up to 30s.
 */
export function findMatchingPullRequests(cwd: string, phaseNumber: string, deps: PhasePreflightDeps = {}): PullRequestCheckResult {
  const execTool = deps.execTool ?? execToolSeam;
  const result = execTool('gh', [
    'pr', 'list', '--state', 'open',
    '--json', 'number,headRefName,title,url,updatedAt',
  ], { cwd, timeout: 5000 });

  if (result.exitCode === 127) {
    return { matches: [], skipped: true, skipReason: 'gh_not_installed' };
  }
  if (result.timedOut) {
    return { matches: [], skipped: true, skipReason: 'gh_timeout' };
  }
  if (result.exitCode !== 0) {
    return { matches: [], skipped: true, skipReason: 'gh_error' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout || '[]');
  } catch {
    return { matches: [], skipped: true, skipReason: 'gh_output_unparseable' };
  }
  if (!Array.isArray(parsed)) {
    return { matches: [], skipped: true, skipReason: 'gh_output_unparseable' };
  }

  const asString = (value: unknown): string => typeof value === 'string' ? value : '';
  const asNumber = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const matches = (parsed as Array<Record<string, unknown>>)
    .filter((pr) => matchesPhaseBranch(asString(pr.headRefName), phaseNumber))
    .map((pr) => ({
      number: asNumber(pr.number),
      headRefName: asString(pr.headRefName),
      title: asString(pr.title),
      url: asString(pr.url),
      updatedAt: asString(pr.updatedAt),
    }));

  return { matches, skipped: false, skipReason: null };
}

/**
 * Runs the full preflight check for one phase: resolves the phase number (from the
 * argument or `.planning/STATE.md`), checks local worktrees and open PRs, and
 * returns a verdict. Never throws — a preflight check that can crash the caller
 * defeats its own purpose (better a missed signal than a blocked orchestrator).
 */
export function checkPhaseWorktree(cwd: string, phaseArg: string | null | undefined, deps: PhasePreflightDeps = {}): PhasePreflightResult {
  const resolvedRaw = phaseArg && phaseArg.trim() ? phaseArg.trim() : resolveCurrentPhaseFromState(cwd, deps);
  if (!resolvedRaw) {
    return {
      ok: false,
      phase: null,
      reason: 'phase_unresolved',
      matchingWorktrees: [],
      matchingPullRequests: [],
      prCheckSkipped: true,
      prCheckSkipReason: 'phase_unresolved',
      verdict: null,
    };
  }

  const phaseNumber = normalizePhaseNumber(resolvedRaw);
  const matchingWorktrees = findMatchingWorktrees(cwd, phaseNumber, deps);
  const prResult = findMatchingPullRequests(cwd, phaseNumber, deps);

  const foundAnything = matchingWorktrees.length > 0 || prResult.matches.length > 0;

  return {
    ok: true,
    phase: phaseNumber,
    reason: null,
    matchingWorktrees,
    matchingPullRequests: prResult.matches,
    prCheckSkipped: prResult.skipped,
    prCheckSkipReason: prResult.skipReason,
    verdict: foundAnything ? 'existing_work_found' : 'safe_to_create',
  };
}

/** CLI entrypoint: `gsd-tools query worktree.phase-preflight [phase]`. */
export function cmdPhasePreflight(cwd: string, args: string[] = [], deps: PhasePreflightDeps & { write?: (s: string) => void } = {}): PhasePreflightResult {
  const write = deps.write ?? ((s: string) => process.stdout.write(s));
  const phaseArg = args.find((a) => !a.startsWith('--')) ?? null;
  const result = checkPhaseWorktree(cwd, phaseArg, deps);
  write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.verdict === 'existing_work_found' ? 1 : 0;
  return result;
}
