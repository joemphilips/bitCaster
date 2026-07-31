import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX,
  DURABLE_CUSTODY_TRANSACTION_OPERATION_LIMIT_MAX,
  applyDurableCustodyTransaction,
  assertDurableCustodyArtifactMatchesReference,
  classifyDurableCustodyActiveWork,
  claimDurableCustodyScope,
  createDurableCustodyArtifactReference,
  createDurableCustodyDispatchIntent,
  createDurableProofOperationFacts,
  decideDurableCustodyPurge,
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeId,
  decodeDurableCustodyScopeInput,
  decodeDurableCustodyScopeState,
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  encodeBoundedDurableArtifact,
  prepareDurableCustodyExactArtifact,
  readDurableCustodyRecoveryPage,
  readPreparedDurableCustodyArtifactBytes,
  reduceDurableCustodyState,
  type DurableCustodyRecord,
  type DurableCustodyScopeState,
  type DurableCustodyTransaction,
} from '../src/durableCustody.ts'

const MINT = 'https://mint.example'
const UNIT = 'sat'
const PUBLIC_KEY = `02${'11'.repeat(32)}`

function scope() {
  const walletId = deriveDurableCustodyWalletId(new Uint8Array(32).fill(7))
  const input = { scopeKind: 'wallet' as const, walletId }
  return { ...input, scopeId: deriveDurableCustodyScopeId(input) }
}

function intent(
  semanticKind: 'wallet-send' | 'swap-lock' = 'wallet-send',
  stage: 'send' | 'lock' = 'send',
): DurableCustodyRecord {
  const walletScope = scope()
  const facts = createDurableProofOperationFacts({
    unit: UNIT,
    binding: {
      kind: 'wallet',
      activityId: 'wallet-operation-1',
      stage,
    },
    horizon: {
      notBeforeMs: null,
      notAfterMs: null,
      safetyMarginMs: 0,
    },
    hasOutputs: true,
    inputKeysetRequirement: 'required',
    keysets: [
      {
        keysetId: 'keyset-1',
        unit: UNIT,
        curve: 'secp256k1',
        publicKeys: { '1': PUBLIC_KEY },
        keysetExpiryMs: null,
        requireDleq: false,
        usedByInputs: true,
        usedByOutputs: true,
      },
    ],
  })
  const proofId = deriveDurableCustodyProofId({
    scopeId: walletScope.scopeId,
    normalizedMint: MINT,
    unit: UNIT,
    keysetId: 'keyset-1',
    secret: 'proof-secret',
  })
  const requestFingerprint = deriveDurableCustodyArtifactFingerprint({
    operation: 'wallet-operation-1',
  })
  const outputFingerprint = deriveDurableCustodyArtifactFingerprint({
    output: 'planned',
  })
  const successorProofId = deriveDurableCustodyProofId({
    scopeId: walletScope.scopeId,
    normalizedMint: MINT,
    unit: UNIT,
    keysetId: 'keyset-1',
    secret: 'output-secret',
  })
  return createDurableCustodyDispatchIntent({
    scope: walletScope,
    retainedOperationKey: 'wallet-operation-1',
    semanticKind,
    facts,
    normalizedMint: MINT,
    inventoryAccountId: null,
    reservation: {
      reservationId: 'reservation-1',
      parentReservationId: null,
      inputs: [{ proofId, keysetId: 'keyset-1', curve: 'secp256k1' }],
    },
    proofLineage: {
      predecessorProofIds: [proofId],
      successorProofIds: [successorProofId],
      successorAdmissionMode: 'exact',
    },
    exactRequest: {
      requestId: 'request-1',
      requestFingerprint,
      payloadHandle: `request:${requestFingerprint}`,
      inputProofIds: [proofId],
      outputPlanFingerprint: outputFingerprint,
      method: 'POST',
      path: '/v1/swap',
      idempotencyKey: 'wallet-operation-1',
      body: {
        encoding: 'canonical-json',
        artifact: { operation: 'wallet-operation-1' },
        fingerprint: requestFingerprint,
      },
    },
    outputPlan: {
      outputPlanId: 'output-plan-1',
      outputPlanFingerprint: outputFingerprint,
      outputMaterialHandle: `outputs:${outputFingerprint}`,
      exactOutput: {
        encoding: 'canonical-json',
        artifact: { output: 'planned' },
        fingerprint: outputFingerprint,
      },
    },
    privateMaterial: {
      materialHandle: `private:${requestFingerprint}`,
      useId: 'private-use-1',
      publicFingerprint: requestFingerprint,
      exactPrivateMaterial: {
        encoding: 'canonical-json',
        artifact: { useId: 'private-use-1' },
        fingerprint: deriveDurableCustodyArtifactFingerprint({
          useId: 'private-use-1',
        }),
      },
    },
  })
}

test('custody identifiers are scope-separated and never expose proof secrets', () => {
  const walletScope = scope()
  const operationId = deriveDurableCustodyOperationId(walletScope.scopeId, {
    retainedOperationKey: 'operation-1',
    binding: {
      kind: 'wallet',
      activityId: 'operation-1',
      stage: 'send',
    },
  })
  const proofId = deriveDurableCustodyProofId({
    scopeId: walletScope.scopeId,
    normalizedMint: MINT,
    unit: UNIT,
    keysetId: 'keyset-1',
    secret: 'bearer-secret',
  })
  assert.match(walletScope.walletId, /^[0-9a-f]{64}$/)
  assert.match(walletScope.scopeId, /^custody:wallet:/)
  assert.match(operationId, /^custody-operation:/)
  assert.match(proofId, /^[0-9a-f]{64}$/)
  assert.equal(proofId.includes('bearer-secret'), false)
})

test('condition-inventory scope encoding is strict and excludes order routes', () => {
  const input = {
    scopeKind: 'condition-inventory' as const,
    conditionId: 'condition-with-dashes',
    inventoryAccountId: 'inventory-1',
    normalizedMint: MINT,
    unit: 'msat',
  }
  const scopeId = deriveDurableCustodyScopeId(input)
  const scope = { ...input, scopeId }

  assert.equal(
    scopeId,
    'custody:condition-inventory:condition-with-dashes:inventory-1:https%3A%2F%2Fmint.example:msat',
  )
  assert.equal(decodeDurableCustodyScopeId(scopeId), scopeId)
  assert.deepEqual(decodeDurableCustodyScopeInput(scopeId), input)
  assert.throws(
    () =>
      decodeDurableCustodyScopeId(
        'custody:market:condition-with-dashes-YES:inventory-1:https%3A%2F%2Fmint.example:msat',
      ),
    /scope id/,
  )
  assert.throws(
    () =>
      deriveDurableCustodyScopeId({
        ...input,
        scopeKind: 'market',
      } as unknown as Parameters<typeof deriveDurableCustodyScopeId>[0]),
    /scope kind/,
  )
  assert.throws(
    () =>
      decodeDurableCustodyScopeState({
        schemaVersion: 1,
        scope: { ...scope, orderRouteId: 'condition-with-dashes-YES' },
        fencingEpoch: 0,
        owner: null,
        effectiveClock: { highWaterMarkMs: 0 },
      }),
    /fields/,
  )
})

test('prepared exact artifacts detach and freeze their canonical graph', () => {
  const original = { nested: { value: 'before' }, list: [{ amount: 1 }] }
  const prepared = prepareDurableCustodyExactArtifact(original)

  original.nested.value = 'after'
  original.list[0]!.amount = 2

  assert.deepEqual(prepared.artifact, {
    nested: { value: 'before' },
    list: [{ amount: 1 }],
  })
  assert.equal(Object.isFrozen(prepared), true)
  assert.equal(Object.isFrozen(prepared.artifact), true)
  assert.equal(Object.isFrozen((prepared.artifact as typeof original).nested), true)
  assert.equal(Object.isFrozen((prepared.artifact as typeof original).list[0]), true)
  assert.throws(() => {
    ;(prepared.artifact as typeof original).nested.value = 'replacement'
  }, TypeError)
})

test('prepared exact-artifact bytes are copy-safe and identity-authorized', () => {
  const prepared = prepareDurableCustodyExactArtifact({ b: 2, a: 1 })
  const reference = createDurableCustodyArtifactReference('artifact-1', prepared)
  const first = readPreparedDurableCustodyArtifactBytes(prepared)
  const second = readPreparedDurableCustodyArtifactBytes(prepared)

  assert.equal(new TextDecoder().decode(first), '{"a":1,"b":2}')
  assert.equal(first.length, reference.byteLength)
  assert.notEqual(first, second)
  first[0] = 0
  assert.equal(new TextDecoder().decode(second), '{"a":1,"b":2}')
  assertDurableCustodyArtifactMatchesReference(reference, prepared)

  const forged = structuredClone(prepared)
  assert.throws(() => readPreparedDurableCustodyArtifactBytes(forged), /not SDK-prepared/)
  assert.deepEqual(createDurableCustodyArtifactReference('artifact-2', forged), {
    ...reference,
    artifactId: 'artifact-2',
  })
})

test('unprepared exact artifacts remain fail-closed after graph mutation', () => {
  const value = { state: 'before' }
  const artifact = {
    encoding: 'canonical-json' as const,
    artifact: value,
    fingerprint: deriveDurableCustodyArtifactFingerprint(value),
  }
  const reference = createDurableCustodyArtifactReference('artifact-1', artifact)

  value.state = 'after'

  assert.throws(
    () => assertDurableCustodyArtifactMatchesReference(reference, artifact),
    /fingerprint/,
  )
  assert.throws(() => createDurableCustodyArtifactReference('artifact-2', artifact), /fingerprint/)
})

test('custody decoder is exact and excludes foreign semantics', () => {
  const record = intent()
  assert.equal(decodeDurableCustodyRecord(record).operation.semanticKind, 'wallet-send')
  assert.throws(
    () =>
      decodeDurableCustodyRecord({
        ...record,
        operation: { ...record.operation, semanticKind: 'foreign-operation' },
      }),
    /semantic kind/,
  )
  assert.throws(
    () => decodeDurableCustodyRecord({ ...record, foreignAuthority: 123 }),
    /foreign fields/,
  )
})

test('custody transaction exposes only the selected bounded operation set', () => {
  const record = intent()
  const records = new Map([[record.operation.operationId, record]])
  let storedArtifact: unknown = null
  let storedArtifactRow: ReturnType<DurableCustodyTransaction['getArtifact']> = null
  const scopeState: DurableCustodyScopeState = {
    schemaVersion: 1,
    scope: record.scope,
    fencingEpoch: 1,
    owner: { incarnationId: 'process-1', leaseExpiresAtMs: 100 },
    effectiveClock: { highWaterMarkMs: 0 },
  }
  const selection = {
    scope: record.scope,
    owner: {
      incarnationId: 'process-1',
      fencingEpoch: 1,
      observedAtMs: 1,
    },
    operationRows: [{ operationId: record.operation.operationId, expectedRevision: 0 }],
  }
  const transaction: DurableCustodyTransaction = {
    getScopeState: () => scopeState,
    getOperation: (operationId) => records.get(operationId) ?? null,
    getArtifact: () => storedArtifactRow,
    putArtifact: (input) => {
      storedArtifact = input.artifact.artifact
      storedArtifactRow = {
        reference: input.reference,
        artifact: input.artifact,
        revision: 0,
      }
    },
    putOperation: ({ record: next }) => records.set(next.operation.operationId, next),
    reserveExactInputs: () => undefined,
    transitionOperation: () => undefined,
    stageVerifiedResult: () => undefined,
    applyVerifiedResult: () => undefined,
    rebuildActiveWorkIndex: () => undefined,
  }
  const result = applyDurableCustodyTransaction(
    transaction,
    selection,
    (selected) => selected.getOperation(record.operation.operationId)?.revision,
  )
  assert.equal(result, 0)
  const exactBody = prepareDurableCustodyExactArtifact({
    operation: 'wallet-operation-1',
  })
  applyDurableCustodyTransaction(transaction, selection, (selected) =>
    selected.putArtifact({
      scopeId: record.scope.scopeId,
      operationId: record.operation.operationId,
      expectedOperationRevision: 0,
      expectedArtifactRevision: null,
      reference: record.operation.exactRequest.body,
      artifact: exactBody,
    }),
  )
  assert.deepEqual(storedArtifact, exactBody.artifact)
  assert.throws(
    () =>
      applyDurableCustodyTransaction(transaction, selection, (selected) =>
        selected.putArtifact({
          scopeId: record.scope.scopeId,
          operationId: record.operation.operationId,
          expectedOperationRevision: 0,
          expectedArtifactRevision: 0,
          reference: record.operation.exactRequest.body,
          artifact: {
            ...exactBody,
            artifact: { operation: 'replacement' },
          },
        }),
      ),
    /fingerprint|does not match|immutable/,
  )
  storedArtifactRow = {
    ...storedArtifactRow!,
    reference: {
      ...record.operation.exactRequest.body,
      byteLength: record.operation.exactRequest.body.byteLength + 1,
    },
  }
  assert.throws(
    () =>
      applyDurableCustodyTransaction(transaction, selection, (selected) =>
        selected.getArtifact({
          scopeId: record.scope.scopeId,
          operationId: record.operation.operationId,
          expectedOperationRevision: 0,
          reference: record.operation.exactRequest.body,
        }),
      ),
    /reference is foreign/,
  )
  assert.throws(
    () =>
      applyDurableCustodyTransaction(transaction, selection, (selected) =>
        selected.putOperation({
          record,
          expectedRevision: record.revision + 1,
        }),
      ),
    /revision is not selected/,
  )
  assert.throws(
    () =>
      applyDurableCustodyTransaction(transaction, selection, (selected) =>
        selected.getOperation('foreign-operation'),
      ),
    /not selected/,
  )
  assert.throws(
    () =>
      applyDurableCustodyTransaction(
        transaction,
        {
          ...selection,
          operationRows: Array.from(
            { length: DURABLE_CUSTODY_TRANSACTION_OPERATION_LIMIT_MAX + 1 },
            (_, index) => ({
              operationId: `operation-${index}`,
              expectedRevision: null,
            }),
          ),
        },
        () => undefined,
      ),
    /operation limit/,
  )
  assert.throws(
    () =>
      applyDurableCustodyTransaction(
        transaction,
        {
          ...selection,
          owner: { ...selection.owner, incarnationId: 'foreign-process' },
        },
        () => undefined,
      ),
    /fencing authorization/,
  )
  assert.throws(
    () =>
      applyDurableCustodyTransaction(
        transaction,
        { ...selection, operationRows: [] },
        () => undefined,
      ),
    /operation limit/,
  )
})

test('scope claim and reducer keep clock monotonic without invalidating the current epoch', () => {
  const walletScope = scope()
  const unowned: DurableCustodyScopeState = {
    schemaVersion: 1,
    scope: walletScope,
    fencingEpoch: 0,
    owner: null,
    effectiveClock: { highWaterMarkMs: 10 },
  }
  const claimed = claimDurableCustodyScope(unowned, {
    incarnationId: 'process-1',
    observedAtMs: 11,
    leaseExpiresAtMs: 21,
  })
  const next = reduceDurableCustodyState(
    { scopeState: claimed, operation: intent() },
    {
      kind: 'mark-transport-attempted',
      authorization: {
        incarnationId: 'process-1',
        fencingEpoch: 1,
        observedAtMs: 12,
      },
      expectedRevision: 0,
    },
  )
  assert.equal(next.operation.operation.state, 'transport-attempted')
  const clockSkewed = reduceDurableCustodyState(next, {
    kind: 'schedule-retry',
    authorization: {
      incarnationId: 'process-1',
      fencingEpoch: 1,
      observedAtMs: 9,
    },
    expectedRevision: 1,
    reason: 'mint-response-unknown',
    nextAttemptAtMs: 14,
  })
  assert.equal(clockSkewed.scopeState.effectiveClock.highWaterMarkMs, 12)
  assert.throws(
    () =>
      reduceDurableCustodyState(clockSkewed, {
        kind: 'mark-transport-attempted',
        authorization: {
          incarnationId: 'process-1',
          fencingEpoch: 1,
          observedAtMs: 13,
        },
        expectedRevision: 1,
      }),
    /revision is stale/,
  )
  assert.throws(
    () =>
      reduceDurableCustodyState(next, {
        kind: 'mark-transport-attempted',
        authorization: {
          incarnationId: 'process-1',
          fencingEpoch: 0,
          observedAtMs: 13,
        },
        expectedRevision: 1,
      }),
    /fencing/,
  )
})

test('custody rejects cross-scope reducers and incoherent persisted state', () => {
  const record = intent()
  const foreign = scope()
  const foreignInput = {
    scopeKind: 'wallet' as const,
    walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(9)),
  }
  foreign.walletId = foreignInput.walletId
  foreign.scopeId = deriveDurableCustodyScopeId(foreignInput)
  assert.throws(
    () =>
      reduceDurableCustodyState(
        {
          operation: record,
          scopeState: {
            schemaVersion: 1,
            scope: foreign,
            fencingEpoch: 1,
            owner: { incarnationId: 'process-1', leaseExpiresAtMs: 100 },
            effectiveClock: { highWaterMarkMs: 1 },
          },
        },
        {
          kind: 'mark-transport-attempted',
          expectedRevision: 0,
          authorization: {
            incarnationId: 'process-1',
            fencingEpoch: 1,
            observedAtMs: 2,
          },
        },
      ),
    /scope state are foreign/,
  )
  assert.throws(
    () =>
      decodeDurableCustodyRecord({
        ...record,
        operation: {
          ...record.operation,
          state: 'reconciled',
        },
      }),
    /lifecycle is incoherent/,
  )
  assert.throws(
    () =>
      decodeDurableCustodyRecord({
        ...record,
        operation: {
          ...record.operation,
          exactRequest: {
            ...record.operation.exactRequest,
            body: {
              ...record.operation.exactRequest.body,
              fingerprint: deriveDurableCustodyArtifactFingerprint({
                operation: 'mutated',
              }),
            },
          },
        },
      }),
    /request body reference is foreign/,
  )
})

test('artifact and mint authorities reject depth and URL aliases before hashing', () => {
  let deep: unknown = 'leaf'
  for (let index = 0; index < 33; index += 1) deep = { child: deep }
  assert.throws(() => encodeBoundedDurableArtifact(deep, 1_024 * 1_024), /structure limit/)
  assert.throws(
    () =>
      deriveDurableCustodyProofId({
        scopeId: scope().scopeId,
        normalizedMint: 'https://user:password@mint.example',
        unit: UNIT,
        keysetId: 'keyset-1',
        secret: 'secret',
      }),
    /normalized mint/,
  )
  assert.throws(
    () =>
      deriveDurableCustodyProofId({
        scopeId: scope().scopeId,
        normalizedMint: 'https://mint.example:443',
        unit: UNIT,
        keysetId: 'keyset-1',
        secret: 'secret',
      }),
    /normalized mint/,
  )
})

test('exact artifacts accept the 16 MiB boundary and reject max plus one', () => {
  const maximum = 16 * 1_024 * 1_024
  const atMaximum = 'x'.repeat(maximum - 2)
  assert.equal(encodeBoundedDurableArtifact(atMaximum, maximum).length, maximum)
  assert.throws(() => encodeBoundedDurableArtifact(`${atMaximum}x`, maximum), /byte limit/)
  assert.equal('artifact' in intent().operation.exactRequest.body, false)
})

test('cross-scope proof identities cannot collide', () => {
  const first = scope()
  const secondInput = {
    scopeKind: 'wallet' as const,
    walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(8)),
  }
  const second = { ...secondInput, scopeId: deriveDurableCustodyScopeId(secondInput) }
  const common = {
    normalizedMint: MINT,
    unit: UNIT,
    keysetId: 'keyset-1',
    secret: 'same-secret',
  }
  assert.notEqual(
    deriveDurableCustodyProofId({ scopeId: first.scopeId, ...common }),
    deriveDurableCustodyProofId({ scopeId: second.scopeId, ...common }),
  )
})

test('P09 purge requires terminal status, replay cutoff, and resolved delivery', () => {
  const record = intent('swap-lock', 'lock')
  assert.deepEqual(record.operation.proofStorage, {
    storageClass: 'pinned-operation-bound-deterministic',
    pinReasons: ['active-reservation'],
    lineage: {
      scopeId: record.scope.scopeId,
      operationId: record.operation.operationId,
      predecessorProofIds: record.operation.reservation.inputs.map(({ proofId }) => proofId),
      successorProofIds: record.operation.proofStorage.lineage.successorProofIds,
      successorAdmissionMode: 'exact',
      selectedSuccessorProofIds: null,
      successorAdmission: null,
    },
  })
  const scopeState = claimDurableCustodyScope(
    {
      schemaVersion: 1,
      scope: record.scope,
      fencingEpoch: 0,
      owner: null,
      effectiveClock: { highWaterMarkMs: 0 },
    },
    {
      incarnationId: 'process-1',
      observedAtMs: 1,
      leaseExpiresAtMs: 100,
    },
  )
  const authority = (observedAtMs: number) => ({
    incarnationId: 'process-1',
    fencingEpoch: 1,
    observedAtMs,
  })
  let state = { scopeState, operation: record }
  state = reduceDurableCustodyState(state, {
    kind: 'mark-transport-attempted',
    authorization: authority(2),
    expectedRevision: 0,
  })
  state = reduceDurableCustodyState(state, {
    kind: 'schedule-retry',
    authorization: authority(3),
    expectedRevision: 1,
    reason: 'mint-response-unknown',
    nextAttemptAtMs: 10,
  })
  assert.deepEqual(state.operation.operation.retry, {
    attempt: 1,
    nextAttemptAtMs: 10,
    reason: 'mint-response-unknown',
  })
  const exactResult = prepareDurableCustodyExactArtifact({ result: 1 })
  state = reduceDurableCustodyState(state, {
    kind: 'stage-verified-result',
    authorization: authority(4),
    expectedRevision: 2,
    resultHandle: 'result:1',
    resultFingerprint: exactResult.fingerprint,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    exactResult,
    selectedSuccessorProofIds: record.operation.proofStorage.lineage.successorProofIds,
  })
  state = reduceDurableCustodyState(state, {
    kind: 'apply-verified-result',
    authorization: authority(5),
    expectedRevision: 3,
    successorAdmission: {
      scopeId: record.scope.scopeId,
      operationId: record.operation.operationId,
      admissionId: 'admission-1',
      proofRows: record.operation.proofStorage.lineage.successorProofIds.map((proofId) => ({
        proofId,
        expectedRevision: null,
        admittedRevision: 0,
      })),
    },
  })
  state = reduceDurableCustodyState(state, {
    kind: 'stage-outbox',
    authorization: authority(6),
    expectedRevision: 4,
    deliveryId: 'delivery-1',
    expiresAtMs: 80,
    exactPayload: {
      encoding: 'canonical-json',
      artifact: { value: 1 },
      fingerprint: deriveDurableCustodyArtifactFingerprint({ value: 1 }),
    },
  })
  state = reduceDurableCustodyState(state, {
    kind: 'resolve-delivery',
    authorization: authority(7),
    expectedRevision: 5,
    receipt: {
      receiptId: 'receipt-1',
      payloadFingerprint: state.operation.operation.delivery.exactPayload!.fingerprint,
      acknowledgedAtMs: 7,
    },
  })
  state = reduceDurableCustodyState(state, {
    kind: 'create-terminal-tombstone',
    authorization: authority(8),
    expectedRevision: 6,
    tombstoneId: 'tombstone-1',
    terminalAuthorityId: 'authority-1',
  })
  assert.deepEqual(decideDurableCustodyPurge(state.operation, state.scopeState), {
    kind: 'retain',
  })
  state = reduceDurableCustodyState(state, {
    kind: 'confirm-terminal-status',
    authorization: authority(9),
    expectedRevision: 7,
    terminalAuthorityId: 'authority-1',
  })
  assert.equal(classifyDurableCustodyActiveWork(state.operation), 'tombstone')
  state = reduceDurableCustodyState(state, {
    kind: 'observe-replay-cutoff',
    authorization: authority(10),
    expectedRevision: 8,
    terminalAuthorityId: 'authority-1',
  })
  assert.deepEqual(decideDurableCustodyPurge(state.operation, state.scopeState), {
    kind: 'delete',
  })
  assert.deepEqual(
    decideDurableCustodyPurge(
      {
        ...state.operation,
        operation: {
          ...state.operation.operation,
          delivery: {
            deliveryKind: 'none',
            deliveryId: null,
            exactPayload: null,
            expiresAtMs: null,
            state: 'none',
            receipt: null,
          },
        },
      },
      state.scopeState,
    ),
    { kind: 'retain' },
  )
  assert.deepEqual(
    decideDurableCustodyPurge(
      {
        ...state.operation,
        operation: {
          ...state.operation.operation,
          proofStorage: {
            ...state.operation.operation.proofStorage,
            lineage: {
              ...state.operation.operation.proofStorage.lineage,
              successorAdmission: null,
            },
          },
        },
      },
      state.scopeState,
    ),
    { kind: 'retain' },
  )
  for (const successorAdmission of [
    {
      ...state.operation.operation.proofStorage.lineage.successorAdmission!,
      proofRows: [],
    },
    {
      ...state.operation.operation.proofStorage.lineage.successorAdmission!,
      scopeId: `${record.scope.scopeId}:foreign`,
    },
  ]) {
    assert.deepEqual(
      decideDurableCustodyPurge(
        {
          ...state.operation,
          operation: {
            ...state.operation.operation,
            proofStorage: {
              ...state.operation.operation.proofStorage,
              lineage: {
                ...state.operation.operation.proofStorage.lineage,
                successorAdmission,
              },
            },
          },
        },
        state.scopeState,
      ),
      { kind: 'retain' },
    )
  }
})

test('recovery page helper enforces the 256-record bound', async () => {
  await assert.rejects(
    () =>
      readDurableCustodyRecoveryPage(
        { listRecoverablePage: async () => ({ records: [], nextCursor: null }) },
        {
          scope: scope(),
          cursor: null,
          limit: DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX + 1,
        },
      ),
    /page limit/,
  )
})
