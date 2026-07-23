// Exact persisted wallet-operation contract re-authored from 7e1385c with
// wallet-scope and fail-closed authority corrections from f1cb65b/b683120.
import {
  DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
  DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  deriveDurableCustodyArtifactFingerprint,
  decodeCanonicalMintOrigin,
  encodeBoundedDurableArtifact,
} from './durableCustody.ts'
import type { DurableCustodyProofOperationInput } from './durableCustodyProofOperation.ts'
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
} from './durableWalletProofTransition.ts'

export const DURABLE_WALLET_OPERATION_SCHEMA_VERSION = 1 as const
export const DURABLE_WALLET_OPERATION_ARRAY_LENGTH_MAX =
  DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX
export const DURABLE_WALLET_OPERATION_METADATA_KEY = 'durableWalletOperation'

export type DurableWalletOperationKind =
  | 'wallet-mint'
  | 'wallet-receive'
  | 'wallet-send'
  | 'wallet-melt'

export interface DurableWalletProof {
  id: string
  amount: string
  secret: string
  C: string
  dleq: null | { e: string; s: string; r: string | null }
  p2pkE: string | null
  witness: string | null
}
export interface DurableWalletOutputData {
  blindedMessage: { amount: string; id: string; B_: string }
  blindingFactor: string
  secret: string
  ephemeralE: string | null
}
interface DurableWalletCommon {
  schemaVersion: 1
  operationId: string
  kind: DurableWalletOperationKind
  mintUrl: string
  unit: string
}
interface DurableWalletSwapPreview {
  amount: string
  fees: string
  keysetId: string
  inputs: DurableWalletProof[]
  sendOutputs: DurableWalletOutputData[]
  keepOutputs: DurableWalletOutputData[]
  unselectedProofs: DurableWalletProof[]
}
export type DurableWalletMintOperation = DurableWalletCommon & {
  kind: 'wallet-mint'
  preview: {
    method: string
    quoteExpiryUnixSeconds: number | null
    payload: {
      quote: string
      outputs: Array<{ amount: string; id: string; B_: string }>
      signature: string | null
    }
    outputData: DurableWalletOutputData[]
    keysetId: string
  }
}
export type DurableWalletReceiveOperation = DurableWalletCommon & {
  kind: 'wallet-receive'
  preview: DurableWalletSwapPreview
}
export type DurableWalletSendOperation = DurableWalletCommon & {
  kind: 'wallet-send'
  preview: DurableWalletSwapPreview
}
export type DurableWalletMeltOperation = DurableWalletCommon & {
  kind: 'wallet-melt'
  preview: {
    method: string
    inputs: DurableWalletProof[]
    outputData: DurableWalletOutputData[]
    keysetId: string
    quote: { quote: string; amount: string }
    requestOptions: {
      preferAsync: boolean
      extraPayload: Readonly<Record<string, DurableWalletJsonValue>>
    }
  }
}
export type DurableWalletOperation =
  | DurableWalletMintOperation
  | DurableWalletReceiveOperation
  | DurableWalletSendOperation
  | DurableWalletMeltOperation
export type DurableWalletJsonValue =
  | null
  | boolean
  | number
  | string
  | DurableWalletJsonValue[]
  | { [key: string]: DurableWalletJsonValue }
export interface DurableWalletOperationAuthority {
  requestFingerprint: string
  outputPlanFingerprint: string
}

export function decodeDurableWalletOperation(
  value: unknown,
): DurableWalletOperation {
  if (!isRecord(value)) throw new Error('durable wallet operation is invalid')
  exactKeys(value, [
    'schemaVersion',
    'operationId',
    'kind',
    'mintUrl',
    'unit',
    'preview',
  ])
  if (value.schemaVersion !== DURABLE_WALLET_OPERATION_SCHEMA_VERSION) {
    throw new Error('durable wallet operation schema is unsupported')
  }
  requireText(value.operationId, 'operation id')
  try {
    decodeCanonicalMintOrigin(value.mintUrl)
  } catch {
    throw new Error('durable wallet mint URL is not normalized')
  }
  requireText(value.unit, 'unit')
  if (!isRecord(value.preview)) {
    throw new Error('durable wallet operation preview is invalid')
  }
  switch (value.kind) {
    case 'wallet-send':
    case 'wallet-receive':
      decodeSwapPreview(value.preview)
      break
    case 'wallet-mint':
      decodeMintPreview(value.preview)
      break
    case 'wallet-melt':
      decodeMeltPreview(value.preview)
      break
    default:
      throw new Error('durable wallet operation kind is invalid')
  }
  return structuredClone(value) as unknown as DurableWalletOperation
}

export function toDurableCustodyProofOperationInput(
  input: DurableWalletOperation,
): DurableCustodyProofOperationInput {
  const operation = decodeDurableWalletOperation(input)
  const metadataBase = {
    unit: operation.unit,
    [DURABLE_WALLET_OPERATION_METADATA_KEY]: structuredClone(operation),
  }
  switch (operation.kind) {
    case 'wallet-receive': {
      const outputGroups = {
        receive: operation.preview.keepOutputs.map(toCustodyOutput),
      }
      const policy = createDurableWalletProofTransition({
        inputSource: 'external',
        plannedOutputLabels: ['receive'],
        resultGroups: {
          receive: { kind: 'wallet', asset: 'regular', reservedBy: null },
        },
      })
      return {
        operationId: operation.operationId,
        kind: operation.kind,
        mintUrl: operation.mintUrl,
        inputs: operation.preview.inputs.map(toCustodyProof),
        outputs: outputGroups,
        metadata: addDurableWalletProofTransitionMetadata(metadataBase, policy),
      }
    }
    case 'wallet-send': {
      const outputGroups = {
        send: operation.preview.sendOutputs.map(toCustodyOutput),
        keep: operation.preview.keepOutputs.map(toCustodyOutput),
      }
      const policy = createDurableWalletProofTransition({
        inputSource: 'wallet',
        plannedOutputLabels: Object.keys(outputGroups),
        resultGroups: {
          send: { kind: 'operation' },
          keep: { kind: 'wallet', asset: 'regular', reservedBy: null },
        },
        passthroughResultGroups: {
          keep: operation.preview.unselectedProofs.map(toCustodyProof),
        },
      })
      return {
        operationId: operation.operationId,
        kind: operation.kind,
        mintUrl: operation.mintUrl,
        inputs: operation.preview.inputs.map(toCustodyProof),
        outputs: outputGroups,
        metadata: addDurableWalletProofTransitionMetadata(metadataBase, policy),
      }
    }
    case 'wallet-mint': {
      const outputs = { receive: operation.preview.outputData.map(toCustodyOutput) }
      const policy = createDurableWalletProofTransition({
        inputSource: 'external',
        plannedOutputLabels: ['receive'],
        resultGroups: {
          receive: { kind: 'wallet', asset: 'regular', reservedBy: null },
        },
      })
      return {
        operationId: operation.operationId,
        kind: operation.kind,
        mintUrl: operation.mintUrl,
        inputs: [],
        outputs,
        metadata: addDurableWalletProofTransitionMetadata(metadataBase, policy),
      }
    }
    case 'wallet-melt': {
      const outputs = { change: operation.preview.outputData.map(toCustodyOutput) }
      const policy = createDurableWalletProofTransition({
        inputSource: 'wallet',
        plannedOutputLabels: ['change'],
        resultGroups: {
          change: { kind: 'wallet', asset: 'regular', reservedBy: null },
        },
        resultCardinality: { change: 'prefix' },
      })
      return {
        operationId: operation.operationId,
        kind: operation.kind,
        mintUrl: operation.mintUrl,
        inputs: operation.preview.inputs.map(toCustodyProof),
        outputs,
        metadata: addDurableWalletProofTransitionMetadata(metadataBase, policy),
      }
    }
  }
}

export function requireDurableWalletOperationFromCustody(
  input: DurableCustodyProofOperationInput,
): DurableWalletOperation {
  const embedded = input.metadata?.[DURABLE_WALLET_OPERATION_METADATA_KEY]
  const operation = decodeDurableWalletOperation(embedded)
  const exact = toDurableCustodyProofOperationInput(operation)
  if (
    deriveDurableCustodyArtifactFingerprint(exact) !==
    deriveDurableCustodyArtifactFingerprint(input)
  ) {
    throw new Error('custody operation does not contain the exact persisted operation')
  }
  return operation
}

export function deriveDurableWalletOperationAuthority(
  input: DurableWalletOperation,
): DurableWalletOperationAuthority {
  const operation = decodeDurableWalletOperation(input)
  const custody = toDurableCustodyProofOperationInput(operation)
  return {
    requestFingerprint: deriveDurableCustodyArtifactFingerprint(operation),
    outputPlanFingerprint: deriveDurableCustodyArtifactFingerprint(
      custody.outputs,
    ),
  }
}

function decodeSwapPreview(value: Record<string, unknown>): void {
  exactKeys(value, [
    'amount',
    'fees',
    'keysetId',
    'inputs',
    'sendOutputs',
    'keepOutputs',
    'unselectedProofs',
  ])
  requireAmount(value.amount, 'amount', false)
  requireAmount(value.fees, 'fees', true)
  requireText(value.keysetId, 'keyset id')
  decodeArray(
    value.inputs,
    decodeProof,
    'inputs',
    DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  )
  decodeArray(
    value.sendOutputs,
    decodeOutput,
    'send outputs',
    DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  )
  decodeArray(
    value.keepOutputs,
    decodeOutput,
    'keep outputs',
    DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  )
  decodeArray(
    value.unselectedProofs,
    decodeProof,
    'unselected proofs',
    DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
  )
  if ((value.inputs as unknown[]).length === 0) {
    throw new Error('durable wallet swap inputs are empty')
  }
  assertOutputKeyset(
    [
      ...(value.sendOutputs as Record<string, unknown>[]),
      ...(value.keepOutputs as Record<string, unknown>[]),
    ],
    value.keysetId,
  )
  assertDistinctOutputs([
    ...(value.sendOutputs as Record<string, unknown>[]),
    ...(value.keepOutputs as Record<string, unknown>[]),
  ])
  assertDistinctProofs([
    ...(value.inputs as Record<string, unknown>[]),
    ...(value.unselectedProofs as Record<string, unknown>[]),
  ])
}

function decodeMintPreview(value: Record<string, unknown>): void {
  exactKeys(value, [
    'method',
    'quoteExpiryUnixSeconds',
    'payload',
    'outputData',
    'keysetId',
  ])
  requireText(value.method, 'mint method')
  if (
    value.quoteExpiryUnixSeconds !== null &&
    (!Number.isSafeInteger(value.quoteExpiryUnixSeconds) ||
      (value.quoteExpiryUnixSeconds as number) < 0)
  ) {
    throw new Error('durable wallet quote expiry is invalid')
  }
  requireText(value.keysetId, 'keyset id')
  if (!isRecord(value.payload)) throw new Error('durable wallet mint payload is invalid')
  exactKeys(value.payload, ['quote', 'outputs', 'signature'])
  requireText(value.payload.quote, 'quote')
  if (value.payload.signature !== null) {
    requireText(value.payload.signature, 'mint signature')
  }
  decodeArray(
    value.payload.outputs,
    decodeBlindedMessage,
    'mint outputs',
    DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  )
  decodeArray(
    value.outputData,
    decodeOutput,
    'mint output data',
    DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  )
  assertOutputKeyset(
    value.outputData as Record<string, unknown>[],
    value.keysetId,
  )
  assertDistinctOutputs(value.outputData as Record<string, unknown>[])
}

function decodeMeltPreview(value: Record<string, unknown>): void {
  exactKeys(value, [
    'method',
    'inputs',
    'outputData',
    'keysetId',
    'quote',
    'requestOptions',
  ])
  requireText(value.method, 'melt method')
  requireText(value.keysetId, 'keyset id')
  decodeArray(
    value.inputs,
    decodeProof,
    'melt inputs',
    DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  )
  decodeArray(
    value.outputData,
    decodeOutput,
    'melt output data',
    DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  )
  if ((value.inputs as unknown[]).length === 0) {
    throw new Error('durable wallet melt inputs are empty')
  }
  assertOutputKeyset(
    value.outputData as Record<string, unknown>[],
    value.keysetId,
  )
  assertDistinctOutputs(value.outputData as Record<string, unknown>[])
  if (!isRecord(value.quote)) throw new Error('durable wallet melt quote is invalid')
  exactKeys(value.quote, ['quote', 'amount'])
  requireText(value.quote.quote, 'quote')
  requireAmount(value.quote.amount, 'quote amount', false)
  if (!isRecord(value.requestOptions)) {
    throw new Error('durable wallet melt options are invalid')
  }
  exactKeys(value.requestOptions, ['preferAsync', 'extraPayload'])
  if (
    typeof value.requestOptions.preferAsync !== 'boolean' ||
    !isRecord(value.requestOptions.extraPayload)
  ) {
    throw new Error('durable wallet melt options are invalid')
  }
  encodeBoundedDurableArtifact(
    value.requestOptions.extraPayload,
    DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  )
}

function decodeProof(value: unknown): void {
  if (!isRecord(value)) throw new Error('durable wallet proof is invalid')
  exactKeys(value, ['id', 'amount', 'secret', 'C', 'dleq', 'p2pkE', 'witness'])
  requireText(value.id, 'proof keyset id')
  requireAmount(value.amount, 'proof amount', false)
  requireText(value.secret, 'proof secret')
  requireText(value.C, 'proof signature')
  if (value.dleq !== null) {
    if (!isRecord(value.dleq)) throw new Error('durable wallet proof DLEQ is invalid')
    exactKeys(value.dleq, ['e', 's', 'r'])
    requireText(value.dleq.e, 'DLEQ e')
    requireText(value.dleq.s, 'DLEQ s')
    if (value.dleq.r !== null) requireText(value.dleq.r, 'DLEQ r')
  }
  if (value.p2pkE !== null) requireText(value.p2pkE, 'proof p2pk value')
  if (value.witness !== null) requireText(value.witness, 'proof witness')
}

function decodeOutput(value: unknown): void {
  if (!isRecord(value)) throw new Error('durable wallet output is invalid')
  exactKeys(value, ['blindedMessage', 'blindingFactor', 'secret', 'ephemeralE'])
  decodeBlindedMessage(value.blindedMessage)
  requireText(value.blindingFactor, 'blinding factor')
  requireText(value.secret, 'output secret')
  if (value.ephemeralE !== null) requireText(value.ephemeralE, 'output ephemeral value')
}

function decodeBlindedMessage(value: unknown): void {
  if (!isRecord(value)) throw new Error('durable wallet blinded message is invalid')
  exactKeys(value, ['amount', 'id', 'B_'])
  requireAmount(value.amount, 'blinded amount', false)
  requireText(value.id, 'blinded keyset id')
  requireText(value.B_, 'blinded message')
}

function toCustodyProof(proof: DurableWalletProof) {
  return {
    id: proof.id,
    amount: Number(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === null ? {} : { dleq: structuredClone(proof.dleq) }),
    ...(proof.p2pkE === null ? {} : { p2pk_e: proof.p2pkE }),
    ...(proof.witness === null ? {} : { witness: proof.witness }),
  }
}

function toCustodyOutput(output: DurableWalletOutputData) {
  return {
    blindedMessage: {
      amount: Number(output.blindedMessage.amount),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor,
    secret: output.secret,
    ...(output.ephemeralE === null ? {} : { ephemeralE: output.ephemeralE }),
  }
}

function decodeArray(
  value: unknown,
  decode: (item: unknown) => void,
  label: string,
  maximumLength: number,
): void {
  if (
    !Array.isArray(value) ||
    value.length > maximumLength
  ) {
    throw new Error(`durable wallet ${label} are invalid`)
  }
  value.forEach(decode)
}

function assertDistinctProofs(proofs: readonly Record<string, unknown>[]): void {
  const ids = proofs.map((proof) => `${String(proof.id)}:${String(proof.secret)}`)
  if (new Set(ids).size !== ids.length) {
    throw new Error('durable wallet operation contains duplicate proofs')
  }
}

function assertOutputKeyset(
  outputs: readonly Record<string, unknown>[],
  expected: unknown,
): void {
  if (
    outputs.some(
      (output) =>
        !isRecord(output.blindedMessage) ||
        output.blindedMessage.id !== expected,
    )
  ) {
    throw new Error('durable wallet output keyset is invalid')
  }
}

function assertDistinctOutputs(
  outputs: readonly Record<string, unknown>[],
): void {
  const ids = outputs.map((output) => {
    if (!isRecord(output.blindedMessage)) return ''
    return `${String(output.secret)}:${String(output.blindedMessage.B_)}`
  })
  if (new Set(ids).size !== ids.length) {
    throw new Error('durable wallet operation contains duplicate outputs')
  }
}

function requireAmount(value: unknown, label: string, allowZero: boolean): void {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    (!allowZero && value === '0')
  ) {
    throw new Error(`durable wallet ${label} is invalid`)
  }
}

function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16 * 1_024) {
    throw new Error(`durable wallet ${label} is invalid`)
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys)
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error('durable wallet operation contains foreign fields')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
}
