// Pure parser for `rg --json` output. Consumes the full stdout (one JSON
// object per line) and returns a flat match list plus run-level stats.
// No I/O, no muxy API references — this file is testable in plain Node.

/**
 * @typedef {Object} Submatch
 * @property {string} match
 * @property {number} start — 0-indexed char offset within the line text
 * @property {number} end — 0-indexed char offset (exclusive)
 *
 * @typedef {Object} Match
 * @property {string} path
 * @property {number} line — 1-indexed
 * @property {number} column — 1-indexed column of the first submatch
 * @property {string} text — line content, no trailing newline
 * @property {Submatch[]} submatches
 *
 * @typedef {Object} ParseStats
 * @property {number|null} durationMs — wall time from rg's summary
 * @property {number|null} filesCount — files_with_matches from summary
 *
 * @typedef {Object} ParseResult
 * @property {Match[]} matches
 * @property {ParseStats} stats
 */

/**
 * Parse the full stdout of `rg --json` into a flat match list plus stats.
 *
 * Rules:
 * - Non-match event types (begin/end/context/search-started/etc.) are
 *   skipped silently — they're informational.
 * - The trailing `\n` is stripped from `lines.text` if present.
 * - Malformed lines are skipped defensively (rg never produces them, but
 *   truncated output or a mid-run kill could leave dangling bytes).
 * - Binary files produce no `match` events, so they're handled by the
 *   natural "no match" path — nothing extra to do here.
 *
 * @param {string} text
 * @returns {ParseResult}
 */
export function parseBuffer(text) {
  const matches = [];
  const stats = { durationMs: null, filesCount: null };

  if (!text) return { matches, stats };

  for (const raw of text.split('\n')) {
    if (!raw) continue;

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      // Malformed line — rg shouldn't emit any, but a partial buffer from
      // a killed process might. Skip rather than throw.
      continue;
    }

    if (event.type === 'match') {
      const m = toMatch(event.data);
      if (m) matches.push(m);
    } else if (event.type === 'summary') {
      captureSummaryStats(event.data, stats);
    }
    // Everything else is informational: begin, end, context, search-* …
    // intentionally ignored.
  }

  return { matches, stats };
}

/**
 * Convert one `match` event's `data` payload to our flat shape.
 * Returns null if the payload is missing required fields.
 *
 * @param {*} data
 * @returns {Match|null}
 */
function toMatch(data) {
  if (!data) return null;

  const path = data.path && typeof data.path.text === 'string' ? data.path.text : null;
  const line = typeof data.line_number === 'number' ? data.line_number : null;
  const rawText = data.lines && typeof data.lines.text === 'string' ? data.lines.text : null;

  if (path === null || line === null || rawText === null) return null;

  // rg always appends a newline to `lines.text` for non-final lines; the
  // final line may omit it. Strip whichever form we got.
  const text = rawText.endsWith('\n') ? rawText.slice(0, -1) : rawText;

  const rawSubmatches = Array.isArray(data.submatches) ? data.submatches : [];
  const submatches = [];
  for (const s of rawSubmatches) {
    if (!s || !s.match || typeof s.match.text !== 'string') continue;
    submatches.push({ match: s.match.text, start: s.start, end: s.end });
  }

  // Column is 1-indexed. If there are no submatches (shouldn't happen for
  // a match event, but be defensive), default to 1.
  const column = submatches.length > 0 ? submatches[0].start + 1 : 1;

  return { path, line, column, text, submatches };
}

/**
 * Extract `durationMs` and `filesCount` from the `summary` event. Mutates
 * the passed-in stats object in place.
 *
 * The rg JSON event shape has `elapsed_total` as a sibling of `stats`
 * inside `data` — not nested under `data.stats`. Both fields are pulled
 * from the same object for consistency with rg's actual output.
 *
 * @param {*} data
 * @param {ParseStats} stats
 */
function captureSummaryStats(data, stats) {
  if (!data) return;

  // Duration: prefer `nanos` (precise) over `secs` (float). Either form
  // is fine — convert to milliseconds.
  if (data.elapsed_total) {
    if (typeof data.elapsed_total.nanos === 'number') {
      stats.durationMs = data.elapsed_total.nanos / 1_000_000;
    } else if (typeof data.elapsed_total.secs === 'number') {
      stats.durationMs = data.elapsed_total.secs * 1000;
    }
  }

  // `files_with_matches` is the only counter that lives under `data.stats`
  // in rg's summary payload.
  if (data.stats && typeof data.stats.files_with_matches === 'number') {
    stats.filesCount = data.stats.files_with_matches;
  }
}
