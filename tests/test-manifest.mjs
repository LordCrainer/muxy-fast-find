// Phase 5: manifest test suite. Pins the shape of package.json's muxy
// block — every permission, event subscription, command, panel, and
// topbar item the extension declares. These are the contracts Muxy
// reads at load time; if a permission goes missing, every rg call would
// silently fail at runtime.
//
// Usage: node tests/test-manifest.mjs

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '../package.json'), 'utf-8')
);
const muxy = pkg.muxy;

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

console.log('test-manifest');

// === top-level shape =======================================================

test('muxy block exists', () => {
  assert.ok(muxy, 'muxy block missing from package.json');
});

test('$schema is set', () => {
  assert.ok(muxy.$schema, '$schema missing');
  assert.ok(
    muxy.$schema.includes('manifest.schema.json'),
    `$schema does not point to manifest.schema.json (got: ${muxy.$schema})`
  );
});

// === permissions ============================================================

test('has all 7 required permissions', () => {
  const required = [
    'panels:write',
    'notifications:write',
    'tabs:read',
    'tabs:write',
    'git:read',
    'worktrees:read',
    'commands:exec',
  ];
  for (const p of required) {
    assert.ok(
      muxy.permissions.includes(p),
      `missing permission: ${p}`
    );
  }
});

test('permissions array has no duplicates', () => {
  const perms = muxy.permissions;
  assert.equal(new Set(perms).size, perms.length, 'duplicate permission entry');
});

// === events =================================================================

test('has events array with worktree.switched and project.switched', () => {
  assert.ok(Array.isArray(muxy.events), 'events must be an array');
  assert.ok(
    muxy.events.includes('worktree.switched'),
    'worktree.switched event missing'
  );
  assert.ok(
    muxy.events.includes('project.switched'),
    'project.switched event missing'
  );
});

// === panels =================================================================

test('declares the fast-find panel', () => {
  assert.ok(Array.isArray(muxy.panels) && muxy.panels.length > 0);
  const panel = muxy.panels[0];
  assert.equal(panel.id, 'fast-find');
  assert.equal(panel.entry, 'panel.html');
});

test('panel id matches toggle action panel', () => {
  // The toggle command's `action.panel` must reference the same id as
  // the panel entry, otherwise the toggle would no-op.
  const panel = muxy.panels[0];
  const toggle = muxy.commands.find((c) => c.id === 'toggle-fast-find');
  assert.ok(toggle, 'toggle-fast-find command missing');
  assert.equal(toggle.action.panel, panel.id);
});

// === topbar =================================================================

test('topbar command resolves to a real command', () => {
  const topbar = muxy.topbarItems[0];
  const cmd = muxy.commands.find((c) => c.id === topbar.command);
  assert.ok(
    cmd,
    `topbar command ${topbar.command} not found in commands array`
  );
});

// === commands ===============================================================

test('command ids are unique', () => {
  const ids = muxy.commands.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate command id');
});

test('toggle-fast-find has shortcut cmd+shift+f', () => {
  const toggle = muxy.commands.find((c) => c.id === 'toggle-fast-find');
  assert.equal(toggle.defaultShortcut, 'cmd+shift+f');
});

test('focus-fast-find exists', () => {
  // Without a focus command the search bar can't be focused via keybind
  // after a panel is hidden, breaking the search-from-anywhere flow.
  const focus = muxy.commands.find((c) => c.id === 'focus-fast-find');
  assert.ok(focus, 'focus-fast-find command missing');
});

// === shape of every declared entity ========================================

test('description is set', () => {
  assert.ok(typeof muxy.description === 'string' && muxy.description.length > 0);
});

test('panel has a position', () => {
  // Muxy uses position to decide where to mount the panel.
  const panel = muxy.panels[0];
  assert.ok(['left', 'right', 'top', 'bottom'].includes(panel.position),
    `unexpected panel.position: ${panel.position}`);
});

test('topbar item has icon and command', () => {
  const topbar = muxy.topbarItems[0];
  assert.ok(topbar.icon, 'topbar item missing icon');
  assert.ok(topbar.command, 'topbar item missing command');
});

test('refresh-fast-find command exists', () => {
  const refresh = muxy.commands.find((c) => c.id === 'refresh-fast-find');
  assert.ok(refresh, 'refresh-fast-find command missing');
});

test('marketplace block has author and categories', () => {
  assert.ok(muxy.marketplace, 'marketplace block missing');
  assert.ok(muxy.marketplace.author, 'marketplace.author missing');
  assert.ok(Array.isArray(muxy.marketplace.categories), 'categories must be an array');
  assert.ok(muxy.marketplace.categories.includes('search'),
    'marketplace.categories should include "search"');
});

test('topbar tooltip is set', () => {
  const topbar = muxy.topbarItems[0];
  assert.ok(typeof topbar.tooltip === 'string' && topbar.tooltip.length > 0);
});

test('no topbar command references a non-existent command', () => {
  for (const tb of muxy.topbarItems) {
    const cmd = muxy.commands.find((c) => c.id === tb.command);
    assert.ok(cmd, `topbar command ${tb.command} not found in commands array`);
  }
});

test('focus-fast-find has its own shortcut', () => {
  const focus = muxy.commands.find((c) => c.id === 'focus-fast-find');
  assert.ok(focus.defaultShortcut, 'focus-fast-find missing defaultShortcut');
});

test('panel id "fast-find" matches the topbar id', () => {
  // The topbar item and the panel both use the extension's id; this
  // keeps the Muxy chrome (icon, tooltip) tied to the same surface.
  const panel = muxy.panels[0];
  const topbar = muxy.topbarItems[0];
  assert.equal(panel.id, 'fast-find');
  assert.equal(topbar.id, 'fast-find');
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
