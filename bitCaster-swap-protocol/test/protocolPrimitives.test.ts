import assert from 'node:assert/strict'
import { test } from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  MIN_LOCKTIME_DELTA_SECS,
  validateLocktimeOrdering,
} from '../src/atomicSwap.ts'
import {
  adapt,
  extract,
  generateAdaptorPoint,
  preSign,
  preVerify,
} from '../src/adaptor.ts'
import {
  computeSharedSecret,
  decrypt,
  deriveEncryptionKey,
  encrypt,
  generateEphemeralKeypair,
} from '../src/ecdh.ts'
import { createP2PKSecret, createP2PKWitness } from '../src/p2pk.ts'
import { normalizeUrl, safeHostname } from '../src/url.ts'

test('validateLocktimeOrdering enforces the atomic-swap refund invariant', () => {
  assert.equal(
    validateLocktimeOrdering(100 + MIN_LOCKTIME_DELTA_SECS + 1, 100),
    null,
  )
  assert.match(
    validateLocktimeOrdering(100 + MIN_LOCKTIME_DELTA_SECS, 100) ?? '',
    /locktime ordering violates protocol invariant/,
  )
  assert.match(
    validateLocktimeOrdering(Number.NaN, 100) ?? '',
    /invalid locktime values/,
  )
})

test('ECDH helpers derive the same key for both sides and decrypt round trips', async () => {
  const alice = generateEphemeralKeypair()
  const bob = generateEphemeralKeypair()
  const aliceShared = computeSharedSecret(alice.privateKey, bob.publicKey)
  const bobShared = computeSharedSecret(bob.privateKey, alice.publicKey)

  assert.deepEqual(aliceShared, bobShared)

  const aliceKey = await deriveEncryptionKey(aliceShared)
  const bobKey = await deriveEncryptionKey(bobShared)
  const ciphertext = await encrypt(aliceKey, 'seller locked proofs')

  assert.equal(await decrypt(bobKey, ciphertext), 'seller locked proofs')
})

test('adaptor signatures preverify, adapt, and extract the adaptor secret', () => {
  const signer = generateEphemeralKeypair()
  const message = new Uint8Array(32).fill(7)
  const adaptor = generateAdaptorPoint()
  const preSig = preSign(signer.privateKey, message, adaptor.point)
  const signerPubkey = hexToBytes(signer.publicKey)

  assert.equal(preVerify(signerPubkey, message, preSig, adaptor.point), true)

  const finalSig = adapt(preSig, adaptor.secret)
  assert.equal(schnorr.verify(finalSig, message, signerPubkey.slice(1)), true)
  assert.deepEqual(extract(finalSig, preSig), adaptor.secret)
})

test('P2PK helpers produce NUT-11 secret and witness shapes', () => {
  const signer = generateEphemeralKeypair()
  const refund = generateEphemeralKeypair()
  const secret = JSON.parse(
    createP2PKSecret({
      recipientPubkey: signer.publicKey,
      locktime: 1_779_393_600,
      refundPubkey: refund.publicKey,
    }),
  ) as [string, { data: string; tags: string[][] }]

  assert.equal(secret[0], 'P2PK')
  assert.equal(secret[1].data, signer.publicKey)
  assert.deepEqual(secret[1].tags, [
    ['sigflag', 'SIG_INPUTS'],
    ['locktime', '1779393600'],
    ['refund', refund.publicKey],
  ])

  const message = new Uint8Array(32).fill(3)
  const witness = JSON.parse(createP2PKWitness(signer.privateKey, message)) as {
    signatures: string[]
  }
  assert.equal(witness.signatures.length, 1)
  assert.equal(witness.signatures[0].length, 128)
  assert.throws(
    () => createP2PKWitness(signer.privateKey, new Uint8Array(31)),
    /message must be 32 bytes/,
  )
})

test('URL helpers normalize mint identifiers consistently', () => {
  assert.equal(normalizeUrl('https://mint.example///'), 'https://mint.example')
  assert.equal(safeHostname('https://mint.example/path'), 'mint.example')
  assert.equal(safeHostname('not a url'), 'not a url')
})

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string has odd length')
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
