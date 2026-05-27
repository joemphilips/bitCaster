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

export interface PartialLockHeldRecord extends SwapFailure {
  kind: 'PartialLockHeld'
  refundLocktime: number
  affectedKeysets: string[]
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
