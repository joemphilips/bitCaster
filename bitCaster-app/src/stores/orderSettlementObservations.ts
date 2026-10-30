import { create } from "zustand";
import type { SettlementGroupSummary } from "@bitcaster/client-sdk/engineClient";
import type { OrderStatusResponse } from "@/lib/orderStatus";
import { settlementGroupForOrder } from "@/lib/settlementProgressReader";
import { usePendingTradesStore, type PendingTrade } from "./pendingTrades";

export interface OrderSettlementObservation {
  readonly walletId: string;
  readonly signerRevision: number;
  readonly marketId: string;
  readonly orderId: string;
  readonly status: OrderStatusResponse["status"];
  readonly group: SettlementGroupSummary | null;
}

interface ObservationState {
  readonly byOrderId: Readonly<Record<string, OrderSettlementObservation>>;
  publish: (trade: PendingTrade, signerRevision: number, response: OrderStatusResponse) => void;
  retain: (walletId: string | null, pending: Readonly<Record<string, PendingTrade>>) => void;
}

/** Ephemeral display facts. Pending work bounds retention; these facts grant no funds authority. */
export const useOrderSettlementObservations = create<ObservationState>((set) => ({
  byOrderId: {},
  publish: (trade, signerRevision, response) => {
    const latest = usePendingTradesStore.getState().byOrderId[trade.orderId];
    if (
      !trade.walletId ||
      latest?.walletId !== trade.walletId ||
      latest.marketId !== trade.marketId ||
      latest.clientOrderId !== trade.clientOrderId ||
      response.orderId !== trade.orderId ||
      response.marketId !== trade.marketId
    )
      return;
    let group: SettlementGroupSummary | null;
    try {
      group = settlementGroupForOrder(response, trade.marketId, trade.orderId);
    } catch {
      return;
    }
    const observation: OrderSettlementObservation = {
      walletId: trade.walletId,
      signerRevision,
      marketId: trade.marketId,
      orderId: trade.orderId,
      status: response.status,
      group,
    };
    set((state) => {
      const previous = state.byOrderId[trade.orderId];
      if (
        previous?.walletId === observation.walletId &&
        previous.signerRevision === signerRevision &&
        previous.marketId === observation.marketId &&
        previous.group !== null &&
        (group === null ||
          (previous.group.groupId === group.groupId && previous.group.revision > group.revision))
      )
        return state;
      return { byOrderId: { ...state.byOrderId, [trade.orderId]: observation } };
    });
  },
  retain: (walletId, pending) =>
    set((state) => {
      const retained = Object.entries(state.byOrderId).filter(
        ([orderId, observation]) =>
          walletId !== null &&
          observation.walletId === walletId &&
          pending[orderId]?.walletId === walletId &&
          pending[orderId]?.marketId === observation.marketId,
      );
      return retained.length === Object.keys(state.byOrderId).length
        ? state
        : { byOrderId: Object.fromEntries(retained) };
    }),
}));
