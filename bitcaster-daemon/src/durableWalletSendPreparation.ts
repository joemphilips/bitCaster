import {
  Amount,
  OutputData,
  type Proof,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  deriveDurableWalletOperationAuthority,
  createDurableWalletSendOperation,
  decodeDurableWalletOperation,
  DURABLE_WALLET_OPERATION_METADATA_KEY,
  type DurableWalletSendOperation,
} from '@bitcaster-market/client-sdk/durableWalletOperation'
import {
  DURABLE_WALLET_SEND_NATIVE_OPERATION_BYTES_LIMIT_MAX,
  DURABLE_WALLET_SEND_PROOF_COUNT_LIMIT_MAX,
  DURABLE_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX,
  DURABLE_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX,
  planDurableWalletSendDeliveryAdmission,
} from '@bitcaster-market/client-sdk/durableWalletSendDelivery'
import {
  prepareDurableWalletSendDelivery,
  requireDurableWalletSendDeliveryPreparationForOperation,
  type DurableWalletSendDeliveryPreparation,
} from '@bitcaster-market/client-sdk/durableWalletSendDeliveryPreparation'
import type {
  PrepareProofOperationInput,
} from './state.ts'

export const DAEMON_WALLET_SEND_DELIVERY_PREPARATION_METADATA_KEY =
  'durableWalletSendDeliveryPreparation' as const

/**
 * Adds the exact SDK user-export authority to the daemon row committed before
 * mint transport. SQLite remains the physical admission authority: if this
 * bounded row cannot commit, the wallet operation never reaches the mint.
 */
export function addDaemonUserExportWalletSendPreparation(
  input: PrepareProofOperationInput,
): PrepareProofOperationInput {
  const walletOperation = createWalletSendOperation(input)
  const admission = planDurableWalletSendDeliveryAdmission({
    outputPlan: {
      mintUrl: walletOperation.mintUrl,
      unit: walletOperation.unit,
      sendOutputs: walletOperation.preview.sendOutputs,
      keepOutputs: walletOperation.preview.keepOutputs,
      passthroughProofs: walletOperation.preview.unselectedProofs,
      inputProofs: walletOperation.preview.inputs,
    },
    limits: {
      encodedTokenBytes: DURABLE_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX,
      proofCount: DURABLE_WALLET_SEND_PROOF_COUNT_LIMIT_MAX,
      durableStorageBytes: DURABLE_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX,
      nativeOperationRowBytes:
        DURABLE_WALLET_SEND_NATIVE_OPERATION_BYTES_LIMIT_MAX,
    },
  })
  const preparation = prepareDurableWalletSendDelivery({
    walletOperation,
    policy: { kind: 'user-export' },
    admission,
  })
  return {
    ...input,
    metadata: {
      ...input.metadata,
      [DURABLE_WALLET_OPERATION_METADATA_KEY]: walletOperation,
      [DAEMON_WALLET_SEND_DELIVERY_PREPARATION_METADATA_KEY]:
        structuredClone(preparation),
    },
  }
}

/** Reissues the runtime capability only after validating the persisted tuple. */
export function requireDaemonWalletSendDeliveryPreparation(
  input: PrepareProofOperationInput,
): DurableWalletSendDeliveryPreparation | undefined {
  const stored = input.metadata?.[
    DAEMON_WALLET_SEND_DELIVERY_PREPARATION_METADATA_KEY
  ]
  if (input.kind !== 'wallet-send') {
    if (stored !== undefined) {
      throw new Error('wallet-send delivery preparation is foreign')
    }
    return undefined
  }
  const walletOperation = requireExactWalletSendOperation(input)
  return requireDurableWalletSendDeliveryPreparationForOperation(
    stored,
    walletOperation,
  )
}

export function readDaemonWalletSendDeliveryPreparation(
  input: Pick<PrepareProofOperationInput, 'kind' | 'metadata'>,
): DurableWalletSendDeliveryPreparation | null {
  const value = input.metadata?.[
    DAEMON_WALLET_SEND_DELIVERY_PREPARATION_METADATA_KEY
  ]
  if (value === undefined) return null
  if (input.kind !== 'wallet-send') {
    throw new Error('wallet-send delivery preparation is foreign')
  }
  return requireDurableWalletSendDeliveryPreparationForOperation(
    value,
    decodeStoredWalletSendOperation(input.metadata),
  )
}

function requireExactWalletSendOperation(
  input: PrepareProofOperationInput,
): DurableWalletSendOperation {
  const stored = decodeStoredWalletSendOperation(input.metadata)
  const reconstructed = createWalletSendOperation(input)
  const storedAuthority = deriveDurableWalletOperationAuthority(stored)
  const reconstructedAuthority =
    deriveDurableWalletOperationAuthority(reconstructed)
  if (
    storedAuthority.requestFingerprint !==
      reconstructedAuthority.requestFingerprint ||
    storedAuthority.outputPlanFingerprint !==
      reconstructedAuthority.outputPlanFingerprint
  ) {
    throw new Error(
      'persisted wallet-send preparation does not match exact daemon operation',
    )
  }
  return stored
}

function decodeStoredWalletSendOperation(
  metadata: Readonly<Record<string, unknown>> | undefined,
): DurableWalletSendOperation {
  const operation = decodeDurableWalletOperation(
    metadata?.[DURABLE_WALLET_OPERATION_METADATA_KEY],
  )
  if (operation.kind !== 'wallet-send') {
    throw new Error('persisted wallet operation is not wallet-send')
  }
  return operation
}

function createWalletSendOperation(
  input: PrepareProofOperationInput,
): DurableWalletSendOperation {
  if (input.kind !== 'wallet-send' || input.durableTradeRecovery !== undefined) {
    throw new Error('daemon user export requires an ordinary wallet-send')
  }
  const unit = requireMetadataText(input, 'unit')
  const preview: SwapPreview = {
    amount: Amount.from(requireMetadataSafeInteger(input, 'amount', false)),
    fees: Amount.from(requireMetadataSafeInteger(input, 'fees', true)),
    keysetId: requireMetadataText(input, 'keysetId'),
    inputs: structuredClone(input.inputs) as Proof[],
    sendOutputs: deserializeOutputs(input.outputs.send),
    keepOutputs: deserializeOutputs(input.outputs.keep),
    unselectedProofs: requireUnselectedProofs(input),
  }
  return createDurableWalletSendOperation({
    operationId: input.operationId,
    mintUrl: input.mintUrl,
    unit,
    preview,
  })
}

function deserializeOutputs(
  values: PrepareProofOperationInput['outputs'][string] | undefined,
): OutputData[] {
  return (values ?? []).map((value) => OutputData.deserialize({
    ...value,
    blindedMessage: {
      ...value.blindedMessage,
      amount: String(value.blindedMessage.amount),
    },
  }))
}

function requireUnselectedProofs(input: PrepareProofOperationInput): Proof[] {
  const value = input.metadata?.unselectedProofs
  if (!Array.isArray(value)) {
    throw new Error('wallet-send unselected proofs are invalid')
  }
  return structuredClone(value) as Proof[]
}

function requireMetadataText(
  input: PrepareProofOperationInput,
  key: string,
): string {
  const value = input.metadata?.[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`wallet-send metadata ${key} is invalid`)
  }
  return value
}

function requireMetadataSafeInteger(
  input: PrepareProofOperationInput,
  key: string,
  allowZero: boolean,
): number {
  const value = input.metadata?.[key]
  if (
    !Number.isSafeInteger(value) ||
    (allowZero ? (value as number) < 0 : (value as number) <= 0)
  ) {
    throw new Error(`wallet-send metadata ${key} is invalid`)
  }
  return value as number
}
