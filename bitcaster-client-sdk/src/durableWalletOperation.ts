import {
  Amount,
  OutputData,
  type AmountLike,
  type MeltPreview,
  type MintPreview,
  type OutputDataLike,
  type Proof,
  type ProofLike,
  type SerializedBlindedSignature,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  deriveDurableCustodyArtifactFingerprint,
  type DurableCustodyRecoveryClassification,
} from './durableCustody.ts'
import { deriveDurableCustodyProofResultFingerprint } from './durableCustodyProofOperationRecord.ts'
import type { DurableCustodyProofOperationInput } from './durableCustodyProofOperation.ts'
import {
  addDurableWalletProofTransitionMetadata,
  assertDurableWalletProofResultMatchesPlan,
  createDurableWalletProofTransition,
  type DurableWalletProofTransition,
} from './durableWalletProofTransition.ts'

export const DURABLE_WALLET_OPERATION_SCHEMA_VERSION = 1 as const
export const DURABLE_WALLET_OPERATION_METADATA_KEY = 'durableWalletOperation'

export type DurableWalletOperationKind =
  | 'wallet-mint'
  | 'wallet-receive'
  | 'wallet-send'
  | 'wallet-melt'

interface DurableWalletOperationCommon {
  schemaVersion: typeof DURABLE_WALLET_OPERATION_SCHEMA_VERSION
  operationId: string
  kind: DurableWalletOperationKind
  mintUrl: string
  unit: string
}

export interface DurableWalletBlindedMessage {
  amount: string
  id: string
  B_: string
}

export interface DurableWalletOutputData {
  blindedMessage: DurableWalletBlindedMessage
  blindingFactor: string
  secret: string
  ephemeralE: string | null
}

export interface DurableWalletBlindedSignature {
  id: string
  amount: string
  C_: string
  dleq: null | { e: string; s: string; r: string | null }
}

export interface DurableWalletProof {
  id: string
  amount: string
  secret: string
  C: string
  dleq: null | { e: string; s: string; r: string | null }
  p2pkE: string | null
  /** Exact mint-wire witness; object witnesses are serialized before persistence. */
  witness: string | null
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

export type DurableWalletMintOperation = DurableWalletOperationCommon & {
  kind: 'wallet-mint'
  preview: {
    method: string
    quoteExpiryUnixSeconds: number | null
    payload: {
      quote: string
      outputs: DurableWalletBlindedMessage[]
      signature: string | null
    }
    outputData: DurableWalletOutputData[]
    keysetId: string
  }
}

export type DurableWalletReceiveOperation = DurableWalletOperationCommon & {
  kind: 'wallet-receive'
  preview: DurableWalletSwapPreview
}

export type DurableWalletSendOperation = DurableWalletOperationCommon & {
  kind: 'wallet-send'
  preview: DurableWalletSwapPreview
}

export type DurableWalletMeltOperation = DurableWalletOperationCommon & {
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

export type DurableWalletRuntimeOperation =
  | {
      kind: 'wallet-mint'
      preview: MintPreview<{ quote: string }>
    }
  | { kind: 'wallet-receive'; preview: SwapPreview }
  | { kind: 'wallet-send'; preview: SwapPreview }
  | {
      kind: 'wallet-melt'
      preview: MeltPreview<{ quote: string; amount: Amount }>
      requestOptions: {
        preferAsync: boolean
        extraPayload: Readonly<Record<string, DurableWalletJsonValue>>
      }
    }

export interface DurableWalletOperationAuthority {
  requestFingerprint: string
  outputPlanFingerprint: string
}

export interface DurableWalletExactOutputRestorePort {
  /**
   * Performs NUT-09 restore, verifies NUT-12 DLEQ proofs when present, and
   * verifies BLS proofs by pairing. The caller invokes this coordinator
   * outside any Web Lock or database transaction.
   */
  restoreVerifiedOutputGroups(input: {
    operationId: string
    mintUrl: string
    outputs: Readonly<Record<string, readonly OutputDataLike[]>>
  }): Promise<Readonly<Record<string, readonly ProofLike[]>>>
}

/** Runtime-only evidence issued after the restore port returns exact proofs. */
export interface DurableWalletVerifiedExactOutputRestore {
  readonly kind: 'exact'
  readonly operationId: string
  readonly requestFingerprint: string
  readonly outputPlanFingerprint: string
  readonly resultGroups: Record<string, Proof[]>
  readonly resultFingerprint: string
}

export type DurableWalletExactOutputRestoreResult =
  | { kind: 'partial' }
  | DurableWalletVerifiedExactOutputRestore

export type DurableWalletOperationRecoveryEvidence = {
  schemaVersion: 1
  operationId: string
  requestFingerprint: string
  submissionState: 'not-submitted' | 'submitted'
  quote:
    | null
    | {
        kind: 'mint'
        method: string
        quoteId: string
        state: 'UNPAID' | 'PAID' | 'ISSUED'
        expiryUnixSeconds: number | null
        observedAtUnixSeconds: number
      }
    | {
        kind: 'melt'
        method: string
        quoteId: string
        state: 'UNPAID' | 'PENDING' | 'PAID'
        change: DurableWalletBlindedSignature[]
      }
  inputStates: Array<{
    keysetId: string
    secret: string
    state: 'UNSPENT' | 'PENDING' | 'SPENT'
  }>
  restore:
    | { kind: 'none' }
    | { kind: 'partial' }
    | DurableWalletVerifiedExactOutputRestore
}

interface ExactRestoreAuthority {
  operationId: string
  requestFingerprint: string
  outputPlanFingerprint: string
  resultFingerprint: string
}

const exactRestoreAuthorities = new WeakMap<
  DurableWalletVerifiedExactOutputRestore,
  ExactRestoreAuthority
>()

export type DurableWalletOperationRecoveryDecision =
  | {
      kind: 'abort-no-transport'
      classification: Extract<
        DurableCustodyRecoveryClassification,
        'all-inputs-unspent'
      >
      reason: 'mint-quote-expired'
    }
  | {
      kind: 'reissue-exact-operation'
      classification: Extract<
        DurableCustodyRecoveryClassification,
        'all-inputs-unspent'
      >
      operation: DurableWalletOperation
    }
  | {
      kind: 'reconcile-exact-operation'
      classification: Extract<
        DurableCustodyRecoveryClassification,
        'spent-restorable'
      >
      operation: DurableWalletOperation
      result:
        | { kind: 'restored-proofs'; resultFingerprint: string }
        | {
            kind: 'melt-quote-change'
            change: DurableWalletBlindedSignature[]
          }
    }
  | {
      kind: 'retry-later'
      classification: Extract<
        DurableCustodyRecoveryClassification,
        'pending-or-mixed' | 'mint-response-unknown'
      >
      reason: 'quote-pending' | 'input-pending-or-mixed' | 'restore-incomplete'
    }
  | {
      kind: 'fail-closed'
      classification: Extract<
        DurableCustodyRecoveryClassification,
        'corrupt' | 'foreign'
      >
      reason: 'corrupt-evidence' | 'operation-authority' | 'quote-authority'
    }

export function createDurableWalletMintOperation(input: {
  operationId: string
  mintUrl: string
  unit: string
  quoteExpiryUnixSeconds: number | null
  preview: MintPreview<Pick<{ quote: string }, 'quote'>>
}): DurableWalletMintOperation {
  return decodeDurableWalletOperation({
    ...commonOperation(input, 'wallet-mint'),
    preview: {
      method: input.preview.method,
      quoteExpiryUnixSeconds: input.quoteExpiryUnixSeconds,
      payload: {
        quote: input.preview.payload.quote,
        outputs: input.preview.payload.outputs.map(serializeBlindedMessage),
        signature: input.preview.payload.signature ?? null,
      },
      outputData: input.preview.outputData.map(serializeOutput),
      keysetId: input.preview.keysetId,
    },
  }) as DurableWalletMintOperation
}

export function createDurableWalletReceiveOperation(input: {
  operationId: string
  mintUrl: string
  unit: string
  preview: SwapPreview
}): DurableWalletReceiveOperation {
  // P2PK/HTLC witnesses must already be present in the preview. Recovery calls
  // completeSwap with this exact rehydrated preview and no signing key.
  return createSwapOperation(input, 'wallet-receive')
}

export function createDurableWalletSendOperation(input: {
  operationId: string
  mintUrl: string
  unit: string
  preview: SwapPreview
}): DurableWalletSendOperation {
  // See createDurableWalletReceiveOperation: signing is preparation, not a
  // dispatch-time source of fresh request material.
  return createSwapOperation(input, 'wallet-send')
}

export function createDurableWalletMeltOperation(input: {
  operationId: string
  mintUrl: string
  unit: string
  preview: MeltPreview<
    Pick<{ quote: string; amount: AmountLike }, 'quote' | 'amount'>
  >
  requestOptions?: {
    preferAsync?: boolean
    extraPayload?: Readonly<Record<string, unknown>>
  }
}): DurableWalletMeltOperation {
  // Callers pre-sign P2PK/HTLC inputs before this boundary. completeMelt must
  // receive this exact rehydrated preview and no dispatch-time signing key.
  return decodeDurableWalletOperation({
    ...commonOperation(input, 'wallet-melt'),
    preview: {
      method: input.preview.method,
      inputs: input.preview.inputs.map(serializeProof),
      outputData: input.preview.outputData.map(serializeOutput),
      keysetId: input.preview.keysetId,
      quote: {
        quote: input.preview.quote.quote,
        amount: canonicalAmount(
          input.preview.quote.amount,
          false,
          'melt quote amount',
        ),
      },
      requestOptions: {
        preferAsync: input.requestOptions?.preferAsync ?? false,
        extraPayload: structuredClone(input.requestOptions?.extraPayload ?? {}),
      },
    },
  }) as DurableWalletMeltOperation
}

/** Strictly decodes one persisted preview; unknown fields and mixed variants fail closed. */
export function decodeDurableWalletOperation(
  value: unknown,
): DurableWalletOperation {
  const record = requireRecord(value, 'wallet operation')
  requireFields(record, [
    'schemaVersion',
    'operationId',
    'kind',
    'mintUrl',
    'unit',
    'preview',
  ])
  if (record.schemaVersion !== DURABLE_WALLET_OPERATION_SCHEMA_VERSION) {
    throw new Error('wallet operation schema version is invalid')
  }
  const common = {
    schemaVersion: DURABLE_WALLET_OPERATION_SCHEMA_VERSION,
    operationId: requireIdentifier(
      record.operationId,
      'wallet operation id',
      512,
    ),
    mintUrl: requireNormalizedMint(record.mintUrl),
    unit: requireIdentifier(record.unit, 'wallet operation unit'),
  }
  switch (record.kind) {
    case 'wallet-mint':
      return {
        ...common,
        kind: record.kind,
        preview: decodeMintPreview(record.preview),
      }
    case 'wallet-receive':
      return {
        ...common,
        kind: record.kind,
        preview: decodeSwapPreview(record.preview, record.kind),
      }
    case 'wallet-send':
      return {
        ...common,
        kind: record.kind,
        preview: decodeSwapPreview(record.preview, record.kind),
      }
    case 'wallet-melt':
      return {
        ...common,
        kind: record.kind,
        preview: decodeMeltPreview(record.preview),
      }
    default:
      throw new Error('wallet operation kind is invalid')
  }
}

/** Rehydrates only the decoded persisted preview; it never calls a preparation API. */
export function rehydrateDurableWalletOperation(
  value: unknown,
): DurableWalletRuntimeOperation {
  const operation = decodeDurableWalletOperation(value)
  switch (operation.kind) {
    case 'wallet-mint':
      return {
        kind: operation.kind,
        preview: {
          method: operation.preview.method,
          payload: {
            quote: operation.preview.payload.quote,
            outputs: operation.preview.payload.outputs.map(
              rehydrateBlindedMessage,
            ),
            ...(operation.preview.payload.signature === null
              ? {}
              : { signature: operation.preview.payload.signature }),
          },
          outputData: operation.preview.outputData.map(rehydrateOutput),
          keysetId: operation.preview.keysetId,
          quote: { quote: operation.preview.payload.quote },
        },
      }
    case 'wallet-receive':
    case 'wallet-send':
      return {
        kind: operation.kind,
        preview: rehydrateSwapPreview(operation.preview),
      }
    case 'wallet-melt':
      return {
        kind: operation.kind,
        preview: {
          method: operation.preview.method,
          inputs: operation.preview.inputs.map(rehydrateProof),
          outputData: operation.preview.outputData.map(rehydrateOutput),
          keysetId: operation.preview.keysetId,
          quote: {
            quote: operation.preview.quote.quote,
            amount: Amount.from(operation.preview.quote.amount),
          },
        },
        requestOptions: structuredClone(operation.preview.requestOptions),
      }
  }
}

/** Converts the exact preview into the common custody-operation authority. */
export function toDurableCustodyProofOperationInput(
  value: unknown,
): DurableCustodyProofOperationInput {
  const operation = decodeDurableWalletOperation(value)
  const exact = exactArtifacts(operation)
  const transition = walletProofTransition(
    operation,
    Object.keys(exact.outputs),
  )
  return {
    operationId: operation.operationId,
    kind: operation.kind,
    mintUrl: operation.mintUrl,
    inputs: exact.inputs.map(toCustodyProof),
    outputs: Object.fromEntries(
      Object.entries(exact.outputs).map(([label, outputs]) => [
        label,
        outputs.map((output) => ({
          blindedMessage: { ...output.blindedMessage },
          blindingFactor: output.blindingFactor,
          secret: output.secret,
          ...(output.ephemeralE === null
            ? {}
            : { ephemeralE: output.ephemeralE }),
        })),
      ]),
    ),
    metadata: addDurableWalletProofTransitionMetadata(
      {
        unit: operation.unit,
        [DURABLE_WALLET_OPERATION_METADATA_KEY]: structuredClone(operation),
      },
      transition,
    ),
  }
}

/** Recovers the exact preview only when every duplicate custody artifact agrees. */
export function requireDurableWalletOperationFromCustody(
  input: DurableCustodyProofOperationInput,
): DurableWalletOperation {
  const metadata = requireRecord(input.metadata, 'wallet operation metadata')
  const operation = decodeDurableWalletOperation(
    metadata[DURABLE_WALLET_OPERATION_METADATA_KEY],
  )
  const expected = toDurableCustodyProofOperationInput(operation)
  let actualFingerprint: string
  let expectedFingerprint: string
  try {
    actualFingerprint = deriveDurableCustodyArtifactFingerprint(
      exactCustodyInputArtifact(input),
    )
    expectedFingerprint = deriveDurableCustodyArtifactFingerprint(
      exactCustodyInputArtifact(expected),
    )
  } catch {
    throw new Error(
      'custody operation does not match its exact persisted preview',
    )
  }
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error(
      'custody operation does not match its exact persisted preview',
    )
  }
  return operation
}

export function deriveDurableWalletOperationAuthority(
  value: unknown,
): DurableWalletOperationAuthority {
  const operation = decodeDurableWalletOperation(value)
  const exact = exactArtifacts(operation)
  return {
    requestFingerprint: deriveDurableCustodyArtifactFingerprint(operation),
    outputPlanFingerprint: deriveDurableCustodyArtifactFingerprint(
      exact.outputs,
    ),
  }
}

/** Canonicalizes the exact NUT-05 quote change returned by cashu-ts. */
export function serializeDurableWalletMeltChange(
  change: readonly SerializedBlindedSignature[] | undefined,
): DurableWalletBlindedSignature[] {
  return (change ?? []).map((signature) =>
    decodeBlindedSignature({
      id: signature.id,
      amount: canonicalAmount(signature.amount, false, 'melt change amount'),
      C_: signature.C_,
      dleq: signature.dleq
        ? {
            e: signature.dleq.e,
            s: signature.dleq.s,
            r: signature.dleq.r ?? null,
          }
        : null,
    }),
  )
}

/** Rehydrates exact quote change for wallet.createMeltChangeProofs. */
export function rehydrateDurableWalletMeltChange(
  change: readonly DurableWalletBlindedSignature[],
): SerializedBlindedSignature[] {
  return change.map((signature) => ({
    id: signature.id,
    amount: Amount.from(signature.amount),
    C_: signature.C_,
    ...(signature.dleq === null
      ? {}
      : {
          dleq: {
            e: signature.dleq.e,
            s: signature.dleq.s,
            ...(signature.dleq.r === null ? {} : { r: signature.dleq.r }),
          },
        }),
  }))
}

/** Restores and maps only the exact persisted mint/swap output groups. */
export async function restoreDurableWalletOperationOutputs(
  persisted: unknown,
  port: DurableWalletExactOutputRestorePort,
): Promise<DurableWalletExactOutputRestoreResult> {
  const operation = decodeDurableWalletOperation(persisted)
  if (operation.kind === 'wallet-melt') {
    throw new Error('melt recovery uses exact quote change authority')
  }
  const outputGroups = rehydrateOutputGroups(exactArtifacts(operation).outputs)
  const restored = await port.restoreVerifiedOutputGroups({
    operationId: operation.operationId,
    mintUrl: operation.mintUrl,
    outputs: outputGroups,
  })
  const normalized = normalizeRestoredOutputGroups(outputGroups, restored)
  if (normalized.kind === 'partial') return normalized

  const resultGroups = addRestorePassthroughs(
    operation,
    normalized.resultGroups,
  )
  const policy = walletProofTransition(operation, Object.keys(outputGroups))
  assertDurableWalletProofResultMatchesPlan(
    policy,
    plannedOutputGroups(outputGroups),
    resultGroups,
  )
  return createVerifiedExactRestore(operation, resultGroups)
}

function createVerifiedExactRestore(
  operation: Exclude<DurableWalletOperation, DurableWalletMeltOperation>,
  resultGroups: Record<string, Proof[]>,
): DurableWalletVerifiedExactOutputRestore {
  const authority = deriveDurableWalletOperationAuthority(operation)
  const resultFingerprint =
    deriveDurableCustodyProofResultFingerprint(resultGroups)
  const result: DurableWalletVerifiedExactOutputRestore = {
    kind: 'exact',
    operationId: operation.operationId,
    requestFingerprint: authority.requestFingerprint,
    outputPlanFingerprint: authority.outputPlanFingerprint,
    resultGroups,
    resultFingerprint,
  }
  exactRestoreAuthorities.set(result, {
    operationId: operation.operationId,
    requestFingerprint: authority.requestFingerprint,
    outputPlanFingerprint: authority.outputPlanFingerprint,
    resultFingerprint,
  })
  return result
}

/** Quote-aware recovery never selects a replacement operation or output plan. */
export function decideDurableWalletOperationRecovery(
  persisted: unknown,
  evidenceValue: unknown,
): DurableWalletOperationRecoveryDecision {
  let operation: DurableWalletOperation
  let evidence: DurableWalletOperationRecoveryEvidence
  try {
    operation = decodeDurableWalletOperation(persisted)
    evidence = decodeRecoveryEvidence(evidenceValue)
  } catch {
    return failClosed('corrupt', 'corrupt-evidence')
  }
  const authority = deriveDurableWalletOperationAuthority(operation)
  if (
    evidence.operationId !== operation.operationId ||
    evidence.requestFingerprint !== authority.requestFingerprint
  ) {
    return failClosed('foreign', 'operation-authority')
  }
  if (!matchesInputAuthority(operation, evidence.inputStates)) {
    return failClosed('foreign', 'operation-authority')
  }
  const restoredResultFingerprint = verifiedRestoreResultFingerprint(
    operation,
    evidence.restore,
  )
  if (restoredResultFingerprint === false) {
    return failClosed('foreign', 'operation-authority')
  }
  if (!matchesQuoteAuthority(operation, evidence.quote)) {
    return failClosed('foreign', 'quote-authority')
  }

  switch (operation.kind) {
    case 'wallet-mint':
      return decideMintRecovery(operation, evidence, restoredResultFingerprint)
    case 'wallet-receive':
    case 'wallet-send':
      return decideSwapRecovery(operation, evidence, restoredResultFingerprint)
    case 'wallet-melt':
      return decideMeltRecovery(operation, evidence)
  }
}

function createSwapOperation<K extends 'wallet-receive' | 'wallet-send'>(
  input: {
    operationId: string
    mintUrl: string
    unit: string
    preview: SwapPreview
  },
  kind: K,
): Extract<DurableWalletOperation, { kind: K }> {
  return decodeDurableWalletOperation({
    ...commonOperation(input, kind),
    preview: {
      amount: canonicalAmount(input.preview.amount, false, 'swap amount'),
      fees: canonicalAmount(input.preview.fees, true, 'swap fees'),
      keysetId: input.preview.keysetId,
      inputs: input.preview.inputs.map(serializeProof),
      sendOutputs: (input.preview.sendOutputs ?? []).map(serializeOutput),
      keepOutputs: (input.preview.keepOutputs ?? []).map(serializeOutput),
      unselectedProofs: (input.preview.unselectedProofs ?? []).map(
        serializeProof,
      ),
    },
  }) as Extract<DurableWalletOperation, { kind: K }>
}

function commonOperation(
  input: { operationId: string; mintUrl: string; unit: string },
  kind: DurableWalletOperationKind,
) {
  return {
    schemaVersion: DURABLE_WALLET_OPERATION_SCHEMA_VERSION,
    operationId: input.operationId,
    kind,
    mintUrl: input.mintUrl,
    unit: input.unit,
  }
}

function decodeMintPreview(
  value: unknown,
): DurableWalletMintOperation['preview'] {
  const preview = requireRecord(value, 'wallet mint preview')
  requireFields(preview, [
    'method',
    'quoteExpiryUnixSeconds',
    'payload',
    'outputData',
    'keysetId',
  ])
  const payload = requireRecord(preview.payload, 'wallet mint payload')
  requireFields(payload, ['quote', 'outputs', 'signature'])
  const decoded = {
    method: requireIdentifier(preview.method, 'mint method'),
    quoteExpiryUnixSeconds: requireOptionalUnixSeconds(
      preview.quoteExpiryUnixSeconds,
      'mint quote expiry',
    ),
    payload: {
      quote: requireIdentifier(payload.quote, 'mint quote id'),
      outputs: requireArray(payload.outputs, 'mint payload outputs').map(
        decodeBlindedMessage,
      ),
      signature:
        payload.signature === null
          ? null
          : requireIdentifier(
              payload.signature,
              'mint quote signature',
              16_384,
            ),
    },
    outputData: decodeOutputs(preview.outputData),
    keysetId: requireIdentifier(preview.keysetId, 'mint keyset id'),
  }
  if (decoded.outputData.length === 0)
    throw new Error('mint output plan is empty')
  assertOutputKeyset(decoded.outputData, decoded.keysetId)
  if (
    deriveDurableCustodyArtifactFingerprint(decoded.payload.outputs) !==
    deriveDurableCustodyArtifactFingerprint(
      decoded.outputData.map(({ blindedMessage }) => blindedMessage),
    )
  ) {
    throw new Error('mint payload does not match exact outputs')
  }
  return decoded
}

function decodeSwapPreview(
  value: unknown,
  kind: 'wallet-receive' | 'wallet-send',
): DurableWalletSwapPreview {
  const preview = requireRecord(
    value,
    `wallet ${kind === 'wallet-send' ? 'send' : 'receive'} preview`,
  )
  requireFields(preview, [
    'amount',
    'fees',
    'keysetId',
    'inputs',
    'sendOutputs',
    'keepOutputs',
    'unselectedProofs',
  ])
  const decoded = {
    amount: requireCanonicalAmount(preview.amount, false, 'swap amount'),
    fees: requireCanonicalAmount(preview.fees, true, 'swap fees'),
    keysetId: requireIdentifier(preview.keysetId, 'swap keyset id'),
    inputs: decodeProofs(preview.inputs, 'swap inputs'),
    sendOutputs: decodeOutputs(preview.sendOutputs),
    keepOutputs: decodeOutputs(preview.keepOutputs),
    unselectedProofs: decodeProofs(
      preview.unselectedProofs,
      'unselected proofs',
      true,
    ),
  }
  if (decoded.inputs.length === 0) throw new Error('swap inputs are empty')
  if (kind === 'wallet-receive') {
    if (
      decoded.sendOutputs.length !== 0 ||
      decoded.unselectedProofs.length !== 0 ||
      decoded.keepOutputs.length === 0
    ) {
      throw new Error('wallet receive preview is mixed or incomplete')
    }
  } else if (decoded.sendOutputs.length === 0) {
    throw new Error('wallet send preview is incomplete')
  }
  assertOutputKeyset(
    [...decoded.sendOutputs, ...decoded.keepOutputs],
    decoded.keysetId,
  )
  assertDistinctOutputs([...decoded.sendOutputs, ...decoded.keepOutputs])
  assertDistinctProofs([...decoded.inputs, ...decoded.unselectedProofs])
  return decoded
}

function decodeMeltPreview(
  value: unknown,
): DurableWalletMeltOperation['preview'] {
  const preview = requireRecord(value, 'wallet melt preview')
  requireFields(preview, [
    'method',
    'inputs',
    'outputData',
    'keysetId',
    'quote',
    'requestOptions',
  ])
  const quote = requireRecord(preview.quote, 'melt quote authority')
  requireFields(quote, ['quote', 'amount'])
  const options = requireRecord(preview.requestOptions, 'melt request options')
  requireFields(options, ['preferAsync', 'extraPayload'])
  const inputs = decodeProofs(preview.inputs, 'melt inputs')
  const outputData = decodeOutputs(preview.outputData)
  const keysetId = requireIdentifier(preview.keysetId, 'melt keyset id')
  if (inputs.length === 0) throw new Error('melt inputs are empty')
  assertOutputKeyset(outputData, keysetId)
  return {
    method: requireIdentifier(preview.method, 'melt method'),
    inputs,
    outputData,
    keysetId,
    quote: {
      quote: requireIdentifier(quote.quote, 'melt quote id'),
      amount: requireCanonicalAmount(quote.amount, false, 'melt quote amount'),
    },
    requestOptions: {
      preferAsync: requireBoolean(options.preferAsync, 'melt async preference'),
      extraPayload: decodeExtraPayload(options.extraPayload),
    },
  }
}

function exactArtifacts(operation: DurableWalletOperation): {
  inputs: DurableWalletProof[]
  outputs: Record<string, DurableWalletOutputData[]>
} {
  switch (operation.kind) {
    case 'wallet-mint':
      return {
        inputs: [],
        outputs: { receive: operation.preview.outputData },
      }
    case 'wallet-receive':
      return swapArtifacts(operation, {
        receive: operation.preview.keepOutputs,
      })
    case 'wallet-send':
      return swapArtifacts(operation, {
        keep: operation.preview.keepOutputs,
        send: operation.preview.sendOutputs,
      })
    case 'wallet-melt':
      return {
        inputs: operation.preview.inputs,
        outputs: { change: operation.preview.outputData },
      }
  }
}

function swapArtifacts(
  operation: DurableWalletReceiveOperation | DurableWalletSendOperation,
  outputs: Record<string, DurableWalletOutputData[]>,
) {
  return {
    inputs: operation.preview.inputs,
    outputs,
  }
}

function walletProofTransition(
  operation: DurableWalletOperation,
  plannedOutputLabels: readonly string[],
): DurableWalletProofTransition {
  switch (operation.kind) {
    case 'wallet-mint':
    case 'wallet-receive':
      return createDurableWalletProofTransition({
        inputSource: 'external',
        plannedOutputLabels,
        resultGroups: {
          receive: { kind: 'wallet', asset: 'regular', reservedBy: null },
        },
      })
    case 'wallet-send':
      return createDurableWalletProofTransition({
        inputSource: 'wallet',
        plannedOutputLabels,
        resultGroups: {
          keep: { kind: 'wallet', asset: 'regular', reservedBy: null },
          send: { kind: 'operation' },
        },
        passthroughResultGroups: {
          keep: operation.preview.unselectedProofs.map(rehydrateProof),
        },
      })
    case 'wallet-melt':
      return createDurableWalletProofTransition({
        inputSource: 'wallet',
        plannedOutputLabels,
        resultGroups: {
          change: { kind: 'wallet', asset: 'regular', reservedBy: null },
        },
        resultCardinality: { change: 'prefix' },
      })
  }
}

function exactCustodyInputArtifact(input: DurableCustodyProofOperationInput) {
  return {
    operationId: input.operationId,
    kind: input.kind,
    mintUrl: input.mintUrl,
    inputs: input.inputs,
    outputs: input.outputs,
    metadata: input.metadata ?? null,
    durableTradeRecovery: input.durableTradeRecovery ?? null,
  }
}

function rehydrateOutputGroups(
  groups: Readonly<Record<string, readonly DurableWalletOutputData[]>>,
): Record<string, OutputData[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([label, outputs]) => [
      label,
      outputs.map(rehydrateOutput),
    ]),
  )
}

function normalizeRestoredOutputGroups(
  outputs: Readonly<Record<string, readonly OutputDataLike[]>>,
  restored: Readonly<Record<string, readonly ProofLike[]>>,
):
  | { kind: 'partial' }
  | { kind: 'exact'; resultGroups: Record<string, Proof[]> } {
  const labels = Object.keys(outputs)
  if (Object.keys(restored).some((label) => !labels.includes(label))) {
    throw new Error('restore returned a foreign output group')
  }
  let partial = false
  const resultGroups: Record<string, Proof[]> = {}
  for (const label of labels) {
    const planned = outputs[label] ?? []
    const proofs = (restored[label] ?? []).map((proof) =>
      rehydrateProof(serializeProof(proof)),
    )
    if (proofs.length > planned.length) {
      throw new Error('restore returned more proofs than the exact output plan')
    }
    proofs.forEach((proof, index) =>
      assertRestoredOutput(planned[index]!, proof),
    )
    if (proofs.length < planned.length) partial = true
    resultGroups[label] = proofs
  }
  return partial ? { kind: 'partial' } : { kind: 'exact', resultGroups }
}

function assertRestoredOutput(output: OutputDataLike, proof: Proof): void {
  const expectedSecret = new TextDecoder().decode(output.secret)
  if (
    proof.secret !== expectedSecret ||
    proof.id !== output.blindedMessage.id ||
    !proof.amount.equals(output.blindedMessage.amount)
  ) {
    throw new Error('restored proof does not match its exact persisted output')
  }
}

function addRestorePassthroughs(
  operation: Exclude<DurableWalletOperation, DurableWalletMeltOperation>,
  groups: Record<string, Proof[]>,
): Record<string, Proof[]> {
  if (operation.kind !== 'wallet-send') return groups
  return {
    ...groups,
    keep: [
      ...(groups.keep ?? []),
      ...operation.preview.unselectedProofs.map(rehydrateProof),
    ],
  }
}

function plannedOutputGroups(
  groups: Readonly<Record<string, readonly OutputDataLike[]>>,
) {
  return Object.fromEntries(
    Object.entries(groups).map(([label, outputs]) => [
      label,
      outputs.map((output) => ({
        secret: new TextDecoder().decode(output.secret),
        blindedMessage: output.blindedMessage,
      })),
    ]),
  )
}

function verifiedRestoreResultFingerprint(
  operation: DurableWalletOperation,
  restore: DurableWalletOperationRecoveryEvidence['restore'],
): string | null | false {
  if (restore.kind !== 'exact') return null
  const issued = exactRestoreAuthorities.get(restore)
  if (!issued || operation.kind === 'wallet-melt') return false
  try {
    const authority = deriveDurableWalletOperationAuthority(operation)
    if (!restoreAuthorityMatches(operation, authority, restore, issued)) {
      return false
    }
    const resultGroups = normalizeExactRuntimeResultGroups(
      operation,
      restore.resultGroups,
    )
    const fingerprint = deriveDurableCustodyProofResultFingerprint(resultGroups)
    return fingerprint === issued.resultFingerprint ? fingerprint : false
  } catch {
    return false
  }
}

function restoreAuthorityMatches(
  operation: DurableWalletOperation,
  authority: DurableWalletOperationAuthority,
  restore: DurableWalletVerifiedExactOutputRestore,
  issued: ExactRestoreAuthority,
): boolean {
  return (
    restore.operationId === operation.operationId &&
    restore.requestFingerprint === authority.requestFingerprint &&
    restore.outputPlanFingerprint === authority.outputPlanFingerprint &&
    restore.resultFingerprint === issued.resultFingerprint &&
    issued.operationId === operation.operationId &&
    issued.requestFingerprint === authority.requestFingerprint &&
    issued.outputPlanFingerprint === authority.outputPlanFingerprint
  )
}

function normalizeExactRuntimeResultGroups(
  operation: Exclude<DurableWalletOperation, DurableWalletMeltOperation>,
  value: unknown,
): Record<string, Proof[]> {
  const groups = requireRecord(value, 'verified restore result groups')
  const outputGroups = rehydrateOutputGroups(exactArtifacts(operation).outputs)
  const labels = Object.keys(outputGroups)
  if (!sameOrderedLabels(labels, Object.keys(groups))) {
    throw new Error('verified restore result labels changed')
  }
  const normalized = Object.fromEntries(
    labels.map((label) => [
      label,
      requireArray(groups[label], 'verified restore result group').map(
        normalizeRuntimeProof,
      ),
    ]),
  )
  assertDurableWalletProofResultMatchesPlan(
    walletProofTransition(operation, labels),
    plannedOutputGroups(outputGroups),
    normalized,
  )
  return normalized
}

function normalizeRuntimeProof(value: unknown): Proof {
  const proof = requireRecord(value, 'verified restore proof')
  const required = ['id', 'amount', 'secret', 'C']
  const allowed = [...required, 'dleq', 'p2pk_e', 'witness']
  if (
    Object.keys(proof).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in proof))
  ) {
    throw new Error('verified restore proof fields changed')
  }
  return rehydrateProof(decodeProof(serializeProof(proof as ProofLike)))
}

function sameOrderedLabels(
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  return (
    expected.length === actual.length &&
    expected.every((label, index) => label === actual[index])
  )
}

function decideMintRecovery(
  operation: DurableWalletMintOperation,
  evidence: DurableWalletOperationRecoveryEvidence,
  restoredResultFingerprint: string | null,
): DurableWalletOperationRecoveryDecision {
  const quote = evidence.quote
  if (quote?.kind !== 'mint') return failClosed('corrupt', 'corrupt-evidence')
  if (quote.state === 'ISSUED') {
    return evidence.restore.kind === 'exact'
      ? reconcileRestored(operation, restoredResultFingerprint!)
      : retry('restore-incomplete', 'mint-response-unknown')
  }
  if (quote.state === 'PAID') {
    return evidence.restore.kind === 'none'
      ? reissue(operation)
      : failClosed('corrupt', 'corrupt-evidence')
  }
  if (quote.state === 'UNPAID') {
    if (evidence.restore.kind !== 'none') {
      return failClosed('corrupt', 'corrupt-evidence')
    }
    if (
      evidence.submissionState === 'not-submitted' &&
      operation.preview.quoteExpiryUnixSeconds !== null &&
      quote.observedAtUnixSeconds >= operation.preview.quoteExpiryUnixSeconds
    ) {
      return {
        kind: 'abort-no-transport',
        classification: 'all-inputs-unspent',
        reason: 'mint-quote-expired',
      }
    }
    return retry('quote-pending', 'pending-or-mixed')
  }
  return failClosed('corrupt', 'corrupt-evidence')
}

function decideSwapRecovery(
  operation: DurableWalletReceiveOperation | DurableWalletSendOperation,
  evidence: DurableWalletOperationRecoveryEvidence,
  restoredResultFingerprint: string | null,
): DurableWalletOperationRecoveryDecision {
  const state = uniformInputState(evidence.inputStates)
  if (state === 'UNSPENT') {
    return evidence.restore.kind === 'none'
      ? reissue(operation)
      : failClosed('corrupt', 'corrupt-evidence')
  }
  if (state === 'SPENT' && evidence.restore.kind === 'exact') {
    return reconcileRestored(operation, restoredResultFingerprint!)
  }
  return retry(
    evidence.restore.kind === 'partial'
      ? 'restore-incomplete'
      : 'input-pending-or-mixed',
    state === 'SPENT' ? 'mint-response-unknown' : 'pending-or-mixed',
  )
}

function decideMeltRecovery(
  operation: DurableWalletMeltOperation,
  evidence: DurableWalletOperationRecoveryEvidence,
): DurableWalletOperationRecoveryDecision {
  const quote = evidence.quote
  if (quote?.kind !== 'melt') return failClosed('corrupt', 'corrupt-evidence')
  if (evidence.restore.kind !== 'none') {
    return failClosed('corrupt', 'corrupt-evidence')
  }
  if (quote.state === 'PAID') {
    const inputState = uniformInputState(evidence.inputStates)
    if (inputState === 'UNSPENT') {
      return failClosed('corrupt', 'corrupt-evidence')
    }
    if (inputState !== 'SPENT') {
      return retry('input-pending-or-mixed', 'pending-or-mixed')
    }
    if (!meltChangeMatchesPlan(operation, quote.change)) {
      return failClosed('corrupt', 'corrupt-evidence')
    }
    return reconcileMeltChange(operation, quote.change)
  }
  if (quote.state === 'PENDING') {
    if (quote.change.length > 0)
      return failClosed('corrupt', 'corrupt-evidence')
    return retry('quote-pending', 'pending-or-mixed')
  }
  if (quote.state === 'UNPAID') {
    if (quote.change.length > 0)
      return failClosed('corrupt', 'corrupt-evidence')
    const inputState = uniformInputState(evidence.inputStates)
    return inputState === 'UNSPENT'
      ? reissue(operation)
      : retry('input-pending-or-mixed', 'pending-or-mixed')
  }
  return failClosed('corrupt', 'corrupt-evidence')
}

function reissue(
  operation: DurableWalletOperation,
): DurableWalletOperationRecoveryDecision {
  return {
    kind: 'reissue-exact-operation',
    classification: 'all-inputs-unspent',
    operation: structuredClone(operation),
  }
}

function reconcileRestored(
  operation: DurableWalletOperation,
  resultFingerprint: string,
): DurableWalletOperationRecoveryDecision {
  return {
    kind: 'reconcile-exact-operation',
    classification: 'spent-restorable',
    operation: structuredClone(operation),
    result: { kind: 'restored-proofs', resultFingerprint },
  }
}

function reconcileMeltChange(
  operation: DurableWalletMeltOperation,
  change: readonly DurableWalletBlindedSignature[],
): DurableWalletOperationRecoveryDecision {
  return {
    kind: 'reconcile-exact-operation',
    classification: 'spent-restorable',
    operation: structuredClone(operation),
    result: {
      kind: 'melt-quote-change',
      change: change.map((signature) => structuredClone(signature)),
    },
  }
}

function meltChangeMatchesPlan(
  operation: DurableWalletMeltOperation,
  change: readonly DurableWalletBlindedSignature[],
): boolean {
  const outputs = operation.preview.outputData
  if (change.length > outputs.length) return false
  return change.every((signature, index) => {
    const output = outputs[index]!.blindedMessage
    return (
      signature.id === output.id &&
      (output.amount === '0' || signature.amount === output.amount)
    )
  })
}

function retry(
  reason: Extract<
    DurableWalletOperationRecoveryDecision,
    { kind: 'retry-later' }
  >['reason'],
  classification: Extract<
    DurableWalletOperationRecoveryDecision,
    { kind: 'retry-later' }
  >['classification'],
): DurableWalletOperationRecoveryDecision {
  return { kind: 'retry-later', classification, reason }
}

function failClosed(
  classification: 'corrupt' | 'foreign',
  reason: Extract<
    DurableWalletOperationRecoveryDecision,
    { kind: 'fail-closed' }
  >['reason'],
): DurableWalletOperationRecoveryDecision {
  return { kind: 'fail-closed', classification, reason }
}

function matchesInputAuthority(
  operation: DurableWalletOperation,
  states: DurableWalletOperationRecoveryEvidence['inputStates'],
): boolean {
  const inputs = exactArtifacts(operation).inputs
  return (
    inputs.length === states.length &&
    inputs.every(
      (proof, index) =>
        proof.id === states[index]!.keysetId &&
        proof.secret === states[index]!.secret,
    )
  )
}

function matchesQuoteAuthority(
  operation: DurableWalletOperation,
  quote: DurableWalletOperationRecoveryEvidence['quote'],
): boolean {
  switch (operation.kind) {
    case 'wallet-mint':
      return (
        quote !== null &&
        quote.kind === 'mint' &&
        quote.method === operation.preview.method &&
        quote.quoteId === operation.preview.payload.quote &&
        quote.expiryUnixSeconds ===
          operation.preview.quoteExpiryUnixSeconds &&
        (quote.state === 'UNPAID' ||
          quote.state === 'PAID' ||
          quote.state === 'ISSUED')
      )
    case 'wallet-melt':
      return (
        quote !== null &&
        quote.kind === 'melt' &&
        quote.method === operation.preview.method &&
        quote.quoteId === operation.preview.quote.quote &&
        (quote.state === 'UNPAID' ||
          quote.state === 'PENDING' ||
          quote.state === 'PAID')
      )
    case 'wallet-receive':
    case 'wallet-send':
      return quote === null
  }
}

function uniformInputState(
  states: DurableWalletOperationRecoveryEvidence['inputStates'],
): 'UNSPENT' | 'PENDING' | 'SPENT' | 'MIXED' {
  if (states.length === 0) return 'MIXED'
  const state = states[0]!.state
  return states.every((candidate) => candidate.state === state)
    ? state
    : 'MIXED'
}

function decodeRecoveryEvidence(
  value: unknown,
): DurableWalletOperationRecoveryEvidence {
  const evidence = requireRecord(value, 'wallet recovery evidence')
  requireFields(evidence, [
    'schemaVersion',
    'operationId',
    'requestFingerprint',
    'submissionState',
    'quote',
    'inputStates',
    'restore',
  ])
  if (evidence.schemaVersion !== 1)
    throw new Error('recovery evidence version is invalid')
  if (
    evidence.submissionState !== 'not-submitted' &&
    evidence.submissionState !== 'submitted'
  ) {
    throw new Error('recovery submission state is invalid')
  }
  return {
    schemaVersion: 1,
    operationId: requireIdentifier(
      evidence.operationId,
      'recovery operation id',
      512,
    ),
    requestFingerprint: requireFingerprint(
      evidence.requestFingerprint,
      'recovery request fingerprint',
    ),
    submissionState: evidence.submissionState,
    quote: decodeRecoveryQuote(evidence.quote),
    inputStates: requireArray(
      evidence.inputStates,
      'recovery input states',
    ).map(decodeInputState),
    restore: decodeRestoreEvidence(evidence.restore),
  }
}

function decodeRecoveryQuote(
  value: unknown,
): DurableWalletOperationRecoveryEvidence['quote'] {
  if (value === null) return null
  const quote = requireRecord(value, 'recovery quote')
  if (quote.kind === 'mint') {
    requireFields(quote, [
      'kind',
      'method',
      'quoteId',
      'state',
      'expiryUnixSeconds',
      'observedAtUnixSeconds',
    ])
    if (
      quote.state !== 'UNPAID' &&
      quote.state !== 'PAID' &&
      quote.state !== 'ISSUED'
    ) {
      throw new Error('recovery mint quote state is invalid')
    }
    return {
      kind: quote.kind,
      method: requireIdentifier(quote.method, 'recovery quote method'),
      quoteId: requireIdentifier(quote.quoteId, 'recovery quote id'),
      state: quote.state,
      expiryUnixSeconds: requireOptionalUnixSeconds(
        quote.expiryUnixSeconds,
        'recovery quote expiry',
      ),
      observedAtUnixSeconds: requireUnixSeconds(
        quote.observedAtUnixSeconds,
        'recovery quote observation time',
      ),
    }
  }
  if (quote.kind === 'melt') {
    requireFields(quote, ['kind', 'method', 'quoteId', 'state', 'change'])
    if (
      quote.state !== 'UNPAID' &&
      quote.state !== 'PENDING' &&
      quote.state !== 'PAID'
    ) {
      throw new Error('recovery melt quote state is invalid')
    }
    return {
      kind: quote.kind,
      method: requireIdentifier(quote.method, 'recovery quote method'),
      quoteId: requireIdentifier(quote.quoteId, 'recovery quote id'),
      state: quote.state,
      change: requireArray(quote.change, 'melt quote change').map(
        decodeBlindedSignature,
      ),
    }
  }
  throw new Error('recovery quote kind is invalid')
}

function decodeBlindedSignature(value: unknown): DurableWalletBlindedSignature {
  const signature = requireRecord(value, 'melt change signature')
  requireFields(signature, ['id', 'amount', 'C_', 'dleq'])
  return {
    id: requireIdentifier(signature.id, 'melt change keyset id'),
    amount: requireCanonicalAmount(
      signature.amount,
      false,
      'melt change amount',
    ),
    C_: requirePoint(signature.C_, 'melt change signature', [66, 96]),
    dleq: decodeDleq(signature.dleq),
  }
}

function decodeInputState(
  value: unknown,
): DurableWalletOperationRecoveryEvidence['inputStates'][number] {
  const state = requireRecord(value, 'recovery input state')
  requireFields(state, ['keysetId', 'secret', 'state'])
  if (
    state.state !== 'UNSPENT' &&
    state.state !== 'PENDING' &&
    state.state !== 'SPENT'
  ) {
    throw new Error('recovery input state is invalid')
  }
  return {
    keysetId: requireIdentifier(state.keysetId, 'recovery input keyset'),
    secret: requireText(state.secret, 'recovery input secret', 16_384),
    state: state.state,
  }
}

function decodeRestoreEvidence(
  value: unknown,
): DurableWalletOperationRecoveryEvidence['restore'] {
  const restore = requireRecord(value, 'restore evidence')
  if (restore.kind === 'none' || restore.kind === 'partial') {
    requireFields(restore, ['kind'])
    return { kind: restore.kind }
  }
  if (restore.kind === 'exact') {
    requireFields(restore, [
      'kind',
      'operationId',
      'requestFingerprint',
      'outputPlanFingerprint',
      'resultGroups',
      'resultFingerprint',
    ])
    const issued = restore as unknown as DurableWalletVerifiedExactOutputRestore
    if (!exactRestoreAuthorities.has(issued)) {
      throw new Error('exact restore evidence was not issued by the SDK')
    }
    requireIdentifier(restore.operationId, 'restore operation id', 512)
    requireFingerprint(
      restore.requestFingerprint,
      'restore request fingerprint',
    )
    requireFingerprint(
      restore.outputPlanFingerprint,
      'restore output plan fingerprint',
    )
    requireRecord(restore.resultGroups, 'restore result groups')
    requireFingerprint(restore.resultFingerprint, 'restore result fingerprint')
    return issued
  }
  throw new Error('restore evidence kind is invalid')
}

function serializeOutput(output: OutputDataLike): DurableWalletOutputData {
  const serialized = OutputData.serialize(output)
  return {
    blindedMessage: {
      amount: canonicalAmount(
        serialized.blindedMessage.amount,
        true,
        'output amount',
      ),
      id: serialized.blindedMessage.id,
      B_: serialized.blindedMessage.B_,
    },
    blindingFactor: serialized.blindingFactor,
    secret: serialized.secret,
    ephemeralE: serialized.ephemeralE ?? null,
  }
}

function serializeBlindedMessage(
  message: MintPreview['payload']['outputs'][number],
): DurableWalletBlindedMessage {
  return {
    amount: canonicalAmount(message.amount, true, 'blinded message amount'),
    id: message.id,
    B_: message.B_,
  }
}

function decodeOutputs(value: unknown): DurableWalletOutputData[] {
  const outputs = requireArray(value, 'wallet outputs').map((item) => {
    const output = requireRecord(item, 'wallet output')
    requireFields(output, [
      'blindedMessage',
      'blindingFactor',
      'secret',
      'ephemeralE',
    ])
    return {
      blindedMessage: decodeBlindedMessage(output.blindedMessage),
      blindingFactor: requireCanonicalDecimal(
        output.blindingFactor,
        false,
        'output blinding factor',
      ),
      secret: requireHex(output.secret, 'output secret', 2_048),
      ephemeralE:
        output.ephemeralE === null
          ? null
          : requirePoint(output.ephemeralE, 'output ephemeral key', [66]),
    }
  })
  const secrets = new Set(outputs.map(({ secret }) => secret))
  if (secrets.size !== outputs.length)
    throw new Error('wallet output secrets are reused')
  return outputs
}

function decodeBlindedMessage(value: unknown): DurableWalletBlindedMessage {
  const message = requireRecord(value, 'blinded message')
  requireFields(message, ['amount', 'id', 'B_'])
  return {
    amount: requireCanonicalAmount(message.amount, true, 'output amount'),
    id: requireIdentifier(message.id, 'output keyset id'),
    B_: requirePoint(message.B_, 'blinded message', [66, 96]),
  }
}

function serializeProof(proof: ProofLike): DurableWalletProof {
  return {
    id: proof.id,
    amount: canonicalAmount(proof.amount, false, 'proof amount'),
    secret: proof.secret,
    C: proof.C,
    dleq: proof.dleq
      ? { e: proof.dleq.e, s: proof.dleq.s, r: proof.dleq.r ?? null }
      : null,
    p2pkE: proof.p2pk_e ?? null,
    witness: serializeWitness(proof.witness),
  }
}

function decodeProofs(
  value: unknown,
  name: string,
  emptyAllowed = false,
): DurableWalletProof[] {
  const proofs = requireArray(value, name).map(decodeProof)
  if (!emptyAllowed && proofs.length === 0) throw new Error(`${name} are empty`)
  assertDistinctProofs(proofs)
  return proofs
}

function decodeProof(value: unknown): DurableWalletProof {
  const proof = requireRecord(value, 'wallet proof')
  requireFields(proof, [
    'id',
    'amount',
    'secret',
    'C',
    'dleq',
    'p2pkE',
    'witness',
  ])
  return {
    id: requireIdentifier(proof.id, 'proof keyset id'),
    amount: requireCanonicalAmount(proof.amount, false, 'proof amount'),
    secret: requireText(proof.secret, 'proof secret', 16_384),
    C: requirePoint(proof.C, 'proof signature', [66, 96]),
    dleq: decodeDleq(proof.dleq),
    p2pkE:
      proof.p2pkE === null
        ? null
        : requirePoint(proof.p2pkE, 'proof ephemeral key', [66]),
    witness:
      proof.witness === null
        ? null
        : requireText(proof.witness, 'proof witness', 16_384),
  }
}

function decodeDleq(value: unknown): DurableWalletProof['dleq'] {
  if (value === null) return null
  const dleq = requireRecord(value, 'proof dleq')
  requireFields(dleq, ['e', 's', 'r'])
  return {
    e: requireHex(dleq.e, 'proof dleq e', 512),
    s: requireHex(dleq.s, 'proof dleq s', 512),
    r: dleq.r === null ? null : requireHex(dleq.r, 'proof dleq r', 512),
  }
}

function serializeWitness(value: ProofLike['witness']): string | null {
  if (value === undefined) return null
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  return requireText(serialized, 'proof witness', 16_384)
}

function rehydrateSwapPreview(preview: DurableWalletSwapPreview): SwapPreview {
  return {
    amount: Amount.from(preview.amount),
    fees: Amount.from(preview.fees),
    keysetId: preview.keysetId,
    inputs: preview.inputs.map(rehydrateProof),
    sendOutputs: preview.sendOutputs.map(rehydrateOutput),
    keepOutputs: preview.keepOutputs.map(rehydrateOutput),
    unselectedProofs: preview.unselectedProofs.map(rehydrateProof),
  }
}

function rehydrateProof(proof: DurableWalletProof): Proof {
  return {
    id: proof.id,
    amount: Amount.from(proof.amount),
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === null
      ? {}
      : {
          dleq: {
            e: proof.dleq.e,
            s: proof.dleq.s,
            ...(proof.dleq.r === null ? {} : { r: proof.dleq.r }),
          },
        }),
    ...(proof.p2pkE === null ? {} : { p2pk_e: proof.p2pkE }),
    ...(proof.witness === null ? {} : { witness: proof.witness }),
  }
}

function rehydrateBlindedMessage(message: DurableWalletBlindedMessage) {
  return { ...message, amount: Amount.from(message.amount) }
}

function rehydrateOutput(output: DurableWalletOutputData): OutputData {
  return OutputData.deserialize({
    blindedMessage: { ...output.blindedMessage },
    blindingFactor: output.blindingFactor,
    secret: output.secret,
    ...(output.ephemeralE === null ? {} : { ephemeralE: output.ephemeralE }),
  })
}

function toCustodyProof(proof: DurableWalletProof) {
  return {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    ...(proof.dleq === null ? {} : { dleq: proof.dleq }),
    ...(proof.p2pkE === null ? {} : { p2pk_e: proof.p2pkE }),
    ...(proof.witness === null ? {} : { witness: proof.witness }),
  }
}

function decodeExtraPayload(
  value: unknown,
): Readonly<Record<string, DurableWalletJsonValue>> {
  const payload = requireRecord(value, 'melt extra payload')
  for (const reserved of ['quote', 'inputs', 'outputs', 'prefer_async']) {
    if (reserved in payload)
      throw new Error('melt extra payload overrides core request authority')
  }
  const decoded = decodeJsonObject(payload, 0)
  if (
    new TextEncoder().encode(JSON.stringify(decoded)).byteLength >
    64 * 1_024
  ) {
    throw new Error('melt extra payload exceeds the byte limit')
  }
  return decoded
}

function decodeJsonObject(
  value: Record<string, unknown>,
  depth: number,
): Record<string, DurableWalletJsonValue> {
  if (depth > 16 || Object.keys(value).length > 256) {
    throw new Error('melt extra payload is invalid')
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      requireText(key, 'melt extra payload key', 512),
      decodeJsonValue(item, depth + 1),
    ]),
  )
}

function decodeJsonValue(
  value: unknown,
  depth: number,
): DurableWalletJsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new Error('melt extra payload number is invalid')
    return value
  }
  if (Array.isArray(value)) {
    if (depth > 16 || value.length > 256)
      throw new Error('melt extra payload is invalid')
    return value.map((item) => decodeJsonValue(item, depth + 1))
  }
  return decodeJsonObject(
    requireRecord(value, 'melt extra payload value'),
    depth,
  )
}

function assertOutputKeyset(
  outputs: DurableWalletOutputData[],
  keysetId: string,
): void {
  if (outputs.some((output) => output.blindedMessage.id !== keysetId)) {
    throw new Error('wallet output keyset does not match preview authority')
  }
}

function assertDistinctProofs(proofs: DurableWalletProof[]): void {
  const identities = new Set(
    proofs.map((proof) => `${proof.id}\0${proof.secret}`),
  )
  if (identities.size !== proofs.length)
    throw new Error('wallet proof inputs are duplicated')
}

function assertDistinctOutputs(outputs: DurableWalletOutputData[]): void {
  const secrets = new Set(outputs.map((output) => output.secret))
  if (secrets.size !== outputs.length)
    throw new Error('wallet output secrets are reused')
}

function canonicalAmount(
  value: AmountLike,
  allowZero: boolean,
  name: string,
): string {
  return requireCanonicalAmount(Amount.from(value).toString(), allowZero, name)
}

function requireCanonicalAmount(
  value: unknown,
  allowZero: boolean,
  name: string,
): string {
  const amount = requireCanonicalDecimal(value, allowZero, name)
  const numeric = BigInt(amount)
  if (numeric > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${name} is invalid`)
  return amount
}

function requireCanonicalDecimal(
  value: unknown,
  allowZero: boolean,
  name: string,
): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]*)$/.test(value) ||
    (!allowZero && value === '0')
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireNormalizedMint(value: unknown): string {
  const mint = requireText(value, 'wallet operation mint', 2_048)
  let parsed: URL
  try {
    parsed = new URL(mint)
  } catch {
    throw new Error('wallet operation mint is invalid')
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('wallet operation mint is invalid')
  }
  const normalized = parsed.href.replace(/\/+$/, '')
  if (normalized !== mint)
    throw new Error('wallet operation mint is not canonical')
  return mint
}

function requirePoint(
  value: unknown,
  name: string,
  lengths: readonly number[],
): string {
  const point = requireHex(value, name, Math.max(...lengths))
  if (!lengths.includes(point.length)) throw new Error(`${name} is invalid`)
  return point
}

function requireHex(value: unknown, name: string, maxLength: number): string {
  const text = requireText(value, name, maxLength)
  if (text.length % 2 !== 0 || !/^[a-f0-9]+$/.test(text)) {
    throw new Error(`${name} is invalid`)
  }
  return text
}

function requireFingerprint(value: unknown, name: string): string {
  const fingerprint = requireText(value, name, 64)
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error(`${name} is invalid`)
  return fingerprint
}

function requireIdentifier(
  value: unknown,
  name: string,
  maxLength = 512,
): string {
  return requireText(value, name, maxLength)
}

function requireText(value: unknown, name: string, maxLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`)
  return value
}

function requireUnixSeconds(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${name} is invalid`)
  }
  return value as number
}

function requireOptionalUnixSeconds(
  value: unknown,
  name: string,
): number | null {
  return value === null ? null : requireUnixSeconds(value, name)
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error(`${name} must be a bounded array`)
  }
  return value
}

function requireFields(
  record: Record<string, unknown>,
  expected: readonly string[],
): void {
  for (const key of Object.keys(record)) {
    if (!expected.includes(key)) throw new Error(`unknown field '${key}'`)
  }
  for (const key of expected) {
    if (!(key in record)) throw new Error(`missing required field '${key}'`)
  }
}
