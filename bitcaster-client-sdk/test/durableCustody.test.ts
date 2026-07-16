import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  acknowledgeDurableCustodyWalletSendHandoff,
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeState,
  decodeDurableCustodyTransactionOperationIds,
  applyDurableCustodyTransaction,
  classifyDurableCustodyWalletStorageBoundary,
  claimDurableCustodyScope,
  createDurableCustodyDispatchIntent,
  createDurableProofOperationFacts,
  deriveDurableCustodyArtifactFingerprint,
  decideDurableCustodyRecovery,
  decideTerminalTombstoneDrain,
  isDurableCustodyActiveRecoveryRecord,
  isDurableCustodyProofReservationActive,
  readDurableCustodyRecoveryPage,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyKeysetFingerprint,
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  releaseDurableCustodyScope,
  renewDurableCustodyScope,
  validateDurableCustodyScopeRegistration,
  reduceDurableCustodyState,
  type DurableCustodyRecord,
  type DurableCustodyScopeState,
  type DurableCustodyState,
  DURABLE_CUSTODY_TRANSACTION_OPERATION_LIMIT_MAX,
} from '../src/durableCustody.ts'
import {
  classifyDurableBearerSpendCustodyHandoffPlan,
  createDurableBearerSpendDeliveryRecord,
  planDurableBearerSpendCustodyHandoff,
} from '../src/durableBearerSpendDelivery.ts'
import {
  classifyDurableRecipientDeliveryCustodyHandoffPlan,
  planDurableRecipientDeliveryCustodyHandoff,
} from '../src/durableRecipientDeliveryHandoff.ts'
import {
  createDurableRecipientDeliveryRecord,
  decodeDurableRecipientDeliveryRecord,
  reduceDurableRecipientDelivery,
} from '../src/durableRecipientDelivery.ts'
import {
  createDurableOutgoingRecipientDeliveryRecord,
  decodeDurableOutgoingRecipientDeliveryRecord,
} from '../src/durableOutgoingRecipientDelivery.ts'
import {
  prepareDurableWalletSendDelivery,
} from '../src/durableWalletSendDeliveryPreparation.ts'
import {
  planDurableWalletSendExactPayload,
} from '../src/durableWalletSendExactPayload.ts'
import {
  createRecipientCustodyState,
  createRecipientDeliveryFixture,
} from './durableRecipientDeliveryFixture.ts'

const FINGERPRINT_A = 'a'.repeat(64)
const FINGERPRINT_B = 'b'.repeat(64)
const SECP_PUBLIC_KEY_A = `02${'11'.repeat(32)}`
const SECP_PUBLIC_KEY_B = `03${'22'.repeat(32)}`

function profileScope() {
  const scope = {
    scopeKind: 'wallet' as const,
    walletId: FINGERPRINT_A,
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

test('custody transaction operation access is exact and bounded', () => {
  assert.deepEqual(
    decodeDurableCustodyTransactionOperationIds(['operation-a', 'operation-b']),
    ['operation-a', 'operation-b'],
  )
  assert.deepEqual(decodeDurableCustodyTransactionOperationIds([]), [])
  assert.throws(
    () => decodeDurableCustodyTransactionOperationIds(['operation-a', 'operation-a']),
    /operation id is duplicated/,
  )
  assert.throws(
    () => decodeDurableCustodyTransactionOperationIds(Array.from(
      { length: DURABLE_CUSTODY_TRANSACTION_OPERATION_LIMIT_MAX + 1 },
      (_, index) => `operation-${index}`,
    )),
    /operation limit is exceeded/,
  )
})

test('exact proof facts bind real public keys and explicit keyset usage', () => {
  const binding = {
    kind: 'wallet' as const,
    activityId: 'wallet-send-001',
    stage: 'send' as const,
  }
  const facts = createDurableProofOperationFacts({
    unit: 'sat',
    binding,
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 250 },
    hasOutputs: true,
    inputKeysetRequirement: 'required',
    keysets: [
      {
        keysetId: '0011223344556677',
        unit: 'sat',
        curve: 'secp256k1',
        publicKeys: { '2': SECP_PUBLIC_KEY_B, '1': SECP_PUBLIC_KEY_A },
        keysetExpiryMs: 20_000,
        requireDleq: false,
        usedByInputs: true,
        usedByOutputs: true,
      },
    ],
  })

  assert.deepEqual(facts.binding, binding)
  assert.equal(facts.horizon.keysetExpiryMs, 20_000)
  assert.deepEqual(facts.verification.inputKeysets, [
    { keysetId: '0011223344556677', curve: 'secp256k1' },
  ])
  assert.deepEqual(facts.verification.outputKeysets, facts.verification.inputKeysets)
  assert.equal(facts.verification.keysetBindings[0]?.requireDleq, false)
  assert.equal(
    facts.verification.keysetBindings[0]?.keysetFingerprint,
    deriveDurableCustodyKeysetFingerprint({
      keysetId: '0011223344556677',
      unit: 'sat',
      curve: 'secp256k1',
      publicKeys: { '1': SECP_PUBLIC_KEY_A, '2': SECP_PUBLIC_KEY_B },
    }),
  )
})

test('dispatch intent binds the exact operation artifacts through SDK policy', () => {
  const scope = profileScope()
  const binding = {
    kind: 'wallet' as const,
    activityId: 'wallet-send-001',
    stage: 'send' as const,
  }
  const facts = createDurableProofOperationFacts({
    unit: 'sat',
    binding,
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: true,
    inputKeysetRequirement: 'required',
    keysets: [{
      keysetId: '0011223344556677',
      unit: 'sat',
      curve: 'secp256k1',
      publicKeys: { '1': SECP_PUBLIC_KEY_A },
      keysetExpiryMs: null,
      requireDleq: false,
      usedByInputs: true,
      usedByOutputs: true,
    }],
  })
  const record = createDurableCustodyDispatchIntent({
    scope,
    retainedOperationKey: 'wallet-send-001',
    semanticKind: 'generic-send',
    facts,
    normalizedMint: 'https://mint.example',
    inventoryAccountId: null,
    reservation: {
      reservationId: 'wallet-send-001',
      parentReservationId: null,
      inputs: [{
        proofId: FINGERPRINT_A,
        keysetId: '0011223344556677',
        curve: 'secp256k1',
      }],
    },
    exactRequest: {
      requestId: 'wallet-send-001',
      requestFingerprint: FINGERPRINT_A,
      payloadHandle: 'wallet-send-request-001',
      inputProofIds: [FINGERPRINT_A],
      outputPlanFingerprint: FINGERPRINT_B,
    },
    outputPlan: {
      outputPlanId: 'wallet-send-output-001',
      outputPlanFingerprint: FINGERPRINT_B,
      outputMaterialHandle: 'wallet-send-output-material-001',
    },
    privateMaterial: {
      materialHandle: 'wallet-send-private-material-001',
      useId: 'wallet-send-001/send',
      publicFingerprint: FINGERPRINT_A,
    },
  })

  assert.equal(record.operation.state, 'dispatch-intent')
  assert.equal(record.operation.terminalReplayEvidenceRequired, false)
  assert.deepEqual(record.operation.binding, binding)
  assert.deepEqual(record.operation.exactRequest.inputProofIds, [FINGERPRINT_A])
  assert.equal(record.operation.verification.outputPlanFingerprint, FINGERPRINT_B)
  assert.equal(
    record.operation.operationId,
    deriveDurableCustodyOperationId(scope.scopeId, {
      retainedOperationKey: 'wallet-send-001',
      binding,
    }),
  )
})

test('exact proof facts reject missing authority and verification policy', () => {
  const base = {
    unit: 'sat',
    binding: {
      kind: 'wallet' as const,
      activityId: 'wallet-send-001',
      stage: 'send' as const,
    },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: true,
    inputKeysetRequirement: 'required' as const,
    keysets: [
      {
        keysetId: '0011223344556677',
        unit: 'sat',
        curve: 'secp256k1' as const,
        publicKeys: { '1': SECP_PUBLIC_KEY_A },
        keysetExpiryMs: null,
        requireDleq: true,
        usedByInputs: true,
        usedByOutputs: false,
      },
    ],
  }
  assert.throws(
    () => createDurableProofOperationFacts(base),
    /output keysets must not be empty/,
  )
  const zeroOutput = createDurableProofOperationFacts({
    ...base,
    hasOutputs: false,
  })
  assert.equal(zeroOutput.verification.hasOutputs, false)
  assert.deepEqual(zeroOutput.verification.outputKeysets, [])
  assert.throws(
    () => createDurableProofOperationFacts({
      ...base,
      inputKeysetRequirement: 'none',
    }),
    /input keysets do not match/,
  )
  assert.throws(
    () => createDurableProofOperationFacts({
      ...base,
      keysets: [{ ...base.keysets[0]!, unit: 'usd', usedByOutputs: true }],
    }),
    /keyset unit does not match/,
  )
  assert.throws(
    () => createDurableProofOperationFacts({
      ...base,
      keysets: [{
        ...base.keysets[0]!,
        publicKeys: { '1': 'keyset-id-is-not-a-public-key' },
        usedByOutputs: true,
      }],
    }),
    /keyset public key is invalid/,
  )
})

test('artifact fingerprints are canonical and reject ambiguous JSON values', () => {
  assert.equal(
    deriveDurableCustodyArtifactFingerprint({ b: [2, 3], a: 1 }),
    deriveDurableCustodyArtifactFingerprint({ a: 1, b: [2, 3] }),
  )
  assert.notEqual(
    deriveDurableCustodyArtifactFingerprint({ a: 1 }),
    deriveDurableCustodyArtifactFingerprint({ a: 2 }),
  )
  assert.throws(
    () => deriveDurableCustodyArtifactFingerprint({ missing: undefined }),
    /artifact is invalid/,
  )
})

function custodyRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const scope = profileScope()
  const identity = {
    retainedOperationKey: 'seller-lock-001',
    binding: {
      kind: 'trade' as const,
      tradeId: 'trade-001',
      role: 'seller' as const,
      stage: 'lock' as const,
    },
  }
  const operationId = deriveDurableCustodyOperationId(scope.scopeId, identity)
  return {
    schemaVersion: 1,
    revision: 0,
    scope,
    operation: {
      ...identity,
      binding: {
        ...identity.binding,
        sessionId: 'session-001',
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
        reservationId: 'reservation-001',
        parentReservationId: null,
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
    ...overrides,
  }
}

function decodedRecord(overrides: Record<string, unknown> = {}): DurableCustodyRecord {
  return decodeDurableCustodyRecord(custodyRecord(overrides))
}

function decodedWalletRecord(): DurableCustodyRecord {
  const raw = custodyRecord()
  const operation = raw.operation as Record<string, unknown>
  operation.binding = {
    kind: 'wallet',
    activityId: 'wallet-send-001',
    stage: 'send',
  }
  operation.semanticKind = 'wallet-send'
  operation.horizon = {
    notBeforeMs: null,
    notAfterMs: null,
    safetyMarginMs: 0,
    keysetExpiryMs: null,
  }
  operation.terminalReplayEvidenceRequired = false
  operation.operationId = operationIdFor(profileScope().scopeId, operation)
  return decodeDurableCustodyRecord(raw)
}

function operationIdFor(
  scopeId: string,
  operation: Record<string, unknown>,
): string {
  const binding = operation.binding as DurableCustodyRecord['operation']['binding']
  const identityBinding = binding.kind === 'trade'
    ? {
        kind: binding.kind,
        tradeId: binding.tradeId,
        role: binding.role,
        stage: binding.stage,
      }
    : {
        kind: binding.kind,
        activityId: binding.activityId,
        stage: binding.stage,
      }
  return deriveDurableCustodyOperationId(scopeId, {
    retainedOperationKey: operation.retainedOperationKey as string,
    binding: identityBinding,
  })
}

function custodyScopeState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    scope: profileScope(),
    fencingEpoch: 7,
    owner: {
      incarnationId: 'worker-001',
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

function recipientDeliveryFixture() {
  const exact = createRecipientDeliveryFixture()
  const pendingCustody = createRecipientCustodyState(exact)
  const outgoingRecipient = createDurableOutgoingRecipientDeliveryRecord({
    exactPayload: exact.exactPayload,
  })
  const pendingRecipient = outgoingRecipient.delivery
  const creditedEvidence = {
    kind: 'credited' as const,
    request: pendingRecipient.request,
    receiptOperationId:
      `score-receipt/${pendingRecipient.request.deliveryId}`,
    receivedAtMs: 2_000,
    creditedAmount: '1',
    creditVerification: { kind: 'exact-amount' as const },
    businessEventId: pendingRecipient.request.deliveryId,
    creditedAtMs: 2_000,
  }
  return {
    custodyState: pendingCustody,
    ...exact,
    outgoingRecipient,
    pendingRecipient,
    creditedEvidence,
    creditedRecipient: reduceDurableRecipientDelivery(
      pendingRecipient,
      creditedEvidence,
    ),
  }
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
  incarnationId: 'worker-001',
  fencingEpoch: 7,
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
        scopeKind: 'wallet' as const,
        walletId: FINGERPRINT_B,
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

test('wallet storage boundaries distinguish new effects from reconciliation', () => {
  const prepared = decodedWalletRecord()
  assert.equal(
    classifyDurableCustodyWalletStorageBoundary({
      previous: null,
      next: prepared,
    }),
    'new-effect',
  )

  const submitted = reduceDurableCustodyState(
    custodyState(prepared),
    { kind: 'transport-attempted', ...ownerAuthorization },
  ).operation
  assert.equal(
    classifyDurableCustodyWalletStorageBoundary({
      previous: prepared,
      next: submitted,
    }),
    'new-effect',
  )

  const staged = reduceDurableCustodyState(
    custodyState(submitted),
    {
      kind: 'verified-result-staged',
      resultHandle: 'result-001',
      resultFingerprint: FINGERPRINT_A,
      outputPlanFingerprint:
        submitted.operation.outputPlan.outputPlanFingerprint,
      ...ownerAuthorization,
    },
  )
  const reconciled = reduceDurableCustodyState(staged, {
    kind: 'reconciled',
    recoverySource: 'transport-attempted',
    ...ownerAuthorization,
  }).operation
  assert.equal(
    classifyDurableCustodyWalletStorageBoundary({
      previous: submitted,
      next: reconciled,
    }),
    'reconciliation-only',
  )

  const pendingDelivery = structuredClone(reconciled)
  pendingDelivery.operation.delivery = {
    deliveryKind: 'outbox',
    deliveryId: `delivery:${reconciled.operation.operationId}:wallet-send`,
    payloadHandle: 'wallet-send-001',
    payloadFingerprint: FINGERPRINT_A,
    expiresAtMs: null,
    state: 'pending',
  }
  assert.equal(
    classifyDurableCustodyWalletStorageBoundary({
      previous: submitted,
      next: pendingDelivery,
    }),
    'reconciliation-only',
  )
  const acknowledgedDelivery = structuredClone(pendingDelivery)
  acknowledgedDelivery.operation.delivery.state = 'acknowledged'
  assert.throws(
    () =>
      classifyDurableCustodyWalletStorageBoundary({
        previous: pendingDelivery,
        next: acknowledgedDelivery,
      }),
    /composite authority/,
  )
})

test('only wallet-send delivery may be non-expiring and it can never expire', () => {
  const walletSend = decodedWalletRecord()
  const submitted = reduceDurableCustodyState(custodyState(walletSend), {
    kind: 'transport-attempted',
    ...ownerAuthorization,
  }).operation
  const staged = reduceDurableCustodyState(custodyState(submitted), {
    kind: 'verified-result-staged',
    resultHandle: 'result-001',
    resultFingerprint: FINGERPRINT_A,
    outputPlanFingerprint: submitted.operation.outputPlan.outputPlanFingerprint,
    ...ownerAuthorization,
  })
  const reconciled = reduceDurableCustodyState(staged, {
    kind: 'reconciled',
    recoverySource: 'transport-attempted',
    ...ownerAuthorization,
  }).operation
  const pending = structuredClone(reconciled)
  pending.operation.delivery = {
    deliveryKind: 'outbox',
    deliveryId: `delivery:${pending.operation.operationId}:wallet-send`,
    payloadHandle: 'wallet-send-001',
    payloadFingerprint: FINGERPRINT_A,
    expiresAtMs: null,
    state: 'pending',
  }
  assert.equal(
    decodeDurableCustodyRecord(pending).operation.delivery.expiresAtMs,
    null,
  )

  const expired = structuredClone(pending)
  expired.operation.delivery.state = 'expired'
  assert.throws(
    () => decodeDurableCustodyRecord(expired),
    /non-expiring delivery cannot be expired/,
  )
  assert.throws(
    () => reduceDurableCustodyState(custodyState(pending), {
      kind: 'delivery-resolved',
      deliveryState: 'expired',
      ...ownerAuthorization,
    }),
    /closed terminal decision/,
  )
  assert.throws(
    () => reduceDurableCustodyState(custodyState(pending), {
      kind: 'delivery-resolved',
      deliveryState: 'acknowledged',
      ...ownerAuthorization,
    }),
    /closed terminal decision/,
  )

  const userExport = createRecipientDeliveryFixture({
    policy: { kind: 'user-export' },
  })
  const userExportCustody = createRecipientCustodyState(userExport)
  const delivery = userExportCustody.operation.operation.delivery
  if (
    delivery.deliveryKind !== 'outbox' ||
    delivery.deliveryId === null ||
    delivery.payloadHandle === null
  ) {
    throw new Error('missing exact user-export delivery')
  }
  const proof = userExport.resultGroups.send[0]!
  const bearer = createDurableBearerSpendDeliveryRecord({
    deliveryId: delivery.deliveryId,
    walletId: profileScope().walletId,
    parentOperationId: userExportCustody.operation.operation.operationId,
    payloadHandle: delivery.payloadHandle,
    mintUrl: 'https://mint.example',
    unit: 'sat',
    encodedToken: userExport.encodedToken,
    proofs: [proof],
    origin: 'local',
    createdAtMs: 1_000,
  })
  const previousCustodyState = userExportCustody
  const handoff = planDurableBearerSpendCustodyHandoff({
    bearerRecord: bearer,
    custodyState: previousCustodyState,
    exactPayload: userExport.exactPayload,
    authorization: ownerAuthorization,
  })
  assert.equal(
    handoff.custodyState.operation.operation.delivery.state,
    'acknowledged',
  )
  assert.equal(handoff.bearerRecord.walletId, profileScope().walletId)
  assert.equal(
    classifyDurableBearerSpendCustodyHandoffPlan({
      previousCustodyState,
      plan: handoff,
    }),
    'reconciliation-only',
  )
  assert.throws(
    () =>
      classifyDurableBearerSpendCustodyHandoffPlan({
        previousCustodyState,
        plan: structuredClone(handoff),
      }),
    /handoff plan is invalid/,
  )
  for (const bearerRecord of [
    { ...bearer, walletId: 'wallet-foreign' },
    { ...bearer, mintUrl: 'https://foreign-mint.example' },
    { ...bearer, unit: 'usd' },
  ]) {
    assert.throws(
      () =>
        planDurableBearerSpendCustodyHandoff({
          bearerRecord,
          custodyState: userExportCustody,
          exactPayload: userExport.exactPayload,
          authorization: ownerAuthorization,
        }),
      /handoff authority is invalid|custody policy is invalid/,
    )
  }
  assert.throws(
    () => acknowledgeDurableCustodyWalletSendHandoff(userExportCustody, {
      capability: {
        kind: 'durable-bearer-custody-handoff',
      },
      ...ownerAuthorization,
    }),
    /handoff authority is invalid/,
  )

  const foreignPolicy = structuredClone(pending)
  foreignPolicy.operation.delivery.deliveryId =
    `delivery:${pending.operation.operationId}:settlement`
  assert.throws(
    () => decodeDurableCustodyRecord(foreignPolicy),
    /non-expiring delivery policy is invalid/,
  )

  const expiringWalletSend = structuredClone(pending)
  expiringWalletSend.operation.delivery.expiresAtMs = 5_000
  assert.throws(
    () => decodeDurableCustodyRecord(expiringWalletSend),
    /wallet-send delivery must be non-expiring/,
  )

  const unknownDelivery = structuredClone(pending)
  unknownDelivery.operation.delivery.deliveryId =
    `delivery:${pending.operation.operationId}:unknown`
  unknownDelivery.operation.delivery.expiresAtMs = 5_000
  assert.throws(
    () => decodeDurableCustodyRecord(unknownDelivery),
    /delivery identity is invalid/,
  )

  const foreignSemantic = structuredClone(pending)
  foreignSemantic.operation.semanticKind = 'generic-send'
  assert.throws(
    () => decodeDurableCustodyRecord(foreignSemantic),
    /wallet-send delivery authority is invalid/,
  )
})

test('terminal recipient evidence closes only the exact durable wallet-send authority', () => {
  const fixture = recipientDeliveryFixture()
  const plan = planDurableRecipientDeliveryCustodyHandoff({
    exactPayload: fixture.exactPayload,
    custodyState: fixture.custodyState,
    outgoingRecipient: fixture.outgoingRecipient,
    evidence: fixture.creditedEvidence,
    authorization: ownerAuthorization,
  })

  assert.equal(
    plan.custodyState.operation.operation.delivery.state,
    'acknowledged',
  )
  assert.equal(plan.recipientRecord.state.kind, 'credited')
  assert.equal(
    classifyDurableRecipientDeliveryCustodyHandoffPlan({
      previousCustodyState: fixture.custodyState,
      plan,
    }),
    'reconciliation-only',
  )

  const terminalRecordPlan = planDurableRecipientDeliveryCustodyHandoff({
    exactPayload: fixture.exactPayload,
    custodyState: fixture.custodyState,
    outgoingRecipient: {
      ...fixture.outgoingRecipient,
      delivery: fixture.creditedRecipient,
    },
    authorization: ownerAuthorization,
  })
  assert.equal(
    terminalRecordPlan.custodyState.operation.operation.delivery.state,
    'acknowledged',
  )
})

test('recipient handoff accepts only verified net-of-receive-fee credit', () => {
  const exact = createRecipientDeliveryFixture({
    amount: 5,
    policy: {
      kind: 'durable-recipient-ack',
      recipient: {
        deliveryId: 'deposit-1',
        accountSubject: 'account:alice',
        recipientKind: 'matching-engine',
        purpose: 'market-funding',
        destinationId: 'market-1',
        mintUrl: 'https://mint.example',
        unit: 'sat',
        requestedAmount: '5',
        creditPolicy: {
          kind: 'net-of-receive-fee',
        },
      },
    },
  })
  const outgoingRecipient = createDurableOutgoingRecipientDeliveryRecord({
    exactPayload: exact.exactPayload,
  })
  const evidence = {
    kind: 'credited' as const,
    request: outgoingRecipient.delivery.request,
    receiptOperationId: 'market-receipt/deposit-1',
    receivedAtMs: 2_000,
    creditedAmount: '4',
    creditVerification: {
      kind: 'net-of-receive-fee' as const,
      receiveFeeAmount: '1',
    },
    businessEventId: 'deposit-1',
    creditedAtMs: 2_000,
  }
  const custodyState = createRecipientCustodyState(exact)

  const plan = planDurableRecipientDeliveryCustodyHandoff({
    exactPayload: exact.exactPayload,
    custodyState,
    outgoingRecipient,
    evidence,
    authorization: ownerAuthorization,
  })
  assert.equal(
    plan.custodyState.operation.operation.delivery.state,
    'acknowledged',
  )

  assert.throws(
    () =>
      planDurableRecipientDeliveryCustodyHandoff({
        exactPayload: exact.exactPayload,
        custodyState,
        outgoingRecipient,
        evidence: {
          ...evidence,
          creditVerification: {
            kind: 'net-of-receive-fee',
            receiveFeeAmount: '2',
          },
        },
        authorization: ownerAuthorization,
      }),
    /net recipient credit verification is invalid/,
  )
})

test('recipient custody restart preserves canonical wallet and delivery identity', () => {
  const fixture = recipientDeliveryFixture()
  assert.equal(
    fixture.walletOperation.operationId,
    fixture.custodyState.operation.operation.retainedOperationKey,
  )
  assert.notEqual(
    fixture.walletOperation.operationId,
    fixture.custodyState.operation.operation.operationId,
  )

  const walletOperation = structuredClone(fixture.walletOperation)
  const preparation = prepareDurableWalletSendDelivery({
    walletOperation,
    policy: structuredClone(fixture.preparation.policy),
    admission: structuredClone(fixture.preparation.admission),
  })
  const exactPayload = planDurableWalletSendExactPayload({
    preparation,
    walletOperation,
    resultGroups: fixture.resultGroups,
    payloadHandle: fixture.exactPayload.payloadHandle,
    encodedToken: fixture.encodedToken,
  })
  const custodyState = {
    operation: decodeDurableCustodyRecord(
      structuredClone(fixture.custodyState.operation),
    ),
    scopeState: decodeDurableCustodyScopeState(
      structuredClone(fixture.custodyState.scopeState),
    ),
  }
  const recipientRecord = decodeDurableRecipientDeliveryRecord(
    structuredClone(fixture.creditedRecipient),
  )
  const outgoingRecipient =
    decodeDurableOutgoingRecipientDeliveryRecord({
      ...structuredClone(fixture.outgoingRecipient),
      delivery: recipientRecord,
    })
  const plan = planDurableRecipientDeliveryCustodyHandoff({
    exactPayload,
    custodyState,
    outgoingRecipient,
    authorization: ownerAuthorization,
  })
  assert.equal(
    plan.custodyState.operation.operation.delivery.state,
    'acknowledged',
  )
})

test('wallet-send custody handoff capabilities cannot cross delivery policies', () => {
  const recipient = recipientDeliveryFixture()
  const userExport = createRecipientDeliveryFixture({
    policy: { kind: 'user-export' },
  })
  const userExportCustody = createRecipientCustodyState(userExport)
  const delivery = userExportCustody.operation.operation.delivery
  if (
    delivery.deliveryKind !== 'outbox' ||
    delivery.deliveryId === null ||
    delivery.payloadHandle === null
  ) {
    throw new Error('missing exact user-export delivery')
  }
  const bearer = createDurableBearerSpendDeliveryRecord({
    deliveryId: delivery.deliveryId,
    walletId: profileScope().walletId,
    parentOperationId: userExportCustody.operation.operation.operationId,
    payloadHandle: delivery.payloadHandle,
    mintUrl: userExport.exactPayload.mintUrl,
    unit: userExport.exactPayload.unit,
    encodedToken: userExport.encodedToken,
    proofs: userExport.resultGroups.send,
    origin: 'local',
    createdAtMs: 1_000,
  })
  assert.throws(
    () =>
      planDurableBearerSpendCustodyHandoff({
        bearerRecord: bearer,
        custodyState: userExportCustody,
        exactPayload: recipient.exactPayload,
        authorization: ownerAuthorization,
      }),
    /custody policy is invalid/,
  )
  assert.throws(
    () =>
      planDurableRecipientDeliveryCustodyHandoff({
        exactPayload: userExport.exactPayload,
        custodyState: recipient.custodyState,
        outgoingRecipient: {
          ...recipient.outgoingRecipient,
          delivery: recipient.creditedRecipient,
        },
        authorization: ownerAuthorization,
      }),
    /policy|conflicts/,
  )
})

test('recipient custody closure rejects delivery, token, mint, unit, and amount substitution', () => {
  const fixture = recipientDeliveryFixture()
  for (const [field, replacement] of [
    ['deliveryId', 'payment-foreign'],
    ['tokenDigest', FINGERPRINT_B],
    ['mintUrl', 'https://foreign-mint.example'],
    ['unit', 'usd'],
    ['requestedAmount', '2'],
    ['accountSubject', 'account:bob'],
    ['recipientKind', 'other-service'],
    ['purpose', 'market-funding'],
    ['destinationId', 'market-2'],
    ['encodedTokenBytes', 999],
  ] as const) {
    const request = {
      ...fixture.pendingRecipient.request,
      [field]: replacement,
    }
    assert.throws(
      () =>
        planDurableRecipientDeliveryCustodyHandoff({
          exactPayload: fixture.exactPayload,
          custodyState: fixture.custodyState,
          outgoingRecipient: {
            ...fixture.outgoingRecipient,
            delivery: {
              ...fixture.pendingRecipient,
              request,
            },
          },
          evidence: {
            ...fixture.creditedEvidence,
            request,
            creditedAmount:
              field === 'requestedAmount'
                ? replacement
                : fixture.creditedEvidence.creditedAmount,
          },
          authorization: ownerAuthorization,
        }),
      /authority|conflicts|amount/,
      field,
    )
  }
})

test('wallet storage boundaries reject trade and foreign exact authority', () => {
  const wallet = decodedWalletRecord()
  assert.throws(
    () =>
      classifyDurableCustodyWalletStorageBoundary({
        previous: null,
        next: decodedRecord(),
      }),
    /cannot adopt trade custody/,
  )
  const foreign = structuredClone(wallet)
  foreign.operation.exactRequest.requestFingerprint = FINGERPRINT_B
  assert.throws(
    () =>
      classifyDurableCustodyWalletStorageBoundary({
        previous: wallet,
        next: foreign,
      }),
    /foreign exact authority/,
  )
  const foreignHorizon = structuredClone(wallet)
  foreignHorizon.operation.horizon.safetyMarginMs = 1
  assert.throws(
    () =>
      classifyDurableCustodyWalletStorageBoundary({
        previous: wallet,
        next: foreignHorizon,
      }),
    /foreign exact authority/,
  )
  const pendingDelivery = structuredClone(wallet)
  pendingDelivery.operation.delivery = {
    deliveryKind: 'outbox',
    deliveryId: `delivery:${wallet.operation.operationId}:wallet-send`,
    payloadHandle: 'wallet-send-001',
    payloadFingerprint: FINGERPRINT_A,
    expiresAtMs: null,
    state: 'pending',
  }
  const foreignDelivery = structuredClone(pendingDelivery)
  foreignDelivery.operation.delivery.payloadFingerprint = FINGERPRINT_B
  foreignDelivery.operation.delivery.state = 'acknowledged'
  assert.throws(
    () =>
      classifyDurableCustodyWalletStorageBoundary({
        previous: pendingDelivery,
        next: foreignDelivery,
      }),
    /foreign delivery authority/,
  )

  const foreignPendingDelivery = structuredClone(wallet)
  foreignPendingDelivery.operation.delivery = {
    deliveryKind: 'outbox',
    deliveryId: `delivery:${wallet.operation.operationId}:settlement`,
    payloadHandle: 'settlement-001',
    payloadFingerprint: FINGERPRINT_A,
    expiresAtMs: 5_000,
    state: 'pending',
  }
  assert.throws(
    () =>
      classifyDurableCustodyWalletStorageBoundary({
        previous: wallet,
        next: foreignPendingDelivery,
      }),
    /foreign delivery authority/,
  )
})

test('custody scope registration starts unowned and claims advance a shared fencing epoch', () => {
  const unowned = decodeDurableCustodyScopeState({
    schemaVersion: 1,
    scope: profileScope(),
    fencingEpoch: 0,
    owner: null,
    effectiveClock: { highWaterMarkMs: 1_000 },
  })
  const claimed = claimDurableCustodyScope(unowned, {
    kind: 'owner-claimed',
    nextIncarnationId: 'worker-001',
    nextFencingEpoch: 1,
    observedAtMs: 1_500,
    nextLeaseExpiresAtMs: 2_000,
  })
  assert.deepEqual(claimed.owner, {
    incarnationId: 'worker-001',
    leaseExpiresAtMs: 2_000,
  })
  assert.equal(claimed.fencingEpoch, 1)
  assert.equal(claimed.effectiveClock.highWaterMarkMs, 1_500)
  assert.throws(
    () => claimDurableCustodyScope(claimed, {
      kind: 'owner-claimed',
      nextIncarnationId: 'worker-002',
      nextFencingEpoch: 2,
      observedAtMs: 1_600,
      nextLeaseExpiresAtMs: 3_000,
    }),
    /custody owner lease has not expired/,
  )
})

test('wallet scope identity is seed-derived and independent of authentication identity', () => {
  const seed = new Uint8Array(32).fill(7)
  const walletId = deriveDurableCustodyWalletId(seed)
  assert.equal(walletId, deriveDurableCustodyWalletId(seed.slice()))
  assert.notEqual(walletId, deriveDurableCustodyWalletId(new Uint8Array(32).fill(8)))
  assert.match(walletId, /^[0-9a-f]{64}$/)
  assert.throws(
    () => deriveDurableCustodyWalletId(new Uint8Array(31)),
    /32 or 64 bytes/,
  )
})

test('renew and release preserve the fencing epoch and reject stale owners', () => {
  const claimed = decodedScopeState()
  const renewed = renewDurableCustodyScope(claimed, {
    kind: 'owner-renewed',
    ...ownerAuthorization,
    nextLeaseExpiresAtMs: 20_000,
  })
  assert.equal(renewed.fencingEpoch, 7)
  assert.equal(renewed.owner?.leaseExpiresAtMs, 20_000)
  const released = releaseDurableCustodyScope(renewed, {
    kind: 'owner-released',
    ...ownerAuthorization,
    observedAtMs: 2_000,
  })
  assert.equal(released.fencingEpoch, 7)
  assert.equal(released.owner, null)
  const reclaimed = claimDurableCustodyScope(released, {
    kind: 'owner-claimed',
    nextIncarnationId: 'worker-002',
    nextFencingEpoch: 8,
    observedAtMs: 2_001,
    nextLeaseExpiresAtMs: 30_000,
  })
  assert.equal(reclaimed.fencingEpoch, 8)
  assert.throws(
    () => renewDurableCustodyScope(reclaimed, {
      kind: 'owner-renewed',
      ...ownerAuthorization,
      observedAtMs: 2_002,
      nextLeaseExpiresAtMs: 40_000,
    }),
    /custody owner epoch is foreign/,
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

test('global proof identity canonicalizes legacy Base64 padding and alphabet aliases', () => {
  const identity = (keysetId: string) => deriveDurableCustodyProofId({
    normalizedMint: 'https://mint.example',
    unit: 'sat',
    keysetId,
    secret: 'proof-secret-001',
  })
  assert.equal(identity('AQIDBA=='), identity('AQIDBA'))
  assert.equal(identity('+///'), identity('-___'))
  assert.throws(() => identity('+___'), /mixes Base64 alphabets/)
  const modern = `01${'ab'.repeat(32)}`
  assert.equal(identity(modern), deriveDurableCustodyProofId({
    normalizedMint: 'https://mint.example', unit: 'sat', keysetId: modern, secret: 'proof-secret-001',
  }))
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
  operation.operationId = operationIdFor(scope.scopeId, operation)
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

  const missingOutputKeysets = custodyRecord()
  ;((missingOutputKeysets.operation as Record<string, unknown>).verification as Record<string, unknown>)
    .outputKeysets = []
  assert.throws(
    () => decodeDurableCustodyRecord(missingOutputKeysets),
    /output keysets must not be empty/,
  )

  const foreignOutputKeyset = custodyRecord()
  ;((foreignOutputKeyset.operation as Record<string, unknown>).verification as Record<string, unknown>)
    .outputKeysets = [{ keysetId: 'foreign-keyset', curve: 'secp256k1' }]
  assert.throws(
    () => decodeDurableCustodyRecord(foreignOutputKeyset),
    /output keyset verification binding is invalid/,
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
  ;(refundOperation.binding as Record<string, unknown>).stage = 'refund'
  refundOperation.operationId = operationIdFor(profileScope().scopeId, refundOperation)
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
  genericWithoutHorizonOperation.terminalReplayEvidenceRequired = false
  genericWithoutHorizonOperation.binding = {
    kind: 'wallet',
    activityId: 'wallet-send-001',
    stage: 'send',
  }
  ;(genericWithoutHorizonOperation.horizon as Record<string, unknown>).notAfterMs = null
  genericWithoutHorizonOperation.operationId = operationIdFor(
    profileScope().scopeId,
    genericWithoutHorizonOperation,
  )
  assert.equal(decodeDurableCustodyRecord(genericWithoutHorizon).operation.semanticKind, 'generic-send')

  const tradeProofSplit = custodyRecord()
  const tradeProofSplitOperation = tradeProofSplit.operation as Record<string, unknown>
  tradeProofSplitOperation.semanticKind = 'generic-send'
  tradeProofSplitOperation.terminalReplayEvidenceRequired = false
  ;(tradeProofSplitOperation.binding as Record<string, unknown>).stage = 'send'
  tradeProofSplitOperation.horizon = {
    notBeforeMs: null,
    notAfterMs: null,
    safetyMarginMs: 0,
    keysetExpiryMs: null,
  }
  tradeProofSplitOperation.operationId = operationIdFor(
    profileScope().scopeId,
    tradeProofSplitOperation,
  )
  assert.equal(
    decodeDurableCustodyRecord(tradeProofSplit).operation.binding.kind,
    'trade',
  )

  const nonExpiringCtf = custodyRecord()
  const nonExpiringCtfOperation = nonExpiringCtf.operation as Record<string, unknown>
  nonExpiringCtfOperation.semanticKind = 'ctf-merge'
  nonExpiringCtfOperation.terminalReplayEvidenceRequired = false
  ;(nonExpiringCtfOperation.binding as Record<string, unknown>).stage = 'ctf-merge'
  ;(nonExpiringCtfOperation.horizon as Record<string, unknown>).notAfterMs = null
  ;(nonExpiringCtfOperation.horizon as Record<string, unknown>).keysetExpiryMs = null
  nonExpiringCtfOperation.operationId = operationIdFor(profileScope().scopeId, nonExpiringCtfOperation)
  assert.equal(decodeDurableCustodyRecord(nonExpiringCtf).operation.semanticKind, 'ctf-merge')

  const conditionalSwap = custodyRecord()
  ;(conditionalSwap.operation as Record<string, unknown>).semanticKind = 'conditional-keyset-swap'
  assert.equal(
    decodeDurableCustodyRecord(conditionalSwap).operation.semanticKind,
    'conditional-keyset-swap',
  )
})

test('terminal replay requirement is derived from semantic kind and contradictions fail closed', () => {
  const swap = custodyRecord()
  ;(swap.operation as Record<string, unknown>).terminalReplayEvidenceRequired = false
  assert.throws(() => decodeDurableCustodyRecord(swap), /terminal replay requirement is invalid/)

  const generic = custodyRecord()
  const operation = generic.operation as Record<string, unknown>
  operation.binding = { kind: 'wallet', activityId: 'wallet-send-001', stage: 'send' }
  operation.semanticKind = 'generic-send'
  operation.horizon = { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 500, keysetExpiryMs: null }
  operation.terminalReplayEvidenceRequired = true
  operation.operationId = operationIdFor(profileScope().scopeId, operation)
  assert.throws(() => decodeDurableCustodyRecord(generic), /terminal replay requirement is invalid/)

  operation.terminalReplayEvidenceRequired = false
  generic.terminalTombstone = {
    tombstoneId: 'tombstone-001',
    tradeId: 'trade-001',
    authenticatedTerminalStatus: false,
    replayCutoffObserved: false,
  }
  assert.throws(() => decodeDurableCustodyRecord(generic), /terminal tombstone is not permitted/)
})

test('dispatch authority advances the effective clock and a rollback cannot reopen a horizon', () => {
  const record = decodedRecord()
  const scopeState = decodedScopeState({ effectiveClock: { highWaterMarkMs: 4_500 } })
  const decision = decideDurableCustodyRecovery(record, scopeState, {
    ...ownerAuthorization,
    observedAtMs: 1_000,
    classification: 'all-inputs-unspent',
    exactRequestDisposition: 'deterministically-rejected',
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

test('expired all-unspent work cannot abort without deterministic pre-submission rejection', () => {
  const record = decodedRecord()
  const decision = decideDurableCustodyRecovery(
    record,
    decodedScopeState({ effectiveClock: { highWaterMarkMs: 4_500 } }),
    {
      ...ownerAuthorization,
      classification: 'all-inputs-unspent',
      exactRequestDisposition: 'unknown',
      scopeId: record.scope.scopeId,
      operationId: record.operation.operationId,
      requestFingerprint: record.operation.exactRequest.requestFingerprint,
      outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    },
  )
  assert.equal(decision.kind, 'reconcile-exact-operation')
})

test('deterministic pre-submission rejection permits safe abort independent of the dispatch horizon', () => {
  const record = decodedRecord()
  const decision = decideDurableCustodyRecovery(record, decodedScopeState(), {
    ...ownerAuthorization,
    classification: 'all-inputs-unspent',
    exactRequestDisposition: 'deterministically-rejected',
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    requestFingerprint: record.operation.exactRequest.requestFingerprint,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
  })
  assert.deepEqual(decision, { kind: 'abort-no-transport', effectiveNowMs: 1_500 })
})

test('a reissue decision carries only the immutable exact-operation reference', () => {
  const record = decodedRecord()
  const decision = decideDurableCustodyRecovery(record, decodedScopeState(), {
    ...ownerAuthorization,
    classification: 'all-inputs-unspent',
    exactRequestDisposition: 'not-rejected',
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
    exactRequestDisposition: 'not-rejected',
    scopeId: beforeWindow.scope.scopeId,
    operationId: beforeWindow.operation.operationId,
    requestFingerprint: beforeWindow.operation.exactRequest.requestFingerprint,
    outputPlanFingerprint: beforeWindow.operation.outputPlan.outputPlanFingerprint,
  })
  assert.deepEqual(waiting, { kind: 'retry-later', effectiveNowMs: 1_500 })

  const claimed = reduceDurableCustodyState(custodyState(), {
    kind: 'owner-claimed',
    observedAtMs: 10_000,
    nextIncarnationId: 'worker-002',
    nextFencingEpoch: 8,
    nextLeaseExpiresAtMs: 20_000,
  })
  assert.deepEqual(claimed.scopeState.owner, {
    incarnationId: 'worker-002',
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
    scopeKind: 'wallet' as const,
    walletId: FINGERPRINT_B,
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
  const unownedForeignScopeState = decodeDurableCustodyScopeState({
    ...custodyScopeState(),
    scope: { ...foreign, scopeId: deriveDurableCustodyScopeId(foreign) },
    owner: null,
  })
  assert.throws(
    () => reduceDurableCustodyState(custodyState(record, unownedForeignScopeState), {
      kind: 'owner-claimed',
      observedAtMs: 1_000,
      nextIncarnationId: 'worker-002',
      nextFencingEpoch: 8,
      nextLeaseExpiresAtMs: 10_000,
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

test('retry cursor is fenced, monotonic, and clears before a custody-changing transition', () => {
  const initial = custodyState()
  const scheduled = reduceDurableCustodyState(initial, {
    kind: 'retry-scheduled',
    reason: 'mint-response-unknown',
    nextAttemptAtMs: 2_000,
    ...ownerAuthorization,
  })
  assert.deepEqual(scheduled.operation.operation.retry, {
    attempt: 1,
    nextAttemptAtMs: 2_000,
    reason: 'mint-response-unknown',
  })
  assert.throws(
    () => reduceDurableCustodyState(scheduled, {
      kind: 'retry-scheduled',
      reason: 'rate-limited',
      nextAttemptAtMs: 1_400,
      ...ownerAuthorization,
      observedAtMs: 1_600,
    }),
    /next retry time is before effective clock/,
  )
  assert.throws(
    () => reduceDurableCustodyState(scheduled, {
      kind: 'retry-scheduled',
      reason: 'rate-limited',
      nextAttemptAtMs: 1_600,
      ...ownerAuthorization,
    }),
    /next retry time moves backwards/,
  )
  assert.throws(
    () => reduceDurableCustodyState(scheduled, {
      kind: 'retry-scheduled',
      reason: 'future-reason' as never,
      nextAttemptAtMs: 2_500,
      ...ownerAuthorization,
    }),
    /retry reason is invalid/,
  )
  const handedOff = reduceDurableCustodyState(scheduled, {
    kind: 'transport-attempted',
    ...ownerAuthorization,
  })
  assert.deepEqual(handedOff.operation.operation.retry, {
    attempt: 0,
    nextAttemptAtMs: null,
    reason: 'none',
  })
})

test('post-handoff recovery reissues the same all-unspent operation inside its horizon', () => {
  const dispatched = reduceDurableCustodyState(custodyState(), {
    kind: 'transport-attempted',
    ...ownerAuthorization,
  })
  assert.equal(dispatched.operation.operation.state, 'transport-attempted')
  assert.equal(dispatched.scopeState.effectiveClock.highWaterMarkMs, 1_500)

  const decision = decideDurableCustodyRecovery(dispatched.operation, dispatched.scopeState, {
    ...ownerAuthorization,
    classification: 'all-inputs-unspent',
    exactRequestDisposition: 'unknown',
    scopeId: dispatched.operation.scope.scopeId,
    operationId: dispatched.operation.operation.operationId,
    requestFingerprint: dispatched.operation.operation.exactRequest.requestFingerprint,
    outputPlanFingerprint: dispatched.operation.operation.outputPlan.outputPlanFingerprint,
  })
  assert.deepEqual(decision, {
    kind: 'reissue-exact-operation',
    effectiveNowMs: 1_500,
    exact: exactReference(dispatched.operation),
  })
  assert.throws(
    () => reduceDurableCustodyState(dispatched, {
      kind: 'abort-no-transport',
      ...ownerAuthorization,
      classification: 'all-inputs-unspent',
      exactRequestDisposition: 'deterministically-rejected',
    }),
    /abort is only legal before transport handoff/,
  )
})

test('NUT-09 recovery may reconcile a dispatch intent only with spent-restorable evidence', () => {
  const record = decodedRecord()
  const initial = custodyState(record)
  assert.equal(isDurableCustodyProofReservationActive(record), true)
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
  assert.equal(isDurableCustodyProofReservationActive(staged.operation), true)
  assert.equal(isDurableCustodyProofReservationActive(reconciled.operation), false)
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
    exactRequestDisposition: 'unknown',
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
      exactRequestDisposition: 'deterministically-rejected',
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

test('safe abort transition requires deterministic rejection without dependency or outbox', () => {
  const record = decodedRecord()
  const expiredScopeState = decodedScopeState({ effectiveClock: { highWaterMarkMs: 4_500 } })
  const aborted = reduceDurableCustodyState(custodyState(record, expiredScopeState), {
    kind: 'abort-no-transport',
    ...ownerAuthorization,
    classification: 'all-inputs-unspent',
    exactRequestDisposition: 'deterministically-rejected',
  })
  assert.equal(aborted.operation.operation.state, 'aborted')
  assert.equal(isDurableCustodyProofReservationActive(aborted.operation), false)

  const dependent = structuredClone(record)
  if (dependent.operation.binding.kind !== 'trade') assert.fail('expected trade binding')
  dependent.operation.binding.hasDependentOperation = true
  assert.throws(
    () => reduceDurableCustodyState(custodyState(dependent, expiredScopeState), {
      kind: 'abort-no-transport',
      ...ownerAuthorization,
      classification: 'all-inputs-unspent',
      exactRequestDisposition: 'deterministically-rejected',
    }),
    /abort is not eligible/,
  )

  const outboxed = structuredClone(record)
  outboxed.operation.delivery = {
    deliveryKind: 'outbox',
    deliveryId: `delivery:${record.operation.operationId}:settlement`,
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
      exactRequestDisposition: 'deterministically-rejected',
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
    deliveryId: `delivery:${reconciled.operation.operation.operationId}:settlement`,
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
    deliveryId: `delivery:${reconciled.operation.operation.operationId}:settlement`,
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

test('active recovery access is cursor/limit bounded and never falls back to an unbounded scan', async () => {
  const calls: unknown[] = []
  const first = decodedRecord()
  const secondRaw = custodyRecord()
  const secondOperation = secondRaw.operation as Record<string, unknown>
  secondOperation.retainedOperationKey = 'seller-lock-002'
  secondOperation.operationId = operationIdFor(profileScope().scopeId, secondOperation)
  const second = decodeDurableCustodyRecord(secondRaw)
  const page = await readDurableCustodyRecoveryPage({
    listRecoverablePage: async (input) => {
      calls.push(input)
      return { records: [first, second], nextCursor: 'cursor-002' }
    },
  }, {
    scope: profileScope(),
    cursor: 'cursor-001',
    limit: 2,
  })

  assert.deepEqual(calls, [{ scope: profileScope(), cursor: 'cursor-001', limit: 2 }])
  assert.equal(page.records.length, 2)
  assert.equal(page.nextCursor, 'cursor-002')

  await assert.rejects(
    readDurableCustodyRecoveryPage({
      listRecoverablePage: async () => ({ records: [first, first], nextCursor: null }),
    }, { scope: profileScope(), cursor: null, limit: 2 }),
    /recovery page operation id is duplicated/,
  )

  await assert.rejects(
    readDurableCustodyRecoveryPage({} as never, { scope: profileScope(), cursor: null, limit: 1 }),
    /bounded durable custody recovery is unavailable/,
  )
  await assert.rejects(
    readDurableCustodyRecoveryPage({
      listRecoverablePage: async () => ({ records: [], nextCursor: null }),
    }, { scope: profileScope(), cursor: null, limit: 0 }),
    /recovery page limit is invalid/,
  )
  await assert.rejects(
    readDurableCustodyRecoveryPage({
      listRecoverablePage: async () => ({ records: [first, second], nextCursor: null }),
    }, { scope: profileScope(), cursor: null, limit: 1 }),
    /recovery page exceeds requested limit/,
  )
  const aborted = structuredClone(first)
  aborted.operation.state = 'aborted'
  await assert.rejects(
    readDurableCustodyRecoveryPage({
      listRecoverablePage: async () => ({ records: [aborted], nextCursor: null }),
    }, { scope: profileScope(), cursor: null, limit: 1 }),
    /recovery page contains inactive record/,
  )
})

test('record decoding rejects oversized proof arrays before binding validation', () => {
  const raw = custodyRecord()
  const operation = raw.operation as Record<string, unknown>
  const reservation = operation.reservation as { inputs: unknown[] }
  const exactRequest = operation.exactRequest as { inputProofIds: unknown[] }
  reservation.inputs = Array.from({ length: 257 }, (_, index) => ({
    proofId: index.toString(16).padStart(64, '0'),
    keysetId: 'keyset-001',
    curve: 'secp256k1',
  }))
  exactRequest.inputProofIds = reservation.inputs.map((input) => (input as { proofId: string }).proofId)
  assert.throws(() => decodeDurableCustodyRecord(raw), /reservation inputs exceed the limit/)
})

test('reconciled operation with no replay requirement leaves the active index without a tombstone', () => {
  const raw = custodyRecord()
  const operation = raw.operation as Record<string, unknown>
  operation.semanticKind = 'generic-send'
  operation.binding = { kind: 'wallet', activityId: 'wallet-send-001', stage: 'send' }
  operation.horizon = { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 500, keysetExpiryMs: null }
  operation.operationId = operationIdFor(profileScope().scopeId, operation)
  operation.state = 'reconciled'
  operation.result = {
    state: 'applied',
    resultHandle: 'result-001',
    resultFingerprint: FINGERPRINT_A,
    outputPlanFingerprint: FINGERPRINT_B,
  }
  operation.terminalReplayEvidenceRequired = false
  assert.equal(isDurableCustodyActiveRecoveryRecord(decodeDurableCustodyRecord(raw)), false)
})
