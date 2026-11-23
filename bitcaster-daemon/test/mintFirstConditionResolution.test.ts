import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  attestableCtfConditionFixture,
  fixtureOracleKey,
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
import { dispatch } from '../src/server.ts'
import { CTF_KEYSET_ID, FakeRetirementWallet, proof } from './support/retirementWallet.ts'

const MINT = 'https://mint.example'
const SEED = '11'.repeat(64)
const MATURITY_EPOCH = 1_900_000_000
const BEFORE_MATURITY_MS = MATURITY_EPOCH * 1000 - 1
const AFTER_MATURITY_MS = MATURITY_EPOCH * 1000 + 1
const EVENT_ID = 'mint-first-retirement'

async function createFixture(mint: 'attested' | 'pending') {
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
  const walletDependencies = {
    createCashuWallet: () => wallet,
    resolveInputFeePpkByKeyset: async () => ({ [CTF_KEYSET_ID]: 0 }),
  }
  const profile = (await readProfile())!
  const resolution = createDaemonConditionResolution({
    profile,
    secrets: { walletSeedHex: SEED },
    walletDependencies,
    relayUrls: async () => ['wss://relay.example'],
    queryRelay: async (url) => {
      relayReads.push(url)
      return [...relayEvents]
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
