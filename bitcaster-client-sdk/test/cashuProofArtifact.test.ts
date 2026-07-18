import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Amount } from '@cashu/cashu-ts'
import { bls12_381 } from '@noble/curves/bls12-381.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  classifyCashuSecret,
  decodeStrictCashuProofArtifact,
  decodeStrictP2pkCondition,
  isStrictAtomicSwapP2pkProofArtifact,
  isStrictCashuProofArtifact,
  isStrictP2pkCashuProofArtifact,
} from '../src/cashuProofArtifact.ts'

const SECP256K1_GENERATOR =
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const COUNTERPARTY_PUBKEY = bytesToHex(
  secp256k1.getPublicKey(new Uint8Array(32).fill(2), true),
)
const BLS_G1_GENERATOR = bytesToHex(bls12_381.G1.Point.BASE.toBytes(true))
const LEGACY_KEYSET_ID = '9mlfd5vCzgGl'
const V1_KEYSET_ID = `00${'22'.repeat(7)}`
const V2_KEYSET_ID = `01${'22'.repeat(32)}`
const V3_KEYSET_ID = `02${'22'.repeat(32)}`
const LOCKTIME = 1_999_999_900

function proof(overrides: Record<string, unknown> = {}) {
  return {
    id: V1_KEYSET_ID,
    amount: Amount.from(1),
    secret: p2pkSecret(),
    C: SECP256K1_GENERATOR,
    dleq: validDleq(),
    ...overrides,
  }
}

function validDleq() {
  return {
    e: '11'.repeat(32),
    s: '22'.repeat(32),
    r: '33'.repeat(32),
  }
}

function atomicSwapTags(): string[][] {
  return [
    ['locktime', String(LOCKTIME)],
    ['pubkeys', COUNTERPARTY_PUBKEY],
    ['n_sigs', '2'],
    ['refund', SECP256K1_GENERATOR],
  ]
}

function p2pkSecret(
  tags: string[][] = atomicSwapTags(),
  overrides: Record<string, unknown> = {},
  kind = 'P2PK',
): string {
  return JSON.stringify([
    kind,
    {
      nonce: '55'.repeat(32),
      data: SECP256K1_GENERATOR,
      tags,
      ...overrides,
    },
  ])
}

const binding = {
  lockerPubkey: SECP256K1_GENERATOR,
  counterpartyPubkey: COUNTERPARTY_PUBKEY,
  locktime: LOCKTIME,
}

test('secret classifier treats current, future, and damaged NUT-10 envelopes as conditional', () => {
  for (const secret of [
    p2pkSecret(),
    JSON.stringify(['HTLC', { nonce: '11', data: '22' }]),
    JSON.stringify(['FUTURE_LOCK', { nonce: '11', data: '22' }]),
    JSON.stringify(['FUTURE_LOCK', null]),
    JSON.stringify(['P2PK']),
    JSON.stringify(['HTLC', null, 'extra']),
  ]) {
    assert.equal(classifyCashuSecret(secret), 'conditional')
  }
  for (const secret of ['ordinary-secret', '[]', JSON.stringify([1, null])]) {
    assert.equal(classifyCashuSecret(secret), 'ordinary')
  }
})

test('strict decoder accepts canonical legacy and NUT-02 V1/V2/V3 keysets', () => {
  const cases = [
    [LEGACY_KEYSET_ID, SECP256K1_GENERATOR, validDleq()],
    [V1_KEYSET_ID, SECP256K1_GENERATOR, validDleq()],
    [V2_KEYSET_ID, SECP256K1_GENERATOR, validDleq()],
    [V3_KEYSET_ID, BLS_G1_GENERATOR, undefined],
  ] as const

  for (const [id, C, dleq] of cases) {
    const artifact = proof({ id, C, dleq })
    assert.equal(decodeStrictCashuProofArtifact(artifact).id, id)
    assert.equal(isStrictCashuProofArtifact(structuredClone(artifact)), true)
  }
})

test('strict decoder accepts every canonical positive Cashu AmountLike form', () => {
  const amounts = [
    1,
    1n,
    '1',
    Amount.from(1),
    { value: 1n },
    BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    String(BigInt(Number.MAX_SAFE_INTEGER) + 1n),
  ]

  for (const amount of amounts) {
    assert.equal(
      decodeStrictCashuProofArtifact(proof({ amount })).amount.toBigInt() > 0n,
      true,
    )
  }
})

test('strict decoder rejects nonpositive or noncanonical amount forms', () => {
  const amounts = [0, 0n, '0', '01', '+1', -1, 1.5, { value: 1 }]
  for (const amount of amounts) {
    assert.equal(isStrictCashuProofArtifact(proof({ amount })), false)
  }
})

test('strict decoder rejects unknown, compact, and noncanonical keyset ids', () => {
  const ids = [
    `03${'22'.repeat(32)}`,
    `01${'22'.repeat(7)}`,
    `02${'22'.repeat(7)}`,
    `00${'ab'.repeat(7)}`.toUpperCase(),
    `01${'ab'.repeat(32)}`.toUpperCase(),
    'AAAAAAAAAAAA',
    '9mlfd5vCzgG=',
    '9mlfd5vCzgG_',
    'not-a-keyset-id',
  ]
  for (const id of ids) {
    assert.equal(isStrictCashuProofArtifact(proof({ id })), false)
  }
})

test('strict decoder rejects field, point, and curve mutations', () => {
  const mutations = [
    proof({ extra: true }),
    proof({ C: `02${'ff'.repeat(32)}` }),
    proof({ p2pk_e: `02${'ff'.repeat(32)}` }),
    proof({ dleq: { e: '11'.repeat(32), s: '22'.repeat(32), extra: true } }),
    proof({ dleq: { e: 'zz'.repeat(32), s: '22'.repeat(32) } }),
    proof({ id: V3_KEYSET_ID, C: BLS_G1_GENERATOR, dleq: validDleq() }),
  ]
  for (const mutation of mutations) {
    assert.equal(isStrictCashuProofArtifact(mutation), false)
  }
})

test('strict decoder accepts exact optional P2PK and witness artifacts', () => {
  const artifact = proof({
    p2pk_e: SECP256K1_GENERATOR,
    witness: JSON.stringify({ signatures: ['44'.repeat(64)] }),
  })
  assert.equal(isStrictCashuProofArtifact(artifact), true)
  assert.equal(isStrictP2pkCashuProofArtifact(artifact), true)
})

test('strict decoder rejects malformed witness artifacts', () => {
  const witnesses = [
    '{',
    JSON.stringify({ signatures: ['ff'], extra: true }),
    { signatures: [1] },
  ]
  for (const witness of witnesses) {
    assert.equal(isStrictCashuProofArtifact(proof({ witness })), false)
  }
})

test('strict P2PK decoder exposes exact valid spending semantics', () => {
  const condition = decodeStrictP2pkCondition(p2pkSecret())
  assert.deepEqual(condition, {
    pubkeys: [SECP256K1_GENERATOR, COUNTERPARTY_PUBKEY],
    requiredSignatures: 2,
    locktime: LOCKTIME,
    refundPubkeys: [SECP256K1_GENERATOR],
    requiredRefundSignatures: 1,
    sigFlag: 'SIG_INPUTS',
    additionalTags: [],
  })
  assert.equal(isStrictP2pkCashuProofArtifact(proof()), true)
})

test('strict P2PK decoder rejects HTLC, malformed keys, tags, and witnesses', () => {
  const secrets = [
    p2pkSecret(atomicSwapTags(), {}, 'HTLC'),
    p2pkSecret(atomicSwapTags(), { nonce: 'short' }),
    p2pkSecret(atomicSwapTags(), { data: `02${'ff'.repeat(32)}` }),
    p2pkSecret(atomicSwapTags(), { extra: true }),
    p2pkSecret([...atomicSwapTags(), ['n_sigs', '2']]),
    p2pkSecret([['pubkeys', SECP256K1_GENERATOR], ['n_sigs', '2']]),
    p2pkSecret([['pubkeys', COUNTERPARTY_PUBKEY], ['n_sigs', '3']]),
    p2pkSecret([
      ['locktime', String(LOCKTIME)],
      ['pubkeys', COUNTERPARTY_PUBKEY],
      ['n_sigs', '2x'],
    ]),
    p2pkSecret([
      ['locktime', String(LOCKTIME)],
      ['refund', COUNTERPARTY_PUBKEY],
      ['n_sigs_refund', '2'],
    ]),
  ]
  for (const secret of secrets) {
    assert.equal(isStrictP2pkCashuProofArtifact(proof({ secret })), false)
  }
  assert.equal(
    isStrictP2pkCashuProofArtifact(
      proof({ witness: JSON.stringify({ preimage: 'secret' }) }),
    ),
    false,
  )
})

test('atomic-swap predicate binds the exact production 2-of-2 proof', () => {
  assert.equal(isStrictAtomicSwapP2pkProofArtifact(proof(), binding), true)
  assert.equal(
    isStrictAtomicSwapP2pkProofArtifact(
      proof({
        secret: p2pkSecret([...atomicSwapTags(), ['sigflag', 'SIG_INPUTS']]),
      }),
      binding,
    ),
    true,
  )
})

test('atomic-swap predicate rejects semantic and pristine-state mutations', () => {
  const mutations = [
    proof({
      secret: p2pkSecret([
        ['locktime', String(LOCKTIME)],
        ['pubkeys', SECP256K1_GENERATOR],
        ['n_sigs', '2'],
        ['refund', COUNTERPARTY_PUBKEY],
      ], { data: COUNTERPARTY_PUBKEY }),
    }),
    proof({
      secret: p2pkSecret(
        atomicSwapTags().map((tag) =>
          tag[0] === 'n_sigs' ? ['n_sigs', '1'] : tag,
        ),
      ),
    }),
    proof({
      secret: p2pkSecret(
        atomicSwapTags().map((tag) =>
          tag[0] === 'locktime' ? ['locktime', String(LOCKTIME + 1)] : tag,
        ),
      ),
    }),
    proof({
      secret: p2pkSecret(
        atomicSwapTags().map((tag) =>
          tag[0] === 'refund' ? ['refund', COUNTERPARTY_PUBKEY] : tag,
        ),
      ),
    }),
    proof({ secret: p2pkSecret([...atomicSwapTags(), ['sigflag', 'SIG_ALL']]) }),
    proof({ secret: p2pkSecret([...atomicSwapTags(), ['custom', 'value']]) }),
    proof({ witness: JSON.stringify({ signatures: ['44'.repeat(64)] }) }),
    proof({ p2pk_e: SECP256K1_GENERATOR }),
  ]
  for (const mutation of mutations) {
    assert.equal(isStrictAtomicSwapP2pkProofArtifact(mutation, binding), false)
  }
  assert.equal(
    isStrictAtomicSwapP2pkProofArtifact(proof(), {
      ...binding,
      locktime: LOCKTIME + 1,
    }),
    false,
  )
})
