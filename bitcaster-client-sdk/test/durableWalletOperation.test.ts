import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeDurableWalletOperation,
  deriveDurableWalletOperationAuthority,
  requireDurableWalletOperationFromCustody,
  toDurableCustodyProofOperationInput,
} from '../src/durableWalletOperation.ts'

function walletSend() {
  return {
    schemaVersion: 1,
    operationId: 'wallet-send-1',
    kind: 'wallet-send',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview: {
      amount: '1',
      fees: '0',
      keysetId: 'keyset-1',
      inputs: [
        {
          id: 'keyset-1',
          amount: '1',
          secret: 'input-secret',
          C: 'input-signature',
          dleq: null,
          p2pkE: null,
          witness: null,
        },
      ],
      sendOutputs: [
        {
          blindedMessage: { amount: '1', id: 'keyset-1', B_: 'blinded-1' },
          blindingFactor: 'blinding-1',
          secret: 'output-secret',
          ephemeralE: null,
        },
      ],
      keepOutputs: [],
      unselectedProofs: [],
    },
  } as const
}

test('wallet operation decoder is strict and binds exact mint/unit authority', () => {
  const operation = decodeDurableWalletOperation(walletSend())
  assert.equal(operation.kind, 'wallet-send')
  assert.equal(operation.unit, 'sat')
  assert.throws(
    () => decodeDurableWalletOperation({ ...walletSend(), foreignAuthority: true }),
    /foreign fields/,
  )
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        mintUrl: 'https://mint.example/',
      }),
    /normalized/,
  )
  assert.throws(() => decodeDurableWalletOperation({ ...walletSend(), unit: '' }), /unit/)
})

test('wallet operation converts to and recovers from exact custody authority', () => {
  const custody = toDurableCustodyProofOperationInput(walletSend())
  const recovered = requireDurableWalletOperationFromCustody(custody)
  const authority = deriveDurableWalletOperationAuthority(recovered)
  assert.equal(custody.kind, 'wallet-send')
  assert.equal(custody.metadata?.unit, 'sat')
  assert.match(authority.requestFingerprint, /^[0-9a-f]{64}$/)
  assert.match(authority.outputPlanFingerprint, /^[0-9a-f]{64}$/)
  assert.throws(
    () =>
      requireDurableWalletOperationFromCustody({
        ...custody,
        mintUrl: 'https://foreign.example',
      }),
    /exact persisted operation/,
  )
})

test('wallet operation rejects mixed or foreign persisted variants', () => {
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        kind: 'foreign-operation',
      }),
    /kind/,
  )
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        preview: {
          ...walletSend().preview,
          foreignAuthority: 1,
        },
      }),
    /foreign fields/,
  )
})

test('wallet operation enforces the shared proof maximum exactly', () => {
  const proof = walletSend().preview.inputs[0]!
  const unselectedProofs = Array.from({ length: 512 }, (_, index) => ({
    ...proof,
    secret: `unselected-${index}`,
    C: `signature-${index}`,
  }))
  assert.equal(
    (
      decodeDurableWalletOperation({
        ...walletSend(),
        preview: { ...walletSend().preview, unselectedProofs },
      }) as { preview: { unselectedProofs: unknown[] } }
    ).preview.unselectedProofs.length,
    512,
  )
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        preview: {
          ...walletSend().preview,
          unselectedProofs: [...unselectedProofs, proof],
        },
      }),
    /unselected proofs are invalid/,
  )
})

test('wallet operation rejects URL aliases and foreign nested DLEQ fields', () => {
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        mintUrl: 'https://mint.example:443',
      }),
    /normalized/,
  )
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        preview: {
          ...walletSend().preview,
          inputs: [
            {
              ...walletSend().preview.inputs[0],
              dleq: { e: 'e', s: 's', r: null, foreign: true },
            },
          ],
        },
      }),
    /foreign fields/,
  )
})
