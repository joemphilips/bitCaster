import assert from 'node:assert/strict'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import {
  assertMarketCreationPreparationEqual,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  snapshotMarketCreationPreparation,
  type MarketCreationPreparation,
  type MarketCreationRecord,
  type MarketCreationStore,
} from '../src/index.ts'
import {
  assertCreatedResultMatches,
  completeDurableMarketCreation,
  readMarketCreationMintRegistration,
  type MarketCreationCoordinatorAdapters,
} from '../src/marketCreationCoordinator.ts'
import {
  CreateMarketError,
  MarketCreationThumbnailMismatchError,
  parseCreateMarketResponse,
} from '../src/marketLifecycle.ts'

test('paid engine rejection and reload retain one fee operation and announcement identity', async () => {
  const fixture = createFixture()
  fixture.failEngine = true
  await assert.rejects(fixture.complete(), /engine rejected/)
  const retained = await fixture.store.read(fixture.preparation.creationId)
  assert.equal(retained?.mintConfirmed, true)
  assert.equal(retained?.engineResult, null)
  const result = await fixture.complete()
  assert.equal(result.status, 'created')
  assert.deepEqual(fixture.effects, ['fee', 'publish', 'mint', 'engine', 'engine'])
  assert.deepEqual(fixture.feeReferences, ['existing-fee-operation'])
  assert.deepEqual(fixture.announcements, [
    fixture.preparation.announcement.announcementNostrEventJson,
  ])
})

test('lost mint response and unavailable lookup resume the same paid operation', async () => {
  const fixture = createFixture()
  fixture.loseMintResponse = true
  await assert.rejects(fixture.complete(), /lookup unavailable/)
  assert.equal((await fixture.store.read(fixture.preparation.creationId))?.mintConfirmed, false)
  const result = await fixture.complete()
  assert.equal(result.status, 'created')
  assert.deepEqual(fixture.effects, ['fee', 'publish', 'mint', 'engine'])
  assert.deepEqual(fixture.feeReferences, ['existing-fee-operation'])
  assert.equal(fixture.announcements.length, 1)
})

test('lost engine response reconciles before a repeated engine delivery', async () => {
  const fixture = createFixture()
  fixture.loseEngineResponse = true
  await assert.rejects(fixture.complete(), /lookup unavailable/)
  assert.equal((await fixture.store.read(fixture.preparation.creationId))?.engineResult, null)
  await fixture.complete()
  await fixture.complete()
  assert.deepEqual(fixture.effects, ['fee', 'publish', 'mint', 'engine'])
  assert.deepEqual(fixture.feeReferences, ['existing-fee-operation'])
})

test('wallet, creator, and destination mismatches stop before all effects', async () => {
  for (const field of [
    'creatorId',
    'walletId',
    'walletScopeId',
    'mintUrl',
    'engineBaseUrl',
  ] as const) {
    const fixture = createFixture()
    await assert.rejects(
      completeDurableMarketCreation(fixture.adapters, fixture.preparation, {
        ...fixture.preparation,
        [field]: 'different',
      }),
      /original creator/,
    )
    assert.equal(fixture.effects.length, 0)
    assert.equal(await fixture.store.read(fixture.preparation.creationId), null)
  }
})

test('changed paid metadata, thumbnail, or fee facts refuse before repeating effects', async () => {
  const fixture = createFixture()
  fixture.failEngine = true
  await assert.rejects(fixture.complete())
  const before = [...fixture.effects]
  for (const changed of [
    {
      ...fixture.preparation,
      metadata: { ...fixture.preparation.metadata, title: 'Different draft' },
    },
    {
      ...fixture.preparation,
      thumbnail: { ...fixture.preparation.thumbnail!, data: new Uint8Array([9]) },
    },
    { ...fixture.preparation, registration: { ...fixture.preparation.registration, feeAmount: 8 } },
    {
      ...fixture.preparation,
      registration: { ...fixture.preparation.registration, feeOperationRef: 'another-operation' },
    },
  ])
    await assert.rejects(
      completeDurableMarketCreation(fixture.adapters, changed, fixture.preparation),
      /facts cannot change/,
    )
  assert.deepEqual(fixture.effects, before)
})

test('durable preparation failure prevents fee preparation and every delivery', async () => {
  const fixture = createFixture()
  fixture.adapters = {
    ...fixture.adapters,
    store: {
      ...fixture.store,
      async reserve() {
        throw new Error('storage unavailable')
      },
    },
  }
  await assert.rejects(fixture.complete(), /storage unavailable/)
  assert.equal(fixture.effects.length, 0)
})

test('unknown fee readiness and invalid mint facts fail closed', async () => {
  const fixture = createFixture()
  fixture.adapters.prepareFee = async () => 'unsupported' as never
  await assert.rejects(fixture.complete(), /readiness is invalid/)
  assert.equal(fixture.effects.length, 0)
  const mismatch = createFixture()
  mismatch.lookupMintOverride = { ...mismatch.condition(), announcements: ['ffff'] }
  await assert.rejects(mismatch.complete(), /does not match/)
  assert.equal(mismatch.effects.length, 0)
})

test('all shared prepayment limits stop durable reservation and every effect', async () => {
  const base = preparation()
  for (const input of [
    { ...base, metadata: { ...base.metadata, description: 'x'.repeat(65537) } },
    { ...base, thumbnail: { ...base.thumbnail!, data: new Uint8Array(5 * 1024 * 1024 + 1) } },
    {
      ...base,
      thumbnail: {
        ...base.thumbnail!,
        data: new Uint8Array(5 * 1024 * 1024),
        filename: 'x'.repeat(1024 * 1024),
      },
    },
  ]) {
    const fixture = createFixture()
    await assert.rejects(completeDurableMarketCreation(fixture.adapters, input, input))
    assert.equal(fixture.effects.length, 0)
    assert.equal(await fixture.store.read(input.creationId), null)
  }
})

test('only the protocol condition-not-found response proves mint absence', async () => {
  const lookup = (response: Response) =>
    readMarketCreationMintRegistration(
      'https://mint.example',
      'ab'.repeat(32),
      async () => response,
    )
  assert.equal(await lookup(Response.json({ code: 13021 }, { status: 400 })), null)
  const observed = { condition_id: 'ab'.repeat(32) }
  assert.deepEqual(await lookup(Response.json(observed)), observed)
  for (const response of [
    Response.json({ code: 13021 }, { status: 404 }),
    Response.json({ code: 10000 }, { status: 400 }),
    Response.json({ code: 13021 }, { status: 503 }),
    new Response('route not found', { status: 404 }),
    new Response('{', { status: 400 }),
  ])
    await assert.rejects(lookup(response))
})

for (const missing of [null, undefined, '', '  ']) {
  test(`fresh engine response with missing image (${JSON.stringify(missing)}) retains the paid attempt`, async () => {
    const fixture = createFixture()
    fixture.result.thumbnailUrl = missing
    await assert.rejects(fixture.complete(), MarketCreationThumbnailMismatchError)
    const retained = await fixture.store.read(fixture.preparation.creationId)
    assert.equal(retained?.mintConfirmed, true)
    assert.equal(retained?.engineResult, null)
    assert.equal(retained?.thumbnail?.filename, 'original.png')
    assert.deepEqual(Array.from(retained!.thumbnail!.data), [1, 2, 3])
    const effects = [...fixture.effects]
    await assert.rejects(fixture.complete(), { code: 'thumbnail-presence-mismatch' })
    assert.deepEqual(fixture.effects, effects)
    assert.equal(fixture.feeReferences.length, 1)
  })
}

test('existing engine image mismatch refuses completion without registering a replacement', async () => {
  const fixture = createFixture()
  await fixture.store.reserve(fixture.preparation)
  await fixture.store.confirmMint(fixture.preparation.creationId)
  fixture.adapters.lookupEngine = async () => ({
    ...fixture.result,
    creatorPubkey: fixture.preparation.creatorId,
    outcomes: ['Yes', 'No'],
    thumbnailUrl: null,
  })
  await assert.rejects(fixture.complete(), { code: 'thumbnail-presence-mismatch' })
  assert.deepEqual(fixture.effects, [])
  assert.equal((await fixture.store.read(fixture.preparation.creationId))?.engineResult, null)
})

test('lost response recovery refuses a missing image without repeating payment or upload', async () => {
  const fixture = createFixture()
  let created = false
  fixture.adapters.createEngine = async () => {
    fixture.effects.push('engine')
    created = true
    throw new CreateMarketError('response lost', null, true)
  }
  fixture.adapters.lookupEngine = async () =>
    created
      ? {
          ...fixture.result,
          creatorPubkey: fixture.preparation.creatorId,
          outcomes: ['Yes', 'No'],
          thumbnailUrl: null,
        }
      : null
  await assert.rejects(fixture.complete(), MarketCreationThumbnailMismatchError)
  assert.equal((await fixture.store.read(fixture.preparation.creationId))?.mintConfirmed, true)
  const effects = [...fixture.effects]
  await assert.rejects(fixture.complete(), MarketCreationThumbnailMismatchError)
  assert.deepEqual(fixture.effects, effects)
  assert.equal(fixture.feeReferences.length, 1)
})

test('historical cached image mismatch stays readable but cannot return cached success', async () => {
  const fixture = createFixture()
  await fixture.store.reserve(fixture.preparation)
  await fixture.store.confirmMint(fixture.preparation.creationId)
  const historical = parseCreateMarketResponse({ ...fixture.result, thumbnailUrl: null })
  // These are the shared validators used by browser and native record readers.
  assert.doesNotThrow(() => assertCreatedResultMatches(historical, fixture.preparation))
  await fixture.store.confirmEngine(fixture.preparation.creationId, historical)
  const before = await fixture.store.read(fixture.preparation.creationId)
  assert.equal(before?.engineResult?.thumbnailUrl, null)
  fixture.adapters.confirmFee = async () => {
    throw new Error('unexpected fee write')
  }
  fixture.adapters.store = {
    ...fixture.store,
    confirmMint: async () => {
      throw new Error('unexpected mint write')
    },
    confirmEngine: async () => {
      throw new Error('unexpected engine write')
    },
  }
  await assert.rejects(fixture.complete(), MarketCreationThumbnailMismatchError)
  assert.deepEqual(fixture.effects, [])
  const after = await fixture.store.read(fixture.preparation.creationId)
  assert.equal(after?.engineResult?.thumbnailUrl, null)
  assert.equal(after?.thumbnail?.filename, 'original.png')
  assert.deepEqual(Array.from(after!.thumbnail!.data), [1, 2, 3])
})

test('image-free creation still completes and accepts its cached result', async () => {
  const fixture = createFixture(false)
  assert.equal((await fixture.complete()).status, 'created')
  const effects = [...fixture.effects]
  assert.equal((await fixture.complete()).status, 'created')
  assert.deepEqual(fixture.effects, effects)
})

function preparation(): MarketCreationPreparation {
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(64).fill(0x11))
  const eventJson = JSON.stringify(
    finalizeEvent(
      { kind: 88, created_at: 1_700_000_000, tags: [], content: 'qrs=' },
      new Uint8Array(32).fill(0x22),
    ),
  )
  return snapshotMarketCreationPreparation({
    creationId: 'creation',
    eventId: 'oracle-event',
    creatorId: JSON.parse(eventJson).pubkey,
    walletId,
    walletScopeId: deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId }),
    mintUrl: 'https://mint.example',
    engineBaseUrl: 'https://engine.example',
    relayUrls: ['wss://relay.example'],
    metadata: {
      title: 'Title',
      description: 'Description',
      outcomes: [{ name: 'Yes' }, { name: 'No' }],
      outcomeType: 'yesno',
      baseAsset: 'sat',
      categoryTags: [],
      oracleAnnouncementHex: 'aabb',
    },
    announcement: {
      conditionId: 'ab'.repeat(32),
      announcementTlvHex: 'aabb',
      announcementNostrEventJson: eventJson,
    },
    registration: { feeOperationRef: 'existing-fee-operation', feeAmount: 7, feeUnit: 'msat' },
    thumbnail: {
      data: new Uint8Array([1, 2, 3]),
      filename: 'original.png',
      contentType: 'image/png',
    },
  })
}

function createFixture(withThumbnail = true) {
  const input = snapshotMarketCreationPreparation({
    ...preparation(),
    ...(withThumbnail ? {} : { thumbnail: null }),
  })
  const rows = new Map<string, MarketCreationRecord>()
  const effects: string[] = [],
    feeReferences: string[] = [],
    announcements: string[] = []
  let mint: unknown | null = null,
    engine: unknown | null = null
  let unavailableMint = false,
    unavailableEngine = false
  const store: MarketCreationStore = {
    async read(id) {
      return structuredClone(rows.get(id) ?? null)
    },
    async reserve(value) {
      const existing = rows.get(value.creationId)
      if (existing !== undefined) assertMarketCreationPreparationEqual(existing, value)
      else
        rows.set(value.creationId, {
          ...structuredClone(value),
          mintConfirmed: false,
          engineResult: null,
        })
      return structuredClone(rows.get(value.creationId)!)
    },
    async confirmMint(id) {
      rows.set(id, { ...rows.get(id)!, mintConfirmed: true })
      return structuredClone(rows.get(id)!)
    },
    async confirmEngine(id, result) {
      rows.set(id, { ...rows.get(id)!, engineResult: result })
      return structuredClone(rows.get(id)!)
    },
  }
  const condition = () => ({
    condition_id: input.announcement.conditionId,
    collateral: 'msat',
    announcements: [input.announcement.announcementTlvHex],
    tags: [
      ['title', input.metadata.title],
      ['description', input.metadata.description],
    ],
  })
  const result = {
    conditionId: input.announcement.conditionId,
    marketsCreated: input.metadata.outcomes.map(
      ({ name }) => `${input.announcement.conditionId}-${name}`,
    ),
    baseAsset: 'sat' as const,
    divisibility: 1000 as const,
    thumbnailUrl: (withThumbnail ? '/thumbnail' : null) as string | null | undefined,
  }
  const fixture = {
    result,
    preparation: input,
    effects,
    feeReferences,
    announcements,
    store,
    condition,
    failEngine: false,
    loseMintResponse: false,
    loseEngineResponse: false,
    lookupMintOverride: undefined as unknown,
    adapters: null as unknown as MarketCreationCoordinatorAdapters,
    complete: () => completeDurableMarketCreation(fixture.adapters, input, input),
  }
  fixture.adapters = {
    store,
    async prepareFee(record) {
      effects.push('fee')
      feeReferences.push(record.registration.feeOperationRef!)
      return 'ready'
    },
    async confirmFee() {},
    async publishAnnouncement(record) {
      effects.push('publish')
      announcements.push(record.announcement.announcementNostrEventJson)
    },
    async lookupMint() {
      if (unavailableMint) {
        unavailableMint = false
        throw new Error('lookup unavailable')
      }
      return fixture.lookupMintOverride ?? mint
    },
    async registerMint() {
      effects.push('mint')
      mint = condition()
      if (fixture.loseMintResponse) {
        fixture.loseMintResponse = false
        unavailableMint = true
        throw new Error('lost response')
      }
      return { condition_id: input.announcement.conditionId }
    },
    async lookupEngine() {
      if (unavailableEngine) {
        unavailableEngine = false
        throw new Error('lookup unavailable')
      }
      return engine
    },
    async createEngine() {
      effects.push('engine')
      if (fixture.failEngine) {
        fixture.failEngine = false
        throw new CreateMarketError('engine rejected', 401, false)
      }
      engine = { ...result, creatorPubkey: input.creatorId, outcomes: ['Yes', 'No'] }
      if (fixture.loseEngineResponse) {
        fixture.loseEngineResponse = false
        unavailableEngine = true
        throw new CreateMarketError('lost engine response', null, true)
      }
      return result
    },
  }
  return fixture
}
