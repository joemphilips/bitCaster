import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { finalizeEvent, verifyEvent } from 'nostr-tools/pure'
import { deriveDlcConditionId } from '@bitcaster-market/client-sdk'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { replaceDaemonSigner, disconnectDaemonSigner } from '../src/secrets.ts'
import { deriveNostrPublicKey } from '../src/profileSecretProtection.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import type { NativeOracleHelper } from '../src/nativeOracleHelper.ts'

test('actual creation RPC resumes with original authenticated account after replacement and gives new creations the selected account', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-signer-rpc-')),
    directory = join(root, 'profile')
  const priorHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const keys = ['22'.repeat(32), '44'.repeat(32)],
    pubkeys = keys.map(deriveNostrPublicKey)
  const calls: string[] = [],
    signed: string[] = [],
    publications: string[] = []
  let conditionId = '',
    failPublication = true
  const market = {
    title: 'Choice',
    description: 'Choose',
    outcomeType: 'yesno' as const,
    outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
    maturityEpoch: 2_000_000_000,
    categoryTags: [],
    baseAsset: 'sat' as const,
  }
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: keys[0],
      nativeOracleNonceSeedHex: '33'.repeat(32),
    })
    const fence = await claimCustodyScopeLease(directory, {
      scopeId: profile.walletScopeId,
      incarnationId: 'signer-rpc-fixture',
      observedAtMs: Date.now(),
    })
    const helper: NativeOracleHelper = {
      assertAvailable() {},
      async verifyEnum() {
        throw new Error('creation must not verify an attestation')
      },
      async createEnum(request) {
        const publicKey = deriveNostrPublicKey(request.oracleSecretKeyHex)
        signed.push(publicKey)
        conditionId = deriveDlcConditionId({
          eventId: request.eventId,
          outcomeCount: 2,
          oraclePublicKeys: [publicKey],
        })
        const announcement = finalizeEvent(
          {
            kind: 88,
            created_at: 1_900_000_000,
            tags: [],
            content: Buffer.from('aabb', 'hex').toString('base64'),
          },
          Uint8Array.from(Buffer.from(request.oracleSecretKeyHex, 'hex')),
        )
        return {
          eventId: request.eventId,
          oraclePublicKeyHex: publicKey,
          announcementTlvHex: 'aabb',
          announcementNostrEventId: announcement.id,
          announcementNostrEventJson: JSON.stringify(announcement),
        }
      },
      async signEnum() {
        throw new Error('creation must not attest')
      },
    }
    mock.module(new URL('../src/nativeOracleHelper.ts', import.meta.url).href, {
      namedExports: { createNativeOracleHelperAdapter: () => helper },
    })
    mock.module(new URL('../src/nativeOraclePublication.ts', import.meta.url).href, {
      namedExports: {
        normalizeOracleRelayUrls: (urls: readonly string[]) => [...urls],
        publishNativeOracleEvent: async () => {
          if (failPublication) {
            failPublication = false
            throw new Error('response lost')
          }
          publications.push(conditionId)
        },
      },
    })
    mock.method(globalThis, 'fetch', async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request)
      if (url.startsWith('https://mint.example')) {
        assert.equal(new Headers(init?.headers).has('authorization'), false)
        if (url.endsWith('/v1/info'))
          return Response.json({
            name: 'Fixture',
            pubkey: 'ab'.repeat(32),
            version: 'fixture',
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
          })
        if (url.endsWith('/v1/conditions')) return Response.json({ condition_id: conditionId })
        if (url.includes('/v1/conditions/')) return Response.json({ code: 13021 }, { status: 400 })
        return Response.json({ keysets: [] })
      }
      const authorization = new Headers(init?.headers).get('authorization')
      assert.ok(
        authorization !== null && authorization.startsWith('Nostr '),
        'creation RPC lost authenticated account',
      )
      const event = JSON.parse(Buffer.from(authorization.slice(6), 'base64').toString('utf8'))
      assert.ok(verifyEvent(event), 'creation RPC generated invalid account authentication')
      calls.push(event.pubkey)
      if (url.endsWith('/registration')) return new Response(null, { status: 404 })
      return Response.json({
        conditionId,
        marketsCreated: [`${conditionId}-Yes`, `${conditionId}-No`],
        baseAsset: 'sat',
        divisibility: 1000,
      })
    })
    const { dispatchNativeMarketCreation } = await import('../src/nativeMarketCreationRpc.ts')
    const deps = {
      getCustodyFence: () => fence,
      createCashuWallet: () => {
        throw new Error('fee-free creation opened wallet')
      },
    }
    const create = (id: string) =>
      dispatchNativeMarketCreation(
        {
          method: 'market.create-native',
          params: { creationId: id, eventId: `${id}-event`, market, relayUrls: [] },
        },
        deps,
      )
    const interrupted = await create('old')
    assert.equal(interrupted.ok, false)
    assert.equal(calls.length, 0)
    await replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: keys[1] })
    // This exact recovery may use retained original authority even while general auth is disconnected.
    await disconnectDaemonSigner(1)
    const resumed = await dispatchNativeMarketCreation(
      { method: 'market.creation-resume', params: { creationId: 'old' } },
      deps,
    )
    assert.equal(
      resumed.ok,
      true,
      JSON.stringify({
        result: resumed,
        authenticatedCallCount: calls.length,
        signerCallCount: signed.length,
        publicationCount: publications.length,
      }),
    )
    assert.deepEqual(calls, [pubkeys[0], pubkeys[0]])
    const { reconnectDaemonSigner } = await import('../src/secrets.ts')
    await reconnectDaemonSigner(2)
    assert.equal((await create('new')).ok, true)
    assert.deepEqual(calls, [pubkeys[0], pubkeys[0], pubkeys[1], pubkeys[1]])
    assert.deepEqual(signed, pubkeys)
    assert.equal(publications.length, 2)
  } finally {
    mock.restoreAll()
    if (priorHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = priorHome
    await rm(root, { recursive: true, force: true })
  }
})
