const EVENT = "bitcaster:settlement-progress-hint";
export type SettlementProgressHint = { orderId: string; marketId: string } | null;

/** A refresh hint only. It carries no settlement or wallet authority. */
export function publishSettlementProgressHint(hint: SettlementProgressHint): void {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: hint }));
}

export function listenForSettlementProgressHints(
  listener: (hint: SettlementProgressHint) => void,
): () => void {
  const handle = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const value: unknown = event.detail;
    if (value === null) listener(null);
    else if (
      typeof value === "object" &&
      value !== null &&
      "orderId" in value &&
      typeof value.orderId === "string" &&
      "marketId" in value &&
      typeof value.marketId === "string"
    ) {
      listener({ orderId: value.orderId, marketId: value.marketId });
    }
  };
  window.addEventListener(EVENT, handle);
  return () => window.removeEventListener(EVENT, handle);
}
