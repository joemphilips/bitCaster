import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { Amount, PaymentRequest } from '@cashu/cashu-ts'
import {
  createAmountlessCashuPaymentRequest,
  derivePaymentRequestReceiveKeyPair,
  readPendingCashuPaymentRequestMessage,
  type PendingCashuPaymentRequestBinding,
} from '../src/paymentRequest.ts'

// Public NUT-18 example transport.
const NPROFILE =
  'nprofile1qy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsz9mhwden5te0wfjkccte9curxven9eehqctrv5hszrthwden5te0dehhxtnvdakqqgydaqy7curk439ykptkysv7udhdhu68sucm295akqefdehkf0d495cwunl5'
const pending: PendingCashuPaymentRequestBinding = {
  id: 'request-a',
  mintUrl: 'https://mint.example',
  walletScopeId: 'wallet-a',
}
const proof = { id: 'keyset', secret: 'fixture-proof', C: 'fixture-signature', amount: 42 }
const payload = { id: pending.id, mint: pending.mintUrl, unit: 'msat', proofs: [proof] }

function readMessage(
  content: string,
  binding: PendingCashuPaymentRequestBinding | undefined = pending,
) {
  return readPendingCashuPaymentRequestMessage({
    content,
    walletScopeId: 'wallet-a',
    readPending: () => binding,
  })
}

test('amountless NUT-18 request roundtrip keeps exact id, mint, msat, and NIP-17 transport', () => {
  const created = createAmountlessCashuPaymentRequest({
    id: pending.id,
    mintUrl: 'https://MINT.example/',
    nprofile: NPROFILE,
  })
  const decoded = PaymentRequest.fromEncodedRequest(created.encoded)
  assert.equal(decoded.id, pending.id)
  assert.equal(decoded.amount, undefined)
  assert.equal(decoded.unit, 'msat')
  assert.equal(decoded.singleUse, false)
  assert.ok(isDeepStrictEqual(decoded.mints, [pending.mintUrl]))
  assert.ok(
    isDeepStrictEqual(decoded.transport, [
      {
        type: 'nostr',
        target: NPROFILE,
        tags: [['n', '17']],
      },
    ]),
  )
})

test('receive identity uses only the first 32 bytes of the 64-byte wallet seed', () => {
  const seed = new Uint8Array(64).fill(1)
  const original = seed.slice()
  const first = derivePaymentRequestReceiveKeyPair(seed)
  seed.fill(2, 32)
  const second = derivePaymentRequestReceiveKeyPair(seed)
  assert.equal(first.publicKey, second.publicKey)
  assert.ok(isDeepStrictEqual(first.privateKey, original.slice(0, 32)), 'receive key changed')
  first.privateKey.fill(3)
  assert.ok(isDeepStrictEqual(seed.slice(0, 32), original.slice(0, 32)), 'seed was modified')
})

test('invalid receive seed fails with a constant error without private material', () => {
  assert.throws(() => derivePaymentRequestReceiveKeyPair(new Uint8Array(32)), {
    message: 'payment receive identity requires a 64-byte wallet seed',
  })
  assert.throws(() => derivePaymentRequestReceiveKeyPair(new Uint8Array(64)), {
    message: 'payment receive identity has an invalid private key',
  })
})

test('pending message accepts numeric amounts and real Cashu Amount JSON strings', () => {
  for (const amount of [42, Amount.from(42)]) {
    const content = JSON.stringify({
      ...payload,
      mint: 'https://MINT.example/',
      proofs: [{ ...proof, amount }],
    })
    const matched = readMessage(content)
    assert.ok(matched !== null, 'matching payment was ignored')
    assert.equal(matched.payload.id, pending.id)
    assert.equal(matched.normalizedMint, pending.mintUrl)
    assert.equal(matched.unit, 'msat')
  }
})

test('pending message refuses missing request, mismatched id, wallet scope, and mint', () => {
  const content = JSON.stringify(payload)
  for (const binding of [
    undefined,
    { ...pending, id: 'other-request' },
    { ...pending, walletScopeId: 'wallet-b' },
    { ...pending, mintUrl: 'https://other.example' },
  ]) {
    const matched = readPendingCashuPaymentRequestMessage({
      content,
      walletScopeId: 'wallet-a',
      readPending: () => binding,
    })
    assert.ok(matched === null, 'foreign pending binding was accepted')
  }
})

test('malformed or unrelated messages never escape validation or confer proof validity', () => {
  for (const content of [
    'not JSON',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...payload, id: 1 }),
    JSON.stringify({ ...payload, mint: {} }),
    JSON.stringify({ ...payload, proofs: {} }),
    JSON.stringify({ ...payload, proofs: [] }),
    JSON.stringify({ ...payload, proofs: [null] }),
    JSON.stringify({ ...payload, proofs: [{ ...proof, secret: {} }] }),
    JSON.stringify({ ...payload, proofs: [{ ...proof, amount: {} }] }),
    JSON.stringify({ ...payload, proofs: [{ ...proof, amount: Number.MAX_SAFE_INTEGER + 1 }] }),
    JSON.stringify({ ...payload, proofs: [{ ...proof, amount: 0 }] }),
    ...[
      '0x2a',
      '4.2e1',
      '+42',
      ' 42',
      '42 ',
      '042',
      '42.0',
      '0',
      '-42',
      '',
      '9007199254740992',
    ].map((amount) => JSON.stringify({ ...payload, proofs: [{ ...proof, amount }] })),
    JSON.stringify({ ...payload, unit: 'btc' }),
    JSON.stringify({ ...payload, unit: 'sat' }),
  ]) {
    assert.ok(readMessage(content) === null, 'malformed payment was accepted')
  }
  // These placeholder signatures pass only transport shape validation.
  // The caller must use its existing durable proof verification and credit path.
  assert.ok(readMessage(JSON.stringify(payload)) !== null)
})
