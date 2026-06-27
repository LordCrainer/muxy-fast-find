# fast-find — Features

Full spec for the `fast-find` Muxy extension. Keep in sync with `README.md` on every release.

## Summary

`fast-find` is a right-side Muxy panel that runs `ripgrep` against the active worktree and streams matches into a live, debounced result list. Click a row to expand a ±N line preview with submatch highlights; `Cmd+Enter` to jump straight to the file in the `files` extension's `code-editor` tab. The panel auto-detects the Muxy worktree (or falls back to `git.repoInfo`), persists its settings in `localStorage`, clears stale results on worktree/project switches, and surfaces a one-click install prompt if `rg` is missing or below 0.10.

## UI

### Header

- Title `Find in Files` on the left with the `🔍` glyph as a visual anchor.
- A `⚙` settings button on the right. Click toggles the settings popover; the click is `stopPropagation`ed so it doesn't immediately close the popover again via the document-level click handler.

### Input row

Sits below the header. Three controls left-to-right:

- **Search input** (`<input type="search">`) — autofocus target. The only field that triggers a search. Each keystroke is debounced 150ms via `setTimeout`; in-flight searches are cancelled by bumping `state.querySeq`.
- **Case toggle (`Aa`)** — flips between `'sensitive'` and `'insensitive'`. Adds/removes `-i` from the rg argv. Visual state is `aria-pressed` + an `.active` class.
- **Literal toggle (`.*`)** — flips between `'regex'` and `'literal'`. Adds/removes `-F` from the rg argv.

### Settings popover (collapsed by default)

Floating panel under the input row. Four fields, all wired to `state.settings` with a one-way data flow (`saveSettings()` writes to `localStorage`; `applySettingsToUI()` repaints the controls on load):

| Field | Type | Maps to |
|---|---|---|
| Include globs | text input | `state.settings.includeGlobs` (comma-separated) → multiple `-g` flags |
| Search hidden files | checkbox | `state.settings.hidden` → `--hidden` |
| Search ignored files (`-uu`) | checkbox | `state.settings.noIgnore` → `-uu` |
| Context lines | select (1, 3, 5, 10) | `state.settings.contextLines` → `sed` range & `inline-preview` window |

Popover closes on outside click, on toggle click, or on `Esc`.

### Status bar

Single text line under the input. Updates per-state with a kind class for color (`info` / `searching` / `warn` / `error`):

| Status text | Triggered by |
|---|---|
| `Type to search` | Initial state, or after a worktree switch with an empty query |
| `Searching…` | `scheduleSearch()` (called on every keystroke) |
| `12 matches · 5 files · 87ms` | `finishSuccess()` — count, file count, duration |
| `No matches for "foo"` | `finishSuccess()` with zero results |
| `No worktree detected. Open inside a git repo.` | `resolveScope()` returned `null` |
| `Invalid query` | `runSearch()` returned `{ error: 'invalid-query' }` |
| `Permission denied` | `muxy.exec` rejected (consent not granted) |
| `Search error — previous results shown` | `rg` returned exit 2 (its own error) |
| `Search failed` | Any other unexpected failure (`{ error: 'unknown' }`) |

`aria-live="polite"` so screen readers announce transitions.

### Results list

Vertical stack of `<li class="result-row">` elements, each with:

- **Header row** — dim relative path (e.g. `src/panel/main.js`) on the left, bright `:line:column` on the right. Full path is in the `title` attribute for hover-tooltip.
- **Content row** — the matched line with submatch spans wrapped in `<mark>`. If the line hit `MAX_COLUMNS` (200), an italic `… (truncated)` hint is appended.
- **Inline preview** (only on the expanded row) — when the row's index equals `state.expandedIndex`. Shows a `±N` context window with the matched line highlighted, or a status message (`Loading preview…` / `Binary file — no preview` / `File no longer exists or is unreadable` / `File is empty or unreadable`).

The list is rendered with `replaceChildren()` + a `DocumentFragment` for batching — a 200-result search is one paint, not 200.

### Empty states

| State | Rendered copy | Trigger |
|---|---|---|
| Muxy host unavailable | `Muxy host not available` | `window.muxy` is `null` (standalone preview) |
| No worktree | `No worktree detected` | `state.scope` is `null` after init or worktree switch |
| No query | `Type to search` | `els.search.value` is empty |
| No matches | `No matches for "<query>"` | `result.matches.length === 0` after a successful search |
| rg missing | `ripgrep required` + body + `brew install ripgrep` with a one-click copy button | `detectRg` returns `{ reason: 'not-found' }` |
| rg too old | `ripgrep is out of date` + body + `brew upgrade ripgrep` with a one-click copy button | `detectRg` returns `{ reason: 'too-old' }` |
| Permission denied | `Search blocked — check Muxy permissions` | `muxy.exec` rejected by Muxy's consent dialog |
| rg error | `ripgrep error: <truncated stderr> — previous results shown` | rg exit code 2 |
| Unknown failure | `Search failed: <message>` | Any other unhandled `runSearch` error |

The rg install/upgrade prompt is the only empty state that has interactive controls (a copy button). The copy button is wired via event delegation on `els.results` so it survives `replaceChildren` without re-binding.

## Architecture

```
panel.html
  ↓ loads
main.js (UI wiring, state, debounce, DOM events, settings persistence)
  ├──→ utils.js          (relativizePath, formatTime, formatCount, formatFileCount, isTruncated)
  ├──→ rg-install.js     (detectRg — version gate, returns { ok, version } | { ok, reason, stderr })
  ├──→ log.js            (olog / oinfo / owarn / oerror — tagged [fastFind] console output)
  ├──→ search.js         (runSearch — resolve scope → buildArgv → exec → parseBuffer)
  │     ├──→ rg-args.js  (buildArgv — pure argv constructor with rg-version-aware flags)
  │     └──→ parse-json.js (parseBuffer — rg --json stream → { matches, stats })
  └──→ inline-preview.js (fetchContext — binary sniff via head -c 1024 → sed range)
```

Three layers, mirroring the structure used in `ai-history`:

1. **Pure-function core** — `rg-args.js`, `parse-json.js`, and the helpers in `utils.js` have no imports from `muxy`, the DOM, or `node:fs`. They take inputs explicitly and return values, which is what makes them directly testable in plain `node` (see `tests/test-ripgrep-args.mjs`, `tests/test-parse-json.mjs`, `tests/test-scoring.mjs`).
2. **I/O boundary** — `search.js` and `inline-preview.js` accept a `muxy` object as the first argument. In production it's `window.muxy`; in tests it's a mock that records every call and lets you script responses. Every async point checks the staleness counter (`getCurrentSeq()`) so a superseded search aborts cleanly mid-flight.
3. **UI module** — `main.js` is the only file that touches the DOM. It owns the debounce timer, settings persistence, and the result list rendering. It imports the I/O layer but never calls `rg` directly.

`log.js` is the only side-effect module besides `main.js`. All output is prefixed with `[fastFind]` so it can be filtered out of Muxy's extension log with one regex (`grep '\[fastFind\]'`).

## Manifest

The `muxy` block in `package.json` is the extension's contract with the host. Full structure:

```json
{
  "$schema": "https://raw.githubusercontent.com/muxy-app/muxy/main/docs/extensions/schema/manifest.schema.json",
  "description": "Find in Files — full-text code search powered by ripgrep.",
  "permissions": [
    "panels:write",
    "notifications:write",
    "tabs:read",
    "tabs:write",
    "git:read",
    "worktrees:read",
    "commands:exec"
  ],
  "events": ["project.switched", "worktree.switched"],
  "panels": [
    {
      "id": "fast-find",
      "title": "Find in Files",
      "entry": "panel.html",
      "position": "right",
      "mode": "pinned"
    }
  ],
  "commands": [
    { "id": "toggle-fast-find", "title": "Find in Files", "defaultShortcut": "cmd+shift+f", "action": { "kind": "togglePanel", "panel": "fast-find" } },
    { "id": "focus-fast-find", "title": "Focus Find in Files", "defaultShortcut": "cmd+alt+f" },
    { "id": "refresh-fast-find", "title": "Refresh Find in Files" }
  ],
  "topbarItems": [
    { "id": "fast-find", "icon": { "symbol": "magnifyingglass" }, "tooltip": "Toggle Find in Files", "command": "toggle-fast-find" }
  ],
  "marketplace": {
    "author": "LordCrainer",
    "github": "LordCrainer",
    "categories": ["productivity", "search"]
  }
}
```

### Field-by-field

| Field | Why |
|---|---|
| `description` | Shown in Muxy's extension list and the marketplace entry |
| `permissions` | The seven scopes fast-find needs (see breakdown below) |
| `events` | The two host events that trigger a scope refresh |
| `panels` | One panel: `fast-find`, mounted on the right rail in pinned mode |
| `commands` | Three commands; the toggle and focus have default shortcuts, `refresh` is palette-only |
| `topbarItems` | A single magnifying-glass icon in Muxy's top bar; click toggles the panel |
| `marketplace` | Author + categories for the marketplace UI |

### Permissions

| Permission | Why |
|---|---|
| `panels:write` | Render the `fast-find` panel UI |
| `notifications:write` | Toasts for copy-confirm, permission-denied, rg errors, and worktree-switch notices |
| `tabs:read` | (Reserved for future use; declared defensively) |
| `tabs:write` | `muxy.tabs.open({ kind: 'extensionWebView', ... })` for `Cmd+Enter` |
| `git:read` | `muxy.git.repoInfo()` as a fallback for scope detection when `worktrees.list` is empty |
| `worktrees:read` | `muxy.worktrees.list()` for primary scope detection (active worktree) |
| `commands:exec` | `muxy.exec` for `which rg`, `rg --version`, `rg --json`, `head -c 1024`, `sed -n <range>p` |

### Events

| Event | Handler | Effect |
|---|---|---|
| `project.switched` | `onScopeChanged` | Bump `querySeq`, clear results, re-resolve scope, toast |
| `worktree.switched` | `onScopeChanged` | Same as above (both events share a handler) |

### Commands

| ID | Default shortcut | Action |
|---|---|---|
| `toggle-fast-find` | `Cmd+Shift+F` | `togglePanel` on `fast-find` |
| `focus-fast-find` | `Cmd+Alt+F` | Focus the search input inside the panel |
| `refresh-fast-find` | (palette only) | Re-run the current search |

## API used (muxy)

| Call site | API | Purpose |
|---|---|---|
| `init()` | `muxy.exec(['which', 'rg'])` | Resolve the absolute path to `rg` (or fall back to `'rg'`) |
| `init()` | `muxy.exec([rgPath, '--version'], { cwd: '/' })` | Detect rg version (always run from `/` to dodge non-existent cwd errors) |
| `init()` | `muxy.events.subscribe('worktree.switched', onScopeChanged)` | React to worktree switches |
| `init()` | `muxy.events.subscribe('project.switched', onScopeChanged)` | React to project switches |
| `init()` | `muxy.events.subscribe('command.refresh-fast-find', reRunSearch)` | Palette command for re-run |
| `init()` | `muxy.events.subscribe('command.focus-fast-find', focusSearch)` | Palette command for focus |
| `onScopeChanged()` | `muxy.worktrees.list()` | Find the new active worktree |
| `onScopeChanged()` | `muxy.git.repoInfo()` (fallback) | Get repo root if worktrees API is empty |
| `runSearch()` | `muxy.exec(argv, { cwd: scope })` | The actual `rg --json` invocation |
| `loadPreview()` | `muxy.exec(['head', '-c', '1024', filePath], { cwd: scope })` | Binary sniff |
| `loadPreview()` | `muxy.exec(['sed', '-n', 'A,Bp', filePath], { cwd: scope })` | Context-line fetch |
| `openInEditor()` | `muxy.tabs.open({ kind: 'extensionWebView', extension: { id: 'files', tabType: 'code-editor', singleton: true, data: { filePath, line, column, replaceable: true } } })` | Open the match in the `files` extension's editor |
| `toast()` | `muxy.toast({ title, variant })` | Non-blocking notifications (info / warn / error variants) |
| Browser | `navigator.clipboard.writeText(text)` + textarea fallback | Copy install/upgrade command to the clipboard |

## Settings schema

Persisted in `localStorage` under the key `fast-find-settings-v1`. Always JSON-serialized; always read with a try/catch that falls back to defaults on parse failure.

| Field | Type | Default | Effect |
|---|---|---|---|
| `caseMode` | `'sensitive'` \| `'insensitive'` | `'sensitive'` | Adds `-i` to rg argv when `'insensitive'` |
| `regexMode` | `'regex'` \| `'literal'` | `'regex'` | Adds `-F` to rg argv when `'literal'` |
| `includeGlobs` | `string` (comma-separated) | `''` | Each non-empty segment becomes a `-g <glob>` |
| `hidden` | `boolean` | `false` | Adds `--hidden` to rg argv |
| `noIgnore` | `boolean` | `false` | Adds `-uu` to rg argv |
| `contextLines` | `number` (1 / 3 / 5 / 10) | `3` | Window size for the inline preview's `sed` range |

Any field missing from the stored object is filled in with its default at load time (spread merge). The same is true for fields with wrong types (e.g. `contextLines: "abc"` falls back to `3`).

Changing any of these clears the inline-preview cache (the context window may have grown or shrunk) and reschedules a search with the current query.

## Edge cases

The eight most important edge cases the codebase is hardened against. All are pinned by tests in `tests/test-run-search.mjs`, `tests/test-inline-preview.mjs`, and `tests/test-rg-install.mjs`.

### 1. Worktree switched mid-search (Phase 4 fix)

The user types a query, rg is running, the user clicks a different worktree in Muxy. Before the fix, the in-flight `runSearch` would still resolve and overwrite the new state. Now:

1. `onScopeChanged` bumps `state.querySeq` synchronously, before awaiting the new scope.
2. The in-flight `runSearch` calls `isStale()` at every await point (after `safeWorktrees`, after `safeRepoInfo`, after `muxy.exec`, after `parseBuffer`).
3. On mismatch, it returns `{ aborted: true }` and the caller in `executeSearch` bails at the early `if (result.aborted) return` check.
4. `onScopeChanged` also clears `state.results = []` synchronously so the stale list never gets one extra render before the new search lands.

### 2. Project switched mid-search

Identical to case 1 (`onScopeChanged` is the handler for both `worktree.switched` and `project.switched`).

### 3. ripgrep missing

`detectRg` returns `{ ok: false, reason: 'not-found', stderr: '...' }`. The UI:

- Sets `state.rgReady = false`, stores the issue for the empty state.
- Renders the `buildRgPromptEl({ title: 'ripgrep required', command: 'brew install ripgrep', ... })` empty state with a one-click copy button.
- Disables the search input (`els.search.disabled = true`, `aria-disabled='true'`).
- Fires a single warn toast.

### 4. ripgrep too old (below 0.10)

Same UI as case 3, but with `title: 'ripgrep is out of date'` and `command: 'brew upgrade ripgrep'`. The `els.search.title` attribute is set to the diagnostic message so the user sees the reason on hover.

### 5. Permission denied on the first `rg` call

Muxy rejects `muxy.exec` (consent dialog not yet approved). The `runSearch` try/catch converts the throw into `{ error: 'exec-failed', message: ... }`. The UI:

- Fires an error toast: `Permission denied. Allow fast-find to run ripgrep.`
- Renders an inline error: `Search blocked — check Muxy permissions`.
- Sets the status to `Permission denied`.

### 6. Binary file in the inline preview

`fetchContext` runs `head -c 1024 <file>` first. If the output contains a NUL byte, the result is `{ kind: 'binary' }` and the UI shows `Binary file — no preview`. No `sed` call is issued.

### 7. File deleted / renamed between search and preview

`sed` returns non-zero exit, or the host reports `no such file` / `cannot open` / `permission denied` in stderr. Either signal collapses to `{ kind: 'stale' }` and the UI shows `File no longer exists or is unreadable`.

### 8. rg error (exit code 2)

rg itself failed (e.g. invalid regex, permission denied mid-traversal). `runSearch` returns `{ error: 'rg-error', message: stderr.slice(0, 200) }`. The UI:

- Fires an error toast with the truncated stderr.
- Sets the status to `Search error — previous results shown`.
- Renders the inline error with the truncated message.

**Phase 5 hardening**: a `muxy.exec` that returns no result (or a result with neither `exitCode` nor `exit_code`) is now treated as `exec-failed` rather than silently succeeding with an empty match list. This catches plugin crashes that previously looked like "no matches".

## Per-project query persistence

Each scope (worktree root) keeps its own last-typed query in `localStorage`
under `fast-find-query-v1:<scope>`. When you switch projects or worktrees,
the new scope's query is restored into the input automatically (but the
search does NOT auto-fire — you must press Enter or keep typing). Settings
(case mode, globs, etc.) remain global across projects.

## Logging

All log lines are prefixed with `[fastFind]` and routed to the matching `console.*` method (`console.debug` / `console.info` / `console.warn` / `console.error`). They are gated on `state.rgReady` — when ripgrep is missing, the log channel is silent (the install prompt is the only signal).

| Site | Level | Key | What it logs |
|---|---|---|---|
| `init()` (end) | info | `init` | `rgVersion=<semver> scope=<path or <none>>` |
| `onScopeChanged()` | info | `worktree.switched` | `old=<path or <none>> new=<path or <none>>` |
| `executeSearch()` (start) | debug | `search.start` | `query=<JSON string> scope=<path> rgVersion=<semver>` |
| `executeSearch()` (failure) | warn or error | `search.error` | `kind=<no-scope\|invalid-query\|exec-failed\|rg-error\|unknown> message=<truncated stderr>` |
| `loadPreview()` (end) | debug | `preview.load` | `filePath=<path> line=<int> kind=<ok\|binary\|stale\|unreadable>` |
| `onCaseToggle()` | debug | `settings.case` | `sensitive->insensitive` (or the reverse) |
| `onLiteralToggle()` | debug | `settings.literal` | `regex->literal` (or the reverse) |
| `onSettingChange()` | debug | `settings.changed` | `globs=<JSON> hidden=<bool> noIgnore=<bool> contextLines=<int>` |

Search errors that look user-actionable (no-scope, invalid-query, exec-failed) log at `warn`; errors that look like real bugs (rg-error, unknown) log at `error`. The grep `\[fastFind\] error` therefore surfaces actionable bugs without being polluted by consent prompts.

## Tests

Eight suites, 204 tests total. Run with `npm test` (which runs `npm run build` first via the `pretest` hook so bundle assertions see a fresh `dist/`).

| Suite | Tests | What it covers |
|---|---|---|
| `tests/test-bundle.mjs` | 20 | `dist/` content: file presence, relative asset refs in `panel.html`, `muxy.exec` and `tabs.open` call sites survive minification, `code-editor` string present, bundle under 30KB, no `console.log` / `debugger;` left over, `<main>` landmark, `Searching` string in bundle, `dist/package.json` mirrors source |
| `tests/test-inline-preview.mjs` | 28 | `fetchContext` happy path, binary sniff, sed exit ≠ 0, empty output, stderr sniff for stale, range clamping, context line normalization, exec rejection collapsing to `stale` |
| `tests/test-manifest.mjs` | 20 | `package.json`'s `muxy` block: all 7 required permissions, no duplicates, `worktree.switched` and `project.switched` events, panel declaration, topbar wiring, command shortcuts, marketplace fields, panel id matches topbar id |
| `tests/test-parse-json.mjs` | 25 | `parseBuffer`: match events, summary stats, submatch shape, trailing-newline stripping, malformed line resilience, `elapsed_total.nanos` vs `elapsed_total.secs`, `files_with_matches` extraction |
| `tests/test-rg-install.mjs` | 15 | `detectRg`: modern / 13.0.0 / 0.10.0 accepted, 0.9.0 rejected, muxy null / exec missing / exec throws, malformed version strings, `rgPath` pass-through, cwd `/` for version probe, multi-line version parser tolerance |
| `tests/test-ripgrep-args.mjs` | 35 | `buildArgv`: default argv shape, every toggle flag, `--` for `-`-prefixed queries, scope as last positional, `--follow=false` only for rg ≥ 13, `-g` per glob, exact argv pin (anti-regression) |
| `tests/test-run-search.mjs` | 27 | `runSearch`: scope resolution (worktrees → git), staleness via `querySeq` / `getCurrentSeq`, exec-failed collapsing, rg exit codes (0 / 1 / 2 / other), invalid-query guard, abort path, `onStale` callback wiring, scope pass-through to stats |
| `tests/test-scoring.mjs` | 34 | `relativizePath` (prefix stripping, partial-match defense, falsy/empty edge cases), `formatTime` (sub-second, second boundary, garbage in), `formatCount` / `formatFileCount` (singular / plural / 0), `isTruncated` (≥ MAX_COLUMNS, off-by-one boundaries, non-string) |

Total wall time: ~1 second on a modern laptop. No real Muxy host required — every test mocks the host API.

## Bundle size

```
dist/src/panel/panel.html        2.22 kB │ gzip: 0.79 kB
dist/assets/panel-*.css           9.83 kB │ gzip: 2.64 kB
dist/assets/panel-*.js           23.15 kB │ gzip: 7.38 kB
```

Vite + vanilla JS, no frameworks. Soft budget is 30KB raw (the bundle test enforces it). Adding `log.js` and ~8 log call sites nudged the JS bundle from 22.00 KB to 23.15 KB — still well under budget.

## Out of scope for v1

- **Multi-buffer / replace** — there's no `Edit All` button or `replace` action. The panel is search-only.
- **Result persistence** — closing the panel and reopening it doesn't restore the previous search or the previous expanded row. The result list lives entirely in `state` and is cleared on `beforeunload`.
- **Multiple panes / tabs** — only one search buffer at a time. There's no buffer-switcher or saved-queries UI.
- **Regex syntax highlighting in the search input** — the input is a plain text field; rg errors during execution surface in the status line, not inline as you type.
- **Custom rg binary path UI** — `which rg` decides the path. To override, the user can symlink `rg` to point at their preferred binary.
- **Project picker / file filter UI** — searches are constrained to the active worktree automatically. There's no UI to broaden the scope to multiple worktrees or to a custom path.
- **Search history dropdown** — recent queries are not stored. A future release could add an MRU list keyed off the panel's focus events.
- **Per-result actions (copy path, reveal in Finder, etc.)** — `Cmd+Enter` opens the file in the editor. There's no 3-dot menu per row.
- **PCRE2 toggle** — fast-find uses rg's default regex engine. There's no UI to flip `-pcre2` on or off.
- **Streaming UI updates** — the result list is replaced all-at-once when a search completes, not progressively as rg emits matches. A future release could add incremental rendering for very large result sets.

## Future plans

The most natural next steps, in priority order:

1. **Saved searches** — let the user pin a query to a hotkey, so `Cmd+1` re-runs their last search.
2. **Search history dropdown** — MRU list of the last 50 queries, accessible via the input's `ArrowUp`.
3. **Multi-worktree scope** — when Muxy has multiple worktrees open, let the user pick which one(s) to search across.
4. **Replace in files** — use rg's `--replace` flag to do a bulk rename, gated behind a confirm dialog.
5. **Files extension integration v2** — instead of `tabs.open` + a static `data` payload, register a shared bus so the `files` extension can subscribe to `fast-find` selections and react to other in-panel events.
