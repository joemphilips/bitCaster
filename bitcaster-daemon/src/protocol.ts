import type { OracleNostrEvent } from '@bitcaster-market/client-sdk'

export type DaemonCommand =
  | { method: 'health'; params?: undefined }
  | { method: 'daemon.status'; params?: undefined }
  | { method: 'daemon.config'; params: { engineUrl?: string; mintUrl?: string } }
  | { method: 'market.create'; params: MarketCreateParams }
  | { method: 'market.close'; params: MarketCloseParams }
  | { method: 'markets.query'; params: QueryMarketsParams }
  | { method: 'markets.show'; params: { conditionId: string } }
  | { method: 'wallet.balance'; params?: undefined }
  | { method: 'wallet.receive'; params: WalletReceiveParams }
  | {
      method: 'wallet.send'
      params: { amountSats: number; mintUrl?: string; operationId?: string }
    }
  | { method: 'wallet.splitCompleteSet'; params: WalletSplitCompleteSetParams }
  | { method: 'wallet.consolidateMarket'; params: WalletConsolidateMarketParams }
  | { method: 'wallet.operations'; params?: { kind?: string; state?: string } }
  | { method: 'wallet.recover'; params?: undefined }
  | { method: 'wallet.seedRecovery'; params: WalletSeedRecoveryParams }
  | { method: 'order.submit'; params: SubmitOrderParams }
  | { method: 'order.status'; params: { marketId: string; orderId: string } }
  | { method: 'order.list'; params?: { marketId?: string; status?: string } }
  | { method: 'order.cancel'; params: { marketId: string; orderId: string } }
  | { method: 'order.book'; params: { marketId: string } }
  | { method: 'trade.list'; params?: { marketId?: string; orderId?: string; step?: string } }
  | { method: 'trade.recover'; params?: undefined }
  | { method: 'trade.watch'; params: { tradeId: string } }

export interface SubmitOrderParams {
  marketId: string
  outcomeId: string
  tokenSide?: 'Outcome' | 'Complement'
  side: 'Buy' | 'Sell'
  price: number
  amountSubunits: number
  timeInForce: 'FAK' | 'FOK' | 'GTC'
  /**
   * Limit-buy maker collateral should be split into a complete set before the
   * order rests. bitcaster-cli sends true by default and false for
   * --no-preflight-split.
   */
  preflightSplit?: boolean
}

export interface QueryMarketsParams {
  state?: 'Open' | 'Closed' | 'Resolved' | 'All'
  sort?: 'Trending' | 'Popular' | 'New'
  tag?: string
  creator?: string
  ids?: string[]
  search?: string
  limit?: number
  cursor?: string
}

export interface MarketCreateParams {
  conditionId: string
  title: string
  description: string
  outcomes: string[]
  liquiditySats?: number
  tags?: string[]
  /** Local file path on the daemon host. */
  thumbnailPath?: string
}

export interface MarketCloseParams {
  conditionId: string
  /** Signed kind-89 DLC oracle attestation event JSON. */
  attestationEvent: OracleNostrEvent
}

export interface WalletReceiveParams {
  token: string
  conditionId?: string
  outcomeSetId?: string
}

export interface WalletSeedRecoveryParams {
  recoveryId: string
  mintUrl: string
  unit: 'sat' | 'msat'
  keysetId: string
  walletSeedHex: string
  disclosureAcknowledged: true
}

export interface WalletSeedRecoveryResult {
  recoveryId: string
  state: 'active' | 'completed'
  nextCounter: number
  batchesProcessed: number
}

export interface WalletSplitCompleteSetParams {
  conditionId: string
  amountSats: number
  mintUrl?: string
  operationId?: string
}

export interface WalletConsolidateMarketParams {
  marketId: string
  // CLI strategy names: merge→t1, sweep→t2, reclaim→t3
  type: 't1' | 't2' | 't3'
}

export interface WalletConsolidationProofSummary {
  id: string
  amount: number
  label: string
  keysetId: string
}

export interface WalletConsolidationResult {
  marketId: string
  conditionId: string
  type: 't1' | 't2' | 't3'
  status: 'consolidated' | 'skipped'
  reason?: string
  convertFeeSats: number
  collateralReturnedSats: number
  spentInputs: WalletConsolidationProofSummary[]
  outputs: WalletConsolidationProofSummary[]
}

export interface DaemonResponse<T = unknown> {
  ok: boolean
  result?: T
  error?: string
  code?: string
}

export interface DaemonHealth {
  status: 'ok'
  service: 'bitcaster-daemon'
  sdk: '@bitcaster-market/client-sdk'
  state: 'ready' | 'missing-profile'
}
