import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  createDurableOutgoingCashuTransfer,
  type DurableOutgoingCashuTransfer,
} from '@bitcaster-market/client-sdk/durableOutgoingCashuTransfer'
import { decodeDurableWalletOperation } from '@bitcaster-market/client-sdk/durableWalletOperation'
import { deriveDurableRecipientTokenAllowance } from '@bitcaster-market/client-sdk/durableRecipientDelivery'
import {
  createMarketFundingDeliveryMetadata,
  marketFundingDeliveryIntent,
} from '@bitcaster-market/client-sdk/marketFundingDelivery'
import {
  createParticipationScoreDeliveryMetadata,
  participationScoreDeliveryIntent,
} from '@bitcaster-market/client-sdk/participationScoreDelivery'
import {
  DurableOutgoingCashuSqliteStore,
  type MarketFundingProduct,
} from '../src/durableOutgoingCashuSqlite.ts'
import { FINAL_PROFILE_SCHEMA_SQL } from '../src/profileSchemaManifest.ts'

const scopeId = 'scope'
const keysetId = `01${'a'.repeat(64)}`
const firstId = '11111111-1111-4111-8111-111111111111'
const secondId = '22222222-2222-4222-8222-222222222222'
const competingId = '33333333-3333-4333-8333-333333333333'
const staleId = '44444444-4444-4444-8444-444444444444'
const scoreFirstId = '55555555-5555-4555-8555-555555555555'
const scoreSecondId = '66666666-6666-4666-8666-666666666666'
const product: MarketFundingProduct = {
  accountSubject: 'subject-1',
  conditionId: 'b'.repeat(64),
  mintUrl: 'https://mint.example',
  unit: 'msat',
  divisibility: 1_000,
}

function fixture() {
  const database = new DatabaseSync(':memory:')
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE custody_scopes (scope_id TEXT PRIMARY KEY);
    CREATE TABLE custody_operations (
      scope_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      retained_operation_key TEXT NOT NULL, semantic_kind TEXT NOT NULL,
      wallet_stage TEXT NOT NULL, PRIMARY KEY (scope_id, operation_id)
    );
    CREATE TABLE custody_artifacts (
      scope_id TEXT NOT NULL, artifact_id TEXT NOT NULL, artifact_kind TEXT NOT NULL,
      encoding TEXT NOT NULL, body BLOB NOT NULL, fingerprint TEXT NOT NULL,
      revision INTEGER NOT NULL, private_material INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL, PRIMARY KEY (scope_id, artifact_id)
    );
    CREATE TABLE custody_operation_artifact_links (scope_id TEXT, artifact_id TEXT);
    INSERT INTO custody_scopes VALUES ('scope');
  `)
  for (const name of ['daemon_outgoing_cashu_transfers', 'daemon_market_funding_heads']) {
    const statement = FINAL_PROFILE_SCHEMA_SQL.find((sql) => sql.startsWith(`CREATE TABLE ${name}`))
    assert.ok(statement)
    database.exec(statement)
  }
  for (const name of [
    'daemon_outgoing_cashu_recipient_active_binding_idx',
    'daemon_market_funding_successor_idx',
  ]) {
    const statement = FINAL_PROFILE_SCHEMA_SQL.find((sql) =>
      sql.startsWith(`CREATE UNIQUE INDEX ${name}`),
    )
    assert.ok(statement)
    database.exec(statement)
  }
  return { database, store: new DurableOutgoingCashuSqliteStore(database) }
}

function transfer(
  database: DatabaseSync,
  transferId: string,
  predecessorTransferId: string | null,
  kind: 'funding' | 'score' = 'funding',
  amount = '1000',
): { custodyOperationId: string; transfer: DurableOutgoingCashuTransfer } {
  const custodyOperationId = `custody-${transferId}`
  const operationId = `wallet-send-${transferId}`
  const operation = decodeDurableWalletOperation({
    schemaVersion: 1,
    operationId,
    kind: 'wallet-send',
    mintUrl: product.mintUrl,
    unit: 'msat',
    preview: {
      amount,
      fees: '0',
      keysetId,
      inputs: [
        {
          id: keysetId,
          amount,
          secret: `input-${transferId}`,
          C: `02${'1'.repeat(64)}`,
          dleq: null,
          p2pkE: null,
          witness: null,
        },
      ],
      sendOutputs: [
        {
          blindedMessage: { amount, id: keysetId, B_: `send-${transferId}` },
          blindingFactor: '1',
          secret: `send-${transferId}`,
          ephemeralE: null,
        },
      ],
      keepOutputs: [],
      unselectedProofs: [],
    },
  })
  if (operation.kind !== 'wallet-send') throw new Error('fixture wallet operation is invalid')
  database
    .prepare(
      `INSERT INTO custody_operations
       (scope_id, operation_id, retained_operation_key, semantic_kind, wallet_stage)
     VALUES (?, ?, ?, 'wallet-send', 'send')`,
    )
    .run(scopeId, custodyOperationId, operationId)
  const metadata =
    kind === 'funding'
      ? createMarketFundingDeliveryMetadata({
          ...product,
          deliveryId: transferId,
          requestedAmount: amount,
        })
      : createParticipationScoreDeliveryMetadata({
          deliveryId: transferId,
          accountSubject: product.accountSubject,
          mintUrl: product.mintUrl,
          requestedAmount: amount,
        })
  const deliveryIntent =
    kind === 'funding'
      ? marketFundingDeliveryIntent({
          accountSubject: product.accountSubject,
          productBindingSha256: metadata.productBindingSha256,
          tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
        })
      : participationScoreDeliveryIntent({
          accountSubject: product.accountSubject,
          productBindingSha256: metadata.productBindingSha256,
          tokenBytesLimit: deriveDurableRecipientTokenAllowance(metadata),
        })
  return {
    custodyOperationId,
    transfer: createDurableOutgoingCashuTransfer({
      transferId,
      walletScopeId: scopeId,
      requestedAmount: amount,
      walletSendOperation: operation,
      recipientSequence: kind === 'funding' ? { predecessorTransferId } : null,
      deliveryIntent,
    }),
  }
}

function putFunding(
  store: DurableOutgoingCashuSqliteStore,
  prepared: ReturnType<typeof transfer>,
  expectedPreviousTransferId: string | null,
  selectedProduct = product,
) {
  return store.putMarketFunding({
    scopeId,
    ...prepared,
    product: selectedProduct,
    expectedPreviousTransferId,
    nowMs: 1,
  })
}

test('funding storage starts at null, replays exactly, and retains a predecessor for a second payment', () => {
  const { database, store } = fixture()
  try {
    assert.equal(store.readMarketFundingHead({ scopeId, product }), null)
    const first = transfer(database, firstId, null)
    const storedFirst = putFunding(store, first, null)
    assert.equal(storedFirst.transferId, firstId)
    assert.equal(putFunding(store, first, null).transferId, firstId)
    assert.equal(store.readMarketFundingHead({ scopeId, product })?.revision, 1)
    assert.equal(
      store.findMarketFundingSuccessor({ scopeId, product, predecessorTransferId: null })
        ?.transferId,
      firstId,
    )

    const second = transfer(database, secondId, firstId)
    putFunding(store, second, firstId)
    assert.equal(store.readMarketFundingHead({ scopeId, product })?.transferId, secondId)
    assert.equal(store.readMarketFundingHead({ scopeId, product })?.revision, 2)
    assert.equal(
      store.findMarketFundingSuccessor({ scopeId, product, predecessorTransferId: firstId })
        ?.transferId,
      secondId,
    )
    assert.ok(store.get(scopeId, firstId))
    assert.ok(store.get(scopeId, secondId))
    assert.deepEqual(
      store.readMarketFundingProductForTransfer({ scopeId, transferId: firstId }),
      product,
    )
    assert.deepEqual(
      store.readMarketFundingProductForTransfer({ scopeId, transferId: secondId }),
      product,
    )
    assert.throws(
      () =>
        database
          .prepare(
            `DELETE FROM daemon_outgoing_cashu_transfers WHERE scope_id = ? AND transfer_id = ?`,
          )
          .run(scopeId, firstId),
      /constraint failed/i,
    )
  } finally {
    database.close()
  }
})

test('funding storage refuses competing and stale heads without transfer or artifact mutation', () => {
  const { database, store } = fixture()
  try {
    const first = transfer(database, firstId, null)
    putFunding(store, first, null)
    const competitor = transfer(database, competingId, null)
    assert.throws(() => putFunding(store, competitor, null), /successor preparation conflicts/)
    const changedAmount = transfer(database, secondId, null, 'funding', '2000')
    assert.throws(() => putFunding(store, changedAmount, null), /successor preparation conflicts/)
    const stale = transfer(database, staleId, competingId)
    assert.throws(() => putFunding(store, stale, competingId), /head changed/)
    assert.equal(store.get(scopeId, competingId), null)
    assert.equal(store.get(scopeId, secondId), null)
    assert.equal(store.get(scopeId, staleId), null)
    assert.equal(
      (
        database.prepare(`SELECT count(*) AS count FROM custody_artifacts`).get() as {
          count: number
        }
      ).count,
      1,
    )
    assert.equal(store.readMarketFundingHead({ scopeId, product })?.transferId, firstId)
  } finally {
    database.close()
  }
})

test('a losing funding CAS supports rollback of the caller-owned custody unit of work', () => {
  const { database, store } = fixture()
  try {
    const first = transfer(database, firstId, null)
    putFunding(store, first, null)
    database.exec('BEGIN IMMEDIATE')
    try {
      const competitor = transfer(database, competingId, null)
      assert.throws(() => putFunding(store, competitor, null), /successor preparation conflicts/)
    } finally {
      database.exec('ROLLBACK')
    }
    assert.equal(store.get(scopeId, competingId), null)
    assert.equal(
      (
        database
          .prepare(`SELECT count(*) AS count FROM custody_operations WHERE operation_id = ?`)
          .get(`custody-${competingId}`) as { count: number }
      ).count,
      0,
    )
    assert.equal(store.readMarketFundingHead({ scopeId, product })?.transferId, firstId)
  } finally {
    database.close()
  }
})

test('funding storage rejects foreign product, scope, sequence, and malformed indexed rows', () => {
  const { database, store } = fixture()
  try {
    const first = transfer(database, firstId, null)
    assert.throws(
      () => putFunding(store, first, null, { ...product, accountSubject: 'other' }),
      /authority conflicts/,
    )
    assert.throws(
      () =>
        store.putMarketFunding({
          scopeId: 'other',
          ...first,
          product,
          expectedPreviousTransferId: null,
          nowMs: 1,
        }),
      /scope is foreign/,
    )
    assert.throws(() => putFunding(store, first, secondId), /sequence conflicts/)
    putFunding(store, first, null)
    database
      .prepare(
        `UPDATE daemon_market_funding_heads SET normalized_mint = 'https://other.example' WHERE scope_id = ?`,
      )
      .run(scopeId)
    assert.throws(() => store.readMarketFundingHead({ scopeId, product }), /authority conflicts/)
    assert.throws(
      () => store.readMarketFundingProductForTransfer({ scopeId, transferId: firstId }),
      /authority conflicts/,
    )
    database
      .prepare(`UPDATE daemon_market_funding_heads SET normalized_mint = ? WHERE scope_id = ?`)
      .run(product.mintUrl, scopeId)
    database
      .prepare(
        `UPDATE daemon_outgoing_cashu_transfers SET funding_sequence = 0 WHERE scope_id = ? AND transfer_id = ?`,
      )
      .run(scopeId, firstId)
    assert.throws(() => store.get(scopeId, firstId), /row is foreign/)
  } finally {
    database.close()
  }
})

test('funding recovery rejects a missing head instead of inventing product metadata', () => {
  const { database, store } = fixture()
  try {
    const first = transfer(database, firstId, null)
    putFunding(store, first, null)
    database.prepare(`DELETE FROM daemon_market_funding_heads WHERE scope_id = ?`).run(scopeId)
    assert.throws(
      () =>
        store.readMarketFundingProductForTransfer({
          scopeId,
          transferId: firstId,
        }),
      /head is missing/,
    )
  } finally {
    database.close()
  }
})

test('Score keeps its single active recipient binding and never enters the funding index', () => {
  const { database, store } = fixture()
  try {
    const first = transfer(database, scoreFirstId, null, 'score')
    const second = transfer(database, scoreSecondId, null, 'score')
    store.put({ scopeId, ...first, nowMs: 1 })
    assert.throws(() => store.put({ scopeId, ...second, nowMs: 1 }), /constraint failed/i)
    assert.equal(
      store.findMarketFundingSuccessor({ scopeId, product, predecessorTransferId: null }),
      null,
    )
    assert.equal(store.get(scopeId, scoreFirstId)?.transfer.recipientSequence, null)
  } finally {
    database.close()
  }
})
