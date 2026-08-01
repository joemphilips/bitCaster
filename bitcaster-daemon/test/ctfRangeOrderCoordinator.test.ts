import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  selectCtfRangeAmounts,
  type MintKeys,
  type Proof,
  type SerializedBlindedMessage,
  type SwapRequest,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import {
  createDurableCtfRangeResultEnvelope,
  deriveRootCtfOutcomeCollectionId,
  type DurableCtfRangeOperation,
} from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  decodeSettlementCapabilityArtifactBytes,
  deriveSettlementCapabilityArtifactDigest,
} from '@bitcaster-market/client-sdk/settlementCapabilityArtifact'
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
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease, type CustodyScopeFence } from '../src/profileFencing.ts'
import {
  emptyDaemonState,
  readState,
  recordSubmittedOrder,
  writeState,
  type StoredProofAsset,
} from '../src/state.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import type { EngineClientLike, PrepareSettlementCapabilityInput } from '../src/server.ts'
import { deserializeOutputGroups } from '../src/walletOps.ts'

const CONDITION_ID = 'ab'.repeat(32)
const COORDINATOR_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const ROTATED_COORDINATOR_KEY = 'c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = `02${'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}`
const KEYS = {
  '1': MINT_PUBLIC_KEY,
  '2': MINT_PUBLIC_KEY,
  '4': MINT_PUBLIC_KEY,
  '8': MINT_PUBLIC_KEY,
  '16': MINT_PUBLIC_KEY,
  '32': MINT_PUBLIC_KEY,
  '64': MINT_PUBLIC_KEY,
  '128': MINT_PUBLIC_KEY,
  '256': MINT_PUBLIC_KEY,
  '512': MINT_PUBLIC_KEY,
  '1024': MINT_PUBLIC_KEY,
  '2048': MINT_PUBLIC_KEY,
  '4096': MINT_PUBLIC_KEY,
  '8192': MINT_PUBLIC_KEY,
  '16384': MINT_PUBLIC_KEY,
}
const INPUT_FEE_PPK = 100
const FINAL_EXPIRY = 2_000
const OFFER_KEYSET_ID = deriveKeysetId(KEYS, {
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
const WALLET_SEED_HEX = '11'.repeat(32)
const MINT_URL = 'https://mint.example'
const ORDER_ID = '00000000-0000-8000-8000-000000000001'
const CAPABILITY_ARTIFACT_ID = '00000000-0000-4000-8000-000000000002'
const SETTLEMENT_GROUP_ID = '00000000-0000-4000-8000-000000000004'

test('daemon retries the exact capability request after its acknowledgement is lost', async () => {
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
      let createAttempts = 0
      const client = fakeEngineClient((request) => {
        posted.push(structuredClone(request))
        createAttempts += 1
        if (createAttempts === 1) throw new Error('capability acknowledgement lost')
        return boundCapability(request)
      })
      const ids = ['range-operation-1', 'range-authorization-1']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => mint,
        createWallet: () => wallet,
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })

      await assert.rejects(
        coordinator.prepare(orderRequest(), client),
        /capability acknowledgement lost/,
      )
      assert.equal(wallet.completeCalls, 1)
      const committed = await readState()
      assert.equal(
        committed?.wallet.proofs.some(({ proof }) => proof.secret === sourceProof.secret),
        false,
      )
      assert.equal(
        committed?.wallet.proofs.reduce((total, { proof }) => total + Number(proof.amount), 0),
        3_190,
      )
      assert.equal(committed?.proofOperations['range-operation-1:source']?.state, 'completed')
      assert.deepEqual(committed?.orders, {})

      const recovered = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(recovered.recovered, ['range-operation-1:source'])
      assert.deepEqual(recovered.pending, [])
      assert.equal(wallet.completeCalls, 1)
      assert.equal(posted.length, 2)
      assert.deepEqual(posted[1], posted[0])
      assert.equal(JSON.stringify(posted[0]), canonicalJson(posted[0]))
      const database = await openDaemonStateSqlite(directory)
      const custodyRows = database
        .prepare(
          'SELECT operation_id, operation_state, result_state, revision FROM custody_operations',
        )
        .all() as Array<{ operation_id: string }>
      database.close()
      assert.equal(custodyRows.length, 1)
      assert.ok(
        await new DaemonCtfRangeCoordinator(directory, fence).load(custodyRows[0]!.operation_id),
      )

      const persisted = await readState()
      assert.deepEqual(persisted?.orders, {})
      const beforePendingRecovery = await rangeRecoverySnapshot(directory)
      const waiting = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(waiting.recovered, [])
      assert.equal(waiting.pending.length, 1)
      assert.match(waiting.pending[0]!.error, /remains unspent before expiry/)
      assert.deepEqual(await rangeRecoverySnapshot(directory), beforePendingRecovery)
      assert.equal(posted.length, 2)
      await assertSeedAbsentFromArtifacts(directory)
    },
  )
})

test('daemon does not consolidate fragmented order funds unless the caller opts in', async () => {
  const sourceProofs = [4_096, 4_096, 2, 2, 2].map((amount) =>
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
        coordinator.prepare({ ...orderRequest(), price: 8_193 }, client),
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

test('daemon resumes exact bounded consolidation without recreating its range capability', async () => {
  const sourceProofs = [4_096, 4_096, 2, 2, 2].map((amount) =>
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
      const request = { ...orderRequest(), price: 8_193, consolidateProofs: true }

      await assert.rejects(coordinator.prepare(request, client), /mint swap acknowledgement lost/)
      const interrupted = await readState()
      const consolidationId = 'range-operation-consolidated:source:consolidation:0'
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
        recovered?.proofOperations['range-operation-consolidated:source']?.state,
        'completed',
      )
      assert.deepEqual(recovered?.orders, {})
    },
  )
})

test('daemon releases the exact unspent source when authorization expires', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(8_192), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-expiry-',
      incarnationId: 'range-expiry-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let nowMs = 10_000
      const wallet = new FakeWallet([sourceProof], 'unspent')
      const client = fakeEngineClient(() => {
        throw new Error('capability creation must not run for an uncommitted source')
      })
      const ids = ['range-operation-expired', 'range-authorization-expired']
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
      assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
        recovered: ['range-operation-expired:source'],
        pending: [],
      })
      const state = await readState()
      assert.equal(
        state?.wallet.proofs.find(({ proof }) => proof.secret === sourceProof.secret)?.state,
        'available',
      )
      assert.equal(state?.proofOperations['range-operation-expired:source']?.state, 'Failed')
      assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
        recovered: [],
        pending: [],
      })
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
      const custody = database.prepare('SELECT operation_id FROM custody_operations').get() as {
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
        recovered: ['range-operation-rejected:source'],
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

test('daemon cancels an expired resting order before refunding its authorization', async () => {
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
      let cancelled = false
      let cancellationCalls = 0
      const baseClient = fakeEngineClient(boundCapability)
      const client: EngineClientLike = {
        ...baseClient,
        getOrderStatus: async () => (cancelled ? cancelledOrderStatus() : restingOrderStatus()),
        cancelOrder: async () => {
          cancellationCalls += 1
          cancelled = true
          return true
        },
      }
      const ids = ['range-operation-resting-expiry', 'range-authorization-resting-expiry']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => activeFence, {
        createMint: () => fakeMint(64, 320),
        createWallet: () => new FakeWallet([sourceProof]),
        executeRefundSwap: async (_mintUrl, request) => {
          assert.equal(cancelled, true)
          return { signatures: request.outputs.map(signBlindedOutput) }
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
      assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
        recovered: ['range-operation-resting-expiry:source'],
        pending: [],
      })
      assert.equal(cancellationCalls, 1)
      assert.equal((await readState())?.orders[ORDER_ID]?.status, 'cancelled')
    },
  )
})

test('daemon terminates a partially filled FAK result after acknowledgement recovery', async () => {
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
          throw new Error('settlement result acknowledgement response lost')
        },
        getOrderStatus: async () => partiallyFilledFakOrderStatus(),
      }
      const ids = ['range-operation-result', 'range-authorization-result']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => mint,
        createWallet: () => new FakeWallet([sourceProof]),
        now: () => 10_000,
        randomId: () => ids.shift()!,
      })
      const request = { ...orderRequest(), timeInForce: 'FAK' as const }
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
      const custody = database.prepare('SELECT operation_id FROM custody_operations').get() as {
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

      const interrupted = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(interrupted.recovered, [])
      assert.equal(interrupted.pending.length, 1)
      assert.match(interrupted.pending[0]!.error, /acknowledgement response lost/)
      assert.equal(
        (await new DaemonCtfRangeCoordinator(directory, fence).load(custody.operation_id))?.record
          .operation.result.state,
        'applied',
      )

      assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
        recovered: ['range-operation-result:source'],
        pending: [],
      })
      assert.equal(acknowledgementCalls, 1)
      assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
        recovered: [],
        pending: [],
      })
    },
  )
})

test('daemon applies exact NUT-09 recovery when the engine result envelope is unavailable', async () => {
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
        getOrderStatus: async () => filledOrderStatus(),
        acknowledgeSettlementCapabilityResult: async () => {
          throw new Error('mint-only recovery must not acknowledge an absent engine result')
        },
      }
      const ids = ['range-operation-mint-recovery', 'range-authorization-mint-recovery']
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => mint,
        createWallet: () => new FakeWallet([sourceProof]),
        now: () => 10_000,
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
      mintCommitted = true

      const database = await openDaemonStateSqlite(directory)
      const custody = database.prepare('SELECT operation_id FROM custody_operations').get() as {
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

      assert.deepEqual(await coordinator.recover(WALLET_SEED_HEX, client), {
        recovered: ['range-operation-mint-recovery:source'],
        pending: [],
      })
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
      const refundRequests: SwapRequest[] = []
      const mint = {
        ...fakeMint(),
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
      const custody = database.prepare('SELECT operation_id FROM custody_operations').get() as {
        operation_id: string
      }
      database.close()
      const loaded = await new DaemonCtfRangeCoordinator(directory, fence).load(
        custody.operation_id,
      )
      assert.ok(loaded)
      nowMs = (loaded.operation.expiry + 1) * 1_000
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
        recovered: ['range-operation-refund:source'],
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
    },
  )
})

test('daemon resumes an exact residual authorization after a restart boundary', async () => {
  const sourceProof = signedProof(OutputData.createRandomData(Amount.from(16_384), mintKeys())[0]!)
  await withDaemonProfile(
    {
      prefix: 'bitcaster-range-residual-',
      incarnationId: 'range-residual-production-test',
      proofs: [sourceProof],
      asset: regularAsset(),
    },
    async ({ directory, fence }) => {
      let selectedOutputs = new Set<string>()
      let predecessorOperationId = ''
      let predecessorCustodyOperationId = ''
      let result: SettlementCapabilityResultResponse | null = null
      let capabilityAttempts = 0
      let submitCalls = 0
      let policyCalls = 0
      let nowMs = 10_000
      const capabilityRequests: CreateSettlementCapabilityRequest[] = []
      const successorOrderId = '00000000-0000-4000-8000-000000000005'
      const mint = fakeMint(64, 1_000, () => selectedOutputs)
      const baseClient = fakeEngineClient((request) => {
        capabilityRequests.push(structuredClone(request))
        capabilityAttempts += 1
        if (capabilityAttempts === 2) {
          throw new Error('residual capability acknowledgement lost')
        }
        return request.continuation === null
          ? boundCapability(request)
          : {
              ...boundCapability(request),
              reference: {
                artifactId: '00000000-0000-4000-8000-000000000006',
                bindingDigest: 'aa'.repeat(32),
              },
              orderId: successorOrderId,
            }
      })
      const client: EngineClientLike = {
        ...baseClient,
        getSettlementCapabilityAdmissionPolicy: async () => {
          policyCalls += 1
          if (policyCalls === 2) throw new Error('successor policy unavailable')
          return {
            coordinatorPubkey: policyCalls === 1 ? COORDINATOR_KEY : ROTATED_COORDINATOR_KEY,
          }
        },
        submitOrder: async () => {
          submitCalls += 1
          return { ...submittedOrder(10_000), orderId: successorOrderId }
        },
        getSettlementCapabilityResultByOperation: async (operationId) =>
          operationId === predecessorOperationId ? result : null,
        acknowledgeSettlementCapabilityResult: async (_resultId, request) => {
          assert.equal(request.expectedVersion, 1)
          assert.ok(result)
          return {
            ...result,
            acknowledgedAt: new Date(12_000).toISOString(),
            version: 2,
          }
        },
        getOrderStatus: async () => awaitingAuthorizationOrderStatus(10_000, 20_000),
      }
      const ids = [
        'range-operation-partial',
        'range-authorization-partial',
        'client-order-successor',
        'range-operation-residual',
        'range-authorization-residual',
      ]
      const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
        createMint: () => mint,
        createWallet: () => new FakeWallet([sourceProof]),
        now: () => nowMs,
        randomId: () => ids.shift()!,
      })
      const request = {
        ...orderRequest(),
        amountSubunits: 20_000,
        continueAfterPartialFill: true,
        timeInForce: 'GTD' as const,
        expiresAt: '2030-01-01T00:00:00.000Z',
      }
      const prepared = await coordinator.prepare(request, client)
      await recordSubmittedOrder(
        request.marketId,
        request.clientOrderId,
        submittedOrder(20_000),
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
      const custody = database.prepare('SELECT operation_id FROM custody_operations').get() as {
        operation_id: string
      }
      database.close()
      const loaded = await new DaemonCtfRangeCoordinator(directory, fence).load(
        custody.operation_id,
      )
      assert.ok(loaded)
      predecessorCustodyOperationId = custody.operation_id
      predecessorOperationId = loaded.operation.operationId
      const selection = validPartialSelection(loaded.operation, 10_000n)
      selectedOutputs = new Set(
        loaded.operation.manifest.entries
          .filter((_, index) => selection.selectedIndices.includes(index))
          .map(({ B_ }) => B_),
      )
      result = engineResult(prepared, loaded.operation, selection.selection)
      nowMs = 650_000

      const interrupted = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(interrupted.recovered, [])
      assert.equal(interrupted.pending.length, 1)
      assert.match(interrupted.pending[0]!.error, /successor policy unavailable/)
      assert.equal(capabilityAttempts, 1)
      const intentDatabase = await openDaemonStateSqlite(directory)
      const persistedIntent = intentDatabase
        .prepare(
          `SELECT successor_client_order_id AS clientOrderId,
             successor_range_operation_id AS operationId,
             successor_authorization_id AS authorizationId
           FROM daemon_ctf_range_successor_intents`,
        )
        .get() as { clientOrderId: string; operationId: string; authorizationId: string }
      intentDatabase.close()
      assert.deepEqual(
        { ...persistedIntent },
        {
          clientOrderId: 'client-order-successor',
          operationId: 'range-operation-residual',
          authorizationId: 'range-authorization-residual',
        },
      )

      const capabilityInterrupted = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(capabilityInterrupted.recovered, [])
      assert.equal(capabilityInterrupted.pending.length, 1)
      assert.match(
        capabilityInterrupted.pending[0]!.error,
        /residual capability acknowledgement lost/,
      )

      const resumed = await coordinator.recover(WALLET_SEED_HEX, client)
      assert.deepEqual(resumed.recovered, [])
      assert.equal(resumed.pending.length, 1)
      assert.match(resumed.pending[0]!.error, /submitted and remains pending settlement/)
      assert.equal(capabilityAttempts, 3)
      assert.equal(submitCalls, 1)
      assert.equal(ids.length, 0)
      assert.equal(capabilityRequests[0]?.continuation, null)
      assert.deepEqual(capabilityRequests[1], capabilityRequests[2])
      assert.deepEqual(capabilityRequests[1]?.continuation, {
        predecessorOrderId: ORDER_ID,
        settlementGroupId: SETTLEMENT_GROUP_ID,
        settlementGroupRevision: 1,
        continuationRevision: 2,
      })
      assert.equal(capabilityRequests[1]?.clientOrderId, 'client-order-successor')
      assert.equal(capabilityRequests[1]?.orderIntent.amountSubunits, 10_000)
      assert.equal(capabilityRequests[1]?.orderIntent.timeInForce, 'GTD')
      assert.equal(capabilityRequests[1]?.orderIntent.expiresAt, request.expiresAt)
      const recoveredDatabase = await openDaemonStateSqlite(directory)
      const preparations = recoveredDatabase
        .prepare(
          `SELECT range_operation_id AS operationId, lifecycle_state AS lifecycle
           FROM daemon_ctf_range_preparations ORDER BY created_at_ms, range_operation_id`,
        )
        .all() as Array<{ operationId: string; lifecycle: string }>
      const preparationAuthorities = recoveredDatabase
        .prepare(
          `SELECT range_operation_id AS operationId,
             authorization_expires_at_unix_seconds AS expiresAt,
             preparation_body AS preparationBody
           FROM daemon_ctf_range_preparations
           ORDER BY created_at_ms, range_operation_id`,
        )
        .all() as Array<{
        operationId: string
        expiresAt: number
        preparationBody: Uint8Array
      }>
      const custodyCount = recoveredDatabase
        .prepare('SELECT count(*) AS count FROM custody_operations')
        .get() as { count: number }
      const residualOperationId = (
        recoveredDatabase
          .prepare(
            `SELECT operation_id AS operationId
             FROM custody_operations
             WHERE operation_id <> ?`,
          )
          .get(predecessorCustodyOperationId) as { operationId: string }
      ).operationId
      const predecessorSuccessors = recoveredDatabase
        .prepare(
          `SELECT proofs.selectability
           FROM custody_selected_successors AS successors
           JOIN custody_proofs AS proofs
             ON proofs.scope_id = successors.scope_id
            AND proofs.proof_id = successors.proof_id
           WHERE successors.operation_id = ?
           ORDER BY successors.proof_position`,
        )
        .all(predecessorCustodyOperationId) as Array<{ selectability: string }>
      const residualInputs = recoveredDatabase
        .prepare(
          `SELECT proofs.selectability,
             proofs.reservation_operation_id AS reservationOperationId
           FROM custody_operation_inputs AS inputs
           JOIN custody_proofs AS proofs
             ON proofs.scope_id = inputs.scope_id
            AND proofs.proof_id = inputs.proof_id
           WHERE inputs.operation_id = ?
           ORDER BY inputs.input_position`,
        )
        .all(residualOperationId) as Array<{
        selectability: string
        reservationOperationId: string | null
      }>
      const selectableCustodyCount = recoveredDatabase
        .prepare(
          `SELECT count(*) AS count
           FROM custody_proofs
           WHERE selectability = 'selectable'`,
        )
        .get() as { count: number }
      const reservedWalletCount = recoveredDatabase
        .prepare(
          `SELECT count(*) AS count
           FROM target_wallet_proofs
           WHERE state = 'reserved'`,
        )
        .get() as { count: number }
      recoveredDatabase.close()
      assert.deepEqual(
        preparations.map(({ operationId, lifecycle }) => ({ operationId, lifecycle })),
        [
          { operationId: 'range-operation-partial', lifecycle: 'terminal' },
          { operationId: 'range-operation-residual', lifecycle: 'order-submitted' },
        ],
      )
      assert.equal(preparationAuthorities.length, 2)
      assert.ok(preparationAuthorities[1]!.expiresAt > preparationAuthorities[0]!.expiresAt)
      assert.equal(
        JSON.parse(Buffer.from(preparationAuthorities[1]!.preparationBody).toString('utf8'))
          .coordinatorPublicKey,
        ROTATED_COORDINATOR_KEY,
      )
      assert.equal(custodyCount.count, 2)
      assert.ok(predecessorSuccessors.length > 0)
      assert.equal(
        predecessorSuccessors.every(
          ({ selectability }) => selectability === 'retained' || selectability === 'spent',
        ),
        true,
      )
      assert.equal(
        predecessorSuccessors.some(({ selectability }) => selectability === 'spent'),
        true,
      )
      assert.ok(residualInputs.length > 0)
      assert.equal(
        residualInputs.every(
          ({ selectability, reservationOperationId }) =>
            selectability === 'locked' && reservationOperationId === residualOperationId,
        ),
        true,
      )
      assert.equal(selectableCustodyCount.count, 0)
      assert.equal(reservedWalletCount.count, 0)
    },
  )
})

test('daemon applies revisioned continuation policy before creating any successor', async (t) => {
  const cases: Array<{
    name: string
    continueAfterPartialFill: boolean
    continuationStatus: 'open' | 'consumed' | 'declined'
    foreignOrderId: boolean
    terminal: boolean
    declineCalls: number
    loseFirstDecline: boolean
    hostile?: 'group' | 'amount'
  }> = [
    {
      name: 'default-off declines the open continuation',
      continueAfterPartialFill: false,
      continuationStatus: 'open' as const,
      foreignOrderId: false,
      terminal: true,
      declineCalls: 2,
      loseFirstDecline: true,
    },
    {
      name: 'a committed decline is retried to repair the order-book tombstone',
      continueAfterPartialFill: true,
      continuationStatus: 'declined' as const,
      foreignOrderId: false,
      terminal: true,
      declineCalls: 1,
      loseFirstDecline: false,
    },
    {
      name: 'a consumed continuation never creates a blind successor',
      continueAfterPartialFill: true,
      continuationStatus: 'consumed' as const,
      foreignOrderId: false,
      terminal: false,
      declineCalls: 0,
      loseFirstDecline: false,
    },
    {
      name: 'a foreign continuation predecessor fails closed',
      continueAfterPartialFill: true,
      continuationStatus: 'open' as const,
      foreignOrderId: true,
      terminal: false,
      declineCalls: 0,
      loseFirstDecline: false,
    },
    {
      name: 'a foreign result group creates no successor authority',
      continueAfterPartialFill: true,
      continuationStatus: 'open',
      foreignOrderId: false,
      terminal: false,
      declineCalls: 0,
      loseFirstDecline: false,
      hostile: 'group',
    },
    {
      name: 'a hostile remaining amount creates no successor authority',
      continueAfterPartialFill: true,
      continuationStatus: 'open',
      foreignOrderId: false,
      terminal: false,
      declineCalls: 0,
      loseFirstDecline: false,
      hostile: 'amount',
    },
  ]
  for (const [index, candidate] of cases.entries()) {
    await t.test(candidate.name, async () => {
      const sourceProof = signedProof(
        OutputData.createRandomData(Amount.from(16_384), mintKeys())[0]!,
      )
      await withDaemonProfile(
        {
          prefix: `bitcaster-range-continuation-${index}-`,
          incarnationId: `range-continuation-${index}`,
          proofs: [sourceProof],
          asset: regularAsset(),
        },
        async ({ directory, fence }) => {
          let selectedOutputs = new Set<string>()
          let predecessorOperationId = ''
          let result: SettlementCapabilityResultResponse | null = null
          let capabilityCalls = 0
          let continuationStatus = candidate.continuationStatus
          const declineArguments: unknown[][] = []
          const mint = fakeMint(64, 1_000, () => selectedOutputs)
          const baseClient = fakeEngineClient((request) => {
            capabilityCalls += 1
            return boundCapability(request)
          })
          const client: EngineClientLike = {
            ...baseClient,
            getSettlementCapabilityResultByOperation: async (operationId) =>
              operationId === predecessorOperationId ? result : null,
            acknowledgeSettlementCapabilityResult: async () => ({
              ...result!,
              acknowledgedAt: new Date(12_000).toISOString(),
              version: 2,
            }),
            getOrderStatus: async () => ({
              ...awaitingAuthorizationOrderStatus(
                candidate.hostile === 'amount' ? 20_000 : 10_000,
                20_000,
                continuationStatus,
              )!,
              ...(candidate.hostile === 'group'
                ? {
                    continuation: {
                      ...awaitingAuthorizationOrderStatus(10_000)!.continuation!,
                      settlementGroupRevision: 2,
                    },
                  }
                : {}),
              ...(candidate.foreignOrderId
                ? { orderId: '00000000-0000-4000-8000-000000000099' }
                : {}),
            }),
            declineOrderContinuation: async (...args) => {
              declineArguments.push(args)
              if (candidate.loseFirstDecline && declineArguments.length === 1) {
                continuationStatus = 'declined'
                throw new Error('decline response lost after durable commit')
              }
            },
          }
          const ids = ['range-operation-policy', 'range-authorization-policy']
          const coordinator = new DaemonCtfRangeOrderCoordinator(directory, () => fence, {
            createMint: () => mint,
            createWallet: () => new FakeWallet([sourceProof]),
            now: () => 10_000,
            randomId: () => ids.shift()!,
          })
          const request = {
            ...orderRequest(),
            amountSubunits: 20_000,
            continueAfterPartialFill: candidate.continueAfterPartialFill,
          }
          const prepared = await coordinator.prepare(request, client)
          await recordSubmittedOrder(
            request.marketId,
            request.clientOrderId,
            submittedOrder(20_000),
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
          const custody = database.prepare('SELECT operation_id FROM custody_operations').get() as {
            operation_id: string
          }
          database.close()
          const loaded = await new DaemonCtfRangeCoordinator(directory, fence).load(
            custody.operation_id,
          )
          assert.ok(loaded)
          predecessorOperationId = loaded.operation.operationId
          const selection = validPartialSelection(loaded.operation, 10_000n)
          selectedOutputs = new Set(
            loaded.operation.manifest.entries
              .filter((_, entryIndex) => selection.selectedIndices.includes(entryIndex))
              .map(({ B_ }) => B_),
          )
          result = engineResult(prepared, loaded.operation, selection.selection)

          let recovery = await coordinator.recover(WALLET_SEED_HEX, client)
          if (candidate.loseFirstDecline) {
            assert.equal(recovery.pending.length, 1)
            assert.match(recovery.pending[0]!.error, /decline response lost/)
            recovery = await coordinator.recover(WALLET_SEED_HEX, client)
          }
          assert.equal(recovery.pending.length, candidate.terminal ? 0 : 1)
          if (candidate.hostile !== undefined) {
            assert.match(
              recovery.pending[0]!.error,
              /continuation authority is unavailable|amount differs/,
            )
          }
          assert.equal(declineArguments.length, candidate.declineCalls)
          if (candidate.declineCalls > 0) {
            assert.equal(
              declineArguments.every(
                (argumentsValue) =>
                  JSON.stringify(argumentsValue) ===
                  JSON.stringify([request.marketId, ORDER_ID, 2]),
              ),
              true,
            )
          }
          assert.equal(capabilityCalls, 1)
          const recoveredDatabase = await openDaemonStateSqlite(directory)
          const preparation = recoveredDatabase
            .prepare(
              `SELECT lifecycle_state AS lifecycle
               FROM daemon_ctf_range_preparations
               WHERE range_operation_id = ?`,
            )
            .get(predecessorOperationId) as { lifecycle: string }
          const successorIntentCount = recoveredDatabase
            .prepare('SELECT count(*) AS count FROM daemon_ctf_range_successor_intents')
            .get() as { count: number }
          recoveredDatabase.close()
          assert.equal(preparation.lifecycle, candidate.terminal ? 'terminal' : 'order-submitted')
          assert.equal(successorIntentCount.count, 0)
        },
      )
    })
  }
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

      const prepared = await coordinator.prepare(
        { ...orderRequest(), side: 'Sell', price: 5_000, consolidateProofs: true },
        fakeEngineClient(boundCapability),
      )

      assert.deepEqual(prepared.consolidation, {
        operationIds: ['range-operation-conditional:source:consolidation:0'],
        feeSubunits: 1,
      })
      assert.equal(wallet.completeCalls, 2)
      assert.equal(
        (await readState())?.proofOperations['range-operation-conditional:source']?.state,
        'completed',
      )
      await assertSeedAbsentFromArtifacts(directory)
    },
  )
})

async function withDaemonProfile(
  input: {
    readonly prefix: string
    readonly incarnationId: string
    readonly proofs: readonly Proof[]
    readonly asset: StoredProofAsset
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
    await writeAvailableProofs(input.proofs, input.asset)
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

async function writeAvailableProofs(
  proofs: readonly Proof[],
  asset: StoredProofAsset,
): Promise<void> {
  const state = emptyDaemonState()
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
    },
  ): Promise<SwapPreview> {
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
        keepAmount === 0 ? [] : OutputData.createRandomData(Amount.from(keepAmount), mintKeys()),
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
              options.keysetId === RECEIVE_KEYSET_ID ? conditionalMintKeys() : mintKeys(),
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
) {
  return {
    getInfo: async () =>
      ({
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
            max_pool_entries: 32,
            max_expiry_seconds: maxExpirySeconds,
          },
        },
      }) as never,
    getKeySets: async () => ({
      keysets: [
        {
          id: OFFER_KEYSET_ID,
          unit: 'msat',
          active: true,
          input_fee_ppk: INPUT_FEE_PPK,
          final_expiry: FINAL_EXPIRY,
        },
        {
          id: '00deadbeef000000',
          unit: 'msat',
          active: false,
          input_fee_ppk: INPUT_FEE_PPK,
          final_expiry: FINAL_EXPIRY,
        },
      ],
    }),
    getConditionalKeysets: async () => ({
      keysets: [
        {
          id: RECEIVE_KEYSET_ID,
          unit: 'msat',
          active: true,
          input_fee_ppk: INPUT_FEE_PPK,
          final_expiry: FINAL_EXPIRY,
          condition_id: CONDITION_ID,
          outcome_collection: 'YES',
          outcome_collection_id: OUTCOME_COLLECTION_ID,
        },
      ],
    }),
    getCtfCondition: async () => ({
      condition_id: CONDITION_ID,
      keysets: { YES: RECEIVE_KEYSET_ID },
    }),
    getKeys: async (keysetId?: string) => ({
      keysets: [keysetId === RECEIVE_KEYSET_ID ? conditionalMintKeys() : mintKeys()],
    }),
    restore: async ({ outputs }: { outputs: SerializedBlindedMessage[] }) => {
      const selected = restoredOutputs?.() ?? new Set<string>()
      const restored = outputs.filter(({ B_ }) => selected.has(B_))
      return {
        outputs: restored,
        signatures: restored.map(signBlindedOutput),
      }
    },
    check: async ({ Ys }: { Ys: string[] }) => ({
      states: Ys.map((Y) => ({ Y, state: 'UNSPENT' as const, witness: null })),
    }),
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
    payParticipationScoreEcash: async () => {
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
  remainingAmountSubunits = 10_000,
): Awaited<ReturnType<EngineClientLike['submitOrder']>> {
  return {
    orderId: ORDER_ID,
    status: 'resting',
    remainingAmountSubunits,
    fills: [],
    pendingPubkeySubmissions: [],
    baseAsset: 'sat',
    divisibility: 10_000,
    activeSettlementGroup: null,
  }
}

function awaitingAuthorizationOrderStatus(
  remainingAmountSubunits: number,
  originalAmountSubunits = orderRequest().amountSubunits,
  continuationStatus: 'open' | 'consumed' | 'declined' = 'open',
): Awaited<ReturnType<EngineClientLike['getOrderStatus']>> {
  return {
    orderId: ORDER_ID,
    marketId: orderRequest().marketId,
    status: 'awaiting_authorization',
    remainingAmountSubunits,
    filledAmountSubunits: originalAmountSubunits - remainingAmountSubunits,
    fills: [],
    tokenSide: 'Outcome',
    baseAsset: 'sat',
    divisibility: 10_000,
    activeSettlementGroup: null,
    continuation: {
      settlementGroupId: SETTLEMENT_GROUP_ID,
      settlementGroupRevision: 1,
      revision: 2,
      status: continuationStatus,
    },
  }
}

function restingOrderStatus(): Awaited<ReturnType<EngineClientLike['getOrderStatus']>> {
  return {
    ...awaitingAuthorizationOrderStatus(orderRequest().amountSubunits),
    status: 'resting',
    filledAmountSubunits: 0,
    continuation: null,
  }
}

function partiallyFilledFakOrderStatus(): Awaited<ReturnType<EngineClientLike['getOrderStatus']>> {
  return {
    ...restingOrderStatus(),
    status: 'partially_filled',
    remainingAmountSubunits: 5_000,
    filledAmountSubunits: 5_000,
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
    divisibility: 10_000,
    activeSettlementGroup: null,
    continuation: null,
  }
}

function cancelledOrderStatus(): Awaited<ReturnType<EngineClientLike['getOrderStatus']>> {
  return {
    ...restingOrderStatus(),
    status: 'cancelled',
    continuation: null,
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
  const signature = createBlindSignature(pointFromHex(output.B_), MINT_PRIVATE_KEY, output.id)
  const dleq = createDLEQProof(pointFromHex(output.B_), MINT_PRIVATE_KEY)
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
    price: 5_000,
    amountSubunits: 10_000,
    minimumFillAmountSubunits: 10_000,
    continueAfterPartialFill: false,
    consolidateProofs: false,
    baseAsset: 'sat',
    collateralUnit: 'msat',
    divisibility: 10_000,
    timeInForce: 'GTC',
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

function conditionalMintKeys(): MintKeys {
  return {
    ...mintKeys(),
    id: RECEIVE_KEYSET_ID,
    conditional: {
      condition_id: CONDITION_ID,
      outcome_collection: 'YES',
      outcome_collection_id: OUTCOME_COLLECTION_ID,
    },
  }
}

function signedProof(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    MINT_PRIVATE_KEY,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), MINT_PRIVATE_KEY)
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
    output.blindedMessage.id === RECEIVE_KEYSET_ID ? conditionalMintKeys() : mintKeys(),
  )
}

function amountToNumber(amount: Proof['amount']): number {
  return amount.toNumber()
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
    amount:
      typeof proof.amount === 'object' &&
      proof.amount !== null &&
      'toNumber' in proof.amount &&
      typeof proof.amount.toNumber === 'function'
        ? proof.amount.toNumber()
        : typeof proof.amount === 'object' &&
            proof.amount !== null &&
            'value' in proof.amount &&
            typeof proof.amount.value === 'bigint'
          ? Number(proof.amount.value)
          : Number(proof.amount),
    secret: proof.secret,
    C: proof.C,
    dleq: proof.dleq ?? null,
    witness: proof.witness ?? null,
    p2pk_e: proof.p2pk_e ?? null,
  }
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
