// Exact persisted wallet-operation contract re-authored from 7e1385c with
// wallet-scope and fail-closed authority corrections from f1cb65b/b683120.
import {
  Amount,
  CheckStateEnum,
  hashToCurve,
  hashToCurveBls,
  isBlsKeyset,
  type OutputDataLike,
  type OutputData,
  type MintPreview,
  type Proof,
  type ProofState,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
  DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  deriveDurableCustodyArtifactFingerprint,
  decodeCanonicalMintOrigin,
  encodeBoundedDurableArtifact,
} from './durableCustody.ts'
import {
  deserializeDurableCustodyOutput,
  serializeDurableCustodyOutput,
  type DurableCustodyProofOperationInput,
} from './durableCustodyProofOperation.ts'
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
} from './durableWalletProofTransition.ts'

export const DURABLE_WALLET_OPERATION_SCHEMA_VERSION = 1 as const
export const DURABLE_WALLET_OPERATION_ARRAY_LENGTH_MAX = DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX
export const DURABLE_WALLET_OPERATION_METADATA_KEY = 'durableWalletOperation'
const DURABLE_WALLET_RECEIVE_PROOF_LIMIT_MAX = 128

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
  witness: DurableWalletProofWitness | null
}
type DurableWalletProofWitness =
  | string
  | { signatures?: string[] }
  | { preimage: string; signatures?: string[] }
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
  derivationRange: {
    keysetId: string
    counterStart: number
    counterCount: number
  } | null
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

export interface DurableWalletReceiveOperationSnapshot {
  readonly operation: DurableWalletReceiveOperation
  readonly state: 'prepared' | 'completed' | 'external-applied'
  /** A terminal result was verified against the persisted operation and mint keys. */
  readonly result: { readonly receive: readonly Proof[] } | null
}

export interface DurableWalletReceiveOperationStore {
  loadOperation(operationId: string): Promise<DurableWalletReceiveOperationSnapshot | null>
  /** Verify and persist this exact result before this function returns. */
  persistCompletedResult(input: {
    readonly operation: DurableWalletReceiveOperation
    readonly result: { readonly receive: readonly Proof[] }
  }): Promise<'completed' | 'external-applied'>
}

export interface DurableWalletMintOperationSnapshot {
  readonly operation: DurableWalletMintOperation
  readonly state: 'prepared' | 'completed' | 'external-applied'
  /** A terminal result was verified against the persisted operation and mint keys. */
  readonly result: { readonly receive: readonly Proof[] } | null
}

export interface DurableWalletMintOperationStore {
  loadOperation(operationId: string): Promise<DurableWalletMintOperationSnapshot | null>
  /** Admit the verified proofs before recording this exact operation as terminal. */
  persistCompletedResult(input: {
    readonly operation: DurableWalletMintOperation
    readonly result: { readonly receive: readonly Proof[] }
  }): Promise<'completed' | 'external-applied'>
}

interface DurableWalletReceiveExecutionInput {
  readonly mode: 'execute' | 'recover'
  readonly operationId: string
  readonly store: DurableWalletReceiveOperationStore
  readonly wallet: {
    checkProofsStates(proofs: Array<Pick<Proof, 'id' | 'secret'>>): Promise<readonly ProofState[]>
    completeSwap(preview: SwapPreview): Promise<{ readonly keep: Proof[]; readonly send: Proof[] }>
  }
  /** Restore and verify only the supplied output plan. */
  readonly restoreExactOutputs: (input: {
    readonly mintUrl: string
    readonly outputs: readonly DurableWalletOutputData[]
  }) => Promise<Readonly<Record<string, readonly Proof[]>>>
  readonly currentPreview?: SwapPreview
}

interface DurableWalletMintExecutionInput {
  readonly mode: 'execute' | 'recover'
  readonly operationId: string
  readonly store: DurableWalletMintOperationStore
  readonly wallet: {
    completeMint(preview: MintPreview<{ quote: string; expiry?: number | null }>): Promise<Proof[]>
  }
  /** Restore and verify only the persisted blinded-output plan. */
  readonly restoreExactOutputs: (input: {
    readonly mintUrl: string
    readonly unit: string
    readonly outputs: readonly DurableWalletOutputData[]
  }) => Promise<readonly Proof[]>
  readonly currentPreview?: MintPreview<
    Pick<{ quote: string; expiry?: number | null }, 'quote' | 'expiry'>
  >
}

type DurableWalletReceiveExecutionResult =
  | { readonly state: 'completed' | 'external-applied'; readonly proofs: Proof[] }
  | { readonly state: 'nonterminal'; readonly proofs: readonly [] }

export type DurableWalletMintExecutionResult =
  | { readonly state: 'completed' | 'external-applied'; readonly proofs: Proof[] }
  | { readonly state: 'nonterminal'; readonly proofs: readonly [] }

export function decodeDurableWalletOperation(value: unknown): DurableWalletOperation {
  if (!isRecord(value)) throw new Error('durable wallet operation is invalid')
  const operation =
    value.kind === 'wallet-receive' && !Object.hasOwn(value, 'derivationRange')
      ? { ...value, derivationRange: null }
      : value
  exactKeys(operation, [
    'schemaVersion',
    'operationId',
    'kind',
    'mintUrl',
    'unit',
    'preview',
    ...(operation.kind === 'wallet-receive' ? ['derivationRange'] : []),
  ])
  if (operation.schemaVersion !== DURABLE_WALLET_OPERATION_SCHEMA_VERSION) {
    throw new Error('durable wallet operation schema is unsupported')
  }
  requireText(operation.operationId, 'operation id')
  try {
    decodeCanonicalMintOrigin(operation.mintUrl)
  } catch {
    throw new Error('durable wallet mint URL is not normalized')
  }
  requireText(operation.unit, 'unit')
  if (!isRecord(operation.preview)) {
    throw new Error('durable wallet operation preview is invalid')
  }
  switch (operation.kind) {
    case 'wallet-send':
      decodeSwapPreview(operation.preview)
      break
    case 'wallet-receive':
      decodeSwapPreview(operation.preview, DURABLE_WALLET_RECEIVE_PROOF_LIMIT_MAX)
      requireReceivePreview(operation.preview)
      decodeReceiveDerivationRange(operation.derivationRange, operation.preview)
      break
    case 'wallet-mint':
      decodeMintPreview(operation.preview)
      break
    case 'wallet-melt':
      decodeMeltPreview(operation.preview)
      break
    default:
      throw new Error('durable wallet operation kind is invalid')
  }
  return structuredClone(operation) as unknown as DurableWalletOperation
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

/** Validate the browser journal fields that bind a mint to its persisted SDK authority. */
export function requireDurableWalletMintJournal(input: {
  readonly operationId: string
  readonly kind: string
  readonly mintUrl: string
  readonly unit: unknown
  readonly outputs: DurableCustodyProofOperationInput['outputs']
  readonly metadata: Readonly<Record<string, unknown>>
}): DurableWalletMintOperation {
  const operation = requireMintOperation(
    decodeDurableWalletOperation(input.metadata[DURABLE_WALLET_OPERATION_METADATA_KEY]),
  )
  if (
    input.kind !== operation.kind ||
    input.operationId !== operation.operationId ||
    input.mintUrl !== operation.mintUrl ||
    input.unit !== operation.unit
  ) {
    throw new Error('durable wallet mint journal identity is foreign')
  }
  const expected = toDurableCustodyProofOperationInput(operation)
  if (
    deriveDurableCustodyArtifactFingerprint(input.outputs) !==
    deriveDurableCustodyArtifactFingerprint(expected.outputs)
  ) {
    throw new Error('durable wallet mint journal outputs conflict with persisted authority')
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
    outputPlanFingerprint: deriveDurableCustodyArtifactFingerprint(custody.outputs),
  }
}

export function serializeDurableWalletReceiveOperation(input: {
  readonly operationId: string
  readonly mintUrl: string
  readonly unit: string
  readonly preview: SwapPreview
  readonly derivationRange?: {
    readonly keysetId: string
    readonly counterStart: number
    readonly counterCount: number
  } | null
}): DurableWalletReceiveOperation {
  return requireReceiveOperation(
    decodeDurableWalletOperation({
      schemaVersion: DURABLE_WALLET_OPERATION_SCHEMA_VERSION,
      operationId: input.operationId,
      kind: 'wallet-receive',
      mintUrl: input.mintUrl,
      unit: input.unit,
      preview: serializeReceivePreview(input.preview),
      derivationRange: input.derivationRange ?? null,
    }),
  )
}

export function serializeDurableWalletMintOperation(input: {
  readonly operationId: string
  readonly mintUrl: string
  readonly unit: string
  readonly preview: MintPreview<Pick<{ quote: string; expiry?: number | null }, 'quote' | 'expiry'>>
}): DurableWalletMintOperation {
  const expiry = input.preview.quote.expiry
  const operation = decodeDurableWalletOperation({
    schemaVersion: DURABLE_WALLET_OPERATION_SCHEMA_VERSION,
    operationId: input.operationId,
    kind: 'wallet-mint',
    mintUrl: input.mintUrl,
    unit: input.unit,
    preview: {
      method: input.preview.method,
      quoteExpiryUnixSeconds: expiry === undefined ? null : expiry,
      payload: {
        quote: input.preview.payload.quote,
        outputs: input.preview.outputData.map((output) => ({
          amount: Amount.from(output.blindedMessage.amount).toString(),
          id: output.blindedMessage.id,
          B_: output.blindedMessage.B_,
        })),
        signature: input.preview.payload.signature ?? null,
      },
      outputData: input.preview.outputData.map(serializeOutput),
      keysetId: input.preview.keysetId,
    },
  })
  if (operation.kind !== 'wallet-mint') throw new Error('durable wallet operation is not a mint')
  return operation
}

/** Rebuild the exact cashu-ts mint preview from persisted SDK authority. */
export function hydrateDurableWalletMintPreview(
  input: DurableWalletMintOperation,
): MintPreview<{ quote: string; expiry?: number | null }> {
  const operation = decodeDurableWalletOperation(input)
  if (operation.kind !== 'wallet-mint') throw new Error('durable wallet operation is not a mint')
  const outputData = operation.preview.outputData.map(hydrateOutput)
  return {
    method: operation.preview.method,
    payload: {
      quote: operation.preview.payload.quote,
      outputs: outputData.map((output) => output.blindedMessage),
      ...(operation.preview.payload.signature === null
        ? {}
        : { signature: operation.preview.payload.signature }),
    },
    outputData,
    keysetId: operation.preview.keysetId,
    quote: {
      quote: operation.preview.payload.quote,
      ...(operation.preview.quoteExpiryUnixSeconds === null
        ? {}
        : { expiry: operation.preview.quoteExpiryUnixSeconds }),
    },
  }
}

/** Execute or recover a persisted mint without selecting fresh outputs. */
export async function runDurableWalletMintOperation(
  input: DurableWalletMintExecutionInput,
): Promise<DurableWalletMintExecutionResult> {
  if (input.mode !== 'execute' && input.mode !== 'recover') {
    throw new Error('durable wallet mint mode is invalid')
  }
  const snapshot = await loadExactMintSnapshot(input)
  const terminal = terminalMintResult(snapshot)
  if (terminal !== null) return terminal
  try {
    const proofs = await input.wallet.completeMint(
      hydrateDurableWalletMintPreview(snapshot.operation),
    )
    return persistExactMintResult(input.store, snapshot.operation, proofs)
  } catch (error) {
    if (input.mode !== 'recover' || !isDurableWalletMintDuplicateOutputsError(error)) throw error
    const proofs = await input.restoreExactOutputs({
      mintUrl: snapshot.operation.mintUrl,
      unit: snapshot.operation.unit,
      outputs: snapshot.operation.preview.outputData.map((output) => structuredClone(output)),
    })
    return persistExactMintResult(input.store, snapshot.operation, proofs)
  }
}

/** Match only the CDK response which proves our exact output plan is already signed. */
export function isDurableWalletMintDuplicateOutputsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { message?: unknown; name?: unknown; status?: unknown; code?: unknown }
  const message = typeof candidate.message === 'string' ? candidate.message : ''
  if (
    !message.includes('Invoice already paid or pending') &&
    !message.includes('Blinded message already signed or pending')
  ) {
    return false
  }
  return (
    candidate.name === 'MintOperationError' ||
    candidate.status === 400 ||
    typeof candidate.code === 'number'
  )
}

function loadExactMintSnapshot(
  input: DurableWalletMintExecutionInput,
): Promise<DurableWalletMintOperationSnapshot> {
  return input.store.loadOperation(input.operationId).then((snapshot) => {
    if (snapshot === null) throw new Error('durable wallet mint operation is absent')
    const operation = requireMintOperation(decodeDurableWalletOperation(snapshot.operation))
    if (operation.operationId !== input.operationId) {
      throw new Error('durable wallet mint operation identity is foreign')
    }
    assertCurrentMintAuthority(operation, input.currentPreview)
    return validateMintSnapshot({ ...snapshot, operation })
  })
}

function assertCurrentMintAuthority(
  persisted: DurableWalletMintOperation,
  currentPreview: DurableWalletMintExecutionInput['currentPreview'],
): void {
  if (
    currentPreview !== undefined &&
    deriveDurableCustodyArtifactFingerprint(
      serializeDurableWalletMintOperation({
        operationId: persisted.operationId,
        mintUrl: persisted.mintUrl,
        unit: persisted.unit,
        preview: currentPreview,
      }).preview,
    ) !== deriveDurableCustodyArtifactFingerprint(persisted.preview)
  ) {
    throw new Error('current wallet mint request conflicts with persisted authority')
  }
}

function validateMintSnapshot(
  snapshot: DurableWalletMintOperationSnapshot,
): DurableWalletMintOperationSnapshot {
  switch (snapshot.state) {
    case 'prepared':
      if (snapshot.result !== null) throw new Error('prepared wallet mint has a result')
      break
    case 'completed':
    case 'external-applied':
      if (snapshot.result === null) throw new Error('terminal wallet mint result is absent')
      break
    default:
      throw new Error('durable wallet mint state is invalid')
  }
  return snapshot
}

function terminalMintResult(
  snapshot: DurableWalletMintOperationSnapshot,
): DurableWalletMintExecutionResult | null {
  if (snapshot.state === 'prepared') return null
  return {
    state: snapshot.state,
    proofs: requireExactMintResult(snapshot.operation, snapshot.result!.receive),
  }
}

async function persistExactMintResult(
  store: DurableWalletMintOperationStore,
  operation: DurableWalletMintOperation,
  result: readonly Proof[],
): Promise<DurableWalletMintExecutionResult> {
  const receive = requireExactMintResult(operation, result)
  const state = await store.persistCompletedResult({ operation, result: { receive } })
  if (state !== 'completed' && state !== 'external-applied') {
    throw new Error('persisted wallet mint result was not completed')
  }
  return { state, proofs: receive }
}

function requireExactMintResult(
  operation: DurableWalletMintOperation,
  result: readonly Proof[],
): Proof[] {
  if (
    result.length === 0 ||
    result.length > DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX ||
    result.length !== operation.preview.outputData.length
  ) {
    throw new Error('durable wallet mint result does not match its exact output plan')
  }
  const bySecret = new Map(result.map((proof) => [proof.secret, serializeProof(proof)]))
  if (bySecret.size !== result.length) {
    throw new Error('durable wallet mint result contains duplicate proofs')
  }
  return operation.preview.outputData.map((output) =>
    requirePlannedReceiveProof(output, bySecret.get(output.secret)),
  )
}

function serializeReceivePreview(preview: SwapPreview): DurableWalletSwapPreview {
  requireReceivePreviewCounts(preview.inputs, preview.sendOutputs, preview.keepOutputs)
  if ((preview.unselectedProofs?.length ?? 0) !== 0) {
    throw new Error('durable wallet receive cannot contain unselected proofs')
  }
  return {
    amount: Amount.from(preview.amount).toString(),
    fees: Amount.from(preview.fees).toString(),
    keysetId: preview.keysetId,
    inputs: preview.inputs.map(serializeProof),
    sendOutputs: [],
    keepOutputs: (preview.keepOutputs ?? []).map(serializeOutput),
    unselectedProofs: [],
  }
}

function hydrateDurableWalletReceivePreview(input: DurableWalletReceiveOperation): SwapPreview {
  const operation = requireReceiveOperation(decodeDurableWalletOperation(input))
  return {
    amount: Amount.from(operation.preview.amount),
    fees: Amount.from(operation.preview.fees),
    keysetId: operation.preview.keysetId,
    inputs: operation.preview.inputs.map(hydrateProof),
    sendOutputs: [],
    keepOutputs: operation.preview.keepOutputs.map(hydrateOutput),
    unselectedProofs: [],
  }
}

export async function runDurableWalletReceiveOperation(
  input: DurableWalletReceiveExecutionInput,
): Promise<DurableWalletReceiveExecutionResult> {
  if (input.mode !== 'execute' && input.mode !== 'recover') {
    throw new Error('durable wallet receive mode is invalid')
  }
  const snapshot = await loadExactReceiveSnapshot(input)
  const terminal = terminalReceiveResult(snapshot)
  if (terminal !== null) return terminal
  if (input.mode === 'execute') return submitPersistedReceive(input, snapshot.operation)
  const states = await input.wallet.checkProofsStates(
    snapshot.operation.preview.inputs.map(({ id, secret }) => ({ id, secret })),
  )
  switch (classifyExactReceiveInputStates(snapshot.operation, states)) {
    case 'spent':
      return restorePersistedReceive(input, snapshot.operation)
    case 'unspent':
      return submitPersistedReceive(input, snapshot.operation)
    case 'nonterminal':
      return { state: 'nonterminal', proofs: [] }
  }
}

function classifyExactReceiveInputStates(
  operation: DurableWalletReceiveOperation,
  states: readonly ProofState[],
): 'spent' | 'unspent' | 'nonterminal' {
  const receive = requireReceiveOperation(decodeDurableWalletOperation(operation))
  const expectedYs = receive.preview.inputs.map(proofY)
  if (states.length !== expectedYs.length) {
    throw new Error('durable wallet receive proof-state response is incomplete')
  }
  const observed = new Map(states.map((state) => [state.Y, state.state]))
  if (observed.size !== states.length || expectedYs.some((Y) => !observed.has(Y))) {
    throw new Error('durable wallet receive proof-state authority is foreign')
  }
  const exactStates = expectedYs.map((Y) => observed.get(Y))
  if (exactStates.every((state) => state === CheckStateEnum.SPENT)) return 'spent'
  if (exactStates.every((state) => state === CheckStateEnum.UNSPENT)) return 'unspent'
  return 'nonterminal'
}

async function loadExactReceiveSnapshot(
  input: DurableWalletReceiveExecutionInput,
): Promise<DurableWalletReceiveOperationSnapshot> {
  const snapshot = await input.store.loadOperation(input.operationId)
  if (snapshot === null) throw new Error('durable wallet receive operation is absent')
  const operation = requireReceiveOperation(decodeDurableWalletOperation(snapshot.operation))
  if (operation.operationId !== input.operationId) {
    throw new Error('durable wallet receive operation identity is foreign')
  }
  assertCurrentReceiveAuthority(operation, input.currentPreview)
  return validateReceiveSnapshot({ ...snapshot, operation })
}

function assertCurrentReceiveAuthority(
  persisted: DurableWalletReceiveOperation,
  currentPreview: SwapPreview | undefined,
): void {
  if (
    currentPreview !== undefined &&
    deriveDurableCustodyArtifactFingerprint(serializeReceivePreview(currentPreview)) !==
      deriveDurableCustodyArtifactFingerprint(persisted.preview)
  ) {
    throw new Error('current wallet receive request conflicts with persisted authority')
  }
}

function validateReceiveSnapshot(
  snapshot: DurableWalletReceiveOperationSnapshot,
): DurableWalletReceiveOperationSnapshot {
  switch (snapshot.state) {
    case 'prepared':
      if (snapshot.result !== null) throw new Error('prepared wallet receive has a result')
      break
    case 'completed':
    case 'external-applied':
      if (snapshot.result === null) throw new Error('terminal wallet receive result is absent')
      break
    default:
      throw new Error('durable wallet receive state is invalid')
  }
  return snapshot
}

function terminalReceiveResult(
  snapshot: DurableWalletReceiveOperationSnapshot,
): DurableWalletReceiveExecutionResult | null {
  if (snapshot.state === 'prepared') return null
  return {
    state: snapshot.state,
    proofs: requireExactReceiveResult(snapshot.operation, snapshot.result!),
  }
}

async function submitPersistedReceive(
  input: DurableWalletReceiveExecutionInput,
  operation: DurableWalletReceiveOperation,
): Promise<DurableWalletReceiveExecutionResult> {
  const result = await input.wallet.completeSwap(hydrateDurableWalletReceivePreview(operation))
  if (result.send.length !== 0) {
    throw new Error('durable wallet receive mint result contains a foreign send group')
  }
  return persistExactReceiveResult(input.store, operation, { receive: result.keep })
}

async function restorePersistedReceive(
  input: DurableWalletReceiveExecutionInput,
  operation: DurableWalletReceiveOperation,
): Promise<DurableWalletReceiveExecutionResult> {
  const restored = await input.restoreExactOutputs({
    mintUrl: operation.mintUrl,
    outputs: operation.preview.keepOutputs.map((output) => structuredClone(output)),
  })
  return persistExactReceiveResult(input.store, operation, restored)
}

async function persistExactReceiveResult(
  store: DurableWalletReceiveOperationStore,
  operation: DurableWalletReceiveOperation,
  result: Readonly<Record<string, readonly Proof[]>>,
): Promise<DurableWalletReceiveExecutionResult> {
  const receive = requireExactReceiveResult(operation, result)
  const state = await store.persistCompletedResult({ operation, result: { receive } })
  if (state !== 'completed' && state !== 'external-applied') {
    throw new Error('persisted wallet receive result was not completed')
  }
  return { state, proofs: receive }
}

function requireExactReceiveResult(
  operation: DurableWalletReceiveOperation,
  result: Readonly<Record<string, readonly Proof[]>>,
): Proof[] {
  if (Object.keys(result).length !== 1 || !Array.isArray(result.receive)) {
    throw new Error('durable wallet receive result group is invalid')
  }
  if (result.receive.length > DURABLE_WALLET_RECEIVE_PROOF_LIMIT_MAX) {
    throw new Error('durable wallet receive result proof limit exceeded')
  }
  if (result.receive.length !== operation.preview.keepOutputs.length) {
    throw new Error('durable wallet receive result does not match its exact output plan')
  }
  const bySecret = new Map(result.receive.map((proof) => [proof.secret, serializeProof(proof)]))
  if (bySecret.size !== result.receive.length) {
    throw new Error('durable wallet receive result contains duplicate proofs')
  }
  return operation.preview.keepOutputs.map((output) =>
    requirePlannedReceiveProof(output, bySecret.get(output.secret)),
  )
}

function requirePlannedReceiveProof(
  output: DurableWalletOutputData,
  proof: DurableWalletProof | undefined,
): Proof {
  if (
    proof === undefined ||
    proof.id !== output.blindedMessage.id ||
    proof.amount !== output.blindedMessage.amount
  ) {
    throw new Error('durable wallet receive result does not match its exact output plan')
  }
  return hydrateProof(proof)
}

function decodeSwapPreview(
  value: Record<string, unknown>,
  maximumProofs = DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
): void {
  const receiveBounded = maximumProofs === DURABLE_WALLET_RECEIVE_PROOF_LIMIT_MAX
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
  decodeArray(value.inputs, decodeProof, 'inputs', maximumProofs)
  decodeArray(
    value.sendOutputs,
    decodeOutput,
    'send outputs',
    receiveBounded ? maximumProofs : DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  )
  decodeArray(
    value.keepOutputs,
    decodeOutput,
    'keep outputs',
    receiveBounded ? maximumProofs : DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  )
  decodeArray(
    value.unselectedProofs,
    decodeProof,
    'unselected proofs',
    receiveBounded ? maximumProofs : DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
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

function requireReceivePreview(value: Record<string, unknown>): void {
  const keepOutputs = value.keepOutputs as Record<string, unknown>[]
  if (
    (value.sendOutputs as unknown[]).length !== 0 ||
    (value.unselectedProofs as unknown[]).length !== 0 ||
    keepOutputs.length === 0
  ) {
    throw new Error('durable wallet receive preview has foreign output groups')
  }
  if (
    keepOutputs.some(
      (output) =>
        typeof output.blindingFactor !== 'string' ||
        !/^(0|[1-9][0-9]*)$/.test(output.blindingFactor),
    )
  ) {
    throw new Error('durable wallet receive blinding factor is invalid')
  }
}

function decodeReceiveDerivationRange(value: unknown, preview: Record<string, unknown>): void {
  if (value === null) return
  if (!isRecord(value)) throw new Error('durable wallet receive derivation range is invalid')
  exactKeys(value, ['keysetId', 'counterStart', 'counterCount'])
  requireText(value.keysetId, 'receive derivation keyset id')
  if (
    value.keysetId !== preview.keysetId ||
    !Number.isSafeInteger(value.counterStart) ||
    (value.counterStart as number) < 0 ||
    !Number.isSafeInteger(value.counterCount) ||
    (value.counterCount as number) <= 0 ||
    value.counterCount !== (preview.keepOutputs as unknown[]).length
  ) {
    throw new Error('durable wallet receive derivation range does not match its output plan')
  }
}

function decodeMintPreview(value: Record<string, unknown>): void {
  exactKeys(value, ['method', 'quoteExpiryUnixSeconds', 'payload', 'outputData', 'keysetId'])
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
  assertOutputKeyset(value.outputData as Record<string, unknown>[], value.keysetId)
  assertDistinctOutputs(value.outputData as Record<string, unknown>[])
  const payloadOutputs = value.payload.outputs as Record<string, unknown>[]
  const outputData = value.outputData as Array<{ blindedMessage: Record<string, unknown> }>
  if (
    payloadOutputs.length !== outputData.length ||
    payloadOutputs.some(
      (output, index) =>
        JSON.stringify(output) !== JSON.stringify(outputData[index]?.blindedMessage),
    )
  ) {
    throw new Error('durable wallet mint payload conflicts with output authority')
  }
}

function decodeMeltPreview(value: Record<string, unknown>): void {
  exactKeys(value, ['method', 'inputs', 'outputData', 'keysetId', 'quote', 'requestOptions'])
  requireText(value.method, 'melt method')
  requireText(value.keysetId, 'keyset id')
  decodeArray(value.inputs, decodeProof, 'melt inputs', DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX)
  decodeArray(
    value.outputData,
    decodeOutput,
    'melt output data',
    DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  )
  if ((value.inputs as unknown[]).length === 0) {
    throw new Error('durable wallet melt inputs are empty')
  }
  assertOutputKeyset(value.outputData as Record<string, unknown>[], value.keysetId)
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
  if (value.witness !== null) decodeProofWitness(value.witness)
}

function decodeProofWitness(value: unknown): asserts value is DurableWalletProofWitness {
  if (typeof value === 'string') {
    requireText(value, 'proof witness')
    return
  }
  if (!isRecord(value)) throw new Error('durable wallet proof witness is invalid')
  const allowed = new Set(['preimage', 'signatures'])
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error('durable wallet proof witness contains foreign fields')
  }
  if ('preimage' in value) requireText(value.preimage, 'proof witness preimage')
  if ('signatures' in value) {
    decodeArray(
      value.signatures,
      (signature) => requireText(signature, 'proof witness signature'),
      'proof witness signatures',
      DURABLE_WALLET_RECEIVE_PROOF_LIMIT_MAX,
    )
  }
  encodeBoundedDurableArtifact(value, DURABLE_CUSTODY_ARTIFACT_BYTES_MAX)
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

function serializeProof(proof: Proof): DurableWalletProof {
  const serialized: DurableWalletProof = {
    id: proof.id,
    amount: Amount.from(proof.amount).toString(),
    secret: proof.secret,
    C: proof.C,
    dleq:
      proof.dleq === undefined
        ? null
        : { e: proof.dleq.e, s: proof.dleq.s, r: proof.dleq.r ?? null },
    p2pkE: proof.p2pk_e ?? null,
    witness:
      proof.witness === undefined
        ? null
        : (structuredClone(proof.witness) as DurableWalletProofWitness),
  }
  decodeProof(serialized)
  return serialized
}

function hydrateProof(proof: DurableWalletProof): Proof {
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
    ...(proof.witness === null
      ? {}
      : { witness: structuredClone(proof.witness) as Proof['witness'] }),
  }
}

function serializeOutput(output: OutputDataLike): DurableWalletOutputData {
  const serialized = serializeDurableCustodyOutput(output)
  const durable: DurableWalletOutputData = {
    blindedMessage: {
      amount: Amount.from(output.blindedMessage.amount).toString(),
      id: serialized.blindedMessage.id,
      B_: serialized.blindedMessage.B_,
    },
    blindingFactor: serialized.blindingFactor,
    secret: serialized.secret,
    ephemeralE: serialized.ephemeralE ?? null,
  }
  decodeOutput(durable)
  return durable
}

function hydrateOutput(output: DurableWalletOutputData): OutputData {
  return deserializeDurableCustodyOutput({
    blindedMessage: { ...output.blindedMessage },
    blindingFactor: output.blindingFactor,
    secret: output.secret,
    ...(output.ephemeralE === null ? {} : { ephemeralE: output.ephemeralE }),
  })
}

function requireReceivePreviewCounts(
  inputs: readonly Proof[],
  sendOutputs: readonly OutputDataLike[] | undefined,
  keepOutputs: readonly OutputDataLike[] | undefined,
): void {
  if (
    inputs.length === 0 ||
    inputs.length > DURABLE_WALLET_RECEIVE_PROOF_LIMIT_MAX ||
    (sendOutputs?.length ?? 0) !== 0 ||
    (keepOutputs?.length ?? 0) === 0 ||
    (keepOutputs?.length ?? 0) > DURABLE_WALLET_RECEIVE_PROOF_LIMIT_MAX
  ) {
    throw new Error('durable wallet receive preview exceeds its 128-proof limit')
  }
}

function requireReceiveOperation(operation: DurableWalletOperation): DurableWalletReceiveOperation {
  if (operation.kind !== 'wallet-receive') {
    throw new Error('durable wallet operation is not a receive')
  }
  return operation
}

function requireMintOperation(operation: DurableWalletOperation): DurableWalletMintOperation {
  if (operation.kind !== 'wallet-mint') {
    throw new Error('durable wallet operation is not a mint')
  }
  return operation
}

function proofY(proof: DurableWalletProof): string {
  const secret = new TextEncoder().encode(proof.secret)
  return isBlsKeyset(proof.id)
    ? hashToCurveBls(secret).toHex(true)
    : hashToCurve(secret).toHex(true)
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
  if (!Array.isArray(value) || value.length > maximumLength) {
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

function assertOutputKeyset(outputs: readonly Record<string, unknown>[], expected: unknown): void {
  if (
    outputs.some(
      (output) => !isRecord(output.blindedMessage) || output.blindedMessage.id !== expected,
    )
  ) {
    throw new Error('durable wallet output keyset is invalid')
  }
}

function assertDistinctOutputs(outputs: readonly Record<string, unknown>[]): void {
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
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}
