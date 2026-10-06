import { finalizeEvent, getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import {
  createOracleBackupEvent,
  decryptOracleBackupEvent,
  encodeOracleBackup,
  readOracleBackupEnvelope,
  ORACLE_BACKUP_TAG_PREFIX,
  OracleBackupError,
  type OracleBackupRecord,
  type OracleBackupValidator,
} from './oracleBackup.ts'
import { normalizeNostrRelayUrls } from './nostrRelays.ts'
import {
  snapshotOraclePublicationRecord,
  type OraclePublicationBinding,
  type OraclePublicationRecord,
} from './oraclePublication.ts'
import { readSignedOracleEvent } from './oracleResolutionExplanation.ts'

export const ORACLE_BACKUP_DELIVERY_BYTES_MAX = 256 * 1_024
export const ORACLE_BACKUP_DELIVERY_RELAYS_MAX = 64
export const ORACLE_BACKUP_DELIVERY_IDS_MAX = 64
export const ORACLE_BACKUP_DELIVERY_CONCURRENCY_MAX = 4

export interface OracleBackupDeliveryBinding {
  readonly conditionId: string
  readonly oraclePubkey: string
  readonly announcementEventId: string
}
export interface OracleBackupTerminalAdmission {
  readonly backupEventId: string
  readonly announcementEventId: string
  readonly attestationEventId: string
  readonly generation: 2
}
interface DeliveryEvent {
  readonly eventJson: string
  readonly eventId: string
  readonly acknowledgedRelayIndexes: readonly number[]
}
export interface OracleBackupDeliveryState {
  readonly schemaVersion: 1
  readonly binding: OracleBackupDeliveryBinding
  readonly relayUrls: readonly string[]
  readonly timestampHighWater: number
  readonly knownEventIds: readonly string[]
  readonly current:
    | (DeliveryEvent & {
        readonly mode: 'initial' | 'terminal'
        readonly generation: 1 | 2
        readonly attestationEventId: string | null
      })
    | null
  readonly deletion: DeliveryEvent | null
  /** Only the trusted owner preparation path can install this fact. */
  readonly terminalAdmission: OracleBackupTerminalAdmission | null
  readonly terminalCommitPending: boolean
}
export interface OracleBackupDeliveryAcknowledgment {
  readonly kind: 'backup' | 'deletion'
  readonly eventId: string
  readonly relayUrl: string
}
export interface OracleBackupDeliveryStore {
  read(conditionId: string): Promise<OracleBackupDeliveryState | null>
  /** Build, compare source and previous stage, save, and verify under the owner boundary. */
  prepare(conditionId: string): Promise<OracleBackupDeliveryState>
  confirm(
    conditionId: string,
    ack: OracleBackupDeliveryAcknowledgment,
  ): Promise<OracleBackupDeliveryState>
  /** Check exact local publication and retire authority in the same owner transaction. */
  commitTerminal(
    conditionId: string,
    admission: OracleBackupTerminalAdmission,
  ): Promise<OracleBackupDeliveryState>
}
export interface OracleBackupDeliveryAdapters {
  readonly store: OracleBackupDeliveryStore
  publishRelay(
    relayUrl: string,
    eventJson: string,
  ): Promise<{ readonly eventId: string; readonly relayUrl: string }>
}
export type OracleBackupDeliveryFailure =
  | 'preparation'
  | 'storage'
  | 'backup-relay'
  | 'deletion-relay'
  | 'terminal-commit'
  | 'no-relays'
export interface OracleBackupDeliveryResult {
  readonly state: OracleBackupDeliveryState | null
  readonly failures: readonly OracleBackupDeliveryFailure[]
}
export class OracleBackupDeliveryError extends Error {
  readonly reason:
    | 'invalid-state'
    | 'invalid-source'
    | 'conflict'
    | 'oversized'
    | 'overflow'
    | 'preparation-key-unavailable'
    | 'invalid-acknowledgment'
    | 'terminal-not-ready'
    | 'terminal-backup-source-not-admitted'
  constructor(reason: OracleBackupDeliveryError['reason']) {
    super(`Private oracle backup delivery: ${reason}.`)
    this.name = 'OracleBackupDeliveryError'
    this.reason = reason
  }
}

/** Provenance from the envelope authenticated by the receiving owner. Never accept RPC metadata. */
export interface OracleBackupSource {
  readonly eventId: string
  readonly createdAt: number
  readonly sourceRelay: string
}

/** The owner checks authority conflicts and saves this state with the authenticated import. */
export function admitOracleBackupSource(input: {
  readonly record: OracleBackupRecord
  readonly source: OracleBackupSource
  readonly previous: OracleBackupDeliveryState | null
}): OracleBackupDeliveryState {
  try {
    const { record, source } = input
    if (
      !hex(source.eventId) ||
      !timestamp(source.createdAt) ||
      source.sourceRelay.length > 2_048 ||
      normalizeNostrRelayUrls([source.sourceRelay])[0] !== source.sourceRelay
    )
      fail('invalid-source')
    const binding = {
      conditionId: record.conditionId,
      oraclePubkey: record.oraclePubkey,
      announcementEventId: readSignedOracleEvent(record.authority.announcementEventJson, 88).id,
    }
    const state =
      input.previous === null
        ? emptyState(binding, record.destinations.relayUrls)
        : snapshotOracleBackupDeliveryState(input.previous)
    if (
      !sameBinding(state.binding, binding) ||
      JSON.stringify(state.relayUrls) !== JSON.stringify(record.destinations.relayUrls)
    )
      fail('conflict')
    if (state.knownEventIds.includes(source.eventId) || state.current?.eventId === source.eventId)
      return state
    if (state.current?.mode === 'terminal' || state.deletion !== null)
      fail('terminal-backup-source-not-admitted')
    // Reserve the last predecessor slot for a locally staged initial version.
    if (state.knownEventIds.length >= 63) fail('overflow')
    return snapshotOracleBackupDeliveryState({
      ...state,
      knownEventIds: [...state.knownEventIds, source.eventId],
      timestampHighWater: Math.max(state.timestampHighWater, source.createdAt),
    })
  } catch (error) {
    if (error instanceof OracleBackupDeliveryError) throw error
    throw new OracleBackupDeliveryError('invalid-source')
  }
}

/** Strict backup transport reader. Keep kind-88/89 publication on its separate reader. */
export function readOracleBackupRelayEvent(eventJson: string): Event {
  try {
    if (
      typeof eventJson !== 'string' ||
      new TextEncoder().encode(eventJson).length > ORACLE_BACKUP_DELIVERY_BYTES_MAX
    )
      fail('invalid-source')
    const value: unknown = JSON.parse(eventJson)
    if (!object(value) || !hex(value.pubkey)) fail('invalid-source')
    if (value.kind === 30078) return readOracleBackupEnvelope(value, value.pubkey)
    if (
      !keys(value, 'content,created_at,id,kind,pubkey,sig,tags') ||
      value.kind !== 5 ||
      !hex(value.id) ||
      typeof value.sig !== 'string' ||
      !/^[0-9a-f]{128}$/.test(value.sig) ||
      !timestamp(value.created_at) ||
      value.content !== '' ||
      !Array.isArray(value.tags) ||
      value.tags.length < 2 ||
      value.tags.length > ORACLE_BACKUP_DELIVERY_IDS_MAX + 1
    )
      fail('invalid-source')
    const ids: string[] = []
    for (const tag of value.tags.slice(0, -1)) {
      if (!Array.isArray(tag) || tag.length !== 2 || tag[0] !== 'e' || !hex(tag[1]))
        fail('invalid-source')
      ids.push(tag[1])
    }
    if (
      new Set(ids).size !== ids.length ||
      JSON.stringify(value.tags) !== JSON.stringify(deletionTags(ids))
    )
      fail('invalid-source')
    const event = JSON.parse(JSON.stringify(value)) as Event
    if (!verifyEvent(event)) fail('invalid-source')
    return event
  } catch {
    throw new OracleBackupDeliveryError('invalid-source')
  }
}

/** Build a portable terminal DTO without exporting or retiring private nonce authority. */
export function buildTerminalOracleBackupRecord(input: {
  readonly binding: OraclePublicationBinding
  readonly announcementTlvHex: string
  readonly destinations: OracleBackupRecord['destinations']
  readonly publication: OraclePublicationRecord
}): OracleBackupRecord {
  try {
    const publication = snapshotOraclePublicationRecord(input.publication)
    if (
      !samePublicationBinding(publication.binding, input.binding) ||
      !publication.relayPublished ||
      publication.attestation === null
    )
      fail('terminal-not-ready')
    return {
      schemaVersion: 1,
      conditionId: input.binding.conditionId,
      oraclePubkey: input.binding.oraclePubkey,
      oracleEventId: input.binding.oracleEventId,
      destinations: structuredClone(input.destinations),
      authority: {
        schemaVersion: 1,
        announcementTlvHex: input.announcementTlvHex,
        announcementEventJson: input.binding.announcementEventJson,
        nonceScalarHex: null,
        signedOutcome: publication.chosenOutcome,
        attestationHex: publication.attestation.attestationHex,
        attestationEventJson: publication.attestation.eventJson,
        publicationRecordJson: JSON.stringify(publication),
      },
    }
  } catch {
    throw new OracleBackupDeliveryError('terminal-not-ready')
  }
}

/** Bind loaded private state to its existing owner before any retry or local mutation. */
export function assertOracleBackupDeliveryOwner(
  state: OracleBackupDeliveryState,
  owner: {
    readonly binding: OraclePublicationBinding
    readonly relayUrls: readonly string[]
    readonly publication: OraclePublicationRecord | null
  },
): void {
  try {
    const checked = snapshotOracleBackupDeliveryState(state)
    if (
      checked.binding.conditionId !== owner.binding.conditionId ||
      checked.binding.oraclePubkey !== owner.binding.oraclePubkey ||
      checked.binding.announcementEventId !==
        readSignedOracleEvent(owner.binding.announcementEventJson, 88).id ||
      JSON.stringify(checked.relayUrls) !== JSON.stringify(owner.relayUrls)
    )
      fail('conflict')
    if (checked.current?.mode === 'terminal') {
      if (owner.publication === null) fail('conflict')
      const publication = snapshotOraclePublicationRecord(owner.publication)
      if (
        !samePublicationBinding(publication.binding, owner.binding) ||
        !publication.relayPublished ||
        publication.attestation === null ||
        readSignedOracleEvent(publication.attestation.eventJson, 89).id !==
          checked.current.attestationEventId
      )
        fail('conflict')
    }
  } catch {
    throw new OracleBackupDeliveryError('conflict')
  }
}

/** Validate private owner state. This does not admit imported metadata as terminal authority. */
export function snapshotOracleBackupDeliveryState(value: unknown): OracleBackupDeliveryState {
  try {
    bounded(value)
    if (
      !object(value) ||
      !keys(
        value,
        'binding,current,deletion,knownEventIds,relayUrls,schemaVersion,terminalAdmission,terminalCommitPending,timestampHighWater',
      ) ||
      value.schemaVersion !== 1
    )
      fail('invalid-state')
    if (
      !object(value.binding) ||
      !keys(value.binding, 'announcementEventId,conditionId,oraclePubkey') ||
      !Object.values(value.binding).every(hex)
    )
      fail('invalid-state')
    if (
      !Array.isArray(value.relayUrls) ||
      value.relayUrls.length > ORACLE_BACKUP_DELIVERY_RELAYS_MAX ||
      value.relayUrls.some(
        (url) => typeof url !== 'string' || new TextEncoder().encode(url).length > 2_048,
      ) ||
      JSON.stringify(normalizeNostrRelayUrls(value.relayUrls)) !== JSON.stringify(value.relayUrls)
    )
      fail('invalid-state')
    if (
      !timestamp(value.timestampHighWater) ||
      !Array.isArray(value.knownEventIds) ||
      value.knownEventIds.length > ORACLE_BACKUP_DELIVERY_IDS_MAX ||
      !value.knownEventIds.every(hex) ||
      new Set(value.knownEventIds).size !== value.knownEventIds.length ||
      typeof value.terminalCommitPending !== 'boolean'
    )
      fail('invalid-state')
    const state = JSON.parse(JSON.stringify(value)) as OracleBackupDeliveryState
    validateCurrent(state)
    validateDeletion(state)
    bounded(state)
    return state
  } catch (error) {
    if (error instanceof OracleBackupDeliveryError && error.reason === 'oversized') throw error
    throw new OracleBackupDeliveryError('invalid-state')
  }
}

function validateCurrent(state: OracleBackupDeliveryState): void {
  const current = state.current
  if (current === null) {
    if (
      state.terminalAdmission !== null ||
      state.terminalCommitPending ||
      state.deletion !== null ||
      state.knownEventIds.length > 63
    )
      fail('invalid-state')
    return
  }
  if (
    !object(current) ||
    !keys(current, 'acknowledgedRelayIndexes,attestationEventId,eventId,eventJson,generation,mode')
  )
    fail('invalid-state')
  const event = readOracleBackupEnvelope(JSON.parse(current.eventJson), state.binding.oraclePubkey)
  if (
    event.id !== current.eventId ||
    event.tags[0][1] !== ORACLE_BACKUP_TAG_PREFIX + state.binding.announcementEventId ||
    event.created_at > state.timestampHighWater ||
    state.knownEventIds.includes(event.id)
  )
    fail('invalid-state')
  validateIndexes(current.acknowledgedRelayIndexes, state.relayUrls.length)
  switch (current.mode) {
    case 'initial':
      if (
        current.generation !== 1 ||
        current.attestationEventId !== null ||
        state.terminalAdmission !== null ||
        state.terminalCommitPending ||
        state.deletion !== null ||
        state.knownEventIds.length > 63
      )
        fail('invalid-state')
      break
    case 'terminal': {
      const admission = state.terminalAdmission
      if (
        current.generation !== 2 ||
        !hex(current.attestationEventId) ||
        !object(admission) ||
        !keys(admission, 'announcementEventId,attestationEventId,backupEventId,generation') ||
        admission.generation !== 2 ||
        admission.backupEventId !== current.eventId ||
        admission.announcementEventId !== state.binding.announcementEventId ||
        admission.attestationEventId !== current.attestationEventId ||
        (!state.terminalCommitPending && current.acknowledgedRelayIndexes.length === 0)
      )
        fail('invalid-state')
      break
    }
    default:
      fail('invalid-state')
  }
}

function validateDeletion(state: OracleBackupDeliveryState): void {
  if (state.deletion === null) return
  const deletion = state.deletion
  if (
    !object(deletion) ||
    !keys(deletion, 'acknowledgedRelayIndexes,eventId,eventJson') ||
    state.current?.mode !== 'terminal' ||
    state.knownEventIds.length === 0
  )
    fail('invalid-state')
  const value: unknown = JSON.parse(deletion.eventJson)
  if (
    !object(value) ||
    !keys(value, 'content,created_at,id,kind,pubkey,sig,tags') ||
    value.kind !== 5 ||
    value.pubkey !== state.binding.oraclePubkey ||
    value.id !== deletion.eventId ||
    !hex(value.id) ||
    typeof value.sig !== 'string' ||
    !/^[0-9a-f]{128}$/.test(value.sig) ||
    !timestamp(value.created_at) ||
    value.content !== '' ||
    JSON.stringify(value.tags) !== JSON.stringify(deletionTags(state.knownEventIds))
  )
    fail('invalid-state')
  if (!verifyEvent(JSON.parse(JSON.stringify(value)) as Event)) fail('invalid-state')
  validateIndexes(deletion.acknowledgedRelayIndexes, state.relayUrls.length)
  if (
    deletion.acknowledgedRelayIndexes.some(
      (index) => !state.current!.acknowledgedRelayIndexes.includes(index),
    )
  )
    fail('invalid-state')
}

/** The owner must compare the source and previous snapshots before saving this candidate. */
export async function prepareOracleBackupDelivery(input: {
  readonly record: OracleBackupRecord
  readonly previous: OracleBackupDeliveryState | null
  readonly privateKey: Uint8Array | null
  readonly validator: OracleBackupValidator
  readonly nowSeconds: number
  readonly observedEvents?: readonly unknown[]
}): Promise<OracleBackupDeliveryState> {
  try {
    const record = JSON.parse(
      await encodeOracleBackup(input.record, input.validator),
    ) as OracleBackupRecord
    const binding = {
      conditionId: record.conditionId,
      oraclePubkey: record.oraclePubkey,
      announcementEventId: readSignedOracleEvent(record.authority.announcementEventJson, 88).id,
    }
    let state =
      input.previous === null
        ? emptyState(binding, record.destinations.relayUrls)
        : snapshotOracleBackupDeliveryState(input.previous)
    if (
      !sameBinding(state.binding, binding) ||
      JSON.stringify(state.relayUrls) !== JSON.stringify(record.destinations.relayUrls)
    )
      fail('conflict')
    const publication =
      record.authority.publicationRecordJson === null
        ? null
        : snapshotOraclePublicationRecord(JSON.parse(record.authority.publicationRecordJson))
    const terminal =
      publication !== null && publication.relayPublished && publication.attestation !== null
    if (state.current?.mode === 'terminal') {
      if (
        !terminal ||
        readSignedOracleEvent(publication!.attestation!.eventJson, 89).id !==
          state.current.attestationEventId
      )
        fail('conflict')
      return completeDeletionPreparation(state, input.privateKey, input.nowSeconds)
    }
    if (state.current !== null && !terminal) return state
    state = await retainObserved(state, record, input, terminal)
    if (input.privateKey === null) fail('preparation-key-unavailable')
    const createdAt = replacementTimestamp(input.nowSeconds, state.timestampHighWater)
    const portable = terminal
      ? { ...record, authority: { ...record.authority, nonceScalarHex: null } }
      : record
    const event = await createOracleBackupEvent({
      record: portable,
      privateKey: input.privateKey,
      createdAt,
      validator: input.validator,
    })
    const ids = [...state.knownEventIds, ...(state.current === null ? [] : [state.current.eventId])]
    if (ids.length > (terminal ? 64 : 63)) fail('overflow')
    const attestationEventId = terminal
      ? readSignedOracleEvent(publication!.attestation!.eventJson, 89).id
      : null
    state = snapshotOracleBackupDeliveryState({
      ...state,
      timestampHighWater: createdAt,
      knownEventIds: ids,
      current: {
        mode: terminal ? 'terminal' : 'initial',
        generation: terminal ? 2 : 1,
        eventJson: JSON.stringify(event),
        eventId: event.id,
        acknowledgedRelayIndexes: [],
        attestationEventId,
      },
      terminalAdmission: terminal
        ? {
            backupEventId: event.id,
            announcementEventId: binding.announcementEventId,
            attestationEventId,
            generation: 2,
          }
        : null,
      terminalCommitPending: terminal,
    })
    return completeDeletionPreparation(state, input.privateKey, input.nowSeconds)
  } catch (error) {
    if (error instanceof OracleBackupDeliveryError) throw error
    if (error instanceof OracleBackupError && error.reason === 'oversized')
      throw new OracleBackupDeliveryError('oversized')
    throw new OracleBackupDeliveryError('invalid-source')
  }
}

async function retainObserved(
  state: OracleBackupDeliveryState,
  record: OracleBackupRecord,
  input: {
    readonly observedEvents?: readonly unknown[]
    readonly privateKey: Uint8Array | null
    readonly validator: OracleBackupValidator
  },
  terminal: boolean,
): Promise<OracleBackupDeliveryState> {
  const observed = input.observedEvents ?? []
  if (!Array.isArray(observed) || observed.length > 64) fail('overflow')
  if (observed.length > 0 && input.privateKey === null) fail('preparation-key-unavailable')
  const ids = [...state.knownEventIds]
  let highWater = state.timestampHighWater
  for (const value of observed) {
    const restored = await decryptOracleBackupEvent({
      event: value,
      privateKey: input.privateKey!,
      validator: input.validator,
      expectedAnnouncementEventId: state.binding.announcementEventId,
    })
    if (
      restored.conditionId !== record.conditionId ||
      restored.oraclePubkey !== record.oraclePubkey ||
      restored.authority.announcementEventJson !== record.authority.announcementEventJson ||
      JSON.stringify(restored.destinations) !== JSON.stringify(record.destinations)
    )
      fail('conflict')
    const event = readOracleBackupEnvelope(value, state.binding.oraclePubkey)
    highWater = Math.max(highWater, event.created_at)
    if (!ids.includes(event.id) && event.id !== state.current?.eventId) ids.push(event.id)
  }
  if (ids.length > (terminal && state.current === null ? 64 : 63)) fail('overflow')
  return { ...state, knownEventIds: ids, timestampHighWater: highWater }
}

function completeDeletionPreparation(
  state: OracleBackupDeliveryState,
  privateKey: Uint8Array | null,
  now: number,
): OracleBackupDeliveryState {
  if (
    state.current?.mode !== 'terminal' ||
    state.knownEventIds.length === 0 ||
    state.deletion !== null
  )
    return state
  if (privateKey === null) fail('preparation-key-unavailable')
  if (getPublicKey(privateKey) !== state.binding.oraclePubkey || !timestamp(now))
    fail('invalid-source')
  const event = finalizeEvent(
    { kind: 5, created_at: now, tags: deletionTags(state.knownEventIds), content: '' },
    privateKey,
  )
  return snapshotOracleBackupDeliveryState({
    ...state,
    deletion: { eventJson: JSON.stringify(event), eventId: event.id, acknowledgedRelayIndexes: [] },
  })
}

/** A stale acknowledgment never replaces the current owner stage. */
export function confirmOracleBackupDelivery(
  input: OracleBackupDeliveryState,
  ack: OracleBackupDeliveryAcknowledgment,
): OracleBackupDeliveryState {
  const state = snapshotOracleBackupDeliveryState(input)
  const index = state.relayUrls.indexOf(ack.relayUrl)
  if (index < 0) fail('invalid-acknowledgment')
  switch (ack.kind) {
    case 'backup':
      if (state.current === null || state.current.eventId !== ack.eventId)
        fail('invalid-acknowledgment')
      return snapshotOracleBackupDeliveryState({
        ...state,
        current: {
          ...state.current,
          acknowledgedRelayIndexes: addIndex(state.current.acknowledgedRelayIndexes, index),
        },
      })
    case 'deletion': {
      if (
        state.current?.mode !== 'terminal' ||
        state.deletion === null ||
        state.deletion.eventId !== ack.eventId ||
        !state.current.acknowledgedRelayIndexes.includes(index)
      )
        fail('invalid-acknowledgment')
      const acknowledgedRelayIndexes = addIndex(state.deletion.acknowledgedRelayIndexes, index)
      const complete = acknowledgedRelayIndexes.length === state.relayUrls.length
      return snapshotOracleBackupDeliveryState({
        ...state,
        deletion: complete ? null : { ...state.deletion, acknowledgedRelayIndexes },
        knownEventIds: complete ? [] : state.knownEventIds,
      })
    }
    default:
      fail('invalid-acknowledgment')
  }
}

/** Run this check with exact publication and the local authority update in one owner transaction. */
export function commitOracleBackupDelivery(
  input: OracleBackupDeliveryState,
  admission: OracleBackupTerminalAdmission,
  publication: OraclePublicationRecord,
): OracleBackupDeliveryState {
  try {
    const state = snapshotOracleBackupDeliveryState(input)
    const exact = snapshotOraclePublicationRecord(publication)
    if (
      state.current?.mode !== 'terminal' ||
      state.current.acknowledgedRelayIndexes.length === 0 ||
      !object(admission) ||
      !keys(admission, 'announcementEventId,attestationEventId,backupEventId,generation') ||
      admission.generation !== 2 ||
      admission.backupEventId !== state.current.eventId ||
      admission.announcementEventId !== state.binding.announcementEventId ||
      admission.attestationEventId !== state.current.attestationEventId ||
      !exact.relayPublished ||
      exact.attestation === null ||
      exact.binding.conditionId !== state.binding.conditionId ||
      exact.binding.oraclePubkey !== state.binding.oraclePubkey ||
      readSignedOracleEvent(exact.binding.announcementEventJson, 88).id !==
        admission.announcementEventId ||
      readSignedOracleEvent(exact.attestation.eventJson, 89).id !== admission.attestationEventId
    )
      fail('terminal-not-ready')
    return snapshotOracleBackupDeliveryState({ ...state, terminalCommitPending: false })
  } catch {
    throw new OracleBackupDeliveryError('terminal-not-ready')
  }
}

/** Preparation -> durable readback -> exact replacement -> per-relay deletion -> local commit. */
export async function deliverOracleBackup(
  adapters: OracleBackupDeliveryAdapters,
  conditionId: string,
): Promise<OracleBackupDeliveryResult> {
  try {
    const prepared = snapshotOracleBackupDeliveryState(await adapters.store.prepare(conditionId))
    const saved = await adapters.store.read(conditionId)
    if (saved === null) fail('conflict')
    assertSameStage(prepared, snapshotOracleBackupDeliveryState(saved))
  } catch {
    return { state: await safeRead(adapters.store, conditionId), failures: ['preparation'] }
  }
  return retryOracleBackupDelivery(adapters, conditionId)
}

/** No preparation, core helper, encryption, or signing is required for saved retries. */
export async function retryOracleBackupDelivery(
  adapters: OracleBackupDeliveryAdapters,
  conditionId: string,
): Promise<OracleBackupDeliveryResult> {
  let state = await safeRead(adapters.store, conditionId)
  if (state === null || state.current === null) return { state, failures: ['storage'] }
  const failures: OracleBackupDeliveryFailure[] = []
  if (state.relayUrls.length === 0) return { state, failures: ['no-relays'] }
  const original = state
  let nextRelay = 0
  await Promise.all(
    Array.from(
      { length: Math.min(ORACLE_BACKUP_DELIVERY_CONCURRENCY_MAX, original.relayUrls.length) },
      async () => {
        while (nextRelay < original.relayUrls.length) {
          const relayUrl = original.relayUrls[nextRelay++]
          await attemptRelayDelivery(adapters, conditionId, original, relayUrl, failures)
        }
      },
    ),
  )
  state = await safeRead(adapters.store, conditionId)
  if (state === null) return { state, failures: [...new Set([...failures, 'storage' as const])] }
  if (
    state.terminalCommitPending &&
    state.terminalAdmission !== null &&
    state.current!.acknowledgedRelayIndexes.length > 0
  ) {
    try {
      const saved = snapshotOracleBackupDeliveryState(
        await adapters.store.commitTerminal(conditionId, state.terminalAdmission),
      )
      assertSameStage(state, saved)
      if (saved.terminalCommitPending) fail('terminal-not-ready')
      state = saved
    } catch {
      failures.push('terminal-commit')
    }
  }
  return { state, failures: [...new Set(failures)] }
}

async function attemptRelayDelivery(
  adapters: OracleBackupDeliveryAdapters,
  conditionId: string,
  original: OracleBackupDeliveryState,
  relayUrl: string,
  failures: OracleBackupDeliveryFailure[],
): Promise<void> {
  let state = original
  try {
    state = await checkedRead(adapters.store, conditionId, state)
    const index = state.relayUrls.indexOf(relayUrl)
    if (!state.current!.acknowledgedRelayIndexes.includes(index))
      state = await sendAndConfirm(adapters, conditionId, state, relayUrl, 'backup')
  } catch {
    failures.push('backup-relay')
  }
  try {
    state = await checkedRead(adapters.store, conditionId, state)
    const index = state.relayUrls.indexOf(relayUrl)
    if (
      state.current?.mode === 'terminal' &&
      state.deletion !== null &&
      state.current.acknowledgedRelayIndexes.includes(index) &&
      !state.deletion.acknowledgedRelayIndexes.includes(index)
    )
      await sendAndConfirm(adapters, conditionId, state, relayUrl, 'deletion')
  } catch {
    failures.push('deletion-relay')
  }
}

async function sendAndConfirm(
  adapters: OracleBackupDeliveryAdapters,
  conditionId: string,
  state: OracleBackupDeliveryState,
  relayUrl: string,
  kind: OracleBackupDeliveryAcknowledgment['kind'],
): Promise<OracleBackupDeliveryState> {
  const event = kind === 'backup' ? state.current! : state.deletion!
  const ack = await adapters.publishRelay(relayUrl, event.eventJson)
  if (ack.eventId !== event.eventId || ack.relayUrl !== relayUrl) fail('invalid-acknowledgment')
  const saved = snapshotOracleBackupDeliveryState(
    await adapters.store.confirm(conditionId, { kind, ...ack }),
  )
  assertSameStage(state, saved)
  const index = state.relayUrls.indexOf(relayUrl)
  const retained = kind === 'backup' ? saved.current : saved.deletion
  if (
    retained === null
      ? !(kind === 'deletion' && saved.knownEventIds.length === 0)
      : !retained.acknowledgedRelayIndexes.includes(index)
  )
    fail('invalid-acknowledgment')
  return saved
}
async function checkedRead(
  store: OracleBackupDeliveryStore,
  conditionId: string,
  expected: OracleBackupDeliveryState,
): Promise<OracleBackupDeliveryState> {
  const state = await safeRead(store, conditionId)
  if (state === null) fail('invalid-state')
  assertSameStage(expected, state)
  return state
}
async function safeRead(
  store: OracleBackupDeliveryStore,
  conditionId: string,
): Promise<OracleBackupDeliveryState | null> {
  try {
    const value = await store.read(conditionId)
    if (value === null) return null
    const state = snapshotOracleBackupDeliveryState(value)
    if (state.binding.conditionId !== conditionId) return null
    return state
  } catch {
    return null
  }
}
function assertSameStage(
  previous: OracleBackupDeliveryState,
  next: OracleBackupDeliveryState,
): void {
  if (
    !sameBinding(previous.binding, next.binding) ||
    JSON.stringify(previous.relayUrls) !== JSON.stringify(next.relayUrls) ||
    previous.current === null ||
    next.current === null ||
    previous.current.eventJson !== next.current.eventJson ||
    previous.current.mode !== next.current.mode ||
    previous.current.generation !== next.current.generation ||
    previous.current.attestationEventId !== next.current.attestationEventId ||
    next.timestampHighWater < previous.timestampHighWater ||
    (previous.deletion !== null &&
      next.deletion !== null &&
      previous.deletion.eventJson !== next.deletion.eventJson) ||
    previous.current.acknowledgedRelayIndexes.some(
      (index) => !next.current!.acknowledgedRelayIndexes.includes(index),
    ) ||
    (previous.deletion !== null &&
      next.deletion !== null &&
      previous.deletion.acknowledgedRelayIndexes.some(
        (index) => !next.deletion!.acknowledgedRelayIndexes.includes(index),
      )) ||
    (!previous.terminalCommitPending && next.terminalCommitPending)
  )
    fail('conflict')
}
function sameBinding(
  left: OracleBackupDeliveryBinding,
  right: OracleBackupDeliveryBinding,
): boolean {
  return (
    left.conditionId === right.conditionId &&
    left.oraclePubkey === right.oraclePubkey &&
    left.announcementEventId === right.announcementEventId
  )
}
function samePublicationBinding(
  left: OraclePublicationBinding,
  right: OraclePublicationBinding,
): boolean {
  return (
    left.conditionId === right.conditionId &&
    left.oraclePubkey === right.oraclePubkey &&
    left.oracleEventId === right.oracleEventId &&
    left.announcementEventJson === right.announcementEventJson &&
    JSON.stringify(left.outcomes) === JSON.stringify(right.outcomes)
  )
}
function emptyState(
  binding: OracleBackupDeliveryBinding,
  relayUrls: readonly string[],
): OracleBackupDeliveryState {
  return snapshotOracleBackupDeliveryState({
    schemaVersion: 1,
    binding,
    relayUrls,
    timestampHighWater: 0,
    knownEventIds: [],
    current: null,
    deletion: null,
    terminalAdmission: null,
    terminalCommitPending: false,
  })
}
function replacementTimestamp(now: number, highWater: number): number {
  if (!timestamp(now)) fail('invalid-source')
  if (highWater === Number.MAX_SAFE_INTEGER) fail('overflow')
  return Math.max(now, highWater + 1)
}
function deletionTags(ids: readonly string[]): string[][] {
  return [...ids.map((id) => ['e', id]), ['k', '30078']]
}
function addIndex(indexes: readonly number[], index: number): number[] {
  return [...new Set([...indexes, index])].sort((a, b) => a - b)
}
function validateIndexes(value: unknown, relayCount: number): void {
  if (
    !Array.isArray(value) ||
    value.some(
      (index, position) =>
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= relayCount ||
        (position > 0 && value[position - 1] >= index),
    )
  )
    fail('invalid-state')
}
function bounded(value: unknown): void {
  const encoded = JSON.stringify(value)
  if (typeof encoded !== 'string') fail('invalid-state')
  if (new TextEncoder().encode(encoded).length > ORACLE_BACKUP_DELIVERY_BYTES_MAX) fail('oversized')
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, expected: string): boolean {
  return Object.keys(value).sort().join(',') === expected
}
function hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function fail(reason: OracleBackupDeliveryError['reason']): never {
  throw new OracleBackupDeliveryError(reason)
}
