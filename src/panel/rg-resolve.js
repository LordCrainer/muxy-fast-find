// Path resolution for ripgrep. The Muxy exec sandbox does NOT inherit the
// user's full interactive shell PATH, so `which rg` frequently returns
// empty even when rg is installed at /opt/homebrew/bin/rg or
// /usr/local/bin/rg. This module implements a multi-strategy resolver:
//
//   1. `which rg` — works when Muxy exec happens to have rg on PATH.
//   2. Parallel `test -x` probes at well-known install locations.
//   3. Bare-name fallback (`'rg'`) — last resort, lets detectRg surface a
//      diagnostic error if nothing is reachable.
//
// Step 2 runs probes concurrently via Promise.all to keep the failure
// case fast (~50ms instead of 4 sequential round-trips).

/**
 * Common ripgrep install locations on macOS / Linux. Probed as a fallback
 * when `which rg` returns empty (which happens in Muxy's exec sandbox
 * because it doesn't inherit the user's full interactive PATH).
 */
export const COMMON_RG_PATHS = Object.freeze([
  '/opt/homebrew/bin/rg',   // Apple Silicon brew
  '/usr/local/bin/rg',      // Intel macOS brew, older installs
  '/usr/bin/rg',            // some system / package-manager installs
  '/opt/local/bin/rg',      // MacPorts
]);

/**
 * Resolve the path to ripgrep via a cascade of strategies:
 *   1. `which rg` (works if Muxy exec env has rg in PATH).
 *   2. Parallel `test -x` probes at COMMON_RG_PATHS.
 *   3. Bare-name fallback (returned as-is).
 *
 * Pure orchestration — never throws. If muxy is missing or every probe
 * fails, returns `fallback` so the caller can still attempt to exec.
 *
 * @param {Object|null} muxy — host bridge; may be null in dev/standalone
 * @param {string} fallback — bare name returned when nothing resolves
 * @returns {Promise<string>}
 */
export async function resolveRgPath(muxy, fallback) {
  if (!muxy || typeof muxy.exec !== 'function') return fallback;

  // Strategy 1: `which rg`. If the Muxy exec env has rg on PATH, this
  // is the cheapest, most accurate answer.
  try {
    const r = await muxy.exec(['which', 'rg']);
    const p = r && typeof r.stdout === 'string' ? r.stdout.trim() : '';
    if (p) return p;
  } catch {
    // Muxy exec can throw on permission denied or transport failure.
    // Fall through to the file-system probes.
  }

  // Strategy 2: probe known install locations with `test -x`. Probes run
  // in parallel to keep the all-fail case fast (~50ms instead of 4
  // sequential round-trips).
  const probes = await Promise.all(
    COMMON_RG_PATHS.map(async (candidate) => {
      try {
        const r = await muxy.exec(['test', '-x', candidate]);
        return r && r.exitCode === 0 ? candidate : null;
      } catch {
        return null;
      }
    })
  );
  const found = probes.find(Boolean);
  if (found) return found;

  // Strategy 3: bare-name fallback. May still work if Muxy happens to
  // have rg in its (sandboxed) PATH. The detectRg call will surface a
  // clean error otherwise.
  return fallback;
}
