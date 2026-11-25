import { DURABLE_CUSTODY_RECORD_BYTES_MAX } from './durableCustody.ts'

/**
 * The inputs of one new send or payment. A lower limit keeps small proofs in a wallet that receives
 * many of them. A record that holds up to DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX inputs still loads.
 */
export const NEW_WALLET_OPERATION_INPUT_LIMIT = 128

/** Upper bounds of the custody record bytes, before and after the mint answer. */
const RECORD_BYTES = 9_600
const RECORD_BYTES_PER_INPUT = 320
const RECORD_BYTES_PER_OUTPUT = 260
const RECORD_BYTES_PER_KEYSET = 320
/** RECORD_BYTES holds a key of this size. The record names the key many times, also encoded. */
const ASSUMED_KEY_BYTES = 128
const RECORD_BYTES_PER_KEY_BYTE = 20
/** Longer than each text that a later state adds: admission ids, tombstones, a terminal rejection. */
export const LATER_RECORD_TEXT_BYTES = 1_024

/** Refused before any effect. The message holds no wallet data. */
export class WalletOperationTooLargeError extends Error {
  readonly code = 'wallet-operation-too-large'

  /** The caller can add what the user can do. That depends on the operation. */
  constructor(
    message = 'The operation needs more proofs than one operation can hold. Nothing was sent.',
  ) {
    super(message)
    this.name = 'WalletOperationTooLargeError'
  }
}

/**
 * Refuse a send or payment whose custody record cannot hold its request and its result. A quote and
 * its execution call this with the same proofs and output count, so a quote never passes what the
 * execution refuses. Only an execution knows its operation key. Each operation that has a quote
 * has a key within the bound that the quote assumes.
 */
export function assertNewWalletOperationFits(
  inputs: readonly { readonly id: string }[],
  outputCount: number,
  operationKey = '',
): void {
  if (
    inputs.length > NEW_WALLET_OPERATION_INPUT_LIMIT ||
    newWalletOperationBytes(inputs, outputCount, operationKey) > DURABLE_CUSTODY_RECORD_BYTES_MAX
  )
    throw new WalletOperationTooLargeError()
}

export function newWalletOperationBytes(
  inputs: readonly { readonly id: string }[],
  outputCount: number,
  operationKey = '',
): number {
  // The outputs can use a keyset that no input uses.
  const keysets = new Set(inputs.map(({ id }) => id)).size + 1
  const keyBytes = new TextEncoder().encode(encodeURIComponent(operationKey)).byteLength
  return (
    RECORD_BYTES +
    inputs.length * RECORD_BYTES_PER_INPUT +
    outputCount * RECORD_BYTES_PER_OUTPUT +
    keysets * RECORD_BYTES_PER_KEYSET +
    Math.max(0, keyBytes - ASSUMED_KEY_BYTES) * RECORD_BYTES_PER_KEY_BYTE +
    LATER_RECORD_TEXT_BYTES
  )
}
