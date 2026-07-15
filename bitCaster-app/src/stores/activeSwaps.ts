/**
 * In-memory state for atomic swaps that have crossed MATCHED but have not yet
 * reached CONFIRMED (or FAILED). Keyed by `tradeId`, never persisted.
 *
 * This store is the working memory of `useTradeSettlement` — it tracks which
 * fills have been promoted to in-progress swaps, what role the user plays in
 * each one, the ciphertexts received from the counterparty, and the small bits
 * of seller/buyer state that must survive across SignalR callbacks.
 *
 * The ephemeral keypair is generated at match time by the
 * `pendingPubkeySubmissions` flow and copied here only after the trade has been
 * promoted to active settlement work.
 *
 * This store remains the working projection. `swapSessions` in the existing
 * IndexedDB database is the durable recovery authority; the settlement hook
 * hydrates this store from that session before driving protocol work.
 */

import { create } from "zustand";
import type { Proof } from "@cashu/cashu-ts";
import type { AdaptorPoint } from "@/lib/adaptor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SwapRole = "seller" | "buyer";

/**
 * Tracks which protocol messages have been observed for a given trade. Each
 * field holds the ciphertext from the wire so the seller/buyer driver can
 * pick up after a re-render without a second hub fetch.
 *
 * `adaptorPoint` and `lockedProofsSeller` come from the seller (Alice).
 * `lockedProofsBuyer` comes from the buyer (Bob).
 */
export interface SwapMessages {
  adaptorPoint?: string;
  lockedProofsSeller?: string;
  lockedProofsBuyer?: string;
}

export interface SellerProtocolState {
  adaptorPoint: AdaptorPoint;
  /** Exact previously journaled ciphertexts; never regenerate on recovery. */
  adaptorPointCipher?: string;
  lockedProofsCipher?: string;
}

export interface BuyerProtocolState {
  /** Bob's pre-sigs over Bob's locked sat proofs — extract `t` from these. */
  ownPreSigsHex: string[];
  /** The proofs Bob locked to Alice; needed for the NUT-07 poll. */
  lockedSatProofs: Proof[];
  /** Bob's encrypted locked-proofs message; replayed seller messages resend this. */
  lockedProofsCipher: string;
  /** Alice's pre-sigs from her locked-proofs message — adapted on claim. */
  sellerPreSigsHex: string[];
}

export interface BuyerProtocolPreparation {
  /** Persisted before proof preparation; reconstructs one exact AES-GCM cipher. */
  lockedProofsCipherIv: Uint8Array;
}

export type SettlementCompleteDelivery = "not-ready" | "pending" | "delivered";

export type SwapWorkKey = "seller-open" | "buyer-respond" | "settle";

/** What stage of the protocol the local driver has finished. */
export type SwapStep =
  | "awaiting-trade-created"
  | "awaiting-counterparty"
  | "driving"
  | "awaiting-confirmation"
  | "awaiting-refund"
  | "completed"
  | "Failed";

export interface ActiveSwapInit {
  tradeId: string;
  orderId: string;
  clientOrderId?: string;
  marketId: string;
  ephemeralPrivkeyHex: string;
  ephemeralPubkeyHex: string;
  baseAsset?: string | null;
  divisibility?: number | null;
  side?: "Buy" | "Sell";
  tokenSide?: "Outcome" | "Complement";
  priceSubunits?: number | null;
  amountSubunits?: number | null;
  timeInForce?: "FAK" | "FOK" | "GTC";
  isTaker?: boolean;
  matchedAmountSubunits?: number | null;
  recoveryAttempt?: number;
}

export interface ActiveSwap {
  tradeId: string;
  /** The order whose fill triggered this swap. */
  orderId: string;
  clientOrderId?: string;
  marketId: string;
  /** Immutable mint transport once durable settlement work starts. */
  mintUrl: string | null;
  /**
   * Ephemeral keypair seeded from `pendingPubkeySubmissions` at promote-time.
   * Captured here so the swap can survive even after the pending-pubkey entry
   * is evicted on terminal settlement status. Both halves are hex.
   */
  ephemeralPrivkeyHex: string;
  ephemeralPubkeyHex: string;
  role: SwapRole | null;
  counterpartyPubkey: string | null;
  /** Unix seconds — Alice's locktime per the protocol spec. */
  sellerLocktime: number | null;
  /** Unix seconds — Bob's shorter locktime. */
  buyerLocktime: number | null;
  /** Face amount of outcome tokens the seller locks. */
  outcomeFaceAmountSats: number | null;
  /** Canonical face amount of outcome tokens the seller locks, in market subunits. */
  outcomeFaceAmountSubunits: number | null;
  /** Regular sats the buyer locks. */
  quotePaymentSats: number | null;
  baseAsset: string | null;
  divisibility: number | null;
  side?: "Buy" | "Sell";
  tokenSide?: "Outcome" | "Complement";
  priceSubunits?: number | null;
  amountSubunits?: number | null;
  timeInForce?: "FAK" | "FOK" | "GTC";
  /** True only when the engine fill identifies this local order as the taker. */
  isTaker?: boolean;
  /** Exact face amount associated with this particular fill. */
  matchedAmountSubunits?: number | null;
  /** Prior replacement-order count carried from the pending order. */
  recoveryAttempt?: number;
  /** Idempotency record for the maker-caused taker replacement request. */
  takerRecovery?: {
    clientOrderId: string;
    status: "pending" | "submitted";
    replacementOrderId?: string;
  };
  quotePaymentSubunits: number | null;
  settlementKind: string | null;
  sellerKeepOutcomeSetId: string | null;
  sellerLockOutcomeSetId: string | null;
  step: SwapStep;
  messages: SwapMessages;
  sellerState: SellerProtocolState | null;
  buyerPreparation: BuyerProtocolPreparation | null;
  buyerState: BuyerProtocolState | null;
  settlementCompleteDelivery: SettlementCompleteDelivery;
  inFlightSteps: Partial<Record<SwapWorkKey, true>>;
  /** Last error message if the swap fell into the `failed` step. */
  error: string | null;
  startedAt: number;
}

interface ActiveSwapsState {
  byTradeId: Record<string, ActiveSwap>;
  promote: (init: ActiveSwapInit) => void;
  setRoleAndCounterparty: (
    tradeId: string,
    role: SwapRole,
    counterpartyPubkey: string,
    locktimes: { sellerLocktime: number; buyerLocktime: number },
    settlementAmounts?: {
      outcomeFaceAmountSats?: number;
      outcomeFaceAmountSubunits?: number;
      quotePaymentSats?: number;
      baseAsset?: string | null;
      divisibility?: number | null;
      quotePaymentSubunits?: number | null;
      settlementKind?: string | null;
      sellerKeepOutcomeSetId?: string | null;
      sellerLockOutcomeSetId?: string | null;
    },
  ) => void;
  recordMessage: (
    tradeId: string,
    messageType: keyof SwapMessages,
    ciphertext: string,
  ) => void;
  setSellerState: (tradeId: string, state: SellerProtocolState) => void;
  setBuyerPreparation: (
    tradeId: string,
    preparation: BuyerProtocolPreparation,
  ) => void;
  setBuyerState: (tradeId: string, state: BuyerProtocolState) => void;
  setSettlementCompleteDelivery: (
    tradeId: string,
    delivery: SettlementCompleteDelivery,
  ) => void;
  beginTakerRecovery: (tradeId: string, clientOrderId: string) => string | null;
  markTakerRecoverySubmitted: (
    tradeId: string,
    replacementOrderId: string,
  ) => void;
  pinMintUrl: (tradeId: string, mintUrl: string) => void;
  claimStep: (tradeId: string, key: SwapWorkKey) => boolean;
  releaseStep: (tradeId: string, key: SwapWorkKey) => void;
  setStep: (tradeId: string, step: SwapStep, error?: string) => void;
  hydrate: (swaps: ActiveSwap[]) => void;
  remove: (tradeId: string) => void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/**
 * Lightweight zustand store, no middleware. Reads / writes happen from the
 * `useTradeSettlement` hook and from the SignalR callbacks fired by it.
 */
export const useActiveSwapsStore = create<ActiveSwapsState>()((set, get) => ({
  byTradeId: {},

  promote: (init) => {
    set((s) => {
      if (s.byTradeId[init.tradeId]) return s;
      const swap = createActiveSwap(init);
      return { byTradeId: { ...s.byTradeId, [init.tradeId]: swap } };
    });
  },

  setRoleAndCounterparty: (
    tradeId,
    role,
    counterpartyPubkey,
    locktimes,
    settlementAmounts,
  ) => {
    set((s) => {
      const existing = s.byTradeId[tradeId];
      if (!existing) return s;
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: {
            ...existing,
            role,
            counterpartyPubkey,
            sellerLocktime: locktimes.sellerLocktime,
            buyerLocktime: locktimes.buyerLocktime,
            outcomeFaceAmountSats:
              settlementAmounts?.outcomeFaceAmountSats ??
              existing.outcomeFaceAmountSats,
            outcomeFaceAmountSubunits:
              settlementAmounts?.outcomeFaceAmountSubunits ??
              existing.outcomeFaceAmountSubunits,
            quotePaymentSats:
              settlementAmounts?.quotePaymentSats ?? existing.quotePaymentSats,
            baseAsset: settlementAmounts?.baseAsset ?? existing.baseAsset,
            divisibility:
              settlementAmounts?.divisibility ?? existing.divisibility,
            quotePaymentSubunits:
              settlementAmounts?.quotePaymentSubunits ??
              existing.quotePaymentSubunits,
            settlementKind:
              settlementAmounts?.settlementKind ?? existing.settlementKind,
            sellerKeepOutcomeSetId:
              settlementAmounts?.sellerKeepOutcomeSetId ??
              existing.sellerKeepOutcomeSetId,
            sellerLockOutcomeSetId:
              settlementAmounts?.sellerLockOutcomeSetId ??
              existing.sellerLockOutcomeSetId,
            step:
              existing.step === "awaiting-trade-created"
                ? "awaiting-counterparty"
                : existing.step,
          },
        },
      };
    });
  },

  recordMessage: (tradeId, messageType, ciphertext) => {
    set((s) => {
      const existing = s.byTradeId[tradeId];
      if (!existing) return s;
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: {
            ...existing,
            messages: { ...existing.messages, [messageType]: ciphertext },
          },
        },
      };
    });
  },

  setSellerState: (tradeId, sellerState) => {
    set((s) => {
      const existing = s.byTradeId[tradeId];
      if (!existing) return s;
      const prior = existing.sellerState;
      if (
        prior &&
        !sameAdaptorPoint(prior.adaptorPoint, sellerState.adaptorPoint)
      ) {
        throw new Error("Seller adaptor state cannot be replaced");
      }
      const merged: SellerProtocolState = {
        adaptorPoint: prior?.adaptorPoint ?? sellerState.adaptorPoint,
        adaptorPointCipher: mergeProtocolCipher(
          prior?.adaptorPointCipher,
          sellerState.adaptorPointCipher,
        ),
        lockedProofsCipher: mergeProtocolCipher(
          prior?.lockedProofsCipher,
          sellerState.lockedProofsCipher,
        ),
      };
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: { ...existing, sellerState: merged },
        },
      };
    });
  },

  setBuyerPreparation: (tradeId, buyerPreparation) => {
    set((s) => {
      const existing = s.byTradeId[tradeId];
      if (!existing) return s;
      const prior = existing.buyerPreparation;
      if (
        prior &&
        !sameBytes(
          prior.lockedProofsCipherIv,
          buyerPreparation.lockedProofsCipherIv,
        )
      ) {
        throw new Error("Buyer protocol preparation cannot be replaced");
      }
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: {
            ...existing,
            buyerPreparation: {
              lockedProofsCipherIv:
                prior?.lockedProofsCipherIv ??
                buyerPreparation.lockedProofsCipherIv,
            },
          },
        },
      };
    });
  },

  setBuyerState: (tradeId, buyerState) => {
    set((s) => {
      const existing = s.byTradeId[tradeId];
      if (!existing) return s;
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: { ...existing, buyerState },
        },
      };
    });
  },

  setSettlementCompleteDelivery: (tradeId, settlementCompleteDelivery) => {
    set((s) => {
      const existing = s.byTradeId[tradeId];
      if (!existing) return s;
      const rank: Record<SettlementCompleteDelivery, number> = {
        "not-ready": 0,
        pending: 1,
        delivered: 2,
      };
      if (
        rank[settlementCompleteDelivery] <
        rank[existing.settlementCompleteDelivery]
      ) {
        throw new Error("Settlement delivery cannot regress");
      }
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: { ...existing, settlementCompleteDelivery },
        },
      };
    });
  },

  pinMintUrl: (tradeId, mintUrl) => {
    set((s) => {
      const existing = s.byTradeId[tradeId];
      if (!existing) return s;
      if (existing.mintUrl !== null && existing.mintUrl !== mintUrl) {
        throw new Error("Active swap mint cannot be changed");
      }
      if (existing.mintUrl === mintUrl) return s;
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: { ...existing, mintUrl },
        },
      };
    });
  },

  beginTakerRecovery: (tradeId, clientOrderId) => {
    const existing = get().byTradeId[tradeId];
    if (!existing || existing.takerRecovery) return null;
    set((s) => {
      const current = s.byTradeId[tradeId];
      if (!current || current.takerRecovery) return s;
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: {
            ...current,
            takerRecovery: { clientOrderId, status: "pending" },
          },
        },
      };
    });
    return get().byTradeId[tradeId]?.takerRecovery?.clientOrderId ?? null;
  },

  markTakerRecoverySubmitted: (tradeId, replacementOrderId) => {
    set((s) => {
      const existing = s.byTradeId[tradeId];
      if (!existing?.takerRecovery) return s;
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: {
            ...existing,
            takerRecovery: {
              ...existing.takerRecovery,
              status: "submitted",
              replacementOrderId,
            },
          },
        },
      };
    });
  },

  claimStep: (tradeId, key) => {
    const existing = get().byTradeId[tradeId];
    if (!existing || existing.inFlightSteps[key]) return false;
    set((s) => {
      const current = s.byTradeId[tradeId];
      if (!current || current.inFlightSteps[key]) return s;
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: {
            ...current,
            inFlightSteps: { ...current.inFlightSteps, [key]: true },
          },
        },
      };
    });
    return true;
  },

  releaseStep: (tradeId, key) => {
    set((s) => {
      const existing = s.byTradeId[tradeId];
      if (!existing || !existing.inFlightSteps[key]) return s;
      const nextInFlight = { ...existing.inFlightSteps };
      delete nextInFlight[key];
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: { ...existing, inFlightSteps: nextInFlight },
        },
      };
    });
  },

  setStep: (tradeId, step, error) => {
    set((s) => {
      const existing = s.byTradeId[tradeId];
      if (!existing) return s;
      return {
        byTradeId: {
          ...s.byTradeId,
          [tradeId]: { ...existing, step, error: error ?? existing.error },
        },
      };
    });
  },

  hydrate: (swaps) => {
    set((s) => {
      const byTradeId = { ...s.byTradeId };
      for (const swap of swaps) {
        if (!byTradeId[swap.tradeId]) byTradeId[swap.tradeId] = swap;
      }
      return { byTradeId };
    });
  },

  remove: (tradeId) => {
    set((s) => {
      if (!(tradeId in s.byTradeId)) return s;
      const next = { ...s.byTradeId };
      delete next[tradeId];
      return { byTradeId: next };
    });
  },
}));

export function createActiveSwap(
  init: ActiveSwapInit,
  startedAt = Date.now(),
): ActiveSwap {
  return {
    ...init,
    mintUrl: null,
    role: null,
    counterpartyPubkey: null,
    sellerLocktime: null,
    buyerLocktime: null,
    outcomeFaceAmountSats: null,
    outcomeFaceAmountSubunits: null,
    quotePaymentSats: null,
    baseAsset: init.baseAsset ?? null,
    divisibility: init.divisibility ?? null,
    priceSubunits: init.priceSubunits ?? null,
    amountSubunits: init.amountSubunits ?? null,
    matchedAmountSubunits: init.matchedAmountSubunits ?? null,
    recoveryAttempt: init.recoveryAttempt ?? 0,
    quotePaymentSubunits: null,
    settlementKind: null,
    sellerKeepOutcomeSetId: null,
    sellerLockOutcomeSetId: null,
    step: "awaiting-trade-created",
    messages: {},
    sellerState: null,
    buyerPreparation: null,
    buyerState: null,
    settlementCompleteDelivery: "not-ready",
    inFlightSteps: {},
    error: null,
    startedAt,
  };
}

function sameAdaptorPoint(
  left: SellerProtocolState["adaptorPoint"],
  right: SellerProtocolState["adaptorPoint"],
): boolean {
  return (
    sameBytes(left.secret, right.secret) && sameBytes(left.point, right.point)
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.length === right.length &&
    left.every((byte, index) => byte === right[index])
  );
}

function mergeProtocolCipher(
  prior: string | undefined,
  next: string | undefined,
): string | undefined {
  if (prior !== undefined && prior !== next) {
    throw new Error("Protocol cipher cannot be erased or replaced");
  }
  return prior ?? next;
}
