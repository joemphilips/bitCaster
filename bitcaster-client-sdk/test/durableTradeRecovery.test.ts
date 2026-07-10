import assert from 'node:assert/strict'
import { test } from 'node:test'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  canSalvageDurableRefund,
  createDurableTradeProofOperationLink,
  deriveDurableProofOperationId,
  isDurableTradeSessionPurgeEligible,
  resumeDurableTradeSession,
  reduceDurableTradeSession,
  scanDurableTradeRecoveryLinks,
  validateDurableTradeSession,
  validateDurableTradePendingIntent,
  validateDurableTradePrivateKeyBinding,
  verifyDurableTradeSessionCipherIntegrity,
  type DurableRefundSalvageEvidence,
  type DurableTradeProofOperationLink,
  type DurableTradeSession,
} from '../src/durableTradeRecovery.ts'

const LOCAL_PROTOCOL_PUBKEY = 'a'.repeat(64)
const COUNTERPARTY_PROTOCOL_PUBKEY = 'b'.repeat(64)

function session(
  overrides: Partial<DurableTradeSession> = {},
): DurableTradeSession {
  const tradeId = overrides.tradeId ?? 'trade-001'
  const role = overrides.role ?? 'seller'
  const mintUrl = overrides.mintUrl ?? 'https://mint.example'
  const sellerLocktimeSecs = overrides.sellerLocktimeSecs ?? 120
  const buyerLocktimeSecs = overrides.buyerLocktimeSecs ?? 100
  const localProtocolPubkey = overrides.localProtocolPubkey ?? LOCAL_PROTOCOL_PUBKEY
  const counterpartyProtocolPubkey =
    overrides.counterpartyProtocolPubkey ?? COUNTERPARTY_PROTOCOL_PUBKEY

  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    revision: 0,
    tradeId,
    role,
    localProtocolPubkey,
    counterpartyProtocolPubkey,
    mintUrl,
    sellerLocktimeSecs,
    buyerLocktimeSecs,
    ephemeralKeyHandle: {
      keyId: 'ephemeral-key-001',
      tradeId,
      role,
      localProtocolPubkey,
      counterpartyProtocolPubkey,
      mintUrl,
      sellerLocktimeSecs,
      buyerLocktimeSecs,
    },
    stage: 'intent',
    proofOperations: [],
    receivedCiphers: {},
    outboundCiphers: {},
    ...overrides,
  }
}

function preparedOperation(
  tradeId = 'trade-001',
  role: DurableTradeSession['role'] = 'seller',
): DurableTradeProofOperationLink {
  return {
    operationId: deriveDurableProofOperationId(tradeId, role, 'proof-reservation'),
    tradeId,
    role,
    stage: 'proof-reservation',
    state: 'prepared',
  }
}

test('deterministic proof-operation identifiers bind trade, role, and stage', () => {
  const sellerReservation = deriveDurableProofOperationId(
    'trade-001',
    'seller',
    'proof-reservation',
  )

  assert.equal(
    sellerReservation,
    'trade-recovery:trade-001:seller:proof-reservation',
  )
  assert.notEqual(
    sellerReservation,
    deriveDurableProofOperationId('trade-001', 'buyer', 'proof-reservation'),
  )
  assert.notEqual(
    sellerReservation,
    deriveDurableProofOperationId('trade-001', 'seller', 'refund'),
  )
})

test('a client operation key is bound into the SDK recovery identity', () => {
  const operation = createDurableTradeProofOperationLink({
    tradeId: 'trade-001',
    role: 'seller',
    stage: 'proof-reservation',
    state: 'prepared',
    operationKey: 'trade-001/browser/seller-lock',
  })

  assert.equal(operation.operationKey, 'trade-001/browser/seller-lock')
  assert.equal(
    operation.operationId,
    deriveDurableProofOperationId(
      'trade-001',
      'seller',
      'proof-reservation',
      'trade-001/browser/seller-lock',
    ),
  )
  assert.match(
    validateDurableTradeSession(session({
      stage: 'proof-reserved',
      proofOperations: [{ ...operation, operationKey: 'different-operation' }],
    })) ?? '',
    /not bound/,
  )
})

test('a pending trade intent validates only the pre-TradeCreated durable binding', () => {
  const intent = {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    tradeId: 'trade-001',
    orderId: 'order-001',
    marketId: 'condition-YES',
    localProtocolPubkey: `02${LOCAL_PROTOCOL_PUBKEY}`,
    deadline: '2026-07-10T12:00:00.000Z',
  }

  assert.equal(validateDurableTradePendingIntent(intent), null)
  assert.match(
    validateDurableTradePendingIntent({ ...intent, deadline: 'not-a-date' }) ?? '',
    /deadline/,
  )
  assert.match(
    validateDurableTradePendingIntent({ ...intent, localProtocolPubkey: 'x' }) ?? '',
    /public key/,
  )
})

test('private recovery material must derive the persisted protocol public key', () => {
  const privateKey = '01'.repeat(32)
  const publicKey = Array.from(secp256k1.getPublicKey(new Uint8Array(32).fill(1), true))
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')

  assert.equal(validateDurableTradePrivateKeyBinding(privateKey, publicKey), null)
  assert.match(
    validateDurableTradePrivateKeyBinding(privateKey, `02${'b'.repeat(64)}`) ?? '',
    /does not match/,
  )
})

test('write-ahead reducer retains the operation link through mint submission and reconciliation', () => {
  const prepared = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation: preparedOperation(),
  })
  assert.equal(prepared.stage, 'proof-reserved')
  assert.equal(prepared.revision, 1)
  assert.equal(prepared.proofOperations[0]?.state, 'prepared')

  const submitted = reduceDurableTradeSession(prepared, {
    kind: 'mint-submitted',
    operationId: prepared.proofOperations[0]!.operationId,
  })
  assert.equal(submitted.stage, 'mint-submitted')
  assert.equal(submitted.proofOperations[0]?.state, 'mint-submitted')

  const reconciled = reduceDurableTradeSession(submitted, {
    kind: 'proof-operation-reconciled',
    operationId: submitted.proofOperations[0]!.operationId,
  })
  assert.equal(reconciled.stage, 'reconciliation-complete')
  assert.equal(isDurableTradeSessionPurgeEligible(reconciled), true)
})

test('outbound cipher journal replay is byte-identical and rejects replacement ciphertext', () => {
  const journaled = reduceDurableTradeSession(session(), {
    kind: 'outbound-cipher-journaled',
    messageType: 'adaptor-point',
    ciphertext: 'cipher-a',
    sha256: 'c'.repeat(64),
  })
  const replay = reduceDurableTradeSession(journaled, {
    kind: 'outbound-cipher-journaled',
    messageType: 'adaptor-point',
    ciphertext: 'cipher-a',
    sha256: 'c'.repeat(64),
  })

  assert.equal(replay, journaled)
  assert.throws(
    () => reduceDurableTradeSession(journaled, {
      kind: 'outbound-cipher-journaled',
      messageType: 'adaptor-point',
      ciphertext: 'cipher-b',
      sha256: 'd'.repeat(64),
    }),
    /different ciphertext/,
  )
})

test('session validation fails closed for an unknown schema or foreign protocol-key binding', () => {
  assert.match(
    validateDurableTradeSession({ ...session(), schemaVersion: 99 }) ?? '',
    /schema version/,
  )
  assert.match(
    validateDurableTradeSession(session({
      ephemeralKeyHandle: {
        ...session().ephemeralKeyHandle,
        counterpartyProtocolPubkey: 'c'.repeat(64),
      },
    })) ?? '',
    /key handle binding/,
  )
})

test('cipher integrity validation rejects altered persisted ciphertext before recovery acts', async () => {
  const valid = reduceDurableTradeSession(session(), {
    kind: 'received-cipher-recorded',
    messageType: 'locked-proofs-seller',
    ciphertext: 'cipher-a',
    sha256: 'a'.repeat(64),
  })

  assert.equal(
    await verifyDurableTradeSessionCipherIntegrity(valid, async () => 'a'.repeat(64)),
    null,
  )
  assert.match(
    await verifyDurableTradeSessionCipherIntegrity(valid, async () => 'b'.repeat(64)) ?? '',
    /cipher hash mismatch/,
  )
})

test('recovery scan finds both a missing session link and a separately persisted orphan operation', () => {
  const linked = preparedOperation()
  const scan = scanDurableTradeRecoveryLinks({
    sessions: [session({
      stage: 'proof-reserved',
      proofOperations: [linked],
    })],
    operations: [
      {
        ...linked,
        operationId: deriveDurableProofOperationId('trade-002', 'buyer', 'refund'),
        tradeId: 'trade-002',
        role: 'buyer',
        stage: 'refund',
      },
    ],
  })

  assert.deepEqual(scan.missingOperations, [linked.operationId])
  assert.deepEqual(scan.orphanOperations, [
    deriveDurableProofOperationId('trade-002', 'buyer', 'refund'),
  ])
})

test('corrupt session cannot resume, but independently bound post-locktime evidence can salvage only its refund', () => {
  const evidence: DurableRefundSalvageEvidence = {
    tradeId: 'trade-001',
    role: 'seller',
    localProtocolPubkey: LOCAL_PROTOCOL_PUBKEY,
    counterpartyProtocolPubkey: COUNTERPARTY_PROTOCOL_PUBKEY,
    mintUrl: 'https://mint.example',
    sellerLocktimeSecs: 120,
    buyerLocktimeSecs: 100,
    keyHandle: session().ephemeralKeyHandle,
    proofOperation: {
      operationId: deriveDurableProofOperationId('trade-001', 'seller', 'refund'),
      tradeId: 'trade-001',
      role: 'seller',
      stage: 'refund',
      state: 'mint-submitted',
    },
  }

  assert.notEqual(validateDurableTradeSession({ ...session(), revision: -1 }), null)
  assert.equal(canSalvageDurableRefund(evidence, 119), false)
  assert.equal(canSalvageDurableRefund(evidence, 120), true)
  assert.equal(canSalvageDurableRefund({
    ...evidence,
    proofOperation: { ...evidence.proofOperation, state: 'prepared' },
  }, 120), false)
  assert.equal(canSalvageDurableRefund({
    ...evidence,
    keyHandle: {
      ...evidence.keyHandle,
      localProtocolPubkey: 'd'.repeat(64),
    },
  }, 120), false)
})

test('a session remains non-purgeable until every linked operation is reconciled', () => {
  const prepared = reduceDurableTradeSession(session(), {
    kind: 'proof-operation-prepared',
    operation: preparedOperation(),
  })
  assert.equal(isDurableTradeSessionPurgeEligible(prepared), false)
})

test('recovery rejoins then replays only journalled outbound ciphers in protocol order', async () => {
  const journaled = reduceDurableTradeSession(
    reduceDurableTradeSession(session(), {
      kind: 'outbound-cipher-journaled',
      messageType: 'locked-proofs-seller',
      ciphertext: 'seller-cipher',
      sha256: 'a'.repeat(64),
    }),
    {
      kind: 'outbound-cipher-journaled',
      messageType: 'adaptor-point',
      ciphertext: 'adaptor-cipher',
      sha256: 'b'.repeat(64),
    },
  )
  const calls: string[] = []

  const result = await resumeDurableTradeSession(journaled, {
    joinTrade: async (tradeId) => { calls.push(`join:${tradeId}`) },
    sendCipher: async (_tradeId, messageType, ciphertext) => {
      calls.push(`${messageType}:${ciphertext}`)
    },
  })

  assert.equal(result.kind, 'replayed')
  assert.deepEqual(calls, [
    'join:trade-001',
    'adaptor-point:adaptor-cipher',
    'locked-proofs-seller:seller-cipher',
  ])
})

test('recovery fails closed before joining or sending an invalid durable session', async () => {
  const calls: string[] = []
  const result = await resumeDurableTradeSession(
    { ...session(), schemaVersion: 99 },
    {
      joinTrade: async () => { calls.push('join') },
      sendCipher: async () => { calls.push('send') },
    },
  )

  assert.equal(result.kind, 'invalid-session')
  assert.deepEqual(calls, [])
})
