import { createHash } from 'node:crypto'
import type { Proof } from '@cashu/cashu-ts'
import {
  deriveDurableCustodyArtifactFingerprint,
  MAX_CONDITION_REGISTRATION_FEE_SUBUNITS,
} from '@bitcaster-market/client-sdk'
import { hydrateDurableWalletProof } from '@bitcaster-market/client-sdk/durableWalletOperation'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import type { DurableOutgoingCashuTransfer } from '@bitcaster-market/client-sdk/durableOutgoingCashuTransfer'
import type { DaemonDurableOutgoingCashuCoordinator } from './durableOutgoingCashuCoordinator.ts'
import type { CashuWalletLike } from './walletOps.ts'

const TRANSFER_ID_DOMAIN = 'bitcaster/native-condition-registration-fee/v1\0'

export interface NativeConditionRegistrationFeeRequest {
  readonly creationId: string
  readonly mintUrl: string
  readonly wallet?: CashuWalletLike
  readonly seed?: Uint8Array
  readonly requiredFeeMsat: number
  readonly maxWalletDebitMsat?: number
}

export type NativeConditionRegistrationFeeResult =
  | { readonly kind: 'fee-free'; readonly transferId: null; readonly feeProofs: readonly [] }
  | {
      readonly kind: 'prepared'
      readonly transferId: string
      readonly feeProofs: readonly Proof[]
    }
  | {
      readonly kind: 'already-spent'
      readonly transferId: string
      readonly feeProofs: readonly []
    }
  | {
      readonly kind: 'pending'
      readonly transferId: string
      readonly feeProofs: readonly []
    }

type FeeCoordinator = Pick<
  DaemonDurableOutgoingCashuCoordinator,
  'loadTransfer' | 'quoteSend' | 'execute' | 'recover' | 'classifyBearerTransfer'
>

/** Prepare or recover the exact durable bearer transfer used for one CTF fee. */
export async function prepareNativeConditionRegistrationFee(
  deps: { readonly coordinator: FeeCoordinator },
  input: NativeConditionRegistrationFeeRequest,
): Promise<NativeConditionRegistrationFeeResult> {
  validateCreationId(input.creationId)
  validateFee(input.requiredFeeMsat)
  if (input.requiredFeeMsat === 0) {
    return { kind: 'fee-free', transferId: null, feeProofs: [] }
  }
  if (typeof input.mintUrl !== 'string' || input.mintUrl.length === 0) {
    throw new Error('condition registration fee mint URL is invalid')
  }

  const transferId = deriveNativeConditionRegistrationFeeTransferId(input.creationId)
  const existing = await deps.coordinator.loadTransfer(transferId)
  if (existing !== null) {
    assertExactFeeTransfer(existing, {
      transferId,
      mintUrl: input.mintUrl,
      amountMsat: input.requiredFeeMsat,
    })
    assertRetryDebitConsent(existing, input.maxWalletDebitMsat)
    return resumeExistingFeeTransfer(deps.coordinator, existing, input)
  }

  const wallet = requireWallet(input.wallet)
  const maxWalletDebitMsat = requireFreshDebitLimit(input.maxWalletDebitMsat, input.requiredFeeMsat)
  const quote = await deps.coordinator.quoteSend({
    amountMsat: input.requiredFeeMsat,
    mintUrl: input.mintUrl,
    wallet,
  })
  assertFeeQuote(quote, input.requiredFeeMsat, maxWalletDebitMsat)
  if (input.seed === undefined) {
    throw new Error('condition registration fee requires deterministic wallet seed access')
  }

  const transfer = await deps.coordinator.execute({
    transferId,
    amountMsat: input.requiredFeeMsat,
    mintUrl: input.mintUrl,
    wallet,
    seed: input.seed,
    maxWalletDebitMsat,
  })
  assertExactFeeTransfer(transfer, {
    transferId,
    mintUrl: input.mintUrl,
    amountMsat: input.requiredFeeMsat,
  })
  return resumeExistingFeeTransfer(deps.coordinator, transfer, input)
}

export function deriveNativeConditionRegistrationFeeTransferId(creationId: string): string {
  validateCreationId(creationId)
  const digest = createHash('sha256')
    .update(TRANSFER_ID_DOMAIN)
    .update(creationId, 'utf8')
    .digest('hex')
  return `native-condition-registration-fee:v1:${digest}`
}

async function resumeExistingFeeTransfer(
  coordinator: FeeCoordinator,
  initialTransfer: DurableOutgoingCashuTransfer,
  input: NativeConditionRegistrationFeeRequest,
): Promise<NativeConditionRegistrationFeeResult> {
  const { transferId } = initialTransfer
  let transfer = initialTransfer
  const wallet = input.wallet

  if (transfer.deliveryState === 'bearer-spent') {
    return { kind: 'already-spent', transferId, feeProofs: [] }
  }
  if (transfer.deliveryState === 'prepared') {
    if (wallet === undefined) return { kind: 'pending', transferId, feeProofs: [] }
    try {
      transfer = await coordinator.recover({
        transfer,
        amountMsat: input.requiredFeeMsat,
        mintUrl: input.mintUrl,
        wallet,
      })
    } catch {
      // Recovery may report a nonterminal wallet operation. Keep this transfer as authority.
      return { kind: 'pending', transferId, feeProofs: [] }
    }
    assertExactFeeTransfer(transfer, {
      transferId,
      mintUrl: input.mintUrl,
      amountMsat: input.requiredFeeMsat,
    })
  } else if (transfer.deliveryState === 'delivery-pending') {
    if (wallet === undefined) return { kind: 'pending', transferId, feeProofs: [] }
    try {
      transfer = await coordinator.recover({
        transfer,
        amountMsat: input.requiredFeeMsat,
        mintUrl: input.mintUrl,
        wallet,
      })
    } catch {
      return { kind: 'pending', transferId, feeProofs: [] }
    }
    assertExactFeeTransfer(transfer, {
      transferId,
      mintUrl: input.mintUrl,
      amountMsat: input.requiredFeeMsat,
    })
  } else if (transfer.deliveryState !== 'bearer-partial') {
    throw new Error('condition registration fee transfer is not recoverable')
  }

  if (transfer.deliveryState === 'bearer-spent') {
    return { kind: 'already-spent', transferId, feeProofs: [] }
  }
  if (transfer.deliveryState === 'prepared') {
    return { kind: 'pending', transferId, feeProofs: [] }
  }
  if (wallet === undefined) return { kind: 'pending', transferId, feeProofs: [] }

  let classified
  try {
    classified = await coordinator.classifyBearerTransfer({ transferId, wallet })
  } catch {
    // A proof-state query failure does not authorize a second send or fee publication.
    return { kind: 'pending', transferId, feeProofs: [] }
  }
  if (
    classified.transferId !== transferId ||
    classified.mintUrl !== input.mintUrl ||
    classified.unit !== 'msat'
  ) {
    throw new Error('condition registration fee classification conflicts')
  }
  if (classified.deliveryState === 'bearer-spent') {
    return { kind: 'already-spent', transferId, feeProofs: [] }
  }
  if (classified.deliveryState !== 'delivery-pending') {
    return { kind: 'pending', transferId, feeProofs: [] }
  }

  const classifiedTransfer = await coordinator.loadTransfer(transferId)
  if (classifiedTransfer === null) throw new Error('condition registration fee transfer is missing')
  assertExactFeeTransfer(classifiedTransfer, {
    transferId,
    mintUrl: input.mintUrl,
    amountMsat: input.requiredFeeMsat,
  })
  if (classifiedTransfer.deliveryState === 'bearer-spent') {
    return { kind: 'already-spent', transferId, feeProofs: [] }
  }
  if (
    classifiedTransfer.deliveryState !== 'delivery-pending' ||
    classifiedTransfer.token === null ||
    classifiedTransfer.token.unspentProofs === null ||
    classifiedTransfer.token.proofs.length === 0 ||
    deriveDurableCustodyArtifactFingerprint(classifiedTransfer.token.unspentProofs) !==
      deriveDurableCustodyArtifactFingerprint(classifiedTransfer.token.proofs)
  ) {
    return { kind: 'pending', transferId, feeProofs: [] }
  }
  return {
    kind: 'prepared',
    transferId,
    feeProofs: classifiedTransfer.token.unspentProofs.map(hydrateDurableWalletProof),
  }
}

function assertExactFeeTransfer(
  transfer: DurableOutgoingCashuTransfer,
  expected: { readonly transferId: string; readonly mintUrl: string; readonly amountMsat: number },
): void {
  const operation = transfer.walletSendOperation
  if (
    transfer.transferId !== expected.transferId ||
    transfer.mintUrl !== expected.mintUrl ||
    transfer.unit !== 'msat' ||
    transfer.requestedAmount !== String(expected.amountMsat) ||
    transfer.recipientSequence !== null ||
    transfer.deliveryIntent.policy !== 'bearer-spend-classification' ||
    operation.kind !== 'wallet-send' ||
    operation.operationId !== expected.transferId ||
    operation.mintUrl !== expected.mintUrl ||
    operation.unit !== 'msat' ||
    amountToNumber(operation.preview.amount) !== expected.amountMsat
  ) {
    throw new Error('condition registration fee transfer conflicts with the request')
  }
  if (transfer.deliveryState !== 'prepared' && transfer.token === null) {
    throw new Error('condition registration fee token authority is missing')
  }
}

function assertRetryDebitConsent(
  transfer: DurableOutgoingCashuTransfer,
  maximumDebitMsat: number | undefined,
): void {
  if (maximumDebitMsat === undefined) return
  if (!Number.isSafeInteger(maximumDebitMsat) || maximumDebitMsat < 1) {
    throw new Error('condition registration fee debit limit is invalid')
  }
  const storedDebit = preparedWalletDebit(transfer)
  if (maximumDebitMsat < storedDebit) {
    throw new Error('condition registration fee transfer exceeds the approved maximum')
  }
}

function preparedWalletDebit(transfer: DurableOutgoingCashuTransfer): number {
  const preview = transfer.walletSendOperation.preview
  const amount = amountToNumber(preview.amount)
  const fees = amountToNumber(preview.fees)
  const total = amount + fees
  if (
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    !Number.isSafeInteger(fees) ||
    fees < 0 ||
    !Number.isSafeInteger(total)
  ) {
    throw new Error('condition registration fee transfer debit is invalid')
  }
  return total
}

function assertFeeQuote(
  quote: { amountMsat: number; sendPreparationFeeMsat: number; totalWalletDebitMsat: number },
  requiredFeeMsat: number,
  maximumDebitMsat: number,
): void {
  if (
    quote.amountMsat !== requiredFeeMsat ||
    !Number.isSafeInteger(quote.sendPreparationFeeMsat) ||
    quote.sendPreparationFeeMsat < 0 ||
    !Number.isSafeInteger(quote.totalWalletDebitMsat) ||
    quote.totalWalletDebitMsat !== quote.amountMsat + quote.sendPreparationFeeMsat
  ) {
    throw new Error('condition registration fee quote is invalid')
  }
  if (quote.totalWalletDebitMsat > maximumDebitMsat) {
    throw new Error('condition registration fee exceeds the approved wallet debit')
  }
}

function requireFreshDebitLimit(value: number | undefined, feeMsat: number): number {
  if (value === undefined || !Number.isSafeInteger(value) || value < feeMsat) {
    throw new Error('condition registration fee requires an approved wallet debit maximum')
  }
  return value
}

function validateFee(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_CONDITION_REGISTRATION_FEE_SUBUNITS
  ) {
    throw new Error('condition registration fee is outside the supported range')
  }
}

function validateCreationId(value: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    new TextEncoder().encode(value).byteLength > 128
  ) {
    throw new Error('condition registration fee creation ID is invalid')
  }
}

function requireWallet(value: CashuWalletLike | undefined): CashuWalletLike {
  if (value === undefined) throw new Error('condition registration fee wallet is required')
  return value
}
