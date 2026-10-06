import { createHash } from 'node:crypto'
import { finalizeEvent } from 'nostr-tools/pure'
import {
  createOracleExplanationTemplate,
  normalizeMarketCreationInput,
  publishOracleOutcome,
  readSignedOracleEvent,
  retryOraclePublication,
  verifyOracleResolutionExplanation,
  type MarketCreationInput,
  type OraclePublicationAdapters,
  type OraclePublicationBinding,
  type OraclePublicationRecord,
  type OraclePublicationResult,
  type OraclePublicationOptions,
  type PreparedOracleAttestation,
  type VerifiedOraclePublicationEvidence,
} from '@bitcaster-market/client-sdk'
import {
  nativeOraclePublicationRecord,
  type NativeOracleCreationStore,
  type NativeOracleCreationRecord,
  type NativeImportedOracleRecord,
  type NativeOracleAuthorityRecord,
} from './nativeOracleCreationStore.ts'
import type { NativeOracleHelper, NativeOracleVerifyEnumResponse } from './nativeOracleHelper.ts'
import { assertNativeOracleCreator } from './nativeMarketOracle.ts'

/** The engine adapter must read the persisted exact event, not interpret a POST status. */
export interface NativeOraclePublicationPorts {
  readonly store: NativeOracleCreationStore
  readonly helper: NativeOracleHelper
  readonly readSigner: () => Promise<{ secretKeyHex: string; nonceSeedHex: string }>
  readonly publishRelay: (eventJson: string) => Promise<{ eventId: string }>
  readonly submitEvent: (conditionId: string, eventJson: string) => Promise<unknown>
  readonly readResolution: (conditionId: string) => Promise<unknown>
}

export function nativeOraclePublicationBinding(
  record: NativeOracleCreationRecord | NativeImportedOracleRecord,
): OraclePublicationBinding {
  if (record.announcement === null) throw new Error('Native oracle announcement is missing.')
  const outcomes =
    'kind' in record && record.kind === 'imported'
      ? record.outcomes
      : normalizeMarketCreationInput(
          (
            JSON.parse((record as NativeOracleCreationRecord).canonicalInput) as {
              market: MarketCreationInput
            }
          ).market,
        ).outcomeLabels
  return {
    conditionId: record.announcement.conditionId,
    oracleEventId: record.eventId,
    oraclePubkey: record.creatorPublicKeyHex,
    outcomes,
    announcementEventJson: record.announcement.announcementNostrEventJson,
  }
}

export function createNativeOraclePublicationAdapters(
  ports: NativeOraclePublicationPorts,
): OraclePublicationAdapters {
  const requireNative = async (conditionId: string) => {
    const record = await ports.store.readAuthorityByConditionId(conditionId)
    if (record?.announcement == null) throw new Error('Native oracle announcement is missing.')
    return record
  }
  const requirePublication = (record: NativeOracleAuthorityRecord): OraclePublicationRecord => {
    const publication = nativeOraclePublicationRecord(record)
    if (publication === null) throw new Error('Native oracle outcome is not saved.')
    return publication
  }
  const verify = async (
    binding: OraclePublicationBinding,
    outcome: string,
    artifact: PreparedOracleAttestation,
  ) => {
    const record = await requireNative(binding.conditionId)
    if (JSON.stringify(nativeOraclePublicationBinding(record)) !== JSON.stringify(binding))
      throw new Error('Native oracle binding conflicts with the saved announcement.')
    return ports.helper.verifyEnum({
      eventId: binding.oracleEventId,
      oraclePublicKeyHex: binding.oraclePubkey,
      chosenOutcome: outcome,
      announcementTlvHex: record.announcement!.announcementTlvHex,
      announcementNostrEventJson: binding.announcementEventJson,
      attestationHex: artifact.attestationHex,
      attestationNostrEventJson: artifact.eventJson,
    })
  }
  const evidence = async (
    binding: OraclePublicationBinding,
    outcome: string,
    artifact: PreparedOracleAttestation,
  ): Promise<VerifiedOraclePublicationEvidence> => {
    const verified = await verify(binding, outcome, artifact)
    return publicationEvidence(binding.conditionId, verified)
  }
  return {
    store: {
      async read(conditionId) {
        const record = await ports.store.readAuthorityByConditionId(conditionId)
        return record === null ? null : nativeOraclePublicationRecord(record)
      },
      async saveChoice(binding, outcome) {
        const record = await requireNative(binding.conditionId)
        if (
          JSON.stringify(nativeOraclePublicationBinding(record)) !== JSON.stringify(binding) ||
          !binding.outcomes.includes(outcome)
        )
          throw new Error('Native oracle choice conflicts with the saved announcement.')
        return requirePublication(
          await ports.store.chooseAuthorityOutcome(binding.conditionId, outcome),
        )
      },
      async saveAttestation(conditionId, artifact) {
        const record = await requireNative(conditionId)
        if (record.chosenOutcome === null) throw new Error('Native oracle outcome is not saved.')
        return requirePublication(
          await ports.store.persistAuthorityAttestation(conditionId, record.chosenOutcome, {
            attestationHex: artifact.attestationHex,
            attestationNostrEventJson: artifact.eventJson,
          }),
        )
      },
      async saveExplanation(conditionId, eventJson) {
        return requirePublication(
          await ports.store.persistAuthorityPublicationProgress(conditionId, {
            kind: 'explanation',
            eventJson,
          }),
        )
      },
      async confirmRelay(conditionId, eventId) {
        return requirePublication(
          await ports.store.persistAuthorityPublicationProgress(conditionId, {
            kind: 'relay',
            eventId,
          }),
        )
      },
      async confirmEngine(conditionId, confirmed) {
        return requirePublication(
          await ports.store.persistAuthorityPublicationProgress(conditionId, {
            kind: 'engine',
            evidence: confirmed,
          }),
        )
      },
      async confirmExplanationRelay(conditionId, eventId) {
        return requirePublication(
          await ports.store.persistAuthorityPublicationProgress(conditionId, {
            kind: 'explanation-relay',
            eventId,
          }),
        )
      },
    },
    async prepareAttestation(binding, outcome) {
      const record = await requireNative(binding.conditionId)
      if (record.chosenOutcome !== outcome || record.attestation !== null)
        throw new Error('Native oracle preparation requires a saved unsigned choice.')
      const signer = await ports.readSigner()
      assertNativeOracleCreator(binding.oraclePubkey, signer.secretKeyHex)
      const prepared =
        record.kind === 'imported'
          ? await ports.helper.signExplicitEnum({
              oracleSecretKeyHex: signer.secretKeyHex,
              privateDtoJson: JSON.stringify(
                await ports.store.readImportedAuthorityForSigning(binding.conditionId),
              ),
              chosenOutcome: outcome,
            })
          : await ports.helper.signEnum({
              oracleSecretKeyHex: signer.secretKeyHex,
              nonceSeedHex: signer.nonceSeedHex,
              reservedNonceIndex: record.nonceIndex,
              eventId: record.eventId,
              chosenOutcome: outcome,
              announcementTlvHex: record.announcement!.announcementTlvHex,
              announcementNostrEventJson: record.announcement!.announcementNostrEventJson,
            })
      return {
        attestationHex: prepared.attestationHex,
        eventJson: prepared.attestationNostrEventJson,
      }
    },
    verifyAttestation: evidence,
    async publishRelay(eventJson) {
      const parsed = JSON.parse(eventJson) as { kind?: unknown }
      if (parsed.kind === 1111) {
        // The shared coordinator and store validate the complete companion context before I/O.
        readSignedOracleEvent(eventJson, 1111)
      } else readSignedOracleEvent(eventJson, 89)
      return ports.publishRelay(eventJson)
    },
    async submitEngine(binding, eventJson) {
      const native = await requireNative(binding.conditionId)
      const current = requirePublication(native)
      if (current.attestation?.eventJson !== eventJson)
        throw new Error('Engine delivery must use the exact saved event.')
      await ports.submitEvent(binding.conditionId, eventJson)
      const observed = await ports.readResolution(binding.conditionId)
      const verified = await verify(binding, current.chosenOutcome, current.attestation)
      assertEngineResolution(
        observed,
        binding,
        current,
        verified,
        native.announcement!.announcementTlvHex,
      )
      return publicationEvidence(binding.conditionId, verified)
    },
    async prepareExplanation(context, content) {
      const signer = await ports.readSigner()
      assertNativeOracleCreator(context.oraclePubkey, signer.secretKeyHex)
      const signed = finalizeEvent(
        createOracleExplanationTemplate(context, content, Math.floor(Date.now() / 1000)),
        Uint8Array.from(Buffer.from(signer.secretKeyHex, 'hex')),
      )
      const eventJson = JSON.stringify(signed)
      verifyOracleResolutionExplanation(context, eventJson)
      return eventJson
    },
  }
}

function publicationEvidence(
  conditionId: string,
  verified: NativeOracleVerifyEnumResponse,
): VerifiedOraclePublicationEvidence {
  return {
    conditionId,
    oracleEventId: verified.eventId,
    oraclePubkey: verified.oraclePublicKeyHex,
    outcome: verified.chosenOutcome,
    announcementEventId: verified.announcementNostrEventId,
    attestationEventId: verified.attestationNostrEventId,
  }
}

export async function publishNativeMarketOutcome(
  ports: NativeOraclePublicationPorts,
  conditionId: string,
  outcome: string,
  explanation?: string,
  options?: OraclePublicationOptions,
) {
  const record = await ports.store.readAuthorityByConditionId(conditionId)
  if (record === null) throw new Error('Native oracle announcement is missing.')
  if (record.chosenOutcome !== null && record.chosenOutcome !== outcome)
    throw new Error('Native oracle choice conflicts with the saved outcome.')
  // Validate signed binding and membership before committing the immutable native intent.
  nativeOraclePublicationRecord({ ...record, chosenOutcome: outcome })
  const chosen = await ports.store.chooseAuthorityOutcome(conditionId, outcome, explanation)
  return publishOracleOutcome(
    createNativeOraclePublicationAdapters(ports),
    nativeOraclePublicationBinding(chosen),
    outcome,
    chosen.explanationDraft ?? undefined,
    options,
  )
}

export async function retryNativeMarketPublication(
  ports: NativeOraclePublicationPorts,
  conditionId: string,
  options?: OraclePublicationOptions,
) {
  const record = await ports.store.readAuthorityByConditionId(conditionId)
  if (record === null) throw new Error('Native oracle announcement is missing.')
  if (
    options?.republishAttestation !== true &&
    record.attestation !== null &&
    record.chosenOutcome !== null &&
    record.explanationEventJson === null &&
    record.explanationDraft !== null
  )
    return publishOracleOutcome(
      createNativeOraclePublicationAdapters(ports),
      nativeOraclePublicationBinding(record),
      record.chosenOutcome,
      record.explanationDraft,
      options,
    )
  return retryOraclePublication(
    createNativeOraclePublicationAdapters(ports),
    nativeOraclePublicationBinding(record),
    options,
  )
}

/** Keep the existing native caller status only after exact engine evidence is durable. */
export function nativeOraclePublicationRpcResult(result: OraclePublicationResult) {
  return {
    ...result,
    ...(result.record.engineEvidence === null ? {} : { result: 'Closed' as const }),
  }
}

function assertEngineResolution(
  value: unknown,
  binding: OraclePublicationBinding,
  current: OraclePublicationRecord,
  verified: Awaited<ReturnType<NativeOracleHelper['verifyEnum']>>,
  announcementTlvHex: string,
): void {
  if (
    !object(value) ||
    value.conditionId !== binding.conditionId ||
    value.attestedOutcome !== current.chosenOutcome ||
    !object(value.attestationEvent) ||
    Object.keys(value.attestationEvent).sort().join(',') !==
      'content,createdAt,id,kind,pubkey,sig,tags'
  )
    throw new Error('Matching engine resolution evidence is unavailable.')
  const { createdAt, ...wireFields } = value.attestationEvent
  const event = readSignedOracleEvent(JSON.stringify({ ...wireFields, created_at: createdAt }), 89)
  const saved = readSignedOracleEvent(current.attestation!.eventJson, 89)
  // Property order can change in transport. No signed field can change.
  if (
    event.id !== saved.id ||
    event.pubkey !== saved.pubkey ||
    event.sig !== saved.sig ||
    event.created_at !== saved.created_at ||
    event.kind !== saved.kind ||
    event.content !== saved.content ||
    JSON.stringify(event.tags) !== JSON.stringify(saved.tags)
  )
    throw new Error('Engine attestation differs from the saved event.')
  const authority = value.registeredAuthority
  const witness = value.oracleWitness
  if (
    !object(authority) ||
    authority.eventId !== binding.oracleEventId ||
    authority.threshold !== 1 ||
    JSON.stringify(authority.outcomes) !== JSON.stringify(binding.outcomes) ||
    !Array.isArray(authority.oracles) ||
    authority.oracles.length !== 1 ||
    !object(authority.oracles[0]) ||
    !object(witness) ||
    !Array.isArray(witness.oracle_sigs) ||
    witness.oracle_sigs.length !== 1 ||
    !object(witness.oracle_sigs[0])
  )
    throw new Error('Registered engine oracle authority is foreign.')
  const oracle = authority.oracles[0]
  const signature = witness.oracle_sigs[0]
  const announcementHash = createHash('sha256')
    .update(Buffer.from(announcementTlvHex, 'hex'))
    .digest('hex')
  if (
    oracle.oraclePublicKey !== binding.oraclePubkey ||
    oracle.noncePoint !== verified.noncePointHex ||
    oracle.announcementIdentity !== announcementHash ||
    signature.oracle_pubkey !== binding.oraclePubkey ||
    signature.outcome !== current.chosenOutcome ||
    signature.oracle_sig !== verified.oracleSignatureHex
  )
    throw new Error('Engine DLC evidence differs from the saved artifact.')
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
