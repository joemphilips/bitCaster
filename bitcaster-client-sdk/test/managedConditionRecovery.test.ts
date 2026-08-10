import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyManagedConditionRecoveryBoundary,
  classifyManagedConditionRecoveryOperation,
  runManagedConditionRecoveryPass,
  type ManagedConditionRecoveryHandlerResult,
  type ManagedConditionRecoveryHandlers,
  type ManagedConditionRecoveryHead,
  type ManagedConditionRecoveryIndexEntry,
  type ManagedConditionRecoveryOperation,
  type ManagedConditionRecoveryOperationKind,
  type ManagedConditionRecoveryStore,
} from '../src/managedConditionRecovery.ts'
import {
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
  DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX,
} from '../src/durableCustody.ts'

const SCOPE_ID = deriveDurableCustodyScopeId({
  scopeKind: 'condition-inventory',
  conditionId: 'condition-recovery-runner',
  inventoryAccountId: 'condition:recovery-runner',
  normalizedMint: 'https://mint.example',
  unit: 'msat',
})

test('operation kinds map exhaustively to dependency classes', () => {
  assert.equal(classifyManagedConditionRecoveryOperation('receive'), 'receive')
  assert.equal(
    classifyManagedConditionRecoveryOperation('capability-preparation'),
    'capability-preparation',
  )
  assert.equal(
    classifyManagedConditionRecoveryOperation('range-settlement'),
    'range-settlement-or-refund',
  )
  assert.equal(
    classifyManagedConditionRecoveryOperation('range-refund'),
    'range-settlement-or-refund',
  )
  assert.equal(
    classifyManagedConditionRecoveryOperation('condition-linked-consolidation'),
    'condition-linked-consolidation',
  )
  assert.equal(
    classifyManagedConditionRecoveryOperation('inventory-retirement'),
    'inventory-retirement',
  )
  assert.throws(() => classifyManagedConditionRecoveryOperation('future-kind'), /unknown/)
})

for (const [kind, semanticKind, stage, path] of [
  ['receive', 'generic-receive', 'receive', '/v1/swap'],
  ['capability-preparation', 'ctf-range-regular-source', 'capability-preparation', '/v1/swap'],
  ['capability-preparation', 'ctf-range-conditional-source', 'capability-preparation', '/v1/swap'],
  [
    'capability-preparation',
    'ctf-range-collateral-convert',
    'capability-preparation',
    '/v1/ctf/convert',
  ],
  ['range-settlement', 'conditional-keyset-swap', 'send', '/internal/settlement-capabilities'],
  ['range-refund', 'swap-refund', 'refund', '/v1/swap'],
  ['condition-linked-consolidation', 'ctf-merge', 'ctf-merge', '/v1/ctf/convert'],
  ['condition-linked-consolidation', 'proof-consolidation', 'proof-consolidation', '/v1/swap'],
  ['inventory-retirement', 'ctf-redeem', 'ctf-redeem', '/v1/redeem_outcome'],
] as const) {
  test(`maps the exact ${kind} durable boundary`, () => {
    assert.equal(
      classifyManagedConditionRecoveryBoundary({
        semanticKind,
        stage,
        method: 'POST',
        path,
      }),
      kind,
    )
  })
}

test('rejects familiar durable semantics on a foreign recovery boundary', () => {
  assert.throws(
    () =>
      classifyManagedConditionRecoveryBoundary({
        semanticKind: 'generic-receive',
        stage: 'receive',
        method: 'POST',
        path: '/v1/foreign',
      }),
    /unknown/,
  )
})

test('the lowest dependency class blocks later due work before due-time filtering', async () => {
  const calls: string[] = []
  const receive = entry('receive', 200)
  const retirement = entry('inventory-retirement', 0)
  const result = await runManagedConditionRecoveryPass({
    scopeId: SCOPE_ID,
    nowMs: 100,
    store: store([receive, retirement]),
    handlers: handlers(calls),
  })

  assert.deepEqual(result, {
    kind: 'retry-at',
    processedCount: 0,
    processedBytes: 0,
    operationId: receive.operationId,
    recoveryClass: 'receive',
    atMs: 200,
  })
  assert.deepEqual(calls, [])
})

test('the runner processes exact operations in dependency order and stops when blocked', async () => {
  const calls: string[] = []
  const exactBodies = new Map<string, unknown>()
  const entries = [
    entry('receive', 0),
    entry('capability-preparation', 0),
    entry('range-refund', 0),
  ]
  const customHandlers = handlers(calls, {
    capabilityPreparation: {
      kind: 'blocked',
      wake: { kind: 'external-signal', source: 'mint', signalId: 'm1' },
    },
  })
  const result = await runManagedConditionRecoveryPass({
    scopeId: SCOPE_ID,
    nowMs: 100,
    store: store(entries, { exactBodies }),
    handlers: customHandlers,
  })

  assert.deepEqual(calls, ['receive', 'capability-preparation'])
  assert.equal(result.kind, 'blocked')
  assert.equal(result.processedCount, 1)
  assert.equal(result.processedBytes, entries[0]!.envelopeByteLength)
  if (result.kind !== 'blocked') assert.fail('expected blocked recovery')
  assert.equal(result.reason, 'handler-blocked')
  assert.deepEqual(result.wake, { kind: 'external-signal', source: 'mint', signalId: 'm1' })
  assert.equal(exactBodies.size, 2)
})

test('one pass processes at most four records and reports retained work', async () => {
  const entries = Array.from({ length: 5 }, (_, index) => entry('receive', index, 100, `r${index}`))
    .sort((left, right) => left.operationId.localeCompare(right.operationId))
    .map((value, index) => ({ ...value, nextAttemptAtMs: index }))
  const calls: string[] = []
  const result = await runManagedConditionRecoveryPass({
    scopeId: SCOPE_ID,
    nowMs: 100,
    store: store(entries),
    handlers: handlers(calls),
  })

  assert.deepEqual(result, {
    kind: 'terminal',
    processedCount: 4,
    processedBytes: 400,
    hasMore: true,
  })
  assert.equal(calls.length, 4)
})

test('an exact envelope above four MiB and at most sixteen MiB runs alone', async () => {
  const large = entry('receive', 0, DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX + 1, 'large')
  const later = entry('receive', 1, 100, 'later')
  const entries = [large, later]
  const calls: string[] = []
  const result = await runManagedConditionRecoveryPass({
    scopeId: SCOPE_ID,
    nowMs: 100,
    store: store(entries),
    handlers: handlers(calls),
  })

  assert.deepEqual(result, {
    kind: 'terminal',
    processedCount: 1,
    processedBytes: DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX + 1,
    hasMore: true,
  })
  assert.deepEqual(calls, ['receive'])

  const maximum = { ...large, envelopeByteLength: DURABLE_CUSTODY_ARTIFACT_BYTES_MAX }
  const maximumResult = await runManagedConditionRecoveryPass({
    scopeId: SCOPE_ID,
    nowMs: 100,
    store: store([maximum]),
    handlers: handlers([]),
  })
  assert.equal(maximumResult.kind, 'terminal')
})

test('unknown, malformed, and foreign indexed authority fails closed', async () => {
  const unknown = entry('future-kind' as ManagedConditionRecoveryOperationKind, 0)
  const unknownResult = await runManagedConditionRecoveryPass({
    scopeId: SCOPE_ID,
    nowMs: 100,
    store: store([unknown]),
    handlers: handlers([]),
  })
  assert.equal(unknownResult.kind, 'blocked')
  if (unknownResult.kind !== 'blocked') assert.fail('expected blocked recovery')
  assert.equal(unknownResult.reason, 'unknown-operation')

  const oversized = {
    ...entry('receive', 0),
    envelopeByteLength: DURABLE_CUSTODY_ARTIFACT_BYTES_MAX + 1,
  }
  const corruptResult = await runManagedConditionRecoveryPass({
    scopeId: SCOPE_ID,
    nowMs: 100,
    store: store([oversized], { raw: true }),
    handlers: handlers([]),
  })
  assert.equal(corruptResult.kind, 'blocked')
  if (corruptResult.kind !== 'blocked') assert.fail('expected blocked recovery')
  assert.equal(corruptResult.reason, 'corrupt-index')

  const foreignResult = await runManagedConditionRecoveryPass({
    scopeId: SCOPE_ID,
    nowMs: 100,
    store: store([entry('receive', 0)], { foreignLoad: true }),
    handlers: handlers([]),
  })
  assert.equal(foreignResult.kind, 'blocked')
  if (foreignResult.kind !== 'blocked') assert.fail('expected blocked recovery')
  assert.equal(foreignResult.reason, 'foreign-operation')
})

test('handler retry and invalid store order return typed scheduler results', async () => {
  const receive = entry('receive', 0)
  const retryResult = await runManagedConditionRecoveryPass({
    scopeId: SCOPE_ID,
    nowMs: 100,
    store: store([receive]),
    handlers: handlers([], { receive: { kind: 'retry-at', atMs: 500 } }),
  })
  assert.equal(retryResult.kind, 'retry-at')
  if (retryResult.kind !== 'retry-at') assert.fail('expected retry recovery')
  assert.equal(retryResult.atMs, 500)

  const orderResult = await runManagedConditionRecoveryPass({
    scopeId: SCOPE_ID,
    nowMs: 100,
    store: store([entry('capability-preparation', 0), entry('receive', 0)]),
    handlers: handlers([]),
  })
  assert.equal(orderResult.kind, 'blocked')
  if (orderResult.kind !== 'blocked') assert.fail('expected blocked recovery')
  assert.equal(orderResult.reason, 'corrupt-index')
})

function entry(
  operationKind: ManagedConditionRecoveryOperationKind,
  nextAttemptAtMs: number,
  envelopeByteLength = 100,
  suffix = operationKind,
): ManagedConditionRecoveryIndexEntry {
  return {
    schemaVersion: 1,
    scopeId: SCOPE_ID,
    operationId: deriveDurableCustodyOperationId(SCOPE_ID, {
      retainedOperationKey: `recovery-${suffix}`,
      binding: { kind: 'wallet', activityId: `recovery-${suffix}`, stage: 'receive' },
    }),
    operationRevision: 0,
    operationKind,
    envelopeByteLength,
    nextAttemptAtMs,
  }
}

function store(
  entries: readonly ManagedConditionRecoveryIndexEntry[],
  options: {
    readonly exactBodies?: Map<string, unknown>
    readonly foreignLoad?: boolean
    readonly raw?: boolean
  } = {},
): ManagedConditionRecoveryStore {
  return {
    async readRecoveryHead({ limit }): Promise<ManagedConditionRecoveryHead> {
      assert.equal(limit, 5)
      return { entries: options.raw ? entries : structuredClone(entries), hasMore: false }
    },
    async loadExactOperation(authority): Promise<ManagedConditionRecoveryOperation> {
      const exactOperation = { persisted: authority.operationId }
      options.exactBodies?.set(authority.operationId, exactOperation)
      return {
        authority: options.foreignLoad
          ? { ...authority, envelopeByteLength: authority.envelopeByteLength + 1 }
          : authority,
        exactOperation,
      }
    },
  }
}

function handlers(
  calls: string[],
  results: Partial<
    Record<
      'receive' | 'capabilityPreparation' | 'range' | 'consolidation' | 'retirement',
      ManagedConditionRecoveryHandlerResult
    >
  > = {},
): ManagedConditionRecoveryHandlers {
  return {
    receive: handler('receive', calls, results.receive),
    capabilityPreparation: handler('capability-preparation', calls, results.capabilityPreparation),
    rangeSettlementOrRefund: handler('range', calls, results.range),
    conditionLinkedConsolidation: handler('consolidation', calls, results.consolidation),
    inventoryRetirement: handler('retirement', calls, results.retirement),
  }
}

function handler(
  name: string,
  calls: string[],
  result: ManagedConditionRecoveryHandlerResult = { kind: 'terminal' },
): (
  operation: ManagedConditionRecoveryOperation,
) => Promise<ManagedConditionRecoveryHandlerResult> {
  return async (operation) => {
    assert.deepEqual(operation.exactOperation, { persisted: operation.authority.operationId })
    calls.push(name)
    return result
  }
}
