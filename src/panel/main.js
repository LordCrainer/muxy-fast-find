// Phase 3 UI layer for fast-find. Owns settings persistence, the debounced
// search pipeline (ripgrep via Phase 2's `runSearch`), the inline preview
// (via Phase 2's `fetchContext`), and the result list DOM. Designed to fail
// closed when Muxy APIs are missing: every muxy.* call is guarded so the panel
// can still load outside the host (e.g. during dev) — the user just gets
// empty results and a status hint.

import { runSearch } from './search.js';
import { fetchContext } from './inline-preview.js';
import { detectRg } from './rg-install.js';
import { resolveRgPath } from './rg-resolve.js';
import { MAX_COLUMNS } from './rg-args.js';
import { relativizePath, absolutizePath, attachAbsolutePaths, formatTime, formatCount, formatFileCount, isTruncated } from './utils.js';
import { loadQueryForScope, saveQueryForScope } from './query-store.js';
import { olog } from './log.js';

// === Constants =============================================================

const STORAGE_KEY = 'fast-find-settings-v1';
const DEBOUNCE_MS = 150;
const RG_PATH_FALLBACK = 'rg';
const PREVIEW_RG_ERROR_TRUNC = 120;
const MAX_INLINE_PREVIEW_LINES = 50;
const INSTALL_CMD = 'brew install ripgrep';
const UPGRADE_CMD = 'brew upgrade ripgrep';

const DEFAULT_SETTINGS = Object.freeze({
  caseMode: 'sensitive',     // 'sensitive' | 'insensitive'
  regexMode: 'regex',        // 'regex' | 'literal'
  includeGlobs: '',
  hidden: false,
  noIgnore: false,
  contextLines: 3,
});

// === State =================================================================
// All mutable runtime lives here. Keeps the rest of the module closure-free.

const muxy = (typeof window !== 'undefined' && window.muxy) ? window.muxy : null;

const state = {
  querySeq: 0,           // bumped on every search; stale results bail out
  previewSeq: 0,         // same idea for the inline-preview fetch
  rgPath: RG_PATH_FALLBACK,
  rgVersion: null,       // null until detectRg resolves; the empty state's
                         // empty-state copy is gated on this being set.
  rgReady: false,        // true when rg exists and meets the version floor
  scope: null,
  settings: { ...DEFAULT_SETTINGS },
  currentQuery: '',
  results: [],
  lastResult: null,
  expandedIndex: -1,
  previewLoading: -1,
  previewCache: new Map(),
  switchingScope: false, // blocks input saves during scope transitions;
                         // flipped on at the start of onScopeChanged and
                         // cleared after the new scope's saved query is
                         // loaded, so a stray keystroke in the transition
                         // window can't store the OLD project's query
                         // under the NEW project's key.
};

let debounceTimer = null;
let cleanupFns = [];

// === Element refs ==========================================================
// Centralized at the top so the rest of the file is purely functional.

const els = {
  search: document.getElementById('search'),
  caseToggle: document.getElementById('case-toggle'),
  literalToggle: document.getElementById('literal-toggle'),
  settingsToggle: document.getElementById('settings-toggle'),
  settingsPopover: document.getElementById('settings-popover'),
  settingGlobs: document.getElementById('setting-globs'),
  settingHidden: document.getElementById('setting-hidden'),
  settingNoIgnore: document.getElementById('setting-no-ignore'),
  settingContext: document.getElementById('setting-context'),
  status: document.getElementById('status'),
  results: document.getElementById('results'),
  scopeIndicator: document.getElementById('scope-indicator'),
  scopePath: document.getElementById('scope-path'),
};

// Guard: if the HTML didn't load (e.g. previewing this file standalone), bail
// out without throwing — `init()` will report a clean status message.
const HAS_DOM = Boolean(els.search && els.status && els.results);

// === Settings persistence ==================================================

function loadSettings() {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_SETTINGS };
  let raw;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { return { ...DEFAULT_SETTINGS }; }
  if (!raw) return { ...DEFAULT_SETTINGS };
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { ...DEFAULT_SETTINGS }; }
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...parsed };
}

function saveSettings() {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings)); }
  catch { /* quota or disabled storage — ignore */ }
}

function applySettingsToUI() {
  if (!HAS_DOM) return;
  els.settingGlobs.value = state.settings.includeGlobs || '';
  els.settingHidden.checked = Boolean(state.settings.hidden);
  els.settingNoIgnore.checked = Boolean(state.settings.noIgnore);
  els.settingContext.value = String(state.settings.contextLines);
  els.caseToggle.classList.toggle('active', state.settings.caseMode === 'insensitive');
  els.caseToggle.setAttribute('aria-pressed', String(state.settings.caseMode === 'insensitive'));
  els.literalToggle.classList.toggle('active', state.settings.regexMode === 'literal');
  els.literalToggle.setAttribute('aria-pressed', String(state.settings.regexMode === 'literal'));
}

function readSettingsFromUI() {
  if (!HAS_DOM) return;
  state.settings.includeGlobs = els.settingGlobs.value || '';
  state.settings.hidden = Boolean(els.settingHidden.checked);
  state.settings.noIgnore = Boolean(els.settingNoIgnore.checked);
  const ctxRaw = parseInt(els.settingContext.value, 10);
  state.settings.contextLines = Number.isFinite(ctxRaw) && ctxRaw > 0 ? ctxRaw : 3;
}

function globsArray() {
  return (state.settings.includeGlobs || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// === Host integration =======================================================

async function resolveScope() {
  if (!muxy) return null;
  if (muxy.worktrees && typeof muxy.worktrees.list === 'function') {
    try {
      const wts = await muxy.worktrees.list();
      if (Array.isArray(wts) && wts.length > 0) {
        const active = wts.find((w) => w && w.isActive)
                    || wts.find((w) => w && w.isCurrent)
                    || wts.find((w) => w && w.active)
                    || wts[0];
        if (active && (active.path || active.root)) {
          return active.path || active.root;
        }
      }
    } catch { /* fall through to git */ }
  }
  if (muxy.git && typeof muxy.git.repoInfo === 'function') {
    try {
      const info = await muxy.git.repoInfo();
      if (info && info.root) return info.root;
    } catch { /* no git context */ }
  }
  return null;
}

function toast(title, variant = 'info') {
  if (!muxy || typeof muxy.toast !== 'function') return;
  try { muxy.toast({ title, variant }); } catch { /* swallow */ }
}

function safeSubscribe(event, handler) {
  if (!muxy || !muxy.events || typeof muxy.events.subscribe !== 'function') return;
  try {
    muxy.events.subscribe(event, handler);
    cleanupFns.push(() => {
      try { muxy.events.unsubscribe && muxy.events.unsubscribe(event, handler); }
      catch { /* ignore */ }
    });
  } catch { /* ignore */ }
}

// === Status + spinner =======================================================

function renderStatus(text, kind = 'info') {
  if (!HAS_DOM) return;
  els.status.textContent = text;
  els.status.className = `status ${kind}`;
}

// Renders the current project/worktree path into the always-visible
// scope indicator above the status bar. The `in` prefix is a tiny
// bit of affordance — it reads naturally as "in /Users/.../fast-find"
// instead of a naked path. `textContent` everywhere because the path
// comes from the host's worktree API (untrusted in principle).
function renderScopeIndicator() {
  if (!els.scopeIndicator || !els.scopePath) return; // defensive
  if (!state.scope) {
    els.scopePath.textContent = 'no project detected';
    els.scopePath.classList.add('scope-empty');
    els.scopeIndicator.removeAttribute('title');
    return;
  }
  els.scopePath.classList.remove('scope-empty');
  els.scopePath.textContent = state.scope;
  els.scopeIndicator.title = `Click to copy full path\n${state.scope}`;
}

// === DOM helpers ===========================================================

function displayPath(p) {
  return relativizePath(p, state.scope);
}

// Splits `text` into an ordered list of {tag, content} pieces, where
// `tag === 'mark'` is a submatch highlight. Overlapping or out-of-range
// submatches are dropped defensively (rg shouldn't produce them, but a
// truncated JSON buffer could).
function splitBySubmatches(text, submatches) {
  if (!text) return [];
  if (!Array.isArray(submatches) || submatches.length === 0) {
    return [{ tag: 'text', content: text }];
  }
  const sorted = [...submatches].sort((a, b) => a.start - b.start);
  const parts = [];
  let cursor = 0;
  for (const s of sorted) {
    if (!s || typeof s.start !== 'number' || typeof s.end !== 'number') continue;
    if (s.start < cursor || s.end > text.length || s.end < s.start) continue;
    if (s.start > cursor) {
      parts.push({ tag: 'text', content: text.slice(cursor, s.start) });
    }
    parts.push({ tag: 'mark', content: text.slice(s.start, s.end) });
    cursor = s.end;
  }
  if (cursor < text.length) {
    parts.push({ tag: 'text', content: text.slice(cursor) });
  }
  return parts;
}

function buildPreviewLine(line, isMatch) {
  const div = document.createElement('div');
  div.className = 'preview-line' + (isMatch ? ' match' : '');
  const num = document.createElement('span');
  num.className = 'preview-line-num';
  num.textContent = String(line.line);
  const txt = document.createElement('span');
  txt.className = 'preview-line-text';
  txt.textContent = line.text;
  div.appendChild(num);
  div.appendChild(txt);
  return div;
}

function buildPreviewLoading() {
  const div = document.createElement('div');
  div.className = 'preview-loading';
  div.textContent = 'Loading preview…';
  return div;
}

function buildPreviewMessage(text, kind = 'empty') {
  const div = document.createElement('div');
  div.className = `preview-empty ${kind}`;
  div.textContent = text;
  return div;
}

function renderPreviewInto(container, result, match) {
  container.replaceChildren();
  if (result.kind === 'ok') {
    const lines = result.lines.slice(0, MAX_INLINE_PREVIEW_LINES);
    for (const line of lines) {
      container.appendChild(buildPreviewLine(line, line.line === result.matchLine));
    }
    return;
  }
  if (result.kind === 'binary') {
    container.appendChild(buildPreviewMessage('Binary file — no preview', 'binary'));
    return;
  }
  if (result.kind === 'stale') {
    container.appendChild(buildPreviewMessage('File no longer exists or is unreadable', 'stale'));
    return;
  }
  container.appendChild(buildPreviewMessage('File is empty or unreadable', 'unreadable'));
}

function buildResultRow(match, index) {
  const li = document.createElement('li');
  li.className = 'result-row';
  li.setAttribute('role', 'option');
  li.setAttribute('tabindex', '0');
  li.setAttribute('data-index', String(index));
  li.setAttribute('aria-selected', String(index === state.expandedIndex));
  li.id = `result-${index}`;

  // Header: dim path + bright location
  const header = document.createElement('div');
  header.className = 'result-header';
  const pathSpan = document.createElement('span');
  pathSpan.className = 'result-path';
  pathSpan.textContent = displayPath(match.path || '');
  pathSpan.title = match.path || '';
  const locSpan = document.createElement('span');
  locSpan.className = 'result-loc';
  locSpan.textContent = `:${match.line}:${match.column}`;
  const openBtn = document.createElement('button');
  openBtn.className = 'result-open';
  openBtn.type = 'button';
  openBtn.setAttribute('aria-label', 'Open file in editor');
  openBtn.textContent = '↗';
  header.appendChild(pathSpan);
  header.appendChild(locSpan);
  header.appendChild(openBtn);
  li.appendChild(header);

  // Content: matched line with <mark> highlights
  const content = document.createElement('div');
  content.className = 'result-content';
  for (const part of splitBySubmatches(match.text, match.submatches)) {
    if (part.tag === 'mark') {
      const m = document.createElement('mark');
      m.textContent = part.content;
      content.appendChild(m);
    } else {
      const t = document.createElement('span');
      t.textContent = part.content;
      content.appendChild(t);
    }
  }
  // Truncation indicator. rg caps each line at MAX_COLUMNS (default 200);
  // any line that hits the cap *may* have been cut. `isTruncated` uses `>=`
  // (not `===`) as a deliberate over-approximation: a 201-char line is
  // definitely truncated, and a 200-char line is suspiciously round.
  // False positives are cheap (just an italic "… (truncated)" hint); false
  // negatives would hide real truncation.
  if (isTruncated(match.text)) {
    const trunc = document.createElement('span');
    trunc.className = 'truncation-indicator';
    trunc.textContent = '… (truncated)';
    content.appendChild(trunc);
  }
  li.appendChild(content);

  // Inline preview (only on the expanded row)
  if (index === state.expandedIndex) {
    const preview = document.createElement('div');
    preview.className = 'inline-preview';
    preview.setAttribute('data-preview-for', String(index));
    const cached = state.previewCache.get(index);
    if (cached) {
      renderPreviewInto(preview, cached, match);
    } else {
      preview.appendChild(buildPreviewLoading());
    }
    li.appendChild(preview);
  }

  return li;
}

function renderResults(matches) {
  if (!HAS_DOM) return;
  els.results.replaceChildren();
  if (!Array.isArray(matches) || matches.length === 0) return;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < matches.length; i += 1) {
    frag.appendChild(buildResultRow(matches[i], i));
  }
  els.results.appendChild(frag);
}

function renderEmpty(message, kind = 'empty') {
  if (!HAS_DOM) return;
  const div = document.createElement('div');
  div.className = `empty ${kind}`;
  div.textContent = message;
  els.results.replaceChildren(div);
}

function renderNoMatches(query) {
  if (!HAS_DOM) return;
  const div = document.createElement('div');
  div.className = 'empty';
  // Use textContent to avoid any HTML injection from the query (though the
  // query comes from the user's own input, defense-in-depth).
  div.textContent = `No matches for "${query}"`;
  els.results.replaceChildren(div);
}

function renderErrorInline(message) {
  if (!HAS_DOM) return;
  const div = document.createElement('div');
  div.className = 'empty error-text';
  div.textContent = message;
  els.results.replaceChildren(div);
}

// === rg install/upgrade prompt =============================================
// Shown when detectRg reports the binary is missing or below the version
// floor. Replaces the normal empty state and disables the search input
// because nothing useful can happen until the user installs/upgrades.

/**
 * Write `text` to the system clipboard with a textarea fallback for
 * non-secure contexts (e.g. file:// in dev). Returns true on success.
 *
 * @param {string} text
 * @returns {boolean}
 */
function copyToClipboard(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  // Preferred path: async Clipboard API. Never rejects in practice but we
  // wrap in try/catch because some sandboxes disable it.
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to the textarea fallback
    }
  }
  // Fallback: hidden textarea + execCommand('copy'). Synchronous and
  // works in non-secure contexts where the async API is gated.
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(ta);
    return Boolean(ok);
  } catch {
    return false;
  }
}

/**
 * Build a "ripgrep required / out of date" empty state with a copy-to-
 * clipboard button. The command is held in a data-attribute so the click
 * handler can read it back without closures over the install command.
 *
 * @param {Object} cfg
 * @param {string} cfg.title
 * @param {string} cfg.body
 * @param {string} cfg.command — shell command to copy
 * @param {string} cfg.copyId — DOM id for the copy button
 * @param {string} [cfg.hint]
 * @returns {HTMLDivElement}
 */
function buildRgPromptEl({ title, body, command, copyId, hint }) {
  const wrap = document.createElement('div');
  wrap.className = 'empty empty-rg-prompt';

  const titleEl = document.createElement('div');
  titleEl.className = 'empty-title';
  titleEl.textContent = title;

  const bodyEl = document.createElement('div');
  bodyEl.className = 'empty-body';
  bodyEl.textContent = body;

  const codeRow = document.createElement('div');
  codeRow.className = 'empty-code';

  const codeEl = document.createElement('code');
  codeEl.textContent = command;

  const copyBtn = document.createElement('button');
  copyBtn.id = copyId;
  copyBtn.className = 'icon-button copy-button';
  copyBtn.type = 'button';
  copyBtn.setAttribute('aria-label', 'Copy install command');
  copyBtn.setAttribute('data-copy-cmd', command);
  copyBtn.textContent = '⧉';

  codeRow.appendChild(codeEl);
  codeRow.appendChild(copyBtn);

  wrap.appendChild(titleEl);
  wrap.appendChild(bodyEl);
  wrap.appendChild(codeRow);

  if (hint) {
    const hintEl = document.createElement('div');
    hintEl.className = 'empty-hint';
    hintEl.textContent = hint;
    wrap.appendChild(hintEl);
  }

  return wrap;
}

/**
 * Show the ripgrep install/upgrade prompt. Called once during init when
 * `detectRg` returns `{ ok: false }`. Subsequent invocations are a no-op
 * because the empty state is already mounted.
 *
 * @param {'not-found'|'too-old'|'error'} reason
 * @param {string} stderr
 */
function renderRgMissing(reason, stderr) {
  if (!HAS_DOM) return;

  // Defensive: command strings are hardcoded constants (not user input),
  // but we use textContent everywhere so they're rendered as plain text
  // and never interpreted as HTML even if a future change makes them
  // configurable.
  if (reason === 'too-old') {
    els.results.replaceChildren(
      buildRgPromptEl({
        title: 'ripgrep is out of date',
        body: stderr || 'Your ripgrep is below the minimum version.',
        command: UPGRADE_CMD,
        copyId: 'copy-upgrade-cmd',
        hint: 'Then restart Muxy.',
      })
    );
  } else {
    // 'not-found' and 'error' share the same install prompt. The stderr
    // detail is surfaced in the body for diagnosis. For 'not-found' we
    // also append a "if you have rg already" hint — rg is often installed
    // but in a directory Muxy's exec sandbox can't see (e.g. on macOS:
    // /opt/homebrew/bin/rg, /usr/local/bin/rg).
    const hint = reason === 'not-found'
      ? 'Then restart Muxy. If you already have rg installed, check that it lives at /opt/homebrew/bin/rg, /usr/local/bin/rg, or /usr/bin/rg.'
      : 'Then restart Muxy.';
    els.results.replaceChildren(
      buildRgPromptEl({
        title: 'ripgrep required',
        body: stderr ? `Install with (reason: ${stderr})` : 'Install with:',
        command: INSTALL_CMD,
        copyId: 'copy-install-cmd',
        hint,
      })
    );
  }
}

/**
 * Click handler for the copy buttons inside the rg-prompt empty state.
 * Delegated to `els.results` so it works even after `replaceChildren`.
 * Kept separate from `onResultClick` so the row-toggle logic doesn't
 * see the button click (it wouldn't match `.result-row` anyway, but
 * keeping the concerns split makes both handlers easier to reason about).
 */
function onCopyButtonClick(e) {
  const btn = e.target.closest('[data-copy-cmd]');
  if (!btn) return;
  e.stopPropagation();
  const cmd = btn.getAttribute('data-copy-cmd') || '';
  const ok = copyToClipboard(cmd);
  if (ok) {
    toast(`Copied: ${cmd}`, 'info');
  } else {
    toast('Copy failed — select the command manually', 'warn');
  }
}

/**
 * Click handler for the per-row "Open" button on the result header.
 * Mirrors `onCopyButtonClick`: delegated to `els.results` so the listener
 * stays alive across `replaceChildren` (every new result-list render
 * destroys the old buttons). The button handles its own click — we
 * stopPropagation so `onResultClick` (the row-toggle handler) does NOT
 * see this click and collapse the preview. Keyboard activation on the
 * button is handled by the browser's native button click (Enter/Space
 * fire `click`), so no keydown handler is needed here.
 */
function onOpenButtonClick(e) {
  const btn = e.target.closest('.result-open');
  if (!btn) return;
  e.stopPropagation();
  const row = btn.closest('.result-row');
  if (!row) return;
  const index = Number(row.dataset.index);
  if (Number.isNaN(index)) return;
  const match = state.results[index];
  if (match) openInEditor(match);
}

// === Inline preview fetch ==================================================

async function loadPreview(index, match) {
  if (!muxy || typeof muxy.exec !== 'function') return;
  if (state.previewLoading === index) return;

  const mySeq = ++state.previewSeq;
  state.previewLoading = index;

  let result;
  try {
    result = await fetchContext(muxy, {
      filePath: match.path,
      line: match.line,
      contextLines: state.settings.contextLines,
      repoRoot: state.scope || '.',
    });
  } catch {
    result = { kind: 'stale' };
  }

  if (mySeq !== state.previewSeq) return; // a newer preview superseded us
  state.previewLoading = -1;
  state.previewCache.set(index, result);

  // Preview-load log. Gated on rg-ready to match the rest of the
  // log surface; the preview pipeline runs even when rg is missing
  // (binary files, deleted files), but the log channel is dedicated
  // to the search path and stays quiet until rg is up.
  if (state.rgReady) {
    olog('debug', 'preview.load',
      'filePath=' + (match.path || ''),
      'line=' + match.line,
      'kind=' + result.kind);
  }

  // Only paint if the row is still expanded
  if (state.expandedIndex !== index || !HAS_DOM) return;
  const row = els.results.querySelector(`[data-index="${index}"]`);
  if (!row) return;
  const preview = row.querySelector('.inline-preview');
  if (!preview) return;
  renderPreviewInto(preview, result, match);
}

function collapseRow(index) {
  if (index < 0 || !HAS_DOM) return;
  const row = els.results.querySelector(`[data-index="${index}"]`);
  if (!row) return;
  const preview = row.querySelector('.inline-preview');
  if (preview) preview.remove();
  row.setAttribute('aria-selected', 'false');
}

function expandRow(index) {
  if (index < 0 || !HAS_DOM) return;
  const row = els.results.querySelector(`[data-index="${index}"]`);
  if (!row) return;
  row.setAttribute('aria-selected', 'true');
  const preview = document.createElement('div');
  preview.className = 'inline-preview';
  preview.setAttribute('data-preview-for', String(index));
  const cached = state.previewCache.get(index);
  const match = state.results[index];
  if (cached) {
    renderPreviewInto(preview, cached, match);
  } else {
    preview.appendChild(buildPreviewLoading());
  }
  row.appendChild(preview);
  if (!cached && match) loadPreview(index, match);
}

// === Result interactions ===================================================

function togglePreview(index) {
  if (index < 0) return;
  const prev = state.expandedIndex;
  state.expandedIndex = (prev === index) ? -1 : index;
  if (prev !== -1 && prev !== state.expandedIndex) collapseRow(prev);
  if (state.expandedIndex === index) expandRow(index);
}

function onResultClick(e) {
  const row = e.target.closest('.result-row');
  if (!row) return;
  // The "Open" button handles its own click and stopPropagation's it,
  // but as a belt-and-braces guard, bail here too. Without this, if
  // stopPropagation is ever forgotten in onOpenButtonClick, the preview
  // would toggle AND the editor would open.
  if (e.target.closest('.result-open')) return;
  const index = parseInt(row.getAttribute('data-index'), 10);
  if (Number.isNaN(index)) return;
  togglePreview(index);
}

function onResultKeydown(e) {
  // Buttons handle their own Enter/Space via the browser's native
  // click synthesis; bail so we don't double-fire togglePreview.
  if (e.target.closest('button')) return;
  if (e.key !== 'Enter') return;
  const row = e.target.closest('.result-row');
  if (!row) return;
  e.preventDefault();
  const index = Number(row.dataset.index);
  if (Number.isNaN(index)) return;
  if (e.metaKey || e.ctrlKey) {
    openInEditor(state.results[index]);
  } else {
    togglePreview(index);
  }
}

async function openInEditor(match) {
  if (!muxy || !muxy.tabs || typeof muxy.tabs.open !== 'function') {
    toast("Cannot open editor — Muxy tabs API unavailable", 'warn');
    return;
  }
  // Hard requirement: every match from a successful search has absPath.
  // A missing absPath means the search augmentation didn't run (or the
  // match came from a stale state). Failing loud here prevents the
  // "wrong file" or "no such file" error that would otherwise surface
  // from the files extension.
  if (!match || typeof match.absPath !== 'string') {
    if (state.rgReady) {
      olog('warn', 'open.noAbsPath', 'path=' + (match && match.path));
    }
    toast('Cannot open file — path data is missing', 'warn');
    return;
  }
  try {
    if (state.rgReady) {
      olog('debug', 'editor.open', 'path=' + match.absPath, 'line=' + match.line);
    }
    if (state.rgReady) {
      olog('info', 'editor.open.attempt', 'absPath=' + match.absPath, 'relative=' + (match.path || '<none>'), 'scope=' + (state.scope || '<none>'));
    }
    await muxy.tabs.open({
      kind: 'extensionWebView',
      extension: {
        id: 'files',
        tabType: 'code-editor',
        singleton: true,
        data: {
          filePath: match.absPath,
          line: match.line,
          column: match.column,
          replaceable: true,
        },
      },
    });
  } catch (err) {
    // Surface the real error so we can tell apart "files extension not
    // installed" from "file not found at that path". The old catch-all
    // hid the underlying message and made both look like a missing
    // extension.
    const detail = (err && (err.message || String(err))) || 'unknown error';
    if (state.rgReady) {
      olog('error', 'editor.open.failed', 'path=' + match.absPath, 'error=' + detail);
    }
    toast(`Cannot open file: ${detail}`, 'error');
  }
}

// === Settings popover ======================================================

function isPopoverOpen() {
  return HAS_DOM && !els.settingsPopover.classList.contains('hidden');
}

function setPopoverOpen(open) {
  if (!HAS_DOM) return;
  els.settingsPopover.classList.toggle('hidden', !open);
}

function togglePopover() {
  setPopoverOpen(!isPopoverOpen());
}

// === Event wiring ==========================================================

function onSearchInput() {
  // During a scope transition, els.search.value is being mutated by
  // onScopeChanged (saving the old query, loading the new one). Saving
  // during this window would store the OLD project's query under the
  // NEW project's key. Block all input handlers until the transition
  // is complete.
  if (state.switchingScope) return;
  const query = els.search.value;
  state.currentQuery = query;
  saveQueryForScope(query, state.scope);
  scheduleSearch();
}

function onSearchKeydown(e) {
  // Enter on the search input fires the search immediately, bypassing
  // the 150ms debounce. Escape falls through to the document handler
  // so the empty-input / collapse-preview behavior still works.
  if (e.key !== 'Enter') return;
  if (state.switchingScope) return;
  e.preventDefault();
  clearTimeout(debounceTimer);
  executeSearch();
}

function onCaseToggle() {
  const prev = state.settings.caseMode;
  state.settings.caseMode = state.settings.caseMode === 'sensitive' ? 'insensitive' : 'sensitive';
  applySettingsToUI();
  saveSettings();
  if (state.rgReady) olog('debug', 'settings.case', prev + '->' + state.settings.caseMode);
  scheduleSearch();
}

function onLiteralToggle() {
  const prev = state.settings.regexMode;
  state.settings.regexMode = state.settings.regexMode === 'regex' ? 'literal' : 'regex';
  applySettingsToUI();
  saveSettings();
  if (state.rgReady) olog('debug', 'settings.literal', prev + '->' + state.settings.regexMode);
  scheduleSearch();
}

function onSettingChange() {
  readSettingsFromUI();
  saveSettings();
  // Clear cached previews — context-line count may have changed
  state.previewCache.clear();
  if (state.rgReady) {
    olog('debug', 'settings.changed',
      'globs=' + JSON.stringify(state.settings.includeGlobs || ''),
      'hidden=' + state.settings.hidden,
      'noIgnore=' + state.settings.noIgnore,
      'contextLines=' + state.settings.contextLines);
  }
  scheduleSearch();
}

function onDocumentClick(e) {
  if (!isPopoverOpen()) return;
  if (e.target.closest('#settings-popover')) return;
  if (e.target.closest('#settings-toggle')) return;
  setPopoverOpen(false);
}

function onDocumentKeydown(e) {
  if (e.key === 'Escape') {
    if (isPopoverOpen()) { setPopoverOpen(false); return; }
    if (state.expandedIndex !== -1) {
      const prev = state.expandedIndex;
      state.expandedIndex = -1;
      collapseRow(prev);
    }
  }
}

function onBeforeUnload() {
  clearTimeout(debounceTimer);
  for (const fn of cleanupFns) {
    try { fn(); } catch { /* ignore */ }
  }
  cleanupFns = [];
}

// === Search pipeline =======================================================

function scheduleSearch() {
  clearTimeout(debounceTimer);
  renderStatus('Searching…', 'searching');

  debounceTimer = setTimeout(executeSearch, DEBOUNCE_MS);
}

async function executeSearch() {
  const mySeq = ++state.querySeq;
  const query = els.search.value;
  state.currentQuery = query;
  state.expandedIndex = -1;
  state.previewCache.clear();

  // Search-start log. The early-exit guard ensures we don't spam the
  // log when rg is missing — `executeSearch` shouldn't be reachable in
  // that case (the input is disabled), but the guard is cheap and
  // defends against race conditions like the user clicking Settings
  // before init() completes.
  if (state.rgReady) {
    olog('debug', 'search.start',
      'query=' + JSON.stringify(query),
      'scope=' + (state.scope || '<none>'),
      'rgVersion=' + state.rgVersion);
  }

  // Guard: no scope at all → show a deterministic empty state, never invoke rg
  if (!state.scope) {
    finishEmptyScope(mySeq);
    return;
  }

  // Guard: no query → empty state, no rg call
  if (!query) {
    finishNoQuery(mySeq);
    return;
  }

  let result;
  try {
    result = await runSearch(muxy, {
      query,
      scope: state.scope,
      rgPath: state.rgPath,
      rgVersion: state.rgVersion,
      caseMode: state.settings.caseMode,
      regexMode: state.settings.regexMode,
      includeGlobs: globsArray(),
      hidden: state.settings.hidden,
      noIgnore: state.settings.noIgnore,
      querySeq: mySeq,
      getCurrentSeq: () => state.querySeq,
    });
  } catch (e) {
    result = {
      aborted: false,
      error: 'unknown',
      message: (e && e.message) || String(e),
    };
  }

  if (mySeq !== state.querySeq) return; // superseded — drop the result

  if (result.aborted) return;

  // Search-error log. Centralized here so every failure mode funnels
  // through one call site. Environmental / user-actionable kinds
  // (no-scope, invalid-query, exec-failed) log at `warn` so a grep on
  // `\[fastFind\] error` only surfaces things that look like real bugs
  // (rg-error, unknown). The dedicated `finish*` functions below still
  // own the user-facing copy (status, toast, inline message).
  if (result.error && state.rgReady) {
    const level = result.error === 'rg-error' || result.error === 'unknown' ? 'error' : 'warn';
    const parts = ['search.error', 'kind=' + result.error];
    if (result.message) parts.push('message=' + String(result.message).slice(0, 200));
    olog(level, ...parts);
  }

  state.lastResult = result;
  // Augment matches with absPath (relative path joined with the scope
  // rg actually ran against). We use `result.stats.scope` because
  // `runSearch` may have resolved a different scope than the one we
  // passed in (worktree fallback); downstream code (`openInEditor`,
  // preview) trusts `absPath` as the canonical "open this file"
  // path, so it must be computed from the same scope the matches
  // came from. Error paths and the initial empty state still leave
  // `state.results = []` untouched — only the success path augments.
  const searchScope = result.stats && result.stats.scope ? result.stats.scope : state.scope;
  state.results = attachAbsolutePaths(result.matches || [], searchScope);

  // Error branches — each one clears results and surfaces the failure in
  // its appropriate channel (inline vs toast).
  if (result.error === 'no-scope') { finishErrorNoScope(); return; }
  if (result.error === 'invalid-query') { finishErrorInvalidQuery(); return; }
  if (result.error === 'exec-failed') { finishErrorExecFailed(); return; }
  if (result.error === 'rg-error') { finishErrorRg(result.message); return; }
  if (result.error === 'unknown') { finishErrorUnknown(result.message); return; }

  // Success path
  finishSuccess(result.stats);
}

function finishEmptyScope() {
  state.results = [];
  renderStatus('No worktree detected. Open inside a git repo.', 'warn');
  renderEmpty('No worktree detected');
}

function finishNoQuery() {
  state.results = [];
  renderStatus('Type to search', 'info');
  renderEmpty('Type to search');
}

function finishErrorNoScope() {
  state.results = [];
  renderStatus('No worktree detected. Open inside a git repo.', 'warn');
  renderEmpty('No worktree detected');
}

function finishErrorInvalidQuery() {
  state.results = [];
  renderStatus('Invalid query', 'error');
  renderEmpty('Invalid query');
}

function finishErrorExecFailed() {
  state.results = [];
  toast("Permission denied. Allow fast-find to run ripgrep.", 'error');
  renderStatus('Permission denied', 'error');
  renderErrorInline('Search blocked — check Muxy permissions');
}

function finishErrorRg(message) {
  const msg = (message || 'unknown').slice(0, PREVIEW_RG_ERROR_TRUNC);
  toast(`ripgrep error: ${msg}`, 'error');
  renderStatus('Search error — previous results shown', 'error');
  renderErrorInline(`ripgrep error: ${msg} — previous results shown`);
}

function finishErrorUnknown(message) {
  state.results = [];
  toast('Search failed', 'error');
  renderStatus('Search failed', 'error');
  const msg = (message || '').slice(0, PREVIEW_RG_ERROR_TRUNC);
  renderErrorInline(msg ? `Search failed: ${msg}` : 'Search failed');
}

function finishSuccess(stats) {
  const count = state.results.length;
  const query = state.currentQuery;
  if (count === 0) {
    renderStatus(`No matches for "${query}"`, 'info');
    renderNoMatches(query);
    return;
  }
  const parts = [formatCount(count)];
  if (stats && typeof stats.filesCount === 'number') {
    parts.push(formatFileCount(stats.filesCount));
  }
  if (stats && typeof stats.durationMs === 'number') {
    parts.push(formatTime(stats.durationMs));
  }
  renderStatus(parts.join(' · '), 'info');
  renderResults(state.results);
}

// === Event subscriptions ===================================================

async function reRunSearch() {
  if (!state.currentQuery) return;
  scheduleSearch();
}

function focusSearch() {
  if (!HAS_DOM) return;
  els.search.focus();
  els.search.select();
}

async function onScopeChanged() {
  // Per-project query persistence. We:
  //   1. Clear any pending debounced search (B1)
  //   2. Set switchingScope = true to block input handlers (B1)
  //   3. Save the current query under the OLD scope's key
  //   4. Reset all session state synchronously
  //   5. Await resolveScope()
  //   6. Clear switchingScope
  //   7. Load the NEW scope's saved query into the input
  // The order matters: if any step fails or is interrupted, the worst
  // case is a stale query in the input — never a cross-project leak.
  const oldScope = state.scope;
  const oldQuery = els.search ? els.search.value : '';
  clearTimeout(debounceTimer);
  state.switchingScope = true;
  state.querySeq++;
  state.previewSeq++;
  state.results = [];
  state.expandedIndex = -1;
  state.previewCache.clear();
  state.previewLoading = -1;
  state.lastResult = null;

  // Persist the OLD query before we touch the input.
  saveQueryForScope(oldQuery, oldScope);

  // Clear the input DOM and state. We do this AFTER save so the
  // save can read the value before we wipe it.
  if (els.search) els.search.value = '';
  state.currentQuery = '';

  state.scope = await resolveScope();
  renderScopeIndicator();
  state.switchingScope = false;

  // Load the NEW scope's saved query (if any) into the input.
  // Restored queries do NOT auto-search — the user must act.
  const restored = loadQueryForScope(state.scope);
  if (els.search) {
    els.search.value = restored;
    state.currentQuery = restored;
  }

  if (state.rgReady) {
    olog('info', 'worktree.switched',
      'old=' + (oldScope || '<none>'),
      'new=' + (state.scope || '<none>'),
      'restored=' + (restored ? 'yes' : 'no'));
  }

  if (!state.scope) {
    renderStatus('No worktree detected. Open inside a git repo.', 'warn');
    renderEmpty('No worktree detected');
  } else {
    renderStatus('Type to search', 'info');
    renderEmpty('Type to search');
  }
}

// === Init ==================================================================

async function init() {
  if (!HAS_DOM) return; // HTML not present — nothing to wire

  // 1. Load + apply settings
  state.settings = loadSettings();
  applySettingsToUI();

  // 2. Resolve host dependencies
  state.rgPath = await resolveRgPath(muxy, RG_PATH_FALLBACK);
  state.scope = await resolveScope();
  renderScopeIndicator();
  // Restore the last query this scope used (if any). The input is
  // populated but `scheduleSearch()` is NOT called — the user must
  // press Enter or type to fire a search. Auto-running on load would
  // surprise users who closed the panel mid-search and expect a
  // blank slate when they re-open it.
  const savedQuery = loadQueryForScope(state.scope);
  if (savedQuery && els.search) {
    els.search.value = savedQuery;
    state.currentQuery = savedQuery;
  }

  // 3. Detect ripgrep (Phase 4). Runs after resolveRgPath so we can probe
  //    the actual binary, not just whatever's on $PATH. Cached on state so
  //    every search knows whether to pass rgVersion through to buildArgv
  //    and whether to gate the UI on rg being present.
  if (muxy) {
    const rgCheck = await detectRg(muxy, state.rgPath);
    if (rgCheck.ok) {
      state.rgVersion = rgCheck.version;
      state.rgReady = true;
    } else {
      state.rgVersion = null;
      state.rgReady = false;
      // Stash for the empty state / toast.
      state.rgIssue = { reason: rgCheck.reason, stderr: rgCheck.stderr };
    }
  }

  // 4. Subscribe to Muxy events
  safeSubscribe('command.refresh-fast-find', reRunSearch);
  safeSubscribe('command.focus-fast-find', focusSearch);
  safeSubscribe('worktree.switched', onScopeChanged);
  safeSubscribe('project.switched', onScopeChanged);

  // 5. Wire DOM events
  els.search.addEventListener('input', onSearchInput);
  els.search.addEventListener('keydown', onSearchKeydown);
  els.caseToggle.addEventListener('click', onCaseToggle);
  els.literalToggle.addEventListener('click', onLiteralToggle);
  els.settingsToggle.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePopover();
  });
  els.settingGlobs.addEventListener('input', onSettingChange);
  els.settingHidden.addEventListener('change', onSettingChange);
  els.settingNoIgnore.addEventListener('change', onSettingChange);
  els.settingContext.addEventListener('change', onSettingChange);
  els.results.addEventListener('click', onResultClick);
  // Delegated copy-button handler for the rg-prompt empty state. Added
  // alongside the row-click handler because the button lives inside
  // `els.results` and is recreated on every `replaceChildren` — event
  // delegation is the only way to keep the listener alive.
  els.results.addEventListener('click', onCopyButtonClick);
  // Delegated handler for the per-row "Open" button. Same rationale as
  // onCopyButtonClick: the button is destroyed and re-created on every
  // result-list render, so a delegated listener is the only way to
  // survive `replaceChildren`. The handler stopPropagation's the click
  // so onResultClick does not also toggle the preview.
  els.results.addEventListener('click', onOpenButtonClick);
  els.results.addEventListener('keydown', onResultKeydown);
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
  window.addEventListener('beforeunload', onBeforeUnload);

  // Click-to-copy the project path. The indicator is a separate element
  // so a direct listener (not delegated) is the right fit. We use the
  // existing `copyToClipboard` helper (textarea fallback for non-secure
  // contexts) and surface the result via toast — same UX as the
  // install-command copy buttons below.
  if (els.scopeIndicator) {
    els.scopeIndicator.addEventListener('click', async () => {
      if (!state.scope) return;
      const ok = copyToClipboard(state.scope);
      toast(ok ? 'Path copied' : 'Copy failed', ok ? 'info' : 'error');
    });
  }

  // 6. Initial render + focus
  if (!muxy) {
    renderStatus('Open this panel inside Muxy to search files', 'warn');
    renderEmpty('Muxy host not available');
    return;
  }
  if (!state.rgReady) {
    // rg missing or too old. The empty state itself is the actionable
    // surface; the toast is a one-time nudge. We also disable the input
    // because there's no point accepting keystrokes we can't act on.
    const issue = state.rgIssue || { reason: 'error', stderr: 'unknown' };
    renderStatus('ripgrep required', 'warn');
    renderRgMissing(issue.reason, issue.stderr);
    toast('ripgrep required — see empty state', 'warn');
    els.search.disabled = true;
    els.search.setAttribute('aria-disabled', 'true');
    els.search.title = state.rgIssue && state.rgIssue.reason === 'too-old'
      ? 'ripgrep is out of date — see empty state'
      : 'ripgrep is not installed — see empty state';
    return;
  }
  if (!state.scope) {
    renderStatus('No worktree detected. Open inside a git repo.', 'warn');
    renderEmpty('No worktree detected');
  } else {
    renderStatus('Type to search', 'info');
    renderEmpty('Type to search');
  }
  // Init log — only fires once rg detection has resolved. The
  // `state.rgReady` guard mirrors the pattern used by every other call
  // site: while rg is missing/old, the panel is in install-prompt mode
  // and there's nothing useful to log.
  if (state.rgReady) {
    olog('info', 'init', 'rgVersion=' + state.rgVersion, 'scope=' + (state.scope || '<none>'));
  }
  els.search.focus();
}

init();
