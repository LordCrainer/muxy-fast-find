// Phase 5: inline-preview test suite. Every fetchContext branch:
// happy path, binary detection, stale file, unreadable, exec throw,
// line/contextLines validation.
//
// Usage: node tests/test-inline-preview.mjs

import assert from 'node:assert/strict';
import { fetchContext } from '../src/panel/inline-preview.js';

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

// Mock factory. `responses` is a function (argv, opts) => result so the
// test can dispatch on the first argv element (head vs sed). When a
// plain object is passed, the same response is returned for every call
// (useful for "exec throws" tests that use a single throw).
function createMuxyMock(responses) {
  return {
    exec: async (argv, opts) => {
      if (typeof responses === 'function') return responses(argv, opts);
      return responses;
    },
  };
}

console.log('test-inline-preview');

// === 1. Happy path =========================================================

await test('ok: returns lines with matchLine and bounded line count', async () => {
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain text' };
    if (argv[0] === 'sed') return { exitCode: 0, stdout: 'line 9\nline 10\nline 11\n' };
    return { exitCode: 1, stdout: '' };
  });
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.kind, 'ok');
  assert.equal(r.matchLine, 10);
  assert.equal(r.lines.length, 3);
});

await test('ok: matchLine is the coerced safeLine', async () => {
  // Even if the caller passed 0 or a float, the result's matchLine
  // should be the 1-indexed integer that was actually used.
  let capturedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  const r = await fetchContext(m, { filePath: 'a.js', line: 7 });
  assert.equal(r.kind, 'ok');
  assert.equal(r.matchLine, 7);
  // The sed range is what was actually requested.
  assert.equal(capturedArgv[2], '2,12p'); // 7-5..7+5
});

// === 2. Binary detection ===================================================

await test('binary: NUL in head output → binary', async () => {
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'a\x00b' };
    return { exitCode: 0, stdout: 'should not be called' };
  });
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.kind, 'binary');
});

await test('binary: sed is NOT called when binary is detected', async () => {
  // The binary sniff should short-circuit before we run sed; otherwise
  // a binary file would print garbage to the preview.
  let sedCalled = false;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: '\x00' };
    if (argv[0] === 'sed') {
      sedCalled = true;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(sedCalled, false, 'sed should not be called for binary files');
});

// === 3. Stale (file gone or unreadable) =====================================

await test('stale: sed exit non-zero → stale', async () => {
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') return { exitCode: 1, stdout: '', stderr: 'No such file' };
    return { exitCode: 0, stdout: '' };
  });
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.kind, 'stale');
});

await test('stale: stderr mentions "no such file" → stale', async () => {
  // sed exit 0 with an out-of-range query AND no stderr is unreadable.
  // sed exit 0 with an error message in stderr is stale. Different
  // surfaces, different user copy.
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    return { exitCode: 0, stdout: '', stderr: 'No such file or directory' };
  });
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.kind, 'stale');
});

await test('stale: stderr mentions "cannot open" → stale', async () => {
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    return { exitCode: 0, stdout: '', stderr: 'sed: cannot open a.js' };
  });
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.kind, 'stale');
});

await test('stale: stderr mentions "permission denied" → stale', async () => {
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    return { exitCode: 0, stdout: '', stderr: 'permission denied' };
  });
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.kind, 'stale');
});

// === 4. Unreadable =========================================================

await test('unreadable: empty stdout, no stderr', async () => {
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    return { exitCode: 0, stdout: '' };
  });
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.kind, 'unreadable');
});

// === 5. exec throw MUST NOT propagate =======================================

await test('head exec throw returns stale (does not throw)', async () => {
  const m = {
    exec: async () => { throw new Error('perm denied'); },
  };
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.kind, 'stale');
});

await test('sed exec throw returns stale (does not throw)', async () => {
  // Head succeeds; sed throws. Same outcome: stale, no propagation.
  const m = {
    exec: async (argv) => {
      if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
      throw new Error('IPC drop');
    },
  };
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.kind, 'stale');
});

// === 6. Input validation ===================================================

await test('empty filePath returns stale', async () => {
  const m = createMuxyMock();
  const r = await fetchContext(m, { filePath: '', line: 10 });
  assert.equal(r.kind, 'stale');
});

await test('null opts returns stale', async () => {
  const m = createMuxyMock();
  const r = await fetchContext(m, null);
  assert.equal(r.kind, 'stale');
});

await test('line: -5 coerced to 1 (range starts at 1)', async () => {
  let capturedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: -5 });
  // safeLine = max(1, -5) = 1. With default contextLines=5, range is 1..6.
  assert.ok(capturedArgv[2].startsWith('1,'));
  assert.equal(capturedArgv[2], '1,6p');
});

await test('line: 0 coerced to 1', async () => {
  let capturedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 0 });
  assert.ok(capturedArgv[2].startsWith('1,'));
});

// === 7. contextLines normalization =========================================

await test('contextLines capped at 50', async () => {
  let capturedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 10, contextLines: 1000 });
  // Range is (line-contextLines) to (line+contextLines), with the
  // start clamped to 1. The MAX span is 2*50 = 100 lines.
  const range = capturedArgv[2];
  const [start, end] = range.replace('p', '').split(',').map(Number);
  assert.ok(start >= 1, `start should be ≥ 1, got ${start}`);
  assert.ok(end - start <= 100, `span should be ≤ 100, got ${end - start}`);
});

await test('contextLines: 0 falls back to 5 (default)', async () => {
  let capturedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 10, contextLines: 0 });
  // line=10, contextLines=5 → range "5,15p"
  assert.equal(capturedArgv[2], '5,15p');
});

await test('contextLines: negative falls back to 5', async () => {
  let capturedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 10, contextLines: -3 });
  assert.equal(capturedArgv[2], '5,15p');
});

// === additional defensive branches ==========================================

await test('line: NaN coerced to 1', async () => {
  let capturedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: NaN });
  // `Number(NaN) || 1` = 1, so safeLine = 1.
  assert.equal(capturedArgv[2], '1,6p');
});

await test('line: undefined coerced to 1', async () => {
  let capturedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: undefined });
  assert.equal(capturedArgv[2], '1,6p');
});

await test('line: float is floored to integer', async () => {
  let capturedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 7.9 });
  // floor(7.9) = 7, contextLines=5 → 2,12p
  assert.equal(capturedArgv[2], '2,12p');
});

await test('contextLines: string falls back to 5', async () => {
  let capturedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      capturedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 10, contextLines: 'banana' });
  // Non-numeric → default 5.
  assert.equal(capturedArgv[2], '5,15p');
});

await test('repoRoot is passed to exec as cwd', async () => {
  let headOpts = null;
  let sedOpts = null;
  const m = createMuxyMock((argv, opts) => {
    if (argv[0] === 'head') { headOpts = opts; return { exitCode: 0, stdout: 'plain' }; }
    if (argv[0] === 'sed') { sedOpts = opts; return { exitCode: 0, stdout: 'x' }; }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 10, repoRoot: '/some/repo' });
  assert.equal(headOpts.cwd, '/some/repo');
  assert.equal(sedOpts.cwd, '/some/repo');
});

await test('repoRoot defaults to "."', async () => {
  let headOpts = null;
  const m = createMuxyMock((argv, opts) => {
    if (argv[0] === 'head') { headOpts = opts; return { exitCode: 0, stdout: 'plain' }; }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(headOpts.cwd, '.');
});

await test('head reads exactly 1024 bytes (binary sniff window)', async () => {
  let headArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') {
      headArgv = argv;
      return { exitCode: 0, stdout: 'plain' };
    }
    return { exitCode: 0, stdout: 'x' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 10 });
  // The sniff window is 1024 bytes; pinned in BINARY_SNIFF_BYTES.
  assert.equal(headArgv[1], '-c');
  assert.equal(headArgv[2], '1024');
  assert.equal(headArgv[3], 'a.js');
});

await test('sed uses -n flag to suppress default output', async () => {
  let sedArgv = null;
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') {
      sedArgv = argv;
      return { exitCode: 0, stdout: 'x' };
    }
    return { exitCode: 0, stdout: '' };
  });
  await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(sedArgv[0], 'sed');
  assert.equal(sedArgv[1], '-n');
  // sedArgv[2] is the range, sedArgv[3] is the file path.
  assert.equal(sedArgv[3], 'a.js');
});

await test('ok: lines have line numbers starting at startLine', async () => {
  // Even though sed's output has the file's actual line numbers, the
  // parser assigns numbers based on the range it requested. This is
  // a known approximation — sed can't easily map "line 3 of output"
  // back to the absolute line in the file. The current implementation
  // uses startLine + offset, which is correct for the in-range case.
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') return { exitCode: 0, stdout: 'A\nB\nC\n' };
    return { exitCode: 1, stdout: '' };
  });
  // line=10, contextLines=5 → startLine=5
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.lines[0].line, 5);
  assert.equal(r.lines[1].line, 6);
  assert.equal(r.lines[2].line, 7);
});

await test('ok: trailing empty line in stdout is dropped', async () => {
  // sed terminates every printed line with \n, producing a final empty
  // element after split. parseSedOutput must drop that phantom row.
  const m = createMuxyMock((argv) => {
    if (argv[0] === 'head') return { exitCode: 0, stdout: 'plain' };
    if (argv[0] === 'sed') return { exitCode: 0, stdout: 'X\n' };
    return { exitCode: 0, stdout: '' };
  });
  const r = await fetchContext(m, { filePath: 'a.js', line: 10 });
  assert.equal(r.lines.length, 1);
  assert.equal(r.lines[0].text, 'X');
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
