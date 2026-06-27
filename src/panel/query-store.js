// Per-project query persistence. Each scope (worktree root) gets its own
// localStorage key, so switching projects preserves each project's last
// query without leaking across projects.
//
// Settings (case mode, globs, etc.) are global — they live in a separate
// storage key in main.js. This module is intentionally narrow: just
// save/load the search input.

const QUERY_STORAGE_PREFIX = 'fast-find-query-v1:';

/**
 * Normalize a scope path for use as a localStorage key. Strips trailing
 * slashes (so `/repo` and `/repo/` produce the same key) and returns
 * `null` for falsy inputs. Preserves the root `/` unchanged.
 *
 * @param {string|null|undefined} scope
 * @returns {string|null}
 */
export function normalizeScope(scope) {
  if (!scope || scope === '/') return scope || null;
  return scope.replace(/\/+$/, '');
}

/**
 * Build the localStorage key for a given scope.
 *
 * @param {string|null|undefined} scope
 * @returns {string}
 */
export function queryStorageKey(scope) {
  const normalized = normalizeScope(scope);
  return QUERY_STORAGE_PREFIX + (normalized || '<none>');
}

/**
 * Load the saved query for a scope. Returns '' if no query is stored
 * or if the scope is falsy. Errors (e.g. localStorage disabled in
 * private mode) are swallowed and return ''.
 *
 * @param {string|null|undefined} scope
 * @returns {string}
 */
export function loadQueryForScope(scope) {
  if (!scope) return '';
  try {
    return localStorage.getItem(queryStorageKey(scope)) || '';
  } catch {
    return '';
  }
}

/**
 * Save a query for a scope. No-op if scope is falsy. Errors (quota
 * exceeded, private mode) are swallowed — persistence is best-effort.
 *
 * @param {string} query
 * @param {string|null|undefined} scope
 * @returns {void}
 */
export function saveQueryForScope(query, scope) {
  if (!scope) return;
  try {
    localStorage.setItem(queryStorageKey(scope), query || '');
  } catch {
    // best-effort
  }
}
