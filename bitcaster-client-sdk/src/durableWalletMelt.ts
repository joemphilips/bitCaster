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

export type DurableWalletMeltResultState = 'none' | 'verified-staged' | 'applied'

export interface DurableWalletMeltOperationStore {
  /** Return the exact change already applied by custody. */
  readAppliedResult(): Promise<readonly Proof[]>
  /** Finish custody admission for the exact staged result, then return its saved change. */
  applyStagedResult(): Promise<readonly Proof[]>
  /** Verify, stage, and admit change returned by an authenticated paid response. */
  stageAndApplyPaidChange(change: readonly Proof[]): Promise<readonly Proof[]>
  /** Release the exact reservation after an explicit unpaid payment response. */
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

export interface DurableWalletMeltExecutionResult {
  readonly state: 'paid' | 'unpaid'
  readonly proofs: readonly Proof[]
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
  const response = await input.transport.completeMelt(preview)
  if (response.quote.quote !== operation.preview.quote.quote) {
    throw new Error('wallet melt response quote is foreign')
  }
  if (response.quote.state !== 'PAID') {
    if (response.quote.state === 'UNPAID') return releaseUnpaid(input)
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
    const refreshed = await checkExactQuote(input, operation)
    if (refreshed.state === 'PAID') {
      return recoverPaidChange(input, preview, refreshed.change ?? [])
    }
    throw error
  }
  if (response.quote.quote !== operation.preview.quote.quote) {
    throw new Error('wallet melt response quote is foreign')
  }
  if (response.quote.state === 'PAID') {
    return applyPaidChange(input, response.change ?? [])
  }
  if (response.quote.state === 'UNPAID') return releaseUnpaid(input)
  throw new Error('wallet melt remains pending')
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
): Promise<DurableWalletMeltExecutionResult> {
  await input.store.releaseUnpaidReservation()
  return { state: 'unpaid', proofs: [] }
}

function requireMeltOperation(value: DurableWalletMeltOperation): DurableWalletMeltOperation {
  const operation = decodeDurableWalletOperation(value)
  if (operation.kind !== 'wallet-melt') {
    throw new Error('durable wallet melt operation is foreign')
  }
  return operation
}
