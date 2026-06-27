// Phase 5: bundle test suite. Validates the Vite output in dist/ — the
// package that actually ships to Muxy. Every assertion here is a
// guarantee that a future refactor didn't accidentally strip a
// host-API call site, break the asset-reference path, or blow the
// bundle past the size budget.
//
// `pretest` in package.json runs `npm run build` before this file, so
// dist/ is always fresh when the assertions run.
//
// Usage: node tests/test-bundle.mjs

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '../dist');

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

console.log('test-bundle');

// === file presence =========================================================

test('dist/panel.html exists', () => {
  assert.ok(existsSync(resolve(distDir, 'panel.html')));
});

test('dist/assets/*.js exists', () => {
  const files = readdirSync(resolve(distDir, 'assets'));
  assert.ok(
    files.some((f) => f.endsWith('.js')),
    'no JS file in dist/assets'
  );
});

test('dist/assets/*.css exists', () => {
  const files = readdirSync(resolve(distDir, 'assets'));
  assert.ok(
    files.some((f) => f.endsWith('.css')),
    'no CSS file in dist/assets'
  );
});

test('dist/icon.svg exists', () => {
  assert.ok(existsSync(resolve(distDir, 'icon.svg')));
});

test('dist/package.json exists', () => {
  assert.ok(existsSync(resolve(distDir, 'package.json')));
});

// === panel.html references are relative =====================================

test('dist/panel.html uses relative asset refs (not absolute /)', () => {
  const html = readFileSync(resolve(distDir, 'panel.html'), 'utf-8');
  // Vite produces absolute /assets/... by default; the fixup plugin in
  // vite.config.js rewrites them to ./assets/... for portability.
  assert.equal(html.includes('href="/assets/'), false);
  assert.equal(html.includes('src="/assets/'), false);
  assert.ok(
    html.includes('href="./assets/') || html.includes('src="./assets/'),
    'panel.html does not reference any ./assets/ path'
  );
});

// Find the JS bundle path. Used by every bundle-content assertion below.
const html = readFileSync(resolve(distDir, 'panel.html'), 'utf-8');
const jsMatch = html.match(/src="\.\/assets\/(panel-[^"]+\.js)"/);
if (!jsMatch) {
  // Fail loudly so the next assertions don't have to handle null.
  test('panel.html references a ./assets/panel-*.js bundle', () => {
    throw new Error('could not find panel-*.js bundle in panel.html');
  });
  // Bail out by exiting the script if no bundle was found.
  console.log('\nAborting: bundle not found');
  process.exit(1);
}
const bundlePath = resolve(distDir, 'assets', jsMatch[1]);
const bundle = readFileSync(bundlePath, 'utf-8');

// === bundle content: host API call sites ====================================

test('bundle includes muxy.exec call site', () => {
  // muxy.exec is the entire search pipeline. Without it, the panel renders
  // but never actually searches.
  assert.ok(
    bundle.includes('muxy.exec'),
    'muxy.exec not found in bundle'
  );
});

test('bundle includes tabs.open call site (for "open in editor")', () => {
  assert.ok(
    bundle.includes('tabs.open'),
    'tabs.open not found in bundle'
  );
});

test('bundle references the code-editor tab type', () => {
  // The "open in editor" action targets the `files` extension's
  // `code-editor` tab type — both string literals must survive
  // minification.
  assert.ok(
    bundle.includes('code-editor'),
    'code-editor string not found in bundle'
  );
});

// === bundle size ===========================================================

test('bundle is under 30KB raw', () => {
  // 30KB is a soft budget for "fast search panel UI". Minified + gzipped
  // this is ~7KB. Going over 30KB raw means we're bundling too much
  // (likely a runtime dep we don't actually need).
  assert.ok(
    bundle.length < 30 * 1024,
    `bundle is ${bundle.length} bytes, exceeds 30KB`
  );
});

test('bundle is non-empty', () => {
  assert.ok(bundle.length > 1000, 'bundle suspiciously small');
});

// === panel.html structure ===================================================

const distPanelHtml = readFileSync(resolve(distDir, 'panel.html'), 'utf-8');

test('dist/panel.html has #search input', () => {
  // The search input is the entry point to the entire feature; if
  // it's missing, the panel would render but be unusable.
  assert.ok(distPanelHtml.includes('id="search"'),
    'panel.html missing id="search"');
});

test('dist/panel.html has #results list', () => {
  assert.ok(distPanelHtml.includes('id="results"'),
    'panel.html missing id="results"');
});

test('dist/panel.html has #status status line', () => {
  assert.ok(distPanelHtml.includes('id="status"'),
    'panel.html missing id="status"');
});

test('dist/panel.html has #settings-toggle button', () => {
  assert.ok(distPanelHtml.includes('id="settings-toggle"'),
    'panel.html missing id="settings-toggle"');
});

// === bundle hygiene ========================================================

test('bundle has no obvious dev artifacts (console.log left over)', () => {
  // Defensive: dev-style logging in a production bundle wastes bytes
  // and risks leaking data into the host console.
  // Vite strips `console.log` calls in production, so this should be 0
  // occurrences. Allow the property access `console.log` from the
  // (unlikely) case where minification kept it.
  const matches = bundle.match(/console\.log\(/g) || [];
  assert.equal(matches.length, 0,
    `bundle has ${matches.length} console.log() call sites`);
});

test('bundle has no debugger statement', () => {
  // A `debugger;` left in production code pauses the host's devtools.
  assert.equal(bundle.includes('debugger;'), false);
});

test('dist/panel.html uses <main> landmark', () => {
  // Accessibility: a `<main>` element lets screen readers skip
  // navigation and go straight to the panel's content.
  assert.ok(distPanelHtml.includes('<main'));
});

test('bundle includes "Searching" status text', () => {
  // The UI shows "Searching…" while a query is in flight. The string
  // is embedded in the bundle so a typo in main.js would still ship.
  assert.ok(bundle.includes('Searching'),
    'bundle missing "Searching" status string');
});

test('dist/package.json mirrors source manifest', () => {
  // `scripts/copy-manifest.mjs` copies package.json verbatim, so
  // any drift between src and dist is a build-pipeline bug.
  const src = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf-8'));
  const dist = JSON.parse(readFileSync(resolve(distDir, 'package.json'), 'utf-8'));
  assert.deepEqual(src.muxy, dist.muxy);
});

// === Phase 4 (Track B): "Open" button on result rows ========================
// Track B adds a per-row "Open" button that opens the file in the editor
// without expanding the preview. These three assertions guarantee the
// feature survives a refactor: the CSS class is present, the JS wires
// the right aria-label, and the scope-change reset (previewLoading = -1)
// makes it into the bundle.

const panelHtmlPath = resolve(distDir, 'panel.html');

test('CSS bundle contains .result-open', () => {
  // m4 fix: read the CSS file from dist/ (not from src/). The HTML in
  // dist/panel.html points to a hashed assets/panel-*.css path, so we
  // parse the link tag and resolve relative to dist/.
  const html = readFileSync(panelHtmlPath, 'utf-8');
  const cssMatch = html.match(/href="\.\/assets\/(panel-[A-Za-z0-9_-]+\.css)"/);
  if (!cssMatch) throw new Error('CSS link not found in panel.html');
  const cssPath = resolve(distDir, 'assets', cssMatch[1]);
  const css = readFileSync(cssPath, 'utf-8');
  assert.ok(css.includes('.result-open'), '.result-open class must be in CSS bundle');
});

test('JS bundle contains Open file in editor aria-label or .result-open class', () => {
  // After minification, the literal string in setAttribute may or may
  // not survive verbatim. Either the aria-label or the class name is
  // sufficient evidence the button was created.
  const found = bundle.includes('Open file in editor') || bundle.includes('result-open');
  assert.ok(found, 'aria-label or class must be in JS bundle');
});

test('JS bundle contains previewLoading = -1 reset', () => {
  // Phase 4 / C5: when the worktree changes, onScopeChanged must reset
  // previewLoading so the next preview can fire. After minification
  // the spacing around `=` may collapse, so we match `\s*` flexibly.
  assert.ok(
    /previewLoading\s*=\s*-1/.test(bundle),
    'previewLoading reset must be in JS bundle'
  );
});

// === v0.2.1 (Track A): absPath augmentation + query persistence ===========

test('JS bundle contains absPath property name', () => {
  // attachAbsolutePaths() augments each match with absPath. The property
  // name must survive minification for the augmentation to work.
  assert.ok(bundle.includes('absPath'), 'absPath must be in JS bundle');
});

test('JS bundle contains fast-find-query-v1: storage prefix', () => {
  // query-store.js defines QUERY_STORAGE_PREFIX = 'fast-find-query-v1:'.
  // This literal must survive minification because it's the actual key
  // written to localStorage at runtime.
  assert.ok(
    bundle.includes('fast-find-query-v1:'),
    'query storage prefix must be in JS bundle'
  );
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
