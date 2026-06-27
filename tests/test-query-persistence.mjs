// Phase 5: query persistence test suite. Covers the helpers in
// `query-store.js` — the per-scope localStorage save/load that
// remembers each project's last search input. The functions are
// pure except for the localStorage read/write, which we mock with
// an in-memory Map at the top of the file (Node has no native
// localStorage).
//
// Usage: node tests/test-query-persistence.mjs

import assert from 'node:assert/strict';
import {
  normalizeScope,
  queryStorageKey,
  loadQueryForScope,
  saveQueryForScope,
} from '../src/panel/query-store.js';

// Mock localStorage for Node (it doesn't exist natively).
const _store = new Map();
globalThis.localStorage = {
  getItem(k) { return _store.has(k) ? _store.get(k) : null; },
  setItem(k, v) { _store.set(k, String(v)); },
  removeItem(k) { _store.delete(k); },
  clear() { _store.clear(); },
};

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

console.log('test-query-persistence');

// === normalizeScope ========================================================
// The key normalizer. Two responsibilities:
//   1. Reject falsy inputs (return null so queryStorageKey can fall
//      through to the '<none>' sentinel).
//   2. Strip trailing slashes so '/repo' and '/repo/' collide on the
//      same localStorage key.

test('normalizeScope: null returns null', () => {
  assert.equal(normalizeScope(null), null);
});

test('normalizeScope: undefined returns null', () => {
  assert.equal(normalizeScope(undefined), null);
});

test('normalizeScope: empty string returns null', () => {
  assert.equal(normalizeScope(''), null);
});

test('normalizeScope: /repo returns /repo', () => {
  assert.equal(normalizeScope('/repo'), '/repo');
});

test('normalizeScope: /repo/ returns /repo', () => {
  assert.equal(normalizeScope('/repo/'), '/repo');
});

test('normalizeScope: /repo/// returns /repo', () => {
  assert.equal(normalizeScope('/repo///'), '/repo');
});

test('normalizeScope: / returns /', () => {
  // Root is a valid scope on its own and must NOT collapse to ''.
  assert.equal(normalizeScope('/'), '/');
});

// === queryStorageKey =======================================================

test('queryStorageKey: /repo produces fast-find-query-v1:/repo', () => {
  assert.equal(queryStorageKey('/repo'), 'fast-find-query-v1:/repo');
});

test('queryStorageKey: /repo/ produces same key as /repo', () => {
  // The trailing-slash normalize is the whole point — both inputs
  // must collide on the same localStorage entry.
  assert.equal(queryStorageKey('/repo/'), 'fast-find-query-v1:/repo');
});

test('queryStorageKey: null produces fast-find-query-v1:<none>', () => {
  // The '<none>' sentinel lets us key an "unscoped" entry without
  // the string 'null' or 'undefined' leaking into the storage.
  assert.equal(queryStorageKey(null), 'fast-find-query-v1:<none>');
});

// === loadQueryForScope =====================================================

test('loadQueryForScope: null scope returns empty string', () => {
  assert.equal(loadQueryForScope(null), '');
});

test('loadQueryForScope: /repo with a stored value returns it', () => {
  _store.set('fast-find-query-v1:/repo', 'auth');
  assert.equal(loadQueryForScope('/repo'), 'auth');
});

test('loadQueryForScope: /repo with no stored value returns empty string', () => {
  _store.delete('fast-find-query-v1:/repo');
  assert.equal(loadQueryForScope('/repo'), '');
});

// === saveQueryForScope =====================================================

test('saveQueryForScope: stores the query for the scope', () => {
  _store.clear();
  saveQueryForScope('login', '/repo');
  assert.equal(_store.get('fast-find-query-v1:/repo'), 'login');
});

test('saveQueryForScope: null scope is a no-op', () => {
  _store.clear();
  saveQueryForScope('login', null);
  assert.equal(_store.size, 0, 'no key should be written for null scope');
});

test('saveQueryForScope: localStorage throw is swallowed', () => {
  // Simulate quota-exceeded / private mode by replacing setItem with
  // a throwing function. The helper must NOT propagate the throw —
  // persistence is best-effort.
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    ...original,
    setItem() { throw new Error('QuotaExceededError'); },
  };
  try {
    // Should not throw.
    saveQueryForScope('foo', '/repo');
  } finally {
    globalThis.localStorage = original;
  }
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
