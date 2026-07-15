import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  DURABLE_WALLET_PROOF_TRANSITION_METADATA_KEY,
  addDurableWalletProofTransitionMetadata,
  assertDurableWalletProofResultGroups,
  assertDurableWalletProofResultMatchesPlan,
  createDurableWalletProofTransition,
  requireDurableWalletProofTransition,
} from '../src/durableWalletProofTransition.ts'

test('wallet proof transition binds exact input authority and output groups', () => {
  const policy = createDurableWalletProofTransition({
    inputSource: 'wallet',
    plannedOutputLabels: ['send', 'keep'],
    resultGroups: {
      send: { kind: 'operation' },
      keep: { kind: 'wallet', asset: 'regular', reservedBy: null },
    },
  })
  const metadata = addDurableWalletProofTransitionMetadata(
    { unit: 'sat' },
    policy,
  )

  assert.equal(metadata.unit, 'sat')
  assert.equal(
    requireDurableWalletProofTransition(metadata, ['keep', 'send']).inputSource,
    'wallet',
  )
  assert.doesNotThrow(() =>
    assertDurableWalletProofResultGroups(policy, ['send', 'keep']),
  )
  assert.deepEqual(policy.passthroughResultGroups, {})
})

test('wallet proof transition validates blinded outputs and exact passthroughs', () => {
  const passthrough = {
    id: 'keyset-1',
    amount: 4,
    secret: 'unselected-secret',
    C: 'unselected-C',
  }
  const policy = createDurableWalletProofTransition({
    inputSource: 'wallet',
    plannedOutputLabels: ['keep'],
    resultGroups: {
      keep: { kind: 'wallet', asset: 'regular', reservedBy: null },
    },
    passthroughResultGroups: { keep: [passthrough] },
  })
  const outputs = {
    keep: [
      {
        secret: 'fresh-secret',
        blindedMessage: { id: 'keyset-1', amount: 6 },
      },
    ],
  }
  const exact = {
    keep: [
      { id: 'keyset-1', amount: 6, secret: 'fresh-secret', C: 'fresh-C' },
      passthrough,
    ],
  }

  assert.doesNotThrow(() =>
    assertDurableWalletProofResultMatchesPlan(policy, outputs, exact),
  )
  assert.throws(
    () =>
      assertDurableWalletProofResultMatchesPlan(policy, outputs, {
        keep: exact.keep.slice(0, 1),
      }),
    /result count does not match/,
  )
  assert.throws(
    () =>
      assertDurableWalletProofResultMatchesPlan(policy, outputs, {
        keep: [exact.keep[0], { ...passthrough, C: 'foreign-C' }],
      }),
    /passthrough result is not exact/,
  )
})

test('wallet proof transition rejects missing, foreign, and overwritten policy', () => {
  assert.throws(
    () => requireDurableWalletProofTransition({}, ['keep']),
    /metadata is invalid/,
  )
  assert.throws(
    () =>
      createDurableWalletProofTransition({
        inputSource: 'external',
        plannedOutputLabels: ['keep'],
        resultGroups: {
          send: { kind: 'wallet', asset: 'regular', reservedBy: null },
        },
      }),
    /result labels are invalid/,
  )
  const policy = createDurableWalletProofTransition({
    inputSource: 'external',
    plannedOutputLabels: ['keep'],
    resultGroups: {
      keep: { kind: 'wallet', asset: 'regular', reservedBy: null },
    },
  })
  assert.throws(
    () =>
      addDurableWalletProofTransitionMetadata(
        { [DURABLE_WALLET_PROOF_TRANSITION_METADATA_KEY]: policy },
        policy,
      ),
    /already defined/,
  )
  assert.throws(
    () => assertDurableWalletProofResultGroups(policy, ['keep', 'send']),
    /result labels are invalid/,
  )
})

test('prefix cardinality accepts only the ordered melt-change prefix', () => {
  const policy = createDurableWalletProofTransition({
    inputSource: 'wallet',
    plannedOutputLabels: ['change'],
    resultGroups: {
      change: { kind: 'wallet', asset: 'regular', reservedBy: null },
    },
    resultCardinality: { change: 'prefix' },
  })
  const outputs = {
    change: [
      { secret: 'change-1', blindedMessage: { id: 'keyset-1', amount: 0 } },
      { secret: 'change-2', blindedMessage: { id: 'keyset-1', amount: 0 } },
    ],
  }

  assert.doesNotThrow(() =>
    assertDurableWalletProofResultMatchesPlan(policy, outputs, { change: [] }),
  )
  assert.doesNotThrow(() =>
    assertDurableWalletProofResultMatchesPlan(policy, outputs, {
      change: [
        { id: 'keyset-1', amount: 1, secret: 'change-1', C: 'change-C-1' },
      ],
    }),
  )
  assert.throws(
    () =>
      assertDurableWalletProofResultMatchesPlan(policy, outputs, {
        change: [
          { id: 'keyset-1', amount: 1, secret: 'change-2', C: 'change-C-2' },
        ],
      }),
    /prefix does not match/,
  )
  assert.throws(
    () =>
      createDurableWalletProofTransition({
        inputSource: 'wallet',
        plannedOutputLabels: ['change'],
        resultGroups: {
          change: { kind: 'wallet', asset: 'regular', reservedBy: null },
        },
        resultCardinality: { change: 'prefix' },
        passthroughResultGroups: {
          change: [{ id: 'keyset-1', amount: 1, secret: 'old', C: 'old-C' }],
        },
      }),
    /prefix.*passthrough/,
  )
})
