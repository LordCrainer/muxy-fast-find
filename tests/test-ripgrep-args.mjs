// Phase 5: rg-args test suite. Pins the exact argv shape that runSearch
// hands to muxy.exec — this is the single most important regression net
// in the project because a flag change silently degrades search quality
// (symlink cycles blow up traversal, regex meta gets shell-parsed, etc.).
//
// Usage: node tests/test-ripgrep-args.mjs

import assert from 'node:assert/strict';
import { buildArgv, RG_DEFAULT_FLAGS, MAX_COLUMNS } from '../src/panel/rg-args.js';

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

console.log('test-ripgrep-args');

// === argv shape: defaults and explicit overrides ============================

test('default: rg + RG_DEFAULT_FLAGS + query', () => {
  assert.deepEqual(
    buildArgv({ query: 'foo' }),
    ['rg', ...RG_DEFAULT_FLAGS, 'foo']
  );
});

test('with scope: appends scope as last positional', () => {
  assert.deepEqual(
    buildArgv({ query: 'foo', scope: '/repo' }),
    ['rg', ...RG_DEFAULT_FLAGS, 'foo', '/repo']
  );
});

// === flag emission in their expected slots ==================================

test('caseMode insensitive adds -i', () => {
  const argv = buildArgv({ query: 'foo', caseMode: 'insensitive' });
  const i = argv.indexOf('-i');
  assert.ok(i > -1, '-i not present');
  assert.ok(argv.indexOf('foo') > i, 'query must come after -i');
});

test('regexMode literal adds -F', () => {
  const argv = buildArgv({ query: 'foo', regexMode: 'literal' });
  assert.ok(argv.includes('-F'));
});

test('includeGlobs emits -g pairs in order', () => {
  const argv = buildArgv({ query: 'foo', includeGlobs: ['*.ts', '*.tsx'] });
  const gIdx = argv.indexOf('-g');
  assert.equal(argv[gIdx + 1], '*.ts');
  // Find the second -g AFTER the first one (not before).
  const g2Idx = argv.indexOf('-g', gIdx + 1);
  assert.equal(argv[g2Idx + 1], '*.tsx');
});

test('hidden adds --hidden', () => {
  assert.ok(buildArgv({ query: 'foo', hidden: true }).includes('--hidden'));
});

test('noIgnore adds -uu', () => {
  assert.ok(buildArgv({ query: 'foo', noIgnore: true }).includes('-uu'));
});

test('custom rgPath', () => {
  assert.equal(
    buildArgv({ query: 'foo', rgPath: '/opt/homebrew/bin/rg' })[0],
    '/opt/homebrew/bin/rg'
  );
});

// === safety nets ============================================================

test('query starting with - gets -- guard', () => {
  const argv = buildArgv({ query: '-flag' });
  const dashIdx = argv.indexOf('--');
  assert.ok(dashIdx > -1, '-- guard missing');
  assert.equal(argv[dashIdx + 1], '-flag');
});

test('query not starting with - has no -- guard', () => {
  assert.equal(buildArgv({ query: 'foo-bar' }).includes('--'), false);
});

test('regex meta is a single argv element (shell-injection safety)', () => {
  // rg treats this as one pattern, not as multiple flags. The fact that
  // it's a single element in the array (not split on whitespace or
  // re-parsed by a shell) is exactly what protects against injection.
  const argv = buildArgv({ query: 'a.*b$+?' });
  assert.ok(argv.includes('a.*b$+?'));
});

// === rg version gating ======================================================

test('rgVersion >= 13 adds --no-follow', () => {
  const argv = buildArgv({ query: 'foo', rgVersion: '14.1.0' });
  assert.ok(argv.includes('--no-follow'));
});

test('rgVersion >= 13 emits --no-follow, not --follow=false', () => {
  // Regression guard: rg rejects `--follow=false` with
  // "invalid CLI arguments: unexpected argument for option '--follow'".
  // The correct form is the boolean negation `--no-follow`.
  const argv = buildArgv({ query: 'foo', rgVersion: '14.1.0' });
  assert.ok(argv.includes('--no-follow'), 'should include --no-follow');
  assert.equal(argv.includes('--follow=false'), false, 'must NOT include --follow=false');
  assert.equal(argv.includes('--follow'), false, 'must NOT include --follow either');
});

test('rgVersion < 13 does not add --no-follow', () => {
  // 12.x would reject the flag with an error; we MUST skip it.
  const argv = buildArgv({ query: 'foo', rgVersion: '12.1.0' });
  assert.equal(argv.includes('--no-follow'), false);
});

test('rgVersion 13.0.0 boundary: --no-follow is added', () => {
  // Exactly at the floor; the spec is `major >= 13`.
  const argv = buildArgv({ query: 'foo', rgVersion: '13.0.0' });
  assert.ok(argv.includes('--no-follow'));
});

// === input validation =======================================================

test('empty query throws', () => {
  assert.throws(() => buildArgv({ query: '' }), /query required/);
});

test('missing query throws', () => {
  assert.throws(() => buildArgv({}), /query required/);
});

test('null opts throws', () => {
  assert.throws(() => buildArgv(null), /query required/);
});

// === exported constants =====================================================

test('MAX_COLUMNS is 200', () => {
  assert.equal(MAX_COLUMNS, 200);
});

test('RG_DEFAULT_FLAGS includes --max-columns=MAX_COLUMNS', () => {
  assert.ok(RG_DEFAULT_FLAGS.includes(`--max-columns=${MAX_COLUMNS}`));
});

test('RG_DEFAULT_FLAGS includes --max-count=2000', () => {
  // The anti-regression test in test-run-search asserts the exact argv,
  // so this constant must keep this shape forever.
  assert.ok(RG_DEFAULT_FLAGS.includes('--max-count=2000'));
});

test('RG_DEFAULT_FLAGS leads with --json so the parser keys correctly', () => {
  assert.equal(RG_DEFAULT_FLAGS[0], '--json');
});

// === flag combination matrix ===============================================

test('all flags combined in a single call', () => {
  // Sanity check: the typical "user has every setting on" path.
  const argv = buildArgv({
    query: 'foo',
    scope: '/r',
    caseMode: 'insensitive',
    regexMode: 'literal',
    hidden: true,
    noIgnore: true,
    includeGlobs: ['*.ts', '*.tsx'],
    rgPath: 'rg',
    rgVersion: '14.0.0',
  });
  assert.ok(argv.includes('-i'));
  assert.ok(argv.includes('-F'));
  assert.ok(argv.includes('--hidden'));
  assert.ok(argv.includes('-uu'));
  assert.ok(argv.includes('--no-follow'));
  // -g pairs in order, before the query.
  const gIdx = argv.indexOf('-g');
  assert.equal(argv[gIdx + 1], '*.ts');
  const g2Idx = argv.indexOf('-g', gIdx + 1);
  assert.equal(argv[g2Idx + 1], '*.tsx');
  // query last-positional-before-scope.
  assert.equal(argv[argv.length - 1], '/r');
  assert.equal(argv[argv.length - 2], 'foo');
});

test('all flag-ordering: hidden < noIgnore < -i < -F < --no-follow < -g pairs', () => {
  // The order in argv matters: --hidden must come before -uu, -i before
  // -F, etc. This test pins the relative positions so a future refactor
  // can't reorder them silently.
  const argv = buildArgv({
    query: 'foo',
    scope: '/r',
    caseMode: 'insensitive',
    regexMode: 'literal',
    hidden: true,
    noIgnore: true,
    includeGlobs: ['*.ts'],
    rgVersion: '14.0.0',
  });
  const iHidden = argv.indexOf('--hidden');
  const iNoIgnore = argv.indexOf('-uu');
  const iI = argv.indexOf('-i');
  const iF = argv.indexOf('-F');
  const iFollow = argv.indexOf('--no-follow');
  const iG = argv.indexOf('-g');
  assert.ok(iHidden < iNoIgnore, '--hidden must come before -uu');
  assert.ok(iNoIgnore < iI, '-uu must come before -i');
  assert.ok(iI < iF, '-i must come before -F');
  assert.ok(iF < iFollow, '-F must come before --no-follow');
  assert.ok(iFollow < iG, '--no-follow must come before -g');
});

test('no-ignore + case-insensitive + literal: order is consistent', () => {
  const argv = buildArgv({
    query: 'q',
    noIgnore: true,
    caseMode: 'insensitive',
    regexMode: 'literal',
  });
  const iNoIgnore = argv.indexOf('-uu');
  const iI = argv.indexOf('-i');
  const iF = argv.indexOf('-F');
  assert.ok(iNoIgnore < iI);
  assert.ok(iI < iF);
});

test('--no-follow position: between -F and the -g pairs', () => {
  const argv = buildArgv({
    query: 'q',
    regexMode: 'literal',
    includeGlobs: ['*.ts'],
    rgVersion: '14.0.0',
  });
  const iF = argv.indexOf('-F');
  const iFollow = argv.indexOf('--no-follow');
  const iG = argv.indexOf('-g');
  assert.ok(iF < iFollow);
  assert.ok(iFollow < iG);
});

// === rgVersion edge cases ===================================================

test('rgVersion 13.0 boundary: --no-follow added', () => {
  const argv = buildArgv({ query: 'q', rgVersion: '13.0' });
  assert.ok(argv.includes('--no-follow'));
});

test('rgVersion 12.99 boundary: --no-follow NOT added', () => {
  const argv = buildArgv({ query: 'q', rgVersion: '12.99.99' });
  assert.equal(argv.includes('--no-follow'), false);
});

test('rgVersion with non-numeric major: --no-follow NOT added', () => {
  // Defensive: "abc.1.0" — parseInt('abc', 10) is NaN, so the check
  // Number.isFinite(major) must gate this off.
  const argv = buildArgv({ query: 'q', rgVersion: 'abc.1.0' });
  assert.equal(argv.includes('--no-follow'), false);
});

test('rgVersion undefined: --no-follow NOT added', () => {
  // Backward-compat: when we don't know the version, we can't safely
  // add the flag (older rg would reject it).
  const argv = buildArgv({ query: 'q' });
  assert.equal(argv.includes('--no-follow'), false);
});

// === includeGlobs edge cases ===============================================

test('includeGlobs empty array: no -g pairs added', () => {
  const argv = buildArgv({ query: 'q', includeGlobs: [] });
  assert.equal(argv.includes('-g'), false);
});

test('includeGlobs single entry: exactly one -g pair', () => {
  const argv = buildArgv({ query: 'q', includeGlobs: ['*.ts'] });
  const gIdxs = argv.reduce((acc, v, i) => v === '-g' ? acc.concat(i) : acc, []);
  assert.equal(gIdxs.length, 1);
  assert.equal(argv[gIdxs[0] + 1], '*.ts');
});

// === scope edge cases =======================================================

test('scope null: argv does not end with null', () => {
  const argv = buildArgv({ query: 'q', scope: null });
  assert.equal(argv[argv.length - 1], 'q');
});

test('scope empty string: argv does not end with empty', () => {
  const argv = buildArgv({ query: 'q', scope: '' });
  assert.equal(argv[argv.length - 1], 'q');
});

test('scope 0: argv ends with "0" (truthy check catches it)', () => {
  // `0` is falsy in JS, so this should be treated as "no scope".
  const argv = buildArgv({ query: 'q', scope: 0 });
  assert.equal(argv[argv.length - 1], 'q');
});

// === --prefix guard integration =============================================

test('-- guard with all flag combinations still present', () => {
  const argv = buildArgv({
    query: '-flag',
    caseMode: 'insensitive',
    hidden: true,
    includeGlobs: ['*.ts'],
  });
  // -- must come BEFORE the query but AFTER the flags.
  const iDash = argv.indexOf('--');
  const iI = argv.indexOf('-i');
  const iHidden = argv.indexOf('--hidden');
  const iG = argv.indexOf('-g');
  const iQuery = argv.indexOf('-flag');
  assert.ok(iDash > iI, '-- must come after -i');
  assert.ok(iDash > iHidden, '-- must come after --hidden');
  assert.ok(iDash > iG, '-- must come after -g');
  assert.equal(iQuery, iDash + 1);
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
