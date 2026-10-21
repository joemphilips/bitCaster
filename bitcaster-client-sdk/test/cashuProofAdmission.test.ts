import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  requireSupportedCashuKeysetId,
  requireValidCashuProofs,
} from '../src/cashuProofAdmission.ts'

const privateKey = Uint8Array.from([...new Uint8Array(31), 7])
const keys = { '1': bytesToHex(secp256k1.getPublicKey(privateKey, true)) }
const ordinaryId = deriveKeysetId(keys, { unit: 'sat', versionByte: 1 })
const conditionalId = deriveConditionalKeysetId({
  keys,
  unit: 'sat',
  conditionId: 'ab'.repeat(32),
  outcomeCollectionId: 'cd'.repeat(32),
})

function signedProof(id = ordinaryId): Proof {
  const output = OutputData.createSingleData(1, ordinaryId, 'public-test-proof', 11n)
  const blinded = pointFromHex(output.blindedMessage.B_)
  const signature = createBlindSignature(blinded, privateKey, ordinaryId)
  const dleq = createDLEQProof(blinded, privateKey)
  return {
    ...output.toProof(
      {
        id: ordinaryId,
        amount: output.blindedMessage.amount,
        C_: signature.C_.toHex(true),
        dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
      },
      { id: ordinaryId, keys },
    ),
    id,
  }
}

for (const id of [ordinaryId, conditionalId, '00' + 'ab'.repeat(7), '02legacyAB_-']) {
  test(`admits real secp DLEQ for supported resolved ID ${id.slice(0, 12)}`, () => {
    const proof = signedProof(id)
    const supplied = Object.freeze({ ...proof, amount: 1, dleq: Object.freeze({ ...proof.dleq! }) })
    assert.equal(
      requireValidCashuProofs([supplied], () => ({ id, keys })),
      undefined,
    )
    assert.equal(supplied.amount, 1)
    assert.equal(supplied.dleq.r, proof.dleq!.r)
  })
}

for (const id of [
  '02' + 'ab'.repeat(32),
  '03' + 'ab'.repeat(32),
  'ff' + 'ab'.repeat(32),
  ordinaryId.slice(0, 16),
  '01',
  ordinaryId.toUpperCase(),
]) {
  test(`rejects unsupported or unresolved ID before any lookup: ${id.slice(0, 16)}`, () => {
    let lookups = 0
    let writes = 0
    assert.throws(() => {
      requireValidCashuProofs([signedProof(), signedProof(id)], () => {
        lookups++
        return { id: ordinaryId, keys }
      })
      writes++
    }, /supported resolved/)
    assert.equal(lookups, 0)
    assert.equal(writes, 0)
  })
}

test('same keys with a foreign resolved ID cannot verify a proof', () => {
  assert.throws(
    () => requireValidCashuProofs([signedProof()], () => ({ id: conditionalId, keys })),
    /does not match/,
  )
})

const invalidProofs: Array<[string, (proof: Proof) => Proof]> = [
  ['missing DLEQ', (proof) => ({ ...proof, dleq: undefined })],
  ['missing r', (proof) => ({ ...proof, dleq: { ...proof.dleq!, r: undefined } })],
  ['invalid DLEQ', (proof) => ({ ...proof, dleq: { ...proof.dleq!, s: '00'.repeat(32) } })],
  ['wrong amount', (proof) => ({ ...proof, amount: Amount.from(2) })],
  ['malformed point', (proof) => ({ ...proof, C: '02' + 'ff'.repeat(32) })],
  ['changed secret', (proof) => ({ ...proof, secret: 'different-public-fixture' })],
]
for (const [name, corrupt] of invalidProofs)
  test(`rejects ${name} before a custody write`, () => {
    let writes = 0
    assert.throws(() => {
      requireValidCashuProofs([signedProof(), corrupt(signedProof())], () => ({
        id: ordinaryId,
        keys,
      }))
      writes++
    })
    assert.equal(writes, 0)
  })

test('lookup failures reject synchronously', () => {
  assert.throws(
    () =>
      requireValidCashuProofs([signedProof()], () => {
        throw new Error('lookup failed')
      }),
    /lookup failed/,
  )
})

test('legacy classification precedes a hexadecimal-looking version prefix', () => {
  assert.doesNotThrow(() => requireSupportedCashuKeysetId('02abcdefabcd'))
})
