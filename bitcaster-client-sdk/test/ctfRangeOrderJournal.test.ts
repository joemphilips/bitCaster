import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertCtfRangeOrderPreparationTransition,
  bindCtfRangeOrderPreparationCapability,
  decodeCtfRangeOrderPreparationArtifact,
  decodeCtfRangeOrderPreparationCapability,
  decodeCtfRangeOrderPreparationIdentity,
  decodeCtfRangeOrderPreparationPageCursor,
  decodeCtfRangeOrderPreparationPageLimit,
  decodeCtfRangeOrderPreparationRecord,
  encodeCtfRangeOrderPreparationArtifact,
  sameCtfRangeOrderPreparationCapability,
  sameCtfRangeOrderPreparationIdentity,
} from '../src/ctfRangeOrderJournal.ts'
import { deriveDurableCustodyScopeId } from '../src/durableCustody.ts'

const CAPABILITY = {
  artifactId: '11111111-1111-4111-8111-111111111111',
  bindingDigest: '22'.repeat(32),
  artifactDigest: '33'.repeat(32),
  orderId: '44444444-4444-4444-8444-444444444444',
} as const

test('canonical preparation artifacts are bounded, detached, and byte exact', () => {
  const value = { z: [1, 2], a: { value: 'before' } }
  const encoded = encodeCtfRangeOrderPreparationArtifact(value)
  value.a.value = 'after'

  assert.equal(Buffer.from(encoded).toString('utf8'), '{"a":{"value":"before"},"z":[1,2]}')
  assert.equal(
    JSON.stringify(decodeCtfRangeOrderPreparationArtifact(encoded)),
    '{"a":{"value":"before"},"z":[1,2]}',
  )
  assert.throws(
    () => decodeCtfRangeOrderPreparationArtifact(Buffer.from('{"z":1, "a":2}')),
    /canonical/,
  )
  assert.throws(
    () => encodeCtfRangeOrderPreparationArtifact({ body: 'x'.repeat(256 * 1_024) }),
    /byte limit/,
  )
  assert.throws(() => encodeCtfRangeOrderPreparationArtifact({ invalid: undefined }), /undefined/)
  assert.throws(() => encodeCtfRangeOrderPreparationArtifact({ invalid: Number.NaN }), /number/)
})

test('strict identity validation preserves source lineage and exact replay', () => {
  const identity = preparationIdentity()
  const decoded = decodeCtfRangeOrderPreparationIdentity(identity)

  assert.equal(decoded.sourceKind, 'wallet-prepared')
  assert.equal(decoded.predecessorRangeOperationId, null)
  assert.equal(sameCtfRangeOrderPreparationIdentity(decoded, identity), true)
  for (const minimumFillAmountSubunits of [5_000, 20_000]) {
    assert.throws(
      () =>
        decodeCtfRangeOrderPreparationIdentity({
          ...identity,
          minimumFillAmountSubunits,
        }),
      /amount policy/,
    )
  }
  assert.equal(
    sameCtfRangeOrderPreparationIdentity(decoded, {
      ...identity,
      amountSubunits: identity.amountSubunits * 2,
    }),
    false,
  )
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationIdentity({
        ...identity,
        sourceKind: 'residual-change',
        predecessorRangeOperationId: null,
      }),
    /predecessor/,
  )
  const continuation = {
    predecessorOrderId: '11111111-1111-4111-8111-111111111111',
    settlementGroupId: '22222222-2222-4222-8222-222222222222',
    settlementGroupRevision: 3,
    continuationRevision: 4,
  }
  const residual = decodeCtfRangeOrderPreparationIdentity({
    ...identity,
    rangeOperationId: 'range-residual',
    sourceOperationId: 'source-residual',
    authorizationId: 'authorization-residual',
    clientOrderId: 'client-residual',
    sourceKind: 'residual-change',
    predecessorRangeOperationId: identity.rangeOperationId,
    continueAfterPartialFill: true,
    continuation,
  })
  assert.deepEqual(residual.continuation, continuation)
  assert.throws(
    () => decodeCtfRangeOrderPreparationIdentity({ ...identity, continuation }),
    /initial order has continuation authority/,
  )
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationIdentity({
        ...residual,
        continueAfterPartialFill: false,
      }),
    /continuation authority is incomplete/,
  )
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationIdentity({
        ...identity,
        priceSubunits: identity.divisibility,
      }),
    /price/,
  )
  assert.throws(
    () => decodeCtfRangeOrderPreparationIdentity({ ...identity, unexpected: true }),
    /fields/,
  )
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationIdentity({
        ...identity,
        orderRouteId: 'condition-2-YES',
      }),
    /foreign condition/,
  )
})

test('one wallet scope may retain exact order routes from several conditions', () => {
  const first = decodeCtfRangeOrderPreparationIdentity(preparationIdentity())
  const second = decodeCtfRangeOrderPreparationIdentity({
    ...preparationIdentity(),
    rangeOperationId: 'range-2',
    sourceOperationId: 'source-2',
    authorizationId: 'authorization-2',
    clientOrderId: 'client-2',
    orderRouteId: 'condition-2-NO',
    normalizedMint: 'https://other-mint.example',
    conditionId: 'condition-2',
  })

  assert.equal(first.scopeId, second.scopeId)
  assert.notEqual(first.normalizedMint, second.normalizedMint)
  assert.notEqual(first.conditionId, second.conditionId)
  assert.notEqual(first.orderRouteId, second.orderRouteId)
})

test('one condition-inventory scope owns several exact order routes for its condition', () => {
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'condition-inventory',
    conditionId: 'condition-1',
    inventoryAccountId: 'inventory-1',
    normalizedMint: 'https://mint.example',
    unit: 'msat',
  })
  const first = decodeCtfRangeOrderPreparationIdentity({
    ...preparationIdentity(),
    scopeId,
    orderRouteId: 'condition-1-YES',
  })
  const second = decodeCtfRangeOrderPreparationIdentity({
    ...preparationIdentity(),
    scopeId,
    rangeOperationId: 'range-2',
    sourceOperationId: 'source-2',
    authorizationId: 'authorization-2',
    clientOrderId: 'client-2',
    orderRouteId: 'condition-1-NO',
  })

  assert.equal(first.scopeId, second.scopeId)
  assert.notEqual(first.orderRouteId, second.orderRouteId)
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationIdentity({
        ...preparationIdentity(),
        scopeId,
        conditionId: 'condition-2',
        orderRouteId: 'condition-2-YES',
      }),
    /crosses its condition-inventory scope/,
  )
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationIdentity({
        ...preparationIdentity(),
        scopeId,
        normalizedMint: 'https://other-mint.example',
      }),
    /crosses its condition-inventory scope/,
  )
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationIdentity({
        ...preparationIdentity(),
        scopeId: deriveDurableCustodyScopeId({
          scopeKind: 'condition-inventory',
          conditionId: 'condition-1',
          inventoryAccountId: 'inventory-1',
          normalizedMint: 'https://mint.example',
          unit: 'sat',
        }),
      }),
    /crosses its condition-inventory scope/,
  )
})

test('capability and lifecycle validation reject partial or illegal authority', () => {
  assert.equal(
    sameCtfRangeOrderPreparationCapability(
      decodeCtfRangeOrderPreparationCapability(CAPABILITY),
      CAPABILITY,
    ),
    true,
  )
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationCapability({
        ...CAPABILITY,
        bindingDigest: 'not-a-digest',
      }),
    /capability/,
  )
  assert.throws(
    () => assertCtfRangeOrderPreparationTransition('prepared', 'capability-bound'),
    /transition/,
  )
  assert.doesNotThrow(() =>
    assertCtfRangeOrderPreparationTransition('prepared', 'capability-requested'),
  )
  assert.doesNotThrow(() =>
    assertCtfRangeOrderPreparationTransition('capability-bound', 'submission-rejected'),
  )
  assert.doesNotThrow(() =>
    assertCtfRangeOrderPreparationTransition('submission-rejected', 'terminal'),
  )
  assert.throws(
    () => assertCtfRangeOrderPreparationTransition('order-submitted', 'prepared'),
    /transition/,
  )

  const identity = preparationIdentity()
  const prepared = decodeCtfRangeOrderPreparationRecord({
    ...identity,
    lifecycleState: 'prepared',
    revision: 0,
    capability: null,
    updatedAtMs: identity.createdAtMs,
  })
  const requested = decodeCtfRangeOrderPreparationRecord({
    ...prepared,
    lifecycleState: 'capability-requested',
    revision: 1,
    updatedAtMs: identity.createdAtMs + 1,
  })
  const bound = bindCtfRangeOrderPreparationCapability({
    current: requested,
    expectedRevision: 1,
    capability: CAPABILITY,
    updatedAtMs: identity.createdAtMs + 2,
  })
  assert.equal(bound.lifecycleState, 'capability-bound')
  const clockMovedBackward = bindCtfRangeOrderPreparationCapability({
    current: requested,
    expectedRevision: 1,
    capability: CAPABILITY,
    updatedAtMs: identity.createdAtMs,
  })
  assert.equal(clockMovedBackward.lifecycleState, 'capability-bound')
  assert.equal(clockMovedBackward.revision, 2)
  assert.equal(clockMovedBackward.updatedAtMs, requested.updatedAtMs)
  assert.deepEqual(
    bindCtfRangeOrderPreparationCapability({
      current: bound,
      expectedRevision: 1,
      capability: CAPABILITY,
      updatedAtMs: identity.createdAtMs + 2,
    }),
    bound,
  )
  assert.equal(
    decodeCtfRangeOrderPreparationRecord({
      ...identity,
      lifecycleState: 'capability-bound',
      revision: 2,
      capability: CAPABILITY,
      updatedAtMs: identity.createdAtMs + 2,
    }).revision,
    2,
  )
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationRecord({
        ...identity,
        lifecycleState: 'submission-rejected',
        revision: 1,
        capability: null,
        updatedAtMs: identity.createdAtMs + 1,
      }),
    /lifecycle authority/,
  )
})

test('generic transitions and persisted capability pairing cover the complete lifecycle matrix', () => {
  const lifecycles = [
    'prepared',
    'capability-requested',
    'capability-bound',
    'order-submitted',
    'submission-rejected',
    'terminal',
  ] as const
  const genericTransitions = new Set([
    'prepared:terminal',
    'prepared:capability-requested',
    'capability-requested:terminal',
    'capability-bound:order-submitted',
    'capability-bound:submission-rejected',
    'capability-bound:terminal',
    'order-submitted:terminal',
    'submission-rejected:terminal',
  ])
  for (const from of lifecycles) {
    for (const to of lifecycles) {
      const transition = () => assertCtfRangeOrderPreparationTransition(from, to)
      if (genericTransitions.has(`${from}:${to}`)) {
        assert.doesNotThrow(transition)
      } else {
        assert.throws(transition, /transition/)
      }
    }
  }

  const identity = preparationIdentity()
  for (const lifecycleState of lifecycles) {
    for (const capability of [null, CAPABILITY] as const) {
      const decode = () =>
        decodeCtfRangeOrderPreparationRecord({
          ...identity,
          lifecycleState,
          revision: lifecycleState === 'prepared' ? 0 : 1,
          capability,
          updatedAtMs: identity.createdAtMs + 1,
        })
      const pairingIsValid =
        lifecycleState === 'terminal' ||
        (lifecycleState === 'prepared' || lifecycleState === 'capability-requested'
          ? capability === null
          : capability !== null)
      if (pairingIsValid) {
        assert.doesNotThrow(decode)
      } else {
        assert.throws(decode, /lifecycle authority/)
      }
    }
  }
})

test('page inputs are bounded and reject ambiguous cursors', () => {
  assert.equal(decodeCtfRangeOrderPreparationPageLimit(256), 256)
  assert.equal(
    decodeCtfRangeOrderPreparationPageCursor({
      createdAtMs: 12,
      rangeOperationId: 'range-1',
    }).rangeOperationId,
    'range-1',
  )
  assert.throws(() => decodeCtfRangeOrderPreparationPageLimit(257), /page limit/)
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationPageCursor({
        createdAtMs: -1,
        rangeOperationId: 'range-1',
      }),
    /cursor/,
  )
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationPageCursor({
        createdAtMs: 1,
        rangeOperationId: '',
      }),
    /cursor/,
  )
})

function preparationIdentity() {
  return {
    scopeId: `custody:wallet:${'11'.repeat(32)}`,
    rangeOperationId: 'range-1',
    sourceOperationId: 'source-1',
    sourceKind: 'wallet-prepared' as const,
    predecessorRangeOperationId: null,
    authorizationId: 'authorization-1',
    clientOrderId: 'client-1',
    orderRouteId: 'condition-1-YES',
    normalizedMint: 'https://mint.example',
    conditionId: 'condition-1',
    unit: 'msat' as const,
    tokenSide: 'Outcome' as const,
    side: 'Buy' as const,
    priceSubunits: 5_000,
    amountSubunits: 10_000,
    minimumFillAmountSubunits: 10_000,
    continueAfterPartialFill: false,
    continuation: null,
    divisibility: 10_000 as const,
    authorizationExpiresAtUnixSeconds: 2_000_000_000,
    preparationBytes: encodeCtfRangeOrderPreparationArtifact({
      rangeOperationId: 'range-1',
      authorizationId: 'authorization-1',
    }),
    createdAtMs: 10,
  }
}
