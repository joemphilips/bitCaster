import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  durableCustodyProofOperationSemanticKind,
  resolveDurableCustodyProofOperationFacts,
} from '../src/durableCustodyProofOperation.ts'
import {
  createDurableCustodyProofOperation,
  deriveDurableCustodyProofResultFingerprint,
} from '../src/durableCustodyProofOperationRecord.ts'
import {
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeState,
  decideDurableCustodyRecovery,
  deriveDurableCustodyScopeId,
  type DurableCustodyRecord,
  type DurableCustodyRecoveryClassification,
  type DurableCustodyScope,
} from '../src/durableCustody.ts'
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  createDurableTradeProofOperationLink,
  type DurableTradeSession,
} from '../src/durableTradeRecovery.ts'

const KEYSET_ID = `00${'22'.repeat(7)}`
const PUBLIC_KEY = `02${'33'.repeat(32)}`

const resolveMintKeys = async () => new Map([[KEYSET_ID, {
  id: KEYSET_ID,
  unit: 'sat',
  keys: { '1': PUBLIC_KEY },
}]])

test('shared proof operation facts bind wallet semantics and exact mint keys', async () => {
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: operation('regular-split'),
    session: null,
    resolveMintKeys,
    requireDleq: false,
  })

  assert.equal(durableCustodyProofOperationSemanticKind('regular-split'), 'generic-send')
  assert.deepEqual(facts.binding, {
    kind: 'wallet',
    activityId: 'operation-001',
    stage: 'send',
  })
  assert.deepEqual(facts.horizon, {
    notBeforeMs: null,
    notAfterMs: null,
    safetyMarginMs: 0,
    keysetExpiryMs: null,
  })
  assert.equal(facts.verification.keysetBindings[0]?.keysetId, KEYSET_ID)
})

test('wallet mint facts require output authority without inventing proof inputs', async () => {
  const mint = operation('wallet-mint')
  const operationWithoutInputs = { ...mint, inputs: [] }
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: operationWithoutInputs,
    session: null,
    resolveMintKeys,
    requireDleq: false,
  })

  assert.deepEqual(facts.verification.inputKeysets, [])
  assert.deepEqual(facts.verification.outputKeysets, [
    { keysetId: KEYSET_ID, curve: 'secp256k1' },
  ])
  const record = createDurableCustodyProofOperation({
    scope: walletScope(),
    operation: operationWithoutInputs,
    facts,
    inventoryAccountId: null,
  })
  assert.deepEqual(record.operation.reservation.inputs, [])
  assert.deepEqual(record.operation.exactRequest.inputProofIds, [])
})

test('only wallet mint may resolve without input proof authority', async () => {
  await assert.rejects(
    resolveDurableCustodyProofOperationFacts({
      operation: { ...operation('wallet-receive'), inputs: [] },
      session: null,
      resolveMintKeys,
      requireDleq: false,
    }),
    /input keysets do not match/,
  )
  await assert.rejects(
    resolveDurableCustodyProofOperationFacts({
      operation: { ...operation('wallet-send'), inputs: [] },
      session: null,
      resolveMintKeys,
      requireDleq: false,
    }),
    /input keysets do not match/,
  )
  await assert.rejects(
    resolveDurableCustodyProofOperationFacts({
      operation: { ...operation('regular-split'), inputs: [] },
      session: null,
      resolveMintKeys,
      requireDleq: false,
    }),
    /input keysets do not match/,
  )

  const session = tradeSession()
  const link = createDurableTradeProofOperationLink({
    tradeId: session.tradeId,
    role: session.role,
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'operation-001',
  })
  await assert.rejects(
    resolveDurableCustodyProofOperationFacts({
      operation: {
        ...operation('swap-lock'),
        inputs: [],
        durableTradeRecovery: link,
      },
      session,
      resolveMintKeys,
      requireDleq: true,
    }),
    /input keysets do not match/,
  )
})

test('wallet mint rejects input proofs and missing output authority', async () => {
  await assert.rejects(
    resolveDurableCustodyProofOperationFacts({
      operation: operation('wallet-mint'),
      session: null,
      resolveMintKeys,
      requireDleq: false,
    }),
    /input keysets do not match/,
  )
  await assert.rejects(
    resolveDurableCustodyProofOperationFacts({
      operation: { ...operation('wallet-mint'), inputs: [], outputs: {} },
      session: null,
      resolveMintKeys,
      requireDleq: false,
    }),
    /custody operation has no keysets/,
  )
  await assert.rejects(
    resolveDurableCustodyProofOperationFacts({
      operation: { ...operation('wallet-mint'), inputs: [] },
      session: null,
      resolveMintKeys: async () => new Map(),
      requireDleq: false,
    }),
    /mint keyset does not match/,
  )
})

test('inputless persisted mint rejects broadened or mismatched authority', async () => {
  const record = await inputlessMintRecord()

  for (const semanticKind of ['generic-send', 'swap-lock']) {
    assertInputlessRecordRejected(
      record,
      (operation) => (operation.semanticKind = semanticKind),
      /reservation inputs must not be empty/,
    )
  }
  assertInputlessRecordRejected(
    record,
    (operation) => (operation.exactRequest.inputProofIds = ['a'.repeat(64)]),
    /exact request input binding is invalid/,
  )
  assertInputlessRecordRejected(
    record,
    (operation) =>
      (operation.reservation.inputs = [
        {
          proofId: 'a'.repeat(64),
          keysetId: KEYSET_ID,
          curve: 'secp256k1',
        },
      ]),
    /exact request input binding is invalid/,
  )
  assertInputlessRecordRejected(
    record,
    (operation) => (operation.verification.outputKeysets = []),
    /output keysets must not be empty/,
  )
  assertInputlessRecordRejected(
    record,
    (operation) => {
      operation.verification.hasOutputs = false
      operation.verification.outputKeysets = []
    },
    /inputless custody operation is invalid/,
  )
  assertInputlessRecordRejected(
    record,
    (operation) =>
      (operation.verification.outputKeysets = [
        { keysetId: 'foreign-keyset', curve: 'secp256k1' },
      ]),
    /output keyset verification binding is invalid/,
  )
})

test('inputless persisted mint retries unknown responses and aborts exact rejection', async () => {
  const record = decodeDurableCustodyRecord(
    structuredClone(await inputlessMintRecord()),
  )
  const scopeState = decodeDurableCustodyScopeState({
    schemaVersion: 1,
    scope: record.scope,
    fencingEpoch: 1,
    owner: { incarnationId: 'worker-001', leaseExpiresAtMs: 10_000 },
    effectiveClock: { highWaterMarkMs: 1_000 },
  })
  const decision = decideDurableCustodyRecovery(
    record,
    scopeState,
    recoveryEvidence(record, 'mint-response-unknown', 'unknown'),
  )

  assert.deepEqual(decision, {
    kind: 'retry-later',
    effectiveNowMs: 1_500,
  })

  const reissue = decideDurableCustodyRecovery(
    record,
    scopeState,
    recoveryEvidence(
      record,
      'all-inputs-unspent',
      'deterministically-rejected',
    ),
  )
  assert.deepEqual(reissue, {
    kind: 'abort-no-transport',
    effectiveNowMs: 1_500,
  })
})

test('shared proof operation facts derive the exact role-specific trade horizon', async () => {
  const session = tradeSession()
  const link = createDurableTradeProofOperationLink({
    tradeId: session.tradeId,
    role: session.role,
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'operation-001',
  })
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: { ...operation('swap-lock'), durableTradeRecovery: link },
    session,
    resolveMintKeys,
    requireDleq: true,
  })

  assert.equal(facts.binding.kind, 'trade')
  assert.equal(facts.binding.tradeId, session.tradeId)
  assert.equal(facts.horizon.notAfterMs, 120_000)
  assert.equal(facts.verification.keysetBindings[0]?.requireDleq, true)
})

test('shared operation builder binds exact proof and request authority', async () => {
  const proofOperation = operation('regular-split')
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: proofOperation,
    session: null,
    resolveMintKeys,
    requireDleq: false,
  })
  const scope = walletScope()
  const record = createDurableCustodyProofOperation({
    scope,
    operation: proofOperation,
    facts,
    inventoryAccountId: null,
  })

  assert.equal(record.scope.scopeId, scope.scopeId)
  assert.equal(record.operation.retainedOperationKey, 'operation-001')
  assert.equal(record.operation.reservation.inputs.length, 1)
  assert.match(record.operation.reservation.inputs[0]!.proofId, /^[0-9a-f]{64}$/)
  assert.deepEqual(
    record.operation.exactRequest.inputProofIds,
    record.operation.reservation.inputs.map(({ proofId }) => proofId),
  )
})

test('shared result fingerprint binds exact normalized proof artifacts', () => {
  const groups = { receive: operation('regular-split').inputs }
  const fingerprint = deriveDurableCustodyProofResultFingerprint(groups)

  assert.match(fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(
    deriveDurableCustodyProofResultFingerprint({ ...groups }),
    fingerprint,
  )
  assert.notEqual(
    deriveDurableCustodyProofResultFingerprint({
      receive: [{ ...groups.receive[0]!, secret: '22'.repeat(32) }],
    }),
    fingerprint,
  )
  assert.notEqual(
    deriveDurableCustodyProofResultFingerprint({
      receive: [{
        ...groups.receive[0]!,
        p2pk_e: `02${'66'.repeat(32)}`,
      }],
    }),
    fingerprint,
  )

  const proof = groups.receive[0]!
  const equivalent = {
    C: proof.C,
    secret: proof.secret,
    amount: 1n,
    id: proof.id,
    dleq: undefined,
  }
  assert.equal(
    deriveDurableCustodyProofResultFingerprint({ receive: [equivalent] }),
    fingerprint,
  )
  assert.equal(
    deriveDurableCustodyProofResultFingerprint({
      second: [equivalent],
      first: [proof],
    }),
    deriveDurableCustodyProofResultFingerprint({
      first: [proof],
      second: [equivalent],
    }),
  )
})

async function inputlessMintRecord() {
  const mint = { ...operation('wallet-mint'), inputs: [] }
  const facts = await resolveDurableCustodyProofOperationFacts({
    operation: mint,
    session: null,
    resolveMintKeys,
    requireDleq: false,
  })
  return createDurableCustodyProofOperation({
    scope: walletScope(),
    operation: mint,
    facts,
    inventoryAccountId: null,
  })
}

type MutableInputlessOperation = {
  semanticKind: unknown
  exactRequest: Record<string, unknown>
  reservation: Record<string, unknown>
  verification: Record<string, unknown>
}

function assertInputlessRecordRejected(
  record: DurableCustodyRecord,
  mutate: (operation: MutableInputlessOperation) => void,
  expected: RegExp,
): void {
  const malformed = structuredClone(record) as unknown as {
    operation: MutableInputlessOperation
  }
  mutate(malformed.operation)
  assert.throws(() => decodeDurableCustodyRecord(malformed), expected)
}

function recoveryEvidence(
  record: DurableCustodyRecord,
  classification: DurableCustodyRecoveryClassification,
  exactRequestDisposition:
    | 'not-rejected'
    | 'deterministically-rejected'
    | 'unknown',
) {
  return {
    incarnationId: 'worker-001',
    fencingEpoch: 1,
    observedAtMs: 1_500,
    classification,
    exactRequestDisposition,
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    requestFingerprint: record.operation.exactRequest.requestFingerprint,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
  }
}

function exactReference(record: DurableCustodyRecord) {
  return {
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    requestFingerprint: record.operation.exactRequest.requestFingerprint,
    requestPayloadHandle: record.operation.exactRequest.payloadHandle,
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    outputMaterialHandle: record.operation.outputPlan.outputMaterialHandle,
    privateMaterial: record.operation.privateMaterial,
    stagedResult: null,
  }
}

function operation(
  kind:
    | 'regular-split'
    | 'swap-lock'
    | 'wallet-mint'
    | 'wallet-receive'
    | 'wallet-send',
) {
  return {
    operationId: 'operation-001',
    kind,
    mintUrl: 'https://mint.example',
    inputs: [{
      id: KEYSET_ID,
      amount: 1,
      secret: '11'.repeat(32),
      C: PUBLIC_KEY,
    }],
    outputs: {
      keep: [{
        blindedMessage: {
          amount: 1,
          id: KEYSET_ID,
          B_: PUBLIC_KEY,
        },
        blindingFactor: '44'.repeat(32),
        secret: '55'.repeat(32),
      }],
    },
    metadata: { unit: 'sat' },
  }
}

function walletScope(): DurableCustodyScope {
  const input = { scopeKind: 'wallet' as const, walletId: 'aa'.repeat(32) }
  return { ...input, scopeId: deriveDurableCustodyScopeId(input) }
}

function tradeSession(): DurableTradeSession {
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId: 'trade-001',
    role: 'seller',
    localProtocolPubkey: 'a'.repeat(64),
    counterpartyProtocolPubkey: 'b'.repeat(64),
    mintUrl: 'https://mint.example',
    sellerLocktimeSecs: 120,
    buyerLocktimeSecs: 100,
    ephemeralKeyHandle: {
      keyId: 'trade-001',
      tradeId: 'trade-001',
      role: 'seller',
      localProtocolPubkey: 'a'.repeat(64),
      counterpartyProtocolPubkey: 'b'.repeat(64),
      mintUrl: 'https://mint.example',
      sellerLocktimeSecs: 120,
      buyerLocktimeSecs: 100,
    },
    stage: 'intent',
    proofOperations: [],
    receivedCiphers: {},
    outboundCiphers: {},
  }
}
