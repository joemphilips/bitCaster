import assert from 'node:assert/strict'
import test from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  Amount,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  type CounterSource,
  type Proof,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts'
import {
  createCtfRangeCapabilityParentPreparationContext,
  mapCtfRangeCapabilityParentResponseToUnverifiedResult,
  createCtfRangeCapabilityParentRequestMeasurer,
  prepareCtfRangeCapabilityParentOperation,
  readCtfRangeCapabilityParentReplay,
  restoreCtfRangeCapabilityParentOperation,
  validateCtfRangeCapabilityParentOperation,
} from '../src/ctfRangeCapabilityParentOperation.ts'
import {
  planCtfRangeCapabilityBatches,
  type CtfRangeCapabilityBatchChild,
} from '../src/ctfRangeCapabilityBatchPlan.ts'
import { planCtfRangeOrderAuthorization } from '../src/ctfRangeOrderAuthorization.ts'
import {
  buildPersistedCtfRangeOrderPreparation,
  type CtfRangeOrderRequest,
  type PersistedCtfRangeOrderPreparation,
} from '../src/ctfRangeOrderProtocol.ts'
import { deriveRootCtfOutcomeCollectionId } from '../src/durableCtfRangeOperation.ts'

const CONDITION_ID = 'ab'.repeat(32)
const MINT_URL = 'https://mint.example'
const COORDINATOR_PUBLIC_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(MINT_PRIVATE_KEY, true))
const KEYS = Object.fromEntries(
  Array.from({ length: 20 }, (_, index) => [(1 << index).toString(), MINT_PUBLIC_KEY]),
)
const INPUT_FEE_PPK = 100
const FINAL_EXPIRY = 1_000
const YES_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: 'YES',
})
const NO_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: 'NO',
})
const REGULAR_KEYSET_ID = deriveKeysetId(KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
})
const YES_KEYSET_ID = conditionalKeysetId(YES_COLLECTION_ID)
const NO_KEYSET_ID = conditionalKeysetId(NO_COLLECTION_ID)

test('prepares and replays one exact mixed collateral parent', async () => {
  const preparations = [preparation('buy', 'Buy'), preparation('sell', 'Sell')]
  const preparationContext = createCtfRangeCapabilityParentPreparationContext({
    seed: new Uint8Array(64).fill(7),
    preparations,
  })
  const plan = batchPlan(preparations, [proof(REGULAR_KEYSET_ID, 16_384)], [])
  assert.equal(plan.parents.length, 1)
  const parent = plan.parents[0]!
  assert.equal(parent.kind, 'collateral-ctf-convert')

  const reservations: Array<{ keysetId: string; count: number }> = []
  const prepared = await prepareCtfRangeCapabilityParentOperation({
    parentOperationId: 'parent-collateral-1',
    parent,
    preparations,
    seed: new Uint8Array(64).fill(7),
    counterSource: counterSource(reservations),
    preparationContext,
  })
  assert.equal(preparationContext.materializedChildCount, preparations.length)
  const replay = readCtfRangeCapabilityParentReplay(prepared)
  assert.equal(replay.path, '/v1/ctf/convert')
  assert.equal(replay.body.length, parent.requestBytes)
  assert.equal(prepared.operation.outputs.successors?.length, parent.outputs.length)
  assert.ok(
    prepared.allocations
      .filter(({ role }) => role === 'authorization')
      .every(
        ({ childOperationId, clientOrderId }) =>
          childOperationId !== null && clientOrderId !== null,
      ),
  )
  assert.deepEqual(
    reservations.sort((left, right) => (left.keysetId < right.keysetId ? -1 : 1)),
    [
      ...new Set(
        parent.outputs
          .filter(({ role }) => role !== 'authorization')
          .map(({ keysetId }) => keysetId),
      ),
    ]
      .sort()
      .map((keysetId) => ({
        keysetId,
        count: parent.outputs.filter(
          (output) => output.role !== 'authorization' && output.keysetId === keysetId,
        ).length,
      })),
  )
  assert.ok(
    prepared.allocations
      .filter(({ role }) => role !== 'authorization')
      .every(
        ({ childOperationId, clientOrderId }) =>
          childOperationId === null && clientOrderId === null,
      ),
  )
  const restored = restoreCtfRangeCapabilityParentOperation({
    operation: structuredClone(prepared.operation),
    exactRequest: {
      ...prepared.exactRequest,
      artifact: structuredClone(prepared.exactRequest.artifact),
    },
    applicationAuthority: structuredClone(prepared.exactAllocations.artifact),
    preparations,
  })
  assert.deepEqual(
    readCtfRangeCapabilityParentReplay(restored).body,
    readCtfRangeCapabilityParentReplay(prepared).body,
  )

  const request = prepared.exactRequest.artifact as {
    outputs: Record<string, SerializedBlindedMessage[]>
  }
  const completed = mapCtfRangeCapabilityParentResponseToUnverifiedResult({
    prepared,
    preparations,
    seed: new Uint8Array(64).fill(7),
    response: {
      signatures: Object.fromEntries(
        Object.entries(request.outputs).map(([group, outputs]) => [group, outputs.map(signOutput)]),
      ),
    },
    preparationContext,
  })
  assert.equal(preparationContext.materializedChildCount, preparations.length)
  for (const preparation of preparations) {
    assert.equal(
      preparationContext.materialize(preparation),
      preparationContext.materialize(preparation),
    )
  }
  assert.equal(preparationContext.materializedChildCount, preparations.length)
  assert.equal(completed.result.successors.length, parent.outputs.length)
  assert.deepEqual(
    completed.allocations.map(({ outputIndex }) => outputIndex),
    parent.outputs.map(({ outputIndex }) => outputIndex),
  )

  const recoveryContext = createCtfRangeCapabilityParentPreparationContext({
    seed: new Uint8Array(64).fill(7),
    preparations,
  })
  const recovered = mapCtfRangeCapabilityParentResponseToUnverifiedResult({
    prepared: restored,
    preparations,
    seed: new Uint8Array(64).fill(7),
    response: {
      signatures: Object.fromEntries(
        Object.entries(request.outputs).map(([group, outputs]) => [group, outputs.map(signOutput)]),
      ),
    },
    preparationContext: recoveryContext,
  })
  assert.equal(recovered.result.successors.length, parent.outputs.length)
  for (const preparation of preparations) recoveryContext.materialize(preparation)
  assert.equal(recoveryContext.materializedChildCount, preparations.length)
})

test('reuses two conditional children in one exact same-keyset parent', async () => {
  const preparations = [preparation('sell-one', 'Sell'), preparation('sell-two', 'Sell')]
  const plan = batchPlan(preparations, [], [proof(YES_KEYSET_ID, 32_768)])
  assert.equal(plan.parents.length, 1)
  const parent = plan.parents[0]!
  assert.equal(parent.kind, 'same-keyset-swap')

  const reservations: Array<{ keysetId: string; count: number }> = []
  const prepared = await prepareCtfRangeCapabilityParentOperation({
    parentOperationId: 'parent-same-keyset-1',
    parent,
    preparations,
    seed: new Uint8Array(64).fill(9),
    counterSource: counterSource(reservations),
  })
  assert.deepEqual(
    reservations,
    [
      ...new Set(
        parent.outputs
          .filter(({ role }) => role !== 'authorization')
          .map(({ keysetId }) => keysetId),
      ),
    ].map((keysetId) => ({
      keysetId,
      count: parent.outputs.filter(
        (output) => output.role !== 'authorization' && output.keysetId === keysetId,
      ).length,
    })),
  )
  const request = prepared.exactRequest.artifact as { outputs: SerializedBlindedMessage[] }
  const restarted = JSON.parse(JSON.stringify(prepared)) as typeof prepared
  assert.deepEqual(
    readCtfRangeCapabilityParentReplay(restarted).body,
    readCtfRangeCapabilityParentReplay(prepared).body,
  )
  const completed = mapCtfRangeCapabilityParentResponseToUnverifiedResult({
    prepared: restarted,
    preparations,
    seed: new Uint8Array(64).fill(9),
    response: { signatures: request.outputs.map(signOutput) },
  })
  assert.equal(readCtfRangeCapabilityParentReplay(prepared).path, '/v1/swap')
  assert.deepEqual(
    prepared.children.map(({ clientOrderId }) => clientOrderId),
    ['sell-one', 'sell-two'],
  )
  assert.equal(completed.result.successors.length, parent.outputs.length)
})

test('rejects allocation, request, and response substitution', async () => {
  const preparations = [preparation('sell-tamper', 'Sell')]
  const plan = batchPlan(preparations, [proof(REGULAR_KEYSET_ID, 16_384)], [])
  const prepared = await prepareCtfRangeCapabilityParentOperation({
    parentOperationId: 'parent-tamper-1',
    parent: plan.parents[0]!,
    preparations,
    seed: new Uint8Array(64).fill(11),
    counterSource: counterSource(),
  })
  assert.throws(
    () =>
      readCtfRangeCapabilityParentReplay({
        ...prepared,
        path: '/v1/swap',
      }),
    /replay envelope is invalid/,
  )
  assert.throws(
    () =>
      validateCtfRangeCapabilityParentOperation(
        {
          ...prepared,
          allocations: [
            { ...prepared.allocations[0]!, role: 'change' },
            ...prepared.allocations.slice(1),
          ],
        },
        preparations,
      ),
    /allocation artifact changed|allocation authority is foreign/,
  )
  assert.throws(
    () =>
      validateCtfRangeCapabilityParentOperation(
        {
          ...prepared,
          operation: {
            ...prepared.operation,
            metadata: { ...prepared.operation.metadata, requestBytes: 1 },
          },
        },
        preparations,
      ),
    /metadata authority is foreign/,
  )
  const request = prepared.exactRequest.artifact as {
    outputs: Record<string, SerializedBlindedMessage[]>
  }
  const signatures = Object.fromEntries(
    Object.entries(request.outputs).map(([group, outputs]) => [group, outputs.map(signOutput)]),
  )
  const firstGroup = Object.keys(signatures)[0]!
  assert.throws(
    () =>
      mapCtfRangeCapabilityParentResponseToUnverifiedResult({
        prepared,
        preparations,
        seed: new Uint8Array(64).fill(11),
        response: { signatures: { ...signatures, foreign: [] } },
      }),
    /response groups are invalid/,
  )
  const foreignKeyset = Object.fromEntries(
    Object.entries(signatures).map(([group, values]) => [
      group,
      values.map((value) => ({ ...value })),
    ]),
  )
  foreignKeyset[firstGroup]![0] = {
    ...foreignKeyset[firstGroup]![0]!,
    id: YES_KEYSET_ID,
  }
  assert.throws(
    () =>
      mapCtfRangeCapabilityParentResponseToUnverifiedResult({
        prepared,
        preparations,
        seed: new Uint8Array(64).fill(11),
        response: { signatures: foreignKeyset },
      }),
    /mint signature is foreign/,
  )
  signatures[firstGroup] = signatures[firstGroup]!.slice(1)
  assert.throws(
    () =>
      mapCtfRangeCapabilityParentResponseToUnverifiedResult({
        prepared,
        preparations,
        seed: new Uint8Array(64).fill(11),
        response: { signatures },
      }),
    /signature count/,
  )
  assert.throws(
    () =>
      validateCtfRangeCapabilityParentOperation(
        {
          ...prepared,
          allocations: Array.from({ length: 257 }, (_, index) => ({
            ...prepared.allocations[0]!,
            outputIndex: index,
          })),
        },
        preparations,
      ),
    /allocations are invalid/,
  )
})

test('rejects same-id keyset substitution and excess parent inputs', () => {
  const preparations = [preparation('buy-authority', 'Buy')]
  const plan = batchPlan(preparations, [proof(REGULAR_KEYSET_ID, 16_384)], [])
  const parent = plan.parents[0]!
  const measure = createCtfRangeCapabilityParentRequestMeasurer({ preparations })
  const substitutedKeys = { ...parent.sourceKeyset.keys, '1': `02${'22'.repeat(32)}` }

  assert.throws(
    () => measure({ ...parent, sourceKeyset: { ...parent.sourceKeyset, keys: substitutedKeys } }),
    /source keyset authority is foreign/,
  )
  assert.throws(
    () =>
      measure({
        ...parent,
        children: [
          {
            ...parent.children[0]!,
            offeredKeyset: { ...parent.children[0]!.offeredKeyset, keys: substitutedKeys },
          },
        ],
      }),
    /offered keyset authority is foreign/,
  )
  assert.throws(
    () =>
      measure({
        ...parent,
        inputs: Array.from({ length: 65 }, (_, index) =>
          proof(parent.sourceKeysetId, 16_384 + index),
        ),
      }),
    /input or output authority is invalid/,
  )
})

function batchPlan(
  preparations: readonly PersistedCtfRangeOrderPreparation[],
  collateralProofs: readonly Proof[],
  conditionalProofs: readonly Proof[],
) {
  return planCtfRangeCapabilityBatches({
    children: preparations.map(batchChild),
    collateralKeyset:
      preparations[0]!.side === 'Buy'
        ? preparations[0]!.offerKeyset
        : preparations[0]!.receiveKeyset,
    collateralProofs,
    conditionalProofs,
    limits: {
      maxInputs: 64,
      maxChildren: 32,
      maxOutputs: 256,
      maxRequestBytes: 1_048_576,
      maxPoolEntries: 128,
    },
    measureExactParentRequestBytes: createCtfRangeCapabilityParentRequestMeasurer({ preparations }),
  })
}

function batchChild(prepared: PersistedCtfRangeOrderPreparation): CtfRangeCapabilityBatchChild {
  const authorizationAmounts = planCtfRangeOrderAuthorization({
    side: prepared.side,
    priceNumerator: prepared.priceNumerator,
    amountSubunits: prepared.amountSubunits,
    divisibility: prepared.divisibility,
    inputFeePpk: prepared.offerKeyset.inputFeePpk,
    offerKeysetKeys: prepared.offerKeyset.keys,
    maxPoolEntries: prepared.maxPoolEntries,
    maxInputs: prepared.maxInputs,
  }).authorizationAmounts
  const base = {
    route: prepared.request.marketId,
    price: String(prepared.priceNumerator),
    amount: String(prepared.amountSubunits),
    clientOrderId: prepared.request.clientOrderId,
    authorizationAmounts,
    poolEntryCount: 1,
  }
  return prepared.side === 'Buy'
    ? { ...base, side: 'Buy', offeredAsset: 'collateral', offeredKeyset: prepared.offerKeyset }
    : {
        ...base,
        side: 'Sell',
        offeredAsset: 'conditional',
        offeredKeyset: prepared.offerKeyset,
        complementKeyset: prepared.complementKeyset,
      }
}

function preparation(clientOrderId: string, side: 'Buy' | 'Sell') {
  return buildPersistedCtfRangeOrderPreparation({
    request: request(clientOrderId, side),
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    mintFacts: reviewedMintFacts(),
    market: {
      outcomes: [
        { id: 'yes-id', label: 'YES' },
        { id: 'no-id', label: 'NO' },
      ],
    },
    nowUnixSeconds: 20,
    randomId: sequentialId(`range-${clientOrderId}`, `authorization-${clientOrderId}`),
  })
}

function request(clientOrderId: string, side: 'Buy' | 'Sell'): CtfRangeOrderRequest {
  return {
    clientOrderId,
    marketId: `${CONDITION_ID}-YES`,
    conditionId: CONDITION_ID,
    outcomeId: 'yes-id',
    tokenSide: 'Outcome',
    side,
    price: 2,
    amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000,
    baseAsset: 'sat',
    collateralUnit: 'msat',
    divisibility: 1_000,
    timeInForce: 'FOK',
    expiresAt: null,
    mintUrl: MINT_URL,
  }
}

function reviewedMintFacts() {
  const regular = activeKeyset(REGULAR_KEYSET_ID)
  const yes = conditionalKeyset(YES_KEYSET_ID, 'YES', YES_COLLECTION_ID)
  const no = conditionalKeyset(NO_KEYSET_ID, 'NO', NO_COLLECTION_ID)
  return {
    regular: [regular],
    conditional: [yes, no],
    maxInputs: 64,
    maxPoolEntries: 128,
    observation: {
      canonicalMintUrl: MINT_URL,
      freshness: 'fresh' as const,
      observedAt: 10,
      maxExpirySeconds: FINAL_EXPIRY,
      conditionKeysetIds: [YES_KEYSET_ID, NO_KEYSET_ID],
      conditionalKeysets: [yes, no].map((keyset) => ({
        keysetId: keyset.id,
        conditionId: CONDITION_ID,
        unit: 'msat',
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
        outcomeCollection: keyset.outcomeCollection,
        outcomeCollectionId: keyset.outcomeCollectionId,
        registeredAt: 10,
        keys: KEYS,
      })),
    },
  }
}

function activeKeyset(id: string) {
  return {
    canonicalMintUrl: MINT_URL,
    id,
    unit: 'msat' as const,
    active: true as const,
    keys: KEYS,
    inputFeePpk: INPUT_FEE_PPK,
    finalExpiry: FINAL_EXPIRY,
  }
}

function conditionalKeyset(id: string, outcomeCollection: string, outcomeCollectionId: string) {
  return {
    ...activeKeyset(id),
    conditionId: CONDITION_ID,
    outcomeCollection,
    outcomeCollectionId,
    registeredAt: 10,
  }
}

function conditionalKeysetId(outcomeCollectionId: string) {
  return deriveConditionalKeysetId({
    keys: KEYS,
    unit: 'msat',
    input_fee_ppk: INPUT_FEE_PPK,
    final_expiry: FINAL_EXPIRY,
    conditionId: CONDITION_ID,
    outcomeCollectionId,
  })
}

function sequentialId(...ids: string[]): () => string {
  let index = 0
  return () => ids[index++] ?? 'unexpected-id'
}

function proof(id: string, amount: number): Proof {
  return { id, amount: Amount.from(amount), secret: `proof-${id}-${amount}`, C: MINT_PUBLIC_KEY }
}

function signOutput(output: SerializedBlindedMessage): SerializedBlindedSignature {
  const signature = createBlindSignature(pointFromHex(output.B_), MINT_PRIVATE_KEY, output.id)
  const dleq = createDLEQProof(pointFromHex(output.B_), MINT_PRIVATE_KEY)
  return {
    id: signature.id,
    amount: Amount.from(output.amount),
    C_: signature.C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  }
}

function counterSource(calls: Array<{ keysetId: string; count: number }> = []): CounterSource {
  let next = 0
  return {
    reserve: async (keysetId, count) => {
      calls.push({ keysetId, count })
      const reservation = { start: next, count }
      next += count
      return reservation
    },
    advanceToAtLeast: async (_keysetId, minimum) => {
      next = Math.max(next, minimum)
    },
  }
}
