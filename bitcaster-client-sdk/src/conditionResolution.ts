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

/** The most kind-89 events that one relay query asks for. */
export const ORACLE_ATTESTATION_RELAY_EVENTS_MAX = 16
/** The most relay events that one resolution examines. */
const RELAY_EVENTS_EXAMINED_MAX = 128
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

/** Ask the oracle relays for the kind-89 events of the registered oracle keys. */
export function oracleAttestationRelayFilter(
  registered: RegisteredConditionAuthority,
): OracleAttestationRelayFilter {
  return {
    kinds: [89],
    authors: registered.oracles.map((oracle) => oracle.oraclePublicKey),
    limit: ORACLE_ATTESTATION_RELAY_EVENTS_MAX,
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

function verifiedRelayAttestation(
  registered: RegisteredConditionAuthority,
  raw: unknown,
  seen: Set<string>,
): {
  readonly oraclePublicKey: string
  readonly signature: string
  readonly outcome: string
} | null {
  try {
    const event = readSignedOracleEvent(JSON.stringify(raw), 89)
    if (seen.has(event.id)) return null
    seen.add(event.id)
    const oracle = registered.oracles.find(
      (candidate) => candidate.oraclePublicKey === event.pubkey,
    )
    if (oracle === undefined || event.content.length > ATTESTATION_CONTENT_CHARS_MAX) return null
    const decoded = decodeCtfEnumAttestation(base64ToHex(event.content))
    if (
      decoded.eventId !== registered.eventId ||
      decoded.oraclePublicKey !== oracle.oraclePublicKey ||
      !registered.outcomes.includes(decoded.outcome)
    )
      return null
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
  readonly relays?: {
    /** Decide from the announced maturity whether a pending condition is worth a relay read. */
    readonly when: (maturityEpoch: number) => boolean
    readonly read: (filter: OracleAttestationRelayFilter) => Promise<readonly unknown[]>
  }
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
      return withRelayResult(mint, input.relays.read)
    case 'unverified':
      // The mint reports a result, so the oracle is due. Look for its evidence.
      if (input.relays === undefined) return mint
      return withRelayResult(mint, input.relays.read, state.reportedOutcome)
    default:
      return assertNever(state)
  }
}

async function withRelayResult(
  mint: ConditionResolution,
  read: (filter: OracleAttestationRelayFilter) => Promise<readonly unknown[]>,
  reportedOutcome?: string,
): Promise<ConditionResolution> {
  let events: readonly unknown[]
  try {
    events = await read(oracleAttestationRelayFilter(mint.registeredAuthority))
  } catch {
    // An unavailable relay is no evidence. The mint state stays.
    return mint
  }
  const result = selectRelayConditionAttestation({
    registeredAuthority: mint.registeredAuthority,
    events,
    reportedOutcome,
  })
  if (result === null) return mint
  return { ...mint, state: { status: 'resolved', source: 'relay', ...result } }
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
