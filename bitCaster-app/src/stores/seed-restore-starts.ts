// The browser-level cap of full seed restore scans (operator decision
// 2026-11-04): a browser starts at most four in any rolling 24 hours. It lives
// outside the per-wallet restore record, so a wallet reset or a seed handoff
// does not clear it. The cap limits mint load and disclosure, not funds
// safety, so a storage failure lets the scan start.

const STARTS_KEY = "bitcaster.seed-restore-starts";
export const SEED_RESTORE_STARTS_MAX = 4;
export const SEED_RESTORE_STARTS_WINDOW_MS = 24 * 60 * 60_000;

export type SeedRestoreStartClaim =
  | { readonly granted: true }
  /** The cap is reached. A slot frees at `retryAtMs`. */
  | { readonly granted: false; readonly retryAtMs: number };

/** Records the start of one full restore scan, or reports when a slot frees. */
export function claimSeedRestoreStart(nowMs: number): SeedRestoreStartClaim {
  const storage = browserStorage();
  if (storage === null) return { granted: true };
  let starts: number[];
  try {
    starts = recentStarts(storage.getItem(STARTS_KEY), nowMs);
  } catch {
    return { granted: true };
  }
  if (starts.length >= SEED_RESTORE_STARTS_MAX) {
    return { granted: false, retryAtMs: Math.min(...starts) + SEED_RESTORE_STARTS_WINDOW_MS };
  }
  try {
    storage.setItem(STARTS_KEY, JSON.stringify([...starts, nowMs]));
  } catch {
    // The cap is a limit, not a safety rule. The scan still starts.
  }
  return { granted: true };
}

/**
 * Gives back the start that `claimSeedRestoreStart(nowMs)` recorded. Call it
 * when the restore record of that start could not be written.
 */
export function releaseSeedRestoreStart(nowMs: number): void {
  const storage = browserStorage();
  if (storage === null) return;
  try {
    // Keep the starts that other tabs recorded after this one.
    const starts = storedStarts(storage.getItem(STARTS_KEY));
    const index = starts.lastIndexOf(nowMs);
    if (index < 0) return;
    starts.splice(index, 1);
    storage.setItem(STARTS_KEY, JSON.stringify(starts));
  } catch {
    // The cap is a limit, not a safety rule. A lost release only delays a scan.
  }
}

function recentStarts(value: string | null, nowMs: number): number[] {
  return storedStarts(value)
    .filter((start) => start <= nowMs && nowMs - start < SEED_RESTORE_STARTS_WINDOW_MS)
    .slice(-SEED_RESTORE_STARTS_MAX);
}

function storedStarts(value: string | null): number[] {
  if (value === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((start): start is number => Number.isSafeInteger(start));
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
