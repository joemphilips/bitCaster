import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  deriveDurableCustodyOperationId,
  deriveDurableCustodyProofId,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  createDurableTradeProofOperationLink,
  type DurableTradeSession,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import { DaemonProofOperationCoordinator } from '../src/durableProofOperationCoordinator.ts'
import {
  DaemonOrderCollateralCoordinator,
  setDaemonOrderCollateralFaultHookForTest,
} from '../src/durableOrderCollateralCoordinator.ts'
import {
  daemonWalletCustodyScope,
  DaemonDurableCustodyLease,
} from '../src/durableCustodyLifecycle.ts'
import {
  SqliteDurableCustodyStore,
} from '../src/durableCustodySqliteStore.ts'
import { openProfileDatabase } from '../src/profile.ts'
import {
  setDaemonCustodyUnitOfWorkFaultHookForTest,
} from '../src/durableCustodyUnitOfWork.ts'
import {
  DAEMON_WALLET_SEND_DELIVERY_PREPARATION_METADATA_KEY,
  addDaemonUserExportWalletSendPreparation,
  readDaemonWalletSendDeliveryPreparation,
} from '../src/durableWalletSendPreparation.ts'
import { recoverPreparedWalletSends } from '../src/walletOps.ts'
import {
  addAvailableSatProofs,
  abortProofOperationCustodyRecovery,
  completeProofOperationWithWalletUpdate,
  decideProofOperationCustodyRecovery,
  assertProofOperationCustodyBound,
  emptyDaemonState,
  getProofOperation,
  installDaemonProofOperationCoordinator,
  markProofOperationCompleted,
  markProofOperationMintSubmitted,
  prepareProofOperation,
  readState,
  updateState,
  writeState,
} from '../src/state.ts'
import { deriveDaemonWalletProofIdFromProof } from '../src/stateSqlite.ts'
import { writeStateWithDurableSessionKeys } from './durableSessionTestStore.ts'

const WALLET_SEED = '11'.repeat(32)
const KEYSET_ID = `00${'22'.repeat(7)}`
const PUBLIC_KEY = `02${'33'.repeat(32)}`

async function withDaemonHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-coordinator-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    await run()
  } finally {
    setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
    setDaemonOrderCollateralFaultHookForTest(undefined)
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

async function installedCoordinator() {
  const store = new SqliteDurableCustodyStore()
  const scope = daemonWalletCustodyScope(WALLET_SEED)
  await store.registerScope(scope)
  await writeState(emptyDaemonState())
  const lease = await DaemonDurableCustodyLease.claim({
    store,
    walletSeedHex: WALLET_SEED,
  })
  return {
    store,
    scope,
    lease,
    uninstall: installCoordinator(lease),
  }
}

function installCoordinator(lease: DaemonDurableCustodyLease): () => void {
  const coordinator = new DaemonProofOperationCoordinator({
    authority: lease,
    resolveMintKeys: async (_mintUrl, keysetIds) => new Map(
      keysetIds.map((keysetId) => [keysetId, {
        id: keysetId,
        unit: 'sat',
        keys: { '1': PUBLIC_KEY, '2': PUBLIC_KEY },
      }]),
    ),
  })
  return installDaemonProofOperationCoordinator(coordinator)
}

function preparedWalletSend() {
  return {
    operationId: 'wallet-send-001',
    kind: 'wallet-send' as const,
    mintUrl: 'https://mint.example',
    inputs: [{
      id: KEYSET_ID,
      amount: 2,
      secret: '66'.repeat(32),
      C: PUBLIC_KEY,
    }],
    outputs: {
      send: [storedOutput('44'.repeat(32), '44')],
      keep: [storedOutput('55'.repeat(32), '55')],
    },
    metadata: {
      amount: 1,
      fees: 0,
      keysetId: KEYSET_ID,
      unit: 'sat',
      baseAsset: 'sat',
      unselectedProofs: [],
    },
  }
}

function reservingWalletSend() {
  const prepared = preparedWalletSend()
  const reservationId = `wallet-send:${prepared.operationId}`
  return addDaemonUserExportWalletSendPreparation({
    ...prepared,
    metadata: { ...prepared.metadata, reservationId },
    walletProofReservation: { reservationId, unit: 'sat' as const },
  })
}

function reservingWalletSendFor(operationId: string, inputSecret: string) {
  const prepared = preparedWalletSend()
  const reservationId = `wallet-send:${operationId}`
  return addDaemonUserExportWalletSendPreparation({
    ...prepared,
    operationId,
    inputs: [{
      ...prepared.inputs[0]!,
      secret: canonicalTestSecret(inputSecret),
    }],
    metadata: { ...prepared.metadata, reservationId },
    walletProofReservation: { reservationId, unit: 'sat' as const },
  })
}

function storedOutput(secret: string, byte: string) {
  return storedOutputAmount(secret, byte, 1)
}

function storedOutputAmount(secret: string, byte: string, amount: number) {
  return {
    blindedMessage: { amount, id: KEYSET_ID, B_: `02${byte.repeat(32)}` },
    blindingFactor: byte.repeat(32),
    secret,
  }
}

function canonicalTestSecret(label: string): string {
  return Buffer.from(label, 'utf8')
    .toString('hex')
    .padEnd(64, '0')
    .slice(0, 64)
}

test('installed daemon coordinator commits custody, operation, and wallet proof lifecycle together', async () => {
  await withDaemonHome(async () => {
    const { store, scope, lease, uninstall } = await installedCoordinator()
    try {
      const prepared = reservingWalletSend()
      await addAvailableSatProofs(prepared.mintUrl, prepared.inputs)
      await prepareProofOperation(prepared)
      const persisted = await getProofOperation(prepared.operationId)
      const delivery = readDaemonWalletSendDeliveryPreparation(
        persisted ?? prepared,
      )
      assert.equal(delivery?.policyKind, 'user-export')
      assert.equal(delivery?.walletOperationId, prepared.operationId)
      const reserved = (await readState()).wallet.proofs[0]
      assert.equal(reserved?.state, 'reserved')
      assert.equal(reserved?.reservedBy, prepared.walletProofReservation.reservationId)
      await markProofOperationMintSubmitted(prepared.operationId)
      const keep = {
        id: KEYSET_ID,
        amount: 1,
        secret: 'keep-secret',
        C: PUBLIC_KEY,
      }
      const send = {
        id: KEYSET_ID,
        amount: 1,
        secret: 'send-secret',
        C: PUBLIC_KEY,
      }
      const inputProofId = deriveDaemonWalletProofIdFromProof(
        prepared.mintUrl,
        'sat',
        prepared.inputs[0]!,
      )
      const keepProofId = deriveDaemonWalletProofIdFromProof(
        prepared.mintUrl,
        'sat',
        keep,
      )
      await completeProofOperationWithWalletUpdate({
        operationId: prepared.operationId,
        resultProofs: { send: [send], keep: [keep] },
        walletProofs: [{ proofIds: [inputProofId, keepProofId] }],
        walletDelta: (now) => ({
          deleteProofIds: [inputProofId],
          upsertProofs: [{
            proof: keep,
            mintUrl: prepared.mintUrl,
            unit: 'sat',
            state: 'available',
            asset: { kind: 'sats', baseAsset: 'sat' },
            createdAt: now,
            updatedAt: now,
          }],
        }),
      })

      assert.equal((await getProofOperation(prepared.operationId))?.state, 'completed')
      assert.deepEqual((await readState()).wallet.proofs.map(({ proof }) => proof), [keep])
      const custodyId = deriveDurableCustodyOperationId(scope.scopeId, {
        retainedOperationKey: prepared.operationId,
        binding: {
          kind: 'wallet',
          activityId: prepared.operationId,
          stage: 'send',
        },
      })
      const canonical = await store.transact(
        {
          scope,
          owner: lease.authorization(),
          operationIds: [custodyId],
        },
        (transaction) => transaction.getOperation(custodyId),
      )
      assert.equal(canonical?.operation.state, 'reconciled')
      assert.equal((await store.listRecoverablePage({
        scope,
        cursor: null,
        limit: 10,
      })).records.length, 0)
      assert.equal(canonical?.operation.reservation.inputs[0]?.proofId,
        deriveDurableCustodyProofId({
          normalizedMint: prepared.mintUrl,
          unit: 'sat',
          keysetId: KEYSET_ID,
          secret: prepared.inputs[0]!.secret,
        }))
      const repeated = await prepareProofOperation(prepared)
      assert.equal(repeated.state, 'completed')
      const database = openProfileDatabase()
      try {
        const reservation = database.prepare(
          `SELECT proof_id FROM custody_proof_reservations
            WHERE scope_id = ? AND operation_id = ?`,
        ).get(scope.scopeId, custodyId)
        assert.equal(reservation, undefined)
      } finally {
        database.close()
      }
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('daemon coordinator rejects substituted wallet-send delivery authority before persistence', async () => {
  await withDaemonHome(async () => {
    const { lease, uninstall } = await installedCoordinator()
    try {
      const prepared = reservingWalletSend()
      const substituted = structuredClone(prepared)
      const delivery = substituted.metadata[
        DAEMON_WALLET_SEND_DELIVERY_PREPARATION_METADATA_KEY
      ] as { walletOperationId: string }
      delivery.walletOperationId = 'foreign-wallet-operation'
      await addAvailableSatProofs(substituted.mintUrl, substituted.inputs)

      await assert.rejects(
        () => prepareProofOperation(substituted),
        /preparation fingerprint is invalid|does not match its exact operation/,
      )

      assert.equal(await getProofOperation(substituted.operationId), null)
      assert.equal((await readState()).wallet.proofs[0]?.state, 'available')
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('daemon coordinator rolls back both authorities on a prepare crash', async () => {
  await withDaemonHome(async () => {
    const { store, scope, lease, uninstall } = await installedCoordinator()
    try {
      const prepared = reservingWalletSend()
      await addAvailableSatProofs(prepared.mintUrl, prepared.inputs)
      setDaemonCustodyUnitOfWorkFaultHookForTest((stage) => {
        if (stage === 'before-commit') throw new Error('simulated crash')
      })
      await assert.rejects(
        () => prepareProofOperation(prepared),
        /simulated crash/,
      )
      setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
      assert.equal(await getProofOperation('wallet-send-001'), null)
      const available = (await readState()).wallet.proofs[0]
      assert.equal(available?.state, 'available')
      assert.equal(available?.reservedBy, undefined)
      assert.equal((await store.listRecoverablePage({
        scope,
        cursor: null,
        limit: 10,
      })).records.length, 0)
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('daemon coordinator atomically releases wallet proofs on safe abort crashes', async () => {
  await withDaemonHome(async () => {
    const { store, scope, lease, uninstall } = await installedCoordinator()
    try {
      const before = await prepareSafeAbortScenario(
        'wallet-send-abort-before',
        'abort-before-input',
      )
      await assertBeforeCommitAbort(before)
      const after = await prepareSafeAbortScenario(
        'wallet-send-abort-after',
        'abort-after-input',
      )
      await assertAfterCommitAbort(after)
      const custodyId = walletSendCustodyId(scope.scopeId, after.input.operationId)
      assert.equal(
        (await readCanonical(store, scope, lease, custodyId))?.operation.state,
        'aborted',
      )
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('safe abort revalidates exact evidence and operation authority in its transaction', async () => {
  await withDaemonHome(async () => {
    const { lease, uninstall } = await installedCoordinator()
    try {
      const scenario = await prepareSafeAbortScenario(
        'wallet-send-abort-evidence',
        'abort-evidence-input',
      )
      await assert.rejects(
        () => abortProofOperationCustodyRecovery(scenario.record, {
          classification: 'all-inputs-unspent',
          exactRequestDisposition: 'unknown',
        }),
        /abort evidence is insufficient/,
      )
      await assert.rejects(
        () => abortProofOperationCustodyRecovery({
          ...scenario.record,
          metadata: { ...scenario.record.metadata, amount: 999 },
        }, scenario.evidence),
        /changed before|foreign exact artifacts/,
      )
      assert.equal(
        (await getProofOperation(scenario.input.operationId))?.state,
        'prepared',
      )
      assert.equal(
        await walletProofReservationForSecret(scenario.inputSecret),
        scenario.input.walletProofReservation.reservationId,
      )
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('safe abort restores exact proofs to their immutable parent collateral pin', async () => {
  await withDaemonHome(async () => {
    const { store, scope, lease, uninstall } = await installedCoordinator()
    try {
      const proof = cashuProof(100, 'abort-parent-input')
      const [proofRow] = await addAvailableSatProofs(
        'https://mint.example',
        [proof],
      )
      assert.ok(proofRow)
      const orderCoordinator = new DaemonOrderCollateralCoordinator(lease)
      const pin = await orderCoordinator.prepare({
        clientOrderId: 'abort-parent-client-order',
        marketId: 'condition-YES',
        mintUrl: 'https://mint.example',
        unit: 'sat',
        orderAmount: 100,
        requiredAmount: 100,
        submissionRequest: {
          clientOrderId: 'abort-parent-client-order',
          outcomeId: 'YES',
          tokenSide: 'Outcome',
          side: 'Buy',
          price: 50,
          amountSubunits: 100,
          timeInForce: 'GTC',
        },
        proofs: [proofRow],
      })
      await orderCoordinator.bindOrObserve({
        pinId: pin.pinId,
        orderId: 'abort-parent-order',
        status: 'resting',
        remainingAmount: 100,
      })
      const operationId = 'abort-parent-preflight-split'
      const operation = {
        operationId,
        kind: 'regular-split' as const,
        mintUrl: 'https://mint.example',
        inputs: [proof],
        outputs: {
          keep: [storedOutputAmount('abort-parent-change', '88', 100)],
        },
        metadata: {
          unit: 'sat',
          reservationId: operationId,
        },
        walletProofReservation: {
          reservationId: operationId,
          unit: 'sat' as const,
          parentOrderCollateralPinId: pin.pinId,
        },
      }
      await prepareProofOperation(operation)
      const prepared = await getProofOperation(operationId)
      assert.ok(prepared)
      const custodyId = walletSendCustodyId(scope.scopeId, operationId)
      assert.equal(
        (await readCanonical(store, scope, lease, custodyId))?.operation
          .reservation.parentReservationId,
        pin.pinId,
      )

      const aborted = await abortProofOperationCustodyRecovery(prepared, {
        classification: 'all-inputs-unspent',
        exactRequestDisposition: 'deterministically-rejected',
      })
      assert.equal(aborted.state, 'Failed')
      assert.equal(await walletProofReservationForSecret(proof.secret), pin.pinId)
      const database = openProfileDatabase()
      try {
        assert.equal(
          database.prepare(
            `SELECT COUNT(*) AS count
               FROM custody_order_collateral_allocations
              WHERE scope_id = ? AND operation_id = ?`,
          ).get(scope.scopeId, custodyId)?.count,
          0,
        )
      } finally {
        database.close()
      }
      assert.equal((await prepareProofOperation(operation)).state, 'Failed')
      await assert.rejects(
        () => prepareProofOperation({
          ...operation,
          walletProofReservation: {
            ...operation.walletProofReservation,
            parentOrderCollateralPinId: 'foreign-parent-pin',
          },
        }),
        /foreign immutable authority/,
      )
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

async function prepareSafeAbortScenario(
  operationId: string,
  inputSecret: string,
) {
  const input = reservingWalletSendFor(operationId, inputSecret)
  await addAvailableSatProofs(input.mintUrl, input.inputs)
  await prepareProofOperation(input)
  const record = await getProofOperation(operationId)
  assert.ok(record)
  const decision = await decideProofOperationCustodyRecovery(
    record,
    'all-inputs-unspent',
    'deterministically-rejected',
  )
  if (decision.kind !== 'abort-no-transport') {
    throw new Error('expected a safe custody abort decision')
  }
  return {
    input,
    inputSecret: input.inputs[0]!.secret,
    record,
    evidence: {
      classification: 'all-inputs-unspent' as const,
      exactRequestDisposition: 'deterministically-rejected' as const,
    },
  }
}

async function assertBeforeCommitAbort(
  scenario: Awaited<ReturnType<typeof prepareSafeAbortScenario>>,
): Promise<void> {
  setDaemonCustodyUnitOfWorkFaultHookForTest((stage) => {
    if (stage === 'before-commit') throw new Error('abort before commit')
  })
  await assert.rejects(
    () => abortProofOperationCustodyRecovery(
      scenario.record,
      scenario.evidence,
    ),
    /abort before commit/,
  )
  setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
  assert.equal(
    (await getProofOperation(scenario.input.operationId))?.state,
    'prepared',
  )
  assert.equal(
    await walletProofReservationForSecret(scenario.inputSecret),
    scenario.input.walletProofReservation.reservationId,
  )
  assert.equal(
    (await abortProofOperationCustodyRecovery(
      scenario.record,
      scenario.evidence,
    )).state,
    'Failed',
  )
  assert.equal(await walletProofStateForSecret(scenario.inputSecret), 'available')
}

async function assertAfterCommitAbort(
  scenario: Awaited<ReturnType<typeof prepareSafeAbortScenario>>,
): Promise<void> {
  setDaemonCustodyUnitOfWorkFaultHookForTest((stage) => {
    if (stage === 'after-commit') throw new Error('abort after commit')
  })
  await assert.rejects(
    () => abortProofOperationCustodyRecovery(
      scenario.record,
      scenario.evidence,
    ),
    /abort after commit/,
  )
  setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
  assert.equal(
    (await getProofOperation(scenario.input.operationId))?.state,
    'Failed',
  )
  assert.equal(await walletProofStateForSecret(scenario.inputSecret), 'available')
  assert.equal(await walletProofReservationForSecret(scenario.inputSecret), undefined)
  assert.equal(
    (await abortProofOperationCustodyRecovery(
      scenario.record,
      scenario.evidence,
    )).state,
    'Failed',
  )
}

async function walletProofStateForSecret(secret: string) {
  return (await readState()).wallet.proofs.find(
    (proof) => proof.proof.secret === secret,
  )?.state
}

async function walletProofReservationForSecret(secret: string) {
  return (await readState()).wallet.proofs.find(
    (proof) => proof.proof.secret === secret,
  )?.reservedBy
}

function walletSendCustodyId(scopeId: string, operationId: string): string {
  return deriveDurableCustodyOperationId(scopeId, {
    retainedOperationKey: operationId,
    binding: { kind: 'wallet', activityId: operationId, stage: 'send' },
  })
}

test('condition registration completes exact zero or positive change across restart', async () => {
  await withDaemonHome(async () => {
    const installed = await installedCoordinator()
    let lease = installed.lease
      let uninstall = installed.uninstall
    const operationIds: string[] = []
    try {
      for (const changeCount of [0, 1] as const) {
        operationIds.push(await completeConditionRegistration(changeCount))
      }

      uninstall()
      await lease.stopAndRelease()
      lease = await DaemonDurableCustodyLease.claim({
        store: installed.store,
        walletSeedHex: WALLET_SEED,
      })
      uninstall = installCoordinator(lease)
      for (const operationId of operationIds) {
        const restored = await getProofOperation(operationId)
        assert.equal(restored?.state, 'completed')
        assert.ok(restored)
        await assertProofOperationCustodyBound(restored)
      }
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

async function completeConditionRegistration(
  changeCount: 0 | 1,
): Promise<string> {
  const operationId = `condition-registration-${changeCount}`
  const outputs = changeCount === 0
    ? []
    : [storedOutput('registration-change', '88')]
  await prepareProofOperation({
    operationId,
    kind: 'ctf-condition-registration',
    mintUrl: 'https://mint.example',
    inputs: [cashuProof(1 + changeCount, `registration-${changeCount}`)],
    outputs: { change: outputs },
    metadata: { unit: 'sat' },
  })
  await markProofOperationMintSubmitted(operationId)
  await markProofOperationCompleted(operationId, {
    change: changeCount === 0
      ? []
      : [{
          ...cashuProof(1, 'registration-change'),
          amount: 1n,
          dleq: undefined,
        }],
  })
  return operationId
}

test('daemon restart recovers one exact wallet operation through canonical custody', async () => {
  await withDaemonHome(async () => {
    const installed = await installedCoordinator()
    let lease = installed.lease
    let uninstall = installed.uninstall
    try {
      const prepared = reservingWalletSend()
      await addAvailableSatProofs(prepared.mintUrl, prepared.inputs)
      await prepareProofOperation(prepared)
      await markProofOperationMintSubmitted(prepared.operationId)

      uninstall()
      await lease.stopAndRelease()
      lease = await DaemonDurableCustodyLease.claim({
        store: installed.store,
        walletSeedHex: WALLET_SEED,
      })
      uninstall = installCoordinator(lease)

      const send = {
        id: KEYSET_ID,
        amount: 1,
        secret: 'restored-send-secret',
        C: PUBLIC_KEY,
      }
      const keep = {
        id: KEYSET_ID,
        amount: 1,
        secret: 'restored-keep-secret',
        C: PUBLIC_KEY,
      }
      const recovery = await recoverPreparedWalletSends(
        { walletSeedHex: WALLET_SEED },
        {
          createCashuWallet: () => ({
            async loadMint() {},
            async receive() { throw new Error('receive unused') },
            async send() { throw new Error('send unused') },
            async checkProofsStates(proofs) {
              return proofs.map(({ secret }) => ({
                Y: secret,
                state: 'SPENT',
                witness: null,
              }))
            },
          }),
          async restoreOutputGroups() {
            return { send: [send], keep: [keep] }
          },
        },
      )

      assert.deepEqual(recovery, {
        recoveredCount: 1,
        pendingCount: 0,
        recovered: [prepared.operationId],
        pending: [],
        summaryTruncated: false,
      })
      assert.equal((await getProofOperation(prepared.operationId))?.state, 'completed')
      assert.deepEqual((await readState()).wallet.proofs.map(({ proof }) => proof), [keep])
      const custodyId = deriveDurableCustodyOperationId(installed.scope.scopeId, {
        retainedOperationKey: prepared.operationId,
        binding: {
          kind: 'wallet',
          activityId: prepared.operationId,
          stage: 'send',
        },
      })
      assert.equal(
        (await readCanonical(
          installed.store,
          installed.scope,
          lease,
          custodyId,
        ))?.operation.state,
        'reconciled',
      )
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('canonical active work is not hidden by a stale terminal daemon projection', async () => {
  await withDaemonHome(async () => {
    const { lease, uninstall } = await installedCoordinator()
    try {
      const prepared = reservingWalletSend()
      await addAvailableSatProofs(prepared.mintUrl, prepared.inputs)
      await prepareProofOperation(prepared)
      await updateState(
        { proofOperationIds: [prepared.operationId] },
        (state) => {
          const operation = state.proofOperations[prepared.operationId]
          assert.ok(operation)
          operation.state = 'Failed'
          operation.lastError = 'stale terminal projection'
        },
      )

      const recovery = await recoverPreparedWalletSends({
        walletSeedHex: WALLET_SEED,
      })

      assert.equal(recovery.recoveredCount, 0)
      assert.equal(recovery.pendingCount, 1)
      assert.equal(recovery.pending[0]?.operationId, prepared.operationId)
      assert.equal(
        recovery.pending[0]?.reason,
        'local-authority-invalid',
      )
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('trade session and canonical custody advance together across a submit fault', async () => {
  await withDaemonHome(async () => {
    const { store, scope, lease, uninstall } = await installedCoordinator()
    try {
      const operationId = 'trade-001/seller-lock'
      const link = createDurableTradeProofOperationLink({
        tradeId: 'trade-001',
        role: 'seller',
        stage: 'proof-reservation',
        state: 'prepared',
        operationKey: operationId,
        kind: 'cashu-atomic',
      })
      const session = tradeSession(link)
      const state = emptyDaemonState()
      state.durableTradeSessions[session.tradeId] = session
      await writeStateWithDurableSessionKeys(state)
      const prepared = {
        ...preparedWalletSend(),
        operationId,
        durableTradeRecovery: link,
        kind: 'swap-lock' as const,
      }
      await prepareProofOperation(prepared)

      const custodyId = deriveDurableCustodyOperationId(scope.scopeId, {
        retainedOperationKey: operationId,
        binding: {
          kind: 'trade',
          tradeId: session.tradeId,
          role: session.role,
          stage: 'lock',
        },
      })
      setDaemonCustodyUnitOfWorkFaultHookForTest((stage) => {
        if (stage === 'before-commit') throw new Error('submit crash')
      })
      await assert.rejects(
        () => markProofOperationMintSubmitted(operationId),
        /submit crash/,
      )
      setDaemonCustodyUnitOfWorkFaultHookForTest(undefined)
      assert.equal((await getProofOperation(operationId))?.state, 'prepared')
      assert.equal((await readCanonical(store, scope, lease, custodyId))?.operation.state,
        'dispatch-intent')

      await markProofOperationMintSubmitted(operationId)
      const after = await readState()
      assert.equal(after.proofOperations[operationId]?.state, 'mint-submitted')
      assert.equal(
        after.durableTradeSessions[session.tradeId]?.proofOperations[0]?.state,
        'mint-submitted',
      )
      assert.equal((await readCanonical(store, scope, lease, custodyId))?.operation.state,
        'transport-attempted')
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('trade lock reserves exact wallet inputs until its state-machine commit', async () => {
  await withDaemonHome(async () => {
    const { lease, uninstall } = await installedCoordinator()
    try {
      const operationId = 'trade-wallet-lock/buyer-lock'
      const link = createDurableTradeProofOperationLink({
        tradeId: 'trade-wallet-lock',
        role: 'buyer',
        stage: 'proof-reservation',
        state: 'prepared',
        operationKey: operationId,
        kind: 'cashu-atomic',
      })
      const session = tradeSession(link)
      const state = emptyDaemonState()
      state.durableTradeSessions[session.tradeId] = session
      await writeStateWithDurableSessionKeys(state)
      const prepared = preparedWalletSend()
      await addAvailableSatProofs(prepared.mintUrl, prepared.inputs)

      await prepareProofOperation({
        ...prepared,
        operationId,
        durableTradeRecovery: link,
        kind: 'swap-lock',
        metadata: {
          ...prepared.metadata,
          reservationId: operationId,
        },
        walletProofReservation: {
          reservationId: operationId,
          unit: 'sat',
        },
      })

      const reserved = (await readState()).wallet.proofs[0]
      assert.equal(reserved?.state, 'reserved')
      assert.equal(reserved?.reservedBy, operationId)
      await markProofOperationMintSubmitted(operationId)
      await markProofOperationCompleted(operationId, {
        send: [{
          id: KEYSET_ID,
          amount: 1,
          secret: 'locked-secret',
          C: PUBLIC_KEY,
        }],
        keep: [{
          id: KEYSET_ID,
          amount: 1,
          secret: 'change-secret',
          C: PUBLIC_KEY,
        }],
      })

      const recoveredInput = (await readState()).wallet.proofs[0]
      assert.equal(recoveredInput?.state, 'reserved')
      assert.equal(recoveredInput?.reservedBy, operationId)
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

test('order collateral capability survives restart and follows exact partial-fill change', async () => {
  await withDaemonHome(async () => {
    const installed = await installedCoordinator()
    let lease = installed.lease
    let uninstall = installed.uninstall
    try {
      const operationId = 'trade-order-pin/buyer-lock'
      const link = createDurableTradeProofOperationLink({
        tradeId: 'trade-order-pin',
        role: 'buyer',
        stage: 'proof-reservation',
        state: 'prepared',
        operationKey: operationId,
        kind: 'cashu-atomic',
      })
      const session = tradeSession(link)
      const state = emptyDaemonState()
      state.durableTradeSessions[session.tradeId] = session
      await writeStateWithDurableSessionKeys(state)

      const inputProof = cashuProof(100, 'order-pin-input')
      const [inputRow] = await addAvailableSatProofs(
        'https://mint.example',
        [inputProof],
      )
      assert.ok(inputRow)
      let orderCoordinator = new DaemonOrderCollateralCoordinator(lease)
      const pin = await orderCoordinator.prepare({
        clientOrderId: 'client-order-pin',
        marketId: 'condition-YES',
        mintUrl: 'https://mint.example',
        unit: 'sat',
        orderAmount: 100,
        requiredAmount: 100,
        submissionRequest: {
          clientOrderId: 'client-order-pin',
          outcomeId: 'YES',
          tokenSide: 'Outcome',
          side: 'Buy',
          price: 50,
          amountSubunits: 100,
          timeInForce: 'GTC',
        },
        proofs: [inputRow],
      })
      await orderCoordinator.bindOrObserve({
        pinId: pin.pinId,
        orderId: 'order-pin',
        status: 'resting',
        remainingAmount: 100,
      })

      await prepareProofOperation({
        operationId,
        durableTradeRecovery: link,
        kind: 'swap-lock',
        mintUrl: 'https://mint.example',
        inputs: [inputProof],
        outputs: {
          send: [storedOutputAmount('order-pin-locked', '66', 40)],
          keep: [storedOutputAmount('order-pin-change', '77', 60)],
        },
        metadata: {
          amount: 40,
          fees: 0,
          keysetId: KEYSET_ID,
          unit: 'sat',
          reservationId: operationId,
          unselectedProofs: [],
        },
        walletProofReservation: {
          reservationId: operationId,
          unit: 'sat',
          parentOrderCollateralPinId: pin.pinId,
        },
      })
      assert.equal((await readState()).wallet.proofs[0]?.reservedBy, operationId)
      await markProofOperationMintSubmitted(operationId)
      const locked = cashuProof(40, 'order-pin-locked')
      const change = cashuProof(60, 'order-pin-change')
      await markProofOperationCompleted(operationId, {
        send: [locked],
        keep: [change],
      })
      const commitFill = () => orderCoordinator.commitFill({
        pinId: pin.pinId,
        orderId: 'order-pin',
        tradeId: session.tradeId,
        fillOrderAmount: 40,
        operationKeys: [operationId],
        releaseProofs: [],
        replacementProofs: [{
          proof: change,
          mintUrl: 'https://mint.example',
          unit: 'sat',
          asset: { kind: 'sats', baseAsset: 'sat' },
        }],
        stateScope: { walletProofs: [{ proofIds: [
          proofId(inputProof),
          proofId(change),
        ] }] },
        applyState(walletState, now) {
          walletState.wallet.proofs = [{
            proof: change,
            mintUrl: 'https://mint.example',
            unit: 'sat',
            state: 'available',
            asset: { kind: 'sats', baseAsset: 'sat' },
            createdAt: now,
            updatedAt: now,
          }]
        },
      })
      setDaemonOrderCollateralFaultHookForTest((stage) => {
        if (stage === 'before-commit') throw new Error('fill commit crash')
      })
      await assert.rejects(commitFill, /fill commit crash/)
      assert.equal((await readState()).wallet.proofs[0]?.proof.secret,
        inputProof.secret)
      setDaemonOrderCollateralFaultHookForTest(undefined)
      await commitFill()

      uninstall()
      await lease.stopAndRelease()
      lease = await DaemonDurableCustodyLease.claim({
        store: installed.store,
        walletSeedHex: WALLET_SEED,
      })
      uninstall = installCoordinator(lease)
      orderCoordinator = new DaemonOrderCollateralCoordinator(lease)
      assert.equal(await orderCoordinator.classifyProofs(pin.pinId, {
        mintUrl: 'https://mint.example',
        unit: 'sat',
        proofs: [change],
      }), 'all')
      const persistedChange = (await readState()).wallet.proofs[0]
      assert.equal(persistedChange?.proof.secret, change.secret)
      assert.equal(persistedChange?.state, 'reserved')
      assert.equal(persistedChange?.reservedBy, pin.pinId)
    } finally {
      uninstall()
      await lease.stopAndRelease()
    }
  })
})

function cashuProof(amount: number, secret: string) {
  return { id: KEYSET_ID, amount, secret, C: PUBLIC_KEY }
}

function proofId(proof: ReturnType<typeof cashuProof>): string {
  return deriveDaemonWalletProofIdFromProof(
    'https://mint.example',
    'sat',
    proof,
  )
}

function tradeSession(
  operation: ReturnType<typeof createDurableTradeProofOperationLink>,
): DurableTradeSession {
  const nowSecs = Math.floor(Date.now() / 1_000)
  const sellerLocktimeSecs = nowSecs + 120
  const buyerLocktimeSecs = nowSecs + 100
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId: operation.tradeId,
    role: operation.role,
    localProtocolPubkey: 'a'.repeat(64),
    counterpartyProtocolPubkey: 'b'.repeat(64),
    mintUrl: 'https://mint.example',
    sellerLocktimeSecs,
    buyerLocktimeSecs,
    ephemeralKeyHandle: {
      keyId: operation.tradeId,
      tradeId: operation.tradeId,
      role: operation.role,
      localProtocolPubkey: 'a'.repeat(64),
      counterpartyProtocolPubkey: 'b'.repeat(64),
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs,
      buyerLocktimeSecs,
    },
    stage: 'intent',
    proofOperations: [],
    receivedCiphers: {},
    outboundCiphers: {},
  }
}

async function readCanonical(
  store: SqliteDurableCustodyStore,
  scope: ReturnType<typeof daemonWalletCustodyScope>,
  lease: DaemonDurableCustodyLease,
  operationId: string,
) {
  return store.transact(
    { scope, owner: lease.authorization(), operationIds: [operationId] },
    (transaction) => transaction.getOperation(operationId),
  )
}
