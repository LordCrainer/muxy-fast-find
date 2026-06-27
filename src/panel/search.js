import { buildArgv } from './rg-args.js';
import { parseBuffer } from './parse-json.js';

/**
 * @typedef {Object} RunSearchOpts
 * @property {string} query — required
 * @property {string|null} [scope] — explicit search root; if null, we
 *   resolve from worktrees / git.repoInfo
 * @property {string} [rgPath='rg'] — binary to invoke
 * @property {string} [rgVersion] — semver "X.Y.Z" string; passed
 *   through to `buildArgv` so it can decide whether to add
 *   `--no-follow` (only for rg ≥ 13)
 * @property {number} [querySeq] — snapshot of the caller's sequence
 *   counter at the moment this call started
 * @property {() => number} [getCurrentSeq] — returns the caller's CURRENT
 *   sequence value. If it differs from `querySeq`, a newer search has
 *   started and this call should abort.
 * @property {() => void} [onStale] — optional callback invoked when
 *   staleness is detected (for logging / debugging)
 * @property {'sensitive'|'insensitive'} [caseMode]
 * @property {'regex'|'literal'} [regexMode]
 * @property {string[]} [includeGlobs]
 * @property {boolean} [noIgnore]
 * @property {boolean} [hidden]
 *
 * @typedef {Object} SearchResult
 * @property {boolean} aborted
 * @property {Match[]} [matches]
 * @property {(ParseStats & { scope: string })} [stats]
 * @property {string} [error] — 'no-scope' | 'invalid-query' | 'exec-failed' | 'rg-error' | 'unknown'
 * @property {string} [message]
 */

/**
 * Resolve the search root from a worktrees list. Prefers an "active" worktree
 * across the three naming variants muxy has shipped, then falls back to the
 * first entry. Returns null if nothing usable is found.
 *
 * @param {Array<{isActive?: boolean, isCurrent?: boolean, active?: boolean, path?: string}>} list
 * @returns {string|null}
 */
function pickActiveWorktree(list) {
  if (!list || list.length === 0) return null;
  return (
    list.find((wt) => wt && wt.isActive) ||
    list.find((wt) => wt && wt.isCurrent) ||
    list.find((wt) => wt && wt.active) ||
    list[0] ||
    null
  )?.path || null;
}

/**
 * Read the worktrees list defensively. Returns null if the API is missing
 * or throws — we don't want a missing worktrees list to crash the search.
 *
 * @param {Object} muxy
 * @returns {Promise<Array|null>}
 */
async function safeWorktrees(muxy) {
  try {
    const fn = muxy && muxy.worktrees && muxy.worktrees.list;
    if (typeof fn !== 'function') return null;
    const result = await fn();
    return Array.isArray(result) ? result : null;
  } catch {
    return null;
  }
}

/**
 * Read repoInfo defensively. Returns null on absence or error.
 *
 * @param {Object} muxy
 * @returns {Promise<{root?: string}|null>}
 */
async function safeRepoInfo(muxy) {
  try {
    const fn = muxy && muxy.git && muxy.git.repoInfo;
    if (typeof fn !== 'function') return null;
    const result = await fn();
    return result || null;
  } catch {
    return null;
  }
}

/**
 * Run a ripgrep search end-to-end: resolve scope, build argv, exec, parse.
 * Aborts cleanly when a newer search supersedes this one.
 *
 * Uses the mock-muxy pattern from ai-history: tests pass an object with
 * `exec`, `worktrees.list`, `git.repoInfo`. No separate `deps` parameter.
 *
 * @param {Object} muxy
 * @param {RunSearchOpts} opts
 * @returns {Promise<SearchResult>}
 */
export async function runSearch(muxy, opts) {
  // Staleness scaffolding. `mySeq` is frozen for this call; `getCurrent()`
  // reads the caller's live counter. Mismatch = a newer search has started.
  const mySeq = opts && typeof opts.querySeq === 'number' ? opts.querySeq : 0;
  const getCurrent =
    opts && typeof opts.getCurrentSeq === 'function' ? opts.getCurrentSeq : () => mySeq;
  const onStale = opts && typeof opts.onStale === 'function' ? opts.onStale : null;

  const isStale = () => mySeq !== getCurrent();

  // Guard: no query is a hard error — the UI should never call us without
  // one, but if it does, fail fast. Reported as `invalid-query` (not
  // `exec-failed`) because it's a validation problem, not an exec
  // rejection — callers can branch on the code without inspecting the
  // message.
  if (!opts || !opts.query) {
    return { aborted: false, error: 'invalid-query', message: 'query required' };
  }

  // --- 1. Resolve scope -------------------------------------------------
  let scope = opts.scope || null;

  if (!scope) {
    const worktrees = await safeWorktrees(muxy);
    if (isStale()) {
      if (onStale) onStale(getCurrent());
      return { aborted: true };
    }
    if (worktrees) scope = pickActiveWorktree(worktrees);
  }

  if (!scope) {
    const repoInfo = await safeRepoInfo(muxy);
    if (isStale()) {
      if (onStale) onStale(getCurrent());
      return { aborted: true };
    }
    if (repoInfo && repoInfo.root) scope = repoInfo.root;
  }

  if (!scope) {
    return { aborted: false, error: 'no-scope', message: 'No worktree detected' };
  }

  // --- 2. Build argv ----------------------------------------------------
  const argv = buildArgv({
    query: opts.query,
    scope,
    caseMode: opts.caseMode,
    regexMode: opts.regexMode,
    includeGlobs: opts.includeGlobs,
    noIgnore: opts.noIgnore,
    hidden: opts.hidden,
    rgPath: opts.rgPath,
    rgVersion: opts.rgVersion,
  });

  // --- 3. Exec ----------------------------------------------------------
  // Muxy's exec takes the full command as an array, opts as the second arg.
  // Sync-vs-async is handled by `await`; thrown errors are caught below.
  let result;
  try {
    result = await muxy.exec(argv, { cwd: scope });
  } catch (err) {
    return {
      aborted: false,
      error: 'exec-failed',
      message: (err && err.message) || String(err),
    };
  }

  if (isStale()) {
    if (onStale) onStale(getCurrent());
    return { aborted: true };
  }

  if (!result) {
    return { aborted: false, error: 'exec-failed', message: 'no result from muxy.exec' };
  }

  // --- 4. Handle exit codes --------------------------------------------
  // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
  const exitCode = typeof result.exitCode === 'number'
    ? result.exitCode
    : typeof result.exit_code === 'number'
      ? result.exit_code
      : 0;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';

  if (exitCode === 2) {
    return { aborted: false, error: 'rg-error', message: stderr.slice(0, 200) };
  }
  if (exitCode !== 0 && exitCode !== 1) {
    return { aborted: false, error: 'unknown', message: `rg exit ${exitCode}` };
  }

  // --- 5. Parse ---------------------------------------------------------
  const parsed = parseBuffer(stdout);
  return {
    aborted: false,
    matches: parsed.matches,
    stats: { ...parsed.stats, scope },
  };
}
