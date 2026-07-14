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
  DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
  DURABLE_STORAGE_OPERATION_ARTIFACT_LIMIT_MAX,
  DURABLE_STORAGE_OPERATION_LIMIT_MAX,
  calculateDurableSwapStorageBudget,
  createDurableStorageAccountingState,
  createDurableStorageReleaseEvidence,
  createDurableStorageReservationPlan,
  decodeDurableStorageAccountingState,
  decodeDurableStorageMaintenanceCursor,
  reduceDurableStorageAccountingState,
  type DurableStorageAccountingState,
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
  assert.deepEqual(budget.operations.map(({ semanticOperationId }) => semanticOperationId), [
    OPERATION_A,
    OPERATION_B,
  ])
  assert.equal(budget.totalArtifactCount, 17)
  assert.equal(budget.totalBytes, 2_740)
  assert.equal(budget.isBrowserQuotaGuarantee, false)
  assert.equal(budget.requiresAtomicAdapterTransaction, true)
  assert.throws(() => calculateDurableSwapStorageBudget({
    ...budgetInput(),
    scopeId: 'aa'.repeat(32),
  }), /custody scope id is invalid/)
  assert.throws(() => calculateDurableSwapStorageBudget({
    ...budgetInput(),
    scopeId: 'custody:profile:%ZZ',
  }), /custody scope id is invalid/)
  assert.throws(() => calculateDurableSwapStorageBudget({
    ...budgetInput(),
    scopeId: 'custody:profile:%70rofile-001',
  }), /custody scope id is invalid/)
  assert.throws(() => calculateDurableSwapStorageBudget({
    ...budgetInput(),
    operations: [{ ...budgetInput().operations[0]!, semanticOperationId: 'bb'.repeat(32) }],
  }), /custody operation id is invalid/)
  const foreignScope = walletScope('f'.repeat(64))
  const foreignOperationId = deriveDurableCustodyOperationId(foreignScope.scopeId, {
    retainedOperationKey: 'seller-lock-a',
    binding: { kind: 'trade', tradeId: 'trade-a', role: 'seller', stage: 'lock' },
  })
  assert.throws(() => calculateDurableSwapStorageBudget({
    ...budgetInput(),
    operations: [{ ...budgetInput().operations[0]!, semanticOperationId: foreignOperationId }],
  }), /custody operation id is invalid/)

  const market = marketScope()
  const marketOperationId = deriveDurableCustodyOperationId(market.scopeId, {
    retainedOperationKey: 'market-lock-a',
    binding: { kind: 'trade', tradeId: 'market-trade-a', role: 'seller', stage: 'lock' },
  })
  assert.equal(calculateDurableSwapStorageBudget({
    ...budgetInput(),
    scopeId: market.scopeId,
    operations: [operationBudget(marketOperationId, 900)],
  }).scopeId, market.scopeId)

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
  assert.throws(() => decodeDurableCustodyScopeId('custody:wallet:%'), /custody scope id is invalid/)
})

test('reserves, consumes, and releases exact custody operations without dropping shared bytes early', () => {
  const reservation = reservationPlan()
  const initial = accountingState(reservation.totalBytes + DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES)
  const reserved = reserve(initial, reservation)
  assert.equal(reserved.accountedBytes, reservation.totalBytes)

  const consumedA = consume(reserved, reservation, OPERATION_A)
  const releasedA = release(consumedA, reservation, terminalRecord('a'), decodedScopeState())
  assert.equal(releasedA.reservations.length, 1)
  assert.equal(releasedA.reservations[0]?.sharedBytes, reservation.sharedBytes)
  assert.equal(
    releasedA.accountedBytes,
    reservation.sharedBytes + reservation.operations[1]!.bytes,
  )

  const consumedB = consume(releasedA, reservation, OPERATION_B)
  const releasedB = release(consumedB, reservation, terminalRecord('b'), decodedScopeState())
  assert.equal(releasedB.accountedBytes, 0)
  assert.deepEqual(releasedB.reservations, [])
})

test('capacity equality admits exactly the reservation plus emergency headroom', () => {
  const reservation = reservationPlan()
  const exact = accountingState(reservation.totalBytes + DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES)
  assert.equal(reserve(exact, reservation).accountedBytes, reservation.totalBytes)
  const short = accountingState(reservation.totalBytes + DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES - 1)
  assert.throws(() => reserve(short, reservation), /capacity is insufficient/)
})

test('release evidence is inferred only from decoded custody state and terminal drain authority', () => {
  const aborted = abortedRecord('a')
  assert.deepEqual(
    pickReleaseEvidence(createDurableStorageReleaseEvidence(aborted)),
    {
      scopeId: SCOPE.scopeId,
      semanticOperationId: OPERATION_A,
      disposition: 'safe-abort',
    },
  )

  assert.throws(
    () => createDurableStorageReleaseEvidence(custodyRecord('a')),
    /custody is not releasable/,
  )
  assert.throws(
    () => createDurableStorageReleaseEvidence(terminalRecord('a')),
    /scope state is required/,
  )
  assert.throws(
    () => createDurableStorageReleaseEvidence(reconciledRecord('a'), decodedScopeState()),
    /terminal custody must be retained/,
  )
  assert.throws(
    () => createDurableStorageReleaseEvidence(terminalRecord('a'), decodedScopeState({
      scope: walletScope('f'.repeat(64)),
    })),
    /foreign custody scope/,
  )
  assert.deepEqual(
    pickReleaseEvidence(createDurableStorageReleaseEvidence(
      terminalRecord('a'),
      decodedScopeState(),
    )),
    {
      scopeId: SCOPE.scopeId,
      semanticOperationId: OPERATION_A,
      disposition: 'terminal-purge',
    },
  )
})

test('release evidence rejects clones and rewritten operation or disposition authority', () => {
  const reservation = reservationPlan()
  const reserved = reserve(accountingState(), reservation)
  const evidence = createDurableStorageReleaseEvidence(abortedRecord('a'))
  assert.equal(Object.isFrozen(evidence), true)
  assert.equal(Reflect.set(evidence, 'semanticOperationId', OPERATION_B), false)
  assert.equal(evidence.semanticOperationId, OPERATION_A)
  assert.throws(
    () => reduceDurableStorageAccountingState(reserved, {
      kind: 'release-operation',
      expectedRevision: reserved.revision,
      reservationId: reservation.reservationId,
      evidence: { ...evidence },
    }),
    /release evidence is invalid/,
  )
  assert.throws(
    () => reduceDurableStorageAccountingState(reserved, {
      kind: 'release-operation',
      expectedRevision: reserved.revision,
      reservationId: reservation.reservationId,
      evidence: {
        ...evidence,
        semanticOperationId: OPERATION_B,
        disposition: 'safe-abort',
      },
    }),
    /release evidence is invalid/,
  )
})

test('corrupted aborted custody cannot authorize storage release', () => {
  const corruptions: Array<(record: DurableCustodyRecord) => void> = [
    (record) => { tradeBinding(record).hasDependentOperation = true },
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
      record.operation.retry = { attempt: 1, nextAttemptAtMs: 2_000, reason: 'rate-limited' }
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
  for (const corrupt of corruptions) {
    const record = structuredClone(abortedRecord('a'))
    corrupt(record)
    assert.throws(
      () => createDurableStorageReleaseEvidence(record),
      /aborted operation|terminal tombstone lifecycle/,
    )
  }
})

test('persisted accounting rejects foreign reservations and duplicate reservation or operation ids', () => {
  const reservation = reservationPlan()
  const state = reserve(accountingState(), reservation)
  const foreign = structuredClone(state)
  foreign.reservations[0]!.scopeId = walletScope('f'.repeat(64)).scopeId
  assert.throws(() => decodeDurableStorageAccountingState(foreign), /reservation scope is foreign/)

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

test('persisted and reducer inputs reject positive artifact counts with zero bytes', () => {
  assert.throws(() => calculateDurableSwapStorageBudget({
    ...budgetInput(),
    session: { count: 1, bytes: 0 },
  }), /count and bytes are inconsistent/)

  const reservation = reservationPlan()
  const undercounted = structuredClone(reservation)
  undercounted.operations[0]!.bytes = 0
  undercounted.totalBytes -= reservation.operations[0]!.bytes
  assert.throws(
    () => reserve(accountingState(), undercounted),
    /reserved artifact count and bytes are inconsistent/,
  )

  const oversized = structuredClone(reservation)
  oversized.operations[0]!.artifactCount = DURABLE_STORAGE_OPERATION_ARTIFACT_LIMIT_MAX + 1
  oversized.totalArtifactCount = oversized.sharedArtifactCount
    + oversized.operations.reduce((total, operation) => total + operation.artifactCount, 0)
  assert.throws(
    () => reserve(accountingState(), oversized),
    /storage reservation operation exceeds the limit/,
  )
})

test('proof-operation pins require custody evidence, bind proof and operation, then allow repledge', () => {
  let state = accountingState()
  state = addPin(state, 0, FINGERPRINT_A, 'pin-0', OPERATION_A)
  assert.throws(
    () => addPin(state, 1, FINGERPRINT_A, 'pin-duplicate-proof', OPERATION_A),
    /proof already has an active storage pin/,
  )
  assert.throws(() => reduceDurableStorageAccountingState(state, {
    kind: 'release-pin-reference',
    expectedRevision: state.revision,
    pinId: 'pin-0',
    evidence: { ...createDurableStorageReleaseEvidence(abortedRecord('a')) },
  }), /release evidence is invalid/)
  assert.throws(() => reduceDurableStorageAccountingState(state, {
    kind: 'release-pin-reference',
    expectedRevision: state.revision,
    pinId: 'pin-0',
    evidence: createDurableStorageReleaseEvidence(abortedRecord('b')),
  }), /pin release operation is foreign/)
  const wrongProofRecord = structuredClone(abortedRecord('a'))
  wrongProofRecord.operation.reservation.inputs[0]!.proofId = PROOF_ID
  wrongProofRecord.operation.exactRequest.inputProofIds[0] = PROOF_ID
  assert.throws(() => reduceDurableStorageAccountingState(state, {
    kind: 'release-pin-reference',
    expectedRevision: state.revision,
    pinId: 'pin-0',
    evidence: createDurableStorageReleaseEvidence(decodeDurableCustodyRecord(wrongProofRecord)),
  }), /pin release proof is foreign/)
  state = reduceDurableStorageAccountingState(state, {
    kind: 'release-pin-reference',
    expectedRevision: state.revision,
    pinId: 'pin-0',
    evidence: createDurableStorageReleaseEvidence(abortedRecord('a')),
  })
  state = addPin(state, 0, FINGERPRINT_A, 'pin-repledged', OPERATION_A)
  assert.equal(state.pinReferences.length, 1)
})

test('open-order collateral pins fail closed because release authority is not yet available', () => {
  const state = addPin(
    accountingState(),
    0,
    PROOF_ID,
    'order-pin',
    'order-001',
    'open-order-collateral',
  )
  assert.throws(() => reduceDurableStorageAccountingState(state, {
    kind: 'release-pin-reference',
    expectedRevision: state.revision,
    pinId: 'order-pin',
    evidence: createDurableStorageReleaseEvidence(abortedRecord('a')),
  }), /open-order collateral release authority is unavailable/)
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
  assert.deepEqual(decodeDurableStorageMaintenanceCursor({
    schemaVersion: 1,
    cursor: 'cursor-001',
    examinedRows: 1,
    examinedBytes: 0,
  }), {
    schemaVersion: 1,
    cursor: 'cursor-001',
    examinedRows: 1,
    examinedBytes: 0,
  })
  assert.throws(() => decodeDurableStorageMaintenanceCursor({
    schemaVersion: 1,
    cursor: 'cursor-001',
    examinedRows: 0,
    examinedBytes: 0,
  }), /continuation has no progress/)
  assert.throws(() => decodeDurableStorageMaintenanceCursor({
    schemaVersion: 1,
    cursor: 'cursor-001',
    examinedRows: 1,
    examinedBytes: 0,
  }, 'cursor-001'), /cursor did not advance/)
})

test('persisted accounting enforces the encoded record byte limit', () => {
  const state = accountingState()
  const oversized = {
    ...state,
    maintenanceCursor: {
      schemaVersion: 1,
      cursor: 'x'.repeat(DURABLE_STORAGE_ADMISSION_RECORD_BYTES_LIMIT_MAX),
      examinedRows: 1,
      examinedBytes: 1,
    },
  }
  assert.throws(
    () => decodeDurableStorageAccountingState(oversized),
    /exceeds the encoded byte limit/,
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

function custodyRecord(suffix: string): DurableCustodyRecord {
  const identity = {
    retainedOperationKey: `seller-lock-${suffix}`,
    binding: {
      kind: 'trade' as const,
      tradeId: `trade-${suffix}`,
      role: 'seller' as const,
      stage: 'lock' as const,
    },
  }
  const operationId = deriveDurableCustodyOperationId(SCOPE.scopeId, identity)
  return decodeDurableCustodyRecord({
    schemaVersion: 1,
    revision: 0,
    scope: SCOPE,
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
      custodyContext: { normalizedMint: 'https://mint.example', unit: 'sat', inventoryAccountId: null },
      reservation: {
        reservationId: `reservation-${suffix}`,
        inputs: [{ proofId: FINGERPRINT_A, keysetId: 'keyset-001', curve: 'secp256k1' }],
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
      result: { state: 'none', resultHandle: null, resultFingerprint: null, outputPlanFingerprint: null },
      verification: {
        outputPlanFingerprint: FINGERPRINT_B,
        keysetBindings: [{
          keysetId: 'keyset-001',
          curve: 'secp256k1',
          keysetFingerprint: FINGERPRINT_B,
          requireDleq: true,
        }],
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
      horizon: { notBeforeMs: null, notAfterMs: 5_000, safetyMarginMs: 500, keysetExpiryMs: null },
    },
    terminalTombstone: null,
  })
}

function abortedRecord(suffix: string): DurableCustodyRecord {
  const record = structuredClone(custodyRecord(suffix))
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
    schemaVersion: 1 as const,
    scopeId: SCOPE.scopeId,
    swapId: 'trade-001',
    session: { count: 1, bytes: 500 },
    operations: [operationBudget(OPERATION_A, 900), operationBudget(OPERATION_B, 700)],
  }
}

function operationBudget(semanticOperationId: string, exactOperationBytes: number) {
  return {
    semanticOperationId,
    exactOperation: { count: 1, bytes: exactOperationBytes },
    proofReferences: { count: 3, bytes: 96 },
    privateMaterial: { count: 1, bytes: 32 },
    ciphers: { count: 2, bytes: 128 },
    transitionOverhead: { count: 1, bytes: 64 },
  }
}

function reservationPlan(): DurableStorageReservationPlan {
  return createDurableStorageReservationPlan({
    reservationId: 'storage-reservation-001',
    budget: calculateDurableSwapStorageBudget(budgetInput()),
  })
}

function accountingState(
  accountingLimitBytes = DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES + 100_000,
): DurableStorageAccountingState {
  return createDurableStorageAccountingState({ scopeId: SCOPE.scopeId, accountingLimitBytes })
}

function reserve(state: DurableStorageAccountingState, reservation: DurableStorageReservationPlan) {
  return reduceDurableStorageAccountingState(state, {
    kind: 'reserve-multi-fill',
    expectedRevision: state.revision,
    reservation,
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
    reservationId: reservation.reservationId,
    semanticOperationId,
  })
}

function release(
  state: DurableStorageAccountingState,
  reservation: DurableStorageReservationPlan,
  record: DurableCustodyRecord,
  scopeState?: DurableCustodyScopeState,
) {
  return reduceDurableStorageAccountingState(state, {
    kind: 'release-operation',
    expectedRevision: state.revision,
    reservationId: reservation.reservationId,
    evidence: createDurableStorageReleaseEvidence(record, scopeState),
  })
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
    pin: { pinId, proofId, reason, referenceId },
  })
}

function pinOperationId(index: number) {
  return deriveDurableCustodyOperationId(SCOPE.scopeId, {
    retainedOperationKey: `pin-operation-${index}`,
    binding: { kind: 'trade', tradeId: `pin-trade-${index}`, role: 'seller', stage: 'lock' },
  })
}

function pickReleaseEvidence(evidence: ReturnType<typeof createDurableStorageReleaseEvidence>) {
  return {
    scopeId: evidence.scopeId,
    semanticOperationId: evidence.semanticOperationId,
    disposition: evidence.disposition,
  }
}
