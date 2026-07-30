import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import {
  createBlindSignature,
  createCtfAuthorizationOutputs,
  createCtfRangeManifest,
  createCtfSelectionBitmap,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveCtfRangeRefundKey,
  deriveKeysetId,
  hashToCurve,
  hashToCurveBls,
  pointFromHex,
  type CheckStatePayload,
  type CheckStateResponse,
  type GetKeysResponse,
  type PostRestorePayload,
  type PostRestoreResponse,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from '@cashu/cashu-ts'
import {
  buildDurableCtfRangeRecoveryQuery,
  createDurableCtfRangeCustodyBinding,
  createDurableCtfRangeOperation,
  deriveRootCtfOutcomeCollectionId,
  toDurableCtfRangeProofOperationInput,
  type DurableCtfRangeMintKeyset,
  type DurableCtfRangeOperation,
} from '../src/durableCtfRangeOperation.ts'
import {
  resolveDurableCustodyProofOperationFacts,
  type DurableCustodyScope,
} from '../src/durableCustodyProofOperation.ts'
import type { SettlementCapabilityResultResponse } from '../src/engineClient.ts'
import {
  CTF_RANGE_MINT_RESTORE_RESPONSE_BYTES_MAX,
  CtfRangeMintRecoveryAdapter,
  checkCtfRangeInputProofStates,
  decodeCtfRangeEngineResult,
  fetchCtfRangeEngineResultByOperation,
  type CtfRangeMintClient,
} from '../src/ctfRangeRecoveryTransport.ts'

const CONDITION_ID = 'ab'.repeat(32)
const ROOT_PARENT = '0'.repeat(64)
const OUTCOME_COLLECTION = 'YES'
const INPUT_FEE_PPK = 100
const FINAL_EXPIRY = 200
const COORDINATOR_PUBLIC_KEY = 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9'
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = `02${'79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'}`
const MINT_KEYS = { '1': MINT_PUBLIC_KEY, '2': MINT_PUBLIC_KEY, '4': MINT_PUBLIC_KEY }
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
})
const OFFER_KEYSET_ID = deriveKeysetId(MINT_KEYS, {
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
})
const RECEIVE_KEYSET_ID = deriveConditionalKeysetId({
  keys: MINT_KEYS,
  unit: 'msat',
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
})

test('engine result-by-operation decodes bounded canonical base64 and verifies its digest', async () => {
  const operation = createRangeOperation()
  const operationId = operation.operationId
  const requestDigest = 'ef'.repeat(32)
  const envelopeBytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      operationId,
      authorizationId: 'range-authorization-1',
      requestDigest,
      selection: '01',
      signatures: [],
    }),
  )
  const response = engineResult(operationId, requestDigest, envelopeBytes)
  const authority = { operation, reference: response.reference }
  const calls: string[] = []
  const decoded = await fetchCtfRangeEngineResultByOperation(
    {
      async getSettlementCapabilityResultByOperation(requestedOperationId) {
        calls.push(requestedOperationId)
        return response
      },
    },
    authority,
  )

  assert.deepEqual(calls, [operationId])
  assert.equal(decoded?.envelope.operationId, operationId)
  assert.deepEqual(decoded?.envelopeBytes === undefined ? undefined : [...decoded.envelopeBytes], [
    ...envelopeBytes,
  ])
  assert.equal(decoded?.resultId, response.resultId)
  assert.equal(decoded?.version, response.version)
})

test('engine result decoder rejects noncanonical base64, digest mismatch, and oversized input', () => {
  const operation = createRangeOperation()
  const operationId = operation.operationId
  const requestDigest = 'ef'.repeat(32)
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      operationId,
      authorizationId: 'range-authorization-1',
      requestDigest,
      selection: '01',
      signatures: [],
    }),
  )
  const valid = engineResult(operationId, requestDigest, bytes)
  const padded = engineResult(
    operationId,
    requestDigest,
    Uint8Array.from([...bytes, ...new Uint8Array(bytes.length % 3 === 0 ? 1 : 0).fill(32)]),
  )
  const authority = { operation, reference: valid.reference }

  for (const response of [
    { ...valid, envelope: `${valid.envelope}\n` },
    { ...padded, envelope: makeBase64TailNoncanonical(padded.envelope) },
    { ...valid, envelopeDigest: '00'.repeat(32) },
    { ...valid, envelope: 'A'.repeat(349_529) },
  ]) {
    assert.throws(
      () => decodeCtfRangeEngineResult(response, authority),
      /CTF range engine result is invalid/,
    )
  }
})

function makeBase64TailNoncanonical(value: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const offset = value.endsWith('==') ? -3 : value.endsWith('=') ? -2 : null
  if (offset === null) throw new Error('test envelope must have base64 padding')
  const index = value.length + offset
  const replacement = alphabet[alphabet.indexOf(value[index]!) + 1]
  if (replacement === undefined) throw new Error('test envelope tail cannot be mutated')
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`
}

test('engine result decoder binds persisted capability, authorization, and retry digest', () => {
  const operation = createRangeOperation()
  const requestDigest = 'ef'.repeat(32)
  const response = engineResult(
    operation.operationId,
    requestDigest,
    new TextEncoder().encode(
      JSON.stringify({
        schemaVersion: 1,
        operationId: operation.operationId,
        authorizationId: operation.authorizationId,
        requestDigest,
        selection: '01',
        signatures: [],
      }),
    ),
  )
  const authority = { operation, reference: response.reference }
  assert.equal(decodeCtfRangeEngineResult(response, authority).requestDigest, requestDigest)

  for (const invalidAuthority of [
    {
      ...authority,
      reference: { ...authority.reference, bindingDigest: 'cd'.repeat(32) },
    },
    { ...authority, previouslyPersistedRequestDigest: 'aa'.repeat(32) },
  ]) {
    assert.throws(
      () => decodeCtfRangeEngineResult(response, invalidAuthority),
      /CTF range engine result is invalid/,
    )
  }
  assert.throws(
    () =>
      decodeCtfRangeEngineResult(
        {
          ...response,
          reference: { ...response.reference, artifactId: 'noncanonical-artifact' },
        },
        authority,
      ),
    /CTF range engine result is invalid/,
  )

  const foreignAuthorization = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      operationId: operation.operationId,
      authorizationId: 'foreign-authorization',
      requestDigest,
      selection: '01',
      signatures: [],
    }),
  )
  assert.throws(
    () =>
      decodeCtfRangeEngineResult(
        engineResult(operation.operationId, requestDigest, foreignAuthorization),
        authority,
      ),
    /CTF range engine result is invalid/,
  )
})

test('uncertain recovery queries the exact full manifest and delegates classification to the SDK', async () => {
  const operation = createRangeOperation()
  const binding = await createRangeBinding(operation)
  const selection = createCtfSelectionBitmap(operation.manifest.entries.length, [1, 3])
  const selected = buildDurableCtfRangeRecoveryQuery(operation, null).outputs.filter(
    (_, index) => index === 1 || index === 3,
  )
  const restoreCalls: PostRestorePayload[] = []
  const checkCalls: CheckStatePayload[] = []
  const keyCalls: string[] = []
  const mint: CtfRangeMintClient = {
    async restore(payload) {
      restoreCalls.push(payload)
      return {
        outputs: selected,
        signatures: selected.map(signBlindedOutput),
      }
    },
    async check(payload) {
      checkCalls.push(payload)
      return {
        states: payload.Ys.map((Y) => ({ Y, state: 'UNSPENT', witness: null })),
      }
    },
    async getKeys(keysetId) {
      keyCalls.push(keysetId ?? '')
      return { keysets: [mintKeyset(operation, keysetId ?? '')] }
    },
  }
  const adapter = new CtfRangeMintRecoveryAdapter(operation, mint)
  const decision = await adapter.classifyUncertainRecovery({
    record: binding.record,
    selection,
    now: 50,
  })

  assert.equal(decision.kind, 'confirmed')
  assert.deepEqual(
    restoreCalls[0]?.outputs.map(({ id, amount, B_ }) => ({
      id,
      amount: amount.toString(),
      B_,
    })),
    operation.manifest.entries.map(({ outputData: { blindedMessage } }) => ({
      id: blindedMessage.id,
      amount: blindedMessage.amount.toString(),
      B_: blindedMessage.B_,
    })),
  )
  assert.deepEqual(
    checkCalls[0]?.Ys,
    operation.inputs.map(({ secret }) => hashToCurve(new TextEncoder().encode(secret)).toHex(true)),
  )
  assert.deepEqual(new Set(keyCalls), new Set([OFFER_KEYSET_ID, RECEIVE_KEYSET_ID]))
})

test('mint recovery rejects foreign restore rows and keysets without exposing proof secrets', async () => {
  const operation = createRangeOperation()
  const binding = await createRangeBinding(operation)
  const secret = operation.inputs[0]!.secret
  const foreignRestore: CtfRangeMintClient = {
    async restore(payload): Promise<PostRestoreResponse> {
      return {
        outputs: [{ ...payload.outputs[0]!, B_: MINT_PUBLIC_KEY }],
        signatures: [signBlindedOutput(payload.outputs[0]!)],
      }
    },
    check: unspentStates,
    async getKeys(keysetId): Promise<GetKeysResponse> {
      return { keysets: [mintKeyset(operation, keysetId ?? '')] }
    },
  }
  const leakingCheck: CtfRangeMintClient = {
    async restore(): Promise<PostRestoreResponse> {
      return { outputs: [], signatures: [] }
    },
    async check(): Promise<CheckStateResponse> {
      throw new Error(`remote failure leaked ${secret}`)
    },
    async getKeys(keysetId): Promise<GetKeysResponse> {
      return { keysets: [mintKeyset(operation, keysetId ?? '')] }
    },
  }
  const foreignKeyset: CtfRangeMintClient = {
    async restore(): Promise<PostRestoreResponse> {
      return { outputs: [], signatures: [] }
    },
    check: unspentStates,
    async getKeys(keysetId): Promise<GetKeysResponse> {
      return {
        keysets: [{ ...mintKeyset(operation, keysetId ?? ''), unit: 'sat' }],
      }
    },
  }

  for (const mint of [foreignRestore, leakingCheck, foreignKeyset]) {
    const adapter = new CtfRangeMintRecoveryAdapter(operation, mint)
    await assert.rejects(
      () =>
        adapter.classifyUncertainRecovery({
          record: binding.record,
          selection: null,
          now: 50,
        }),
      (error: unknown) =>
        error instanceof Error &&
        /CTF range mint recovery failed/.test(error.message) &&
        !error.message.includes(secret),
    )
  }
})

test('exact NUT-07 rejects missing and duplicate states and batches through the durable cap', async () => {
  const inputs = Array.from({ length: 101 }, (_, index) => ({
    id: OFFER_KEYSET_ID,
    secret: `input-${index}`,
  }))
  const batchSizes: number[] = []
  const states = await checkCtfRangeInputProofStates(
    {
      async check(payload) {
        batchSizes.push(payload.Ys.length)
        return unspentStates(payload)
      },
    },
    inputs,
  )
  assert.equal(states.length, inputs.length)
  assert.deepEqual(batchSizes, [100, 1])

  const blsId = `02${'12'.repeat(32)}`
  let blsY = ''
  await checkCtfRangeInputProofStates(
    {
      async check(payload) {
        blsY = payload.Ys[0]!
        return unspentStates(payload)
      },
    },
    [{ id: blsId, secret: 'bls-secret' }],
  )
  assert.equal(blsY, hashToCurveBls(new TextEncoder().encode('bls-secret')).toHex(true))

  await assert.rejects(
    () =>
      checkCtfRangeInputProofStates(
        {
          async check() {
            return { states: [] }
          },
        },
        [{ id: OFFER_KEYSET_ID, secret: 'missing-input' }],
      ),
    /CTF range proof-state response is invalid/,
  )
  await assert.rejects(
    () =>
      checkCtfRangeInputProofStates(
        {
          async check(payload) {
            return {
              states: [
                { Y: payload.Ys[0]!, state: 'UNSPENT', witness: null },
                { Y: payload.Ys[0]!, state: 'UNSPENT', witness: null },
              ],
            }
          },
        },
        [
          { id: OFFER_KEYSET_ID, secret: 'duplicate-input-1' },
          { id: OFFER_KEYSET_ID, secret: 'duplicate-input-2' },
        ],
      ),
    /CTF range proof-state response is invalid/,
  )

  let overCapCalls = 0
  await assert.rejects(
    () =>
      checkCtfRangeInputProofStates(
        {
          async check(payload) {
            overCapCalls += 1
            return unspentStates(payload)
          },
        },
        Array.from({ length: 257 }, (_, index) => ({
          id: OFFER_KEYSET_ID,
          secret: `over-cap-${index}`,
        })),
      ),
    /CTF range proof-state response is invalid/,
  )
  assert.equal(overCapCalls, 0)
})

test('invalid restored signature remains reconciling instead of becoming terminal', async () => {
  const operation = createRangeOperation()
  const binding = await createRangeBinding(operation)
  const selection = createCtfSelectionBitmap(operation.manifest.entries.length, [1])
  const selected = buildDurableCtfRangeRecoveryQuery(operation, null).outputs[1]!
  const mint: CtfRangeMintClient = {
    async restore() {
      return {
        outputs: [selected],
        signatures: [{ ...signBlindedOutput(selected), C_: '00'.repeat(33) }],
      }
    },
    check: unspentStates,
    async getKeys(keysetId) {
      return { keysets: [mintKeyset(operation, keysetId ?? '')] }
    },
  }

  const decision = await new CtfRangeMintRecoveryAdapter(operation, mint).classifyUncertainRecovery(
    {
      record: binding.record,
      selection,
      now: 50,
    },
  )
  assert.equal(decision.kind, 'reconciling')
})

test('default Cashu recovery cancels oversized restore responses with safe fetch options', async () => {
  const operation = createRangeOperation()
  const binding = await createRangeBinding(operation)
  let restoreCancelled = false
  const requests: Array<{ redirect: RequestRedirect | undefined; hasSignal: boolean }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push({
      redirect: init?.redirect,
      hasSignal: init?.signal instanceof AbortSignal,
    })
    if (url.endsWith('/v1/restore')) {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(CTF_RANGE_MINT_RESTORE_RESPONSE_BYTES_MAX))
            controller.enqueue(Uint8Array.of(1))
          },
          cancel() {
            restoreCancelled = true
          },
        }),
      )
    }
    if (url.endsWith('/v1/checkstate')) {
      const body = JSON.parse(String(init?.body)) as CheckStatePayload
      return Response.json(await unspentStates(body))
    }
    const keysetId = decodeURIComponent(url.slice(url.lastIndexOf('/') + 1))
    return Response.json({ keysets: [mintKeyset(operation, keysetId)] })
  }
  const adapter = new CtfRangeMintRecoveryAdapter(operation, undefined, fetchImpl)

  await assert.rejects(
    () =>
      adapter.classifyUncertainRecovery({
        record: binding.record,
        selection: null,
        now: 50,
      }),
    /CTF range mint recovery failed/,
  )
  assert.equal(restoreCancelled, true)
  assert.equal(
    requests.every(({ redirect }) => redirect === 'error'),
    true,
  )
  assert.equal(
    requests.every(({ hasSignal }) => hasSignal),
    true,
  )
})

function engineResult(
  operationId: string,
  requestDigest: string,
  envelopeBytes: Uint8Array,
): SettlementCapabilityResultResponse {
  return {
    resultId: '33333333-3333-4333-8333-333333333333',
    reference: {
      artifactId: '11111111-1111-4111-8111-111111111111',
      bindingDigest: 'ab'.repeat(32),
    },
    operationId,
    requestDigest,
    envelopeDigest: createHash('sha256').update(envelopeBytes).digest('hex'),
    envelope: Buffer.from(envelopeBytes).toString('base64'),
    createdAt: '2026-07-30T00:00:00.000Z',
    acknowledgedAt: null,
    version: 2,
    settlementGroup: {
      groupId: '44444444-4444-4444-8444-444444444444',
      revision: 1,
      status: 'Confirmed',
      coalescingDeadline: '2026-07-30T00:00:00.000Z',
      frozenAt: '2026-07-30T00:00:00.000Z',
    },
  }
}

function createRangeOperation(): DurableCtfRangeOperation {
  const seed = new Uint8Array(64).fill(7)
  const operationId = 'range-operation-1'
  const manifest = createCtfRangeManifest({
    seed,
    operationId,
    receiveKeyset: { id: RECEIVE_KEYSET_ID, active: true, keys: MINT_KEYS },
    offerKeyset: { id: OFFER_KEYSET_ID, active: true, keys: MINT_KEYS },
    maxReceive: '3',
    maxChange: '3',
    maxEntries: 4,
  })
  const refundKey = deriveCtfRangeRefundKey(seed, operationId)
  const inputs = createCtfAuthorizationOutputs({
    seed,
    operationId,
    offerKeysetId: OFFER_KEYSET_ID,
    amounts: ['2', '2'],
    commitment: manifest.commitment,
    expiry: 100,
    expiryContext: expiryContext(),
    refund: refundKey.publicKey,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    poolPolicy: { rateN: '1', rateD: '1', minReceive: '1', maxDebit: '4' },
  }).map((output) =>
    output.toProof(
      signBlindedOutput(output.blindedMessage),
      mintKeysetById(output.blindedMessage.id),
    ),
  )
  return createDurableCtfRangeOperation({
    operationId,
    sourceOperationId: 'range-prepare-1',
    authorizationId: 'range-authorization-1',
    mintUrl: 'https://mint.example',
    unit: 'msat',
    conditionId: CONDITION_ID,
    parentCollectionId: ROOT_PARENT,
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    offerKeysetId: OFFER_KEYSET_ID,
    receiveKeysetId: RECEIVE_KEYSET_ID,
    keysetLookup: keysetLookup(),
    expiryObservation: expiryObservation(),
    expiry: 100,
    policy: { rateN: '1', rateD: '1', minReceive: '1', maxDebit: '4' },
    refundKey,
    inputFeePpkByKeyset: { [OFFER_KEYSET_ID]: INPUT_FEE_PPK },
    inputs,
    manifest,
  })
}

async function createRangeBinding(operation: DurableCtfRangeOperation) {
  const keysets = mintKeysets(operation)
  const facts = await resolveDurableCustodyProofOperationFacts({
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
    requireDleq: true,
  })
  return createDurableCtfRangeCustodyBinding({
    scope: walletScope(),
    operation,
    facts,
    mintKeysets: keysets,
    inventoryAccountId: null,
    boundary: {
      method: 'POST',
      path: '/v1/range-authorizations',
      idempotencyKey: operation.authorizationId,
      requestBody: { authorizationId: operation.authorizationId },
    },
  })
}

function signBlindedOutput(output: SerializedBlindedMessage): SerializedBlindedSignature {
  const signature = createBlindSignature(pointFromHex(output.B_), MINT_PRIVATE_KEY, output.id)
  const dleq = createDLEQProof(pointFromHex(output.B_), MINT_PRIVATE_KEY)
  return {
    id: output.id,
    amount: output.amount,
    C_: signature.C_.toHex(true),
    dleq: {
      e: Buffer.from(dleq.e).toString('hex'),
      s: Buffer.from(dleq.s).toString('hex'),
    },
  }
}

async function unspentStates(payload: CheckStatePayload): Promise<CheckStateResponse> {
  return {
    states: payload.Ys.map((Y) => ({ Y, state: 'UNSPENT', witness: null })),
  }
}

function walletScope(): DurableCustodyScope {
  const walletId = '12'.repeat(32)
  return {
    scopeKind: 'wallet',
    walletId,
    scopeId: `custody:wallet:${walletId}`,
  }
}

function expiryContext() {
  return {
    now: 10,
    maxExpirySeconds: 100,
    condition: { condition_id: CONDITION_ID, keysets: { YES: RECEIVE_KEYSET_ID } },
    conditionalKeysets: [
      { id: RECEIVE_KEYSET_ID, condition_id: CONDITION_ID, final_expiry: FINAL_EXPIRY },
    ],
  }
}

function expiryObservation() {
  return {
    canonicalMintUrl: 'https://mint.example',
    freshness: 'fresh' as const,
    observedAt: 10,
    maxExpirySeconds: 100,
    conditionKeysetIds: [RECEIVE_KEYSET_ID],
    conditionalKeysets: [
      {
        keysetId: RECEIVE_KEYSET_ID,
        conditionId: CONDITION_ID,
        unit: 'msat',
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
        keys: MINT_KEYS,
      },
    ],
  }
}

function keysetLookup() {
  return {
    canonicalMintUrl: 'https://mint.example',
    freshness: 'fresh' as const,
    regularKeysets: [
      {
        keysetId: OFFER_KEYSET_ID,
        unit: 'msat',
        active: true,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
    conditionalKeysets: [
      {
        keysetId: RECEIVE_KEYSET_ID,
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

function mintKeysets(operation: DurableCtfRangeOperation) {
  return new Map<string, DurableCtfRangeMintKeyset>(
    [operation.keysetAuthority.offer, operation.keysetAuthority.receive].map((authority) => [
      authority.keysetId,
      {
        canonicalMintUrl: operation.mintUrl,
        id: authority.keysetId,
        unit: authority.unit,
        keys: MINT_KEYS,
        inputFeePpk: authority.inputFeePpk,
        finalExpiry: authority.finalExpiry,
      },
    ]),
  )
}

function mintKeyset(operation: DurableCtfRangeOperation, keysetId: string) {
  const keyset = mintKeysets(operation).get(keysetId)
  if (!keyset) throw new Error('test requested an unknown keyset')
  return {
    id: keyset.id,
    unit: keyset.unit,
    keys: keyset.keys,
    input_fee_ppk: keyset.inputFeePpk,
    final_expiry: keyset.finalExpiry ?? undefined,
  }
}

function mintKeysetById(keysetId: string) {
  return {
    id: keysetId,
    unit: 'msat',
    keys: MINT_KEYS,
    input_fee_ppk: INPUT_FEE_PPK,
    final_expiry: FINAL_EXPIRY,
  }
}
