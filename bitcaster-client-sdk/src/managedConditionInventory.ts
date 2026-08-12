import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js'
import {
  decodeCanonicalMintOrigin,
  decodeDurableCustodyOperationId,
  decodeDurableCustodyScopeId,
  encodeBoundedDurableArtifact,
  prepareDurableCustodyExactArtifact,
} from './durableCustody.ts'

export const MANAGED_CONDITION_INVENTORY_SCHEMA_VERSION = 1 as const
const EVIDENCE_BYTES_MAX = 64 * 1_024
const TEXT_BYTES_MAX = 16 * 1_024
const ORACLE_COUNT_MAX = 16
const OUTCOME_COUNT_MAX = 8
const verifiedResolutionBrand: unique symbol = Symbol('VerifiedConditionResolution')

export interface ManagedConditionInventoryBinding {
  readonly scopeId: string
  readonly normalizedMint: string
  readonly unit: string
  readonly conditionId: string
  readonly canonicalParentCollectionId: string | null
}

export interface DlcConditionResolutionEvidence {
  readonly schemaVersion: 1
  readonly source: 'dlc-oracle-attestation'
  readonly attestations: readonly {
    readonly oraclePublicKey: string
    readonly signature: string
  }[]
  readonly resolvedOutcome: string
}

export interface PreparedDlcConditionResolutionEvidence {
  readonly evidence: DlcConditionResolutionEvidence
  readonly canonicalOracleWitness: string
}

export interface PersistedRegisteredDlcConditionAuthority extends ManagedConditionInventoryBinding {
  readonly schemaVersion: 1
  readonly eventId: string
  readonly outcomes: readonly string[]
  readonly threshold: number
  readonly oracles: readonly {
    readonly oraclePublicKey: string
    readonly noncePoint: string
    readonly announcementIdentity: string
  }[]
}

export interface PersistedVerifiedConditionResolution extends ManagedConditionInventoryBinding {
  readonly schemaVersion: 1
  readonly source: 'dlc-oracle-attestation'
  readonly conditionIdentity: string
  readonly announcementIdentities: readonly string[]
  readonly attestationIdentity: string
  readonly resolvedOutcome: string
  readonly authorityId: string
  readonly evidenceFingerprint: string
}

export interface VerifiedConditionResolution extends PersistedVerifiedConditionResolution {
  readonly [verifiedResolutionBrand]: true
}

export type ManagedConditionRetirementIntentKind =
  | 'automated-service-policy'
  | 'daemon-standing-policy'
  | 'explicit-user-command'

export interface ManagedConditionRetirementIntent extends ManagedConditionInventoryBinding {
  readonly schemaVersion: 1
  readonly kind: ManagedConditionRetirementIntentKind
  readonly intentId: string
  readonly createdAtMs: number
}

interface ManagedConditionInventoryBase extends ManagedConditionInventoryBinding {
  readonly schemaVersion: 1
  readonly revision: number
}

export type ManagedConditionInventoryState =
  | (ManagedConditionInventoryBase & {
      readonly state: 'active'
      readonly resolution: null
      readonly retirementIntent: null
      readonly retirementStartedAtMs: null
      readonly retirementCompletedAtMs: null
    })
  | (ManagedConditionInventoryBase & {
      readonly state: 'retiring'
      readonly resolution: PersistedVerifiedConditionResolution
      readonly retirementIntent: ManagedConditionRetirementIntent
      readonly retirementStartedAtMs: number
      readonly retirementCompletedAtMs: null
    })
  | (ManagedConditionInventoryBase & {
      readonly state: 'retired'
      readonly resolution: PersistedVerifiedConditionResolution
      readonly retirementIntent: ManagedConditionRetirementIntent
      readonly retirementStartedAtMs: number
      readonly retirementCompletedAtMs: number
    })

export interface ManagedConditionInventoryQuiescence {
  readonly earlierWorkCount: number
  readonly unknownWorkCount: number
  readonly corruptWorkCount: number
  readonly pendingRetirementWorkCount: number
  readonly selectableRetirementProofCount: number
  readonly unappliedResultCount: number
}

export interface PersistedManagedConditionOperationAuthority {
  readonly operationId: string
  readonly scopeId: string
  readonly inventoryRevisionAtBind: number
  readonly purpose: 'existing-recovery' | 'retirement-redemption'
  readonly resolutionEvidenceFingerprint: string | null
  readonly retirementIntentId: string | null
}

export type ManagedConditionInventoryMutation =
  | { readonly kind: 'new-economic-intent' }
  | {
      readonly kind: 'exact-existing-recovery'
      readonly authority: PersistedManagedConditionOperationAuthority
    }
  | {
      readonly kind: 'retirement-redemption'
      readonly authority: PersistedManagedConditionOperationAuthority
    }
  | { readonly kind: 'proof-retention-or-audit' }

export function verifyDlcConditionResolution(
  expected: ManagedConditionInventoryBinding,
  registered: PersistedRegisteredDlcConditionAuthority,
  input: DlcConditionResolutionEvidence,
): VerifiedConditionResolution {
  const binding = decodeManagedConditionInventoryBinding(expected)
  const authority = decodePersistedRegisteredDlcConditionAuthority(registered)
  assertSameBinding(binding, authority)
  const exact = prepareResolutionEvidence(input)
  const evidence = decodeDlcEvidence(exact.artifact)
  if (!authority.outcomes.includes(evidence.resolvedOutcome)) {
    throw new Error('resolved outcome is foreign')
  }
  verifyAttestationThreshold(authority, evidence)
  return brandResolution({
    schemaVersion: 1,
    ...binding,
    source: 'dlc-oracle-attestation',
    conditionIdentity: fingerprintCondition(authority),
    announcementIdentities: authority.oracles.map((oracle) => oracle.announcementIdentity),
    attestationIdentity: fingerprintAttestation(evidence),
    resolvedOutcome: evidence.resolvedOutcome,
    authorityId: fingerprintAuthority(authority),
    evidenceFingerprint: exact.fingerprint,
  })
}

/** Decode and canonicalize the mint's enum-outcome oracle witness. */
export function prepareDlcConditionResolutionEvidence(
  resolvedOutcome: string,
  value: unknown,
): PreparedDlcConditionResolutionEvidence {
  const outcome = canonicalText(resolvedOutcome, 'resolved outcome')
  if (!record(value)) throw new Error('condition oracle witness is invalid')
  exactKeys(value, ['oracle_sigs'], 'condition oracle witness')
  if (!Array.isArray(value.oracle_sigs)) throw new Error('condition oracle witness is invalid')
  const signatures = value.oracle_sigs.map((entry) => {
    if (!record(entry)) throw new Error('condition oracle witness signature is invalid')
    exactKeys(
      entry,
      ['oracle_pubkey', 'oracle_sig', 'outcome'],
      'condition oracle witness signature',
    )
    if (canonicalText(entry.outcome, 'condition oracle witness outcome') !== outcome) {
      throw new Error('condition oracle witness outcome is foreign')
    }
    return {
      oraclePublicKey: hex(entry.oracle_pubkey, 64, 'oracle public key'),
      signature: hex(entry.oracle_sig, 128, 'oracle signature'),
    }
  })
  const evidence = decodeDlcEvidence({
    schemaVersion: 1,
    source: 'dlc-oracle-attestation',
    attestations: signatures,
    resolvedOutcome: outcome,
  })
  const ordered = [...evidence.attestations].sort((left, right) =>
    left.oraclePublicKey.localeCompare(right.oraclePublicKey),
  )
  return {
    evidence: { ...evidence, attestations: ordered },
    canonicalOracleWitness: JSON.stringify({
      oracle_sigs: ordered.map(({ oraclePublicKey, signature }) => ({
        oracle_pubkey: oraclePublicKey,
        oracle_sig: signature,
        outcome,
      })),
    }),
  }
}

/** Decode exact condition registration facts loaded by the trusted local custody transaction. */
export function decodePersistedRegisteredDlcConditionAuthority(
  value: PersistedRegisteredDlcConditionAuthority,
): PersistedRegisteredDlcConditionAuthority {
  const decoded = decodeRegisteredConditionAuthority(value)
  const derivedConditionId = deriveDlcConditionId({
    eventId: decoded.eventId,
    outcomeCount: decoded.outcomes.length,
    oraclePublicKeys: decoded.oracles.map((oracle) => oracle.oraclePublicKey),
  })
  if (decoded.conditionId !== derivedConditionId) {
    throw new Error('registered condition authority is foreign')
  }
  return Object.freeze({
    ...decoded,
    outcomes: Object.freeze([...decoded.outcomes]),
    oracles: Object.freeze(decoded.oracles.map((oracle) => Object.freeze({ ...oracle }))),
  })
}

export function deriveDlcConditionId(input: {
  readonly eventId: string
  readonly outcomeCount: number
  readonly oraclePublicKeys: readonly string[]
}): string {
  const eventId = canonicalText(input.eventId, 'oracle event id')
  const outcomeCount = positiveCount(input.outcomeCount, 'outcome count')
  if (outcomeCount < 2 || outcomeCount > OUTCOME_COUNT_MAX)
    throw new Error('outcome count is invalid')
  if (input.oraclePublicKeys.length === 0 || input.oraclePublicKeys.length > ORACLE_COUNT_MAX)
    throw new Error('condition oracle set is invalid')
  const pubkeys = input.oraclePublicKeys
    .map((value) => hexToBytes(hex(value, 64, 'oracle public key')))
    .sort(compareBytes)
  if (new Set(pubkeys.map(bytesToHex)).size !== pubkeys.length)
    throw new Error('condition oracle is duplicated')
  return bytesToHex(
    taggedHash(
      'Cashu_condition_id',
      concatBytes(...pubkeys, utf8ToBytes(eventId), Uint8Array.of(outcomeCount)),
    ),
  )
}

export function persistVerifiedConditionResolution(
  value: VerifiedConditionResolution,
): PersistedVerifiedConditionResolution {
  if (value[verifiedResolutionBrand] !== true) {
    throw new Error('condition resolution evidence was not verified by the SDK')
  }
  return decodePersistedResolution(value)
}

export function createManagedConditionRetirementIntent(input: {
  readonly binding: ManagedConditionInventoryBinding
  readonly kind: ManagedConditionRetirementIntentKind
  readonly intentId: string
  readonly createdAtMs: number
}): ManagedConditionRetirementIntent {
  return {
    schemaVersion: 1,
    ...decodeManagedConditionInventoryBinding(input.binding),
    kind: decodeIntentKind(input.kind),
    intentId: text(input.intentId, 'retirement intent id'),
    createdAtMs: count(input.createdAtMs, 'retirement intent time'),
  }
}

export function createManagedConditionInventoryState(
  input: ManagedConditionInventoryBinding,
): ManagedConditionInventoryState {
  return {
    schemaVersion: 1,
    ...decodeManagedConditionInventoryBinding(input),
    revision: 0,
    state: 'active',
    resolution: null,
    retirementIntent: null,
    retirementStartedAtMs: null,
    retirementCompletedAtMs: null,
  }
}

export function startManagedConditionInventoryRetirement(input: {
  readonly current: ManagedConditionInventoryState
  readonly resolution: VerifiedConditionResolution
  readonly retirementIntent: ManagedConditionRetirementIntent
  readonly startedAtMs: number
}): ManagedConditionInventoryState {
  const current = decodeManagedConditionInventoryState(input.current)
  const resolution = persistVerifiedConditionResolution(input.resolution)
  const intent = decodeRetirementIntent(input.retirementIntent)
  assertSameBinding(current, resolution)
  assertSameBinding(current, intent)
  if (current.state === 'retiring') return exactRetirementRetry(current, resolution, intent)
  if (current.state === 'retired') throw new Error('managed condition inventory is retired')
  const startedAtMs = count(input.startedAtMs, 'retirement start time')
  if (startedAtMs < intent.createdAtMs) throw new Error('retirement starts before its intent')
  return {
    ...current,
    revision: 1,
    state: 'retiring',
    resolution,
    retirementIntent: intent,
    retirementStartedAtMs: startedAtMs,
    retirementCompletedAtMs: null,
  }
}

export function completeManagedConditionInventoryRetirement(input: {
  readonly current: ManagedConditionInventoryState
  readonly quiescence: ManagedConditionInventoryQuiescence
  readonly completedAtMs: number
}): ManagedConditionInventoryState {
  const current = decodeManagedConditionInventoryState(input.current)
  if (current.state === 'active') throw new Error('managed condition inventory is active')
  if (current.state === 'retired') return current
  assertQuiescent(input.quiescence)
  const completedAtMs = count(input.completedAtMs, 'retirement completion time')
  if (completedAtMs < current.retirementStartedAtMs)
    throw new Error('retirement completion time precedes its start')
  return {
    ...current,
    revision: current.revision + 1,
    state: 'retired',
    retirementCompletedAtMs: completedAtMs,
  }
}

export function assertManagedConditionInventoryMutation(
  current: ManagedConditionInventoryState,
  mutation: ManagedConditionInventoryMutation,
): void {
  const state = decodeManagedConditionInventoryState(current)
  if (mutation.kind === 'proof-retention-or-audit') return
  if (mutation.kind === 'new-economic-intent') {
    if (state.state !== 'active') throw new Error('managed condition inventory rejects new intent')
    return
  }
  assertOperationMutation(state, mutation.kind, mutation.authority)
}

export function decodeManagedConditionInventoryState(
  value: unknown,
): ManagedConditionInventoryState {
  if (!record(value)) throw new Error('managed condition inventory state is invalid')
  exactKeys(value, STATE_KEYS, 'managed condition inventory state')
  const base = {
    schemaVersion: schema(value.schemaVersion),
    ...decodeManagedConditionInventoryBinding(value),
    revision: count(value.revision, 'managed condition inventory revision'),
  }
  if (value.state === 'active') return decodeActive(value, base)
  if (value.state === 'retiring') return decodeRetiring(value, base)
  if (value.state === 'retired') return decodeRetired(value, base)
  throw new Error('managed condition inventory state is invalid')
}

export function decodeManagedConditionInventoryBinding(
  value: unknown,
): ManagedConditionInventoryBinding {
  if (!record(value)) throw new Error('managed condition inventory binding is invalid')
  return {
    scopeId: decodeDurableCustodyScopeId(value.scopeId),
    normalizedMint: decodeCanonicalMintOrigin(value.normalizedMint),
    unit: text(value.unit, 'condition inventory unit'),
    conditionId: hex(value.conditionId, 64, 'condition id'),
    canonicalParentCollectionId: parentId(value.canonicalParentCollectionId),
  }
}

function decodeActive(
  value: Record<string, unknown>,
  base: ManagedConditionInventoryBase,
): ManagedConditionInventoryState {
  if (base.revision !== 0) throw new Error('active inventory revision is invalid')
  if (
    value.resolution !== null ||
    value.retirementIntent !== null ||
    value.retirementStartedAtMs !== null ||
    value.retirementCompletedAtMs !== null
  )
    throw new Error('active inventory contains retirement authority')
  return {
    ...base,
    state: 'active',
    resolution: null,
    retirementIntent: null,
    retirementStartedAtMs: null,
    retirementCompletedAtMs: null,
  }
}

function decodeRetiring(
  value: Record<string, unknown>,
  base: ManagedConditionInventoryBase,
): ManagedConditionInventoryState {
  if (base.revision !== 1) throw new Error('retiring inventory revision is invalid')
  const resolution = decodePersistedResolution(value.resolution)
  const retirementIntent = decodeRetirementIntent(value.retirementIntent)
  assertSameBinding(base, resolution)
  assertSameBinding(base, retirementIntent)
  if (value.retirementCompletedAtMs !== null)
    throw new Error('retiring inventory is already complete')
  return {
    ...base,
    state: 'retiring',
    resolution,
    retirementIntent,
    retirementStartedAtMs: count(value.retirementStartedAtMs, 'retirement start time'),
    retirementCompletedAtMs: null,
  }
}

function decodeRetired(
  value: Record<string, unknown>,
  base: ManagedConditionInventoryBase,
): ManagedConditionInventoryState {
  if (base.revision !== 2) throw new Error('retired inventory revision is invalid')
  const retiring = decodeRetiring(
    { ...value, state: 'retiring', retirementCompletedAtMs: null },
    { ...base, revision: 1 },
  )
  if (retiring.state !== 'retiring') throw new Error('retired inventory authority is invalid')
  const completedAtMs = count(value.retirementCompletedAtMs, 'retirement completion time')
  if (completedAtMs < retiring.retirementStartedAtMs)
    throw new Error('retirement completion time precedes its start')
  return { ...retiring, revision: 2, state: 'retired', retirementCompletedAtMs: completedAtMs }
}

function decodeDlcEvidence(value: unknown): DlcConditionResolutionEvidence {
  if (!record(value)) throw new Error('DLC condition resolution evidence is invalid')
  exactKeys(value, DLC_EVIDENCE_KEYS, 'DLC condition resolution evidence')
  if (schema(value.schemaVersion) !== 1 || value.source !== 'dlc-oracle-attestation')
    throw new Error('DLC condition resolution evidence is invalid')
  return {
    schemaVersion: 1,
    source: 'dlc-oracle-attestation',
    attestations: decodeAttestations(value.attestations),
    resolvedOutcome: canonicalText(value.resolvedOutcome, 'resolved outcome'),
  }
}

function decodeRegisteredConditionAuthority(
  value: unknown,
): PersistedRegisteredDlcConditionAuthority {
  if (!record(value)) throw new Error('registered condition authority is invalid')
  exactKeys(value, REGISTERED_CONDITION_KEYS, 'registered condition authority')
  const binding = decodeManagedConditionInventoryBinding(value)
  const outcomes = uniqueTexts(value.outcomes, 'condition outcome', OUTCOME_COUNT_MAX)
  const oracles = decodeRegisteredOracles(value.oracles)
  const threshold = positiveCount(value.threshold, 'oracle threshold')
  if (threshold > oracles.length) throw new Error('oracle threshold is invalid')
  return {
    schemaVersion: schema(value.schemaVersion),
    ...binding,
    eventId: canonicalText(value.eventId, 'oracle event id'),
    outcomes,
    threshold,
    oracles,
  }
}

function decodeRegisteredOracles(
  value: unknown,
): PersistedRegisteredDlcConditionAuthority['oracles'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ORACLE_COUNT_MAX)
    throw new Error('condition oracle set is invalid')
  const result = value.map((item) => {
    if (!record(item)) throw new Error('condition oracle is invalid')
    exactKeys(item, ['oraclePublicKey', 'noncePoint', 'announcementIdentity'], 'condition oracle')
    return {
      oraclePublicKey: hex(item.oraclePublicKey, 64, 'oracle public key'),
      noncePoint: hex(item.noncePoint, 64, 'oracle nonce point'),
      announcementIdentity: fingerprint(item.announcementIdentity, 'announcement identity'),
    }
  })
  if (new Set(result.map((item) => item.oraclePublicKey)).size !== result.length)
    throw new Error('condition oracle is duplicated')
  return result
}

function decodeAttestations(value: unknown): DlcConditionResolutionEvidence['attestations'] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ORACLE_COUNT_MAX)
    throw new Error('condition attestation set is invalid')
  const result = value.map((item) => {
    if (!record(item)) throw new Error('condition attestation is invalid')
    exactKeys(item, ['oraclePublicKey', 'signature'], 'condition attestation')
    return {
      oraclePublicKey: hex(item.oraclePublicKey, 64, 'oracle public key'),
      signature: hex(item.signature, 128, 'oracle signature'),
    }
  })
  if (new Set(result.map((item) => item.oraclePublicKey)).size !== result.length)
    throw new Error('condition attestation is duplicated')
  return result
}

function verifyAttestationThreshold(
  registered: PersistedRegisteredDlcConditionAuthority,
  evidence: DlcConditionResolutionEvidence,
): void {
  const oracles = new Map(registered.oracles.map((oracle) => [oracle.oraclePublicKey, oracle]))
  const message = taggedHash('DLC/oracle/attestation/v0', utf8ToBytes(evidence.resolvedOutcome))
  let valid = 0
  for (const attestation of evidence.attestations) {
    const oracle = oracles.get(attestation.oraclePublicKey)
    if (oracle === undefined) throw new Error('condition attestation oracle is foreign')
    const signature = hexToBytes(attestation.signature)
    if (
      bytesToHex(signature.slice(0, 32)) !== oracle.noncePoint ||
      !schnorr.verify(signature, message, hexToBytes(oracle.oraclePublicKey))
    )
      throw new Error('condition attestation signature is invalid')
    valid += 1
  }
  if (valid < registered.threshold) throw new Error('condition attestation threshold is not met')
}

function decodePersistedResolution(value: unknown): PersistedVerifiedConditionResolution {
  if (!record(value)) throw new Error('verified condition resolution is invalid')
  exactKeys(value, RESOLUTION_KEYS, 'verified condition resolution')
  if (schema(value.schemaVersion) !== 1 || value.source !== 'dlc-oracle-attestation')
    throw new Error('verified condition resolution is invalid')
  return {
    schemaVersion: 1,
    ...decodeManagedConditionInventoryBinding(value),
    source: 'dlc-oracle-attestation',
    conditionIdentity: fingerprint(value.conditionIdentity, 'condition identity'),
    announcementIdentities: uniqueFingerprints(
      value.announcementIdentities,
      'announcement identity',
    ),
    attestationIdentity: fingerprint(value.attestationIdentity, 'attestation identity'),
    resolvedOutcome: canonicalText(value.resolvedOutcome, 'resolved outcome'),
    authorityId: fingerprint(value.authorityId, 'resolution authority id'),
    evidenceFingerprint: fingerprint(value.evidenceFingerprint, 'resolution evidence fingerprint'),
  }
}

function decodeRetirementIntent(value: unknown): ManagedConditionRetirementIntent {
  if (!record(value)) throw new Error('retirement intent is invalid')
  exactKeys(value, INTENT_KEYS, 'retirement intent')
  return {
    schemaVersion: schema(value.schemaVersion),
    ...decodeManagedConditionInventoryBinding(value),
    kind: decodeIntentKind(value.kind),
    intentId: text(value.intentId, 'retirement intent id'),
    createdAtMs: count(value.createdAtMs, 'retirement intent time'),
  }
}

function decodeOperationAuthority(
  value: unknown,
  scopeId: string,
): PersistedManagedConditionOperationAuthority {
  if (!record(value)) throw new Error('managed condition operation authority is invalid')
  exactKeys(value, OPERATION_AUTHORITY_KEYS, 'managed condition operation authority')
  if (value.scopeId !== scopeId) throw new Error('managed condition operation scope is foreign')
  const operationId = decodeDurableCustodyOperationId(value.operationId, scopeId)
  const inventoryRevisionAtBind = count(value.inventoryRevisionAtBind, 'inventory revision at bind')
  if (value.purpose === 'existing-recovery')
    return {
      operationId,
      scopeId,
      inventoryRevisionAtBind,
      purpose: value.purpose,
      resolutionEvidenceFingerprint: nullValue(
        value.resolutionEvidenceFingerprint,
        'resolution fingerprint',
      ),
      retirementIntentId: nullValue(value.retirementIntentId, 'retirement intent id'),
    }
  if (value.purpose !== 'retirement-redemption')
    throw new Error('managed condition operation purpose is invalid')
  return {
    operationId,
    scopeId,
    inventoryRevisionAtBind,
    purpose: value.purpose,
    resolutionEvidenceFingerprint: fingerprint(
      value.resolutionEvidenceFingerprint,
      'resolution fingerprint',
    ),
    retirementIntentId: text(value.retirementIntentId, 'retirement intent id'),
  }
}

function assertExistingRecoveryRevision(
  state: ManagedConditionInventoryState,
  authority: PersistedManagedConditionOperationAuthority,
): void {
  if (
    state.state === 'retired' ||
    authority.inventoryRevisionAtBind > state.revision ||
    (state.state === 'retiring' && authority.inventoryRevisionAtBind >= state.revision)
  )
    throw new Error('existing recovery was not bound before retirement')
}

function assertRetirementOperationBinding(
  state: ManagedConditionInventoryState,
  authority: PersistedManagedConditionOperationAuthority,
): void {
  if (
    state.state !== 'retiring' ||
    authority.inventoryRevisionAtBind !== state.revision ||
    authority.resolutionEvidenceFingerprint !== state.resolution.evidenceFingerprint ||
    authority.retirementIntentId !== state.retirementIntent.intentId
  )
    throw new Error('retirement operation authority is foreign')
}

function assertOperationMutation(
  state: ManagedConditionInventoryState,
  kind: 'exact-existing-recovery' | 'retirement-redemption',
  persisted: PersistedManagedConditionOperationAuthority,
): void {
  const authority = decodeOperationAuthority(persisted, state.scopeId)
  if (kind === 'exact-existing-recovery' && authority.purpose !== 'existing-recovery')
    throw new Error('managed condition operation purpose is foreign')
  if (kind === 'retirement-redemption' && authority.purpose !== 'retirement-redemption')
    throw new Error('managed condition operation purpose is foreign')
  if (kind === 'exact-existing-recovery') assertExistingRecoveryRevision(state, authority)
  else assertRetirementOperationBinding(state, authority)
}

function exactRetirementRetry(
  current: Extract<ManagedConditionInventoryState, { state: 'retiring' }>,
  resolution: PersistedVerifiedConditionResolution,
  intent: ManagedConditionRetirementIntent,
): ManagedConditionInventoryState {
  if (
    !sameResolution(current.resolution, resolution) ||
    current.retirementIntent.kind !== intent.kind ||
    current.retirementIntent.intentId !== intent.intentId ||
    current.retirementIntent.createdAtMs !== intent.createdAtMs
  )
    throw new Error('managed condition inventory retirement retry conflicts')
  return current
}

function sameResolution(
  left: PersistedVerifiedConditionResolution,
  right: PersistedVerifiedConditionResolution,
): boolean {
  return (
    left.conditionIdentity === right.conditionIdentity &&
    left.attestationIdentity === right.attestationIdentity &&
    left.resolvedOutcome === right.resolvedOutcome &&
    left.authorityId === right.authorityId &&
    left.evidenceFingerprint === right.evidenceFingerprint &&
    left.announcementIdentities.length === right.announcementIdentities.length &&
    left.announcementIdentities.every(
      (value, index) => value === right.announcementIdentities[index],
    )
  )
}

function assertQuiescent(value: ManagedConditionInventoryQuiescence): void {
  if (!record(value)) throw new Error('managed condition inventory is not quiescent')
  exactKeys(value, QUIESCENCE_KEYS, 'managed condition inventory quiescence')
  if (Object.values(value).some((item) => count(item, 'quiescence count') !== 0))
    throw new Error('managed condition inventory is not quiescent')
}

function assertSameBinding(
  expected: ManagedConditionInventoryBinding,
  actual: ManagedConditionInventoryBinding,
): void {
  if (
    expected.scopeId !== actual.scopeId ||
    expected.normalizedMint !== actual.normalizedMint ||
    expected.unit !== actual.unit ||
    expected.conditionId !== actual.conditionId ||
    expected.canonicalParentCollectionId !== actual.canonicalParentCollectionId
  )
    throw new Error('managed condition inventory authority is foreign')
}

function prepareResolutionEvidence(value: unknown): { artifact: unknown; fingerprint: string } {
  const exact = prepareDurableCustodyExactArtifact(value)
  const bytes = encodeBoundedDurableArtifact(exact.artifact, EVIDENCE_BYTES_MAX)
  return { artifact: exact.artifact, fingerprint: bytesToHex(sha256(bytes)) }
}

function brandResolution(value: PersistedVerifiedConditionResolution): VerifiedConditionResolution {
  const branded = {
    ...value,
    announcementIdentities: Object.freeze([...value.announcementIdentities]),
  } as VerifiedConditionResolution
  Object.defineProperty(branded, verifiedResolutionBrand, { value: true })
  return Object.freeze(branded)
}

function fingerprintCondition(value: PersistedRegisteredDlcConditionAuthority): string {
  return artifactFingerprint({
    eventId: value.eventId,
    outcomes: value.outcomes,
    threshold: value.threshold,
    oracles: value.oracles,
  })
}

function fingerprintAttestation(value: DlcConditionResolutionEvidence): string {
  return artifactFingerprint({
    resolvedOutcome: value.resolvedOutcome,
    attestations: value.attestations,
  })
}

function fingerprintAuthority(value: PersistedRegisteredDlcConditionAuthority): string {
  return artifactFingerprint({
    threshold: value.threshold,
    oraclePublicKeys: value.oracles.map((oracle) => oracle.oraclePublicKey).sort(),
  })
}

function artifactFingerprint(value: unknown): string {
  return bytesToHex(sha256(encodeBoundedDurableArtifact(value, EVIDENCE_BYTES_MAX)))
}

function taggedHash(tag: string, message: Uint8Array): Uint8Array {
  const tagHash = sha256(utf8ToBytes(tag))
  return sha256(concatBytes(tagHash, tagHash, message))
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < left.length; index += 1)
    if (left[index] !== right[index]) return left[index]! - right[index]!
  return left.length - right.length
}

function uniqueTexts(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximum)
    throw new Error(`${label} list is invalid`)
  const result = value.map((item) => canonicalText(item, label))
  if (new Set(result).size !== result.length) throw new Error(`${label} is duplicated`)
  return result
}

function uniqueFingerprints(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > ORACLE_COUNT_MAX)
    throw new Error(`${label} list is invalid`)
  const result = value.map((item) => fingerprint(item, label))
  if (new Set(result).size !== result.length) throw new Error(`${label} is duplicated`)
  return result
}

function canonicalText(value: unknown, label: string): string {
  const result = text(value, label)
  if (result.normalize('NFC') !== result) throw new Error(`${label} is not canonical NFC`)
  return result
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || utf8ToBytes(value).length > TEXT_BYTES_MAX)
    throw new Error(`${label} is invalid`)
  return value
}

function hex(value: unknown, length: number, label: string): string {
  if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/.test(value))
    throw new Error(`${label} is invalid`)
  return value
}

function fingerprint(value: unknown, label: string): string {
  return hex(value, 64, label)
}

function parentId(value: unknown): string | null {
  if (value === null || value === '0'.repeat(64)) return null
  return hex(value, 64, 'parent collection id')
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`)
  return Number(value)
}

function positiveCount(value: unknown, label: string): number {
  const result = count(value, label)
  if (result === 0) throw new Error(`${label} is invalid`)
  return result
}

function nullValue(value: unknown, label: string): null {
  if (value !== null) throw new Error(`${label} must be null`)
  return null
}

function schema(value: unknown): 1 {
  if (value !== 1) throw new Error('managed condition schema is unsupported')
  return 1
}

function decodeIntentKind(value: unknown): ManagedConditionRetirementIntentKind {
  if (
    value !== 'automated-service-policy' &&
    value !== 'daemon-standing-policy' &&
    value !== 'explicit-user-command'
  )
    throw new Error('retirement intent kind is invalid')
  return value
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys)
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  )
    throw new Error(`${label} contains foreign fields`)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const STATE_KEYS = [
  'schemaVersion',
  'scopeId',
  'normalizedMint',
  'unit',
  'conditionId',
  'canonicalParentCollectionId',
  'revision',
  'state',
  'resolution',
  'retirementIntent',
  'retirementStartedAtMs',
  'retirementCompletedAtMs',
] as const
const DLC_EVIDENCE_KEYS = ['schemaVersion', 'source', 'attestations', 'resolvedOutcome'] as const
const REGISTERED_CONDITION_KEYS = [
  'schemaVersion',
  'scopeId',
  'normalizedMint',
  'unit',
  'conditionId',
  'canonicalParentCollectionId',
  'eventId',
  'outcomes',
  'threshold',
  'oracles',
] as const
const RESOLUTION_KEYS = [
  'schemaVersion',
  'scopeId',
  'normalizedMint',
  'unit',
  'conditionId',
  'canonicalParentCollectionId',
  'source',
  'conditionIdentity',
  'announcementIdentities',
  'attestationIdentity',
  'resolvedOutcome',
  'authorityId',
  'evidenceFingerprint',
] as const
const INTENT_KEYS = [
  'schemaVersion',
  'scopeId',
  'normalizedMint',
  'unit',
  'conditionId',
  'canonicalParentCollectionId',
  'kind',
  'intentId',
  'createdAtMs',
] as const
const OPERATION_AUTHORITY_KEYS = [
  'operationId',
  'scopeId',
  'inventoryRevisionAtBind',
  'purpose',
  'resolutionEvidenceFingerprint',
  'retirementIntentId',
] as const
const QUIESCENCE_KEYS = [
  'earlierWorkCount',
  'unknownWorkCount',
  'corruptWorkCount',
  'pendingRetirementWorkCount',
  'selectableRetirementProofCount',
  'unappliedResultCount',
] as const
