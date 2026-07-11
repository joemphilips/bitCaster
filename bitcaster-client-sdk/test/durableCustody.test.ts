import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeState,
  applyDurableCustodyTransaction,
  decideDurableCustodyRecovery,
  decideTerminalTombstoneDrain,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  validateDurableCustodyScopeRegistration,
  reduceDurableCustodyState,
  type DurableCustodyRecord,
  type DurableCustodyScopeState,
  type DurableCustodyState,
} from '../src/durableCustody.ts'

const FINGERPRINT_A = 'a'.repeat(64)
const FINGERPRINT_B = 'b'.repeat(64)

function profileScope() {
  const scope = {
    scopeKind: 'profile' as const,
    profileId: 'profile-001',
  }
  return { ...scope, scopeId: deriveDurableCustodyScopeId(scope) }
}

function marketScope() {
  const scope = {
    scopeKind: 'market' as const,
    marketId: 'condition-001-yes',
    inventoryAccountId: 'inventory-001',
    normalizedMint: 'https://mint.example',
    unit: 'sat',
  }
  return { ...scope, scopeId: deriveDurableCustodyScopeId(scope) }
}

function custodyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const scope = profileScope()
  const identity = {
    retainedOperationKey: 'seller-lock-001',
    trade: {
      tradeId: 'trade-001',
      role: 'seller',
      stage: 'lock',
    },
  }
  const operationId = deriveDurableCustodyOperationId(scope.scopeId, identity)
  return {
    schemaVersion: 1,
    revision: 0,
    scope,
    operation: {
      ...identity,
      operationId,
      semanticKind: 'swap-lock',
      state: 'dispatch-intent',
      custodyContext: {
        normalizedMint: 'https://mint.example',
        unit: 'sat',
        inventoryAccountId: null,
      },
      reservation: {
        reservationId: 'reservation-001',
        inputs: [{ proofId: FINGERPRINT_A, keysetId: 'keyset-001', curve: 'secp256k1' }],
      },
      exactRequest: {
        requestId: 'request-001',
        requestFingerprint: FINGERPRINT_A,
        payloadHandle: 'request-payload-001',
        inputProofIds: [FINGERPRINT_A],
        outputPlanFingerprint: FINGERPRINT_B,
      },
      outputPlan: {
        outputPlanId: 'output-plan-001',
        outputPlanFingerprint: FINGERPRINT_B,
        outputMaterialHandle: 'output-material-001',
      },
      privateMaterial: {
        materialHandle: 'private-material-001',
        useId: 'trade-001/seller/lock',
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
        keysetBindings: [
          {
            keysetId: 'keyset-001',
            curve: 'secp256k1',
            keysetFingerprint: FINGERPRINT_B,
            requireDleq: true,
          },
        ],
      },
      sessionLink: {
        linkKind: 'trade',
        sessionId: 'session-001',
        tradeId: 'trade-001',
        immutableTradeFingerprint: FINGERPRINT_A,
        hasDependentOperation: false,
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
    ...overrides,
  }
}

function decodedRecord(overrides: Record<string, unknown> = {}): DurableCustodyRecord {
  return decodeDurableCustodyRecord(custodyRecord(overrides))
}

function custodyScopeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    scope: profileScope(),
    owner: {
      ownerId: 'worker-001',
      epoch: 7,
      leaseExpiresAtMs: 10_000,
    },
    effectiveClock: { highWaterMarkMs: 1_000 },
    ...overrides,
  }
}

function decodedScopeState(overrides: Record<string, unknown> = {}): DurableCustodyScopeState {
  return decodeDurableCustodyScopeState(custodyScopeState(overrides))
}

function custodyState(
  operation: DurableCustodyRecord = decodedRecord(),
  scopeState: DurableCustodyScopeState = decodedScopeState(),
): DurableCustodyState {
  return { operation, scopeState }
}

function exactReference(record: DurableCustodyRecord) {
  return {
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    requestFingerprint: record.operation.exactRequest.requestFingerprint,
    requestPayloadHandle: record.operation.exactRequest.payloadHandle,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    outputMaterialHandle: record.operation.outputPlan.outputMaterialHandle,
    privateMaterial: { ...record.operation.privateMaterial },
    stagedResult: record.operation.result.state === 'none'
      ? null
      : {
        resultHandle: record.operation.result.resultHandle,
        resultFingerprint: record.operation.result.resultFingerprint,
        outputPlanFingerprint: record.operation.result.outputPlanFingerprint,
      },
  }
}

const ownerAuthorization = {
  ownerId: 'worker-001',
  ownerEpoch: 7,
  observedAtMs: 1_500,
}

test('canonical custody decoder rejects unknown versions, fields, and foreign scopes', () => {
  assert.equal(decodedRecord().operation.state, 'dispatch-intent')

  assert.throws(
    () => decodeDurableCustodyRecord({ ...custodyRecord(), schemaVersion: 2 }),
    /unsupported durable custody schema version/,
  )
  assert.throws(
    () => decodeDurableCustodyRecord({ ...custodyRecord(), futureField: true }),
    /unknown field/,
  )
  assert.throws(
    () => {
      const foreignScope = {
        scopeKind: 'profile' as const,
        profileId: 'profile-foreign',
      }
      return decodeDurableCustodyRecord(custodyRecord(), {
        ...foreignScope,
        scopeId: deriveDurableCustodyScopeId(foreignScope),
      })
    },
    /foreign custody scope/,
  )
  assert.throws(
    () => decodeDurableCustodyScopeState({ ...custodyScopeState(), unknown: true }),
    /unknown field/,
  )
  const nestedUnknown = custodyRecord()
  ;((nestedUnknown.operation as Record<string, unknown>).exactRequest as Record<string, unknown>).future = true
  assert.throws(
    () => decodeDurableCustodyRecord(nestedUnknown),
    /unknown field 'future'/,
  )
})

test('global proof identity has a domain-separated canonical vector and never includes a secret literally', () => {
  const proofId = deriveDurableCustodyProofId({
    normalizedMint: 'https://mint.example',
    unit: 'sat',
    keysetId: 'keyset-001',
    secret: 'proof-secret-001',
  })
  assert.equal(proofId, '109fdee82f93d8aaac81687accffd9ee6873f8f823ebb394e166d43da3f6e6c8')
  assert.notEqual(proofId, deriveDurableCustodyProofId({
    normalizedMint: 'https://mint.example',
    unit: 'sat',
    keysetId: 'keyset-001',
    secret: 'proof-secret-002',
  }))
  assert.equal(proofId.includes('proof-secret-001'), false)
  assert.throws(
    () => deriveDurableCustodyProofId({
      normalizedMint: 'https://mint.example/',
      unit: 'sat',
      keysetId: 'keyset-001',
      secret: 'proof-secret-001',
    }),
    /normalized mint is invalid/,
  )
})

test('market custody scopes bind their mint, unit, and inventory domain', () => {
  const scope = marketScope()
  const raw = custodyRecord()
  raw.scope = scope
  const operation = raw.operation as Record<string, unknown>
  operation.custodyContext = {
    normalizedMint: scope.normalizedMint,
    unit: scope.unit,
    inventoryAccountId: scope.inventoryAccountId,
  }
  operation.operationId = deriveDurableCustodyOperationId(scope.scopeId, {
    retainedOperationKey: operation.retainedOperationKey as string,
    trade: operation.trade as { tradeId: string; role: 'buyer' | 'seller'; stage: 'lock' },
  })
  assert.equal(decodeDurableCustodyRecord(raw).scope.scopeId, scope.scopeId)

  const otherAccount = { ...scope, inventoryAccountId: 'inventory-002' }
  assert.notEqual(scope.scopeId, deriveDurableCustodyScopeId(otherAccount))
  ;(operation.custodyContext as Record<string, unknown>).inventoryAccountId = otherAccount.inventoryAccountId
  assert.throws(
    () => decodeDurableCustodyRecord(raw),
    /market custody context is foreign/,
  )

  assert.throws(
    () => validateDurableCustodyScopeRegistration(scope, {
      ...otherAccount,
      scopeId: deriveDurableCustodyScopeId(otherAccount),
    }),
    /market custody scope registration conflicts/,
  )
  const otherMarket = { ...scope, marketId: 'condition-002-no' }
  assert.throws(
    () => validateDurableCustodyScopeRegistration(scope, {
      ...otherMarket,
      scopeId: deriveDurableCustodyScopeId(otherMarket),
    }),
    /market custody scope registration conflicts/,
  )
})

test('canonical custody decoder requires immutable exact-operation and verification bindings', () => {
  const missingVerification = custodyRecord()
  delete (missingVerification.operation as Record<string, unknown>).verification
  assert.throws(
    () => decodeDurableCustodyRecord(missingVerification),
    /missing required field 'verification'/,
  )

  const unknownCurve = custodyRecord()
  const input = ((unknownCurve.operation as Record<string, unknown>).reservation as Record<string, unknown>)
    .inputs as Array<Record<string, unknown>>
  input[0]!.curve = 'future-curve'
  assert.throws(
    () => decodeDurableCustodyRecord(unknownCurve),
    /curve is invalid/,
  )

  const mismatchedOutputBinding = custodyRecord()
  const verification = (mismatchedOutputBinding.operation as Record<string, unknown>)
    .verification as Record<string, unknown>
  verification.outputPlanFingerprint = FINGERPRINT_A
  assert.throws(
    () => decodeDurableCustodyRecord(mismatchedOutputBinding),
    /output plan binding is invalid/,
  )

  const duplicateInput = custodyRecord()
  ;((duplicateInput.operation as Record<string, unknown>).exactRequest as Record<string, unknown>)
    .inputProofIds = [FINGERPRINT_A, FINGERPRINT_A]
  assert.throws(
    () => decodeDurableCustodyRecord(duplicateInput),
    /exact request input binding is invalid/,
  )

  const mismatchedSemanticStage = custodyRecord()
  ;(mismatchedSemanticStage.operation as Record<string, unknown>).semanticKind = 'swap-claim'
  assert.throws(
    () => decodeDurableCustodyRecord(mismatchedSemanticStage),
    /operation semantic stage binding is invalid/,
  )

  const refundMissingNotBefore = custodyRecord()
  const refundOperation = refundMissingNotBefore.operation as Record<string, unknown>
  refundOperation.semanticKind = 'swap-refund'
  ;(refundOperation.trade as Record<string, unknown>).stage = 'refund'
  refundOperation.operationId = deriveDurableCustodyOperationId(profileScope().scopeId, {
    retainedOperationKey: refundOperation.retainedOperationKey as string,
    trade: refundOperation.trade as { tradeId: string; role: 'buyer' | 'seller'; stage: 'refund' },
  })
  assert.throws(
    () => decodeDurableCustodyRecord(refundMissingNotBefore),
    /operation semantic horizon requires not-before/,
  )

  const lockMissingNotAfter = custodyRecord()
  const lockOperation = lockMissingNotAfter.operation as Record<string, unknown>
  ;(lockOperation.horizon as Record<string, unknown>).notAfterMs = null
  assert.throws(
    () => decodeDurableCustodyRecord(lockMissingNotAfter),
    /operation semantic horizon requires not-after/,
  )

  const genericWithoutHorizon = custodyRecord()
  const genericWithoutHorizonOperation = genericWithoutHorizon.operation as Record<string, unknown>
  genericWithoutHorizonOperation.semanticKind = 'generic-send'
  ;(genericWithoutHorizonOperation.trade as Record<string, unknown>).stage = 'send'
  ;(genericWithoutHorizonOperation.horizon as Record<string, unknown>).notAfterMs = null
  genericWithoutHorizonOperation.operationId = deriveDurableCustodyOperationId(profileScope().scopeId, {
    retainedOperationKey: genericWithoutHorizonOperation.retainedOperationKey as string,
    trade: genericWithoutHorizonOperation.trade as { tradeId: string; role: 'buyer' | 'seller'; stage: 'send' },
  })
  assert.equal(decodeDurableCustodyRecord(genericWithoutHorizon).operation.semanticKind, 'generic-send')

  const nonExpiringCtf = custodyRecord()
  const nonExpiringCtfOperation = nonExpiringCtf.operation as Record<string, unknown>
  nonExpiringCtfOperation.semanticKind = 'ctf-merge'
  ;(nonExpiringCtfOperation.trade as Record<string, unknown>).stage = 'ctf-merge'
  ;(nonExpiringCtfOperation.horizon as Record<string, unknown>).notAfterMs = null
  ;(nonExpiringCtfOperation.horizon as Record<string, unknown>).keysetExpiryMs = null
  nonExpiringCtfOperation.operationId = deriveDurableCustodyOperationId(profileScope().scopeId, {
    retainedOperationKey: nonExpiringCtfOperation.retainedOperationKey as string,
    trade: nonExpiringCtfOperation.trade as { tradeId: string; role: 'buyer' | 'seller'; stage: 'ctf-merge' },
  })
  assert.equal(decodeDurableCustodyRecord(nonExpiringCtf).operation.semanticKind, 'ctf-merge')
})

test('dispatch authority advances the effective clock and a rollback cannot reopen a horizon', () => {
  const record = decodedRecord()
  const scopeState = decodedScopeState({ effectiveClock: { highWaterMarkMs: 4_500 } })
  const decision = decideDurableCustodyRecovery(record, scopeState, {
    ...ownerAuthorization,
    observedAtMs: 1_000,
    classification: 'all-inputs-unspent',
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    requestFingerprint: record.operation.exactRequest.requestFingerprint,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
  })

  assert.deepEqual(decision, {
    kind: 'abort-no-transport',
    effectiveNowMs: 4_500,
  })
})

test('a reissue decision carries only the immutable exact-operation reference', () => {
  const record = decodedRecord()
  const decision = decideDurableCustodyRecovery(record, decodedScopeState(), {
    ...ownerAuthorization,
    classification: 'all-inputs-unspent',
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    requestFingerprint: record.operation.exactRequest.requestFingerprint,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
  })
  assert.deepEqual(decision, {
    kind: 'reissue-exact-operation',
    effectiveNowMs: 1_500,
    exact: exactReference(record),
  })
})

test('not-before waits rather than aborting and an expired lease permits a fenced claim', () => {
  const beforeWindow = decodedRecord({
    operation: {
      ...custodyRecord().operation as Record<string, unknown>,
      horizon: { notBeforeMs: 2_000, notAfterMs: 5_000, safetyMarginMs: 500, keysetExpiryMs: null },
    },
  })
  const waiting = decideDurableCustodyRecovery(beforeWindow, decodedScopeState(), {
    ...ownerAuthorization,
    classification: 'all-inputs-unspent',
    scopeId: beforeWindow.scope.scopeId,
    operationId: beforeWindow.operation.operationId,
    requestFingerprint: beforeWindow.operation.exactRequest.requestFingerprint,
    outputPlanFingerprint: beforeWindow.operation.outputPlan.outputPlanFingerprint,
  })
  assert.deepEqual(waiting, { kind: 'retry-later', effectiveNowMs: 1_500 })

  const claimed = reduceDurableCustodyState(custodyState(), {
    kind: 'owner-claimed',
    observedAtMs: 10_000,
    nextOwnerId: 'worker-002',
    nextOwnerEpoch: 8,
    nextLeaseExpiresAtMs: 20_000,
  })
  assert.deepEqual(claimed.scopeState.owner, {
    ownerId: 'worker-002',
    epoch: 8,
    leaseExpiresAtMs: 20_000,
  })
  assert.throws(
    () => reduceDurableCustodyState(claimed, {
      kind: 'transport-attempted',
      ...ownerAuthorization,
      observedAtMs: 10_001,
    }),
    /custody owner epoch is foreign/,
  )
})

test('scope authority is shared across operations and rejects a foreign scope row', () => {
  const record = decodedRecord()
  const foreign = {
    scopeKind: 'profile' as const,
    profileId: 'profile-foreign',
  }
  const foreignScopeState = decodeDurableCustodyScopeState({
    ...custodyScopeState(),
    scope: { ...foreign, scopeId: deriveDurableCustodyScopeId(foreign) },
  })
  assert.throws(
    () => reduceDurableCustodyState(custodyState(record, foreignScopeState), {
      kind: 'transport-attempted',
      ...ownerAuthorization,
    }),
    /foreign custody scope/,
  )
})

test('transaction work rejects a foreign await before an adapter can split a custody commit', () => {
  assert.throws(
    () => applyDurableCustodyTransaction({} as never, async () => undefined),
    /durable custody transaction callback must not await/,
  )
})

test('post-handoff recovery never reissues an all-unspent exact operation', () => {
  const dispatched = reduceDurableCustodyState(custodyState(), {
    kind: 'transport-attempted',
    ...ownerAuthorization,
  })
  assert.equal(dispatched.operation.operation.state, 'transport-attempted')
  assert.equal(dispatched.scopeState.effectiveClock.highWaterMarkMs, 1_500)

  const decision = decideDurableCustodyRecovery(dispatched.operation, dispatched.scopeState, {
    ...ownerAuthorization,
    classification: 'all-inputs-unspent',
    scopeId: dispatched.operation.scope.scopeId,
    operationId: dispatched.operation.operation.operationId,
    requestFingerprint: dispatched.operation.operation.exactRequest.requestFingerprint,
    outputPlanFingerprint: dispatched.operation.operation.outputPlan.outputPlanFingerprint,
  })
  assert.deepEqual(decision, {
    kind: 'reconcile-exact-operation',
    reason: 'transport-attempted',
    exact: exactReference(dispatched.operation),
  })
  assert.throws(
    () => reduceDurableCustodyState(dispatched, {
      kind: 'abort-no-transport',
      ...ownerAuthorization,
      classification: 'all-inputs-unspent',
    }),
    /abort is only legal before transport handoff/,
  )
})

test('NUT-09 recovery may reconcile a dispatch intent only with spent-restorable evidence', () => {
  const record = decodedRecord()
  const initial = custodyState(record)
  assert.throws(
    () => reduceDurableCustodyState(initial, {
      kind: 'reconciled',
      recoverySource: 'spent-restorable',
      ...ownerAuthorization,
    }),
    /reconciliation requires verified staged result/,
  )
  const staged = reduceDurableCustodyState(initial, {
    kind: 'verified-result-staged',
    resultHandle: 'result-001',
    resultFingerprint: FINGERPRINT_A,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    ...ownerAuthorization,
  })
  const reconciled = reduceDurableCustodyState(staged, {
    kind: 'reconciled',
    recoverySource: 'spent-restorable',
    ...ownerAuthorization,
  })
  assert.equal(reconciled.operation.operation.state, 'reconciled')
  assert.equal(reconciled.operation.operation.result.state, 'applied')
  assert.throws(
    () => reduceDurableCustodyState(staged, {
      kind: 'reconciled',
      recoverySource: 'transport-attempted',
      ...ownerAuthorization,
    }),
    /dispatch-intent reconciliation source is invalid/,
  )
})

test('a verified staged result cannot be aborted after the dispatch horizon closes', () => {
  const record = decodedRecord()
  const expiredScopeState = decodedScopeState({ effectiveClock: { highWaterMarkMs: 4_500 } })
  const staged = reduceDurableCustodyState(custodyState(record, expiredScopeState), {
    kind: 'verified-result-staged',
    resultHandle: 'result-001',
    resultFingerprint: FINGERPRINT_A,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    ...ownerAuthorization,
  })
  const decision = decideDurableCustodyRecovery(staged.operation, staged.scopeState, {
    ...ownerAuthorization,
    classification: 'all-inputs-unspent',
    scopeId: staged.operation.scope.scopeId,
    operationId: staged.operation.operation.operationId,
    requestFingerprint: staged.operation.operation.exactRequest.requestFingerprint,
    outputPlanFingerprint: staged.operation.operation.outputPlan.outputPlanFingerprint,
  })
  assert.deepEqual(decision, {
    kind: 'reconcile-exact-operation',
    reason: 'verified-result-staged',
    exact: exactReference(staged.operation),
  })
  assert.throws(
    () => reduceDurableCustodyState(staged, {
      kind: 'abort-no-transport',
      ...ownerAuthorization,
      classification: 'all-inputs-unspent',
    }),
    /abort is not eligible/,
  )
  assert.equal(
    reduceDurableCustodyState(staged, {
      kind: 'reconciled',
      recoverySource: 'verified-result-staged',
      ...ownerAuthorization,
    }).operation.operation.state,
    'reconciled',
  )
})

test('abort is limited to expired dispatch intent without a dependency or outbox', () => {
  const record = decodedRecord()
  const expiredScopeState = decodedScopeState({ effectiveClock: { highWaterMarkMs: 4_500 } })
  const aborted = reduceDurableCustodyState(custodyState(record, expiredScopeState), {
    kind: 'abort-no-transport',
    ...ownerAuthorization,
    classification: 'all-inputs-unspent',
  })
  assert.equal(aborted.operation.operation.state, 'aborted')

  const dependent = structuredClone(record)
  ;(dependent.operation.sessionLink as { hasDependentOperation: boolean }).hasDependentOperation = true
  assert.throws(
    () => reduceDurableCustodyState(custodyState(dependent, expiredScopeState), {
      kind: 'abort-no-transport',
      ...ownerAuthorization,
      classification: 'all-inputs-unspent',
    }),
    /abort is not eligible/,
  )

  const outboxed = structuredClone(record)
  outboxed.operation.delivery = {
    deliveryKind: 'outbox',
    deliveryId: 'delivery-001',
    payloadHandle: 'delivery-payload-001',
    payloadFingerprint: FINGERPRINT_A,
    expiresAtMs: 5_000,
    state: 'pending',
  }
  assert.throws(
    () => reduceDurableCustodyState(custodyState(outboxed, expiredScopeState), {
      kind: 'abort-no-transport',
      ...ownerAuthorization,
      classification: 'all-inputs-unspent',
    }),
    /abort is not eligible/,
  )
})

test('terminal tombstones retain until terminal status and replay cutoff are authenticated', () => {
  const transported = reduceDurableCustodyState(custodyState(), {
    kind: 'transport-attempted',
    ...ownerAuthorization,
  })
  const staged = reduceDurableCustodyState(transported, {
    kind: 'verified-result-staged',
    resultHandle: 'result-001',
    resultFingerprint: FINGERPRINT_A,
    outputPlanFingerprint: transported.operation.operation.outputPlan.outputPlanFingerprint,
    ...ownerAuthorization,
  })
  const reconciled = reduceDurableCustodyState(
    staged,
    { kind: 'reconciled', recoverySource: 'transport-attempted', ...ownerAuthorization },
  )
  const pendingDelivery = structuredClone(reconciled)
  pendingDelivery.operation.operation.delivery = {
    deliveryKind: 'outbox',
    deliveryId: 'delivery-001',
    payloadHandle: 'delivery-payload-001',
    payloadFingerprint: FINGERPRINT_A,
    expiresAtMs: 5_000,
    state: 'pending',
  }
  assert.throws(
    () => reduceDurableCustodyState(pendingDelivery, {
      kind: 'terminal-tombstone-created',
      ...ownerAuthorization,
      tombstoneId: 'tombstone-pending-delivery',
    }),
    /terminal tombstone requires resolved delivery/,
  )
  const prematurelyExpiredDelivery = structuredClone(reconciled)
  prematurelyExpiredDelivery.operation.operation.delivery = {
    deliveryKind: 'outbox',
    deliveryId: 'delivery-002',
    payloadHandle: 'delivery-payload-002',
    payloadFingerprint: FINGERPRINT_A,
    expiresAtMs: 5_000,
    state: 'expired',
  }
  assert.throws(
    () => reduceDurableCustodyState(prematurelyExpiredDelivery, {
      kind: 'terminal-tombstone-created',
      ...ownerAuthorization,
      tombstoneId: 'tombstone-premature-delivery',
    }),
    /delivery expiry is premature/,
  )
  assert.throws(
    () => reduceDurableCustodyState(pendingDelivery, {
      kind: 'delivery-resolved',
      deliveryState: 'expired',
      ...ownerAuthorization,
    }),
    /delivery expiry is premature/,
  )
  const expiredDelivery = reduceDurableCustodyState(pendingDelivery, {
    kind: 'delivery-resolved',
    deliveryState: 'expired',
    ...ownerAuthorization,
    observedAtMs: 5_000,
  })
  assert.equal(expiredDelivery.operation.operation.delivery.state, 'expired')
  const tombstoned = reduceDurableCustodyState(reconciled, {
    kind: 'terminal-tombstone-created',
    ...ownerAuthorization,
    tombstoneId: 'tombstone-001',
  })

  assert.deepEqual(decideTerminalTombstoneDrain(tombstoned.operation, tombstoned.scopeState), { kind: 'retain' })
  const confirmed = reduceDurableCustodyState(tombstoned, {
    kind: 'terminal-tombstone-confirmed',
    ...ownerAuthorization,
    authenticatedTradeId: 'trade-001',
  })
  assert.deepEqual(decideTerminalTombstoneDrain(confirmed.operation, confirmed.scopeState), { kind: 'delete' })
})

test('impossible tombstone lifecycle records fail closed before replay protection can drain', () => {
  const corrupt = custodyRecord({
    terminalTombstone: {
      tombstoneId: 'tombstone-001',
      tradeId: 'trade-001',
      authenticatedTerminalStatus: true,
      replayCutoffObserved: true,
    },
  })
  assert.throws(
    () => decodeDurableCustodyRecord(corrupt),
    /terminal tombstone lifecycle is invalid/,
  )
  assert.throws(
    () => decideTerminalTombstoneDrain(corrupt as unknown as DurableCustodyRecord, decodedScopeState()),
    /terminal tombstone lifecycle is invalid/,
  )
})
