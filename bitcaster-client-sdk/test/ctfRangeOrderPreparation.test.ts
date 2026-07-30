import assert from 'node:assert/strict'
import test from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  parseCtfPayToUnlockCondition,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import {
  completeCtfRangeOrderAuthorization,
  prepareCtfRangeOrderAuthorization,
} from '../src/ctfRangeOrderPreparation.ts'
import { deriveRootCtfOutcomeCollectionId } from '../src/durableCtfRangeOperation.ts'
import { createPoolSettlementCapabilityArtifact } from '../src/settlementCapabilityArtifact.ts'

const CONDITION_ID = 'ab'.repeat(32)
const OUTCOME_COLLECTION = 'YES'
const COORDINATOR_PUBLIC_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(MINT_PRIVATE_KEY, true))
const KEYS = Object.fromEntries(
  Array.from({ length: 20 }, (_, index) => [(1 << index).toString(), MINT_PUBLIC_KEY]),
)
const INPUT_FEE_PPK = 100
const FINAL_EXPIRY = 200
const MINT_URL = 'https://mint.example'
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
})
const REGULAR_KEYSET_ID = deriveKeysetId(KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
})
const OUTCOME_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})

test('prepares exact PAY_TO_UNLOCK material and completes one durable buy authorization', () => {
  const prepared = prepareCtfRangeOrderAuthorization(preparationInput())
  const replay = prepareCtfRangeOrderAuthorization(preparationInput())

  assert.deepEqual(
    prepared.authorizationOutputs.map(OutputData.serialize),
    replay.authorizationOutputs.map(OutputData.serialize),
  )
  assert.equal(prepared.manifest.commitment, replay.manifest.commitment)
  assert.equal(prepared.plan.inputAmount, '3')
  for (const output of prepared.authorizationOutputs) {
    const condition = parseCtfPayToUnlockCondition(new TextDecoder().decode(output.secret))
    assert.equal(condition.data, prepared.manifest.commitment)
    assert.equal(condition.offerKeyset, REGULAR_KEYSET_ID)
    assert.equal(condition.expiry, 100n)
    assert.equal(condition.refund, prepared.refundKey.publicKey)
    assert.equal(condition.coordinatorPublicKey, COORDINATOR_PUBLIC_KEY)
    assert.deepEqual(condition.mode, {
      kind: 'pool',
      policy: { rateN: 10_000n, rateD: 3n, minReceive: 10_000n, maxDebit: 3n },
    })
  }

  const operation = completeCtfRangeOrderAuthorization({
    preparation: prepared,
    inputs: prepared.authorizationOutputs.map(signOutput),
    keysetLookup: keysetLookup(),
    expiryObservation: expiryObservation(),
  })
  const artifact = createPoolSettlementCapabilityArtifact(operation)

  assert.equal(operation.sourceOperationId, 'source-operation-1')
  assert.equal(operation.inputs.length, prepared.authorizationOutputs.length)
  assert.equal(artifact.authorizationMode, 'pool')
  assert.equal(artifact.manifest.commitment, prepared.manifest.commitment)
})

test('rejects a foreign keyset context before deriving private authorization material', () => {
  assert.throws(
    () =>
      prepareCtfRangeOrderAuthorization({
        ...preparationInput(),
        offerKeyset: { ...regularKeyset(), canonicalMintUrl: 'https://other.example' },
      }),
    /foreign asset context/,
  )
})

test('prepares a sell authorization from the conditional asset into regular collateral', () => {
  const base = preparationInput()
  const prepared = prepareCtfRangeOrderAuthorization({
    ...base,
    side: 'Sell',
    offerKeyset: outcomeKeyset(),
    receiveKeyset: regularKeyset(),
  })
  const operation = completeCtfRangeOrderAuthorization({
    preparation: prepared,
    inputs: prepared.authorizationOutputs.map(signOutput),
    keysetLookup: keysetLookup(),
    expiryObservation: expiryObservation(),
  })

  assert.equal(operation.offerAsset.kind, 'conditional')
  assert.equal(operation.receiveAsset.kind, 'regular')
  assert.ok(
    prepared.authorizationOutputs.every(
      (output) =>
        parseCtfPayToUnlockCondition(new TextDecoder().decode(output.secret)).offerKeyset ===
        OUTCOME_KEYSET_ID,
    ),
  )
})

function preparationInput() {
  return {
    seed: new Uint8Array(64).fill(7),
    operationId: 'range-operation-1',
    sourceOperationId: 'source-operation-1',
    authorizationId: 'authorization-1',
    mintUrl: MINT_URL,
    conditionId: CONDITION_ID,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    side: 'Buy' as const,
    priceNumerator: 2,
    amountSubunits: 10_000,
    divisibility: 10_000,
    offerKeyset: regularKeyset(),
    receiveKeyset: outcomeKeyset(),
    expiryObservation: expiryObservation(),
    expiry: 100,
    maxPoolEntries: 128,
    maxInputs: 64,
  }
}

function regularKeyset() {
  return {
    canonicalMintUrl: MINT_URL,
    id: REGULAR_KEYSET_ID,
    unit: 'msat' as const,
    active: true as const,
    keys: KEYS,
    inputFeePpk: INPUT_FEE_PPK,
    finalExpiry: FINAL_EXPIRY,
  }
}

function outcomeKeyset() {
  return {
    canonicalMintUrl: MINT_URL,
    id: OUTCOME_KEYSET_ID,
    unit: 'msat' as const,
    active: true as const,
    keys: KEYS,
    inputFeePpk: INPUT_FEE_PPK,
    finalExpiry: FINAL_EXPIRY,
  }
}

function expiryObservation() {
  return {
    canonicalMintUrl: MINT_URL,
    freshness: 'fresh' as const,
    observedAt: 10,
    maxExpirySeconds: 100,
    conditionKeysetIds: [OUTCOME_KEYSET_ID],
    conditionalKeysets: [
      {
        keysetId: OUTCOME_KEYSET_ID,
        conditionId: CONDITION_ID,
        unit: 'msat',
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        keys: KEYS,
      },
    ],
  }
}

function keysetLookup() {
  return {
    canonicalMintUrl: MINT_URL,
    freshness: 'fresh' as const,
    regularKeysets: [
      {
        keysetId: REGULAR_KEYSET_ID,
        unit: 'msat',
        active: true,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
    conditionalKeysets: [
      {
        keysetId: OUTCOME_KEYSET_ID,
        unit: 'msat',
        active: true,
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
  }
}

function signOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    MINT_PRIVATE_KEY,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), MINT_PRIVATE_KEY)
  return output.toProof(
    {
      id: signature.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: output.blindedMessage.id, keys: KEYS },
  )
}
