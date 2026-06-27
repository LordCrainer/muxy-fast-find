/**
 * Tagged logging helpers for fast-find.
 *
 * Every log line is prefixed with `[fastFind]` so it can be grep'd in
 * Muxy's extension log without colliding with other panels' output. We
 * route by level to the matching `console.*` method so a host like Muxy
 * that filters by `console.error` / `console.warn` / `console.info` for
 * severity still gets a useful signal.
 *
 * The helpers are deliberately small — they don't add buffering, tags,
 * or any other feature that would tempt callers to depend on them for
 * control flow. The point is observability, not logging infrastructure.
 */

const TAG = '[fastFind]';

/**
 * Build the prefixed argument list we hand to the console method. The
 * `level` is inlined after the tag so a single grep (e.g.
 * `grep "\[fastFind\] error"`) catches all errors without needing
 * separate regexes per `console.*` method.
 *
 * @param {string} level
 * @param {Array<unknown>} args
 * @returns {Array<unknown>}
 */
function format(level, args) {
  return [TAG, level, ...args];
}

/**
 * Emit a tagged log at the given severity. The level string is kept in
 * the output (not replaced by the console method) so the `[fastFind]`
 * tag and the severity stay adjacent and easy to scan.
 *
 * @param {'debug'|'info'|'warn'|'error'} level
 * @param {...unknown} args
 */
export function olog(level, ...args) {
  // Map the level string to the matching console method. Falling
  // through to `console.debug` for unknown levels is intentional —
  // it's the quietest option, so a typo like `olog('warnin')` won't
  // suddenly start yelling.
  const method =
    level === 'error' ? console.error
      : level === 'warn' ? console.warn
      : level === 'info' ? console.info
      : console.debug;
  method(...format(level, args));
}

/**
 * Shorthand for `olog('warn', ...)`.
 *
 * @param {...unknown} args
 */
export function owarn(...args) {
  olog('warn', ...args);
}

/**
 * Shorthand for `olog('error', ...)`.
 *
 * @param {...unknown} args
 */
export function oerror(...args) {
  olog('error', ...args);
}

/**
 * Shorthand for `olog('info', ...)`.
 *
 * @param {...unknown} args
 */
export function oinfo(...args) {
  olog('info', ...args);
}
