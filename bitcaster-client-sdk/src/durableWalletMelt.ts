import {
  type MeltPreview,
  type MeltQuoteBaseResponse,
  type MeltQuoteResponse,
  type OutputDataLike,
  type Proof,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts'
import { deserializeDurableCustodyOutput } from './durableCustodyProofOperation.ts'
import {
  decodeDurableWalletOperation,
  hydrateDurableWalletProof,
  type DurableWalletMeltOperation,
} from './durableWalletOperation.ts'
import { isMintAmountOutsideLimitError } from './mintPaymentLimits.ts'

export type DurableWalletMeltResultState = 'none' | 'verified-staged' | 'applied'

export interface DurableWalletMeltOperationStore {
  /** Return the exact change already applied by custody. */
  readAppliedResult(): Promise<readonly Proof[]>
  /** Finish custody admission for the exact staged result, then return its saved change. */
  applyStagedResult(): Promise<readonly Proof[]>
  /** Verify, stage, and admit change returned by an authenticated paid response. */
  stageAndApplyPaidChange(change: readonly Proof[]): Promise<readonly Proof[]>
  /** Release the exact reservation after an explicit unpaid response or a limit refusal. */
  releaseUnpaidReservation(): Promise<void>
}

export interface DurableWalletMeltTransport {
  completeMelt(preview: MeltPreview<Pick<MeltQuoteResponse, 'quote'>>): Promise<{
    readonly quote: { readonly quote: string; readonly state: string }
    readonly change?: readonly Proof[]
  }>
  checkMeltQuote(
    method: string,
    quote: string,
  ): Promise<
    Pick<MeltQuoteBaseResponse, 'quote' | 'state'> & {
      readonly state: string
      readonly change?: readonly SerializedBlindedSignature[]
    }
  >
  createMeltChangeProofs(
    outputData: OutputDataLike[],
    changeSigs: SerializedBlindedSignature[],
  ): readonly Proof[]
}

export interface DurableWalletMeltExecutionInput {
  readonly mode: 'execute' | 'recover'
  readonly operation: DurableWalletMeltOperation
  readonly resultState: DurableWalletMeltResultState
  readonly transport: DurableWalletMeltTransport
  readonly store: DurableWalletMeltOperationStore
}

/**
 * Why a melt ended as unpaid. `mint-limit`: the mint refused it for its payment
 * limit (11006). `payment-failed`: the mint answered that the quote is unpaid.
 */
export type DurableWalletMeltUnpaidReason = 'mint-limit' | 'payment-failed'

export type DurableWalletMeltExecutionResult =
  | { readonly state: 'paid'; readonly proofs: readonly Proof[] }
  | {
      readonly state: 'unpaid'
      readonly unpaidReason: DurableWalletMeltUnpaidReason
      readonly proofs: readonly []
    }

/** Execute or recover one persisted melt without changing its quote or output authority. */
export async function runDurableWalletMeltOperation(
  input: DurableWalletMeltExecutionInput,
): Promise<DurableWalletMeltExecutionResult> {
  if (input.mode !== 'execute' && input.mode !== 'recover') {
    throw new Error('durable wallet melt mode is invalid')
  }
  const operation = requireMeltOperation(input.operation)

  switch (input.resultState) {
    case 'applied':
      return { state: 'paid', proofs: await input.store.readAppliedResult() }
    case 'verified-staged':
      return { state: 'paid', proofs: await input.store.applyStagedResult() }
    case 'none':
      break
    default:
      throw new Error('durable wallet melt result state is invalid')
  }

  const preview = hydrateDurableWalletMeltPreview(operation)
  if (input.mode === 'execute') {
    return submitMelt(input, operation, preview)
  }
  return recoverMelt(input, operation, preview)
}

/** Rebuild the exact saved NUT-08 request. */
export function hydrateDurableWalletMeltPreview(
  value: DurableWalletMeltOperation,
): MeltPreview<Pick<MeltQuoteResponse, 'quote'>> {
  const operation = requireMeltOperation(value)
  return {
    method: operation.preview.method,
    inputs: operation.preview.inputs.map(hydrateDurableWalletProof),
    outputData: operation.preview.outputData.map(({ ephemeralE, ...output }) =>
      deserializeDurableCustodyOutput({
        ...output,
        ...(ephemeralE === null ? {} : { ephemeralE }),
      }),
    ),
    keysetId: operation.preview.keysetId,
    quote: { quote: operation.preview.quote.quote },
  }
}

async function submitMelt(
  input: DurableWalletMeltExecutionInput,
  operation: DurableWalletMeltOperation,
  preview: MeltPreview<Pick<MeltQuoteResponse, 'quote'>>,
): Promise<DurableWalletMeltExecutionResult> {
  let response: Awaited<ReturnType<DurableWalletMeltTransport['completeMelt']>>
  try {
    response = await input.transport.completeMelt(preview)
  } catch (error) {
    if (!isMintAmountOutsideLimitError(error)) throw error
    return settleFailedSubmission(input, operation, preview, error)
  }
  if (response.quote.quote !== operation.preview.quote.quote) {
    throw new Error('wallet melt response quote is foreign')
  }
  if (response.quote.state !== 'PAID') {
    if (response.quote.state === 'UNPAID') return releaseUnpaid(input, 'payment-failed')
    throw new Error('wallet melt remains pending')
  }
  return applyPaidChange(input, response.change ?? [])
}

async function recoverMelt(
  input: DurableWalletMeltExecutionInput,
  operation: DurableWalletMeltOperation,
  preview: MeltPreview<Pick<MeltQuoteResponse, 'quote'>>,
): Promise<DurableWalletMeltExecutionResult> {
  const status = await checkExactQuote(input, operation)
  if (status.state === 'PAID') {
    return recoverPaidChange(input, preview, status.change ?? [])
  }
  if (status.state !== 'UNPAID') {
    throw new Error('wallet melt remains pending')
  }

  let response: Awaited<ReturnType<DurableWalletMeltTransport['completeMelt']>>
  try {
    response = await input.transport.completeMelt(preview)
  } catch (error) {
    return settleFailedSubmission(input, operation, preview, error)
  }
  if (response.quote.quote !== operation.preview.quote.quote) {
    throw new Error('wallet melt response quote is foreign')
  }
  if (response.quote.state === 'PAID') {
    return applyPaidChange(input, response.change ?? [])
  }
  if (response.quote.state === 'UNPAID') return releaseUnpaid(input, 'payment-failed')
  throw new Error('wallet melt remains pending')
}

/**
 * Settle a submission without a payment response from a fresh quote status.
 *
 * A limit refusal (11006) says that the mint did not start this payment: the
 * amount is outside its limit, for one payment or for a period. The mint then
 * has no pending state, so an unpaid status releases the reservation. After
 * every other failure the request can still be in progress, and an unpaid
 * status releases nothing.
 */
async function settleFailedSubmission(
  input: DurableWalletMeltExecutionInput,
  operation: DurableWalletMeltOperation,
  preview: MeltPreview<Pick<MeltQuoteResponse, 'quote'>>,
  failure: unknown,
): Promise<DurableWalletMeltExecutionResult> {
  const status = await checkExactQuote(input, operation)
  if (status.state === 'PAID') {
    return recoverPaidChange(input, preview, status.change ?? [])
  }
  if (status.state === 'UNPAID' && isMintAmountOutsideLimitError(failure)) {
    return releaseUnpaid(input, 'mint-limit')
  }
  throw failure
}

async function checkExactQuote(
  input: DurableWalletMeltExecutionInput,
  operation: DurableWalletMeltOperation,
) {
  const status = await input.transport.checkMeltQuote(
    operation.preview.method,
    operation.preview.quote.quote,
  )
  if (status.quote !== operation.preview.quote.quote) {
    throw new Error('wallet melt status quote is foreign')
  }
  return status
}

async function recoverPaidChange(
  input: DurableWalletMeltExecutionInput,
  preview: MeltPreview<Pick<MeltQuoteResponse, 'quote'>>,
  signatures: readonly SerializedBlindedSignature[],
): Promise<DurableWalletMeltExecutionResult> {
  return applyPaidChange(
    input,
    input.transport.createMeltChangeProofs(preview.outputData, [...signatures]),
  )
}

async function applyPaidChange(
  input: DurableWalletMeltExecutionInput,
  change: readonly Proof[],
): Promise<DurableWalletMeltExecutionResult> {
  return {
    state: 'paid',
    proofs: await input.store.stageAndApplyPaidChange(change),
  }
}

async function releaseUnpaid(
  input: DurableWalletMeltExecutionInput,
  unpaidReason: DurableWalletMeltUnpaidReason,
): Promise<DurableWalletMeltExecutionResult> {
  await input.store.releaseUnpaidReservation()
  return { state: 'unpaid', unpaidReason, proofs: [] }
}

function requireMeltOperation(value: DurableWalletMeltOperation): DurableWalletMeltOperation {
  const operation = decodeDurableWalletOperation(value)
  if (operation.kind !== 'wallet-melt') {
    throw new Error('durable wallet melt operation is foreign')
  }
  return operation
}
