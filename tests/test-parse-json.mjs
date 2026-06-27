// Phase 5: parse-json test suite. Line-buffered parser for `rg --json`
// output. Covers every event type (match / summary / informational),
// plus malformed input, multi-match lines, and trailing-newline stripping.
//
// Usage: node tests/test-parse-json.mjs

import assert from 'node:assert/strict';
import { parseBuffer } from '../src/panel/parse-json.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    failures.push({ name, error: e });
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

// Tiny factory so every test starts from the same event-shape helpers.
// `path` / `line` / `text` are the only fields the parser reads for matches;
// the rest is dropped (and verified to be dropped) by the column/text
// assertions below.
function matchEvent({ path, line, text, start = 0, end = 1 }) {
  return JSON.stringify({
    type: 'match',
    data: {
      path: { text: path },
      lines: { text },
      line_number: line,
      submatches: [{ match: { text: 'x' }, start, end }],
    },
  });
}

console.log('test-parse-json');

// === empty / no-op ==========================================================

test('empty input → empty matches', () => {
  const r = parseBuffer('');
  assert.deepEqual(r.matches, []);
  assert.equal(r.stats.durationMs, null);
  assert.equal(r.stats.filesCount, null);
});

test('whitespace-only input → empty matches', () => {
  const r = parseBuffer('\n\n\n');
  assert.deepEqual(r.matches, []);
});

// === single match ===========================================================

test('single match event: path, line, column, text, submatches', () => {
  const line = matchEvent({
    path: 'src/foo.ts',
    line: 42,
    text: 'function bar() {',
    start: 9,
    end: 12,
  });
  const r = parseBuffer(line);
  assert.equal(r.matches.length, 1);
  const m = r.matches[0];
  assert.equal(m.path, 'src/foo.ts');
  assert.equal(m.line, 42);
  assert.equal(m.column, 10); // start (9) + 1 — 1-indexed
  assert.equal(m.text, 'function bar() {');
  assert.equal(m.submatches.length, 1);
  assert.equal(m.submatches[0].match, 'x');
  assert.equal(m.submatches[0].start, 9);
  assert.equal(m.submatches[0].end, 12);
});

test('strips trailing \\n from line text', () => {
  // rg appends \n to every non-final line; the final line may omit it.
  // Both forms must yield the same `text` (no trailing newline).
  const r = parseBuffer(matchEvent({ path: 'a', line: 1, text: 'hello\n' }));
  assert.equal(r.matches[0].text, 'hello');
});

test('preserves text when no trailing \\n', () => {
  const r = parseBuffer(matchEvent({ path: 'a', line: 1, text: 'hello' }));
  assert.equal(r.matches[0].text, 'hello');
});

test('column defaults to 1 when no submatches', () => {
  // Should never happen for a real match event, but be defensive.
  const ev = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'a' },
      lines: { text: 'x' },
      line_number: 1,
      submatches: [],
    },
  });
  const r = parseBuffer(ev);
  assert.equal(r.matches[0].column, 1);
});

// === informational events ===================================================

test('begin/end events are ignored', () => {
  const input = [
    JSON.stringify({ type: 'begin', data: { path: { text: 'a' } } }),
    JSON.stringify({ type: 'end', data: { path: { text: 'a' } } }),
  ].join('\n');
  const r = parseBuffer(input);
  assert.deepEqual(r.matches, []);
});

test('summary event is ignored for matches but captures stats', () => {
  const input = [
    JSON.stringify({
      type: 'summary',
      data: { elapsed_total: { human: '1ms', nanos: 1000000, secs: 0.001 } },
    }),
  ].join('\n');
  const r = parseBuffer(input);
  assert.deepEqual(r.matches, []);
  assert.equal(r.stats.durationMs, 1);
});

// === malformed input ========================================================

test('malformed lines are skipped', () => {
  const input = [
    'not json',
    matchEvent({ path: 'a', line: 1, text: 'x' }),
    '{broken',
  ].join('\n');
  const r = parseBuffer(input);
  // Only the middle line parses; the other two are dropped silently.
  assert.equal(r.matches.length, 1);
  assert.equal(r.matches[0].path, 'a');
});

test('truncated buffer (no trailing newline) is still parsed', () => {
  // The parser splits on \n — a final non-newline-terminated line still
  // gets its own element. The `if (!raw) continue` guard at the top is
  // what prevents the leading empty element from throwing.
  const r = parseBuffer(matchEvent({ path: 'a', line: 1, text: 'x' }));
  assert.equal(r.matches.length, 1);
});

// === multi-match ============================================================

test('multiple matches preserve order', () => {
  const input = [
    matchEvent({ path: 'a', line: 1, text: 'x' }),
    matchEvent({ path: 'b', line: 2, text: 'x' }),
    matchEvent({ path: 'a', line: 5, text: 'x' }),
  ].join('\n');
  const r = parseBuffer(input);
  assert.equal(r.matches.length, 3);
  assert.equal(r.matches[0].path, 'a');
  assert.equal(r.matches[1].path, 'b');
  assert.equal(r.matches[2].line, 5);
});

// === summary stats capture =================================================

test('summary stats captured from nanos', () => {
  const input = JSON.stringify({
    type: 'summary',
    data: { elapsed_total: { human: '50ms', nanos: 50000000, secs: 0.05 } },
  });
  const r = parseBuffer(input);
  assert.equal(r.stats.durationMs, 50);
});

test('summary stats captured from secs (fallback)', () => {
  // No `nanos` key — parser must fall back to `secs`.
  const input = JSON.stringify({
    type: 'summary',
    data: { elapsed_total: { human: '2s', secs: 2.0 } },
  });
  const r = parseBuffer(input);
  assert.equal(r.stats.durationMs, 2000);
});

test('summary captures filesCount from data.stats.files_with_matches', () => {
  const input = JSON.stringify({
    type: 'summary',
    data: {
      elapsed_total: { nanos: 1_000_000 },
      stats: { files_with_matches: 7 },
    },
  });
  const r = parseBuffer(input);
  assert.equal(r.stats.filesCount, 7);
  assert.equal(r.stats.durationMs, 1);
});

// === additional defensive branches =========================================

test('match event with multiple submatches preserves all of them', () => {
  // A real rg event can have several submatches per line (one per
  // match of the pattern). The parser must keep them all.
  const ev = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'a.ts' },
      lines: { text: 'foo bar foo' },
      line_number: 5,
      submatches: [
        { match: { text: 'foo' }, start: 0, end: 3 },
        { match: { text: 'bar' }, start: 4, end: 7 },
        { match: { text: 'foo' }, start: 8, end: 11 },
      ],
    },
  });
  const r = parseBuffer(ev);
  assert.equal(r.matches[0].submatches.length, 3);
  // Column is 1-indexed and based on the FIRST submatch.
  assert.equal(r.matches[0].column, 1);
});

test('match event with missing path is dropped silently', () => {
  // Defensive: a partial buffer or weird rg version could omit fields.
  // The parser must not throw, just skip the line.
  const ev = JSON.stringify({
    type: 'match',
    data: { lines: { text: 'x' }, line_number: 1, submatches: [] },
  });
  const r = parseBuffer(ev);
  assert.equal(r.matches.length, 0);
});

test('match event with missing line_number is dropped silently', () => {
  const ev = JSON.stringify({
    type: 'match',
    data: { path: { text: 'a' }, lines: { text: 'x' }, submatches: [] },
  });
  const r = parseBuffer(ev);
  assert.equal(r.matches.length, 0);
});

test('match event with missing lines is dropped silently', () => {
  const ev = JSON.stringify({
    type: 'match',
    data: { path: { text: 'a' }, line_number: 1, submatches: [] },
  });
  const r = parseBuffer(ev);
  assert.equal(r.matches.length, 0);
});

test('match event with no submatches array uses empty array', () => {
  // Shouldn't happen in real rg, but the parser must be defensive.
  const ev = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'a' },
      lines: { text: 'x' },
      line_number: 1,
    },
  });
  const r = parseBuffer(ev);
  assert.equal(r.matches.length, 1);
  assert.deepEqual(r.matches[0].submatches, []);
});

test('context event (informational) is ignored', () => {
  // rg emits `context` events for lines surrounding a match (when
  // -C/--context is passed). They're informational and the parser
  // must skip them — only `match` events become result rows.
  const ev = JSON.stringify({
    type: 'context',
    data: {
      path: { text: 'a' },
      lines: { text: 'ctx' },
      line_number: 1,
    },
  });
  const r = parseBuffer(ev);
  assert.equal(r.matches.length, 0);
});

test('search-started event (informational) is ignored', () => {
  const ev = JSON.stringify({
    type: 'search-started',
    data: { path: { text: 'a' } },
  });
  const r = parseBuffer(ev);
  assert.equal(r.matches.length, 0);
});

test('unknown event type is ignored', () => {
  // Future rg versions may add new event types; the parser must skip
  // anything it doesn't recognize rather than throwing.
  const ev = JSON.stringify({ type: 'future-thing', data: {} });
  const r = parseBuffer(ev);
  assert.equal(r.matches.length, 0);
});

test('summary with no elapsed_total leaves durationMs as null', () => {
  const ev = JSON.stringify({
    type: 'summary',
    data: { stats: { files_with_matches: 3 } },
  });
  const r = parseBuffer(ev);
  assert.equal(r.stats.durationMs, null);
  assert.equal(r.stats.filesCount, 3);
});

test('summary with empty data leaves stats as null', () => {
  // Defensive: a malformed summary event should not crash.
  const ev = JSON.stringify({ type: 'summary', data: {} });
  const r = parseBuffer(ev);
  assert.equal(r.stats.durationMs, null);
  assert.equal(r.stats.filesCount, null);
});

test('mix of valid + malformed + informational lines', () => {
  const input = [
    'not json',
    JSON.stringify({ type: 'begin', data: { path: { text: 'a' } } }),
    matchEvent({ path: 'a', line: 1, text: 'x' }),
    '{broken',
    JSON.stringify({ type: 'end', data: { path: { text: 'a' } } }),
    matchEvent({ path: 'b', line: 2, text: 'y' }),
    JSON.stringify({ type: 'context', data: { path: { text: 'a' }, lines: { text: 'c' }, line_number: 0 } }),
  ].join('\n');
  const r = parseBuffer(input);
  // Two matches survived; the begin/end/context lines are informational
  // and the two malformed lines were silently dropped.
  assert.equal(r.matches.length, 2);
  assert.equal(r.matches[0].path, 'a');
  assert.equal(r.matches[1].path, 'b');
});

// === Summary ===============================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error.message}`);
  }
  process.exit(1);
}
