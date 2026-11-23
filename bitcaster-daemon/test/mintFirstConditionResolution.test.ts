import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  attestableCtfConditionFixture,
  fixtureOracleKey,
  nip01RelayAnswerFixture,
  otherCtfAttestationEventsFixture,
  signFixtureOutcome,
  signedCtfAttestationEventFixture,
} from '../../bitcaster-client-sdk/test/support/ctfAnnouncementFixture.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { readProfile } from '../src/profile.ts'
import { addAvailableProofs, readState } from '../src/state.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { retireResolvedDaemonConditions } from '../src/managedConditionRetirement.ts'
import { createDaemonConditionResolution } from '../src/nativeConditionResolution.ts'
import type { OracleAttestationRelayFilter } from '@bitcaster-market/client-sdk/conditionResolution'
import { dispatch } from '../src/server.ts'
import { CTF_KEYSET_ID, FakeRetirementWallet, proof } from './support/retirementWallet.ts'

const MINT = 'https://mint.example'
const SEED = '11'.repeat(64)
const MATURITY_EPOCH = 1_900_000_000
const BEFORE_MATURITY_MS = MATURITY_EPOCH * 1000 - 1
const AFTER_MATURITY_MS = MATURITY_EPOCH * 1000 + 1
const EVENT_ID = 'mint-first-retirement'

type RelayAnswer = (filter: OracleAttestationRelayFilter) => readonly unknown[]

async function createFixture(
  mint: 'attested' | 'pending',
  /** The relays in order of preference. By default one NIP-01 relay serves `relayEvents`. */
  relays?: Record<string, RelayAnswer>,
) {
  const previous = process.env.BITCASTER_DAEMON_HOME
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-mint-first-'))
  const directory = join(root, 'profile')
  process.env.BITCASTER_DAEMON_HOME = directory
  const bootstrap = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT,
    walletSeedHex: SEED,
    nostrSecretKeyHex: '22'.repeat(32),
    rpcToken: 'R'.repeat(43),
    initializedAtMs: 1_700_000_000_000,
  })
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: bootstrap.walletScopeId,
    incarnationId: 'mint-first-retirement-test',
    observedAtMs: 1_700_000_000_100,
  })
  const oracle = attestableCtfConditionFixture({
    outcomes: ['YES', 'NO'],
    eventId: EVENT_ID,
    winner: 'YES',
    maturityEpoch: MATURITY_EPOCH,
  })
  const conditionId = oracle.registration.condition_id
  await addAvailableProofs(MINT, [proof(CTF_KEYSET_ID, 'held-winning-proof', 4)], {
    kind: 'Outcome',
    conditionId,
    outcomeSetId: 'YES',
    baseAsset: 'sat',
    unit: 'msat',
  })
  const oracleSig = {
    oracle_pubkey: oracle.oraclePublicKey,
    oracle_sig: oracle.signature,
    outcome: 'YES',
  }
  const wallet = new FakeRetirementWallet()
  wallet.conditionInfo = {
    ...oracle.registration,
    registered_at: 1_800_000_000,
    keysets: {},
    ...(mint === 'attested'
      ? {
          attestation: {
            status: 'attested',
            winning_outcome: 'YES',
            attested_at: 1_900_000_010,
            oracle_sigs: [oracleSig],
          },
        }
      : {}),
  }
  const relayEvents: unknown[] = []
  const relayReads: string[] = []
  const answers = relays ?? {
    'wss://relay.example': (filter: OracleAttestationRelayFilter) =>
      nip01RelayAnswerFixture(relayEvents, filter),
  }
  const walletDependencies = {
    createCashuWallet: () => wallet,
    resolveInputFeePpkByKeyset: async () => ({ [CTF_KEYSET_ID]: 0 }),
  }
  const profile = (await readProfile())!
  const resolution = createDaemonConditionResolution({
    profile,
    secrets: { walletSeedHex: SEED },
    walletDependencies,
    relayUrls: async () => Object.keys(answers),
    queryRelay: async (url, filter) => {
      relayReads.push(url)
      return answers[url]!(filter)
    },
  })
  return {
    directory,
    conditionId,
    oracle,
    oracleSig,
    wallet,
    relayEvents,
    relayReads,
    walletDependencies,
    discover: (nowMs: number) =>
      retireResolvedDaemonConditions({
        profile,
        secrets: { walletSeedHex: SEED },
        fence,
        resolution,
        walletDependencies,
        nowMs,
      }),
    fence,
    dispose: async () => {
      if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previous
      await rm(root, { recursive: true, force: true })
    },
  }
}

function validRelayAttestation(signature: string) {
  return signedCtfAttestationEventFixture({ eventId: EVENT_ID, outcome: 'YES', signature })
}

async function inventoryRows(directory: string): Promise<number> {
  const database = await openDaemonStateSqlite(directory)
  try {
    return (
      database
        .prepare('SELECT count(*) AS count FROM daemon_managed_condition_inventory')
        .get() as { count: number }
    ).count
  } finally {
    database.close()
  }
}

test('automatic retirement resolves from the mint record while the engine is unreachable', async (t) => {
  // Each network request fails. The retirement must not need the engine.
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('the engine is unreachable')
  })
  const fixture = await createFixture('attested')
  try {
    assert.deepEqual(await fixture.discover(BEFORE_MATURITY_MS), {
      results: [{ conditionId: fixture.conditionId, error: null }],
      awaitingAttestation: [],
      discoveryFailures: [],
      nextMaturityMs: null,
    })
    assert.equal(fixture.wallet.redeemCalls, 1)
    assert.equal(fixture.relayReads.length, 0, 'a mint record needs no relay read')
    assert.equal(network.mock.callCount(), 0)
    const state = (await readState())!
    assert.equal(
      state.wallet.proofs.some(({ asset }) => asset.kind === 'Outcome'),
      false,
    )
  } finally {
    await fixture.dispose()
  }
})

test('without a mint record, a verified relay attestation retires the condition with its witness', async (t) => {
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('the engine is unreachable')
  })
  const fixture = await createFixture('pending')
  try {
    fixture.relayEvents.push(validRelayAttestation(fixture.oracle.signature))
    assert.deepEqual(await fixture.discover(AFTER_MATURITY_MS), {
      results: [{ conditionId: fixture.conditionId, error: null }],
      awaitingAttestation: [],
      discoveryFailures: [],
      nextMaturityMs: null,
    })
    assert.equal(fixture.wallet.redeemCalls, 1)
    // The mint has no recorded result, so each input carries the oracle witness.
    // The mint records the first valid witness that it accepts.
    assert.deepEqual(fixture.wallet.witnesses, [
      JSON.stringify({ oracle_sigs: [fixture.oracleSig] }),
    ])
    assert.equal(network.mock.callCount(), 0)
  } finally {
    await fixture.dispose()
  }
})

test('a forged or wrong-outcome relay attestation is refused and nothing is redeemed', async () => {
  const fixture = await createFixture('pending')
  try {
    const otherKey = fixtureOracleKey(9)
    fixture.relayEvents.push(
      // A different key signs the winning outcome.
      signedCtfAttestationEventFixture({
        eventId: EVENT_ID,
        outcome: 'YES',
        signature: signFixtureOutcome('YES', otherKey),
        attestationKey: otherKey,
      }),
      // The oracle key, but the signature belongs to another outcome.
      signedCtfAttestationEventFixture({
        eventId: EVENT_ID,
        outcome: 'NO',
        signature: fixture.oracle.signature,
      }),
      // A valid oracle signature of NO that does not use the announced nonce.
      signedCtfAttestationEventFixture({
        eventId: EVENT_ID,
        outcome: 'NO',
        signature: signFixtureOutcome('NO'),
      }),
    )
    assert.deepEqual(await fixture.discover(AFTER_MATURITY_MS), {
      results: [],
      awaitingAttestation: [fixture.conditionId],
      discoveryFailures: [],
      nextMaturityMs: null,
    })
    assert.equal(fixture.relayReads.length, 1)
    assert.equal(fixture.wallet.redeemCalls, 0)
    assert.equal(await inventoryRows(fixture.directory), 0)
  } finally {
    await fixture.dispose()
  }
})

test('after the announced maturity the scan keeps reading until the attestation appears, then claims once', async () => {
  const fixture = await createFixture('pending')
  try {
    // Before the maturity the oracle is not due. The scan reads only the mint and
    // reports the maturity, so the daemon can wake at that time.
    assert.deepEqual(await fixture.discover(BEFORE_MATURITY_MS), {
      results: [],
      awaitingAttestation: [],
      discoveryFailures: [],
      nextMaturityMs: MATURITY_EPOCH * 1000,
    })
    assert.equal(fixture.relayReads.length, 0)
    // After the maturity, a missing attestation keeps the condition for a retry.
    assert.deepEqual(await fixture.discover(AFTER_MATURITY_MS), {
      results: [],
      awaitingAttestation: [fixture.conditionId],
      discoveryFailures: [],
      nextMaturityMs: null,
    })
    assert.equal(fixture.relayReads.length, 1)
    assert.equal(fixture.wallet.redeemCalls, 0)
    fixture.relayEvents.push(validRelayAttestation(fixture.oracle.signature))
    assert.deepEqual((await fixture.discover(AFTER_MATURITY_MS)).results, [
      { conditionId: fixture.conditionId, error: null },
    ])
    assert.equal(fixture.wallet.redeemCalls, 1)
    // Nothing is held any more, so a later scan claims nothing again.
    assert.deepEqual(await fixture.discover(AFTER_MATURITY_MS), {
      results: [],
      awaitingAttestation: [],
      discoveryFailures: [],
      nextMaturityMs: null,
    })
    assert.equal(fixture.wallet.redeemCalls, 1)
  } finally {
    await fixture.dispose()
  }
})

test('the scan pages back past newer attestations of the same oracle key', async () => {
  const fixture = await createFixture('pending')
  try {
    // The creator key attests each of its markets. 40 newer attestations hide this one
    // from the first page.
    const attestation = validRelayAttestation(fixture.oracle.signature)
    fixture.relayEvents.push(
      attestation,
      ...otherCtfAttestationEventsFixture(40, attestation.created_at),
    )
    assert.deepEqual((await fixture.discover(AFTER_MATURITY_MS)).results, [
      { conditionId: fixture.conditionId, error: null },
    ])
    assert.deepEqual(fixture.wallet.witnesses, [
      JSON.stringify({ oracle_sigs: [fixture.oracleSig] }),
    ])
    // Pages of 16 from the newest event: 40 to 25, 25 to 10, then 10 to the attestation.
    assert.equal(fixture.relayReads.length, 3)
  } finally {
    await fixture.dispose()
  }
})

test('a relay that ignores the limit does not crowd out the attestation on another relay', async () => {
  // The fixture oracle signs YES with the announced nonce.
  const attestation = validRelayAttestation(signFixtureOutcome('YES'))
  const flood = otherCtfAttestationEventsFixture(200, attestation.created_at)
  const fixture = await createFixture('pending', {
    'wss://flood.example': () => flood,
    'wss://relay.example': (filter) => nip01RelayAnswerFixture([attestation], filter),
  })
  try {
    assert.deepEqual((await fixture.discover(AFTER_MATURITY_MS)).results, [
      { conditionId: fixture.conditionId, error: null },
    ])
    assert.equal(fixture.wallet.redeemCalls, 1)
  } finally {
    await fixture.dispose()
  }
})

test('an explicit condition retirement does not need the engine', async () => {
  const fixture = await createFixture('attested')
  try {
    const deps = {
      ...fixture.walletDependencies,
      getCustodyFence: () => fixture.fence,
      createEngineClient: () => {
        throw new Error('the engine is unreachable')
      },
    }
    const preview = await dispatch(
      {
        method: 'wallet.retireCondition',
        params: { conditionId: fixture.conditionId, acknowledge: false },
      },
      deps,
    )
    assert.equal(preview.ok, true)
    assert.equal((preview.result as { state: string }).state, 'preview')
    const retired = await dispatch(
      {
        method: 'wallet.retireCondition',
        params: { conditionId: fixture.conditionId, acknowledge: true },
      },
      deps,
    )
    assert.equal(retired.ok, true)
    assert.equal((retired.result as { state: string }).state, 'retired')
    assert.equal(fixture.wallet.redeemCalls, 1)
  } finally {
    await fixture.dispose()
  }
})

test('an explicit condition retirement without a verified result refuses with a code and saves nothing', async () => {
  const fixture = await createFixture('pending')
  try {
    const deps = { ...fixture.walletDependencies, getCustodyFence: () => fixture.fence }
    const retire = (acknowledge: boolean) =>
      dispatch(
        {
          method: 'wallet.retireCondition',
          params: { conditionId: fixture.conditionId, acknowledge },
        },
        deps,
      )
    // The mint has no result, and the relays hold no attestation.
    for (const acknowledge of [false, true])
      assert.deepEqual(await retire(acknowledge), {
        ok: false,
        code: 'condition-retirement-result-unavailable',
        error: 'the condition has no verified result yet; try again later',
      })
    // An unreadable mint record refuses in the same way.
    fixture.wallet.conditionInfo = undefined
    assert.deepEqual(await retire(true), {
      ok: false,
      code: 'condition-retirement-result-unavailable',
      error: 'the condition result could not be read from the mint; try again later',
    })
    assert.equal(fixture.wallet.redeemCalls, 0)
    assert.equal(await inventoryRows(fixture.directory), 0)
    assert.equal(
      (await readState())?.wallet.proofs.filter((record) => record.state === 'available').length,
      1,
    )
  } finally {
    await fixture.dispose()
  }
})
