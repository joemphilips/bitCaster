import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Amount,
  computeCtfManifestCommitment,
  computeCtfReceiveCommitment,
  hashToCurve,
  type CtfPoolEntry,
} from '@cashu/cashu-ts'
import {
  decodeSettlementCapabilityArtifact,
  decodeSettlementCapabilityArtifactBytes,
  deriveSettlementCapabilityArtifactDigest,
  encodeSettlementCapabilityArtifact,
  type PoolSettlementCapabilityArtifact,
  type SettlementCapabilityInputProof,
  type SettlementCapabilityOutput,
  type StandardSettlementCapabilityArtifact,
} from '../src/settlementCapabilityArtifact.ts'

const CONDITION_ID = 'aa'.repeat(32)
const ROOT_PARENT = '00'.repeat(32)
const OFFER_KEYSET = '0011223344556677'
const RECEIVE_KEYSET = `01${'aa'.repeat(32)}`
const POINT_ONE = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const POINT_TWO = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
const POOL_PROOF_SIGNATURE =
  '023487d4b2fd7302862ed765610fbcfa3355b637ad0169864b08d78644bc8beeb6'
const POOL_DLEQ = {
  e: '7434a6e4a1b0e088ae76020be608ffc3ec5a1893006827d9705f22976ec0fb7f',
  s: '814bdafc32472f25f6c4f4dacc5b00bfcabad0da23eeee347d9d901236b132a5',
  r: `${'00'.repeat(31)}02`,
}
const STANDARD_PROOF_SIGNATURE =
  '020d68ea1adf998eb2410b7166ec9ec6af54acb271da6ba6217ebf61bb2538456b'
const STANDARD_DLEQ = {
  e: 'ab58be47708cfc6f89c3758ac2762cfda5ae4ef7b0d5739cc7d7b4ef9285ac0f',
  s: '3d56f54925056745f6ccdb440d9006f9278674aece62526f43bfe6528db0a01d',
  r: `${'00'.repeat(31)}02`,
}
const COORDINATOR_KEY = POINT_ONE.slice(2)
const REFUND_KEY = COORDINATOR_KEY
const EXPIRY = 2_000_000_000
const POOL_COMMITMENT = '92be6e407746227598f9a32c4c2c8b695b716ba1e3fec372f88175a1fc669c4b'
const POOL_PROOF_Y = '023487d4b2fd7302862ed765610fbcfa3355b637ad0169864b08d78644bc8beeb6'
const POOL_ARTIFACT_DIGEST = 'eaa35d8555b53e33acc6f995e2f4907429fd8ed795c8098f36abbdc8cc8274bc'
const STANDARD_ARTIFACT_DIGEST =
  'ef93567954cad6bb9dc249ac3d05ecc32ba088437d857736c1897359dfa58809'

function standardFixture(): StandardSettlementCapabilityArtifact {
  const outputs: SettlementCapabilityOutput[] = [{ amount: '4', id: RECEIVE_KEYSET, B_: POINT_TWO }]
  const commitment = computeCtfReceiveCommitment(
    outputs.map((output) => ({ ...output, amount: Amount.from(output.amount) })),
  )
  const secret = payToUnlockSecret(commitment)
  return {
    ...commonFixture(
      secret,
      'standard-operation-1',
      'authorization-standard-1',
      STANDARD_PROOF_SIGNATURE,
      STANDARD_DLEQ,
    ),
    authorizationMode: 'standard',
    outputs,
  }
}

function poolFixture(): PoolSettlementCapabilityArtifact {
  const entries: CtfPoolEntry[] = [
    { index: '0', role: 'receive', amount: '1', id: RECEIVE_KEYSET, B_: POINT_ONE },
    { index: '1', role: 'change', amount: '1', id: OFFER_KEYSET, B_: POINT_TWO },
  ]
  const commitment = computeCtfManifestCommitment(entries)
  assert.equal(commitment, POOL_COMMITMENT)
  const policy = { rateN: '1', rateD: '1', minReceive: '1', maxDebit: '4' }
  const secret = payToUnlockSecret(commitment, policy)
  return {
    ...commonFixture(secret),
    authorizationMode: 'pool',
    policy,
    manifest: { commitment, entries },
  }
}

function commonFixture(
  secret: string,
  operationId = 'range-operation-1',
  authorizationId = 'authorization-1',
  proofSignature = POOL_PROOF_SIGNATURE,
  dleq = POOL_DLEQ,
): {
  schemaVersion: 2
  operationId: string
  authorizationId: string
  mintUrl: string
  unit: 'msat'
  conditionId: string
  parentCollectionId: string
  offerKeysetId: string
  receiveKeysetId: string
  expiry: number
  inputFeePpkByKeyset: Record<string, number>
  inputProofYs: string[]
  inputs: SettlementCapabilityInputProof[]
} {
  const input: SettlementCapabilityInputProof = {
    id: OFFER_KEYSET,
    amount: '4',
    secret,
    C: proofSignature,
    dleq,
    p2pkE: null,
    witness: null,
  }
  return {
    schemaVersion: 2,
    operationId,
    authorizationId,
    mintUrl: 'https://mint.example',
    unit: 'msat',
    conditionId: CONDITION_ID,
    parentCollectionId: ROOT_PARENT,
    offerKeysetId: OFFER_KEYSET,
    receiveKeysetId: RECEIVE_KEYSET,
    expiry: EXPIRY,
    inputFeePpkByKeyset: { [OFFER_KEYSET]: 100 },
    inputProofYs: [hashToCurve(new TextEncoder().encode(secret)).toHex(true)],
    inputs: [input],
  }
}

function payToUnlockSecret(
  commitment: string,
  policy?: { rateN: string; rateD: string; minReceive: string; maxDebit: string },
): string {
  const tags = [
    ['offer_keyset', OFFER_KEYSET],
    ['expiry', EXPIRY.toString()],
    ['refund', REFUND_KEY],
    ['coordinator_pubkey', COORDINATOR_KEY],
  ]
  if (policy) {
    tags.push(
      ['rate_n', policy.rateN],
      ['rate_d', policy.rateD],
      ['min_receive', policy.minReceive],
      ['max_debit', policy.maxDebit],
    )
  }
  return JSON.stringify([
    'PAY_TO_UNLOCK',
    {
      data: commitment,
      nonce: '11'.repeat(32),
      tags,
    },
  ])
}

test('v2 standard and pool capability fixtures round-trip as canonical exact authority', () => {
  const standard = standardFixture()
  const pool = poolFixture()
  assert.equal(pool.inputProofYs[0], POOL_PROOF_Y)
  assert.equal(encodeSettlementCapabilityArtifact(pool).byteLength, 2_014)
  assert.equal(deriveSettlementCapabilityArtifactDigest(pool), POOL_ARTIFACT_DIGEST)
  assert.equal(encodeSettlementCapabilityArtifact(standard).byteLength, 1_616)
  assert.equal(deriveSettlementCapabilityArtifactDigest(standard), STANDARD_ARTIFACT_DIGEST)
  for (const artifact of [standard, pool]) {
    const bytes = encodeSettlementCapabilityArtifact(artifact)
    const decoded = decodeSettlementCapabilityArtifactBytes(bytes)
    assert.equal(sameBytes(encodeSettlementCapabilityArtifact(decoded), bytes), true)
    assert.equal(decoded.authorizationMode, artifact.authorizationMode)
    assert.equal(
      deriveSettlementCapabilityArtifactDigest(decoded),
      deriveSettlementCapabilityArtifactDigest(artifact),
    )
    assert.equal(new TextDecoder().decode(bytes).includes('"schemaVersion":2'), true)
  }
})

test('v2 capability allows HTTP only for an exact loopback mint origin', () => {
  const loopback = poolFixture()
  loopback.mintUrl = 'http://127.0.0.1:3338'
  assert.equal(decodeSettlementCapabilityArtifact(loopback).mintUrl, 'http://127.0.0.1:3338')

  const external = poolFixture()
  external.mintUrl = 'http://mint.example'
  assert.throws(
    () => decodeSettlementCapabilityArtifact(external),
    /requires HTTPS outside loopback/,
  )
})

test('v2 capability modes reject cross-mode, legacy, and changed authority', () => {
  const standard = standardFixture()
  const pool = poolFixture()
  const invalid: Array<[unknown, RegExp]> = [
    [{ ...standard, schemaVersion: 1 }, /header is unsupported/],
    [{ ...standard, policy: pool.policy }, /foreign or missing fields/],
    [{ ...pool, outputs: standard.outputs }, /foreign or missing fields/],
    [{ ...pool, authorizationMode: 'standard' }, /foreign or missing fields/],
    [{ ...standard, outputs: [] }, /standard output count/],
    [
      { ...pool, manifest: { ...pool.manifest, entries: pool.manifest.entries.slice(0, 1) } },
      /manifest count/,
    ],
    [
      {
        ...standard,
        outputs: standard.outputs.map((output, index) =>
          index === 0 ? { ...output, amount: '2' } : output,
        ),
      },
      /proof authority is inconsistent/,
    ],
    [
      {
        ...pool,
        manifest: {
          ...pool.manifest,
          entries: pool.manifest.entries.map((entry, index) =>
            index === 0 ? { ...entry, amount: '2' } : entry,
          ),
        },
      },
      /manifest is invalid/,
    ],
    [
      {
        ...pool,
        inputs: pool.inputs.map((proof) => ({ ...proof, C: `02${'00'.repeat(32)}` })),
      },
      /proof signature is invalid/,
    ],
    [
      {
        ...pool,
        inputs: pool.inputs.map((proof) => ({ ...proof, dleq: null })),
      },
      /DLEQ/,
    ],
    [
      {
        ...pool,
        inputs: pool.inputs.map((proof) => ({
          ...proof,
          dleq: { e: proof.dleq.e, s: proof.dleq.s },
        })),
      },
      /foreign or missing fields/,
    ],
    [
      {
        ...pool,
        offerKeysetId: '1111223344556677',
      },
      /keyset.*canonical/i,
    ],
  ]
  for (const [value, expected] of invalid) {
    assert.throws(() => decodeSettlementCapabilityArtifact(value), expected)
  }
})

test('v2 pool policy follows the pinned unsigned bounds', () => {
  const pool = poolFixture()
  const zeroRate = {
    ...pool,
    policy: { ...pool.policy, rateN: '0' },
  }
  zeroRate.inputs = zeroRate.inputs.map((proof) => ({
    ...proof,
    secret: payToUnlockSecret(pool.manifest.commitment, zeroRate.policy),
  }))
  zeroRate.inputProofYs = zeroRate.inputs.map((proof) =>
    hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
  )
  assert.equal(decodeSettlementCapabilityArtifact(zeroRate).policy.rateN, '0')

  const zeroMaximumDebit = {
    ...pool,
    policy: { ...pool.policy, maxDebit: '0' },
  }
  zeroMaximumDebit.inputs = zeroMaximumDebit.inputs.map((proof) => ({
    ...proof,
    secret: payToUnlockSecret(pool.manifest.commitment, zeroMaximumDebit.policy),
  }))
  zeroMaximumDebit.inputProofYs = zeroMaximumDebit.inputs.map((proof) =>
    hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
  )
  assert.equal(decodeSettlementCapabilityArtifact(zeroMaximumDebit).policy.maxDebit, '0')

  const excessiveMaximumDebit = {
    ...pool,
    policy: { ...pool.policy, maxDebit: '5' },
  }
  excessiveMaximumDebit.inputs = excessiveMaximumDebit.inputs.map((proof) => ({
    ...proof,
    secret: payToUnlockSecret(pool.manifest.commitment, excessiveMaximumDebit.policy),
  }))
  excessiveMaximumDebit.inputProofYs = excessiveMaximumDebit.inputs.map((proof) =>
    hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
  )
  assert.throws(
    () => decodeSettlementCapabilityArtifact(excessiveMaximumDebit),
    /maximum debit exceeds fixed inputs/,
  )
})

test('v2 capability binds one valid coordinator and unique proof nonce', () => {
  const pool = poolFixture()
  const invalidCoordinator = payToUnlockSecret(pool.manifest.commitment, pool.policy).replace(
    `["coordinator_pubkey","${COORDINATOR_KEY}"]`,
    `["coordinator_pubkey","${'00'.repeat(32)}"]`,
  )
  assert.throws(
    () =>
      decodeSettlementCapabilityArtifact({
        ...pool,
        inputs: [{ ...pool.inputs[0], secret: invalidCoordinator }],
        inputProofYs: [hashToCurve(new TextEncoder().encode(invalidCoordinator)).toHex(true)],
      }),
    /coordinator public key is invalid/,
  )

  assert.throws(
    () =>
      decodeSettlementCapabilityArtifact({
        ...pool,
        inputs: [structuredClone(pool.inputs[0]), structuredClone(pool.inputs[0])],
        inputProofYs: [pool.inputProofYs[0], pool.inputProofYs[0]],
      }),
    /proof authority is inconsistent/,
  )
})

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
}

test('v2 capability rejects noncanonical bytes and unbounded witness variants', () => {
  const pool = poolFixture()
  const canonical = encodeSettlementCapabilityArtifact(pool)
  const parsed = JSON.parse(new TextDecoder().decode(canonical)) as object
  const noncanonical = new TextEncoder().encode(JSON.stringify(parsed, null, 2))
  assert.throws(
    () => decodeSettlementCapabilityArtifactBytes(noncanonical),
    /bytes are not canonical/,
  )
  assert.throws(
    () =>
      decodeSettlementCapabilityArtifact({
        ...pool,
        inputs: [{ ...pool.inputs[0], witness: { signatures: [] } }],
      }),
    /witness signatures/,
  )
})
