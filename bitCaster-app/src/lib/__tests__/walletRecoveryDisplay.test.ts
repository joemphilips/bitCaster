import { describe, expect, it } from "vitest";
import type {
  WalletRecoveryHoldingsRead,
  WalletRecoveryPendingReason,
  WalletRecoveryStatus,
} from "@bitcaster/client-sdk/walletRecoveryStatus";
import {
  walletRecoveryDisplay,
  walletRecoveryHoldingsUnknown,
  walletRecoveryRowsEmptyIsTerminal,
} from "../walletRecoveryDisplay";

const TAG = { activation: { scopeId: "scope", epoch: 2 }, mintSetTag: '["https://mint"]' };
const OTHER_EPOCH = { ...TAG, activation: { scopeId: "scope", epoch: 1 } };
const COMPLETED: WalletRecoveryStatus = {
  kind: "completed",
  tag: TAG,
  passSeq: 3,
  coverage: "full",
};
const CHECKING: WalletRecoveryStatus = { kind: "checking", tag: TAG };
const OK_CURRENT: WalletRecoveryHoldingsRead<number> = {
  kind: "ok",
  tag: TAG,
  afterPassSeq: 3,
  value: [1],
};
const UNHYDRATED: WalletRecoveryHoldingsRead<number> = { kind: "unhydrated" };
const FAILED: WalletRecoveryHoldingsRead<number> = { kind: "failed" };

function pending(reason: WalletRecoveryPendingReason, retryAtMs: number | null) {
  return { kind: "pending", tag: TAG, reason, retryAtMs } as const;
}

function unavailable(reason: "profile-unavailable" | "read-failed" | "recovery-failed") {
  return {
    kind: "unavailable",
    tag: reason === "profile-unavailable" ? null : TAG,
    reason,
    retryable: reason !== "profile-unavailable",
  } as const;
}

describe("walletRecoveryDisplay", () => {
  it("shows nothing for a completed recovery with current reads", () => {
    expect(
      walletRecoveryDisplay({ status: COMPLETED, profileExpected: true, reads: [OK_CURRENT] }),
    ).toEqual({ state: "complete" });
  });

  it("is checking for a read that began before the latest completed pass", () => {
    // The follow-up read decides. The row does not go blank in between.
    const earlier = { ...OK_CURRENT, afterPassSeq: 2 };
    expect(
      walletRecoveryDisplay({ status: COMPLETED, profileExpected: true, reads: [earlier] }),
    ).toEqual({ state: "checking" });
  });

  it.each([
    ["an unhydrated read", UNHYDRATED],
    ["a read of another activation", { ...OK_CURRENT, tag: OTHER_EPOCH }],
  ])("is checking for %s after a completed recovery", (_name, read) => {
    expect(
      walletRecoveryDisplay({ status: COMPLETED, profileExpected: true, reads: [read] }),
    ).toEqual({ state: "checking" });
  });

  it("is checking while the recovery checks", () => {
    expect(
      walletRecoveryDisplay({ status: CHECKING, profileExpected: true, reads: [OK_CURRENT] }),
    ).toEqual({ state: "checking" });
  });

  it.each([
    ["operation", null, "recovering"],
    ["scan-continues", 5_000, "recovering"],
    ["probe-due", 5_000, "recovering"],
    ["proof-pending", null, "waitingForMint"],
    ["start-limit", 9_000, "resumesAt"],
    ["backoff", 9_000, "resumesAt"],
    // Without a known time, a wait shows as recovery in progress.
    ["start-limit", null, "recovering"],
    ["backoff", null, "recovering"],
  ] as const)("shows a %s wait at %s as %s", (reason, retryAtMs, text) => {
    expect(
      walletRecoveryDisplay({
        status: pending(reason, retryAtMs),
        profileExpected: true,
        reads: [OK_CURRENT],
      }),
    ).toEqual({ state: "pending", text, retryAtMs: text === "resumesAt" ? retryAtMs : null });
  });

  it.each([
    ["recovery-failed", true, "retry", "scope"],
    ["read-failed", true, "reload", "scope"],
    ["profile-unavailable", true, "reload-or-restore", null],
    // A visitor without a wallet sees the wallet setup, not a recovery error.
    ["profile-unavailable", false, "none", null],
  ] as const)(
    "shows %s (wallet expected: %s) with the %s action",
    (reason, profileExpected, action, scopeId) => {
      expect(
        walletRecoveryDisplay({ status: unavailable(reason), profileExpected, reads: [FAILED] }),
      ).toEqual({ state: "unavailable", reason, action, scopeId });
    },
  );

  it.each([
    ["completed", COMPLETED],
    ["checking", CHECKING],
    ["pending", pending("scan-continues", null)],
  ] as const)("shows a failed holdings read as unavailable while %s", (_name, status) => {
    expect(
      walletRecoveryDisplay({ status, profileExpected: true, reads: [OK_CURRENT, FAILED] }),
    ).toEqual({
      state: "unavailable",
      reason: "custody-unavailable",
      action: "reload",
      scopeId: "scope",
    });
  });

  it("uses the status alone when the surface has no holdings read", () => {
    expect(walletRecoveryDisplay({ status: COMPLETED, profileExpected: true })).toEqual({
      state: "complete",
    });
  });
});

describe("walletRecoveryHoldingsUnknown", () => {
  it.each([
    [{ state: "complete" }, false],
    [{ state: "checking" }, true],
    [{ state: "pending", text: "recovering", retryAtMs: null }, true],
    [{ state: "unavailable", reason: "read-failed", action: "reload", scopeId: "scope" }, true],
    [{ state: "unavailable", reason: "profile-unavailable", action: "none", scopeId: null }, false],
  ] as const)("is %j -> %s", (display, unknown) => {
    expect(walletRecoveryHoldingsUnknown(display)).toBe(unknown);
  });
});

describe("walletRecoveryRowsEmptyIsTerminal", () => {
  const emptyCurrent = { ...OK_CURRENT, value: [] };

  it("permits an empty list after a completed recovery and a current empty read", () => {
    expect(walletRecoveryRowsEmptyIsTerminal(COMPLETED, emptyCurrent, [])).toBe(true);
  });

  it("permits an empty tab of a read that has rows on another tab", () => {
    // The closed tab is empty although the read holds an active position.
    expect(walletRecoveryRowsEmptyIsTerminal(COMPLETED, OK_CURRENT, [])).toBe(true);
  });

  it.each([
    ["rows are shown", COMPLETED, emptyCurrent, [1]],
    ["the read is unhydrated", COMPLETED, UNHYDRATED, []],
    ["the read failed", COMPLETED, FAILED, []],
    ["the read began before the pass", COMPLETED, { ...emptyCurrent, afterPassSeq: 2 }, []],
    ["the read has another tag", COMPLETED, { ...emptyCurrent, tag: OTHER_EPOCH }, []],
    ["the recovery checks", CHECKING, emptyCurrent, []],
    ["the coverage is limited", { ...COMPLETED, coverage: "limited" } as const, emptyCurrent, []],
  ] as const)("refuses an empty list when %s", (_name, status, read, rows) => {
    expect(walletRecoveryRowsEmptyIsTerminal(status, read, rows)).toBe(false);
  });
});
