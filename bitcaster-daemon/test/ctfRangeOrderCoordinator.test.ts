import {
  recoverAllDaemonWalletFromSeed,
  type AllKeysetSeedRecoveryTransport,
} from '../src/emergencySeedRecovery.ts'
import { loadCtfRangeMintMetadata } from '@bitcaster-market/client-sdk/ctfRangeMintMetadata'
import {
  buildPersistedCtfRangeOrderPreparation,
  deriveCounterCtfRangeIdentity,
  createCtfRangePreparationIntent,
  decodeCtfRangeOrderPreparationFromRecord,
  encodePersistedCtfRangeOrderPreparation,
  selectCtfRangePreparationForIntent,
} from '@bitcaster-market/client-sdk/ctfRangeOrderProtocol'
import {
  readRangePreparationHistoryByClientOrderId,
  toSdkRangePreparationRecord,
} from '../src/ctfRangeOrderJournalSqlite.ts'

import {
  mintDenominationKeys,
  mintDenominationPrivateKey,
} from '../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts'
import { signedCtfRegistrationFixture } from '../../bitcaster-client-sdk/test/support/ctfAnnouncementFixture.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import test from 'node:test'
import {
  Amount,
  MintOperationError,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  selectCtfRangeAmounts,
  hashToCurve,
  type CtfConvertRequest,
  type CtfConvertResponse,
  type MintKeys,
  type Proof,
  type SerializedBlindedMessage,
  type SwapRequest,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyProofId,
  deriveDurableCustodyWalletId,
  deriveDurableCustodyArtifactFingerprint,
} from '@bitcaster-market/client-sdk'
import {
  createDeterministicDurableCtfRangeRefundOutputs,
  createDurableCtfRangeRefundOperation,
  deriveDurableCtfRangeFeeBounds,
  deriveDurableCtfRangeRefundOperationId,
  createDurableCtfRangeResultEnvelope,
  deriveRootCtfOutcomeCollectionId,
  type DurableCtfRangeOperation,
} from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  decodeSettlementCapabilityArtifactBytes,
  deriveSettlementCapabilityArtifactDigest,
} from '@bitcaster-market/client-sdk/settlementCapabilityArtifact'
import { CtfRangeMintRecoveryAdapter } from '@bitcaster-market/client-sdk/ctfRangeRecoveryTransport'
import type {
  CreateSettlementCapabilityRequest,
  SettlementCapabilityResultResponse,
  SettlementCapabilityResponse,
} from '@bitcaster-market/client-sdk/engineClient'
import {
  DaemonCtfRangeOrderCoordinator,
  type DaemonCtfRangeOrderCoordinatorDependencies,
} from '../src/ctfRangeOrderCoordinator.ts'
import { DaemonCtfRangeCoordinator } from '../src/ctfRangeCoordinator.ts'
import { createCtfRangeRecoveryLoop } from '../src/ctfRangeRecoveryLoop.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease, type CustodyScopeFence } from '../src/profileFencing.ts'
import {
  reserveDaemonCtfPreparation,
  reserveDaemonKeysetCounter,
  completeCtfRangeRefundProofOperationFromDatabase,
  prepareCtfRangeRefundProofOperationFromDatabase,
  emptyDaemonState,
  readAvailableCanonicalWalletProofPageFromDatabase,
  readAvailableWalletProofsFenced,
  readState,
  recordOrderStatus,
  recordSubmittedOrder,
  writeState,
  type StoredProofAsset,
} from '../src/state.ts'
import { createDaemonStateSqliteSession, openDaemonStateSqlite } from '../src/stateSqlite.ts'
import {
  DurableCustodySqliteStore,
  type CustodyProofSqliteRow,
} from '../src/durableCustodySqliteStore.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import type { EngineClientLike, PrepareSettlementCapabilityInput } from '../src/server.ts'
import {
  createDaemonCounterSource,
  deserializeOutputGroups,
  serializeOutputDataArray,
} from '../src/walletOps.ts'
import { DaemonDurableOutgoingCashuCoordinator } from '../src/durableOutgoingCashuCoordinator.ts'

const REGISTERED_CONDITION = signedCtfRegistrationFixture(['YES', 'NO'], 'range-coordinator-test')
const CONDITION_ID = REGISTERED_CONDITION.condition_id
const COORDINATOR_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const ROTATED_COORDINATOR_KEY = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = `02${'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}`
const ROTATED_MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 2])
const KEYS = mintDenominationKeys(
  MINT_PRIVATE_KEY,
  Array.from({ length: 15 }, (_, index) => (1 << index).toString()),
)
const ROTATED_KEYS = mintDenominationKeys(ROTATED_MINT_PRIVATE_KEY, Object.keys(KEYS))
const INPUT_FEE_PPK = 100
const FINAL_EXPIRY = 2_000
const OFFER_KEYSET_ID = deriveKeysetId(KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
})
const ROTATED_OFFER_KEYSET_ID = deriveKeysetId(ROTATED_KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
})
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: 'YES',
})
const RECEIVE_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})
const COMPLEMENT_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: 'NO',
})
const COMPLEMENT_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
})
const WALLET_SEED_HEX = '11'.repeat(64)
const MINT_URL = 'https://mint.example'
const ORDER_ID = '00000000-0000-8000-8000-000000000001'
const CAPABILITY_ARTIFACT_ID = '00000000-0000-4000-8000-000000000002'
const SETTLEMENT_GROUP_ID = '00000000-0000-4000-8000-000000000004'

test('fresh preparation refuses foreign returned binding authority and lost owner', async (t) => {
  for (const mode of [
    'scope',
    'scope-kind',
    'custody-operation',
    'range-operation',
    'body',
    'owner',
  ] as const) {
    await t.test(mode, async (t) => {
      const sourceProof = signedProof(
        OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!,
      )
      await withDaemonProfile(
        {
          prefix: 'bitcaster-returned-authority-',
          incarnationId: 'returned-authority',
          proofs: [sourceProof],
          asset: regularAsset(),
        },
        async ({ directory, fence }) => {
          const originalBind = DaemonCtfRangeCoordinator.prototype.bindPreparedSource
          let ownerLost = false
          t.mock.method(
            DaemonCtfRangeCoordinator.prototype,
            'bindPreparedSource',
            async function (
              this: DaemonCtfRangeCoordinator,
              input: Parameters<typeof originalBind>[0],
            ) {
              const loaded = await originalBind.call(this, input)
              const value = structuredClone(loaded)
              if (mode === 'scope')
                return {
                  ...value,
                  record: { ...value.record, scope: { ...value.record.scope, scopeId: 'foreign' } },
                }
              if (mode === 'scope-kind')
                return {
                  ...value,
                  record: {
                    ...value.record,
                    scope: { ...value.record.scope, scopeKind: 'foreign' },
                  },
                }
              if (mode === 'custody-operation')
                return {
                  ...value,
                  record: {
                    ...value.record,
                    operation: { ...value.record.operation, operationId: 'foreign' },
                  },
                }
              if (mode === 'range-operation')
                return { ...value, operation: { ...value.operation, operationId: 'foreign' } }
              if (mode === 'body') return { ...value, requestBody: {} }
              ownerLost = true
              return value
            },
          )
          let capabilityCalls = 0
          const ids = ['returned-operation', 'returned-authorization']
          const coordinator = new DaemonCtfRangeOrderCoordinator(
            directory,
            () => {
              if (ownerLost) throw new Error('owner-lost')
              return fence
            },
            {
              createMint: () => fakeMint(),
              createWallet: () => new FakeWallet([sourceProof]),
              now: () => 10_000,
              randomId: () => ids.shift()!,
            },
          )
          await assert.rejects(
            coordinator.prepare(
              orderRequest(),
              fakeEngineClient((request) => {
                capabilityCalls++
                return boundCapability(request)
              }),
            ),
            mode === 'owner' ? /owner-lost/ : /authority is missing or foreign/,
          )
          assert.equal(capabilityCalls, 0)
        },
      )
    })
  }
})

test('daemon fence takeover during an uncommitted preview prevents source counters and reservations', async () => {
  const proof = cashProof(8_192)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-source-preview-fence-',
      incarnationId: 'source-preview-fence-test',
      proofs: [proof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let notifyPreviewStarted!: () => void
      let releasePreview!: () => void
      const previewStarted = new Promise<void>((resolve) => {
        notifyPreviewStarted = resolve
      })
      const previewGate = new Promise<void>((resolve) => {
        releasePreview = resolve
      })
      const wallet = new FakeWallet([proof])
      wallet.beforePrepareSwap = async () => {
        notifyPreviewStarted()
        await previewGate
      }
      let capabilityCalls = 0
      const client = fakeEngineClient((request) => {
        capabilityCalls += 1
        return boundCapability(request)
      })
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: randomIds('source-preview-fence'),
      })
      const preparing = coordinator.prepare(orderRequest(), client)
      let startupTimeout: ReturnType<typeof setTimeout>
      await Promise.race([
        previewStarted,
        new Promise<never>((_, reject) => {
          startupTimeout = setTimeout(
            () => reject(new Error('source preview did not reach the barrier')),
            5_000,
          )
        }),
      ])
      clearTimeout(startupTimeout!)
      const beforeTakeover = await openDaemonStateSqlite(directory)
      const countersBefore = {
        target: beforeTakeover
          .prepare('SELECT keyset_id, next_counter FROM target_keyset_counters ORDER BY keyset_id')
          .all(),
        custody: beforeTakeover
          .prepare('SELECT keyset_id, next_counter FROM custody_keyset_counters ORDER BY keyset_id')
          .all(),
      }
      beforeTakeover.close()
      await claimCustodyScopeLease(directory, {
        scopeId: fence.scopeId,
        incarnationId: 'source-preview-fence-successor',
        observedAtMs: fence.leaseExpiresAtMs,
      })
      releasePreview()
      await assert.rejects(preparing, /stale or expired authority/)
      assert.equal(wallet.completeCalls, 0)
      assert.equal(capabilityCalls, 0)
      const state = await readState()
      assert.equal(state?.wallet.proofs[0]?.state, 'available')
      assert.equal(
        state?.proofOperations[(await counterRangeId(directory, 'client-order-1')) + ':source'],
        undefined,
      )
      const database = await openDaemonStateSqlite(directory)
      try {
        assert.deepEqual(
          database
            .prepare(
              'SELECT keyset_id, next_counter FROM target_keyset_counters ORDER BY keyset_id',
            )
            .all(),
          countersBefore.target,
        )
        assert.deepEqual(
          database
            .prepare(
              'SELECT keyset_id, next_counter FROM custody_keyset_counters ORDER BY keyset_id',
            )
            .all(),
          countersBefore.custody,
        )
        assert.equal(
          database.prepare('SELECT count(*) AS count FROM custody_proof_reservations').get()?.count,
          0,
        )
      } finally {
        database.close()
      }
    },
  )
})

test('daemon discards a failed source draft without committing its counter transcript', async () => {
  const proof = cashProof(8_192)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-source-draft-failure-',
      incarnationId: 'source-draft-failure-test',
      proofs: [proof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const readCounters = async () => {
        const database = await openDaemonStateSqlite(directory)
        try {
          const rows = (table: 'target_keyset_counters' | 'custody_keyset_counters') =>
            database
              .prepare(
                `SELECT normalized_mint, unit, keyset_id, next_counter FROM ${table}
                 ORDER BY normalized_mint, unit, keyset_id`,
              )
              .all()
              .map((row) => Object.values(row as Record<string, unknown>))
          return {
            target: rows('target_keyset_counters'),
            custody: rows('custody_keyset_counters'),
          }
        } finally {
          database.close()
        }
      }
      let countersAtPreview: Awaited<ReturnType<typeof readCounters>> | undefined
      const wallet = new FakeWallet([proof])
      wallet.beforePrepareSwap = async () => {
        countersAtPreview = await readCounters()
        throw new Error('source draft preview failed')
      }
      let capabilityCalls = 0
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: randomIds('source-draft-failure'),
      })
      await assert.rejects(
        coordinator.prepare(
          orderRequest(),
          fakeEngineClient((request) => {
            capabilityCalls += 1
            return boundCapability(request)
          }),
        ),
        /source draft preview failed/,
      )
      assert.ok(countersAtPreview)
      assert.deepEqual(await readCounters(), countersAtPreview)
      assert.equal(wallet.completeCalls, 0)
      assert.equal(capabilityCalls, 0)
      const state = await readState()
      assert.equal(
        state?.proofOperations[(await counterRangeId(directory, 'client-order-1')) + ':source'],
        undefined,
      )
      assert.equal(state?.wallet.proofs[0]?.state, 'available')
      const database = await openDaemonStateSqlite(directory)
      try {
        assert.equal(
          database.prepare('SELECT count(*) AS count FROM custody_proof_reservations').get()?.count,
          0,
        )
      } finally {
        database.close()
      }
    },
  )
})

test('daemon rebuilds a source draft after a counter conflict and commits after the reserved range', async () => {
  const proof = cashProof(8_192)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-source-counter-conflict-',
      incarnationId: 'source-counter-conflict-test',
      proofs: [proof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet([proof])
      let committedReservation: { start: number; count: number } | undefined
      let retryStart: number | undefined
      wallet.beforePrepareSwap = async () => {
        if (wallet.prepareSwapDrafts.length !== 0) {
          const database = await openDaemonStateSqlite(directory)
          try {
            const row = database
              .prepare(
                `SELECT next_counter FROM target_keyset_counters
                 WHERE normalized_mint=? AND unit=? AND keyset_id=?`,
              )
              .get(MINT_URL, 'msat', OFFER_KEYSET_ID) as { next_counter: number } | undefined
            assert.ok(row)
            retryStart = row.next_counter
          } finally {
            database.close()
          }
          return
        }
        committedReservation = await reserveDaemonKeysetCounter(
          OFFER_KEYSET_ID,
          1,
          { fence, observedAtMs: 10_000 },
          { normalizedMint: MINT_URL, unit: 'msat' },
        )
      }
      const client = fakeEngineClient(boundCapability)
      const preview = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => {
          throw new Error('fee preview must not create a wallet')
        },
        now: () => 10_000,
        randomId: randomIds('source-counter-conflict-preview'),
      })
      const consent = await preview.previewFeeFacts(orderRequest(), client)
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: randomIds('source-counter-conflict'),
      })

      const prepared = await coordinator.prepare(orderRequest(), client, undefined, consent)

      assert.equal(prepared.operationId, await counterRangeId(directory))
      assert.equal(wallet.prepareSwapDrafts.length, 2)
      assert.ok(committedReservation)
      assert.deepEqual(wallet.prepareSwapDrafts[0]!.inputSecrets, [proof.secret])
      assert.deepEqual(wallet.prepareSwapDrafts[1]!.inputSecrets, [proof.secret])
      assert.ok(wallet.prepareSwapDrafts[0]!.sendBlindedMessages.length > 0)
      assert.ok(wallet.prepareSwapDrafts[1]!.sendBlindedMessages.length > 0)
      assert.ok(wallet.prepareSwapDrafts[0]!.keepBlindedMessages.length > 0)
      assert.ok(wallet.prepareSwapDrafts[1]!.keepBlindedMessages.length > 0)
      assert.ok(retryStart !== undefined)
      assert.equal(
        retryStart,
        committedReservation.start + committedReservation.count,
        'the retry snapshots the cursor immediately after the concurrent committed range',
      )
      assert.deepEqual(
        wallet.prepareSwapDrafts[0]!.sendBlindedMessages,
        wallet.prepareSwapDrafts[1]!.sendBlindedMessages,
        'authorization outputs remain fixed across retries',
      )
      const sourceOperationId = `${prepared.operationId}:source`
      const persisted = (await readState())?.proofOperations[sourceOperationId]
      assert.ok(persisted)
      const reservation = await openDaemonStateSqlite(directory)
      try {
        const committedCounter = reservation
          .prepare(
            `SELECT next_counter FROM target_keyset_counters
             WHERE normalized_mint=? AND unit=? AND keyset_id=?`,
          )
          .get(MINT_URL, 'msat', OFFER_KEYSET_ID) as { next_counter: number }
        assert.ok(committedCounter)
        assert.equal(
          committedCounter.next_counter,
          retryStart + persisted.outputs.keep!.length,
          'the winning source range starts at the retry snapshot and advances by exactly its keep-output allocation',
        )
      } finally {
        reservation.close()
      }
      assert.deepEqual(
        persisted.outputs.keep?.map((output) => output.blindedMessage.B_),
        wallet.prepareSwapDrafts[1]!.keepBlindedMessages,
        'the exact rebuilt change outputs are the ones persisted',
      )
      assert.equal(wallet.completeCalls, 1)
      await assertCounterAuthorityPairs(directory)
    },
  )
})

test('daemon same-operation source race replays the exact committed journal once', async () => {
  const proof = cashProof(8_192)
  let concurrentNextCounter = 0
  let concurrentOutputs: unknown
  await withDaemonProfile(
    {
      prefix: 'bitcaster-source-same-operation-race-',
      incarnationId: 'source-same-operation-race-test',
      proofs: [proof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet([proof])
      let callbacks = 0
      let timedOut = false
      let releaseCallbacks!: () => void
      const callbackGate = new Promise<void>((resolve) => {
        releaseCallbacks = resolve
      })
      const repeatedIds = ['source-same-operation-operation', 'source-same-operation-authorization']
      let randomIdCall = 0
      let timeout: ReturnType<typeof setTimeout> | undefined
      const beforeCreateCapability = async () => {
        callbacks += 1
        if (callbacks === 1) {
          // Bound only the wait for the second call. The preparation before the barrier is
          // CPU-bound, and a parallel test run can make it take longer than this bound.
          timeout = setTimeout(() => {
            timedOut = true
            releaseCallbacks()
          }, 5_000)
        }
        if (callbacks === 2) {
          clearTimeout(timeout)
          releaseCallbacks()
        }
        await callbackGate
        throw new Error('stop after source commit')
      }
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => repeatedIds[randomIdCall++ % repeatedIds.length]!,
      })
      let capabilityCalls = 0
      const client = fakeEngineClient((request) => {
        capabilityCalls += 1
        return boundCapability(request)
      })
      const databaseBefore = await openDaemonStateSqlite(directory)
      let counterBefore: number
      try {
        const row = databaseBefore
          .prepare(
            `SELECT next_counter FROM target_keyset_counters
             WHERE normalized_mint=? AND unit=? AND keyset_id=?`,
          )
          .get(MINT_URL, 'msat', OFFER_KEYSET_ID) as { next_counter: number } | undefined
        counterBefore = row?.next_counter ?? 0
      } finally {
        databaseBefore.close()
      }
      const results = await Promise.allSettled([
        coordinator.prepare(orderRequest(), client, beforeCreateCapability),
        coordinator.prepare(orderRequest(), client, beforeCreateCapability),
      ])
      clearTimeout(timeout)

      assert.equal(timedOut, false, 'both same-operation calls must reach the post-commit barrier')
      assert.equal(callbacks, 2)
      assert.deepEqual(
        results.map((result) => result.status),
        ['rejected', 'rejected'],
      )
      for (const result of results) {
        assert.equal(result.status, 'rejected')
        if (result.status === 'rejected') {
          assert.match(String(result.reason), /stop after source commit/)
        }
      }
      assert.equal(wallet.prepareSwapDrafts.length, 2)
      assert.deepEqual(
        wallet.prepareSwapDrafts[0]!.keepBlindedMessages,
        wallet.prepareSwapDrafts[1]!.keepBlindedMessages,
        'the duplicate operation starts from the same snapshot and reconstructs the same draft',
      )
      assert.equal(wallet.completeCalls, 1)
      assert.equal(capabilityCalls, 0)

      const source = (await readState())?.proofOperations[
        `${await counterRangeId(directory)}:source`
      ]
      assert.ok(source)
      assert.equal(source.state, 'completed')
      concurrentOutputs = source.outputs
      const databaseAfter = await openDaemonStateSqlite(directory)
      try {
        const row = databaseAfter
          .prepare(
            `SELECT next_counter FROM target_keyset_counters
             WHERE normalized_mint=? AND unit=? AND keyset_id=?`,
          )
          .get(MINT_URL, 'msat', OFFER_KEYSET_ID) as { next_counter: number }
        assert.ok(row)
        assert.ok(row.next_counter > counterBefore)
        concurrentNextCounter = row.next_counter
      } finally {
        databaseAfter.close()
      }
      await assertCounterAuthorityPairs(directory)
    },
  )

  await withDaemonProfile(
    {
      prefix: 'bitcaster-source-same-operation-control-',
      incarnationId: 'source-same-operation-control-test',
      proofs: [proof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet([proof])
      const repeatedIds = ['source-same-operation-operation', 'source-same-operation-authorization']
      let randomIdCall = 0
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => repeatedIds[randomIdCall++ % repeatedIds.length]!,
      })
      await assert.rejects(
        coordinator.prepare(orderRequest(), fakeEngineClient(boundCapability), async () => {
          throw new Error('stop after source commit')
        }),
        /stop after source commit/,
      )
      const source = (await readState())?.proofOperations[
        `${await counterRangeId(directory)}:source`
      ]
      assert.ok(source)
      assert.deepEqual(source.outputs, concurrentOutputs)
      const database = await openDaemonStateSqlite(directory)
      try {
        const row = database
          .prepare(
            `SELECT next_counter FROM target_keyset_counters
             WHERE normalized_mint=? AND unit=? AND keyset_id=?`,
          )
          .get(MINT_URL, 'msat', OFFER_KEYSET_ID) as { next_counter: number }
        assert.ok(row)
        assert.equal(
          concurrentNextCounter,
          row.next_counter,
          'racing identical calls commit the same single allocation as one ordinary call',
        )
      } finally {
        database.close()
      }
    },
  )
})

for (const faultPhase of ['before-commit', 'after-commit'] as const) {
  test(`daemon source journal ${faultPhase} fault rolls back or replays the exact transaction`, async () => {
    const proof = cashProof(8_192)
    await withDaemonProfile(
      {
        prefix: 'bitcaster-source-journal-transaction-',
        incarnationId: `source-journal-${faultPhase}`,
        proofs: [proof],
        asset: regularAsset(),
      },
      async ({ directory, fence }) => {
        const readCounters = async () => {
          const database = await openDaemonStateSqlite(directory)
          try {
            return {
              target: database
                .prepare(
                  `SELECT normalized_mint, unit, keyset_id, next_counter
                   FROM target_keyset_counters ORDER BY normalized_mint, unit, keyset_id`,
                )
                .all(),
              custody: database
                .prepare(
                  `SELECT normalized_mint, unit, keyset_id, next_counter
                   FROM custody_keyset_counters ORDER BY normalized_mint, unit, keyset_id`,
                )
                .all(),
            }
          } finally {
            database.close()
          }
        }
        let countersBeforeSourceTransaction: Awaited<ReturnType<typeof readCounters>> | undefined
        let countersAtLostCommitReply: Awaited<ReturnType<typeof readCounters>> | undefined
        const wallet = new FakeWallet([proof])
        wallet.checkProofsStates = async (proofs) =>
          proofs.map(({ secret }) => ({ Y: secret, state: 'UNSPENT' as const }))
        wallet.beforePrepareSwap = async () => {
          countersBeforeSourceTransaction = await readCounters()
        }
        let injected = false
        const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => fakeMint(),
          createWallet: () => wallet,
          now: () => 10_000,
          randomId: randomIds(`source-journal-${faultPhase}`),
          injectRangeUnitOfWorkFault: (phase) => {
            if (!injected && phase === faultPhase) {
              injected = true
              if (phase === 'after-commit') {
                const committed = new DatabaseSync(join(directory, 'daemon-state.sqlite'))
                try {
                  countersAtLostCommitReply = {
                    target: committed
                      .prepare(
                        `SELECT normalized_mint, unit, keyset_id, next_counter
                         FROM target_keyset_counters
                         ORDER BY normalized_mint, unit, keyset_id`,
                      )
                      .all(),
                    custody: committed
                      .prepare(
                        `SELECT normalized_mint, unit, keyset_id, next_counter
                         FROM custody_keyset_counters
                         ORDER BY normalized_mint, unit, keyset_id`,
                      )
                      .all(),
                  }
                } finally {
                  committed.close()
                }
              }
              throw new Error(`source transaction ${faultPhase} fault`)
            }
          },
        })
        const client = fakeEngineClient(boundCapability)

        if (faultPhase === 'before-commit') {
          await assert.rejects(coordinator.prepare(orderRequest(), client), /before-commit fault/)
          assert.ok(countersBeforeSourceTransaction)
          assert.deepEqual(await readCounters(), countersBeforeSourceTransaction)
        } else {
          await coordinator.prepare(orderRequest(), client)
          assert.ok(injected, 'the source transaction commit reply fault must run')
          assert.deepEqual(await readCounters(), countersAtLostCommitReply)
        }

        const sourceOperationId = `${await counterRangeId(directory)}:source`
        const state = await readState()
        const sourceOperation = state?.proofOperations[sourceOperationId]
        const database = await openDaemonStateSqlite(directory)
        try {
          const sourceLinks = database
            .prepare(
              `SELECT source_operation_id AS sourceOperationId, reservation_id AS reservationId
               FROM daemon_ctf_range_sources WHERE range_operation_id = ?`,
            )
            .all(await counterRangeId(directory)) as Array<{
            sourceOperationId: string
            reservationId: string
          }>
          const reservedInput = database
            .prepare(
              `SELECT state, reserved_by AS reservedBy FROM target_wallet_proofs
               WHERE scope_id = ? AND normalized_mint = ? AND secret = ?`,
            )
            .get(fence.scopeId, MINT_URL, proof.secret) as
            | { state: string; reservedBy: string | null }
            | undefined
          if (faultPhase === 'before-commit') {
            assert.equal(sourceOperation, undefined)
            assert.deepEqual(sourceLinks, [])
            assert.equal(reservedInput?.state, 'available')
            assert.equal(reservedInput?.reservedBy, null)
            assert.equal(
              database.prepare('SELECT count(*) AS count FROM custody_operations').get()?.count,
              0,
            )
            assert.equal(
              database.prepare('SELECT count(*) AS count FROM custody_proof_reservations').get()
                ?.count,
              0,
            )
          } else {
            assert.ok(sourceOperation)
            assert.equal(sourceOperation.state, 'completed')
            assert.equal(sourceLinks.length, 1)
            assert.equal(sourceLinks[0]?.sourceOperationId, sourceOperationId)
            assert.ok(sourceLinks[0]?.reservationId)
            assert.equal(
              reservedInput,
              undefined,
              'successful exact replay completes the source and consumes its target proof',
            )
            assert.ok(Object.values(sourceOperation.outputs).some((outputs) => outputs.length > 0))
            assert.equal(wallet.prepareSwapDrafts.length, 1)
            assert.equal(wallet.completeCalls, 1)
            const targetCounters = database
              .prepare(
                `SELECT normalized_mint, unit, keyset_id, next_counter
                 FROM target_keyset_counters ORDER BY normalized_mint, unit, keyset_id`,
              )
              .all()
            const custodyCounters = database
              .prepare(
                `SELECT normalized_mint, unit, keyset_id, next_counter
                 FROM custody_keyset_counters ORDER BY normalized_mint, unit, keyset_id`,
              )
              .all()
            assert.deepEqual(targetCounters, custodyCounters)
          }
        } finally {
          database.close()
        }
        assert.equal(injected, true)
      },
    )
  })
}

test('daemon retries the exact capability request after its acknowledgement is lost', async (t) => {
  const originalBind = DaemonCtfRangeCoordinator.prototype.bindPreparedSource
  let boundRequest: unknown
  t.mock.method(
    DaemonCtfRangeCoordinator.prototype,
    'bindPreparedSource',
    async function (this: DaemonCtfRangeCoordinator, input: Parameters<typeof originalBind>[0]) {
      const authority = await originalBind.call(this, input)
      boundRequest = authority.requestBody
      return authority
    },
  )
  const originalLoad = DaemonCtfRangeCoordinator.prototype.load
  let loads = 0
  t.mock.method(
    DaemonCtfRangeCoordinator.prototype,
    'load',
    async function (this: DaemonCtfRangeCoordinator, id: string) {
      loads++
      return originalLoad.call(this, id)
    },
  )
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-order-',
      incarnationId: 'range-order-production-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet([sourceProof])
      const mint = fakeMint()
      const posted: CreateSettlementCapabilityRequest[] = []
      const callOrder: string[] = []
      const requiredScores: number[] = []
      const phases: import('../src/orderTimeline.ts').OrderTimelineObservation[] = []
      let createAttempts = 0
      const client = fakeEngineClient((request) => {
        assert.notStrictEqual(request, boundRequest)
        assert.ok(isDeepStrictEqual(request, boundRequest), 'exact capability request changed')
        callOrder.push('create-capability')
        posted.push(structuredClone(request))
        createAttempts += 1
        if (createAttempts === 1) throw new Error('capability acknowledgement lost')
        return boundCapability(request)
      })
      const ids = ['range-operation-1', 'range-authorization-1']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        observeOrderTimeline: (observation) => {
          phases.push(observation)
        },
        createMint: () => mint,
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })

      for (const bounds of [
        { maxQuotePaymentSubunits: null, minQuotePaymentSubunits: null },
        { maxQuotePaymentSubunits: -1, minQuotePaymentSubunits: null },
        { maxQuotePaymentSubunits: null, minQuotePaymentSubunits: 500 },
        { maxQuotePaymentSubunits: 500, minQuotePaymentSubunits: 500 },
      ]) {
        await assert.rejects(
          coordinator.prepare({ ...orderRequest(), ...bounds }, client),
          /bound is invalid/,
        )
        assert.equal(wallet.completeCalls, 0)
        assert.equal(createAttempts, 0)
      }

      await assert.rejects(
        coordinator.prepare(orderRequest(), client, async (requiredScore) => {
          callOrder.push('fund-score')
          assert.deepEqual(
            phases
              .filter(({ phase }) => !phase.startsWith('preparation-'))
              .map(({ phase }) => phase),
            ['preparation'],
          )
          requiredScores.push(requiredScore)
        }),
        /capability acknowledgement lost/,
      )
      // Initial absence check + postcommit validated load. No third duplicate load.
      assert.equal(loads, 2)
      assert.equal(wallet.completeCalls, 1)
      const topLevelPhases = phases.filter(({ phase }) => !phase.startsWith('preparation-'))
      assert.deepEqual(
        topLevelPhases.map(({ phase, outcome }) => [phase, outcome]),
        [
          ['preparation', 'success'],
          ['score-admission', 'success'],
          ['capability-admission', 'failed'],
        ],
      )
      assert.equal(topLevelPhases[0]!.endedUtc <= topLevelPhases[1]!.startedUtc, true)
      assert.equal(topLevelPhases[1]!.endedUtc <= topLevelPhases[2]!.startedUtc, true)
      const preparationSteps = phases.filter(({ phase }) => phase.startsWith('preparation-'))
      assert.deepEqual(
        preparationSteps.map(({ phase }) => phase).sort(),
        [
          'preparation-mint-authority',
          'preparation-policy-read',
          'preparation-mint-read',
          'preparation-market-read',
          'preparation-wallet-source',
          'preparation-authorization-binding',
          'preparation-durable-bind',
          'preparation-exact-request',
        ].sort(),
      )
      for (const step of preparationSteps) {
        assert.equal(step.outcome, 'success')
        assert.ok(Number.isFinite(step.elapsedMs) && step.elapsedMs >= 0)
        assert.ok(step.startedUtc >= topLevelPhases[0]!.startedUtc)
        assert.ok(step.endedUtc <= topLevelPhases[0]!.endedUtc)
        assert.equal(step.clientOrderId, orderRequest().clientOrderId)
        assert.equal(step.operationId, null)
        assert.equal(step.orderId, null)
        assert.equal(step.groupId, null)
        assert.equal(step.groupRevision, null)
      }
      const committed = await readState()
      assert.equal(
        committed?.wallet.proofs.some(({ proof }) => proof.secret === sourceProof.secret),
        false,
      )
      assert.equal(
        committed?.wallet.proofs.reduce((total, { proof }) => total + Number(proof.amount), 0),
        7_690,
      )
      assert.equal(
        committed?.proofOperations[(await counterRangeId(directory, 'client-order-1')) + ':source']
          ?.state,
        'completed',
      )
      assert.deepEqual(committed?.orders, {})

      const restarted = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => mint,
        createWallet: () => {
          throw new Error('restart must reuse prepared wallet state')
        },
        now: () => 10_000,
      })
      const recovered = await restarted.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(recovered.recovered, [])
      assert.equal(recovered.pending.length, 1)
      assert.equal(recovered.pending[0]!.retryAtMs, 10_000)
      assert.equal(wallet.completeCalls, 1)
      assert.equal(posted.length, 2)
      assert.equal(posted[0]!.orderIntent.maxQuotePaymentSubunits, 500)
      assert.equal(posted[0]!.orderIntent.minQuotePaymentSubunits, null)
      assert.equal(posted[1]!.orderIntent.maxQuotePaymentSubunits, 500)
      assert.equal(posted[1]!.orderIntent.minQuotePaymentSubunits, null)
      assert.deepEqual(callOrder, ['fund-score', 'create-capability', 'create-capability'])
      assert.equal(requiredScores.length, 1)
      const artifactBytes = Buffer.from(posted[0]!.artifact, 'base64')
      const artifact = decodeSettlementCapabilityArtifactBytes(artifactBytes)
      assert.equal(
        requiredScores[0],
        1 +
          artifact.inputs.length +
          Math.ceil(artifact.manifest.entries.length / 16) +
          Math.ceil(artifactBytes.byteLength / 4_096),
      )
      assert.ok(
        isDeepStrictEqual(posted[1], posted[0]),
        'restart changed capability admission bytes',
      )
      assert.equal(JSON.stringify(posted[0]), canonicalJson(posted[0]))
      const database = await openDaemonStateSqlite(directory)
      const custodyRows = database
        .prepare(
          `SELECT operation_id, operation_state, result_state, revision
           FROM custody_operations WHERE semantic_kind = 'conditional-keyset-swap'`,
        )
        .all() as Array<{ operation_id: string }>
      database.close()
      assert.equal(custodyRows.length, 1)
      await assertSourceCustodyIdentity(directory, 'ctf-range-regular-source')
      const persistedAuthority = await new DaemonCtfRangeCoordinator(directory, fence).load(
        custodyRows[0]!.operation_id,
      )
      assert.ok(persistedAuthority)
      assert.equal(
        persistedAuthority.record.operation.exactRequest.requestFingerprint,
        deriveDurableCustodyArtifactFingerprint(posted[0]),
      )
      await assert.rejects(
        restarted.prepare({ ...orderRequest(), maxQuotePaymentSubunits: 501 }, client),
        /intent conflicts/,
      )
      assert.equal(posted.length, 2)

      const persisted = await readState()
      assert.deepEqual(persisted?.orders, {})
      const beforePendingRecovery = await rangeRecoverySnapshot(directory)
      const waiting = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(waiting.recovered, [])
      assert.equal(waiting.pending.length, 1)
      assert.match(waiting.pending[0]!.error, /remains unspent before expiry/)
      assert.ok(
        isDeepStrictEqual(await rangeRecoverySnapshot(directory), beforePendingRecovery),
        'pending recovery changed retained authority',
      )
      assert.equal(posted.length, 2)
      await assertSeedAbsentFromArtifacts(directory)
    },
  )
})

test(
  'replayed capability keeps recovery scheduled until exact expiry refund without order submission',
  { timeout: 30_000 },
  async () => {
    const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
    await withDaemonProfile(
      {
        prefix: 'bitcaster-range-retry-wake-',
        incarnationId: 'range-retry-wake',
        proofs: [sourceProof],
        asset: regularAsset(),
      },
      async ({ directory, fence }) => {
        let nowMs = 10_000
        let orderCalls = 0
        let refundCalls = 0
        const posted: CreateSettlementCapabilityRequest[] = []
        const wallet = new FakeWallet([sourceProof])
        const client = fakeEngineClient(
          (request) => {
            posted.push(structuredClone(request))
            if (posted.length === 1) throw new Error('capability acknowledgement lost')
            return boundCapability(request)
          },
          async () => {
            orderCalls += 1
            return submittedOrder()
          },
        )
        const ids = ['range-operation-retry-wake', 'range-authorization-retry-wake']
        const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => fakeMint(64, 1_000),
          createWallet: () => wallet,
          authorizationLifetimeSeconds: 20,
          executeRefundSwap: async (_mint, request) => {
            assert.ok(nowMs >= 30_000, 'refund must wait for the original expiry')
            refundCalls += 1
            return { signatures: request.outputs.map(signBlindedOutput) }
          },
          now: () => nowMs,
          randomId: () => ids.shift()!,
        })
        await assert.rejects(coordinator.prepare(orderRequest(), client), /acknowledgement lost/)
        const before = await openDaemonStateSqlite(directory)
        const original = before
          .prepare(
            `SELECT range_operation_id, source_operation_id, authorization_id,
        client_order_id, authorization_expires_at_unix_seconds, preparation_body
        FROM daemon_ctf_range_preparations`,
          )
          .get()
        before.close()
        type Pass = Awaited<ReturnType<typeof coordinator.recover>>
        type Timer = { callback: () => void; delayMs: number; cancelled: boolean }
        const timers: Timer[] = []
        let completion: ReturnType<typeof Promise.withResolvers<Pass>> | undefined
        const loop = createCtfRangeRecoveryLoop({
          recover: () => coordinator.recover(WALLET_SEED_HEX, client),
          now: () => nowMs,
          schedule: (callback, delayMs) => {
            const timer = { callback, delayMs, cancelled: false }
            timers.push(timer)
            return timer
          },
          cancel: (timer) => {
            ;(timer as Timer).cancelled = true
          },
          onResult: (result) => completion!.resolve(result),
          onError: (error) => completion!.reject(error),
        })
        const pass = async (start: () => void) => {
          completion = Promise.withResolvers<Pass>()
          start()
          return completion.promise
        }
        try {
          const rebound = await pass(() => loop.trigger())
          assert.deepEqual(rebound.recovered, [])
          assert.equal(rebound.pending.length, 1)
          assert.equal(timers.length, 1, 'capability binding must not stop the recovery loop')
          assert.equal(timers[0]!.delayMs, 0)
          assert.deepEqual(posted[1], posted[0], 'recovery must preserve the exact signed request')
          assert.equal(wallet.completeCalls, 1)
          assert.equal(orderCalls, 0)
          assert.equal(refundCalls, 0)

          const waiting = await pass(timers.shift()!.callback)
          assert.equal(waiting.pending.length, 1)
          assert.equal(waiting.pending[0]!.retryAtMs, 31_000)
          assert.equal(timers.length, 1)
          assert.equal(timers[0]!.delayMs, 21_000)
          assert.equal(refundCalls, 0)
          nowMs += timers[0]!.delayMs
          const finished = await pass(timers.shift()!.callback)
          assert.deepEqual(finished.pending, [])
          assert.deepEqual(finished.recovered, [
            (await counterRangeId(directory, 'client-order-1')) + ':source',
          ])
          assert.equal(timers.length, 0)
          assert.equal(posted.length, 2)
          assert.equal(wallet.completeCalls, 1)
          assert.equal(orderCalls, 0)
          assert.equal(refundCalls, 1)
          const db = await openDaemonStateSqlite(directory)
          try {
            assert.deepEqual(
              db
                .prepare(
                  `SELECT range_operation_id, source_operation_id, authorization_id,
            client_order_id, authorization_expires_at_unix_seconds, preparation_body
            FROM daemon_ctf_range_preparations`,
                )
                .get(),
              original,
            )
            assert.equal(
              db.prepare('SELECT lifecycle_state FROM daemon_ctf_range_preparations').get()
                ?.lifecycle_state,
              'terminal',
            )
            assert.equal(
              db
                .prepare(
                  "SELECT count(*) AS n FROM custody_operations WHERE operation_state NOT IN ('reconciled','aborted')",
                )
                .get()?.n,
              0,
            )
            assert.equal(
              db
                .prepare(
                  "SELECT count(*) AS n FROM custody_operations WHERE operation_state = 'aborted'",
                )
                .get()?.n,
              1,
            )
            assert.equal(
              db
                .prepare(
                  "SELECT count(*) AS n FROM target_wallet_proofs WHERE state <> 'available' AND retired_by_operation_id IS NULL",
                )
                .get()?.n,
              0,
            )
          } finally {
            db.close()
          }
          const state = await readState()
          assert.deepEqual(state?.orders, {})
          const refund = Object.values(state!.proofOperations).find(
            (operation) => operation.metadata.purpose === 'ctf-range-refund',
          )
          assert.equal(refund?.state, 'completed')
          // One source swap fee and one refund fee; the original 8,192 msat is otherwise available.
          assert.equal(
            state!.wallet.proofs.reduce((sum, { proof }) => sum + Number(proof.amount), 0),
            8_190,
          )
        } finally {
          loop.stop()
        }
      },
    )
  },
)

test('daemon retains a capped authorization after restart with a different cap', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-lifetime-',
      incarnationId: 'range-lifetime-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet([sourceProof])
      const posted: CreateSettlementCapabilityRequest[] = []
      const client = fakeEngineClient((request) => {
        posted.push(structuredClone(request))
        if (posted.length === 1) throw new Error('capability acknowledgement lost')
        return boundCapability(request)
      })
      const ids = ['range-lifetime-operation', 'range-lifetime-authorization']
      const dependencies = {
        createMint: () => fakeMint(),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => ids.shift()!,
      }
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        ...dependencies,
        authorizationLifetimeSeconds: 60,
      })
      await assert.rejects(coordinator.prepare(orderRequest(), client), /acknowledgement lost/)
      const first = decodeSettlementCapabilityArtifactBytes(
        Buffer.from(posted[0]!.artifact, 'base64'),
      )
      assert.equal(first.expiry, 70)
      const restarted = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        ...dependencies,
        authorizationLifetimeSeconds: 600,
      })
      const recovery = await restarted.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(recovery.recovered, [])
      assert.equal(recovery.pending.length, 1)
      assert.equal(recovery.pending[0]!.retryAtMs, 10_000)
      assert.equal(posted.length, 2)
      assert.ok(
        posted[0]!.artifact === posted[1]!.artifact,
        'replay changed the authorization artifact',
      )
      assert.equal(wallet.completeCalls, 1)
    },
  )
})

test('daemon does not consolidate fragmented order funds unless the caller opts in', async () => {
  const sourceProofs = [2, 2, 2, 2].map((amount) =>
    signedProof(OutputData.createRandomData(Amount.from(amount), mintKeys())[0]!),
  )
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-consolidation-off-',
      incarnationId: 'range-consolidation-off-test',
      proofs: sourceProofs,
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet(sourceProofs)
      let capabilityCalls = 0
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(3),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => 'range-operation-consolidation-off',
      })
      const client = fakeEngineClient((request) => {
        capabilityCalls += 1
        return boundCapability(request)
      })

      await assert.rejects(
        coordinator.prepare(
          {
            ...orderRequest(),
            price: 5,
            amountSubunits: 1_000,
            minimumFillAmountSubunits: 1_000,
          },
          client,
        ),
        /proofs exceed the mint input limit; retry with proof consolidation enabled/,
      )

      assert.equal(wallet.completeCalls, 0)
      assert.equal(capabilityCalls, 0)
      const state = await readState()
      assert.deepEqual(state?.proofOperations, {})
      assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
        recovered: [],
        pending: [],
      })
    },
  )
})

test('daemon previews full-exit source fees without persisting or spending', async () => {
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-fee-preview-',
      incarnationId: 'range-fee-preview-test',
      proofs: heldShareProofs(),
      asset: outcomeAsset(),
      cashProofs: [cashProof(64)],
    },
    async ({ directory, fence }) => {
      const mint = mixedSourceMint()
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => mint,
        createWallet: () => {
          throw new Error('fee preview must not create a swap wallet')
        },
        now: () => 10_000,
        randomId: randomIds('range-fee-preview'),
      })
      const facts = await coordinator.previewFeeFacts(
        sellOneShareRequest(),
        fakeEngineClient(boundCapability),
      )

      assert.equal(facts.sourceMode, 'mixed-source-ctf-convert')
      assert.equal(facts.sourcePreparationFeeSubunits, '1')
      assert.equal(facts.consolidationFeeSubunits, '0')
      assert.deepEqual(facts.sourcePreparationAsset, { kind: 'regular', unit: 'msat' })
      assert.deepEqual(facts.consolidationAsset, {
        kind: 'conditional',
        unit: 'msat',
        conditionId: CONDITION_ID,
        outcomeCollection: 'YES',
      })
      assert.equal(mint.convertRequests.length, 0)
      assert.deepEqual((await readState())?.proofOperations, {})
      const database = await openDaemonStateSqlite(directory)
      try {
        const preparations = database
          .prepare('SELECT COUNT(*) AS count FROM daemon_ctf_range_preparations')
          .get() as { count: number }
        assert.equal(preparations.count, 0)
      } finally {
        database.close()
      }
    },
  )
})

test('daemon accepts exact fee consent and refuses changed source fees before mint spend', async () => {
  const sourceProof = cashProof(8_192)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-fee-consent-',
      incarnationId: 'range-fee-consent-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet([sourceProof])
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: randomIds('range-fee-consent'),
      })
      const client = fakeEngineClient(boundCapability)
      const previewCoordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => {
          throw new Error('fee preview must not create a wallet')
        },
        now: () => 10_000,
        randomId: randomIds('range-fee-consent-preview'),
      })
      const consent = await previewCoordinator.previewFeeFacts(orderRequest(), client)
      assert.equal(consent.sourcePreparationFeeSubunits, '1')
      const prepared = await coordinator.prepare(orderRequest(), client, undefined, consent)
      assert.equal(prepared.operationId, await counterRangeId(directory))
      assert.equal(wallet.completeCalls, 1)
      await assertCounterAuthorityPairs(directory)
    },
  )

  const fragmentedProofs = Array.from({ length: 20 }, () => cashProof(32))
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-fee-drift-',
      incarnationId: 'range-fee-drift-test',
      proofs: fragmentedProofs,
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet(fragmentedProofs)
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: randomIds('range-fee-drift'),
      })
      const client = fakeEngineClient(boundCapability)
      const previewCoordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => {
          throw new Error('fee preview must not create a wallet')
        },
        now: () => 10_000,
        randomId: randomIds('range-fee-drift-preview'),
      })
      const consent = await previewCoordinator.previewFeeFacts(orderRequest(), client)
      assert.equal(consent.sourcePreparationFeeSubunits, '2')
      await addAvailableProofs([cashProof(8_192)], regularAsset())

      await assert.rejects(
        coordinator.prepare(orderRequest(), client, undefined, consent),
        /fee consent does not match/,
      )
      assert.equal(wallet.completeCalls, 0)
      assert.deepEqual((await readState())?.proofOperations, {})
    },
  )
})

test('daemon retains source-consolidation reservations after exact retry rejection', async () => {
  const proofs = [2, 2, 2, 2].map((amount) =>
    signedProof(OutputData.createRandomData(Amount.from(amount), mintKeys())[0]!),
  )
  await withDaemonProfile(
    {
      prefix: 'bitcaster-consolidation-rejected-',
      incarnationId: 'consolidation-rejected-test',
      proofs,
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet(proofs, 'unspent')
      const ids = ['range-consolidation-rejected', 'authorization-consolidation-rejected']
      const client = fakeEngineClient(() => {
        throw new Error('failed preparation must not request a capability')
      })
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(3),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })
      await assert.rejects(
        coordinator.prepare(
          {
            ...orderRequest(),
            price: 5,
            amountSubunits: 1_000,
            minimumFillAmountSubunits: 1_000,
            consolidateProofs: true,
          },
          client,
        ),
        /mint swap acknowledgement lost/,
      )
      let replays = 0
      wallet.completeSwap = async () => {
        replays += 1
        throw new MintOperationError(11001, 'definite rejection')
      }
      const recovered = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.equal(replays, 1)
      assert.equal(recovered.recovered.length, 0)
      assert.equal(recovered.pending.length, 1)
      assert.match(recovered.pending[0]!.error, /replay rejection remains pending/)
      const state = await readState()
      assert.ok(state?.wallet.proofs.some(({ state: proofState }) => proofState === 'reserved'))
      const database = await openDaemonStateSqlite(directory)
      try {
        assert.ok(
          Number(
            database.prepare('SELECT count(*) AS count FROM custody_proof_reservations').get()
              ?.count,
          ) > 0,
        )
        assert.equal(
          database
            .prepare(
              "SELECT operation_state AS state FROM custody_operations WHERE semantic_kind = 'proof-consolidation'",
            )
            .get()?.state,
          'dispatch-intent',
        )
        assert.equal(
          database
            .prepare('SELECT lifecycle_state AS state FROM daemon_ctf_range_preparations')
            .get()?.state,
          'prepared',
        )
      } finally {
        database.close()
      }
    },
  )
})

test('daemon consolidation replay does not restore successors consumed after commit', async () => {
  const proofs = [2, 2, 2, 2].map((amount) =>
    signedProof(OutputData.createRandomData(Amount.from(amount), mintKeys())[0]!),
  )
  await withDaemonProfile(
    {
      prefix: 'bitcaster-consolidation-consumed-',
      incarnationId: 'consolidation-consumed-test',
      proofs,
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet(proofs)
      const prepare = wallet.prepareSwapToSend.bind(wallet)
      let preparations = 0
      wallet.prepareSwapToSend = async (...args) => {
        preparations += 1
        if (preparations > 1) throw new Error('source preparation interrupted')
        return prepare(...args)
      }
      const ids = ['range-consolidation-consumed', 'authorization-consolidation-consumed']
      const client = fakeEngineClient(() => {
        throw new Error('must not request a capability')
      })
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(3),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })
      await assert.rejects(
        coordinator.prepare(
          {
            ...orderRequest(),
            price: 5,
            amountSubunits: 1_000,
            minimumFillAmountSubunits: 1_000,
            consolidateProofs: true,
          },
          client,
        ),
        /source preparation interrupted/,
      )
      const state = await readState()
      assert.ok(state)
      const consolidation = Object.values(state.proofOperations).find(
        ({ kind }) => kind === 'proof-consolidation',
      )
      assert.equal(consolidation?.state, 'completed')
      const successors = consolidation?.resultProofs?.consolidated
      assert.ok(successors?.length)
      const database = await openDaemonStateSqlite(directory)
      try {
        const store = new DurableCustodySqliteStore(database)
        for (const proof of successors) {
          assert.ok(proof.id)
          const proofId = deriveDurableCustodyProofId({
            scopeId: testScopeId(),
            normalizedMint: MINT_URL,
            unit: 'msat',
            keysetId: proof.id,
            secret: proof.secret,
          })
          const row = store.getProof(testScopeId(), proofId)
          assert.ok(row)
          store.putProofCas(
            { ...row, nut07State: 'SPENT', selectability: 'spent', revision: row.revision + 1 },
            row.revision,
          )
        }
      } finally {
        database.close()
      }
      state.wallet.proofs = state.wallet.proofs.filter(
        ({ proof }) => !successors.some((successor) => successor.secret === proof.secret),
      )
      await writeState(state)
      const result = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.equal(result.pending.length, 1)
      assert.match(
        result.pending[0]!.error,
        /fresh range source preparation requires explicit fee consent/,
      )
      assert.equal(preparations, 2)
      const replayed = await readState()
      assert.equal(
        replayed?.wallet.proofs.some(({ proof }) =>
          successors.some((successor) => successor.secret === proof.secret),
        ),
        false,
      )
    },
  )
})

test('daemon resumes exact bounded consolidation without recreating its range capability', async () => {
  const sourceProofs = [2, 2, 2, 2].map((amount) =>
    signedProof(OutputData.createRandomData(Amount.from(amount), mintKeys())[0]!),
  )
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-consolidation-',
      incarnationId: 'range-consolidation-production-test',
      proofs: sourceProofs,
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet(sourceProofs, true)
      const client = fakeEngineClient(boundCapability)
      const ids = ['range-operation-consolidated', 'range-authorization-consolidated']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(3),
        createWallet: () => wallet,
        restoreOutputs: async () => ({}),
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })
      const request = {
        ...orderRequest(),
        price: 5,
        amountSubunits: 1_000,
        minimumFillAmountSubunits: 1_000,
        consolidateProofs: true,
      }

      const previewCoordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(3),
        createWallet: () => {
          throw new Error('consolidation fee preview must not create a wallet')
        },
        now: () => 10_000,
        randomId: randomIds('range-consolidation-preview'),
      })
      const consent = await previewCoordinator.previewFeeFacts(request, client)
      assert.equal(consent.consolidationFeeSubunits, '1')
      assert.equal(consent.sourcePreparationFeeSubunits, '1')
      assert.equal(wallet.completeCalls, 0)
      assert.deepEqual((await readState())?.proofOperations, {})

      await assert.rejects(
        coordinator.prepare(request, client, undefined, consent),
        /mint swap acknowledgement lost/,
      )
      const interrupted = await readState()
      const consolidationId =
        (await counterRangeId(directory, 'client-order-1')) + ':source:consolidation:0'
      assert.equal(interrupted?.proofOperations[consolidationId]?.state, 'prepared')
      assert.equal(
        interrupted?.wallet.proofs.filter(({ state: proofState }) => proofState === 'reserved')
          .length,
        3,
      )

      const incompletePass = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(incompletePass.recovered, [])
      assert.equal(incompletePass.pending.length, 1)
      assert.match(incompletePass.pending[0]!.error, /consolidation result is incomplete/)
      const stillReserved = await readState()
      assert.equal(stillReserved?.proofOperations[consolidationId]?.state, 'prepared')
      assert.equal(
        stillReserved?.wallet.proofs.filter(({ state: proofState }) => proofState === 'reserved')
          .length,
        3,
      )

      const recoveredCoordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(3),
        createWallet: () => wallet,
        restoreOutputs: async (_mintUrl, groups) =>
          Object.fromEntries(
            Object.entries(deserializeOutputGroups(groups)).map(([label, outputs]) => [
              label,
              outputs.map(signedProof),
            ]),
          ),
        now: () => 10_000,
      })
      const recoveredPass = await recoveredCoordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(recoveredPass.recovered, [])
      assert.equal(recoveredPass.pending.length, 1)
      assert.match(
        recoveredPass.pending[0]!.error,
        /unsubmitted range authorization remains unspent/,
      )
      assert.equal(wallet.completeCalls, 2)
      const recovered = await readState()
      assert.equal(recovered?.proofOperations[consolidationId]?.state, 'completed')
      assert.equal(recovered?.proofOperations[consolidationId]?.metadata.fees, 1)
      assert.equal(
        recovered?.proofOperations[(await counterRangeId(directory, 'client-order-1')) + ':source']
          ?.state,
        'completed',
      )
      assert.deepEqual(recovered?.orders, {})
    },
  )
})

test('daemon refuses a higher cumulative fee after a committed consolidation before further spend', async () => {
  const sourceProofs = [2, 2, 2, 2].map((amount) => cashProof(amount))
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-fee-rise-after-consolidation-',
      incarnationId: 'range-fee-rise-after-consolidation-test',
      proofs: sourceProofs,
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet(sourceProofs)
      const prepareSwap = wallet.prepareSwapToSend.bind(wallet)
      let preparations = 0
      wallet.prepareSwapToSend = async (...args) => {
        preparations += 1
        if (preparations > 1) throw new Error('source preparation interrupted after consolidation')
        return prepareSwap(...args)
      }
      const request = {
        ...orderRequest(),
        price: 5,
        consolidateProofs: true,
      }
      const client = fakeEngineClient(boundCapability)
      const preview = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(3),
        now: () => 10_000,
        randomId: randomIds('range-fee-rise-preview'),
      })
      const consent = await preview.previewFeeFacts(request, client)
      assert.equal(consent.sourcePreparationFeeSubunits, '1')
      assert.equal(consent.consolidationFeeSubunits, '1')
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(3),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: randomIds('range-fee-rise'),
      })
      await assert.rejects(
        coordinator.prepare(request, client, undefined, consent),
        /source preparation interrupted after consolidation/,
      )
      assert.equal(wallet.completeCalls, 1)

      const state = await readState()
      assert.ok(state)
      const available = state.wallet.proofs.filter(
        ({ state: proofState }) => proofState === 'available',
      )
      const database = await openDaemonStateSqlite(directory)
      try {
        const store = new DurableCustodySqliteStore(database)
        for (const { proof } of available) {
          const proofId = deriveDurableCustodyProofId({
            scopeId: testScopeId(),
            normalizedMint: MINT_URL,
            unit: 'msat',
            keysetId: proof.id,
            secret: proof.secret,
          })
          const row = store.getProof(testScopeId(), proofId)
          assert.ok(row)
          store.putProofCas(
            { ...row, nut07State: 'SPENT', selectability: 'spent', revision: row.revision + 1 },
            row.revision,
          )
        }
      } finally {
        database.close()
      }
      state.wallet.proofs = state.wallet.proofs.filter(
        ({ state: proofState }) => proofState !== 'available',
      )
      await writeState(state)
      await addAvailableProofs(
        [2, 2, 2, 2].map((amount) => cashProof(amount)),
        regularAsset(),
      )

      const restarted = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(3),
        createWallet: () => wallet,
        now: () => 10_000,
      })
      const result = await restarted.recover(WALLET_SEED_HEX, client)
      assert.equal(result.pending.length, 1)
      assert.match(result.pending[0]!.error, /fee consent does not match/)
      assert.equal(wallet.completeCalls, 1)
      assert.equal(
        (await readState())?.proofOperations[
          (await counterRangeId(directory, 'client-order-1')) + ':source'
        ],
        undefined,
      )
    },
  )
})

test('daemon keeps both reservations when an expired source replay is uncertain', async () => {
  const proof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-source-uncertain-',
      incarnationId: 'source-uncertain-test',
      proofs: [proof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let nowMs = 10_000
      const wallet = new FakeWallet([proof], 'unspent')
      const ids = ['range-uncertain', 'authorization-uncertain']
      const client = fakeEngineClient(() => {
        throw new Error('must not submit a capability')
      })
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(64, 320),
        createWallet: () => wallet,
        now: () => nowMs,
        randomId: () => ids.shift()!,
      })
      await assert.rejects(
        coordinator.prepare(orderRequest(), client),
        /mint swap acknowledgement lost/,
      )
      nowMs = 31_000
      let replayCalls = 0
      wallet.completeSwap = async () => {
        replayCalls += 1
        throw new Error('transport unavailable')
      }
      const result = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.equal(replayCalls, 1)
      assert.equal(result.recovered.length, 0)
      assert.equal(result.pending.length, 1)
      assert.match(result.pending[0]!.error, /replay result is uncertain/)
      const state = await readState()
      assert.equal(state?.wallet.proofs[0]?.state, 'reserved')
      const database = await openDaemonStateSqlite(directory)
      try {
        assert.equal(
          database.prepare('SELECT count(*) AS count FROM custody_proof_reservations').get()?.count,
          1,
        )
        assert.equal(
          database.prepare('SELECT selectability FROM custody_proofs').get()?.selectability,
          'locked',
        )
      } finally {
        database.close()
      }
    },
  )
})

test('daemon keeps source reservations after a definite exact replay rejection at expiry', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-expiry-rejection-',
      incarnationId: 'range-expiry-rejection-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let nowMs = 10_000
      const wallet = new FakeWallet([sourceProof], 'unspent')
      const sourcePreviewDigests: string[] = []
      let capabilityCalls = 0
      const client = fakeEngineClient(() => {
        capabilityCalls += 1
        throw new Error('capability creation must not run for an uncommitted source')
      })
      const ids = ['range-operation-expired-rejection', 'range-authorization-expired-rejection']
      wallet.completeSwap = async (preview) => {
        sourcePreviewDigests.push(swapPreviewDigest(preview))
        if (sourcePreviewDigests.length === 1) throw new Error('mint swap acknowledgement lost')
        throw new MintOperationError(11001, 'definite replay rejection')
      }
      wallet.checkProofsStates = async (proofs) =>
        proofs.map(({ secret }) => ({ Y: secret, state: 'UNSPENT' as const }))
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(64, 1_000),
        createWallet: () => wallet,
        authorizationLifetimeSeconds: 20,
        now: () => nowMs,
        randomId: () => ids.shift()!,
      })

      await assert.rejects(
        coordinator.prepare(orderRequest(), client),
        /mint swap acknowledgement lost/,
      )
      nowMs = 30_000
      const recovery = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.equal(sourcePreviewDigests.length, 2)
      assert.equal(sourcePreviewDigests[1], sourcePreviewDigests[0])
      assert.deepEqual(recovery.recovered, [])
      assert.equal(recovery.pending.length, 1)
      assert.match(recovery.pending[0]!.error, /replay rejection remains pending/)
      assert.equal(capabilityCalls, 0)
      const state = await readState()
      assert.equal(state?.wallet.proofs[0]?.state, 'reserved')
      assert.equal(
        state?.proofOperations[(await counterRangeId(directory, 'client-order-1')) + ':source']
          ?.state,
        'prepared',
      )
      assert.deepEqual(state?.orders, {})
      const database = await openDaemonStateSqlite(directory)
      try {
        const custody = database
          .prepare(
            `SELECT operation_state AS state FROM custody_operations
          WHERE semantic_kind = 'ctf-range-regular-source'`,
          )
          .get()
        assert.notEqual(custody?.state, 'aborted')
        const reservations = database
          .prepare('SELECT count(*) AS count FROM custody_proof_reservations')
          .get()
        assert.equal(reservations?.count, 1)
        const preparation = database
          .prepare(
            `SELECT lifecycle_state AS lifecycle FROM daemon_ctf_range_preparations
             WHERE range_operation_id = ?`,
          )
          .get(await counterRangeId(directory))
        assert.equal(preparation?.lifecycle, 'prepared')
      } finally {
        database.close()
      }
    },
  )
})

test('daemon applies a late exact source result and refunds locally without capability admission', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-late-source-',
      incarnationId: 'range-late-source-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let nowMs = 10_000
      let notifySourceStarted!: () => void
      const sourceStarted = new Promise<void>((resolve) => {
        notifySourceStarted = resolve
      })
      let completeOriginal!: (result: { keep: Proof[]; send: Proof[] }) => void
      const originalResponse = new Promise<{ keep: Proof[]; send: Proof[] }>((resolve) => {
        completeOriginal = resolve
      })
      const wallet = new FakeWallet([sourceProof])
      let sourceCalls = 0
      let originalPreview: SwapPreview | null = null
      const sourcePreviewDigests: string[] = []
      wallet.checkProofsStates = async (proofs) =>
        proofs.map(({ secret }) => ({ Y: secret, state: 'UNSPENT' as const }))
      wallet.completeSwap = async (preview) => {
        sourceCalls += 1
        sourcePreviewDigests.push(swapPreviewDigest(preview))
        if (sourceCalls === 1) {
          originalPreview = preview
          notifySourceStarted()
          return originalResponse
        }
        throw new MintOperationError(11001, 'exact retry lost race with original source request')
      }
      let capabilityCalls = 0
      let orderCalls = 0
      let beforeCapabilityCalls = 0
      const client = fakeEngineClient(
        (request) => {
          capabilityCalls += 1
          return boundCapability(request)
        },
        async () => {
          orderCalls += 1
          return submittedOrder()
        },
      )
      const ids = ['range-operation-late-source', 'range-authorization-late-source']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(64, 1_000),
        createWallet: () => wallet,
        authorizationLifetimeSeconds: 20,
        executeRefundSwap: async (_mintUrl, request) => ({
          signatures: request.outputs.map(signBlindedOutput),
        }),
        now: () => nowMs,
        randomId: () => ids.shift()!,
      })

      const preparing = coordinator
        .prepare(orderRequest(), client, async () => {
          beforeCapabilityCalls += 1
        })
        .then(
          () => null,
          (error) => error,
        )
      await sourceStarted
      nowMs = 30_000
      const uncertain = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.equal(sourceCalls, 2)
      assert.equal(sourcePreviewDigests[1], sourcePreviewDigests[0])
      assert.deepEqual(uncertain.recovered, [])
      assert.equal(uncertain.pending.length, 1)
      assert.match(uncertain.pending[0]!.error, /replay rejection remains pending/)
      const pendingDatabase = await openDaemonStateSqlite(directory)
      try {
        assert.equal(
          pendingDatabase.prepare('SELECT count(*) AS count FROM custody_proof_reservations').get()
            ?.count,
          1,
        )
        assert.equal(
          pendingDatabase.prepare('SELECT selectability FROM custody_proofs').get()?.selectability,
          'locked',
        )
      } finally {
        pendingDatabase.close()
      }

      assert.ok(originalPreview)
      completeOriginal({
        send: (originalPreview.sendOutputs ?? []).map(signedProof),
        keep: (originalPreview.keepOutputs ?? []).map(signedProof),
      })
      const prepareError = await preparing
      assert.ok(prepareError instanceof Error)
      assert.match(prepareError.message, /expired before capability admission/)
      assert.equal(beforeCapabilityCalls, 0)
      assert.equal(capabilityCalls, 0)
      assert.equal(orderCalls, 0)

      const state = await readState()
      assert.equal(
        state?.proofOperations[(await counterRangeId(directory, 'client-order-1')) + ':source']
          ?.state,
        'completed',
      )
      assert.ok(
        Object.values(state?.proofOperations ?? {}).some(
          ({ state: operationState, metadata }) =>
            operationState === 'completed' && metadata.purpose === 'ctf-range-refund',
        ),
      )
      assert.deepEqual(state?.orders, {})
      const database = await openDaemonStateSqlite(directory)
      try {
        const terminal = database
          .prepare(
            `SELECT lifecycle_state AS lifecycle FROM daemon_ctf_range_preparations
             WHERE range_operation_id = ?`,
          )
          .get(await counterRangeId(directory))
        assert.equal(terminal?.lifecycle, 'terminal')
      } finally {
        database.close()
      }
    },
  )
})

test('daemon routes an expired capability-requested journal to local refund without retrying admission', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-expired-capability-',
      incarnationId: 'range-expired-capability-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let nowMs = 10_000
      let crossExpiryDuringExactRequestRead = false
      let recoveryFenceReads = 0
      let capabilityCalls = 0
      let orderCalls = 0
      const client = fakeEngineClient(
        () => {
          capabilityCalls += 1
          throw new Error('capability acknowledgement lost')
        },
        async () => {
          orderCalls += 1
          return submittedOrder()
        },
      )
      const ids = ['range-operation-expired-capability', 'range-authorization-expired-capability']
      const coordinator = new DaemonCtfRangeOrderCoordinator(
        directory,
        () => {
          if (crossExpiryDuringExactRequestRead) {
            recoveryFenceReads += 1
            if (recoveryFenceReads === 2) nowMs = 30_000
          }
          return fence
        },
        {
          createMint: () => fakeMint(64, 1_000),
          createWallet: () => new FakeWallet([sourceProof]),
          authorizationLifetimeSeconds: 20,
          executeRefundSwap: async (_mintUrl, request) => ({
            signatures: request.outputs.map(signBlindedOutput),
          }),
          now: () => nowMs,
          randomId: () => ids.shift()!,
        },
      )

      await assert.rejects(
        coordinator.prepare(orderRequest(), client),
        /capability acknowledgement lost/,
      )
      assert.equal(capabilityCalls, 1)
      const pendingDatabase = await openDaemonStateSqlite(directory)
      const pending = pendingDatabase
        .prepare(
          `SELECT lifecycle_state AS lifecycle FROM daemon_ctf_range_preparations
           WHERE range_operation_id = ?`,
        )
        .get(await counterRangeId(directory))
      pendingDatabase.close()
      assert.equal(pending?.lifecycle, 'capability-requested')

      nowMs = 29_000
      crossExpiryDuringExactRequestRead = true
      assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
        recovered: [(await counterRangeId(directory, 'client-order-1')) + ':source'],
        pending: [],
      })
      assert.ok(recoveryFenceReads >= 2)
      assert.equal(capabilityCalls, 1)
      assert.equal(orderCalls, 0)
      const state = await readState()
      assert.ok(
        Object.values(state?.proofOperations ?? {}).some(
          ({ state: operationState, metadata }) =>
            operationState === 'completed' && metadata.purpose === 'ctf-range-refund',
        ),
      )
      assert.deepEqual(state?.orders, {})
    },
  )
})

test('daemon refuses a range authorization without five minutes of refund headroom', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-short-horizon-',
      incarnationId: 'range-short-horizon-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet([sourceProof])
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(64, 300),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => 'must-not-be-used',
      })

      await assert.rejects(
        coordinator.prepare(orderRequest(), fakeEngineClient(boundCapability)),
        /authorization horizon is exhausted/,
      )
      assert.equal(wallet.completeCalls, 0)
      const state = await readState()
      assert.equal(state?.wallet.proofs[0]?.state, 'available')
      assert.deepEqual(state?.proofOperations, {})
      const database = await openDaemonStateSqlite(directory)
      const preparationCount = database
        .prepare('SELECT count(*) AS count FROM daemon_ctf_range_preparations')
        .get() as { count: number }
      database.close()
      assert.equal(preparationCount.count, 0)
    },
  )
})

test('daemon discovers but does not replay an order after its submission acknowledgement is lost', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-order-submit-',
      incarnationId: 'range-order-submit-production-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let capabilityState: SettlementCapabilityResponse['state'] = 'bound'
      let submitAttempts = 0
      const baseClient = fakeEngineClient(
        (request) => boundCapability(request, capabilityState),
        async () => {
          submitAttempts += 1
          capabilityState = 'selected'
          if (submitAttempts === 1) throw new Error('order acknowledgement lost')
          return submittedOrder()
        },
      )
      const client: EngineClientLike = {
        ...baseClient,
        getOrderStatus: async () => (submitAttempts > 0 ? restingOrderStatus() : null),
      }
      const ids = ['range-operation-submit', 'range-authorization-submit']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => new FakeWallet([sourceProof]),
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })
      const prepared = await coordinator.prepare(orderRequest(), client)

      await assert.rejects(
        client.submitOrder(orderRequest().marketId, {
          settlementCapability: prepared.capability.reference,
          comment: null,
        }),
        /order acknowledgement lost/,
      )
      assert.deepEqual((await readState())?.orders, {})

      const recovered = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(recovered.recovered, [])
      assert.equal(recovered.pending.length, 1)
      assert.match(recovered.pending[0]!.error, /submitted range authorization remains unspent/)
      assert.equal(submitAttempts, 1)
      assert.equal((await readState())?.orders[ORDER_ID]?.clientOrderId, 'client-order-1')
    },
  )
})

test('daemon refunds a definitively rejected order without requiring engine order state', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-order-rejected-',
      incarnationId: 'range-order-rejected-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let activeFence = fence
      let nowMs = 10_000
      const ids = ['range-operation-rejected', 'range-authorization-rejected']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => activeFence, {
        createMint: () => fakeMint(),
        createWallet: () => new FakeWallet([sourceProof]),
        executeRefundSwap: async (_mintUrl, request) => ({
          signatures: request.outputs.map(signBlindedOutput),
        }),
        now: () => nowMs,
        randomId: () => ids.shift()!,
      })
      const client = fakeEngineClient(boundCapability)
      const prepared = await coordinator.prepare(orderRequest(), client)
      await prepared.markRejected()

      const database = await openDaemonStateSqlite(directory)
      const preparation = database
        .prepare(
          `SELECT lifecycle_state AS lifecycle
           FROM daemon_ctf_range_preparations
           WHERE range_operation_id = ?`,
        )
        .get(prepared.operationId) as { lifecycle: string }
      const custody = database
        .prepare(
          "SELECT operation_id FROM custody_operations WHERE semantic_kind = 'conditional-keyset-swap'",
        )
        .get() as {
        operation_id: string
      }
      database.close()
      assert.equal(preparation.lifecycle, 'submission-rejected')

      const loaded = await new DaemonCtfRangeCoordinator(directory, fence).load(
        custody.operation_id,
      )
      assert.ok(loaded)
      const waiting = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.equal(waiting.recovered.length, 0)
      assert.equal(waiting.pending.length, 1)
      assert.equal(waiting.pending[0]?.retryAtMs, loaded.operation.expiry * 1_000 + 1_000)

      nowMs = (loaded.operation.expiry + 1) * 1_000
      activeFence = await claimCustodyScopeLease(directory, {
        scopeId: testScopeId(),
        incarnationId: 'range-order-rejected-refund',
        observedAtMs: nowMs,
      })
      assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
        recovered: [(await counterRangeId(directory, 'client-order-1')) + ':source'],
        pending: [],
      })

      const recovered = await readState()
      assert.deepEqual(recovered?.orders, {})
      assert.equal(
        Object.values(recovered?.proofOperations ?? {}).some(
          ({ state, metadata }) => state === 'completed' && metadata.purpose === 'ctf-range-refund',
        ),
        true,
      )
      const recoveredDatabase = await openDaemonStateSqlite(directory)
      const terminal = recoveredDatabase
        .prepare(
          `SELECT lifecycle_state AS lifecycle
           FROM daemon_ctf_range_preparations
           WHERE range_operation_id = ?`,
        )
        .get(prepared.operationId) as { lifecycle: string }
      recoveredDatabase.close()
      assert.equal(terminal.lifecycle, 'terminal')
    },
  )
})

test('daemon leaves an unexpectedly active FOK pending without cancellation or refund', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-resting-expiry-',
      incarnationId: 'range-resting-expiry-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let activeFence = fence
      let nowMs = 10_000
      let cancellationCalls = 0
      const activeStatuses = [
        restingOrderStatus(),
        { ...restingOrderStatus()!, status: 'matched' as const },
        { ...restingOrderStatus()!, status: 'partially_filled' as const },
      ]
      let activeStatusIndex = 0
      const baseClient = fakeEngineClient(boundCapability)
      const client: EngineClientLike = {
        ...baseClient,
        getOrderStatus: async () => activeStatuses[activeStatusIndex]!,
        cancelOrder: async () => {
          cancellationCalls += 1
          throw new Error('public FOK recovery must not cancel a resting order')
        },
      }
      const ids = ['range-operation-resting-expiry', 'range-authorization-resting-expiry']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => activeFence, {
        createMint: () => fakeMint(64, 320),
        createWallet: () => new FakeWallet([sourceProof]),
        executeRefundSwap: async () => {
          throw new Error('public FOK recovery must not refund a resting order')
        },
        now: () => nowMs,
        randomId: () => ids.shift()!,
      })
      const request = orderRequest()
      const prepared = await coordinator.prepare(request, client)
      await recordSubmittedOrder(
        request.marketId,
        request.clientOrderId,
        submittedOrder(),
        null,
        request.tokenSide,
        request.side,
        request.price,
        request.amountSubunits,
        request.baseAsset,
        request.divisibility,
      )
      await prepared.markSubmitted()

      nowMs = 71_000
      activeFence = await claimCustodyScopeLease(directory, {
        scopeId: testScopeId(),
        incarnationId: 'range-resting-expiry-recovery',
        observedAtMs: nowMs,
      })
      for (
        activeStatusIndex = 0;
        activeStatusIndex < activeStatuses.length;
        activeStatusIndex += 1
      ) {
        const recovery = await coordinator.recover(WALLET_SEED_HEX, client)
        assert.deepEqual(recovery.recovered, [])
        assert.equal(recovery.pending.length, 1)
        assert.match(recovery.pending[0]!.error, /unexpectedly active/)
      }
      assert.equal(cancellationCalls, 0)
      const state = await readState()
      assert.equal(state?.orders[ORDER_ID]?.status, 'partially_filled')
      assert.equal(
        Object.values(state?.proofOperations ?? {}).some(
          ({ metadata }) => metadata.purpose === 'ctf-range-refund',
        ),
        false,
      )
      const database = await openDaemonStateSqlite(directory)
      const journal = database
        .prepare('SELECT lifecycle_state AS lifecycle FROM daemon_ctf_range_preparations')
        .get() as { lifecycle: string }
      database.close()
      assert.equal(journal.lifecycle, 'order-submitted')
    },
  )
})

for (const acknowledgementLost of [true, false])
  test(`daemon completes a filled FOK result: acknowledgementLost=${acknowledgementLost}`, async () => {
    const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
    await withDaemonProfile(
      {
        prefix: 'bitcaster-range-result-ack-',
        incarnationId: 'range-result-ack-production-test',
        proofs: [sourceProof],
        asset: regularAsset(),
      },
      async ({ directory, fence }) => {
        let selectedOutputs = new Set<string>()
        let result: SettlementCapabilityResultResponse | null = null
        let acknowledgementCommitted = false
        let acknowledgementCalls = 0
        const observations: import('../src/orderTimeline.ts').OrderTimelineObservation[] = []
        const mint = fakeMint(64, 1_000, () => selectedOutputs)
        const baseClient = fakeEngineClient(boundCapability)
        const client: EngineClientLike = {
          ...baseClient,
          getSettlementCapabilityResultByOperation: async () =>
            result === null
              ? null
              : {
                  ...result,
                  acknowledgedAt: acknowledgementCommitted ? new Date(12_000).toISOString() : null,
                  version: acknowledgementCommitted ? 2 : 1,
                },
          acknowledgeSettlementCapabilityResult: async (_resultId, request) => {
            acknowledgementCalls += 1
            assert.equal(request.expectedVersion, 1)
            acknowledgementCommitted = true
            if (acknowledgementLost)
              throw new Error('settlement result acknowledgement response lost')
            return { ...result!, acknowledgedAt: new Date(12_000).toISOString(), version: 2 }
          },
          getOrderStatus: async () => filledOrderStatus(),
        }
        const ids = ['range-operation-result', 'range-authorization-result']
        const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          observeOrderTimeline: (observation) => {
            observations.push(observation)
            throw new Error('observer unavailable')
          },
          createMint: () => mint,
          createWallet: () => new FakeWallet([sourceProof]),
          now: () => 10_000,
          randomId: () => ids.shift()!,
        })
        const request = orderRequest()
        const prepared = await coordinator.prepare(request, client)
        assert.deepEqual(
          observations.map(({ phase }) => phase),
          [
            'preparation-policy-read',
            'preparation-market-read',
            'preparation-mint-read',
            'preparation-mint-authority',
            'preparation-wallet-source',
            'preparation-authorization-binding',
            'preparation-durable-bind',
            'preparation-exact-request',
            'preparation',
            'score-admission',
            'capability-admission',
          ],
        )
        assert.equal(
          observations.find(({ phase }) => phase === 'preparation')!.operationId,
          prepared.operationId,
        )
        assert.equal(
          observations.find(({ phase }) => phase === 'score-admission')!.outcome,
          'unverified',
        )
        assert.equal(
          observations.find(({ phase }) => phase === 'capability-admission')!.orderId,
          prepared.capability.orderId,
        )
        assert.equal(
          observations.every(({ elapsedMs }) => Number.isFinite(elapsedMs) && elapsedMs >= 0),
          true,
        )
        await recordSubmittedOrder(
          request.marketId,
          request.clientOrderId,
          submittedOrder(),
          null,
          request.tokenSide,
          request.side,
          request.price,
          request.amountSubunits,
          request.baseAsset,
          request.divisibility,
        )
        if (acknowledgementLost) await prepared.markSubmitted()

        const database = await openDaemonStateSqlite(directory)
        if (!acknowledgementLost) {
          database
            .prepare('DELETE FROM daemon_orders WHERE scope_id = ? AND order_id = ?')
            .run(fence.scopeId, prepared.capability.orderId)
        }
        const custody = database
          .prepare(
            "SELECT operation_id FROM custody_operations WHERE semantic_kind = 'conditional-keyset-swap'",
          )
          .get() as {
          operation_id: string
        }
        database.close()
        const loaded = await new DaemonCtfRangeCoordinator(directory, fence).load(
          custody.operation_id,
        )
        assert.ok(loaded)
        const selection = validTerminalSelection(loaded.operation)
        selectedOutputs = new Set(
          loaded.operation.manifest.entries
            .filter((_, index) => selection.selectedIndices.includes(index))
            .map(({ B_ }) => B_),
        )
        result = engineResult(prepared, loaded.operation, selection.selection)
        const mintCallsAfterPreparation = { ...mint.calls }

        if (!acknowledgementLost) {
          assert.equal(
            await recordOrderStatus(
              request.marketId,
              prepared.capability.orderId,
              filledOrderStatus(),
            ),
            null,
          )
        }
        const interrupted = await coordinator.recover(WALLET_SEED_HEX, client)
        if (!acknowledgementLost) {
          assert.deepEqual(interrupted, {
            recovered: [(await counterRangeId(directory, 'client-order-1')) + ':source'],
            pending: [],
          })
          const completion = observations.filter(({ phase }) => phase === 'result-completion')
          assert.equal(completion.length, 1)
          assert.equal(completion[0]!.applicationPath, 'engine')
          assert.equal(completion[0]!.outcome, 'success')
          assert.equal(acknowledgementCalls, 1)
          assert.equal(
            (await readState())?.orders[prepared.capability.orderId]?.clientOrderId,
            request.clientOrderId,
          )
          const recorded = observations.length
          assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
            recovered: [],
            pending: [],
          })
          assert.equal(observations.length, recorded)
          return
        }
        assert.deepEqual(interrupted.recovered, [])
        assert.equal(interrupted.pending.length, 1)
        assert.match(interrupted.pending[0]!.error, /acknowledgement response lost/)
        const firstApplication = observations.find(({ phase }) => phase === 'result-application')!
        assert.equal(firstApplication.outcome, 'success')
        assert.equal(firstApplication.orderId, prepared.capability.orderId)
        assert.equal(firstApplication.groupId, result!.settlementGroup!.groupId)
        assert.equal(firstApplication.groupRevision, result!.settlementGroup!.revision)
        assert.deepEqual(
          observations.slice(-3).map(({ phase, outcome }) => [phase, outcome]),
          [
            ['result-verification', 'success'],
            ['result-application', 'success'],
            ['result-acknowledgement', 'failed'],
          ],
        )
        assert.equal(
          (await new DaemonCtfRangeCoordinator(directory, fence).load(custody.operation_id))?.record
            .operation.result.state,
          'applied',
        )

        result = null
        const unavailable = await coordinator.recover(WALLET_SEED_HEX, client)
        assert.deepEqual(unavailable.recovered, [])
        assert.equal(unavailable.pending.length, 1)
        assert.ok(!observations.some(({ phase }) => phase === 'result-completion'))
        assert.deepEqual(mint.calls, mintCallsAfterPreparation)

        result = engineResult(prepared, loaded.operation, selection.selection)
        assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
          recovered: [(await counterRangeId(directory, 'client-order-1')) + ':source'],
          pending: [],
        })
        assert.equal(acknowledgementCalls, 1)
        const completion = observations.filter(({ phase }) => phase === 'result-completion')
        assert.equal(completion.length, 1)
        assert.equal(completion[0]!.applicationPath, 'persisted-engine-reuse')
        assert.equal(completion[0]!.outcome, 'reused')
        assert.ok(
          observations.some(
            ({ phase, outcome }) => phase === 'result-reuse' && outcome === 'reused',
          ),
        )
        assert.ok(observations.some(({ phase }) => phase === 'result-verification-recheck'))
        assert.deepEqual(
          observations
            .filter(({ phase }) => phase === 'result-application')
            .map(({ outcome }) => outcome),
          ['success', 'reused'],
        )
        assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
          recovered: [],
          pending: [],
        })
        assert.deepEqual(mint.calls, mintCallsAfterPreparation)
      },
    )
  })

test('order timeline stops optional writes after backpressure without stalling financial work', async () => {
  const { Writable } = await import('node:stream')
  const { createOrderTimelineStderrSink, measureOrderPhase } =
    await import('../src/orderTimeline.ts')
  const stream = new Writable({
    highWaterMark: 1,
    write() {
      // Keep the first write pending. No callback or drain can unblock the sink.
    },
  })
  let writes = 0
  const observer = createOrderTimelineStderrSink({
    on: (event, listener) => stream.on(event, listener),
    write: (line, callback) => {
      writes += 1
      return stream.write(line, callback)
    },
  })
  try {
    assert.equal(await measureOrderPhase(observer, 'order-submit', {}, async () => 7), 7)
    assert.equal(await measureOrderPhase(observer, 'result-application', {}, async () => 11), 11)
    assert.equal(writes, 1)
    assert.equal(stream.listenerCount('error'), 1)
    assert.equal(stream.writableNeedDrain, true)
  } finally {
    stream.destroy()
  }
})

test('order timeline bounds its fields and isolates listener and sink failure', async () => {
  const { startOrderPhase, measureOrderPhase, writeOrderTimeline, createOrderTimelineStderrSink } =
    await import('../src/orderTimeline.ts')
  const observations: import('../src/orderTimeline.ts').OrderTimelineObservation[] = []
  const finish = startOrderPhase(
    (item) => {
      observations.push(item)
    },
    'order-submit',
    { orderId: 'order-a' },
  )
  finish('success')
  finish('failed')
  assert.equal(observations.length, 1)
  assert.equal(observations[0]!.operationId, null)
  assert.equal(observations[0]!.groupId, null)
  let line = ''
  writeOrderTimeline(
    Object.assign({}, observations[0]!, { omitted: 'not-a-diagnostic-field' }),
    (value) => {
      line = value
    },
  )
  const parsed = JSON.parse(line.slice('order-timeline: '.length)) as Record<string, unknown>
  assert.equal(Object.hasOwn(parsed, 'omitted'), false)
  assert.equal(Object.hasOwn(parsed, 'error'), false)
  writeOrderTimeline(observations[0]!, () => {
    throw new Error('sink unavailable')
  })
  for (const mode of ['event', 'callback', 'throw'] as const) {
    const { EventEmitter } = await import('node:events')
    const stream = new EventEmitter() as import('node:events').EventEmitter & {
      write: (line: string, callback: (error?: Error | null) => void) => boolean
    }
    let writes = 0
    stream.write = (_line, callback) => {
      writes += 1
      switch (mode) {
        case 'event':
          queueMicrotask(() => stream.emit('error', new Error('sink unavailable')))
          break
        case 'callback':
          queueMicrotask(() => callback(new Error('sink unavailable')))
          break
        case 'throw':
          throw new Error('sink unavailable')
      }
      return true
    }
    const observe = createOrderTimelineStderrSink(stream)
    await observe(observations[0]!)
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    await observe(observations[0]!)
    assert.equal(writes, 1)
    assert.equal(stream.listenerCount('error'), 1)
  }
  const result = await measureOrderPhase(
    async () => {
      throw new Error('observer unavailable')
    },
    'order-submit',
    {},
    async () => 7,
  )
  assert.equal(result, 7)
  const failure = new Error('work failed')
  await assert.rejects(
    measureOrderPhase(
      () => {
        throw new Error('observer unavailable')
      },
      'preparation',
      {},
      async () => {
        throw failure
      },
    ),
    (error) => error === failure,
  )
  const cancellation = new Error('operation cancelled')
  cancellation.name = 'AbortError'
  const cancelled: import('../src/orderTimeline.ts').OrderTimelineObservation[] = []
  await assert.rejects(
    measureOrderPhase(
      (observation) => {
        cancelled.push(observation)
        return Promise.reject(new Error('observer unavailable'))
      },
      'mint-observation',
      { applicationPath: 'mint-recovery' },
      async () => {
        throw cancellation
      },
    ),
    (error) => error === cancellation,
  )
  assert.equal(cancelled.length, 1)
  assert.equal(cancelled[0]!.outcome, 'failed')
  assert.equal(cancelled[0]!.applicationPath, 'mint-recovery')
})

test('daemon applies a partial FOK result but keeps it pending and unacknowledged', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-partial-fok-',
      incarnationId: 'range-partial-fok-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let result: SettlementCapabilityResultResponse | null = null
      let acknowledgementCalls = 0
      const baseClient = fakeEngineClient(boundCapability)
      const client: EngineClientLike = {
        ...baseClient,
        getSettlementCapabilityResultByOperation: async () => result,
        acknowledgeSettlementCapabilityResult: async () => {
          acknowledgementCalls += 1
          throw new Error('partial FOK result must not be acknowledged')
        },
      }
      const ids = ['range-operation-partial-fok', 'range-authorization-partial-fok']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(64, 1_000),
        createWallet: () => new FakeWallet([sourceProof]),
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })
      const request = {
        ...orderRequest(),
        amountSubunits: 2_000,
        minimumFillAmountSubunits: 2_000,
      }
      const prepared = await coordinator.prepare(request, client)
      await recordSubmittedOrder(
        request.marketId,
        request.clientOrderId,
        submittedOrder(),
        null,
        request.tokenSide,
        request.side,
        request.price,
        request.amountSubunits,
        request.baseAsset,
        request.divisibility,
      )
      await prepared.markSubmitted()

      const database = await openDaemonStateSqlite(directory)
      const custody = database
        .prepare(
          "SELECT operation_id FROM custody_operations WHERE semantic_kind = 'conditional-keyset-swap'",
        )
        .get() as {
        operation_id: string
      }
      database.close()
      const loaded = await new DaemonCtfRangeCoordinator(directory, fence).load(
        custody.operation_id,
      )
      assert.ok(loaded)
      const selection = validPartialSelection(loaded.operation)
      result = engineResult(prepared, loaded.operation, selection.selection)

      const recovery = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(recovery.recovered, [])
      assert.equal(recovery.pending.length, 1)
      assert.match(recovery.pending[0]!.error, /does not satisfy the submitted FOK order/)
      assert.equal(acknowledgementCalls, 0)

      const persisted = await new DaemonCtfRangeCoordinator(directory, fence).load(
        custody.operation_id,
      )
      assert.equal(persisted?.record.operation.result.state, 'applied')
      const finalDatabase = await openDaemonStateSqlite(directory)
      const journal = finalDatabase
        .prepare('SELECT lifecycle_state AS lifecycle FROM daemon_ctf_range_preparations')
        .get() as { lifecycle: string }
      finalDatabase.close()
      assert.equal(journal.lifecycle, 'order-submitted')
    },
  )
})

for (const persistedStage of [false, true])
  test(`daemon applies exact mint recovery: persistedStage=${persistedStage}`, async () => {
    const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
    await withDaemonProfile(
      {
        prefix: 'bitcaster-range-mint-recovery-',
        incarnationId: 'range-mint-recovery-test',
        proofs: [sourceProof],
        asset: regularAsset(),
      },
      async ({ directory, fence }) => {
        let selectedOutputs = new Set<string>()
        let mintCommitted = false
        let engineTransportFails = true
        let engineResponse: SettlementCapabilityResultResponse | null = null
        let nowMs = 10_000
        const mint = {
          ...fakeMint(64, 1_000, () => selectedOutputs),
          check: async ({ Ys }: { Ys: string[] }) => ({
            states: Ys.map((Y) => ({
              Y,
              state: mintCommitted ? ('SPENT' as const) : ('UNSPENT' as const),
              witness: null,
            })),
          }),
        }
        const client: EngineClientLike = {
          ...fakeEngineClient(boundCapability),
          getSettlementCapabilityResultByOperation: async () => {
            if (engineTransportFails) throw new Error('engine result unavailable')
            return engineResponse
          },
          getOrderStatus: async () => {
            throw new Error('full settlement must not require engine order status')
          },
          acknowledgeSettlementCapabilityResult: async () => {
            throw new Error('mint-only recovery must not acknowledge an absent engine result')
          },
        }
        const ids = ['range-operation-mint-recovery', 'range-authorization-mint-recovery']
        const observations: import('../src/orderTimeline.ts').OrderTimelineObservation[] = []
        const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          observeOrderTimeline: (observation) => {
            observations.push(observation)
          },
          createMint: () => mint,
          createWallet: () => new FakeWallet([sourceProof]),
          now: () => nowMs,
          randomId: () => ids.shift()!,
        })
        const request = orderRequest()
        const prepared = await coordinator.prepare(request, client)
        await recordSubmittedOrder(
          request.marketId,
          request.clientOrderId,
          submittedOrder(),
          null,
          request.tokenSide,
          request.side,
          request.price,
          request.amountSubunits,
          request.baseAsset,
          request.divisibility,
        )
        await prepared.markSubmitted()

        const database = await openDaemonStateSqlite(directory)
        const custody = database
          .prepare(
            "SELECT operation_id FROM custody_operations WHERE semantic_kind = 'conditional-keyset-swap'",
          )
          .get() as {
          operation_id: string
        }
        database.close()
        const loaded = await new DaemonCtfRangeCoordinator(directory, fence).load(
          custody.operation_id,
        )
        assert.ok(loaded)
        const selection = validTerminalSelection(loaded.operation)
        const unavailable = await coordinator.recover(WALLET_SEED_HEX, client)
        assert.deepEqual(unavailable.recovered, [])
        assert.equal(unavailable.pending.length, 1)
        assert.ok(
          observations.some(
            ({ phase, outcome }) =>
              phase === 'recovery-verification-staging' && outcome === 'unverified',
          ),
        )
        assert.ok(!observations.some(({ phase }) => phase === 'result-completion'))

        engineTransportFails = false
        mintCommitted = true
        nowMs = (loaded.operation.expiry + 1) * 1_000
        selectedOutputs = new Set(
          loaded.operation.manifest.entries
            .filter((_, index) => selection.selectedIndices.includes(index))
            .map(({ B_ }) => B_),
        )
        const valid = engineResult(prepared, loaded.operation, selection.selection)
        const envelope = JSON.parse(Buffer.from(valid.envelope, 'base64').toString('utf8')) as {
          signatures: Array<{ dleq: { e: string; s: string } | null }>
        }
        if (envelope.signatures[0]?.dleq === null || envelope.signatures[0]?.dleq === undefined) {
          throw new Error('invalid engine envelope fixture has no DLEQ')
        }
        envelope.signatures[0]!.dleq = { ...envelope.signatures[0]!.dleq!, e: '00'.repeat(32) }
        const envelopeBytes = Buffer.from(JSON.stringify(envelope))
        engineResponse = {
          ...valid,
          envelope: envelopeBytes.toString('base64'),
          envelopeDigest: createHash('sha256').update(envelopeBytes).digest('hex'),
        }
        const applicationStart = observations.length

        if (persistedStage) {
          // Retain a real verified result before the existing application boundary.
          const observation = await new CtfRangeMintRecoveryAdapter(
            loaded.operation,
            mint,
          ).loadUncertainRecoveryObservation({
            record: loaded.record,
            selection: null,
            now: Math.floor(nowMs / 1_000),
          })
          const custodyCoordinator = new DaemonCtfRangeCoordinator(directory, fence)
          const staged = await custodyCoordinator.stageRecovered({
            custodyOperationId: custody.operation_id,
            observation: observation.observation,
            resolveKeyset: observation.resolveKeyset,
            observedAtMs: nowMs,
          })
          assert.equal(staged.kind, 'confirmed')
          assert.equal(
            (await custodyCoordinator.load(custody.operation_id))?.record.operation.result.state,
            'verified-staged',
          )
        }

        assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
          recovered: [(await counterRangeId(directory, 'client-order-1')) + ':source'],
          pending: [],
        })
        const selectedObservations = observations.slice(applicationStart)
        const recoveredDatabase = await openDaemonStateSqlite(directory)
        const recoveredRow = recoveredDatabase
          .prepare(
            `SELECT operations.result_state AS resultState,
             preparations.lifecycle_state AS lifecycle
           FROM custody_operations AS operations
           JOIN daemon_ctf_range_preparations AS preparations
             ON preparations.scope_id = operations.scope_id
           WHERE operations.operation_id = ?`,
          )
          .get(custody.operation_id) as { resultState: string; lifecycle: string }
        const spendableProofCount = recoveredDatabase
          .prepare(
            `SELECT count(*) AS count
           FROM target_wallet_proofs
           WHERE state = 'available'`,
          )
          .get() as { count: number }
        recoveredDatabase.close()
        assert.deepEqual({ ...recoveredRow }, { resultState: 'applied', lifecycle: 'terminal' })
        assert.ok(spendableProofCount.count > 0)
        assert.equal(
          selectedObservations.some(
            ({ phase, outcome }) => phase === 'result-verification' && outcome === 'unverified',
          ),
          !persistedStage,
        )
        const applications = selectedObservations.filter(
          ({ phase }) => phase === 'result-application',
        )
        assert.equal(applications.length, 1)
        assert.equal(applications[0]!.outcome, 'success')
        assert.equal(applications[0]!.operationId, prepared.operationId)
        assert.equal(applications[0]!.orderId, prepared.capability.orderId)
        assert.equal(applications[0]!.groupId, null)
        assert.equal(applications[0]!.groupRevision, null)
        assert.ok(!selectedObservations.some(({ phase }) => phase === 'result-acknowledgement'))
        assert.equal(
          selectedObservations.some(
            ({ phase, outcome }) => phase === 'mint-observation' && outcome === 'success',
          ),
          !persistedStage,
        )
        assert.equal(
          selectedObservations.some(
            ({ phase, outcome }) =>
              phase === 'recovery-verification-staging' && outcome === 'success',
          ),
          !persistedStage,
        )
        const completion = selectedObservations.filter(({ phase }) => phase === 'result-completion')
        assert.equal(completion.length, 1)
        assert.equal(
          completion[0]!.applicationPath,
          persistedStage ? 'persisted-mint-reuse' : 'mint-recovery',
        )
        assert.equal(completion[0]!.outcome, persistedStage ? 'reused' : 'success')
        assert.equal(
          selectedObservations.some(
            ({ phase, outcome, applicationPath }) =>
              phase === 'result-verification' &&
              outcome === 'unverified' &&
              applicationPath === 'engine',
          ),
          !persistedStage,
        )

        // Model the valid crash window after custody apply but before preparation terminalization.
        const crashPrefix = await openDaemonStateSqlite(directory)
        crashPrefix
          .prepare(
            "UPDATE daemon_ctf_range_preparations SET lifecycle_state = 'order-submitted', revision = revision + 1",
          )
          .run()
        crashPrefix.close()
        const retryStart = observations.length
        assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
          recovered: [(await counterRangeId(directory, 'client-order-1')) + ':source'],
          pending: [],
        })
        const retry = observations.slice(retryStart)
        assert.deepEqual(
          retry.map(({ phase, outcome, applicationPath }) => [phase, outcome, applicationPath]),
          [
            ['result-application', 'reused', 'persisted-mint-reuse'],
            ['result-reuse', 'reused', 'persisted-mint-reuse'],
            ['result-completion', 'reused', 'persisted-mint-reuse'],
          ],
        )
        const afterRetry = await openDaemonStateSqlite(directory)
        const afterCount = afterRetry
          .prepare("SELECT count(*) AS count FROM target_wallet_proofs WHERE state = 'available'")
          .get() as { count: number }
        afterRetry.close()
        assert.equal(afterCount.count, spendableProofCount.count)
      },
    )
  })

test('daemon resumes the exact post-expiry refund after mint acknowledgement loss', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-refund-',
      incarnationId: 'range-refund-restart-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let activeFence = fence
      let nowMs = 10_000
      let refundCommitted = false
      let rotatedRefundKeysetActive = false
      const refundRequests: SwapRequest[] = []
      const mint = {
        ...fakeMint(64, 1_000, undefined, () => rotatedRefundKeysetActive),
        check: async ({ Ys }: { Ys: string[] }) => ({
          states: Ys.map((Y) => ({
            Y,
            state: refundCommitted ? ('SPENT' as const) : ('UNSPENT' as const),
            witness: null,
          })),
        }),
      }
      const client: EngineClientLike = {
        ...fakeEngineClient(boundCapability),
        getOrderStatus: async () => cancelledOrderStatus(),
      }
      const dependencies: DaemonCtfRangeOrderCoordinatorDependencies = {
        createMint: () => mint,
        createWallet: () => new FakeWallet([sourceProof]),
        now: () => nowMs,
        randomId: (() => {
          const ids = ['range-operation-refund', 'range-authorization-refund']
          return () => ids.shift()!
        })(),
        executeRefundSwap: async (_mintUrl: string, request: SwapRequest) => {
          refundRequests.push(structuredClone(request))
          refundCommitted = true
          throw new Error('refund mint acknowledgement lost')
        },
        restoreOutputs: async (_mintUrl, groups) =>
          Object.fromEntries(
            Object.entries(deserializeOutputGroups(groups)).map(([label, outputs]) => [
              label,
              outputs.map(signedProof),
            ]),
          ),
      }
      const coordinator = new DaemonCtfRangeOrderCoordinator(
        directory,
        () => activeFence,
        dependencies,
      )
      const request = orderRequest()
      const prepared = await coordinator.prepare(request, client)
      await recordSubmittedOrder(
        request.marketId,
        request.clientOrderId,
        submittedOrder(),
        null,
        request.tokenSide,
        request.side,
        request.price,
        request.amountSubunits,
        request.baseAsset,
        request.divisibility,
      )
      await prepared.markSubmitted()

      const database = await openDaemonStateSqlite(directory)
      const custody = database
        .prepare(
          "SELECT operation_id FROM custody_operations WHERE semantic_kind = 'conditional-keyset-swap'",
        )
        .get() as {
        operation_id: string
      }
      database.close()
      const loaded = await new DaemonCtfRangeCoordinator(directory, fence).load(
        custody.operation_id,
      )
      assert.ok(loaded)
      nowMs = (loaded.operation.expiry + 1) * 1_000
      rotatedRefundKeysetActive = true
      activeFence = await claimCustodyScopeLease(directory, {
        scopeId: testScopeId(),
        incarnationId: 'range-refund-after-expiry',
        observedAtMs: nowMs,
      })

      const interrupted = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(interrupted.recovered, [])
      assert.equal(interrupted.pending.length, 1)
      assert.match(interrupted.pending[0]!.error, /refund mint acknowledgement lost/)
      assert.equal(refundRequests.length, 1)
      assert.ok(refundRequests[0]!.inputs.every(({ witness }) => witness !== undefined))

      const interruptedState = await readState()
      const preparedRefund = Object.values(interruptedState?.proofOperations ?? {}).find(
        ({ metadata }) => metadata.purpose === 'ctf-range-refund',
      )
      assert.equal(preparedRefund?.state, 'prepared')
      assert.deepEqual(
        preparedRefund?.inputs.map(exactProofSnapshot),
        refundRequests[0]!.inputs.map(exactProofSnapshot),
      )
      assert.ok(preparedRefund)
      const refundOperationId = deriveDurableCtfRangeRefundOperationId(loaded.operation.operationId)
      const refundAmount =
        loaded.operation.inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n) -
        deriveDurableCtfRangeFeeBounds(loaded.operation).maximumFee
      const plan = preparedRefund.metadata.refundOutputPlan as {
        outputs: ReturnType<typeof OutputData.serialize>[]
        keysetId: string
        counterStart: number
      }
      assert.equal(plan.keysetId, ROTATED_OFFER_KEYSET_ID)
      assert.ok(Number.isSafeInteger(plan.counterStart))
      const outputs = plan.outputs
      assert.equal(preparedRefund.operationId, refundOperationId)
      assert.equal(preparedRefund.metadata.refundKeysetId, ROTATED_OFFER_KEYSET_ID)
      assert.deepEqual(
        (deserializeOutputGroups(preparedRefund.outputs).refund ?? []).map(OutputData.serialize),
        outputs,
      )
      assert.deepEqual(
        refundRequests[0]!.outputs.map(({ amount, B_, id }) => ({
          amount: amountToNumber(amount).toString(),
          B_,
          id,
        })),
        outputs.map(({ blindedMessage }) => blindedMessage),
      )
      const interruptedDatabase = await openDaemonStateSqlite(directory)
      const locked = interruptedDatabase
        .prepare(
          `SELECT count(*) AS count
           FROM custody_operation_inputs AS inputs
           JOIN custody_proofs AS proofs
             ON proofs.scope_id = inputs.scope_id
            AND proofs.proof_id = inputs.proof_id
           JOIN custody_proof_reservations AS reservations
             ON reservations.scope_id = inputs.scope_id
            AND reservations.proof_id = inputs.proof_id
            AND reservations.operation_id = inputs.operation_id
           WHERE inputs.operation_id = ?
             AND proofs.nut07_state = 'UNSPENT'
             AND proofs.selectability = 'locked'
             AND proofs.reservation_operation_id = inputs.operation_id`,
        )
        .get(custody.operation_id) as { count: number }
      interruptedDatabase.close()
      assert.equal(locked.count, loaded.operation.inputs.length)

      const restarted = new DaemonCtfRangeOrderCoordinator(
        directory,
        () => activeFence,
        dependencies,
      )
      assert.deepEqual(await restarted.recover(WALLET_SEED_HEX, client), {
        recovered: [(await counterRangeId(directory, 'client-order-1')) + ':source'],
        pending: [],
      })
      assert.equal(refundRequests.length, 1, 'restart must not submit a second refund request')

      const recoveredState = await readState()
      const completedRefund = Object.values(recoveredState?.proofOperations ?? {}).find(
        ({ metadata }) => metadata.purpose === 'ctf-range-refund',
      )
      assert.equal(completedRefund?.state, 'completed')
      assert.ok((completedRefund?.resultProofs?.refund.length ?? 0) > 0)
      const recoveredDatabase = await openDaemonStateSqlite(directory)
      const recoveredCustody = recoveredDatabase
        .prepare(
          `SELECT operation_state AS operationState, result_state AS resultState
           FROM custody_operations WHERE operation_id = ?`,
        )
        .get(custody.operation_id) as { operationState: string; resultState: string }
      const retiredInputs = recoveredDatabase
        .prepare(
          `SELECT proofs.nut07_state AS nut07State, proofs.selectability,
             proofs.reservation_operation_id AS reservationOperationId
           FROM custody_operation_inputs AS inputs
           JOIN custody_proofs AS proofs
             ON proofs.scope_id = inputs.scope_id
            AND proofs.proof_id = inputs.proof_id
           WHERE inputs.operation_id = ?`,
        )
        .all(custody.operation_id) as Array<{
        nut07State: string
        selectability: string
        reservationOperationId: string | null
      }>
      const reservationCount = recoveredDatabase
        .prepare(
          `SELECT count(*) AS count FROM custody_proof_reservations
           WHERE operation_id = ?`,
        )
        .get(custody.operation_id) as { count: number }
      const activeWorkCount = recoveredDatabase
        .prepare('SELECT count(*) AS count FROM custody_active_work WHERE operation_id = ?')
        .get(custody.operation_id) as { count: number }
      const refundProofCount = recoveredDatabase
        .prepare(
          `SELECT count(*) AS count
           FROM target_wallet_proofs
           WHERE state = 'available' AND asset_kind = 'sats' AND unit = 'msat'`,
        )
        .get() as { count: number }
      recoveredDatabase.close()
      assert.deepEqual({ ...recoveredCustody }, { operationState: 'aborted', resultState: 'none' })
      assert.equal(
        retiredInputs.every(
          ({ nut07State, selectability, reservationOperationId }) =>
            nut07State === 'SPENT' && selectability === 'spent' && reservationOperationId === null,
        ),
        true,
      )
      assert.equal(reservationCount.count, 0)
      assert.equal(activeWorkCount.count, 0)
      assert.ok(refundProofCount.count > 0)
      assert.deepEqual(await restarted.recover(WALLET_SEED_HEX, client), {
        recovered: [],
        pending: [],
      })
      // Consume the refunded proofs through the ordinary durable outgoing path.
      // The adjacent mint is deterministic; SQLite custody admission is real.
      const exactRefund = {
        custodyOperationId: custody.operation_id,
        refundOperationId: completedRefund!.operationId,
        refundProofs: completedRefund!.resultProofs!.refund,
        refundAsset: regularAsset(),
        refundKeyset: rotatedMintKeys(),
        observedAtMs: nowMs,
      }
      const exactCoordinator = new DaemonCtfRangeCoordinator(directory, activeFence)
      const healthyBefore = await rangeRecoverySnapshot(directory)
      const healthyKeys = mint.calls.getKeys
      const healthyRecovery = new DaemonCtfRangeOrderCoordinator(
        directory,
        () => activeFence,
        dependencies,
      )
      assert.deepEqual(await healthyRecovery.recover(WALLET_SEED_HEX, client), {
        recovered: [],
        pending: [],
      })
      assert.equal(mint.calls.getKeys, healthyKeys)
      assert.equal(
        isDeepStrictEqual(await rangeRecoverySnapshot(directory), healthyBefore),
        true,
        'healthy terminal history must not mutate custody',
      )
      const omitted = await openDaemonStateSqlite(directory)
      for (const proof of exactRefund.refundProofs) {
        const id = deriveDurableCustodyProofId({
          scopeId: testScopeId(),
          normalizedMint: MINT_URL,
          unit: 'msat',
          keysetId: proof.id,
          secret: proof.secret,
        })
        assert.equal(
          omitted
            .prepare('DELETE FROM custody_proofs WHERE scope_id = ? AND proof_id = ?')
            .run(testScopeId(), id).changes,
          1,
        )
      }
      // Synthetic noncandidate journal rows test indexed pagination only. Their
      // absent parents do not represent independent valid refunded operations.
      for (let index = 0; index < 257; index++) {
        const operationId = `pagination-noncandidate-${String(index).padStart(3, '0')}`
        prepareCtfRangeRefundProofOperationFromDatabase(
          omitted,
          {
            operationId,
            kind: 'swap-refund',
            mintUrl: completedRefund!.mintUrl,
            inputs: completedRefund!.inputs,
            outputs: completedRefund!.outputs,
            metadata: {
              ...completedRefund!.metadata,
              rangeOperationId: 'absent-pagination-parent',
            },
          },
          1,
        )
        completeCtfRangeRefundProofOperationFromDatabase(
          omitted,
          operationId,
          exactRefund.refundProofs,
          1,
        )
      }
      omitted.close()
      let repairMetadataUnavailable = true
      const legacyRecovery = new DaemonCtfRangeOrderCoordinator(directory, () => activeFence, {
        ...dependencies,
        createMint: () => ({
          ...mint,
          getKeys: async (id: string) => {
            if (repairMetadataUnavailable) throw new Error('temporary refund metadata unavailable')
            return mint.getKeys(id)
          },
        }),
      })
      const keysBeforePage = mint.calls.getKeys
      const prefixPage = await legacyRecovery.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(prefixPage, { recovered: [], pending: [], deferredCount: 1 })
      assert.equal(
        mint.calls.getKeys,
        keysBeforePage,
        'noncandidate history must not contact the mint',
      )
      const deferredRepair = await legacyRecovery.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(deferredRepair.recovered, [])
      assert.equal(deferredRepair.pending.length, 1)
      assert.equal(deferredRepair.pending[0]!.operationId, exactRefund.refundOperationId)
      assert.match(deferredRepair.pending[0]!.error, /temporary refund metadata unavailable/)
      repairMetadataUnavailable = false
      assert.deepEqual(await legacyRecovery.recover(WALLET_SEED_HEX, client), {
        recovered: [(await counterRangeId(directory, 'client-order-1')) + ':source'],
        pending: [],
      })
      const metadataCalls = mint.calls.getKeys
      assert.deepEqual(await legacyRecovery.recover(WALLET_SEED_HEX, client), {
        recovered: [],
        pending: [],
      })
      assert.equal(
        mint.calls.getKeys,
        metadataCalls,
        'exhausted terminal history must not load mint keys',
      )
      await spendRecoveredRefund(
        directory,
        () => activeFence,
        () => nowMs,
      )
      const afterSpend = await walletSummary()
      await exactCoordinator.completeRefund(exactRefund)
      assert.deepEqual(
        await walletSummary(),
        afterSpend,
        'refund replay cannot restore spent proofs',
      )
      const spentDatabase = await openDaemonStateSqlite(directory)
      try {
        const store = new DurableCustodySqliteStore(spentDatabase)
        for (const proof of exactRefund.refundProofs) {
          const id = deriveDurableCustodyProofId({
            scopeId: testScopeId(),
            normalizedMint: MINT_URL,
            unit: 'msat',
            keysetId: proof.id,
            secret: proof.secret,
          })
          assert.equal(store.getProof(testScopeId(), id)?.selectability, 'spent')
        }
      } finally {
        spentDatabase.close()
      }
      assert.equal(refundRequests.length, 1)
    },
  )
})

async function spendRecoveredRefund(
  directory: string,
  getFence: () => CustodyScopeFence,
  now: () => number,
): Promise<void> {
  let counterSource = createDaemonCounterSource(
    () => ({ fence: getFence(), observedAtMs: now() }),
    { normalizedMint: MINT_URL, unit: 'msat' },
  )
  let mintCalls = 0
  const wallet: Parameters<DaemonDurableOutgoingCashuCoordinator['execute']>[0]['wallet'] = {
    loadMint: async () => {},
    receive: async () => [],
    send: async () => ({ keep: [], send: [] }),
    getKeyset: (id?: string) => ({
      ...(id === ROTATED_OFFER_KEYSET_ID ? rotatedMintKeys() : mintKeys()),
      fee: INPUT_FEE_PPK,
      expiry: FINAL_EXPIRY,
      verify: () => true,
    }),
    prepareSwapToSend: async (amount, proofs, config) => {
      const total = proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0)
      const fees = Math.ceil((proofs.length * INPUT_FEE_PPK) / 1000)
      const sendTemplates = OutputData.createRandomData(Amount.from(amount), mintKeys())
      const keepTemplates = OutputData.createRandomData(
        Amount.from(total - amount - fees),
        mintKeys(),
      )
      const range = await counterSource.reserve(
        OFFER_KEYSET_ID,
        sendTemplates.length + keepTemplates.length,
      )
      const options = config as {
        onCountersReserved: (value: {
          keysetId: string
          start: number
          count: number
          next: number
        }) => void
      }
      options.onCountersReserved({
        keysetId: OFFER_KEYSET_ID,
        start: range.start,
        count: range.count,
        next: range.start + range.count,
      })
      let counter = range.start
      const outputs = (templates: OutputData[]) =>
        templates.map((template) =>
          OutputData.createSingleDeterministicData(
            template.blindedMessage.amount,
            Buffer.from(WALLET_SEED_HEX, 'hex'),
            counter++,
            OFFER_KEYSET_ID,
          ),
        )
      return {
        amount: Amount.from(amount),
        fees: Amount.from(fees),
        keysetId: OFFER_KEYSET_ID,
        inputs: proofs,
        sendOutputs: outputs(sendTemplates),
        keepOutputs: outputs(keepTemplates),
        unselectedProofs: [],
      }
    },
    completeSwap: async (preview) => {
      mintCalls += 1
      return {
        send: (preview.sendOutputs ?? []).map(signedProof),
        keep: (preview.keepOutputs ?? []).map(signedProof),
      }
    },
    checkProofsStates: async (proofs) =>
      proofs.map((proof) => ({ Y: proofY(proof), state: 'UNSPENT' as const })),
  }
  const outgoing = new DaemonDurableOutgoingCashuCoordinator(directory, getFence, {}, now)
  const sent = await outgoing.execute({
    transferId: 'spend-exact-refund',
    amountMsat: 1000,
    mintUrl: MINT_URL,
    wallet,
    createWallet: (source) => {
      counterSource = source
      return wallet
    },
    seed: Buffer.from(WALLET_SEED_HEX, 'hex'),
  })
  assert.equal(mintCalls, 1)
  assert.ok(sent.token !== null)
  assert.equal(
    sent.token.proofs.reduce((sum, proof) => sum + amountToNumber(proof.amount), 0),
    1000,
  )
}

for (const faultPhase of ['before-commit', 'after-commit'] as const) {
  test(`daemon recovers source binding ${faultPhase} without wallet loading or order submission`, async () => {
    const proof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
    await withDaemonProfile(
      {
        prefix: 'bitcaster-range-staged-',
        incarnationId: 'range-staged-recovery-test',
        proofs: [proof],
        asset: regularAsset(),
      },
      async ({ directory, fence }) => {
        const wallet = new FakeWallet([proof])
        const ids = ['range-staged', 'authorization-staged']
        const mint = fakeMint()
        const client = fakeEngineClient(() => {
          throw new Error('recovery must not request a capability')
        })
        const first = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => mint,
          injectRangeBindFault: (phase) => {
            if (phase === faultPhase) throw new Error('binding interrupted')
          },
          createWallet: () => wallet,
          now: () => 10_000,
          randomId: () => ids.shift()!,
        })
        await assert.rejects(first.prepare(orderRequest(), client), /binding interrupted/)
        assert.equal(wallet.completeCalls, 1)
        const beforeRecovery = await rangeRecoverySnapshot(directory)
        if (faultPhase === 'before-commit') {
          const interrupted = await readState()
          assert.equal(interrupted?.wallet.proofs.length, 1)
          assert.equal(interrupted?.wallet.proofs[0]?.state, 'reserved')
          assert.equal(
            interrupted?.proofOperations[
              (await counterRangeId(directory, 'client-order-1')) + ':source'
            ]?.state,
            'prepared',
          )
          const database = await openDaemonStateSqlite(directory)
          try {
            assert.equal(
              database.prepare('SELECT count(*) AS count FROM custody_operations').get()?.count,
              1,
            )
            assert.equal(
              database.prepare('SELECT result_state AS state FROM custody_operations').get()?.state,
              'verified-staged',
            )
            assert.equal(
              database.prepare('SELECT count(*) AS count FROM custody_proofs').get()?.count,
              1,
            )
            assert.equal(
              database.prepare('SELECT selectability FROM custody_proofs').get()?.selectability,
              'locked',
            )
            assert.equal(
              database.prepare('SELECT count(*) AS count FROM custody_successor_admissions').get()
                ?.count,
              0,
            )
          } finally {
            database.close()
          }
        }
        const restarted = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => mint,
          createWallet: () => {
            throw new Error('staged recovery must not load a wallet')
          },
          now: () => 10_000,
        })
        const result = await restarted.recover(WALLET_SEED_HEX, client)
        assert.equal(result.pending.length, 1)
        assert.match(result.pending[0]!.error, /unsubmitted range authorization remains unspent/)
        assert.equal(wallet.completeCalls, 1)
        assert.deepEqual((await readState())?.orders, {})
        await assertSourceCustodyIdentity(directory, 'ctf-range-regular-source')
        if (faultPhase === 'after-commit') {
          assert.deepEqual(await rangeRecoverySnapshot(directory), beforeRecovery)
        }
      },
    )
  })
}

test('daemon binds a conditional source to range custody without consolidation', async () => {
  const proof = signedProof(
    OutputData.createRandomData(Amount.from(16_384), conditionalMintKeys())[0]!,
  )
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-conditional-direct-',
      incarnationId: 'range-conditional-direct',
      proofs: [proof],
      asset: outcomeAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet([proof])
      const ids = ['range-conditional-direct', 'authorization-conditional-direct']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })
      await coordinator.prepare(
        {
          ...orderRequest(),
          side: 'Sell',
          maxQuotePaymentSubunits: null,
          minQuotePaymentSubunits: 500,
          amountSubunits: 10_000,
          minimumFillAmountSubunits: 10_000,
        },
        fakeEngineClient(boundCapability),
      )
      assert.equal(wallet.completeCalls, 1)
      await assertCounterAuthorityPairs(directory)
      await assertSourceCustodyIdentity(directory, 'ctf-range-conditional-source')
    },
  )
})

test('daemon consolidates conditional CTF inventory with the same bounded source protocol', async () => {
  const sourceProofs = [8_192, 1_024, 512, 128, 128, 4, 4, 4, 4, 4, 4].map((amount) =>
    signedProof(OutputData.createRandomData(Amount.from(amount), conditionalMintKeys())[0]!),
  )
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-conditional-',
      incarnationId: 'range-conditional-production-test',
      proofs: sourceProofs,
      asset: outcomeAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet(sourceProofs)
      const ids = ['range-operation-conditional', 'range-authorization-conditional']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(8),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })

      // Ten current-D shares keep this bounded-consolidation fixture fragmented.
      const prepared = await coordinator.prepare(
        {
          ...orderRequest(),
          side: 'Sell',
          maxQuotePaymentSubunits: null,
          minQuotePaymentSubunits: 500,
          price: 500,
          amountSubunits: 10_000,
          minimumFillAmountSubunits: 10_000,
          consolidateProofs: true,
        },
        fakeEngineClient(boundCapability),
      )

      assert.deepEqual(prepared.consolidation, {
        operationIds: [
          (await counterRangeId(directory, 'client-order-1')) + ':source:consolidation:0',
        ],
        feeSubunits: 1,
      })
      assert.equal(wallet.completeCalls, 2)
      await assertCounterAuthorityPairs(directory)
      await assertSourceCustodyIdentity(directory, 'ctf-range-conditional-source')
      assert.equal(
        (await readState())?.proofOperations[
          (await counterRangeId(directory, 'client-order-1')) + ':source'
        ]?.state,
        'completed',
      )
      await assertSeedAbsentFromArtifacts(directory)
    },
  )
})

test('daemon prepares a real retained successor through a fresh range preparation', async () => {
  const sourceProofs = OutputData.createRandomData(Amount.from(20_000), conditionalMintKeys()).map(
    signedProof,
  )
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-retained-follow-up-',
      incarnationId: 'range-retained-follow-up-test',
      proofs: sourceProofs,
      asset: outcomeAsset(),
    },
    async ({ directory, fence }) => {
      const wallet = new FakeWallet(sourceProofs)
      const ids = [
        'range-retained-producer',
        'authorization-retained-producer',
        'range-retained-follow-up',
        'authorization-retained-follow-up',
      ]
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => fakeMint(8),
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })
      let capabilityIndex = 0
      const engine = fakeEngineClient((request) => {
        capabilityIndex += 1
        return {
          ...boundCapability(request),
          orderId: `00000000-0000-8000-8000-${String(capabilityIndex).padStart(12, '0')}`,
        }
      })

      await coordinator.prepare(
        {
          ...orderRequest(),
          clientOrderId: 'client-retained-producer',
          side: 'Sell',
          maxQuotePaymentSubunits: null,
          minQuotePaymentSubunits: 500,
          amountSubunits: 5_000,
          minimumFillAmountSubunits: 5_000,
        },
        engine,
      )
      const firstSource = (await readState())?.proofOperations[
        (await counterRangeId(directory, 'client-retained-producer')) + ':source'
      ]
      assert.equal(firstSource?.state, 'completed')
      const retainedSuccessors = firstSource?.resultProofs?.keep ?? []
      assert.ok(retainedSuccessors.length > 0)
      await assertSourceCustodyIdentity(
        directory,
        'ctf-range-conditional-source',
        (await counterRangeId(directory, 'client-retained-producer')) + ':source',
      )
      const beforeFollowUp = await retainedSuccessorRows(directory, retainedSuccessors)
      assert.ok(
        beforeFollowUp.every(
          ({ selectability, targetState }) =>
            selectability === 'retained' && targetState === 'available',
        ),
      )

      let checkedFollowUpReservation = false
      wallet.beforeCompleteConditionalSwap = async () => {
        const preparedState = await readState()
        const preparedSource =
          preparedState?.proofOperations[
            (await counterRangeId(directory, 'client-retained-follow-up')) + ':source'
          ]
        assert.equal(preparedSource?.state, 'prepared')
        const retainedSecrets = new Set(retainedSuccessors.map(({ secret }) => secret))
        assert.ok(
          preparedSource?.inputs.some(({ secret }) => retainedSecrets.has(secret)),
          'follow-up preparation must select a retained successor before mint completion',
        )
        await assertExactTargetAndCanonicalReservations(
          directory,
          (await counterRangeId(directory, 'client-retained-follow-up')) + ':source',
          preparedSource!.inputs,
        )
        checkedFollowUpReservation = true
      }

      await coordinator.prepare(
        {
          ...orderRequest(),
          clientOrderId: 'client-retained-follow-up',
          side: 'Sell',
          maxQuotePaymentSubunits: null,
          minQuotePaymentSubunits: 500,
          amountSubunits: 10_000,
          minimumFillAmountSubunits: 10_000,
        },
        engine,
      )
      const followUpSource = (await readState())?.proofOperations[
        (await counterRangeId(directory, 'client-retained-follow-up')) + ':source'
      ]
      assert.equal(followUpSource?.state, 'completed')
      assert.equal(checkedFollowUpReservation, true)
      const retainedSecrets = new Set(retainedSuccessors.map(({ secret }) => secret))
      assert.ok(
        followUpSource?.inputs.some(({ secret }) => retainedSecrets.has(secret)),
        'the second preparation must consume a successor created by the first preparation',
      )
      await assertSourceCustodyIdentity(
        directory,
        'ctf-range-conditional-source',
        (await counterRangeId(directory, 'client-retained-follow-up')) + ':source',
      )
      assert.equal(wallet.completeCalls, 2)
    },
  )
})

// A full held-share Sell spends exactly the held face. The wallet holds one
// share of YES face (1,000 msat as six proofs), so shares cannot also pay the
// conditional input fee. Seven source inputs at 100 ppk cost 1 msat of cash.
const HELD_SHARE_FACE = 1_000

test('daemon prepares a full held-share Sell from exact shares plus fee cash', async () => {
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-full-exit-',
      incarnationId: 'range-full-exit-test',
      proofs: heldShareProofs(),
      asset: outcomeAsset(),
      cashProofs: [cashProof(64)],
    },
    async ({ directory, fence }) => {
      const mint = mixedSourceMint()
      let capabilityCalls = 0
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => mint,
        createWallet: () => {
          throw new Error('mixed preparation must not use the swap wallet')
        },
        now: () => 10_000,
        randomId: randomIds('range-full-exit'),
      })

      await coordinator.prepare(
        sellOneShareRequest(),
        fakeEngineClient((request) => {
          capabilityCalls += 1
          return boundCapability(request)
        }),
      )

      assert.equal(mint.convertRequests.length, 1)
      assert.deepEqual(convertInputTotals(mint.convertRequests[0]!), { YES: 1_000, '*': 64 })
      assert.equal(capabilityCalls, 1)
      await assertCounterAuthorityPairs(directory)
      assert.deepEqual(await walletSummary(), {
        availableShares: 0,
        availableCash: 63,
        reservedShares: 0,
        reservedCash: 0,
      })
      await assertSourceCustodyIdentity(directory, 'ctf-range-conditional-source')
    },
  )
})

const LOST_SOURCE_RESPONSE_CASES = [
  {
    name: 'all-unspent inputs replay the exact conversion',
    observe: () => 'UNSPENT' as const,
    restore: 'unused' as const,
    expected: {
      conversions: 2,
      pending: /unsubmitted range authorization remains unspent before expiry/,
      sourceResult: 'applied',
      wallet: { availableShares: 0, availableCash: 63, reservedShares: 0, reservedCash: 0 },
    },
  },
  {
    name: 'all-spent inputs restore the exact outputs',
    observe: () => 'SPENT' as const,
    restore: 'complete' as const,
    expected: {
      conversions: 1,
      pending: /unsubmitted range authorization remains unspent before expiry/,
      sourceResult: 'applied',
      wallet: { availableShares: 0, availableCash: 63, reservedShares: 0, reservedCash: 0 },
    },
  },
  {
    name: 'all-spent inputs with a missing output stay pending',
    observe: () => 'SPENT' as const,
    restore: 'missing-output' as const,
    expected: {
      conversions: 1,
      pending: /custody mint proof count is invalid/,
      sourceResult: 'none',
      wallet: { availableShares: 0, availableCash: 0, reservedShares: 1_000, reservedCash: 64 },
    },
  },
  {
    name: 'mixed input states stay pending',
    observe: (index: number) => (index === 0 ? ('SPENT' as const) : ('UNSPENT' as const)),
    restore: 'unused' as const,
    expected: {
      conversions: 1,
      pending: /remains pending at the mint \(mixed-input-states\)/,
      sourceResult: 'none',
      wallet: { availableShares: 0, availableCash: 0, reservedShares: 1_000, reservedCash: 64 },
    },
  },
  {
    name: 'a pending input stays pending',
    observe: (index: number) => (index === 0 ? ('PENDING' as const) : ('UNSPENT' as const)),
    restore: 'unused' as const,
    expected: {
      conversions: 1,
      pending: /remains pending at the mint \(pending-input-state\)/,
      sourceResult: 'none',
      wallet: { availableShares: 0, availableCash: 0, reservedShares: 1_000, reservedCash: 64 },
    },
  },
]

for (const scenario of LOST_SOURCE_RESPONSE_CASES) {
  test(`daemon recovers a lost mixed source response after restart: ${scenario.name}`, async () => {
    await withDaemonProfile(
      {
        prefix: 'bitcaster-range-mixed-lost-',
        incarnationId: 'range-mixed-lost-test',
        proofs: heldShareProofs(),
        asset: outcomeAsset(),
        cashProofs: [cashProof(64)],
      },
      async ({ directory, fence }) => {
        const inputStates = new Map<string, SourceInputState>()
        const conversions: string[] = []
        const convert = async (request: CtfConvertRequest) => {
          conversions.push(exactRequestJson(request))
          if (conversions.length > 1) return signConvertRequest(request)
          convertInputs(request).forEach((proof, index) =>
            inputStates.set(proofY(proof), scenario.observe(index)),
          )
          throw new Error('mint convert response lost')
        }
        const client = fakeEngineClient(() => {
          throw new Error('a prepared journal must not request a capability')
        })
        const first = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => mixedSourceMint({ convert, inputStates }),
          now: () => 10_000,
          randomId: randomIds('range-mixed-lost'),
        })
        await assert.rejects(first.prepare(sellOneShareRequest(), client), /response lost/)

        const restartedMint = mixedSourceMint({ convert, inputStates })
        const restarted = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => restartedMint,
          createWallet: () => {
            throw new Error('mixed source recovery must not load the swap wallet')
          },
          restoreOutputs: async (_mintUrl, groups) => restoredGroups(groups, scenario.restore),
          now: () => 10_000,
        })
        const recovered = await restarted.recover(WALLET_SEED_HEX, client)

        assert.deepEqual(recovered.recovered, [])
        assert.equal(recovered.pending.length, 1)
        assert.match(recovered.pending[0]!.error, scenario.expected.pending)
        assert.equal(conversions.length, scenario.expected.conversions)
        assert.equal(new Set(conversions).size, 1, 'a retry changed the exact conversion')
        assert.equal(restartedMint.metadataCallsAtInputCheck[0], 0)
        assert.equal(
          (await mixedSourceCustody(directory)).sourceResult,
          scenario.expected.sourceResult,
        )
        assert.deepEqual(await walletSummary(), scenario.expected.wallet)

        // A second pass must not commit recovered successors again.
        await restarted.recover(WALLET_SEED_HEX, client)
        assert.equal(conversions.length, scenario.expected.conversions)
        assert.deepEqual(await walletSummary(), scenario.expected.wallet)
      },
    )
  })
}

for (const faultPhase of ['before-commit', 'after-commit'] as const) {
  test(`daemon resumes a mixed source at the outer handoff ${faultPhase} without a new conversion`, async () => {
    await withDaemonProfile(
      {
        prefix: 'bitcaster-range-mixed-handoff-',
        incarnationId: 'range-mixed-handoff-test',
        proofs: heldShareProofs(),
        asset: outcomeAsset(),
        cashProofs: [cashProof(64)],
      },
      async ({ directory, fence }) => {
        const client = fakeEngineClient(() => {
          throw new Error('recovery must not request a capability')
        })
        const mint = mixedSourceMint()
        const first = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => mint,
          injectRangeBindFault: (phase) => {
            if (phase === faultPhase) throw new Error('binding interrupted')
          },
          now: () => 10_000,
          randomId: randomIds('range-mixed-handoff'),
        })
        await assert.rejects(first.prepare(sellOneShareRequest(), client), /binding interrupted/)
        assert.equal(mint.convertRequests.length, 1)

        const restartedMint = mixedSourceMint({
          convert: async () => {
            throw new Error('handoff recovery must not convert again')
          },
        })
        const restarted = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => restartedMint,
          createWallet: () => {
            throw new Error('handoff recovery must not load the swap wallet')
          },
          now: () => 10_000,
        })
        const result = await restarted.recover(WALLET_SEED_HEX, client)

        assert.equal(result.pending.length, 1)
        assert.match(result.pending[0]!.error, /unsubmitted range authorization remains unspent/)
        assert.equal(restartedMint.convertRequests.length, 0)
        assert.deepEqual(await walletSummary(), {
          availableShares: 0,
          availableCash: 63,
          reservedShares: 0,
          reservedCash: 0,
        })
        await assertSourceCustodyIdentity(directory, 'ctf-range-conditional-source')
      },
    )
  })
}

test('daemon keeps both mixed reservations when a duplicate retry loses to the original conversion', async () => {
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-mixed-race-',
      incarnationId: 'range-mixed-race-test',
      proofs: heldShareProofs(),
      asset: outcomeAsset(),
      cashProofs: [cashProof(64)],
    },
    async ({ directory, fence }) => {
      let nowMs = 10_000
      let notifyOriginalStarted!: () => void
      const originalStarted = new Promise<void>((resolve) => {
        notifyOriginalStarted = resolve
      })
      let releaseOriginal!: () => void
      const originalReleased = new Promise<void>((resolve) => {
        releaseOriginal = resolve
      })
      const conversions: string[] = []
      const mint = mixedSourceMint({
        convert: async (request) => {
          conversions.push(exactRequestJson(request))
          if (conversions.length > 1) {
            throw new MintOperationError(11002, 'duplicate retry lost to the original request')
          }
          notifyOriginalStarted()
          await originalReleased
          return signConvertRequest(request)
        },
      })
      let capabilityCalls = 0
      let scoreCalls = 0
      let orderCalls = 0
      const client = fakeEngineClient(
        (request) => {
          capabilityCalls += 1
          return boundCapability(request)
        },
        async () => {
          orderCalls += 1
          return submittedOrder()
        },
      )
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => mint,
        authorizationLifetimeSeconds: 20,
        executeRefundSwap: async (_mintUrl, request) => ({
          signatures: request.outputs.map(signBlindedOutput),
        }),
        now: () => nowMs,
        randomId: randomIds('range-mixed-race'),
      })

      const preparing = coordinator
        .prepare(sellOneShareRequest(), client, async () => {
          scoreCalls += 1
        })
        .then(
          () => null,
          (error: unknown) => error,
        )
      await originalStarted
      nowMs = 30_000
      const duplicate = await coordinator.recover(WALLET_SEED_HEX, client)

      assert.deepEqual(duplicate.recovered, [])
      assert.equal(duplicate.pending.length, 1)
      assert.match(duplicate.pending[0]!.error, /replay rejection remains pending/)
      assert.deepEqual(conversions, [conversions[0], conversions[0]])
      assert.deepEqual(await walletSummary(), {
        availableShares: 0,
        availableCash: 0,
        reservedShares: 1_000,
        reservedCash: 64,
      })
      assert.deepEqual(await mixedSourceCustody(directory), {
        sourceResult: 'none',
        sourceOperation: 'dispatch-intent',
        reservations: 7,
        lifecycle: 'prepared',
      })

      releaseOriginal()
      const prepareError = await preparing
      assert.ok(prepareError instanceof Error)
      assert.match(prepareError.message, /expired before capability admission/)
      assert.equal(scoreCalls, 0)
      assert.equal(capabilityCalls, 0)
      assert.equal(orderCalls, 0)
      assert.equal(conversions.length, 2)
      assert.equal(await completedRefundCount(), 1)
      assert.equal((await mixedSourceCustody(directory)).lifecycle, 'terminal')
      assert.equal((await walletSummary()).availableCash, 63)
    },
  )
})

const EXPIRY_BOUNDARY_CASES = [
  {
    journal: 'prepared',
    boundary: 'one millisecond before expiry',
    recoveryAtMs: 29_999,
    expected: {
      capabilityCalls: 0,
      recovered: false,
      pending: /unsubmitted range authorization remains unspent before expiry/,
      lifecycle: 'prepared',
      refunds: 0,
    },
  },
  {
    journal: 'prepared',
    boundary: 'at the exact expiry',
    recoveryAtMs: 30_000,
    expected: {
      capabilityCalls: 0,
      recovered: true,
      pending: null,
      lifecycle: 'terminal',
      refunds: 1,
    },
  },
  {
    journal: 'capability-requested',
    boundary: 'one millisecond before expiry',
    recoveryAtMs: 29_999,
    expected: {
      capabilityCalls: 2,
      recovered: false,
      pending: /recovered range capability requires custody reconciliation/,
      lifecycle: 'capability-bound',
      refunds: 0,
    },
  },
  {
    journal: 'capability-requested',
    boundary: 'at the exact expiry',
    recoveryAtMs: 30_000,
    expected: {
      capabilityCalls: 1,
      recovered: true,
      pending: null,
      lifecycle: 'terminal',
      refunds: 1,
    },
  },
] as const

for (const scenario of EXPIRY_BOUNDARY_CASES) {
  test(`daemon recovers a mixed ${scenario.journal} journal ${scenario.boundary}`, async () => {
    await withDaemonProfile(
      {
        prefix: 'bitcaster-range-mixed-expiry-',
        incarnationId: 'range-mixed-expiry-test',
        proofs: heldShareProofs(),
        asset: outcomeAsset(),
        cashProofs: [cashProof(64)],
      },
      async ({ directory, fence }) => {
        let nowMs = 10_000
        let conversions = 0
        const mint = mixedSourceMint({
          convert: async (request) => {
            conversions += 1
            if (scenario.journal === 'prepared' && conversions === 1) {
              throw new Error('mint convert response lost')
            }
            return signConvertRequest(request)
          },
        })
        let capabilityCalls = 0
        let orderCalls = 0
        const client = fakeEngineClient(
          (request) => {
            capabilityCalls += 1
            if (capabilityCalls === 1) throw new Error('capability acknowledgement lost')
            return boundCapability(request)
          },
          async () => {
            orderCalls += 1
            return submittedOrder()
          },
        )
        const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => mint,
          authorizationLifetimeSeconds: 20,
          executeRefundSwap: async (_mintUrl, request) => ({
            signatures: request.outputs.map(signBlindedOutput),
          }),
          now: () => nowMs,
          randomId: randomIds('range-mixed-expiry'),
        })
        await assert.rejects(coordinator.prepare(sellOneShareRequest(), client), /lost/)
        assert.equal((await mixedSourceCustody(directory)).lifecycle, scenario.journal)

        nowMs = scenario.recoveryAtMs
        const result = await coordinator.recover(WALLET_SEED_HEX, client)

        assert.equal(result.recovered.length, scenario.expected.recovered ? 1 : 0)
        if (scenario.expected.pending === null) assert.deepEqual(result.pending, [])
        else assert.match(result.pending[0]?.error ?? '', scenario.expected.pending)
        if (scenario.expected.lifecycle === 'capability-bound')
          assert.equal(result.pending[0]?.retryAtMs, scenario.recoveryAtMs)
        assert.equal(capabilityCalls, scenario.expected.capabilityCalls)
        assert.equal(orderCalls, 0)
        assert.equal((await mixedSourceCustody(directory)).lifecycle, scenario.expected.lifecycle)
        assert.equal(await completedRefundCount(), scenario.expected.refunds)
      },
    )
  })
}

const FRESH_SELECTION_RESTART_CASES = [
  {
    name: 'current mint metadata permits fresh mixed selection',
    metadataAvailable: true,
    expected: {
      conversions: 1,
      pending: /unsubmitted range authorization remains unspent before expiry/,
      wallet: { availableShares: 0, availableCash: 63, reservedShares: 0, reservedCash: 0 },
    },
  },
  {
    name: 'unavailable current mint metadata refuses fresh selection',
    metadataAvailable: false,
    expected: {
      conversions: 0,
      pending: /current mint metadata is unavailable/,
      wallet: { availableShares: 1_000, availableCash: 64, reservedShares: 0, reservedCash: 0 },
    },
  },
]

for (const scenario of FRESH_SELECTION_RESTART_CASES) {
  test(`daemon selects a new source after restart only with current metadata: ${scenario.name}`, async () => {
    await withDaemonProfile(
      {
        prefix: 'bitcaster-range-mixed-fresh-',
        incarnationId: 'range-mixed-fresh-test',
        proofs: heldShareProofs(),
        asset: outcomeAsset(),
      },
      async ({ directory, fence }) => {
        const client = fakeEngineClient(() => {
          throw new Error('a prepared journal must not request a capability')
        })
        const previewCash = cashProof(64)
        await addAvailableProofs([previewCash], regularAsset())
        const preview = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => mixedSourceMint(),
          now: () => 10_000,
          randomId: randomIds('range-mixed-fresh-preview'),
        })
        const consent = await preview.previewFeeFacts(sellOneShareRequest(), client)
        const stateBeforeMissingCash = await readState()
        assert.ok(stateBeforeMissingCash)
        stateBeforeMissingCash.wallet.proofs = stateBeforeMissingCash.wallet.proofs.filter(
          ({ proof }) => proof.secret !== previewCash.secret,
        )
        await writeState(stateBeforeMissingCash)
        const database = await openDaemonStateSqlite(directory)
        try {
          const store = new DurableCustodySqliteStore(database)
          const proofId = deriveDurableCustodyProofId({
            scopeId: testScopeId(),
            normalizedMint: MINT_URL,
            unit: 'msat',
            keysetId: previewCash.id,
            secret: previewCash.secret,
          })
          const row = store.getProof(testScopeId(), proofId)
          assert.ok(row)
          store.putProofCas(
            { ...row, nut07State: 'SPENT', selectability: 'spent', revision: row.revision + 1 },
            row.revision,
          )
        } finally {
          database.close()
        }
        const first = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => mixedSourceMint(),
          now: () => 10_000,
          randomId: randomIds('range-mixed-fresh'),
        })
        await assert.rejects(
          first.prepare(sellOneShareRequest(), client, undefined, consent),
          /needs ordinary sats to pay the range source preparation fee/,
        )
        assert.equal((await mixedSourceCustody(directory)).lifecycle, 'prepared')
        await addAvailableProofs([cashProof(64)], regularAsset())

        const restartedMint = mixedSourceMint({
          metadataAvailable: scenario.metadataAvailable,
        })
        const restarted = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => restartedMint,
          now: () => 10_000,
        })
        const result = await restarted.recover(WALLET_SEED_HEX, client)

        assert.equal(result.pending.length, 1)
        assert.match(result.pending[0]!.error, scenario.expected.pending)
        assert.equal(restartedMint.convertRequests.length, scenario.expected.conversions)
        if (scenario.metadataAvailable) {
          assert.ok(restartedMint.metadataCallsAtConvert[0]! > 0)
        }
        assert.deepEqual(await walletSummary(), scenario.expected.wallet)
      },
    )
  })
}

// Exact shares need six authorization outputs. Two msat of cash pays the
// 1 msat fee and leaves one change output, so the conversion needs seven.
// Consolidation is enabled in every row: a refusal must not spend a fee on it.
const FEE_CASH_REFUSAL = /daemon wallet needs ordinary sats to pay the range source preparation fee/
const MINT_LIMIT_REFUSAL =
  /daemon range source needs more proofs than the mint accepts in one request/
const SELECTION_BOUNDARY_CASES = [
  {
    name: 'at the advertised output limit',
    cash: [2],
    maxOutputs: 7,
    expected: {
      conversionOutputCounts: [7],
      error: null,
      proofOperations: 1,
      consolidationFees: [],
      wallet: { availableShares: 0, availableCash: 1, reservedShares: 0, reservedCash: 0 },
    },
  },
  {
    name: 'above the advertised output limit',
    cash: [2],
    maxOutputs: 6,
    expected: {
      conversionOutputCounts: [],
      error: MINT_LIMIT_REFUSAL,
      proofOperations: 0,
      consolidationFees: [],
      wallet: { availableShares: 1_000, availableCash: 2, reservedShares: 0, reservedCash: 0 },
    },
  },
  {
    // 62 x 16 + 2 x 4 = 1,000 fills all 64 inputs, so no cash input fits.
    name: 'with cash for face and fee but held shares filling the input bound',
    held: [...Array.from({ length: 62 }, () => 16), 4, 4],
    cash: [2_048],
    maxOutputs: 512,
    expected: {
      conversionOutputCounts: [],
      error: MINT_LIMIT_REFUSAL,
      proofOperations: 0,
      consolidationFees: [],
      wallet: { availableShares: 1_000, availableCash: 2_048, reservedShares: 0, reservedCash: 0 },
    },
  },
  {
    // The 64 largest of 62 x 16 + 12 x 4 = 1,040 still fill the input bound,
    // but ten more held proofs exist. One bounded consolidation of those 64
    // pays 7 msat of shares (64 x 100 ppk) and leaves room for fee cash. The
    // mixed source then pays a 1 msat joint fee from the 2,048 msat cash; its
    // 2,047 msat change needs 11 outputs beside the 6 authorization outputs.
    name: 'after consolidating held shares beyond the input bound',
    held: [...Array.from({ length: 62 }, () => 16), ...Array.from({ length: 12 }, () => 4)],
    cash: [2_048],
    maxOutputs: 512,
    swapWallet: true,
    expected: {
      conversionOutputCounts: [17],
      error: null,
      proofOperations: 2,
      consolidationFees: [7],
      wallet: {
        availableShares: 33,
        availableCash: 2_047,
        reservedShares: 0,
        reservedCash: 0,
      },
    },
  },
  {
    name: 'without ordinary cash for the fee',
    cash: [],
    maxOutputs: 512,
    expected: {
      conversionOutputCounts: [],
      error: FEE_CASH_REFUSAL,
      proofOperations: 0,
      consolidationFees: [],
      wallet: { availableShares: 1_000, availableCash: 0, reservedShares: 0, reservedCash: 0 },
    },
  },
]

for (const scenario of SELECTION_BOUNDARY_CASES) {
  test(`daemon selects a mixed source ${scenario.name}`, async () => {
    await withDaemonProfile(
      {
        prefix: 'bitcaster-range-mixed-outputs-',
        incarnationId: 'range-mixed-outputs-test',
        proofs: 'held' in scenario ? scenario.held.map(heldShareProof) : heldShareProofs(),
        asset: outcomeAsset(),
        cashProofs: scenario.cash.map(cashProof),
      },
      async ({ directory, fence }) => {
        const mint = mixedSourceMint({ maxOutputs: scenario.maxOutputs })
        let capabilityCalls = 0
        const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
          createMint: () => mint,
          createWallet: () => {
            if ('swapWallet' in scenario) return new FakeWallet([])
            throw new Error('mixed selection must not load the swap wallet')
          },
          now: () => 10_000,
          randomId: randomIds('range-mixed-outputs'),
        })
        const preparing = coordinator.prepare(
          { ...sellOneShareRequest(), consolidateProofs: true },
          fakeEngineClient((request) => {
            capabilityCalls += 1
            return boundCapability(request)
          }),
        )

        if (scenario.expected.error === null) await preparing
        else await assert.rejects(preparing, scenario.expected.error)
        assert.deepEqual(
          mint.convertRequests.map((request) =>
            Object.values(request.outputs).reduce((total, outputs) => total + outputs.length, 0),
          ),
          scenario.expected.conversionOutputCounts,
        )
        const operations = Object.values((await readState())?.proofOperations ?? {})
        assert.equal(operations.length, scenario.expected.proofOperations)
        assert.deepEqual(
          operations
            .filter(({ kind }) => kind === 'proof-consolidation')
            .map(({ metadata }) => metadata.fees),
          scenario.expected.consolidationFees,
        )
        assert.equal(capabilityCalls, scenario.expected.conversionOutputCounts.length)
        assert.deepEqual(await walletSummary(), scenario.expected.wallet)
      },
    )
  })
}

test('daemon range selection accepts verified retained proofs only from available wallet projection', async () => {
  const proof = heldShareProof(HELD_SHARE_FACE)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-retained-source-availability-',
      incarnationId: 'range-retained-source-availability-test',
      proofs: [proof],
      asset: outcomeAsset(),
    },
    async ({ directory }) => {
      await updateCanonicalProofRow(directory, proof, (row) => ({
        ...row,
        selectability: 'retained',
        storageClass: 'pinned-operation-bound-deterministic',
      }))
      assert.deepEqual(
        (await readCanonicalSourceCandidates(directory, proof)).proofs.map(
          ({ proof: candidate }) => candidate.secret,
        ),
        [proof.secret],
      )

      const stateWithoutAvailableProjection = await readState()
      assert.ok(stateWithoutAvailableProjection)
      const target = stateWithoutAvailableProjection.wallet.proofs.find(
        ({ proof: candidate }) => candidate.secret === proof.secret,
      )
      assert.ok(target)
      target.state = 'locked'
      target.reservedBy = 'foreign-target-reservation'
      await writeState(stateWithoutAvailableProjection)
      assert.deepEqual((await readCanonicalSourceCandidates(directory, proof)).proofs, [])

      target.state = 'available'
      delete target.reservedBy
      await writeState(stateWithoutAvailableProjection)

      await updateCanonicalProofRow(directory, proof, (row) => ({
        ...row,
        selectability: 'locked',
        reservationOperationId: 'foreign-canonical-reservation',
      }))
      assert.deepEqual((await readCanonicalSourceCandidates(directory, proof)).proofs, [])

      await updateCanonicalProofRow(directory, proof, (row) => ({
        ...row,
        nut07State: 'SPENT',
        selectability: 'spent',
        reservationOperationId: null,
      }))
      assert.deepEqual((await readCanonicalSourceCandidates(directory, proof)).proofs, [])

      await updateCanonicalProofRow(directory, proof, (row) => ({
        ...row,
        selectability: 'retained',
        storageClass: 'pinned-operation-bound-deterministic',
        reservationOperationId: 'foreign-canonical-reservation',
      }))
      assert.deepEqual((await readCanonicalSourceCandidates(directory, proof)).proofs, [])
    },
  )
})

async function updateCanonicalProofRow(
  directory: string,
  proof: Proof,
  update: (row: CustodyProofSqliteRow) => CustodyProofSqliteRow,
): Promise<void> {
  assert.ok(proof.id)
  const database = await openDaemonStateSqlite(directory)
  try {
    const scopeId = testScopeId()
    const store = new DurableCustodySqliteStore(database)
    const proofId = deriveDurableCustodyProofId({
      scopeId,
      normalizedMint: MINT_URL,
      unit: 'msat',
      keysetId: proof.id,
      secret: proof.secret,
    })
    const current = store.getProof(scopeId, proofId)
    assert.ok(current)
    const updated = update(current)
    store.putProofCas(
      {
        ...updated,
        revision: current.revision + 1,
        updatedAtMs: Math.max(current.updatedAtMs, Date.now()),
      },
      current.revision,
    )
  } finally {
    database.close()
  }
}

async function readCanonicalSourceCandidates(directory: string, proof: Proof) {
  assert.ok(proof.id)
  const database = await openDaemonStateSqlite(directory)
  try {
    return readAvailableCanonicalWalletProofPageFromDatabase(database, {
      mintUrl: MINT_URL,
      keysetId: proof.id,
      asset: outcomeAsset(),
      limit: 10,
    })
  } finally {
    database.close()
  }
}

async function assertSourceCustodyIdentity(
  directory: string,
  semanticKind: 'ctf-range-regular-source' | 'ctf-range-conditional-source',
  sourceOperationId?: string,
): Promise<void> {
  const state = await readState()
  const source = Object.values(state?.proofOperations ?? {}).find(
    ({ operationId, metadata }) =>
      metadata.purpose === 'ctf-range-authorization-source' &&
      (sourceOperationId === undefined || operationId === sourceOperationId),
  )
  assert.ok(source?.resultProofs)
  const custodyOperationId = source.metadata.custodySourceOperationId
  assert.equal(typeof custodyOperationId, 'string')
  const database = await openDaemonStateSqlite(directory)
  try {
    const rows = database
      .prepare(
        `SELECT wallet_stage AS stage, result_state AS resultState
        FROM custody_operations WHERE semantic_kind = ? AND operation_id = ?`,
      )
      .all(semanticKind, custodyOperationId)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.stage, 'capability-preparation')
    assert.equal(rows[0]!.resultState, 'applied')
    const custody = new DurableCustodySqliteStore(database)
    for (const [group, proofs] of Object.entries(source.resultProofs)) {
      for (const proof of proofs) {
        assert.ok(proof.id)
        const row = custody.getProof(
          testScopeId(),
          deriveDurableCustodyProofId({
            scopeId: testScopeId(),
            normalizedMint: MINT_URL,
            unit: 'msat',
            keysetId: proof.id,
            secret: proof.secret,
          }),
        )
        assert.ok(row)
        const target = state?.wallet.proofs.find(
          ({ proof: candidate }) => candidate.secret === proof.secret,
        )
        switch (group) {
          case 'authorization':
            assert.equal(row.selectability, 'locked')
            assert.equal(target, undefined)
            break
          case 'keep':
          case 'offered-change':
          case 'collateral-change':
            assert.equal(row.selectability, 'retained')
            assert.equal(target?.state, 'available')
            break
          default:
            assert.fail('unexpected source output group')
        }
      }
    }
    const authorizations = database
      .prepare(
        `
      SELECT proofs.selectability, proofs.condition_id AS conditionId,
        proofs.outcome_set_id AS outcomeSetId,
        proofs.reservation_operation_id = operations.operation_id AS owned,
        reservations.operation_id = operations.operation_id AS reserved
      FROM custody_operations AS operations
      JOIN custody_operation_inputs AS inputs
        ON inputs.scope_id = operations.scope_id AND inputs.operation_id = operations.operation_id
      JOIN custody_proofs AS proofs
        ON proofs.scope_id = inputs.scope_id AND proofs.proof_id = inputs.proof_id
      LEFT JOIN custody_proof_reservations AS reservations
        ON reservations.scope_id = proofs.scope_id AND reservations.proof_id = proofs.proof_id
      WHERE operations.semantic_kind = 'conditional-keyset-swap'
    `,
      )
      .all()
    assert.ok(authorizations.length > 0)
    for (const row of authorizations) {
      assert.equal(row.selectability, 'locked')
      assert.equal(row.owned, 1)
      assert.equal(row.reserved, 1)
      assert.equal(
        row.conditionId,
        semanticKind === 'ctf-range-regular-source' ? null : CONDITION_ID,
      )
      assert.equal(row.outcomeSetId, semanticKind === 'ctf-range-regular-source' ? null : 'YES')
    }
  } finally {
    database.close()
  }
}

async function assertCounterAuthorityPairs(directory: string): Promise<void> {
  const database = await openDaemonStateSqlite(directory)
  try {
    const target = database
      .prepare(
        `SELECT normalized_mint, unit, keyset_id, next_counter
         FROM target_keyset_counters ORDER BY normalized_mint, unit, keyset_id`,
      )
      .all() as Array<{
      normalized_mint: string
      unit: string
      keyset_id: string
      next_counter: number
    }>
    const custody = database
      .prepare(
        `SELECT normalized_mint, unit, keyset_id, next_counter
         FROM custody_keyset_counters ORDER BY normalized_mint, unit, keyset_id`,
      )
      .all() as typeof target
    const tuples = (rows: typeof target) =>
      rows.map(({ normalized_mint, unit, keyset_id, next_counter }) => [
        normalized_mint,
        unit,
        keyset_id,
        next_counter,
      ])
    assert.ok(target.length > 0)
    assert.deepEqual(tuples(target), tuples(custody))
  } finally {
    database.close()
  }
}

async function retainedSuccessorRows(
  directory: string,
  proofs: readonly Proof[],
): Promise<Array<{ selectability: string; targetState: string }>> {
  const database = await openDaemonStateSqlite(directory)
  try {
    const custody = new DurableCustodySqliteStore(database)
    return proofs.map((proof) => {
      assert.ok(proof.id)
      const proofId = deriveDurableCustodyProofId({
        scopeId: testScopeId(),
        normalizedMint: MINT_URL,
        unit: 'msat',
        keysetId: proof.id,
        secret: proof.secret,
      })
      const canonical = custody.getProof(testScopeId(), proofId)
      const target = database
        .prepare(
          `SELECT state AS targetState FROM target_wallet_proofs
           WHERE scope_id = ? AND normalized_mint = ? AND secret = ?`,
        )
        .get(testScopeId(), MINT_URL, proof.secret) as { targetState: string } | undefined
      assert.ok(canonical)
      assert.ok(target)
      return { selectability: canonical.selectability, targetState: target.targetState }
    })
  } finally {
    database.close()
  }
}

async function assertExactTargetAndCanonicalReservations(
  directory: string,
  sourceOperationId: string,
  inputs: readonly { readonly id?: string; readonly secret: string }[],
): Promise<void> {
  const state = await readState()
  const source = state?.proofOperations[sourceOperationId]
  assert.ok(source)
  const custodyOperationId = source.metadata.custodySourceOperationId
  const reservationId = source.metadata.reservationId
  assert.equal(typeof custodyOperationId, 'string')
  assert.equal(typeof reservationId, 'string')
  const expectedInputs = inputs.map((proof) => {
    assert.ok(proof.id)
    return {
      proofId: deriveDurableCustodyProofId({
        scopeId: testScopeId(),
        normalizedMint: MINT_URL,
        unit: 'msat',
        keysetId: proof.id,
        secret: proof.secret,
      }),
      secret: proof.secret,
    }
  })

  const database = await openDaemonStateSqlite(directory)
  try {
    const operation = database
      .prepare(
        `SELECT reservation_id AS reservationId FROM custody_operations
         WHERE scope_id = ? AND operation_id = ?
           AND semantic_kind = 'ctf-range-conditional-source'`,
      )
      .get(testScopeId(), custodyOperationId) as { reservationId: string } | undefined
    assert.ok(operation)
    assert.equal(operation.reservationId, reservationId)
    const operationInputs = database
      .prepare(
        `SELECT proof_id AS proofId FROM custody_operation_inputs
         WHERE scope_id = ? AND operation_id = ? ORDER BY input_position`,
      )
      .all(testScopeId(), custodyOperationId) as Array<{ proofId: string }>
    assert.deepEqual(
      operationInputs.map(({ proofId }) => proofId).sort(),
      expectedInputs.map(({ proofId }) => proofId).sort(),
    )

    const readReservation = database.prepare(
      `SELECT proofs.selectability,
         proofs.reservation_operation_id AS proofReservationOperationId,
         reservations.operation_id AS reservationOperationId,
         reservations.reservation_id AS reservationId
       FROM custody_proofs AS proofs
       JOIN custody_proof_reservations AS reservations
         ON reservations.scope_id = proofs.scope_id AND reservations.proof_id = proofs.proof_id
       WHERE proofs.scope_id = ? AND proofs.proof_id = ?`,
    )
    const readTargetReservation = database.prepare(
      `SELECT state AS targetState, reserved_by AS targetReservationId
       FROM target_wallet_proofs
       WHERE scope_id = ? AND normalized_mint = ? AND secret = ?`,
    )
    for (const { proofId, secret } of expectedInputs) {
      const row = readReservation.get(testScopeId(), proofId) as
        | {
            selectability: string
            proofReservationOperationId: string | null
            reservationOperationId: string
            reservationId: string
          }
        | undefined
      assert.ok(row)
      assert.equal(row.selectability, 'locked')
      assert.equal(row.proofReservationOperationId, custodyOperationId)
      assert.equal(row.reservationOperationId, custodyOperationId)
      assert.equal(row.reservationId, reservationId)
      const target = readTargetReservation.get(testScopeId(), MINT_URL, secret) as
        | { targetState: string; targetReservationId: string | null }
        | undefined
      assert.ok(target)
      assert.equal(target.targetState, 'reserved')
      assert.equal(target.targetReservationId, reservationId)
    }
  } finally {
    database.close()
  }
}

async function withDaemonProfile(
  input: {
    readonly prefix: string
    readonly incarnationId: string
    readonly proofs: readonly Proof[]
    readonly asset: StoredProofAsset
    readonly cashProofs?: readonly Proof[]
  },
  run: (context: { directory: string; fence: CustodyScopeFence }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), input.prefix))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT_URL,
      walletSeedHex: WALLET_SEED_HEX,
      nostrSecretKeyHex: '22'.repeat(32),
      initializedAtMs: 1,
    })
    await writeState(emptyDaemonState())
    await addAvailableProofs(input.proofs, input.asset)
    await addAvailableProofs(input.cashProofs ?? [], regularAsset())
    const fence = await claimCustodyScopeLease(directory, {
      scopeId: testScopeId(),
      incarnationId: input.incarnationId,
      observedAtMs: 10_000,
    })
    await run({ directory, fence })
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}

async function addAvailableProofs(
  proofs: readonly Proof[],
  asset: StoredProofAsset,
): Promise<void> {
  const state = (await readState()) ?? emptyDaemonState()
  state.wallet.proofs.push(
    ...proofs.map((proof) => ({
      proof,
      mintUrl: MINT_URL,
      state: 'available' as const,
      asset,
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
    })),
  )
  await writeState(state)
  const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
  try {
    const custody = new DurableCustodySqliteStore(database)
    for (const proof of proofs) {
      custody.putProofCas(
        createCustodyProofSqliteRow({
          scopeId: testScopeId(),
          normalizedMint: MINT_URL,
          unit: asset.unit,
          proof: {
            ...proof,
            dleq: proof.dleq ?? null,
            witness: proof.witness ?? null,
            p2pkE: proof.p2pk_e ?? null,
          },
          baseAsset: 'sat',
          conditionId: asset.kind === 'Outcome' ? asset.conditionId : null,
          outcomeSetId: asset.kind === 'Outcome' ? asset.outcomeSetId : null,
          productBinding: null,
          signatureVerified: true,
          dleqState: proof.dleq == null ? 'not-present' : 'verified',
          nut07State: 'UNSPENT',
          selectability: 'selectable',
          storageClass: 'pinned-operation-bound-deterministic',
          reservationOperationId: null,
          revision: 0,
          nowMs: 1,
        }),
        null,
      )
    }
  } finally {
    database.close()
  }
}

function testScopeId(): string {
  return deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(Buffer.from(WALLET_SEED_HEX, 'hex')),
  })
}

function regularAsset(): StoredProofAsset {
  return { kind: 'sats', baseAsset: 'sat', unit: 'msat' }
}

function canonicalJson(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonicalize)
    if (item === null || typeof item !== 'object') return item
    return Object.fromEntries(
      Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return JSON.stringify(canonicalize(value))
}

function outcomeAsset(): StoredProofAsset {
  return {
    kind: 'Outcome',
    conditionId: CONDITION_ID,
    outcomeSetId: 'YES',
    baseAsset: 'sat',
    unit: 'msat',
  }
}

class FakeWallet {
  readonly #lostAcknowledgementState: 'SPENT' | 'UNSPENT' | null
  completeCalls = 0
  readonly prepareSwapDrafts: Array<{
    inputSecrets: string[]
    sendBlindedMessages: string[]
    keepBlindedMessages: string[]
  }> = []
  beforePrepareSwap?: () => Promise<void>
  beforeCompleteConditionalSwap?: () => Promise<void>
  #observedStateAfterLostAcknowledgement: 'SPENT' | 'UNSPENT' | null = null

  constructor(
    _sourceProofs: Proof[],
    loseFirstCompletionAcknowledgement: boolean | 'unspent' = false,
  ) {
    this.#lostAcknowledgementState =
      loseFirstCompletionAcknowledgement === true
        ? 'SPENT'
        : loseFirstCompletionAcknowledgement === 'unspent'
          ? 'UNSPENT'
          : null
  }

  async loadMint(): Promise<void> {}

  async prepareSwapToSend(
    amount: number,
    proofs: Proof[],
    config: { includeFees: false; keysetId: string },
    outputConfig: {
      send: { type: 'custom'; data: OutputData[] } | { type: 'random' }
      keep: { type: 'custom'; data: OutputData[] } | { type: 'random' }
    },
  ): Promise<SwapPreview> {
    await this.beforePrepareSwap?.()
    if (outputConfig.send.type === 'custom') {
      this.prepareSwapDrafts.push({
        inputSecrets: proofs.map(({ secret }) => secret),
        sendBlindedMessages: outputConfig.send.data.map(({ blindedMessage: { B_ } }) => B_),
        keepBlindedMessages:
          outputConfig.keep.type === 'custom'
            ? outputConfig.keep.data.map(({ blindedMessage: { B_ } }) => B_)
            : [],
      })
    }
    assert.equal(
      config.includeFees,
      false,
      'range preparation must not add a second recipient-spend fee to its exact outputs',
    )
    const fees = 1
    const keepAmount =
      proofs.reduce((total, proof) => total + amountToNumber(proof.amount), 0) - amount - fees
    const sendOutputs =
      outputConfig.send.type === 'custom'
        ? outputConfig.send.data
        : OutputData.createRandomData(Amount.from(amount), mintKeys())
    return {
      amount: Amount.from(amount),
      fees: Amount.from(fees),
      keysetId: OFFER_KEYSET_ID,
      inputs: proofs,
      sendOutputs,
      keepOutputs:
        keepAmount === 0
          ? []
          : outputConfig.keep.type === 'custom'
            ? outputConfig.keep.data
            : OutputData.createRandomData(Amount.from(keepAmount), mintKeys()),
      unselectedProofs: [],
    }
  }

  async completeSwap(preview: SwapPreview): Promise<{ keep: Proof[]; send: Proof[] }> {
    this.completeCalls += 1
    if (this.#lostAcknowledgementState !== null && this.completeCalls === 1) {
      this.#observedStateAfterLostAcknowledgement = this.#lostAcknowledgementState
      throw new Error('mint swap acknowledgement lost')
    }
    return {
      send: (preview.sendOutputs ?? []).map(signedProof),
      keep: (preview.keepOutputs ?? []).map(signedProof),
    }
  }

  async prepareConditionalSwap(options: {
    keysetId: string
    inputs: Proof[]
    outputs: Array<
      | { label: string; kind: 'custom'; data: OutputData[] }
      | { label: string; kind: 'random'; amount: number }
    >
  }) {
    const outputDataByLabel = Object.fromEntries(
      options.outputs.map((group) => [
        group.label,
        group.kind === 'custom'
          ? group.data
          : OutputData.createRandomData(
              Amount.from(group.amount),
              conditionalMintKeys(options.keysetId),
            ),
      ]),
    )
    return {
      keysetId: options.keysetId,
      inputs: options.inputs,
      outputDataByLabel,
    }
  }

  async completeConditionalSwap(preview: {
    outputDataByLabel: Record<string, OutputData[]>
  }): Promise<Record<string, Proof[]>> {
    this.completeCalls += 1
    await this.beforeCompleteConditionalSwap?.()
    return Object.fromEntries(
      Object.entries(preview.outputDataByLabel).map(([label, outputs]) => [
        label,
        outputs.map(signedProof),
      ]),
    )
  }

  async checkProofsStates(
    proofs: Array<Pick<Proof, 'id' | 'secret'>>,
  ): Promise<Array<{ Y: string; state: 'SPENT' | 'UNSPENT' }>> {
    if (this.#observedStateAfterLostAcknowledgement === null) {
      throw new Error('fresh preparation must not resume a source')
    }
    return proofs.map(({ secret }) => ({
      Y: secret,
      state: this.#observedStateAfterLostAcknowledgement!,
    }))
  }
}

function fakeMint(
  maxInputs = 64,
  maxExpirySeconds = 1_000,
  restoredOutputs?: () => ReadonlySet<string>,
  includeRotatedRegularKeyset: () => boolean = () => false,
  maxOutputs = 512,
) {
  const calls = {
    getInfo: 0,
    getKeySets: 0,
    getConditionalKeysets: 0,
    getCtfCondition: 0,
    getKeys: 0,
    restore: 0,
    check: 0,
  }
  return {
    calls,
    getInfo: async () => {
      calls.getInfo += 1
      return {
        name: 'test',
        pubkey: MINT_PUBLIC_KEY,
        version: 'test',
        contact: [],
        nuts: {
          '4': { methods: [], disabled: false },
          '5': { methods: [], disabled: false },
          'CTF-split-merge': {
            supported: true,
            partial_fill: true,
            max_inputs: maxInputs,
            max_outputs: maxOutputs,
            max_request_bytes: 16 * 1_024 * 1_024,
            max_pool_entries: 32,
            max_expiry_seconds: maxExpirySeconds,
          },
        },
      } as never
    },
    getKeySets: async () => {
      calls.getKeySets += 1
      return {
        keysets: [
          {
            id: OFFER_KEYSET_ID,
            unit: 'msat',
            active: !includeRotatedRegularKeyset(),
            input_fee_ppk: INPUT_FEE_PPK,
            final_expiry: FINAL_EXPIRY,
          },
          ...(includeRotatedRegularKeyset()
            ? [
                {
                  id: ROTATED_OFFER_KEYSET_ID,
                  unit: 'msat',
                  active: true,
                  input_fee_ppk: INPUT_FEE_PPK,
                  final_expiry: FINAL_EXPIRY,
                },
              ]
            : []),
          {
            id: '00deadbeef000000',
            unit: 'msat',
            active: false,
            input_fee_ppk: INPUT_FEE_PPK,
            final_expiry: FINAL_EXPIRY,
          },
        ],
      }
    },
    getConditionalKeysets: async () => {
      calls.getConditionalKeysets += 1
      return {
        next_cursor: null,
        keysets: [
          {
            id: RECEIVE_KEYSET_ID,
            unit: 'msat',
            active: true,
            input_fee_ppk: INPUT_FEE_PPK,
            final_expiry: FINAL_EXPIRY,
            registered_at: 0,
            condition_id: CONDITION_ID,
            outcome_collection: 'YES',
            outcome_collection_id: OUTCOME_COLLECTION_ID,
          },
          {
            id: COMPLEMENT_KEYSET_ID,
            unit: 'msat',
            active: true,
            input_fee_ppk: INPUT_FEE_PPK,
            final_expiry: FINAL_EXPIRY,
            registered_at: 0,
            condition_id: CONDITION_ID,
            outcome_collection: 'NO',
            outcome_collection_id: COMPLEMENT_COLLECTION_ID,
          },
        ],
      }
    },
    getCtfCondition: async () => {
      calls.getCtfCondition += 1
      return {
        ...REGISTERED_CONDITION,
        condition_id: CONDITION_ID,
        registered_at: 0,
        keysets: { NO: COMPLEMENT_KEYSET_ID, YES: RECEIVE_KEYSET_ID },
      }
    },
    getKeys: async (keysetId?: string) => {
      calls.getKeys += 1
      return {
        keysets: [
          keysetId === ROTATED_OFFER_KEYSET_ID
            ? rotatedMintKeys()
            : keysetId === RECEIVE_KEYSET_ID || keysetId === COMPLEMENT_KEYSET_ID
              ? conditionalMintKeys(keysetId)
              : mintKeys(),
        ],
      }
    },
    restore: async ({ outputs }: { outputs: SerializedBlindedMessage[] }) => {
      calls.restore += 1
      const selected = restoredOutputs?.() ?? new Set<string>()
      const restored = outputs.filter(({ B_ }) => selected.has(B_))
      return {
        outputs: restored,
        signatures: restored.map(signBlindedOutput),
      }
    },
    check: async ({ Ys }: { Ys: string[] }) => {
      calls.check += 1
      return {
        states: Ys.map((Y) => ({ Y, state: 'UNSPENT' as const, witness: null })),
      }
    },
  }
}

function fakeEngineClient(
  create: (request: CreateSettlementCapabilityRequest) => SettlementCapabilityResponse,
  submit: () => Promise<ReturnType<typeof submittedOrder>> = async () => submittedOrder(),
): EngineClientLike {
  return {
    createSettlementCapability: async (request) => create(request),
    getSettlementCapabilityAdmissionPolicy: async () => ({
      coordinatorPubkey: COORDINATOR_KEY,
    }),
    getMarket: async () => ({
      conditionId: CONDITION_ID,
      outcomes: [
        { id: 'yes-id', label: 'YES' },
        { id: 'no-id', label: 'NO' },
      ],
    }),
    queryMarkets: async () => ({ markets: [] }),
    submitOrder: submit,
    getSettlementCapabilityResultByOperation: async () => null,
    getOrderStatus: async () => null,
    cancelOrder: async () => false,
    getOrderBook: async () => ({ bids: [], asks: [], spread: 0, sequence: 0 }) as never,
    getParticipationScore: async () => {
      throw new Error('not used')
    },
  }
}

function boundCapability(
  request: CreateSettlementCapabilityRequest,
  state: SettlementCapabilityResponse['state'] = 'bound',
): SettlementCapabilityResponse {
  const artifact = decodeSettlementCapabilityArtifactBytes(Buffer.from(request.artifact, 'base64'))
  return {
    reference: { artifactId: CAPABILITY_ARTIFACT_ID, bindingDigest: 'ef'.repeat(32) },
    orderId: ORDER_ID,
    clientOrderId: request.clientOrderId,
    marketId: request.marketId,
    artifactDigest: deriveSettlementCapabilityArtifactDigest(artifact),
    state,
    version: 3,
    authorizationExpiresAt: new Date(109_000).toISOString(),
    stageExpiresAt: new Date(109_000).toISOString(),
    settlementGroup: null,
  }
}

function submittedOrder(
  remainingAmountSubunits = 1_000,
): Awaited<ReturnType<EngineClientLike['submitOrder']>> {
  return {
    orderId: ORDER_ID,
    status: 'resting',
    remainingAmountSubunits,
    fills: [],
    baseAsset: 'sat',
    divisibility: 1_000,
    activeSettlementGroup: null,
  }
}

function restingOrderStatus(): Awaited<ReturnType<EngineClientLike['getOrderStatus']>> {
  return {
    orderId: ORDER_ID,
    marketId: orderRequest().marketId,
    status: 'resting',
    remainingAmountSubunits: orderRequest().amountSubunits,
    filledAmountSubunits: 0,
    fills: [],
    tokenSide: 'Outcome',
    baseAsset: 'sat',
    divisibility: 1_000,
    activeSettlementGroup: null,
  }
}

function filledOrderStatus(): Awaited<ReturnType<EngineClientLike['getOrderStatus']>> {
  return {
    orderId: ORDER_ID,
    marketId: orderRequest().marketId,
    status: 'filled',
    remainingAmountSubunits: 0,
    filledAmountSubunits: orderRequest().amountSubunits,
    fills: [],
    tokenSide: 'Outcome',
    baseAsset: 'sat',
    divisibility: 1_000,
    activeSettlementGroup: null,
  }
}

function cancelledOrderStatus(): Awaited<ReturnType<EngineClientLike['getOrderStatus']>> {
  return {
    ...restingOrderStatus(),
    status: 'cancelled',
  }
}

async function rangeRecoverySnapshot(directory: string) {
  const database = await openDaemonStateSqlite(directory)
  try {
    return {
      preparations: database
        .prepare(
          `SELECT range_operation_id AS operationId, lifecycle_state AS lifecycle,
             revision
           FROM daemon_ctf_range_preparations
           ORDER BY range_operation_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      custodyOperations: database
        .prepare(
          `SELECT operation_id AS operationId, operation_state AS operationState,
             result_state AS resultState, revision
           FROM custody_operations
           ORDER BY operation_id`,
        )
        .all()
        .map((row) => ({ ...row })),
      custodyProofs: database
        .prepare(
          `SELECT proof_id AS proofId, selectability, nut07_state AS nut07State,
             reservation_operation_id AS reservationOperationId, revision
           FROM custody_proofs
           ORDER BY proof_id`,
        )
        .all()
        .map((row) => ({ ...row })),
    }
  } finally {
    database.close()
  }
}

function validTerminalSelection(operation: DurableCtfRangeOperation) {
  const inputTotal = operation.inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n)
  const debit = BigInt(operation.policy.maxDebit)
  const minimumReceive = BigInt(operation.policy.minReceive)
  const proportionalReceive =
    (debit * BigInt(operation.policy.rateN) + BigInt(operation.policy.rateD) - 1n) /
    BigInt(operation.policy.rateD)
  const receive = proportionalReceive > minimumReceive ? proportionalReceive : minimumReceive
  return selectCtfRangeAmounts(
    operation.manifest.entries.map(({ outputData: _, ...entry }) => entry),
    receive,
    inputTotal - debit,
  )
}

function validPartialSelection(operation: DurableCtfRangeOperation, requestedReceive?: bigint) {
  const inputTotal = operation.inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n)
  const maximumDebit = BigInt(operation.policy.maxDebit)
  const debit = maximumDebit > 2n ? maximumDebit / 2n - 1n : maximumDebit
  const minimumReceive = BigInt(operation.policy.minReceive)
  const proportionalReceive =
    (debit * BigInt(operation.policy.rateN) + BigInt(operation.policy.rateD) - 1n) /
    BigInt(operation.policy.rateD)
  const minimumValidReceive =
    proportionalReceive > minimumReceive ? proportionalReceive : minimumReceive
  const receive =
    requestedReceive !== undefined && requestedReceive > minimumValidReceive
      ? requestedReceive
      : minimumValidReceive
  return selectCtfRangeAmounts(
    operation.manifest.entries.map(({ outputData: _, ...entry }) => entry),
    receive,
    inputTotal - debit,
  )
}

function engineResult(
  prepared: Awaited<ReturnType<DaemonCtfRangeOrderCoordinator['prepare']>>,
  operation: DurableCtfRangeOperation,
  selection: string,
): SettlementCapabilityResultResponse {
  const envelope = createDurableCtfRangeResultEnvelope({
    operation,
    requestDigest: 'ef'.repeat(32),
    selection,
    signatures: signaturesFor(operation, selection),
  })
  const envelopeBytes = Buffer.from(JSON.stringify(envelope))
  return {
    resultId: '00000000-0000-4000-8000-000000000003',
    reference: prepared.capability.reference,
    operationId: operation.operationId,
    requestDigest: envelope.requestDigest,
    envelopeDigest: createHash('sha256').update(envelopeBytes).digest('hex'),
    envelope: envelopeBytes.toString('base64'),
    createdAt: new Date(11_000).toISOString(),
    acknowledgedAt: null,
    version: 1,
    settlementGroup: {
      groupId: SETTLEMENT_GROUP_ID,
      status: 'Confirmed',
      revision: 1,
      coalescingDeadline: new Date(10_500).toISOString(),
      frozenAt: new Date(10_750).toISOString(),
    },
  }
}

function signaturesFor(operation: DurableCtfRangeOperation, selection: string) {
  const bitmap = Buffer.from(selection, 'hex')
  return operation.manifest.entries
    .filter((_, index) => (bitmap[index >> 3]! & (1 << (index & 7))) !== 0)
    .map(({ outputData }) => signBlindedOutput(outputData.blindedMessage))
}

function signBlindedOutput(output: SerializedBlindedMessage) {
  const signature = createBlindSignature(
    pointFromHex(output.B_),
    mintDenominationPrivateKey(MINT_PRIVATE_KEY, output.amount.toString()),
    output.id,
  )
  const dleq = createDLEQProof(
    pointFromHex(output.B_),
    mintDenominationPrivateKey(MINT_PRIVATE_KEY, output.amount.toString()),
  )
  return {
    id: signature.id,
    amount: output.amount,
    C_: signature.C_.toHex(true),
    dleq: {
      e: Buffer.from(dleq.e).toString('hex'),
      s: Buffer.from(dleq.s).toString('hex'),
    },
  }
}

function orderRequest(): PrepareSettlementCapabilityInput {
  return {
    clientOrderId: 'client-order-1',
    marketId: `${CONDITION_ID}-YES`,
    conditionId: CONDITION_ID,
    outcomeId: 'yes-id',
    tokenSide: 'Outcome',
    side: 'Buy',
    price: 500,
    maxQuotePaymentSubunits: 500,
    minQuotePaymentSubunits: null,
    amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000,
    consolidateProofs: false,
    baseAsset: 'sat',
    collateralUnit: 'msat',
    divisibility: 1_000,
    timeInForce: 'FOK',
    expiresAt: null,
    mintUrl: MINT_URL,
    walletSeedHex: WALLET_SEED_HEX,
  }
}

function mintKeys(): MintKeys {
  return {
    id: OFFER_KEYSET_ID,
    unit: 'msat',
    active: true,
    input_fee_ppk: INPUT_FEE_PPK,
    final_expiry: FINAL_EXPIRY,
    keys: KEYS,
  }
}

function rotatedMintKeys(): MintKeys {
  return {
    ...mintKeys(),
    id: ROTATED_OFFER_KEYSET_ID,
    keys: ROTATED_KEYS,
  }
}

function conditionalMintKeys(keysetId = RECEIVE_KEYSET_ID): MintKeys {
  const complement = keysetId === COMPLEMENT_KEYSET_ID
  return {
    ...mintKeys(),
    id: keysetId,
    conditional: {
      condition_id: CONDITION_ID,
      outcome_collection: complement ? 'NO' : 'YES',
      outcome_collection_id: complement ? COMPLEMENT_COLLECTION_ID : OUTCOME_COLLECTION_ID,
    },
  }
}

function signedProof(output: OutputData): Proof {
  const privateKey = mintDenominationPrivateKey(
    output.blindedMessage.id === ROTATED_OFFER_KEYSET_ID
      ? ROTATED_MINT_PRIVATE_KEY
      : MINT_PRIVATE_KEY,
    output.blindedMessage.amount.toString(),
  )
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    privateKey,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), privateKey)
  return output.toProof(
    {
      id: signature.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: {
        e: Buffer.from(dleq.e).toString('hex'),
        s: Buffer.from(dleq.s).toString('hex'),
      },
    },
    output.blindedMessage.id === ROTATED_OFFER_KEYSET_ID
      ? rotatedMintKeys()
      : output.blindedMessage.id === RECEIVE_KEYSET_ID ||
          output.blindedMessage.id === COMPLEMENT_KEYSET_ID
        ? conditionalMintKeys(output.blindedMessage.id)
        : mintKeys(),
  )
}

function amountToNumber(amount: unknown): number {
  if (
    typeof amount === 'object' &&
    amount !== null &&
    'toNumber' in amount &&
    typeof amount.toNumber === 'function'
  ) {
    return amount.toNumber()
  }
  if (
    typeof amount === 'object' &&
    amount !== null &&
    'value' in amount &&
    typeof amount.value === 'bigint'
  ) {
    return Number(amount.value)
  }
  return Number(amount)
}

function exactProofSnapshot(proof: {
  readonly id?: string
  readonly amount: unknown
  readonly secret: string
  readonly C: string
  readonly dleq?: unknown
  readonly witness?: unknown
  readonly p2pk_e?: string
}) {
  return {
    id: proof.id,
    amount: amountToNumber(proof.amount),
    secret: proof.secret,
    C: proof.C,
    dleq: proof.dleq ?? null,
    witness: proof.witness ?? null,
    p2pk_e: proof.p2pk_e ?? null,
  }
}

type SourceInputState = 'UNSPENT' | 'PENDING' | 'SPENT'

function sellOneShareRequest(): PrepareSettlementCapabilityInput {
  return {
    ...orderRequest(),
    clientOrderId: 'client-order-full-exit',
    side: 'Sell',
    maxQuotePaymentSubunits: null,
    minQuotePaymentSubunits: 500,
  }
}

function heldShareProofs(): Proof[] {
  return OutputData.createRandomData(Amount.from(HELD_SHARE_FACE), conditionalMintKeys()).map(
    signedProof,
  )
}

function heldShareProof(amount: number): Proof {
  return signedProof(OutputData.createRandomData(Amount.from(amount), conditionalMintKeys())[0]!)
}

function cashProof(amount: number): Proof {
  return signedProof(OutputData.createRandomData(Amount.from(amount), mintKeys())[0]!)
}

function randomIds(prefix: string): () => string {
  const ids = [`${prefix}-operation`, `${prefix}-authorization`]
  return () => {
    const id = ids.shift()
    if (id === undefined) throw new Error('fixture random ids are exhausted')
    return id
  }
}

function mixedSourceMint(
  options: {
    readonly maxOutputs?: number
    readonly metadataAvailable?: boolean
    readonly inputStates?: ReadonlyMap<string, SourceInputState>
    readonly convert?: (request: CtfConvertRequest) => Promise<CtfConvertResponse>
  } = {},
) {
  const base = fakeMint(64, 1_000, undefined, () => false, options.maxOutputs)
  const metadataCalls = () =>
    base.calls.getInfo +
    base.calls.getKeySets +
    base.calls.getConditionalKeysets +
    base.calls.getCtfCondition +
    base.calls.getKeys
  const convertRequests: CtfConvertRequest[] = []
  const metadataCallsAtConvert: number[] = []
  const metadataCallsAtInputCheck: number[] = []
  return {
    ...base,
    convertRequests,
    metadataCallsAtConvert,
    metadataCallsAtInputCheck,
    getInfo: async () => {
      if (options.metadataAvailable === false) {
        base.calls.getInfo += 1
        throw new Error('current mint metadata is unavailable')
      }
      return base.getInfo()
    },
    check: async ({ Ys }: { Ys: string[] }) => {
      metadataCallsAtInputCheck.push(metadataCalls())
      base.calls.check += 1
      return {
        states: Ys.map((Y) => ({
          Y,
          state: options.inputStates?.get(Y) ?? ('UNSPENT' as const),
          witness: null,
        })),
      }
    },
    ctfConvert: async (request: CtfConvertRequest) => {
      convertRequests.push(request)
      metadataCallsAtConvert.push(metadataCalls())
      return (options.convert ?? signConvertRequest)(request)
    },
  }
}

async function signConvertRequest(request: CtfConvertRequest): Promise<CtfConvertResponse> {
  return {
    signatures: Object.fromEntries(
      Object.entries(request.outputs).map(([collection, outputs]) => [
        collection,
        outputs.map(signBlindedOutput),
      ]),
    ),
  } as CtfConvertResponse
}

function convertInputs(request: CtfConvertRequest): Proof[] {
  return Object.values(request.inputs).flat()
}

function convertInputTotals(request: CtfConvertRequest): Record<string, number> {
  return Object.fromEntries(
    Object.entries(request.inputs).map(([collection, proofs]) => [
      collection,
      proofs.reduce((total, proof) => total + amountToNumber(proof.amount), 0),
    ]),
  )
}

function exactRequestJson(request: CtfConvertRequest): string {
  return JSON.stringify(request, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
}

function proofY(proof: Pick<Proof, 'secret'>): string {
  return hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true)
}

function restoredGroups(
  groups: Parameters<typeof deserializeOutputGroups>[0],
  mode: 'unused' | 'complete' | 'missing-output',
): Record<string, Proof[]> {
  if (mode === 'unused') throw new Error('exact output restore must not run')
  const restored = Object.fromEntries(
    Object.entries(deserializeOutputGroups(groups)).map(([label, outputs]) => [
      label,
      outputs.map(signedProof),
    ]),
  )
  if (mode === 'missing-output') restored.authorization = restored.authorization!.slice(1)
  return restored
}

async function walletSummary() {
  const proofs = (await readState())?.wallet.proofs ?? []
  const total = (kind: StoredProofAsset['kind'], proofState: 'available' | 'reserved') =>
    proofs
      .filter(({ asset, state }) => asset.kind === kind && state === proofState)
      .reduce((sum, { proof }) => sum + amountToNumber(proof.amount), 0)
  return {
    availableShares: total('Outcome', 'available'),
    availableCash: total('sats', 'available'),
    reservedShares: total('Outcome', 'reserved'),
    reservedCash: total('sats', 'reserved'),
  }
}

async function mixedSourceCustody(directory: string) {
  const database = await openDaemonStateSqlite(directory)
  try {
    const source = database
      .prepare(
        `SELECT operation_state AS operationState, result_state AS resultState
         FROM custody_operations WHERE semantic_kind = 'ctf-range-conditional-source'`,
      )
      .get() as { operationState: string; resultState: string } | undefined
    const reservations = database
      .prepare('SELECT count(*) AS count FROM custody_proof_reservations')
      .get() as { count: number }
    const preparation = database
      .prepare('SELECT lifecycle_state AS lifecycle FROM daemon_ctf_range_preparations')
      .get() as { lifecycle: string } | undefined
    return {
      sourceResult: source?.resultState ?? null,
      sourceOperation: source?.operationState ?? null,
      reservations: Number(reservations.count),
      lifecycle: preparation?.lifecycle ?? null,
    }
  } finally {
    database.close()
  }
}

async function completedRefundCount(): Promise<number> {
  const operations = Object.values((await readState())?.proofOperations ?? {})
  return operations.filter(
    ({ state, metadata }) => state === 'completed' && metadata.purpose === 'ctf-range-refund',
  ).length
}

function swapPreviewDigest(preview: SwapPreview): string {
  const exactPreview = JSON.stringify({
    inputs: preview.inputs.map(exactProofSnapshot),
    send: (preview.sendOutputs ?? []).map(OutputData.serialize),
    keep: (preview.keepOutputs ?? []).map(OutputData.serialize),
  })
  return createHash('sha256').update(exactPreview).digest('hex')
}

async function assertSeedAbsentFromArtifacts(directory: string): Promise<void> {
  const database = await openDaemonStateSqlite(directory)
  try {
    const artifacts = database.prepare('SELECT body FROM custody_artifacts').all() as Array<{
      body: Uint8Array
    }>
    assert.equal(
      artifacts.some(({ body }) => Buffer.from(body).toString('utf8').includes(WALLET_SEED_HEX)),
      false,
    )
  } finally {
    database.close()
  }
}

async function atomicPreparationInput(
  directory: string,
  fence: CustodyScopeFence,
  clientOrderId = 'atomic-request',
) {
  const { walletSeedHex: _seed, consolidateProofs: _policy, ...request } = orderRequest()
  request.clientOrderId = clientOrderId
  const candidate = buildPersistedCtfRangeOrderPreparation({
    request,
    coordinatorPublicKey: COORDINATOR_KEY,
    mintFacts: await loadCtfRangeMintMetadata({
      mint: fakeMint(),
      mintUrl: MINT_URL,
      conditionId: CONDITION_ID,
      observedAt: 10,
      allowInsecureLoopbackHttp: false,
    }),
    market: {
      outcomes: [
        { id: 'yes-id', label: 'YES' },
        { id: 'no-id', label: 'NO' },
      ],
    },
    nowUnixSeconds: 10,
    randomId: randomIds(clientOrderId),
  })
  const { intent } = createCtfRangePreparationIntent({
    scopeId: fence.scopeId,
    request,
    feeConsentBytes: null,
    consolidateProofs: false,
  })
  return {
    storage: createDaemonStateSqliteSession(directory),
    mutation: { fence, observedAtMs: 10000 },
    intent,
    candidate,
    seed: Buffer.from(WALLET_SEED_HEX, 'hex'),
  }
}

async function atomicDatabaseSnapshot(directory: string) {
  const database = await openDaemonStateSqlite(directory)
  try {
    return {
      target: database.prepare('SELECT * FROM target_keyset_counters ORDER BY keyset_id').all(),
      custody: database.prepare('SELECT * FROM custody_keyset_counters ORDER BY keyset_id').all(),
      preparations: database
        .prepare('SELECT * FROM daemon_ctf_range_preparations ORDER BY range_operation_id')
        .all(),
      fence: database.prepare('SELECT * FROM custody_scope_state').all(),
    }
  } finally {
    database.close()
  }
}

for (const fault of ['first-cursor', 'receipt'])
  test(`atomic preparation SQLite rolls back ${fault} failure`, async () => {
    await withDaemonProfile(
      {
        prefix: 'ctf-atomic-',
        incarnationId: 'atomic-fault-incarnation',
        proofs: [],
        asset: regularAsset(),
      },
      async ({ directory, fence }) => {
        const input = await atomicPreparationInput(directory, fence)
        const before = await atomicDatabaseSnapshot(directory)
        const database = await openDaemonStateSqlite(directory)
        database.exec(
          fault === 'first-cursor'
            ? `CREATE TRIGGER atomic_abort AFTER INSERT ON target_keyset_counters BEGIN SELECT RAISE(ABORT,'atomic injected'); END`
            : `CREATE TRIGGER atomic_abort AFTER INSERT ON daemon_ctf_range_preparations BEGIN SELECT RAISE(ABORT,'atomic injected'); END`,
        )
        try {
          await assert.rejects(reserveDaemonCtfPreparation(input), /atomic injected/)
        } finally {
          database.exec('DROP TRIGGER atomic_abort')
          database.close()
        }
        assert.deepEqual(await atomicDatabaseSnapshot(directory), before)
      },
    )
  })

test('atomic preparation SQLite concurrent allocation, reopen replay, exhausted replay and intent conflict', async () => {
  await withDaemonProfile(
    {
      prefix: 'ctf-atomic-',
      incarnationId: 'atomic-success-incarnation',
      proofs: [],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const input = await atomicPreparationInput(directory, fence)
      const [first, retry] = await Promise.all([
        reserveDaemonCtfPreparation(input),
        reserveDaemonCtfPreparation({
          ...input,
          storage: createDaemonStateSqliteSession(directory),
        }),
      ])
      assert.deepEqual(first, retry)
      const receipt = decodeCtfRangeOrderPreparationFromRecord(toSdkRangePreparationRecord(first))
      assert.equal(receipt.version, 3)
      const another = await atomicPreparationInput(directory, fence, 'atomic-other')
      const second = decodeCtfRangeOrderPreparationFromRecord(
        toSdkRangePreparationRecord(await reserveDaemonCtfPreparation(another)),
      )
      assert.equal(second.version, 3)
      if (receipt.version !== 3 || second.version !== 3) throw new Error('expected v3')
      assert.equal(second.offerCounterStart, receipt.offerCounterStart + receipt.offerCounterCount)
      assert.equal(
        second.receiveCounterStart,
        receipt.receiveCounterStart + receipt.receiveCounterCount,
      )
      const distinct = await Promise.all(
        ['third', 'fourth'].map(async (id) =>
          reserveDaemonCtfPreparation(await atomicPreparationInput(directory, fence, id)),
        ),
      )
      const distinctReceipts = distinct
        .map((row) => decodeCtfRangeOrderPreparationFromRecord(toSdkRangePreparationRecord(row)))
        .sort((left, right) =>
          left.version === 3 && right.version === 3
            ? left.offerCounterStart - right.offerCounterStart
            : 0,
        )
      assert.equal(distinctReceipts[0]!.version, 3)
      assert.equal(distinctReceipts[1]!.version, 3)
      if (distinctReceipts[0]!.version !== 3 || distinctReceipts[1]!.version !== 3)
        throw new Error('expected v3')
      assert.equal(
        distinctReceipts[1]!.offerCounterStart,
        distinctReceipts[0]!.offerCounterStart + distinctReceipts[0]!.offerCounterCount,
      )
      assert.equal(
        distinctReceipts[1]!.receiveCounterStart,
        distinctReceipts[0]!.receiveCounterStart + distinctReceipts[0]!.receiveCounterCount,
      )

      const database = await openDaemonStateSqlite(directory)
      database.exec(
        'UPDATE target_keyset_counters SET next_counter=2147483648; UPDATE custody_keyset_counters SET next_counter=2147483648;',
      )
      database.close()
      const before = await atomicDatabaseSnapshot(directory)
      assert.deepEqual(
        await reserveDaemonCtfPreparation({
          ...input,
          storage: createDaemonStateSqliteSession(directory),
        }),
        first,
      )
      const changed = { ...input, intent: { ...input.intent, consolidateProofs: true } }
      await assert.rejects(reserveDaemonCtfPreparation(changed), /conflicts/)
      await assert.rejects(
        reserveDaemonCtfPreparation(
          await atomicPreparationInput(directory, fence, 'exhausted-new'),
        ),
        /Invalid counter/,
      )
      assert.deepEqual(await atomicDatabaseSnapshot(directory), before)
    },
  )
})

test('atomic preparation SQLite stale fence and one-sided authority do not create a receipt', async () => {
  await withDaemonProfile(
    {
      prefix: 'ctf-atomic-',
      incarnationId: 'atomic-stale-incarnation',
      proofs: [],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const input = await atomicPreparationInput(directory, fence)
      const before = await atomicDatabaseSnapshot(directory)
      await assert.rejects(
        reserveDaemonCtfPreparation({
          ...input,
          mutation: {
            ...input.mutation,
            fence: { ...fence, fencingEpoch: fence.fencingEpoch + 1 },
          },
        }),
        /stale or expired authority/,
      )
      assert.deepEqual(await atomicDatabaseSnapshot(directory), before)
      const database = await openDaemonStateSqlite(directory)
      database
        .prepare(
          'INSERT INTO target_keyset_counters(scope_id,normalized_mint,unit,keyset_id,next_counter,updated_at_ms) VALUES(?,?,?,?,?,?)',
        )
        .run(fence.scopeId, MINT_URL, 'msat', input.candidate.offerKeyset.id, 1, 10000)
      database.close()
      const mismatched = await atomicDatabaseSnapshot(directory)
      await assert.rejects(reserveDaemonCtfPreparation(input), /one-sided/)
      assert.deepEqual(await atomicDatabaseSnapshot(directory), mismatched)
    },
  )
})

test('atomic preparation SQLite terminal history replays exactly and changed intent conflicts', async () => {
  await withDaemonProfile(
    {
      prefix: 'ctf-atomic-',
      incarnationId: 'atomic-history-incarnation',
      proofs: [],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const input = await atomicPreparationInput(directory, fence)
      const first = await reserveDaemonCtfPreparation(input)
      const database = await openDaemonStateSqlite(directory)
      database
        .prepare(
          "UPDATE daemon_ctf_range_preparations SET lifecycle_state='terminal' WHERE range_operation_id=?",
        )
        .run(first.rangeOperationId)
      const rows = readRangePreparationHistoryByClientOrderId(
        database,
        fence.scopeId,
        input.intent.request.clientOrderId,
      )
      database.close()
      const before = await atomicDatabaseSnapshot(directory)
      const replay = await reserveDaemonCtfPreparation(input)
      assert.equal(replay.lifecycleState, 'terminal')
      assert.equal(replay.rangeOperationId, first.rangeOperationId)
      assert.deepEqual(await atomicDatabaseSnapshot(directory), before)
      assert.throws(
        () => selectCtfRangePreparationForIntent([rows[0]!, rows[0]!], input.intent),
        /ambiguous/,
      )
      const differentIntent = {
        ...rows[0]!,
        rangeOperationId: input.candidate.operationId,
        sourceOperationId: input.candidate.sourceOperationId,
        authorizationId: input.candidate.authorizationId,
        preparationBytes: encodePersistedCtfRangeOrderPreparation(input.candidate),
        consolidateProofs: true,
      }
      for (const [matchingState, differentState] of [
        ['terminal', 'prepared'],
        ['prepared', 'terminal'],
      ] as const) {
        assert.throws(
          () =>
            selectCtfRangePreparationForIntent(
              [
                { ...rows[0]!, lifecycleState: matchingState },
                { ...differentIntent, lifecycleState: differentState },
              ],
              input.intent,
            ),
          /ambiguous/,
        )
      }
      assert.throws(
        () => selectCtfRangePreparationForIntent(Array(33).fill(rows[0]), input.intent),
        /limit/,
      )
      await assert.rejects(
        reserveDaemonCtfPreparation({
          ...input,
          intent: { ...input.intent, consolidateProofs: true },
        }),
        /conflicts/,
      )
      assert.deepEqual(await atomicDatabaseSnapshot(directory), before)
    },
  )
})

test('atomic preparation SQLite preserves and replays an existing v2 receipt without allocating', async () => {
  await withDaemonProfile(
    {
      prefix: 'ctf-atomic-',
      incarnationId: 'atomic-legacy-incarnation',
      proofs: [],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const input = await atomicPreparationInput(directory, fence)
      const first = await reserveDaemonCtfPreparation(input)
      const database = await openDaemonStateSqlite(directory)
      database
        .prepare(
          'UPDATE daemon_ctf_range_preparations SET range_operation_id=?,source_operation_id=?,authorization_id=?,preparation_body=? WHERE range_operation_id=?',
        )
        .run(
          input.candidate.operationId,
          input.candidate.sourceOperationId,
          input.candidate.authorizationId,
          encodePersistedCtfRangeOrderPreparation(input.candidate),
          first.rangeOperationId,
        )
      database.close()
      const before = await atomicDatabaseSnapshot(directory)
      const replay = await reserveDaemonCtfPreparation({
        ...input,
        storage: createDaemonStateSqliteSession(directory),
      })
      assert.equal(replay.rangeOperationId, input.candidate.operationId)
      assert.equal(
        decodeCtfRangeOrderPreparationFromRecord(toSdkRangePreparationRecord(replay)).version,
        2,
      )
      assert.deepEqual(await atomicDatabaseSnapshot(directory), before)
      await assert.rejects(
        reserveDaemonCtfPreparation({
          ...input,
          intent: { ...input.intent, consolidateProofs: true },
        }),
        /conflicts/,
      )
      assert.deepEqual(await atomicDatabaseSnapshot(directory), before)
    },
  )
})

async function counterRangeId(
  directory: string,
  clientOrderId = 'client-order-1',
): Promise<string> {
  const database = await openDaemonStateSqlite(directory)
  try {
    const rows = readRangePreparationHistoryByClientOrderId(database, testScopeId(), clientOrderId)
    assert.equal(rows.length, 1)
    const preparation = decodeCtfRangeOrderPreparationFromRecord(
      toSdkRangePreparationRecord(rows[0]!),
    )
    assert.equal(preparation.version, 3)
    if (preparation.version !== 3) throw new Error('expected v3 preparation')
    const identity = deriveCounterCtfRangeIdentity(
      Buffer.from(WALLET_SEED_HEX, 'hex'),
      preparation.offerKeyset.id,
      preparation.offerCounterStart,
    )
    assert.equal(rows[0]!.rangeOperationId, identity.operationId)
    return identity.operationId
  } finally {
    database.close()
  }
}

test('atomic preparation SQLite lost commit reply reopens the exact receipt without another allocation', async () => {
  await withDaemonProfile(
    {
      prefix: 'ctf-atomic-',
      incarnationId: 'atomic-lost-reply-incarnation',
      proofs: [],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      const input = await atomicPreparationInput(directory, fence)
      const storage = {
        ...input.storage,
        transaction: async <T>(
          ...args: Parameters<typeof input.storage.transaction<T>>
        ): Promise<T> => {
          await input.storage.transaction<T>(...args)
          throw new Error('lost commit reply')
        },
      }
      await assert.rejects(reserveDaemonCtfPreparation({ ...input, storage }), /lost commit reply/)
      const committed = await atomicDatabaseSnapshot(directory)
      assert.equal(committed.preparations.length, 1)
      const replay = await reserveDaemonCtfPreparation({
        ...input,
        storage: createDaemonStateSqliteSession(directory),
      })
      assert.deepEqual(
        Buffer.from(replay.preparationBytes),
        Buffer.from(committed.preparations[0]!.preparation_body as Uint8Array),
      )
      assert.deepEqual(await atomicDatabaseSnapshot(directory), committed)
    },
  )
})

async function withExpiredOrdinaryRefund(
  overrides: DaemonCtfRangeOrderCoordinatorDependencies,
  run: (context: {
    directory: string
    fence: () => CustodyScopeFence
    coordinator: DaemonCtfRangeOrderCoordinator
    client: EngineClientLike
    dependencies: DaemonCtfRangeOrderCoordinatorDependencies
    source: import('@bitcaster-market/client-sdk/durableCtfRangeOperation').DurableCtfRangeOperation
    custodyOperationId: string
  }) => Promise<void>,
) {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'ordinary-refund-atomic-',
      incarnationId: 'ordinary-refund-atomic',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let activeFence = fence
      let nowMs = 10000
      const ids = ['ordinary-refund-range', 'ordinary-refund-auth']
      const dependencies: DaemonCtfRangeOrderCoordinatorDependencies = {
        createMint: () => fakeMint(),
        createWallet: () => new FakeWallet([sourceProof]),
        now: () => nowMs,
        randomId: () => ids.shift()!,
        executeRefundSwap: async (_url, request) => ({
          signatures: request.outputs.map(signBlindedOutput),
        }),
        ...overrides,
      }
      const coordinator = new DaemonCtfRangeOrderCoordinator(
        directory,
        () => activeFence,
        dependencies,
      )
      const client = fakeEngineClient(boundCapability)
      const prepared = await coordinator.prepare(orderRequest(), client)
      await prepared.markRejected()
      const db = await openDaemonStateSqlite(directory)
      const row = db
        .prepare(
          "SELECT operation_id AS id FROM custody_operations WHERE semantic_kind='conditional-keyset-swap'",
        )
        .get() as { id: string }
      db.close()
      const loaded = await new DaemonCtfRangeCoordinator(directory, activeFence).load(row.id)
      assert.ok(loaded)
      nowMs = (loaded.operation.expiry + 1) * 1000
      activeFence = await claimCustodyScopeLease(directory, {
        scopeId: testScopeId(),
        incarnationId: 'expired-refund-atomic',
        observedAtMs: nowMs,
      })
      await run({
        directory,
        fence: () => activeFence,
        coordinator,
        client,
        dependencies,
        source: loaded.operation,
        custodyOperationId: row.id,
      })
    },
  )
}

async function refundMoneySnapshot(directory: string) {
  const db = await openDaemonStateSqlite(directory)
  try {
    const names = [
      'target_keyset_counters',
      'custody_keyset_counters',
      'target_proof_operations',
      'target_wallet_proofs',
      'custody_operations',
      'custody_artifacts',
      'custody_proofs',
      'custody_proof_reservations',
      'custody_operation_inputs',
    ]
    return Object.fromEntries(
      names.map((name) => [
        name,
        db
          .prepare(`SELECT * FROM ${name}`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    )
  } finally {
    db.close()
  }
}

for (const phase of ['counter-written', 'journal-bound'] as const) {
  test(`ordinary range refund rolls back ${phase} with its source locks intact`, async () => {
    let directory = ''
    let before: unknown
    let hit = 0
    let swaps = 0
    await withExpiredOrdinaryRefund(
      {
        observeRefundPrepared: async () => {
          before = await refundMoneySnapshot(directory)
        },
        injectRefundPreparationFault: (at) => {
          if (at === phase) {
            hit++
            throw new Error('refund atomic rollback')
          }
        },
        executeRefundSwap: async () => {
          swaps++
          throw new Error('unexpected swap')
        },
      },
      async (context) => {
        directory = context.directory
        const result = await context.coordinator.recover(WALLET_SEED_HEX, context.client)
        assert.equal(result.pending.length, 1)
        assert.match(result.pending[0]!.error, /refund atomic rollback/)
        assert.equal(hit, 1)
        assert.equal(swaps, 0)
        assert.deepEqual(await refundMoneySnapshot(directory), before)
      },
    )
  })
}

test('ordinary range refund bounds real counter conflicts to three drafts without swap', async () => {
  let directory = ''
  let getFence: () => CustodyScopeFence
  let observedAt = 0
  let drafts = 0
  let swaps = 0
  await withExpiredOrdinaryRefund(
    {
      observeRefundPrepared: async ({ outputs }) => {
        drafts++
        await createDaemonCounterSource(() => ({ fence: getFence(), observedAtMs: observedAt }), {
          normalizedMint: MINT_URL,
          unit: 'msat',
        }).reserve(outputs[0]!.blindedMessage.id, 1)
      },
      executeRefundSwap: async () => {
        swaps++
        throw new Error('unexpected swap')
      },
    },
    async (context) => {
      directory = context.directory
      getFence = context.fence
      observedAt = (context.source.expiry + 1) * 1000
      const result = await context.coordinator.recover(WALLET_SEED_HEX, context.client)
      assert.equal(result.pending.length, 1)
      assert.match(result.pending[0]!.error, /counter/)
      assert.equal(drafts, 3)
      assert.equal(swaps, 0)
      const db = await openDaemonStateSqlite(directory)
      try {
        assert.equal(
          (
            db
              .prepare("SELECT count(*) AS n FROM target_proof_operations WHERE kind='swap-refund'")
              .get() as { n: number }
          ).n,
          0,
        )
      } finally {
        db.close()
      }
    },
  )
})

test('ordinary range refund reconciles lost preparation COMMIT reply without a second draft', async () => {
  let injected = 0
  let drafts = 0
  let swaps = 0
  await withExpiredOrdinaryRefund(
    {
      observeRefundPrepared: async () => {
        drafts++
      },
      injectRefundUnitOfWorkFault: (phase) => {
        if (phase === 'after-commit' && injected++ === 0)
          throw new Error('refund lost commit reply')
      },
      executeRefundSwap: async (_url, request) => {
        swaps++
        return { signatures: request.outputs.map(signBlindedOutput) }
      },
    },
    async (context) => {
      const result = await context.coordinator.recover(WALLET_SEED_HEX, context.client)
      assert.equal(result.pending.length, 0)
      assert.equal(result.recovered.length, 1)
      assert.equal(drafts, 1)
      assert.equal(swaps, 1)
      const state = await readState()
      const refund = Object.values(state!.proofOperations).find(
        (row) => row.kind === 'swap-refund',
      )!
      assert.equal(refund.state, 'completed')
      assert.ok(refund.metadata.refundOutputPlan)
    },
  )
})

for (const corruption of [
  'signature',
  'stripped-plan',
  'invalid-plan',
  'legacy-control',
] as const) {
  test(`ordinary range refund saved ${corruption} is checked before swap`, async () => {
    let context: Parameters<Parameters<typeof withExpiredOrdinaryRefund>[1]>[0]
    let swaps = 0
    let inserted = 0
    await withExpiredOrdinaryRefund(
      {
        observeRefundPrepared: async (draft) => {
          inserted++
          const source = context.source
          const outputs =
            corruption === 'legacy-control'
              ? createDeterministicDurableCtfRangeRefundOutputs({
                  seed: Buffer.from(WALLET_SEED_HEX, 'hex'),
                  source,
                  refundOperationId: draft.operationId,
                  amount:
                    source.inputs.reduce((sum, proof) => sum + BigInt(proof.amount), 0n) -
                    deriveDurableCtfRangeFeeBounds(source).maximumFee,
                  keyset: mintKeys(),
                })
              : [...draft.outputs]
          const prepared = createDurableCtfRangeRefundOperation({
            operationId: draft.operationId,
            source,
            refundKeysetId: OFFER_KEYSET_ID,
            resolveKeysetAsset: () => source.offerAsset,
            outputs,
          })
          if (corruption === 'signature')
            prepared.request.inputs[0]!.witness = { signatures: ['00'.repeat(64)] }
          await withDurableCustodyUnitOfWork(
            context.directory,
            context.fence(),
            (source.expiry + 1) * 1000,
            (database) =>
              prepareCtfRangeRefundProofOperationFromDatabase(
                database,
                {
                  operationId: draft.operationId,
                  kind: 'swap-refund',
                  mintUrl: MINT_URL,
                  inputs: prepared.request.inputs,
                  outputs: {
                    refund: serializeOutputDataArray(outputs.map(OutputData.deserialize)),
                  },
                  metadata: {
                    ...prepared.operation.metadata,
                    purpose: 'ctf-range-refund',
                    rangeOperationId: source.operationId,
                    custodyOperationId: context.custodyOperationId,
                    refundKeysetId: OFFER_KEYSET_ID,
                    ...(corruption === 'invalid-plan'
                      ? { refundOutputPlan: null }
                      : corruption === 'signature'
                        ? { refundOutputPlan: draft.plan }
                        : {}),
                  },
                },
                (source.expiry + 1) * 1000,
              ),
          )
        },
        executeRefundSwap: async (_url, request) => {
          swaps++
          return { signatures: request.outputs.map(signBlindedOutput) }
        },
      },
      async (value) => {
        context = value
        const result = await context.coordinator.recover(WALLET_SEED_HEX, context.client)
        assert.equal(inserted, 1)
        if (corruption === 'legacy-control') {
          assert.equal(result.pending.length, 0)
          assert.equal(swaps, 1)
        } else {
          assert.equal(result.pending.length, 1)
          assert.match(
            result.pending[0]!.error,
            corruption === 'signature'
              ? /witness/
              : corruption === 'invalid-plan'
                ? /seed-derived|output plan/
                : /legacy outputs/,
          )
          assert.equal(swaps, 0)
        }
      },
    )
  })
}

test('ordinary range refund different committed winner supersedes speculative outputs before CAS', async () => {
  let context: Parameters<Parameters<typeof withExpiredOrdinaryRefund>[1]>[0]
  let losing: string[] = []
  let winning: string[] = []
  let submitted: string[] = []
  let observed = 0
  const points = (outputs: readonly { blindedMessage: { B_: string } }[]) =>
    outputs.map((value) => value.blindedMessage.B_).sort()
  await withExpiredOrdinaryRefund(
    {
      observeRefundPrepared: async (draft) => {
        observed++
        losing = points(draft.outputs)
        await createDaemonCounterSource(
          () => ({ fence: context.fence(), observedAtMs: (context.source.expiry + 1) * 1000 }),
          { normalizedMint: MINT_URL, unit: 'msat' },
        ).reserve(draft.outputs[0]!.blindedMessage.id, 5)
        const winner = new DaemonCtfRangeOrderCoordinator(context.directory, context.fence, {
          ...context.dependencies,
          observeRefundPrepared: undefined,
          executeRefundSwap: async (_url, request) => {
            winning = request.outputs.map((output) => output.B_).sort()
            throw new Error('winner refund reply unavailable')
          },
        })
        const held = await winner.recover(WALLET_SEED_HEX, context.client)
        assert.equal(held.pending.length, 1)
        assert.match(held.pending[0]!.error, /winner refund reply unavailable/)
      },
      executeRefundSwap: async (_url, request) => {
        submitted = request.outputs.map((output) => output.B_).sort()
        return { signatures: request.outputs.map(signBlindedOutput) }
      },
    },
    async (value) => {
      context = value
      const result = await context.coordinator.recover(WALLET_SEED_HEX, context.client)
      assert.equal(result.pending.length, 0)
      assert.equal(result.recovered.length, 1)
      assert.equal(observed, 1)
      assert.notDeepEqual(winning, losing)
      assert.deepEqual(submitted, winning)
      const state = await readState()
      assert.equal(
        Object.values(state!.proofOperations).filter((row) => row.kind === 'swap-refund').length,
        1,
      )
    },
  )
})

test('completed regular range refund is found by the production regular-msat seed scanner in a fresh profile', async () => {
  const signatures = new Map<string, ReturnType<typeof signBlindedOutput>>()
  await withExpiredOrdinaryRefund(
    {
      executeRefundSwap: async (_url, request) => {
        const result = request.outputs.map((output) => {
          const signature = signBlindedOutput(output)
          signatures.set(output.B_, signature)
          return signature
        })
        return { signatures: result }
      },
    },
    async (context) => {
      const completed = await context.coordinator.recover(WALLET_SEED_HEX, context.client)
      assert.equal(completed.pending.length, 0)
      const originalState = await readState()
      const refund = Object.values(originalState!.proofOperations).find(
        (row) => row.kind === 'swap-refund',
      )!
      assert.equal(refund.state, 'completed')
      assert.ok(signatures.size > 0)
      const originalProofs = refund.resultProofs!.refund
      const plan = refund.metadata.refundOutputPlan as {
        counterStart: number
        counterCount: number
      }
      const directory = await mkdtemp(join(tmpdir(), 'completed-refund-seed-scan-'))
      const previous = process.env.BITCASTER_DAEMON_HOME
      try {
        await bootstrapFreshDaemonProfile({
          directory,
          engineBaseUrl: 'https://engine.example',
          mintUrl: MINT_URL,
          walletSeedHex: WALLET_SEED_HEX,
          nostrSecretKeyHex: '22'.repeat(32),
          initializedAtMs: 1,
        })
        const profileFence = await claimCustodyScopeLease(directory, {
          scopeId: testScopeId(),
          incarnationId: 'completed-refund-seed-scan',
          observedAtMs: 2,
        })
        process.env.BITCASTER_DAEMON_HOME = directory
        assert.equal(
          (
            await readAvailableWalletProofsFenced({
              mintUrl: MINT_URL,
              asset: regularAsset(),
              mutation: { fence: profileFence, observedAtMs: 3 },
            })
          ).length,
          0,
        )
        let regularLists = 0
        let restoreCalls = 0
        const transport: AllKeysetSeedRecoveryTransport = {
          wallet: {
            loadMint: async () => undefined,
            keyChain: { getKeyset: () => mintKeys(), ensureKeysetKeys: async () => mintKeys() },
            checkProofsStates: async (proofs) =>
              proofs.map((proof) => ({ Y: proofY(proof), state: 'UNSPENT' as const })),
          },
          listRegularKeysets: async () => {
            regularLists++
            return { keysets: [{ ...mintKeys(), active: true }] }
          },
          listConditionalKeysets: async () => {
            throw new Error('default recovery must never list conditions')
          },
          getConditionalKeyset: async () => {
            throw new Error('default recovery must never fetch conditional keysets')
          },
          restoreCandidates: async (candidates) => {
            restoreCalls++
            const matched = (candidates as SerializedBlindedMessage[]).filter((candidate) =>
              signatures.has(candidate.B_),
            )
            return {
              outputs: matched,
              signatures: matched.map((candidate) => signatures.get(candidate.B_)!),
            }
          },
        }
        const recovered = await recoverAllDaemonWalletFromSeed(
          {
            recoveryId: 'completed-regular-refund-scan',
            mintUrl: MINT_URL,
            unit: 'msat',
            walletSeedHex: WALLET_SEED_HEX,
            disclosureAcknowledged: true,
          },
          { directory, getFence: () => profileFence, nowMs: () => 3, transport },
        )
        assert.equal(recovered.state, 'completed')
        assert.equal(regularLists, 1)
        assert.ok(restoreCalls > 0)
        assert.deepEqual(recovered.scanPolicy, { version: 1, scope: 'regular-msat', gapLimit: 300 })
        assert.equal(recovered.scannedRanges.length, 1)
        assert.equal(recovered.scannedRanges[0]!.keysetId, OFFER_KEYSET_ID)
        assert.equal(recovered.scannedRanges[0]!.stopReason, 'gap-limit')
        assert.equal(
          recovered.scannedRanges[0]!.nextCounter,
          plan.counterStart + plan.counterCount + 300,
        )
        const identity = (proof: { id?: string; amount: unknown; secret: string; C: string }) => ({
          id: proof.id,
          amount: amountToNumber(proof.amount as Amount),
          secret: proof.secret,
          C: proof.C,
        })
        const actual = (
          await readAvailableWalletProofsFenced({
            mintUrl: MINT_URL,
            asset: regularAsset(),
            mutation: { fence: profileFence, observedAtMs: 3 },
          })
        )
          .map((row) => identity(row.proof))
          .sort((a, b) => a.secret.localeCompare(b.secret))
        const expected = originalProofs
          .map(identity)
          .sort((a, b) => a.secret.localeCompare(b.secret))
        assert.deepEqual(actual, expected)
        const counters = await createDaemonCounterSource(
          () => ({ fence: profileFence, observedAtMs: 3 }),
          { normalizedMint: MINT_URL, unit: 'msat' },
        ).snapshot()
        assert.equal(counters[OFFER_KEYSET_ID], plan.counterStart + plan.counterCount)
      } finally {
        if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
        else process.env.BITCASTER_DAEMON_HOME = previous
        await rm(directory, { recursive: true, force: true })
      }
    },
  )
})
