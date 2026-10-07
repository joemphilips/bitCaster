import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { OutputData, deriveKeysetId } from '@cashu/cashu-ts'
import {
  bindDurableBolt11MintQuoteOperation,
  createDurableBolt11MintQuote,
  hideDurableBolt11MintQuote,
  observeDurableBolt11MintQuoteState,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import { prepareDurableCustodyMintOperationAuthority } from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import {
  serializeDurableWalletMintOperation,
  toDurableCustodyProofOperationInput,
} from '@bitcaster-market/client-sdk/durableWalletOperation'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { DurableCustodyTransactionSqlite } from '../src/durableCustodyTransactionSqlite.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { NativeBolt11MintQuoteSqliteStore } from '../src/nativeBolt11MintQuoteSqlite.ts'

const MINT_URL = 'https://mint.example'
const WALLET_SEED_HEX = '11'.repeat(64)
const NOSTR_SECRET_HEX = '22'.repeat(32)
const KEYS = {
  '1': '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
}
const KEYSET_ID = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1 })

test('stores a bound quote with its custody operation in the caller transaction', async () => {
  const fixture = await profile()
  try {
    const prepared = prepareQuote(fixture.scope)
    await assert.rejects(
      () =>
        insertQuote(fixture, prepared, {
          injectFault: (phase) => {
            if (phase === 'before-commit') throw new Error('injected rollback')
          },
        }),
      /injected rollback/,
    )

    let database = await openDaemonStateSqlite(fixture.directory)
    try {
      const custodyCount = database
        .prepare('SELECT count(*) AS count FROM custody_operations WHERE scope_id = ?')
        .get(fixture.scope.scopeId) as { count: number }
      assert.equal(custodyCount.count, 0)
      assert.equal(
        new NativeBolt11MintQuoteSqliteStore(database).get(
          fixture.scope.scopeId,
          prepared.quote.quoteRecordId,
        ),
        null,
      )
    } finally {
      database.close()
    }

    await insertQuote(fixture, prepared)
    database = await openDaemonStateSqlite(fixture.directory)
    try {
      const store = new NativeBolt11MintQuoteSqliteStore(database)
      const reopened = store.get(fixture.scope.scopeId, prepared.quote.quoteRecordId)
      assert.ok(reopened)
      assert.equal(reopened.custodyOperationId, prepared.record.operation.operationId)
      assert.equal(reopened.quote.walletMintOperationId, prepared.quote.walletMintOperationId)
      assert.deepEqual(reopened.quote, prepared.quote)
      assert.deepEqual(
        store.getActiveByCustodyOperationIds(fixture.scope.scopeId, [
          prepared.record.operation.operationId,
        ]),
        [reopened],
      )

      const hidden = hideDurableBolt11MintQuote(reopened.quote)
      const hiddenRecord = store.update({
        scopeId: fixture.scope.scopeId,
        custodyOperationId: reopened.custodyOperationId,
        expectedRevision: reopened.quote.revision,
        quote: hidden,
      })
      assert.equal(hiddenRecord.quote.presentationState, 'hidden')
      assert.deepEqual(
        store.getActiveByCustodyOperationIds(fixture.scope.scopeId, [
          hiddenRecord.custodyOperationId,
        ]),
        [hiddenRecord],
      )

      const paid = observeDurableBolt11MintQuoteState(hiddenRecord.quote, 'PAID')
      const paidRecord = store.update({
        scopeId: fixture.scope.scopeId,
        custodyOperationId: hiddenRecord.custodyOperationId,
        expectedRevision: hiddenRecord.quote.revision,
        quote: paid,
      })
      assert.equal(paidRecord.quote.observedState, 'PAID')
      assert.equal(paidRecord.quote.presentationState, 'hidden')
      assert.throws(
        () =>
          store.update({
            scopeId: fixture.scope.scopeId,
            custodyOperationId: paidRecord.custodyOperationId,
            expectedRevision: hiddenRecord.quote.revision,
            quote: observeDurableBolt11MintQuoteState(paidRecord.quote, 'ISSUED'),
          }),
        /revision or authority changed/,
      )
      const skippedRevision = {
        ...observeDurableBolt11MintQuoteState(paidRecord.quote, 'ISSUED'),
        revision: paidRecord.quote.revision + 2,
      }
      assert.throws(
        () =>
          store.update({
            scopeId: fixture.scope.scopeId,
            custodyOperationId: paidRecord.custodyOperationId,
            expectedRevision: paidRecord.quote.revision,
            quote: skippedRevision,
          }),
        /transition is invalid/,
      )
      assert.throws(
        () =>
          database
            .prepare(
              `DELETE FROM daemon_bolt11_mint_quotes
               WHERE scope_id = ? AND quote_record_id = ?`,
            )
            .run(fixture.scope.scopeId, prepared.quote.quoteRecordId),
        /recovery state cannot be deleted/,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('rejects foreign scope, operation binding, and non-msat quotes', async () => {
  const fixture = await profile()
  try {
    const prepared = prepareQuote(fixture.scope, 'quote-primary')
    await insertQuote(fixture, prepared)
    const foreign = prepareQuote(fixture.scope, 'quote-foreign')
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      const store = new NativeBolt11MintQuoteSqliteStore(database)
      assert.equal(
        store.get('custody:wallet:' + '33'.repeat(32), prepared.quote.quoteRecordId),
        null,
      )
      assert.throws(
        () =>
          store.insert({
            scopeId: fixture.scope.scopeId,
            custodyOperationId: prepared.record.operation.operationId,
            quote: foreign.quote,
          }),
        /custody operation binding conflicts/,
      )
      assert.throws(
        () =>
          store.insert({
            scopeId: 'custody:wallet:' + '33'.repeat(32),
            custodyOperationId: prepared.record.operation.operationId,
            quote: prepared.quote,
          }),
        /custody operation binding conflicts/,
      )
      assert.throws(
        () =>
          store.insert({
            scopeId: fixture.scope.scopeId,
            custodyOperationId: foreign.record.operation.operationId,
            quote: createDurableBolt11MintQuote({
              mintUrl: MINT_URL,
              unit: 'sat',
              requestedAmount: '10',
              quoteId: 'quote-sat',
              invoiceRequest: 'lnbc-sat-fixture',
            }),
          }),
        /unit must be msat/,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

async function profile() {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-native-bolt11-'))
  const initialized = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT_URL,
    walletSeedHex: WALLET_SEED_HEX,
    nostrSecretKeyHex: NOSTR_SECRET_HEX,
    initializedAtMs: 1,
  })
  const walletId = deriveDurableCustodyWalletId(Buffer.from(WALLET_SEED_HEX, 'hex'))
  return {
    directory,
    scope: {
      scopeKind: 'wallet' as const,
      walletId,
      scopeId: deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId }),
    },
    fence: await claimCustodyScopeLease(directory, {
      scopeId: initialized.walletScopeId,
      incarnationId: 'native-bolt11-store-test',
      observedAtMs: 2,
    }),
  }
}

function prepareQuote(scope: Awaited<ReturnType<typeof profile>>['scope'], quoteId = 'quote-1') {
  const initialQuote = createDurableBolt11MintQuote({
    mintUrl: MINT_URL,
    unit: 'msat',
    requestedAmount: '1',
    quoteId,
    invoiceRequest: `lnbc-${quoteId}`,
    expiryUnixSeconds: 1_800_000_000,
  })
  const output = OutputData.createSingleData('1', KEYSET_ID, `secret:${quoteId}`, 17n)
  const walletMintOperation = serializeDurableWalletMintOperation({
    operationId: initialQuote.walletMintOperationId,
    mintUrl: MINT_URL,
    unit: 'msat',
    preview: {
      method: 'bolt11',
      payload: {
        quote: quoteId,
        outputs: [output.blindedMessage],
        signature: 'fixture-signature',
      },
      outputData: [output],
      keysetId: KEYSET_ID,
      quote: { quote: quoteId, expiry: 1_800_000_000 },
    },
  })
  const quote = bindDurableBolt11MintQuoteOperation(initialQuote, walletMintOperation)
  const custodyInput = toDurableCustodyProofOperationInput(walletMintOperation)
  const mintAuthority = prepareDurableCustodyMintOperationAuthority({
    operation: custodyInput,
    keysets: [
      {
        canonicalMintUrl: MINT_URL,
        id: KEYSET_ID,
        unit: 'msat',
        keys: KEYS,
        inputFeePpk: 0,
        finalExpiry: null,
        identity: { kind: 'regular' },
      },
    ],
  })
  const quoteAuthority = quote.walletMintOperationAuthority
  assert.ok(quoteAuthority)
  assert.notEqual(mintAuthority.exactRequest.fingerprint, quoteAuthority.requestFingerprint)
  assert.equal(mintAuthority.exactOutput.fingerprint, quoteAuthority.outputPlanFingerprint)
  const artifacts = {
    requestBody: mintAuthority.exactRequest,
    output: mintAuthority.exactOutput,
    privateMaterial: mintAuthority.exactAuthority,
  }
  const record = createDurableCustodyProofOperation({
    scope,
    operation: custodyInput,
    facts: mintAuthority.facts,
    inventoryAccountId: null,
    exactBoundary: {
      method: 'POST',
      path: '/v1/mint/bolt11',
      idempotencyKey: walletMintOperation.operationId,
      ...artifacts,
    },
  })
  return { quote, record, artifacts }
}

async function insertQuote(
  fixture: Awaited<ReturnType<typeof profile>>,
  prepared: ReturnType<typeof prepareQuote>,
  options: Parameters<typeof withDurableCustodyUnitOfWork>[4] = {},
): Promise<void> {
  await withDurableCustodyUnitOfWork(
    fixture.directory,
    fixture.fence,
    3,
    (database) => {
      const transaction = new DurableCustodyTransactionSqlite(database, fixture.scope.scopeId, 3)
      bindDurableCustodyProofOperation(transaction, prepared.record, prepared.artifacts)
      new NativeBolt11MintQuoteSqliteStore(database).insert({
        scopeId: fixture.scope.scopeId,
        custodyOperationId: prepared.record.operation.operationId,
        quote: prepared.quote,
      })
    },
    options,
  )
}
