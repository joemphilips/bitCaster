import { useEffect, useMemo, useRef } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import type { DurableCustodyScope } from "@bitcaster/client-sdk/durableCustody";
import { parseOrderRouteId } from "@bitcaster/client-sdk/orderRoute";
import {
  activeBrowserWalletScopeId,
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import {
  readBrowserTradeRecoveryObservation,
  type BrowserTradeRecoveryObservation,
} from "@/lib/browserTradeRecoveryObservation";
import { hasActiveCtfRangePreparation } from "@/stores/ctf-range-order-db";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import {
  useOrderSettlementObservations,
  type OrderSettlementObservation,
} from "@/stores/orderSettlementObservations";
import { assertNever } from "@/lib/enumDiscipline";

export type MarketTradeRecoveryStage =
  | "order-pending"
  | "settlement-pending"
  | "wallet-recovery"
  | "result-saved"
  | "unavailable";
export interface MarketTradeRecoveryDisplay {
  readonly stages: readonly MarketTradeRecoveryStage[];
  readonly suppressFundingHint: boolean;
  /** Local display facts invalidate estimates; they do not establish source freshness. */
  readonly invalidationKey: string;
}

export function marketTradeRecoveryStage(
  local: BrowserTradeRecoveryObservation | null,
  observed: OrderSettlementObservation | undefined,
): MarketTradeRecoveryStage {
  const resultState = local?.resultState ?? null;
  switch (resultState) {
    case "applied":
      return "result-saved";
    case "verified-staged":
      return "wallet-recovery";
    case "none":
    case null:
      break;
    default:
      return assertNever(resultState);
  }
  const groupStatus = observed?.group?.status ?? null;
  switch (groupStatus) {
    case "Prepared":
    case "SubmissionPending":
    case "Reconciling":
      return "settlement-pending";
    case "Confirmed":
    case "DefinitivelyRejected":
    case "Refundable":
    case "ExpiredBeforeSubmission":
    case "RejectedBeforeSubmission":
      return local?.resultState === "none" ? "wallet-recovery" : "unavailable";
    case null:
      return "order-pending";
    default:
      return assertNever(groupStatus);
  }
}

/** Display-only consumer of the existing lifecycle reader and exact local custody facts. */
export function useMarketTradeRecovery({
  mnemonic,
  conditionId,
  signerRevision,
}: {
  mnemonic: string | null;
  conditionId: string | null;
  signerRevision: number;
}): MarketTradeRecoveryDisplay {
  const pending = usePendingTradesStore((state) => state.byOrderId);
  const observations = useOrderSettlementObservations((state) => state.byOrderId);
  const activeScopeId = activeBrowserWalletScopeId();
  const scope = useMemo<Extract<DurableCustodyScope, { scopeKind: "wallet" }> | null>(() => {
    const walletId = mnemonic === null ? null : browserWalletIdFromMnemonic(mnemonic);
    const scopeId = mnemonic === null ? null : browserWalletScopeIdFromMnemonic(mnemonic);
    return walletId !== null && scopeId !== null && scopeId === activeScopeId
      ? { scopeKind: "wallet", walletId, scopeId }
      : null;
  }, [mnemonic, activeScopeId]);
  const trades = useMemo(
    () =>
      Object.values(pending)
        .filter(
          (trade) =>
            scope !== null &&
            conditionId !== null &&
            trade.walletId === scope.walletId &&
            parseOrderRouteId(trade.marketId)?.conditionId === conditionId,
        )
        .sort((left, right) => left.orderId.localeCompare(right.orderId)),
    [pending, scope, conditionId],
  );
  const identityKey = JSON.stringify([
    scope?.scopeId ?? null,
    conditionId,
    signerRevision,
    trades.map((trade) => [trade.orderId, trade.marketId, trade.clientOrderId ?? null]),
  ]);
  const currentIdentityRef = useRef(identityKey);
  currentIdentityRef.current = identityKey;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const local = useLiveQuery(
    async () => {
      if (scope === null || conditionId === null) return null;
      try {
        const active = await hasActiveCtfRangePreparation(scope.scopeId);
        if (
          !mountedRef.current ||
          currentIdentityRef.current !== identityKey ||
          activeBrowserWalletScopeId() !== scope.scopeId
        )
          return null;
        const records = await Promise.all(
          trades.map(async (trade) => ({
            orderId: trade.orderId,
            observation: await readBrowserTradeRecoveryObservation(scope, trade),
          })),
        );
        return { identityKey, active, records, unavailable: false };
      } catch {
        return { identityKey, active: true, records: [], unavailable: true };
      }
    },
    [identityKey],
    null,
  );
  const current = local?.identityKey === identityKey ? local : null;
  const localByOrderId = new Map(current?.records.map((item) => [item.orderId, item.observation]));
  const scopedObservations = trades.map((trade) => {
    const observed = observations[trade.orderId];
    return observed?.walletId === scope?.walletId &&
      observed.signerRevision === signerRevision &&
      observed.marketId === trade.marketId &&
      observed.orderId === trade.orderId
      ? observed
      : undefined;
  });
  const facts = trades.map((trade, index) => {
    const record = localByOrderId.get(trade.orderId) ?? null;
    const observed = scopedObservations[index];
    return [
      trade.orderId,
      record?.lifecycleState ?? null,
      record?.resultState ?? null,
      observed?.status ?? null,
      observed?.group?.groupId ?? null,
      observed?.group?.revision ?? null,
      observed?.group?.status ?? null,
    ];
  });
  return {
    stages: [
      ...new Set(
        trades.map((trade, index) =>
          current === null || current.unavailable
            ? ("unavailable" as const)
            : marketTradeRecoveryStage(
                localByOrderId.get(trade.orderId) ?? null,
                scopedObservations[index],
              ),
        ),
      ),
    ],
    suppressFundingHint:
      scope !== null && (current === null || current.active || trades.length > 0),
    invalidationKey: JSON.stringify([
      identityKey,
      current === null ? "loading" : current.unavailable ? "unavailable" : "ready",
      current?.active ?? null,
      facts,
    ]),
  };
}
