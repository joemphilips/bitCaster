import { decode } from 'cborg'
import type { Proof } from '@cashu/cashu-ts'
import {
  decryptEncryptedWalletBackupV2TransportBundle,
  prepareEncryptedWalletBackupV2TransportBundle,
  type EncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2AssetIdentity,
  type EncryptedWalletBackupV2BundleObjectWire,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2PreparedTransportBundle,
} from './encryptedWalletBackupV2Bundle.ts'
import { ENCRYPTED_WALLET_BACKUP_V2_UINT64_MAX } from './encryptedWalletBackupV2Descriptor.ts'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import { deriveDurableCustodyScopeId, deriveDurableCustodyWalletId } from './durableCustody.ts'
import {
  createDurableCustodyProofMaterialRecord,
  deserializeDurableCustodyProofArtifact,
  serializeDurableCustodyProofArtifact,
} from './durableCustodyProofMaterial.ts'
import {
  decodeDurableWalletProofDerivationLocator,
  decodeDurableWalletProofDerivationLocatorCbor,
  deriveDurableWalletProofSecret,
  encodeDurableWalletProofDerivationLocatorCbor,
  type DurableWalletProofDerivationLocator,
} from './durableWalletProofDerivationLocator.ts'
import {
  deriveEncryptedWalletBackupV2AssetLocator,
  type EncryptedWalletBackupV2KeyHandle,
} from './encryptedWalletBackupV2Keys.ts'
import { requireEncryptedWalletBackupV2SeedHandleMatch } from './encryptedWalletBackupV2KeyAuthority.ts'
import {
  equalBytes,
  requireLowerHex,
  requireUtf8Text,
} from './encryptedWalletBackupServerValidation.ts'
import { canonicalizeMintIdentityUrl } from './tokenImportValidation.ts'

export const ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX = 512 as const
export const ENCRYPTED_WALLET_BACKUP_V2_COUNTER_MAX = 512 as const
export const ENCRYPTED_WALLET_BACKUP_V2_COUNTER_VALUE_MAX = 2_147_483_648 as const

const PAYLOAD_VERSION = 1
const PAYLOAD_KIND = 'encrypted-wallet-backup-v2-proof-set'
const PAYLOAD_MAX_BYTES = 3_931_904
const MINT_MAX_BYTES = 2_048
const OUTCOME_MAX_BYTES = 256
const PREFLIGHT_TOKEN_MAX = 65_536

export type EncryptedWalletBackupV2ProofSetAsset =
  | { readonly kind: 'ordinary' }
  | {
      readonly kind: 'ctf'
      readonly conditionId: string
      readonly outcomeLabel: string
      readonly outcomeCollectionId: string
      readonly registeredAt: number
      readonly finalExpiry: number | null
    }

export interface EncryptedWalletBackupV2ProofSetProof {
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly asset: EncryptedWalletBackupV2ProofSetAsset
  readonly proof: Proof
  readonly locator: DurableWalletProofDerivationLocator
}

export interface EncryptedWalletBackupV2CounterHighWaterMark {
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly keysetId: string
  readonly nextCounter: number
}

export interface EncryptedWalletBackupV2UnverifiedProofSet {
  readonly proofs: readonly (EncryptedWalletBackupV2ProofSetProof & { readonly proofId: string })[]
  readonly counterHighWaterMarks: readonly EncryptedWalletBackupV2CounterHighWaterMark[]
}

export interface EncryptedWalletBackupV2RestoreKeyset {
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly keysetId: string
  readonly keyset: unknown
  readonly requireDleq: boolean
  verify(): boolean
}

export interface EncryptedWalletBackupV2RestoreVerificationPort {
  resolveKeyset(input: {
    readonly mintUrl: string
    readonly unit: 'sat' | 'msat'
    readonly keysetId: string
  }): Promise<EncryptedWalletBackupV2RestoreKeyset>
  verifyProofs(input: {
    readonly proofs: readonly Proof[]
    readonly keysets: ReadonlyMap<string, EncryptedWalletBackupV2RestoreKeyset>
  }): void
  checkProofStates(input: {
    readonly mintUrl: string
    readonly proofs: readonly {
      readonly proofId: string
      readonly id: string
      readonly secret: string
    }[]
  }): Promise<readonly { readonly proofId: string; readonly state: string }[]>
}

export interface EncryptedWalletBackupV2VerifiedProofSet extends EncryptedWalletBackupV2UnverifiedProofSet {
  readonly verified: true
}

const VERIFIED_RESTORED_PROOF_SETS = new WeakMap<object, EncryptedWalletBackupV2VerifiedProofSet>()

export function requireEncryptedWalletBackupV2VerifiedProofSet(
  value: unknown,
): EncryptedWalletBackupV2VerifiedProofSet {
  if (typeof value !== 'object' || value === null || !VERIFIED_RESTORED_PROOF_SETS.has(value))
    throw new Error('encrypted backup V2 verified proof set is invalid')
  return VERIFIED_RESTORED_PROOF_SETS.get(value)!
}

/** Verify detached V2 material before a client can persist it as custody. */
export async function verifyEncryptedWalletBackupV2RestoredProofSet(input: {
  readonly seed: Uint8Array
  readonly expectedAsset: EncryptedWalletBackupV2AssetIdentity
  readonly unverified: EncryptedWalletBackupV2UnverifiedProofSet
  readonly port: EncryptedWalletBackupV2RestoreVerificationPort
}): Promise<EncryptedWalletBackupV2VerifiedProofSet> {
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(input.expectedAsset)
  const seed = input.seed
  const decoded = validateProofSet({
    seed,
    proofs: input.unverified.proofs.map(withoutProofId),
    counterHighWaterMarks: input.unverified.counterHighWaterMarks,
  })
  assertProofSetAsset(decoded.proofs, asset)
  const keysets = await resolveRestoreKeysets(decoded.proofs, input.port)
  input.port.verifyProofs({ proofs: decoded.proofs.map(({ proof }) => proof), keysets })
  await requireUnspentRestoreProofs(decoded.proofs, input.port)
  const verified = freezeVerifiedProofSet(decoded)
  VERIFIED_RESTORED_PROOF_SETS.set(verified, verified)
  return verified
}

function withoutProofId(entry: EncryptedWalletBackupV2UnverifiedProofSet['proofs'][number]) {
  const { proofId: _proofId, ...encoded } = entry
  return encoded
}

async function resolveRestoreKeysets(
  proofs: readonly DecodedProofEntry[],
  port: EncryptedWalletBackupV2RestoreVerificationPort,
) {
  const keysets = new Map<string, EncryptedWalletBackupV2RestoreKeyset>()
  for (const proof of proofs) {
    if (keysets.has(proof.proof.id)) continue
    const keyset = await port.resolveKeyset({
      mintUrl: proof.mintUrl,
      unit: proof.unit,
      keysetId: proof.proof.id,
    })
    if (
      keyset.mintUrl !== proof.mintUrl ||
      keyset.unit !== proof.unit ||
      keyset.keysetId !== proof.proof.id ||
      !keyset.verify()
    )
      throw new Error('encrypted backup V2 restored keyset is invalid')
    keysets.set(proof.proof.id, keyset)
  }
  return keysets
}

async function requireUnspentRestoreProofs(
  proofs: readonly DecodedProofEntry[],
  port: EncryptedWalletBackupV2RestoreVerificationPort,
): Promise<void> {
  const states = await port.checkProofStates({
    mintUrl: proofs[0]!.mintUrl,
    proofs: proofs.map(({ proof, proofId }) => ({ proofId, id: proof.id, secret: proof.secret })),
  })
  if (states.length !== proofs.length)
    throw new Error('encrypted backup V2 restored proof state is invalid')
  const expected = new Set(proofs.map(({ proofId }) => proofId))
  const observed = new Set<string>()
  for (const { proofId, state } of states) {
    if (!expected.has(proofId) || observed.has(proofId) || state !== 'UNSPENT')
      throw new Error('encrypted backup V2 restored proof state is not unspent')
    observed.add(proofId)
  }
  if (observed.size !== expected.size)
    throw new Error('encrypted backup V2 restored proof state is invalid')
}

/** Encrypts deterministic proof material. The result is not proof admission authority. */
export async function prepareEncryptedWalletBackupV2ProofSetBundle(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly seed: Uint8Array
  readonly asset: EncryptedWalletBackupV2AssetIdentity
  readonly proofs: readonly EncryptedWalletBackupV2ProofSetProof[]
  readonly custodyRevision: bigint
  readonly counterHighWaterMarks: readonly EncryptedWalletBackupV2CounterHighWaterMark[]
  readonly runtime: EncryptedWalletBackupV2BundleRuntime
  readonly bundleIdExists?: (bundleId: string) => boolean | Promise<boolean>
}): Promise<EncryptedWalletBackupV2PreparedTransportBundle> {
  const seed = await requireEncryptedWalletBackupV2SeedHandleMatch(input)
  const decoded = validateProofSet({
    seed,
    proofs: input.proofs,
    counterHighWaterMarks: input.counterHighWaterMarks,
  })
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(input.asset)
  assertProofSetAsset(decoded.proofs, asset)
  const declaredAmount = sumProofAmounts(decoded.proofs)
  const canonicalPayload = encodeProofSetPayload(decoded)
  preflightProofSetPayload(canonicalPayload)
  return prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle: input.keyHandle,
    asset,
    declaredAmount,
    custodyRevision: input.custodyRevision,
    canonicalPayload,
    runtime: input.runtime,
    bundleIdExists: input.bundleIdExists,
  })
}

/** Restores unverified proof material. Verify mint signatures, DLEQ, keysets, and NUT-07 first. */
export async function decryptEncryptedWalletBackupV2ProofSetBundle(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly seed: Uint8Array
  readonly expectedAsset: EncryptedWalletBackupV2AssetIdentity
  readonly custodyRevision: bigint
  readonly runtime: EncryptedWalletBackupV2BundleRuntime
  readonly descriptor: EncryptedWalletBackupV2BundleDescriptor
  readonly objects: readonly EncryptedWalletBackupV2BundleObjectWire[]
}): Promise<EncryptedWalletBackupV2UnverifiedProofSet> {
  const descriptor = snapshotDescriptor(input.descriptor)
  const seed = await requireEncryptedWalletBackupV2SeedHandleMatch(input)
  const expectedAsset = decodeEncryptedWalletBackupV2AssetIdentity(input.expectedAsset)
  const expectedAssetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: input.keyHandle,
    ...expectedAsset,
  })
  if (expectedAssetLocator !== descriptor.assetLocator)
    throw new Error('encrypted backup proof set asset is foreign')
  if (descriptor.custodyRevision !== input.custodyRevision)
    throw new Error('encrypted backup proof set custody metadata is foreign')
  const payload = await decryptEncryptedWalletBackupV2TransportBundle({
    keyHandle: input.keyHandle,
    runtime: input.runtime,
    descriptor,
    objects: input.objects,
  })
  const decoded = decodeProofSetPayload(payload, seed)
  assertProofSetAsset(decoded.proofs, expectedAsset)
  if (sumProofAmounts(decoded.proofs) !== descriptor.declaredAmount)
    throw new Error('encrypted backup proof set declared amount is invalid')
  return cloneUnverifiedProofSet(decoded)
}

function validateProofSet(input: {
  readonly seed: Uint8Array
  readonly proofs: readonly EncryptedWalletBackupV2ProofSetProof[]
  readonly counterHighWaterMarks: readonly EncryptedWalletBackupV2CounterHighWaterMark[]
}): DecodedProofSet {
  if (
    !Array.isArray(input.proofs) ||
    input.proofs.length < 1 ||
    input.proofs.length > ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX
  ) {
    throw new Error('encrypted backup proof set proofs are invalid')
  }
  if (
    !Array.isArray(input.counterHighWaterMarks) ||
    input.counterHighWaterMarks.length > ENCRYPTED_WALLET_BACKUP_V2_COUNTER_MAX
  ) {
    throw new Error('encrypted backup proof set counters are invalid')
  }
  const scopeId = walletScopeId(input.seed)
  const proofs = input.proofs.map((proof) => decodeProofEntry(proof, input.seed, scopeId))
  if (new Set(proofs.map((proof) => proof.proofId)).size !== proofs.length) {
    throw new Error('encrypted backup proof set proofs are duplicated')
  }
  const counters = input.counterHighWaterMarks.map(decodeCounter)
  const counterByTuple = new Map(counters.map((counter) => [counterTuple(counter), counter]))
  if (counterByTuple.size !== counters.length)
    throw new Error('encrypted backup proof set counters are duplicated')
  for (const proof of proofs) {
    if (proof.locator.kind !== 'nut13') continue
    const counter = counterByTuple.get(counterTuple({ ...proof, keysetId: proof.locator.keysetId }))
    if (counter === undefined || counter.nextCounter <= proof.locator.counter) {
      throw new Error('encrypted backup NUT-13 counter authority is absent or low')
    }
  }
  return { proofs: Object.freeze(proofs), counterHighWaterMarks: Object.freeze(counters) }
}

function decodeProofEntry(value: unknown, seed: Uint8Array, scopeId: string): DecodedProofEntry {
  if (!isRecord(value) || !exactKeys(value, ['mintUrl', 'unit', 'asset', 'proof', 'locator'])) {
    throw new Error('encrypted backup proof set proof is invalid')
  }
  const mintUrl = requireCanonicalMint(value.mintUrl)
  const unit = requireUnit(value.unit)
  const asset = decodeAsset(value.asset)
  const locator = decodeDurableWalletProofDerivationLocator(value.locator)
  const proof = deserializeDurableCustodyProofArtifact(
    serializeDurableCustodyProofArtifact(value.proof as Proof),
  )
  const material = createDurableCustodyProofMaterialRecord({
    scopeId,
    normalizedMint: mintUrl,
    unit,
    proof: serializeDurableCustodyProofArtifact(proof),
  })
  const expectedSecret = deriveDurableWalletProofSecret({
    seed,
    locator,
    proofKeysetId: material.keysetId,
    proofAmount: material.amount,
  })
  if (proof.secret !== expectedSecret)
    throw new Error('encrypted backup proof provenance is foreign')
  return Object.freeze({
    mintUrl,
    unit,
    asset,
    proof,
    locator,
    proofId: material.proofId,
    amount: BigInt(material.amount),
  })
}

function decodeCounter(value: unknown): EncryptedWalletBackupV2CounterHighWaterMark {
  if (!isRecord(value) || !exactKeys(value, ['mintUrl', 'unit', 'keysetId', 'nextCounter'])) {
    throw new Error('encrypted backup proof set counter is invalid')
  }
  if (
    typeof value.nextCounter !== 'number' ||
    !Number.isSafeInteger(value.nextCounter) ||
    value.nextCounter < 0 ||
    value.nextCounter > ENCRYPTED_WALLET_BACKUP_V2_COUNTER_VALUE_MAX
  ) {
    throw new Error('encrypted backup proof set counter is invalid')
  }
  const keyset = decodeDurableWalletProofDerivationLocator({
    schemaVersion: 1,
    kind: 'nut13',
    keysetId: value.keysetId,
    counter: 0,
  })
  if (keyset.kind !== 'nut13') throw new Error('encrypted backup proof set counter is invalid')
  return Object.freeze({
    mintUrl: requireCanonicalMint(value.mintUrl),
    unit: requireUnit(value.unit),
    keysetId: keyset.keysetId,
    nextCounter: value.nextCounter,
  })
}

function encodeProofSetPayload(value: DecodedProofSet): Uint8Array {
  const payload = encodeCanonicalBackupCbor([
    PAYLOAD_VERSION,
    PAYLOAD_KIND,
    value.proofs.map(encodeProofEntry),
    value.counterHighWaterMarks.map((counter) => [
      counter.mintUrl,
      counter.unit,
      counter.keysetId,
      counter.nextCounter,
    ]),
  ])
  if (payload.byteLength > PAYLOAD_MAX_BYTES)
    throw new Error('encrypted backup proof set payload is too large')
  return payload
}

function encodeProofEntry(proof: DecodedProofEntry): readonly unknown[] {
  return [
    proof.mintUrl,
    proof.unit,
    encodeAsset(proof.asset),
    serializeDurableCustodyProofArtifact(proof.proof),
    encodeDurableWalletProofDerivationLocatorCbor(proof.locator),
  ]
}

function decodeProofSetPayload(bytes: Uint8Array, seed: Uint8Array): DecodedProofSet {
  preflightProofSetPayload(bytes)
  let raw: unknown
  try {
    raw = decode(bytes)
  } catch {
    throw new Error('encrypted backup proof set CBOR is invalid')
  }
  if (
    !Array.isArray(raw) ||
    raw.length !== 4 ||
    raw[0] !== PAYLOAD_VERSION ||
    raw[1] !== PAYLOAD_KIND
  ) {
    throw new Error('encrypted backup proof set payload is invalid')
  }
  const proofsRaw = raw[2]
  const countersRaw = raw[3]
  if (!Array.isArray(proofsRaw) || !Array.isArray(countersRaw))
    throw new Error('encrypted backup proof set payload is invalid')
  const decoded = validateProofSet({
    seed,
    proofs: proofsRaw.map(decodeProofWire),
    counterHighWaterMarks: countersRaw.map(decodeCounterWire),
  })
  if (!equalBytes(encodeProofSetPayload(decoded), bytes)) {
    throw new Error('encrypted backup proof set CBOR is noncanonical')
  }
  return decoded
}

function decodeProofWire(value: unknown): EncryptedWalletBackupV2ProofSetProof {
  if (!Array.isArray(value) || value.length !== 5)
    throw new Error('encrypted backup proof set proof is invalid')
  return {
    mintUrl: value[0] as string,
    unit: value[1] as 'sat' | 'msat',
    asset: decodeAssetWire(value[2]),
    proof: deserializeDurableCustodyProofArtifact(value[3]),
    locator: decodeDurableWalletProofDerivationLocatorCbor(value[4]),
  }
}

function decodeCounterWire(value: unknown): EncryptedWalletBackupV2CounterHighWaterMark {
  if (!Array.isArray(value) || value.length !== 4)
    throw new Error('encrypted backup proof set counter is invalid')
  return {
    mintUrl: value[0] as string,
    unit: value[1] as 'sat' | 'msat',
    keysetId: value[2] as string,
    nextCounter: value[3] as number,
  }
}

function decodeAsset(value: unknown): EncryptedWalletBackupV2ProofSetAsset {
  if (!isRecord(value) || typeof value.kind !== 'string')
    throw new Error('encrypted backup proof set asset is invalid')
  switch (value.kind) {
    case 'ordinary':
      if (!exactKeys(value, ['kind'])) break
      return Object.freeze({ kind: 'ordinary' })
    case 'ctf':
      if (
        !exactKeys(value, [
          'kind',
          'conditionId',
          'outcomeLabel',
          'outcomeCollectionId',
          'registeredAt',
          'finalExpiry',
        ])
      )
        break
      const registeredAt = requireUnixTime(value.registeredAt)
      const finalExpiry = requireOptionalPositiveUnixTime(value.finalExpiry)
      if (finalExpiry !== null && finalExpiry <= registeredAt)
        throw new Error('encrypted backup proof set asset is invalid')
      return Object.freeze({
        kind: 'ctf',
        conditionId: requireLowerHex(value.conditionId, 32, 'condition id'),
        outcomeLabel: requireUtf8Text(value.outcomeLabel, OUTCOME_MAX_BYTES, 'outcome label'),
        outcomeCollectionId: requireLowerHex(
          value.outcomeCollectionId,
          32,
          'outcome collection id',
        ),
        registeredAt,
        finalExpiry,
      })
  }
  throw new Error('encrypted backup proof set asset is invalid')
}

function encodeAsset(value: EncryptedWalletBackupV2ProofSetAsset): readonly unknown[] {
  switch (value.kind) {
    case 'ordinary':
      return [0]
    case 'ctf':
      return [
        1,
        value.conditionId,
        value.outcomeLabel,
        value.outcomeCollectionId,
        value.registeredAt,
        value.finalExpiry,
      ]
  }
}

function decodeAssetWire(value: unknown): EncryptedWalletBackupV2ProofSetAsset {
  if (!Array.isArray(value) || typeof value[0] !== 'number')
    throw new Error('encrypted backup proof set asset is invalid')
  switch (value[0]) {
    case 0:
      if (value.length === 1) return decodeAsset({ kind: 'ordinary' })
      break
    case 1:
      if (value.length === 6)
        return decodeAsset({
          kind: 'ctf',
          conditionId: value[1],
          outcomeLabel: value[2],
          outcomeCollectionId: value[3],
          registeredAt: value[4],
          finalExpiry: value[5],
        })
      break
  }
  throw new Error('encrypted backup proof set asset is invalid')
}

/** Creates the canonical asset identity used by one V2 proof-set bundle. */
export function createEncryptedWalletBackupV2AssetIdentity(input: {
  readonly mintUrl: string
  readonly unit: string
  readonly asset: EncryptedWalletBackupV2ProofSetAsset
}): EncryptedWalletBackupV2AssetIdentity {
  const asset = decodeAsset(input.asset)
  return decodeEncryptedWalletBackupV2AssetIdentity({
    mintUrl: input.mintUrl,
    unit: input.unit,
    assetIdentity: assetIdentity(asset),
  })
}

/** Encodes one canonical local asset key without delimiter ambiguity. */
export function encryptedWalletBackupV2LocalAssetKey(value: unknown): string {
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(value)
  return JSON.stringify([asset.mintUrl, asset.unit, asset.assetIdentity])
}

/** Strictly decodes a canonical V2 asset identity. */
export function decodeEncryptedWalletBackupV2AssetIdentity(
  value: unknown,
): EncryptedWalletBackupV2AssetIdentity {
  if (!isRecord(value) || !exactKeys(value, ['mintUrl', 'unit', 'assetIdentity']))
    throw new Error('encrypted backup proof set asset is invalid')
  const assetIdentity = requireAssetIdentity(value.assetIdentity)
  return Object.freeze({
    mintUrl: requireCanonicalMint(value.mintUrl),
    unit: requireUnit(value.unit),
    assetIdentity,
  })
}

function requireAssetIdentity(value: unknown): string {
  const identity = requireUtf8Text(value, 256, 'encrypted backup asset identity')
  if (identity === 'cashu:ordinary' || /^ctf:[0-9a-f]{64}:[0-9a-f]{64}$/.test(identity)) {
    return identity
  }
  throw new Error('encrypted backup asset identity is invalid')
}

function assertProofSetAsset(
  proofs: readonly DecodedProofEntry[],
  asset: EncryptedWalletBackupV2AssetIdentity,
): void {
  if (
    proofs.some(
      (proof) =>
        proof.mintUrl !== asset.mintUrl ||
        proof.unit !== asset.unit ||
        assetIdentity(proof.asset) !== asset.assetIdentity,
    )
  )
    throw new Error('encrypted backup proof set asset is foreign')
}

function sumProofAmounts(proofs: readonly DecodedProofEntry[]): bigint {
  let total = 0n
  for (const proof of proofs) {
    total += proof.amount
    if (total > ENCRYPTED_WALLET_BACKUP_V2_UINT64_MAX)
      throw new Error('encrypted backup proof set declared amount is invalid')
  }
  return total
}

function assetIdentity(asset: EncryptedWalletBackupV2ProofSetAsset): string {
  switch (asset.kind) {
    case 'ordinary':
      return 'cashu:ordinary'
    case 'ctf':
      return `ctf:${asset.conditionId}:${asset.outcomeCollectionId}`
  }
}

function walletScopeId(seed: Uint8Array): string {
  return deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(seed),
  })
}

function requireCanonicalMint(value: unknown): string {
  if (typeof value !== 'string') throw new Error('encrypted backup mint URL is invalid')
  const canonical = canonicalizeMintIdentityUrl(value)
  if (canonical !== value || new TextEncoder().encode(value).byteLength > MINT_MAX_BYTES)
    throw new Error('encrypted backup mint URL is invalid')
  return value
}

function requireUnit(value: unknown): 'sat' | 'msat' {
  if (value !== 'sat' && value !== 'msat') throw new Error('encrypted backup unit is invalid')
  return value
}

function requireUnixTime(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('encrypted backup time is invalid')
  return value
}

function requireOptionalPositiveUnixTime(value: unknown): number | null {
  if (value === null) return null
  const timestamp = requireUnixTime(value)
  if (timestamp < 1) throw new Error('encrypted backup time is invalid')
  return timestamp
}

function counterTuple(value: { mintUrl: string; unit: string; keysetId: string }): string {
  return `${value.mintUrl}\u0000${value.unit}\u0000${value.keysetId}`
}

function cloneUnverifiedProofSet(
  value: DecodedProofSet,
): EncryptedWalletBackupV2UnverifiedProofSet {
  return Object.freeze({
    proofs: Object.freeze(
      value.proofs.map((proof) =>
        Object.freeze({
          mintUrl: proof.mintUrl,
          unit: proof.unit,
          asset: structuredClone(proof.asset),
          proof: deserializeDurableCustodyProofArtifact(
            serializeDurableCustodyProofArtifact(proof.proof),
          ),
          locator: structuredClone(proof.locator),
          proofId: proof.proofId,
        }),
      ),
    ),
    counterHighWaterMarks: Object.freeze(
      value.counterHighWaterMarks.map((counter) => Object.freeze({ ...counter })),
    ),
  })
}

/** Creates the immutable snapshot that the verified-runtime brand authorizes. */
function freezeVerifiedProofSet(value: DecodedProofSet): EncryptedWalletBackupV2VerifiedProofSet {
  return deepFreeze({
    verified: true as const,
    proofs: value.proofs.map((proof) => ({
      mintUrl: proof.mintUrl,
      unit: proof.unit,
      asset: structuredClone(proof.asset),
      proof: deserializeDurableCustodyProofArtifact(
        serializeDurableCustodyProofArtifact(proof.proof),
      ),
      locator: structuredClone(proof.locator),
      proofId: proof.proofId,
    })),
    counterHighWaterMarks: value.counterHighWaterMarks.map((counter) => ({ ...counter })),
  })
}

function deepFreeze<T>(value: T): T {
  if (
    value === null ||
    typeof value !== 'object' ||
    Object.isFrozen(value) ||
    ArrayBuffer.isView(value)
  )
    return value
  for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item)
  return Object.freeze(value)
}

function snapshotDescriptor(
  value: EncryptedWalletBackupV2BundleDescriptor,
): EncryptedWalletBackupV2BundleDescriptor {
  const snapshot = Object.fromEntries(Object.entries(value)) as Record<string, unknown>
  if (Array.isArray(snapshot.objects)) {
    snapshot.objects = snapshot.objects.map((object) =>
      isRecord(object) ? Object.fromEntries(Object.entries(object)) : object,
    )
  }
  return snapshot as unknown as EncryptedWalletBackupV2BundleDescriptor
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field))
  )
}

interface DecodedProofEntry extends EncryptedWalletBackupV2ProofSetProof {
  readonly proofId: string
  readonly amount: bigint
}
interface DecodedProofSet {
  readonly proofs: readonly DecodedProofEntry[]
  readonly counterHighWaterMarks: readonly EncryptedWalletBackupV2CounterHighWaterMark[]
}

function preflightProofSetPayload(bytes: Uint8Array): void {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > PAYLOAD_MAX_BYTES
  )
    throw new Error('encrypted backup proof set CBOR is invalid')
  const state = { offset: 0, tokens: 0 }
  const root = scan(bytes, state, 0)
  if (
    state.offset !== bytes.byteLength ||
    root.major !== 4 ||
    root.value !== 4 ||
    root.children[0]?.value !== 1 ||
    root.children[1]?.major !== 3 ||
    root.children[1]?.value !== PAYLOAD_KIND.length
  )
    throw new Error('encrypted backup proof set CBOR is invalid')
  const proofs = root.children[2]
  const counters = root.children[3]
  if (
    proofs?.major !== 4 ||
    proofs.value === null ||
    proofs.value < 1 ||
    proofs.value > ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX ||
    counters?.major !== 4 ||
    counters.value === null ||
    counters.value > ENCRYPTED_WALLET_BACKUP_V2_COUNTER_MAX
  )
    throw new Error('encrypted backup proof set CBOR is invalid')
  for (const proof of proofs.children)
    if (proof.major !== 4 || proof.value !== 5)
      throw new Error('encrypted backup proof set CBOR is invalid')
  for (const counter of counters.children)
    if (counter.major !== 4 || counter.value !== 4)
      throw new Error('encrypted backup proof set CBOR is invalid')
}

interface CborShape {
  readonly major: number
  readonly value: number | null
  readonly children: readonly CborShape[]
}
function scan(
  bytes: Uint8Array,
  state: { offset: number; tokens: number },
  depth: number,
): CborShape {
  if (depth > 16 || ++state.tokens > PREFLIGHT_TOKEN_MAX || state.offset >= bytes.byteLength)
    throw new Error('encrypted backup proof set CBOR is invalid')
  const first = bytes[state.offset++]!
  const major = first >>> 5
  const additional = first & 31
  if (major === 1 || major === 6 || additional === 31)
    throw new Error('encrypted backup proof set CBOR is invalid')
  if (major === 7) {
    if (additional !== 22) throw new Error('encrypted backup proof set CBOR is invalid')
    return { major, value: additional, children: [] }
  }
  if (major !== 0 && major !== 2 && major !== 3 && major !== 4 && major !== 5)
    throw new Error('encrypted backup proof set CBOR is invalid')
  const value = scanArgument(bytes, state, additional)
  if (major === 0) return { major, value, children: [] }
  if (value > PAYLOAD_MAX_BYTES) throw new Error('encrypted backup proof set CBOR is invalid')
  if (major === 2 || major === 3) {
    if (state.offset + value > bytes.byteLength)
      throw new Error('encrypted backup proof set CBOR is invalid')
    if (major === 3)
      new TextDecoder('utf-8', { fatal: true }).decode(
        bytes.subarray(state.offset, state.offset + value),
      )
    state.offset += value
    return { major, value, children: [] }
  }
  const children: CborShape[] = []
  const childCount = major === 5 ? value * 2 : value
  for (let index = 0; index < childCount; index += 1) children.push(scan(bytes, state, depth + 1))
  return { major, value, children }
}
function scanArgument(bytes: Uint8Array, state: { offset: number }, additional: number): number {
  if (additional < 24) return additional
  const width = ({ 24: 1, 25: 2, 26: 4, 27: 8 } as Record<number, number>)[additional]
  if (width === undefined || state.offset + width > bytes.byteLength)
    throw new Error('encrypted backup proof set CBOR is invalid')
  let result = 0n
  for (let index = 0; index < width; index += 1)
    result = (result << 8n) | BigInt(bytes[state.offset++]!)
  if (
    result > BigInt(Number.MAX_SAFE_INTEGER) ||
    (width === 1 && result < 24n) ||
    (width === 2 && result <= 0xffn) ||
    (width === 4 && result <= 0xffffn) ||
    (width === 8 && result <= 0xffff_ffffn)
  )
    throw new Error('encrypted backup proof set CBOR is invalid')
  return Number(result)
}
