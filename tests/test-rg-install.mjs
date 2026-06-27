// Phase 5: rg-install test suite. Validates `detectRg`, the Phase 4
// helper that decides whether ripgrep is present, executable, and
// recent enough for the features fast-find relies on. Every verdict
// shape (ok / not-found / too-old / error) is exercised here, plus
// the "no host bridge" defensive branch.
//
// Usage: node tests/test-rg-install.mjs

import assert from 'node:assert/strict';
import { detectRg } from '../src/panel/rg-install.js';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
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

// Mock factory. `execResponse` is a value to return from muxy.exec
// (an object), a thrown error to simulate, or a function that takes
// argv and returns the response.
function createMuxyMock(execResponse) {
  return {
    exec: async (argv) => {
      if (typeof execResponse === 'function') return execResponse(argv);
      if (execResponse instanceof Error) throw execResponse;
      return execResponse;
    },
  };
}

console.log('test-rg-install');

// === 1. Happy path =========================================================

await test('ok: modern rg (14.1.0) returns version', async () => {
  const m = createMuxyMock({ exitCode: 0, stdout: 'ripgrep 14.1.0\n\nfeatures: +pcre2\n' });
  const r = await detectRg(m, 'rg');
  assert.equal(r.ok, true);
  assert.equal(r.version, '14.1.0');
});

await test('ok: rg 13.0.0 is accepted (the floor)', async () => {
  const m = createMuxyMock({ exitCode: 0, stdout: 'ripgrep 13.0.0' });
  const r = await detectRg(m, 'rg');
  assert.equal(r.ok, true);
  assert.equal(r.version, '13.0.0');
});

await test('ok: rg 0.10.0 is accepted (pre-1.0 floor)', async () => {
  // The pre-1.0 era used a 0.X version line; 0.10 is the documented
  // minimum there.
  const m = createMuxyMock({ exitCode: 0, stdout: 'ripgrep 0.10.0' });
  const r = await detectRg(m, 'rg');
  assert.equal(r.ok, true);
  assert.equal(r.version, '0.10.0');
});

// === 2. Not found ==========================================================

await test('not-found: muxy is null', async () => {
  // No host bridge → can't exec at all. The UI should show the install
  // prompt regardless of root cause.
  const r = await detectRg(null, 'rg');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-found');
  assert.ok(r.stderr.includes('muxy.exec'));
});

await test('not-found: muxy.exec is missing', async () => {
  const r = await detectRg({}, 'rg');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-found');
});

await test('not-found: muxy.exec throws', async () => {
  const m = createMuxyMock(new Error('rg: command not found'));
  const r = await detectRg(m, 'rg');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-found');
  assert.ok(r.stderr.includes('command not found'));
});

// === 3. Too old ============================================================

await test('too-old: rg 0.9.0 is below the floor', async () => {
  const m = createMuxyMock({ exitCode: 0, stdout: 'ripgrep 0.9.0' });
  const r = await detectRg(m, 'rg');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-old');
  assert.ok(r.stderr.includes('too old'));
});

// === 4. Error: malformed output ============================================

await test('error: empty stdout is treated as malformed', async () => {
  // exec didn't throw but rg produced no version line — something is
  // deeply wrong; surface as 'error', not 'not-found' (binary is there).
  const m = createMuxyMock({ exitCode: 0, stdout: '' });
  const r = await detectRg(m, 'rg');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
});

await test('error: unparseable version string', async () => {
  const m = createMuxyMock({ exitCode: 0, stdout: 'something else entirely' });
  const r = await detectRg(m, 'rg');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
});

await test('error: version with non-numeric components', async () => {
  const m = createMuxyMock({ exitCode: 0, stdout: 'ripgrep abc.def.ghi' });
  const r = await detectRg(m, 'rg');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'error');
});

// === 5. rgPath passed through =============================================

await test('rgPath: custom path is used in the exec call', async () => {
  let capturedArgv = null;
  const m = {
    exec: async (argv) => {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'ripgrep 14.0.0' };
    },
  };
  await detectRg(m, '/opt/homebrew/bin/rg');
  assert.equal(capturedArgv[0], '/opt/homebrew/bin/rg');
  assert.equal(capturedArgv[1], '--version');
});

await test('rgPath defaults to "rg" (resolved via $PATH)', async () => {
  let capturedArgv = null;
  const m = {
    exec: async (argv) => {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'ripgrep 14.0.0' };
    },
  };
  await detectRg(m, 'rg');
  assert.equal(capturedArgv[0], 'rg');
});

// === 6. cwd is "/" for the version probe ===================================

await test('exec uses cwd "/" for the version probe', async () => {
  let capturedOpts = null;
  const m = {
    exec: async (argv, opts) => {
      capturedOpts = opts;
      return { exitCode: 0, stdout: 'ripgrep 14.0.0' };
    },
  };
  await detectRg(m, 'rg');
  // Probing `rg --version` from a non-existent cwd would fail; "/" is
  // always present on POSIX systems.
  assert.equal(capturedOpts.cwd, '/');
});

// === 7. Version parser tolerance ===========================================

await test('parses "ripgrep 14.1.0" with trailing newline', async () => {
  const m = createMuxyMock({ exitCode: 0, stdout: 'ripgrep 14.1.0\n' });
  const r = await detectRg(m, 'rg');
  assert.equal(r.ok, true);
  assert.equal(r.version, '14.1.0');
});

await test('parses version embedded in longer multi-line output', async () => {
  // Real rg --version output is multiple lines; only the first is the
  // version. The parser must extract the version from line 1 and not
  // get confused by later content.
  const stdout = [
    'ripgrep 14.1.0',
    '',
    'features: +pcre2',
    'build: x86_64-apple-darwin',
  ].join('\n');
  const m = createMuxyMock({ exitCode: 0, stdout });
  const r = await detectRg(m, 'rg');
  assert.equal(r.ok, true);
  assert.equal(r.version, '14.1.0');
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
