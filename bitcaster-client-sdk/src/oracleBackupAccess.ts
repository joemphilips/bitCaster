import { getPublicKey, verifyEvent, type Event } from 'nostr-tools/pure'
import {
  decryptOracleBackupEvent,
  readOracleBackupEnvelope,
  ORACLE_BACKUP_KIND,
  ORACLE_BACKUP_TAG_PREFIX,
  type OracleBackupRecord,
  type OracleBackupValidator,
} from './oracleBackup.ts'
import {
  assertOracleBackupDeliveryOwner,
  snapshotOracleBackupDeliveryState,
  ORACLE_BACKUP_DELIVERY_RELAYS_MAX,
  type OracleBackupDeliveryState,
  type OracleBackupSource,
} from './oracleBackupDelivery.ts'
import { normalizeNostrRelayUrls } from './nostrRelays.ts'
import {
  oraclePublicationTerminal,
  mergeOraclePublicationRecords,
  snapshotOraclePublicationRecord,
  type OraclePublicationBinding,
  type OraclePublicationRecord,
} from './oraclePublication.ts'
import { readSignedOracleEvent } from './oracleResolutionExplanation.ts'

export const ORACLE_BACKUP_SCAN_BROAD_MAX = 32
export const ORACLE_BACKUP_SCAN_BUCKET_MAX = 128
export const ORACLE_BACKUP_SCAN_FRAME_BYTES_MAX = 96 * 1_024
export const ORACLE_BACKUP_SCAN_BYTES_MAX = 160 * ORACLE_BACKUP_SCAN_FRAME_BYTES_MAX
export const ORACLE_BACKUP_SCAN_DEADLINE_MS = 10_000

export interface OracleBackupDescriptor {
  readonly conditionId: string
  readonly oraclePubkey: string
  readonly oracleEventId: string
  readonly announcementEventId: string
  readonly backupEventId: string
  readonly createdAt: number
  readonly sourceRelay: string
  readonly outcomes: readonly string[]
  readonly destinations: OracleBackupRecord['destinations']
  readonly state: 'unresolved' | 'signed' | 'terminal'
}
export interface OracleBackupScanCursor {
  readonly schemaVersion: 1
  readonly author: string
  readonly relayUrls: readonly string[]
  readonly relayIndex: number
  readonly until: number | null
}
export interface OracleBackupRelayFilter {
  readonly kinds: readonly number[]
  readonly authors: readonly string[]
  readonly '#v'?: readonly string[]
  readonly '#d'?: readonly string[]
  readonly ids?: readonly string[]
  readonly limit: number
  readonly since?: number
  readonly until?: number
}
export interface OracleBackupRelayQuery {
  readonly relayUrl: string
  readonly filter: OracleBackupRelayFilter
  readonly signal: AbortSignal
  readonly maxEvents: number
  readonly maxBytes: number
}
/** The adapter bounds frames and bytes, closes at EOSE, and cleans up on abort. */
export type OracleBackupQueryRelay = (input: OracleBackupRelayQuery) => Promise<{
  readonly events: readonly unknown[]
  /** EOSE was received. This does not promise complete history or retention. */
  readonly complete: boolean
}>
export type OracleBackupScanPartialReason =
  | 'relay-dependent-history'
  | 'query-failed'
  | 'deadline'
  | 'saturated-bucket'
  | 'processing-limit'
  | 'invalid-candidates'
  | 'unsupported-version'
  | 'lifecycle-regression'
export interface OracleBackupScanResult {
  readonly descriptors: readonly OracleBackupDescriptor[]
  readonly cursor: OracleBackupScanCursor | null
  readonly discovery: 'relay-dependent'
  readonly partialReasons: readonly OracleBackupScanPartialReason[]
  readonly observedRelayComplete: boolean
}
export class OracleBackupAccessError extends Error {
  readonly reason:
    | 'wrong-owner'
    | 'invalid-envelope'
    | 'invalid-cursor'
    | 'invalid-relays'
    | 'local-state'
    | 'stale-source'
    | 'unsupported-version'
    | 'incomplete-query'
    | 'unavailable'
    | 'lifecycle-regression'
  constructor(reason: OracleBackupAccessError['reason']) {
    super(`Private oracle backup access: ${reason}.`)
    this.name = 'OracleBackupAccessError'
    this.reason = reason
  }
}

/** NIP-01 replaceable ordering: newest timestamp, then lowest event ID on a tie. */
function precedes(left: Event, right: Event): boolean {
  return (
    left.created_at > right.created_at ||
    (left.created_at === right.created_at && left.id < right.id)
  )
}

function supportedVersion(event: Event): boolean {
  return event.tags[1][1] === '1' || event.tags[1][1] === '2'
}

/** A timestamp cannot restore a retired nonce or erase a verified signing choice. */
export function assertOracleBackupLifecycleDoesNotRegress(
  candidate: OracleBackupRecord,
  known: OracleBackupRecord,
): void {
  const next = candidate.authority
  const old = known.authority
  const refuse = () => {
    throw new OracleBackupAccessError('lifecycle-regression')
  }
  if (
    candidate.conditionId !== known.conditionId ||
    candidate.oraclePubkey !== known.oraclePubkey ||
    candidate.oracleEventId !== known.oracleEventId ||
    next.announcementTlvHex !== old.announcementTlvHex ||
    next.announcementEventJson !== old.announcementEventJson
  )
    refuse()
  if (old.nonceScalarHex === null && next.nonceScalarHex !== null) refuse()
  if (
    old.nonceScalarHex !== null &&
    next.nonceScalarHex !== null &&
    old.nonceScalarHex !== next.nonceScalarHex
  )
    refuse()
  for (const key of ['signedOutcome', 'attestationHex', 'attestationEventJson'] as const)
    if (old[key] !== null && old[key] !== next[key]) refuse()
  if (old.publicationRecordJson !== null) {
    if (next.publicationRecordJson === null) refuse()
    try {
      const previous = snapshotOraclePublicationRecord(JSON.parse(old.publicationRecordJson))
      const current = snapshotOraclePublicationRecord(JSON.parse(next.publicationRecordJson!))
      if (
        JSON.stringify(mergeOraclePublicationRecords(previous, current)) !== JSON.stringify(current)
      )
        refuse()
    } catch {
      refuse()
    }
  }
}

/**
 * Recheck a selected identity on the configured relays before importing its exact ID.
 * EOSE and ordering describe those observations, never global signing freshness.
 * Versions are deliberately not filtered: an authenticated future version blocks
 * fallback to an older copy of private signing authority.
 */
export async function fetchCurrentOracleBackupSelection(input: {
  readonly author: string
  readonly privateKey: Uint8Array
  readonly validator: OracleBackupValidator
  readonly eventId: string
  readonly sourceRelay: string
  readonly relayUrls: readonly string[]
  readonly queryRelay: OracleBackupQueryRelay
  readonly signal?: AbortSignal
}): Promise<Event> {
  if (!/^[0-9a-f]{64}$/.test(input.eventId) || !/^[0-9a-f]{64}$/.test(input.author))
    throw new OracleBackupAccessError('invalid-envelope')
  if (getPublicKey(input.privateKey) !== input.author)
    throw new OracleBackupAccessError('wrong-owner')
  const relays = checkedRelays([...new Set([...input.relayUrls, input.sourceRelay])])
  const source = checkedRelays([input.sourceRelay])[0]
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(ORACLE_BACKUP_SCAN_DEADLINE_MS)])
    : AbortSignal.timeout(ORACLE_BACKUP_SCAN_DEADLINE_MS)
  let bytes = 0
  let rawEvents = 0
  const observed = new Map<string, Event>()
  const query = async (relayUrl: string, filter: OracleBackupRelayFilter, required: boolean) => {
    input.signal?.throwIfAborted()
    let reply: Awaited<ReturnType<OracleBackupQueryRelay>>
    try {
      signal.throwIfAborted()
      reply = await input.queryRelay({
        relayUrl,
        filter,
        signal,
        maxEvents: ORACLE_BACKUP_SCAN_BROAD_MAX,
        maxBytes: ORACLE_BACKUP_SCAN_BROAD_MAX * ORACLE_BACKUP_SCAN_FRAME_BYTES_MAX,
      })
    } catch {
      input.signal?.throwIfAborted()
      if (required) throw new OracleBackupAccessError('incomplete-query')
      return []
    }
    input.signal?.throwIfAborted()
    if (
      !Array.isArray(reply.events) ||
      reply.events.length > ORACLE_BACKUP_SCAN_BROAD_MAX ||
      (required && (!reply.complete || reply.events.length === ORACLE_BACKUP_SCAN_BROAD_MAX))
    )
      throw new OracleBackupAccessError('incomplete-query')
    rawEvents += reply.events.length
    if (rawEvents > ORACLE_BACKUP_SCAN_BROAD_MAX + ORACLE_BACKUP_SCAN_BUCKET_MAX)
      throw new OracleBackupAccessError('incomplete-query')
    const events: Event[] = []
    for (const raw of reply.events) {
      const size = new TextEncoder().encode(JSON.stringify(raw)).length
      bytes += size
      if (size > ORACLE_BACKUP_SCAN_FRAME_BYTES_MAX || bytes > ORACLE_BACKUP_SCAN_BYTES_MAX)
        throw new OracleBackupAccessError('incomplete-query')
      try {
        const event = readOracleBackupEnvelope(raw, input.author)
        if (matchesFilter(event, filter)) {
          events.push(event)
          observed.set(event.id, event)
        }
      } catch {
        // Invalid signatures cannot suppress an authenticated selection.
      }
    }
    return events
  }
  const base = {
    kinds: [ORACLE_BACKUP_KIND],
    authors: [input.author],
    limit: ORACLE_BACKUP_SCAN_BROAD_MAX,
  }
  const selected = (await query(source, { ...base, ids: [input.eventId] }, true)).find(
    (event) => event.id === input.eventId,
  )
  if (!selected) throw new OracleBackupAccessError('unavailable')
  let newest = selected
  const identityFilter = { ...base, '#d': [selected.tags[0][1]] }
  for (const event of await query(source, identityFilter, true))
    if (precedes(event, newest)) newest = event
  const optionalRelays = relays.filter((relay) => relay !== source)
  // A small batch bounds socket fan-out even for the maximum configured relay list.
  for (let index = 0; index < optionalRelays.length; index += 4) {
    const batches = await Promise.all(
      optionalRelays.slice(index, index + 4).map((relay) => query(relay, identityFilter, false)),
    )
    for (const events of batches)
      for (const event of events) if (precedes(event, newest)) newest = event
  }
  if (!supportedVersion(newest)) throw new OracleBackupAccessError('unsupported-version')
  if (newest.id !== selected.id) throw new OracleBackupAccessError('stale-source')
  // Validation has its own bounded phase: optional transport timeout must not
  // consume the healthy source's validation budget. The uncancellable validator
  // port can leave at most one operation in flight after refusal.
  const validation = new AbortController()
  const abort = () => validation.abort()
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) abort()
  const timer = setTimeout(abort, ORACLE_BACKUP_SCAN_DEADLINE_MS)
  const decode = async (event: Event) => {
    if (validation.signal.aborted) throw new OracleBackupAccessError('incomplete-query')
    let onAbort: () => void = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new OracleBackupAccessError('incomplete-query'))
      validation.signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([
        decryptOracleBackupEvent({
          event,
          privateKey: input.privateKey,
          validator: input.validator,
        }),
        cancelled,
      ])
    } finally {
      validation.signal.removeEventListener('abort', onAbort)
    }
  }
  try {
    const current = await decode(selected)
    for (const event of observed.values()) {
      if (
        event.id === selected.id ||
        event.tags[0][1] !== selected.tags[0][1] ||
        !supportedVersion(event)
      )
        continue
      let known: OracleBackupRecord
      try {
        known = await decode(event)
      } catch (error) {
        if (error instanceof OracleBackupAccessError) throw error
        continue // Invalid private payloads do not establish lifecycle authority.
      }
      assertOracleBackupLifecycleDoesNotRegress(current, known)
    }
    return selected
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
    validation.abort()
  }
}

/** Refetch the selected exact ID before this call. Descriptors grant no import authority. */
export async function restoreOracleBackupEnvelope(input: {
  readonly event: unknown
  readonly sourceRelay: string
  readonly privateKey: Uint8Array
  readonly validator: OracleBackupValidator
}): Promise<{
  readonly record: OracleBackupRecord
  readonly source: OracleBackupSource
  readonly descriptor: OracleBackupDescriptor
}> {
  try {
    const author = getPublicKey(input.privateKey)
    if (
      object(input.event) &&
      typeof input.event.pubkey === 'string' &&
      input.event.pubkey !== author
    )
      throw new OracleBackupAccessError('wrong-owner')
    const sourceRelay = checkedRelays([input.sourceRelay])[0]
    const event = readOracleBackupEnvelope(input.event, author)
    let outcomes: readonly string[] | null = null
    const record = await decryptOracleBackupEvent({
      event,
      privateKey: input.privateKey,
      validator: {
        async validateAuthority(dto, expectedAuthor) {
          const summary = await input.validator.validateAuthority(dto, expectedAuthor)
          outcomes = [...summary.outcomes]
          return summary
        },
      },
    })
    if (outcomes === null) throw new Error()
    const source = { eventId: event.id, createdAt: event.created_at, sourceRelay }
    return {
      record,
      source,
      descriptor: {
        conditionId: record.conditionId,
        oraclePubkey: record.oraclePubkey,
        oracleEventId: record.oracleEventId,
        announcementEventId: readSignedOracleEvent(record.authority.announcementEventJson, 88).id,
        backupEventId: source.eventId,
        createdAt: source.createdAt,
        sourceRelay,
        outcomes,
        destinations: {
          mintUrl: record.destinations.mintUrl,
          engineUrl: record.destinations.engineUrl,
          relayUrls: [...record.destinations.relayUrls],
        },
        state:
          record.authority.nonceScalarHex === null
            ? 'terminal'
            : record.authority.signedOutcome === null
              ? 'unresolved'
              : 'signed',
      },
    }
  } catch (error) {
    if (error instanceof OracleBackupAccessError && error.reason === 'wrong-owner') throw error
    throw new OracleBackupAccessError('invalid-envelope')
  }
}

/** Scan one relay per page. T-1 continuation depends on the relay's result policy. */
export async function listOracleBackups(input: {
  readonly privateKey: Uint8Array
  readonly validator: OracleBackupValidator
  readonly relayUrls: readonly string[]
  readonly cursor?: OracleBackupScanCursor | null
  readonly queryRelay: OracleBackupQueryRelay
  readonly signal?: AbortSignal
}): Promise<OracleBackupScanResult> {
  const relayUrls = checkedRelays(input.relayUrls).sort()
  let author: string
  try {
    author = getPublicKey(input.privateKey)
  } catch {
    throw new OracleBackupAccessError('wrong-owner')
  }
  const start = checkedCursor(input.cursor, author, relayUrls)
  const reasons: OracleBackupScanPartialReason[] = ['relay-dependent-history']
  const descriptors: OracleBackupDescriptor[] = []
  const recordsByIdentity = new Map<string, OracleBackupRecord[]>()
  const recordsByEventId = new Map<string, OracleBackupRecord>()
  const currentDescriptors = () =>
    descriptors.filter((descriptor) => {
      const current = recordsByEventId.get(descriptor.backupEventId)!
      const identity = readSignedOracleEvent(current.authority.announcementEventJson, 88).id
      try {
        for (const known of recordsByIdentity.get(identity) ?? [])
          assertOracleBackupLifecycleDoesNotRegress(current, known)
        return true
      } catch {
        reasons.push('lifecycle-regression')
        return false
      }
    })
  const result = (
    cursor: OracleBackupScanCursor | null,
    observedRelayComplete = false,
  ): OracleBackupScanResult => ({
    descriptors: currentDescriptors(),
    cursor,
    discovery: 'relay-dependent',
    partialReasons: [...new Set(reasons)],
    observedRelayComplete,
  })
  if (relayUrls.length === 0) return result(null, true)
  const controller = new AbortController()
  const deadline = Date.now() + ORACLE_BACKUP_SCAN_DEADLINE_MS
  const abort = () => controller.abort()
  input.signal?.addEventListener('abort', abort, { once: true })
  if (input.signal?.aborted) controller.abort()
  const timer = setTimeout(abort, ORACLE_BACKUP_SCAN_DEADLINE_MS)
  let bytes = 0
  const seen = new Set<string>()
  const newestByIdentity = new Map<string, Event>()
  const checkDeadline = () => {
    if (controller.signal.aborted || Date.now() >= deadline) throw new ScanFailure('deadline')
  }
  // At most one validator can remain active after a timeout. Its port has no cancellation API.
  // Do not schedule more validation after that timeout.
  const boundedAwait = async <T>(operation: () => Promise<T>): Promise<T> => {
    checkDeadline()
    let rejectAbort: (() => void) | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(new ScanFailure('deadline'))
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    try {
      const value = await Promise.race([operation(), cancelled])
      checkDeadline()
      return value
    } finally {
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
    }
  }
  const base: OracleBackupRelayFilter = {
    kinds: [ORACLE_BACKUP_KIND],
    authors: [author],
    limit: ORACLE_BACKUP_SCAN_BROAD_MAX,
  }
  const query = async (filter: OracleBackupRelayFilter, maxEvents: number) => {
    let reply: Awaited<ReturnType<OracleBackupQueryRelay>>
    try {
      reply = await boundedAwait(() =>
        input.queryRelay({
          relayUrl: relayUrls[start.relayIndex],
          filter,
          signal: controller.signal,
          maxEvents,
          maxBytes: maxEvents * ORACLE_BACKUP_SCAN_FRAME_BYTES_MAX,
        }),
      )
    } catch (error) {
      if (error instanceof ScanFailure) throw error
      throw new ScanFailure('query-failed')
    }
    if (!reply || !Array.isArray(reply.events) || reply.events.length > maxEvents)
      throw new ScanFailure('processing-limit')
    // Count all raw replies before filtering or deduplication.
    for (const value of reply.events) {
      checkDeadline()
      let size: number
      try {
        size = new TextEncoder().encode(JSON.stringify(value)).length
      } catch {
        throw new ScanFailure('processing-limit')
      }
      bytes += size
      if (size > ORACLE_BACKUP_SCAN_FRAME_BYTES_MAX || bytes > ORACLE_BACKUP_SCAN_BYTES_MAX)
        throw new ScanFailure('processing-limit')
    }
    if (reply.complete !== true) throw new ScanFailure('query-failed')
    return reply.events
  }
  const validate = async (events: readonly unknown[], filter: OracleBackupRelayFilter) => {
    for (const value of events) {
      checkDeadline()
      // Only authenticated IDs can suppress another raw version.
      let envelope: Event
      try {
        const event = readAuthenticatedScanEvent(value, filter)
        // Kind 30078 also carries settings and public creator records. They
        // participate in pagination, but are not malformed oracle backups.
        if (
          !event.tags.some((tag) => tag[0] === 'd' && tag[1]?.startsWith(ORACLE_BACKUP_TAG_PREFIX))
        )
          continue
        envelope = readOracleBackupEnvelope(event, author)
      } catch {
        reasons.push('invalid-candidates')
        continue
      }
      if (seen.has(envelope.id)) continue
      seen.add(envelope.id)
      const identity = envelope.tags[0][1]
      const previous = newestByIdentity.get(identity)
      const isNewest = !previous || precedes(envelope, previous)
      if (isNewest) newestByIdentity.set(identity, envelope)
      if (previous && isNewest) {
        const index = descriptors.findIndex((row) => row.backupEventId === previous.id)
        if (index >= 0) descriptors.splice(index, 1)
      }
      if (!supportedVersion(envelope)) {
        reasons.push('unsupported-version')
        continue
      }
      try {
        const restored = await boundedAwait(() =>
          restoreOracleBackupEnvelope({
            event: value,
            sourceRelay: relayUrls[start.relayIndex],
            privateKey: input.privateKey,
            validator: input.validator,
          }),
        )
        recordsByEventId.set(envelope.id, restored.record)
        const announcementId = restored.descriptor.announcementEventId
        const history = recordsByIdentity.get(announcementId) ?? []
        history.push(restored.record)
        recordsByIdentity.set(announcementId, history)
        if (isNewest) descriptors.push(restored.descriptor)
      } catch (error) {
        if (error instanceof ScanFailure) throw error
        reasons.push('invalid-candidates')
      }
    }
  }
  const nextRelay = () =>
    start.relayIndex + 1 < relayUrls.length
      ? { ...start, relayIndex: start.relayIndex + 1, until: null }
      : null
  try {
    const broadFilter = { ...base, ...(start.until === null ? {} : { until: start.until }) }
    const broad = await query(broadFilter, ORACLE_BACKUP_SCAN_BROAD_MAX)
    if (broad.length === 0) return result(nextRelay(), true)
    const matching: { created_at: number }[] = []
    for (const value of broad) {
      checkDeadline()
      try {
        // Advance over the entire authenticated kind/author feed. Otherwise
        // newer unrelated records can permanently hide older oracle backups.
        matching.push(readAuthenticatedScanEvent(value, broadFilter))
      } catch {
        reasons.push('invalid-candidates')
      }
    }
    if (matching.length === 0) throw new ScanFailure('processing-limit')
    const oldest = Math.min(...matching.map((value) => value.created_at))
    const bucketFilter = {
      ...base,
      limit: ORACLE_BACKUP_SCAN_BUCKET_MAX,
      since: oldest,
      until: oldest,
    }
    const bucket = await query(bucketFilter, ORACLE_BACKUP_SCAN_BUCKET_MAX)
    await validate(broad, broadFilter)
    await validate(bucket, bucketFilter)
    if (bucket.length === ORACLE_BACKUP_SCAN_BUCKET_MAX) {
      reasons.push('saturated-bucket')
      return result(start)
    }
    if (oldest === 0) return result(nextRelay(), true)
    return result({ ...start, until: oldest - 1 })
  } catch (error) {
    reasons.push(error instanceof ScanFailure ? error.reason : 'processing-limit')
    return result(start)
  } finally {
    clearTimeout(timer)
    input.signal?.removeEventListener('abort', abort)
    controller.abort()
  }
}

export interface OracleBackupStatus {
  readonly binding: {
    readonly conditionId: string
    readonly oraclePubkey: string
    readonly oracleEventId: string
    readonly announcementEventId: string
    readonly outcomes: readonly string[]
  }
  readonly destinations: OracleBackupRecord['destinations']
  readonly publication: {
    readonly state: 'unresolved' | 'signed' | 'terminal'
    readonly relayPublished: boolean
    readonly engineSynchronized: boolean
  }
  readonly importComplete: boolean
  readonly preparationPending: boolean
  readonly initial: {
    readonly prepared: boolean
    readonly acknowledgedRelays: number
    readonly totalRelays: number
  }
  readonly terminal: {
    readonly prepared: boolean
    readonly replacementAcknowledgedRelays: number
    readonly deletionRequired: boolean
    readonly deletionAcknowledgedRelays: number
    readonly localCommitPending: boolean
  }
  readonly noRelays: boolean
}

/** Project durable owner facts. Initial acknowledgments do not imply terminal delivery. */
export function oracleBackupStatus(input: {
  readonly binding: OraclePublicationBinding
  readonly destinations: OracleBackupRecord['destinations']
  readonly publication: OraclePublicationRecord | null
  readonly importComplete: boolean
  readonly delivery: OracleBackupDeliveryState | null
}): OracleBackupStatus {
  try {
    const { binding } = input
    const publication =
      input.publication === null ? null : snapshotOraclePublicationRecord(input.publication)
    if (
      publication !== null &&
      (publication.binding.conditionId !== binding.conditionId ||
        publication.binding.oraclePubkey !== binding.oraclePubkey ||
        publication.binding.oracleEventId !== binding.oracleEventId ||
        publication.binding.announcementEventJson !== binding.announcementEventJson ||
        JSON.stringify(publication.binding.outcomes) !== JSON.stringify(binding.outcomes))
    )
      throw new Error()
    const relayUrls = checkedRelays(input.destinations.relayUrls)
    if (JSON.stringify(relayUrls) !== JSON.stringify(input.destinations.relayUrls))
      throw new Error()
    const delivery =
      input.delivery === null ? null : snapshotOracleBackupDeliveryState(input.delivery)
    if (delivery !== null)
      assertOracleBackupDeliveryOwner(delivery, { binding, relayUrls, publication })
    const terminal = publication !== null && oraclePublicationTerminal(publication)
    const initialStage = delivery?.current?.mode === 'initial' ? delivery.current : null
    const terminalStage = delivery?.current?.mode === 'terminal' ? delivery.current : null
    return {
      binding: {
        conditionId: binding.conditionId,
        oraclePubkey: binding.oraclePubkey,
        oracleEventId: binding.oracleEventId,
        announcementEventId: readSignedOracleEvent(binding.announcementEventJson, 88).id,
        outcomes: [...binding.outcomes],
      },
      destinations: {
        mintUrl: input.destinations.mintUrl,
        engineUrl: input.destinations.engineUrl,
        relayUrls,
      },
      publication: {
        state: terminal ? 'terminal' : publication?.attestation == null ? 'unresolved' : 'signed',
        relayPublished: publication?.relayPublished ?? false,
        engineSynchronized:
          publication?.engineEvidence !== null && publication?.engineEvidence !== undefined,
      },
      importComplete: input.importComplete,
      preparationPending: terminal
        ? terminalStage === null ||
          ((delivery?.knownEventIds.length ?? 0) > 0 && delivery?.deletion === null)
        : initialStage === null,
      initial: {
        prepared: initialStage !== null,
        acknowledgedRelays: initialStage?.acknowledgedRelayIndexes.length ?? 0,
        totalRelays: relayUrls.length,
      },
      terminal: {
        prepared: terminalStage !== null,
        replacementAcknowledgedRelays: terminalStage?.acknowledgedRelayIndexes.length ?? 0,
        deletionRequired: (delivery?.knownEventIds.length ?? 0) > 0 && terminal,
        deletionAcknowledgedRelays: delivery?.deletion?.acknowledgedRelayIndexes.length ?? 0,
        localCommitPending: delivery?.terminalCommitPending ?? false,
      },
      noRelays: relayUrls.length === 0,
    }
  } catch {
    throw new OracleBackupAccessError('local-state')
  }
}

class ScanFailure extends Error {
  readonly reason: OracleBackupScanPartialReason
  constructor(reason: OracleBackupScanPartialReason) {
    super(reason)
    this.reason = reason
  }
}
function checkedRelays(value: readonly string[]): string[] {
  try {
    if (
      !Array.isArray(value) ||
      value.length > ORACLE_BACKUP_DELIVERY_RELAYS_MAX ||
      value.some((url) => typeof url !== 'string' || new TextEncoder().encode(url).length > 2_048)
    )
      throw new Error()
    const normalized = normalizeNostrRelayUrls(value)
    if (normalized.some((url) => new TextEncoder().encode(url).length > 2_048)) throw new Error()
    return normalized
  } catch {
    throw new OracleBackupAccessError('invalid-relays')
  }
}
function checkedCursor(
  value: OracleBackupScanCursor | null | undefined,
  author: string,
  relayUrls: readonly string[],
): OracleBackupScanCursor {
  if (value === undefined || value === null)
    return { schemaVersion: 1, author, relayUrls, relayIndex: 0, until: null }
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'author,relayIndex,relayUrls,schemaVersion,until' ||
    value.schemaVersion !== 1 ||
    value.author !== author ||
    !Array.isArray(value.relayUrls) ||
    value.relayUrls.length !== relayUrls.length ||
    value.relayUrls.some((url, index) => url !== relayUrls[index]) ||
    !Number.isSafeInteger(value.relayIndex) ||
    value.relayIndex < 0 ||
    value.relayIndex >= relayUrls.length ||
    (value.until !== null && !timestamp(value.until))
  )
    throw new OracleBackupAccessError('invalid-cursor')
  return structuredClone(value)
}
function readAuthenticatedScanEvent(value: unknown, filter: OracleBackupRelayFilter): Event {
  if (!matchesFilter(value, filter)) throw new Error('Invalid relay scan event.')
  // Strip nostr-tools' verification-cache symbol at the untrusted query port.
  const event = JSON.parse(JSON.stringify(value)) as Event
  if (!verifyEvent(event)) throw new Error('Invalid relay scan signature.')
  return event
}
function matchesFilter(value: unknown, filter: OracleBackupRelayFilter): boolean {
  return (
    object(value) &&
    value.kind === ORACLE_BACKUP_KIND &&
    value.pubkey === filter.authors[0] &&
    timestamp(value.created_at) &&
    (filter.since === undefined || value.created_at >= filter.since) &&
    (filter.until === undefined || value.created_at <= filter.until) &&
    Array.isArray(value.tags) &&
    (filter['#v'] === undefined ||
      value.tags.some(
        (tag) =>
          Array.isArray(tag) &&
          tag.length === 2 &&
          tag[0] === 'v' &&
          filter['#v']!.includes(tag[1]),
      )) &&
    (filter['#d'] === undefined ||
      value.tags.some(
        (tag) =>
          Array.isArray(tag) &&
          tag.length === 2 &&
          tag[0] === 'd' &&
          filter['#d']!.includes(tag[1]),
      )) &&
    (filter.ids === undefined || (typeof value.id === 'string' && filter.ids.includes(value.id)))
  )
}
function timestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
