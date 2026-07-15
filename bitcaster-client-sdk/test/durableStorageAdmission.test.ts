import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeDurableCustodyRecord,
  decodeDurableCustodyOperationId,
  decodeDurableCustodyScopeId,
  decodeDurableCustodyScopeState,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
  type DurableCustodyRecord,
  type DurableCustodyScopeState,
} from '../src/durableCustody.ts'
import {
  DURABLE_STORAGE_ADMISSION_RECORD_BYTES_LIMIT_MAX,
  DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
  DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX,
  DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
  DURABLE_STORAGE_OPERATION_ARTIFACT_LIMIT_MAX,
  DURABLE_STORAGE_OPERATION_LIMIT_MAX,
  DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX,
  DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX,
  advanceDurablePreTradePubkeyAttempt,
  advanceDurablePreTradeSession,
  advanceDurableStorageReservationArtifacts,
  applyDurablePreTradeStorageAdmissionBatch,
  applyDurableStorageAdmissionBatch,
  bindDurablePreTradeStorageReservation,
  calculateDurableSwapStorageBudget,
  classifyDurablePreTradeTerminalEvidence,
  createDurableStorageAccountingState,
  createDurableStorageAdmissionBatchPlan,
  createDurablePreTradeStorageAdmissionBatchPlan,
  createDurablePreTradeStorageCapacityProfile,
  createDurablePreTradeStorageReservationPlan,
  createDurableStorageJsonArtifact,
  createDurableStorageReservationArtifactPlan,
  createDurableStorageReservationPlan,
  decodeDurableStorageAccountingState,
  decodeDurableStorageMaintenanceCursor,
  promoteDurablePreTradeSession,
  releaseTerminalDurablePreTradeIntent,
  releaseCommittedDurableStorageOperation,
  reduceDurableStorageAccountingState,
  verifyDurableStorageReservationArtifacts,
  type DurableStorageAccountingState,
  type DurablePreTradeStorageCapacityProfile,
  type DurableStorageReleaseStore,
  type DurableStorageReservationPlan,
} from '../src/durableStorageAdmission.ts'

const FINGERPRINT_A = 'a'.repeat(64)
const FINGERPRINT_B = 'b'.repeat(64)
const PROOF_ID = '11'.repeat(32)
const SCOPE = walletScope()
const OPERATION_A = custodyRecord('a').operation.operationId
const OPERATION_B = custodyRecord('b').operation.operationId

function tradeBinding(
  record: DurableCustodyRecord,
): Extract<DurableCustodyRecord['operation']['binding'], { kind: 'trade' }> {
  if (record.operation.binding.kind !== 'trade') assert.fail('expected trade binding')
  return record.operation.binding
}

function tradeIdentity(record: DurableCustodyRecord) {
  const binding = tradeBinding(record)
  return {
    kind: binding.kind,
    tradeId: binding.tradeId,
    role: binding.role,
    stage: binding.stage,
  }
}

test('calculates one exact versioned worst-case budget from canonical custody identifiers', () => {
  const budget = calculateDurableSwapStorageBudget(budgetInput())
  assert.equal(budget.schemaVersion, DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION)
  assert.equal(budget.scopeId, SCOPE.scopeId)
  assert.deepEqual(
    budget.operations.map(({ semanticOperationId }) => semanticOperationId),
    [OPERATION_A, OPERATION_B],
  )
  assert.equal(budget.totalArtifactCount, 17)
  assert.equal(budget.totalBytes, 2_740)
  assert.deepEqual(
    budget.session.artifacts.map((artifact) => artifact.artifactId),
    ['session'],
  )
  assert.match(budget.session.artifacts[0]!.sha256, /^[0-9a-f]{64}$/)
  assert.equal(budget.isBrowserQuotaGuarantee, false)
  assert.equal(budget.requiresAtomicAdapterTransaction, true)
})

test('rejects malformed, noncanonical, and foreign custody identifiers', () => {
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        scopeId: 'aa'.repeat(32),
      }),
    /custody scope id is invalid/,
  )
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        scopeId: 'custody:profile:%ZZ',
      }),
    /custody scope id is invalid/,
  )
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        scopeId: 'custody:profile:%70rofile-001',
      }),
    /custody scope id is invalid/,
  )
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        operations: [
          {
            ...budgetInput().operations[0]!,
            semanticOperationId: 'bb'.repeat(32),
          },
        ],
      }),
    /custody operation id is invalid/,
  )
  const foreignScope = walletScope('f'.repeat(64))
  const foreignOperationId = deriveDurableCustodyOperationId(foreignScope.scopeId, {
    retainedOperationKey: 'seller-lock-a',
    binding: {
      kind: 'trade',
      tradeId: 'trade-a',
      role: 'seller',
      stage: 'lock',
    },
  })
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        operations: [
          {
            ...budgetInput().operations[0]!,
            semanticOperationId: foreignOperationId,
          },
        ],
      }),
    /custody operation id is invalid/,
  )
})

test('accepts canonical wallet and market custody identifiers', () => {
  const market = marketScope()
  const marketOperationId = deriveDurableCustodyOperationId(market.scopeId, {
    retainedOperationKey: 'market-lock-a',
    binding: {
      kind: 'trade',
      tradeId: 'market-trade-a',
      role: 'seller',
      stage: 'lock',
    },
  })
  assert.equal(
    calculateDurableSwapStorageBudget({
      ...budgetInput(),
      scopeId: market.scopeId,
      operations: [operationBudget(marketOperationId, 900)],
    }).scopeId,
    market.scopeId,
  )

  for (const walletId of ['a', 'b', 'c', 'd'].map((value) => value.repeat(64))) {
    const scope = walletScope(walletId)
    assert.equal(decodeDurableCustodyScopeId(scope.scopeId), scope.scopeId)
    const operationId = deriveDurableCustodyOperationId(scope.scopeId, {
      retainedOperationKey: `key:${walletId.slice(0, 16)}%`,
      binding: {
        kind: 'trade',
        tradeId: `trade:🔐:${walletId.slice(0, 16)}`,
        role: 'seller',
        stage: 'lock',
      },
    })
    assert.equal(decodeDurableCustodyOperationId(operationId, scope.scopeId), operationId)
  }
  const maxScope = walletScope('e'.repeat(64))
  const maxRecord = structuredClone(custodyRecord('max'))
  maxRecord.scope = maxScope
  maxRecord.operation.operationId = deriveDurableCustodyOperationId(maxScope.scopeId, {
    retainedOperationKey: maxRecord.operation.retainedOperationKey,
    binding: tradeIdentity(maxRecord),
  })
  assert.equal(decodeDurableCustodyRecord(maxRecord).scope.scopeId, maxScope.scopeId)
  assert.throws(
    () => decodeDurableCustodyScopeId('custody:wallet:%'),
    /custody scope id is invalid/,
  )
})

test('derives logical bytes from closed exact encodings instead of caller-declared totals', () => {
  const json = createDurableStorageJsonArtifact({
    artifactId: 'json-row',
    artifactRole: 'trade-session',
    value: { operationId: OPERATION_A, state: 'prepared' },
  })
  const budget = calculateDurableSwapStorageBudget({
    ...budgetInput(),
    session: json,
  })
  assert.equal(budget.session.bytes, new TextEncoder().encode(json.encodedJson).byteLength)
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        session: { count: 1, bytes: 1 },
      } as never),
    /planned storage artifact/,
  )
})

test('binds a reservation to the exact artifact encodings written by its adapter', () => {
  const input = budgetInput()
  const reservation = createDurableStorageReservationPlan({
    reservationId: 'storage-reservation-artifact-binding',
    budget: calculateDurableSwapStorageBudget(input),
  })
  const artifacts = plannedArtifacts(input)
  assert.doesNotThrow(() => verifyDurableStorageReservationArtifacts({ reservation, artifacts }))
  assert.doesNotThrow(() =>
    verifyDurableStorageReservationArtifacts({
      reservation,
      artifacts: [...artifacts].reverse(),
    }),
  )

  const substituted = structuredClone(artifacts)
  const bytes =
    substituted[1]!.encoding === 'binary' ? substituted[1]!.bytes : assert.fail('expected binary')
  bytes.fill(1)
  assert.throws(
    () =>
      verifyDurableStorageReservationArtifacts({
        reservation,
        artifacts: substituted,
      }),
    /do not match the committed plan/,
  )
  assert.throws(
    () =>
      verifyDurableStorageReservationArtifacts({
        reservation,
        artifacts: artifacts.slice(0, -1),
      }),
    /do not match the committed plan/,
  )
})

test('reservation creation rejects cloned or mutated logical-byte budgets', () => {
  const budget = calculateDurableSwapStorageBudget(budgetInput())
  const cloned = structuredClone(budget)
  cloned.operations[0]!.exactOperation.bytes = 1
  cloned.operations[0]!.bytes -= 899
  cloned.totalBytes -= 899
  assert.throws(
    () =>
      createDurableStorageReservationPlan({
        reservationId: 'forged',
        budget: cloned,
      }),
    /not SDK-issued/,
  )

  budget.operations[0]!.exactOperation.bytes = 1
  assert.throws(
    () => createDurableStorageReservationPlan({ reservationId: 'mutated', budget }),
    /not SDK-issued/,
  )
})

test('rejects duplicate artifact identities within and across exact operation components', () => {
  const duplicateWithin = budgetInput()
  duplicateWithin.operations[0]!.ciphers = [
    artifact('duplicate', 10, 'cipher'),
    artifact('duplicate', 10, 'cipher'),
  ]
  assert.throws(
    () => calculateDurableSwapStorageBudget(duplicateWithin),
    /artifact id is duplicated/,
  )

  const duplicateAcross = budgetInput()
  duplicateAcross.operations[1]!.privateMaterial = [artifact('session', 10, 'private-material')]
  assert.throws(
    () => calculateDurableSwapStorageBudget(duplicateAcross),
    /artifact id is duplicated/,
  )
})

test('reserves, consumes, and releases exact custody operations without dropping shared bytes early', async () => {
  const reservation = reservationPlan()
  const initial = accountingState(
    reservation.totalBytes + DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
  )
  const reserved = reserve(initial, reservation)
  assert.equal(reserved.accountedBytes, reservation.totalBytes)

  const consumedA = consume(reserved, reservation, OPERATION_A)
  const releasedA = await commitRelease(
    consumedA,
    reservation,
    terminalRecord('a'),
    decodedScopeState(),
  )
  assert.equal(releasedA.reservations.length, 1)
  assert.equal(releasedA.reservations[0]?.sharedBytes, reservation.sharedBytes)
  assert.equal(releasedA.accountedBytes, reservation.sharedBytes + reservation.operations[1]!.bytes)

  const consumedB = consume(releasedA, reservation, OPERATION_B)
  const releasedB = await commitRelease(
    consumedB,
    reservation,
    terminalRecord('b'),
    decodedScopeState(),
  )
  assert.equal(releasedB.accountedBytes, 0)
  assert.deepEqual(releasedB.reservations, [])
})

test('commits release classification and accounting in one adapter transaction', async () => {
  const reservation = reservationPlan()
  let committed = reserve(accountingState(), reservation)
  let observedQuery: unknown
  const store: DurableStorageReleaseStore = {
    async commitRelease(query, apply) {
      observedQuery = query
      assert.equal(Object.isFrozen(query), true)
      assert.throws(() => {
        ;(query as unknown as { scopeId: string }).scopeId = walletScope('f'.repeat(64)).scopeId
      }, /read only|object is not extensible|Cannot assign/)
      const result = apply({
        accounting: committed,
        custodyRecord: abortedRecord('a'),
        scopeState: null,
      })
      committed = result.nextAccounting
      return result
    },
  }
  const result = await releaseCommittedDurableStorageOperation({
    store,
    expectedAccountingRevision: committed.revision,
    scopeId: SCOPE.scopeId,
    reservationId: reservation.reservationId,
    semanticOperationId: OPERATION_A,
  })
  assert.equal(result.nextAccounting.revision, 2)
  assert.deepEqual(observedQuery, {
    recordId: 'durable-storage-origin-accounting',
    expectedAccountingRevision: 1,
    scopeId: SCOPE.scopeId,
    reservationId: reservation.reservationId,
    semanticOperationId: OPERATION_A,
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.nextAccounting), true)
  assert.equal(result.releaseDisposition, 'safe-abort')
  assert.deepEqual(
    result.artifactActions,
    reservationOperationArtifactsForTest(reservation.operations[0]!).map((artifact) => ({
      artifactId: artifact.artifactId,
      artifactRole: artifact.artifactRole,
      action: retainedTestArtifactRole(artifact.artifactRole) ? 'retain' : 'delete',
    })),
  )
  assert.equal(committed.reservations[0]!.operations.length, 1)
})

test('last-operation release deletes owned rows and retains shared or proof post-images', async () => {
  const budget = budgetInput()
  budget.operations = [budget.operations[0]!]
  const reservation = createDurableStorageReservationPlan({
    reservationId: 'storage-reservation-final-actions',
    budget: calculateDurableSwapStorageBudget(budget),
  })
  const consumed = consume(reserve(accountingState(), reservation), reservation, OPERATION_A)
  const result = await releaseCommittedDurableStorageOperation({
    store: {
      async commitRelease(_query, apply) {
        return apply({
          accounting: consumed,
          custodyRecord: terminalRecord('a'),
          scopeState: decodedScopeState(),
        })
      },
    },
    expectedAccountingRevision: consumed.revision,
    scopeId: reservation.scopeId,
    reservationId: reservation.reservationId,
    semanticOperationId: OPERATION_A,
  })
  assert.equal(result.releaseDisposition, 'terminal-purge')
  assert.deepEqual(result.artifactActions, [
    ...reservationOperationArtifactsForTest(reservation.operations[0]!).map((artifact) => ({
      artifactId: artifact.artifactId,
      artifactRole: artifact.artifactRole,
      action: retainedTestArtifactRole(artifact.artifactRole) ? 'retain' : 'delete',
    })),
    { artifactId: 'session', artifactRole: 'trade-session', action: 'delete' },
  ])
})

test('committed release rejects missing, repeated, cloned, late, and failed adapter callbacks', async () => {
  const reservation = reservationPlan()
  const accounting = reserve(accountingState(), reservation)
  const rows = {
    accounting,
    custodyRecord: abortedRecord('a'),
    scopeState: null,
  }
  const input = {
    expectedAccountingRevision: accounting.revision,
    scopeId: SCOPE.scopeId,
    reservationId: reservation.reservationId,
    semanticOperationId: OPERATION_A,
  }

  await assert.rejects(
    () =>
      releaseCommittedDurableStorageOperation({
        ...input,
        store: {
          async commitRelease() {
            return {} as never
          },
        },
      }),
    /result is invalid/,
  )
  await assert.rejects(
    () =>
      releaseCommittedDurableStorageOperation({
        ...input,
        store: {
          async commitRelease(_query, apply) {
            const result = apply(rows)
            assert.throws(() => apply(rows), /callback is invalid/)
            return result
          },
        },
      }),
    /result is invalid/,
  )
  await assert.rejects(
    () =>
      releaseCommittedDurableStorageOperation({
        ...input,
        store: {
          async commitRelease(_query, apply) {
            return structuredClone(apply(rows))
          },
        },
      }),
    /result is invalid/,
  )

  const asynchronouslyRead = await releaseCommittedDurableStorageOperation({
    ...input,
    store: {
      async commitRelease(_query, apply) {
        await Promise.resolve()
        return apply(rows)
      },
    },
  })
  assert.equal(asynchronouslyRead.nextAccounting.revision, accounting.revision + 1)

  let late: Parameters<DurableStorageReleaseStore['commitRelease']>[1] | undefined
  await assert.rejects(
    () =>
      releaseCommittedDurableStorageOperation({
        ...input,
        store: {
          async commitRelease(_query, apply) {
            late = apply
            return {} as never
          },
        },
      }),
    /result is invalid/,
  )
  assert.throws(() => late!(rows), /callback is invalid/)

  await assert.rejects(
    () =>
      releaseCommittedDurableStorageOperation({
        ...input,
        store: {
          async commitRelease(_query, apply) {
            apply(rows)
            throw new Error('adapter rollback')
          },
        },
      }),
    /adapter rollback/,
  )
})

test('adapter query mutation cannot substitute foreign committed rows', async () => {
  const reservation = reservationPlan()
  const accounting = reserve(accountingState(), reservation)
  const foreignScope = walletScope('f'.repeat(64))
  const foreignRecord = abortedRecord('a', foreignScope)
  const foreignReservation = createDurableStorageReservationPlan({
    reservationId: reservation.reservationId,
    budget: calculateDurableSwapStorageBudget({
      schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
      scopeId: foreignScope.scopeId,
      swapId: reservation.swapId,
      session: artifact('foreign:session', 1, 'trade-session'),
      operations: [operationBudget(foreignRecord.operation.operationId, 1, 'foreign:operation')],
    }),
  })
  const foreignAccounting = reserve(accountingState(), foreignReservation)
  await assert.rejects(
    () =>
      releaseCommittedDurableStorageOperation({
        store: {
          async commitRelease(query, apply) {
            const mutations: Array<[keyof typeof query, unknown]> = [
              ['recordId', 'foreign-accounting'],
              ['expectedAccountingRevision', foreignAccounting.revision],
              ['scopeId', foreignScope.scopeId],
              ['reservationId', foreignReservation.reservationId],
              ['semanticOperationId', foreignRecord.operation.operationId],
            ]
            for (const [field, value] of mutations) {
              assert.equal(Reflect.set(query, field, value), false)
            }
            return apply({
              accounting: foreignAccounting,
              custodyRecord: foreignRecord,
              scopeState: null,
            })
          },
        },
        expectedAccountingRevision: accounting.revision,
        scopeId: reservation.scopeId,
        reservationId: reservation.reservationId,
        semanticOperationId: OPERATION_A,
      }),
    /storage reservation is missing|custody operation id is invalid|semantic operation reservation is missing/,
  )
})

test('capacity equality admits exactly the reservation plus emergency headroom', () => {
  const reservation = reservationPlan()
  const exact = accountingState(
    reservation.totalBytes + DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
  )
  assert.equal(reserve(exact, reservation).accountedBytes, reservation.totalBytes)
  const short = accountingState(
    reservation.totalBytes + DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES - 1,
  )
  assert.throws(() => reserve(short, reservation), /capacity is insufficient/)
})

test('reserves a same-scope multi-fill batch atomically in one origin-global revision', () => {
  const first = reservationPlan('storage-reservation-001', 'trade-001')
  const second = reservationPlan('storage-reservation-002', 'trade-002', 'fill-2')
  const initial = accountingState(
    first.totalBytes + second.totalBytes + DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
  )
  const reserved = reserveBatch(initial, [first, second])
  assert.equal(reserved.recordId, 'durable-storage-origin-accounting')
  assert.equal(reserved.isBrowserQuotaGuarantee, false)
  assert.equal(reserved.revision, initial.revision + 1)
  assert.equal(reserved.reservations.length, 2)
  assert.equal(reserved.accountedBytes, first.totalBytes + second.totalBytes)

  const foreign = reservationPlan(
    'storage-reservation-foreign',
    'trade-foreign',
    'foreign',
    walletScope('f'.repeat(64)),
  )
  assert.throws(() => reserveBatch(initial, [first, foreign]), /batch scope is foreign/)
  assert.deepEqual(initial.reservations, [])
})

test('advances one truthful pre-trade intent into a session and exact custody reservation', () => {
  const profile = preTradeCapacityProfile()
  const intent = artifact('swap-intent:trade-001', 100, 'trade-intent')
  const retainedOrder = artifact('pending-trades:order-001', 80, 'transaction-only-retained')
  const preTrade = createDurablePreTradeStorageReservationPlan({
    scopeId: SCOPE.scopeId,
    reservationId: 'storage-reservation-pre-trade',
    swapId: 'trade-001',
    orderId: 'order-001',
    marketId: 'condition-001-yes',
    deadlineMs: 10_000,
    intent,
    capacityProfile: profile,
  })
  const batch = createDurablePreTradeStorageAdmissionBatchPlan({
    batchId: 'pre-trade-batch-001',
    reservations: [preTrade],
    transactionOnlyArtifacts: [retainedOrder],
  })
  const prepared = applyDurablePreTradeStorageAdmissionBatch({
    state: accountingState(),
    batch,
    artifacts: [intent, retainedOrder],
  })
  assert.equal(prepared.preTradeReservations[0]!.stage, 'pubkey-prepared')
  assert.equal(prepared.accountedBytes, profile.totalBytes)
  const replayedPrepared = applyDurablePreTradeStorageAdmissionBatch({
    state: prepared,
    batch,
    artifacts: [intent, retainedOrder],
  })
  assert.equal(replayedPrepared.revision, prepared.revision)

  const activeInput = reservationBudgetInput('trade-001', 'default', SCOPE, 'pre-trade')
  const attemptedIntent = artifact('swap-intent:trade-001', 120, 'trade-intent')
  const attempted = advanceDurablePreTradePubkeyAttempt({
    state: prepared,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    previousIntent: intent,
    nextIntent: attemptedIntent,
  })
  assert.equal(attempted.preTradeReservations[0]!.stage, 'pubkey-attempted')
  assert.equal(attempted.accountedBytes, profile.totalBytes)
  const exactRetry = advanceDurablePreTradePubkeyAttempt({
    state: attempted,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    previousIntent: attemptedIntent,
    nextIntent: attemptedIntent,
  })
  assert.equal(exactRetry.revision, attempted.revision)

  const sessionBound = promoteDurablePreTradeSession({
    state: attempted,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    previousIntent: attemptedIntent,
    session: activeInput.session,
  })
  assert.equal(sessionBound.preTradeReservations[0]!.stage, 'session-bound')
  assert.equal(sessionBound.preTradeReservations[0]!.intent, null)
  const replayedPromotion = promoteDurablePreTradeSession({
    state: sessionBound,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    previousIntent: null,
    session: activeInput.session,
  })
  assert.equal(replayedPromotion.revision, sessionBound.revision)

  const advancedSessionArtifact = artifact(
    activeInput.session.artifactId,
    499,
    'trade-session',
  )
  const advancedSession = advanceDurablePreTradeSession({
    state: sessionBound,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    previousSession: activeInput.session,
    nextSession: advancedSessionArtifact,
  })
  assert.equal(advancedSession.revision, sessionBound.revision + 1)
  const replayedAdvance = advanceDurablePreTradeSession({
    state: advancedSession,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    previousSession: advancedSessionArtifact,
    nextSession: advancedSessionArtifact,
  })
  assert.equal(replayedAdvance.revision, advancedSession.revision)
  activeInput.session = advancedSessionArtifact

  const active = createDurableStorageReservationPlan({
    reservationId: preTrade.reservationId,
    budget: calculateDurableSwapStorageBudget(activeInput),
  })
  const custodyScope = artifact(
    'custody-scope:wallet-primary',
    80,
    'transaction-only-retained',
  )
  const artifactPlan = createDurableStorageReservationArtifactPlan({
    reservation: active,
    transactionOnlyArtifacts: [custodyScope],
  })
  const bound = bindDurablePreTradeStorageReservation({
    state: advancedSession,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    artifactPlan,
    artifacts: [...plannedArtifacts(activeInput), custodyScope],
  })
  assert.equal(bound.preTradeReservations.length, 0)
  assert.equal(bound.reservations.length, 1)
  assert.equal(bound.reservations[0]!.capacityRetention, 'retain-until-terminal')
  assert.equal(bound.reservations[0]!.capacityProfile?.profileId, profile.profileId)
  assert.equal(bound.reservations[0]!.reservedBytes, profile.totalBytes)
  assert.equal(bound.accountedBytes, profile.totalBytes)
  const replayedBinding = bindDurablePreTradeStorageReservation({
    state: bound,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    artifactPlan,
    artifacts: [...plannedArtifacts(activeInput), custodyScope],
  })
  assert.equal(replayedBinding.revision, bound.revision)
})

test('advances bound artifacts by exact CAS while retaining fixed capacity', () => {
  const profile = preTradeCapacityProfile()
  const intent = artifact('swap-intent:trade-advance', 100, 'trade-intent')
  const preTrade = createDurablePreTradeStorageReservationPlan({
    scopeId: SCOPE.scopeId,
    reservationId: 'storage-reservation-advance',
    swapId: 'trade-advance',
    orderId: 'order-advance',
    marketId: 'condition-001-yes',
    deadlineMs: 10_000,
    intent,
    capacityProfile: profile,
  })
  const prepared = applyDurablePreTradeStorageAdmissionBatch({
    state: accountingState(),
    batch: createDurablePreTradeStorageAdmissionBatchPlan({
      batchId: 'pre-trade-batch-advance',
      reservations: [preTrade],
      transactionOnlyArtifacts: [],
    }),
    artifacts: [intent],
  })
  const initialInput = reservationBudgetInput('trade-advance', 'advance')
  const sessionBound = promoteDurablePreTradeSession({
    state: prepared,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    previousIntent: intent,
    session: initialInput.session,
  })
  const initialReservation = createDurableStorageReservationPlan({
    reservationId: preTrade.reservationId,
    budget: calculateDurableSwapStorageBudget(initialInput),
  })
  const custodyScope = artifact(
    'custody-scope:wallet-advance',
    80,
    'transaction-only-retained',
  )
  const initialArtifactPlan = createDurableStorageReservationArtifactPlan({
    reservation: initialReservation,
    transactionOnlyArtifacts: [custodyScope],
  })
  const bound = bindDurablePreTradeStorageReservation({
    state: sessionBound,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    artifactPlan: initialArtifactPlan,
    artifacts: [...plannedArtifacts(initialInput), custodyScope],
  })
  const nextInput = reservationBudgetInput('trade-advance', 'advance')
  nextInput.session = artifact('advance:session', 499, 'trade-session')
  nextInput.operations[0]!.exactOperation = artifact(
    'advance:operation-a:exact-operation',
    899,
    'exact-operation',
  )
  const nextReservation = createDurableStorageReservationPlan({
    reservationId: preTrade.reservationId,
    budget: calculateDurableSwapStorageBudget(nextInput),
  })
  const nextArtifactPlan = createDurableStorageReservationArtifactPlan({
    reservation: nextReservation,
    transactionOnlyArtifacts: [custodyScope],
  })
  const advanced = advanceDurableStorageReservationArtifacts({
    state: bound,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    previousArtifacts: plannedArtifacts(initialInput),
    nextArtifactPlan,
    nextArtifacts: [...plannedArtifacts(nextInput), custodyScope],
  })
  assert.equal(advanced.revision, bound.revision + 1)
  assert.equal(advanced.accountedBytes, profile.totalBytes)
  assert.equal(advanced.reservations[0]!.reservedBytes, profile.totalBytes)
  assert.equal(advanced.reservations[0]!.sharedBytes, 499)

  const replayed = advanceDurableStorageReservationArtifacts({
    state: advanced,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    previousArtifacts: plannedArtifacts(nextInput),
    nextArtifactPlan,
    nextArtifacts: [...plannedArtifacts(nextInput), custodyScope],
  })
  assert.equal(replayed.revision, advanced.revision)

  const omittedOperationInput = {
    ...nextInput,
    operations: [nextInput.operations[0]!],
  }
  const omittedOperationReservation = createDurableStorageReservationPlan({
    reservationId: preTrade.reservationId,
    budget: calculateDurableSwapStorageBudget(omittedOperationInput),
  })
  const omittedOperationPlan = createDurableStorageReservationArtifactPlan({
    reservation: omittedOperationReservation,
    transactionOnlyArtifacts: [custodyScope],
  })
  assert.throws(
    () =>
      advanceDurableStorageReservationArtifacts({
        state: advanced,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousArtifacts: plannedArtifacts(nextInput),
        nextArtifactPlan: omittedOperationPlan,
        nextArtifacts: [...plannedArtifacts(omittedOperationInput), custodyScope],
      }),
    /omits an active operation/,
  )
  const oversizedInput = reservationBudgetInput('trade-advance', 'advance')
  oversizedInput.operations[0]!.ciphers[0] = artifact(
    'advance:operation-a:cipher:0',
    65,
    'cipher',
  )
  const oversizedReservation = createDurableStorageReservationPlan({
    reservationId: preTrade.reservationId,
    budget: calculateDurableSwapStorageBudget(oversizedInput),
  })
  const oversizedPlan = createDurableStorageReservationArtifactPlan({
    reservation: oversizedReservation,
    transactionOnlyArtifacts: [custodyScope],
  })
  assert.throws(
    () =>
      advanceDurableStorageReservationArtifacts({
        state: advanced,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousArtifacts: plannedArtifacts(nextInput),
        nextArtifactPlan: oversizedPlan,
        nextArtifacts: [...plannedArtifacts(oversizedInput), custodyScope],
      }),
    /ciphers exceeds the reserved capacity/,
  )
  assert.throws(
    () =>
      advanceDurableStorageReservationArtifacts({
        state: advanced,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousArtifacts: plannedArtifacts(initialInput),
        nextArtifactPlan,
        nextArtifacts: [...plannedArtifacts(nextInput), custodyScope],
      }),
    /do not match the committed plan/,
  )
  const foreign = createDurableStorageReservationPlan({
    reservationId: preTrade.reservationId,
    budget: calculateDurableSwapStorageBudget(
      reservationBudgetInput('trade-foreign', 'advance'),
    ),
  })
  const foreignPlan = createDurableStorageReservationArtifactPlan({
    reservation: foreign,
    transactionOnlyArtifacts: [custodyScope],
  })
  assert.throws(
    () =>
      advanceDurableStorageReservationArtifacts({
        state: advanced,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousArtifacts: plannedArtifacts(nextInput),
        nextArtifactPlan: foreignPlan,
        nextArtifacts: [
          ...plannedArtifacts(reservationBudgetInput('trade-foreign', 'advance')),
          custodyScope,
        ],
      }),
    /identity is foreign/,
  )
  assert.throws(
    () =>
      advanceDurableStorageReservationArtifacts({
        state: advanced,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousArtifacts: plannedArtifacts(nextInput),
        nextArtifactPlan,
        nextArtifacts: plannedArtifacts(nextInput),
      }),
    /do not match the committed plan/,
  )
  assert.throws(
    () =>
      advanceDurableStorageReservationArtifacts({
        state: advanced,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousArtifacts: plannedArtifacts(nextInput),
        nextArtifactPlan: structuredClone(nextArtifactPlan),
        nextArtifacts: [...plannedArtifacts(nextInput), custodyScope],
      }),
    /not SDK-issued/,
  )
})

test('pre-trade transitions reject mutation, substitution, foreign identity, and capacity overflow', () => {
  const profile = preTradeCapacityProfile()
  const intent = artifact('swap-intent:trade-001', 100, 'trade-intent')
  const preTrade = createDurablePreTradeStorageReservationPlan({
    scopeId: SCOPE.scopeId,
    reservationId: 'storage-reservation-pre-trade',
    swapId: 'trade-001',
    orderId: 'order-001',
    marketId: 'condition-001-yes',
    deadlineMs: 10_000,
    intent,
    capacityProfile: profile,
  })
  const batch = createDurablePreTradeStorageAdmissionBatchPlan({
    batchId: 'pre-trade-batch-001',
    reservations: [preTrade],
    transactionOnlyArtifacts: [],
  })
  const prepared = applyDurablePreTradeStorageAdmissionBatch({
    state: accountingState(),
    batch,
    artifacts: [intent],
  })
  assert.throws(
    () =>
      advanceDurablePreTradePubkeyAttempt({
        state: prepared,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousIntent: artifact('swap-intent:trade-001', 99, 'trade-intent'),
        nextIntent: intent,
      }),
    /do not match the committed plan/,
  )
  assert.throws(
    () =>
      advanceDurablePreTradePubkeyAttempt({
        state: prepared,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousIntent: intent,
        nextIntent: artifact('swap-intent:foreign', 100, 'trade-intent'),
      }),
    /identity changed/,
  )
  assert.throws(
    () =>
      advanceDurablePreTradePubkeyAttempt({
        state: prepared,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousIntent: intent,
        nextIntent: artifact(
          'swap-intent:trade-001',
          profile.tradeIntent.bytes + 1,
          'trade-intent',
        ),
      }),
    /exceeds the reserved capacity/,
  )
  const session = artifact('swap-session:trade-001', 100, 'trade-session')
  const sessionBound = promoteDurablePreTradeSession({
    state: prepared,
    scopeId: SCOPE.scopeId,
    reservationId: preTrade.reservationId,
    previousIntent: intent,
    session,
  })
  assert.throws(
    () =>
      advanceDurablePreTradeSession({
        state: prepared,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousSession: session,
        nextSession: session,
      }),
    /not session-bound/,
  )
  assert.throws(
    () =>
      advanceDurablePreTradeSession({
        state: sessionBound,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousSession: artifact('swap-session:trade-001', 99, 'trade-session'),
        nextSession: session,
      }),
    /do not match the committed plan/,
  )
  assert.throws(
    () =>
      advanceDurablePreTradeSession({
        state: sessionBound,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousSession: session,
        nextSession: artifact('swap-session:foreign', 100, 'trade-session'),
      }),
    /identity changed/,
  )
  assert.throws(
    () =>
      advanceDurablePreTradeSession({
        state: sessionBound,
        scopeId: SCOPE.scopeId,
        reservationId: preTrade.reservationId,
        previousSession: session,
        nextSession: artifact(
          'swap-session:trade-001',
          profile.session.bytes + 1,
          'trade-session',
        ),
      }),
    /exceeds the reserved capacity/,
  )
  assert.throws(
    () =>
      createDurablePreTradeStorageAdmissionBatchPlan({
        batchId: 'pre-trade-batch-clone',
        reservations: [structuredClone(preTrade)],
        transactionOnlyArtifacts: [],
      }),
    /not SDK-issued/,
  )
})

test('prepared and attempted intents release only after SDK classification of the exact failed fill', () => {
  const profile = preTradeCapacityProfile()
  const intent = artifact('swap-intent:terminal', 100, 'trade-intent')
  const reservation = createDurablePreTradeStorageReservationPlan({
    scopeId: SCOPE.scopeId,
    reservationId: 'storage-reservation-terminal',
    swapId: 'trade-terminal',
    orderId: 'order-terminal',
    marketId: 'condition-001-yes',
    deadlineMs: 10_000,
    intent,
    capacityProfile: profile,
  })
  const batch = createDurablePreTradeStorageAdmissionBatchPlan({
    batchId: 'pre-trade-batch-terminal',
    reservations: [reservation],
    transactionOnlyArtifacts: [],
  })
  const prepared = applyDurablePreTradeStorageAdmissionBatch({
    state: accountingState(),
    batch,
    artifacts: [intent],
  })
  const liveFillArtifact = terminalOrderStatusArtifact(reservation, {
    orderStatus: 'cancelled',
    fillStatus: 'Matched',
  })
  assert.throws(
    () =>
      classifyDurablePreTradeTerminalEvidence({
        state: prepared,
        scopeId: reservation.scopeId,
        reservationId: reservation.reservationId,
        evidenceArtifact: liveFillArtifact,
      }),
    /fill is not failed/,
  )
  const foreignArtifact = terminalOrderStatusArtifact(reservation, {
    orderId: 'order-foreign',
  })
  assert.throws(
    () =>
      classifyDurablePreTradeTerminalEvidence({
        state: prepared,
        scopeId: reservation.scopeId,
        reservationId: reservation.reservationId,
        evidenceArtifact: foreignArtifact,
      }),
    /identity is foreign/,
  )
  const pendingArtifact = terminalOrderStatusArtifact(reservation, {
    pendingTradeId: reservation.swapId,
  })
  assert.throws(
    () =>
      classifyDurablePreTradeTerminalEvidence({
        state: prepared,
        scopeId: reservation.scopeId,
        reservationId: reservation.reservationId,
        evidenceArtifact: pendingArtifact,
      }),
    /still exposes a pending trade/,
  )
  const terminalArtifact = terminalOrderStatusArtifact(reservation)
  const evidence = classifyDurablePreTradeTerminalEvidence({
    state: prepared,
    scopeId: reservation.scopeId,
    reservationId: reservation.reservationId,
    evidenceArtifact: terminalArtifact,
  })
  assert.equal(evidence.terminalKind, 'trade-failed')
  assert.throws(
    () =>
      releaseTerminalDurablePreTradeIntent({
        state: prepared,
        scopeId: SCOPE.scopeId,
        reservationId: reservation.reservationId,
        currentIntent: intent,
        terminalEvidence: structuredClone(evidence),
        evidenceArtifact: terminalArtifact,
      }),
    /not SDK-issued/,
  )
  assert.throws(
    () =>
      releaseTerminalDurablePreTradeIntent({
        state: prepared,
        scopeId: SCOPE.scopeId,
        reservationId: reservation.reservationId,
        currentIntent: intent,
        terminalEvidence: evidence,
        evidenceArtifact: terminalOrderStatusArtifact(reservation, {
          fillStatus: 'Filled',
        }),
      }),
    /do not match the committed plan/,
  )
  const releasedPrepared = releaseTerminalDurablePreTradeIntent({
    state: prepared,
    scopeId: SCOPE.scopeId,
    reservationId: reservation.reservationId,
    currentIntent: intent,
    terminalEvidence: evidence,
    evidenceArtifact: terminalArtifact,
  })
  assert.equal(releasedPrepared.nextAccounting.preTradeReservations.length, 0)
  assert.equal(releasedPrepared.nextAccounting.accountedBytes, 0)
  assert.deepEqual(releasedPrepared.artifactAction, {
    artifactId: 'swap-intent:terminal',
    artifactRole: 'trade-intent',
    action: 'delete',
  })

  const attempted = advanceDurablePreTradePubkeyAttempt({
    state: prepared,
    scopeId: SCOPE.scopeId,
    reservationId: reservation.reservationId,
    previousIntent: intent,
    nextIntent: intent,
  })
  const releasedAttempted = releaseTerminalDurablePreTradeIntent({
    state: attempted,
    scopeId: SCOPE.scopeId,
    reservationId: reservation.reservationId,
    currentIntent: intent,
    terminalEvidence: evidence,
    evidenceArtifact: terminalArtifact,
  })
  assert.equal(releasedAttempted.nextAccounting.preTradeReservations.length, 0)
  assert.equal(releasedAttempted.nextAccounting.accountedBytes, 0)
})

test('admission batch verifies one exact retained post-image without charging or duplicating it', () => {
  const firstInput = reservationBudgetInput('trade-batch-1', 'batch-1')
  const secondInput = reservationBudgetInput('trade-batch-2', 'batch-2')
  const first = createDurableStorageReservationPlan({
    reservationId: 'reservation-batch-1',
    budget: calculateDurableSwapStorageBudget(firstInput),
  })
  const second = createDurableStorageReservationPlan({
    reservationId: 'reservation-batch-2',
    budget: calculateDurableSwapStorageBudget(secondInput),
  })
  const scopeState = artifact('dexie:scope-state', 64, 'transaction-only-retained')
  const batch = createDurableStorageAdmissionBatchPlan({
    batchId: 'admission-batch-001',
    reservations: [first, second],
    transactionOnlyArtifacts: [scopeState],
  })
  const next = applyDurableStorageAdmissionBatch({
    state: accountingState(),
    batch,
    artifacts: [...plannedArtifacts(firstInput), ...plannedArtifacts(secondInput), scopeState],
  })
  assert.equal(next.revision, 1)
  assert.equal(next.reservations.length, 2)
  assert.equal(next.accountedBytes, first.totalBytes + second.totalBytes)
  assert.equal(batch.totalBytes, first.totalBytes + second.totalBytes + scopeState.bytes.byteLength)
})

test('admission batch rejects omitted, substituted, wrong-role, cloned, and foreign rows', () => {
  const input = reservationBudgetInput('trade-batch-fault', 'batch-fault')
  const reservation = createDurableStorageReservationPlan({
    reservationId: 'reservation-batch-fault',
    budget: calculateDurableSwapStorageBudget(input),
  })
  const scopeState = artifact('dexie:scope-state', 64, 'transaction-only-retained')
  const batch = createDurableStorageAdmissionBatchPlan({
    batchId: 'admission-batch-fault',
    reservations: [reservation],
    transactionOnlyArtifacts: [scopeState],
  })
  const artifacts = [...plannedArtifacts(input), scopeState]
  assert.throws(
    () =>
      applyDurableStorageAdmissionBatch({
        state: accountingState(),
        batch,
        artifacts: artifacts.slice(0, -1),
      }),
    /do not match the committed plan/,
  )
  const substituted = structuredClone(artifacts)
  substituted.at(-1)!.bytes.fill(1)
  assert.throws(
    () =>
      applyDurableStorageAdmissionBatch({
        state: accountingState(),
        batch,
        artifacts: substituted,
      }),
    /do not match the committed plan/,
  )
  assert.throws(
    () =>
      createDurableStorageAdmissionBatchPlan({
        batchId: 'admission-batch-wrong-role',
        reservations: [reservation],
        transactionOnlyArtifacts: [artifact('dexie:scope-state-foreign', 64, 'operation-overhead')],
      }),
    /transaction-only artifact role is invalid/,
  )
  assert.throws(
    () =>
      applyDurableStorageAdmissionBatch({
        state: accountingState(),
        batch: structuredClone(batch),
        artifacts,
      }),
    /not SDK-issued/,
  )
  const foreign = reservationPlan(
    'reservation-batch-foreign',
    'trade-batch-foreign',
    'batch-foreign',
    walletScope('f'.repeat(64)),
  )
  assert.throws(
    () =>
      createDurableStorageAdmissionBatchPlan({
        batchId: 'admission-batch-foreign',
        reservations: [reservation, foreign],
        transactionOnlyArtifacts: [],
      }),
    /batch scope is foreign/,
  )
})

test('batch reservation rejects duplicate swap and artifact identities before accounting', () => {
  const first = reservationPlan('storage-reservation-001', 'trade-001')
  const duplicateSwap = reservationPlan('storage-reservation-002', 'trade-001', 'fill-2')
  assert.throws(
    () => reserveBatch(accountingState(), [first, duplicateSwap]),
    /swap id is duplicated/,
  )

  const duplicateArtifact = reservationPlan(
    'storage-reservation-002',
    'trade-002',
    'fill-2',
    SCOPE,
    'default',
  )
  assert.throws(
    () => reserveBatch(accountingState(), [first, duplicateArtifact]),
    /artifact id is duplicated/,
  )
})

test('batch reservation rejects cloned and self-consistently undercounted plans', () => {
  const forged = structuredClone(reservationPlan())
  forged.sharedBytes = 1
  for (const operation of forged.operations) operation.bytes = 1
  forged.totalBytes = forged.sharedBytes + forged.operations.length
  assert.throws(
    () => reserveBatch(accountingState(), [forged]),
    /storage reservation is not SDK-issued/,
  )
})

test('origin-global accounting accepts separate wallet reservations in separate batches', () => {
  const local = reservationPlan(
    'storage-reservation-shared',
    'trade-local',
    'shared-labels',
    SCOPE,
    'same-artifacts',
  )
  const foreign = reservationPlan(
    'storage-reservation-shared',
    'trade-foreign',
    'shared-labels',
    walletScope('f'.repeat(64)),
    'same-artifacts',
  )
  const first = reserve(accountingState(), local)
  const second = reserve(first, foreign)
  assert.deepEqual(
    second.reservations.map((reservation) => reservation.scopeId),
    [SCOPE.scopeId, foreign.scopeId],
  )
  const consumedLocal = consume(second, local, local.operations[0]!.semanticOperationId)
  assert.equal(consumedLocal.reservations[0]!.operations[0]!.state, 'consumed')
  assert.equal(consumedLocal.reservations[1]!.operations[0]!.state, 'reserved')
})

test('batch reservation rejects aggregate operation overflow and stale revisions', () => {
  const reservations = Array.from(
    { length: DURABLE_STORAGE_OPERATION_LIMIT_MAX / 2 + 1 },
    (_, index) => reservationPlan(`reservation-${index}`, `trade-${index}`, `limit-${index}`),
  )
  assert.throws(
    () => reserveBatch(accountingState(Number.MAX_SAFE_INTEGER), reservations),
    /active semantic operation count exceeds the limit/,
  )

  const state = accountingState()
  assert.throws(
    () =>
      reduceDurableStorageAccountingState(state, {
        kind: 'reserve-batch',
        expectedRevision: state.revision + 1,
        reservations: [reservationPlan()],
      }),
    /revision is stale/,
  )
})

test('persisted reservations reject omitted artifact identities', () => {
  const reservation = reservationPlan()
  const omitted = structuredClone(reservation)
  omitted.operations[0]!.transitionOverhead.artifacts.pop()
  const persisted = {
    ...accountingState(),
    accountedBytes: omitted.totalBytes,
    reservations: [omitted],
  }
  assert.throws(
    () => decodeDurableStorageAccountingState(persisted),
    /transition overhead count is inconsistent/,
  )

  const oversized = structuredClone(reservation)
  oversized.operations[0]!.transitionOverhead.artifacts = Array(
    DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX + 1,
  ).fill(oversized.operations[0]!.transitionOverhead.artifacts[0]!)
  assert.throws(
    () =>
      decodeDurableStorageAccountingState({
        ...accountingState(),
        accountedBytes: oversized.totalBytes,
        reservations: [oversized],
      }),
    /transition overhead artifacts count exceeds the limit/,
  )
})

test('persisted component roles cannot turn proof post-images into deletion authority', () => {
  const reservation = reservationPlan()
  const corrupted = structuredClone(reservation)
  corrupted.operations[0]!.proofReferences.artifacts[0]!.artifactRole = 'operation-overhead'
  assert.throws(
    () =>
      decodeDurableStorageAccountingState({
        ...accountingState(),
        accountedBytes: corrupted.totalBytes,
        reservations: [corrupted],
      }),
    /proof references artifact role is invalid/,
  )
})

test('committed release accepts only exact custody state and terminal drain authority', async () => {
  const reservation = reservationPlan()
  const reserved = reserve(accountingState(), reservation)
  assert.equal(
    (await commitRelease(reserved, reservation, abortedRecord('a'), null)).reservations[0]!
      .operations.length,
    1,
  )
  await assert.rejects(
    () => commitRelease(reserved, reservation, custodyRecord('a'), null),
    /custody is not releasable/,
  )
  await assert.rejects(
    () => commitRelease(reserved, reservation, terminalRecord('a'), null),
    /scope state is required/,
  )
  await assert.rejects(
    () => commitRelease(reserved, reservation, reconciledRecord('a'), decodedScopeState()),
    /terminal custody must be retained/,
  )
  await assert.rejects(
    () =>
      commitRelease(
        reserved,
        reservation,
        terminalRecord('a'),
        decodedScopeState({ scope: walletScope('f'.repeat(64)) }),
      ),
    /foreign custody scope/,
  )
  const consumed = consume(reserved, reservation, OPERATION_A)
  assert.equal(
    (await commitRelease(consumed, reservation, terminalRecord('a'), decodedScopeState()))
      .reservations[0]!.operations.length,
    1,
  )
})

test('corrupted aborted custody cannot authorize storage release', async () => {
  const corruptions: Array<(record: DurableCustodyRecord) => void> = [
    (record) => {
      tradeBinding(record).hasDependentOperation = true
    },
    (record) => {
      record.operation.delivery = {
        deliveryKind: 'outbox',
        deliveryId: 'delivery-corrupt',
        payloadHandle: 'payload-corrupt',
        payloadFingerprint: FINGERPRINT_A,
        expiresAtMs: 5_000,
        state: 'pending',
      }
    },
    (record) => {
      record.operation.result = {
        state: 'verified-staged',
        resultHandle: 'result-corrupt',
        resultFingerprint: FINGERPRINT_A,
        outputPlanFingerprint: FINGERPRINT_B,
      }
    },
    (record) => {
      record.operation.retry = {
        attempt: 1,
        nextAttemptAtMs: 2_000,
        reason: 'rate-limited',
      }
    },
    (record) => {
      record.terminalTombstone = {
        tombstoneId: 'tombstone-corrupt',
        tradeId: tradeBinding(record).tradeId,
        authenticatedTerminalStatus: true,
        replayCutoffObserved: true,
      }
    },
  ]
  const reservation = reservationPlan()
  const reserved = reserve(accountingState(), reservation)
  for (const corrupt of corruptions) {
    const record = structuredClone(abortedRecord('a'))
    corrupt(record)
    await assert.rejects(
      () => commitRelease(reserved, reservation, record, null),
      /aborted operation|terminal tombstone lifecycle/,
    )
  }
})

test('persisted accounting rejects malformed scope and duplicate reservation or operation ids', () => {
  const reservation = reservationPlan()
  const state = reserve(accountingState(), reservation)
  const foreign = structuredClone(state)
  foreign.reservations[0]!.scopeId = walletScope('f'.repeat(64)).scopeId
  assert.throws(
    () => decodeDurableStorageAccountingState(foreign),
    /custody operation id is invalid/,
  )

  const duplicateReservation = structuredClone(state)
  duplicateReservation.reservations.push(structuredClone(duplicateReservation.reservations[0]!))
  duplicateReservation.accountedBytes *= 2
  assert.throws(
    () => decodeDurableStorageAccountingState(duplicateReservation),
    /reservation id is duplicated/,
  )

  const duplicateOperation = structuredClone(state)
  duplicateOperation.reservations[0]!.operations[1]!.semanticOperationId = OPERATION_A
  assert.throws(
    () => decodeDurableStorageAccountingState(duplicateOperation),
    /semantic operation id is duplicated/,
  )
})

test('persisted accounting requires current schema and own known fields', () => {
  const state = accountingState()
  assert.throws(
    () => decodeDurableStorageAccountingState({ ...state, schemaVersion: 1 }),
    /unsupported durable storage accounting schema version/,
  )
  assert.throws(
    () => decodeDurableStorageAccountingState({ ...state, futureField: true }),
    /unknown field 'futureField'/,
  )

  const inheritedRevision = Object.assign(Object.create({ revision: state.revision }), state)
  delete inheritedRevision.revision
  assert.throws(
    () => decodeDurableStorageAccountingState(inheritedRevision),
    /missing required field 'revision'/,
  )
})

test('persisted and reducer inputs reject positive artifact counts with zero bytes', () => {
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        session: artifact('empty-session', 0, 'trade-session'),
      }),
    /binary storage artifact exceeds the byte limit/,
  )

  const reservation = reservationPlan()
  const undercounted = structuredClone(reservation)
  undercounted.operations[0]!.bytes = 0
  undercounted.totalBytes -= reservation.operations[0]!.bytes
  assert.throws(
    () =>
      decodeDurableStorageAccountingState({
        ...accountingState(),
        accountedBytes: undercounted.totalBytes,
        reservations: [undercounted],
      }),
    /storage reservation operation totals are inconsistent/,
  )

  const oversized = structuredClone(reservation)
  oversized.operations[0]!.artifactCount = DURABLE_STORAGE_OPERATION_ARTIFACT_LIMIT_MAX + 1
  oversized.totalArtifactCount =
    oversized.sharedArtifactCount +
    oversized.operations.reduce((total, operation) => total + operation.artifactCount, 0)
  assert.throws(
    () =>
      decodeDurableStorageAccountingState({
        ...accountingState(),
        accountedBytes: oversized.totalBytes,
        reservations: [oversized],
      }),
    /storage reservation operation totals are inconsistent/,
  )
})

test('preflights artifact sizes and collection counts before hashing or decoding', () => {
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        operations: Array(DURABLE_STORAGE_OPERATION_LIMIT_MAX + 1).fill(
          budgetInput().operations[0]!,
        ),
      }),
    /operation.*count exceeds the limit/,
  )
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        session: artifact(
          'oversized-binary',
          DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX + 1,
          'trade-session',
        ),
      }),
    /binary storage artifact exceeds the byte limit/,
  )
  assert.throws(
    () =>
      createDurableStorageJsonArtifact({
        artifactId: 'oversized-json',
        artifactRole: 'trade-session',
        value: 'x'.repeat(DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX + 1),
      }),
    /JSON storage artifact exceeds the byte limit/,
  )
})

test('aggregate limits stop operation decoding before a later sentinel is inspected', () => {
  let sentinelInspected = false
  const sentinel = {
    get semanticOperationId(): string {
      sentinelInspected = true
      throw new Error('sentinel operation was inspected')
    },
  }
  const operations = Array.from({ length: 4 }, (_, index) => maximumArtifactOperation(index))
  assert.equal(1 + operations.length * DURABLE_STORAGE_OPERATION_ARTIFACT_LIMIT_MAX, 4_101)
  assert.equal(DURABLE_STORAGE_SWAP_ARTIFACT_LIMIT_MAX, 4_096)
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        operations: [...operations, sentinel as never],
      }),
    /storage artifact count exceeds the limit/,
  )
  assert.equal(sentinelInspected, false)
})

test('component byte limits stop hashing before a later artifact is inspected', () => {
  let sentinelInspected = false
  const sentinel = {
    get artifactId(): string {
      sentinelInspected = true
      throw new Error('sentinel artifact was inspected')
    },
  }
  const chunkBytes = Math.floor(DURABLE_STORAGE_COMPONENT_BYTES_LIMIT_MAX * 0.6)
  const operation = operationBudget(OPERATION_A, 1)
  operation.privateMaterial = [
    artifact('large-private-a', chunkBytes, 'private-material'),
    artifact('large-private-b', chunkBytes, 'private-material'),
    sentinel as never,
  ]

  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        operations: [operation],
      }),
    /private material bytes exceed the limit/,
  )
  assert.equal(sentinelInspected, false)
})

test('planned artifact decoding is strict and JSON encodings are canonical', () => {
  const withSession = (session: unknown) =>
    calculateDurableSwapStorageBudget({
      ...budgetInput(),
      session: session as ReturnType<typeof artifact>,
    })
  assert.throws(
    () =>
      withSession({
        artifactId: 'unknown',
        encoding: 'text',
        artifactRole: 'trade-session',
        bytes: new Uint8Array([1]),
      }),
    /encoding is invalid/,
  )
  assert.throws(
    () =>
      withSession({
        artifactId: 'missing',
        encoding: 'binary',
        artifactRole: 'trade-session',
      }),
    /missing required field 'bytes'/,
  )
  assert.throws(
    () =>
      withSession({
        artifactId: 'extra',
        encoding: 'binary',
        artifactRole: 'trade-session',
        bytes: new Uint8Array([1]),
        extra: true,
      }),
    /unknown field 'extra'/,
  )
  assert.throws(
    () =>
      withSession({
        artifactId: 'json',
        encoding: 'json-utf8',
        artifactRole: 'trade-session',
        encodedJson: '{ "a": 1 }',
      }),
    /not canonical/,
  )
})

test('enforces artifact lifecycles before unsafe adapter deletion is possible', () => {
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        session: artifact('unsafe-session', 1, 'exact-operation'),
      }),
    /session artifact role is invalid/,
  )
  assert.throws(
    () =>
      calculateDurableSwapStorageBudget({
        ...budgetInput(),
        operations: [
          {
            ...budgetInput().operations[0]!,
            proofReferences: [artifact('unsafe-proof-row', 1, 'operation-overhead')],
          },
        ],
      }),
    /proof references artifact role is invalid/,
  )
})

test('proof-operation pins release only with the same committed custody row', async () => {
  const reservation = reservationPlan()
  let state = reserve(accountingState(), reservation)
  state = addPin(state, 0, FINGERPRINT_A, 'pin-0', OPERATION_A)
  assert.throws(
    () => addPin(state, 1, FINGERPRINT_A, 'pin-duplicate-proof', OPERATION_A),
    /proof already has an active storage pin/,
  )
  const foreignScope = walletScope('f'.repeat(64))
  const crossScopePins = reduceDurableStorageAccountingState(state, {
    kind: 'add-pin-reference',
    expectedRevision: state.revision,
    pin: {
      scopeId: foreignScope.scopeId,
      pinId: 'pin-0',
      proofId: '22'.repeat(32),
      reason: 'open-order-collateral',
      referenceId: 'foreign-order-001',
    },
  })
  assert.equal(crossScopePins.pinReferences.length, 2)
  assert.throws(
    () =>
      reduceDurableStorageAccountingState(state, {
        kind: 'add-pin-reference',
        expectedRevision: state.revision,
        pin: {
          scopeId: foreignScope.scopeId,
          pinId: 'foreign-pin-duplicate-proof',
          proofId: FINGERPRINT_A,
          reason: 'open-order-collateral',
          referenceId: 'foreign-order-001',
        },
      }),
    /proof already has an active storage pin/,
  )
  await assert.rejects(
    () => commitRelease(state, reservation, abortedRecord('b'), null, OPERATION_A),
    /custody row is foreign/,
  )
  const wrongProofRecord = structuredClone(abortedRecord('a'))
  wrongProofRecord.operation.reservation.inputs[0]!.proofId = PROOF_ID
  wrongProofRecord.operation.exactRequest.inputProofIds[0] = PROOF_ID
  await assert.rejects(
    () => commitRelease(state, reservation, decodeDurableCustodyRecord(wrongProofRecord), null),
    /proof pin is foreign/,
  )
  state = await commitRelease(state, reservation, abortedRecord('a'), null)
  state = addPin(state, 0, FINGERPRINT_A, 'pin-repledged', OPERATION_B)
  assert.equal(state.pinReferences.length, 1)
})

test('custody release does not interpret or release open-order collateral', async () => {
  const reservation = reservationPlan()
  const reserved = reserve(accountingState(), reservation)
  const state = addPin(reserved, 0, PROOF_ID, 'order-pin', 'order-001', 'open-order-collateral')
  const released = await commitRelease(state, reservation, abortedRecord('a'), null)
  assert.deepEqual(released.pinReferences, state.pinReferences)
})

test('exact duplicate add-pin is an idempotent no-op without a revision advance', () => {
  const state = addPin(accountingState(), 0, FINGERPRINT_A, 'pin-idempotent', OPERATION_A)
  const repeated = addPin(state, 0, FINGERPRINT_A, 'pin-idempotent', OPERATION_A)
  assert.deepEqual(repeated, state)
  assert.equal(repeated.revision, state.revision)
})

test('proof pin references enforce canonical operation identity and the 256 limit', () => {
  assert.throws(
    () => addPin(accountingState(), 0, PROOF_ID, 'pin-foreign-reference', 'not-an-operation'),
    /custody operation id is invalid/,
  )

  let state = accountingState()
  for (let index = 0; index < DURABLE_STORAGE_OPERATION_LIMIT_MAX; index += 1) {
    state = addPin(
      state,
      index,
      index.toString(16).padStart(64, '0'),
      `pin-${index}`,
      pinOperationId(index),
    )
  }
  assert.equal(state.pinReferences.length, 256)
  assert.throws(
    () => addPin(state, 256, 'ff'.repeat(32), 'pin-256', pinOperationId(256)),
    /pin reference count exceeds the limit/,
  )

  const duplicateProof = structuredClone(state)
  duplicateProof.pinReferences[1]!.proofId = duplicateProof.pinReferences[0]!.proofId
  assert.throws(
    () => decodeDurableStorageAccountingState(duplicateProof),
    /proof already has an active storage pin/,
  )
})

test('maintenance cursor rejects zero progress and non-advancing continuations', () => {
  assert.deepEqual(
    decodeDurableStorageMaintenanceCursor({
      schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
      cursor: 'cursor-001',
      examinedRows: 1,
      examinedBytes: 0,
    }),
    {
      schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
      cursor: 'cursor-001',
      examinedRows: 1,
      examinedBytes: 0,
    },
  )
  assert.throws(
    () =>
      decodeDurableStorageMaintenanceCursor({
        schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
        cursor: 'cursor-001',
        examinedRows: 0,
        examinedBytes: 0,
      }),
    /continuation has no progress/,
  )
  assert.throws(
    () =>
      decodeDurableStorageMaintenanceCursor(
        {
          schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
          cursor: 'cursor-001',
          examinedRows: 1,
          examinedBytes: 0,
        },
        'cursor-001',
      ),
    /cursor did not advance/,
  )
})

test('persisted accounting enforces the encoded record byte limit', () => {
  const state = accountingState()
  const oversized = {
    ...state,
    pinReferences: Array.from(
      { length: DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX },
      (_, index) => ({
        scopeId: SCOPE.scopeId,
        pinId: `${index}:${'p'.repeat(500)}`,
        proofId: index.toString(16).padStart(64, '0'),
        reason: 'open-order-collateral',
        referenceId: `${index}:${'r'.repeat(500)}`,
      }),
    ),
  }
  assert.ok(JSON.stringify(oversized).length > DURABLE_STORAGE_ADMISSION_RECORD_BYTES_LIMIT_MAX)
  assert.throws(
    () => decodeDurableStorageAccountingState(oversized),
    /exceeds the encoded byte limit/,
  )
})

test('persisted accounting rejects any browser-quota guarantee claim', () => {
  const state = { ...accountingState(), isBrowserQuotaGuarantee: true }
  assert.throws(
    () => decodeDurableStorageAccountingState(state),
    /accounting authority marker is invalid/,
  )
})

test('headroom loss disables admission and restore is explicit', () => {
  const initial = accountingState()
  const released = reduceDurableStorageAccountingState(initial, {
    kind: 'release-emergency-headroom',
    expectedRevision: 0,
    reason: 'quota-recovery',
  })
  assert.throws(() => reserve(released, reservationPlan()), /emergency headroom is unavailable/)
  const restored = reduceDurableStorageAccountingState(released, {
    kind: 'restore-emergency-headroom',
    expectedRevision: 1,
  })
  assert.equal(restored.emergencyHeadroom.state, 'ready')
})

function walletScope(walletId = 'a'.repeat(64)) {
  const input = { scopeKind: 'wallet' as const, walletId }
  return { ...input, scopeId: deriveDurableCustodyScopeId(input) }
}

function marketScope() {
  const input = {
    scopeKind: 'market' as const,
    marketId: 'condition-001-yes',
    inventoryAccountId: 'inventory-001',
    normalizedMint: 'https://mint.example',
    unit: 'sat',
  }
  return { ...input, scopeId: deriveDurableCustodyScopeId(input) }
}

function custodyRecord(suffix: string, scope = SCOPE): DurableCustodyRecord {
  const identity = {
    retainedOperationKey: `seller-lock-${suffix}`,
    binding: {
      kind: 'trade' as const,
      tradeId: `trade-${suffix}`,
      role: 'seller' as const,
      stage: 'lock' as const,
    },
  }
  const operationId = deriveDurableCustodyOperationId(scope.scopeId, identity)
  return decodeDurableCustodyRecord({
    schemaVersion: 1,
    revision: 0,
    scope,
    operation: {
      ...identity,
      binding: {
        ...identity.binding,
        sessionId: `session-${suffix}`,
        immutableTradeFingerprint: FINGERPRINT_A,
        hasDependentOperation: false,
      },
      operationId,
      semanticKind: 'swap-lock',
      state: 'dispatch-intent',
      terminalReplayEvidenceRequired: true,
      custodyContext: {
        normalizedMint: 'https://mint.example',
        unit: 'sat',
        inventoryAccountId: null,
      },
      reservation: {
        reservationId: `reservation-${suffix}`,
        parentReservationId: null,
        inputs: [
          {
            proofId: FINGERPRINT_A,
            keysetId: 'keyset-001',
            curve: 'secp256k1',
          },
        ],
      },
      exactRequest: {
        requestId: `request-${suffix}`,
        requestFingerprint: FINGERPRINT_A,
        payloadHandle: `request-payload-${suffix}`,
        inputProofIds: [FINGERPRINT_A],
        outputPlanFingerprint: FINGERPRINT_B,
      },
      outputPlan: {
        outputPlanId: `output-plan-${suffix}`,
        outputPlanFingerprint: FINGERPRINT_B,
        outputMaterialHandle: `output-material-${suffix}`,
      },
      privateMaterial: {
        materialHandle: `private-material-${suffix}`,
        useId: `trade-${suffix}/seller/lock`,
        publicFingerprint: FINGERPRINT_A,
      },
      result: {
        state: 'none',
        resultHandle: null,
        resultFingerprint: null,
        outputPlanFingerprint: null,
      },
      verification: {
        outputPlanFingerprint: FINGERPRINT_B,
        hasOutputs: true,
        keysetBindings: [
          {
            keysetId: 'keyset-001',
            curve: 'secp256k1',
            keysetFingerprint: FINGERPRINT_B,
            requireDleq: true,
          },
        ],
        outputKeysets: [{ keysetId: 'keyset-001', curve: 'secp256k1' }],
      },
      delivery: {
        deliveryKind: 'none',
        deliveryId: null,
        payloadHandle: null,
        payloadFingerprint: null,
        expiresAtMs: null,
        state: 'none',
      },
      retry: { attempt: 0, nextAttemptAtMs: null, reason: 'none' },
      horizon: {
        notBeforeMs: null,
        notAfterMs: 5_000,
        safetyMarginMs: 500,
        keysetExpiryMs: null,
      },
    },
    terminalTombstone: null,
  })
}

function abortedRecord(suffix: string, scope = SCOPE): DurableCustodyRecord {
  const record = structuredClone(custodyRecord(suffix, scope))
  record.operation.state = 'aborted'
  return decodeDurableCustodyRecord(record)
}

function reconciledRecord(suffix: string): DurableCustodyRecord {
  const record = structuredClone(custodyRecord(suffix))
  record.operation.state = 'reconciled'
  record.operation.result = {
    state: 'applied',
    resultHandle: `result-${suffix}`,
    resultFingerprint: FINGERPRINT_A,
    outputPlanFingerprint: FINGERPRINT_B,
  }
  return decodeDurableCustodyRecord(record)
}

function terminalRecord(suffix: string): DurableCustodyRecord {
  const record = structuredClone(reconciledRecord(suffix))
  record.terminalTombstone = {
    tombstoneId: `tombstone-${suffix}`,
    tradeId: `trade-${suffix}`,
    authenticatedTerminalStatus: true,
    replayCutoffObserved: true,
  }
  return decodeDurableCustodyRecord(record)
}

function decodedScopeState(overrides: Record<string, unknown> = {}): DurableCustodyScopeState {
  return decodeDurableCustodyScopeState({
    schemaVersion: 1,
    scope: SCOPE,
    fencingEpoch: 7,
    owner: { incarnationId: 'worker-001', leaseExpiresAtMs: 10_000 },
    effectiveClock: { highWaterMarkMs: 1_000 },
    ...overrides,
  })
}

function budgetInput() {
  return {
    schemaVersion: DURABLE_STORAGE_ADMISSION_SCHEMA_VERSION,
    scopeId: SCOPE.scopeId,
    swapId: 'trade-001',
    session: artifact('session', 500, 'trade-session'),
    operations: [
      operationBudget(OPERATION_A, 900, 'operation-a'),
      operationBudget(OPERATION_B, 700, 'operation-b'),
    ],
  }
}

function operationBudget(
  semanticOperationId: string,
  exactOperationBytes: number,
  prefix = semanticOperationId,
) {
  return {
    semanticOperationId,
    exactOperation: artifact(`${prefix}:exact-operation`, exactOperationBytes, 'exact-operation'),
    proofReferences: [
      artifact(`${prefix}:proof:0`, 32, 'proof-post-image'),
      artifact(`${prefix}:proof:1`, 32, 'proof-post-image'),
      artifact(`${prefix}:proof:2`, 32, 'proof-post-image'),
    ],
    privateMaterial: [artifact(`${prefix}:private`, 32, 'private-material')],
    ciphers: [
      artifact(`${prefix}:cipher:0`, 64, 'cipher'),
      artifact(`${prefix}:cipher:1`, 64, 'cipher'),
    ],
    transitionOverhead: [artifact(`${prefix}:transition`, 64, 'operation-overhead')],
  }
}

function maximumArtifactOperation(index: number) {
  const operationId = deriveDurableCustodyOperationId(SCOPE.scopeId, {
    retainedOperationKey: `aggregate-limit-${index}`,
    binding: {
      kind: 'trade',
      tradeId: `aggregate-limit-trade-${index}`,
      role: 'seller',
      stage: 'lock',
    },
  })
  const component = (name: string, artifactRole: Parameters<typeof artifact>[2]) =>
    Array.from({ length: DURABLE_STORAGE_PROOF_REFERENCE_LIMIT_MAX }, (_, artifactIndex) =>
      artifact(`aggregate-${index}:${name}:${artifactIndex}`, 1, artifactRole),
    )
  return {
    semanticOperationId: operationId,
    exactOperation: artifact(`aggregate-${index}:exact`, 1, 'exact-operation'),
    proofReferences: component('proof', 'proof-post-image'),
    privateMaterial: component('private', 'private-material'),
    ciphers: component('cipher', 'cipher'),
    transitionOverhead: component('transition', 'operation-overhead'),
  }
}

function plannedArtifacts(input: ReturnType<typeof budgetInput>) {
  return [
    input.session,
    ...input.operations.flatMap((operation) => [
      operation.exactOperation,
      ...operation.proofReferences,
      ...operation.privateMaterial,
      ...operation.ciphers,
      ...operation.transitionOverhead,
    ]),
  ]
}

function reservationOperationArtifactsForTest(
  operation: DurableStorageReservationPlan['operations'][number],
) {
  return [
    ...operation.exactOperation.artifacts,
    ...operation.proofReferences.artifacts,
    ...operation.privateMaterial.artifacts,
    ...operation.ciphers.artifacts,
    ...operation.transitionOverhead.artifacts,
  ]
}

function retainedTestArtifactRole(role: string): boolean {
  return role === 'proof-post-image' || role === 'transaction-only-retained'
}

function artifact(
  artifactId: string,
  bytes: number,
  artifactRole:
    | 'trade-session'
    | 'trade-intent'
    | 'exact-operation'
    | 'proof-post-image'
    | 'private-material'
    | 'cipher'
    | 'operation-overhead'
    | 'transaction-only-retained',
) {
  return {
    artifactId,
    encoding: 'binary' as const,
    artifactRole,
    bytes: new Uint8Array(bytes),
  }
}

function reservationPlan(
  reservationId = 'storage-reservation-001',
  swapId = 'trade-001',
  prefix = 'default',
  scope = SCOPE,
  artifactPrefix = prefix,
): DurableStorageReservationPlan {
  return createDurableStorageReservationPlan({
    reservationId,
    budget: calculateDurableSwapStorageBudget(
      reservationBudgetInput(swapId, prefix, scope, artifactPrefix),
    ),
  })
}

function reservationBudgetInput(
  swapId: string,
  prefix: string,
  scope = SCOPE,
  artifactPrefix = prefix,
) {
  const useDefaultOperations = scope.scopeId === SCOPE.scopeId && prefix === 'default'
  const operationA = useDefaultOperations
    ? OPERATION_A
    : deriveDurableCustodyOperationId(scope.scopeId, {
        retainedOperationKey: `${prefix}-operation-a`,
        binding: {
          kind: 'trade',
          tradeId: `${prefix}-trade-a`,
          role: 'seller',
          stage: 'lock',
        },
      })
  const operationB = useDefaultOperations
    ? OPERATION_B
    : deriveDurableCustodyOperationId(scope.scopeId, {
        retainedOperationKey: `${prefix}-operation-b`,
        binding: {
          kind: 'trade',
          tradeId: `${prefix}-trade-b`,
          role: 'seller',
          stage: 'lock',
        },
      })
  return {
    ...budgetInput(),
    scopeId: scope.scopeId,
    swapId,
    session: artifact(`${artifactPrefix}:session`, 500, 'trade-session'),
    operations: [
      operationBudget(operationA, 900, `${artifactPrefix}:operation-a`),
      operationBudget(operationB, 700, `${artifactPrefix}:operation-b`),
    ],
  }
}

function preTradeCapacityProfile(): DurablePreTradeStorageCapacityProfile {
  return createDurablePreTradeStorageCapacityProfile({
    profileId: 'gui-trade-v1',
    tradeIntent: { artifactCount: 1, bytes: 256 },
    session: { artifactCount: 1, bytes: 500 },
    exactOperations: { artifactCount: 2, bytes: 1_600 },
    proofReferences: { artifactCount: 6, bytes: 192 },
    privateMaterial: { artifactCount: 2, bytes: 64 },
    ciphers: { artifactCount: 4, bytes: 256 },
    transitionOverhead: { artifactCount: 2, bytes: 128 },
  })
}

function terminalOrderStatusArtifact(
  reservation: ReturnType<typeof createDurablePreTradeStorageReservationPlan>,
  options: {
    orderId?: string
    orderStatus?: string
    fillStatus?: 'Matched' | 'Filled' | 'Failed'
    pendingTradeId?: string | null
  } = {},
) {
  return createDurableStorageJsonArtifact({
    artifactId: `order-status:${reservation.swapId}`,
    artifactRole: 'transaction-only-retained',
    value: {
      orderId: options.orderId ?? reservation.orderId,
      marketId: reservation.marketId,
      status: options.orderStatus ?? 'failed',
      remainingAmountSubunits: 0,
      filledAmountSubunits: 10,
      fills: [
        {
          tradeId: reservation.swapId,
          makerOrderId: reservation.orderId,
          takerOrderId: 'counterparty-order',
          status: options.fillStatus ?? 'Failed',
        },
      ],
      tokenSide: 'Outcome',
      baseAsset: 'sat',
      divisibility: 10_000,
      ...(options.pendingTradeId === undefined
        ? {}
        : { tradeId: options.pendingTradeId }),
    },
  })
}

function accountingState(
  accountingLimitBytes = DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES + 100_000,
): DurableStorageAccountingState {
  return createDurableStorageAccountingState({ accountingLimitBytes })
}

function reserve(state: DurableStorageAccountingState, reservation: DurableStorageReservationPlan) {
  return reserveBatch(state, [reservation])
}

function reserveBatch(
  state: DurableStorageAccountingState,
  reservations: DurableStorageReservationPlan[],
) {
  return reduceDurableStorageAccountingState(state, {
    kind: 'reserve-batch',
    expectedRevision: state.revision,
    reservations,
  })
}

function consume(
  state: DurableStorageAccountingState,
  reservation: DurableStorageReservationPlan,
  semanticOperationId: string,
) {
  return reduceDurableStorageAccountingState(state, {
    kind: 'consume-operation',
    expectedRevision: state.revision,
    scopeId: reservation.scopeId,
    reservationId: reservation.reservationId,
    semanticOperationId,
  })
}

async function commitRelease(
  state: DurableStorageAccountingState,
  reservation: DurableStorageReservationPlan,
  record: DurableCustodyRecord,
  scopeState: DurableCustodyScopeState | null,
  semanticOperationId = record.operation.operationId,
): Promise<DurableStorageAccountingState> {
  const result = await releaseCommittedDurableStorageOperation({
    store: {
      async commitRelease(_query, apply) {
        return apply({ accounting: state, custodyRecord: record, scopeState })
      },
    },
    expectedAccountingRevision: state.revision,
    scopeId: reservation.scopeId,
    reservationId: reservation.reservationId,
    semanticOperationId,
  })
  return result.nextAccounting
}

function addPin(
  state: DurableStorageAccountingState,
  index: number,
  proofId: string,
  pinId = `pin-${index}`,
  referenceId = pinOperationId(index),
  reason: 'proof-operation' | 'open-order-collateral' = 'proof-operation',
) {
  return reduceDurableStorageAccountingState(state, {
    kind: 'add-pin-reference',
    expectedRevision: state.revision,
    pin: { scopeId: SCOPE.scopeId, pinId, proofId, reason, referenceId },
  })
}

function pinOperationId(index: number) {
  return deriveDurableCustodyOperationId(SCOPE.scopeId, {
    retainedOperationKey: `pin-operation-${index}`,
    binding: {
      kind: 'trade',
      tradeId: `pin-trade-${index}`,
      role: 'seller',
      stage: 'lock',
    },
  })
}
