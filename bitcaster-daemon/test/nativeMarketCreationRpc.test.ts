import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { createNativeOracleCreationStore } from '../src/nativeOracleCreationStore.ts'
import { dispatch } from '../src/server.ts'

test('creation status is read-only and excludes private creation inputs and artifacts', async () => {
  await withProfile(async (directory) => {
    const command = { method: 'market.creation-status', params: { creationId: 'one' } } as const
    const deps = {
      createCashuWallet: () => {
        throw new Error('status must not open a wallet')
      },
    }
    assert.deepEqual(await dispatch(command, deps), { ok: true, result: null })
    const store = createNativeOracleCreationStore(directory)
    await store.reserveCreation({
      creationId: 'one',
      eventId: 'event',
      canonicalInput: '{"privateDraft":"not-returned"}',
    })
    assert.deepEqual(await dispatch(command, deps), {
      ok: true,
      result: {
        creationId: 'one',
        eventId: 'event',
        conditionId: null,
        announcementPrepared: false,
        chosenOutcome: null,
        attestationPrepared: false,
        relayPublished: false,
        engineSynchronized: false,
        explanationPrepared: false,
        explanationDraftSaved: false,
        explanationRelayPublished: false,
        mintRegistered: false,
        engineRegistered: false,
      },
    })
    assert.equal((await store.readCreation('one'))?.nonceIndex, 0)
  })
})

test('creation RPC never exposes downstream error bodies', async () => {
  await withProfile(async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => {
      throw new Error('private-fee-proof-marker')
    }
    try {
      const response = await dispatch(
        { method: 'market.creation-quote', params: { outcomes: ['Yes', 'No'] } },
        {
          getCustodyFence() {
            throw new Error('quote failure must not reserve custody')
          },
          createCashuWallet: () => {
            throw new Error('metadata failure must not open a wallet')
          },
        },
      )
      assert.equal(response.ok, false)
      assert.equal('code' in response && response.code, 'market-creation-incomplete')
      assert.equal(JSON.stringify(response).includes('private-fee-proof-marker'), false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

test('zero-fee creation quote needs no wallet preparation', async () => {
  await withProfile(async () => {
    globalThis.fetch = async (request) => {
      const url = String(request)
      return Response.json(
        url.endsWith('/v1/info')
          ? {
              name: 'Test mint',
              pubkey: 'ab'.repeat(32),
              version: 'test',
              nuts: {
                '4': { methods: [], disabled: false },
                '5': { methods: [], disabled: false },
                CTF: {
                  default_keyset_creation: 'one-vs-rest',
                  registration_fees: [
                    { unit: 'msat', registration_fee_base: 0, registration_fee_per_keyset: 0 },
                  ],
                },
              },
            }
          : { keysets: [] },
      )
    }
    const response = await dispatch(
      { method: 'market.creation-quote', params: { outcomes: ['Yes', 'No'] } },
      {
        getCustodyFence() {
          throw new Error('zero fee must not reserve custody')
        },
        createCashuWallet() {
          throw new Error('zero fee must not open a wallet')
        },
      },
    )
    assert.deepEqual(response, {
      ok: true,
      result: { requiredFeeMsat: 0, sendPreparationFeeMsat: 0, totalWalletDebitMsat: 0 },
    })
  })
})

test('exact create retry uses the saved fee policy without reading changed mint metadata', async () => {
  await withProfile(async (directory) => {
    const market = {
      title: 'Saved creation',
      description: 'Same request',
      outcomeType: 'yesno',
      outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
      maturityEpoch: 2_000_000_000,
      categoryTags: [],
      baseAsset: 'sat',
    } as const
    await createNativeOracleCreationStore(directory).reserveCreation({
      creationId: 'saved',
      eventId: 'saved-event',
      canonicalInput: JSON.stringify({
        market,
        registration: { requiredFeeMsat: 7 },
        destination: {
          engineBaseUrl: 'https://engine.example',
          mintUrl: 'https://mint.example',
          relayUrls: ['wss://relay.example/'],
        },
      }),
    })
    let metadataReads = 0
    let paymentWalletOpened = false
    globalThis.fetch = async () => {
      metadataReads += 1
      throw new Error('mint policy endpoint is unavailable after the first attempt')
    }
    const response = await dispatch(
      {
        method: 'market.create-native',
        params: {
          creationId: 'saved',
          eventId: 'saved-event',
          market,
          relayUrls: ['wss://relay.example/'],
        },
      },
      {
        getCustodyFence() {
          throw new Error('fixture stops before custody access')
        },
        createCashuWallet() {
          paymentWalletOpened = true
          throw new Error('fixture stops at the saved nonzero-fee wallet boundary')
        },
      },
    )
    assert.equal(response.ok, false)
    assert.equal(metadataReads, 0, 'exact replay reread mint policy')
    assert.equal(paymentWalletOpened, true, 'saved nonzero fee was not selected')
  })
})

async function withProfile(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-creation-rpc-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  const originalFetch = globalThis.fetch
  process.env.BITCASTER_DAEMON_HOME = directory
  globalThis.fetch = async () => {
    throw new Error('unexpected network I/O')
  }
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    await run(directory)
  } finally {
    globalThis.fetch = originalFetch
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}
