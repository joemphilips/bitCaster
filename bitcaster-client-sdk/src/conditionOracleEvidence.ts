import type { DurableCustodyMintKeysetAuthority } from './durableCustodyMintResult.ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { Keyset, type Proof } from '@cashu/cashu-ts'
import {
  decodePersistedRegisteredDlcConditionAuthority,
  prepareDlcConditionResolutionEvidence,
  verifyDlcOracleResolution,
  type DlcConditionResolutionEvidence,
  type PersistedRegisteredDlcConditionAuthority,
  type ManagedConditionInventoryBinding,
} from './managedConditionInventory.ts'
import {
  canonicalProofOperationMintIdentity,
  proofAuthority,
  proofOperationAuthorityDigest,
  requireProofArray,
} from './ctfProofOperationAuthority.ts'
import { canonicalizeOutcomeSet, parseOutcomeSetId } from './outcomeSets.ts'

export const UNVERIFIED_CONDITION_OUTCOME_WARNING =
  'The mint reports this outcome, but we have not verified evidence from the intended oracle.'

export interface ConditionOracleResolutionContext {
  readonly registered: PersistedRegisteredDlcConditionAuthority
  readonly evidence: DlcConditionResolutionEvidence
}

export type ConditionOracleEvidence =
  | {
      readonly status: 'verified'
      readonly context: ConditionOracleResolutionContext
      readonly canonicalOracleWitness: string
    }
  | {
      readonly status: 'unverified'
      readonly reason: 'missing' | 'unavailable' | 'invalid'
      readonly warning: typeof UNVERIFIED_CONDITION_OUTCOME_WARNING
    }

export function requireVerifiedConditionOracleEvidence(
  value: ConditionOracleResolutionContext,
): Extract<ConditionOracleEvidence, { status: 'verified' }> {
  const registered = decodePersistedRegisteredDlcConditionAuthority(value.registered)
  verifyDlcOracleResolution(registered, value.evidence)
  const prepared = prepareDlcConditionResolutionEvidence(value.evidence.resolvedOutcome, {
    oracle_sigs: value.evidence.attestations.map(({ oraclePublicKey, signature }) => ({
      oracle_pubkey: oraclePublicKey,
      oracle_sig: signature,
      outcome: value.evidence.resolvedOutcome,
    })),
  })
  const context = Object.freeze({
    registered,
    evidence: Object.freeze({
      ...prepared.evidence,
      attestations: Object.freeze(
        prepared.evidence.attestations.map((item) => Object.freeze(item)),
      ),
    }),
  })
  return Object.freeze({
    status: 'verified',
    context,
    canonicalOracleWitness: prepared.canonicalOracleWitness,
  })
}

export function createConditionOracleEvidenceResolver(
  options: { readonly maxEntries?: number } = {},
) {
  const maxEntries = options.maxEntries ?? 64
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 256)
    throw new Error('condition evidence cache bound is invalid')
  const cache = new Map<string, Extract<ConditionOracleEvidence, { status: 'verified' }>>()
  return {
    clear(): void {
      cache.clear()
    },
    async resolveFromMint(input: {
      readonly binding: ManagedConditionInventoryBinding
      readonly fetchRegisteredAuthority: () => Promise<unknown>
      readonly fetchInitialAttestation?: () => Promise<unknown>
      readonly fetchConditionInfo: (includeOracleSigs: boolean) => Promise<unknown>
    }): Promise<{ readonly evidence: ConditionOracleEvidence; readonly resolvedOutcome?: string }> {
      let raw: unknown
      try {
        raw = await input.fetchConditionInfo(false)
      } catch {
        return { evidence: unverified('unavailable') }
      }
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return { evidence: unverified('invalid') }
      const info = raw as Record<string, unknown>
      if (
        info.condition_id !== input.binding.conditionId ||
        (info.attestation !== undefined &&
          (typeof info.attestation !== 'object' ||
            info.attestation === null ||
            Array.isArray(info.attestation)))
      )
        return { evidence: unverified('invalid') }
      const attestation = (info.attestation ?? { status: 'pending' }) as Record<string, unknown>
      if (attestation.status !== 'attested' && attestation.status !== 'pending')
        return { evidence: unverified('invalid') }
      if (attestation.status === 'pending') {
        if (input.fetchInitialAttestation === undefined) return { evidence: unverified('missing') }
        let initial: unknown
        try {
          initial = await input.fetchInitialAttestation()
        } catch {
          return { evidence: unverified('unavailable') }
        }
        try {
          if (typeof initial !== 'object' || initial === null || Array.isArray(initial))
            throw new Error('initial attestation is invalid')
          const response = initial as Record<string, unknown>
          if (
            response.conditionId !== input.binding.conditionId ||
            typeof response.attestedOutcome !== 'string'
          )
            throw new Error('initial attestation is foreign')
          const registered = bindRegisteredDlcConditionAuthority(
            input.binding,
            response.registeredAuthority,
          )
          assertConditionOracleMintRegistration(registered, response.attestedOutcome, raw, false)
          const evidence = await this.resolve({
            registered,
            resolvedOutcome: response.attestedOutcome,
            fetchWitness: async () => response.oracleWitness,
          })
          return {
            evidence,
            ...(evidence.status === 'verified'
              ? { resolvedOutcome: response.attestedOutcome }
              : {}),
          }
        } catch {
          for (const [key, cached] of cache) {
            if (
              cached.context.registered.conditionId === input.binding.conditionId &&
              cached.context.registered.normalizedMint === input.binding.normalizedMint
            )
              cache.delete(key)
          }
          return { evidence: unverified('invalid') }
        }
      }
      const resolvedOutcome = attestation.winning_outcome
      if (
        typeof resolvedOutcome !== 'string' ||
        resolvedOutcome.length === 0 ||
        resolvedOutcome.length > 16384 ||
        resolvedOutcome !== resolvedOutcome.trim()
      )
        return { evidence: unverified('invalid') }
      let registered: PersistedRegisteredDlcConditionAuthority
      try {
        registered = bindRegisteredDlcConditionAuthority(
          input.binding,
          await input.fetchRegisteredAuthority(),
        )
      } catch {
        return { evidence: unverified('unavailable'), resolvedOutcome }
      }
      try {
        assertConditionOracleMintRegistration(registered, resolvedOutcome, raw)
      } catch {
        for (const [key, cached] of cache) {
          if (
            cached.context.registered.normalizedMint === registered.normalizedMint &&
            cached.context.registered.conditionId === registered.conditionId
          )
            cache.delete(key)
        }
        return { evidence: unverified('invalid'), resolvedOutcome }
      }
      const evidence = await this.resolve({
        registered,
        resolvedOutcome,
        fetchWitness: async () =>
          prepareConditionOracleWitnessFromMintInfo(
            registered,
            resolvedOutcome,
            await input.fetchConditionInfo(true),
          ),
      })
      return { evidence, resolvedOutcome }
    },
    async resolve(input: {
      readonly registered?: PersistedRegisteredDlcConditionAuthority
      readonly resolvedOutcome: string
      readonly fetchWitness: () => Promise<unknown>
    }): Promise<ConditionOracleEvidence> {
      if (input.registered === undefined) return unverified('missing')
      let registered: PersistedRegisteredDlcConditionAuthority
      try {
        registered = decodePersistedRegisteredDlcConditionAuthority(input.registered)
      } catch {
        return unverified('invalid')
      }
      const key = proofOperationAuthorityDigest({
        registered,
        resolvedOutcome: input.resolvedOutcome,
      })
      const identity = `${registered.normalizedMint}:${registered.conditionId}`
      // A different reported result must not reuse a former claim's verification.
      for (const [entry, result] of cache) {
        if (
          `${result.context.registered.normalizedMint}:${result.context.registered.conditionId}` ===
            identity &&
          entry !== key
        )
          cache.delete(entry)
      }
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      let witness: unknown
      try {
        witness = await input.fetchWitness()
      } catch {
        return unverified('unavailable')
      }
      if (witness === undefined || witness === null) return unverified('missing')
      try {
        const prepared = prepareDlcConditionResolutionEvidence(input.resolvedOutcome, witness)
        const verified = requireVerifiedConditionOracleEvidence({
          registered,
          evidence: prepared.evidence,
        })
        cache.set(key, verified)
        if (cache.size > maxEntries) cache.delete(cache.keys().next().value!)
        return verified
      } catch {
        return unverified('invalid')
      }
    },
  }
}

function unverified(reason: 'missing' | 'unavailable' | 'invalid'): ConditionOracleEvidence {
  return { status: 'unverified', reason, warning: UNVERIFIED_CONDITION_OUTCOME_WARNING }
}

export interface CtfVerifiedLosingAuthority {
  readonly resolution: ConditionOracleResolutionContext
  readonly operationId: string
  readonly normalizedMint: string
  readonly conditionId: string
  readonly outcomeCollection: string
  readonly inputs: readonly Record<string, unknown>[]
  readonly inputKeysets: readonly DurableCustodyMintKeysetAuthority[]
}

export function prepareCtfVerifiedLosingAuthority(input: {
  readonly resolution: ConditionOracleResolutionContext
  readonly operationId: string
  readonly mintUrl: string
  readonly conditionId: string
  readonly outcomeCollection: string
  readonly inputs: readonly Proof[]
  readonly inputKeysets: readonly DurableCustodyMintKeysetAuthority[]
}): CtfVerifiedLosingAuthority {
  const verified = requireVerifiedConditionOracleEvidence(input.resolution)
  const mint = canonicalProofOperationMintIdentity(input.mintUrl)
  const members = parseOutcomeSetId(input.outcomeCollection)
  if (
    !input.operationId ||
    verified.context.registered.normalizedMint !== mint ||
    verified.context.registered.conditionId !== input.conditionId ||
    members.length === 0 ||
    canonicalizeOutcomeSet(members) !== input.outcomeCollection ||
    members.some((member) => !verified.context.registered.outcomes.includes(member)) ||
    members.includes(verified.context.evidence.resolvedOutcome) ||
    verified.context.registered.canonicalParentCollectionId !== null
  )
    throw new Error('CTF refusal does not prove this exact collection lost')
  const inputs = requireProofArray(input.inputs, 'verified losing inputs')
  if (inputs.length === 0 || inputs.length > 256)
    throw new Error('verified losing input count is invalid')
  const inputIds = new Set(inputs.map((proof) => proof.id))
  if (!Array.isArray(input.inputKeysets) || input.inputKeysets.length !== inputIds.size)
    throw new Error('verified losing conditional keyset authority is absent')
  const keysets = structuredClone(input.inputKeysets)
  for (const keyset of keysets) {
    if (
      !inputIds.delete(keyset.id) ||
      keyset.canonicalMintUrl !== mint ||
      keyset.unit !== verified.context.registered.unit ||
      keyset.identity.kind !== 'conditional' ||
      keyset.identity.conditionId !== input.conditionId ||
      keyset.identity.outcomeCollection !== input.outcomeCollection ||
      !Keyset.verifyConditionalKeysetId(
        {
          id: keyset.id,
          unit: keyset.unit,
          keys: { ...keyset.keys },
          input_fee_ppk: keyset.inputFeePpk,
          ...(keyset.finalExpiry === null ? {} : { final_expiry: keyset.finalExpiry }),
        },
        keyset.identity,
      )
    )
      throw new Error('verified losing conditional keyset authority is foreign')
  }
  return {
    resolution: verified.context,
    operationId: input.operationId,
    normalizedMint: mint,
    conditionId: input.conditionId,
    outcomeCollection: input.outcomeCollection,
    inputs: inputs.map(proofAuthority),
    inputKeysets: keysets,
  }
}

export function requireCtfVerifiedLosingAuthority(
  value: CtfVerifiedLosingAuthority,
  expected?: {
    readonly operationId: string
    readonly mintUrl: string
    readonly conditionId: string
    readonly outcomeCollection: string
    readonly inputs: readonly Proof[]
    readonly inputKeysets?: readonly DurableCustodyMintKeysetAuthority[]
  },
): CtfVerifiedLosingAuthority {
  const canonical = prepareCtfVerifiedLosingAuthority({
    resolution: value.resolution,
    operationId: value.operationId,
    mintUrl: value.normalizedMint,
    conditionId: value.conditionId,
    outcomeCollection: value.outcomeCollection,
    inputs: value.inputs as unknown as Proof[],
    inputKeysets: value.inputKeysets,
  })
  if (proofOperationAuthorityDigest(canonical) !== proofOperationAuthorityDigest(value))
    throw new Error('verified losing authority is not canonical')
  if (expected !== undefined) {
    const bound = prepareCtfVerifiedLosingAuthority({
      ...expected,
      resolution: canonical.resolution,
      inputKeysets: expected.inputKeysets ?? canonical.inputKeysets,
    })
    if (proofOperationAuthorityDigest(canonical) !== proofOperationAuthorityDigest(bound))
      throw new Error('verified losing authority is foreign to exact inputs')
  }
  return canonical
}

export type ConditionOracleEvidenceSummary =
  | { readonly status: 'verified' }
  | Extract<ConditionOracleEvidence, { status: 'unverified' }>

export function summarizeConditionOracleEvidence(
  value: ConditionOracleEvidence,
): ConditionOracleEvidenceSummary {
  switch (value.status) {
    case 'verified':
      return { status: 'verified' }
    case 'unverified':
      return { status: 'unverified', reason: value.reason, warning: value.warning }
    default:
      throw new Error('condition oracle evidence status is invalid')
  }
}

export function bindRegisteredDlcConditionAuthority(
  binding: ManagedConditionInventoryBinding,
  raw: unknown,
): PersistedRegisteredDlcConditionAuthority {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('intended condition registration is unavailable')
  const value = raw as Record<string, unknown>
  return decodePersistedRegisteredDlcConditionAuthority({
    schemaVersion: 1,
    ...binding,
    eventId: value.eventId as string,
    outcomes: value.outcomes as string[],
    threshold: value.threshold as number,
    oracles: value.oracles as PersistedRegisteredDlcConditionAuthority['oracles'],
  })
}

function assertConditionOracleMintRegistration(
  registered: PersistedRegisteredDlcConditionAuthority,
  resolvedOutcome: string,
  raw: unknown,
  requireRecordedResult = true,
): Record<string, unknown> {
  const intended = decodePersistedRegisteredDlcConditionAuthority(registered)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('mint condition evidence is invalid')
  const info = raw as Record<string, unknown>
  if (
    requireRecordedResult &&
    (typeof info.attestation !== 'object' ||
      info.attestation === null ||
      Array.isArray(info.attestation))
  )
    throw new Error('mint condition attestation is invalid')
  const attestation = (info.attestation ?? {}) as Record<string, unknown>
  if (
    info.condition_id !== intended.conditionId ||
    info.threshold !== intended.threshold ||
    info.collateral !== intended.unit ||
    (requireRecordedResult &&
      (attestation.status !== 'attested' || attestation.winning_outcome !== resolvedOutcome)) ||
    !Array.isArray(info.announcements) ||
    info.announcements.length !== intended.oracles.length
  )
    throw new Error('mint condition evidence registration is foreign')
  const announcements = info.announcements
    .map((announcement) => {
      if (
        typeof announcement !== 'string' ||
        announcement.length > 131072 ||
        !/^(?:[0-9a-f]{2})+$/.test(announcement)
      )
        throw new Error('mint condition announcement is invalid')
      return bytesToHex(sha256(hexToBytes(announcement)))
    })
    .sort()
  if (
    JSON.stringify(announcements) !==
    JSON.stringify(intended.oracles.map((oracle) => oracle.announcementIdentity).sort())
  )
    throw new Error('mint condition announcement is foreign')
  return attestation
}

export function prepareConditionOracleWitnessFromMintInfo(
  registered: PersistedRegisteredDlcConditionAuthority,
  resolvedOutcome: string,
  raw: unknown,
): { readonly oracle_sigs: unknown } {
  const attestation = assertConditionOracleMintRegistration(registered, resolvedOutcome, raw)
  if (
    !Array.isArray(attestation.oracle_sigs) ||
    attestation.oracle_sigs.length > registered.oracles.length
  )
    throw new Error('mint condition signature count is invalid')
  return { oracle_sigs: attestation.oracle_sigs }
}
