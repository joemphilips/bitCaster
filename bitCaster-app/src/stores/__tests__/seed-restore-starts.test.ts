import { afterEach, describe, expect, it, vi } from "vitest";
import { SEED_RESTORE_STARTS_WINDOW_MS, claimSeedRestoreStart } from "../seed-restore-starts";

// The cap of full seed restore scans limits mint load and disclosure. It is
// not a funds rule, so a broken store must not stop a restore.

const KEY = "bitcaster.seed-restore-starts";

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
});

describe("claimSeedRestoreStart", () => {
  it("frees a slot when the oldest of four starts leaves the window", () => {
    const first = 1_000_000;
    for (let start = 0; start < 4; start += 1) {
      expect(claimSeedRestoreStart(first + start)).toEqual({ granted: true });
    }

    expect(claimSeedRestoreStart(first + 10)).toEqual({
      granted: false,
      retryAtMs: first + SEED_RESTORE_STARTS_WINDOW_MS,
    });
    expect(claimSeedRestoreStart(first + SEED_RESTORE_STARTS_WINDOW_MS)).toEqual({
      granted: true,
    });
  });

  it("starts the scan when the store cannot be read or holds invalid data", () => {
    window.localStorage.setItem(KEY, "not json");
    expect(claimSeedRestoreStart(1_000)).toEqual({ granted: true });

    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage is disabled");
    });
    expect(claimSeedRestoreStart(2_000)).toEqual({ granted: true });
  });

  it("starts the scan when the store cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    expect(claimSeedRestoreStart(1_000)).toEqual({ granted: true });
  });
});
