import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createSeedRecoveryScanPolicy,
  validateSeedRecoveryScanPolicy,
  SEED_RECOVERY_MAX_GAP_LIMIT,
} from '../src/seedRecoveryScanPolicy.ts'

const CONDITION = 'ab'.repeat(32)

test('default recovery selects only regular msat with the accepted gap', () => {
  assert.deepEqual(createSeedRecoveryScanPolicy(), {
    version: 1,
    scope: 'regular-msat',
    gapLimit: 300,
  })
  assert.deepEqual(createSeedRecoveryScanPolicy({ conditionId: CONDITION, gapLimit: 901 }), {
    version: 1,
    scope: 'condition',
    conditionId: CONDITION,
    gapLimit: 901,
  })
})

test('gap policy accepts positive integer bounds without changing batch size', () => {
  for (const gapLimit of [1, 299, 300, 301, SEED_RECOVERY_MAX_GAP_LIMIT]) {
    assert.equal(createSeedRecoveryScanPolicy({ gapLimit }).gapLimit, gapLimit)
  }
  for (const gapLimit of [0, -1, 1.5, NaN, Infinity, SEED_RECOVERY_MAX_GAP_LIMIT + 1]) {
    assert.throws(() => createSeedRecoveryScanPolicy({ gapLimit }))
  }
})

test('persisted scope cannot silently fall back or accept a different shape', () => {
  const valid = createSeedRecoveryScanPolicy({ conditionId: CONDITION })
  assert.deepEqual(validateSeedRecoveryScanPolicy(valid), valid)
  for (const value of [
    undefined,
    null,
    [],
    {},
    { ...valid, version: 2 },
    { ...valid, gapLimit: null },
    { ...valid, gapLimit: '300' },
    { ...valid, gapLimit: true },
    { ...valid, scope: 'all' },
    { ...valid, unit: 'sat' },
    { ...valid, conditionId: undefined },
    { ...valid, conditionId: CONDITION.toUpperCase() },
    { ...valid, conditionId: '' },
    { version: 1, scope: 'regular-msat', gapLimit: 300, conditionId: CONDITION },
  ])
    assert.throws(() => validateSeedRecoveryScanPolicy(value))
})

test('misspelled or legacy constructor options cannot silently select the default scope', () => {
  for (const input of [
    null,
    [],
    'msat',
    { conditionID: CONDITION },
    { scope: 'all' },
    { conditionId: CONDITION, gaplimit: 500 },
    { unit: 'sat' },
  ]) {
    assert.throws(() =>
      createSeedRecoveryScanPolicy(input as Parameters<typeof createSeedRecoveryScanPolicy>[0]),
    )
  }
})

test('validation snapshots the policy and does not retain caller mutation', () => {
  const input = { version: 1, scope: 'condition', conditionId: CONDITION, gapLimit: 300 }
  const policy = validateSeedRecoveryScanPolicy(input)
  input.conditionId = 'cd'.repeat(32)
  input.gapLimit = 999
  assert.deepEqual(policy, {
    version: 1,
    scope: 'condition',
    conditionId: CONDITION,
    gapLimit: 300,
  })
  assert.equal(Object.isFrozen(policy), true)
})
