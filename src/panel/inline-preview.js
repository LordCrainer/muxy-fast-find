// Fetches surrounding context lines for an inline preview. Hardened against
// binary files (NUL-byte sniff), deleted/renamed files (non-zero sed exit),
// and unreadable files (empty output despite success). Returns a
// discriminated-union result so callers exhaustively handle every case.

/**
 * @typedef {Object} FetchContextOpts
 * @property {string} filePath
 * @property {number} line — 1-indexed target line
 * @property {number} [contextLines=5] — lines before & after; 0/negative
 *   falls back to 5, values > 50 are capped at 50
 * @property {string} [repoRoot='.'] — cwd for exec
 *
 * @typedef {{line: number, text: string}} ContextLine
 *
 * @typedef {Object} ContextOk
 * @property {'ok'} kind
 * @property {ContextLine[]} lines
 * @property {number} matchLine
 *
 * @typedef {Object} ContextBinary
 * @property {'binary'} kind
 *
 * @typedef {Object} ContextStale
 * @property {'stale'} kind
 *
 * @typedef {Object} ContextUnreadable
 * @property {'unreadable'} kind
 *
 * @typedef {ContextOk|ContextBinary|ContextStale|ContextUnreadable} ContextResult
 */

const MAX_CONTEXT_LINES = 50;
const DEFAULT_CONTEXT_LINES = 5;
const BINARY_SNIFF_BYTES = 1024;

/**
 * Coerce the caller-supplied `contextLines` into a safe value.
 * 0, negative, missing, or non-numeric → 5. > 50 → 50.
 *
 * @param {*} raw
 * @returns {number}
 */
function normalizeContextLines(raw) {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_CONTEXT_LINES;
  }
  if (raw > MAX_CONTEXT_LINES) return MAX_CONTEXT_LINES;
  return Math.floor(raw);
}

/**
 * Strip the trailing newline (if any) from sed's output and convert into
 * `{line, text}` records starting at `startLine`.
 *
 * @param {string} stdout
 * @param {number} startLine
 * @returns {ContextLine[]}
 */
function parseSedOutput(stdout, startLine) {
  const raw = stdout.split('\n');
  // sed always terminates each printed line with \n, producing a final
  // empty element. Drop it so we don't emit a phantom blank row.
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const lines = new Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    lines[i] = { line: startLine + i, text: raw[i] };
  }
  return lines;
}

/**
 * Fetch surrounding context lines for an inline preview.
 *
 * Returns a discriminated-union result so callers must handle every case:
 * - `{ kind: 'ok', lines, matchLine }` — happy path
 * - `{ kind: 'binary' }` — NUL byte detected in first 1024 bytes
 * - `{ kind: 'stale' }` — file gone or unreadable (sed exit ≠ 0, exec
 *   rejected, or stderr flagged a file-existence / permission error)
 * - `{ kind: 'unreadable' }` — sed succeeded with empty output and no
 *   stderr signal (permissions, ACL, or truly empty file)
 *
 * @param {Object} muxy
 * @param {FetchContextOpts} opts
 * @returns {Promise<ContextResult>}
 */
export async function fetchContext(muxy, opts) {
  // Guard clause: a missing opts object, a non-string filePath, or an
  // empty filePath is unrecoverable — we'd be pointing sed at nothing.
  // Collapse it to `stale` so the UI can fall through to its stale-path
  // branch (mirrors the sed-exit-≠-0 path below).
  if (!opts || typeof opts.filePath !== 'string' || opts.filePath === '') {
    return { kind: 'stale' };
  }

  // Defensive normalization FIRST so every downstream call sees a sane
  // value. This is the single most important guard in this module.
  const contextLines = normalizeContextLines(opts.contextLines);

  // Coerce `line` to a safe 1-indexed integer. Negatives, NaN, fractions
  // and `Infinity` would all produce malformed `sed` ranges — clamp them
  // to a sane lower bound of 1. `Math.floor` handles fractions; the `|| 1`
  // collapses NaN/null/undefined to 1; `Math.max` handles negatives.
  const safeLine = Math.max(1, Math.floor(Number(opts.line) || 1));
  const repoRoot = opts.repoRoot || '.';
  const execOpts = { cwd: repoRoot };

  // --- 1. Binary sniff --------------------------------------------------
  // `head -c 1024` is portable and the NUL-byte check is the standard
  // heuristic — POSIX text files (and most binary blobs) are unambiguous
  // in the first 1KB. We treat a NUL anywhere as binary.
  //
  // Wrapped in try/catch: a rejected exec (sandbox failure, IPC drop,
  // plugin error) must not bubble out — we collapse it to `stale`,
  // matching the sed-exit-≠-0 path below. Symmetric with `search.js`'s
  // exec-rejection handler.
  let sniff;
  try {
    sniff = await muxy.exec(
      ['head', '-c', String(BINARY_SNIFF_BYTES), opts.filePath],
      execOpts
    );
  } catch {
    return { kind: 'stale' };
  }
  const sniffOut = sniff && typeof sniff.stdout === 'string' ? sniff.stdout : '';
  if (sniffOut.indexOf('\x00') !== -1) {
    return { kind: 'binary' };
  }

  // --- 2. Fetch context window -----------------------------------------
  // Clamp start to 1 — sed's first-address can't be < 1, and a negative
  // start would be silently dropped by sed on some platforms.
  const startLine = Math.max(1, safeLine - contextLines);
  const endLine = safeLine + contextLines;
  const range = `${startLine},${endLine}p`;

  // Wrapped in try/catch for the same reason as the sniff above: a
  // rejected exec collapses to `stale` rather than propagating.
  let result;
  try {
    result = await muxy.exec(['sed', '-n', range, opts.filePath], execOpts);
  } catch {
    return { kind: 'stale' };
  }
  const exitCode =
    result && typeof result.exitCode === 'number'
      ? result.exitCode
      : result && typeof result.exit_code === 'number'
        ? result.exit_code
        : 0;
  const stdout = result && typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = result && typeof result.stderr === 'string' ? result.stderr : '';

  if (exitCode !== 0) return { kind: 'stale' };

  // Distinguish "unreadable" from "out-of-range". An out-of-range sed
  // query (e.g. `sed -n '95,105p'` on a 3-line file) yields empty stdout
  // with exit 0 — indistinguishable from an ACL/permission denial purely
  // from exit code. Sniff stderr for file-existence or permission
  // signatures: if sed/head actually complained, treat the reference as
  // stale instead of mislabeling it unreadable. Out-of-range cases that
  // emit no stderr fall through to the original `unreadable` branch
  // (preserving the spec'd ACL/empty-file intent).
  if (stderr && /no such file|cannot open|permission denied/i.test(stderr)) {
    return { kind: 'stale' };
  }

  if (!stdout) return { kind: 'unreadable' };

  return { kind: 'ok', lines: parseSedOutput(stdout, startLine), matchLine: safeLine };
}
