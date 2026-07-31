import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/curves/utils.js'
import {
  Amount,
  OutputData,
  createBlindSignature,
  createCtfAuthorizationOutputs,
  createDLEQProof,
  createCtfRangeManifest,
  createCtfSelectionBitmap,
  deriveConditionalKeysetId,
  deriveCtfRangeRefundKey,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import {
  assertDurableCtfRangeCustodyAuthority,
  buildDurableCtfRangeRecoveryQuery,
  classifyDurableCtfRangeRecovery,
  createDeterministicDurableCtfRangeRefundOutputs,
  createDurableCtfRangeOperation,
  createDurableCtfRangeCustodyBinding,
  createDurableCtfRangeRefundOperation,
  createDurableCtfRangeResultEnvelope,
  decodeDurableCtfRangeOperation,
  decodeDurableCtfRangeResultEnvelopeBytes,
  DURABLE_CTF_RANGE_RESULT_BYTES_MAX,
  deriveDurableCtfRangeFeeBounds,
  deriveDurableCtfRangeSettledFaceAmount,
  deriveDurableCtfRangeRefundOperationId,
  deriveDurableCtfRangeRefundRequestFingerprint,
  deriveDurableCtfResidualDecision,
  deriveRootCtfOutcomeCollectionId,
  prepareDurableCtfRangeRecoveredResult,
  prepareDurableCtfRangeVerifiedResult,
  recoverDurableCtfRangeResult,
  recoverDurableCtfRangeVerifiedResultArtifact,
  requireDurableCtfRangeOperationFromCustody,
  toDurableCtfRangeProofOperationInput,
  stageDurableCtfRangeVerifiedResult,
  type DurableCtfRangeExpiryObservation,
  type DurableCtfRangeOperation,
  type DurableCtfRangeAllManifestRecovery,
} from '../src/durableCtfRangeOperation.ts'
import {
  assertDurableCtfRangeExactBinding,
  assertDurableCtfRangeExactCommittedBinding,
  assertDurableCtfRangeInputsUnspent,
  createDurableCtfRangeStagedResultAuthority,
  mapDurableCtfRangeSuccessorProofs,
  matchDurableCtfRangeExactStagedResult,
} from '../src/durableCtfRangeCustody.ts'
import type { TokenImportKeysetLookup } from '../src/tokenImportValidation.ts'
import { bindDurableCustodyProofOperation } from '../src/durableCustodyProofOperationRecord.ts'
import {
  deriveDurableCustodyScopeId,
  resolveDurableCustodyProofOperationFacts,
  type DurableCustodyScope,
  type DurableCustodyScopeState,
  type DurableCustodyTransaction,
} from '../src/index.ts'
import {
  createPoolSettlementCapabilityArtifact,
  decodeSettlementCapabilityArtifact,
} from '../src/settlementCapabilityArtifact.ts'
import { FaultInjectingDurableCustodyAdapter } from './support/faultInjectingDurableCustodyAdapter.ts'

const CONDITION_ID = 'ab'.repeat(32)
const OUTCOME_COLLECTION = 'YES'
const SECOND_OUTCOME_COLLECTION = 'NO'
const ROOT_PARENT = '0'.repeat(64)
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(MINT_PRIVATE_KEY, true))
const KEYS = { '1': MINT_PUBLIC_KEY, '2': MINT_PUBLIC_KEY, '4': MINT_PUBLIC_KEY }
const INPUT_FEE_PPK = 100
const FINAL_EXPIRY = 200
const COORDINATOR_PUBLIC_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const OTHER_COORDINATOR_PUBLIC_KEY =
  'e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13'
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
})
const SECOND_OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: 'NO',
})
const OFFER_KEYSET = deriveKeysetId(KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
})
const RECEIVE_KEYSET = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})
const SECOND_CONDITIONAL_KEYSET = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: SECOND_OUTCOME_COLLECTION_ID,
})
const SEED = new Uint8Array(64).fill(7)

function fixture(
  options: {
    inputAmounts?: string[]
    keysetLookup?: TokenImportKeysetLookup
    expiry?: number
    expiryObservation?: DurableCtfRangeExpiryObservation
    proofSigningPrivateKey?: Uint8Array
    offerKeysetId?: string
    expiryContext?: Parameters<typeof createCtfAuthorizationOutputs>[0]['expiryContext']
  } = {},
): DurableCtfRangeOperation {
  const expiry = options.expiry ?? 100
  const offerKeysetId = options.offerKeysetId ?? OFFER_KEYSET
  const manifest = createCtfRangeManifest({
    seed: SEED,
    operationId: 'range-operation-1',
    receiveKeyset: { id: RECEIVE_KEYSET, active: true, keys: KEYS },
    offerKeyset: { id: offerKeysetId, active: true, keys: KEYS },
    maxReceive: '3',
    maxChange: '3',
    maxEntries: 4,
  })
  const refundKey = deriveCtfRangeRefundKey(SEED, 'range-operation-1')
  const authorization = createCtfAuthorizationOutputs({
    seed: SEED,
    operationId: 'range-operation-1',
    offerKeysetId,
    amounts: options.inputAmounts ?? ['4'],
    commitment: manifest.commitment,
    expiry,
    expiryContext: options.expiryContext ?? authorizationExpiryContext(),
    refund: refundKey.publicKey,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    poolPolicy: { rateN: '1', rateD: '1', minReceive: '1', maxDebit: '4' },
  })
  return createDurableCtfRangeOperation({
    operationId: 'range-operation-1',
    sourceOperationId: 'prepare-operation-1',
    authorizationId: 'authorization-1',
    mintUrl: 'https://mint.example',
    unit: 'msat',
    conditionId: CONDITION_ID,
    parentCollectionId: ROOT_PARENT,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    offerKeysetId,
    receiveKeysetId: RECEIVE_KEYSET,
    keysetLookup: options.keysetLookup ?? rangeKeysetLookup(),
    expiryObservation: options.expiryObservation ?? conditionExpiryObservation(),
    allowInsecureLoopbackHttp: false,
    expiry,
    policy: { rateN: '1', rateD: '1', minReceive: '1', maxDebit: '4' },
    refundKey,
    inputFeePpkByKeyset: { [offerKeysetId]: INPUT_FEE_PPK },
    inputs: authorization.map((output) =>
      signOutput(output, options.proofSigningPrivateKey ?? MINT_PRIVATE_KEY),
    ),
    manifest,
  })
}

function ambiguousConditionalFixture(): DurableCtfRangeOperation {
  const baseLookup = rangeKeysetLookup()
  const second = conditionExpiryObservationWithSecondKeyset(FINAL_EXPIRY)
  return fixture({
    offerKeysetId: SECOND_CONDITIONAL_KEYSET,
    keysetLookup: {
      ...baseLookup,
      regularKeysets: [],
      conditionalKeysets: [
        ...baseLookup.conditionalKeysets,
        {
          keysetId: SECOND_CONDITIONAL_KEYSET,
          unit: 'msat',
          active: true,
          conditionId: CONDITION_ID,
          outcomeCollection: SECOND_OUTCOME_COLLECTION,
          outcomeCollectionId: SECOND_OUTCOME_COLLECTION_ID,
          inputFeePpk: INPUT_FEE_PPK,
          finalExpiry: FINAL_EXPIRY,
        },
      ],
    },
    expiryObservation: second.observation,
    expiryContext: {
      now: 10,
      maxExpirySeconds: 100,
      condition: {
        condition_id: CONDITION_ID,
        keysets: {
          [OUTCOME_COLLECTION]: RECEIVE_KEYSET,
          [SECOND_OUTCOME_COLLECTION]: SECOND_CONDITIONAL_KEYSET,
        },
      },
      conditionalKeysets: [
        {
          id: RECEIVE_KEYSET,
          condition_id: CONDITION_ID,
          final_expiry: FINAL_EXPIRY,
        },
        {
          id: SECOND_CONDITIONAL_KEYSET,
          condition_id: CONDITION_ID,
          final_expiry: FINAL_EXPIRY,
        },
      ],
    },
  })
}

function authorizationExpiryContext(): Parameters<
  typeof createCtfAuthorizationOutputs
>[0]['expiryContext'] {
  return {
    now: 10,
    maxExpirySeconds: 100,
    condition: { condition_id: CONDITION_ID, keysets: { YES: RECEIVE_KEYSET } },
    conditionalKeysets: [
      { id: RECEIVE_KEYSET, condition_id: CONDITION_ID, final_expiry: FINAL_EXPIRY },
    ],
  }
}

function conditionExpiryObservation(): DurableCtfRangeExpiryObservation {
  return {
    canonicalMintUrl: 'https://mint.example',
    freshness: 'fresh',
    observedAt: 10,
    maxExpirySeconds: 100,
    conditionKeysetIds: [RECEIVE_KEYSET],
    conditionalKeysets: [
      {
        keysetId: RECEIVE_KEYSET,
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

function conditionExpiryObservationWithSecondKeyset(
  actualFinalExpiry: number | null,
  maxExpirySeconds = 100,
  reportedFinalExpiry = actualFinalExpiry,
): {
  keysetId: string
  observation: DurableCtfRangeExpiryObservation
} {
  const base = conditionExpiryObservation()
  const keysetId = deriveConditionalKeysetId({
    keys: KEYS,
    unit: 'msat',
    input_fee_ppk: INPUT_FEE_PPK,
    ...(actualFinalExpiry === null ? {} : { final_expiry: actualFinalExpiry }),
    conditionId: CONDITION_ID,
    outcomeCollectionId: SECOND_OUTCOME_COLLECTION_ID,
  })
  return {
    keysetId,
    observation: {
      ...base,
      maxExpirySeconds,
      conditionKeysetIds: [...base.conditionKeysetIds, keysetId],
      conditionalKeysets: [
        ...base.conditionalKeysets,
        {
          keysetId,
          conditionId: CONDITION_ID,
          unit: 'msat',
          inputFeePpk: INPUT_FEE_PPK,
          ...(reportedFinalExpiry === null ? {} : { finalExpiry: reportedFinalExpiry }),
          outcomeCollectionId: SECOND_OUTCOME_COLLECTION_ID,
          keys: KEYS,
        },
      ],
    },
  }
}

function rangeKeysetLookup(): TokenImportKeysetLookup {
  return {
    canonicalMintUrl: 'https://mint.example',
    freshness: 'fresh',
    regularKeysets: [
      {
        keysetId: OFFER_KEYSET,
        unit: 'msat',
        active: true,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
    conditionalKeysets: [
      {
        keysetId: RECEIVE_KEYSET,
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

function signOutput(output: OutputData, mintPrivateKey = MINT_PRIVATE_KEY): Proof {
  const mintPublicKey = bytesToHex(secp256k1.getPublicKey(mintPrivateKey, true))
  const signingKeys = Object.fromEntries(Object.keys(KEYS).map((amount) => [amount, mintPublicKey]))
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    mintPrivateKey,
    output.blindedMessage.id,
  )
  return output.toProof(
    {
      id: signature.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: serializeDleq(output.blindedMessage.B_, mintPrivateKey),
    },
    { id: output.blindedMessage.id, keys: signingKeys },
  )
}

function signaturesFor(operation: DurableCtfRangeOperation, selection: string) {
  const selected = new Set(
    operation.manifest.entries
      .filter((_, index) => {
        const bytes = Buffer.from(selection, 'hex')
        return (bytes[index >> 3]! & (1 << (index & 7))) !== 0
      })
      .map(({ B_ }) => B_),
  )
  return operation.manifest.entries
    .filter(({ B_ }) => selected.has(B_))
    .map(({ outputData }) => {
      const output = OutputData.deserialize(outputData)
      const signature = createBlindSignature(
        pointFromHex(output.blindedMessage.B_),
        MINT_PRIVATE_KEY,
        output.blindedMessage.id,
      )
      return {
        id: signature.id,
        amount: output.blindedMessage.amount,
        C_: signature.C_.toHex(true),
        dleq: serializeDleq(output.blindedMessage.B_),
      }
    })
}

function serializeDleq(B_: string, mintPrivateKey = MINT_PRIVATE_KEY) {
  const dleq = createDLEQProof(pointFromHex(B_), mintPrivateKey)
  return { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) }
}

function recoveryFor(
  operation: DurableCtfRangeOperation,
  selection: string,
  reverse = false,
): DurableCtfRangeAllManifestRecovery {
  const restoredOutputs = buildDurableCtfRangeRecoveryQuery(operation, selection).outputs
  const signatures = signaturesFor(operation, selection)
  return {
    queriedOutputs: buildDurableCtfRangeRecoveryQuery(operation, null).outputs,
    restoredOutputs: reverse ? [...restoredOutputs].reverse() : restoredOutputs,
    signatures: reverse ? [...signatures].reverse() : signatures,
    queryCompleted: true,
  }
}

async function factsFor(operation: DurableCtfRangeOperation, requireDleq = true) {
  const keysets = mintKeysetsFor(operation)
  return resolveDurableCustodyProofOperationFacts({
    operation: toDurableCtfRangeProofOperationInput(operation),
    resolveMintKeys: async () =>
      new Map(
        [...keysets].map(([id, keyset]) => [
          id,
          {
            id,
            unit: keyset.unit,
            keys: keyset.keys,
            final_expiry: keyset.finalExpiry ?? undefined,
          },
        ]),
      ),
    requireDleq,
  })
}

function mintKeysetsFor(operation: DurableCtfRangeOperation) {
  return new Map(
    [operation.keysetAuthority.offer, operation.keysetAuthority.receive].map((authority) => [
      authority.keysetId,
      {
        canonicalMintUrl: operation.mintUrl,
        id: authority.keysetId,
        unit: authority.unit,
        keys: KEYS,
        inputFeePpk: authority.inputFeePpk,
        finalExpiry: authority.finalExpiry,
      },
    ]),
  )
}

async function recordFor(operation: DurableCtfRangeOperation) {
  return createDurableCtfRangeCustodyBinding({
    scope: walletScope(),
    operation,
    facts: await factsFor(operation),
    mintKeysets: mintKeysetsFor(operation),
    inventoryAccountId: null,
    boundary: {
      method: 'POST',
      path: '/v1/range-authorizations',
      idempotencyKey: operation.authorizationId,
      requestBody: { authorizationId: operation.authorizationId },
    },
  }).record
}

function resolveKeyset(_canonicalMintUrl: string, id: string) {
  return id === OFFER_KEYSET || id === RECEIVE_KEYSET ? { id, keys: KEYS } : undefined
}

function inputY(operation: DurableCtfRangeOperation): string {
  return hashToCurve(new TextEncoder().encode(operation.inputs[0]!.secret)).toHex(true)
}

test('range operation preserves direct proof-operation authority and fee bounds', () => {
  const operation = fixture()
  assert.deepEqual(operation.keysetAuthority, {
    offer: {
      keysetId: OFFER_KEYSET,
      unit: 'msat',
      source: 'regular',
      activity: 'active',
      inputFeePpk: INPUT_FEE_PPK,
      finalExpiry: FINAL_EXPIRY,
      conditionId: null,
      outcomeCollection: null,
      outcomeCollectionId: null,
    },
    receive: {
      keysetId: RECEIVE_KEYSET,
      unit: 'msat',
      source: 'conditional',
      activity: 'active',
      inputFeePpk: INPUT_FEE_PPK,
      finalExpiry: FINAL_EXPIRY,
      conditionId: CONDITION_ID,
      outcomeCollection: OUTCOME_COLLECTION,
      outcomeCollectionId: OUTCOME_COLLECTION_ID,
    },
  })
  assert.equal(operation.schemaVersion, 2)
  assert.equal(operation.coordinatorPublicKey, COORDINATOR_PUBLIC_KEY)
  assert.equal(decodeDurableCtfRangeOperation(operation).sourceOperationId, 'prepare-operation-1')
  assert.throws(
    () => decodeDurableCtfRangeOperation({ ...operation, schemaVersion: 1 }),
    /schema is unsupported/,
  )
  assert.deepEqual(deriveDurableCtfRangeFeeBounds(operation), {
    weightPpk: 100n,
    minimumFee: 0n,
    maximumFee: 1n,
  })
  assert.deepEqual(
    deriveDurableCtfRangeFeeBounds(
      fixture({
        inputAmounts: Array.from({ length: 11 }, () => '1'),
      }),
    ),
    {
      weightPpk: 1_100n,
      minimumFee: 1n,
      maximumFee: 2n,
    },
  )
  const custody = toDurableCtfRangeProofOperationInput(operation)
  assert.equal(custody.kind, 'ctf-range-authorization')
  assert.equal(
    requireDurableCtfRangeOperationFromCustody(custody).sourceOperationId,
    'prepare-operation-1',
  )
  assert.throws(
    () =>
      decodeDurableCtfRangeOperation({
        ...operation,
        inputFeePpkByKeyset: { [OFFER_KEYSET]: 0 },
      }),
    /input fee authority/,
  )
  assert.throws(
    () =>
      decodeDurableCtfRangeOperation({
        ...operation,
        inputs: [operation.inputs[0], operation.inputs[0]],
      }),
    /input proof.*uniqueness/,
  )
  assert.throws(
    () =>
      decodeDurableCtfRangeOperation({
        ...operation,
        inputs: [{ ...operation.inputs[0]!, dleq: { e: 'e', s: 's', foreign: true } }],
      }),
    /proof DLEQ/,
  )
  assert.throws(
    () =>
      decodeDurableCtfRangeOperation({
        ...operation,
        inputs: [{ ...operation.inputs[0]!, witness: { signatures: [] } }],
      }),
    /proof witness/,
  )
  assert.throws(
    () =>
      decodeDurableCtfRangeOperation({
        ...operation,
        coordinatorPublicKey: OTHER_COORDINATOR_PUBLIC_KEY,
      }),
    /input authority/,
  )
  assert.throws(
    () =>
      decodeDurableCtfRangeOperation({
        ...operation,
        coordinatorPublicKey: '00'.repeat(32),
      }),
    /coordinator public key is invalid/,
  )
})

test('range custody authority admits repeated input keysets and rejects substitutions', async () => {
  const operation = fixture({ inputAmounts: ['2', '2'] })
  const record = await recordFor(operation)
  assert.equal(
    isDeepStrictEqual(assertDurableCtfRangeCustodyAuthority(record, operation), operation),
    true,
    'validated range authority must preserve the exact operation',
  )

  const substitutions: Array<[typeof record, RegExp]> = [
    [
      {
        ...record,
        operation: {
          ...record.operation,
          custodyContext: {
            ...record.operation.custodyContext,
            normalizedMint: 'https://foreign-mint.example',
          },
        },
      },
      /custody context/,
    ],
    [
      {
        ...record,
        operation: {
          ...record.operation,
          privateMaterial: {
            ...record.operation.privateMaterial,
            publicFingerprint: '0'.repeat(64),
          },
        },
      },
      /private authority/,
    ],
    [
      {
        ...record,
        operation: {
          ...record.operation,
          outputPlan: {
            ...record.operation.outputPlan,
            outputPlanFingerprint: '0'.repeat(64),
          },
        },
      },
      /output/,
    ],
    [
      {
        ...record,
        operation: {
          ...record.operation,
          reservation: {
            ...record.operation.reservation,
            inputs: [...record.operation.reservation.inputs].reverse(),
          },
        },
      },
      /proof-operation link/,
    ],
    [
      {
        ...record,
        operation: {
          ...record.operation,
          verification: {
            ...record.operation.verification,
            inputKeysets: [],
          },
        },
      },
      /input keyset authority/,
    ],
    [
      {
        ...record,
        operation: {
          ...record.operation,
          verification: {
            ...record.operation.verification,
            keysetBindings: record.operation.verification.keysetBindings.slice(1),
          },
        },
      },
      /keyset binding authority/,
    ],
  ]
  for (const [substituted, expected] of substitutions) {
    assert.throws(() => assertDurableCtfRangeCustodyAuthority(substituted, operation), expected)
  }
})

test('shared range custody binding and NUT-07 helpers preserve exact authority', async () => {
  const { operation, binding } = await sharedRangeBinding()
  const exactOperation = assertDurableCtfRangeExactBinding(binding)
  assertDurableCtfRangeExactCommittedBinding(binding.record, binding.record, exactOperation)
  const substitutedBinding = structuredClone(binding.record)
  substitutedBinding.operation.exactRequest.idempotencyKey = 'foreign-idempotency-key'
  assert.throws(
    () =>
      assertDurableCtfRangeExactCommittedBinding(
        substitutedBinding,
        binding.record,
        exactOperation,
      ),
    /immutable authority is not exact/,
  )
  assertDurableCtfRangeInputsUnspent([{ Y: inputY(operation), state: 'UNSPENT', witness: null }])
  assert.throws(
    () =>
      assertDurableCtfRangeInputsUnspent([
        { Y: inputY(operation), state: 'PENDING', witness: null },
      ]),
    /not UNSPENT/,
  )
})

test('shared range custody mapping is exact and rejects over-bound results before mapping', async () => {
  const { operation, prepared, staged } = await stagedSharedRangeResult()
  assert.equal(
    deriveDurableCtfRangeSettledFaceAmount(operation, prepared.result),
    prepared.result.receive.reduce((total, proof) => total + Number(proof.amount), 0),
  )
  assert.equal(
    matchDurableCtfRangeExactStagedResult(staged, prepared.authority)?.fingerprint,
    prepared.resultFingerprint,
  )
  const successors = mapDurableCtfRangeSuccessorProofs(
    { record: staged, operation, result: prepared.result },
    (proof) => proof,
  )
  assert.deepEqual(
    successors.map(({ material }) => material.proofId),
    prepared.selectedSuccessorProofIds,
  )
  assert.deepEqual(
    successors.map(({ classification }) => classification),
    [
      { conditionId: CONDITION_ID, outcomeSetId: OUTCOME_COLLECTION },
      { conditionId: null, outcomeSetId: null },
    ],
  )
  let oversizedMapCalls = 0
  assert.throws(
    () =>
      mapDurableCtfRangeSuccessorProofs(
        {
          record: staged,
          operation,
          result: {
            ...prepared.result,
            receive: Array.from({ length: 513 }, () => prepared.result.receive[0]!),
            change: [],
          },
        },
        () => {
          oversizedMapCalls += 1
        },
      ),
    /proof count is invalid/,
  )
  assert.equal(oversizedMapCalls, 0)

  for (const result of [
    {
      ...prepared.result,
      change: [prepared.result.receive[0]!],
    },
    {
      ...prepared.result,
      change: [
        {
          ...prepared.result.change[0]!,
          secret: `${prepared.result.change[0]!.secret}-foreign`,
        },
      ],
    },
  ]) {
    let invalidMapCalls = 0
    assert.throws(
      () =>
        mapDurableCtfRangeSuccessorProofs({ record: staged, operation, result }, () => {
          invalidMapCalls += 1
        }),
      /duplicated|foreign/,
    )
    assert.equal(invalidMapCalls, 0)
  }
})

test('shared range custody applied replay uses persisted authority without remapping', async () => {
  const { operation, prepared, adapter, staged } = await stagedSharedRangeResult()
  adapter.run((transaction) =>
    transaction.applyVerifiedResult({
      operationId: staged.operation.operationId,
      expectedRevision: staged.revision,
      authorization: { incarnationId: 'process-1', fencingEpoch: 1, observedAtMs: 21 },
      outputPlanFingerprint: staged.operation.outputPlan.outputPlanFingerprint,
      resultHandle: staged.operation.result.resultHandle!,
      resultFingerprint: staged.operation.result.resultFingerprint!,
      successorAdmission: {
        scopeId: staged.scope.scopeId,
        operationId: staged.operation.operationId,
        admissionId: 'shared-helper-admission',
        proofRows: prepared.selectedSuccessorProofIds.map((proofId) => ({
          proofId,
          expectedRevision: null,
          admittedRevision: 0,
        })),
      },
    }),
  )
  assert.equal(
    matchDurableCtfRangeExactStagedResult(adapter.readOperation()!, prepared.authority)
      ?.fingerprint,
    prepared.resultFingerprint,
  )
  assert.throws(
    () =>
      mapDurableCtfRangeSuccessorProofs(
        { record: adapter.readOperation()!, operation, result: prepared.result },
        (proof) => proof,
      ),
    /successor rows are already applied/,
  )

  const substituted = structuredClone(staged)
  substituted.operation.result.resultHandle = 'foreign-result'
  assert.throws(
    () => matchDurableCtfRangeExactStagedResult(substituted, prepared.authority),
    /staged result authority is foreign/,
  )
})

async function sharedRangeBinding() {
  const operation = fixture()
  const binding = createDurableCtfRangeCustodyBinding({
    scope: walletScope(),
    operation,
    facts: await factsFor(operation),
    mintKeysets: mintKeysetsFor(operation),
    inventoryAccountId: null,
    boundary: {
      method: 'POST',
      path: '/v1/range-authorizations',
      idempotencyKey: operation.authorizationId,
      requestBody: { authorizationId: operation.authorizationId },
    },
  })
  return { operation, binding }
}

async function stagedSharedRangeResult() {
  const { operation, binding } = await sharedRangeBinding()
  const selection = createCtfSelectionBitmap(4, [1, 3])
  const decision = prepareDurableCtfRangeVerifiedResult({
    record: binding.record,
    operation,
    envelope: createDurableCtfRangeResultEnvelope({
      operation,
      requestDigest: 'ef'.repeat(32),
      selection,
      signatures: signaturesFor(operation, selection),
    }),
    allManifestRecovery: recoveryFor(operation, selection),
    resolveKeyset,
  })
  assert.equal(decision.kind, 'confirmed')
  if (decision.kind !== 'confirmed') throw new Error('range result fixture is not confirmed')
  const authority = createDurableCtfRangeStagedResultAuthority({
    record: binding.record,
    exactResult: decision.exactResult,
    resultHandle: decision.resultHandle,
    resultFingerprint: decision.resultFingerprint,
    selectedSuccessorProofIds: decision.selectedSuccessorProofIds,
  })
  const adapter = new FaultInjectingDurableCustodyAdapter(scopeState(binding.record.scope))
  adapter.run((transaction) =>
    bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
  )
  adapter.run((transaction) =>
    transaction.stageVerifiedResult({
      operationId: binding.record.operation.operationId,
      expectedRevision: binding.record.revision,
      authorization: { incarnationId: 'process-1', fencingEpoch: 1, observedAtMs: 20 },
      outputPlanFingerprint: binding.record.operation.outputPlan.outputPlanFingerprint,
      resultHandle: decision.resultHandle,
      resultFingerprint: decision.resultFingerprint,
      exactResult: decision.exactResult,
      selectedSuccessorProofIds: decision.selectedSuccessorProofIds,
    }),
  )
  return {
    operation,
    adapter,
    staged: adapter.readOperation()!,
    prepared: { ...decision, authority },
  }
}

test('range operation produces one canonical pool settlement capability artifact', () => {
  const operation = fixture()
  const artifact = createPoolSettlementCapabilityArtifact(operation)

  assert.equal(artifact.operationId, operation.operationId)
  assert.equal(artifact.authorizationId, operation.authorizationId)
  assert.deepEqual(artifact.policy, operation.policy)
  assert.deepEqual(
    artifact.manifest.entries,
    operation.manifest.entries.map(({ outputData: _, ...entry }) => entry),
  )
  assert.deepEqual(artifact.inputProofYs, [inputY(operation)])
  assert.deepEqual(decodeSettlementCapabilityArtifact(artifact), artifact)

  assert.throws(
    () =>
      createPoolSettlementCapabilityArtifact({
        ...operation,
        inputs: operation.inputs.map((proof) => ({ ...proof, dleq: null })),
      }),
    /proof DLEQ is required/,
  )
})

test('range operation admits only fresh exact active keyset classifications', () => {
  const base = rangeKeysetLookup()
  const receive = base.conditionalKeysets[0]!
  const rejected: Array<[TokenImportKeysetLookup, RegExp]> = [
    [{ ...base, freshness: 'stale' }, /stale/],
    [{ ...base, conditionalKeysets: [] }, /did not return keyset/],
    [
      { ...base, conditionalKeysets: [{ ...receive, active: false }] },
      /receive keyset is inactive/,
    ],
    [
      {
        ...base,
        conditionalKeysets: [{ ...receive, conditionId: 'ef'.repeat(32) }],
      },
      /condition is foreign/,
    ],
    [
      {
        ...base,
        conditionalKeysets: [{ ...receive, outcomeCollectionId: 'INVALID' }],
      },
      /outcome collection id is invalid/,
    ],
    [
      {
        ...base,
        conditionalKeysets: [{ ...receive, outcomeCollectionId: 'ef'.repeat(32) }],
      },
      /outcome collection id is inconsistent/,
    ],
    [
      {
        ...base,
        regularKeysets: [{ ...base.regularKeysets[0]!, inputFeePpk: INPUT_FEE_PPK + 1 }],
      },
      /input fee authority/,
    ],
    [{ ...base, canonicalMintUrl: 'https://foreign-mint.example' }, /foreign mint/],
    [
      {
        ...base,
        regularKeysets: [
          ...base.regularKeysets,
          { keysetId: RECEIVE_KEYSET, unit: 'msat', active: true },
        ],
      },
      /ambiguous/,
    ],
    [
      {
        ...base,
        regularKeysets: [
          ...base.regularKeysets,
          { keysetId: '00feedface123456', unit: 'msat', active: true },
        ],
      },
      /unrequested keyset/,
    ],
  ]
  for (const [keysetLookup, expected] of rejected) {
    assert.throws(() => fixture({ keysetLookup }), expected)
  }

  assert.throws(
    () =>
      fixture({
        keysetLookup: {
          canonicalMintUrl: 'https://mint.example',
          freshness: 'fresh',
          regularKeysets: [
            {
              keysetId: OFFER_KEYSET,
              unit: 'msat',
              active: true,
              inputFeePpk: INPUT_FEE_PPK,
              finalExpiry: FINAL_EXPIRY,
            },
            {
              keysetId: RECEIVE_KEYSET,
              unit: 'msat',
              active: true,
              inputFeePpk: INPUT_FEE_PPK,
              finalExpiry: FINAL_EXPIRY,
            },
          ],
          conditionalKeysets: [],
        },
      }),
    /assets must differ/,
  )
})

test('range expiry authority covers every condition keyset and missing-expiry fallback', () => {
  const base = conditionExpiryObservation()
  const earlier = conditionExpiryObservationWithSecondKeyset(99)

  assert.throws(
    () => fixture({ expiryObservation: earlier.observation }),
    /effective condition keyset ceiling/,
  )
  const missingAtCeiling = conditionExpiryObservationWithSecondKeyset(null, 90)
  assert.throws(
    () => fixture({ expiryObservation: missingAtCeiling.observation }),
    /effective condition keyset ceiling/,
  )
  const missingAfterExpiry = conditionExpiryObservationWithSecondKeyset(null, 91)
  const fallback = fixture({ expiryObservation: missingAfterExpiry.observation })
  assert.equal(fallback.expiryAuthority.effectiveExpiryCeiling, 101)
  assert.equal(
    fallback.expiryAuthority.conditionalKeysets.find(
      ({ keysetId }) => keysetId === missingAfterExpiry.keysetId,
    )?.finalExpiry,
    null,
  )
  assert.throws(
    () =>
      fixture({
        expiryObservation: {
          ...base,
          conditionKeysetIds: [...base.conditionKeysetIds, earlier.keysetId],
        },
      }),
    /complete.*expiry authority/,
  )
  assert.throws(
    () => fixture({ expiryObservation: { ...base, freshness: 'stale' } }),
    /observation is stale/,
  )
  assert.throws(
    () =>
      fixture({
        expiryObservation: conditionExpiryObservationWithSecondKeyset(99, 100, 200).observation,
      }),
    /keyset identity is inconsistent/,
  )
  assert.throws(
    () => decodeDurableCtfRangeOperation({ ...fixture(), expiry: 110 }),
    /effective condition keyset ceiling/,
  )
  const operation = fixture()
  assert.throws(
    () =>
      decodeDurableCtfRangeOperation({
        ...operation,
        expiryAuthority: {
          ...operation.expiryAuthority,
          conditionalKeysets: operation.expiryAuthority.conditionalKeysets.map((keyset) => ({
            ...keyset,
            finalExpiry: FINAL_EXPIRY + 1,
          })),
        },
      }),
    /selected keyset expiry differs/,
  )
})

test('range custody binding rejects mint keys inconsistent with persisted authority', async () => {
  const operation = fixture()
  const facts = await factsFor(operation)
  const otherPrivateKey = Uint8Array.from([...new Uint8Array(31), 2])
  const wrongKeys = {
    ...KEYS,
    '1': bytesToHex(secp256k1.getPublicKey(otherPrivateKey, true)),
  }
  const inconsistent = mintKeysetsFor(operation)
  inconsistent.set(RECEIVE_KEYSET, {
    ...inconsistent.get(RECEIVE_KEYSET)!,
    keys: wrongKeys,
  })
  const bind = (mintKeysets: ReturnType<typeof mintKeysetsFor>) =>
    createDurableCtfRangeCustodyBinding({
      scope: walletScope(),
      operation,
      facts,
      mintKeysets,
      inventoryAccountId: null,
      boundary: {
        method: 'POST',
        path: '/v1/range-authorizations',
        idempotencyKey: operation.authorizationId,
        requestBody: {},
      },
    })
  assert.throws(() => bind(inconsistent), /keyset identity is inconsistent/)

  const foreign = mintKeysetsFor(operation)
  foreign.set(OFFER_KEYSET, {
    ...foreign.get(OFFER_KEYSET)!,
    canonicalMintUrl: 'https://foreign-mint.example',
  })
  assert.throws(() => bind(foreign), /metadata is foreign/)

  const wrongFee = mintKeysetsFor(operation)
  wrongFee.set(OFFER_KEYSET, {
    ...wrongFee.get(OFFER_KEYSET)!,
    inputFeePpk: INPUT_FEE_PPK + 1,
  })
  assert.throws(() => bind(wrongFee), /metadata is foreign/)
})

test('range custody binding verifies every input proof against the pinned mint keys', async () => {
  const inputAmounts = ['2', '2']
  const operation = fixture({ inputAmounts })
  const facts = await factsFor(operation)
  const bind = (candidate: DurableCtfRangeOperation) =>
    createDurableCtfRangeCustodyBinding({
      scope: walletScope(),
      operation: candidate,
      facts,
      mintKeysets: mintKeysetsFor(operation),
      inventoryAccountId: null,
      boundary: {
        method: 'POST',
        path: '/v1/range-authorizations',
        idempotencyKey: operation.authorizationId,
        requestBody: {},
      },
    })

  const tamperedSignature = structuredClone(operation)
  tamperedSignature.inputs[1]!.C = MINT_PUBLIC_KEY
  assert.throws(() => bind(tamperedSignature), /input proof cryptographic verification failed/)

  const invalidDleq = structuredClone(operation)
  invalidDleq.inputs[0]!.dleq = {
    ...(invalidDleq.inputs[0]!.dleq as { e: string; s: string; r: string }),
    e: '00'.repeat(32),
  }
  assert.throws(() => bind(invalidDleq), /input proof cryptographic verification failed/)

  const foreignMintPrivateKey = Uint8Array.from([...new Uint8Array(31), 2])
  assert.throws(
    () => bind(fixture({ inputAmounts, proofSigningPrivateKey: foreignMintPrivateKey })),
    /input proof cryptographic verification failed/,
  )
})

test('range condition-inventory custody scope binds the exact condition', async () => {
  const operation = fixture()
  const facts = await factsFor(operation)
  const bind = (scope: DurableCustodyScope) =>
    createDurableCtfRangeCustodyBinding({
      scope,
      operation,
      facts,
      mintKeysets: mintKeysetsFor(operation),
      inventoryAccountId: 'inventory-1',
      boundary: {
        method: 'POST',
        path: '/v1/range-authorizations',
        idempotencyKey: operation.authorizationId,
        requestBody: {},
      },
    })

  const scope = conditionInventoryScope(CONDITION_ID)
  const bound = bind(scope)
  assert.equal(bound.record.scope.scopeId, scope.scopeId)
  assert.equal(bound.record.scope.conditionId, CONDITION_ID)
  assert.throws(
    () => bind(conditionInventoryScope('cd'.repeat(32))),
    /condition-inventory scope does not match the conditional asset/,
  )
})

test('range condition-inventory custody binding rejects ambiguous conditional assets', async () => {
  const operation = ambiguousConditionalFixture()
  const facts = await factsFor(operation)
  assert.throws(
    () =>
      createDurableCtfRangeCustodyBinding({
        scope: conditionInventoryScope(CONDITION_ID),
        operation,
        facts,
        mintKeysets: mintKeysetsFor(operation),
        inventoryAccountId: 'inventory-1',
        boundary: {
          method: 'POST',
          path: '/v1/range-authorizations',
          idempotencyKey: operation.authorizationId,
          requestBody: {},
        },
      }),
    /condition-inventory scope conditional asset is ambiguous/,
  )
})

test('selected range result unblinds only the exact persisted subset', async () => {
  const operation = fixture()
  const record = await recordFor(operation)
  const unsafeFacts = await factsFor(operation, false)
  assert.throws(
    () =>
      createDurableCtfRangeCustodyBinding({
        scope: walletScope(),
        operation,
        facts: unsafeFacts,
        mintKeysets: mintKeysetsFor(operation),
        inventoryAccountId: null,
        boundary: {
          method: 'POST',
          path: '/v1/range-authorizations',
          idempotencyKey: operation.authorizationId,
          requestBody: {},
        },
      }),
    /verification authority is unsafe/,
  )
  const selection = createCtfSelectionBitmap(4, [1, 3])
  const envelope = createDurableCtfRangeResultEnvelope({
    operation,
    requestDigest: 'ef'.repeat(32),
    selection,
    signatures: signaturesFor(operation, selection),
  })
  const result = recoverDurableCtfRangeResult(
    operation,
    envelope,
    recoveryFor(operation, selection),
    record,
    resolveKeyset,
  )
  assert.equal(result.receive.length, 1)
  assert.equal(result.change.length, 1)
  assert.equal(result.receive[0]?.amount.toString(), '2')
  assert.equal(result.change[0]?.amount.toString(), '2')
  const reversed = recoverDurableCtfRangeResult(
    operation,
    envelope,
    recoveryFor(operation, selection, true),
    record,
    resolveKeyset,
  )
  assert.equal(reversed.receive[0]?.amount.toString(), '2')
  assert.equal(reversed.change[0]?.amount.toString(), '2')
  assert.throws(
    () =>
      recoverDurableCtfRangeResult(
        operation,
        { ...envelope, authorizationId: 'foreign' },
        recoveryFor(operation, selection),
        record,
        resolveKeyset,
      ),
    /foreign/,
  )
  assert.throws(
    () =>
      recoverDurableCtfRangeResult(
        operation,
        envelope,
        {
          ...recoveryFor(operation, selection),
          signatures: recoveryFor(operation, selection).signatures.map((signature, index) =>
            index === 0 ? { ...signature, dleq: undefined } : signature,
          ),
        },
        record,
        resolveKeyset,
      ),
    /DLEQ/,
  )
  const otherMintKey = bytesToHex(
    secp256k1.getPublicKey(Uint8Array.from([...new Uint8Array(31), 2]), true),
  )
  assert.throws(
    () =>
      recoverDurableCtfRangeResult(
        operation,
        envelope,
        recoveryFor(operation, selection),
        record,
        (_canonicalMintUrl, id) =>
          id === OFFER_KEYSET || id === RECEIVE_KEYSET
            ? { id, keys: { '1': otherMintKey, '2': otherMintKey, '4': otherMintKey } }
            : undefined,
      ),
    /keyset identity is inconsistent/,
  )
  assert.throws(
    () =>
      recoverDurableCtfRangeResult(
        operation,
        envelope,
        {
          ...recoveryFor(operation, selection),
          queriedOutputs: buildDurableCtfRangeRecoveryQuery(operation, selection).outputs,
        },
        record,
        resolveKeyset,
      ),
    /full manifest/,
  )
})

test('recovery queries the exact manifest and never invents terminal state', async () => {
  const operation = fixture()
  const record = await recordFor(operation)
  const selection = createCtfSelectionBitmap(4, [1, 3])
  const query = buildDurableCtfRangeRecoveryQuery(operation, null)
  assert.equal(query.mode, 'unknown')
  assert.equal(query.outputs.length, 4)
  const selectedOutputs = buildDurableCtfRangeRecoveryQuery(operation, selection).outputs
  const confirmed = classifyDurableCtfRangeRecovery({
    operation,
    record,
    observation: {
      selection: null,
      inputStates: [{ Y: inputY(operation), state: 'SPENT', witness: null }],
      queriedOutputs: query.outputs,
      restoredOutputs: selectedOutputs,
      signatures: signaturesFor(operation, selection),
      queryCompleted: true,
      now: 50,
    },
    resolveKeyset,
  })
  assert.equal(confirmed.kind, 'confirmed')
  assert.equal(confirmed.kind === 'confirmed' ? confirmed.result.selection : '', selection)
  const malformedSignatures = signaturesFor(operation, selection).map((signature, index) =>
    index === 0 ? { ...signature, C_: `02${'00'.repeat(32)}` } : signature,
  )
  for (const [signatures, resolver] of [
    [malformedSignatures, resolveKeyset],
    [signaturesFor(operation, selection), () => undefined],
  ] as const) {
    assert.equal(
      classifyDurableCtfRangeRecovery({
        operation,
        record,
        observation: {
          selection: null,
          inputStates: [{ Y: inputY(operation), state: 'SPENT', witness: null }],
          queriedOutputs: query.outputs,
          restoredOutputs: selectedOutputs,
          signatures,
          queryCompleted: true,
          now: 50,
        },
        resolveKeyset: resolver,
      }).kind,
      'reconciling',
    )
  }
  for (const [now, expected] of [
    [50, 'waiting'],
    [100, 'refundable'],
  ] as const) {
    assert.equal(
      classifyDurableCtfRangeRecovery({
        operation,
        record,
        observation: {
          selection,
          inputStates: [{ Y: inputY(operation), state: 'UNSPENT', witness: null }],
          queriedOutputs: query.outputs,
          restoredOutputs: [],
          signatures: [],
          queryCompleted: true,
          now,
        },
        resolveKeyset,
      }).kind,
      expected,
    )
  }
  assert.equal(
    classifyDurableCtfRangeRecovery({
      operation,
      record,
      observation: {
        selection,
        inputStates: [{ Y: 'foreign-y', state: 'UNSPENT', witness: null }],
        queriedOutputs: query.outputs,
        restoredOutputs: [],
        signatures: [],
        queryCompleted: true,
        now: 100,
      },
      resolveKeyset,
    }).kind,
    'reconciling',
  )
})

test('mint-verified recovery stages the exact durable result without an engine envelope', async () => {
  const { operation, binding } = await sharedRangeBinding()
  const selection = createCtfSelectionBitmap(4, [1, 3])
  const query = buildDurableCtfRangeRecoveryQuery(operation, null)
  const observation = {
    selection: null,
    inputStates: [{ Y: inputY(operation), state: 'SPENT' as const, witness: null }],
    queriedOutputs: query.outputs,
    restoredOutputs: buildDurableCtfRangeRecoveryQuery(operation, selection).outputs,
    signatures: signaturesFor(operation, selection),
    queryCompleted: true,
    now: 50,
  }
  const prepared = prepareDurableCtfRangeRecoveredResult({
    record: binding.record,
    operation,
    observation,
    resolveKeyset,
  })
  assert.equal(prepared.kind, 'confirmed')
  if (prepared.kind !== 'confirmed') throw new Error('mint recovery fixture is not confirmed')
  assert.deepEqual(
    {
      schemaVersion: (prepared.exactResult.artifact as { schemaVersion: unknown }).schemaVersion,
      source: (prepared.exactResult.artifact as { source: unknown }).source,
    },
    { schemaVersion: 2, source: 'mint-recovery' },
  )

  const adapter = new FaultInjectingDurableCustodyAdapter(scopeState(binding.record.scope))
  adapter.run((transaction) =>
    bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
  )
  adapter.run((transaction) =>
    transaction.stageVerifiedResult({
      operationId: binding.record.operation.operationId,
      expectedRevision: binding.record.revision,
      authorization: { incarnationId: 'process-1', fencingEpoch: 1, observedAtMs: 20 },
      outputPlanFingerprint: binding.record.operation.outputPlan.outputPlanFingerprint,
      resultHandle: prepared.resultHandle,
      resultFingerprint: prepared.resultFingerprint,
      exactResult: prepared.exactResult,
      selectedSuccessorProofIds: prepared.selectedSuccessorProofIds,
    }),
  )
  const reopened = adapter.reopen()
  const staged = reopened.readOperation()!
  const artifact = reopened
    .readArtifacts()
    .find(({ reference }) => reference.artifactId.endsWith(':result'))!
  assert.equal(
    isDeepStrictEqual(
      recoverDurableCtfRangeVerifiedResultArtifact({
        record: staged,
        operation,
        exactResult: artifact.artifact,
        resolveKeyset,
      }),
      prepared.result,
    ),
    true,
    'mint-verified recovery artifact must reproduce the exact proof result',
  )
})

test('refund preserves offered class and residual reauthorization links exact change', async () => {
  const operation = fixture()
  const record = await recordFor(operation)
  const refundOutput = OutputData.createSingleDeterministicData('3', SEED, 80, OFFER_KEYSET)
  const refund = createDurableCtfRangeRefundOperation({
    operationId: 'refund-operation-1',
    source: operation,
    refundKeysetId: OFFER_KEYSET,
    resolveKeysetAsset: (id) => (id === OFFER_KEYSET ? operation.offerAsset : undefined),
    outputs: [OutputData.serialize(refundOutput)],
  })
  assert.equal(refund.operation.kind, 'ctf-range-refund')
  assert.equal(refund.request.inputs[0]?.witness !== undefined, true)
  assert.throws(
    () =>
      createDurableCtfRangeRefundOperation({
        operationId: 'refund-operation-2',
        source: operation,
        refundKeysetId: RECEIVE_KEYSET,
        resolveKeysetAsset: (id) => (id === RECEIVE_KEYSET ? operation.receiveAsset : undefined),
        outputs: [OutputData.serialize(refundOutput)],
      }),
    /offered asset class/,
  )

  const selection = createCtfSelectionBitmap(4, [1, 3])
  const result = recoverDurableCtfRangeResult(
    operation,
    createDurableCtfRangeResultEnvelope({
      operation,
      requestDigest: 'ef'.repeat(32),
      selection,
      signatures: signaturesFor(operation, selection),
    }),
    recoveryFor(operation, selection),
    record,
    resolveKeyset,
  )
  const residual = deriveDurableCtfResidualDecision({
    source: operation,
    result,
    originalOrderAmount: 4,
    remainingOrderAmount: 2,
    restingOrder: true,
  })
  assert.equal(residual.kind, 'awaiting-authorization')
  assert.equal(
    residual.kind === 'awaiting-authorization' ? residual.predecessorOperationId : '',
    operation.operationId,
  )
  assert.equal(
    residual.kind === 'awaiting-authorization'
      ? residual.sourceProofs.every((proof) => Amount.from(proof.amount).toBigInt() > 0n)
      : false,
    true,
  )
  assert.throws(
    () =>
      deriveDurableCtfResidualDecision({
        source: operation,
        result: { ...result, operationId: 'foreign-operation' },
        originalOrderAmount: 4,
        remainingOrderAmount: 2,
        restingOrder: true,
      }),
    /result is foreign/,
  )
  assert.throws(
    () =>
      deriveDurableCtfResidualDecision({
        source: operation,
        result,
        originalOrderAmount: 4,
        remainingOrderAmount: 3,
        restingOrder: true,
      }),
    /remaining amount differs/,
  )
})

test('refund operation identity is deterministic and range-bound', () => {
  const first = deriveDurableCtfRangeRefundOperationId('range-operation-1')
  assert.equal(first, deriveDurableCtfRangeRefundOperationId('range-operation-1'))
  assert.notEqual(first, deriveDurableCtfRangeRefundOperationId('range-operation-2'))
  assert.match(first, /^ctf-range-refund:[0-9a-f]{64}$/)
})

test('refund outputs reconstruct exactly from seed after local origin loss', () => {
  const operation = fixture()
  const refundOperationId = deriveDurableCtfRangeRefundOperationId(operation.operationId)
  const derive = (seed: Uint8Array) =>
    createDeterministicDurableCtfRangeRefundOutputs({
      seed,
      source: operation,
      refundOperationId,
      amount: '3',
      keyset: { id: OFFER_KEYSET, keys: KEYS },
    })
  const first = derive(SEED)
  const reconstructed = derive(new Uint8Array(SEED))
  assert.deepEqual(reconstructed, first)
  assert.notDeepEqual(derive(new Uint8Array(64).fill(8)), first)

  const prepared = createDurableCtfRangeRefundOperation({
    operationId: refundOperationId,
    source: operation,
    refundKeysetId: OFFER_KEYSET,
    resolveKeysetAsset: (id) => (id === OFFER_KEYSET ? operation.offerAsset : undefined),
    outputs: reconstructed,
  })
  const fingerprint = deriveDurableCtfRangeRefundRequestFingerprint(prepared.request)
  const mutated = {
    inputs: prepared.request.inputs.map((proof, index) =>
      index === 0 ? { ...proof, witness: { signatures: ['00'.repeat(64)] } } : proof,
    ),
    outputs: [...prepared.request.outputs],
  }
  assert.notEqual(deriveDurableCtfRangeRefundRequestFingerprint(mutated), fingerprint)
})

test('range response admission is bounded before JSON parsing or cryptography', () => {
  assert.throws(
    () =>
      decodeDurableCtfRangeResultEnvelopeBytes(
        new Uint8Array(DURABLE_CTF_RANGE_RESULT_BYTES_MAX + 1),
      ),
    /byte limit/,
  )
  assert.throws(
    () =>
      createDurableCtfRangeResultEnvelope({
        operation: fixture(),
        requestDigest: 'ef'.repeat(32),
        selection: 'aa'.repeat(33),
        signatures: [],
      }),
    /selection/,
  )
})

test('large bounded manifests remain logarithmic and exactly recoverable after restart', () => {
  const keys = Object.fromEntries(
    Array.from({ length: 64 }, (_, exponent) => [
      (1n << BigInt(exponent)).toString(),
      MINT_PUBLIC_KEY,
    ]),
  )
  const manifest = createCtfRangeManifest({
    seed: SEED,
    operationId: 'large-range',
    receiveKeyset: { id: RECEIVE_KEYSET, active: true, keys },
    offerKeyset: { id: OFFER_KEYSET, active: true, keys },
    maxReceive: '18446744073709551615',
    maxChange: '18446744073709551615',
    maxEntries: 128,
  })
  assert.equal(manifest.entries.length, 128)
  const persisted = structuredClone(
    manifest.entries.map(({ outputData }) => OutputData.serialize(outputData)),
  )
  assert.deepEqual(
    persisted.map((output) => OutputData.deserialize(output).blindedMessage.B_),
    manifest.entries.map(({ entry }) => entry.B_),
  )
  assert.equal(Amount.from(manifest.entries[63]!.entry.amount).toString(), '9223372036854775808')
})

test('direct preparation link and selected result commit atomically across restart faults', async () => {
  const operation = fixture()
  const custody = toDurableCtfRangeProofOperationInput(operation)
  const facts = await factsFor(operation)
  const scope = walletScope()
  const binding = createDurableCtfRangeCustodyBinding({
    scope,
    operation,
    facts,
    mintKeysets: mintKeysetsFor(operation),
    inventoryAccountId: null,
    boundary: {
      method: 'POST',
      path: '/v1/range-authorizations',
      idempotencyKey: operation.authorizationId,
      requestBody: { authorizationId: operation.authorizationId },
    },
  })
  const adapter = new FaultInjectingDurableCustodyAdapter(scopeState(scope))
  assert.throws(
    () =>
      adapter.run(
        (transaction) =>
          bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
        'put-artifact',
      ),
    /injected fault/,
  )
  assert.equal(adapter.readOperation(), null)
  assert.equal(adapter.readArtifacts().length, 0)

  adapter.run((transaction) =>
    bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
  )
  const restarted = adapter.reopen()
  const privateArtifact = restarted
    .readArtifacts()
    .find(({ reference }) => reference.artifactId.endsWith(':private'))
  const restartedOperation = decodeDurableCtfRangeOperation(privateArtifact?.artifact.artifact)
  assert.equal(restartedOperation.sourceOperationId, operation.sourceOperationId)
  assert.equal(restartedOperation.coordinatorPublicKey, COORDINATOR_PUBLIC_KEY)

  const selection = createCtfSelectionBitmap(4, [1, 3])
  const envelope = createDurableCtfRangeResultEnvelope({
    operation,
    requestDigest: 'ef'.repeat(32),
    selection,
    signatures: signaturesFor(operation, selection),
  })
  const authorization = { incarnationId: 'process-1', fencingEpoch: 1, observedAtMs: 20 }
  const foreignOperation = { ...operation, authorizationId: 'foreign-authorization' }
  assert.throws(
    () =>
      restarted.run((transaction) =>
        stageDurableCtfRangeVerifiedResult({
          transaction,
          record: restarted.readOperation()!,
          operation: foreignOperation,
          envelope: createDurableCtfRangeResultEnvelope({
            operation: foreignOperation,
            requestDigest: 'ef'.repeat(32),
            selection,
            signatures: signaturesFor(foreignOperation, selection),
          }),
          allManifestRecovery: recoveryFor(foreignOperation, selection),
          authorization,
          resolveKeyset,
        }),
      ),
    /custody record is foreign/,
  )
  const truncatedSelection = createCtfSelectionBitmap(4, [1])
  const truncatedDecision = restarted.run((transaction) =>
    stageDurableCtfRangeVerifiedResult({
      transaction,
      record: restarted.readOperation()!,
      operation,
      envelope: createDurableCtfRangeResultEnvelope({
        operation,
        requestDigest: 'ef'.repeat(32),
        selection: truncatedSelection,
        signatures: signaturesFor(operation, truncatedSelection),
      }),
      allManifestRecovery: recoveryFor(operation, selection),
      authorization,
      resolveKeyset,
    }),
  )
  assert.equal(truncatedDecision.kind, 'reconciling')
  assert.equal(restarted.readOperation()?.operation.result.state, 'none')
  assert.throws(
    () =>
      restarted.run(
        (transaction) =>
          stageDurableCtfRangeVerifiedResult({
            transaction,
            record: restarted.readOperation()!,
            operation,
            envelope,
            allManifestRecovery: recoveryFor(operation, selection),
            authorization,
            resolveKeyset,
          }),
        'stage-result',
      ),
    /injected fault/,
  )
  assert.equal(restarted.readOperation()?.operation.result.state, 'none')

  const prepared = prepareDurableCtfRangeVerifiedResult({
    record: restarted.readOperation()!,
    operation,
    envelope,
    allManifestRecovery: recoveryFor(operation, selection),
    resolveKeyset,
  })
  assert.equal(prepared.kind, 'confirmed')
  assert.equal(restarted.readOperation()?.operation.result.state, 'none')
  assert.equal(
    restarted.readArtifacts().some(({ reference }) => reference.artifactId.endsWith(':result')),
    false,
  )

  restarted.run((transaction) =>
    stageDurableCtfRangeVerifiedResult({
      transaction,
      record: restarted.readOperation()!,
      operation,
      envelope,
      allManifestRecovery: recoveryFor(operation, selection),
      authorization,
      resolveKeyset,
    }),
  )
  const recovered = restarted.reopen()
  assert.equal(recovered.readOperation()?.operation.result.state, 'verified-staged')
  assert.equal(
    recovered.readArtifacts().some(({ reference }) => reference.artifactId.endsWith(':result')),
    true,
  )
  const staged = recovered.readOperation()!
  const stagedArtifact = recovered
    .readArtifacts()
    .find(({ reference }) => reference.artifactId.endsWith(':result'))!
  assert.equal(
    isDeepStrictEqual(
      recoverDurableCtfRangeVerifiedResultArtifact({
        record: staged,
        operation,
        exactResult: stagedArtifact.artifact,
        resolveKeyset,
      }),
      recoverDurableCtfRangeResult(
        operation,
        envelope,
        recoveryFor(operation, selection),
        staged,
        resolveKeyset,
      ),
    ),
    true,
    'staged range recovery must equal the expected proof result',
  )
  const selected = staged.operation.proofStorage.lineage.selectedSuccessorProofIds!
  assert.equal(selected.length, 2)
  assert.equal(staged.operation.proofStorage.lineage.successorProofIds.length, 4)
  const admission = {
    scopeId: scope.scopeId,
    operationId: staged.operation.operationId,
    admissionId: 'range-admission-1',
    proofRows: selected.map((proofId) => ({
      proofId,
      expectedRevision: null,
      admittedRevision: 0,
    })),
  }
  const apply = (transaction: DurableCustodyTransaction) =>
    transaction.applyVerifiedResult({
      operationId: staged.operation.operationId,
      expectedRevision: staged.revision,
      authorization: { ...authorization, observedAtMs: 21 },
      outputPlanFingerprint: staged.operation.outputPlan.outputPlanFingerprint,
      resultHandle: staged.operation.result.resultHandle!,
      resultFingerprint: staged.operation.result.resultFingerprint!,
      successorAdmission: admission,
    })
  assert.throws(() => recovered.run(apply, 'apply-result'), /injected fault/)
  assert.equal(recovered.readOperation()?.operation.result.state, 'verified-staged')
  recovered.run(apply)
  assert.equal(recovered.readOperation()?.operation.state, 'reconciled')
  assert.equal(
    isDeepStrictEqual(
      recoverDurableCtfRangeVerifiedResultArtifact({
        record: recovered.readOperation()!,
        operation,
        exactResult: stagedArtifact.artifact,
        resolveKeyset,
      }),
      recoverDurableCtfRangeResult(
        operation,
        envelope,
        recoveryFor(operation, selection),
        recovered.readOperation()!,
        resolveKeyset,
      ),
    ),
    true,
    'applied range recovery must equal the expected proof result',
  )
  assert.deepEqual(
    recovered.readOperation()?.operation.proofStorage.lineage.successorAdmission?.proofRows,
    admission.proofRows,
  )
})

function walletScope(): DurableCustodyScope {
  const input = { scopeKind: 'wallet' as const, walletId: 'a'.repeat(64) }
  return { ...input, scopeId: deriveDurableCustodyScopeId(input) }
}

function conditionInventoryScope(conditionId: string): DurableCustodyScope {
  const input = {
    scopeKind: 'condition-inventory' as const,
    conditionId,
    inventoryAccountId: 'inventory-1',
    normalizedMint: 'https://mint.example',
    unit: 'msat',
  }
  return { ...input, scopeId: deriveDurableCustodyScopeId(input) }
}

function scopeState(scope: DurableCustodyScope): DurableCustodyScopeState {
  return {
    schemaVersion: 1,
    scope,
    fencingEpoch: 1,
    owner: { incarnationId: 'process-1', leaseExpiresAtMs: 1_000 },
    effectiveClock: { highWaterMarkMs: 10 },
  }
}
