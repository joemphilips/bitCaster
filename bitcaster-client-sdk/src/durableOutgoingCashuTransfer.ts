import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { getEncodedTokenV4, type Proof } from '@cashu/cashu-ts'
import {
  decodeCanonicalMintOrigin,
  deriveDurableCustodyArtifactFingerprint,
  DURABLE_CUSTODY_RECORD_BYTES_MAX,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
} from './durableCustody.ts'
import {
  decodeDurableWalletOperation,
  decodeDurableWalletProof,
  deriveDurableWalletOperationAuthority,
  deriveDurableWalletProofY,
  hydrateDurableWalletProof,
  serializeDurableWalletProof,
  type DurableWalletOperationAuthority,
  type DurableWalletProof,
  type DurableWalletReceiveExecutionInput,
  type DurableWalletReceiveOperation,
  type DurableWalletSendExecutionInput,
  type DurableWalletSendOperation,
  type DurableWalletSendOperationStore,
  runDurableWalletReceiveOperation,
  runDurableWalletSendOperation,
  verifyDurableWalletReceiveResult,
  verifyDurableWalletSendResult,
} from './durableWalletOperation.ts'
import {
  decodeDurableWalletProofDerivationLocator,
  type DurableWalletProofDerivationLocator,
} from './durableWalletProofDerivationLocator.ts'

export const DURABLE_OUTGOING_CASHU_TRANSFER_SCHEMA_VERSION = 1 as const
export const DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX = 128
export const DURABLE_OUTGOING_CASHU_TOKEN_PROOF_LIMIT_MAX = 512
export const DURABLE_OUTGOING_CASHU_CUSTODY_REVISION_LIMIT_MAX =
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX + DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX
export const DURABLE_OUTGOING_CASHU_PROOF_STATE_CALL_LIMIT_MAX = 32
export const DURABLE_OUTGOING_CASHU_PROOF_STATE_PROOFS_PER_CALL_MAX = 128
export const DURABLE_OUTGOING_CASHU_RETRY_BACKOFF_INITIAL_MS = 5_000
export const DURABLE_OUTGOING_CASHU_RETRY_BACKOFF_MAX_MS = 60 * 60 * 1_000
export const DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX = 4 * 1_024 * 1_024
/**
 * This is the maximum local reservation for one outgoing transfer.
 * It includes the exact prepared transfer, the token, and three bounded copies of
 * the token proof/result representation. Each output also has bounded index state.
 */
export const DURABLE_OUTGOING_CASHU_STORAGE_RESERVATION_BYTES_MAX = 20 * 1_024 * 1_024

export type DurableOutgoingCashuDeliveryIntent =
  | {
      readonly policy: 'durable-recipient-ack'
      readonly expectedSubject: string
      /** A strict opaque canonical product binding. Checkpoint 2 defines its public tuple. */
      readonly opaqueProductBinding: string
      readonly tokenBytesLimit: number
      readonly tokenProofLimit: number
    }
  | {
      readonly policy: 'bearer-spend-classification'
      readonly tokenBytesLimit: number
      readonly tokenProofLimit: number
    }

export type DurableOutgoingCashuDeliveryState =
  | 'prepared'
  | 'delivery-pending'
  | 'recipient-acknowledged'
  | 'bearer-spent'
  | 'bearer-partial'
  | 'reclaim-prepared'
  | 'reclaimed'

export interface DurableOutgoingCashuTokenAuthority {
  readonly encodedToken: string
  readonly sha256: string
  readonly encodedLength: number
  readonly proofs: readonly DurableWalletProof[]
  /** The exact subset that mint proof-state classification permits a sender to reclaim. */
  readonly unspentProofs: readonly DurableWalletProof[] | null
  readonly custodyRevisions: readonly {
    readonly proofIdentity: string
    readonly revision: number
  }[]
}

export interface DurableOutgoingCashuReclaimAuthority {
  readonly reclaimId: string
  readonly proofFingerprint: string
  readonly proofs: readonly DurableWalletProof[]
  /** This exact receive plan is the only mint operation allowed to reclaim these proofs. */
  readonly walletReceiveOperation: DurableWalletReceiveOperation
  readonly walletReceiveOperationAuthority: DurableWalletOperationAuthority
  readonly completionEvidence: DurableOutgoingCashuReclaimCompletionEvidence | null
}

/**
 * The implementation must atomically admit the verified successor proofs, record this
 * evidence, and transition the transfer to `reclaimed` in one local durable transaction.
 */
export interface DurableOutgoingCashuReclaimCompletionEvidence {
  readonly transferId: string
  readonly reclaimId: string
  readonly walletReceiveOperationAuthority: DurableWalletOperationAuthority
  readonly successorProofFingerprint: string
  readonly custodyRevisions: readonly {
    readonly proofIdentity: string
    readonly revision: number
  }[]
}

export interface DurableOutgoingCashuReclaimExecutionInput {
  readonly transfer: DurableOutgoingCashuTransfer
  /** The durable receive store must persist exact successors before it returns terminal state. */
  readonly walletReceive: Omit<DurableWalletReceiveExecutionInput, 'mode'>
  /** Return atomic custody evidence after admission and transfer completion have committed. */
  admitAndComplete(input: {
    readonly transfer: DurableOutgoingCashuTransfer
    readonly reclaim: DurableOutgoingCashuReclaimAuthority
    readonly successorProofs: readonly Proof[]
  }): Promise<DurableOutgoingCashuReclaimCompletionEvidence>
}

/** A local-only record. `encodedToken` is bearer authority and must never leave its durable store. */
export interface DurableOutgoingCashuTransfer {
  readonly schemaVersion: 1
  readonly transferId: string
  readonly walletScopeId: string
  readonly mintUrl: string
  readonly unit: string
  readonly requestedAmount: string
  readonly walletSendOperation: DurableWalletSendOperation
  readonly walletSendOperationAuthority: DurableWalletOperationAuthority
  /** One exact locator per seed-derived keep output. Null means not seed-derived. */
  readonly keepProofDerivationLocators: readonly (DurableWalletProofDerivationLocator | null)[]
  readonly deliveryIntent: DurableOutgoingCashuDeliveryIntent
  readonly deliveryState: DurableOutgoingCashuDeliveryState
  readonly token: DurableOutgoingCashuTokenAuthority | null
  readonly recipientReceipt: DurableOutgoingCashuRecipientAcknowledgement | null
  readonly reclaim: DurableOutgoingCashuReclaimAuthority | null
  readonly recovery: { readonly dueAtMs: number; readonly attemptCount: number }
  readonly revision: number
}

/**
 * Calculate a conservative local storage reservation before mint I/O.
 * The browser uses this value for physical IndexedDB admission.
 */
export function durableOutgoingCashuStorageReservationBytes(
  value: DurableOutgoingCashuTransfer,
): number {
  const transfer = decodeDurableOutgoingCashuTransfer(value)
  const outputCount =
    transfer.walletSendOperation.preview.keepOutputs.length +
    transfer.walletSendOperation.preview.sendOutputs.length
  const transferBytes = new TextEncoder().encode(JSON.stringify(transfer)).byteLength
  const bytes =
    transferBytes +
    transfer.deliveryIntent.tokenBytesLimit * 4 +
    outputCount * 512 +
    2 * DURABLE_CUSTODY_RECORD_BYTES_MAX
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > DURABLE_OUTGOING_CASHU_STORAGE_RESERVATION_BYTES_MAX
  ) {
    throw new Error('durable outgoing Cashu storage reservation exceeds its admitted envelope')
  }
  return bytes
}

/** Physical transaction before mint I/O. It selects and locks exactly one operation and admits storage. */
export interface DurableOutgoingCashuPreMintAdapter {
  prepare(input: {
    readonly transferId: string
    readonly walletScopeId: string
    readonly mintUrl: string
    readonly unit: string
    readonly requestedAmount: string
    readonly deliveryIntent: DurableOutgoingCashuDeliveryIntent
    readonly maximumEncodedTokenBytes: number
    readonly maximumTokenProofs: number
  }): Promise<DurableOutgoingCashuTransfer>
  /** Load one existing pre-mint transfer. This method must not select new proofs. */
  recover?(input: {
    readonly transferId: string
    readonly walletScopeId: string
  }): Promise<DurableOutgoingCashuTransfer>
}

/** Physical transaction after mint I/O. It verifies and admits exact proof and token authority atomically. */
export interface DurableOutgoingCashuPostMintAdapter {
  persistMinted(input: {
    readonly transfer: DurableOutgoingCashuTransfer
    readonly keepProofs: readonly unknown[]
    readonly sendProofs: readonly unknown[]
    readonly encodedToken: string
  }): Promise<DurableOutgoingCashuTransfer>
}

export interface DurableOutgoingCashuCoordinatorInput {
  readonly mode?: 'execute' | 'recover'
  readonly preMint: DurableOutgoingCashuPreMintAdapter
  readonly postMint: DurableOutgoingCashuPostMintAdapter
  readonly transfer: {
    readonly transferId: string
    readonly walletScopeId: string
    readonly mintUrl: string
    readonly unit: string
    readonly requestedAmount: string
    readonly deliveryIntent: DurableOutgoingCashuDeliveryIntent
  }
  readonly wallet: DurableWalletSendExecutionInput['wallet']
  readonly restoreExactOutputs: DurableWalletSendExecutionInput['restoreExactOutputs']
  /** Required for restart recovery. It supplies the persisted exact send operation and result. */
  readonly walletOperationStore?: DurableWalletSendOperationStore
}

export interface DurableOutgoingCashuRecoveryCursor {
  readonly dueAtMs: number
  readonly transferId: string
}

export interface DurableOutgoingCashuDuePage {
  /** The store enforces this byte bound before it materializes the records. */
  readonly storedBytes: number
  readonly transfers: readonly DurableOutgoingCashuTransfer[]
  readonly nextCursor: DurableOutgoingCashuRecoveryCursor | null
}

/** Stores must page by `(dueAtMs, transferId)` and must not calculate a global pending count. */
export interface DurableOutgoingCashuRecoveryStore {
  listDue(input: {
    readonly mintUrl: string
    readonly dueBeforeMs: number
    readonly cursor: DurableOutgoingCashuRecoveryCursor | null
    readonly limit: number
    readonly maximumBytes: number
  }): Promise<DurableOutgoingCashuDuePage>
  persist(input: DurableOutgoingCashuTransfer): Promise<DurableOutgoingCashuTransfer>
}

export interface DurableOutgoingCashuProofStateChunk {
  readonly mintUrl: string
  readonly transfers: readonly DurableOutgoingCashuTransfer[]
  readonly proofs: readonly DurableWalletProof[]
  /** Binds each contiguous proof range back to its complete token proof vector. */
  readonly proofAssociations: readonly {
    readonly transferId: string
    readonly proofOffset: number
    readonly proofCount: number
  }[]
}

export type DurableOutgoingCashuBearerClassification =
  | { readonly kind: 'spent' }
  | { readonly kind: 'unspent'; readonly reclaimable: true }
  | { readonly kind: 'partial'; readonly unspentProofs: readonly DurableWalletProof[] }
  | { readonly kind: 'uncertain'; readonly reclaimable: false }

export interface DurableOutgoingCashuProofState {
  readonly Y: string
  readonly state: 'UNSPENT' | 'PENDING' | 'SPENT'
}

export interface DurableOutgoingCashuRecipientAcknowledgement {
  readonly transferId: string
  readonly expectedSubject: string
  readonly opaqueProductBinding: string
  readonly mintUrl: string
  readonly unit: string
  readonly requestedAmount: string
  readonly tokenSha256: string
  readonly tokenLength: number
  readonly durableReceiveAuthority: DurableWalletOperationAuthority
  readonly durableResultFingerprint: string
}

/** The recipient status provider verifies and persists the receipt in the local transfer store. */
export interface DurableOutgoingCashuRecipientReceiptAdapter {
  readAndPersistReceipt(input: {
    readonly transfer: DurableOutgoingCashuTransfer
  }): Promise<DurableOutgoingCashuTransfer>
}

export function createDurableOutgoingCashuTransfer(input: {
  readonly transferId: string
  readonly walletScopeId: string
  readonly requestedAmount: string
  readonly walletSendOperation: DurableWalletSendOperation
  readonly keepProofDerivationLocators?: readonly (DurableWalletProofDerivationLocator | null)[]
  readonly deliveryIntent: DurableOutgoingCashuDeliveryIntent
  readonly dueAtMs?: number
}): DurableOutgoingCashuTransfer {
  const operation = requireWalletSendOperation(input.walletSendOperation)
  const amount = sumSendAmount(operation)
  if (amount !== input.requestedAmount) {
    throw new Error('durable outgoing Cashu transfer requested amount conflicts with send plan')
  }
  const intent = decodeDeliveryIntent(input.deliveryIntent)
  return decodeDurableOutgoingCashuTransfer({
    schemaVersion: DURABLE_OUTGOING_CASHU_TRANSFER_SCHEMA_VERSION,
    transferId: input.transferId,
    walletScopeId: input.walletScopeId,
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    requestedAmount: input.requestedAmount,
    walletSendOperation: operation,
    walletSendOperationAuthority: deriveDurableWalletOperationAuthority(operation),
    keepProofDerivationLocators: decodeKeepProofDerivationLocators(
      input.keepProofDerivationLocators ?? [],
      operation,
    ),
    deliveryIntent: intent,
    deliveryState: 'prepared',
    token: null,
    recipientReceipt: null,
    reclaim: null,
    recovery: { dueAtMs: input.dueAtMs ?? 0, attemptCount: 0 },
    revision: 0,
  })
}

/** Execute one complete outgoing transfer boundary. Adapters cannot assemble this boundary manually. */
export async function runDurableOutgoingCashuTransfer(
  input: DurableOutgoingCashuCoordinatorInput,
): Promise<DurableOutgoingCashuTransfer> {
  const mode = input.mode ?? 'execute'
  if (mode !== 'execute' && mode !== 'recover') {
    throw new Error('durable outgoing Cashu coordinator mode is invalid')
  }
  if (mode === 'recover' && input.walletOperationStore === undefined) {
    throw new Error('durable outgoing Cashu recovery requires the persisted wallet operation store')
  }
  const prepared = decodeDurableOutgoingCashuTransfer(
    mode === 'execute'
      ? await input.preMint.prepare({
          ...input.transfer,
          maximumEncodedTokenBytes: input.transfer.deliveryIntent.tokenBytesLimit,
          maximumTokenProofs: input.transfer.deliveryIntent.tokenProofLimit,
        })
      : await requirePreMintRecovery(input.preMint, input.transfer),
  )
  if (mode === 'recover' && prepared.deliveryState === 'delivery-pending') {
    assertTransferMatchesRequest(prepared, input.transfer)
    return prepared
  }
  assertPreparedTransferMatchesRequest(prepared, input.transfer)
  if (
    prepared.walletSendOperation.preview.sendOutputs.length >
    prepared.deliveryIntent.tokenProofLimit
  ) {
    throw new Error('durable outgoing Cashu send plan exceeds its admitted proof limit')
  }
  let admitted: DurableOutgoingCashuTransfer | null = null
  const result = await runDurableWalletSendOperation({
    mode,
    operationId: prepared.walletSendOperation.operationId,
    wallet: input.wallet,
    restoreExactOutputs: input.restoreExactOutputs,
    store: {
      async loadOperation(operationId) {
        if (mode === 'recover') return input.walletOperationStore!.loadOperation(operationId)
        return { operation: prepared.walletSendOperation, state: 'prepared', result: null }
      },
      async persistCompletedResult(value) {
        admitted = await persistExactOutgoingMintResult({
          adapter: input.postMint,
          transfer: prepared,
          result: value.result,
        })
        return 'completed'
      },
    },
  })
  if (result.state !== 'completed' && result.state !== 'external-applied') {
    throw new Error('durable outgoing Cashu wallet send did not complete')
  }
  if (admitted === null) {
    throw new Error(
      'durable outgoing Cashu terminal wallet result lacks atomic post-mint admission',
    )
  }
  return admitted
}

async function persistExactOutgoingMintResult(input: {
  readonly adapter: DurableOutgoingCashuPostMintAdapter
  readonly transfer: DurableOutgoingCashuTransfer
  readonly result: { readonly keep: readonly Proof[]; readonly send: readonly Proof[] }
}): Promise<DurableOutgoingCashuTransfer> {
  const encodedToken = encodeExactDurableOutgoingCashuToken(input.transfer, input.result.send)
  const keepProofs = input.result.keep.map(serializeDurableWalletProof)
  const sendProofs = input.result.send.map(serializeDurableWalletProof)
  const persisted = decodeDurableOutgoingCashuTransfer(
    await input.adapter.persistMinted({
      transfer: input.transfer,
      keepProofs,
      sendProofs,
      encodedToken,
    }),
  )
  if (persisted.token === null)
    throw new Error('durable outgoing Cashu post-mint admission is absent')
  const exact = admitDurableOutgoingCashuToken({
    transfer: input.transfer,
    keepProofs,
    sendProofs,
    encodedToken,
    custodyRevisions: persisted.token.custodyRevisions,
    dueAtMs: input.transfer.recovery.dueAtMs,
  })
  if (
    deriveDurableCustodyArtifactFingerprint(persisted) !==
    deriveDurableCustodyArtifactFingerprint(exact)
  ) {
    throw new Error('durable outgoing Cashu post-mint admission conflicts')
  }
  return exact
}

async function requirePreMintRecovery(
  adapter: DurableOutgoingCashuPreMintAdapter,
  transfer: DurableOutgoingCashuCoordinatorInput['transfer'],
): Promise<DurableOutgoingCashuTransfer> {
  if (adapter.recover === undefined) {
    throw new Error('durable outgoing Cashu pre-mint recovery is unavailable')
  }
  return adapter.recover({ transferId: transfer.transferId, walletScopeId: transfer.walletScopeId })
}

export function encodeExactDurableOutgoingCashuToken(
  transfer: DurableOutgoingCashuTransfer,
  sendProofs: readonly Proof[],
): string {
  const exact = decodeDurableOutgoingCashuTransfer(transfer)
  if (sendProofs.length !== exact.walletSendOperation.preview.sendOutputs.length) {
    throw new Error('durable outgoing Cashu token encoding requires the exact verified mint result')
  }
  const bySecret = new Map(sendProofs.map((proof) => [proof.secret, proof]))
  if (
    bySecret.size !== sendProofs.length ||
    exact.walletSendOperation.preview.sendOutputs.some((output) => {
      const proof = bySecret.get(output.secret)
      return (
        proof?.id !== output.blindedMessage.id ||
        proof.amount.toString() !== output.blindedMessage.amount
      )
    })
  ) {
    throw new Error('durable outgoing Cashu token encoding requires the exact verified mint result')
  }
  try {
    return getEncodedTokenV4({ mint: exact.mintUrl, unit: exact.unit, proofs: [...sendProofs] })
  } catch {
    throw new Error('durable outgoing Cashu token encoding is invalid')
  }
}

function assertPreparedTransferMatchesRequest(
  transfer: DurableOutgoingCashuTransfer,
  request: DurableOutgoingCashuCoordinatorInput['transfer'],
): void {
  if (
    transfer.transferId !== request.transferId ||
    transfer.walletScopeId !== request.walletScopeId ||
    transfer.mintUrl !== request.mintUrl ||
    transfer.unit !== request.unit ||
    transfer.requestedAmount !== request.requestedAmount ||
    deriveDurableCustodyArtifactFingerprint(transfer.deliveryIntent) !==
      deriveDurableCustodyArtifactFingerprint(request.deliveryIntent) ||
    transfer.deliveryState !== 'prepared' ||
    transfer.token !== null ||
    transfer.reclaim !== null
  ) {
    throw new Error('durable outgoing Cashu pre-mint authority conflicts')
  }
}

function assertTransferMatchesRequest(
  transfer: DurableOutgoingCashuTransfer,
  request: DurableOutgoingCashuCoordinatorInput['transfer'],
): void {
  if (
    transfer.transferId !== request.transferId ||
    transfer.walletScopeId !== request.walletScopeId ||
    transfer.mintUrl !== request.mintUrl ||
    transfer.unit !== request.unit ||
    transfer.requestedAmount !== request.requestedAmount ||
    deriveDurableCustodyArtifactFingerprint(transfer.deliveryIntent) !==
      deriveDurableCustodyArtifactFingerprint(request.deliveryIntent)
  ) {
    throw new Error('durable outgoing Cashu pre-mint authority conflicts')
  }
}

export function decodeDurableOutgoingCashuTransfer(value: unknown): DurableOutgoingCashuTransfer {
  if (!isRecord(value)) throw new Error('durable outgoing Cashu transfer is invalid')
  exactKeys(value, [
    'schemaVersion',
    'transferId',
    'walletScopeId',
    'mintUrl',
    'unit',
    'requestedAmount',
    'walletSendOperation',
    'walletSendOperationAuthority',
    'keepProofDerivationLocators',
    'deliveryIntent',
    'deliveryState',
    'token',
    'recipientReceipt',
    'reclaim',
    'recovery',
    'revision',
  ])
  if (value.schemaVersion !== DURABLE_OUTGOING_CASHU_TRANSFER_SCHEMA_VERSION) {
    throw new Error('durable outgoing Cashu transfer schema is unsupported')
  }
  requireText(value.transferId, 'transfer id')
  requireText(value.walletScopeId, 'wallet scope id')
  const mintUrl = requireCanonicalMint(value.mintUrl)
  requireText(value.unit, 'unit')
  requirePositiveAmount(value.requestedAmount)
  const operation = requireWalletSendOperation(value.walletSendOperation)
  if (
    operation.mintUrl !== mintUrl ||
    operation.unit !== value.unit ||
    sumSendAmount(operation) !== value.requestedAmount
  ) {
    throw new Error('durable outgoing Cashu transfer wallet send authority is foreign')
  }
  const authority = decodeWalletAuthority(value.walletSendOperationAuthority)
  if (!sameAuthority(authority, deriveDurableWalletOperationAuthority(operation))) {
    throw new Error('durable outgoing Cashu transfer wallet send authority conflicts')
  }
  const keepProofDerivationLocators = decodeKeepProofDerivationLocators(
    value.keepProofDerivationLocators,
    operation,
  )
  const deliveryIntent = decodeDeliveryIntent(value.deliveryIntent)
  const token = decodeToken(value.token, {
    mintUrl,
    unit: value.unit,
    deliveryIntent,
    walletSendOperation: operation,
  })
  const recipientReceipt = decodeRecipientReceipt(value.recipientReceipt)
  const reclaim = decodeReclaim(value.reclaim, token, mintUrl, value.unit)
  requireDeliveryState(value.deliveryState)
  decodeRecovery(value.recovery)
  requireRevision(value.revision)
  assertTransferState(value.deliveryState, deliveryIntent, token, recipientReceipt, reclaim)
  if (recipientReceipt !== null) {
    assertRecipientReceiptMatchesTransfer({
      receipt: recipientReceipt,
      transferId: value.transferId,
      mintUrl,
      unit: value.unit,
      requestedAmount: value.requestedAmount,
      deliveryIntent,
      token,
    })
  }
  return structuredClone({
    schemaVersion: DURABLE_OUTGOING_CASHU_TRANSFER_SCHEMA_VERSION,
    transferId: value.transferId,
    walletScopeId: value.walletScopeId,
    mintUrl,
    unit: value.unit,
    requestedAmount: value.requestedAmount,
    walletSendOperation: operation,
    walletSendOperationAuthority: authority,
    keepProofDerivationLocators,
    deliveryIntent,
    deliveryState: value.deliveryState,
    token,
    recipientReceipt,
    reclaim,
    recovery: value.recovery,
    revision: value.revision,
  })
}

/** Admit an exact post-mint token only once. This reducer does not log the token. */
export function admitDurableOutgoingCashuToken(input: {
  readonly transfer: DurableOutgoingCashuTransfer
  readonly keepProofs: readonly unknown[]
  readonly sendProofs: readonly unknown[]
  readonly encodedToken: string
  readonly custodyRevisions: readonly {
    readonly proofIdentity: string
    readonly revision: number
  }[]
  readonly dueAtMs: number
}): DurableOutgoingCashuTransfer {
  const transfer = decodeDurableOutgoingCashuTransfer(input.transfer)
  if (transfer.deliveryState !== 'prepared' || transfer.token !== null) {
    throw new Error('durable outgoing Cashu transfer token transition is invalid')
  }
  const mintResult = verifyDurableWalletSendResult(transfer.walletSendOperation, {
    keep: requireProofs(input.keepProofs),
    send: requireProofs(input.sendProofs),
  })
  const sendProofs = mintResult.send.map(serializeDurableWalletProof)
  requireExactCustodyRevisions(
    transfer.walletSendOperation.preview.inputs,
    mintResult.keep.map(serializeDurableWalletProof),
    sendProofs,
    input.custodyRevisions,
  )
  const token = createTokenAuthority(
    transfer,
    input.encodedToken,
    sendProofs,
    input.custodyRevisions,
  )
  return decodeDurableOutgoingCashuTransfer({
    ...transfer,
    deliveryState: 'delivery-pending',
    token,
    recovery: {
      dueAtMs: requireTimestamp(input.dueAtMs),
      attemptCount: transfer.recovery.attemptCount,
    },
    revision: transfer.revision + 1,
  })
}

export function classifyDurableOutgoingBearerProofStates(input: {
  readonly transfer: DurableOutgoingCashuTransfer
  readonly states: readonly DurableOutgoingCashuProofState[]
  readonly dueAtMs: number
}): {
  readonly transfer: DurableOutgoingCashuTransfer
  readonly classification: DurableOutgoingCashuBearerClassification
} {
  const transfer = decodeDurableOutgoingCashuTransfer(input.transfer)
  if (transfer.deliveryIntent.policy !== 'bearer-spend-classification' || transfer.token === null) {
    throw new Error('durable outgoing Cashu bearer classification is invalid')
  }
  if (transfer.deliveryState === 'bearer-spent') {
    const classification = classifyBearerStates(transfer.token.proofs, input.states)
    if (classification.kind === 'spent') return { transfer, classification }
    throw new Error('durable outgoing Cashu bearer classification conflicts')
  }
  if (
    transfer.deliveryState !== 'delivery-pending' &&
    transfer.deliveryState !== 'bearer-partial'
  ) {
    throw new Error('durable outgoing Cashu bearer classification transition is invalid')
  }
  const classification = classifyBearerStates(transfer.token.proofs, input.states)
  const preservePartial =
    transfer.deliveryState === 'bearer-partial' &&
    (classification.kind === 'uncertain' || classification.kind === 'unspent')
  const narrowedPartial =
    transfer.deliveryState === 'bearer-partial' && classification.kind === 'partial'
      ? (transfer.token.unspentProofs ?? []).filter((proof) =>
          classification.unspentProofs.some(
            (candidate) => proofIdentity(candidate) === proofIdentity(proof),
          ),
        )
      : null
  const token = {
    ...transfer.token,
    unspentProofs:
      classification.kind === 'spent'
        ? null
        : preservePartial
          ? structuredClone(transfer.token.unspentProofs)
          : narrowedPartial !== null
            ? structuredClone(narrowedPartial.length === 0 ? null : narrowedPartial)
            : classification.kind === 'uncertain'
              ? null
              : classification.kind === 'unspent'
                ? structuredClone(transfer.token.proofs)
                : classification.unspentProofs,
  }
  const deliveryState =
    classification.kind === 'spent'
      ? 'bearer-spent'
      : narrowedPartial !== null && narrowedPartial.length === 0
        ? 'bearer-spent'
        : classification.kind === 'partial' || preservePartial
          ? 'bearer-partial'
          : 'delivery-pending'
  const accumulatedClassification: DurableOutgoingCashuBearerClassification =
    deliveryState === 'bearer-spent'
      ? { kind: 'spent' }
      : deliveryState === 'bearer-partial'
        ? { kind: 'partial', unspentProofs: structuredClone(token.unspentProofs ?? []) }
        : classification
  if (
    deliveryState === transfer.deliveryState &&
    deriveDurableCustodyArtifactFingerprint(token) ===
      deriveDurableCustodyArtifactFingerprint(transfer.token) &&
    input.dueAtMs === transfer.recovery.dueAtMs
  ) {
    return { transfer, classification: accumulatedClassification }
  }
  return {
    transfer: decodeDurableOutgoingCashuTransfer({
      ...transfer,
      deliveryState,
      token,
      recovery: {
        dueAtMs: requireTimestamp(input.dueAtMs),
        attemptCount: transfer.recovery.attemptCount + 1,
      },
      revision: transfer.revision + 1,
    }),
    classification: accumulatedClassification,
  }
}

/** Persist byte-exact reclaim authority after a fresh complete proof-state classification. */
export function prepareDurableOutgoingCashuReclaim(input: {
  readonly transfer: DurableOutgoingCashuTransfer
  readonly reclaimId: string
  readonly states: readonly DurableOutgoingCashuProofState[]
  readonly dueAtMs: number
  readonly walletReceiveOperation: DurableWalletReceiveOperation
}): DurableOutgoingCashuTransfer {
  const transfer = classifyDurableOutgoingBearerProofStates({
    transfer: input.transfer,
    states: input.states,
    dueAtMs: input.dueAtMs,
  }).transfer
  if (
    transfer.deliveryIntent.policy !== 'bearer-spend-classification' ||
    transfer.token === null ||
    (transfer.deliveryState !== 'delivery-pending' &&
      transfer.deliveryState !== 'bearer-partial') ||
    transfer.token.unspentProofs === null ||
    transfer.token.unspentProofs.length === 0
  ) {
    throw new Error('durable outgoing Cashu reclaim is not authorized')
  }
  requireText(input.reclaimId, 'reclaim id')
  const operation = requireExactReclaimOperation({
    operation: input.walletReceiveOperation,
    reclaimId: input.reclaimId,
    mintUrl: transfer.mintUrl,
    unit: transfer.unit,
    proofs: transfer.token.unspentProofs,
  })
  const reclaim = {
    reclaimId: input.reclaimId,
    proofFingerprint: deriveDurableCustodyArtifactFingerprint(transfer.token.unspentProofs),
    proofs: structuredClone(transfer.token.unspentProofs),
    walletReceiveOperation: operation,
    walletReceiveOperationAuthority: deriveDurableWalletOperationAuthority(operation),
    completionEvidence: null,
  }
  return decodeDurableOutgoingCashuTransfer({
    ...transfer,
    deliveryState: 'reclaim-prepared',
    reclaim,
    revision: transfer.revision + 1,
  })
}

/** Complete reclaim only with exact successor proofs and atomic durable-custody evidence. */
export function completeDurableOutgoingCashuReclaim(input: {
  readonly transfer: DurableOutgoingCashuTransfer
  readonly successorProofs: readonly Proof[]
  readonly evidence: DurableOutgoingCashuReclaimCompletionEvidence
}): DurableOutgoingCashuTransfer {
  const transfer = decodeDurableOutgoingCashuTransfer(input.transfer)
  if (transfer.reclaim === null) {
    throw new Error('durable outgoing Cashu reclaim completion is invalid')
  }
  const successorProofs = verifyDurableWalletReceiveResult(
    transfer.reclaim.walletReceiveOperation,
    { receive: [...input.successorProofs] },
  )
  const evidence = input.evidence
  if (
    evidence.transferId !== transfer.transferId ||
    evidence.reclaimId !== transfer.reclaim.reclaimId ||
    !sameAuthority(
      evidence.walletReceiveOperationAuthority,
      transfer.reclaim.walletReceiveOperationAuthority,
    ) ||
    evidence.successorProofFingerprint !==
      deriveDurableCustodyArtifactFingerprint(successorProofs.map(serializeDurableWalletProof))
  ) {
    throw new Error('durable outgoing Cashu reclaim completion evidence conflicts')
  }
  requireExactCustodyRevisions(
    transfer.reclaim.proofs,
    successorProofs.map(serializeDurableWalletProof),
    [],
    evidence.custodyRevisions,
  )
  if (transfer.deliveryState === 'reclaimed') {
    if (
      transfer.reclaim.completionEvidence === null ||
      deriveDurableCustodyArtifactFingerprint(transfer.reclaim.completionEvidence) !==
        deriveDurableCustodyArtifactFingerprint(evidence)
    ) {
      throw new Error('durable outgoing Cashu reclaim completion conflicts')
    }
    return transfer
  }
  if (
    transfer.deliveryState !== 'reclaim-prepared' ||
    transfer.reclaim.completionEvidence !== null
  ) {
    throw new Error('durable outgoing Cashu reclaim completion is invalid')
  }
  return decodeDurableOutgoingCashuTransfer({
    ...transfer,
    deliveryState: 'reclaimed',
    reclaim: { ...transfer.reclaim, completionEvidence: structuredClone(evidence) },
    revision: transfer.revision + 1,
  })
}

/** Execute or recover only the exact persisted reclaim receive plan. */
export async function runDurableOutgoingCashuReclaim(
  input: DurableOutgoingCashuReclaimExecutionInput,
): Promise<DurableOutgoingCashuTransfer> {
  const transfer = decodeDurableOutgoingCashuTransfer(input.transfer)
  if (transfer.deliveryState === 'reclaimed') return transfer
  if (transfer.deliveryState !== 'reclaim-prepared' || transfer.reclaim === null) {
    throw new Error('durable outgoing Cashu reclaim execution is invalid')
  }
  if (input.walletReceive.operationId !== transfer.reclaim.walletReceiveOperation.operationId) {
    throw new Error('durable outgoing Cashu reclaim operation conflicts')
  }
  const result = await runDurableWalletReceiveOperation({ ...input.walletReceive, mode: 'recover' })
  if (result.state === 'nonterminal') return transfer
  const evidence = await input.admitAndComplete({
    transfer,
    reclaim: transfer.reclaim,
    successorProofs: result.proofs,
  })
  return completeDurableOutgoingCashuReclaim({
    transfer,
    successorProofs: result.proofs,
    evidence,
  })
}

export async function acknowledgeDurableOutgoingCashuRecipient(input: {
  readonly transfer: DurableOutgoingCashuTransfer
  readonly receiptAdapter: DurableOutgoingCashuRecipientReceiptAdapter
}): Promise<DurableOutgoingCashuTransfer> {
  const transfer = decodeDurableOutgoingCashuTransfer(input.transfer)
  if (transfer.deliveryIntent.policy !== 'durable-recipient-ack' || transfer.token === null) {
    throw new Error('durable outgoing Cashu recipient acknowledgement is invalid')
  }
  if (transfer.deliveryState === 'recipient-acknowledged') return transfer
  if (transfer.deliveryState !== 'delivery-pending') {
    throw new Error('durable outgoing Cashu recipient acknowledgement is invalid')
  }
  const persisted = decodeDurableOutgoingCashuTransfer(
    await input.receiptAdapter.readAndPersistReceipt({ transfer }),
  )
  assertTransferMatchesRequest(persisted, transfer)
  if (persisted.deliveryState !== 'recipient-acknowledged' || persisted.recipientReceipt === null) {
    throw new Error('durable outgoing Cashu recipient receipt was not persisted')
  }
  const evidence = persisted.recipientReceipt
  if (
    evidence.transferId !== transfer.transferId ||
    evidence.expectedSubject !== transfer.deliveryIntent.expectedSubject ||
    evidence.opaqueProductBinding !== transfer.deliveryIntent.opaqueProductBinding ||
    evidence.mintUrl !== transfer.mintUrl ||
    evidence.unit !== transfer.unit ||
    evidence.requestedAmount !== transfer.requestedAmount ||
    evidence.tokenSha256 !== transfer.token.sha256 ||
    evidence.tokenLength !== transfer.token.encodedLength ||
    !isSha256(evidence.durableResultFingerprint)
  ) {
    throw new Error('durable outgoing Cashu recipient acknowledgement conflicts')
  }
  return persisted
}

/** Validate a bounded page and group it by mint without starvation from an old failing transfer. */
export function planDurableOutgoingCashuRecoveryPage(input: {
  readonly page: DurableOutgoingCashuDuePage
  readonly cursor?: DurableOutgoingCashuRecoveryCursor | null
  readonly limit: number
  readonly maximumBytes: number
}): ReadonlyMap<string, readonly DurableOutgoingCashuTransfer[]> {
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX
  ) {
    throw new Error('durable outgoing Cashu recovery page limit is invalid')
  }
  if (
    !Number.isSafeInteger(input.maximumBytes) ||
    input.maximumBytes < 1 ||
    input.maximumBytes > DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX
  ) {
    throw new Error('durable outgoing Cashu recovery page byte limit is invalid')
  }
  if (input.page.transfers.length > input.limit)
    throw new Error('durable outgoing Cashu recovery page exceeds its limit')
  const transfers = input.page.transfers.map(decodeDurableOutgoingCashuTransfer)
  let previous: DurableOutgoingCashuTransfer | null = null
  if (
    !Number.isSafeInteger(input.page.storedBytes) ||
    input.page.storedBytes < 0 ||
    input.page.storedBytes > input.maximumBytes
  ) {
    throw new Error('durable outgoing Cashu recovery store byte budget is invalid')
  }
  const groups = new Map<string, DurableOutgoingCashuTransfer[]>()
  for (const transfer of transfers) {
    if (
      previous === null &&
      input.cursor !== undefined &&
      input.cursor !== null &&
      compareCursor(
        { dueAtMs: transfer.recovery.dueAtMs, transferId: transfer.transferId },
        input.cursor,
      ) <= 0
    ) {
      throw new Error('durable outgoing Cashu recovery page repeats the requested cursor')
    }
    if (previous !== null && compareDue(previous, transfer) >= 0) {
      throw new Error('durable outgoing Cashu recovery page order is invalid')
    }
    previous = transfer
    const group = groups.get(transfer.mintUrl) ?? []
    group.push(transfer)
    groups.set(transfer.mintUrl, group)
  }
  if (input.page.nextCursor !== null) {
    decodeCursor(input.page.nextCursor)
    const last = transfers.at(-1)
    const floor =
      last === undefined
        ? (input.cursor ?? null)
        : { dueAtMs: last.recovery.dueAtMs, transferId: last.transferId }
    if (floor !== null && compareCursor(input.page.nextCursor, floor) <= 0) {
      throw new Error('durable outgoing Cashu recovery cursor does not advance')
    }
  }
  return new Map([...groups].sort(([left], [right]) => left.localeCompare(right)))
}

/** Group exact pending token proofs deterministically within one bounded NUT-07 pass. */
export function planDurableOutgoingCashuProofStateChunks(input: {
  readonly transfers: readonly DurableOutgoingCashuTransfer[]
  readonly maximumCalls: number
  readonly maximumProofsPerCall: number
}): readonly DurableOutgoingCashuProofStateChunk[] {
  if (
    !Number.isSafeInteger(input.maximumCalls) ||
    input.maximumCalls < 1 ||
    input.maximumCalls > DURABLE_OUTGOING_CASHU_PROOF_STATE_CALL_LIMIT_MAX
  ) {
    throw new Error('durable outgoing Cashu proof-state call limit is invalid')
  }
  if (
    !Number.isSafeInteger(input.maximumProofsPerCall) ||
    input.maximumProofsPerCall < 1 ||
    input.maximumProofsPerCall > DURABLE_OUTGOING_CASHU_PROOF_STATE_PROOFS_PER_CALL_MAX
  ) {
    throw new Error('durable outgoing Cashu proof-state chunk limit is invalid')
  }
  if (
    input.maximumCalls * input.maximumProofsPerCall <
    DURABLE_OUTGOING_CASHU_TOKEN_PROOF_LIMIT_MAX
  ) {
    throw new Error('durable outgoing Cashu proof-state configuration cannot cover one token')
  }
  const ordered = [...input.transfers]
    .map(decodeDurableOutgoingCashuTransfer)
    .sort((left, right) => left.mintUrl.localeCompare(right.mintUrl) || compareDue(left, right))
  const chunks: DurableOutgoingCashuProofStateChunk[] = []
  for (const transfer of ordered) {
    if (
      transfer.token === null ||
      transfer.deliveryIntent.policy !== 'bearer-spend-classification' ||
      (transfer.deliveryState !== 'delivery-pending' && transfer.deliveryState !== 'bearer-partial')
    ) {
      continue
    }
    const prior = chunks.at(-1)
    const reusableProofCapacity =
      prior?.mintUrl === transfer.mintUrl ? input.maximumProofsPerCall - prior.proofs.length : 0
    const remainingProofCapacity =
      reusableProofCapacity + (input.maximumCalls - chunks.length) * input.maximumProofsPerCall
    if (remainingProofCapacity < transfer.token.proofs.length) break
    for (let proofOffset = 0; proofOffset < transfer.token.proofs.length; ) {
      const previous = chunks.at(-1)
      const canAppend = previous !== undefined && previous.mintUrl === transfer.mintUrl
      const available = canAppend ? input.maximumProofsPerCall - previous.proofs.length : 0
      if (available === 0 && chunks.length >= input.maximumCalls) break
      const proofCount = Math.min(
        transfer.token.proofs.length - proofOffset,
        canAppend && available > 0 ? available : input.maximumProofsPerCall,
      )
      const proofs = transfer.token.proofs.slice(proofOffset, proofOffset + proofCount)
      const association = { transferId: transfer.transferId, proofOffset, proofCount }
      if (canAppend && available > 0) {
        chunks[chunks.length - 1] = {
          ...previous,
          transfers: previous.transfers.includes(transfer)
            ? previous.transfers
            : [...previous.transfers, transfer],
          proofs: [...previous.proofs, ...proofs],
          proofAssociations: [...previous.proofAssociations, association],
        }
      } else {
        if (chunks.length >= input.maximumCalls) break
        chunks.push({
          mintUrl: transfer.mintUrl,
          transfers: [transfer],
          proofs,
          proofAssociations: [association],
        })
      }
      proofOffset += proofCount
    }
  }
  return chunks
}

export function scheduleDurableOutgoingCashuRecoveryRetry(input: {
  readonly transfer: DurableOutgoingCashuTransfer
  readonly nowMs: number
}): DurableOutgoingCashuTransfer {
  const transfer = decodeDurableOutgoingCashuTransfer(input.transfer)
  const nowMs = requireTimestamp(input.nowMs)
  const exponent = Math.min(transfer.recovery.attemptCount, 16)
  const delay = Math.min(
    DURABLE_OUTGOING_CASHU_RETRY_BACKOFF_INITIAL_MS * 2 ** exponent,
    DURABLE_OUTGOING_CASHU_RETRY_BACKOFF_MAX_MS,
  )
  return decodeDurableOutgoingCashuTransfer({
    ...transfer,
    recovery: {
      dueAtMs: Math.max(nowMs, transfer.recovery.dueAtMs) + delay,
      attemptCount: transfer.recovery.attemptCount + 1,
    },
    revision: transfer.revision + 1,
  })
}

/** Safe diagnostic metadata. This function deliberately excludes the encoded token and proofs. */
export function redactedTransferMetadata(input: DurableOutgoingCashuTransfer): {
  transferId: string
  mintUrl: string
  unit: string
  deliveryState: DurableOutgoingCashuDeliveryState
  tokenDigest: string | null
  tokenLength: number | null
} {
  const transfer = decodeDurableOutgoingCashuTransfer(input)
  return {
    transferId: transfer.transferId,
    mintUrl: transfer.mintUrl,
    unit: transfer.unit,
    deliveryState: transfer.deliveryState,
    tokenDigest: transfer.token?.sha256 ?? null,
    tokenLength: transfer.token?.encodedLength ?? null,
  }
}

function classifyBearerStates(
  proofs: readonly DurableWalletProof[],
  states: readonly DurableOutgoingCashuProofState[],
): DurableOutgoingCashuBearerClassification {
  const expected = proofs.map(deriveDurableWalletProofY)
  if (states.length !== expected.length) return { kind: 'uncertain', reclaimable: false }
  const observed = new Map<string, DurableOutgoingCashuProofState>()
  for (const state of states) {
    if (
      !isRecord(state) ||
      typeof state.Y !== 'string' ||
      !['UNSPENT', 'PENDING', 'SPENT'].includes(state.state) ||
      observed.has(state.Y)
    ) {
      return { kind: 'uncertain', reclaimable: false }
    }
    observed.set(state.Y, state)
  }
  if (expected.some((Y) => !observed.has(Y))) return { kind: 'uncertain', reclaimable: false }
  const exact = expected.map((Y) => observed.get(Y)!.state)
  if (exact.every((state) => state === 'SPENT')) return { kind: 'spent' }
  if (exact.every((state) => state === 'UNSPENT')) return { kind: 'unspent', reclaimable: true }
  if (exact.some((state) => state === 'PENDING')) return { kind: 'uncertain', reclaimable: false }
  const unspentProofs = proofs.filter((_, index) => exact[index] === 'UNSPENT')
  return unspentProofs.length === 0
    ? { kind: 'uncertain', reclaimable: false }
    : { kind: 'partial', unspentProofs: structuredClone(unspentProofs) }
}

function requireWalletSendOperation(value: unknown): DurableWalletSendOperation {
  const operation = decodeDurableWalletOperation(value)
  if (operation.kind !== 'wallet-send')
    throw new Error('durable outgoing Cashu transfer operation is invalid')
  return operation
}

function requireProofs(value: readonly unknown[]): ReturnType<typeof hydrateDurableWalletProof>[] {
  if (!Array.isArray(value))
    throw new Error('durable outgoing Cashu token proof authority is invalid')
  return value.map((proof) => hydrateDurableWalletProof(decodeDurableWalletProof(proof)))
}

function createTokenAuthority(
  transfer: DurableOutgoingCashuTransfer,
  encodedToken: string,
  proofs: readonly DurableWalletProof[],
  custodyRevisions: readonly { readonly proofIdentity: string; readonly revision: number }[],
): DurableOutgoingCashuTokenAuthority {
  const intent = transfer.deliveryIntent
  requireEncodedToken(encodedToken, intent.tokenBytesLimit)
  const encodedLength = new TextEncoder().encode(encodedToken).byteLength
  if (encodedLength > intent.tokenBytesLimit || proofs.length > intent.tokenProofLimit) {
    throw new Error('durable outgoing Cashu token exceeds its admitted envelope')
  }
  if (
    encodedToken !==
    encodeExactDurableOutgoingCashuToken(transfer, proofs.map(hydrateDurableWalletProof))
  ) {
    throw new Error('durable outgoing Cashu token authority is foreign')
  }
  return {
    encodedToken,
    sha256: bytesToHex(sha256(new TextEncoder().encode(encodedToken))),
    encodedLength,
    proofs: structuredClone(proofs),
    unspentProofs: null,
    custodyRevisions: decodeCustodyRevisions(custodyRevisions),
  }
}

function decodeToken(
  value: unknown,
  transfer: Pick<
    DurableOutgoingCashuTransfer,
    'mintUrl' | 'unit' | 'deliveryIntent' | 'walletSendOperation'
  >,
): DurableOutgoingCashuTokenAuthority | null {
  const intent = transfer.deliveryIntent
  if (value === null) return null
  if (!isRecord(value)) throw new Error('durable outgoing Cashu token authority is invalid')
  exactKeys(value, [
    'encodedToken',
    'sha256',
    'encodedLength',
    'proofs',
    'unspentProofs',
    'custodyRevisions',
  ])
  requireEncodedToken(value.encodedToken, intent.tokenBytesLimit)
  const encodedLength = new TextEncoder().encode(value.encodedToken).byteLength
  if (
    value.encodedLength !== encodedLength ||
    encodedLength > intent.tokenBytesLimit ||
    !isSha256(value.sha256) ||
    value.sha256 !== bytesToHex(sha256(new TextEncoder().encode(value.encodedToken)))
  ) {
    throw new Error('durable outgoing Cashu token authority is invalid')
  }
  if (
    !Array.isArray(value.proofs) ||
    value.proofs.length === 0 ||
    value.proofs.length > intent.tokenProofLimit
  ) {
    throw new Error('durable outgoing Cashu token proof authority is invalid')
  }
  const proofs = value.proofs.map(decodeDurableWalletProof)
  assertDistinctProofs(proofs)
  if (
    value.encodedToken !==
    encodeExactDurableOutgoingCashuToken(
      {
        ...transfer,
        schemaVersion: DURABLE_OUTGOING_CASHU_TRANSFER_SCHEMA_VERSION,
        transferId: 'decode-only',
        walletScopeId: 'decode-only',
        requestedAmount: sumSendAmount(transfer.walletSendOperation),
        walletSendOperationAuthority: deriveDurableWalletOperationAuthority(
          transfer.walletSendOperation,
        ),
        keepProofDerivationLocators: transfer.walletSendOperation.preview.keepOutputs.map(
          () => null,
        ),
        deliveryState: 'prepared',
        token: null,
        recipientReceipt: null,
        reclaim: null,
        recovery: { dueAtMs: 0, attemptCount: 0 },
        revision: 0,
      },
      proofs.map(hydrateDurableWalletProof),
    )
  ) {
    throw new Error('durable outgoing Cashu token authority is foreign')
  }
  let unspentProofs: DurableWalletProof[] | null
  if (value.unspentProofs === null) {
    unspentProofs = null
  } else if (Array.isArray(value.unspentProofs)) {
    unspentProofs = value.unspentProofs.map(decodeDurableWalletProof)
    assertDistinctProofs(unspentProofs)
    const identities = new Set(proofs.map(proofIdentity))
    if (
      unspentProofs.length === 0 ||
      unspentProofs.some((proof) => !identities.has(proofIdentity(proof)))
    ) {
      throw new Error('durable outgoing Cashu reclaim proof authority is invalid')
    }
  } else {
    throw new Error('durable outgoing Cashu reclaim proof authority is invalid')
  }
  return {
    encodedToken: value.encodedToken,
    sha256: value.sha256,
    encodedLength,
    proofs,
    unspentProofs,
    custodyRevisions: decodeCustodyRevisions(value.custodyRevisions),
  }
}

function decodeReclaim(
  value: unknown,
  token: DurableOutgoingCashuTokenAuthority | null,
  mintUrl: string,
  unit: string,
): DurableOutgoingCashuReclaimAuthority | null {
  if (value === null) return null
  if (!isRecord(value) || token === null)
    throw new Error('durable outgoing Cashu reclaim authority is invalid')
  exactKeys(value, [
    'reclaimId',
    'proofFingerprint',
    'proofs',
    'walletReceiveOperation',
    'walletReceiveOperationAuthority',
    'completionEvidence',
  ])
  requireText(value.reclaimId, 'reclaim id')
  if (!Array.isArray(value.proofs) || value.proofs.length === 0)
    throw new Error('durable outgoing Cashu reclaim authority is invalid')
  const proofs = value.proofs.map(decodeDurableWalletProof)
  assertDistinctProofs(proofs)
  if (
    !isSha256(value.proofFingerprint) ||
    value.proofFingerprint !== deriveDurableCustodyArtifactFingerprint(proofs)
  ) {
    throw new Error('durable outgoing Cashu reclaim authority is invalid')
  }
  const unspent = new Set((token.unspentProofs ?? []).map(proofIdentity))
  if (
    proofs.length !== unspent.size ||
    proofs.some((proof) => !unspent.has(proofIdentity(proof)))
  ) {
    throw new Error('durable outgoing Cashu reclaim proof authority is invalid')
  }
  const operation = requireExactReclaimOperation({
    operation: value.walletReceiveOperation,
    reclaimId: value.reclaimId,
    mintUrl,
    unit,
    proofs,
  })
  const authority = decodeWalletAuthority(value.walletReceiveOperationAuthority)
  if (!sameAuthority(authority, deriveDurableWalletOperationAuthority(operation))) {
    throw new Error('durable outgoing Cashu reclaim operation authority conflicts')
  }
  const completionEvidence =
    value.completionEvidence === null
      ? null
      : decodeReclaimCompletionEvidence(value.completionEvidence)
  return {
    reclaimId: value.reclaimId,
    proofFingerprint: value.proofFingerprint,
    proofs,
    walletReceiveOperation: operation,
    walletReceiveOperationAuthority: authority,
    completionEvidence,
  }
}

function decodeReclaimCompletionEvidence(
  value: unknown,
): DurableOutgoingCashuReclaimCompletionEvidence {
  if (!isRecord(value))
    throw new Error('durable outgoing Cashu reclaim completion evidence is invalid')
  exactKeys(value, [
    'transferId',
    'reclaimId',
    'walletReceiveOperationAuthority',
    'successorProofFingerprint',
    'custodyRevisions',
  ])
  requireText(value.transferId, 'transfer id')
  requireText(value.reclaimId, 'reclaim id')
  if (!isSha256(value.successorProofFingerprint)) {
    throw new Error('durable outgoing Cashu reclaim completion evidence is invalid')
  }
  return {
    transferId: value.transferId,
    reclaimId: value.reclaimId,
    walletReceiveOperationAuthority: decodeWalletAuthority(value.walletReceiveOperationAuthority),
    successorProofFingerprint: value.successorProofFingerprint,
    custodyRevisions: decodeCustodyRevisions(value.custodyRevisions),
  }
}

function requireExactReclaimOperation(input: {
  readonly operation: unknown
  readonly reclaimId: string
  readonly mintUrl: string
  readonly unit: string
  readonly proofs: readonly DurableWalletProof[]
}): DurableWalletReceiveOperation {
  const operation = decodeDurableWalletOperation(input.operation)
  if (
    operation.kind !== 'wallet-receive' ||
    operation.operationId !== input.reclaimId ||
    operation.mintUrl !== input.mintUrl ||
    operation.unit !== input.unit ||
    operation.preview.sendOutputs.length !== 0 ||
    operation.preview.unselectedProofs.length !== 0 ||
    operation.preview.keepOutputs.length === 0
  ) {
    throw new Error('durable outgoing Cashu reclaim operation is invalid')
  }
  const expected = input.proofs.map(proofIdentity).sort()
  const actual = operation.preview.inputs.map(proofIdentity).sort()
  if (
    expected.length !== actual.length ||
    expected.some((identity, index) => identity !== actual[index])
  ) {
    throw new Error('durable outgoing Cashu reclaim operation inputs conflict')
  }
  return operation
}

function decodeDeliveryIntent(value: unknown): DurableOutgoingCashuDeliveryIntent {
  if (!isRecord(value)) throw new Error('durable outgoing Cashu delivery intent is invalid')
  if (value.policy === 'durable-recipient-ack') {
    exactKeys(value, [
      'policy',
      'expectedSubject',
      'opaqueProductBinding',
      'tokenBytesLimit',
      'tokenProofLimit',
    ])
    requireText(value.expectedSubject, 'expected subject')
    requireText(value.opaqueProductBinding, 'opaque product binding')
  } else if (value.policy === 'bearer-spend-classification') {
    exactKeys(value, ['policy', 'tokenBytesLimit', 'tokenProofLimit'])
  } else {
    throw new Error('durable outgoing Cashu delivery policy is invalid')
  }
  requireLimit(value.tokenBytesLimit, 1, DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX, 'token byte')
  requireLimit(
    value.tokenProofLimit,
    1,
    DURABLE_OUTGOING_CASHU_TOKEN_PROOF_LIMIT_MAX,
    'token proof',
  )
  return structuredClone(value) as DurableOutgoingCashuDeliveryIntent
}

function decodeRecipientReceipt(
  value: unknown,
): DurableOutgoingCashuRecipientAcknowledgement | null {
  if (value === null) return null
  if (!isRecord(value)) throw new Error('durable outgoing Cashu recipient receipt is invalid')
  exactKeys(value, [
    'transferId',
    'expectedSubject',
    'opaqueProductBinding',
    'mintUrl',
    'unit',
    'requestedAmount',
    'tokenSha256',
    'tokenLength',
    'durableReceiveAuthority',
    'durableResultFingerprint',
  ])
  requireText(value.transferId, 'transfer id')
  requireText(value.expectedSubject, 'expected subject')
  requireText(value.opaqueProductBinding, 'opaque product binding')
  const mintUrl = requireCanonicalMint(value.mintUrl)
  requireText(value.unit, 'unit')
  requirePositiveAmount(value.requestedAmount)
  if (!isSha256(value.tokenSha256) || !isSha256(value.durableResultFingerprint)) {
    throw new Error('durable outgoing Cashu recipient receipt is invalid')
  }
  requireLimit(value.tokenLength, 1, DURABLE_OUTGOING_CASHU_RECOVERY_BYTES_MAX, 'token byte')
  return {
    transferId: value.transferId,
    expectedSubject: value.expectedSubject,
    opaqueProductBinding: value.opaqueProductBinding,
    mintUrl,
    unit: value.unit,
    requestedAmount: value.requestedAmount,
    tokenSha256: value.tokenSha256,
    tokenLength: value.tokenLength,
    durableReceiveAuthority: decodeWalletAuthority(value.durableReceiveAuthority),
    durableResultFingerprint: value.durableResultFingerprint,
  }
}

function assertRecipientReceiptMatchesTransfer(input: {
  readonly receipt: DurableOutgoingCashuRecipientAcknowledgement
  readonly transferId: string
  readonly mintUrl: string
  readonly unit: string
  readonly requestedAmount: string
  readonly deliveryIntent: DurableOutgoingCashuDeliveryIntent
  readonly token: DurableOutgoingCashuTokenAuthority | null
}): void {
  if (
    input.deliveryIntent.policy !== 'durable-recipient-ack' ||
    input.token === null ||
    input.receipt.transferId !== input.transferId ||
    input.receipt.expectedSubject !== input.deliveryIntent.expectedSubject ||
    input.receipt.opaqueProductBinding !== input.deliveryIntent.opaqueProductBinding ||
    input.receipt.mintUrl !== input.mintUrl ||
    input.receipt.unit !== input.unit ||
    input.receipt.requestedAmount !== input.requestedAmount ||
    input.receipt.tokenSha256 !== input.token.sha256 ||
    input.receipt.tokenLength !== input.token.encodedLength
  ) {
    throw new Error('durable outgoing Cashu recipient receipt conflicts')
  }
}

function decodeWalletAuthority(value: unknown): DurableWalletOperationAuthority {
  if (!isRecord(value)) throw new Error('durable outgoing Cashu wallet authority is invalid')
  exactKeys(value, ['requestFingerprint', 'outputPlanFingerprint'])
  if (!isSha256(value.requestFingerprint) || !isSha256(value.outputPlanFingerprint)) {
    throw new Error('durable outgoing Cashu wallet authority is invalid')
  }
  return {
    requestFingerprint: value.requestFingerprint,
    outputPlanFingerprint: value.outputPlanFingerprint,
  }
}

function decodeKeepProofDerivationLocators(
  value: unknown,
  operation: DurableWalletSendOperation,
): (DurableWalletProofDerivationLocator | null)[] {
  if (!Array.isArray(value) || value.length !== operation.preview.keepOutputs.length) {
    throw new Error('durable outgoing Cashu keep proof derivation locators are invalid')
  }
  const seen = new Set<string>()
  return value.map((locator, index) => {
    if (locator === null) return null
    const decoded = decodeDurableWalletProofDerivationLocator(locator)
    const output = operation.preview.keepOutputs[index]
    if (
      output === undefined ||
      decoded.kind !== 'nut13' ||
      decoded.keysetId !== output.blindedMessage.id
    ) {
      throw new Error('durable outgoing Cashu keep proof derivation locator is foreign')
    }
    const fingerprint = deriveDurableCustodyArtifactFingerprint(decoded)
    if (seen.has(fingerprint)) {
      throw new Error('durable outgoing Cashu keep proof derivation locators conflict')
    }
    seen.add(fingerprint)
    return decoded
  })
}

function decodeCustodyRevisions(value: unknown): { proofIdentity: string; revision: number }[] {
  if (!Array.isArray(value) || value.length > DURABLE_OUTGOING_CASHU_CUSTODY_REVISION_LIMIT_MAX) {
    throw new Error('durable outgoing Cashu custody revisions are invalid')
  }
  const seen = new Set<string>()
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('durable outgoing Cashu custody revision is invalid')
    exactKeys(entry, ['proofIdentity', 'revision'])
    requireText(entry.proofIdentity, 'proof identity')
    if (
      typeof entry.revision !== 'number' ||
      !Number.isSafeInteger(entry.revision) ||
      entry.revision < 0 ||
      seen.has(entry.proofIdentity)
    ) {
      throw new Error('durable outgoing Cashu custody revision is invalid')
    }
    seen.add(entry.proofIdentity)
    return { proofIdentity: entry.proofIdentity, revision: entry.revision }
  })
}

function requireExactCustodyRevisions(
  inputs: readonly DurableWalletProof[],
  keep: readonly DurableWalletProof[],
  send: readonly DurableWalletProof[],
  revisions: readonly { readonly proofIdentity: string; readonly revision: number }[],
): void {
  const decoded = decodeCustodyRevisions(revisions)
  const expected = new Set([...inputs, ...keep, ...send].map(proofIdentity))
  if (
    expected.size !== decoded.length ||
    decoded.some((revision) => !expected.has(revision.proofIdentity))
  ) {
    throw new Error('durable outgoing Cashu custody revisions conflict')
  }
}

function assertTransferState(
  state: unknown,
  intent: DurableOutgoingCashuDeliveryIntent,
  token: DurableOutgoingCashuTokenAuthority | null,
  recipientReceipt: DurableOutgoingCashuRecipientAcknowledgement | null,
  reclaim: DurableOutgoingCashuReclaimAuthority | null,
): void {
  if (state === 'prepared') {
    if (token !== null || recipientReceipt !== null || reclaim !== null)
      throw new Error('durable outgoing Cashu state conflicts')
    return
  }
  if (state === 'delivery-pending') {
    if (token === null || recipientReceipt !== null || reclaim !== null)
      throw new Error('durable outgoing Cashu state conflicts')
    return
  }
  if (state === 'recipient-acknowledged') {
    if (
      intent.policy !== 'durable-recipient-ack' ||
      token === null ||
      recipientReceipt === null ||
      reclaim !== null
    )
      throw new Error('durable outgoing Cashu state conflicts')
    return
  }
  if (state === 'bearer-spent' || state === 'bearer-partial') {
    if (
      intent.policy !== 'bearer-spend-classification' ||
      token === null ||
      recipientReceipt !== null ||
      reclaim !== null
    )
      throw new Error('durable outgoing Cashu state conflicts')
    if (
      state === 'bearer-partial' &&
      (token.unspentProofs === null || token.unspentProofs.length === token.proofs.length)
    ) {
      throw new Error('durable outgoing Cashu partial authority is invalid')
    }
    return
  }
  if (state === 'reclaim-prepared' || state === 'reclaimed') {
    if (
      intent.policy !== 'bearer-spend-classification' ||
      token === null ||
      recipientReceipt !== null ||
      reclaim === null
    )
      throw new Error('durable outgoing Cashu state conflicts')
    if (
      (state === 'reclaim-prepared' && reclaim.completionEvidence !== null) ||
      (state === 'reclaimed' && reclaim.completionEvidence === null)
    ) {
      throw new Error('durable outgoing Cashu reclaim completion state conflicts')
    }
    return
  }
  throw new Error('durable outgoing Cashu delivery state is invalid')
}

function decodeRecovery(
  value: unknown,
): asserts value is { dueAtMs: number; attemptCount: number } {
  if (!isRecord(value)) throw new Error('durable outgoing Cashu recovery metadata is invalid')
  exactKeys(value, ['dueAtMs', 'attemptCount'])
  requireTimestamp(value.dueAtMs)
  if (
    typeof value.attemptCount !== 'number' ||
    !Number.isSafeInteger(value.attemptCount) ||
    value.attemptCount < 0
  ) {
    throw new Error('durable outgoing Cashu recovery metadata is invalid')
  }
}

function decodeCursor(value: unknown): asserts value is DurableOutgoingCashuRecoveryCursor {
  if (!isRecord(value)) throw new Error('durable outgoing Cashu recovery cursor is invalid')
  exactKeys(value, ['dueAtMs', 'transferId'])
  requireTimestamp(value.dueAtMs)
  requireText(value.transferId, 'transfer id')
}

function compareDue(
  left: DurableOutgoingCashuTransfer,
  right: DurableOutgoingCashuTransfer,
): number {
  return (
    left.recovery.dueAtMs - right.recovery.dueAtMs ||
    left.transferId.localeCompare(right.transferId)
  )
}

function compareCursor(
  left: DurableOutgoingCashuRecoveryCursor,
  right: DurableOutgoingCashuRecoveryCursor,
): number {
  return left.dueAtMs - right.dueAtMs || left.transferId.localeCompare(right.transferId)
}

function sumSendAmount(operation: DurableWalletSendOperation): string {
  return operation.preview.sendOutputs
    .reduce((total, output) => total + BigInt(output.blindedMessage.amount), 0n)
    .toString()
}

function proofIdentity(proof: DurableWalletProof): string {
  return deriveDurableCustodyArtifactFingerprint({ id: proof.id, secret: proof.secret, C: proof.C })
}

function assertDistinctProofs(proofs: readonly DurableWalletProof[]): void {
  const identities = new Set(proofs.map(proofIdentity))
  if (identities.size !== proofs.length)
    throw new Error('durable outgoing Cashu proof authority contains duplicates')
}

function sameAuthority(
  left: DurableWalletOperationAuthority,
  right: DurableWalletOperationAuthority,
): boolean {
  return (
    left.requestFingerprint === right.requestFingerprint &&
    left.outputPlanFingerprint === right.outputPlanFingerprint
  )
}

function requireCanonicalMint(value: unknown): string {
  try {
    return decodeCanonicalMintOrigin(value)
  } catch {
    throw new Error('durable outgoing Cashu mint URL is not normalized')
  }
}

function requireText(value: unknown, name: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > 16 * 1_024
  ) {
    throw new Error(`durable outgoing Cashu ${name} is invalid`)
  }
}

function requireEncodedToken(value: unknown, maximumBytes: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.startsWith('cashuB') ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  ) {
    throw new Error('durable outgoing Cashu token authority is invalid')
  }
}

function requirePositiveAmount(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('durable outgoing Cashu requested amount is invalid')
  }
}

function requireLimit(
  value: unknown,
  minimum: number,
  maximum: number,
  name: string,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`durable outgoing Cashu ${name} limit is invalid`)
  }
}

function requireTimestamp(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('durable outgoing Cashu due time is invalid')
  }
  return value
}

function requireRevision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('durable outgoing Cashu revision is invalid')
  }
}

function requireDeliveryState(value: unknown): asserts value is DurableOutgoingCashuDeliveryState {
  if (
    ![
      'prepared',
      'delivery-pending',
      'recipient-acknowledged',
      'bearer-spent',
      'bearer-partial',
      'reclaim-prepared',
      'reclaimed',
    ].includes(value as string)
  ) {
    throw new Error('durable outgoing Cashu delivery state is invalid')
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new Error('durable outgoing Cashu record contains foreign fields')
  }
}
