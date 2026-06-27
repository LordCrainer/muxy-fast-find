// Phase 5: scoring/utils test suite. Covers the pure helpers extracted
// from main.js into utils.js (relativizePath, formatTime, formatCount,
// isTruncated). These are the formatting + path utilities that the
// status chip and result rows depend on; getting them right keeps the
// UI copy consistent across all the rendering sites.
//
// Usage: node tests/test-scoring.mjs

import assert from 'node:assert/strict';
import { MAX_COLUMNS } from '../src/panel/rg-args.js';
import {
  relativizePath,
  absolutizePath,
  formatTime,
  formatCount,
  formatFileCount,
  isTruncated,
} from '../src/panel/utils.js';

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

console.log('test-scoring');

// === relativizePath ========================================================

test('relativizePath strips scope prefix', () => {
  assert.equal(relativizePath('/repo/src/foo.ts', '/repo'), 'src/foo.ts');
});

test('relativizePath does not strip partial match', () => {
  // /repo2 must NOT be stripped from /repo2/src even when scope is /repo.
  // This is the prefix-collision guard that string-slice alone wouldn't give.
  assert.equal(relativizePath('/repo2/src/foo.ts', '/repo'), '/repo2/src/foo.ts');
});

test('relativizePath returns full path if no scope', () => {
  assert.equal(relativizePath('/repo/src/foo.ts', null), '/repo/src/foo.ts');
});

test('relativizePath returns full path if scope is empty string', () => {
  assert.equal(relativizePath('/repo/src/foo.ts', ''), '/repo/src/foo.ts');
});

test('relativizePath returns full path if file not under scope', () => {
  assert.equal(relativizePath('/other/foo.ts', '/repo'), '/other/foo.ts');
});

test('relativizePath: scope == filePath returns the path unchanged', () => {
  // Edge case: the matched file IS the scope root (no trailing slash,
  // nothing under it). The function only strips `scope + '/'`, so the
  // path comes back unchanged. That's correct — there's nothing
  // "under" the scope here to relativize.
  assert.equal(relativizePath('/repo', '/repo'), '/repo');
});

test('relativizePath: empty filePath returns empty', () => {
  assert.equal(relativizePath('', '/repo'), '');
});

test('relativizePath: null filePath returns null', () => {
  assert.equal(relativizePath(null, '/repo'), null);
});

// === formatTime ============================================================

test('formatTime formats sub-second', () => {
  assert.equal(formatTime(50), '50ms');
});

test('formatTime: 0ms is 0ms', () => {
  assert.equal(formatTime(0), '0ms');
});

test('formatTime: 999ms is rounded to 999ms', () => {
  assert.equal(formatTime(999), '999ms');
});

test('formatTime formats seconds at the boundary', () => {
  // 1000ms flips from the "ms" branch into the "s" branch.
  assert.equal(formatTime(1000), '1.0s');
});

test('formatTime: 1500ms is 1.5s', () => {
  assert.equal(formatTime(1500), '1.5s');
});

test('formatTime: 12_500ms is 12.5s', () => {
  assert.equal(formatTime(12500), '12.5s');
});

test('formatTime: garbage input returns empty string', () => {
  assert.equal(formatTime('nope'), '');
  assert.equal(formatTime(NaN), '');
  assert.equal(formatTime(-1), '');
});

// === formatCount / formatFileCount ==========================================

test('formatCount singular', () => {
  assert.equal(formatCount(1), '1 match');
});

test('formatCount plural (zero)', () => {
  // English convention: 0 takes the plural form.
  assert.equal(formatCount(0), '0 matches');
});

test('formatCount plural (many)', () => {
  assert.equal(formatCount(47), '47 matches');
});

test('formatFileCount singular', () => {
  assert.equal(formatFileCount(1), '1 file');
});

test('formatFileCount plural', () => {
  assert.equal(formatFileCount(3), '3 files');
});

// === isTruncated ===========================================================

test('isTruncated returns true at or above maxColumns', () => {
  assert.equal(isTruncated('a'.repeat(MAX_COLUMNS)), true);
});

test('isTruncated returns false below maxColumns', () => {
  assert.equal(isTruncated('a'.repeat(MAX_COLUMNS - 1)), false);
});

test('isTruncated handles empty string', () => {
  assert.equal(isTruncated(''), false);
});

test('isTruncated returns false for non-string input', () => {
  // Defensive: a malformed match event could leave text undefined.
  assert.equal(isTruncated(undefined), false);
  assert.equal(isTruncated(null), false);
  assert.equal(isTruncated(42), false);
});

// === additional helpers ====================================================

test('formatCount: 2 is plural', () => {
  // Off-by-one guard: only n === 1 takes the singular form.
  assert.equal(formatCount(2), '2 matches');
});

test('formatCount: large numbers are plural', () => {
  assert.equal(formatCount(2000), '2000 matches');
});

test('formatFileCount: 2 is plural', () => {
  assert.equal(formatFileCount(2), '2 files');
});

test('formatFileCount: 0 is plural (English convention)', () => {
  assert.equal(formatFileCount(0), '0 files');
});

test('formatTime: 60_000ms is 60.0s', () => {
  assert.equal(formatTime(60_000), '60.0s');
});

test('formatTime: 999.4 rounds to 999ms (Math.round behavior)', () => {
  // Math.round(999.4) = 999 — confirms the rounding direction.
  assert.equal(formatTime(999.4), '999ms');
});

test('formatTime: 999.5 rounds to 1000ms (banker-style boundary)', () => {
  // Math.round(999.5) = 1000 in JS (rounds half to even for negatives
  // but rounds up for positives). Just pin the actual behavior so a
  // future refactor doesn't change it accidentally.
  assert.equal(formatTime(999.5), '1000ms');
});

test('isTruncated at exactly MAX_COLUMNS + 1', () => {
  // Pin the >= (not ===) check at the upper edge.
  assert.equal(isTruncated('a'.repeat(MAX_COLUMNS + 1)), true);
});

test('isTruncated at MAX_COLUMNS - 1: NOT truncated', () => {
  assert.equal(isTruncated('a'.repeat(MAX_COLUMNS - 1)), false);
});

test('relativizePath: scope with trailing slash is NOT stripped', () => {
  // The function builds `scope + '/'` — if the caller already supplies
  // a trailing slash, we'd get `scope + '//'` and nothing would match.
  // This pins the documented contract: callers pass a clean scope.
  assert.equal(relativizePath('/repo/src/foo.ts', '/repo/'), '/repo/src/foo.ts');
});

// === absolutizePath ========================================================
// Inverse of relativizePath. rg runs with cwd=state.scope, so match.path
// in the JSON output is relative. Before handing the path to Muxy's
// `files` extension (which needs absolute paths), we re-join it.

test('absolutizePath joins scope + relative path', () => {
  assert.equal(absolutizePath('src/auth/login.ts', '/repo'), '/repo/src/auth/login.ts');
});

test('absolutizePath leaves already-absolute paths unchanged', () => {
  // Defensive: if rg ever returns an absolute path (symlinks, weird
  // config), we don't want to double-prefix it.
  assert.equal(absolutizePath('/already/abs.ts', '/repo'), '/already/abs.ts');
});

test('absolutizePath returns path unchanged when scope is null', () => {
  assert.equal(absolutizePath('src/file.ts', null), 'src/file.ts');
});

test('absolutizePath returns path unchanged when scope is undefined', () => {
  assert.equal(absolutizePath('src/file.ts', undefined), 'src/file.ts');
});

test('absolutizePath returns path unchanged when scope is empty string', () => {
  // Empty scope == falsy == "caller's problem, we can't help".
  assert.equal(absolutizePath('src/file.ts', ''), 'src/file.ts');
});

test('absolutizePath: empty filePath returns empty', () => {
  assert.equal(absolutizePath('', '/repo'), '');
});

test('absolutizePath: null filePath returns null', () => {
  assert.equal(absolutizePath(null, '/repo'), null);
});

test('absolutizePath: undefined filePath returns undefined', () => {
  assert.equal(absolutizePath(undefined, '/repo'), undefined);
});

test('absolutizePath: non-string filePath is returned as-is', () => {
  // The function guards against bad input rather than coercing —
  // mirrors the defensive shape of isTruncated / formatTime.
  assert.equal(absolutizePath(123, '/repo'), 123);
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
