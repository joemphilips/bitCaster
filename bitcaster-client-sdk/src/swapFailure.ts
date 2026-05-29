export type SwapFailureKind =
  | 'PartialLockHeld'
  | 'InsufficientInventory'
  | 'MintError'
  | 'EngineRejected'

export interface SwapFailure {
  kind: SwapFailureKind
  refundLocktime?: number
  affectedKeysets?: string[]
  detail: string
}

export interface OutcomeMetadata {
  conditionId: string
  outcomeCollection: string
  marketId: string
}

export interface PartialLockProofRecord {
  id?: string
  amount: unknown
  secret: string
  C: string
  witness?: unknown
  dleq?: unknown
}

export interface PartialLockHeldRecord extends SwapFailure {
  kind: 'PartialLockHeld'
  tradeId: string
  orderId?: string
  mintUrl?: string
  refundLocktime: number
  affectedKeysets: string[]
  outcomeByKeyset: Record<string, OutcomeMetadata>
  lockedProofs: PartialLockProofRecord[]
  createdAt?: number
}

export function redactSwapFailureForTelemetry(
  failure: SwapFailure,
): Pick<SwapFailure, 'kind' | 'refundLocktime'> {
  return {
    kind: failure.kind,
    ...(failure.refundLocktime === undefined
      ? {}
      : { refundLocktime: failure.refundLocktime }),
  }
}
