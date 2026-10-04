import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { finalizeEvent } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  Amount,
  CheckStateEnum,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type OperationCounters,
  type Proof,
} from '@cashu/cashu-ts'
import {
  BitcasterEngineClient,
  EngineClientError,
  defaultMarketDivisibility,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  deriveDlcConditionId,
  type MarketCreationInput,
} from '@bitcaster-market/client-sdk'
import type { DurableOutgoingCashuTransfer } from '@bitcaster-market/client-sdk/durableOutgoingCashuTransfer'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { deriveNativeConditionRegistrationFeeTransferId } from '../src/nativeConditionRegistrationFee.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { DAEMON_PROFILE_DATABASE } from '../src/profileSchema.ts'
import { deriveNostrPublicKey } from '../src/profileSecretProtection.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import {
  createNativeOracleCreationStore,
  type NativeOracleCreationStore,
} from '../src/nativeOracleCreationStore.ts'
import { completeNativeMarketCreation } from '../src/nativeMarketCreation.ts'
import { addAvailableProofs } from '../src/state.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import type { NativeMarketCreationInput } from '../src/nativeMarketOracle.ts'
import type { NativeOracleHelper } from '../src/nativeOracleHelper.ts'
import type { NativeMarketCreationDependencies } from '../src/nativeMarketCreation.ts'
import {
  createDaemonCounterSource,
  type CashuWalletLike,
  type WalletOpsDependencies,
} from '../src/walletOps.ts'

const CREATOR_PUBKEY = deriveNostrPublicKey('22'.repeat(32))
const ORACLE_PUBKEY = CREATOR_PUBKEY
const MINT_URL = 'https://mint.example'
const ANNOUNCEMENT_TLV_HEX = 'aabb'
const ANNOUNCEMENT_EVENT_JSON = JSON.stringify(
  finalizeEvent(
    {
      kind: 88,
      created_at: 1_700_000_000,
      content: 'qrs=',
      tags: [],
    },
    new Uint8Array(32).fill(0x22),
  ),
)
const FEE_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const FEE_PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(FEE_PRIVATE_KEY, true))
const FEE_KEYS = Object.fromEntries(
  [1, 2, 4, 8, 16].map((amount) => [String(amount), FEE_PUBLIC_KEY]),
)
const FEE_KEYSET_ID = deriveKeysetId(FEE_KEYS, { unit: 'msat', versionByte: 1 })

for (const [name, market] of [
  ['binary', binaryMarket()],
  ['categorical', categoricalMarket()],
] as const) {
  test(`fee-free ${name} creation publishes, registers, and creates through SDK boundaries`, async () => {
    const input = creationInput(`fee-free-${name}`, market)
    await withFixture(input, async (fixture) => {
      const result = await completeNativeMarketCreation(fixture.dependencies, input)

      assert.equal(result.status, 'created')
      assert.equal(result.creationId, input.creationId)
      assert.equal(result.conditionId, fixture.conditionIdFor(input))
      assert.deepEqual(
        result.market.marketsCreated,
        market.outcomeDetails.map(({ name: outcome }) => `${result.conditionId}-${outcome}`),
      )
      assert.equal(fixture.helperCreateCount(), 1)
      assert.equal(fixture.publishedEvents().length, 1)
      assert.equal(fixture.mintRequests().length, 1)
      assert.equal(fixture.engineStats().registrationReads, 1)
      assert.equal(fixture.engineStats().createRequests, 1)
      assert.equal(fixture.mintRequests()[0]?.collateral, 'msat')
      assert.deepEqual(fixture.mintRequests()[0]?.announcements, [ANNOUNCEMENT_TLV_HEX])
      assert.equal(Object.hasOwn(fixture.mintRequests()[0] ?? {}, 'fee'), false)
    })
  })
}

test('an exact retry reuses the stored announcement and does not invoke the helper again', async () => {
  const input = creationInput('exact-retry', binaryMarket())
  await withFixture(input, async (fixture) => {
    const first = await completeNativeMarketCreation(fixture.dependencies, input)
    const stored = await fixture.store.readCreation(input.creationId)
    const second = await completeNativeMarketCreation(fixture.dependencies, input)

    assert.equal(first.conditionId, second.conditionId)
    assert.equal(second.status, 'created')
    assert.equal(fixture.helperCreateCount(), 1)
    assert.equal(fixture.publishedEvents().length, 1)
    assert.equal(fixture.mintRequests().length, 1)
    assert.deepEqual(
      fixture.mintRequests().map(({ announcements }) => announcements),
      [[ANNOUNCEMENT_TLV_HEX]],
    )
    assert.equal(
      (await fixture.store.readCreation(input.creationId))?.nonceIndex,
      stored?.nonceIndex,
    )
    assert.equal(fixture.engineStats().registrationReads, 1)
    assert.equal(fixture.engineStats().createRequests, 1)
  })
})

test('a saved creation refuses a different account before nonce, helper, fee, mint or publication effects', async () => {
  const input = creationInput('wrong-account', binaryMarket())
  await withFixture(input, async (fixture) => {
    await fixture.store.reserveCreation({
      creationId: input.creationId,
      eventId: input.eventId,
      canonicalInput: '{}',
    })
    for (const changed of [
      { creatorPubkey: deriveNostrPublicKey('44'.repeat(32)) },
      { oracle: { ...fixture.dependencies.oracle, oracleSecretKeyHex: '44'.repeat(32) } },
    ]) {
      await assert.rejects(
        completeNativeMarketCreation(
          Object.create(
            fixture.dependencies,
            Object.fromEntries(Object.entries(changed).map(([key, value]) => [key, { value }])),
          ),
          input,
        ),
        /requires signer/,
      )
    }
    assert.equal(fixture.helperCreateCount(), 0)
    assert.equal(fixture.publishedEvents().length, 0)
    assert.equal(fixture.mintRequests().length, 0)
    assert.deepEqual(fixture.engineStats(), { registrationReads: 0, createRequests: 0 })
    assert.equal((await fixture.store.readCreation(input.creationId))!.nonceIndex, 0)
    assert.equal(
      (
        await fixture.store.reserveCreation({
          creationId: 'next',
          eventId: 'next-event',
          canonicalInput: '{}',
        })
      ).nonceIndex,
      1,
    )
  })
})

test('publication failure prevents mint and engine calls, then retry uses the reserved announcement', async () => {
  const input = creationInput('publish-retry', binaryMarket())
  await withFixture(input, async (fixture) => {
    fixture.failNextPublication()
    await assert.rejects(
      completeNativeMarketCreation(fixture.dependencies, input),
      /relay publication failed/,
    )
    const reserved = await fixture.store.readCreation(input.creationId)
    assert.ok(reserved?.announcement)
    assert.equal(fixture.helperCreateCount(), 1)
    assert.equal(fixture.mintRequests().length, 0)
    assert.deepEqual(fixture.engineStats(), { registrationReads: 0, createRequests: 0 })

    const retried = await completeNativeMarketCreation(fixture.dependencies, input)
    assert.equal(retried.status, 'created')
    assert.equal(fixture.helperCreateCount(), 1)
    assert.equal(fixture.publishedEvents().length, 2)
    assert.equal(fixture.publishedEvents()[0], fixture.publishedEvents()[1])
    assert.equal(fixture.mintRequests().length, 1)
    assert.deepEqual(fixture.engineStats(), { registrationReads: 1, createRequests: 1 })
  })
})

test('mint response loss after accepting the fee reuses the spent transfer on retry', async () => {
  const input: NativeMarketCreationInput = {
    ...creationInput('paid-registration-retry', binaryMarket()),
    registration: { requiredFeeMsat: 7 },
  }
  await withFixture(input, async (fixture) => {
    fixture.failAfterMintAcceptsFee()
    await assert.rejects(
      completeNativeMarketCreation(fixture.dependencies, input, { maxWalletDebitMsat: 7 }),
      /Mint registration lookup is unavailable/,
    )

    const transferId = deriveNativeConditionRegistrationFeeTransferId(input.creationId)
    const paidTransfer = await fixture.feeTransfer()
    assert.equal(paidTransfer?.transferId, transferId)
    assert.equal(paidTransfer?.deliveryState, 'delivery-pending')
    assert.equal(fixture.paymentWalletStats()?.completedSwaps, 1)
    assert.equal(fixture.publishedEvents().length, 1)
    assert.equal(fixture.mintRequests().length, 1)
    const firstFee = fixture.mintRequests()[0]?.fee as Array<Record<string, unknown>> | undefined
    assert.ok(firstFee?.length)
    assert.equal(firstFee[0]?.secret, paidTransfer?.token?.proofs[0]?.secret)
    assert.deepEqual(fixture.engineStats(), { registrationReads: 0, createRequests: 0 })

    const retried = await completeNativeMarketCreation(fixture.dependenciesAfterRestart(), input)
    assert.equal(retried.status, 'created')
    assert.equal(retried.conditionId, fixture.conditionIdFor(input))
    assert.equal(fixture.paymentWalletStats()?.completedSwaps, 1)
    assert.equal(fixture.paymentWalletStats()?.prepareCalls, 2)
    assert.equal(fixture.publishedEvents().length, 1)
    assert.equal(fixture.mintRequests().length, 1)
    assert.equal(fixture.helperCreateCount(), 1)
    assert.equal(
      (await fixture.store.readCreation(input.creationId))?.marketCreation?.mintConfirmed,
      true,
    )
    const retriedTransfer = await fixture.feeTransfer()
    assert.equal(retriedTransfer?.transferId, paidTransfer?.transferId)
    assert.equal(
      retriedTransfer?.walletSendOperation.operationId,
      paidTransfer?.walletSendOperation.operationId,
    )
    assert.equal(retriedTransfer?.token?.sha256, paidTransfer?.token?.sha256)
    assert.equal(retriedTransfer?.deliveryState, 'bearer-spent')
    assert.deepEqual(fixture.engineStats(), { registrationReads: 1, createRequests: 1 })
  })
})

test('a mint condition mismatch blocks engine reads and creation', async () => {
  const input = creationInput('mint-mismatch', categoricalMarket())
  await withFixture(input, async (fixture) => {
    fixture.setMintConditionId('ff'.repeat(32))
    await assert.rejects(
      completeNativeMarketCreation(fixture.dependencies, input),
      /different condition|does not match/,
    )
    assert.equal(fixture.publishedEvents().length, 1)
    assert.equal(fixture.mintRequests().length, 1)
    assert.deepEqual(fixture.engineStats(), { registrationReads: 0, createRequests: 0 })
  })
})

test('an unavailable registration read is not treated as an absent market', async () => {
  const input = creationInput('registration-read-unavailable', binaryMarket())
  await withFixture(input, async (fixture) => {
    fixture.failNextRegistrationRead()

    await assert.rejects(
      completeNativeMarketCreation(fixture.dependencies, input),
      (error: unknown) => error instanceof EngineClientError && error.status === 503,
    )

    assert.equal(fixture.engineStats().registrationReads, 1)
    assert.equal(fixture.engineStats().createRequests, 0)
  })
})

test('uncertain engine creation reconciles a matching market read', async () => {
  const input = creationInput('engine-reconcile', categoricalMarket())
  await withFixture(input, async (fixture) => {
    fixture.commitThenFailEngineCreate()
    const result = await completeNativeMarketCreation(fixture.dependencies, input)

    assert.equal(result.status, 'created')
    assert.equal(result.conditionId, fixture.conditionIdFor(input))
    assert.deepEqual(
      result.market.marketsCreated,
      input.market.outcomeDetails.map(({ name }) => `${result.conditionId}-${name}`),
    )
    assert.equal(fixture.mintRequests().length, 1)
    assert.equal(fixture.engineStats().registrationReads, 2)
    assert.equal(fixture.engineStats().createRequests, 1)
  })
})

test('paid engine failure survives a cold SQLite read and resumes the original thumbnail without another fee', async () => {
  const data = new Uint8Array(2 * 1024 * 1024).fill(0x5a)
  const expectedHash = createHash('sha256').update(data).digest('hex')
  const input: NativeMarketCreationInput = {
    ...creationInput('paid-engine-resume', binaryMarket()),
    registration: { requiredFeeMsat: 7 },
    destination: {
      ...creationInput('unused', binaryMarket()).destination,
      thumbnailSha256: expectedHash,
      thumbnailFilename: 'original.png',
      thumbnailContentType: 'image/png',
    },
  }
  await withFixture(input, async (fixture) => {
    fixture.failEngineCreateBeforeCommit()
    await assert.rejects(
      completeNativeMarketCreation(fixture.dependencies, input, {
        maxWalletDebitMsat: 7,
        thumbnail: { data, filename: 'original.png', contentType: 'image/png' },
      }),
      /Failed to create market/,
    )
    const reopened = createNativeOracleCreationStore(fixture.directory)
    const paid = (await reopened.readCreation(input.creationId))!
    assert.equal(paid.marketCreation?.mintConfirmed, true)
    assert.equal(paid.marketCreation?.engineResult, null)
    assert.equal(paid.marketCreation?.registration.feeAmount, 7)
    assert.equal(paid.marketCreation?.registration.feeUnit, 'msat')
    assert.equal(
      paid.marketCreation?.registration.feeOperationRef,
      deriveNativeConditionRegistrationFeeTransferId(input.creationId),
    )
    assert.equal(paid.walletId, deriveDurableCustodyWalletId(fixture.dependencies.seed))
    assert.equal(paid.walletScopeId, paid.marketCreation?.walletScopeId)
    assert.equal(
      paid.marketCreation?.announcement.announcementNostrEventJson,
      ANNOUNCEMENT_EVENT_JSON,
    )
    assert.equal(
      createHash('sha256').update(paid.marketCreation!.thumbnail!.data).digest('hex'),
      expectedHash,
    )
    data.fill(0)
    const result = await completeNativeMarketCreation(fixture.dependenciesAfterRestart(), input)
    assert.equal(result.status, 'created')
    const confirmed = await createNativeOracleCreationStore(fixture.directory).readCreation(
      input.creationId,
    )
    assert.equal(confirmed?.marketCreation?.mintConfirmed, true)
    assert.equal(confirmed?.marketCreation?.engineResult?.conditionId, result.conditionId)
    assert.equal(confirmed?.nonceIndex, paid.nonceIndex)
    assert.equal(fixture.helperCreateCount(), 1)
    assert.equal(fixture.publishedEvents().length, 1)
    assert.equal(fixture.mintRequests().length, 1)
    assert.equal(fixture.paymentWalletStats()?.completedSwaps, 1)
    assert.equal(fixture.paymentWalletStats()?.prepareCalls, 2)
    assert.equal((await fixture.feeTransfer())?.deliveryState, 'bearer-spent')
    assert.equal(fixture.engineThumbnails().length, 2)
    for (const bytes of fixture.engineThumbnails())
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expectedHash)
    const database = new DatabaseSync(join(fixture.directory, DAEMON_PROFILE_DATABASE))
    try {
      for (const mutation of [
        "creation_mint_url = 'https://different.example'",
        'creation_fee_amount = 8',
        "creation_thumbnail_bytes = x'01'",
        'creation_mint_confirmed = 0',
        "creation_engine_result_json = '{}'",
      ])
        assert.throws(
          () => database.exec(`UPDATE daemon_oracle_creations SET ${mutation}`),
          /immutable after commitment/,
        )
    } finally {
      database.close()
    }
  })
})

test('lost paid engine response and lookup survive cold SQLite resume without another delivery', async () => {
  const input: NativeMarketCreationInput = {
    ...creationInput('paid-engine-lost-response', categoricalMarket()),
    registration: { requiredFeeMsat: 7 },
  }
  await withFixture(input, async (fixture) => {
    fixture.commitThenLoseEngineResponseAndLookup()
    await assert.rejects(
      completeNativeMarketCreation(fixture.dependencies, input, { maxWalletDebitMsat: 7 }),
      (error: unknown) => error instanceof EngineClientError && error.status === 503,
    )
    const cold = await createNativeOracleCreationStore(fixture.directory).readCreation(
      input.creationId,
    )
    assert.equal(cold?.marketCreation?.mintConfirmed, true)
    assert.equal(cold?.marketCreation?.engineResult, null)
    const result = await completeNativeMarketCreation(fixture.dependenciesAfterRestart(), input)
    assert.equal(result.status, 'created')
    await completeNativeMarketCreation(fixture.dependenciesAfterRestart(), input)
    assert.equal(fixture.engineStats().createRequests, 1)
    assert.equal(fixture.paymentWalletStats()?.completedSwaps, 1)
    assert.equal(fixture.publishedEvents().length, 1)
    assert.equal(fixture.mintRequests().length, 1)
    assert.equal(fixture.helperCreateCount(), 1)
    assert.equal((await fixture.feeTransfer())?.deliveryState, 'bearer-spent')
  })
})

test('paid creation rejects a different wallet, destinations, or draft without repeating effects', async () => {
  const input: NativeMarketCreationInput = {
    ...creationInput('paid-boundary', binaryMarket()),
    registration: { requiredFeeMsat: 7 },
  }
  await withFixture(input, async (fixture) => {
    fixture.failEngineCreateBeforeCommit()
    await assert.rejects(
      completeNativeMarketCreation(fixture.dependencies, input, { maxWalletDebitMsat: 7 }),
    )
    await assert.rejects(
      completeNativeMarketCreation(
        { ...fixture.dependencies, seed: new Uint8Array(64).fill(0x44) },
        input,
      ),
      /original wallet/,
    )
    for (const changed of [
      { ...input, destination: { ...input.destination, mintUrl: 'https://other-mint.example' } },
      {
        ...input,
        destination: { ...input.destination, engineBaseUrl: 'https://other-engine.example' },
      },
      { ...input, market: { ...input.market, title: 'Changed paid draft' } },
      { ...input, registration: { requiredFeeMsat: 8 } },
    ])
      await assert.rejects(
        completeNativeMarketCreation(fixture.dependenciesAfterRestart(), changed),
      )
    assert.equal(fixture.helperCreateCount(), 1)
    assert.equal(fixture.publishedEvents().length, 1)
    assert.equal(fixture.mintRequests().length, 1)
    assert.equal(fixture.engineStats().createRequests, 1)
    assert.equal(fixture.paymentWalletStats()?.completedSwaps, 1)
    assert.equal(
      (await fixture.store.readCreation(input.creationId))?.marketCreation?.metadata.title,
      input.market.title,
    )
  })
})

test('production SQLite preparation write failure stops before fee, relay, mint, or engine effects', async () => {
  const input: NativeMarketCreationInput = {
    ...creationInput('sqlite-write-failure', binaryMarket()),
    registration: { requiredFeeMsat: 7 },
  }
  await withFixture(input, async (fixture) => {
    await fixture.store.readWalletBinding()
    const database = new DatabaseSync(join(fixture.directory, DAEMON_PROFILE_DATABASE))
    try {
      database.exec(`CREATE TRIGGER test_creation_write_failure
        BEFORE UPDATE OF creation_metadata_json ON daemon_oracle_creations
        BEGIN SELECT RAISE(ABORT, 'fixture preparation storage failure'); END`)
      await assert.rejects(
        completeNativeMarketCreation(fixture.dependencies, input, { maxWalletDebitMsat: 7 }),
        /fixture preparation storage failure/,
      )
      assert.equal((await fixture.store.readCreation(input.creationId))?.marketCreation, null)
      assert.equal(fixture.paymentWalletStats()?.prepareCalls, 0)
      assert.equal(fixture.paymentWalletStats()?.completedSwaps, 0)
      assert.equal(fixture.publishedEvents().length, 0)
      assert.equal(fixture.mintRequests().length, 0)
      assert.equal(fixture.engineStats().createRequests, 0)
    } finally {
      database.exec('DROP TRIGGER IF EXISTS test_creation_write_failure')
      database.close()
    }
    const result = await completeNativeMarketCreation(fixture.dependenciesAfterRestart(), input, {
      maxWalletDebitMsat: 7,
    })
    assert.equal(result.status, 'created')
    assert.equal(fixture.helperCreateCount(), 1)
    assert.equal(fixture.paymentWalletStats()?.completedSwaps, 1)
  })
})

test('an unavailable mint lookup is not absence and cannot start the registration fee', async () => {
  const input: NativeMarketCreationInput = {
    ...creationInput('mint-lookup-unavailable', binaryMarket()),
    registration: { requiredFeeMsat: 7 },
  }
  await withFixture(input, async (fixture) => {
    fixture.failNextMintRead()
    await assert.rejects(
      completeNativeMarketCreation(fixture.dependencies, input, { maxWalletDebitMsat: 7 }),
      /Mint registration lookup is unavailable/,
    )
    assert.equal(fixture.paymentWalletStats()?.prepareCalls, 0)
    assert.equal(fixture.paymentWalletStats()?.completedSwaps, 0)
    assert.equal(fixture.publishedEvents().length, 0)
    assert.equal(fixture.mintRequests().length, 0)
    assert.equal(fixture.engineStats().createRequests, 0)
    const saved = await createNativeOracleCreationStore(fixture.directory).readCreation(
      input.creationId,
    )
    assert.equal(saved?.marketCreation?.mintConfirmed, false)
    assert.equal(saved?.marketCreation?.engineResult, null)
  })
})

async function withFixture(
  input: NativeMarketCreationInput,
  run: (fixture: NativeMarketCreationFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-native-market-create-'))
  const directory = join(root, 'profile')
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: input.destination.engineBaseUrl,
      mintUrl: input.destination.mintUrl,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
      nativeOracleNonceSeedHex: '33'.repeat(32),
    })
    const feeFixture =
      input.registration.requiredFeeMsat === 0
        ? null
        : await createRegistrationFeeFixture(directory)
    const fixture = createFixture(directory, input, feeFixture)
    await run(fixture)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
}

interface NativeMarketCreationFixture {
  readonly directory: string
  readonly dependencies: NativeMarketCreationDependencies
  readonly store: NativeOracleCreationStore
  helperCreateCount(): number
  publishedEvents(): string[]
  mintRequests(): Record<string, unknown>[]
  engineStats(): { registrationReads: number; createRequests: number }
  conditionIdFor(input: NativeMarketCreationInput): string
  failNextPublication(): void
  failNextRegistrationRead(): void
  failAfterMintAcceptsFee(): void
  failNextMintRead(): void
  failEngineCreateBeforeCommit(): void
  setMintConditionId(conditionId: string): void
  commitThenFailEngineCreate(): void
  commitThenLoseEngineResponseAndLookup(): void
  dependenciesAfterRestart(): NativeMarketCreationDependencies
  feeTransfer(): Promise<DurableOutgoingCashuTransfer | null>
  paymentWalletStats(): { prepareCalls: number; completedSwaps: number } | null
  engineThumbnails(): Uint8Array[]
}

function createFixture(
  directory: string,
  input: NativeMarketCreationInput,
  feeFixture: RegistrationFeeFixture | null,
): NativeMarketCreationFixture {
  const store = createNativeOracleCreationStore(directory)
  let helperCreates = 0
  let publicationFailureCount = 0
  let mintConditionIdOverride: string | null = null
  let engineCreateUncertain = false
  let loseEngineReconciliation = false
  let loseMintResponseAfterAcceptingFee = false
  let mintReadFailures = 0
  let storedMintCondition: Record<string, unknown> | null = null
  let engineCreateFailures = 0
  let storedEngineMarket: Record<string, unknown> | null = null
  let registrationReads = 0
  let registrationReadFailureCount = 0
  let engineCreateRequests = 0
  const published: string[] = []
  const registrations: Record<string, unknown>[] = []
  const engineThumbnails: Uint8Array[] = []
  const outcomes = input.market.outcomeDetails.map(({ name }) => name)

  const helper: NativeOracleHelper = {
    assertAvailable() {},
    async createEnum(request) {
      helperCreates += 1
      return {
        eventId: request.eventId,
        oraclePublicKeyHex: ORACLE_PUBKEY,
        announcementTlvHex: ANNOUNCEMENT_TLV_HEX,
        announcementNostrEventId: 'de'.repeat(32),
        announcementNostrEventJson: ANNOUNCEMENT_EVENT_JSON,
      }
    },
    async signEnum() {
      throw new Error('outcome signing is outside market creation')
    },
  }

  const fetchEngine: typeof fetch = async (request, init) => {
    const url = new URL(String(request))
    if (url.pathname.endsWith('/registration') && init?.method !== 'POST') {
      registrationReads += 1
      if (registrationReadFailureCount > 0) {
        registrationReadFailureCount -= 1
        return new Response('temporarily unavailable', { status: 503 })
      }
      if (storedEngineMarket === null) return new Response('not found', { status: 404 })
      return Response.json(storedEngineMarket)
    }
    if (url.pathname.startsWith('/api/v1/markets/') && init?.method === 'POST') {
      engineCreateRequests += 1
      const multipart = await new Request(String(request), init).formData()
      const thumbnail = multipart.get('thumbnail')
      if (thumbnail instanceof Blob)
        engineThumbnails.push(new Uint8Array(await thumbnail.arrayBuffer()))
      if (engineCreateFailures > 0) {
        engineCreateFailures -= 1
        return new Response('fresh authentication required', { status: 401 })
      }
      const conditionId = decodeURIComponent(url.pathname.slice('/api/v1/markets/'.length))
      const createdMarket = marketRecord(conditionId, input.market)
      storedEngineMarket = createdMarket
      if (engineCreateUncertain) {
        engineCreateUncertain = false
        if (loseEngineReconciliation) {
          registrationReadFailureCount += 1
          loseEngineReconciliation = false
        }
        return new Response('engine response was lost', { status: 500 })
      }
      return Response.json({
        conditionId,
        marketsCreated: outcomes.map((outcome) => `${conditionId}-${outcome}`),
        baseAsset: input.market.baseAsset,
        divisibility: defaultMarketDivisibility(input.market.baseAsset),
      })
    }
    throw new Error(`Unexpected mocked engine request: ${url.pathname}`)
  }
  const engine = new BitcasterEngineClient({
    baseUrl: input.destination.engineBaseUrl,
    fetchImpl: fetchEngine,
  })
  const buildDependencies = (
    coordinator?: DaemonDurableOutgoingCashuCoordinator,
    wallet?: CashuWalletLike,
    currentStore = store,
  ): NativeMarketCreationDependencies => {
    const shared = {
      oracle: {
        store: currentStore,
        helper,
        oracleSecretKeyHex: '22'.repeat(32),
        nonceSeedHex: '33'.repeat(32),
      },
      seed: Buffer.from('11'.repeat(64), 'hex'),
      engine,
      creatorPubkey: CREATOR_PUBKEY,
      publish: async (relayUrls: readonly string[], eventJson: string) => {
        published.push(eventJson)
        if (publicationFailureCount > 0) {
          publicationFailureCount -= 1
          throw new Error('relay publication failed')
        }
        return {
          eventId: 'de'.repeat(32),
          acceptedRelays: [...relayUrls],
          rejectedRelayCount: 0,
        }
      },
      fetch: async (request: RequestInfo | URL, init?: RequestInit) => {
        if (
          String(request).startsWith(`${input.destination.mintUrl}/v1/conditions/`) &&
          init?.method === undefined
        ) {
          if (mintReadFailures > 0) {
            mintReadFailures -= 1
            return new Response('lookup unavailable', { status: 503 })
          }
          return storedMintCondition === null
            ? Response.json({ code: 13021, detail: 'Condition not found' }, { status: 400 })
            : Response.json(storedMintCondition)
        }
        assert.equal(String(request), `${input.destination.mintUrl}/v1/conditions`)
        assert.equal(init?.method, 'POST')
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        registrations.push(body)
        storedMintCondition = {
          condition_id: mintConditionIdOverride ?? conditionIdFor(input),
          announcements: body.announcements,
          collateral: body.collateral,
          tags: body.tags,
          keysets: {},
        }
        if (loseMintResponseAfterAcceptingFee) {
          loseMintResponseAfterAcceptingFee = false
          assert.ok(feeFixture, 'fee acceptance requires the durable fee fixture')
          const feeProofs = body.fee as Array<Record<string, unknown>> | undefined
          assert.ok(feeProofs?.length, 'mint must receive the prepared registration fee')
          const transfer = await feeFixture.coordinator.loadTransfer(
            deriveNativeConditionRegistrationFeeTransferId(input.creationId),
          )
          assert.ok(transfer?.token?.proofs.length)
          assert.equal(feeProofs[0]?.secret, transfer.token.proofs[0]?.secret)
          feeFixture.markMintSpent()
          mintReadFailures += 1
          throw new Error('mint response was lost after fee acceptance')
        }
        if (feeFixture !== null) feeFixture.markMintSpent()
        return Response.json({
          condition_id: mintConditionIdOverride ?? conditionIdFor(input),
          keysets: {},
        })
      },
    }
    if (coordinator !== undefined && wallet !== undefined) {
      const dependencies: NativeMarketCreationDependencies = {
        ...shared,
        coordinator,
        wallet,
      }
      return dependencies
    }
    const dependencies: NativeMarketCreationDependencies = {
      ...shared,
      get wallet(): never {
        throw new Error('fee-free creation accessed the wallet')
      },
      get coordinator(): never {
        throw new Error('fee-free creation accessed the outgoing coordinator')
      },
    }
    return dependencies
  }
  const dependencies =
    feeFixture === null
      ? buildDependencies()
      : buildDependencies(feeFixture.coordinator, feeFixture.createWallet())

  return {
    directory,
    dependencies,
    store,
    helperCreateCount: () => helperCreates,
    publishedEvents: () => [...published],
    mintRequests: () => structuredClone(registrations),
    engineStats: () => ({ registrationReads, createRequests: engineCreateRequests }),
    conditionIdFor: (creation) => conditionIdFor(creation),
    dependenciesAfterRestart: () =>
      feeFixture === null
        ? buildDependencies(undefined, undefined, createNativeOracleCreationStore(directory))
        : buildDependencies(
            feeFixture.createCoordinator(),
            feeFixture.createWallet(),
            createNativeOracleCreationStore(directory),
          ),
    feeTransfer: async () =>
      feeFixture === null
        ? null
        : feeFixture.coordinator.loadTransfer(
            deriveNativeConditionRegistrationFeeTransferId(input.creationId),
          ),
    paymentWalletStats: () => feeFixture?.stats() ?? null,
    engineThumbnails: () => engineThumbnails.map((bytes) => bytes.slice()),
    failNextPublication() {
      publicationFailureCount += 1
    },
    failNextRegistrationRead() {
      registrationReadFailureCount += 1
    },
    failAfterMintAcceptsFee() {
      loseMintResponseAfterAcceptingFee = true
    },
    failNextMintRead() {
      mintReadFailures += 1
    },
    failEngineCreateBeforeCommit() {
      engineCreateFailures += 1
    },
    setMintConditionId(conditionId) {
      mintConditionIdOverride = conditionId
    },
    commitThenFailEngineCreate() {
      engineCreateUncertain = true
    },
    commitThenLoseEngineResponseAndLookup() {
      engineCreateUncertain = true
      loseEngineReconciliation = true
    },
  }
}

interface RegistrationFeeFixture {
  readonly coordinator: DaemonDurableOutgoingCashuCoordinator
  createCoordinator(): DaemonDurableOutgoingCashuCoordinator
  createWallet(): CashuWalletLike
  markMintSpent(): void
  stats(): { prepareCalls: number; completedSwaps: number }
}

async function createRegistrationFeeFixture(directory: string): Promise<RegistrationFeeFixture> {
  const walletSeed = Buffer.from('11'.repeat(64), 'hex')
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(walletSeed),
  })
  const fence = await claimCustodyScopeLease(directory, {
    scopeId,
    incarnationId: 'native-market-create-fee-test',
    observedAtMs: Date.now(),
  })
  let mintSpent = false
  let prepareCalls = 0
  let completedSwaps = 0
  let preparedProofs: { keep: Proof[]; send: Proof[] } = { keep: [], send: [] }

  const inputOutput = OutputData.createSingleData(16, FEE_KEYSET_ID, 'fee-input-proof', 1n)
  const sendOutputs = [
    OutputData.createSingleData(4, FEE_KEYSET_ID, 'fee-send-four', 2n),
    OutputData.createSingleData(2, FEE_KEYSET_ID, 'fee-send-two', 3n),
    OutputData.createSingleData(1, FEE_KEYSET_ID, 'fee-send-one', 4n),
  ]
  const keepOutputs = [
    OutputData.createSingleData(8, FEE_KEYSET_ID, 'fee-keep-eight', 5n),
    OutputData.createSingleData(1, FEE_KEYSET_ID, 'fee-keep-one', 6n),
  ]
  const inputProof = signProof(inputOutput)
  const proofByBlindedMessage = new Map<string, Proof>()

  await addAvailableProofs(MINT_URL, [inputProof], {
    kind: 'sats',
    baseAsset: 'sat',
    unit: 'msat',
  })
  await withDurableCustodyUnitOfWork(directory, fence, Date.now(), (database) => {
    const proof = createCustodyProofSqliteRow({
      scopeId,
      normalizedMint: MINT_URL,
      unit: 'msat',
      proof: {
        id: inputProof.id,
        amount: inputProof.amount,
        secret: inputProof.secret,
        C: inputProof.C,
        dleq: inputProof.dleq ?? null,
        p2pkE: inputProof.p2pk_e ?? null,
        witness: inputProof.witness ?? null,
      },
      baseAsset: 'sat',
      conditionId: null,
      outcomeSetId: null,
      productBinding: null,
      signatureVerified: true,
      dleqState: 'verified',
      nut07State: 'UNSPENT',
      selectability: 'selectable',
      storageClass: 'pinned-operation-bound-deterministic',
      reservationOperationId: null,
      revision: 0,
      nowMs: Date.now(),
    })
    new DurableCustodySqliteStore(database).putProofBatchCas([{ proof, expectedRevision: null }])
  })

  const walletDependencies: WalletOpsDependencies = {
    restoreOutputGroups: async (_mintUrl, outputGroups) => ({
      send: restore('send', outputGroups.send ?? []),
      keep: restore('keep', outputGroups.keep ?? []),
    }),
  }
  const counterSource = createDaemonCounterSource(() => ({ fence, observedAtMs: Date.now() }), {
    normalizedMint: MINT_URL,
    unit: 'msat',
  })
  const createCoordinator = () =>
    new DaemonDurableOutgoingCashuCoordinator(directory, () => fence, walletDependencies)

  function restore(
    _group: 'send' | 'keep',
    outputs: Array<{ blindedMessage: { B_: string } }>,
  ): Proof[] {
    return outputs.map((output) => {
      const proof = proofByBlindedMessage.get(output.blindedMessage.B_)
      if (proof === undefined) throw new Error('fee output fixture is missing')
      return proof
    })
  }

  return {
    coordinator: createCoordinator(),
    createCoordinator,
    createWallet() {
      const wallet: CashuWalletLike = {
        loadMint: async () => {},
        receive: async () => [],
        send: async () => ({ keep: [], send: [] }),
        prepareSwapToSend: async (amountMsat, proofs, config, outputConfig) => {
          prepareCalls += 1
          assert.equal(amountMsat, 7)
          if ((outputConfig as { send?: { type?: string } } | undefined)?.send?.type === 'random') {
            assert.equal(config, undefined)
            return {
              amount: Amount.from(amountMsat),
              fees: Amount.zero(),
              keysetId: FEE_KEYSET_ID,
              inputs: [...proofs],
              sendOutputs,
              keepOutputs,
              unselectedProofs: [],
            }
          }
          assert.equal((config as { includeFees?: boolean }).includeFees, false)
          assert.deepEqual(outputConfig, {
            send: { type: 'deterministic', counter: 0 },
            keep: { type: 'deterministic', counter: 0 },
          })
          const onCountersReserved = (
            config as { onCountersReserved?: (counters: OperationCounters) => void }
          ).onCountersReserved
          assert.equal(typeof onCountersReserved, 'function')
          const count = sendOutputs.length + keepOutputs.length
          const range = await counterSource.reserve(FEE_KEYSET_ID, count)
          onCountersReserved?.({
            keysetId: FEE_KEYSET_ID,
            start: range.start,
            count: range.count,
            next: range.start + range.count,
          })
          let counter = range.start
          const deterministicOutputs = (templates: readonly OutputData[]) =>
            templates.map((template) => {
              return OutputData.createSingleDeterministicData(
                template.blindedMessage.amount,
                walletSeed,
                counter++,
                FEE_KEYSET_ID,
              )
            })
          const preparedSendOutputs = deterministicOutputs(sendOutputs)
          const preparedKeepOutputs = deterministicOutputs(keepOutputs)
          const sendProofs = preparedSendOutputs.map((output) => signProof(output))
          const keepProofs = preparedKeepOutputs.map((output) => signProof(output))
          preparedProofs = { keep: keepProofs, send: sendProofs }
          for (const [index, output] of preparedSendOutputs.entries()) {
            proofByBlindedMessage.set(output.blindedMessage.B_, sendProofs[index]!)
          }
          for (const [index, output] of preparedKeepOutputs.entries()) {
            proofByBlindedMessage.set(output.blindedMessage.B_, keepProofs[index]!)
          }
          return {
            amount: Amount.from(amountMsat),
            fees: Amount.zero(),
            keysetId: FEE_KEYSET_ID,
            inputs: [...proofs],
            sendOutputs: preparedSendOutputs,
            keepOutputs: preparedKeepOutputs,
            unselectedProofs: [],
          }
        },
        completeSwap: async () => {
          completedSwaps += 1
          if (completedSwaps > 1) throw new Error('registration fee wallet debit repeated')
          return preparedProofs
        },
        checkProofsStates: async (proofs) =>
          proofs.map((proof) => ({
            Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
            state: mintSpent ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
            witness: null,
          })),
        getKeyset: (keysetId) => {
          if (keysetId !== undefined && keysetId !== FEE_KEYSET_ID) {
            throw new Error('registration fee fixture keyset is missing')
          }
          return {
            id: FEE_KEYSET_ID,
            keys: FEE_KEYS,
            unit: 'msat',
            fee: 0,
            verify: () => true,
          }
        },
      }
      return wallet
    },
    markMintSpent() {
      mintSpent = true
    },
    stats: () => ({ prepareCalls, completedSwaps }),
  }
}

function signProof(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    FEE_PRIVATE_KEY,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), FEE_PRIVATE_KEY)
  const proof = output.toProof(
    {
      id: output.blindedMessage.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: output.blindedMessage.id, keys: FEE_KEYS },
  )
  return proof
}

function conditionIdFor(input: NativeMarketCreationInput): string {
  return deriveDlcConditionId({
    eventId: input.eventId,
    outcomeCount: input.market.outcomeDetails.length,
    oraclePublicKeys: [ORACLE_PUBKEY],
  })
}

function marketRecord(conditionId: string, market: MarketCreationInput): Record<string, unknown> {
  return {
    conditionId,
    creatorPubkey: CREATOR_PUBKEY,
    outcomes: market.outcomeDetails.map(({ name }) => name),
    baseAsset: 'sat',
    divisibility: 1_000,
    thumbnailUrl: null,
    outcomeDetails: market.outcomeDetails.map(({ name, color }) => ({
      name,
      color: typeof color === 'string' ? color.toUpperCase() : null,
    })),
  }
}

function creationInput(creationId: string, market: MarketCreationInput): NativeMarketCreationInput {
  return {
    creationId,
    eventId: `event-${creationId}`,
    market,
    registration: { requiredFeeMsat: 0 },
    destination: {
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      relayUrls: ['wss://relay.example'],
    },
  }
}

function binaryMarket(): MarketCreationInput {
  return {
    title: 'Will it rain?',
    description: 'A yes-or-no market.',
    outcomeType: 'yesno',
    outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
    maturityEpoch: 2_000_000_000,
    categoryTags: ['Weather'],
    baseAsset: 'sat',
  }
}

function categoricalMarket(): MarketCreationInput {
  return {
    title: 'Tomorrow weather',
    description: 'Choose the forecast.',
    outcomeType: 'categorical',
    outcomeDetails: [
      { name: 'Rain', color: '#aabbcc' },
      { name: 'Snow', color: '#ddeeff' },
      { name: 'Clear' },
    ],
    maturityEpoch: 2_000_000_100,
    categoryTags: ['Weather', 'Forecast'],
    baseAsset: 'sat',
  }
}
