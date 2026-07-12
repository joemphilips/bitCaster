import * as Cashu from '@cashu/cashu-ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import { deriveDurableCustodyProofId } from './durableCustody.ts'
import {
  encodeCanonicalBackupCbor as encodeCanonical,
  measureCanonicalBackupCbor as measureCanonicalCbor,
  preflightEncryptedProofChunkCbor as preflightProofChunk,
} from './encryptedWalletBackupCbor.ts'
import { classifyDurableWalletStorage } from './recoverableWalletStorage.ts'

export const ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION = 1 as const
export const ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND = 1 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_KIND_RESERVED = 2 as const
export const ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES = 262_144 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_FRAME_BYTES_RESERVED = 65_536 as const
export const ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES = 245_760 as const
export const ENCRYPTED_WALLET_BACKUP_MANIFEST_CBOR_MAX_BYTES_RESERVED = 65_532 as const
export const ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX = 512 as const
export const ENCRYPTED_WALLET_BACKUP_BODY_BYTES = 262_172 as const

const ROOT_SALT = new TextEncoder().encode('bitcaster/encrypted-wallet-backup/hkdf-salt/v1')
const REALM_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/
const SECP256K1_ORDER = secp256k1.Point.Fn.ORDER
const UINT64_MAX = 18_446_744_073_709_551_615n
const REQUEST_SCALAR_ATTEMPTS = 256
const OBJECT_ID_COLLISION_ATTEMPTS = 8

type SecretDeriver = (counter: number) => { secret: Uint8Array; blindingFactor: Uint8Array }

export interface EncryptedWalletBackupRuntime {
  subtle: SubtleCrypto
  getRandomValues(target: Uint8Array): Uint8Array
}

export interface EncryptedWalletBackupKeyHandle {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly realm: string
  readonly vaultId: string
  readonly requestAuthPublicKey: string
}

interface KeyAuthority {
  readonly realm: string
  readonly seedDigest: Uint8Array
  readonly encryptionRoot: Uint8Array
  readonly requestAuthRoot: Uint8Array
  readonly vaultIdBytes: Uint8Array
  readonly runtime: EncryptedWalletBackupRuntime
  readonly derivers: Map<string, SecretDeriver>
  readonly preparedObjectIds: Set<string>
}

const KEY_AUTHORITIES = new WeakMap<object, KeyAuthority>()

export interface EncryptedWalletBackupCtfMetadata {
  conditionId: string
  outcomeLabel: string
  outcomeCollectionId: string
  registeredAtUnixSeconds: number
  finalExpiryUnixSeconds: number
}

export interface VerifiedEncryptedWalletBackupConditionalKeyset {
  readonly keysetId: string
}

interface ConditionalKeysetAuthority {
  readonly mint: string
  readonly unit: string
  readonly keysetId: string
  readonly conditionId: string
  readonly outcomeLabel: string
  readonly outcomeCollectionId: string
  readonly registeredAtUnixSeconds: number
  readonly curve: 'secp256k1' | 'bls12-381'
  readonly finalExpiryUnixSeconds: number
}

const VERIFIED_CONDITIONAL_KEYSETS = new WeakMap<object, ConditionalKeysetAuthority>()

export interface EncryptedWalletBackupCommittedProofSnapshot {
  readonly schemaVersion: 1
  readonly snapshotId: string
  readonly revision: number
  readonly proofId: string
  readonly proofCommitment: string
  readonly proofKind: EncryptedWalletBackupProofKind
  readonly ctfMetadata: EncryptedWalletBackupCtfMetadata | null
  readonly conditionalKeysetEvidence: VerifiedEncryptedWalletBackupConditionalKeyset | null
  readonly provenance: 'wallet-seed' | 'external' | 'unknown'
  readonly operationBinding: 'terminally-unlinked' | 'nonterminal' | 'unknown'
  readonly reserved: boolean
  readonly ambiguousMintOperation: boolean
  readonly proofPins: EncryptedWalletBackupProofPins
  readonly derivationLocator: 'committed' | 'missing'
}

type EncryptedWalletBackupProofKind = 'ordinary' | 'ctf-active' | 'ctf-expired' | 'p2pk' | 'htlc' | 'unknown'
interface EncryptedWalletBackupProofPins {
  readonly openOrderCollateral: 'absent' | 'present' | 'unknown'
  readonly outbox: 'absent' | 'present' | 'unknown'
  readonly retryCursor: 'absent' | 'present' | 'unknown'
  readonly replayTombstone: 'absent' | 'present' | 'unknown'
  readonly dependentWork: 'absent' | 'present' | 'unknown'
}

export interface EncryptedWalletBackupProofSnapshotStore {
  withCommittedProofSnapshot<T>(
    stableProofId: string,
    read: (row: EncryptedWalletBackupCommittedProofSnapshot) => T,
  ): Promise<T>
}

interface TransactionProofSnapshotAuthority {
  readonly row: EncryptedWalletBackupCommittedProofSnapshot
  readonly conditionalKeyset: ConditionalKeysetAuthority | null
}

const TRANSACTION_PROOF_SNAPSHOTS = new WeakMap<object, TransactionProofSnapshotAuthority>()

export interface EncryptedWalletBackupProofInput {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  mint: string
  unit: string
  counter: number
  proof: {
    id: string
    amount: string
    secret: string
    C: string
    dleq?: { e: string; s: string; r: string }
    witness?: unknown
    p2pk_e?: unknown
  }
  proofKind: EncryptedWalletBackupProofKind
  ctfMetadata: EncryptedWalletBackupCtfMetadata | null
  effectiveNowUnixSeconds: number
  createdAtUnixSeconds: number
  updatedAtUnixSeconds: number
  proofSnapshotStore: EncryptedWalletBackupProofSnapshotStore
}

export interface PreparedEncryptedWalletBackupProof {
  readonly proofId: string
  readonly commitment: string
}

interface PreparedProofAuthority {
  readonly proofId: string
  readonly commitment: string
  readonly recordBytes: Uint8Array
}

const PREPARED_PROOF_AUTHORITIES = new WeakMap<object, PreparedProofAuthority>()

export interface PreparedEncryptedWalletBackupProofChunk {
  readonly kindCode: typeof ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND
  readonly bindings: readonly Readonly<{ proofId: string; commitment: string }>[]
}

const PREPARED_CHUNK_AUTHORITIES = new WeakMap<object, Uint8Array>()

export interface PreparedEncryptedWalletBackupObject {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly kindCode: typeof ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND
  readonly realm: string
  readonly vaultId: string
  readonly objectId: string
  readonly generation: number
  readonly paddedLength: typeof ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES
  readonly digest: string
}

export interface EncryptedWalletBackupWireObject extends PreparedEncryptedWalletBackupObject {
  readonly aad: Uint8Array
  readonly body: Uint8Array
}

interface PreparedObjectAuthority {
  readonly aad: Uint8Array
  readonly body: Uint8Array
}

const PREPARED_OBJECT_AUTHORITIES = new WeakMap<object, PreparedObjectAuthority>()

export interface DecryptedEncryptedWalletBackupProofChunk {
  readonly formatVersion: typeof ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION
  readonly kindCode: typeof ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND
  readonly recordCount: number
}

interface UnverifiedEncryptedWalletBackupProof {
  readonly proofId: string
  readonly commitment: string
  readonly mint: string
  readonly unit: string
  readonly counter: number
  readonly encodedProofKind: 0 | 1
  readonly ctfMetadata: EncryptedWalletBackupCtfMetadata | null
  readonly createdAtUnixSeconds: number
  readonly updatedAtUnixSeconds: number
  readonly proof: {
    readonly id: string
    readonly amount: string
    readonly secret: string
    readonly C: string
    readonly dleq?: { readonly e: string; readonly s: string; readonly r: string }
  }
}

interface DecryptedProofChunkAuthority {
  readonly records: readonly UnverifiedEncryptedWalletBackupProof[]
}

const DECRYPTED_PROOF_CHUNK_AUTHORITIES = new WeakMap<object, DecryptedProofChunkAuthority>()

export async function createEncryptedWalletBackupKeyHandle(input: {
  seed: Uint8Array
  realm: string
  runtime?: EncryptedWalletBackupRuntime
}): Promise<EncryptedWalletBackupKeyHandle> {
  const seed = requireSeed(input.seed)
  const realm = requireRealm(input.realm)
  const runtime = requireRuntime(input.runtime)
  const encryptionRoot = await hkdf(
    runtime.subtle, seed, ROOT_SALT, encodeCanonical([1, 'encryption-root', realm]),
  )
  const requestAuthRoot = await hkdf(
    runtime.subtle, seed, ROOT_SALT, encodeCanonical([1, 'request-auth-root', realm]),
  )
  const vaultIdBytes = await hkdf(
    runtime.subtle, encryptionRoot, ROOT_SALT, encodeCanonical([1, 'vault-id', realm]),
  )
  const requestScalar = await deriveRequestAuthScalar(runtime.subtle, requestAuthRoot, realm)
  const requestAuthPublicKey = bytesToHex(secp256k1.getPublicKey(requestScalar, true).slice(1))
  const handle = Object.freeze({
    formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
    realm,
    vaultId: bytesToHex(vaultIdBytes),
    requestAuthPublicKey,
  })
  KEY_AUTHORITIES.set(handle, {
    realm,
    seedDigest: sha256(seed),
    encryptionRoot,
    requestAuthRoot,
    vaultIdBytes,
    runtime,
    derivers: new Map(),
    preparedObjectIds: new Set(),
  })
  return handle
}

export function verifyEncryptedWalletBackupConditionalKeyset(input: {
  mint: string
  unit: string
  outcomeLabel: string
  registeredAtUnixSeconds: number
  mintKeys: unknown
  conditionalMetadata: unknown
}): VerifiedEncryptedWalletBackupConditionalKeyset {
  const mint = requireNormalizedMint(input.mint)
  const unit = requireBoundedText(input.unit, 64, 'conditional keyset unit')
  const outcomeLabel = requireBoundedText(input.outcomeLabel, 256, 'conditional outcome label')
  const registeredAt = requireNonNegativeSafeInteger(input.registeredAtUnixSeconds, 'conditional registration time')
  const keys = requireRecord(input.mintKeys, 'conditional mint keys')
  requireKnownFields(keys, ['id', 'unit', 'keys'], ['active', 'input_fee_ppk', 'final_expiry', 'conditional'])
  const keyset = decodeKeysetId(keys.id)
  if (keyset.kindCode !== 2 || keyset.curve !== 'secp256k1' || keys.unit !== unit) {
    throw new Error('conditional mint keys are invalid')
  }
  const finalExpiry = requireNonNegativeSafeInteger(keys.final_expiry, 'conditional final expiry')
  if (finalExpiry <= registeredAt) throw new Error('conditional final expiry is invalid')
  const metadata = requireRecord(input.conditionalMetadata, 'conditional keyset metadata')
  requireKnownFields(metadata, ['conditionId', 'outcomeCollection', 'outcomeCollectionId', 'registeredAt'])
  const conditionId = requireLowerHex(metadata.conditionId, 32, 'conditional condition id')
  const outcomeCollection = requireBoundedText(metadata.outcomeCollection, 256, 'conditional outcome collection')
  const outcomeCollectionId = requireLowerHex(metadata.outcomeCollectionId, 32, 'conditional outcome collection id')
  if (outcomeCollection !== outcomeLabel
    || requireNonNegativeSafeInteger(metadata.registeredAt, 'conditional metadata registration') !== registeredAt) {
    throw new Error('conditional keyset metadata does not match context')
  }
  const publicKeys = requireRecord(keys.keys, 'conditional denomination keys')
  const denominations = Object.entries(publicKeys)
  if (denominations.length < 1 || denominations.length > 64
    || new TextEncoder().encode(JSON.stringify(publicKeys)).byteLength > 65_536) {
    throw new Error('conditional denomination keys exceed bounds')
  }
  const normalizedPublicKeys: Record<string, string> = {}
  for (const [amount, publicKey] of denominations) {
    if (!/^[1-9][0-9]{0,19}$/.test(amount) || BigInt(amount) > UINT64_MAX
      || typeof publicKey !== 'string' || !/^(?:02|03)[0-9a-f]{64}$/.test(publicKey)) {
      throw new Error('conditional denomination key is invalid')
    }
    normalizedPublicKeys[amount] = publicKey
  }
  const inputFee = keys.input_fee_ppk === undefined
    ? undefined
    : requireInteger(keys.input_fee_ppk, 0, 2_147_483_647, 'conditional input fee')
  if (keys.active !== undefined) requireBoolean(keys.active, 'conditional active marker')
  if (keys.conditional !== undefined) {
    const embedded = requireRecord(keys.conditional, 'embedded conditional metadata')
    requireKnownFields(embedded, ['conditionId', 'outcomeCollection', 'outcomeCollectionId', 'registeredAt'])
    if (embedded.conditionId !== conditionId || embedded.outcomeCollection !== outcomeCollection
      || embedded.outcomeCollectionId !== outcomeCollectionId || embedded.registeredAt !== registeredAt) {
      throw new Error('embedded conditional metadata conflicts')
    }
  }
  const normalizedKeys = {
    id: keyset.text,
    unit,
    ...(keys.active === undefined ? {} : { active: keys.active }),
    ...(inputFee === undefined ? {} : { input_fee_ppk: inputFee }),
    final_expiry: finalExpiry,
    keys: normalizedPublicKeys,
    conditional: { conditionId, outcomeCollection, outcomeCollectionId, registeredAt },
  }
  const normalizedMetadata = { conditionId, outcomeCollection, outcomeCollectionId, registeredAt }
  const keysetApi = (Cashu as unknown as {
    Keyset?: { verifyConditionalKeysetId(keys: unknown, metadata: unknown): boolean }
  }).Keyset
  if (keysetApi === undefined || !keysetApi.verifyConditionalKeysetId(normalizedKeys, normalizedMetadata)) {
    throw new Error('conditional keyset cryptographic verification failed')
  }
  const handle = Object.freeze({ keysetId: keyset.text })
  VERIFIED_CONDITIONAL_KEYSETS.set(handle, {
    mint, unit, keysetId: keyset.text, conditionId, outcomeLabel,
    outcomeCollectionId, registeredAtUnixSeconds: registeredAt,
    curve: keyset.curve, finalExpiryUnixSeconds: finalExpiry,
  })
  return handle
}

export async function prepareEncryptedWalletBackupProof(
  input: EncryptedWalletBackupProofInput,
): Promise<PreparedEncryptedWalletBackupProof> {
  const authority = requireKeyAuthority(input.keyHandle)
  const seed = requireSeed(input.seed)
  if (!equalBytes(authority.seedDigest, sha256(seed))) {
    throw new Error('backup seed does not match key handle')
  }
  const mint = requireNormalizedMint(input.mint)
  const unit = requireBoundedText(input.unit, 64, 'backup proof unit')
  const counter = requireInteger(input.counter, 0, 2_147_483_647, 'backup proof counter')
  const proof = requireRecord(input.proof, 'backup proof')
  requireKnownFields(proof, ['id', 'amount', 'secret', 'C'], ['dleq', 'witness', 'p2pk_e'])
  if (proof.witness !== undefined || proof.p2pk_e !== undefined) {
    throw new Error('unsupported proof field')
  }
  const keyset = decodeKeysetId(proof.id)
  const amount = requireAmount(proof.amount)
  const secret = requireLowerHexSecret(proof.secret)
  const signature = requireSignature(proof.C, keyset.curve)
  const dleq = requireDleq(proof.dleq, keyset.curve)
  let deriver = authority.derivers.get(keyset.text)
  if (deriver === undefined) {
    try {
      deriver = cashuSecretDeriver(seed, keyset.text)
    } catch {
      throw new Error('backup proof keyset is invalid')
    }
    authority.derivers.set(keyset.text, deriver)
  }
  let derivedSecret: Uint8Array
  try {
    derivedSecret = deriver(counter).secret
  } catch {
    throw new Error('backup proof derivation failed')
  }
  if (bytesToHex(derivedSecret) !== secret) {
    throw new Error('proof secret does not match deterministic derivation')
  }
  const proofId = deriveDurableCustodyProofId({
    normalizedMint: mint,
    unit,
    keysetId: keyset.identityText,
    secret,
  })
  const effectiveNow = requireNonNegativeSafeInteger(
    input.effectiveNowUnixSeconds, 'backup preparation effective time',
  )
  const createdAt = requireNonNegativeSafeInteger(input.createdAtUnixSeconds, 'proof creation time')
  const updatedAt = requireNonNegativeSafeInteger(input.updatedAtUnixSeconds, 'proof update time')
  if (updatedAt < createdAt) throw new Error('proof timestamps are invalid')
  const proofKindCode = input.proofKind === 'ordinary' ? 0 : 1
  const ctfMetadata = decodeCtfMetadata(input.ctfMetadata, proofKindCode, effectiveNow)
  const keysetWire = [keyset.kindCode, keyset.text]
  const commitmentPreimage = [
    1, 'proof-record-commitment', mint, unit, keysetWire, amount,
    new TextEncoder().encode(secret), signature, dleq, counter, proofKindCode,
    ctfMetadata, createdAt, updatedAt,
  ]
  const commitment = bytesToHex(sha256(encodeCanonical(commitmentPreimage)))
  await requireAuthoritativeStorageSnapshot(input, proofId, commitment, mint, unit, keyset, ctfMetadata)
  const record = [
    hexToBytes(proofId), hexToBytes(commitment), mint, unit, keysetWire, amount,
    new TextEncoder().encode(secret), signature, dleq, counter, proofKindCode,
    ctfMetadata, createdAt, updatedAt,
  ]
  if (measureCanonicalCbor(record) > ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES) {
    throw new Error('backup proof record exceeds the encoded size limit')
  }
  const recordBytes = encodeCanonical(record)
  const handle = Object.freeze({ proofId, commitment })
  PREPARED_PROOF_AUTHORITIES.set(handle, { proofId, commitment, recordBytes })
  return handle
}

function requireSoleMissingReceiptClassification(
  input: Pick<EncryptedWalletBackupCommittedProofSnapshot,
    'provenance' | 'proofKind' | 'operationBinding' | 'reserved' | 'ambiguousMintOperation'
    | 'proofPins' | 'derivationLocator'>,
  proofId: string,
  commitment: string,
): void {
  const classification = classifyDurableWalletStorage({
    schemaVersion: 1,
    recordId: proofId,
    kind: 'deterministic-proof',
    provenance: input.provenance,
    proofKind: input.proofKind,
    operationBinding: input.operationBinding,
    reserved: input.reserved,
    ambiguousMintOperation: input.ambiguousMintOperation,
    proofPins: input.proofPins,
    derivationLocator: input.derivationLocator,
    proofCommitment: { state: 'verified', digest: commitment },
    backupReceiptEvidence: null,
    expiredAuditPurgeAfterMs: null,
  })
  if (classification.storageClass !== 'pinned-local-recovery-state'
    || classification.recordId !== proofId
    || classification.proofCommitment !== commitment
    || classification.pinReasons.length !== 1
    || classification.pinReasons[0] !== 'missing-current-backup-receipt') {
    throw new Error('proof is not backup eligible')
  }
}

async function requireAuthoritativeStorageSnapshot(
  input: EncryptedWalletBackupProofInput,
  proofId: string,
  commitment: string,
  mint: string,
  unit: string,
  keyset: KeysetId,
  ctfTuple: null | [Uint8Array, string, Uint8Array, number, number],
): Promise<void> {
  const store = requireProofSnapshotStore(input.proofSnapshotStore)
  let callbackOpen = true
  let callbackCalls = 0
  let issued: object | undefined
  let returned: unknown
  try {
    returned = await store.withCommittedProofSnapshot(proofId, (rawRow) => {
      if (!callbackOpen || callbackCalls++ !== 0) throw new Error('proof snapshot transaction callback is invalid')
      const row = decodeCommittedProofSnapshot(rawRow)
      requireSoleMissingReceiptClassification(row, row.proofId, row.proofCommitment)
      const conditionalKeyset = row.conditionalKeysetEvidence === null
        ? null
        : VERIFIED_CONDITIONAL_KEYSETS.get(row.conditionalKeysetEvidence)
      if (row.conditionalKeysetEvidence !== null && conditionalKeyset === undefined) {
        throw new Error('conditional keyset evidence is invalid')
      }
      const capability = Object.freeze({ snapshotId: row.snapshotId, revision: row.revision })
      TRANSACTION_PROOF_SNAPSHOTS.set(capability, { row, conditionalKeyset: conditionalKeyset ?? null })
      issued = capability
      return capability
    })
  } finally {
    callbackOpen = false
  }
  if (isThenable(returned) || issued === undefined || returned !== issued || callbackCalls !== 1) {
    throw new Error('proof snapshot transaction must be synchronous and exact')
  }
  const snapshot = TRANSACTION_PROOF_SNAPSHOTS.get(issued)
  if (snapshot === undefined) throw new Error('authoritative storage snapshot is invalid')
  const row = snapshot.row
  if (row.proofId !== proofId) throw new Error('proof id does not match authoritative storage snapshot')
  if (row.proofCommitment !== commitment) {
    throw new Error('proof commitment does not match authoritative storage snapshot')
  }
  if (row.proofKind !== input.proofKind) throw new Error('proof does not match authoritative storage snapshot')
  const metadata = ctfTuple === null ? null : ctfTupleToMetadata(ctfTuple)
  if (JSON.stringify(row.ctfMetadata) !== JSON.stringify(metadata)) {
    throw new Error('proof does not match authoritative storage snapshot')
  }
  if (input.proofKind === 'ctf-active') {
    const conditional = snapshot.conditionalKeyset
    if (conditional === null || conditional.mint !== mint || conditional.unit !== unit
      || conditional.keysetId !== keyset.text || conditional.curve !== keyset.curve
      || metadata === null
      || conditional.conditionId !== metadata.conditionId
      || conditional.outcomeLabel !== metadata.outcomeLabel
      || conditional.outcomeCollectionId !== metadata.outcomeCollectionId
      || conditional.registeredAtUnixSeconds !== metadata.registeredAtUnixSeconds
      || conditional.finalExpiryUnixSeconds !== metadata.finalExpiryUnixSeconds) {
      throw new Error('proof does not match validated conditional keyset')
    }
  } else if (snapshot.conditionalKeyset !== null || row.conditionalKeysetEvidence !== null) {
    throw new Error('ordinary proof cannot bind a conditional keyset')
  }
}

function requireProofSnapshotStore(value: unknown): EncryptedWalletBackupProofSnapshotStore {
  if (typeof value !== 'object' || value === null
    || typeof (value as { withCommittedProofSnapshot?: unknown }).withCommittedProofSnapshot !== 'function') {
    throw new Error('proof snapshot store is invalid')
  }
  return value as EncryptedWalletBackupProofSnapshotStore
}

function decodeCommittedProofSnapshot(value: unknown): EncryptedWalletBackupCommittedProofSnapshot {
  const row = requireRecord(value, 'committed proof snapshot')
  requireKnownFields(row, [
    'schemaVersion', 'snapshotId', 'revision', 'proofId', 'proofCommitment', 'proofKind',
    'ctfMetadata', 'conditionalKeysetEvidence', 'provenance', 'operationBinding', 'reserved',
    'ambiguousMintOperation', 'proofPins', 'derivationLocator',
  ])
  if (row.schemaVersion !== 1) throw new Error('unsupported committed proof snapshot version')
  const proofKind = requireProofKind(row.proofKind)
  const ctf = decodeCtfMetadata(
    row.ctfMetadata as EncryptedWalletBackupCtfMetadata | null,
    proofKind === 'ordinary' ? 0 : 1,
    0,
  )
  return Object.freeze({
    schemaVersion: 1 as const,
    snapshotId: requireBoundedText(row.snapshotId, 128, 'storage snapshot id'),
    revision: requireNonNegativeSafeInteger(row.revision, 'storage snapshot revision'),
    proofId: requireLowerHex(row.proofId, 32, 'stored proof id'),
    proofCommitment: requireLowerHex(row.proofCommitment, 32, 'stored proof commitment'),
    proofKind,
    ctfMetadata: ctf === null ? null : ctfTupleToMetadata(ctf),
    conditionalKeysetEvidence: row.conditionalKeysetEvidence as VerifiedEncryptedWalletBackupConditionalKeyset | null,
    provenance: requireOneOfValue(row.provenance, ['wallet-seed', 'external', 'unknown'], 'stored provenance'),
    operationBinding: requireOneOfValue(
      row.operationBinding, ['terminally-unlinked', 'nonterminal', 'unknown'], 'stored operation binding',
    ),
    reserved: requireBoolean(row.reserved, 'stored reservation'),
    ambiguousMintOperation: requireBoolean(row.ambiguousMintOperation, 'stored ambiguity'),
    proofPins: decodeProofPins(row.proofPins),
    derivationLocator: requireOneOfValue(row.derivationLocator, ['committed', 'missing'], 'stored derivation locator'),
  })
}

function requireProofKind(value: unknown): EncryptedWalletBackupProofKind {
  if (!['ordinary', 'ctf-active', 'ctf-expired', 'p2pk', 'htlc', 'unknown'].includes(value as string)) {
    throw new Error('stored proof kind is invalid')
  }
  return value as EncryptedWalletBackupProofKind
}

export async function prepareEncryptedWalletBackupProofs(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  records: readonly Omit<EncryptedWalletBackupProofInput, 'keyHandle' | 'seed'>[]
}): Promise<PreparedEncryptedWalletBackupProof[]> {
  if (!Array.isArray(input.records) || input.records.length === 0
    || input.records.length > ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX) {
    throw new Error('backup proof count is invalid')
  }
  const groups = new Map<string, typeof input.records>()
  for (const record of input.records) {
    const keysetId = requireRecord(record.proof, 'backup proof').id
    const keyset = decodeKeysetId(keysetId).text
    groups.set(keyset, [...(groups.get(keyset) ?? []), record])
  }
  const result: PreparedEncryptedWalletBackupProof[] = []
  for (const records of groups.values()) {
    for (const record of records) {
      result.push(await prepareEncryptedWalletBackupProof({
        ...record,
        keyHandle: input.keyHandle,
        seed: input.seed,
      }))
    }
  }
  return result
}

export function packEncryptedWalletBackupProofChunk(
  handles: readonly PreparedEncryptedWalletBackupProof[],
): PreparedEncryptedWalletBackupProofChunk {
  if (!Array.isArray(handles) || handles.length === 0
    || handles.length > ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX) {
    throw new Error('backup proof count is invalid')
  }
  const authorities = handles.map((handle) => requireProofAuthority(handle))
    .sort((left, right) => compareHex(left.proofId, right.proofId))
  if (new Set(authorities.map((authority) => authority.proofId)).size !== authorities.length) {
    throw new Error('backup proof id is duplicated')
  }
  const records = authorities.map((authority) => decode(authority.recordBytes))
  const root = [1, ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND, records]
  const measured = measureCanonicalCbor(root)
  if (measured > ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES) {
    throw new Error('backup proof chunk exceeds the canonical CBOR limit')
  }
  const canonical = encodeCanonical(root)
  const bindings = Object.freeze(authorities.map((authority) => Object.freeze({
    proofId: authority.proofId,
    commitment: authority.commitment,
  })))
  const chunk = Object.freeze({
    kindCode: ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
    bindings,
  })
  PREPARED_CHUNK_AUTHORITIES.set(chunk, canonical)
  return chunk
}

export async function prepareEncryptedWalletBackupObject(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  chunk: PreparedEncryptedWalletBackupProofChunk
  generation: number
  runtime?: EncryptedWalletBackupRuntime
  objectIdExists?: (objectId: string) => boolean | Promise<boolean>
}): Promise<PreparedEncryptedWalletBackupObject> {
  const authority = requireKeyAuthority(input.keyHandle)
  const chunkBytes = requireChunkAuthority(input.chunk)
  const generation = requireInteger(input.generation, 1, Number.MAX_SAFE_INTEGER, 'backup generation')
  const runtime = input.runtime === undefined ? authority.runtime : requireRuntime(input.runtime)
  let objectIdBytes: Uint8Array | undefined
  let objectId: string | undefined
  for (let attempt = 0; attempt < OBJECT_ID_COLLISION_ATTEMPTS; attempt += 1) {
    const candidate = randomBytes(runtime, 16)
    const candidateId = bytesToHex(candidate)
    if (authority.preparedObjectIds.has(candidateId)) continue
    authority.preparedObjectIds.add(candidateId)
    try {
      if (input.objectIdExists !== undefined && await input.objectIdExists(candidateId)) {
        authority.preparedObjectIds.delete(candidateId)
        continue
      }
    } catch (error) {
      authority.preparedObjectIds.delete(candidateId)
      throw error
    }
    objectIdBytes = candidate
    objectId = candidateId
    break
  }
  if (objectIdBytes === undefined || objectId === undefined) {
    throw new Error('backup object id collision limit exceeded')
  }
  try {
    const nonce = randomBytes(runtime, 12)
    const aad = encodeCanonical([
      1,
      ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
      authority.realm,
      authority.vaultIdBytes,
      objectIdBytes,
      generation,
      ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES,
    ])
    const objectKey = await hkdf(
      runtime.subtle,
      authority.encryptionRoot,
      objectIdBytes,
      encodeCanonical([
        1, 'object-key', authority.realm, authority.vaultIdBytes,
        ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
      ]),
    )
    const frame = new Uint8Array(ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES)
    writeUint32(frame, 0, chunkBytes.byteLength)
    frame.set(chunkBytes, 4)
    const key = await runtime.subtle.importKey('raw', asArrayBuffer(objectKey), 'AES-GCM', false, ['encrypt'])
    const encrypted = new Uint8Array(await runtime.subtle.encrypt({
      name: 'AES-GCM',
      iv: asArrayBuffer(nonce),
      additionalData: asArrayBuffer(aad),
      tagLength: 128,
    }, key, frame))
    const body = concatBytes(nonce, encrypted)
    const digest = bytesToHex(sha256(concatBytes(uint32Bytes(aad.byteLength), aad, body)))
    const prepared = Object.freeze({
      formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
      kindCode: ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
      realm: authority.realm,
      vaultId: bytesToHex(authority.vaultIdBytes),
      objectId,
      generation,
      paddedLength: ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES,
      digest,
    })
    PREPARED_OBJECT_AUTHORITIES.set(prepared, { aad, body })
    return prepared
  } catch (error) {
    authority.preparedObjectIds.delete(objectId)
    throw error
  }
}

export function readPreparedEncryptedWalletBackupObject(
  prepared: PreparedEncryptedWalletBackupObject,
): EncryptedWalletBackupWireObject {
  const authority = typeof prepared === 'object' && prepared !== null
    ? PREPARED_OBJECT_AUTHORITIES.get(prepared)
    : undefined
  if (authority === undefined) throw new Error('prepared backup object is invalid')
  return {
    ...prepared,
    aad: authority.aad.slice(),
    body: authority.body.slice(),
  }
}

export async function decryptEncryptedWalletBackupProofChunk(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  object: EncryptedWalletBackupWireObject
  cooperativeYield?: () => void | Promise<void>
}): Promise<DecryptedEncryptedWalletBackupProofChunk> {
  try {
    const records = await decryptProofChunk(input)
    const handle = Object.freeze({
      formatVersion: ENCRYPTED_WALLET_BACKUP_FORMAT_VERSION,
      kindCode: ENCRYPTED_WALLET_BACKUP_PROOF_CHUNK_KIND,
      recordCount: records.length,
    })
    DECRYPTED_PROOF_CHUNK_AUTHORITIES.set(handle, { records })
    return handle
  } catch {
    throw new Error('corrupt encrypted wallet backup object')
  }
}

async function decryptProofChunk(input: {
  keyHandle: EncryptedWalletBackupKeyHandle
  seed: Uint8Array
  object: EncryptedWalletBackupWireObject
  cooperativeYield?: () => void | Promise<void>
}): Promise<UnverifiedEncryptedWalletBackupProof[]> {
  const authority = requireKeyAuthority(input.keyHandle)
  const seed = requireSeed(input.seed)
  if (!equalBytes(authority.seedDigest, sha256(seed))) throw new Error('foreign seed')
  const object = requireWireObject(input.object, authority)
  const objectId = hexToBytes(object.objectId)
  const expectedAad = encodeCanonical([
    1, 1, authority.realm, authority.vaultIdBytes, objectId,
    object.generation, ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES,
  ])
  if (!equalBytes(expectedAad, object.aad)) throw new Error('foreign aad')
  const expectedDigest = bytesToHex(sha256(concatBytes(
    uint32Bytes(object.aad.byteLength), object.aad, object.body,
  )))
  if (expectedDigest !== object.digest) throw new Error('digest mismatch')
  const objectKey = await hkdf(
    authority.runtime.subtle,
    authority.encryptionRoot,
    objectId,
    encodeCanonical([1, 'object-key', authority.realm, authority.vaultIdBytes, 1]),
  )
  const key = await authority.runtime.subtle.importKey(
    'raw', asArrayBuffer(objectKey), 'AES-GCM', false, ['decrypt'],
  )
  const frame = new Uint8Array(await authority.runtime.subtle.decrypt({
    name: 'AES-GCM',
    iv: asArrayBuffer(object.body.slice(0, 12)),
    additionalData: asArrayBuffer(object.aad),
    tagLength: 128,
  }, key, asArrayBuffer(object.body.slice(12))))
  if (frame.byteLength !== ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES) throw new Error('frame length')
  const cborLength = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false)
  if (cborLength < 1 || cborLength > ENCRYPTED_WALLET_BACKUP_PROOF_CBOR_MAX_BYTES
    || cborLength > frame.byteLength - 4) throw new Error('cbor length')
  for (let index = 4 + cborLength; index < frame.byteLength; index += 1) {
    if (frame[index] !== 0) throw new Error('padding')
  }
  const canonical = frame.slice(4, 4 + cborLength)
  preflightProofChunk(canonical)
  const decoded = decode(canonical)
  const reencoded = encodeCanonical(decoded)
  if (!equalBytes(canonical, reencoded)) throw new Error('noncanonical cbor')
  return decodeProofChunkRecords(decoded, seed, input.cooperativeYield)
}

async function decodeProofChunkRecords(
  value: unknown,
  seed: Uint8Array,
  cooperativeYield: (() => void | Promise<void>) | undefined,
): Promise<UnverifiedEncryptedWalletBackupProof[]> {
  if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1 || value[1] !== 1
    || !Array.isArray(value[2]) || value[2].length < 1
    || value[2].length > ENCRYPTED_WALLET_BACKUP_PROOF_COUNT_MAX) throw new Error('root')
  const records = value[2]
  const derivers = new Map<string, SecretDeriver>()
  const restored: UnverifiedEncryptedWalletBackupProof[] = []
  const yieldToHost = cooperativeYield ?? defaultCooperativeYield
  for (let index = 0; index < records.length; index += 1) {
    restored.push(decodeProofRecord(records[index], seed, derivers))
    // Four-record work slices keep legacy BIP-32 derivation comfortably below
    // a browser long-task budget on the measured corpus; this is a work bound,
    // not a latency guarantee.
    if ((index + 1) % 4 === 0 && index + 1 < records.length) await yieldToHost()
  }
  for (let index = 1; index < restored.length; index += 1) {
    if (compareHex(restored[index - 1]!.proofId, restored[index]!.proofId) >= 0) {
      throw new Error('proof order')
    }
  }
  return restored
}

function decodeProofRecord(
  value: unknown,
  seed: Uint8Array,
  derivers: Map<string, SecretDeriver>,
): UnverifiedEncryptedWalletBackupProof {
  if (!Array.isArray(value) || value.length !== 14) throw new Error('record')
  const [proofIdRaw, commitmentRaw, mintRaw, unitRaw, keysetRaw, amountRaw, secretRaw,
    signatureRaw, dleqRaw, counterRaw, proofKindRaw, ctfRaw, createdRaw, updatedRaw] = value
  const proofId = requireBytes(proofIdRaw, 32, 'proof id')
  const commitment = requireBytes(commitmentRaw, 32, 'commitment')
  const mint = requireNormalizedMint(mintRaw)
  const unit = requireBoundedText(unitRaw, 64, 'unit')
  const keyset = decodeKeysetWire(keysetRaw)
  const amount = requireAmount(amountRaw)
  const secretBytes = requireBytes(secretRaw, 64, 'secret')
  const secret = new TextDecoder('utf-8', { fatal: true }).decode(secretBytes)
  requireLowerHexSecret(secret)
  const signature = requireSignatureBytes(signatureRaw, keyset.curve)
  const dleq = requireDleqBytes(dleqRaw, keyset.curve)
  const counter = requireInteger(counterRaw, 0, 2_147_483_647, 'counter')
  if (proofKindRaw !== 0 && proofKindRaw !== 1) throw new Error('proof kind')
  const effectiveNow = 0
  const ctf = decodeCtfWire(ctfRaw, proofKindRaw, effectiveNow, false)
  const createdAt = requireNonNegativeSafeInteger(createdRaw, 'created')
  const updatedAt = requireNonNegativeSafeInteger(updatedRaw, 'updated')
  if (updatedAt < createdAt) throw new Error('timestamps')
  let deriver = derivers.get(keyset.text)
  if (deriver === undefined) {
    deriver = cashuSecretDeriver(seed, keyset.text)
    derivers.set(keyset.text, deriver)
  }
  if (bytesToHex(deriver(counter).secret) !== secret) throw new Error('secret derivation')
  const expectedProofId = deriveDurableCustodyProofId({
    normalizedMint: mint, unit, keysetId: keyset.identityText, secret,
  })
  if (bytesToHex(proofId) !== expectedProofId) throw new Error('proof id')
  const keysetWire = [keyset.kindCode, keyset.text]
  const commitmentPreimage = [
    1, 'proof-record-commitment', mint, unit, keysetWire, amount, secretBytes,
    signature, dleq, counter, proofKindRaw, ctf, createdAt, updatedAt,
  ]
  const expectedCommitment = sha256(encodeCanonical(commitmentPreimage))
  if (!equalBytes(commitment, expectedCommitment)) throw new Error('commitment')
  const proofBase = {
    id: keyset.text,
    amount,
    secret,
    C: bytesToHex(signature),
  }
  const proof: UnverifiedEncryptedWalletBackupProof['proof'] = dleq === null
    ? proofBase
    : {
        ...proofBase,
        dleq: { e: bytesToHex(dleq[0]), s: bytesToHex(dleq[1]), r: bytesToHex(dleq[2]) },
      }
  return {
    proofId: expectedProofId,
    commitment: bytesToHex(expectedCommitment),
    mint,
    unit,
    counter,
    encodedProofKind: proofKindRaw,
    ctfMetadata: ctf === null ? null : {
      conditionId: bytesToHex(ctf[0] as Uint8Array),
      outcomeLabel: ctf[1] as string,
      outcomeCollectionId: bytesToHex(ctf[2] as Uint8Array),
      registeredAtUnixSeconds: ctf[3] as number,
      finalExpiryUnixSeconds: ctf[4] as number,
    },
    createdAtUnixSeconds: createdAt,
    updatedAtUnixSeconds: updatedAt,
    proof,
  }
}

function defaultCooperativeYield(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function requireWireObject(
  value: unknown,
  authority: KeyAuthority,
): EncryptedWalletBackupWireObject {
  const object = requireRecord(value, 'wire object')
  requireKnownFields(object, [
    'formatVersion', 'kindCode', 'realm', 'vaultId', 'objectId', 'generation',
    'paddedLength', 'digest', 'aad', 'body',
  ])
  if (object.formatVersion !== 1 || object.kindCode !== 1
    || object.realm !== authority.realm || object.vaultId !== bytesToHex(authority.vaultIdBytes)
    || object.paddedLength !== ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES) throw new Error('metadata')
  const objectId = requireLowerHex(object.objectId, 16, 'object id')
  const digest = requireLowerHex(object.digest, 32, 'digest')
  const generation = requireInteger(object.generation, 1, Number.MAX_SAFE_INTEGER, 'generation')
  const aad = requireBytesRange(object.aad, 1, 4_096, 'aad')
  const body = requireBytes(object.body, ENCRYPTED_WALLET_BACKUP_BODY_BYTES, 'body')
  return {
    formatVersion: 1,
    kindCode: 1,
    realm: authority.realm,
    vaultId: bytesToHex(authority.vaultIdBytes),
    objectId,
    generation,
    paddedLength: ENCRYPTED_WALLET_BACKUP_PROOF_FRAME_BYTES,
    digest,
    aad,
    body,
  }
}

interface KeysetId {
  kindCode: 0 | 1 | 2
  text: string
  identityText: string
  curve: 'secp256k1' | 'bls12-381'
}

function decodeKeysetId(value: unknown): KeysetId {
  if (typeof value !== 'string') throw new Error('backup proof keyset is invalid')
  if (/^(?:01|02)[0-9a-f]{14}$/.test(value)) throw new Error('unresolved short modern keyset')
  if (/^00[0-9a-f]{14}$/.test(value)) {
    return { kindCode: 1, text: value, identityText: value, curve: 'secp256k1' }
  }
  if (/^(?:01|02)[0-9a-f]{64}$/.test(value)) {
    return {
      kindCode: 2,
      text: value,
      identityText: value,
      curve: value.startsWith('02') ? 'bls12-381' : 'secp256k1',
    }
  }
  if (/^[0-9a-fA-F]+$/.test(value)) throw new Error('backup proof keyset is invalid')
  if (isCashuLegacyBase64(value)) {
    return {
      kindCode: 0,
      text: value,
      identityText: `legacy:${bytesToHex(base64Decode(value.replace(/=+$/, '')))}`,
      curve: 'secp256k1',
    }
  }
  throw new Error('backup proof keyset is invalid')
}

function decodeKeysetWire(value: unknown): KeysetId {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('keyset wire')
  const decoded = decodeKeysetId(value[1])
  if (decoded.kindCode !== value[0]) throw new Error('keyset tag')
  return decoded
}

function isCashuLegacyBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length > 128) return false
  if (/[+/]/.test(value) && /[-_]/.test(value)) return false
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (normalized.length % 4 === 1) return false
  try {
    const decoded = base64Decode(normalized)
    const standard = base64Encode(decoded).replace(/=+$/, '')
    return standard === normalized
  } catch {
    return false
  }
}

function decodeCtfMetadata(
  value: EncryptedWalletBackupCtfMetadata | null,
  proofKindCode: number,
  effectiveNow: number,
): null | [Uint8Array, string, Uint8Array, number, number] {
  if (proofKindCode === 0) {
    if (value !== null) throw new Error('ordinary proof cannot contain CTF metadata')
    return null
  }
  if (value === null) throw new Error('CTF metadata is invalid')
  const record = requireRecord(value, 'CTF metadata')
  requireKnownFields(record, [
    'conditionId', 'outcomeLabel', 'outcomeCollectionId',
    'registeredAtUnixSeconds', 'finalExpiryUnixSeconds',
  ])
  const conditionId = hexToBytes(requireLowerHex(record.conditionId, 32, 'condition id'))
  const outcomeLabel = requireBoundedText(record.outcomeLabel, 256, 'CTF outcome label')
  const collectionId = hexToBytes(requireLowerHex(record.outcomeCollectionId, 32, 'outcome collection id'))
  const registeredAt = requireNonNegativeSafeInteger(record.registeredAtUnixSeconds, 'CTF registration time')
  const finalExpiry = requireNonNegativeSafeInteger(record.finalExpiryUnixSeconds, 'CTF final expiry')
  if (finalExpiry <= effectiveNow) throw new Error('CTF proof is expired')
  return [conditionId, outcomeLabel, collectionId, registeredAt, finalExpiry]
}

function ctfTupleToMetadata(
  value: [Uint8Array, string, Uint8Array, number, number],
): EncryptedWalletBackupCtfMetadata {
  return {
    conditionId: bytesToHex(value[0]),
    outcomeLabel: value[1],
    outcomeCollectionId: bytesToHex(value[2]),
    registeredAtUnixSeconds: value[3],
    finalExpiryUnixSeconds: value[4],
  }
}

function decodeCtfWire(
  value: unknown,
  proofKindCode: number,
  effectiveNow: number,
  enforceExpiry: boolean,
): null | [Uint8Array, string, Uint8Array, number, number] {
  if (proofKindCode === 0) {
    if (value !== null) throw new Error('ctf wire')
    return null
  }
  if (!Array.isArray(value) || value.length !== 5) throw new Error('ctf wire')
  const conditionId = requireBytes(value[0], 32, 'condition id')
  const label = requireBoundedText(value[1], 256, 'outcome')
  const collectionId = requireBytes(value[2], 32, 'collection id')
  const registered = requireNonNegativeSafeInteger(value[3], 'registration')
  const expiry = requireNonNegativeSafeInteger(value[4], 'expiry')
  if (enforceExpiry && expiry <= effectiveNow) throw new Error('expired')
  return [conditionId, label, collectionId, registered, expiry]
}

function requireDleq(value: unknown, curve: KeysetId['curve']): null | [Uint8Array, Uint8Array, Uint8Array] {
  if (curve === 'bls12-381') {
    if (value !== undefined && value !== null) throw new Error('BLS proof cannot contain DLEQ')
    return null
  }
  const record = requireRecord(value, 'proof DLEQ')
  requireKnownFields(record, ['e', 's', 'r'])
  return [
    hexToBytes(requireLowerHex(record.e, 32, 'DLEQ e')),
    hexToBytes(requireLowerHex(record.s, 32, 'DLEQ s')),
    hexToBytes(requireLowerHex(record.r, 32, 'DLEQ r')),
  ]
}

function requireDleqBytes(value: unknown, curve: KeysetId['curve']): null | [Uint8Array, Uint8Array, Uint8Array] {
  if (curve === 'bls12-381') {
    if (value !== null) throw new Error('dleq')
    return null
  }
  if (!Array.isArray(value) || value.length !== 3) throw new Error('dleq')
  return [
    requireBytes(value[0], 32, 'dleq e'),
    requireBytes(value[1], 32, 'dleq s'),
    requireBytes(value[2], 32, 'dleq r'),
  ]
}

function requireSignature(value: unknown, curve: KeysetId['curve']): Uint8Array {
  const bytes = hexToBytes(requireLowerHex(value, curve === 'bls12-381' ? 48 : 33, 'proof signature'))
  return bytes
}

function requireSignatureBytes(value: unknown, curve: KeysetId['curve']): Uint8Array {
  return requireBytes(value, curve === 'bls12-381' ? 48 : 33, 'signature')
}

function requireAmount(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new Error('backup proof amount is invalid')
  }
  let amount: bigint
  try { amount = BigInt(value) } catch { throw new Error('backup proof amount is invalid') }
  if (amount > UINT64_MAX) throw new Error('backup proof amount is invalid')
  return value
}

function requireLowerHexSecret(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('backup proof secret is invalid')
  }
  return value
}

function requireNormalizedMint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('normalized mint is invalid')
  let parsed: URL
  try { parsed = new URL(value) } catch { throw new Error('normalized mint is invalid') }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username !== '' || parsed.password !== '' || parsed.search !== '' || parsed.hash !== ''
    || /%[0-9a-f]{2}/i.test(parsed.pathname)) throw new Error('normalized mint is invalid')
  const normalized = parsed.href.replace(/\/+$/, '')
  if (normalized !== value || new TextEncoder().encode(normalized).byteLength > 2_048) {
    throw new Error('normalized mint is invalid')
  }
  return normalized
}

function requireBoundedText(value: unknown, maxBytes: number, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || hasInvalidText(value)) {
    throw new Error(`${name} is invalid`)
  }
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength > maxBytes) throw new Error(`${name} is invalid`)
  return value
}

function hasInvalidText(value: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return true
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function requireRealm(value: unknown): string {
  if (typeof value !== 'string' || !REALM_PATTERN.test(value)) throw new Error('backup realm is invalid')
  return value
}

function requireSeed(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== 64) throw new Error('backup seed is invalid')
  return value.slice()
}

function requireRuntime(value: EncryptedWalletBackupRuntime | undefined): EncryptedWalletBackupRuntime {
  const runtime = value ?? globalThis.crypto
  if (runtime === undefined || typeof runtime.getRandomValues !== 'function'
    || runtime.subtle === undefined) throw new Error('encrypted backup crypto runtime is unavailable')
  return {
    subtle: runtime.subtle,
    getRandomValues: (target) => runtime.getRandomValues(target),
  }
}

function requireKeyAuthority(value: unknown): KeyAuthority {
  if (typeof value !== 'object' || value === null) throw new Error('backup key handle is invalid')
  const authority = KEY_AUTHORITIES.get(value)
  if (authority === undefined) throw new Error('backup key handle is invalid')
  return authority
}

function requireProofAuthority(value: unknown): PreparedProofAuthority {
  if (typeof value !== 'object' || value === null) throw new Error('prepared backup proof handle is invalid')
  const authority = PREPARED_PROOF_AUTHORITIES.get(value)
  if (authority === undefined) throw new Error('prepared backup proof handle is invalid')
  return authority
}

function requireChunkAuthority(value: unknown): Uint8Array {
  if (typeof value !== 'object' || value === null) throw new Error('proof chunk handle is invalid')
  const authority = PREPARED_CHUNK_AUTHORITIES.get(value)
  if (authority === undefined) throw new Error('proof chunk handle is invalid')
  return authority
}

async function deriveRequestAuthScalar(
  subtle: SubtleCrypto,
  requestAuthRoot: Uint8Array,
  realm: string,
): Promise<Uint8Array> {
  for (let counter = 0; counter < REQUEST_SCALAR_ATTEMPTS; counter += 1) {
    const candidate = await hkdf(
      subtle,
      requestAuthRoot,
      ROOT_SALT,
      encodeCanonical([1, 'request-auth-scalar', realm, counter]),
    )
    const scalar = bytesToBigInt(candidate)
    if (scalar > 0n && scalar < SECP256K1_ORDER) return candidate
  }
  throw new Error('request authentication scalar derivation exhausted')
}

async function hkdf(
  subtle: SubtleCrypto,
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
): Promise<Uint8Array> {
  const key = await subtle.importKey('raw', asArrayBuffer(ikm), 'HKDF', false, ['deriveBits'])
  const bits = await subtle.deriveBits({
    name: 'HKDF', hash: 'SHA-256', salt: asArrayBuffer(salt), info: asArrayBuffer(info),
  }, key, 256)
  return new Uint8Array(bits)
}

function randomBytes(runtime: EncryptedWalletBackupRuntime, length: number): Uint8Array {
  const result = new Uint8Array(length)
  const returned = runtime.getRandomValues(result)
  if (returned !== result || result.byteLength !== length) throw new Error('crypto runtime returned invalid randomness')
  return result
}

function cashuSecretDeriver(seed: Uint8Array, keysetId: string): SecretDeriver {
  const create = (Cashu as unknown as {
    createSecretAndBlindingFactorDeriver(seed: Uint8Array, keysetId: string): SecretDeriver
  }).createSecretAndBlindingFactorDeriver
  if (typeof create !== 'function') throw new Error('cashu derivation is unavailable')
  return create(seed, keysetId)
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} is invalid`)
  return value as Record<string, unknown>
}

function requireKnownFields(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(record)) {
    if (!required.includes(key) && !optional.includes(key)) throw new Error('unsupported proof field')
  }
  for (const key of required) if (!(key in record)) throw new Error(`missing required field '${key}'`)
}

function requireNonNegativeSafeInteger(value: unknown, name: string): number {
  return requireInteger(value, 0, Number.MAX_SAFE_INTEGER, name)
}

function requireInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${name} is invalid`)
  return value
}

function requireOneOfValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  name: string,
): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${name} is invalid`)
  return value as T[number]
}

function decodeProofPins(value: unknown): EncryptedWalletBackupProofPins {
  const pins = requireRecord(value, 'stored proof pins')
  requireKnownFields(pins, [
    'openOrderCollateral', 'outbox', 'retryCursor', 'replayTombstone', 'dependentWork',
  ])
  const state = (entry: unknown, name: string) => requireOneOfValue(
    entry, ['absent', 'present', 'unknown'] as const, name,
  )
  return Object.freeze({
    openOrderCollateral: state(pins.openOrderCollateral, 'stored collateral pin'),
    outbox: state(pins.outbox, 'stored outbox pin'),
    retryCursor: state(pins.retryCursor, 'stored retry pin'),
    replayTombstone: state(pins.replayTombstone, 'stored replay pin'),
    dependentWork: state(pins.dependentWork, 'stored dependency pin'),
  })
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function'
}

function requireLowerHex(value: unknown, bytes: number, name: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireBytes(value: unknown, length: number, name: string): Uint8Array {
  return requireBytesRange(value, length, length, name)
}

function requireBytesRange(value: unknown, minimum: number, maximum: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function bytesToBigInt(value: Uint8Array): bigint {
  let result = 0n
  for (const byte of value) result = (result << 8n) | BigInt(byte)
  return result
}

function compareHex(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

function writeUint32(target: Uint8Array, offset: number, value: number): void {
  new DataView(target.buffer, target.byteOffset, target.byteLength).setUint32(offset, value, false)
}

function uint32Bytes(value: number): Uint8Array {
  const result = new Uint8Array(4)
  writeUint32(result, 0, value)
  return result
}

function concatBytes(...values: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0))
  let offset = 0
  for (const value of values) { result.set(value, offset); offset += value.byteLength }
  return result
}

function asArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer
}

function base64Decode(value: string): Uint8Array {
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4)
  const text = atob(padded)
  return Uint8Array.from(text, (character) => character.charCodeAt(0))
}

function base64Encode(value: Uint8Array): string {
  let text = ''
  for (const byte of value) text += String.fromCharCode(byte)
  return btoa(text)
}
