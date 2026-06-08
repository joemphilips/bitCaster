import { beforeEach, describe, expect, it } from "vitest";
import { getSwapDiagnostics, installE2EDiagnostics } from "../e2eDiagnostics";
import { useActiveSwapsStore } from "@/stores/activeSwaps";
import { usePendingTradesStore } from "@/stores/pendingTrades";

beforeEach(() => {
  useActiveSwapsStore.setState({ byTradeId: {} });
  usePendingTradesStore.setState({ byOrderId: {} });
  delete window.__BITCASTER_E2E__;
});

describe("e2e diagnostics", () => {
  it("exposes bundled sanitized swap diagnostics", () => {
    usePendingTradesStore.getState().add({
      orderId: "order-1",
      marketId: "cond-A",
      ephemeralPubkey: "02" + "11".repeat(32),
      ephemeralPrivkey: "22".repeat(32),
      submittedAt: 1_700_000_000_000,
    });
    useActiveSwapsStore.getState().promote({
      tradeId: "trade-1",
      orderId: "order-1",
      marketId: "cond-A",
      ephemeralPrivkeyHex: "33".repeat(32),
      ephemeralPubkeyHex: "02" + "44".repeat(32),
    });
    useActiveSwapsStore
      .getState()
      .recordMessage("trade-1", "lockedProofsBuyer", "ciphertext");
    useActiveSwapsStore.getState().setStep("trade-1", "completed");

    installE2EDiagnostics();

    const snapshot =
      window.__BITCASTER_E2E__?.getSwapDiagnostics("trade-1") ??
      getSwapDiagnostics("trade-1");
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.activeTrade).toMatchObject({
      tradeId: "trade-1",
      orderId: "order-1",
      marketId: "cond-A",
      step: "completed",
      messageTypes: ["lockedProofsBuyer"],
    });
    expect(snapshot.pendingTrades["order-1"]).toEqual({
      orderId: "order-1",
      marketId: "cond-A",
      submittedAt: 1_700_000_000_000,
      hasPreflightSplit: false,
    });
    expect(serialized).not.toContain("22".repeat(32));
    expect(serialized).not.toContain("33".repeat(32));
    expect(serialized).not.toContain("ciphertext");
  });
});
