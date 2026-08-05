import { decode } from 'cborg'
import type { Proof } from '@cashu/cashu-ts'
import {
  decryptEncryptedWalletBackupV2TransportBundle,
  prepareEncryptedWalletBackupV2TransportBundle,
  type EncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleObjectWire,
  type EncryptedWalletBackupV2BundleRuntime,
  type EncryptedWalletBackupV2PreparedTransportBundle,
} from './encryptedWalletBackupV2Bundle.ts'
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
  deriveEncryptedWalletBackupV2OperationLocator,
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
      readonly finalExpiry: number
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

/** Encrypts deterministic proof material. The result is not proof admission authority. */
export async function prepareEncryptedWalletBackupV2ProofSetBundle(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly seed: Uint8Array
  readonly operationId: string
  readonly proofs: readonly EncryptedWalletBackupV2ProofSetProof[]
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
  const canonicalPayload = encodeProofSetPayload(decoded)
  preflightProofSetPayload(canonicalPayload)
  return prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle: input.keyHandle,
    operationId: requireUtf8Text(input.operationId, 256, 'encrypted backup operation id'),
    assets: transportAssets(decoded.proofs),
    canonicalPayload,
    runtime: input.runtime,
    bundleIdExists: input.bundleIdExists,
  })
}

/** Restores unverified proof material. Verify mint signatures, DLEQ, keysets, and NUT-07 first. */
export async function decryptEncryptedWalletBackupV2ProofSetBundle(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly seed: Uint8Array
  readonly operationId: string
  readonly runtime: EncryptedWalletBackupV2BundleRuntime
  readonly descriptor: EncryptedWalletBackupV2BundleDescriptor
  readonly objects: readonly EncryptedWalletBackupV2BundleObjectWire[]
}): Promise<EncryptedWalletBackupV2UnverifiedProofSet> {
  const descriptor = snapshotDescriptor(input.descriptor)
  const seed = await requireEncryptedWalletBackupV2SeedHandleMatch(input)
  const operationId = requireUtf8Text(input.operationId, 256, 'encrypted backup operation id')
  const expectedOperationLocator = await deriveEncryptedWalletBackupV2OperationLocator({
    keyHandle: input.keyHandle,
    operationId,
  })
  if (expectedOperationLocator !== descriptor.operationLocator) {
    throw new Error('encrypted backup proof set operation is foreign')
  }
  const payload = await decryptEncryptedWalletBackupV2TransportBundle({
    keyHandle: input.keyHandle,
    runtime: input.runtime,
    descriptor,
    objects: input.objects,
  })
  const decoded = decodeProofSetPayload(payload, seed)
  const expectedAssets = await Promise.all(
    transportAssets(decoded.proofs).map((asset) =>
      deriveEncryptedWalletBackupV2AssetLocator({ keyHandle: input.keyHandle, ...asset }),
    ),
  )
  if (!sameStrings([...new Set(expectedAssets)].sort(), descriptor.assetLocators)) {
    throw new Error('encrypted backup proof set assets are foreign')
  }
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
  return Object.freeze({ mintUrl, unit, asset, proof, locator, proofId: material.proofId })
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
      return Object.freeze({
        kind: 'ctf',
        conditionId: requireLowerHex(value.conditionId, 32, 'condition id'),
        outcomeLabel: requireUtf8Text(value.outcomeLabel, OUTCOME_MAX_BYTES, 'outcome label'),
        outcomeCollectionId: requireLowerHex(
          value.outcomeCollectionId,
          32,
          'outcome collection id',
        ),
        registeredAt: requireUnixTime(value.registeredAt),
        finalExpiry: requireUnixTime(value.finalExpiry),
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

function transportAssets(
  proofs: readonly DecodedProofEntry[],
): readonly { mintUrl: string; unit: string; assetIdentity: string }[] {
  const unique = new Map<string, { mintUrl: string; unit: string; assetIdentity: string }>()
  for (const proof of proofs) {
    const asset = {
      mintUrl: proof.mintUrl,
      unit: proof.unit,
      assetIdentity: assetIdentity(proof.asset),
    }
    unique.set(`${asset.mintUrl}\u0000${asset.unit}\u0000${asset.assetIdentity}`, asset)
  }
  return Object.freeze(
    [...unique.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, asset]) => asset),
  )
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

function counterTuple(value: { mintUrl: string; unit: string; keysetId: string }): string {
  return `${value.mintUrl}\u0000${value.unit}\u0000${value.keysetId}`
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
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

function snapshotDescriptor(
  value: EncryptedWalletBackupV2BundleDescriptor,
): EncryptedWalletBackupV2BundleDescriptor {
  const snapshot = Object.fromEntries(Object.entries(value)) as Record<string, unknown>
  if (Array.isArray(snapshot.assetLocators)) snapshot.assetLocators = [...snapshot.assetLocators]
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
