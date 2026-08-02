import assert from 'node:assert/strict'
import test from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  parseCtfPayToUnlockCondition,
  pointFromHex,
  type CtfConvertRequest,
  type Proof,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts'
import {
  completeCtfRangeOrderAuthorization,
  prepareCtfRangeOrderAuthorization,
} from '../src/ctfRangeOrderPreparation.ts'
import {
  buildPersistedCtfRangeOrderPreparation,
  createCtfRangeSettlementCapabilityRequest,
  ctfRangeOrderPreparationKeysetLookup,
  decodeCtfRangeOrderPreparationFromRecord,
  decodePersistedCtfRangeOrderPreparationBytes,
  encodePersistedCtfRangeOrderPreparation,
  validateAndProjectCtfRangeSettlementCapabilityResponse,
  type CtfRangeOrderRequest,
} from '../src/ctfRangeOrderProtocol.ts'
import {
  encodeCtfRangeOrderPreparationArtifact,
  type CtfRangeOrderPreparationRecord,
} from '../src/ctfRangeOrderJournal.ts'
import { deriveRootCtfOutcomeCollectionId } from '../src/durableCtfRangeOperation.ts'
import {
  createPoolSettlementCapabilityArtifact,
  deriveSettlementCapabilityArtifactDigest,
} from '../src/settlementCapabilityArtifact.ts'
import {
  prepareCtfRangeSourceOperation,
  validateCtfRangeSourceCompletionOperation,
} from '../src/ctfRangeSourceOperation.ts'
import { planCtfRangeCapabilitySource } from '../src/ctfRangeCapabilitySourcePlan.ts'
import {
  completeCtfRangeCollateralSourceOperation,
  prepareCtfRangeCollateralSourceOperation,
  validateCtfRangeCollateralSourceOperation,
} from '../src/ctfRangeCollateralSourceOperation.ts'

const CONDITION_ID = 'ab'.repeat(32)
const OUTCOME_COLLECTION = 'YES'
const COMPLEMENT_COLLECTION = 'NO'
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
const COMPLEMENT_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: COMPLEMENT_COLLECTION,
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
const REVIEWED_FINAL_EXPIRY = 1_000
const REVIEWED_REGULAR_KEYSET_ID = deriveKeysetId(KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: REVIEWED_FINAL_EXPIRY,
  versionByte: 1,
})
const REVIEWED_OUTCOME_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: REVIEWED_FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})
const REVIEWED_COMPLEMENT_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: REVIEWED_FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
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
    allowInsecureLoopbackHttp: false,
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
    allowInsecureLoopbackHttp: false,
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

test('builds, canonically persists, and verifies one exact range preparation record', () => {
  const request = {
    ...rangeOrderRequest(),
    amountSubunits: 20_000,
  }
  const persisted = buildPersistedCtfRangeOrderPreparation({
    request,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY.toUpperCase(),
    mintFacts: reviewedMintFacts(),
    market: {
      outcomes: [
        { id: 'yes-id', label: 'YES' },
        { id: 'no-id', label: 'NO' },
      ],
    },
    nowUnixSeconds: 20,
    randomId: sequentialId('range-operation-2', 'authorization-2'),
  })
  const preparationBytes = encodePersistedCtfRangeOrderPreparation(persisted)
  const record = preparationRecord(persisted, preparationBytes)

  assert.equal(persisted.coordinatorPublicKey, COORDINATOR_PUBLIC_KEY)
  assert.equal(persisted.offerKeyset.id, REVIEWED_REGULAR_KEYSET_ID)
  assert.equal(persisted.receiveKeyset.id, REVIEWED_OUTCOME_KEYSET_ID)
  assert.equal(persisted.complementKeyset.id, REVIEWED_COMPLEMENT_KEYSET_ID)
  assert.equal(persisted.expiry, 700)
  assert.deepEqual(decodePersistedCtfRangeOrderPreparationBytes(preparationBytes), persisted)
  assert.deepEqual(decodeCtfRangeOrderPreparationFromRecord(record, request), persisted)
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationFromRecord(
        { ...record, orderRouteId: `${CONDITION_ID}-NO` },
        request,
      ),
    /preparation is foreign/,
  )
  assert.throws(
    () =>
      decodeCtfRangeOrderPreparationFromRecord(
        { ...record, minimumFillAmountSubunits: 20_000 },
        request,
      ),
    /preparation is foreign/,
  )
  assert.throws(
    () =>
      decodePersistedCtfRangeOrderPreparationBytes(
        encodeCtfRangeOrderPreparationArtifact({
          ...persisted,
          request: { ...request, walletSeedHex: 'secret' },
        }),
      ),
    /request fields are invalid/,
  )
  for (const candidate of [
    {
      ...persisted,
      offerKeyset: { ...persisted.offerKeyset, unknown: true },
    },
    {
      ...persisted,
      expiryObservation: { ...persisted.expiryObservation, unknown: true },
    },
    {
      ...persisted,
      expiryObservation: {
        ...persisted.expiryObservation,
        conditionalKeysets: persisted.expiryObservation.conditionalKeysets.map((keyset, index) =>
          index === 0 ? { ...keyset, unknown: true } : keyset,
        ),
      },
    },
  ]) {
    assert.throws(
      () =>
        decodePersistedCtfRangeOrderPreparationBytes(
          encodeCtfRangeOrderPreparationArtifact(candidate),
        ),
      /fields are invalid/,
    )
  }
  for (const nowUnixSeconds of [Number.NaN, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () =>
        buildPersistedCtfRangeOrderPreparation({
          request,
          coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
          mintFacts: reviewedMintFacts(),
          market: {
            outcomes: [
              { id: 'yes-id', label: 'YES' },
              { id: 'no-id', label: 'NO' },
            ],
          },
          nowUnixSeconds,
          randomId: sequentialId('invalid-clock-operation', 'invalid-clock-authorization'),
        }),
      /current time/,
    )
  }
  assert.throws(
    () =>
      buildPersistedCtfRangeOrderPreparation({
        request: { ...request, marketId: `${CONDITION_ID}-NO` },
        coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
        mintFacts: reviewedMintFacts(),
        market: {
          outcomes: [
            { id: 'yes-id', label: 'YES' },
            { id: 'no-id', label: 'NO' },
          ],
        },
        nowUnixSeconds: 20,
        randomId: sequentialId('cross-route-operation', 'cross-route-authorization'),
      }),
    /exact engine order route/,
  )
  assert.throws(
    () =>
      buildPersistedCtfRangeOrderPreparation({
        request,
        coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
        mintFacts: reviewedMintFacts(),
        market: {
          outcomes: [
            { id: 'yes-id', label: 'YES' },
            { id: 'other-id', label: 'yes-id' },
          ],
        },
        nowUnixSeconds: 20,
        randomId: sequentialId('ambiguous-operation', 'ambiguous-authorization'),
      }),
    /exact engine order route/,
  )
})

test('GTD preparation preserves the original order expiry and rejects an expired horizon', () => {
  const expiresAt = '1970-01-01T00:05:00.000Z'
  const persisted = buildPersistedCtfRangeOrderPreparation({
    request: {
      ...rangeOrderRequest(),
      timeInForce: 'GTD',
      expiresAt,
    },
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    mintFacts: reviewedMintFacts(),
    market: {
      outcomes: [
        { id: 'yes-id', label: 'YES' },
        { id: 'no-id', label: 'NO' },
      ],
    },
    nowUnixSeconds: 20,
    randomId: sequentialId('range-operation-gtd', 'authorization-gtd'),
  })

  assert.equal(persisted.request.expiresAt, expiresAt)
  assert.equal(persisted.expiry, 300)
  assert.throws(
    () =>
      buildPersistedCtfRangeOrderPreparation({
        request: persisted.request,
        coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
        mintFacts: reviewedMintFacts(),
        market: {
          outcomes: [
            { id: 'yes-id', label: 'YES' },
            { id: 'no-id', label: 'NO' },
          ],
        },
        nowUnixSeconds: 300,
        randomId: sequentialId('range-operation-expired', 'authorization-expired'),
      }),
    /GTD order expiry horizon is exhausted/,
  )
})

test('builds one capability request and validates its exact engine projection', () => {
  const preparation = buildPersistedCtfRangeOrderPreparation({
    request: rangeOrderRequest(),
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    mintFacts: reviewedMintFacts(),
    market: {
      outcomes: [
        { id: 'yes-id', label: 'YES' },
        { id: 'no-id', label: 'NO' },
      ],
    },
    nowUnixSeconds: 20,
    randomId: sequentialId('range-operation-capability', 'authorization-capability'),
  })
  const request = preparation.request
  const operation = completedOperation(preparation)
  const capabilityRequest = createCtfRangeSettlementCapabilityRequest(preparation, operation)
  const artifactDigest = deriveSettlementCapabilityArtifactDigest(
    createPoolSettlementCapabilityArtifact(operation),
  )
  const capability = {
    reference: {
      artifactId: '11111111-1111-4111-8111-111111111111',
      bindingDigest: '11'.repeat(32),
    },
    orderId: '22222222-2222-4222-8222-222222222222',
    clientOrderId: request.clientOrderId,
    marketId: request.marketId,
    artifactDigest,
    state: 'bound' as const,
    version: 1,
    authorizationExpiresAt: '2030-01-01T00:00:00.000Z',
    stageExpiresAt: '2030-01-01T00:01:00.000Z',
    settlementGroup: null,
  }

  assert.equal(capabilityRequest.stageIdempotencyKey, operation.authorizationId)
  assert.equal(capabilityRequest.continuation, null)
  const continuation = {
    predecessorOrderId: '11111111-1111-4111-8111-111111111111',
    settlementGroupId: '22222222-2222-4222-8222-222222222222',
    settlementGroupRevision: 3,
    continuationRevision: 4,
  }
  assert.deepEqual(
    createCtfRangeSettlementCapabilityRequest(preparation, operation, continuation).continuation,
    continuation,
  )
  assert.throws(
    () =>
      createCtfRangeSettlementCapabilityRequest(preparation, operation, {
        ...continuation,
        continuationRevision: 0,
      }),
    /continuation revision is invalid/,
  )
  assert.equal(
    Buffer.from(capabilityRequest.artifact, 'base64').toString('base64'),
    capabilityRequest.artifact,
  )
  assert.deepEqual(
    validateAndProjectCtfRangeSettlementCapabilityResponse({
      capability,
      preparation,
      operation,
      recovering: false,
    }),
    {
      artifactId: capability.reference.artifactId,
      bindingDigest: capability.reference.bindingDigest,
      artifactDigest,
      orderId: capability.orderId,
    },
  )
  assert.throws(
    () =>
      validateAndProjectCtfRangeSettlementCapabilityResponse({
        capability: { ...capability, marketId: `${CONDITION_ID}-NO` },
        preparation,
        operation,
        recovering: false,
      }),
    /foreign settlement capability/,
  )
  assert.throws(
    () =>
      createCtfRangeSettlementCapabilityRequest(preparation, {
        ...operation,
        sourceOperationId: 'foreign-source-operation',
      }),
    /foreign to its persisted order preparation/,
  )
})

test('prepares one exact persisted range source through the shared wallet boundary', async () => {
  const preparation = persistedPreparation('range-operation-source')
  const candidate: Proof = {
    id: preparation.offerKeyset.id,
    amount: 4,
    secret: 'source-proof',
    C: MINT_PUBLIC_KEY,
  }
  const operation = await prepareCtfRangeSourceOperation({
    preparation,
    seed: new Uint8Array(64).fill(7),
    candidates: [candidate],
    wallet: {
      prepareSwapToSend: async (amount, proofs, config, outputs) => ({
        amount: Amount.from(amount),
        fees: Amount.from(1),
        keysetId: config.keysetId,
        inputs: proofs,
        sendOutputs: outputs.send.data,
        keepOutputs: [],
        unselectedProofs: [],
      }),
      completeSwap: async () => ({ keep: [], send: [] }),
      prepareConditionalSwap: async () => {
        throw new Error('unexpected conditional source')
      },
      completeConditionalSwap: async () => ({}),
    },
  })

  assert.ok(operation)
  assert.equal(operation.kind, 'ctf-range-regular-source')
  assert.equal(operation.operationId, preparation.sourceOperationId)
  assert.equal(operation.inputs[0]?.secret, candidate.secret)
  assert.equal(operation.metadata?.purpose, 'ctf-range-authorization-source')
  assert.ok((operation.outputs.authorization?.length ?? 0) > 0)
  assert.deepEqual(validateCtfRangeSourceCompletionOperation(operation).operation, operation)
  assert.throws(
    () =>
      validateCtfRangeSourceCompletionOperation({
        ...operation,
        metadata: { ...operation.metadata, keysetId: '' },
      }),
    /keysetId is invalid/,
  )
  const output = operation.outputs.authorization![0]!
  assert.throws(
    () =>
      validateCtfRangeSourceCompletionOperation({
        ...operation,
        outputs: {
          ...operation.outputs,
          authorization: [
            {
              ...output,
              blindedMessage: { ...output.blindedMessage, B_: MINT_PUBLIC_KEY },
            },
          ],
        },
      }),
    /does not match its exact private material/,
  )
})

test('prepares one exact collateral conversion with locked offer and ordinary complement', async () => {
  const preparation = persistedPreparation('range-operation-collateral', 'Sell')
  const authorization = prepareCtfRangeOrderAuthorization({
    seed: new Uint8Array(64).fill(7),
    ...withoutPersistedRequest(preparation),
  }).authorizationOutputs
  const collateral: Proof = {
    id: preparation.receiveKeyset.id,
    amount: 20_000,
    secret: 'collateral-source-proof',
    C: MINT_PUBLIC_KEY,
  }
  const plan = planCtfRangeCapabilitySource({
    side: 'Sell',
    authorizationAmounts: authorization.map(({ blindedMessage }) =>
      blindedMessage.amount.toString(),
    ),
    offeredKeyset: preparation.offerKeyset,
    collateralKeyset: preparation.receiveKeyset,
    complementKeyset: preparation.complementKeyset,
    offeredCandidates: [],
    collateralCandidates: [collateral],
    maxInputs: preparation.maxInputs,
    maxOutputs: 256,
  })
  assert.equal(plan.kind, 'collateral-ctf-convert')
  if (plan.kind !== 'collateral-ctf-convert') return

  const operation = prepareCtfRangeCollateralSourceOperation({
    preparation,
    seed: new Uint8Array(64).fill(7),
    plan,
  })
  assert.equal(operation.kind, 'ctf-range-collateral-convert')
  assert.equal(operation.inputs[0]?.secret, collateral.secret)
  assert.ok((operation.outputs.authorization?.length ?? 0) > 0)
  assert.ok((operation.outputs.complement?.length ?? 0) > 0)
  assert.deepEqual(validateCtfRangeCollateralSourceOperation(operation, preparation), operation)
  let request: CtfConvertRequest | null = null
  const completed = await completeCtfRangeCollateralSourceOperation({
    operation,
    preparation,
    transport: {
      postConvert: async (value) => {
        request = value
        return {
          signatures: Object.fromEntries(
            Object.entries(value.outputs).map(([collection, outputs]) => [
              collection,
              outputs.map(signBlindedMessage),
            ]),
          ),
        }
      },
    },
  })
  assert.deepEqual(Object.keys(request!.inputs), ['*'])
  assert.deepEqual(Object.keys(request!.outputs).sort(), [
    '*',
    COMPLEMENT_COLLECTION,
    OUTCOME_COLLECTION,
  ])
  assert.equal(completed.authorization.reduce(sumProofAmount, 0), 10_000)
  assert.equal(completed.complement.reduce(sumProofAmount, 0), 10_000)
  assert.equal(completed.collateralChange.reduce(sumProofAmount, 0), 9_999)
  assert.throws(
    () =>
      validateCtfRangeCollateralSourceOperation(
        {
          ...operation,
          metadata: { ...operation.metadata, complementKeysetId: 'foreign-keyset' },
        },
        preparation,
      ),
    /value authority|preparation is foreign/,
  )
})

test('rejects wallet substitution of exact range authorization outputs', async () => {
  const preparation = persistedPreparation('range-operation-substitution')
  await assert.rejects(
    prepareCtfRangeSourceOperation({
      preparation,
      seed: new Uint8Array(64).fill(7),
      candidates: [
        { id: preparation.offerKeyset.id, amount: 4, secret: 'source-proof', C: MINT_PUBLIC_KEY },
      ],
      wallet: {
        prepareSwapToSend: async (amount, proofs, config) => ({
          amount: Amount.from(amount),
          fees: Amount.from(1),
          keysetId: config.keysetId,
          inputs: proofs,
          sendOutputs: [],
          keepOutputs: [],
          unselectedProofs: [],
        }),
        completeSwap: async () => ({ keep: [], send: [] }),
        prepareConditionalSwap: async () => {
          throw new Error('unexpected conditional source')
        },
        completeConditionalSwap: async () => ({}),
      },
    }),
    /changed exact authorization outputs/,
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
    minimumFillAmountSubunits: 10_000,
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

function rangeOrderRequest(): CtfRangeOrderRequest {
  return {
    clientOrderId: 'client-order-1',
    marketId: `${CONDITION_ID}-YES`,
    conditionId: CONDITION_ID,
    outcomeId: 'yes-id',
    tokenSide: 'Outcome',
    side: 'Buy',
    price: 2,
    amountSubunits: 10_000,
    minimumFillAmountSubunits: 10_000,
    baseAsset: 'sat',
    collateralUnit: 'msat',
    divisibility: 10_000,
    timeInForce: 'GTC',
    expiresAt: null,
    mintUrl: MINT_URL,
  }
}

function reviewedMintFacts() {
  const observation = {
    ...expiryObservation(),
    maxExpirySeconds: REVIEWED_FINAL_EXPIRY,
    conditionKeysetIds: [REVIEWED_OUTCOME_KEYSET_ID, REVIEWED_COMPLEMENT_KEYSET_ID],
    conditionalKeysets: [
      ...expiryObservation().conditionalKeysets.map((keyset) => ({
        ...keyset,
        keysetId: REVIEWED_OUTCOME_KEYSET_ID,
        finalExpiry: REVIEWED_FINAL_EXPIRY,
      })),
      {
        ...expiryObservation().conditionalKeysets[0]!,
        keysetId: REVIEWED_COMPLEMENT_KEYSET_ID,
        finalExpiry: REVIEWED_FINAL_EXPIRY,
        outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
      },
    ],
  }
  return {
    regular: [
      {
        ...regularKeyset(),
        id: REVIEWED_REGULAR_KEYSET_ID,
        finalExpiry: REVIEWED_FINAL_EXPIRY,
      },
    ],
    conditional: [
      {
        ...outcomeKeyset(),
        id: REVIEWED_OUTCOME_KEYSET_ID,
        finalExpiry: REVIEWED_FINAL_EXPIRY,
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
      },
      {
        ...outcomeKeyset(),
        id: REVIEWED_COMPLEMENT_KEYSET_ID,
        finalExpiry: REVIEWED_FINAL_EXPIRY,
        conditionId: CONDITION_ID,
        outcomeCollection: COMPLEMENT_COLLECTION,
        outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
      },
    ],
    maxInputs: 64,
    maxPoolEntries: 128,
    observation,
  }
}

function sequentialId(...ids: string[]): () => string {
  let index = 0
  return () => ids[index++] ?? 'unexpected-id'
}

function persistedPreparation(operationId: string, side: 'Buy' | 'Sell' = 'Buy') {
  return buildPersistedCtfRangeOrderPreparation({
    request: { ...rangeOrderRequest(), side },
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    mintFacts: reviewedMintFacts(),
    market: {
      outcomes: [
        { id: 'yes-id', label: 'YES' },
        { id: 'no-id', label: 'NO' },
      ],
    },
    nowUnixSeconds: 20,
    randomId: sequentialId(operationId, `${operationId}:authorization`),
  })
}

function withoutPersistedRequest(preparation: ReturnType<typeof persistedPreparation>) {
  const { version: _, request: _request, complementKeyset: _complement, ...input } = preparation
  return input
}

function preparationRecord(
  persisted: ReturnType<typeof buildPersistedCtfRangeOrderPreparation>,
  preparationBytes: Uint8Array,
): CtfRangeOrderPreparationRecord {
  return {
    scopeId: `custody:wallet:${'11'.repeat(32)}`,
    rangeOperationId: persisted.operationId,
    sourceOperationId: persisted.sourceOperationId,
    sourceKind: persisted.sourceKind,
    predecessorRangeOperationId: persisted.predecessorRangeOperationId,
    authorizationId: persisted.authorizationId,
    clientOrderId: persisted.request.clientOrderId,
    orderRouteId: persisted.request.marketId,
    normalizedMint: persisted.mintUrl,
    conditionId: persisted.conditionId,
    unit: 'msat',
    tokenSide: persisted.request.tokenSide,
    side: persisted.side,
    priceSubunits: persisted.priceNumerator,
    amountSubunits: persisted.amountSubunits,
    minimumFillAmountSubunits: persisted.request.minimumFillAmountSubunits,
    continueAfterPartialFill: false,
    continuation: null,
    divisibility: persisted.divisibility,
    authorizationExpiresAtUnixSeconds: persisted.expiry,
    preparationBytes,
    createdAtMs: 1,
    lifecycleState: 'prepared',
    revision: 0,
    capability: null,
    updatedAtMs: 1,
  }
}

function completedOperation(persisted?: ReturnType<typeof buildPersistedCtfRangeOrderPreparation>) {
  const prepared = prepareCtfRangeOrderAuthorization(
    persisted === undefined
      ? preparationInput()
      : {
          seed: new Uint8Array(64).fill(7),
          operationId: persisted.operationId,
          sourceOperationId: persisted.sourceOperationId,
          authorizationId: persisted.authorizationId,
          mintUrl: persisted.mintUrl,
          conditionId: persisted.conditionId,
          coordinatorPublicKey: persisted.coordinatorPublicKey,
          side: persisted.side,
          priceNumerator: persisted.priceNumerator,
          amountSubunits: persisted.amountSubunits,
          divisibility: persisted.divisibility,
          offerKeyset: persisted.offerKeyset,
          receiveKeyset: persisted.receiveKeyset,
          expiryObservation: persisted.expiryObservation,
          expiry: persisted.expiry,
          maxPoolEntries: persisted.maxPoolEntries,
          maxInputs: persisted.maxInputs,
        },
  )
  return completeCtfRangeOrderAuthorization({
    preparation: prepared,
    inputs: prepared.authorizationOutputs.map(signOutput),
    keysetLookup:
      persisted === undefined ? keysetLookup() : ctfRangeOrderPreparationKeysetLookup(persisted),
    expiryObservation: persisted === undefined ? expiryObservation() : persisted.expiryObservation,
    allowInsecureLoopbackHttp: false,
  })
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

function signBlindedMessage(output: SerializedBlindedMessage): SerializedBlindedSignature {
  const signature = createBlindSignature(pointFromHex(output.B_), MINT_PRIVATE_KEY, output.id)
  const dleq = createDLEQProof(pointFromHex(output.B_), MINT_PRIVATE_KEY)
  return {
    id: signature.id,
    amount: Amount.from(output.amount),
    C_: signature.C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  }
}

function sumProofAmount(sum: number, proof: Proof): number {
  return sum + Number(proof.amount)
}
