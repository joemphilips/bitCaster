import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { deriveDlcConditionId } from '../src/managedConditionInventory.ts'
import {
  decodeCtfEnumAttestation,
  verifyCtfEnumAnnouncement,
} from '../src/ctfConditionRegistration.ts'
import {
  ORACLE_ATTESTATION_RELAY_READ_TIMEOUT_MS,
  oracleAttestationRelayFilter,
  readMintConditionResolution,
  resolveConditionResult,
  selectRelayConditionAttestation,
  type ConditionResolution,
  type OracleAttestationRelayFilter,
  type OracleAttestationRelays,
} from '../src/conditionResolution.ts'
import {
  attestableCtfConditionFixture,
  fixtureOracleKey,
  nip01RelayAnswerFixture,
  otherCtfAttestationEventsFixture,
  signFixtureOutcome,
  signedCtfAttestationEventFixture,
} from './support/ctfAnnouncementFixture.ts'

const MINT = 'https://mint.example'
const RELAY = 'wss://relay.example'
const MATURITY = 1_900_000_000
// Real bytes from the kormir native helper: create-enum, then sign-enum for YES.
const kormir = JSON.parse(
  readFileSync(new URL('./fixtures/kormir-enum-attestation.json', import.meta.url), 'utf8'),
) as {
  eventId: string
  outcomes: string[]
  eventMaturityEpoch: number
  oraclePublicKey: string
  announcementTlvHex: string
  attestedOutcome: string
  attestationHex: string
  attestationEvent: Record<string, unknown>
}

function condition(attestation?: unknown) {
  const fixture = attestableCtfConditionFixture({
    outcomes: ['YES', 'NO'],
    eventId: 'mint-first-resolution',
    winner: 'YES',
    maturityEpoch: MATURITY,
  })
  return {
    ...fixture,
    info: {
      ...fixture.registration,
      registered_at: 1_800_000_000,
      keysets: {},
      ...(attestation === undefined ? {} : { attestation }),
    },
  }
}

function read(info: unknown, conditionId: string): ConditionResolution {
  return readMintConditionResolution({
    condition: info,
    mintUrl: MINT,
    conditionId,
    allowInsecureLoopbackHttp: false,
  })
}

test('the real kormir attestation body decodes and verifies against its own announcement', () => {
  const announcement = verifyCtfEnumAnnouncement(kormir.announcementTlvHex)
  assert.equal(announcement.eventMaturityEpoch, kormir.eventMaturityEpoch)
  const decoded = decodeCtfEnumAttestation(kormir.attestationHex)
  assert.deepEqual(decoded, {
    eventId: kormir.eventId,
    oraclePublicKey: kormir.oraclePublicKey,
    signature: decoded.signature,
    outcome: 'YES',
  })
  assert.equal(decoded.signature.slice(0, 64), announcement.noncePoint)
  const conditionId = deriveDlcConditionId({
    eventId: kormir.eventId,
    outcomeCount: 2,
    oraclePublicKeys: [kormir.oraclePublicKey],
  })
  const pending = read(
    {
      condition_id: conditionId,
      threshold: 1,
      collateral: 'msat',
      announcements: [kormir.announcementTlvHex],
    },
    conditionId,
  )
  assert.equal(pending.state.status, 'pending')
  assert.equal(pending.maturityEpoch, kormir.eventMaturityEpoch)
  assert.deepEqual(
    selectRelayConditionAttestation({
      registeredAuthority: pending.registeredAuthority,
      events: [kormir.attestationEvent],
    }),
    {
      attestedOutcome: 'YES',
      oracleWitness: {
        oracle_sigs: [
          { oracle_pubkey: kormir.oraclePublicKey, oracle_sig: decoded.signature, outcome: 'YES' },
        ],
      },
    },
  )
})

test('strict attestation decoding refuses suffixes, truncation and several outcomes', () => {
  for (const raw of [
    kormir.attestationHex + '00',
    kormir.attestationHex.slice(0, -2),
    kormir.attestationHex.replace(/000103594553$/, '0002035945530159'),
    'zz',
    '00'.repeat(20_000),
  ])
    assert.throws(() => decodeCtfEnumAttestation(raw))
})

test('a mint record with verified oracle signatures resolves the condition', () => {
  const fixture = condition()
  const oracleSig = {
    oracle_pubkey: fixture.oraclePublicKey,
    oracle_sig: fixture.signature,
    outcome: 'YES',
  }
  const resolved = read(
    {
      ...fixture.info,
      attestation: { status: 'attested', winning_outcome: 'YES', oracle_sigs: [oracleSig] },
    },
    fixture.registration.condition_id,
  )
  assert.deepEqual(resolved.state, {
    status: 'resolved',
    source: 'mint',
    attestedOutcome: 'YES',
    oracleWitness: { oracle_sigs: [oracleSig] },
  })
  assert.deepEqual(resolved.registeredAuthority, {
    eventId: 'mint-first-resolution',
    outcomes: ['YES', 'NO'],
    threshold: 1,
    oracles: [
      {
        oraclePublicKey: fixture.oraclePublicKey,
        noncePoint: fixture.signature.slice(0, 64),
        announcementIdentity: resolved.registeredAuthority.oracles[0]!.announcementIdentity,
      },
    ],
  })
  assert.equal(resolved.maturityEpoch, MATURITY)
})

test('a mint record maps each attestation status and refuses an unknown status', () => {
  const fixture = condition()
  const id = fixture.registration.condition_id
  assert.equal(read(fixture.info, id).state.status, 'pending')
  assert.equal(
    read({ ...fixture.info, attestation: { status: 'pending' } }, id).state.status,
    'pending',
  )
  for (const status of ['expired', 'violation'] as const)
    assert.deepEqual(read({ ...fixture.info, attestation: { status } }, id).state, {
      status: 'refused',
      mintStatus: status,
    })
  assert.deepEqual(
    read({ ...fixture.info, attestation: { status: 'attested', winning_outcome: 'YES' } }, id)
      .state,
    { status: 'unverified', reportedOutcome: 'YES', reason: 'missing' },
  )
  // A signature for another outcome does not authenticate the reported outcome.
  const foreign = {
    oracle_pubkey: fixture.oraclePublicKey,
    oracle_sig: signFixtureOutcome('NO'),
    outcome: 'YES',
  }
  assert.deepEqual(
    read(
      {
        ...fixture.info,
        attestation: { status: 'attested', winning_outcome: 'YES', oracle_sigs: [foreign] },
      },
      id,
    ).state,
    { status: 'unverified', reportedOutcome: 'YES', reason: 'invalid' },
  )
  for (const attestation of [
    { status: 'resolved' },
    { status: 'attested', winning_outcome: 'MAYBE' },
    'attested',
  ])
    assert.throws(() => read({ ...fixture.info, attestation }, id))
  // The registration must belong to the requested condition.
  assert.throws(() => read(fixture.info, 'ab'.repeat(32)))
})

test('the relay filter names the registered oracle keys and a bounded event count', () => {
  const fixture = condition()
  const pending = read(fixture.info, fixture.registration.condition_id)
  assert.deepEqual(oracleAttestationRelayFilter(pending.registeredAuthority), {
    kinds: [89],
    authors: [fixture.oraclePublicKey],
    limit: 16,
  })
  // A later page asks for older events.
  assert.deepEqual(oracleAttestationRelayFilter(pending.registeredAuthority, 1_900_000_050), {
    kinds: [89],
    authors: [fixture.oraclePublicKey],
    limit: 16,
    until: 1_900_000_050,
  })
})

test('a relay attestation needs a valid oracle signature on the announced nonce', () => {
  const fixture = condition()
  const { registeredAuthority } = read(fixture.info, fixture.registration.condition_id)
  const select = (events: unknown[], reportedOutcome?: string) =>
    selectRelayConditionAttestation({ registeredAuthority, events, reportedOutcome })
  const valid = signedCtfAttestationEventFixture({
    eventId: 'mint-first-resolution',
    outcome: 'YES',
    signature: fixture.signature,
  })
  const otherKey = fixtureOracleKey(9)
  const refused = [
    // Another key signs the same outcome.
    signedCtfAttestationEventFixture({
      eventId: 'mint-first-resolution',
      outcome: 'YES',
      signature: signFixtureOutcome('YES', otherKey),
      attestationKey: otherKey,
    }),
    // The event names NO but carries the signature of YES.
    signedCtfAttestationEventFixture({
      eventId: 'mint-first-resolution',
      outcome: 'NO',
      signature: fixture.signature,
    }),
    // A valid oracle signature on another nonce is not the announced attestation.
    signedCtfAttestationEventFixture({
      eventId: 'mint-first-resolution',
      outcome: 'NO',
      signature: signFixtureOutcome('NO'),
    }),
    // The attestation of another event.
    signedCtfAttestationEventFixture({
      eventId: 'other-event',
      outcome: 'YES',
      signature: fixture.signature,
    }),
    // A changed Nostr envelope fails its event signature.
    { ...valid, created_at: valid.created_at + 1 },
    'not an event',
  ]
  assert.equal(select(refused), null)
  assert.deepEqual(select([...refused, valid]), {
    attestedOutcome: 'YES',
    oracleWitness: {
      oracle_sigs: [
        { oracle_pubkey: fixture.oraclePublicKey, oracle_sig: fixture.signature, outcome: 'YES' },
      ],
    },
  })
  // The mint has recorded another outcome. Relay evidence cannot replace it.
  assert.throws(() => select([valid], 'NO'), /conflict/)
})

test('the resolution reads the mint first and reads the relays only when allowed', async () => {
  const fixture = condition()
  const id = fixture.registration.condition_id
  const event = signedCtfAttestationEventFixture({
    eventId: 'mint-first-resolution',
    outcome: 'YES',
    signature: fixture.signature,
  })
  const relayReads: unknown[] = []
  const resolve = (info: unknown, allowed: boolean, events: unknown[] = [event]) =>
    resolveConditionResult({
      conditionId: id,
      mintUrl: MINT,
      allowInsecureLoopbackHttp: false,
      readMintCondition: async () => info,
      relays: {
        when: (maturityEpoch) => {
          assert.equal(maturityEpoch, MATURITY)
          return allowed
        },
        urls: async () => [RELAY],
        query: async (url, filter) => {
          assert.equal(url, RELAY)
          relayReads.push(filter)
          return events
        },
      },
    })
  const oracleSig = {
    oracle_pubkey: fixture.oraclePublicKey,
    oracle_sig: fixture.signature,
    outcome: 'YES',
  }
  const minted = await resolve(
    {
      ...fixture.info,
      attestation: { status: 'attested', winning_outcome: 'YES', oracle_sigs: [oracleSig] },
    },
    true,
  )
  assert.equal(minted.state.status, 'resolved')
  assert.equal(relayReads.length, 0)
  // Before the announced maturity the caller can skip the relays.
  assert.equal((await resolve(fixture.info, false)).state.status, 'pending')
  assert.equal(relayReads.length, 0)
  assert.deepEqual((await resolve(fixture.info, true)).state, {
    status: 'resolved',
    source: 'relay',
    attestedOutcome: 'YES',
    oracleWitness: { oracle_sigs: [oracleSig] },
  })
  assert.equal(relayReads.length, 1)
  // A relay failure or an unreadable relay list leaves the mint state.
  for (const relays of [
    {
      urls: async () => [RELAY],
      query: async () => {
        throw new Error('relay unavailable')
      },
    },
    {
      urls: async () => {
        throw new Error('relay list unavailable')
      },
      query: async () => [event],
    },
  ]) {
    const failing = await resolveConditionResult({
      conditionId: id,
      mintUrl: MINT,
      allowInsecureLoopbackHttp: false,
      readMintCondition: async () => fixture.info,
      relays: { when: () => true, ...relays },
    })
    assert.equal(failing.state.status, 'pending')
  }
  // A mint result without evidence takes the matching relay evidence.
  const reported = await resolve(
    { ...fixture.info, attestation: { status: 'attested', winning_outcome: 'YES' } },
    false,
  )
  assert.equal(reported.state.status, 'resolved')
  // A mint read failure is not hidden.
  await assert.rejects(
    resolveConditionResult({
      conditionId: id,
      mintUrl: MINT,
      allowInsecureLoopbackHttp: false,
      readMintCondition: async () => {
        throw new Error('mint unavailable')
      },
    }),
    /mint unavailable/,
  )
})

function relayResolution(
  info: unknown,
  conditionId: string,
  relays: Omit<OracleAttestationRelays, 'when'>,
): Promise<ConditionResolution> {
  return resolveConditionResult({
    conditionId,
    mintUrl: MINT,
    allowInsecureLoopbackHttp: false,
    readMintCondition: async () => info,
    relays: { when: () => true, ...relays },
  })
}

test('the relay read pages back from the newest event, at most 8 pages of 16 events', async () => {
  const fixture = condition()
  const id = fixture.registration.condition_id
  const attestation = signedCtfAttestationEventFixture({
    eventId: 'mint-first-resolution',
    outcome: 'YES',
    signature: fixture.signature,
  })
  const read = async (newer: number) => {
    const events = [attestation, ...otherCtfAttestationEventsFixture(newer, attestation.created_at)]
    const filters: OracleAttestationRelayFilter[] = []
    const resolution = await relayResolution(fixture.info, id, {
      urls: async () => [RELAY],
      query: async (_url, filter) => {
        filters.push(filter)
        return nip01RelayAnswerFixture(events, filter)
      },
    })
    return { state: resolution.state.status, filters }
  }
  // The newest page holds the attestation. The read stops there.
  assert.equal((await read(15)).filters.length, 1)
  // 120 newer events: each page ends at the oldest event of the page before it.
  const paged = await read(120)
  assert.equal(paged.state, 'resolved')
  assert.equal(paged.filters.length, 8)
  assert.equal(paged.filters[0]!.until, undefined)
  assert.deepEqual(
    paged.filters.slice(1).map((filter) => attestation.created_at + 1 + 120 - filter.until!),
    [16, 31, 46, 61, 76, 91, 106],
  )
  // Each later page repeats the oldest event of the page before it. Thus 8 pages reach the
  // 121 newest events. Beyond them the attestation stays hidden, and the condition fails closed.
  const hidden = await read(121)
  assert.equal(hidden.state, 'pending')
  assert.equal(hidden.filters.length, 8)
  // A relay that ignores `until` and `limit` repeats its page. The first repeated page moves
  // `until` one second back. The second repeated page brings no new event and ends the read.
  let repeats = 0
  const flood = otherCtfAttestationEventsFixture(20, attestation.created_at)
  const repeated = await relayResolution(fixture.info, id, {
    urls: async () => [RELAY],
    query: async () => {
      repeats += 1
      return flood
    },
  })
  assert.equal(repeated.state.status, 'pending')
  assert.equal(repeats, 3)
})

test('a full page of events in the second of its until moves the read one second back', async () => {
  const fixture = condition()
  const id = fixture.registration.condition_id
  const attestation = signedCtfAttestationEventFixture({
    eventId: 'mint-first-resolution',
    outcome: 'YES',
    signature: fixture.signature,
  })
  // More events than one page share one second. An inclusive `until` repeats them.
  const sameSecond = Array.from({ length: 20 }, (_, index) =>
    signedCtfAttestationEventFixture({
      eventId: `same-second-${index}`,
      outcome: 'YES',
      signature: signFixtureOutcome('YES'),
      createdAt: attestation.created_at + 1,
    }),
  )
  const filters: OracleAttestationRelayFilter[] = []
  const resolution = await relayResolution(fixture.info, id, {
    urls: async () => [RELAY],
    query: async (_url, filter) => {
      filters.push(filter)
      return nip01RelayAnswerFixture([attestation, ...sameSecond], filter)
    },
  })
  assert.equal(resolution.state.status, 'resolved')
  // The second page brings no new event, so the third page asks for the second before.
  assert.deepEqual(
    filters.map((filter) => filter.until),
    [undefined, attestation.created_at + 1, attestation.created_at],
  )
})

test('a relay that stalls ends its read at its deadline, and another relay still resolves', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const fixture = condition()
  const id = fixture.registration.condition_id
  const attestation = signedCtfAttestationEventFixture({
    eventId: 'mint-first-resolution',
    outcome: 'YES',
    signature: fixture.signature,
  })
  const flood = otherCtfAttestationEventsFixture(20, attestation.created_at)
  let stallPages = 0
  let stalled!: () => void
  const stall = new Promise<void>((resolve) => (stalled = resolve))
  const resolution = relayResolution(fixture.info, id, {
    urls: async () => ['wss://stall.example', RELAY],
    query: async (url, filter) => {
      if (url === RELAY) return nip01RelayAnswerFixture([attestation], filter)
      stallPages += 1
      if (stallPages === 1) return nip01RelayAnswerFixture(flood, filter)
      // The second page never answers and ignores its signal.
      stalled()
      return new Promise<never>(() => {})
    },
  })
  await stall
  t.mock.timers.tick(ORACLE_ATTESTATION_RELAY_READ_TIMEOUT_MS)
  assert.equal((await resolution).state.status, 'resolved')
  assert.equal(stallPages, 2)
})
