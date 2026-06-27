// Pure formatting + path helpers extracted from `main.js` so the UI module
// can stay focused on DOM + event wiring. No DOM access, no I/O, no
// closures over runtime state — every function here takes its inputs
// explicitly and returns a value, which is what makes them directly
// testable in plain Node.

import { MAX_COLUMNS } from './rg-args.js';

/**
 * Strip a leading `scope + '/'` prefix from `filePath`. Returns the
 * original path unchanged when:
 *   - filePath is falsy
 *   - scope is missing/null
 *   - filePath is not actually under scope (avoids prefix collisions like
 *     `/repo2` vs `/repo` — both share `/repo` as a prefix but only the
 *     first is a child of the second).
 *
 * @param {string} filePath
 * @param {string|null|undefined} scope
 * @returns {string}
 */
export function relativizePath(filePath, scope) {
  if (!filePath) return filePath;
  if (!scope) return filePath;
  if (filePath.startsWith(scope + '/')) return filePath.slice(scope.length + 1);
  return filePath;
}

/**
 * Build an absolute path from a (possibly relative) `filePath` and a `scope`.
 * Pure function — no I/O, no path normalization beyond the join.
 *
 * Rules (in order):
 *   - Falsy `filePath` → return as-is (preserves null/empty contract)
 *   - Already absolute (starts with '/' on POSIX) → return as-is
 *   - No `scope` → return as-is (caller's problem; we can't help)
 *   - Otherwise → return `${scope}/${filePath}` (forward-slash join;
 *     rg output and Muxy paths are POSIX-style even on Windows)
 *
 * Inverse of `relativizePath`: that one strips the scope prefix, this one
 * adds it back. They are paired for the "rg with cwd=scope" pattern.
 *
 * @param {string} filePath
 * @param {string|null|undefined} scope
 * @returns {string}
 */
export function absolutizePath(filePath, scope) {
  if (!filePath) return filePath;
  if (typeof filePath !== 'string') return filePath;
  if (filePath.startsWith('/')) return filePath;
  if (!scope) return filePath;
  return `${scope}/${filePath}`;
}

/**
 * Format a millisecond count as a compact human string for the status
 * chip. Sub-second values render as "50ms" (rounded), larger ones as
 * "1.5s" with one decimal — anything finer is noise on a search status
 * line.
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatTime(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Pluralize "match" / "matches" for the search-summary chip. Single
 * source of truth so the UI copy stays consistent.
 *
 * @param {number} n
 * @returns {string}
 */
export function formatCount(n) {
  return `${n} match${n === 1 ? '' : 'es'}`;
}

/**
 * Same shape, different noun — files for the search-summary chip.
 *
 * @param {number} n
 * @returns {string}
 */
export function formatFileCount(n) {
  return `${n} file${n === 1 ? '' : 's'}`;
}

/**
 * Decide whether a matched line should show the truncation hint. We use
 * `>=` (not `===`) deliberately: a 200-char line is suspiciously round
 * and a 201+ char one is definitely clipped. False positives are cheap
 * (just an italic hint); false negatives would hide real truncation.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isTruncated(text) {
  if (typeof text !== 'string') return false;
  return text.length >= MAX_COLUMNS;
}
