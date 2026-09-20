import { decode } from 'cborg'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
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
import {
  digestEncryptedWalletBackupV2BundleDescriptor,
  ENCRYPTED_WALLET_BACKUP_V2_UINT64_MAX,
} from './encryptedWalletBackupV2Descriptor.ts'
import { encodeCanonicalBackupCbor } from './encryptedWalletBackupCbor.ts'
import {
  requireEncryptedWalletBackupV2CollectedHeadEvidence,
  type EncryptedWalletBackupV2CollectedHeadEvidence,
  type EncryptedWalletBackupV2CurrentHead,
} from './encryptedWalletBackupV2Head.ts'
import type { EncryptedWalletBackupV2RemotePort } from './encryptedWalletBackupV2HttpAdapter.ts'
import { collectAllEncryptedWalletBackupV2DescriptorPages } from './encryptedWalletBackupV2Sync.ts'
import {
  prepareEncryptedWalletBackupV2RequestProof,
  type EncryptedWalletBackupV2RequestProofRuntime,
} from './encryptedWalletBackupV2RequestProof.ts'
import {
  decodeDurableCustodyRecord,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  type DurableCustodyExactArtifact,
  type DurableCustodyRecord,
} from './durableCustody.ts'
import { readDurableCustodyAuthenticatedTerminalMintRejection } from './durableCustodyMintResult.ts'
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

const PAYLOAD_VERSION = 2
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
  readonly terminalSeal?: EncryptedWalletBackupV2TerminalSeal
}

export interface EncryptedWalletBackupV2TerminalSeal {
  readonly schemaVersion: 1
  readonly kind: 'ctf-verified-losing'
  readonly operationIdDigest: string
  readonly requestDigest: string
  readonly code: 13015
  readonly classifiedAtMs: number
  readonly proofCommitment: string
}

export interface EncryptedWalletBackupV2CommittedTerminalSealStore {
  withCommittedTerminalRejection<T>(
    operationId: string,
    read: (value: {
      readonly record: DurableCustodyRecord
      readonly exactRejection: DurableCustodyExactArtifact
      readonly classifiedAtMs: number
    }) => T,
  ): Promise<T>
}

const ISSUED_TERMINAL_SEALS = new WeakMap<object, string>()
const DECRYPTED_PROOF_SET_AUTHORITY = new WeakMap<object, DecryptedProofSetAuthority>()
const REMOTE_TERMINAL_SEAL_REUSE_AUTHORITY = new WeakMap<
  object,
  RemoteTerminalSealReuseAuthorityData
>()

/** A non-clonable authority for reusing one seal fetched by the SDK. */
export interface EncryptedWalletBackupV2RemoteTerminalSealReuseAuthority {
  readonly kind: 'ctf-verified-losing-remote-reuse'
  readonly proofId: string
  readonly head: EncryptedWalletBackupV2CurrentHead
  readonly bundleId: string
  readonly descriptorDigest: string
  readonly assetLocator: string
  readonly custodyRevision: bigint
  readonly proofCommitment: string
  readonly terminalSeal: EncryptedWalletBackupV2TerminalSeal
}

/**
 * Fetched material and authorities from one remote predecessor read.
 * Pass `currentHeadEvidence` to the compare-and-swap mutation for this
 * replacement. Do not substitute a second head read.
 */
export interface EncryptedWalletBackupV2RemoteTerminalSealReuseResult {
  readonly currentHeadEvidence: EncryptedWalletBackupV2CollectedHeadEvidence
  readonly descriptor: EncryptedWalletBackupV2BundleDescriptor
  readonly decrypted: EncryptedWalletBackupV2UnverifiedProofSet
  readonly authorities: readonly EncryptedWalletBackupV2RemoteTerminalSealReuseAuthority[]
}

/**
 * Require the unforgeable authority returned by remote terminal-seal reuse.
 * This is useful to retain a typed authority in a caller without accepting a
 * copied seal object as equivalent authority.
 */
export function requireEncryptedWalletBackupV2RemoteTerminalSealReuseAuthority(
  value: unknown,
): EncryptedWalletBackupV2RemoteTerminalSealReuseAuthority {
  if (
    typeof value !== 'object' ||
    value === null ||
    !REMOTE_TERMINAL_SEAL_REUSE_AUTHORITY.has(value)
  )
    throw new Error('encrypted backup remote terminal seal authority is invalid')
  return value as EncryptedWalletBackupV2RemoteTerminalSealReuseAuthority
}

/** Rebuild seal authority from one committed CTF redeem row and its exact rejection. */
export async function issueEncryptedWalletBackupV2TerminalSeal(input: {
  readonly seed: Uint8Array
  readonly proof: EncryptedWalletBackupV2ProofSetProof
  readonly operationId: string
  readonly store: EncryptedWalletBackupV2CommittedTerminalSealStore
}): Promise<EncryptedWalletBackupV2TerminalSeal> {
  const proof = decodeProofEntry(input.proof, input.seed, walletScopeId(input.seed))
  if (proof.asset.kind !== 'ctf' || proof.terminalSeal !== undefined)
    throw new Error('encrypted backup terminal seal proof is invalid')
  let open = true
  let calls = 0
  let issued: EncryptedWalletBackupV2TerminalSeal | undefined
  let returned: unknown
  try {
    returned = await input.store.withCommittedTerminalRejection(input.operationId, (value) => {
      if (!open || calls++ !== 0)
        throw new Error('encrypted backup committed terminal callback is invalid')
      const record = decodeDurableCustodyRecord(value.record)
      const rejection = readDurableCustodyAuthenticatedTerminalMintRejection({
        record,
        exactRejection: value.exactRejection,
      })
      if (
        record.operation.operationId !== input.operationId ||
        record.operation.state !== 'aborted' ||
        record.operation.semanticKind !== 'ctf-redeem' ||
        record.scope.scopeId !== walletScopeId(input.seed) ||
        rejection.normalizedMint !== proof.mintUrl ||
        record.operation.custodyContext.unit !== proof.unit ||
        record.operation.exactRequest.inputProofIds.filter((id) => id === proof.proofId).length !==
          1
      )
        throw new Error('encrypted backup terminal seal operation is foreign')
      issued = Object.freeze({
        schemaVersion: 1,
        kind: 'ctf-verified-losing',
        operationIdDigest: digestText(input.operationId),
        requestDigest: rejection.requestFingerprint,
        code: 13015,
        classifiedAtMs: requireUnixTime(value.classifiedAtMs),
        proofCommitment: proofCommitment(proof),
      })
      return issued
    })
  } finally {
    open = false
  }
  if (issued === undefined || returned !== issued || calls !== 1)
    throw new Error('encrypted backup committed terminal read is not exact')
  ISSUED_TERMINAL_SEALS.set(issued, proof.proofId)
  return issued
}

/**
 * Fetches and re-authorizes existing terminal seals after origin loss.
 *
 * This function owns one authenticated current-head and exact-bundle read.
 * The caller must provide the backup origin and an authenticated V2 remote
 * port. It does not accept caller-provided head pages, descriptors, decrypted
 * material, or seals as issuance evidence. It performs no mint or NUT-07
 * check on sibling entries.
 */
export async function authorizeEncryptedWalletBackupV2RemoteTerminalSealReuse(input: {
  readonly keyHandle: EncryptedWalletBackupV2KeyHandle
  readonly seed: Uint8Array
  readonly expectedAsset: EncryptedWalletBackupV2AssetIdentity
  readonly custodyRevision: bigint
  readonly expectedEnrollmentEpoch: number
  readonly remote: Pick<EncryptedWalletBackupV2RemotePort, 'readDescriptorPage' | 'readObject'>
  readonly remoteRequest: {
    readonly origin: string
    readonly issuedAtUnixSeconds: number
    readonly expiresAtUnixSeconds: number
    readonly signal: AbortSignal
    readonly runtime?: EncryptedWalletBackupV2RequestProofRuntime
  }
  readonly runtime: EncryptedWalletBackupV2BundleRuntime
}): Promise<EncryptedWalletBackupV2RemoteTerminalSealReuseResult> {
  const seed = await requireEncryptedWalletBackupV2SeedHandleMatch(input)
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(input.expectedAsset)
  const origin = requireRemoteOrigin(input.remoteRequest.origin)
  const base = encryptedWalletBackupV2RemoteBase(origin, input.keyHandle)
  const issueGetProof = (url: string) =>
    prepareEncryptedWalletBackupV2RequestProof({
      keyHandle: input.keyHandle,
      enrollmentEpoch: input.expectedEnrollmentEpoch,
      method: 'GET',
      url,
      issuedAtUnixSeconds: input.remoteRequest.issuedAtUnixSeconds,
      expiresAtUnixSeconds: input.remoteRequest.expiresAtUnixSeconds,
      payload: new Uint8Array(),
      signal: input.remoteRequest.signal,
      runtime: input.remoteRequest.runtime,
    })
  const currentHeadEvidence = await collectAllEncryptedWalletBackupV2DescriptorPages({
    issueRequestProof: (afterBundleId) =>
      issueGetProof(encryptedWalletBackupV2DescriptorPageUrl(base, afterBundleId)),
    readDescriptorPage: ({ requestProof, afterBundleId }) =>
      input.remote.readDescriptorPage({
        requestProof,
        afterBundleId,
        signal: input.remoteRequest.signal,
      }),
  })
  if (
    currentHeadEvidence.head.realm !== input.keyHandle.realm ||
    currentHeadEvidence.head.walletId !== input.keyHandle.walletId ||
    currentHeadEvidence.head.enrollmentEpoch !== input.expectedEnrollmentEpoch
  )
    throw new Error('encrypted backup remote terminal head scope is invalid')
  const expectedAssetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
    keyHandle: input.keyHandle,
    ...asset,
  })
  const currentBundles = currentHeadEvidence.bundles.filter(
    (bundle) => bundle.assetLocator === expectedAssetLocator,
  )
  if (currentBundles.length !== 1)
    throw new Error('encrypted backup remote terminal bundle is not current')
  const currentBundle = currentBundles[0]!
  if (currentBundle.custodyRevision !== input.custodyRevision)
    throw new Error('encrypted backup remote terminal bundle binding is invalid')
  const objects: EncryptedWalletBackupV2BundleObjectWire[] = []
  for (const objectReference of currentBundle.objects) {
    const requestProof = await issueGetProof(
      encryptedWalletBackupV2ObjectUrl(base, objectReference.objectId),
    )
    objects.push(
      await input.remote.readObject({
        requestProof,
        objectId: objectReference.objectId,
        expectedDescriptor: currentBundle,
        signal: input.remoteRequest.signal,
      }),
    )
  }
  const decrypted = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle: input.keyHandle,
    seed,
    expectedAsset: asset,
    custodyRevision: input.custodyRevision,
    runtime: input.runtime,
    descriptor: currentBundle,
    objects,
  })
  const decoded = validateAuthenticatedDecryptedProofSet(decrypted, seed, asset)
  const authorities = decoded.proofs
    .filter((proof) => proof.terminalSeal !== undefined)
    .map((proof) =>
      createRemoteTerminalSealReuseAuthority({
        currentHeadEvidence,
        descriptor: currentBundle,
        expectedAssetLocator,
        custodyRevision: input.custodyRevision,
        proof,
      }),
    )
  if (authorities.length === 0) throw new Error('encrypted backup remote terminal seal is missing')
  return Object.freeze({
    currentHeadEvidence,
    descriptor: currentBundle,
    decrypted,
    authorities: Object.freeze(authorities),
  })
}

function createRemoteTerminalSealReuseAuthority(input: {
  readonly currentHeadEvidence: EncryptedWalletBackupV2CollectedHeadEvidence
  readonly descriptor: EncryptedWalletBackupV2BundleDescriptor
  readonly expectedAssetLocator: string
  readonly custodyRevision: bigint
  readonly proof: DecodedProofEntry
}): EncryptedWalletBackupV2RemoteTerminalSealReuseAuthority {
  const collected = requireEncryptedWalletBackupV2CollectedHeadEvidence(input.currentHeadEvidence)
  const descriptorDigest = digestEncryptedWalletBackupV2BundleDescriptor(input.descriptor)
  const currentBundles = collected.bundles.filter(
    (bundle) =>
      bundle.bundleId === input.descriptor.bundleId &&
      bundle.assetLocator === input.expectedAssetLocator,
  )
  if (
    currentBundles.length !== 1 ||
    descriptorDigest !== digestEncryptedWalletBackupV2BundleDescriptor(currentBundles[0]!) ||
    input.descriptor.custodyRevision !== input.custodyRevision ||
    input.proof.terminalSeal === undefined
  )
    throw new Error('encrypted backup remote terminal bundle binding is invalid')
  const authority = Object.freeze({
    kind: 'ctf-verified-losing-remote-reuse' as const,
    proofId: input.proof.proofId,
    head: Object.freeze({ ...collected.head }),
    bundleId: input.descriptor.bundleId,
    descriptorDigest,
    assetLocator: input.descriptor.assetLocator,
    custodyRevision: input.descriptor.custodyRevision,
    proofCommitment: proofCommitment(input.proof),
    terminalSeal: Object.freeze({ ...input.proof.terminalSeal }),
  })
  REMOTE_TERMINAL_SEAL_REUSE_AUTHORITY.set(authority, {
    proofId: input.proof.proofId,
    proofCommitment: authority.proofCommitment,
    terminalSeal: authority.terminalSeal,
    assetLocator: authority.assetLocator,
    custodyRevision: authority.custodyRevision,
    bundleId: authority.bundleId,
    descriptorDigest: authority.descriptorDigest,
    head: authority.head,
  })
  return authority
}

function encryptedWalletBackupV2RemoteBase(
  origin: string,
  keyHandle: EncryptedWalletBackupV2KeyHandle,
): string {
  return `${origin}/v1/encrypted-wallet-backup/realms/${keyHandle.realm}/wallets/${keyHandle.walletId}`
}

function encryptedWalletBackupV2DescriptorPageUrl(
  base: string,
  afterBundleId: string | null,
): string {
  return afterBundleId === null ? `${base}/head` : `${base}/head/after/${afterBundleId}`
}

function encryptedWalletBackupV2ObjectUrl(base: string, objectId: string): string {
  return `${base}/objects/${objectId}`
}

function requireRemoteOrigin(value: string): string {
  try {
    const origin = new URL(value)
    if (
      origin.protocol !== 'https:' ||
      origin.username !== '' ||
      origin.password !== '' ||
      origin.pathname !== '/' ||
      origin.search !== '' ||
      origin.hash !== ''
    )
      throw new Error('encrypted backup remote origin is invalid')
    return origin.origin
  } catch {
    throw new Error('encrypted backup remote origin is invalid')
  }
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
  readonly proofs: readonly (EncryptedWalletBackupV2ProofSetProof & {
    readonly proofId: string
    readonly selectionAuthority: 'live-verified' | 'terminal-sealed-non-selectable'
  })[]
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
  const sealed = decoded.proofs.filter((proof) => proof.terminalSeal !== undefined)
  if (
    sealed.length > 0 &&
    DECRYPTED_PROOF_SET_AUTHORITY.get(input.unverified)?.proofSetDigest !== digestProofSet(decoded)
  )
    throw new Error('encrypted backup terminal seal needs exact authenticated decrypted material')
  const selectable = decoded.proofs.filter((proof) => proof.terminalSeal === undefined)
  if (selectable.length > 0) {
    const keysets = await resolveRestoreKeysets(selectable, input.port)
    input.port.verifyProofs({ proofs: selectable.map(({ proof }) => proof), keysets })
    await requireUnspentRestoreProofs(selectable, input.port)
  }
  const verified = freezeVerifiedProofSet(decoded)
  VERIFIED_RESTORED_PROOF_SETS.set(verified, verified)
  return verified
}

function withoutProofId(entry: EncryptedWalletBackupV2UnverifiedProofSet['proofs'][number]) {
  const { proofId: _proofId, ...encoded } = entry
  return encoded
}

function stripProofId(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, 'proofId')) return value
  const { proofId: _proofId, ...entry } = value
  return entry
}

function normalizePrepareProof(
  value: unknown,
  seed: Uint8Array,
): EncryptedWalletBackupV2ProofSetProof {
  if (!isRecord(value) || !Object.hasOwn(value, 'proofId'))
    return value as EncryptedWalletBackupV2ProofSetProof
  const proofId = value.proofId
  const entry = stripProofId(value)
  const decoded = decodeProofEntry(entry, seed, walletScopeId(seed))
  if (proofId !== decoded.proofId) throw new Error('encrypted backup proof set proof id is invalid')
  return entry as EncryptedWalletBackupV2ProofSetProof
}

function validateAuthenticatedDecryptedProofSet(
  value: EncryptedWalletBackupV2UnverifiedProofSet,
  seed: Uint8Array,
  asset: EncryptedWalletBackupV2AssetIdentity,
): DecodedProofSet {
  const authority = DECRYPTED_PROOF_SET_AUTHORITY.get(value)
  const decoded = validateProofSet({
    seed,
    proofs: value.proofs.map(withoutProofId),
    counterHighWaterMarks: value.counterHighWaterMarks,
  })
  if (authority === undefined || authority.proofSetDigest !== digestProofSet(decoded))
    throw new Error('encrypted backup remote terminal bundle is not exact authenticated material')
  assertProofSetAsset(decoded.proofs, asset)
  return decoded
}

function requireRemoteTerminalSealReuseData(
  value: unknown,
): readonly RemoteTerminalSealReuseAuthorityData[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ENCRYPTED_WALLET_BACKUP_V2_PROOF_SET_MAX)
    throw new Error('encrypted backup remote terminal seal authorities are invalid')
  const authorities = value.map((item) => {
    const authority = requireEncryptedWalletBackupV2RemoteTerminalSealReuseAuthority(item)
    const data = REMOTE_TERMINAL_SEAL_REUSE_AUTHORITY.get(authority)
    if (data === undefined)
      throw new Error('encrypted backup remote terminal seal authority is invalid')
    return data
  })
  if (new Set(authorities.map((authority) => authority.proofId)).size !== authorities.length)
    throw new Error('encrypted backup remote terminal seal authorities are duplicated')
  return authorities
}

function requireProofSetSealAuthorities(
  decoded: DecodedProofSet,
  remoteAuthorities: readonly RemoteTerminalSealReuseAuthorityData[],
  issuedProofIds: ReadonlySet<string>,
): void {
  const remoteByProofId = new Map(
    remoteAuthorities.map((authority) => [authority.proofId, authority]),
  )
  const usedRemoteProofIds = new Set<string>()
  for (const proof of decoded.proofs) {
    const seal = proof.terminalSeal
    if (seal === undefined) continue
    if (issuedProofIds.has(proof.proofId)) continue
    const remoteAuthority = remoteByProofId.get(proof.proofId)
    if (
      remoteAuthority === undefined ||
      remoteAuthority.proofId !== proof.proofId ||
      remoteAuthority.proofCommitment !== proofCommitment(proof) ||
      !sameTerminalSeal(remoteAuthority.terminalSeal, seal)
    )
      throw new Error('encrypted backup terminal seal is not SDK-authorized')
    usedRemoteProofIds.add(proof.proofId)
  }
  if (remoteAuthorities.some((authority) => !usedRemoteProofIds.has(authority.proofId)))
    throw new Error('encrypted backup remote terminal seal is not present')
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
  readonly remoteTerminalSealReuses?: readonly EncryptedWalletBackupV2RemoteTerminalSealReuseAuthority[]
  readonly remoteTerminalSealReuseHeadEvidence?: EncryptedWalletBackupV2CollectedHeadEvidence
}): Promise<EncryptedWalletBackupV2PreparedTransportBundle> {
  const seed = await requireEncryptedWalletBackupV2SeedHandleMatch(input)
  const asset = decodeEncryptedWalletBackupV2AssetIdentity(input.asset)
  const remoteAuthorities = requireRemoteTerminalSealReuseData(input.remoteTerminalSealReuses)
  if (remoteAuthorities.length > 0) {
    const assetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle: input.keyHandle,
      ...asset,
    })
    const first = remoteAuthorities[0]!
    const headEvidence = input.remoteTerminalSealReuseHeadEvidence
    if (headEvidence === undefined)
      throw new Error('encrypted backup remote terminal head evidence is required')
    const collected = requireEncryptedWalletBackupV2CollectedHeadEvidence(headEvidence)
    if (
      remoteAuthorities.some(
        (authority) =>
          authority.assetLocator !== assetLocator ||
          authority.bundleId !== first.bundleId ||
          authority.descriptorDigest !== first.descriptorDigest ||
          authority.custodyRevision !== first.custodyRevision ||
          !sameCurrentHead(authority.head, first.head),
      )
    )
      throw new Error('encrypted backup remote terminal seal binding is invalid')
    if (!sameCurrentHead(collected.head, first.head))
      throw new Error('encrypted backup remote terminal head evidence is stale')
    if (
      !collected.bundles.some(
        (bundle) =>
          bundle.bundleId === first.bundleId &&
          bundle.assetLocator === first.assetLocator &&
          bundle.custodyRevision === first.custodyRevision &&
          digestEncryptedWalletBackupV2BundleDescriptor(bundle) === first.descriptorDigest,
      )
    )
      throw new Error('encrypted backup remote terminal head evidence is stale')
  }
  const proofs = input.proofs.map((proof) => normalizePrepareProof(proof, seed))
  const decoded = validateProofSet({
    seed,
    proofs,
    counterHighWaterMarks: input.counterHighWaterMarks,
  })
  requireProofSetSealAuthorities(
    decoded,
    remoteAuthorities,
    new Set(
      input.proofs.flatMap((proof, index) =>
        proof.terminalSeal !== undefined &&
        ISSUED_TERMINAL_SEALS.get(proof.terminalSeal) === decoded.proofs[index]!.proofId
          ? [decoded.proofs[index]!.proofId]
          : [],
      ),
    ),
  )
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
  const unverified = cloneUnverifiedProofSet(decoded)
  DECRYPTED_PROOF_SET_AUTHORITY.set(unverified, {
    proofSetDigest: digestProofSet(decoded),
    descriptorDigest: digestEncryptedWalletBackupV2BundleDescriptor(descriptor),
    bundleId: descriptor.bundleId,
    assetLocator: descriptor.assetLocator,
    custodyRevision: descriptor.custodyRevision,
  })
  return unverified
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
  if (
    !isRecord(value) ||
    !(
      exactKeys(value, ['mintUrl', 'unit', 'asset', 'proof', 'locator']) ||
      exactKeys(value, ['mintUrl', 'unit', 'asset', 'proof', 'locator', 'terminalSeal'])
    )
  ) {
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
  const terminalSeal =
    value.terminalSeal === undefined ? undefined : decodeTerminalSeal(value.terminalSeal)
  const entry = { mintUrl, unit, asset, proof, locator, proofId: material.proofId }
  if (
    terminalSeal !== undefined &&
    (asset.kind !== 'ctf' || terminalSeal.proofCommitment !== proofCommitment(entry))
  )
    throw new Error('encrypted backup terminal seal proof binding is invalid')
  return Object.freeze({
    ...entry,
    ...(terminalSeal === undefined ? {} : { terminalSeal }),
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
    proof.terminalSeal === undefined ? null : encodeTerminalSeal(proof.terminalSeal),
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
  if (!Array.isArray(value) || value.length !== 6)
    throw new Error('encrypted backup proof set proof is invalid')
  return {
    mintUrl: value[0] as string,
    unit: value[1] as 'sat' | 'msat',
    asset: decodeAssetWire(value[2]),
    proof: deserializeDurableCustodyProofArtifact(value[3]),
    locator: decodeDurableWalletProofDerivationLocatorCbor(value[4]),
    ...(value[5] === null ? {} : { terminalSeal: decodeTerminalSealWire(value[5]) }),
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

function decodeTerminalSeal(value: unknown): EncryptedWalletBackupV2TerminalSeal {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'schemaVersion',
      'kind',
      'operationIdDigest',
      'requestDigest',
      'code',
      'classifiedAtMs',
      'proofCommitment',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'ctf-verified-losing' ||
    value.code !== 13015
  )
    throw new Error('encrypted backup terminal seal is invalid')
  const classifiedAtMs = requireUnixTime(value.classifiedAtMs)
  return Object.freeze({
    schemaVersion: 1,
    kind: 'ctf-verified-losing',
    operationIdDigest: requireLowerHex(value.operationIdDigest, 32, 'terminal operation digest'),
    requestDigest: requireLowerHex(value.requestDigest, 32, 'terminal request digest'),
    code: 13015,
    classifiedAtMs,
    proofCommitment: requireLowerHex(value.proofCommitment, 32, 'terminal proof commitment'),
  })
}

function encodeTerminalSeal(value: EncryptedWalletBackupV2TerminalSeal): readonly unknown[] {
  const seal = decodeTerminalSeal(value)
  return [
    seal.schemaVersion,
    seal.kind,
    seal.operationIdDigest,
    seal.requestDigest,
    seal.code,
    seal.classifiedAtMs,
    seal.proofCommitment,
  ]
}

function decodeTerminalSealWire(value: unknown): EncryptedWalletBackupV2TerminalSeal {
  if (!Array.isArray(value) || value.length !== 7)
    throw new Error('encrypted backup terminal seal is invalid')
  return decodeTerminalSeal({
    schemaVersion: value[0],
    kind: value[1],
    operationIdDigest: value[2],
    requestDigest: value[3],
    code: value[4],
    classifiedAtMs: value[5],
    proofCommitment: value[6],
  })
}

function digestText(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)))
}

function digestProofSet(value: DecodedProofSet): string {
  return bytesToHex(sha256(encodeProofSetPayload(value)))
}

function proofCommitment(
  value: EncryptedWalletBackupV2ProofSetProof & { readonly proofId: string },
): string {
  return bytesToHex(
    sha256(
      encodeCanonicalBackupCbor([
        'bitcaster:encrypted-backup-v2-terminal-proof:v1',
        value.mintUrl,
        value.unit,
        encodeAsset(value.asset),
        serializeDurableCustodyProofArtifact(value.proof),
        encodeDurableWalletProofDerivationLocatorCbor(value.locator),
        value.proofId,
      ]),
    ),
  )
}

function sameTerminalSeal(
  left: EncryptedWalletBackupV2TerminalSeal | undefined,
  right: EncryptedWalletBackupV2TerminalSeal | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.schemaVersion === right.schemaVersion &&
    left.kind === right.kind &&
    left.operationIdDigest === right.operationIdDigest &&
    left.requestDigest === right.requestDigest &&
    left.code === right.code &&
    left.classifiedAtMs === right.classifiedAtMs &&
    left.proofCommitment === right.proofCommitment
  )
}

function sameCurrentHead(
  left: EncryptedWalletBackupV2CurrentHead,
  right: EncryptedWalletBackupV2CurrentHead,
): boolean {
  return (
    left.formatVersion === right.formatVersion &&
    left.realm === right.realm &&
    left.walletId === right.walletId &&
    left.enrollmentEpoch === right.enrollmentEpoch &&
    left.headVersion === right.headVersion &&
    left.activeBundleCount === right.activeBundleCount &&
    left.activeObjectCount === right.activeObjectCount &&
    left.activeSetDigest === right.activeSetDigest
  )
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
          ...(proof.terminalSeal === undefined
            ? {}
            : { terminalSeal: structuredClone(proof.terminalSeal) }),
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
      ...(proof.terminalSeal === undefined
        ? {}
        : { terminalSeal: structuredClone(proof.terminalSeal) }),
      selectionAuthority:
        proof.terminalSeal === undefined
          ? ('live-verified' as const)
          : ('terminal-sealed-non-selectable' as const),
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

interface DecryptedProofSetAuthority {
  readonly proofSetDigest: string
  readonly descriptorDigest: string
  readonly bundleId: string
  readonly assetLocator: string
  readonly custodyRevision: bigint
}

interface RemoteTerminalSealReuseAuthorityData {
  readonly proofId: string
  readonly proofCommitment: string
  readonly terminalSeal: EncryptedWalletBackupV2TerminalSeal
  readonly assetLocator: string
  readonly custodyRevision: bigint
  readonly bundleId: string
  readonly descriptorDigest: string
  readonly head: EncryptedWalletBackupV2CurrentHead
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
    root.children[0]?.value !== PAYLOAD_VERSION ||
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
    if (proof.major !== 4 || proof.value !== 6)
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
