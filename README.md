# fast-find — Find in Files

Full-text code search for Muxy, powered by [ripgrep](https://github.com/BurntSushi/ripgrep). Lives in a right-side panel with live results, inline previews, and `Cmd+Enter` to jump straight to the match in your editor.

> For the full spec (UI inventory, manifest, API surface, tests, troubleshooting): **[FEATURES.md](./FEATURES.md)**

## Features

- **Live search with 150ms debounce** — type and the result list updates as you pause; no submit step.
- **Active-worktree scope** — auto-detects the Muxy worktree / git repo and restricts every search to it. No accidental cross-repo hits.
- **Inline preview** — click a result to expand ±N context lines (1/3/5/10) right in the panel. Submatches are highlighted with `<mark>`.
- **Open in editor** — `Cmd+Enter` on a result opens it in the [files](https://github.com/muxy-app) extension's `code-editor` tab, scrolled to the exact line and column.
- **Case sensitivity toggle** — `Aa` flips between case-sensitive (default) and case-insensitive.
- **Literal mode** — `.*` toggles regex off; the query is matched as a plain string.
- **Include globs** — comma-separated patterns (e.g. `*.ts,*.tsx`) become `-g` flags; everything else is filtered out.
- **Hidden files** — toggle `--hidden` to traverse dotfiles.
- **No-ignore toggle** — adds `-uu` (no ignore files, no `.ignore`, no hidden filtering) for searches that must pierce `.gitignore` and friends.
- **Configurable context lines** — 1, 3 (default), 5, or 10 lines around the match in the inline preview.
- **Persistent settings** — case/literal/globs/hidden/no-ignore/context are stored in `localStorage` under `fast-find-settings-v1`.
- **Worktree switch detection** — listens to `worktree.switched` and `project.switched`; bumps the query sequence counter and clears stale results so a mid-search switch never lands a result from the old tree.
- **ripgrep install prompt** — on first run (or after an upgrade), the panel detects a missing or out-of-date `rg` and surfaces a one-click copy of `brew install ripgrep` / `brew upgrade ripgrep`.
- **200+ tests** — 8 suites covering argv construction, JSON parsing, install detection, search pipeline, inline preview, bundle, manifest, and scoring helpers.

## Install

Muxy auto-detects the extension at `~/.config/muxy/extensions/fast-find/`. **Restart Muxy** to load it. The first time the panel opens, fast-find runs `rg --version` and either silently proceeds or shows the install prompt.

If you move the extension to a different path, update Muxy's `extensions` config to point at the new location.

## Dependencies

### Required: `ripgrep`

| Item | Value |
|---|---|
| Binary | `rg` on `$PATH` |
| Minimum version | 0.10 (anything ≥ 0.10 or ≥ 1.0 is accepted) |
| macOS install | `brew install ripgrep` |
| Linux install | `apt install ripgrep` (Ubuntu 20.04+), `dnf install ripgrep` (Fedora 33+), or your distro's package manager |
| Windows install | `winget install BurntSushi.ripgrep` or `scoop install ripgrep` |

The extension shells out to `rg` for every search. There is no fallback — if `rg` is missing or below 0.10, the panel shows the install prompt and the search input stays disabled.

### Optional: `files` extension

Required only for `Cmd+Enter` to open results in an editor. Without it, results still appear and the inline preview still works, but pressing `Cmd+Enter` shows a toast asking you to install the `files` extension.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd+Shift+F` | Toggle the panel |
| `Cmd+Alt+F` | Focus the search input |
| `Cmd+Enter` on a result | Open in the `files` extension's `code-editor` tab, scrolled to the match |
| `Enter` on a result | Toggle the inline preview (expand / collapse) |
| `Esc` | Close the settings popover, collapse the inline preview, or clear the search input |

All shortcuts are declared in `package.json` under `muxy.commands` and re-bindable from Muxy's keybindings UI.

## Consent prompts

Every call to `muxy.exec` may show a **"Allow this command to run?"** dialog the first time the host sees that command shape. fast-find shells out to a small set of well-known binaries, so the prompts are limited to:

- `rg` (or whatever `which rg` resolves to) for searches
- `head` for the binary-file sniff that gates the inline preview
- `sed` for the context-line fetch

To minimize prompts:

1. **Click "Allow & remember"** the first time you run a search. Muxy records the exact argv and won't ask again for that shape.
2. Different invocations of `rg` (e.g. with `--hidden`, `-uu`, or `-g` flags) are different command shapes, so the first run with each new flag set will prompt. Subsequent runs are silent.
3. To revoke all consents, go to **Settings → Extensions → fast-find → Reset consent**. After that, every `muxy.exec` call prompts again until you re-approve.

## Troubleshooting

| Issue | Cause | Fix |
|---|---|---|
| "ripgrep required" empty state | `rg` is missing from `$PATH` | `brew install ripgrep`, then restart Muxy |
| "ripgrep is out of date" empty state | `rg < 0.10` (predates stable JSON output) | `brew upgrade ripgrep`, then restart Muxy |
| "Allow this command to run?" on every search | You clicked "Allow" without "Allow & remember" the first time | Click "Allow & remember"; or reset consent and re-approve once with the checkbox |
| "No worktree detected" | Muxy isn't inside a git repo, or the worktree API returned an empty list | Open the panel from inside a git repo, or run `git init` |
| "Install the 'files' extension to open results in an editor" toast (on `Cmd+Enter`) | The `files` extension isn't installed | Install the `files` extension from Muxy's marketplace; the toast links to it on most Muxy builds |
| "No matches" but you know the term exists | Case sensitivity is on, or the file type is filtered by the include globs, or the file is gitignored | Try `Aa` to enable case-insensitive, clear the `Include globs` field, or toggle `-uu` in the settings popover |
| Search returns results from a previous worktree | (Resolved in the shipped build) | This was the worktree-switch race; the current build clears results synchronously on `worktree.switched`. If you still see it, reload Muxy |

## Development

```bash
npm install
npm run dev       # Vite dev server on :5173
npm run build     # Build to dist/ (panel.html + assets/, then copies package.json)
npm test          # 204 tests across 8 suites, ~1s total
```

The `pretest` hook runs `npm run build` automatically, so `dist/` is always fresh before the bundle assertions fire.

Open `src/panel/panel.html` directly in a browser for a standalone preview — the panel fails closed when `window.muxy` is missing and shows a "Muxy host not available" status.

## Architecture

```
panel.html
  ↓ loads
main.js (UI wiring, state, debounce, DOM events)
  ├──→ utils.js          (relativizePath, formatTime, formatCount, isTruncated — pure)
  ├──→ rg-install.js     (detectRg — version gate)
  ├──→ log.js            (olog, oinfo, owarn, oerror — tagged console output)
  ├──→ search.js         (runSearch — scope + argv + exec + parse)
  │     ├──→ rg-args.js  (buildArgv — pure argv constructor)
  │     └──→ parse-json.js (parseBuffer — rg --json stream → Match[])
  └──→ inline-preview.js (fetchContext — binary sniff + sed range)
```

Three concentric layers, mirroring the structure used in `ai-history`:

1. **Pure-function core** — `rg-args.js`, `parse-json.js`, and the helpers in `utils.js` are dependency-free and exhaustively tested without a DOM or Muxy.
2. **I/O boundary** — `search.js` and `inline-preview.js` accept a `muxy` object (production) or a mock (tests) and orchestrate the pipeline. Every async point checks the staleness counter.
3. **UI module** — `main.js` owns the debounce, settings persistence, and DOM rendering. It imports the I/O layer but never calls `rg` directly.

`log.js` is intentionally the only side-effect module besides `main.js`: tagged `console.*` calls prefixed with `[fastFind]` so anything fast-find emits can be grep'd out of Muxy's extension log with one regex.
