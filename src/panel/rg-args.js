// Pure argv builder for ripgrep. No I/O, no exceptions beyond the explicit
// "query required" guard. Returned arrays feed directly to muxy.exec as
// separate elements — no shell joining happens here.

/**
 * @typedef {Object} BuildArgvOpts
 * @property {string} query — The search pattern (required, non-empty)
 * @property {string|null} [scope] — Directory to search; appended as the
 *   last positional so rg treats it as the path argument
 * @property {'sensitive'|'insensitive'} [caseMode='sensitive']
 * @property {'regex'|'literal'} [regexMode='regex']
 * @property {string[]} [includeGlobs] — Each entry becomes a `-g <glob>` pair
 * @property {boolean} [noIgnore=false] — When true, adds `-uu` (ripgrep's
 *   "no ignore files + no .ignore + hidden" flag). The spec deliberately
 *   uses `-uu` rather than `--no-ignore` for a stronger, more predictable
 *   traversal.
 * @property {boolean} [hidden=false] — Adds `--hidden`
 * @property {string} [rgPath='rg'] — Binary to invoke; Phase 3 will pass
 *   the resolved path from `which rg`
 * @property {string} [rgVersion] — semver "X.Y.Z" string from
 *   `rg-install.detectRg`. When provided AND the major is ≥ 13, adds
 *   `--no-follow` to prevent symlink cycles from blowing up the
 *   traversal. Undefined → no flag (older rg would reject it).
 *
 * Note: `--max-columns` and `--max-count` are intentionally NOT exposed
 * in v1 — they're pinned in `RG_DEFAULT_FLAGS` so the anti-regression
 * test can assert EXACT argv (`--max-columns=200`, `--max-count=2000`).
 * Phase 3 settings UI toggles hidden / noIgnore / caseMode / regexMode /
 * includeGlobs only.
 */

/**
 * Maximum line length rg will emit before truncating with `…`. Exposed as
 * a constant so the UI's truncation-indicator heuristic (in `main.js`)
 * can use the same number as a single source of truth. Changing this
 * value here automatically updates both the rg flag and the UI check.
 */
export const MAX_COLUMNS = 200;

/**
 * The baseline flag set every `buildArgv()` call starts from. Exposed for
 * tests and for documentation. Order is significant: the parser keys on
 * JSON output, so the leading `--json` / `--no-messages` flags must stay
 * first.
 */
export const RG_DEFAULT_FLAGS = [
  '--json',
  '--no-config',
  '--no-messages',
  `--max-columns=${MAX_COLUMNS}`,
  '--max-count=2000',
];

/**
 * Build a ripgrep argv array suitable for muxy.exec. Pure: same input →
 * same output, no hidden state, no I/O.
 *
 * @param {BuildArgvOpts} opts
 * @returns {string[]}
 */
export function buildArgv(opts) {
  // Guard clause: a missing/empty query is the only "can't recover" state.
  if (!opts || !opts.query) {
    throw new Error('query required');
  }

  const {
    query,
    scope = null,
    caseMode = 'sensitive',
    regexMode = 'regex',
    includeGlobs = null,
    noIgnore = false,
    hidden = false,
    rgPath = 'rg',
    rgVersion = null,
  } = opts;

  const argv = [rgPath, ...RG_DEFAULT_FLAGS];

  // Mutators of the default set — all append-only, in a fixed order so
  // tests can predict the resulting array.
  if (hidden) argv.push('--hidden');
  if (noIgnore) argv.push('-uu');
  if (caseMode === 'insensitive') argv.push('-i');
  if (regexMode === 'literal') argv.push('-F');

  // Symlink paranoia. `--no-follow` was added in rg 13.0 (rg uses
  // `--no-follow`, not `--follow=false` — passing `--follow=false`
  // is rejected with "invalid CLI arguments"). On older versions rg
  // would reject the flag with an error. Only add it when we know
  // the version supports it. This prevents pathological symlink
  // cycles (common in monorepos with node_modules) from turning a
  // 50ms search into a 30s one.
  if (rgVersion) {
    const major = parseInt(rgVersion.split('.')[0], 10);
    if (Number.isFinite(major) && major >= 13) {
      argv.push('--no-follow');
    }
  }

  if (includeGlobs) {
    for (const glob of includeGlobs) {
      argv.push('-g', glob);
    }
  }

  // A query that starts with `-` would be parsed by rg as a flag, not a
  // pattern. Inserting `--` is the documented way to tell rg "end of flags,
  // everything else is positional". This is the single most important
  // safety net in this module.
  if (query.startsWith('-')) argv.push('--');
  argv.push(query);

  // Scope is rg's last positional — the path to search.
  if (scope) argv.push(scope);

  return argv;
}
