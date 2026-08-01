// Persistence-neutral subset re-authored from 7e1385c with ordinary
// wallet-scope, exact-unit, and fail-closed corrections from f1cb65b/b683120.
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

export const DURABLE_CUSTODY_SCHEMA_VERSION = 1 as const
export const DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX = 256
export const DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX = 4 * 1_024 * 1_024
export const DURABLE_CUSTODY_RECORD_BYTES_MAX = 64 * 1_024
export const DURABLE_CUSTODY_TRANSACTION_OPERATION_LIMIT_MAX = 256
export const DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX = 256
export const DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX = 256
export const DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX = 512
export const DURABLE_CUSTODY_PROOF_GROUP_LIMIT_MAX = 16
export const DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX = 256
export const DURABLE_CUSTODY_ARTIFACT_BYTES_MAX = 16 * 1_024 * 1_024
export const DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX = 16 * 1_024
export const DURABLE_CUSTODY_ARTIFACT_DEPTH_LIMIT_MAX = 32
export const DURABLE_CUSTODY_ARTIFACT_NODE_LIMIT_MAX = 16_384
export const DURABLE_CUSTODY_RECOVERY_PAGE_MAX_BYTES = DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX
export const DURABLE_CUSTODY_RECORD_MAX_BYTES = DURABLE_CUSTODY_RECORD_BYTES_MAX
export const DURABLE_ARTIFACT_BYTES_LIMIT_MAX = DURABLE_CUSTODY_ARTIFACT_BYTES_MAX

export type DurableCustodySemanticKind =
  | 'swap-lock'
  | 'swap-claim'
  | 'swap-refund'
  | 'conditional-keyset-swap'
  | 'generic-receive'
  | 'generic-send'
  | 'wallet-send'
  | 'ctf-split'
  | 'ctf-merge'
  | 'ctf-redeem'
export type DurableCustodyOperationState =
  | 'dispatch-intent'
  | 'transport-attempted'
  | 'reconciled'
  | 'aborted'
export type DurableCustodyCurve = 'secp256k1' | 'bls12-381'
export type DurableCustodyWalletStage =
  | 'lock'
  | 'claim'
  | 'refund'
  | 'receive'
  | 'send'
  | 'ctf-split'
  | 'ctf-merge'
  | 'ctf-redeem'

export type DurableCustodyScope =
  | { scopeKind: 'wallet'; walletId: string; scopeId: string }
  | {
      scopeKind: 'condition-inventory'
      conditionId: string
      inventoryAccountId: string
      normalizedMint: string
      unit: string
      scopeId: string
    }
export type DurableCustodyScopeInput =
  | { scopeKind: 'wallet'; walletId: string }
  | {
      scopeKind: 'condition-inventory'
      conditionId: string
      inventoryAccountId: string
      normalizedMint: string
      unit: string
    }
export interface DurableCustodyBinding {
  kind: 'wallet'
  activityId: string
  stage: DurableCustodyWalletStage
}
export interface DurableCustodyOperationIdentity {
  retainedOperationKey: string
  binding: DurableCustodyBinding
}
export interface DurableCustodyProofIdentityInput {
  scopeId: string
  normalizedMint: string
  unit: string
  keysetId: string
  secret: string
}
export interface DurableCustodyExactArtifact {
  encoding: 'canonical-json'
  artifact: unknown
  fingerprint: string
}
interface PreparedDurableCustodyArtifactMetadata {
  encodedBytes: Uint8Array
  fingerprint: string
  byteLength: number
}
const preparedDurableCustodyArtifacts = new WeakMap<
  object,
  PreparedDurableCustodyArtifactMetadata
>()
export interface DurableCustodyArtifactReference {
  artifactId: string
  encoding: 'canonical-json'
  fingerprint: string
  byteLength: number
}
export interface DurableCustodyArtifactRow {
  reference: DurableCustodyArtifactReference
  artifact: DurableCustodyExactArtifact
  revision: number
}
export interface DurableCustodySuccessorAdmissionEvidence {
  scopeId: string
  operationId: string
  admissionId: string
  proofRows: Array<{
    proofId: string
    expectedRevision: number | null
    admittedRevision: number
  }>
}
export interface DurableCustodyAuthenticatedTerminalMintRejectionAuthority {
  schemaVersion: 1
  kind: 'authenticated-terminal-mint-rejection'
  operationId: string
  semanticKind: 'ctf-redeem'
  normalizedMint: string
  requestFingerprint: string
  code: 13015
  transportProvenance: 'authenticated-mint-transport'
  transportOperationId: string
  rejectionBody: { code: 13015 }
  predecessorDisposition: 'retain'
  selectedSuccessorProofIds: []
}
export interface DurableCustodyTerminalMintRejection {
  kind: 'authenticated-terminal-mint-rejection'
  code: 13015
  rejectionHandle: string
  rejectionFingerprint: string
  exactRejection: DurableCustodyArtifactReference
  predecessorDisposition: 'retain'
  selectedSuccessorProofIds: []
}
export type DurableCustodyStorageClass =
  | 'pinned-operation-bound-deterministic'
  | 'terminal-replay-retained'
export type DurableCustodyPinReason =
  | 'active-reservation'
  | 'pending-outbox'
  | 'active-retry-cursor'
  | 'replay-tombstone'
export interface DurableCustodyProofStorageAuthority {
  storageClass: DurableCustodyStorageClass
  pinReasons: DurableCustodyPinReason[]
  lineage: {
    scopeId: string
    operationId: string
    predecessorProofIds: string[]
    successorProofIds: string[]
    successorAdmissionMode: 'exact' | 'subset'
    selectedSuccessorProofIds: string[] | null
    successorAdmission: DurableCustodySuccessorAdmissionEvidence | null
  }
}
export interface DurableProofOperationKeysetFactsInput {
  keysetId: string
  unit: string
  curve: DurableCustodyCurve
  publicKeys: Readonly<Record<string, string>>
  keysetExpiryMs: number | null
  requireDleq: boolean
  usedByInputs: boolean
  usedByOutputs: boolean
}
export interface DurableProofOperationFacts {
  unit: string
  binding: DurableCustodyBinding
  horizon: DurableCustodyRecord['operation']['horizon']
  verification: {
    hasOutputs: boolean
    keysetBindings: DurableCustodyRecord['operation']['verification']['keysetBindings']
    inputKeysets: Array<{ keysetId: string; curve: DurableCustodyCurve }>
    outputKeysets: Array<{ keysetId: string; curve: DurableCustodyCurve }>
  }
}
export interface DurableProofOperationFactsInput {
  unit: string
  binding: DurableCustodyBinding
  horizon: Omit<DurableCustodyRecord['operation']['horizon'], 'keysetExpiryMs'>
  hasOutputs: boolean
  inputKeysetRequirement: 'required' | 'none'
  keysets: readonly DurableProofOperationKeysetFactsInput[]
}

export interface DurableCustodyRecord {
  schemaVersion: typeof DURABLE_CUSTODY_SCHEMA_VERSION
  revision: number
  scope: DurableCustodyScope
  operation: {
    operationId: string
    retainedOperationKey: string
    binding: DurableCustodyBinding
    semanticKind: DurableCustodySemanticKind
    state: DurableCustodyOperationState
    terminalReplayEvidenceRequired: boolean
    custodyContext: {
      normalizedMint: string
      unit: string
      inventoryAccountId: string | null
    }
    reservation: {
      reservationId: string
      parentReservationId: string | null
      inputs: Array<{
        proofId: string
        keysetId: string
        curve: DurableCustodyCurve
      }>
    }
    exactRequest: {
      requestId: string
      requestFingerprint: string
      payloadHandle: string
      inputProofIds: string[]
      outputPlanFingerprint: string
      method: string
      path: string
      idempotencyKey: string
      body: DurableCustodyArtifactReference
    }
    outputPlan: {
      outputPlanId: string
      outputPlanFingerprint: string
      outputMaterialHandle: string
      exactOutput: DurableCustodyArtifactReference
    }
    privateMaterial: {
      materialHandle: string
      useId: string
      publicFingerprint: string
      exactPrivateMaterial: DurableCustodyArtifactReference
    }
    result: {
      state: 'none' | 'verified-staged' | 'applied'
      resultHandle: string | null
      resultFingerprint: string | null
      outputPlanFingerprint: string | null
      exactResult: DurableCustodyArtifactReference | null
    }
    terminalMintRejection: DurableCustodyTerminalMintRejection | null
    proofStorage: DurableCustodyProofStorageAuthority
    delivery:
      | {
          deliveryKind: 'none'
          deliveryId: null
          exactPayload: null
          expiresAtMs: null
          state: 'none'
          receipt: null
        }
      | {
          deliveryKind: 'outbox'
          deliveryId: string
          exactPayload: DurableCustodyArtifactReference
          expiresAtMs: number | null
          state: 'pending' | 'acknowledged' | 'expired'
          receipt: null | {
            receiptId: string
            payloadFingerprint: string
            acknowledgedAtMs: number
          }
        }
    verification: {
      outputPlanFingerprint: string
      hasOutputs: boolean
      keysetBindings: Array<{
        keysetId: string
        curve: DurableCustodyCurve
        keysetFingerprint: string
        requireDleq: boolean
      }>
      inputKeysets: Array<{ keysetId: string; curve: DurableCustodyCurve }>
      outputKeysets: Array<{ keysetId: string; curve: DurableCustodyCurve }>
    }
    retry: {
      attempt: number
      nextAttemptAtMs: number | null
      reason:
        | 'none'
        | 'pending-or-mixed'
        | 'mint-response-unknown'
        | 'rate-limited'
        | 'reservation-race'
        | 'storage-unavailable'
    }
    horizon: {
      notBeforeMs: number | null
      notAfterMs: number | null
      safetyMarginMs: number
      keysetExpiryMs: number | null
    }
  }
  terminalTombstone: null | {
    tombstoneId: string
    terminalAuthorityId: string
    authenticatedTerminalStatus: boolean
    replayCutoffObserved: boolean
  }
}

export interface DurableCustodyScopeState {
  schemaVersion: typeof DURABLE_CUSTODY_SCHEMA_VERSION
  scope: DurableCustodyScope
  fencingEpoch: number
  owner: null | { incarnationId: string; leaseExpiresAtMs: number }
  effectiveClock: { highWaterMarkMs: number }
}
export interface DurableCustodyState {
  scopeState: DurableCustodyScopeState
  operation: DurableCustodyRecord
}
export interface DurableCustodyOwnerAuthorization {
  incarnationId: string
  fencingEpoch: number
  observedAtMs: number
}
export type DurableCustodyTransition =
  | {
      kind: 'mark-transport-attempted'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
    }
  | {
      kind: 'schedule-retry'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
      reason: Exclude<DurableCustodyRecord['operation']['retry']['reason'], 'none'>
      nextAttemptAtMs: number
    }
  | {
      kind: 'stage-verified-result'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
      resultHandle: string
      resultFingerprint: string
      outputPlanFingerprint: string
      exactResult: DurableCustodyExactArtifact
      selectedSuccessorProofIds: readonly string[]
    }
  | {
      kind: 'apply-verified-result'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
      successorAdmission: DurableCustodySuccessorAdmissionEvidence
    }
  | {
      kind: 'reconcile-authenticated-terminal-mint-rejection'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
      rejectionHandle: string
      rejectionFingerprint: string
      exactRejection: DurableCustodyExactArtifact
      code: 13015
      predecessorDisposition: 'retain'
    }
  | {
      kind: 'abort'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
    }
  | {
      kind: 'release-unspent-reservation'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
    }
  | {
      kind: 'stage-outbox'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
      deliveryId: string
      exactPayload: DurableCustodyExactArtifact
      expiresAtMs: number | null
    }
  | {
      kind: 'resolve-delivery'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
      receipt: {
        receiptId: string
        payloadFingerprint: string
        acknowledgedAtMs: number
      }
    }
  | {
      kind: 'create-terminal-tombstone'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
      tombstoneId: string
      terminalAuthorityId: string
    }
  | {
      kind: 'confirm-terminal-status' | 'observe-replay-cutoff'
      authorization: DurableCustodyOwnerAuthorization
      expectedRevision: number
      terminalAuthorityId: string
    }

export interface DurableCustodyTransaction {
  getScopeState(): DurableCustodyScopeState
  getOperation(operationId: string): DurableCustodyRecord | null
  putOperation(input: { record: DurableCustodyRecord; expectedRevision: number | null }): void
  getArtifact(input: {
    scopeId: string
    operationId: string
    expectedOperationRevision: number
    reference: DurableCustodyArtifactReference
  }): DurableCustodyArtifactRow | null
  putArtifact(input: {
    scopeId: string
    operationId: string
    expectedOperationRevision: number
    expectedArtifactRevision: number | null
    reference: DurableCustodyArtifactReference
    artifact: DurableCustodyExactArtifact
  }): void
  reserveExactInputs(input: {
    operationId: string
    expectedRevision: number
    reservationId: string
    proofIds: readonly string[]
  }): void
  transitionOperation(input: {
    operationId: string
    expectedRevision: number
    transition: DurableCustodyTransition
  }): void
  stageVerifiedResult(input: {
    operationId: string
    expectedRevision: number
    authorization: DurableCustodyOwnerAuthorization
    outputPlanFingerprint: string
    resultHandle: string
    resultFingerprint: string
    exactResult: DurableCustodyExactArtifact
    selectedSuccessorProofIds: readonly string[]
  }): void
  applyVerifiedResult(input: {
    /**
     * Adapter capability: CAS the operation and atomically admit every exact
     * successor proof row described by successorAdmission in one transaction.
     */
    operationId: string
    expectedRevision: number
    authorization: DurableCustodyOwnerAuthorization
    outputPlanFingerprint: string
    resultHandle: string
    resultFingerprint: string
    successorAdmission: DurableCustodySuccessorAdmissionEvidence
  }): void
  reconcileAuthenticatedTerminalMintRejection?(input: {
    /**
     * Adapter capability: CAS the operation, persist the exact rejection, and
     * terminally condemn every reserved predecessor in one transaction.
     */
    operationId: string
    expectedRevision: number
    authorization: DurableCustodyOwnerAuthorization
    rejectionHandle: string
    rejectionFingerprint: string
    exactRejection: DurableCustodyExactArtifact
    code: 13015
    predecessorDisposition: 'retain'
  }): void
  rebuildActiveWorkIndex(input: {
    /** Nonempty exact subset of the enclosing transaction selection. */
    scopeId: string
    operationRows: readonly {
      operationId: string
      expectedRevision: number | null
    }[]
  }): void
}

export interface DurableCustodyTransactionSelection {
  scope: DurableCustodyScope
  owner: DurableCustodyOwnerAuthorization
  operationRows: readonly {
    operationId: string
    expectedRevision: number | null
  }[]
}

export interface DurableCustodyPageStore {
  listRecoverablePage(input: {
    scope: DurableCustodyScope
    cursor: string | null
    limit: number
  }): Promise<{ records: DurableCustodyRecord[]; nextCursor: string | null }>
}
export type DurableCustodyActiveRecoveryPageStore = DurableCustodyPageStore
export interface DurableCustodyRecoveryPageInput {
  scope: DurableCustodyScope
  cursor: string | null
  limit: number
}
export interface DurableCustodyRecoveryPage {
  records: DurableCustodyRecord[]
  nextCursor: string | null
}

const WALLET_ID_DOMAIN = new TextEncoder().encode('bitcaster/durable-custody-wallet-id/v1\0')

export function deriveDurableCustodyWalletId(seed: Uint8Array): string {
  if (!(seed instanceof Uint8Array) || (seed.length !== 32 && seed.length !== 64)) {
    throw new Error('custody wallet seed root must be 32 or 64 bytes')
  }
  const bytes = new Uint8Array(WALLET_ID_DOMAIN.length + seed.length)
  bytes.set(WALLET_ID_DOMAIN)
  bytes.set(seed, WALLET_ID_DOMAIN.length)
  return bytesToHex(sha256(bytes))
}

export function deriveDurableCustodyScopeId(scope: DurableCustodyScopeInput): string {
  validateScopeInput(scope)
  return scope.scopeKind === 'wallet'
    ? compositeId(['custody', 'wallet', scope.walletId])
    : compositeId([
        'custody',
        'condition-inventory',
        encodeURIComponent(scope.conditionId),
        encodeURIComponent(scope.inventoryAccountId),
        encodeURIComponent(scope.normalizedMint),
        encodeURIComponent(scope.unit),
      ])
}

export function decodeDurableCustodyScopeId(value: unknown): string {
  decodeDurableCustodyScopeInput(value)
  return value as string
}

export function decodeDurableCustodyScopeInput(value: unknown): DurableCustodyScopeInput {
  requireText(value, 'scope id')
  const parts = value.split(':')
  try {
    if (parts.length === 3 && parts[0] === 'custody' && parts[1] === 'wallet') {
      const input: DurableCustodyScopeInput = {
        scopeKind: 'wallet',
        walletId: parts[2]!,
      }
      if (value === deriveDurableCustodyScopeId(input)) return input
    }
    if (parts.length === 6 && parts[0] === 'custody' && parts[1] === 'condition-inventory') {
      const input: DurableCustodyScopeInput = {
        scopeKind: 'condition-inventory',
        conditionId: decodeURIComponent(parts[2]!),
        inventoryAccountId: decodeURIComponent(parts[3]!),
        normalizedMint: decodeURIComponent(parts[4]!),
        unit: decodeURIComponent(parts[5]!),
      }
      if (value === deriveDurableCustodyScopeId(input)) return input
    }
  } catch {
    // Normalize malformed components to a non-secret error.
  }
  throw new Error('custody scope id is invalid')
}

export function deriveDurableCustodyOperationId(
  scopeId: string,
  identity: DurableCustodyOperationIdentity,
): string {
  decodeDurableCustodyScopeId(scopeId)
  requireText(identity.retainedOperationKey, 'retained operation key')
  validateBinding(identity.binding)
  return compositeId([
    'custody-operation',
    encodeURIComponent(scopeId),
    'wallet',
    encodeURIComponent(identity.binding.activityId),
    identity.binding.stage,
    encodeURIComponent(identity.retainedOperationKey),
  ])
}

export function decodeDurableCustodyOperationId(value: unknown, expectedScopeId: string): string {
  requireText(value, 'operation id')
  if (
    !value.startsWith(
      `custody-operation:${encodeURIComponent(
        decodeDurableCustodyScopeId(expectedScopeId),
      )}:wallet:`,
    )
  ) {
    throw new Error('custody operation id is invalid')
  }
  return value
}

export function deriveDurableCustodyProofId(input: DurableCustodyProofIdentityInput): string {
  const scopeId = decodeDurableCustodyScopeId(input.scopeId)
  requireNormalizedMint(input.normalizedMint)
  requireText(input.unit, 'unit')
  const keysetId = canonicalDurableCustodyKeysetIdentity(input.keysetId)
  requireText(input.secret, 'proof secret')
  return bytesToHex(
    sha256(
      encodeProofIdentity([
        'bitcaster/custody-proof-id/v1',
        scopeId,
        input.normalizedMint,
        input.unit,
        keysetId,
        input.secret,
      ]),
    ),
  )
}

export function deriveDurableCustodyArtifactFingerprint(artifact: unknown): string {
  return bytesToHex(sha256(encodeDurableCustodyArtifact(artifact)))
}

export function encodeDurableCustodyArtifact(value: unknown): Uint8Array {
  return encodeBoundedDurableArtifact(value, DURABLE_CUSTODY_RECOVERY_PAGE_MAX_BYTES)
}

export function encodeBoundedDurableArtifact(value: unknown, maximumBytes: number): Uint8Array {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > DURABLE_ARTIFACT_BYTES_LIMIT_MAX
  ) {
    throw new Error('custody artifact byte limit is invalid')
  }
  assertBoundedArtifactGraph(value, maximumBytes)
  const bytes = new TextEncoder().encode(canonicalJson(value))
  if (bytes.length === 0 || bytes.length > maximumBytes) {
    throw new Error('custody artifact exceeds the byte limit')
  }
  return bytes
}

export function prepareDurableCustodyExactArtifact(artifact: unknown): DurableCustodyExactArtifact {
  let detachedArtifact: unknown
  try {
    detachedArtifact = structuredClone(artifact)
  } catch {
    throw new Error('custody artifact cannot be cloned')
  }
  const encodedBytes = encodeBoundedDurableArtifact(
    detachedArtifact,
    DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  )
  const fingerprint = bytesToHex(sha256(encodedBytes))
  freezeCanonicalArtifactGraph(detachedArtifact)
  const exactArtifact = Object.freeze({
    encoding: 'canonical-json' as const,
    artifact: detachedArtifact,
    fingerprint,
  })
  preparedDurableCustodyArtifacts.set(exactArtifact, {
    encodedBytes,
    fingerprint,
    byteLength: encodedBytes.length,
  })
  return exactArtifact
}

export function readPreparedDurableCustodyArtifactBytes(
  artifact: DurableCustodyExactArtifact,
): Uint8Array {
  const metadata = preparedDurableCustodyArtifacts.get(artifact)
  if (metadata === undefined) {
    throw new Error('custody exact artifact is not SDK-prepared')
  }
  return metadata.encodedBytes.slice()
}

export function canonicalDurableCustodyKeysetIdentity(keysetId: string): string {
  requireText(keysetId, 'proof keyset id')
  if (/^[0-9a-fA-F]+$/.test(keysetId)) return keysetId
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(keysetId)) return keysetId
  if (/[+/]/.test(keysetId) && /[-_]/.test(keysetId)) {
    throw new Error('proof keyset id mixes Base64 alphabets')
  }
  const normalized = keysetId.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (normalized.length % 4 === 1) return keysetId
  try {
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
    const decoded = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
    let standard = ''
    for (const byte of decoded) standard += String.fromCharCode(byte)
    if (btoa(standard).replace(/=+$/, '') !== normalized) return keysetId
    return `legacy:${bytesToHex(decoded)}`
  } catch {
    return keysetId
  }
}

export function deriveDurableCustodyKeysetFingerprint(input: {
  keysetId: string
  unit: string
  curve: DurableCustodyCurve
  publicKeys: Readonly<Record<string, string>>
}): string {
  const keysetId = canonicalDurableCustodyKeysetIdentity(input.keysetId)
  requireText(input.unit, 'keyset unit')
  validateCurve(input.curve)
  const entries = Object.entries(input.publicKeys)
  if (entries.length === 0 || entries.length > DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX) {
    throw new Error('custody keyset public keys are invalid')
  }
  const expectedLength = input.curve === 'bls12-381' ? 192 : 66
  const canonical = entries.map(([amount, publicKey]) => {
    const amountNumber = Number(amount)
    if (
      !/^[1-9][0-9]*$/.test(amount) ||
      !Number.isSafeInteger(amountNumber) ||
      typeof publicKey !== 'string' ||
      publicKey.length !== expectedLength ||
      !/^[a-fA-F0-9]+$/.test(publicKey)
    ) {
      throw new Error('custody keyset public key is invalid')
    }
    return { amount, amountNumber, publicKey: publicKey.toLowerCase() }
  })
  canonical.sort((left, right) => left.amountNumber - right.amountNumber)
  return bytesToHex(
    sha256(
      encodeProofIdentity([
        'bitcaster/custody-keyset-fingerprint/v1',
        keysetId,
        input.unit,
        input.curve,
        ...canonical.flatMap(({ amount, publicKey }) => [amount, publicKey]),
      ]),
    ),
  )
}

export function createDurableProofOperationFacts(
  input: DurableProofOperationFactsInput,
): DurableProofOperationFacts {
  requireText(input.unit, 'unit')
  validateBinding(input.binding)
  validateHorizon(input.horizon)
  if (
    input.keysets.length === 0 ||
    input.keysets.length > DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX
  ) {
    throw new Error('custody keyset binding limit is invalid')
  }
  const ids = new Set<string>()
  const bindings = input.keysets.map((keyset) => {
    requireText(keyset.keysetId, 'keyset id')
    if (ids.has(keyset.keysetId)) throw new Error('custody keyset is duplicated')
    ids.add(keyset.keysetId)
    if (keyset.unit !== input.unit) throw new Error('custody keyset unit is invalid')
    validateCurve(keyset.curve)
    const keys = Object.entries(keyset.publicKeys)
    if (
      keys.length === 0 ||
      keys.some(
        ([amount, key]) =>
          !/^[1-9][0-9]*$/.test(amount) ||
          typeof key !== 'string' ||
          (keyset.curve === 'secp256k1'
            ? !/^(02|03)[0-9a-fA-F]{64}$/.test(key)
            : !/^[89a-fA-F][0-9a-fA-F]{191}$/.test(key)),
      )
    ) {
      throw new Error('custody mint public keys are invalid')
    }
    nullableTime(keyset.keysetExpiryMs, 'keyset expiry')
    return {
      keysetId: keyset.keysetId,
      curve: keyset.curve,
      keysetFingerprint: deriveDurableCustodyKeysetFingerprint({
        keysetId: keyset.keysetId,
        unit: keyset.unit,
        curve: keyset.curve,
        publicKeys: keyset.publicKeys,
      }),
      requireDleq: keyset.requireDleq,
    }
  })
  const inputKeysets = input.keysets
    .filter((keyset) => keyset.usedByInputs)
    .map(({ keysetId, curve }) => ({ keysetId, curve }))
  const outputKeysets = input.keysets
    .filter((keyset) => keyset.usedByOutputs)
    .map(({ keysetId, curve }) => ({ keysetId, curve }))
  if (input.inputKeysetRequirement === 'required' && inputKeysets.length === 0) {
    throw new Error('custody input keyset is required')
  }
  if (input.hasOutputs !== outputKeysets.length > 0) {
    throw new Error('custody output keyset authority is invalid')
  }
  const expiries = input.keysets
    .map((keyset) => keyset.keysetExpiryMs)
    .filter((value): value is number => value !== null)
  return {
    unit: input.unit,
    binding: structuredClone(input.binding),
    horizon: {
      ...input.horizon,
      keysetExpiryMs: expiries.length === 0 ? null : Math.min(...expiries),
    },
    verification: {
      hasOutputs: input.hasOutputs,
      keysetBindings: bindings,
      inputKeysets,
      outputKeysets,
    },
  }
}

export function createDurableCustodyDispatchIntent(input: {
  scope: DurableCustodyScope
  retainedOperationKey: string
  semanticKind: DurableCustodySemanticKind
  facts: DurableProofOperationFacts
  normalizedMint: string
  inventoryAccountId: string | null
  reservation: DurableCustodyRecord['operation']['reservation']
  proofLineage: {
    predecessorProofIds: readonly string[]
    successorProofIds: readonly string[]
    successorAdmissionMode: 'exact' | 'subset'
  }
  exactRequest: Omit<DurableCustodyRecord['operation']['exactRequest'], 'body'> & {
    body: DurableCustodyExactArtifact
  }
  outputPlan: Omit<DurableCustodyRecord['operation']['outputPlan'], 'exactOutput'> & {
    exactOutput: DurableCustodyExactArtifact
  }
  privateMaterial: Omit<
    DurableCustodyRecord['operation']['privateMaterial'],
    'exactPrivateMaterial'
  > & { exactPrivateMaterial: DurableCustodyExactArtifact }
}): DurableCustodyRecord {
  validateExactArtifact(input.exactRequest.body)
  validateExactArtifact(input.outputPlan.exactOutput)
  validateExactArtifact(input.privateMaterial.exactPrivateMaterial)
  validateScope(input.scope)
  requireSemantic(input.semanticKind)
  requireNormalizedMint(input.normalizedMint)
  requireText(input.retainedOperationKey, 'retained operation key')
  requireText(input.facts.unit, 'unit')
  validateBinding(input.facts.binding)
  if (
    input.scope.scopeKind === 'condition-inventory' &&
    (input.scope.normalizedMint !== input.normalizedMint ||
      input.scope.unit !== input.facts.unit ||
      input.scope.inventoryAccountId !== input.inventoryAccountId)
  ) {
    throw new Error('custody condition-inventory scope authority is invalid')
  }
  validateProofLineageInput(input.proofLineage, input.reservation.inputs)
  if (
    input.reservation.inputs.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX ||
    new Set(input.reservation.inputs.map(({ proofId }) => proofId)).size !==
      input.reservation.inputs.length
  ) {
    throw new Error('custody input proof limit or uniqueness is invalid')
  }
  if (input.exactRequest.outputPlanFingerprint !== input.outputPlan.outputPlanFingerprint) {
    throw new Error('custody output plan fingerprint is inconsistent')
  }
  const { body: requestBody, ...exactRequestAuthority } = input.exactRequest
  const { exactOutput, ...outputPlanAuthority } = input.outputPlan
  const { exactPrivateMaterial, ...privateMaterialAuthority } = input.privateMaterial
  const record: DurableCustodyRecord = {
    schemaVersion: DURABLE_CUSTODY_SCHEMA_VERSION,
    revision: 0,
    scope: structuredClone(input.scope),
    operation: {
      operationId: deriveDurableCustodyOperationId(input.scope.scopeId, {
        retainedOperationKey: input.retainedOperationKey,
        binding: input.facts.binding,
      }),
      retainedOperationKey: input.retainedOperationKey,
      binding: structuredClone(input.facts.binding),
      semanticKind: input.semanticKind,
      state: 'dispatch-intent',
      terminalReplayEvidenceRequired:
        input.semanticKind === 'swap-lock' ||
        input.semanticKind === 'swap-claim' ||
        input.semanticKind === 'swap-refund' ||
        input.semanticKind === 'conditional-keyset-swap',
      custodyContext: {
        normalizedMint: input.normalizedMint,
        unit: input.facts.unit,
        inventoryAccountId: input.inventoryAccountId,
      },
      reservation: structuredClone(input.reservation),
      exactRequest: {
        ...structuredClone(exactRequestAuthority),
        body: createDurableCustodyArtifactReference(
          `artifact:${deriveDurableCustodyOperationId(input.scope.scopeId, {
            retainedOperationKey: input.retainedOperationKey,
            binding: input.facts.binding,
          })}:request`,
          requestBody,
        ),
      },
      outputPlan: {
        ...structuredClone(outputPlanAuthority),
        exactOutput: createDurableCustodyArtifactReference(
          `artifact:${deriveDurableCustodyOperationId(input.scope.scopeId, {
            retainedOperationKey: input.retainedOperationKey,
            binding: input.facts.binding,
          })}:output`,
          exactOutput,
        ),
      },
      privateMaterial: {
        ...structuredClone(privateMaterialAuthority),
        exactPrivateMaterial: createDurableCustodyArtifactReference(
          `artifact:${deriveDurableCustodyOperationId(input.scope.scopeId, {
            retainedOperationKey: input.retainedOperationKey,
            binding: input.facts.binding,
          })}:private`,
          exactPrivateMaterial,
        ),
      },
      result: {
        state: 'none',
        resultHandle: null,
        resultFingerprint: null,
        outputPlanFingerprint: null,
        exactResult: null,
      },
      terminalMintRejection: null,
      proofStorage: {
        storageClass: 'pinned-operation-bound-deterministic',
        pinReasons: ['active-reservation'],
        lineage: {
          scopeId: input.scope.scopeId,
          operationId: deriveDurableCustodyOperationId(input.scope.scopeId, {
            retainedOperationKey: input.retainedOperationKey,
            binding: input.facts.binding,
          }),
          predecessorProofIds: [...input.proofLineage.predecessorProofIds],
          successorProofIds: [...input.proofLineage.successorProofIds],
          successorAdmissionMode: input.proofLineage.successorAdmissionMode,
          selectedSuccessorProofIds: null,
          successorAdmission: null,
        },
      },
      delivery: {
        deliveryKind: 'none',
        deliveryId: null,
        exactPayload: null,
        expiresAtMs: null,
        state: 'none',
        receipt: null,
      },
      verification: {
        outputPlanFingerprint: input.outputPlan.outputPlanFingerprint,
        ...structuredClone(input.facts.verification),
      },
      retry: { attempt: 0, nextAttemptAtMs: null, reason: 'none' },
      horizon: structuredClone(input.facts.horizon),
    },
    terminalTombstone: null,
  }
  return decodeDurableCustodyRecord(record)
}

export function decodeDurableCustodyRecord(value: unknown): DurableCustodyRecord {
  if (!isRecord(value)) throw new Error('custody record is invalid')
  exactKeys(value, ['schemaVersion', 'revision', 'scope', 'operation', 'terminalTombstone'])
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0
  ) {
    throw new Error('custody record header is invalid')
  }
  validateScope(value.scope)
  if (!isRecord(value.operation)) throw new Error('custody operation is invalid')
  exactKeys(value.operation, [
    'operationId',
    'retainedOperationKey',
    'binding',
    'semanticKind',
    'state',
    'terminalReplayEvidenceRequired',
    'custodyContext',
    'reservation',
    'exactRequest',
    'outputPlan',
    'privateMaterial',
    'result',
    'terminalMintRejection',
    'proofStorage',
    'delivery',
    'verification',
    'retry',
    'horizon',
  ])
  requireSemantic(value.operation.semanticKind)
  validateBinding(value.operation.binding)
  if (
    value.operation.state !== 'dispatch-intent' &&
    value.operation.state !== 'transport-attempted' &&
    value.operation.state !== 'reconciled' &&
    value.operation.state !== 'aborted'
  ) {
    throw new Error('custody operation state is invalid')
  }
  validateOperationDetails(value.operation, value.scope)
  validateTerminalTombstone(value.terminalTombstone, value.operation)
  durableCustodyArtifactReferences(value as unknown as DurableCustodyRecord)
  const bytes = new TextEncoder().encode(canonicalJson(value)).length
  if (bytes > DURABLE_CUSTODY_RECORD_BYTES_MAX) {
    throw new Error('custody record byte limit exceeded')
  }
  return structuredClone(value) as unknown as DurableCustodyRecord
}

export function assertDurableCustodyImmutableAuthorityMatches(
  existing: DurableCustodyRecord,
  expected: DurableCustodyRecord,
): void {
  const current = decodeDurableCustodyRecord(existing)
  const candidate = decodeDurableCustodyRecord(expected)
  const immutableAuthority = (record: DurableCustodyRecord) => ({
    schemaVersion: record.schemaVersion,
    scope: record.scope,
    operation: {
      operationId: record.operation.operationId,
      retainedOperationKey: record.operation.retainedOperationKey,
      binding: record.operation.binding,
      semanticKind: record.operation.semanticKind,
      terminalReplayEvidenceRequired: record.operation.terminalReplayEvidenceRequired,
      custodyContext: record.operation.custodyContext,
      reservation: record.operation.reservation,
      exactRequest: record.operation.exactRequest,
      outputPlan: record.operation.outputPlan,
      privateMaterial: record.operation.privateMaterial,
      proofStorage: {
        storageClass: record.operation.proofStorage.storageClass,
        lineage: {
          scopeId: record.operation.proofStorage.lineage.scopeId,
          operationId: record.operation.proofStorage.lineage.operationId,
          predecessorProofIds: record.operation.proofStorage.lineage.predecessorProofIds,
          successorProofIds: record.operation.proofStorage.lineage.successorProofIds,
          successorAdmissionMode: record.operation.proofStorage.lineage.successorAdmissionMode,
        },
      },
      verification: record.operation.verification,
      horizon: record.operation.horizon,
    },
  })
  if (canonicalJson(immutableAuthority(current)) !== canonicalJson(immutableAuthority(candidate))) {
    throw new Error('custody operation immutable authority is not exact')
  }
}

export function decodeDurableCustodyScopeState(value: unknown): DurableCustodyScopeState {
  if (!isRecord(value)) throw new Error('custody scope state is invalid')
  exactKeys(value, ['schemaVersion', 'scope', 'fencingEpoch', 'owner', 'effectiveClock'])
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.fencingEpoch) ||
    (value.fencingEpoch as number) < 0
  ) {
    throw new Error('custody scope state header is invalid')
  }
  validateScope(value.scope)
  if (!isRecord(value.effectiveClock)) {
    throw new Error('custody scope clock is invalid')
  }
  exactKeys(value.effectiveClock, ['highWaterMarkMs'])
  safeTime(value.effectiveClock.highWaterMarkMs as number, 'scope clock')
  if (value.owner !== null) {
    if (!isRecord(value.owner)) throw new Error('custody scope owner is invalid')
    exactKeys(value.owner, ['incarnationId', 'leaseExpiresAtMs'])
    requireText(value.owner.incarnationId, 'incarnation id')
    safeTime(value.owner.leaseExpiresAtMs as number, 'lease expiry')
  }
  return structuredClone(value) as unknown as DurableCustodyScopeState
}

export function decodeDurableCustodyTransactionOperationIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('custody transaction operation ids are invalid')
  }
  if (value.length > DURABLE_CUSTODY_TRANSACTION_OPERATION_LIMIT_MAX) {
    throw new Error('custody transaction operation limit is exceeded')
  }
  const ids = value.map((id) => {
    requireText(id, 'custody transaction operation id')
    return id
  })
  if (new Set(ids).size !== ids.length) {
    throw new Error('custody transaction operation id is duplicated')
  }
  return ids
}

export function applyDurableCustodyTransaction<T>(
  transaction: DurableCustodyTransaction,
  selection: DurableCustodyTransactionSelection,
  apply: (selected: DurableCustodyTransaction) => T,
): T
export function applyDurableCustodyTransaction<T>(
  transaction: DurableCustodyTransaction,
  selection: DurableCustodyTransactionSelection,
  apply: (selected: DurableCustodyTransaction) => T,
): T {
  validateScope(selection.scope)
  const scopeState = decodeDurableCustodyScopeState(transaction.getScopeState())
  if (scopeState.scope.scopeId !== selection.scope.scopeId) {
    throw new Error('custody transaction scope is foreign')
  }
  authorize(scopeState, selection.owner)
  if (
    selection.operationRows.length === 0 ||
    selection.operationRows.length > DURABLE_CUSTODY_TRANSACTION_OPERATION_LIMIT_MAX
  ) {
    throw new Error('custody transaction operation limit is invalid')
  }
  const selectedRows = new Map(
    selection.operationRows.map((row) => [row.operationId, row.expectedRevision]),
  )
  if (
    selectedRows.size !== selection.operationRows.length ||
    selection.operationRows.some(
      ({ operationId, expectedRevision }) =>
        typeof operationId !== 'string' ||
        operationId.length === 0 ||
        (expectedRevision !== null &&
          (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)),
    )
  ) {
    throw new Error('custody transaction operation selection is invalid')
  }
  const requireSelected = (
    operationId: string,
    expectedRevision?: number | null,
  ): DurableCustodyRecord | null => {
    if (!selectedRows.has(operationId)) {
      throw new Error('custody operation was not selected')
    }
    const selectedRevision = selectedRows.get(operationId)!
    if (expectedRevision !== undefined && selectedRevision !== expectedRevision) {
      throw new Error('custody operation revision is not selected')
    }
    const current = transaction.getOperation(operationId)
    if (
      (selectedRevision === null && current !== null) ||
      (selectedRevision !== null &&
        (current === null ||
          current.revision !== selectedRevision ||
          current.scope.scopeId !== selection.scope.scopeId))
    ) {
      throw new Error('custody selected operation CAS is stale or foreign')
    }
    return current
  }
  const requireOwner = (authorization: DurableCustodyOwnerAuthorization) => {
    if (
      authorization.incarnationId !== selection.owner.incarnationId ||
      authorization.fencingEpoch !== selection.owner.fencingEpoch ||
      authorization.observedAtMs !== selection.owner.observedAtMs
    ) {
      throw new Error('custody transaction owner is foreign')
    }
  }
  const selected: DurableCustodyTransaction = {
    getScopeState: () => structuredClone(scopeState),
    getOperation(operationId) {
      return requireSelected(operationId)
    },
    putOperation(input) {
      requireSelected(input.record.operation.operationId, input.expectedRevision)
      if (
        input.expectedRevision !== null ||
        input.record.revision !== 0 ||
        input.record.scope.scopeId !== selection.scope.scopeId
      ) {
        throw new Error('custody transaction put is not an exact insertion')
      }
      decodeDurableCustodyRecord(input.record)
      transaction.putOperation(input)
      selectedRows.set(input.record.operation.operationId, 0)
    },
    getArtifact(input) {
      validateArtifactReference(input.reference)
      const record = requireSelected(input.operationId, input.expectedOperationRevision)
      if (
        record === null ||
        input.scopeId !== selection.scope.scopeId ||
        !durableCustodyArtifactReferences(record).some((reference) =>
          artifactReferencesEqual(reference, input.reference),
        )
      ) {
        throw new Error('custody artifact reference was not selected')
      }
      const row = transaction.getArtifact(input)
      if (row === null) return null
      validateArtifactRow(row, input.reference)
      return structuredClone(row)
    },
    putArtifact(input) {
      requireSelected(input.operationId, input.expectedOperationRevision)
      if (input.scopeId !== selection.scope.scopeId) {
        throw new Error('custody artifact scope is foreign')
      }
      assertDurableCustodyArtifactMatchesReference(input.reference, input.artifact)
      const record = transaction.getOperation(input.operationId)
      if (
        record === null ||
        !durableCustodyArtifactReferences(record).some((reference) =>
          artifactReferencesEqual(reference, input.reference),
        )
      ) {
        throw new Error('custody artifact reference was not selected')
      }
      const current = transaction.getArtifact({
        scopeId: input.scopeId,
        operationId: input.operationId,
        expectedOperationRevision: input.expectedOperationRevision,
        reference: input.reference,
      })
      if (current === null) {
        if (input.expectedArtifactRevision !== null) {
          throw new Error('custody artifact CAS is stale')
        }
        transaction.putArtifact(input)
        return
      }
      validateArtifactRow(current, input.reference)
      if (input.expectedArtifactRevision !== current.revision) {
        throw new Error('custody artifact is immutable or its CAS is stale')
      }
    },
    reserveExactInputs(input) {
      requireSelected(input.operationId, input.expectedRevision)
      transaction.reserveExactInputs(input)
    },
    transitionOperation(input) {
      requireSelected(input.operationId, input.expectedRevision)
      requireOwner(input.transition.authorization)
      if (input.transition.expectedRevision !== input.expectedRevision) {
        throw new Error('custody transition revision is foreign')
      }
      transaction.transitionOperation(input)
    },
    stageVerifiedResult(input) {
      requireSelected(input.operationId, input.expectedRevision)
      requireOwner(input.authorization)
      transaction.stageVerifiedResult(input)
    },
    applyVerifiedResult(input) {
      const record = requireSelected(input.operationId, input.expectedRevision)
      requireOwner(input.authorization)
      if (record === null) {
        throw new Error('custody result operation is absent')
      }
      validateSuccessorAdmission(
        input.successorAdmission,
        record.scope,
        record.operation.operationId,
        requireSelectedSuccessorProofIds(record),
      )
      transaction.applyVerifiedResult(input)
    },
    reconcileAuthenticatedTerminalMintRejection(input) {
      const record = requireSelected(input.operationId, input.expectedRevision)
      requireOwner(input.authorization)
      if (record === null) {
        throw new Error('custody terminal mint rejection operation is absent')
      }
      if (input.predecessorDisposition !== 'retain') {
        throw new Error('custody terminal mint rejection predecessor disposition is invalid')
      }
      const reconcile = transaction.reconcileAuthenticatedTerminalMintRejection
      if (reconcile === undefined) {
        throw new Error('custody adapter does not support terminal mint rejection')
      }
      reconcile(input)
    },
    rebuildActiveWorkIndex(input) {
      const operationIds = new Set(input.operationRows.map(({ operationId }) => operationId))
      if (
        input.scopeId !== selection.scope.scopeId ||
        input.operationRows.length === 0 ||
        input.operationRows.length > selectedRows.size ||
        operationIds.size !== input.operationRows.length ||
        input.operationRows.some(
          (row) =>
            !selectedRows.has(row.operationId) ||
            selectedRows.get(row.operationId) !== row.expectedRevision,
        )
      ) {
        throw new Error('custody active index selection is foreign')
      }
      input.operationRows.forEach(({ operationId, expectedRevision }) =>
        requireSelected(operationId, expectedRevision),
      )
      transaction.rebuildActiveWorkIndex(input)
    },
  }
  const result = apply(selected)
  if (isPromiseLike(result)) {
    throw new Error('custody transaction callback must be synchronous')
  }
  return result
}

export function isDurableCustodyActiveRecoveryRecord(record: DurableCustodyRecord): boolean {
  const decoded = decodeDurableCustodyRecord(record)
  return (
    decoded.operation.state === 'dispatch-intent' ||
    decoded.operation.state === 'transport-attempted'
  )
}

export function claimDurableCustodyScope(
  state: DurableCustodyScopeState,
  input: {
    incarnationId: string
    observedAtMs: number
    leaseExpiresAtMs: number
  },
): DurableCustodyScopeState {
  validateScope(state.scope)
  requireText(input.incarnationId, 'incarnation id')
  safeTime(input.observedAtMs, 'observed time')
  safeTime(input.leaseExpiresAtMs, 'lease expiry')
  if (input.leaseExpiresAtMs <= input.observedAtMs) {
    throw new Error('custody scope clock or lease is invalid')
  }
  if (state.owner !== null && state.owner.leaseExpiresAtMs > input.observedAtMs) {
    throw new Error('custody scope is already owned')
  }
  return {
    ...structuredClone(state),
    fencingEpoch: state.fencingEpoch + 1,
    owner: {
      incarnationId: input.incarnationId,
      leaseExpiresAtMs: input.leaseExpiresAtMs,
    },
    effectiveClock: {
      highWaterMarkMs: Math.max(state.effectiveClock.highWaterMarkMs, input.observedAtMs),
    },
  }
}

export function renewDurableCustodyScope(
  state: DurableCustodyScopeState,
  input: DurableCustodyOwnerAuthorization & { leaseExpiresAtMs: number },
): DurableCustodyScopeState {
  const owner = authorize(state, input)
  safeTime(input.leaseExpiresAtMs, 'lease expiry')
  if (input.leaseExpiresAtMs <= input.observedAtMs) {
    throw new Error('custody lease expiry is invalid')
  }
  return {
    ...structuredClone(state),
    owner: {
      incarnationId: input.incarnationId,
      leaseExpiresAtMs: Math.max(owner.leaseExpiresAtMs, input.leaseExpiresAtMs),
    },
    effectiveClock: {
      highWaterMarkMs: Math.max(state.effectiveClock.highWaterMarkMs, input.observedAtMs),
    },
  }
}

export function releaseDurableCustodyScope(
  state: DurableCustodyScopeState,
  input: DurableCustodyOwnerAuthorization,
): DurableCustodyScopeState {
  authorize(state, input)
  return {
    ...structuredClone(state),
    owner: null,
    effectiveClock: {
      highWaterMarkMs: Math.max(state.effectiveClock.highWaterMarkMs, input.observedAtMs),
    },
  }
}

export function reduceDurableCustodyState(
  state: DurableCustodyState,
  transition: DurableCustodyTransition,
): DurableCustodyState {
  if (state.operation.scope.scopeId !== state.scopeState.scope.scopeId) {
    throw new Error('custody operation and scope state are foreign')
  }
  if (transition.expectedRevision !== state.operation.revision) {
    throw new Error('custody operation revision is stale')
  }
  authorize(state.scopeState, transition.authorization)
  const operation = structuredClone(state.operation)
  switch (transition.kind) {
    case 'mark-transport-attempted':
      if (operation.operation.state !== 'dispatch-intent') {
        throw new Error('custody transport transition is invalid')
      }
      operation.operation.state = 'transport-attempted'
      break
    case 'schedule-retry':
      if (
        operation.operation.state !== 'dispatch-intent' &&
        operation.operation.state !== 'transport-attempted'
      ) {
        throw new Error('custody retry transition is invalid')
      }
      if (
        transition.nextAttemptAtMs < transition.authorization.observedAtMs ||
        (operation.operation.retry.nextAttemptAtMs !== null &&
          transition.nextAttemptAtMs < operation.operation.retry.nextAttemptAtMs)
      ) {
        throw new Error('custody retry time moves backwards')
      }
      operation.operation.retry = {
        attempt: operation.operation.retry.attempt + 1,
        nextAttemptAtMs: transition.nextAttemptAtMs,
        reason: transition.reason,
      }
      setStoragePins(operation, ['active-reservation', 'active-retry-cursor'])
      break
    case 'stage-verified-result':
      if (
        operation.operation.state !== 'transport-attempted' &&
        operation.operation.state !== 'dispatch-intent'
      ) {
        throw new Error('custody result transition is invalid')
      }
      if (
        transition.outputPlanFingerprint !== operation.operation.outputPlan.outputPlanFingerprint
      ) {
        throw new Error('custody verified output plan is invalid')
      }
      validateExactArtifact(transition.exactResult)
      if (transition.exactResult.fingerprint !== transition.resultFingerprint) {
        throw new Error('custody verified result body is foreign')
      }
      operation.operation.proofStorage.lineage.selectedSuccessorProofIds = selectSuccessorProofIds(
        operation,
        transition.selectedSuccessorProofIds,
      )
      operation.operation.result = {
        state: 'verified-staged',
        resultHandle: transition.resultHandle,
        resultFingerprint: transition.resultFingerprint,
        outputPlanFingerprint: transition.outputPlanFingerprint,
        exactResult: createDurableCustodyArtifactReference(
          `artifact:${operation.operation.operationId}:result`,
          transition.exactResult,
        ),
      }
      operation.operation.retry = {
        attempt: 0,
        nextAttemptAtMs: null,
        reason: 'none',
      }
      setStoragePins(operation, ['active-reservation'])
      break
    case 'apply-verified-result':
      if (operation.operation.result.state !== 'verified-staged') {
        throw new Error('custody result has not been staged')
      }
      validateSuccessorAdmission(
        transition.successorAdmission,
        operation.scope,
        operation.operation.operationId,
        requireSelectedSuccessorProofIds(operation),
      )
      operation.operation.result.state = 'applied'
      operation.operation.state = 'reconciled'
      operation.operation.proofStorage.lineage.successorAdmission = structuredClone(
        transition.successorAdmission,
      )
      break
    case 'reconcile-authenticated-terminal-mint-rejection':
      if (
        (operation.operation.state !== 'dispatch-intent' &&
          operation.operation.state !== 'transport-attempted') ||
        operation.operation.result.state !== 'none' ||
        operation.operation.terminalMintRejection !== null
      ) {
        throw new Error('custody terminal mint rejection transition is invalid')
      }
      validateAuthenticatedTerminalMintRejectionAuthority(
        transition.exactRejection,
        operation,
        transition.code,
        transition.predecessorDisposition,
      )
      if (transition.exactRejection.fingerprint !== transition.rejectionFingerprint) {
        throw new Error('custody terminal mint rejection body is foreign')
      }
      requireText(transition.rejectionHandle, 'terminal mint rejection handle')
      operation.operation.state = 'aborted'
      operation.operation.terminalMintRejection = {
        kind: 'authenticated-terminal-mint-rejection',
        code: transition.code,
        rejectionHandle: transition.rejectionHandle,
        rejectionFingerprint: transition.rejectionFingerprint,
        exactRejection: createDurableCustodyArtifactReference(
          `artifact:${operation.operation.operationId}:terminal-mint-rejection`,
          transition.exactRejection,
        ),
        predecessorDisposition: transition.predecessorDisposition,
        selectedSuccessorProofIds: [],
      }
      operation.operation.retry = {
        attempt: 0,
        nextAttemptAtMs: null,
        reason: 'none',
      }
      setStoragePins(operation, [])
      break
    case 'abort':
      if (operation.operation.state !== 'dispatch-intent') {
        throw new Error('custody abort transition is invalid')
      }
      operation.operation.state = 'aborted'
      operation.operation.retry = {
        attempt: 0,
        nextAttemptAtMs: null,
        reason: 'none',
      }
      setStoragePins(operation, [])
      break
    case 'release-unspent-reservation':
      if (
        operation.operation.state !== 'dispatch-intent' &&
        operation.operation.state !== 'transport-attempted'
      ) {
        throw new Error('custody unspent release transition is invalid')
      }
      operation.operation.state = 'aborted'
      operation.operation.retry = {
        attempt: 0,
        nextAttemptAtMs: null,
        reason: 'none',
      }
      setStoragePins(operation, [])
      break
    case 'stage-outbox':
      if (
        operation.operation.state !== 'reconciled' ||
        operation.operation.delivery.deliveryKind !== 'none'
      ) {
        throw new Error('custody outbox transition is invalid')
      }
      validateExactArtifact(transition.exactPayload)
      requireText(transition.deliveryId, 'delivery id')
      nullableTime(transition.expiresAtMs, 'delivery expiry')
      operation.operation.delivery = {
        deliveryKind: 'outbox',
        deliveryId: transition.deliveryId,
        exactPayload: createDurableCustodyArtifactReference(
          `artifact:${operation.operation.operationId}:delivery`,
          transition.exactPayload,
        ),
        expiresAtMs: transition.expiresAtMs,
        state: 'pending',
        receipt: null,
      }
      setStoragePins(operation, ['pending-outbox'])
      break
    case 'resolve-delivery':
      if (
        operation.operation.delivery.deliveryKind !== 'outbox' ||
        operation.operation.delivery.state !== 'pending'
      ) {
        throw new Error('custody delivery resolution is invalid')
      }
      requireText(transition.receipt.receiptId, 'delivery receipt id')
      requireFingerprint(
        transition.receipt.payloadFingerprint,
        'delivery receipt payload fingerprint',
      )
      safeTime(transition.receipt.acknowledgedAtMs, 'delivery receipt time')
      if (
        transition.receipt.payloadFingerprint !==
          operation.operation.delivery.exactPayload.fingerprint ||
        transition.receipt.acknowledgedAtMs !== transition.authorization.observedAtMs
      ) {
        throw new Error('custody delivery receipt is foreign')
      }
      operation.operation.delivery = {
        ...operation.operation.delivery,
        state: 'acknowledged',
        receipt: structuredClone(transition.receipt),
      }
      setStoragePins(operation, [])
      break
    case 'create-terminal-tombstone':
      if (
        operation.operation.state !== 'reconciled' ||
        !operation.operation.terminalReplayEvidenceRequired ||
        operation.terminalTombstone !== null ||
        !isDeliveryResolved(operation.operation.delivery)
      ) {
        throw new Error('custody terminal tombstone transition is invalid')
      }
      requireText(transition.tombstoneId, 'tombstone id')
      requireText(transition.terminalAuthorityId, 'terminal authority id')
      operation.terminalTombstone = {
        tombstoneId: transition.tombstoneId,
        terminalAuthorityId: transition.terminalAuthorityId,
        authenticatedTerminalStatus: false,
        replayCutoffObserved: false,
      }
      operation.operation.proofStorage.storageClass = 'terminal-replay-retained'
      setStoragePins(operation, ['replay-tombstone'])
      break
    case 'confirm-terminal-status':
    case 'observe-replay-cutoff':
      if (
        operation.terminalTombstone === null ||
        operation.terminalTombstone.terminalAuthorityId !== transition.terminalAuthorityId
      ) {
        throw new Error('custody terminal evidence is foreign')
      }
      if (transition.kind === 'confirm-terminal-status') {
        operation.terminalTombstone.authenticatedTerminalStatus = true
      } else {
        operation.terminalTombstone.replayCutoffObserved = true
      }
      break
  }
  operation.revision += 1
  return {
    scopeState: {
      ...structuredClone(state.scopeState),
      effectiveClock: {
        highWaterMarkMs: Math.max(
          state.scopeState.effectiveClock.highWaterMarkMs,
          transition.authorization.observedAtMs,
        ),
      },
    },
    operation: decodeDurableCustodyRecord(operation),
  }
}

export type DurableCustodyActiveWorkDisposition = 'operation' | 'delivery' | 'tombstone' | 'none'

export function classifyDurableCustodyActiveWork(
  record: DurableCustodyRecord,
): DurableCustodyActiveWorkDisposition {
  const decoded = decodeDurableCustodyRecord(record)
  if (
    decoded.operation.state === 'dispatch-intent' ||
    decoded.operation.state === 'transport-attempted'
  ) {
    return 'operation'
  }
  if (
    decoded.operation.delivery.deliveryKind === 'outbox' &&
    decoded.operation.delivery.state === 'pending'
  ) {
    return 'delivery'
  }
  if (
    decoded.terminalTombstone !== null &&
    (!decoded.terminalTombstone.authenticatedTerminalStatus ||
      !decoded.terminalTombstone.replayCutoffObserved)
  ) {
    return 'tombstone'
  }
  return 'none'
}

export function decideDurableCustodyPurge(
  record: DurableCustodyRecord,
  scopeState: DurableCustodyScopeState,
): { kind: 'retain' } | { kind: 'delete' } {
  let decoded: DurableCustodyRecord
  try {
    decoded = decodeDurableCustodyRecord(record)
  } catch {
    // Deletion must fail closed for malformed or unverifiable evidence.
    return { kind: 'retain' }
  }
  const decodedScope = decodeDurableCustodyScopeState(scopeState)
  if (decoded.scope.scopeId !== decodedScope.scope.scopeId) {
    throw new Error('custody purge scope is foreign')
  }
  const tombstone = decoded.terminalTombstone
  return tombstone !== null &&
    tombstone.authenticatedTerminalStatus &&
    tombstone.replayCutoffObserved &&
    isDeliveryResolved(decoded.operation.delivery) &&
    decoded.operation.proofStorage.lineage.successorAdmission !== null
    ? { kind: 'delete' }
    : { kind: 'retain' }
}

export const decideTerminalTombstoneDrain = decideDurableCustodyPurge

export function isDurableCustodyProofReservationActive(record: DurableCustodyRecord): boolean {
  return record.operation.state !== 'reconciled' && record.operation.state !== 'aborted'
}

function setStoragePins(record: DurableCustodyRecord, pins: DurableCustodyPinReason[]): void {
  record.operation.proofStorage.pinReasons = [...pins].sort()
}

function isDeliveryResolved(delivery: DurableCustodyRecord['operation']['delivery']): boolean {
  switch (delivery.deliveryKind) {
    case 'none':
      return false
    case 'outbox':
      return delivery.state === 'acknowledged' && delivery.receipt !== null
  }
}

export async function readDurableCustodyRecoveryPage(
  store: DurableCustodyPageStore,
  input: {
    scope: DurableCustodyScope
    cursor: string | null
    limit: number
  },
): Promise<{ records: DurableCustodyRecord[]; nextCursor: string | null }> {
  validateScope(input.scope)
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX
  ) {
    throw new Error('custody recovery page limit is invalid')
  }
  if (
    input.cursor !== null &&
    (typeof input.cursor !== 'string' ||
      input.cursor.length === 0 ||
      input.cursor.length > DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX)
  ) {
    throw new Error('custody recovery cursor is invalid')
  }
  const page = await store.listRecoverablePage(input)
  if (page.records.length > input.limit) {
    throw new Error('custody recovery page exceeds its record limit')
  }
  const records = page.records.map(decodeDurableCustodyRecord)
  if (new Set(records.map((record) => record.operation.operationId)).size !== records.length) {
    throw new Error('custody recovery page contains duplicate operations')
  }
  if (
    records.some(
      (record) =>
        record.scope.scopeId !== input.scope.scopeId ||
        record.operation.state === 'reconciled' ||
        record.operation.state === 'aborted',
    )
  ) {
    throw new Error('custody recovery page contains a foreign record')
  }
  if (
    new TextEncoder().encode(canonicalJson(page)).length > DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX
  ) {
    throw new Error('custody recovery page byte limit exceeded')
  }
  if (
    page.nextCursor !== null &&
    (typeof page.nextCursor !== 'string' ||
      page.nextCursor.length === 0 ||
      page.nextCursor.length > DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX)
  ) {
    throw new Error('custody recovery next cursor is invalid')
  }
  if (
    (records.length === 0 && page.nextCursor !== null) ||
    (page.nextCursor !== null && page.nextCursor === input.cursor)
  ) {
    throw new Error('custody recovery cursor did not advance')
  }
  return { records, nextCursor: page.nextCursor }
}

function validateOperationDetails(
  operation: Record<string, unknown>,
  scope: DurableCustodyScope,
): void {
  requireText(operation.operationId, 'operation id')
  requireText(operation.retainedOperationKey, 'retained operation key')
  decodeDurableCustodyOperationId(operation.operationId, scope.scopeId)
  const expectedOperationId = deriveDurableCustodyOperationId(scope.scopeId, {
    retainedOperationKey: operation.retainedOperationKey,
    binding: operation.binding as DurableCustodyBinding,
  })
  if (operation.operationId !== expectedOperationId) {
    throw new Error('custody operation id is invalid')
  }
  if (
    typeof operation.terminalReplayEvidenceRequired !== 'boolean' ||
    operation.terminalReplayEvidenceRequired !==
      requiresTerminalReplay(operation.semanticKind as DurableCustodySemanticKind)
  ) {
    throw new Error('custody terminal replay authority is invalid')
  }
  if (
    (operation.binding as DurableCustodyBinding).stage !==
    semanticStage(operation.semanticKind as DurableCustodySemanticKind)
  ) {
    throw new Error('custody semantic stage binding is invalid')
  }
  if (!isRecord(operation.custodyContext)) {
    throw new Error('custody context is invalid')
  }
  exactKeys(operation.custodyContext, ['normalizedMint', 'unit', 'inventoryAccountId'])
  requireNormalizedMint(operation.custodyContext.normalizedMint)
  requireText(operation.custodyContext.unit, 'unit')
  nullableText(operation.custodyContext.inventoryAccountId, 'inventory account id')
  if (!isRecord(operation.reservation)) {
    throw new Error('custody reservation is invalid')
  }
  exactKeys(operation.reservation, ['reservationId', 'parentReservationId', 'inputs'])
  requireText(operation.reservation.reservationId, 'reservation id')
  nullableText(operation.reservation.parentReservationId, 'parent reservation id')
  if (
    !Array.isArray(operation.reservation.inputs) ||
    operation.reservation.inputs.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX
  ) {
    throw new Error('custody reservation inputs are invalid')
  }
  operation.reservation.inputs.forEach((input) => {
    if (!isRecord(input)) throw new Error('custody reservation input is invalid')
    exactKeys(input, ['proofId', 'keysetId', 'curve'])
    requireFingerprint(input.proofId, 'proof id')
    requireText(input.keysetId, 'keyset id')
    validateCurve(input.curve)
  })
  if (
    new Set(
      operation.reservation.inputs.map((input) =>
        String((input as Record<string, unknown>).proofId),
      ),
    ).size !== operation.reservation.inputs.length
  ) {
    throw new Error('custody reservation proof is duplicated')
  }
  validateExactObject(
    operation.exactRequest,
    [
      'requestId',
      'requestFingerprint',
      'payloadHandle',
      'inputProofIds',
      'outputPlanFingerprint',
      'method',
      'path',
      'idempotencyKey',
      'body',
    ],
    'exact request',
  )
  const exactRequest = operation.exactRequest as Record<string, unknown>
  requireText(exactRequest.requestId, 'request id')
  requireFingerprint(exactRequest.requestFingerprint, 'request fingerprint')
  requireText(exactRequest.payloadHandle, 'request payload handle')
  requireFingerprint(exactRequest.outputPlanFingerprint, 'output plan fingerprint')
  requireHttpMethod(exactRequest.method)
  requireHttpPath(exactRequest.path)
  requireText(exactRequest.idempotencyKey, 'idempotency key')
  validateArtifactReference(exactRequest.body)
  if (exactRequest.body.fingerprint !== exactRequest.requestFingerprint) {
    throw new Error('custody request body reference is foreign')
  }
  if (
    !Array.isArray(exactRequest.inputProofIds) ||
    exactRequest.inputProofIds.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX
  ) {
    throw new Error('custody exact input proof ids are invalid')
  }
  exactRequest.inputProofIds.forEach((id) => requireFingerprint(id, 'input proof id'))
  validateExactObject(
    operation.outputPlan,
    ['outputPlanId', 'outputPlanFingerprint', 'outputMaterialHandle', 'exactOutput'],
    'output plan',
  )
  const outputPlan = operation.outputPlan as Record<string, unknown>
  requireText(outputPlan.outputPlanId, 'output plan id')
  requireFingerprint(outputPlan.outputPlanFingerprint, 'output plan fingerprint')
  requireText(outputPlan.outputMaterialHandle, 'output material handle')
  validateArtifactReference(outputPlan.exactOutput)
  if (outputPlan.exactOutput.fingerprint !== outputPlan.outputPlanFingerprint) {
    throw new Error('custody exact output reference is foreign')
  }
  if (outputPlan.outputPlanFingerprint !== exactRequest.outputPlanFingerprint) {
    throw new Error('custody output plan fingerprint is inconsistent')
  }
  validateExactObject(
    operation.privateMaterial,
    ['materialHandle', 'useId', 'publicFingerprint', 'exactPrivateMaterial'],
    'private material',
  )
  const privateMaterial = operation.privateMaterial as Record<string, unknown>
  requireText(privateMaterial.materialHandle, 'private material handle')
  requireText(privateMaterial.useId, 'private material use id')
  requireFingerprint(privateMaterial.publicFingerprint, 'public fingerprint')
  validateArtifactReference(privateMaterial.exactPrivateMaterial)
  validateExactObject(
    operation.result,
    ['state', 'resultHandle', 'resultFingerprint', 'outputPlanFingerprint', 'exactResult'],
    'result',
  )
  const result = operation.result as Record<string, unknown>
  if (result.state !== 'none' && result.state !== 'verified-staged' && result.state !== 'applied') {
    throw new Error('custody result state is invalid')
  }
  nullableText(result.resultHandle, 'result handle')
  nullableFingerprint(result.resultFingerprint, 'result fingerprint')
  nullableFingerprint(result.outputPlanFingerprint, 'result output fingerprint')
  if (result.exactResult !== null) validateArtifactReference(result.exactResult)
  if (
    (result.state === 'none') !==
    (result.resultHandle === null &&
      result.resultFingerprint === null &&
      result.outputPlanFingerprint === null &&
      result.exactResult === null)
  ) {
    throw new Error('custody result authority is incoherent')
  }
  if (
    result.state !== 'none' &&
    (result.resultHandle === null ||
      result.resultFingerprint === null ||
      result.outputPlanFingerprint === null ||
      !isRecord(result.exactResult) ||
      result.exactResult.fingerprint !== result.resultFingerprint)
  ) {
    throw new Error('custody result body is not exact')
  }
  validateTerminalMintRejection(operation.terminalMintRejection, operation, scope)
  validateProofStorage(operation.proofStorage, operation, scope)
  validateDelivery(operation.delivery)
  validateVerification(operation.verification, outputPlan.outputPlanFingerprint)
  validateExactObject(operation.retry, ['attempt', 'nextAttemptAtMs', 'reason'], 'retry')
  const retry = operation.retry as Record<string, unknown>
  if (!Number.isSafeInteger(retry.attempt) || (retry.attempt as number) < 0) {
    throw new Error('custody retry attempt is invalid')
  }
  if (retry.nextAttemptAtMs !== null) {
    safeTime(retry.nextAttemptAtMs as number, 'retry time')
  }
  if (
    retry.reason !== 'none' &&
    retry.reason !== 'pending-or-mixed' &&
    retry.reason !== 'mint-response-unknown' &&
    retry.reason !== 'rate-limited' &&
    retry.reason !== 'reservation-race' &&
    retry.reason !== 'storage-unavailable'
  ) {
    throw new Error('custody retry reason is invalid')
  }
  validateExactObject(
    operation.horizon,
    ['notBeforeMs', 'notAfterMs', 'safetyMarginMs', 'keysetExpiryMs'],
    'horizon',
  )
  const horizon = operation.horizon as Record<string, unknown>
  nullableTime(horizon.notBeforeMs as number | null, 'not-before time')
  nullableTime(horizon.notAfterMs as number | null, 'not-after time')
  safeTime(horizon.safetyMarginMs as number, 'safety margin')
  nullableTime(horizon.keysetExpiryMs as number | null, 'keyset expiry')
  validateLifecycleCoherence(operation)
}

function validateVerification(value: unknown, outputFingerprint: unknown): void {
  validateExactObject(
    value,
    ['outputPlanFingerprint', 'hasOutputs', 'keysetBindings', 'inputKeysets', 'outputKeysets'],
    'verification',
  )
  const verification = value as Record<string, unknown>
  requireFingerprint(verification.outputPlanFingerprint, 'verification output fingerprint')
  if (
    verification.outputPlanFingerprint !== outputFingerprint ||
    typeof verification.hasOutputs !== 'boolean'
  ) {
    throw new Error('custody verification authority is invalid')
  }
  if (
    !Array.isArray(verification.keysetBindings) ||
    !Array.isArray(verification.inputKeysets) ||
    !Array.isArray(verification.outputKeysets) ||
    verification.keysetBindings.length > DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX
  ) {
    throw new Error('custody verification keysets are invalid')
  }
  verification.keysetBindings.forEach((binding) => {
    if (!isRecord(binding)) throw new Error('custody keyset binding is invalid')
    exactKeys(binding, ['keysetId', 'curve', 'keysetFingerprint', 'requireDleq'])
    requireText(binding.keysetId, 'keyset id')
    validateCurve(binding.curve)
    requireFingerprint(binding.keysetFingerprint, 'keyset fingerprint')
    if (typeof binding.requireDleq !== 'boolean') {
      throw new Error('custody DLEQ authority is invalid')
    }
  })
  for (const group of [verification.inputKeysets, verification.outputKeysets]) {
    group.forEach((keyset) => {
      if (!isRecord(keyset)) throw new Error('custody keyset usage is invalid')
      exactKeys(keyset, ['keysetId', 'curve'])
      requireText(keyset.keysetId, 'keyset id')
      validateCurve(keyset.curve)
    })
  }
}

function validateExactArtifactMetadata(value: unknown): PreparedDurableCustodyArtifactMetadata {
  if (!isRecord(value)) throw new Error('custody exact artifact is invalid')
  const prepared = preparedDurableCustodyArtifacts.get(value)
  if (prepared !== undefined) return prepared
  exactKeys(value, ['encoding', 'artifact', 'fingerprint'])
  if (value.encoding !== 'canonical-json') {
    throw new Error('custody exact artifact encoding is invalid')
  }
  requireFingerprint(value.fingerprint, 'exact artifact fingerprint')
  const bytes = encodeBoundedDurableArtifact(value.artifact, DURABLE_CUSTODY_ARTIFACT_BYTES_MAX)
  if (bytesToHex(sha256(bytes)) !== value.fingerprint) {
    throw new Error('custody exact artifact fingerprint is invalid')
  }
  return {
    encodedBytes: bytes,
    fingerprint: value.fingerprint,
    byteLength: bytes.length,
  }
}

function validateExactArtifact(value: unknown): asserts value is DurableCustodyExactArtifact {
  validateExactArtifactMetadata(value)
}

export function createDurableCustodyArtifactReference(
  artifactId: string,
  value: DurableCustodyExactArtifact,
): DurableCustodyArtifactReference {
  requireText(artifactId, 'artifact id')
  const metadata = validateExactArtifactMetadata(value)
  return {
    artifactId,
    encoding: 'canonical-json',
    fingerprint: metadata.fingerprint,
    byteLength: metadata.byteLength,
  }
}

export function assertDurableCustodyArtifactMatchesReference(
  reference: DurableCustodyArtifactReference,
  artifact: DurableCustodyExactArtifact,
): void {
  validateArtifactReference(reference)
  const metadata = validateExactArtifactMetadata(artifact)
  if (
    reference.fingerprint !== metadata.fingerprint ||
    reference.byteLength !== metadata.byteLength ||
    reference.encoding !== artifact.encoding
  ) {
    throw new Error('custody artifact does not match its exact reference')
  }
}

export function durableCustodyArtifactReferences(
  record: DurableCustodyRecord,
): DurableCustodyArtifactReference[] {
  const references = [
    record.operation.exactRequest.body,
    record.operation.outputPlan.exactOutput,
    record.operation.privateMaterial.exactPrivateMaterial,
    ...(record.operation.result.exactResult === null ? [] : [record.operation.result.exactResult]),
    ...(record.operation.terminalMintRejection === null
      ? []
      : [record.operation.terminalMintRejection.exactRejection]),
    ...(record.operation.delivery.deliveryKind === 'outbox'
      ? [record.operation.delivery.exactPayload]
      : []),
  ]
  const ids = new Set<string>()
  for (const reference of references) {
    validateArtifactReference(reference)
    if (ids.has(reference.artifactId)) {
      throw new Error('custody artifact reference is duplicated')
    }
    ids.add(reference.artifactId)
  }
  return references.map((reference) => ({ ...reference }))
}

function artifactReferencesEqual(
  left: DurableCustodyArtifactReference,
  right: DurableCustodyArtifactReference,
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.encoding === right.encoding &&
    left.fingerprint === right.fingerprint &&
    left.byteLength === right.byteLength
  )
}

function validateArtifactRow(
  row: DurableCustodyArtifactRow,
  expectedReference: DurableCustodyArtifactReference,
): void {
  if (!isRecord(row)) throw new Error('custody artifact row is invalid')
  exactKeys(row, ['reference', 'artifact', 'revision'])
  validateArtifactReference(row.reference)
  if (!artifactReferencesEqual(row.reference, expectedReference)) {
    throw new Error('custody artifact row reference is foreign')
  }
  if (!Number.isSafeInteger(row.revision) || row.revision < 0) {
    throw new Error('custody artifact row revision is invalid')
  }
  assertDurableCustodyArtifactMatchesReference(row.reference, row.artifact)
}

function validateArtifactReference(
  value: unknown,
): asserts value is DurableCustodyArtifactReference {
  if (!isRecord(value)) throw new Error('custody artifact reference is invalid')
  exactKeys(value, ['artifactId', 'encoding', 'fingerprint', 'byteLength'])
  requireText(value.artifactId, 'artifact id')
  if (value.encoding !== 'canonical-json') {
    throw new Error('custody artifact reference encoding is invalid')
  }
  requireFingerprint(value.fingerprint, 'artifact reference fingerprint')
  if (
    !Number.isSafeInteger(value.byteLength) ||
    (value.byteLength as number) < 1 ||
    (value.byteLength as number) > DURABLE_CUSTODY_ARTIFACT_BYTES_MAX
  ) {
    throw new Error('custody artifact reference byte length is invalid')
  }
}

function validateProofLineageInput(
  lineage: {
    predecessorProofIds: readonly string[]
    successorProofIds: readonly string[]
    successorAdmissionMode: 'exact' | 'subset'
  },
  inputs: DurableCustodyRecord['operation']['reservation']['inputs'],
): void {
  if (
    lineage.predecessorProofIds.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX ||
    lineage.successorProofIds.length > DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX
  ) {
    throw new Error('custody proof lineage limit exceeded')
  }
  const predecessors = lineage.predecessorProofIds.map((id) => {
    requireFingerprint(id, 'predecessor proof id')
    return id
  })
  const successors = lineage.successorProofIds.map((id) => {
    requireFingerprint(id, 'successor proof id')
    return id
  })
  const reserved = inputs.map(({ proofId }) => proofId)
  if (lineage.successorAdmissionMode !== 'exact' && lineage.successorAdmissionMode !== 'subset') {
    throw new Error('custody successor admission mode is invalid')
  }
  if (
    new Set(predecessors).size !== predecessors.length ||
    new Set(successors).size !== successors.length ||
    predecessors.length !== reserved.length ||
    predecessors.some((proofId) => !reserved.includes(proofId))
  ) {
    throw new Error('custody proof lineage is invalid')
  }
}

function selectSuccessorProofIds(
  record: DurableCustodyRecord,
  selectedValue: readonly string[],
): string[] {
  const lineage = record.operation.proofStorage.lineage
  const selected = [...selectedValue]
  if (
    selected.length > DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX ||
    new Set(selected).size !== selected.length
  ) {
    throw new Error('custody selected successor proof limit or uniqueness is invalid')
  }
  selected.forEach((proofId) => requireFingerprint(proofId, 'selected successor proof id'))
  const selectedSet = new Set(selected)
  const canonical = lineage.successorProofIds.filter((proofId) => selectedSet.has(proofId))
  if (
    canonical.length !== selected.length ||
    canonical.some((proofId, index) => proofId !== selected[index]) ||
    (record.operation.verification.hasOutputs && selected.length === 0) ||
    (!record.operation.verification.hasOutputs && selected.length !== 0) ||
    (lineage.successorAdmissionMode === 'exact' &&
      selected.length !== lineage.successorProofIds.length)
  ) {
    throw new Error('custody selected successor proofs do not match the output authority')
  }
  return selected
}

function requireSelectedSuccessorProofIds(record: DurableCustodyRecord): string[] {
  const selected = record.operation.proofStorage.lineage.selectedSuccessorProofIds
  if (selected === null) throw new Error('custody successor selection is not staged')
  return selected
}

function validateSelectedSuccessorProofIds(lineage: Record<string, unknown>): void {
  const mode = lineage.successorAdmissionMode
  const candidates = lineage.successorProofIds as string[]
  const selected = lineage.selectedSuccessorProofIds as string[] | null
  if (mode !== 'exact' && mode !== 'subset') {
    throw new Error('custody successor admission mode is invalid')
  }
  if (selected === null) {
    if (lineage.successorAdmission !== null) {
      throw new Error('custody successor admission has no staged selection')
    }
    return
  }
  const selectedSet = new Set(selected)
  const canonical = candidates.filter((proofId) => selectedSet.has(proofId))
  if (
    selectedSet.size !== selected.length ||
    canonical.length !== selected.length ||
    canonical.some((proofId, index) => proofId !== selected[index]) ||
    (mode === 'exact' && selected.length !== candidates.length)
  ) {
    throw new Error('custody selected successor proofs are invalid')
  }
}

function validateProofStorage(
  value: unknown,
  operation: Record<string, unknown>,
  scope: DurableCustodyScope,
): void {
  if (!isRecord(value)) throw new Error('custody proof storage is invalid')
  exactKeys(value, ['storageClass', 'pinReasons', 'lineage'])
  if (
    value.storageClass !== 'pinned-operation-bound-deterministic' &&
    value.storageClass !== 'terminal-replay-retained'
  ) {
    throw new Error('custody proof storage class is invalid')
  }
  if (!Array.isArray(value.pinReasons) || value.pinReasons.length > 4) {
    throw new Error('custody proof storage pins are invalid')
  }
  const pins = value.pinReasons.map((pin) => {
    if (
      pin !== 'active-reservation' &&
      pin !== 'pending-outbox' &&
      pin !== 'active-retry-cursor' &&
      pin !== 'replay-tombstone'
    ) {
      throw new Error('custody proof storage pin is invalid')
    }
    return pin
  })
  if (
    new Set(pins).size !== pins.length ||
    [...pins].sort().some((pin, index) => pin !== pins[index])
  ) {
    throw new Error('custody proof storage pins are not canonical')
  }
  if (!isRecord(value.lineage)) throw new Error('custody proof lineage is invalid')
  exactKeys(value.lineage, [
    'scopeId',
    'operationId',
    'predecessorProofIds',
    'successorProofIds',
    'successorAdmissionMode',
    'selectedSuccessorProofIds',
    'successorAdmission',
  ])
  if (
    value.lineage.scopeId !== scope.scopeId ||
    value.lineage.operationId !== operation.operationId
  ) {
    throw new Error('custody proof lineage is foreign')
  }
  if (
    !Array.isArray(value.lineage.predecessorProofIds) ||
    !Array.isArray(value.lineage.successorProofIds) ||
    (value.lineage.selectedSuccessorProofIds !== null &&
      !Array.isArray(value.lineage.selectedSuccessorProofIds))
  ) {
    throw new Error('custody proof lineage is invalid')
  }
  validateProofLineageInput(
    {
      predecessorProofIds: value.lineage.predecessorProofIds as string[],
      successorProofIds: value.lineage.successorProofIds as string[],
      successorAdmissionMode: value.lineage.successorAdmissionMode as 'exact' | 'subset',
    },
    (operation.reservation as DurableCustodyRecord['operation']['reservation']).inputs,
  )
  validateSelectedSuccessorProofIds(value.lineage)
  const selected = value.lineage.selectedSuccessorProofIds as string[] | null
  const resultState = (operation.result as DurableCustodyRecord['operation']['result']).state
  const hasOutputs = (operation.verification as DurableCustodyRecord['operation']['verification'])
    .hasOutputs
  if (
    (resultState === 'none') !== (selected === null) ||
    (selected !== null && hasOutputs !== selected.length > 0)
  ) {
    throw new Error('custody successor selection and result state are inconsistent')
  }
  if (value.lineage.successorAdmission !== null) {
    validateSuccessorAdmission(
      value.lineage.successorAdmission,
      scope,
      operation.operationId as string,
      value.lineage.selectedSuccessorProofIds as string[],
    )
  }
}

function validateSuccessorAdmission(
  value: unknown,
  scope: DurableCustodyScope,
  operationId: string,
  plannedSuccessorProofIds: readonly string[],
): asserts value is DurableCustodySuccessorAdmissionEvidence {
  if (!isRecord(value)) {
    throw new Error('custody successor admission is invalid')
  }
  exactKeys(value, ['scopeId', 'operationId', 'admissionId', 'proofRows'])
  if (value.scopeId !== scope.scopeId || value.operationId !== operationId) {
    throw new Error('custody successor admission is foreign')
  }
  requireText(value.admissionId, 'successor admission id')
  if (
    !Array.isArray(value.proofRows) ||
    value.proofRows.length > DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX ||
    value.proofRows.length !== plannedSuccessorProofIds.length
  ) {
    throw new Error('custody successor admission is incomplete')
  }
  const admittedIds = value.proofRows.map((row, index) => {
    if (!isRecord(row)) {
      throw new Error('custody successor admission row is invalid')
    }
    exactKeys(row, ['proofId', 'expectedRevision', 'admittedRevision'])
    requireFingerprint(row.proofId, 'successor admission proof id')
    if (
      row.expectedRevision !== null &&
      (!Number.isSafeInteger(row.expectedRevision) || (row.expectedRevision as number) < 0)
    ) {
      throw new Error('custody successor admission expected revision is invalid')
    }
    if (
      !Number.isSafeInteger(row.admittedRevision) ||
      (row.admittedRevision as number) < 0 ||
      row.admittedRevision !== (row.expectedRevision ?? 0)
    ) {
      throw new Error('custody successor admission revision is invalid')
    }
    if (row.proofId !== plannedSuccessorProofIds[index]) {
      throw new Error('custody successor admission does not match the plan')
    }
    return row.proofId
  })
  if (new Set(admittedIds).size !== admittedIds.length) {
    throw new Error('custody successor admission is duplicated')
  }
}

function validateDelivery(value: unknown): void {
  if (!isRecord(value)) throw new Error('custody delivery is invalid')
  exactKeys(value, [
    'deliveryKind',
    'deliveryId',
    'exactPayload',
    'expiresAtMs',
    'state',
    'receipt',
  ])
  if (value.deliveryKind === 'none') {
    if (
      value.deliveryId !== null ||
      value.exactPayload !== null ||
      value.expiresAtMs !== null ||
      value.state !== 'none' ||
      value.receipt !== null
    ) {
      throw new Error('empty custody delivery contains authority')
    }
    return
  }
  if (value.deliveryKind !== 'outbox') {
    throw new Error('custody delivery kind is invalid')
  }
  requireText(value.deliveryId, 'delivery id')
  validateArtifactReference(value.exactPayload)
  if (value.expiresAtMs !== null) safeTime(value.expiresAtMs as number, 'delivery expiry')
  if (value.state !== 'pending' && value.state !== 'acknowledged' && value.state !== 'expired') {
    throw new Error('custody delivery state is invalid')
  }
  if (value.receipt !== null) {
    if (!isRecord(value.receipt)) throw new Error('custody delivery receipt is invalid')
    exactKeys(value.receipt, ['receiptId', 'payloadFingerprint', 'acknowledgedAtMs'])
    requireText(value.receipt.receiptId, 'delivery receipt id')
    requireFingerprint(value.receipt.payloadFingerprint, 'delivery receipt payload fingerprint')
    safeTime(value.receipt.acknowledgedAtMs as number, 'delivery receipt time')
    if (
      value.state !== 'acknowledged' ||
      value.receipt.payloadFingerprint !== value.exactPayload.fingerprint
    ) {
      throw new Error('custody delivery receipt authority is invalid')
    }
  } else if (value.state === 'acknowledged') {
    throw new Error('acknowledged custody delivery requires a receipt')
  }
}

function validateTerminalMintRejection(
  value: unknown,
  operation: Record<string, unknown>,
  _scope: DurableCustodyScope,
): void {
  if (value === null) return
  if (!isRecord(value)) throw new Error('custody terminal mint rejection is invalid')
  exactKeys(value, [
    'kind',
    'code',
    'rejectionHandle',
    'rejectionFingerprint',
    'exactRejection',
    'predecessorDisposition',
    'selectedSuccessorProofIds',
  ])
  if (
    value.kind !== 'authenticated-terminal-mint-rejection' ||
    value.code !== 13015 ||
    operation.semanticKind !== 'ctf-redeem' ||
    operation.state !== 'aborted' ||
    value.predecessorDisposition !== 'retain' ||
    !Array.isArray(value.selectedSuccessorProofIds) ||
    value.selectedSuccessorProofIds.length !== 0
  ) {
    throw new Error('custody terminal mint rejection authority is invalid')
  }
  requireText(value.rejectionHandle, 'terminal mint rejection handle')
  requireFingerprint(value.rejectionFingerprint, 'terminal mint rejection fingerprint')
  validateArtifactReference(value.exactRejection)
  if (value.exactRejection.fingerprint !== value.rejectionFingerprint) {
    throw new Error('custody terminal mint rejection reference is foreign')
  }
}

function validateAuthenticatedTerminalMintRejectionAuthority(
  exactRejection: DurableCustodyExactArtifact,
  record: DurableCustodyRecord,
  code: 13015,
  predecessorDisposition: 'retain',
): void {
  validateExactArtifact(exactRejection)
  const value = exactRejection.artifact
  if (!isRecord(value)) throw new Error('custody terminal mint rejection body is invalid')
  exactKeys(value, [
    'schemaVersion',
    'kind',
    'operationId',
    'semanticKind',
    'normalizedMint',
    'requestFingerprint',
    'code',
    'transportProvenance',
    'transportOperationId',
    'rejectionBody',
    'predecessorDisposition',
    'selectedSuccessorProofIds',
  ])
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'authenticated-terminal-mint-rejection' ||
    value.operationId !== record.operation.operationId ||
    value.semanticKind !== 'ctf-redeem' ||
    record.operation.semanticKind !== 'ctf-redeem' ||
    value.normalizedMint !== record.operation.custodyContext.normalizedMint ||
    value.requestFingerprint !== record.operation.exactRequest.requestFingerprint ||
    value.code !== 13015 ||
    value.transportProvenance !== 'authenticated-mint-transport' ||
    value.transportOperationId !== record.operation.retainedOperationKey ||
    !isRecord(value.rejectionBody) ||
    value.rejectionBody.code !== 13015 ||
    Object.keys(value.rejectionBody).length !== 1 ||
    value.predecessorDisposition !== 'retain' ||
    code !== 13015 ||
    predecessorDisposition !== 'retain' ||
    !Array.isArray(value.selectedSuccessorProofIds) ||
    value.selectedSuccessorProofIds.length !== 0
  ) {
    throw new Error('custody terminal mint rejection body is foreign')
  }
}

function validateTerminalTombstone(value: unknown, operation: Record<string, unknown>): void {
  if (value === null) return
  if (!isRecord(value)) throw new Error('custody terminal tombstone is invalid')
  exactKeys(value, [
    'tombstoneId',
    'terminalAuthorityId',
    'authenticatedTerminalStatus',
    'replayCutoffObserved',
  ])
  requireText(value.tombstoneId, 'tombstone id')
  requireText(value.terminalAuthorityId, 'terminal authority id')
  if (
    typeof value.authenticatedTerminalStatus !== 'boolean' ||
    typeof value.replayCutoffObserved !== 'boolean' ||
    operation.terminalReplayEvidenceRequired !== true ||
    operation.state !== 'reconciled'
  ) {
    throw new Error('custody terminal tombstone authority is invalid')
  }
}

function validateLifecycleCoherence(operation: Record<string, unknown>): void {
  const result = operation.result as Record<string, unknown>
  const reservation = operation.reservation as Record<string, unknown>
  const retry = operation.retry as Record<string, unknown>
  const delivery = operation.delivery as Record<string, unknown>
  const lineage = (operation.proofStorage as Record<string, unknown>).lineage as Record<
    string,
    unknown
  >
  const terminalMintRejection = operation.terminalMintRejection
  if (
    (operation.state === 'reconciled') !== (result.state === 'applied') ||
    (operation.state === 'reconciled') !== (lineage.successorAdmission !== null) ||
    (operation.state === 'aborted' &&
      (result.state !== 'none' || delivery.deliveryKind !== 'none' || retry.reason !== 'none'))
  ) {
    throw new Error('custody operation lifecycle is incoherent')
  }
  if (
    terminalMintRejection !== null &&
    (operation.state !== 'aborted' ||
      result.state !== 'none' ||
      lineage.selectedSuccessorProofIds !== null ||
      lineage.successorAdmission !== null ||
      delivery.deliveryKind !== 'none' ||
      retry.reason !== 'none')
  ) {
    throw new Error('custody terminal mint rejection lifecycle is incoherent')
  }
  const reserved = (reservation.inputs as Array<Record<string, unknown>>).map(
    ({ proofId }) => proofId,
  )
  const requested = (operation.exactRequest as Record<string, unknown>).inputProofIds as unknown[]
  if (
    reserved.length !== requested.length ||
    new Set(reserved).size !== reserved.length ||
    new Set(requested).size !== requested.length ||
    reserved.some((proofId) => !requested.includes(proofId))
  ) {
    throw new Error('custody reservation and request are incoherent')
  }
}

function validateExactObject(
  value: unknown,
  fields: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`custody ${label} is invalid`)
  exactKeys(value, fields)
}

function authorize(
  scope: DurableCustodyScopeState,
  authorization: DurableCustodyOwnerAuthorization,
): NonNullable<DurableCustodyScopeState['owner']> {
  const owner = scope.owner
  safeTime(authorization.observedAtMs, 'observed time')
  if (
    owner === null ||
    owner.incarnationId !== authorization.incarnationId ||
    scope.fencingEpoch !== authorization.fencingEpoch
  ) {
    throw new Error('custody fencing authorization is invalid')
  }
  return owner
}

function validateScope(value: unknown): asserts value is DurableCustodyScope {
  if (!isRecord(value)) throw new Error('custody scope is invalid')
  if (value.scopeKind === 'wallet') {
    exactKeys(value, ['scopeKind', 'walletId', 'scopeId'])
    requireText(value.walletId, 'wallet id')
  } else if (value.scopeKind === 'condition-inventory') {
    exactKeys(value, [
      'scopeKind',
      'conditionId',
      'inventoryAccountId',
      'normalizedMint',
      'unit',
      'scopeId',
    ])
    requireText(value.conditionId, 'condition id')
    requireText(value.inventoryAccountId, 'inventory account id')
    requireNormalizedMint(value.normalizedMint)
    requireText(value.unit, 'unit')
  } else {
    throw new Error('custody scope kind is invalid')
  }
  requireText(value.scopeId, 'scope id')
  const { scopeId, ...input } = value
  if (scopeId !== deriveDurableCustodyScopeId(input as DurableCustodyScopeInput)) {
    throw new Error('custody scope id is invalid')
  }
}

function validateScopeInput(value: DurableCustodyScopeInput): void {
  if (value.scopeKind === 'wallet') {
    if (!/^[0-9a-f]{64}$/.test(value.walletId)) {
      throw new Error('custody wallet id is invalid')
    }
  } else if (value.scopeKind === 'condition-inventory') {
    requireText(value.conditionId, 'condition id')
    requireText(value.inventoryAccountId, 'inventory account id')
    requireNormalizedMint(value.normalizedMint)
    requireText(value.unit, 'unit')
  } else {
    throw new Error('custody scope kind is invalid')
  }
}

function validateBinding(value: unknown): asserts value is DurableCustodyBinding {
  if (!isRecord(value)) throw new Error('custody binding is invalid')
  exactKeys(value, ['kind', 'activityId', 'stage'])
  if (value.kind !== 'wallet') throw new Error('custody binding kind is invalid')
  requireText(value.activityId, 'activity id')
  if (
    value.stage !== 'receive' &&
    value.stage !== 'lock' &&
    value.stage !== 'claim' &&
    value.stage !== 'refund' &&
    value.stage !== 'send' &&
    value.stage !== 'ctf-split' &&
    value.stage !== 'ctf-merge' &&
    value.stage !== 'ctf-redeem'
  ) {
    throw new Error('custody binding stage is invalid')
  }
}

function requireSemantic(value: unknown): asserts value is DurableCustodySemanticKind {
  if (
    value !== 'swap-lock' &&
    value !== 'swap-claim' &&
    value !== 'swap-refund' &&
    value !== 'conditional-keyset-swap' &&
    value !== 'generic-receive' &&
    value !== 'generic-send' &&
    value !== 'wallet-send' &&
    value !== 'ctf-split' &&
    value !== 'ctf-merge' &&
    value !== 'ctf-redeem'
  ) {
    throw new Error('custody semantic kind is invalid')
  }
}

function requiresTerminalReplay(kind: DurableCustodySemanticKind): boolean {
  switch (kind) {
    case 'swap-lock':
    case 'swap-claim':
    case 'swap-refund':
    case 'conditional-keyset-swap':
      return true
    case 'generic-receive':
    case 'generic-send':
    case 'wallet-send':
    case 'ctf-split':
    case 'ctf-merge':
    case 'ctf-redeem':
      return false
  }
}

function semanticStage(kind: DurableCustodySemanticKind): DurableCustodyWalletStage {
  switch (kind) {
    case 'swap-lock':
      return 'lock'
    case 'swap-claim':
      return 'claim'
    case 'swap-refund':
      return 'refund'
    case 'conditional-keyset-swap':
    case 'generic-send':
    case 'wallet-send':
      return 'send'
    case 'generic-receive':
      return 'receive'
    case 'ctf-split':
    case 'ctf-merge':
    case 'ctf-redeem':
      return kind
  }
}

function requireHttpMethod(value: unknown): void {
  if (value !== 'POST' && value !== 'PUT' && value !== 'PATCH' && value !== 'DELETE') {
    throw new Error('custody exact request method is invalid')
  }
}

function requireHttpPath(value: unknown): void {
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('#') ||
    value.length > DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX
  ) {
    throw new Error('custody exact request path is invalid')
  }
}

function validateCurve(value: unknown): asserts value is DurableCustodyCurve {
  if (value !== 'secp256k1' && value !== 'bls12-381') {
    throw new Error('custody keyset curve is invalid')
  }
}

function validateHorizon(value: {
  notBeforeMs: number | null
  notAfterMs: number | null
  safetyMarginMs: number
}): void {
  nullableTime(value.notBeforeMs, 'not-before time')
  nullableTime(value.notAfterMs, 'not-after time')
  safeTime(value.safetyMarginMs, 'safety margin')
}

function requireNormalizedMint(value: unknown): asserts value is string {
  requireText(value, 'normalized mint')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('custody normalized mint is invalid')
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username ||
    parsed.password ||
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80') ||
    parsed.hash ||
    parsed.search ||
    parsed.pathname !== '/' ||
    value.endsWith('/') ||
    parsed.origin !== value
  ) {
    throw new Error('custody normalized mint is invalid')
  }
}

export function decodeCanonicalMintOrigin(value: unknown): string {
  requireNormalizedMint(value)
  return value
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new Error('custody artifact number is invalid')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        if (value[key] === undefined) {
          throw new Error('custody artifact contains undefined')
        }
        return `${JSON.stringify(key)}:${canonicalJson(value[key])}`
      })
      .join(',')}}`
  }
  throw new Error('custody artifact type is invalid')
}

function assertBoundedArtifactGraph(value: unknown, maximumBytes: number): void {
  const seen = new WeakSet<object>()
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let nodes = 0
  let estimatedBytes = 0
  const encoder = new TextEncoder()
  while (stack.length > 0) {
    const current = stack.pop()!
    nodes += 1
    if (
      nodes > DURABLE_CUSTODY_ARTIFACT_NODE_LIMIT_MAX ||
      current.depth > DURABLE_CUSTODY_ARTIFACT_DEPTH_LIMIT_MAX
    ) {
      throw new Error('custody artifact structure limit exceeded')
    }
    const item = current.value
    if (item === null || typeof item === 'boolean') {
      estimatedBytes += 5
    } else if (typeof item === 'string') {
      estimatedBytes += encoder.encode(item).length + 2
    } else if (typeof item === 'number') {
      if (!Number.isSafeInteger(item)) {
        throw new Error('custody artifact number is invalid')
      }
      estimatedBytes += 24
    } else if (Array.isArray(item)) {
      if (seen.has(item)) throw new Error('custody artifact cycle is invalid')
      seen.add(item)
      estimatedBytes += item.length + 2
      for (const child of item) {
        stack.push({ value: child, depth: current.depth + 1 })
      }
    } else if (isRecord(item)) {
      if (seen.has(item)) throw new Error('custody artifact cycle is invalid')
      seen.add(item)
      const entries = Object.entries(item)
      estimatedBytes += entries.length + 2
      for (const [key, child] of entries) {
        if (child === undefined) {
          throw new Error('custody artifact contains undefined')
        }
        estimatedBytes += encoder.encode(key).length + 3
        stack.push({ value: child, depth: current.depth + 1 })
      }
    } else {
      throw new Error('custody artifact type is invalid')
    }
    if (estimatedBytes > maximumBytes) {
      throw new Error('custody artifact exceeds the byte limit')
    }
  }
}

function freezeCanonicalArtifactGraph(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  const stack: object[] = [value]
  while (stack.length > 0) {
    const current = stack.pop()!
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === 'object') {
        stack.push(child)
      }
    }
    Object.freeze(current)
  }
}

function compositeId(parts: readonly string[]): string {
  const value = parts.join(':')
  requireText(value, 'composite identifier')
  return value
}

function encodeProofIdentity(parts: readonly string[]): Uint8Array {
  const encoded = parts.map((part) => {
    requireText(part, 'proof identity component')
    return new TextEncoder().encode(part)
  })
  const length = encoded.reduce((total, part) => total + 4 + part.length, 0)
  if (length > DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX) {
    throw new Error('custody proof identity is too large')
  }
  const result = new Uint8Array(length)
  const view = new DataView(result.buffer)
  let offset = 0
  for (const part of encoded) {
    view.setUint32(offset, part.length)
    offset += 4
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value)
  const expected = new Set(keys)
  if (actual.length !== keys.length || actual.some((key) => !expected.has(key))) {
    throw new Error('custody record contains foreign fields')
  }
}

function requireText(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    new TextEncoder().encode(value).length > DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX
  ) {
    throw new Error(`custody ${label} is invalid`)
  }
}

function nullableText(value: unknown, label: string): void {
  if (value !== null) requireText(value, label)
}

function requireFingerprint(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`custody ${label} is invalid`)
  }
}

function nullableFingerprint(value: unknown, label: string): void {
  if (value !== null) requireFingerprint(value, label)
}

function nullableTime(value: number | null, label: string): void {
  if (value !== null) safeTime(value, label)
}

function safeTime(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`custody ${label} is invalid`)
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') && value !== null && 'then' in value
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  )
}
