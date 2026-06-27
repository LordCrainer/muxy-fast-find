// Phase 5: rg-resolve test suite. Validates the multi-strategy ripgrep
// path resolver: `which rg` → parallel `test -x` probes at known
// install locations → bare-name fallback. The resolver is the primary
// defense against Muxy's exec sandbox hiding /opt/homebrew/bin/rg and
// /usr/local/bin/rg from the panel.
//
// Usage: node tests/test-rg-resolve.mjs

import assert from 'node:assert/strict';
import { resolveRgPath, COMMON_RG_PATHS } from '../src/panel/rg-resolve.js';

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

console.log('test-rg-resolve');

// === 0. Module shape =======================================================

await test('exports COMMON_RG_PATHS as a non-empty array', () => {
  assert.ok(Array.isArray(COMMON_RG_PATHS));
  assert.ok(COMMON_RG_PATHS.length >= 3, 'expected at least 3 probe paths');
  for (const p of COMMON_RG_PATHS) {
    assert.equal(typeof p, 'string');
    assert.ok(p.endsWith('/rg'), `expected probe path to end with /rg, got: ${p}`);
  }
});

await test('COMMON_RG_PATHS includes the canonical macOS / Linux locations', () => {
  // Pin the specific entries: these are the only four that matter for
  // real-world users. Changing them is a deliberate, visible decision.
  assert.ok(COMMON_RG_PATHS.includes('/opt/homebrew/bin/rg'));
  assert.ok(COMMON_RG_PATHS.includes('/usr/local/bin/rg'));
  assert.ok(COMMON_RG_PATHS.includes('/usr/bin/rg'));
});

await test('resolveRgPath is a function', () => {
  assert.equal(typeof resolveRgPath, 'function');
});

// === 1. which rg returns a path ===========================================

await test('uses "which rg" result when it returns a non-empty path', async () => {
  let probeCalls = 0;
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 0, stdout: '/usr/bin/rg\n' };
      if (argv[0] === 'test') { probeCalls += 1; return { exitCode: 0 }; }
      return { exitCode: 1 };
    },
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, '/usr/bin/rg');
  // When `which` succeeds, probes are short-circuited — Promise.all with
  // an empty array of meaningful results shouldn't even be reached. We
  // don't assert probeCalls === 0 (the implementation may still call
  // them) — what matters is the returned path.
  assert.ok(p !== 'rg', 'should not fall back to the bare name when which succeeded');
});

await test('trims trailing whitespace/newline from "which" output', async () => {
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 0, stdout: '   /opt/homebrew/bin/rg   \n' };
      return { exitCode: 1 };
    },
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, '/opt/homebrew/bin/rg');
});

// === 2. which empty + probe succeeds ======================================

await test('falls back to /opt/homebrew/bin/rg probe when "which" returns empty', async () => {
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 1, stdout: '' };
      if (argv[0] === 'test' && argv[2] === '/opt/homebrew/bin/rg') return { exitCode: 0 };
      return { exitCode: 1 };
    },
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, '/opt/homebrew/bin/rg');
});

await test('falls back to /usr/local/bin/rg probe when "which" returns empty', async () => {
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 1, stdout: '' };
      if (argv[0] === 'test' && argv[2] === '/usr/local/bin/rg') return { exitCode: 0 };
      return { exitCode: 1 };
    },
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, '/usr/local/bin/rg');
});

await test('falls back to /usr/bin/rg probe when "which" returns empty', async () => {
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 1, stdout: '' };
      if (argv[0] === 'test' && argv[2] === '/usr/bin/rg') return { exitCode: 0 };
      return { exitCode: 1 };
    },
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, '/usr/bin/rg');
});

// === 3. all probes fail → fallback ========================================

await test('returns fallback when "which" empty and all probes fail', async () => {
  const m = {
    exec: async () => ({ exitCode: 1, stdout: '' }),
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, 'rg');
});

await test('returns the custom fallback string when nothing resolves', async () => {
  const m = {
    exec: async () => ({ exitCode: 1, stdout: '' }),
  };
  const p = await resolveRgPath(m, 'custom-rg-fallback');
  assert.equal(p, 'custom-rg-fallback');
});

// === 4. which throws → fall through to probes =============================

await test('falls through to probes when "which" exec throws', async () => {
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') throw new Error('permission denied');
      if (argv[0] === 'test' && argv[2] === '/usr/local/bin/rg') return { exitCode: 0 };
      return { exitCode: 1 };
    },
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, '/usr/local/bin/rg');
});

await test('returns fallback when "which" throws AND all probes fail', async () => {
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') throw new Error('permission denied');
      throw new Error('also denied');
    },
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, 'rg');
});

// === 5. all probes throw → fallback ========================================

await test('returns fallback when every probe throws (no transport)', async () => {
  const m = {
    exec: async () => { throw new Error('sandbox denied all exec'); },
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, 'rg');
});

// === 6. muxy null / missing exec → fallback immediately ===================

await test('returns fallback immediately when muxy is null', async () => {
  const p = await resolveRgPath(null, 'rg');
  assert.equal(p, 'rg');
});

await test('returns fallback immediately when muxy.exec is missing', async () => {
  const p = await resolveRgPath({}, 'rg');
  assert.equal(p, 'rg');
});

await test('returns fallback immediately when muxy.exec is not a function', async () => {
  const p = await resolveRgPath({ exec: 'not a function' }, 'rg');
  assert.equal(p, 'rg');
});

await test('does not invoke muxy.exec when muxy.exec is missing', async () => {
  // The guard inspects muxy.exec (via `typeof`) to decide whether to
  // use it. What matters here is that the function is never INVOKED —
  // a missing exec means no `which rg` and no probes. If we ever
  // accidentally called the missing function, this would throw.
  const p = await resolveRgPath({ exec: undefined }, 'rg');
  assert.equal(p, 'rg');
});

// === 7. Probe execution is parallel (not sequential) ======================

await test('runs probes in parallel (4x30ms probes finish well under 100ms)', async () => {
  // If probes ran sequentially, 4 × 30ms = 120ms — over the 100ms
  // threshold. Parallel ≈ 30ms. The 100ms ceiling gives us 3× headroom
  // for scheduler jitter while still catching a serial regression.
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 1, stdout: '' };
      if (argv[0] === 'test') {
        await new Promise((r) => setTimeout(r, 30));
        return { exitCode: 1 }; // all probes fail; we only care about timing
      }
      return { exitCode: 1 };
    },
  };
  const t0 = Date.now();
  const p = await resolveRgPath(m, 'rg');
  const elapsed = Date.now() - t0;
  assert.equal(p, 'rg', 'all probes should have failed');
  assert.ok(
    elapsed < 100,
    `expected parallel probes to finish in <100ms, took ${elapsed}ms`
  );
});

await test('all four COMMON_RG_PATHS are probed in parallel', async () => {
  // Spy on probe invocations: count concurrent in-flight calls and
  // verify the high-water mark is > 1 (proves parallelism, not
  // sequential await).
  let inFlight = 0;
  let highWater = 0;
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 1, stdout: '' };
      if (argv[0] === 'test') {
        inFlight += 1;
        if (inFlight > highWater) highWater = inFlight;
        // Hold the probe open briefly so concurrent calls pile up.
        await new Promise((r) => setTimeout(r, 20));
        inFlight -= 1;
        return { exitCode: 1 };
      }
      return { exitCode: 1 };
    },
  };
  await resolveRgPath(m, 'rg');
  assert.ok(
    highWater > 1,
    `expected concurrent probes (high-water > 1), got ${highWater}`
  );
});

// === 8. Edge cases ========================================================

await test('probes use ["test", "-x", candidate] argv shape', async () => {
  const observed = [];
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 1, stdout: '' };
      if (argv[0] === 'test') {
        observed.push([...argv]);
        return { exitCode: 1 };
      }
      return { exitCode: 1 };
    },
  };
  await resolveRgPath(m, 'rg');
  assert.equal(observed.length, COMMON_RG_PATHS.length);
  for (let i = 0; i < observed.length; i += 1) {
    assert.deepEqual(observed[i], ['test', '-x', COMMON_RG_PATHS[i]]);
  }
});

await test('uses exitCode === 0 to accept a probe (not just absence of throw)', async () => {
  // test -x on a non-executable file returns exitCode 1 — must not be
  // accepted. Conversely, exitCode 0 on a real rg must be accepted.
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 1, stdout: '' };
      if (argv[0] === 'test' && argv[2] === '/opt/homebrew/bin/rg') return { exitCode: 0 };
      return { exitCode: 1 }; // not exitCode 0 — must be rejected
    },
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, '/opt/homebrew/bin/rg');
});

await test('does not pass stderr=undefined as a positive signal', async () => {
  // Some Muxy exec impls return { exitCode: 1, stderr: 'not found' }
  // for missing binaries. The probe should treat exitCode, not stdout,
  // as the success signal.
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'which') return { exitCode: 1, stdout: '', stderr: 'not found' };
      if (argv[0] === 'test') return { exitCode: 1, stdout: '', stderr: 'not found' };
      return { exitCode: 1, stdout: '', stderr: 'not found' };
    },
  };
  const p = await resolveRgPath(m, 'rg');
  assert.equal(p, 'rg', 'nothing should have resolved');
});

// === Summary ==============================================================

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error.message}`);
  }
  process.exit(1);
}
