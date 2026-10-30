import { describe, expect, it, vi } from "vitest";
import {
  beginBrowserCtfRangeOrderAttempt,
  endBrowserCtfRangeOrderAttempt,
  deferBrowserCtfRangeOrderRecovery,
  listenForBrowserCtfRangeRecoveryWake,
} from "../browserCtfRangeOrderRecoveryWake";

describe("browser CTF range recovery wake", () => {
  it("coalesces retained work until every active attempt settles", () => {
    const recover = vi.fn();
    const stopWake = listenForBrowserCtfRangeRecoveryWake("wallet-a", recover);
    beginBrowserCtfRangeOrderAttempt({ scopeId: "wallet-a", operationId: "attempt-a" });
    beginBrowserCtfRangeOrderAttempt({ scopeId: "wallet-a", operationId: "attempt-b" });

    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-a",
      operationId: "attempt-a",
      retainedRecoveryWork: true,
    });
    expect(deferBrowserCtfRangeOrderRecovery("wallet-a")).toBe(true);
    expect(recover).not.toHaveBeenCalled();

    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-a",
      operationId: "attempt-b",
      retainedRecoveryWork: false,
    });
    expect(deferBrowserCtfRangeOrderRecovery("wallet-a")).toBe(false);
    expect(recover).toHaveBeenCalledOnce();
    stopWake();
  });

  it("wakes deferred work only when the last successful attempt releases", () => {
    const recover = vi.fn();
    const stopWake = listenForBrowserCtfRangeRecoveryWake("wallet-deferred", recover);
    beginBrowserCtfRangeOrderAttempt({ scopeId: "wallet-deferred", operationId: "first" });
    beginBrowserCtfRangeOrderAttempt({ scopeId: "wallet-deferred", operationId: "last" });
    expect(deferBrowserCtfRangeOrderRecovery("wallet-absent")).toBe(false);
    expect(deferBrowserCtfRangeOrderRecovery("wallet-deferred")).toBe(true);
    expect(deferBrowserCtfRangeOrderRecovery("wallet-deferred")).toBe(true);
    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-deferred",
      operationId: "first",
      retainedRecoveryWork: false,
    });
    expect(recover).not.toHaveBeenCalled();
    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-deferred",
      operationId: "last",
      retainedRecoveryWork: false,
    });
    expect(recover).toHaveBeenCalledOnce();
    expect(deferBrowserCtfRangeOrderRecovery("wallet-deferred")).toBe(false);
    stopWake();
  });

  it("does not wake without retained work and ignores retired profiles", () => {
    const recover = vi.fn();
    const stopWake = listenForBrowserCtfRangeRecoveryWake("wallet-current", recover);
    beginBrowserCtfRangeOrderAttempt({ scopeId: "wallet-retired", operationId: "attempt" });
    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-retired",
      operationId: "attempt",
      retainedRecoveryWork: true,
    });
    expect(recover).not.toHaveBeenCalled();

    beginBrowserCtfRangeOrderAttempt({ scopeId: "wallet-current", operationId: "successful" });
    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-current",
      operationId: "successful",
      retainedRecoveryWork: false,
    });
    expect(recover).not.toHaveBeenCalled();
    stopWake();
  });
});
