import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  durableCustodyProofOperationSemanticKind,
  resolveDurableCustodyProofOperationFacts,
} from '../src/durableCustodyProofOperation.ts'
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

function operation(kind: 'regular-split' | 'swap-lock') {
  return {
    operationId: 'operation-001',
    kind,
    mintUrl: 'https://mint.example',
    inputs: [{ id: KEYSET_ID }],
    outputs: {
      keep: [{ blindedMessage: { id: KEYSET_ID } }],
    },
    metadata: { unit: 'sat' },
  }
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
