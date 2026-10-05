import { deriveDlcConditionId } from './managedConditionInventory.ts'
import {
  assertOracleExplanationText,
  readSignedOracleEvent,
  verifyOracleResolutionExplanation,
  type OracleExplanationContext,
} from './oracleResolutionExplanation.ts'

export interface OraclePublicationBinding {
  readonly conditionId: string
  readonly oracleEventId: string
  readonly oraclePubkey: string
  readonly outcomes: readonly string[]
  readonly announcementEventJson: string
}

export interface PreparedOracleAttestation {
  readonly attestationHex: string
  readonly eventJson: string
}

/** Returned only after the adapter verifies DLC evidence against registered authority. */
export interface VerifiedOraclePublicationEvidence {
  readonly conditionId: string
  readonly oracleEventId: string
  readonly oraclePubkey: string
  readonly outcome: string
  readonly announcementEventId: string
  readonly attestationEventId: string
}

/** This is a port view of an existing creator record, not a new journal. */
export interface OraclePublicationRecord {
  readonly binding: OraclePublicationBinding
  readonly chosenOutcome: string
  readonly attestation: PreparedOracleAttestation | null
  readonly relayPublished: boolean
  readonly engineEvidence: VerifiedOraclePublicationEvidence | null
  readonly explanationEventJson: string | null
  readonly explanationRelayPublished: boolean
}

export interface OraclePublicationStore {
  read(conditionId: string): Promise<OraclePublicationRecord | null>
  /** Atomically retain the binding and choice. Reject conflicts and preserve all saved progress. */
  saveChoice(binding: OraclePublicationBinding, outcome: string): Promise<OraclePublicationRecord>
  saveAttestation(
    conditionId: string,
    artifact: PreparedOracleAttestation,
  ): Promise<OraclePublicationRecord>
  saveExplanation(conditionId: string, eventJson: string): Promise<OraclePublicationRecord>
  confirmRelay(conditionId: string, eventId: string): Promise<OraclePublicationRecord>
  confirmEngine(
    conditionId: string,
    evidence: VerifiedOraclePublicationEvidence,
  ): Promise<OraclePublicationRecord>
  confirmExplanationRelay(conditionId: string, eventId: string): Promise<OraclePublicationRecord>
}

export interface OraclePublicationAdapters {
  readonly store: OraclePublicationStore
  /** Use the existing Kormir/native helper. This port must not publish. */
  prepareAttestation(
    binding: OraclePublicationBinding,
    outcome: string,
  ): Promise<PreparedOracleAttestation>
  /** Verify the DLC artifact, committed nonce, outcome and registered announcement, including reload. */
  verifyAttestation(
    binding: OraclePublicationBinding,
    outcome: string,
    artifact: PreparedOracleAttestation,
  ): Promise<VerifiedOraclePublicationEvidence>
  /** Use bounded transport attempts. Return the acknowledged event ID, not a send acknowledgment. */
  publishRelay(eventJson: string): Promise<{ readonly eventId: string }>
  /** A generic HTTP success is insufficient. Return matching verified resolution evidence. */
  submitEngine(
    binding: OraclePublicationBinding,
    eventJson: string,
  ): Promise<VerifiedOraclePublicationEvidence>
  /** Sign only the NIP-22 companion. This port must not publish. */
  prepareExplanation(context: OracleExplanationContext, content: string): Promise<string>
}

export type OraclePublicationFailureStage =
  | 'explanation-preparation'
  | 'relay'
  | 'engine'
  | 'explanation-relay'

export interface OraclePublicationResult {
  readonly record: OraclePublicationRecord
  /** Deliberately excludes adapter errors, payloads, and secrets. */
  readonly failures: readonly OraclePublicationFailureStage[]
}

export interface OraclePublicationOptions {
  readonly engineDelivery: 'synchronize' | 'relay-only'
}

/** Validate a loaded port view without adding another storage owner. DLC verification remains a port. */
export function snapshotOraclePublicationRecord(
  record: OraclePublicationRecord,
): OraclePublicationRecord {
  const binding = snapshotBinding(record.binding)
  assertRecord(record, binding, record.chosenOutcome)
  return {
    binding,
    chosenOutcome: record.chosenOutcome,
    attestation: structuredClone(record.attestation),
    relayPublished: record.relayPublished,
    engineEvidence: structuredClone(record.engineEvidence),
    explanationEventJson: record.explanationEventJson,
    explanationRelayPublished: record.explanationRelayPublished,
  }
}

/** Merge identical public authority without losing an exact artifact or delivery confirmation. */
export function mergeOraclePublicationRecords(
  previous: OraclePublicationRecord | null,
  incoming: OraclePublicationRecord | null,
): OraclePublicationRecord | null {
  const old = previous === null ? null : snapshotOraclePublicationRecord(previous)
  const next = incoming === null ? null : snapshotOraclePublicationRecord(incoming)
  if (old === null) return next
  if (next === null) return old
  if (
    JSON.stringify(old.binding) !== JSON.stringify(next.binding) ||
    old.chosenOutcome !== next.chosenOutcome
  )
    throw new Error('Oracle publication authority conflicts with saved state.')
  function retained<T>(
    left: T | null,
    right: T | null,
    equal: (left: T, right: T) => boolean,
  ): T | null {
    if (left !== null && right !== null && !equal(left, right))
      throw new Error('Exact oracle publication artifact conflicts with saved state.')
    return left ?? right
  }
  return snapshotOraclePublicationRecord({
    binding: old.binding,
    chosenOutcome: old.chosenOutcome,
    attestation: retained(old.attestation, next.attestation, sameAttestation),
    relayPublished: old.relayPublished || next.relayPublished,
    engineEvidence: retained(
      old.engineEvidence,
      next.engineEvidence,
      (left, right) =>
        left.conditionId === right.conditionId &&
        left.oracleEventId === right.oracleEventId &&
        left.oraclePubkey === right.oraclePubkey &&
        left.outcome === right.outcome &&
        left.announcementEventId === right.announcementEventId &&
        left.attestationEventId === right.attestationEventId,
    ),
    explanationEventJson: retained(
      old.explanationEventJson,
      next.explanationEventJson,
      (left, right) => left === right,
    ),
    explanationRelayPublished: old.explanationRelayPublished || next.explanationRelayPublished,
  })
}

/** Choice -> local preparation -> exact durable save -> independent delivery. */
export async function publishOracleOutcome(
  adapters: OraclePublicationAdapters,
  input: OraclePublicationBinding,
  outcome: string,
  explanationText?: string,
  options: OraclePublicationOptions = { engineDelivery: 'synchronize' },
): Promise<OraclePublicationResult> {
  const synchronizeEngine = engineDeliveryEnabled(options)
  const binding = snapshotBinding(input)
  if (!binding.outcomes.includes(outcome)) throw new Error('Oracle outcome is foreign.')
  let retained = await adapters.store.read(binding.conditionId)
  if (retained !== null) assertRecord(retained, binding, outcome)
  else retained = await adapters.store.saveChoice(structuredClone(binding), outcome)
  assertRecord(retained, binding, outcome)
  let current = structuredClone(retained)
  if (current.attestation === null) {
    const prepared = structuredClone(
      await adapters.prepareAttestation(structuredClone(binding), outcome),
    )
    await verifyPrepared(adapters, binding, outcome, prepared)
    const saved = await adapters.store.saveAttestation(
      binding.conditionId,
      structuredClone(prepared),
    )
    assertTransition(current, saved)
    if (saved.attestation === null || !sameAttestation(saved.attestation, prepared))
      throw new Error('Exact oracle attestation was not saved.')
    current = structuredClone(saved)
  }
  await verifyPrepared(adapters, binding, outcome, current.attestation!)
  const failures: OraclePublicationFailureStage[] = []
  if (explanationText !== undefined) {
    try {
      current = await retainExplanation(adapters, current, explanationText)
    } catch {
      failures.push('explanation-preparation')
    }
  }
  current = await attemptRelay(adapters, current, failures)
  if (synchronizeEngine) current = await attemptEngine(adapters, current, failures)
  current = await attemptExplanationRelay(adapters, current, failures)
  return { record: current, failures }
}

function engineDeliveryEnabled(options: OraclePublicationOptions): boolean {
  switch (options.engineDelivery) {
    case 'synchronize':
      return true
    case 'relay-only':
      return false
    default:
      throw new Error('Oracle publication delivery mode is invalid.')
  }
}

/** Reload the saved choice. Retry without a signer or a new outcome selection. */
export async function retryOraclePublication(
  adapters: OraclePublicationAdapters,
  binding: OraclePublicationBinding,
  options: OraclePublicationOptions = { engineDelivery: 'synchronize' },
): Promise<OraclePublicationResult> {
  const stored = await adapters.store.read(binding.conditionId)
  if (stored === null || stored.attestation === null)
    throw new Error('Signed oracle publication is unavailable.')
  return publishOracleOutcome(adapters, binding, stored.chosenOutcome, undefined, options)
}

async function retainExplanation(
  adapters: OraclePublicationAdapters,
  current: OraclePublicationRecord,
  content: string,
): Promise<OraclePublicationRecord> {
  assertOracleExplanationText(content)
  const context = explanationContext(current)
  if (current.explanationEventJson !== null) {
    if (
      verifyOracleResolutionExplanation(context, current.explanationEventJson).content !== content
    )
      throw new Error('Signed explanation cannot change.')
    return current
  }
  const eventJson = await adapters.prepareExplanation(context, content)
  if (verifyOracleResolutionExplanation(context, eventJson).content !== content)
    throw new Error('Explanation content changed during preparation.')
  const saved = await adapters.store.saveExplanation(current.binding.conditionId, eventJson)
  assertTransition(current, saved)
  if (saved.explanationEventJson !== eventJson) throw new Error('Exact explanation was not saved.')
  return structuredClone(saved)
}

async function attemptRelay(
  adapters: OraclePublicationAdapters,
  current: OraclePublicationRecord,
  failures: OraclePublicationFailureStage[],
): Promise<OraclePublicationRecord> {
  if (current.relayPublished) return current
  try {
    const id = readSignedOracleEvent(current.attestation!.eventJson, 89).id
    if ((await adapters.publishRelay(current.attestation!.eventJson)).eventId !== id)
      throw new Error('Relay acknowledgment is foreign.')
    const saved = await adapters.store.confirmRelay(current.binding.conditionId, id)
    assertTransition(current, saved)
    if (!saved.relayPublished) throw new Error('Relay confirmation was not saved.')
    return structuredClone(saved)
  } catch {
    failures.push('relay')
    return current
  }
}

async function attemptEngine(
  adapters: OraclePublicationAdapters,
  current: OraclePublicationRecord,
  failures: OraclePublicationFailureStage[],
): Promise<OraclePublicationRecord> {
  if (current.engineEvidence !== null) return current
  try {
    const evidence = structuredClone(
      await adapters.submitEngine(structuredClone(current.binding), current.attestation!.eventJson),
    )
    assertEvidence(current.binding, current.chosenOutcome, current.attestation!, evidence)
    const saved = await adapters.store.confirmEngine(
      current.binding.conditionId,
      structuredClone(evidence),
    )
    assertTransition(current, saved)
    if (saved.engineEvidence === null) throw new Error('Engine confirmation was not saved.')
    return structuredClone(saved)
  } catch {
    failures.push('engine')
    return current
  }
}

async function attemptExplanationRelay(
  adapters: OraclePublicationAdapters,
  current: OraclePublicationRecord,
  failures: OraclePublicationFailureStage[],
): Promise<OraclePublicationRecord> {
  if (current.explanationEventJson === null || current.explanationRelayPublished) return current
  try {
    const event = verifyOracleResolutionExplanation(
      explanationContext(current),
      current.explanationEventJson,
    )
    if ((await adapters.publishRelay(current.explanationEventJson)).eventId !== event.id)
      throw new Error('Explanation acknowledgment is foreign.')
    const saved = await adapters.store.confirmExplanationRelay(
      current.binding.conditionId,
      event.id,
    )
    assertTransition(current, saved)
    if (!saved.explanationRelayPublished) throw new Error('Explanation confirmation was not saved.')
    return structuredClone(saved)
  } catch {
    failures.push('explanation-relay')
    return current
  }
}

async function verifyPrepared(
  adapters: OraclePublicationAdapters,
  binding: OraclePublicationBinding,
  outcome: string,
  prepared: PreparedOracleAttestation,
): Promise<void> {
  assertArtifact(binding, prepared)
  assertEvidence(
    binding,
    outcome,
    prepared,
    await adapters.verifyAttestation(structuredClone(binding), outcome, structuredClone(prepared)),
  )
}

function snapshotBinding(input: OraclePublicationBinding): OraclePublicationBinding {
  if (
    !input ||
    typeof input.oracleEventId !== 'string' ||
    input.oracleEventId.length === 0 ||
    new TextEncoder().encode(input.oracleEventId).length > 512 ||
    !Array.isArray(input.outcomes) ||
    input.outcomes.length < 2 ||
    input.outcomes.length > 8 ||
    input.outcomes.some(
      (outcome) =>
        typeof outcome !== 'string' ||
        outcome.length === 0 ||
        new TextEncoder().encode(outcome).length > 191,
    ) ||
    new Set(input.outcomes).size !== input.outcomes.length
  )
    throw new Error('Oracle publication binding is invalid.')
  const announcement = readSignedOracleEvent(input.announcementEventJson, 88)
  if (
    announcement.pubkey !== input.oraclePubkey ||
    input.conditionId !==
      deriveDlcConditionId({
        eventId: input.oracleEventId,
        outcomeCount: input.outcomes.length,
        oraclePublicKeys: [input.oraclePubkey],
      })
  )
    throw new Error('Registered oracle binding is invalid.')
  return {
    conditionId: input.conditionId,
    oracleEventId: input.oracleEventId,
    oraclePubkey: input.oraclePubkey,
    outcomes: [...input.outcomes],
    announcementEventJson: input.announcementEventJson,
  }
}

function assertArtifact(
  binding: OraclePublicationBinding,
  artifact: PreparedOracleAttestation,
): void {
  if (
    !artifact ||
    typeof artifact.attestationHex !== 'string' ||
    artifact.attestationHex.length === 0 ||
    artifact.attestationHex.length > 48 * 1_024 ||
    !/^(?:[0-9a-f]{2})+$/.test(artifact.attestationHex)
  )
    throw new Error('Oracle attestation artifact is invalid.')
  const event = readSignedOracleEvent(artifact.eventJson, 89)
  const announcement = readSignedOracleEvent(binding.announcementEventJson, 88)
  const parents = event.tags.filter(([name]) => name === 'e')
  if (
    event.pubkey !== binding.oraclePubkey ||
    parents.length !== 1 ||
    parents[0].length !== 2 ||
    parents[0][1] !== announcement.id
  )
    throw new Error('Oracle attestation binding is invalid.')
  const bytes = Uint8Array.from(artifact.attestationHex.match(/../g)!, (value) =>
    parseInt(value, 16),
  )
  if (event.content !== btoa(String.fromCharCode(...bytes)))
    throw new Error('Oracle attestation body does not match its artifact.')
}

function assertEvidence(
  binding: OraclePublicationBinding,
  outcome: string,
  artifact: PreparedOracleAttestation,
  evidence: VerifiedOraclePublicationEvidence,
): void {
  if (
    !evidence ||
    evidence.conditionId !== binding.conditionId ||
    evidence.oracleEventId !== binding.oracleEventId ||
    evidence.oraclePubkey !== binding.oraclePubkey ||
    evidence.outcome !== outcome ||
    evidence.announcementEventId !== readSignedOracleEvent(binding.announcementEventJson, 88).id ||
    evidence.attestationEventId !== readSignedOracleEvent(artifact.eventJson, 89).id
  )
    throw new Error('Verified oracle evidence is foreign.')
}

function assertRecord(
  record: OraclePublicationRecord,
  binding: OraclePublicationBinding,
  outcome: string,
): void {
  if (
    JSON.stringify(snapshotBinding(record.binding)) !== JSON.stringify(binding) ||
    record.chosenOutcome !== outcome ||
    !binding.outcomes.includes(outcome) ||
    typeof record.relayPublished !== 'boolean' ||
    typeof record.explanationRelayPublished !== 'boolean'
  )
    throw new Error('Stored oracle publication conflicts with its binding.')
  if (record.attestation === null) {
    if (
      record.relayPublished ||
      record.engineEvidence !== null ||
      record.explanationEventJson !== null ||
      record.explanationRelayPublished
    )
      throw new Error('Unsigned oracle publication has delivery progress.')
    return
  }
  assertArtifact(binding, record.attestation)
  if (record.engineEvidence !== null)
    assertEvidence(binding, outcome, record.attestation, record.engineEvidence)
  if (record.explanationEventJson !== null)
    verifyOracleResolutionExplanation(explanationContext(record), record.explanationEventJson)
  else if (record.explanationRelayPublished)
    throw new Error('Explanation publication has no signed event.')
}

function assertTransition(previous: OraclePublicationRecord, next: OraclePublicationRecord): void {
  assertRecord(next, previous.binding, previous.chosenOutcome)
  if (
    (previous.attestation !== null &&
      (next.attestation === null || !sameAttestation(previous.attestation, next.attestation))) ||
    (previous.explanationEventJson !== null &&
      next.explanationEventJson !== previous.explanationEventJson) ||
    (previous.relayPublished && !next.relayPublished) ||
    (previous.engineEvidence !== null &&
      JSON.stringify(next.engineEvidence) !== JSON.stringify(previous.engineEvidence)) ||
    (previous.explanationRelayPublished && !next.explanationRelayPublished)
  )
    throw new Error('Saved oracle publication regressed or changed.')
}

function sameAttestation(
  left: PreparedOracleAttestation,
  right: PreparedOracleAttestation,
): boolean {
  return left.attestationHex === right.attestationHex && left.eventJson === right.eventJson
}

function explanationContext(record: OraclePublicationRecord): OracleExplanationContext {
  return {
    oraclePubkey: record.binding.oraclePubkey,
    announcementEventJson: record.binding.announcementEventJson,
    attestationEventJson: record.attestation!.eventJson,
  }
}
