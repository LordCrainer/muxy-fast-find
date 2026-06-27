// Phase 4: ripgrep version detection. Surfaces a structured verdict to the
// UI layer so it can decide between the normal empty state, an
// "install ripgrep" prompt, or an "out of date" prompt. Keeps all version
// parsing in one place — `main.js` should never regex a `--version` string
// directly.

/**
 * @typedef {Object} RgDetectOk
 * @property {true} ok
 * @property {string} version — semver "X.Y.Z"
 *
 * @typedef {Object} RgDetectFail
 * @property {false} ok
 * @property {'not-found'|'too-old'|'error'} reason
 * @property {string} stderr — human-readable detail for diagnostics
 *
 * @typedef {RgDetectOk|RgDetectFail} RgDetectResult
 */

// Below this version, rg predates several features we rely on (notably the
// stable JSON output contract). 0.10 is the floor the project has chosen.
const MIN_RG_MAJOR = 1;
const MIN_RG_FALLBACK_MAJOR = 0;
const MIN_RG_FALLBACK_MINOR = 10;

/**
 * Parse a `ripgrep X.Y.Z` line from `rg --version`. Returns a normalized
 * semver string or null. Tolerates the multi-line `ripgrep 14.1.0\n\nfeatures: ...`
 * layout by trimming before matching.
 *
 * @param {string} stdout
 * @returns {{version: string, major: number, minor: number, patch: number}|null}
 */
function parseVersion(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return null;
  const match = stdout.match(/ripgrep\s+(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
    return null;
  }
  return { version: `${major}.${minor}.${patch}`, major, minor, patch };
}

/**
 * Detect whether the resolved ripgrep binary is present, executable, and
 * recent enough for the features this extension relies on. Pure
 * orchestration — every failure mode returns a structured result rather
 * than throwing, so the UI can switch on `reason` without try/catch.
 *
 * @param {Object|null} muxy — host bridge; may be null in dev/standalone
 * @param {string} rgPath — absolute path to rg, or `'rg'` to rely on $PATH
 * @returns {Promise<RgDetectResult>}
 */
export async function detectRg(muxy, rgPath) {
  // Guard: no host bridge → we can't exec at all. Treat as not-found so the
  // UI can show the install prompt (which is the actionable next step
  // regardless of root cause).
  if (!muxy || typeof muxy.exec !== 'function') {
    return { ok: false, reason: 'not-found', stderr: 'muxy.exec unavailable' };
  }

  let result;
  try {
    result = await muxy.exec([rgPath, '--version'], { cwd: '/' });
  } catch (e) {
    // If rgPath is just 'rg' (the fallback), and the exec failed, the issue
    // is almost certainly that Muxy's exec PATH doesn't include the
    // directory containing rg. main.js's resolveRgPath probes known
    // locations first, so by the time we get here the user likely has rg
    // somewhere PATH-unusual. Surface the underlying error so it's
    // debuggable from the empty state.
    return {
      ok: false,
      reason: 'not-found',
      stderr: `rg --version failed: ${(e && e.message) || 'unknown error'}. Tried path: "${rgPath}". If rg is installed, ensure it is on Muxy's PATH or at /opt/homebrew/bin/rg, /usr/local/bin/rg, or /usr/bin/rg.`,
    };
  }

  // Defensive: a successful exec that returned no stdout is treated as a
  // malformed version string rather than a missing binary, since exec
  // didn't throw.
  const stdout = result && typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!stdout) {
    return { ok: false, reason: 'error', stderr: 'empty stdout from rg --version' };
  }

  const parsed = parseVersion(stdout);
  if (!parsed) {
    return { ok: false, reason: 'error', stderr: stdout || 'unparseable version' };
  }

  const { version, major, minor, patch } = parsed;

  // Version gate. Accept major >= 1, or 0.x where x >= 10 (rg's pre-1.0 era).
  const isTooOld =
    (major < MIN_RG_MAJOR) &&
    !(major === MIN_RG_FALLBACK_MAJOR && minor >= MIN_RG_FALLBACK_MINOR);

  if (isTooOld) {
    return {
      ok: false,
      reason: 'too-old',
      stderr: `ripgrep ${version} is too old (need ≥0.10)`,
    };
  }

  return { ok: true, version };
}
