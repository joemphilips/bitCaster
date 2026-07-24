import assert from 'node:assert/strict'
import test from 'node:test'
import {
  addDurableWalletProofTransitionMetadata,
  assertDurableWalletProofResultMatchesPlan,
  createDurableWalletProofTransition,
  requireDurableWalletProofTransition,
} from '../src/durableWalletProofTransition.ts'

test('wallet proof transition binds exact groups and passthrough proofs', () => {
  const passthrough = {
    id: 'keyset-1',
    amount: 4,
    secret: 'unselected-secret',
    C: 'unselected-signature',
    dleq: { e: 'e', s: 's', r: 'r' },
    p2pk_e: 'p2pk-e',
    witness: { signatures: ['exact'] },
  }
  const policy = createDurableWalletProofTransition({
    inputSource: 'wallet',
    plannedOutputLabels: ['keep'],
    resultGroups: {
      keep: { kind: 'wallet', asset: 'regular', reservedBy: null },
    },
    passthroughResultGroups: { keep: [passthrough] },
  })
  const metadata = addDurableWalletProofTransitionMetadata({ unit: 'sat' }, policy)
  assert.equal(requireDurableWalletProofTransition(metadata, ['keep']).inputSource, 'wallet')
  assert.doesNotThrow(() =>
    assertDurableWalletProofResultMatchesPlan(
      policy,
      {
        keep: [
          {
            secret: 'fresh-secret',
            blindedMessage: { id: 'keyset-1', amount: 6 },
          },
        ],
      },
      {
        keep: [
          {
            id: 'keyset-1',
            amount: 6,
            secret: 'fresh-secret',
            C: 'fresh-signature',
          },
          passthrough,
        ],
      },
    ),
  )
  assert.throws(
    () =>
      assertDurableWalletProofResultMatchesPlan(
        policy,
        {
          keep: [
            {
              secret: 'fresh-secret',
              blindedMessage: { id: 'keyset-1', amount: 6 },
            },
          ],
        },
        {
          keep: [
            {
              id: 'keyset-1',
              amount: 6,
              secret: 'fresh-secret',
              C: 'fresh-signature',
            },
            { ...passthrough, C: 'foreign-signature' },
          ],
        },
      ),
    /passthrough result is not exact/,
  )
})

test('wallet proof transition accepts max passthroughs and rejects max plus one', () => {
  const proofs = Array.from({ length: 512 }, (_, index) => ({
    id: 'keyset-1',
    amount: 1,
    secret: `secret-${index}`,
    C: `signature-${index}`,
  }))
  assert.equal(
    createDurableWalletProofTransition({
      inputSource: 'wallet',
      plannedOutputLabels: ['keep'],
      resultGroups: {
        keep: { kind: 'wallet', asset: 'regular', reservedBy: null },
      },
      passthroughResultGroups: { keep: proofs },
    }).passthroughResultGroups.keep?.length,
    512,
  )
  assert.throws(
    () =>
      createDurableWalletProofTransition({
        inputSource: 'wallet',
        plannedOutputLabels: ['keep'],
        resultGroups: {
          keep: { kind: 'wallet', asset: 'regular', reservedBy: null },
        },
        passthroughResultGroups: {
          keep: [...proofs, { ...proofs[0]!, secret: 'overflow' }],
        },
      }),
    /passthrough limit/,
  )
  assert.throws(
    () =>
      createDurableWalletProofTransition({
        inputSource: 'wallet',
        plannedOutputLabels: Array.from({ length: 17 }, (_, index) => `group-${index}`),
        resultGroups: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`group-${index}`, { kind: 'operation' }]),
        ),
      }),
    /group limit/,
  )
})
