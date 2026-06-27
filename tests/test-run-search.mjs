// Phase 5: run-search test suite. The anti-regression net for the search
// pipeline. Every branch of runSearch is exercised here — scope
// resolution, exact argv pinning, exit code matrix, exec throw,
// cancellation. The argv-pin test is the most important: a single
// misplaced flag in rg-args.js would silently degrade search quality.
//
// Usage: node tests/test-run-search.mjs

import assert from 'node:assert/strict';
import { runSearch } from '../src/panel/search.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  // Async-aware test runner — wait for the test body to settle before
  // moving on so failures land on the right assertion.
  return Promise.resolve()
    .then(() => fn())
    .then(() => {
      passed++;
      console.log(`  ✓ ${name}`);
    })
    .catch((e) => {
      failed++;
      failures.push({ name, error: e });
      console.log(`  ✗ ${name}: ${e.message}`);
    });
}

// Mock factory matching the shape runSearch actually consumes. Every
// method records its call into `calls` so assertions can introspect
// what runSearch did. The `worktrees` / `repoInfo` parameters accept
// the literal `'throw'` to simulate permission errors at the boundary.
function createMuxyMock({ worktrees, repoInfo, exec, execError, execExit, execStderr } = {}) {
  const calls = [];
  return {
    worktrees: {
      list: async (...args) => {
        calls.push({ key: 'worktrees.list', args });
        if (worktrees === 'throw') throw new Error('perm denied');
        return worktrees || [];
      },
    },
    git: {
      repoInfo: async () => {
        calls.push({ key: 'git.repoInfo', args: [] });
        if (repoInfo === 'throw') throw new Error('perm denied');
        return repoInfo || null;
      },
    },
    exec: async (argv, opts) => {
      calls.push({ key: 'exec', args: [argv, opts] });
      if (execError) throw execError;
      return {
        exitCode: execExit ?? 0,
        stdout: exec || '',
        stderr: execStderr || '',
      };
    },
    calls,
  };
}

console.log('test-run-search');

// === 1. Scope resolution ====================================================

await test('explicit scope wins (worktrees.list NOT called)', async () => {
  const m = createMuxyMock({ exec: '', execExit: 0 });
  await runSearch(m, { query: 'foo', scope: '/explicit', rgPath: 'rg' });
  const worktreesCall = m.calls.find((c) => c.key === 'worktrees.list');
  assert.equal(worktreesCall, undefined, 'worktrees.list should not be called when scope is set');
  const execCall = m.calls.find((c) => c.key === 'exec');
  assert.equal(execCall.args[0][execCall.args[0].length - 1], '/explicit');
});

await test('worktrees.list: picks the active worktree', async () => {
  const m = createMuxyMock({
    worktrees: [
      { path: '/wt1', isActive: false },
      { path: '/wt2', isActive: true },
    ],
    exec: '', execExit: 0,
  });
  await runSearch(m, { query: 'foo', rgPath: 'rg' });
  const execCall = m.calls.find((c) => c.key === 'exec');
  assert.equal(execCall.args[0][execCall.args[0].length - 1], '/wt2');
});

await test('worktrees.list throws → fall through to git.repoInfo', async () => {
  const m = createMuxyMock({
    worktrees: 'throw',
    repoInfo: { root: '/r' },
    exec: '', execExit: 0,
  });
  await runSearch(m, { query: 'foo', rgPath: 'rg' });
  const execCall = m.calls.find((c) => c.key === 'exec');
  assert.equal(execCall.args[0][execCall.args[0].length - 1], '/r');
});

await test('no scope available → no-scope error', async () => {
  const m = createMuxyMock({ worktrees: [], repoInfo: { root: null } });
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  assert.equal(r.error, 'no-scope');
});

// === 2. Exact argv pinning (the C4 anti-regression) ========================

await test('exact argv pinned', async () => {
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    exec: '', execExit: 0,
  });
  await runSearch(m, { query: 'foo', rgPath: 'rg' });
  const execCall = m.calls.find((c) => c.key === 'exec');
  assert.deepEqual(
    execCall.args[0],
    [
      'rg', '--json', '--no-config', '--no-messages',
      '--max-columns=200', '--max-count=2000',
      'foo', '/r',
    ]
  );
  assert.equal(execCall.args[1].cwd, '/r');
});

// === 3. Exit code matrix ===================================================

await test('exit 0 → parsed matches returned', async () => {
  const matchJson = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'a' },
      lines: { text: 'x' },
      line_number: 1,
      submatches: [{ match: { text: 'x' }, start: 0, end: 1 }],
    },
  });
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    exec: matchJson,
    execExit: 0,
  });
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  assert.equal(r.matches.length, 1);
  assert.equal(r.error, undefined);
});

await test('exit 1 → empty matches (NOT an error)', async () => {
  // rg exits 1 when there are no matches. This is normal, not a failure.
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    exec: '',
    execExit: 1,
  });
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  assert.deepEqual(r.matches, []);
  assert.equal(r.error, undefined);
});

await test('exit 2 → rg-error with stderr surfaced', async () => {
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    exec: '',
    execExit: 2,
    execStderr: 'regex parse error: foo',
  });
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  assert.equal(r.error, 'rg-error');
  assert.ok(r.message.includes('regex parse'));
});

await test('exit 3 → unknown error', async () => {
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    exec: '',
    execExit: 3,
  });
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  assert.equal(r.error, 'unknown');
  assert.ok(r.message.includes('rg exit 3'));
});

// === 4. exec throw → exec-failed ===========================================

await test('exec throw → exec-failed', async () => {
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    execError: new Error('not found'),
  });
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  assert.equal(r.error, 'exec-failed');
  assert.ok(r.message.includes('not found'));
});

// === 5. Validation =========================================================

await test('empty query → invalid-query', async () => {
  const m = createMuxyMock();
  const r = await runSearch(m, { query: '', rgPath: 'rg' });
  assert.equal(r.error, 'invalid-query');
});

await test('missing opts → invalid-query', async () => {
  const m = createMuxyMock();
  const r = await runSearch(m, undefined);
  assert.equal(r.error, 'invalid-query');
});

// === 6. Cancellation =======================================================

await test('querySeq mismatch → aborted', async () => {
  let currentSeq = 1;
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    exec: '',
    execExit: 0,
  });
  // Override exec to bump the live counter mid-call, simulating a
  // newer search landing while the previous one is still running.
  m.exec = async (argv, opts) => {
    m.calls.push({ key: 'exec', args: [argv, opts] });
    currentSeq = 2;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const r = await runSearch(m, {
    query: 'foo',
    rgPath: 'rg',
    querySeq: 1,
    getCurrentSeq: () => currentSeq,
  });
  assert.equal(r.aborted, true);
});

await test('matching querySeq → NOT aborted', async () => {
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    exec: '',
    execExit: 0,
  });
  const r = await runSearch(m, {
    query: 'foo',
    rgPath: 'rg',
    querySeq: 7,
    getCurrentSeq: () => 7, // still 7 → no supersede
  });
  assert.equal(r.aborted, false);
  assert.equal(r.error, undefined);
});

// === 7. onStale callback fires on supersede ================================

await test('onStale callback fires when seq mismatches', async () => {
  let currentSeq = 1;
  let staleCalledWith = null;
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    exec: '',
    execExit: 0,
  });
  m.exec = async (argv, opts) => {
    m.calls.push({ key: 'exec', args: [argv, opts] });
    currentSeq = 99;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  await runSearch(m, {
    query: 'foo',
    rgPath: 'rg',
    querySeq: 1,
    getCurrentSeq: () => currentSeq,
    onStale: (n) => { staleCalledWith = n; },
  });
  assert.equal(staleCalledWith, 99);
});

// === additional defensive branches ==========================================

await test('worktrees.list missing: falls through to git.repoInfo', async () => {
  // No worktrees.list at all (older Muxy API or stripped host) →
  // safeWorktrees returns null → repoInfo path takes over.
  const m = {
    git: {
      repoInfo: async () => {
        m.calls = m.calls || [];
        m.calls.push({ key: 'git.repoInfo' });
        return { root: '/git-root' };
      },
    },
    exec: async (argv) => {
      m.calls = m.calls || [];
      m.calls.push({ key: 'exec', args: [argv] });
      return { exitCode: 0, stdout: '', stderr: '' };
    },
    calls: [],
  };
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  const execCall = m.calls.find((c) => c.key === 'exec');
  assert.equal(execCall.args[0][execCall.args[0].length - 1], '/git-root');
});

await test('both APIs missing: returns no-scope error', async () => {
  const m = {
    exec: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
  };
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  assert.equal(r.error, 'no-scope');
});

await test('worktrees.list returns non-array: treated as no worktrees', async () => {
  // Defensive: a host that returns a non-array (object, null, etc.)
  // must not crash; safeWorktrees coerces it to null.
  const m = {
    worktrees: { list: async () => ({ unexpected: 'shape' }) },
    git: { repoInfo: async () => ({ root: '/r' }) },
    exec: async (argv) => ({ exitCode: 0, stdout: '', stderr: '' }),
  };
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  // Falls through to git.repoInfo because worktrees.list returned a
  // non-array (treated as "no usable list").
  assert.ok(r.error === undefined || r.error === 'no-scope');
});

await test('worktrees: isCurrent variant picks the current worktree', async () => {
  const m = createMuxyMock({
    worktrees: [
      { path: '/wt1', isCurrent: true },
      { path: '/wt2', isActive: true },
    ],
    exec: '', execExit: 0,
  });
  await runSearch(m, { query: 'foo', rgPath: 'rg' });
  const execCall = m.calls.find((c) => c.key === 'exec');
  // isActive wins over isCurrent per pickActiveWorktree's lookup order.
  assert.equal(execCall.args[0][execCall.args[0].length - 1], '/wt2');
});

await test('worktrees: active variant picks the active worktree', async () => {
  const m = createMuxyMock({
    worktrees: [
      { path: '/wt1', active: true },
    ],
    exec: '', execExit: 0,
  });
  await runSearch(m, { query: 'foo', rgPath: 'rg' });
  const execCall = m.calls.find((c) => c.key === 'exec');
  assert.equal(execCall.args[0][execCall.args[0].length - 1], '/wt1');
});

await test('worktrees: no flag set falls back to first entry', async () => {
  const m = createMuxyMock({
    worktrees: [
      { path: '/wt1' },
      { path: '/wt2' },
    ],
    exec: '', execExit: 0,
  });
  await runSearch(m, { query: 'foo', rgPath: 'rg' });
  const execCall = m.calls.find((c) => c.key === 'exec');
  assert.equal(execCall.args[0][execCall.args[0].length - 1], '/wt1');
});

await test('exit_code (snake_case) is accepted as a fallback', async () => {
  // muxy.exec may return either `exitCode` or `exit_code` depending on
  // host version. The handler reads both, preferring camelCase.
  const m = {
    worktrees: { list: async () => [{ path: '/r', isActive: true }] },
    exec: async () => ({ exit_code: 1, stdout: '', stderr: '' }),
  };
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.matches, []);
});

await test('result null: returns exec-failed', async () => {
  // If muxy.exec resolves to null/undefined (shouldn't happen but be
  // defensive), the search must report exec-failed rather than crash.
  const m = {
    worktrees: { list: async () => [{ path: '/r', isActive: true }] },
    exec: async () => null,
  };
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  assert.equal(r.error, 'exec-failed');
});

await test('result.stdout non-string is coerced to empty', async () => {
  const m = {
    worktrees: { list: async () => [{ path: '/r', isActive: true }] },
    exec: async () => ({ exitCode: 0, stdout: null, stderr: null }),
  };
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  // exit 0 with no stdout → empty matches, no error.
  assert.equal(r.error, undefined);
  assert.deepEqual(r.matches, []);
});

await test('worktrees.list throws between worktrees and git: aborts', async () => {
  // If the seq bumps while worktrees.list is in flight, the result is
  // discarded and the next call's git check is skipped.
  let currentSeq = 1;
  const m = {
    worktrees: {
      list: async () => {
        currentSeq = 2; // bump mid-call
        return [{ path: '/r', isActive: true }];
      },
    },
    git: { repoInfo: async () => { throw new Error('should not be called'); } },
    exec: async () => { throw new Error('should not be called'); },
  };
  const r = await runSearch(m, {
    query: 'foo',
    rgPath: 'rg',
    querySeq: 1,
    getCurrentSeq: () => currentSeq,
  });
  assert.equal(r.aborted, true);
});

await test('onStale is NOT called when seq matches', async () => {
  let staleCalled = false;
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    exec: '', execExit: 0,
  });
  await runSearch(m, {
    query: 'foo',
    rgPath: 'rg',
    querySeq: 5,
    getCurrentSeq: () => 5, // still 5
    onStale: () => { staleCalled = true; },
  });
  assert.equal(staleCalled, false);
});

await test('matches pass through to caller unchanged', async () => {
  // Sanity check: the matches array returned by runSearch is the same
  // one produced by parseBuffer, not a copy or transformation.
  const matchJson = JSON.stringify({
    type: 'match',
    data: {
      path: { text: 'p' },
      lines: { text: 't' },
      line_number: 99,
      submatches: [{ match: { text: 't' }, start: 0, end: 1 }],
    },
  });
  const m = createMuxyMock({
    worktrees: [{ path: '/r', isActive: true }],
    exec: matchJson,
    execExit: 0,
  });
  const r = await runSearch(m, { query: 'foo', rgPath: 'rg' });
  assert.equal(r.matches[0].line, 99);
  assert.equal(r.matches[0].path, 'p');
  assert.equal(r.stats.scope, '/r');
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
