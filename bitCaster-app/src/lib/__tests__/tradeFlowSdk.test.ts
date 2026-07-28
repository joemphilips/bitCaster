import { describe, expect, it } from "vitest";
import {
  decideSwapMessage,
  decideTradeCreated,
  decideTradeStateChanged,
} from "@bitcaster/client-sdk/tradeFlow";
import { TRADE_MESSAGE_TYPES } from "@bitcaster/client-sdk/tradeSession";

const SAT_MARKET_ORDER_CAP_SUBUNITS = 100_000_000_000_000;

describe("shared trade-flow event planner", () => {
  it("accepts own TradeCreated payloads and resolves local role", () => {
    const decision = decideTradeCreated({
      ownEphemeralPubkey: "abc",
      sellerPubkey: "ABC",
      buyerPubkey: "def",
      sellerLocktime: 120,
      buyerLocktime: 60,
      settlementKind: "DirectSwap",
      baseAsset: "sat",
      divisibility: 10_000,
      outcomeFaceAmountSubunits: 10_000,
      quotePaymentSubunits: 5_000,
    });

    expect(decision).toMatchObject({
      accepted: true,
      role: "seller",
      counterpartyPubkey: "def",
      sellerLocktime: 120,
      buyerLocktime: 60,
    });
  });

  it("rejects malformed settlement metadata fail-closed before locking proofs", () => {
    const decision = decideTradeCreated({
      ownEphemeralPubkey: "abc",
      sellerPubkey: "abc",
      buyerPubkey: "def",
      sellerLocktime: 120,
      buyerLocktime: 60,
      settlementKind: "SellSellMerge",
      baseAsset: "sat",
      divisibility: 10_000,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "invalid-protocol",
    });
  });

  it("accepts safe TradeCreated subunit amounts at the sat-market order cap", () => {
    const decision = decideTradeCreated({
      ownEphemeralPubkey: "buyer",
      sellerPubkey: "seller",
      buyerPubkey: "buyer",
      sellerLocktime: 120,
      buyerLocktime: 60,
      settlementKind: "DirectSwap",
      baseAsset: "sat",
      divisibility: 10_000,
      expectedBaseAsset: "sat",
      expectedDivisibility: 10_000,
      expectedOrder: {
        side: "Buy",
        priceSubunits: 5_000,
        amountSubunits: SAT_MARKET_ORDER_CAP_SUBUNITS,
      },
      requireExpectedOrder: true,
      outcomeFaceAmountSubunits: SAT_MARKET_ORDER_CAP_SUBUNITS,
      quotePaymentSubunits: SAT_MARKET_ORDER_CAP_SUBUNITS / 2,
    });

    expect(decision).toMatchObject({ accepted: true, role: "buyer" });
  });

  it("rejects TradeCreated subunit amounts above the submitted order cap", () => {
    const decision = decideTradeCreated({
      ownEphemeralPubkey: "buyer",
      sellerPubkey: "seller",
      buyerPubkey: "buyer",
      sellerLocktime: 120,
      buyerLocktime: 60,
      settlementKind: "DirectSwap",
      baseAsset: "sat",
      divisibility: 10_000,
      expectedBaseAsset: "sat",
      expectedDivisibility: 10_000,
      expectedOrder: {
        side: "Buy",
        priceSubunits: 5_000,
        amountSubunits: SAT_MARKET_ORDER_CAP_SUBUNITS,
      },
      requireExpectedOrder: true,
      outcomeFaceAmountSubunits: SAT_MARKET_ORDER_CAP_SUBUNITS + 1,
      quotePaymentSubunits: SAT_MARKET_ORDER_CAP_SUBUNITS / 2,
    });

    expect(decision).toMatchObject({ accepted: false });
    if (!decision.accepted) {
      expect(decision.error).toMatch(/whole market share|exceeds the submitted order amount/);
    }
  });

  it("rejects unsafe TradeCreated subunit amounts as invalid protocol metadata", () => {
    const decision = decideTradeCreated({
      ownEphemeralPubkey: "buyer",
      sellerPubkey: "seller",
      buyerPubkey: "buyer",
      sellerLocktime: 120,
      buyerLocktime: 60,
      settlementKind: "DirectSwap",
      baseAsset: "sat",
      divisibility: 10_000,
      expectedBaseAsset: "sat",
      expectedDivisibility: 10_000,
      expectedOrder: {
        side: "Buy",
        priceSubunits: 5_000,
        amountSubunits: SAT_MARKET_ORDER_CAP_SUBUNITS,
      },
      requireExpectedOrder: true,
      outcomeFaceAmountSubunits: 2 ** 53,
      quotePaymentSubunits: SAT_MARKET_ORDER_CAP_SUBUNITS / 2,
    });

    expect(decision).toMatchObject({
      accepted: false,
      reason: "invalid-protocol",
    });
    if (!decision.accepted) {
      expect(decision.error).toMatch(/safe integer/);
    }
  });

  it("plans buyer response once both seller ciphertexts are present", () => {
    const first = decideSwapMessage({
      role: "buyer",
      messages: {},
      messageType: TRADE_MESSAGE_TYPES.adaptorPoint,
      ciphertext: "cipher-a",
    });
    expect(first).toMatchObject({
      messageKey: "adaptorPoint",
      action: "none",
    });

    const second = decideSwapMessage({
      role: "buyer",
      messages: first.messages,
      messageType: TRADE_MESSAGE_TYPES.lockedProofsSeller,
      ciphertext: "cipher-s",
    });
    expect(second).toMatchObject({
      messageKey: "lockedProofsSeller",
      action: "buyer-respond",
    });
  });

  it("maps engine trade states to driver actions", () => {
    expect(decideTradeStateChanged("Settling")).toBe("settlement-claim");
    expect(decideTradeStateChanged("Confirmed")).toBe("finish-confirmed");
    expect(decideTradeStateChanged("Cancelled")).toBe("finish-failed");
    expect(decideTradeStateChanged("Unknown")).toBe("none");
  });
});
