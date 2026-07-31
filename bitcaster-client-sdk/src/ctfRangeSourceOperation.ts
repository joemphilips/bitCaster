import {
  Amount,
  OutputData,
  type ConditionalSwapPreview,
  type Proof,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  deserializeDurableCustodyOutput,
  serializeDurableCustodyOutput,
  type DurableCustodyProofOperationInput,
} from './durableCustodyProofOperation.ts'
import { prepareCtfRangeOrderAuthorization } from './ctfRangeOrderPreparation.ts'
import type { PersistedCtfRangeOrderPreparation } from './ctfRangeOrderProtocol.ts'
import {
  amountToNumber,
  computeInputFeeSatsForProofs,
  sumProofs,
  takeProofsForLock,
} from './proofSelection.ts'

const SOURCE_PURPOSE = 'ctf-range-authorization-source'

export interface CtfRangeSourceWallet {
  prepareSwapToSend(
    amount: number,
    proofs: Proof[],
    config: { includeFees: false; keysetId: string },
    outputConfig: {
      send: { type: 'custom'; data: OutputData[] }
      keep: { type: 'random' }
    },
  ): Promise<SwapPreview>
  completeSwap(preview: SwapPreview): Promise<{ keep: Proof[]; send: Proof[] }>
  prepareConditionalSwap(options: {
    keysetId: string
    inputs: Proof[]
    outputs: Array<
      | { label: string; kind: 'custom'; data: OutputData[] }
      | { label: string; kind: 'random'; amount: number }
    >
  }): Promise<ConditionalSwapPreview>
  completeConditionalSwap(preview: ConditionalSwapPreview): Promise<Record<string, Proof[]>>
}

export interface CtfRangeSourceResult {
  readonly authorization: readonly Proof[]
  readonly keep: readonly Proof[]
}

export async function prepareCtfRangeSourceOperation(input: {
  readonly preparation: PersistedCtfRangeOrderPreparation
  readonly seed: Uint8Array
  readonly wallet: CtfRangeSourceWallet
  readonly candidates: readonly Proof[]
}): Promise<DurableCustodyProofOperationInput | null> {
  const prepared = prepareCtfRangeOrderAuthorization({
    seed: input.seed,
    ...withoutRequest(input.preparation),
  })
  const target = amountToNumber(OutputData.sumOutputAmounts(prepared.authorizationOutputs))
  const selected = takeProofsForLock([...input.candidates], target, {
    [input.preparation.offerKeyset.id]: input.preparation.offerKeyset.inputFeePpk,
  })
  if (selected === null) return null
  return input.preparation.side === 'Buy'
    ? prepareRegularSource(input.preparation, input.wallet, prepared.authorizationOutputs, selected)
    : prepareConditionalSource(
        input.preparation,
        input.wallet,
        prepared.authorizationOutputs,
        selected,
        target,
      )
}

export async function completeCtfRangeSourceOperation(
  operation: DurableCustodyProofOperationInput,
  wallet: CtfRangeSourceWallet,
): Promise<CtfRangeSourceResult> {
  assertSourceOperation(operation)
  const outputs = deserializeOutputs(operation.outputs)
  if (operation.kind === 'conditional-keyset-swap') {
    const result = await wallet.completeConditionalSwap({
      keysetId: metadataText(operation, 'keysetId'),
      inputs: operation.inputs as Proof[],
      outputDataByLabel: outputs,
    })
    return { authorization: result.authorization ?? [], keep: result.keep ?? [] }
  }
  const result = await wallet.completeSwap({
    amount: Amount.from(metadataNumber(operation, 'amount')),
    fees: Amount.from(metadataNumber(operation, 'fees')),
    keysetId: metadataText(operation, 'keysetId'),
    inputs: operation.inputs as Proof[],
    sendOutputs: outputs.authorization ?? [],
    keepOutputs: outputs.keep ?? [],
    unselectedProofs: [],
  })
  return { authorization: result.send, keep: result.keep }
}

async function prepareRegularSource(
  preparation: PersistedCtfRangeOrderPreparation,
  wallet: CtfRangeSourceWallet,
  authorizationOutputs: OutputData[],
  inputs: Proof[],
): Promise<DurableCustodyProofOperationInput> {
  const target = amountToNumber(OutputData.sumOutputAmounts(authorizationOutputs))
  const preview = await wallet.prepareSwapToSend(
    target,
    inputs,
    { includeFees: false, keysetId: preparation.offerKeyset.id },
    {
      send: { type: 'custom', data: authorizationOutputs },
      keep: { type: 'random' },
    },
  )
  assertExactOutputs(preview.sendOutputs ?? [], authorizationOutputs)
  return sourceOperation(preparation, 'wallet-send', preview, {
    authorization: preview.sendOutputs ?? [],
    keep: preview.keepOutputs ?? [],
    amount: amountToNumber(preview.amount),
    fees: amountToNumber(preview.fees),
    keysetId: preview.keysetId,
  })
}

async function prepareConditionalSource(
  preparation: PersistedCtfRangeOrderPreparation,
  wallet: CtfRangeSourceWallet,
  authorizationOutputs: OutputData[],
  inputs: Proof[],
  target: number,
): Promise<DurableCustodyProofOperationInput> {
  const fees = computeInputFeeSatsForProofs(inputs, {
    [preparation.offerKeyset.id]: preparation.offerKeyset.inputFeePpk,
  })
  const change = sumProofs(inputs) - fees - target
  if (change < 0) throw new Error('conditional range source is underfunded')
  const outputs: Parameters<CtfRangeSourceWallet['prepareConditionalSwap']>[0]['outputs'] = [
    { label: 'authorization', kind: 'custom', data: authorizationOutputs },
  ]
  if (change > 0) outputs.push({ label: 'keep', kind: 'random', amount: change })
  const preview = await wallet.prepareConditionalSwap({
    keysetId: preparation.offerKeyset.id,
    inputs,
    outputs,
  })
  assertExactOutputs(preview.outputDataByLabel.authorization ?? [], authorizationOutputs)
  return sourceOperation(preparation, 'conditional-keyset-swap', preview, {
    authorization: preview.outputDataByLabel.authorization ?? [],
    keep: preview.outputDataByLabel.keep ?? [],
    amount: target,
    fees,
    keysetId: preview.keysetId,
  })
}

function sourceOperation(
  preparation: PersistedCtfRangeOrderPreparation,
  kind: 'wallet-send' | 'conditional-keyset-swap',
  preview: SwapPreview | ConditionalSwapPreview,
  output: {
    authorization: OutputData[]
    keep: OutputData[]
    amount: number
    fees: number
    keysetId: string
  },
): DurableCustodyProofOperationInput {
  if (preview.inputs.length < 1 || preview.inputs.length > preparation.maxInputs) {
    throw new Error('range source exceeds the mint input limit')
  }
  return {
    operationId: preparation.sourceOperationId,
    kind,
    mintUrl: preparation.mintUrl,
    inputs: preview.inputs.map(serializeProof),
    outputs: {
      authorization: output.authorization.map(serializeDurableCustodyOutput),
      keep: output.keep.map(serializeDurableCustodyOutput),
    },
    metadata: {
      purpose: SOURCE_PURPOSE,
      rangeOperationId: preparation.operationId,
      unit: 'msat',
      sourceMode: kind,
      amount: output.amount,
      fees: output.fees,
      keysetId: output.keysetId,
    },
  }
}

function serializeProof(proof: Proof): DurableCustodyProofOperationInput['inputs'][number] {
  return Object.fromEntries(
    Object.entries({
      id: proof.id,
      amount: amountToNumber(proof.amount),
      secret: proof.secret,
      C: proof.C,
      dleq: structuredClone(proof.dleq),
      p2pk_e: proof.p2pk_e,
      witness: structuredClone(proof.witness),
    }).filter(([, value]) => value !== undefined),
  ) as DurableCustodyProofOperationInput['inputs'][number]
}

function deserializeOutputs(
  outputs: DurableCustodyProofOperationInput['outputs'],
): Record<string, OutputData[]> {
  return Object.fromEntries(
    Object.entries(outputs).map(([label, values]) => [
      label,
      values.map(deserializeDurableCustodyOutput),
    ]),
  )
}

function assertSourceOperation(operation: DurableCustodyProofOperationInput): void {
  if (
    (operation.kind !== 'wallet-send' && operation.kind !== 'conditional-keyset-swap') ||
    operation.metadata?.purpose !== SOURCE_PURPOSE ||
    operation.metadata.unit !== 'msat'
  ) {
    throw new Error('persisted range source operation is invalid')
  }
}

function metadataText(operation: DurableCustodyProofOperationInput, field: string): string {
  const value = operation.metadata?.[field]
  if (typeof value !== 'string' || value.length < 1) {
    throw new Error(`range source ${field} is invalid`)
  }
  return value
}

function metadataNumber(operation: DurableCustodyProofOperationInput, field: string): number {
  const value = operation.metadata?.[field]
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`range source ${field} is invalid`)
  }
  return value as number
}

function assertExactOutputs(actual: OutputData[], expected: OutputData[]): void {
  if (
    actual.length !== expected.length ||
    actual.some(
      (output, index) =>
        canonical(OutputData.serialize(output)) !==
        canonical(OutputData.serialize(expected[index]!)),
    )
  ) {
    throw new Error('range source changed exact authorization outputs')
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (typeof item === 'bigint' ? item.toString() : item))
}

function withoutRequest(preparation: PersistedCtfRangeOrderPreparation) {
  const { version: _, request: _request, ...input } = preparation
  return input
}
