export const TRADE_TERMINAL_EVENT = "bitcaster:trade-terminal";

export interface TradeTerminalDetail {
  tradeId: string;
  marketId: string;
  state: "Confirmed" | "Failed";
}

export function emitTradeTerminal(detail: TradeTerminalDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TradeTerminalDetail>(TRADE_TERMINAL_EVENT, { detail }));
}

export function onTradeTerminal(handler: (detail: TradeTerminalDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    handler((event as CustomEvent<TradeTerminalDetail>).detail);
  };
  window.addEventListener(TRADE_TERMINAL_EVENT, listener);
  return () => window.removeEventListener(TRADE_TERMINAL_EVENT, listener);
}
