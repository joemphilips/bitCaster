import type { SpeculativeCounterTranscript } from "@bitcaster/client-sdk/speculativeCounterTranscript";
import type { DurableWalletSendOperation } from "@bitcaster/client-sdk/durableWalletOperation";
import type { BrowserWalletCounterDexieStore } from "../stores/browser-wallet-counter-db";

export interface BrowserOutgoingCounterPreparation {
  readonly transcript: SpeculativeCounterTranscript;
  readonly counterStore: BrowserWalletCounterDexieStore;
  readonly counterContext: { readonly mintUrl: string; readonly unit: string };
}

const preparations = new WeakMap<DurableWalletSendOperation, BrowserOutgoingCounterPreparation>();

export function bindBrowserOutgoingCounterPreparation(
  operation: DurableWalletSendOperation,
  preparation: BrowserOutgoingCounterPreparation,
): void {
  preparations.set(operation, preparation);
}

export function browserOutgoingCounterPreparationFor(
  operation: DurableWalletSendOperation,
): BrowserOutgoingCounterPreparation {
  const preparation = preparations.get(operation);
  if (preparation === undefined) {
    throw new Error("browser outgoing operation has no speculative counter authority");
  }
  return preparation;
}
