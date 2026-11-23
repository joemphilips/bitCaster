import { bytesToHex } from '@noble/hashes/utils.js'
import {
  decodeCtfEnumAttestation,
  verifyCtfConditionRegistration,
  verifyCtfEnumAnnouncement,
} from './ctfConditionRegistration.ts'
import {
  prepareDlcConditionResolutionEvidence,
  verifyDlcOracleResolution,
} from './managedConditionInventory.ts'
import { readSignedOracleEvent } from './oracleResolutionExplanation.ts'

/** The most kind-89 events that one relay page asks for. */
export const ORACLE_ATTESTATION_RELAY_EVENTS_MAX = 16
/**
 * The most pages that one relay read asks for. The oracle key of a creator
 * attests each of its markets, so newer attestations can fill the first page.
 * Each later page repeats the oldest event of the page before it, so the read
 * reaches the 121 newest events of the relay.
 */
export const ORACLE_ATTESTATION_RELAY_PAGES_MAX = 8
/** The most relays that one resolution reads. */
export const ORACLE_ATTESTATION_RELAYS_MAX = 8
/** One relay read, with all of its pages, stops after this time. */
export const ORACLE_ATTESTATION_RELAY_READ_TIMEOUT_MS = 5_000
/** The most relay events that one resolution examines: each page of each relay. */
const RELAY_EVENTS_EXAMINED_MAX =
  ORACLE_ATTESTATION_RELAYS_MAX *
  ORACLE_ATTESTATION_RELAY_PAGES_MAX *
  ORACLE_ATTESTATION_RELAY_EVENTS_MAX
/** A kind-89 content holds at most an 8 KiB attestation body as base64. */
const ATTESTATION_CONTENT_CHARS_MAX = 11_000

/** The registered oracle facts that verify a result. The mint registration supplies them. */
export interface RegisteredConditionAuthority {
  readonly eventId: string
  readonly outcomes: readonly string[]
  readonly threshold: number
  readonly oracles: readonly {
    readonly oraclePublicKey: string
    readonly noncePoint: string
    readonly announcementIdentity: string
  }[]
}

/** The NUT-CTF redemption witness. */
export interface ConditionOracleWitness {
  readonly oracle_sigs: readonly {
    readonly oracle_pubkey: string
    readonly oracle_sig: string
    readonly outcome: string
  }[]
}

export type ConditionResolutionState =
  /** Oracle signatures that the client verified against the registered announcements. */
  | {
      readonly status: 'resolved'
      readonly source: 'mint' | 'relay'
      readonly attestedOutcome: string
      readonly oracleWitness: ConditionOracleWitness
    }
  /** No verified result yet. */
  | { readonly status: 'pending' }
  /** The mint reports a result, but no evidence for it verifies. */
  | {
      readonly status: 'unverified'
      readonly reportedOutcome: string
      readonly reason: 'missing' | 'invalid'
    }
  /** The mint does not redeem this condition by an oracle result. */
  | { readonly status: 'refused'; readonly mintStatus: 'expired' | 'violation' }

export interface ConditionResolution {
  readonly conditionId: string
  readonly registeredAuthority: RegisteredConditionAuthority
  /** The earliest announced event maturity, in Unix seconds. */
  readonly maturityEpoch: number
  readonly state: ConditionResolutionState
}

export interface OracleAttestationRelayFilter {
  readonly kinds: readonly [89]
  readonly authors: readonly string[]
  readonly limit: number
  /** NIP-01: only events with `created_at <= until`. A later page uses it to read older events. */
  readonly until?: number
}

/** The oracle relays of one resolution. Each relay is read independently. */
export interface OracleAttestationRelays {
  /** Decide from the announced maturity whether a pending condition is worth a relay read. */
  readonly when: (maturityEpoch: number) => boolean
  /** The relays in order of preference. The read uses the first `ORACLE_ATTESTATION_RELAYS_MAX`. */
  readonly urls: () => Promise<readonly string[]>
  /** One page query to one relay. */
  readonly query: (
    url: string,
    filter: OracleAttestationRelayFilter,
    signal: AbortSignal,
  ) => Promise<readonly unknown[]>
  /** Stops each relay read. */
  readonly signal?: AbortSignal
}

type MintAttestationStatus = 'pending' | 'attested' | 'expired' | 'violation'

/**
 * Read the mint condition record (NUT-CTF "Condition Info"). The verified
 * announcements of the registration supply the oracle authority. A recorded
 * result counts only when its oracle signatures verify against them.
 */
export function readMintConditionResolution(input: {
  readonly condition: unknown
  readonly mintUrl: string
  readonly conditionId: string
  readonly allowInsecureLoopbackHttp: boolean
}): ConditionResolution {
  const registration = verifyCtfConditionRegistration(input)
  const info = input.condition as Record<string, unknown>
  const announcements = info.announcements as readonly string[]
  const base = {
    conditionId: registration.conditionId,
    registeredAuthority: {
      eventId: registration.eventId,
      outcomes: registration.outcomes,
      threshold: registration.threshold,
      oracles: registration.oracles,
    },
    maturityEpoch: Math.min(
      ...announcements.map(
        (announcement) => verifyCtfEnumAnnouncement(announcement).eventMaturityEpoch,
      ),
    ),
  }
  // NUT-CTF omits the attestation object until the mint records a result.
  if (info.attestation === undefined || info.attestation === null)
    return { ...base, state: { status: 'pending' } }
  if (typeof info.attestation !== 'object' || Array.isArray(info.attestation))
    throw new Error('mint condition attestation is invalid')
  const attestation = info.attestation as Record<string, unknown>
  const status = mintAttestationStatus(attestation.status)
  switch (status) {
    case 'pending':
      return { ...base, state: { status: 'pending' } }
    case 'expired':
    case 'violation':
      return { ...base, state: { status: 'refused', mintStatus: status } }
    case 'attested':
      return { ...base, state: mintRecordState(base.registeredAuthority, attestation) }
    default:
      return assertNever(status)
  }
}

function mintRecordState(
  registered: RegisteredConditionAuthority,
  attestation: Record<string, unknown>,
): ConditionResolutionState {
  const outcome = attestation.winning_outcome
  if (typeof outcome !== 'string' || !registered.outcomes.includes(outcome))
    throw new Error('mint condition result is foreign')
  if (!Array.isArray(attestation.oracle_sigs))
    return { status: 'unverified', reportedOutcome: outcome, reason: 'missing' }
  try {
    return {
      status: 'resolved',
      source: 'mint',
      ...verifiedWitness(registered, outcome, attestation.oracle_sigs),
    }
  } catch {
    return { status: 'unverified', reportedOutcome: outcome, reason: 'invalid' }
  }
}

function mintAttestationStatus(raw: unknown): MintAttestationStatus {
  switch (raw) {
    case 'pending':
    case 'attested':
    case 'expired':
    case 'violation':
      return raw
    default:
      throw new Error('mint condition attestation status is unknown')
  }
}

/**
 * Ask a relay for the kind-89 events of the registered oracle keys. A later
 * page sets `until` to the oldest event of the page before it.
 */
export function oracleAttestationRelayFilter(
  registered: RegisteredConditionAuthority,
  until?: number,
): OracleAttestationRelayFilter {
  return {
    kinds: [89],
    authors: registered.oracles.map((oracle) => oracle.oraclePublicKey),
    limit: ORACLE_ATTESTATION_RELAY_EVENTS_MAX,
    ...(until === undefined ? {} : { until }),
  }
}

/**
 * Select the oracle result from untrusted relay events. Each signature must
 * verify against the registered announcement and its nonce. A valid result
 * needs the registered threshold of distinct oracles. Valid signatures for two
 * outcomes, or a result other than the one that the mint recorded, are a
 * conflict: the caller must not redeem.
 */
export function selectRelayConditionAttestation(input: {
  readonly registeredAuthority: RegisteredConditionAuthority
  readonly events: readonly unknown[]
  readonly reportedOutcome?: string
}): { readonly attestedOutcome: string; readonly oracleWitness: ConditionOracleWitness } | null {
  const registered = input.registeredAuthority
  const signatures = new Map<string, Map<string, string>>()
  const seen = new Set<string>()
  for (const raw of input.events.slice(0, RELAY_EVENTS_EXAMINED_MAX)) {
    const attestation = verifiedRelayAttestation(registered, raw, seen)
    if (attestation === null) continue
    const byOracle = signatures.get(attestation.outcome) ?? new Map<string, string>()
    byOracle.set(attestation.oraclePublicKey, attestation.signature)
    signatures.set(attestation.outcome, byOracle)
  }
  if (signatures.size > 1) throw new Error('oracle attestations on the relays conflict')
  const [entry] = signatures
  if (entry === undefined) return null
  const [outcome, byOracle] = entry
  if (input.reportedOutcome !== undefined && input.reportedOutcome !== outcome)
    throw new Error('relay oracle attestation conflicts with the mint record')
  if (byOracle.size < registered.threshold) return null
  return verifiedWitness(
    registered,
    outcome,
    [...byOracle].map(([oraclePublicKey, signature]) => ({
      oracle_pubkey: oraclePublicKey,
      oracle_sig: signature,
      outcome,
    })),
  )
}

/**
 * Decode a relay event that names the registered event, before any signature
 * check. Most kind-89 events of a creator key attest its other markets, so this
 * check keeps a long read cheap. The result is not evidence.
 */
function registeredEventAttestation(
  registered: RegisteredConditionAuthority,
  raw: unknown,
): {
  readonly oracle: RegisteredConditionAuthority['oracles'][number]
  readonly decoded: ReturnType<typeof decodeCtfEnumAttestation>
} | null {
  const event = eventFields(raw)
  const oracle = registered.oracles.find((candidate) => candidate.oraclePublicKey === event.pubkey)
  if (
    event.kind !== 89 ||
    oracle === undefined ||
    typeof event.content !== 'string' ||
    event.content.length > ATTESTATION_CONTENT_CHARS_MAX
  )
    return null
  try {
    const decoded = decodeCtfEnumAttestation(base64ToHex(event.content))
    if (
      decoded.eventId !== registered.eventId ||
      decoded.oraclePublicKey !== oracle.oraclePublicKey ||
      !registered.outcomes.includes(decoded.outcome)
    )
      return null
    return { oracle, decoded }
  } catch {
    return null
  }
}

function verifiedRelayAttestation(
  registered: RegisteredConditionAuthority,
  raw: unknown,
  seen: Set<string>,
): {
  readonly oraclePublicKey: string
  readonly signature: string
  readonly outcome: string
} | null {
  const candidate = registeredEventAttestation(registered, raw)
  if (candidate === null) return null
  const { oracle, decoded } = candidate
  try {
    const event = readSignedOracleEvent(JSON.stringify(raw), 89)
    if (seen.has(event.id)) return null
    seen.add(event.id)
    // One signature on the announced nonce of this oracle.
    verifyDlcOracleResolution(
      { outcomes: registered.outcomes, threshold: 1, oracles: [oracle] },
      {
        schemaVersion: 1,
        source: 'dlc-oracle-attestation',
        attestations: [{ oraclePublicKey: oracle.oraclePublicKey, signature: decoded.signature }],
        resolvedOutcome: decoded.outcome,
      },
    )
    return {
      oraclePublicKey: oracle.oraclePublicKey,
      signature: decoded.signature,
      outcome: decoded.outcome,
    }
  } catch {
    // A forged, foreign or malformed event is not evidence.
    return null
  }
}

function verifiedWitness(
  registered: RegisteredConditionAuthority,
  outcome: string,
  oracleSigs: unknown,
): { readonly attestedOutcome: string; readonly oracleWitness: ConditionOracleWitness } {
  const prepared = prepareDlcConditionResolutionEvidence(outcome, { oracle_sigs: oracleSigs })
  verifyDlcOracleResolution(registered, prepared.evidence)
  return {
    attestedOutcome: prepared.evidence.resolvedOutcome,
    oracleWitness: JSON.parse(prepared.canonicalOracleWitness) as ConditionOracleWitness,
  }
}

/**
 * Resolve one condition without the matching engine. Read the mint record
 * first. When the mint has no verified result, read the oracle attestation
 * from the relays and verify it locally. The caller then redeems with that
 * witness, and the mint records the first valid result.
 */
export async function resolveConditionResult(input: {
  readonly conditionId: string
  readonly mintUrl: string
  readonly allowInsecureLoopbackHttp: boolean
  /** `GET /v1/conditions/{condition_id}?include_oracle_sigs=true` */
  readonly readMintCondition: () => Promise<unknown>
  readonly relays?: OracleAttestationRelays
}): Promise<ConditionResolution> {
  const mint = readMintConditionResolution({
    condition: await input.readMintCondition(),
    mintUrl: input.mintUrl,
    conditionId: input.conditionId,
    allowInsecureLoopbackHttp: input.allowInsecureLoopbackHttp,
  })
  const state = mint.state
  switch (state.status) {
    case 'resolved':
    case 'refused':
      return mint
    case 'pending':
      if (input.relays === undefined || !input.relays.when(mint.maturityEpoch)) return mint
      return withRelayResult(mint, input.relays)
    case 'unverified':
      // The mint reports a result, so the oracle is due. Look for its evidence.
      if (input.relays === undefined) return mint
      return withRelayResult(mint, input.relays, state.reportedOutcome)
    default:
      return assertNever(state)
  }
}

async function withRelayResult(
  mint: ConditionResolution,
  relays: OracleAttestationRelays,
  reportedOutcome?: string,
): Promise<ConditionResolution> {
  let urls: readonly string[]
  try {
    urls = (await relays.urls()).slice(0, ORACLE_ATTESTATION_RELAYS_MAX)
  } catch {
    // Without a relay list there is no relay evidence. The mint state stays.
    return mint
  }
  // A relay that fails or stalls does not stop the reads of the others.
  const events = await Promise.all(
    urls.map((url) => readRelayAttestationEvents(relays, url, mint.registeredAuthority)),
  )
  const result = selectRelayConditionAttestation({
    registeredAuthority: mint.registeredAuthority,
    events: events.flat(),
    reportedOutcome,
  })
  if (result === null) return mint
  return { ...mint, state: { status: 'resolved', source: 'relay', ...result } }
}

/**
 * Read one relay from its newest event backward. Each page asks for the events
 * at or before the oldest event of the page before it. The read stops at a
 * short page, at a page without a new event, at a valid attestation of the
 * registered event, after `ORACLE_ATTESTATION_RELAY_PAGES_MAX` pages, or at its
 * deadline. A failed or late page ends the read. The earlier pages stay.
 *
 * An inclusive `until` repeats a full page of events that share its second.
 * Thus a page without a new event, whose oldest event has that second, moves
 * `until` one second back once. If that page also brings no new event, the
 * read stops.
 */
async function readRelayAttestationEvents(
  relays: OracleAttestationRelays,
  url: string,
  registered: RegisteredConditionAuthority,
): Promise<unknown[]> {
  const deadline = relayReadDeadline(relays.signal)
  const events: unknown[] = []
  const ids = new Set<string>()
  let until: number | undefined
  let movedBack = false
  try {
    for (let page = 0; page < ORACLE_ATTESTATION_RELAY_PAGES_MAX; page += 1) {
      const filter = oracleAttestationRelayFilter(registered, until)
      let received: readonly unknown[]
      try {
        received = await untilAborted(relays.query(url, filter, deadline.signal), deadline.signal)
      } catch {
        break
      }
      // A relay that ignores the limit cannot crowd out the other relays.
      const answer = Array.isArray(received) ? received.slice(0, filter.limit) : []
      let fresh = 0
      // The oldest new event, and the oldest event of the page with the repeated ones.
      let oldest: number | undefined
      let pageOldest: number | undefined
      let attested = false
      for (const raw of answer) {
        const event = eventFields(raw)
        if (typeof event.id !== 'string') continue
        const createdAt = eventCreatedAt(event)
        if (createdAt !== undefined) pageOldest = Math.min(pageOldest ?? Infinity, createdAt)
        if (ids.has(event.id)) continue
        ids.add(event.id)
        fresh += 1
        events.push(raw)
        if (createdAt !== undefined) oldest = Math.min(oldest ?? Infinity, createdAt)
        attested ||= verifiedRelayAttestation(registered, raw, new Set()) !== null
      }
      if (answer.length < filter.limit || attested) break
      if (fresh === 0) {
        if (movedBack || until === undefined || until === 0 || pageOldest !== until) break
        until -= 1
        movedBack = true
        continue
      }
      if (oldest === undefined) break
      until = oldest
      movedBack = false
    }
  } finally {
    deadline.dispose()
  }
  return events
}

/** The deadline of one relay read. The caller signal also stops it. */
function relayReadDeadline(caller: AbortSignal | undefined): {
  readonly signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('oracle relay read timed out')),
    ORACLE_ATTESTATION_RELAY_READ_TIMEOUT_MS,
  )
  const stop = () => controller.abort(caller?.reason)
  if (caller?.aborted) stop()
  else caller?.addEventListener('abort', stop, { once: true })
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      caller?.removeEventListener('abort', stop)
    },
  }
}

/** A query that ignores its signal still cannot hold the read. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  ])
}

/** The fields of an untrusted relay event. A value that is not an object has none. */
function eventFields(raw: unknown): Readonly<Record<string, unknown>> {
  return typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
}

/** The `created_at` second of an untrusted relay event. An invalid value has none. */
function eventCreatedAt(event: Readonly<Record<string, unknown>>): number | undefined {
  const createdAt = event.created_at
  return Number.isSafeInteger(createdAt) && (createdAt as number) >= 0
    ? (createdAt as number)
    : undefined
}

function base64ToHex(content: string): string {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytesToHex(bytes)
}

function assertNever(value: never): never {
  throw new Error(`unhandled condition resolution variant: ${JSON.stringify(value)}`)
}
