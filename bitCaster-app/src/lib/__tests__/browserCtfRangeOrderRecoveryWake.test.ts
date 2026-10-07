import { describe, expect, it, vi } from "vitest";
import {
  beginBrowserCtfRangeOrderAttempt,
  endBrowserCtfRangeOrderAttempt,
  hasActiveBrowserCtfRangeOrderAttempt,
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
    expect(hasActiveBrowserCtfRangeOrderAttempt("wallet-a")).toBe(true);
    expect(recover).not.toHaveBeenCalled();

    endBrowserCtfRangeOrderAttempt({
      scopeId: "wallet-a",
      operationId: "attempt-b",
      retainedRecoveryWork: false,
    });
    expect(hasActiveBrowserCtfRangeOrderAttempt("wallet-a")).toBe(false);
    expect(recover).toHaveBeenCalledOnce();
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
