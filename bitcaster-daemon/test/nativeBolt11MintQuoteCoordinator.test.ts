import { readActivityRows } from './nativeActivityTestHelpers.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  MintOperationError,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import {
  applyDurableCustodyTransaction,
  createDurableBolt11MintQuote,
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
import { NativeBolt11MintQuoteCoordinator } from '../src/nativeBolt11MintQuoteCoordinator.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from '../src/durableCustodyTransactionSqlite.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { NativeBolt11MintQuoteSqliteStore } from '../src/nativeBolt11MintQuoteSqlite.ts'
import { readAvailableWalletProofsFenced, reserveDaemonKeysetCounter } from '../src/state.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'

const MINT_URL = 'https://mint.example'
const WALLET_SEED_HEX = '11'.repeat(64)
const NOSTR_SECRET_HEX = '22'.repeat(32)
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEYS = { '1': bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) }
const KEYSET_ID = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1 })

test('commits quote and exact custody authority before invoice disclosure', async () => {
  const fixture = await createFixture()
  try {
    const failing = fixture.coordinator({
      injectFault: (phase) => {
        if (phase === 'before-commit') throw new Error('injected quote commit failure')
      },
    })
    await assert.rejects(
      failing.create({ mintUrl: MINT_URL, amountMsat: 1 }),
      /injected quote commit failure/,
    )
    assert.deepEqual(await fixture.counts(), { quotes: 0, operations: 0, active: 0, proofs: 0 })
    assert.equal(await fixture.counter(), 1)

    const view = await fixture.coordinator().create({ mintUrl: MINT_URL, amountMsat: 1 })
    assert.equal(view.invoiceRequest, 'lnbc-quote-2')
    assert.equal(view.unit, 'msat')
    assert.equal(view.requestedAmount, '1')
    assert.deepEqual(Object.keys(view).sort(), [
      'expiryUnixSeconds',
      'invoiceRequest',
      'mintUrl',
      'observedState',
      'paymentMethod',
      'presentationState',
      'quoteId',
      'quoteRecordId',
      'requestedAmount',
      'revision',
      'unit',
    ])
    assert.deepEqual(await fixture.counts(), { quotes: 1, operations: 1, active: 1, proofs: 0 })

    const hidden = await fixture.coordinator().hide(view.quoteRecordId)
    const diagnosticCanary = 'sensitive diagnostic canary: invoice and proof material'
    fixture.failNextQuoteCreation(diagnosticCanary)
    const originalWrite = process.stderr.write
    let diagnostic = ''
    try {
      process.stderr.write = ((chunk: string | Uint8Array) => {
        diagnostic += chunk.toString()
        return true
      }) as typeof process.stderr.write
      await assert.rejects(
        failing.create({ mintUrl: MINT_URL, amountMsat: 1 }),
        (error: unknown) => error instanceof Error && error.message === diagnosticCanary,
      )
    } finally {
      process.stderr.write = originalWrite
    }
    assert.equal(diagnostic, 'native-bolt11-invoice-create-failed stage=create-quote error=Error\n')
    assert.doesNotMatch(diagnostic, /sensitive diagnostic canary|invoice and proof material/)
    const reopened = fixture.coordinator()
    assert.deepEqual(await reopened.get(view.quoteRecordId), hidden)
    const unpaid = await reopened.recoverActivePage({ cursor: null })
    assert.deepEqual(unpaid.outcomes, [
      { quoteRecordId: view.quoteRecordId, outcome: 'unpaid', retryPending: true, blocking: false },
    ])
    assert.equal(unpaid.nextCursor, null)
    assert.equal(fixture.calls.complete, 0)
    assert.equal(fixture.calls.prepare, 2)
    assert.deepEqual(await fixture.counts(), { quotes: 1, operations: 1, active: 1, proofs: 0 })
  } finally {
    await fixture.close()
  }
})

test('recovers a hidden paid quote from staged custody without mint I/O or double credit', async () => {
  const fixture = await createFixture()
  try {
    const coordinator = fixture.coordinator()
    const created = await coordinator.create({ mintUrl: MINT_URL, amountMsat: 1 })
    const hidden = await coordinator.hide(created.quoteRecordId)
    assert.equal(hidden.presentationState, 'hidden')
    fixture.setState(hidden.quoteId, 'PAID')

    let afterCommitCount = 0
    const interrupted = fixture.coordinator({
      injectFault: (phase) => {
        if (phase === 'after-commit' && ++afterCommitCount === 2) {
          throw new Error('injected staged-result interruption')
        }
      },
    })
    const failedPage = await interrupted.recoverActivePage({ cursor: null })
    assert.deepEqual(failedPage.outcomes, [
      {
        quoteRecordId: hidden.quoteRecordId,
        outcome: 'error',
        blocking: true,
        error: 'native BOLT11 mint quote recovery failed',
      },
    ])
    assert.equal((await fixture.counts()).proofs, 0)
    assert.equal((await readActivityRows(fixture.directory)).length, 0)
    assert.equal((await fixture.operationResultState()).state, 'verified-staged')
    assert.equal((await interrupted.get(hidden.quoteRecordId))?.observedState, 'PAID')

    const beforeRetry = { ...fixture.calls }
    const reopened = fixture.coordinator()
    const resumed = await reopened.recoverActivePage({ cursor: null })
    assert.deepEqual(resumed.outcomes, [
      { quoteRecordId: hidden.quoteRecordId, outcome: 'recovered', blocking: false },
    ])
    assert.equal(fixture.calls.walletFor, beforeRetry.walletFor)
    assert.equal(fixture.calls.check, beforeRetry.check)
    assert.equal(fixture.calls.complete, beforeRetry.complete)
    assert.equal(fixture.calls.restore, beforeRetry.restore)
    assert.deepEqual(await fixture.counts(), { quotes: 1, operations: 1, active: 0, proofs: 1 })
    const available = await readAvailableWalletProofsFenced({
      mintUrl: MINT_URL,
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      mutation: { fence: fixture.fence, observedAtMs: Date.now() },
    })
    assert.equal(available.length, 1)
    assert.equal(Number(available[0]!.proof.amount), 1)
    const activity = await readActivityRows(fixture.directory)
    assert.equal(activity.length, 1)
    assert.equal(activity[0]?.item.type, 'deposit')
    assert.equal(activity[0]?.item.amountSubunits, 1)
    assert.equal(activity[0]?.item.txId, hidden.quoteId)
    assert.equal(activity[0]?.item.lightningInvoice, hidden.invoiceRequest)
    assert.equal(activity[0]?.item.walletId, fixture.fence.scopeId.slice('custody:wallet:'.length))
    assert.equal(await fixture.counter(), 1)
    assert.deepEqual(await reopened.get(hidden.quoteRecordId), {
      ...hidden,
      observedState: 'ISSUED',
      revision: hidden.revision + 2,
    })
    assert.deepEqual(await reopened.recoverActivePage({ cursor: null }), {
      outcomes: [],
      nextCursor: null,
      hasMore: false,
    })
    assert.equal((await fixture.counts()).proofs, 1)
    assert.deepEqual(await readActivityRows(fixture.directory), activity)
  } finally {
    await fixture.close()
  }
})

test('rejects empty duplicate-output restore, then admits only the exact issued output', async () => {
  const fixture = await createFixture()
  try {
    const coordinator = fixture.coordinator()
    const view = await coordinator.create({ mintUrl: MINT_URL, amountMsat: 1 })
    fixture.setState(view.quoteId, 'ISSUED')
    fixture.setDuplicateMint(true)
    fixture.setRestoreValid(false)

    const rejected = await fixture.coordinator().recoverActivePage({ cursor: null })
    assert.equal(rejected.outcomes[0]?.outcome, 'error')
    assert.equal((await fixture.counts()).proofs, 0)
    assert.equal((await fixture.counts()).active, 1)
    assert.equal(fixture.calls.prepare, 1)
    assert.equal(fixture.calls.restore, 1)

    fixture.setRestoreValid(true)
    const recovered = await fixture.coordinator().recoverActivePage({ cursor: null })
    assert.deepEqual(recovered.outcomes, [
      { quoteRecordId: view.quoteRecordId, outcome: 'recovered', blocking: false },
    ])
    assert.equal(fixture.calls.prepare, 1)
    assert.equal(fixture.calls.complete, 2)
    assert.equal(fixture.calls.restore, 2)
    assert.equal(await fixture.counter(), 1)
    assert.deepEqual(await fixture.counts(), { quotes: 1, operations: 1, active: 0, proofs: 1 })
    assert.deepEqual(await fixture.coordinator().recoverActivePage({ cursor: null }), {
      outcomes: [],
      nextCursor: null,
      hasMore: false,
    })
    assert.equal(fixture.calls.complete, 2)
    assert.equal(fixture.calls.restore, 2)
    assert.equal((await fixture.counts()).proofs, 1)
  } finally {
    await fixture.close()
  }
})

test('rejects a foreign prepared quote or non-msat quote before mint I/O', async () => {
  for (const scenario of [
    { name: 'non-msat quote response', responseUnit: 'sat', preparedQuote: null, prepareCalls: 0 },
    {
      name: 'foreign prepared quote',
      responseUnit: null,
      preparedQuote: 'foreign-quote',
      prepareCalls: 1,
    },
  ]) {
    const fixture = await createFixture()
    try {
      fixture.setNextQuoteOverrides({
        ...(scenario.responseUnit === null ? {} : { unit: scenario.responseUnit }),
        ...(scenario.preparedQuote === null ? {} : { preparedQuote: scenario.preparedQuote }),
      })
      await assert.rejects(
        fixture.coordinator().create({ mintUrl: MINT_URL, amountMsat: 1 }),
        /native BOLT11 mint (quote response|output plan) is invalid/,
        scenario.name,
      )
      assert.equal(fixture.calls.prepare, scenario.prepareCalls)
      assert.equal(fixture.calls.check, 0)
      assert.equal(fixture.calls.complete, 0)
      if (scenario.prepareCalls === 1) assert.equal(await fixture.counter(), 1)
      assert.deepEqual(await fixture.counts(), { quotes: 0, operations: 0, active: 0, proofs: 0 })
    } finally {
      await fixture.close()
    }
  }
})

test('advances the generic active-work cursor across non-quote work and unpaid pages', async () => {
  const fixture = await createFixture()
  try {
    const coordinator = fixture.coordinator()
    for (let index = 0; index < 257; index += 1) {
      await coordinator.create({ mintUrl: MINT_URL, amountMsat: 1 })
    }
    const unjoinedOperationId = await insertUnjoinedGenericOperation(fixture)

    let database = await openDaemonStateSqlite(fixture.directory)
    let firstCursor: string
    let paidQuoteId: string
    try {
      database
        .prepare(
          `UPDATE custody_active_work SET next_attempt_at_ms = 1
           WHERE operation_id IN (SELECT custody_operation_id FROM daemon_bolt11_mint_quotes)`,
        )
        .run()
      database
        .prepare(`UPDATE custody_active_work SET next_attempt_at_ms = 0 WHERE operation_id = ?`)
        .run(unjoinedOperationId)
      const custody = new DurableCustodySqliteStore(database)
      const quoteStore = new NativeBolt11MintQuoteSqliteStore(database)
      const firstPage = custody.listActiveWorkPage(fixture.scope.scopeId)
      assert.equal(firstPage.rows.length, 256)
      assert.ok(firstPage.nextCursor)
      assert.ok(firstPage.rows.some(({ operationId }) => operationId === unjoinedOperationId))
      firstCursor = firstPage.nextCursor
      const secondPage = custody.listActiveWorkPage(fixture.scope.scopeId, firstCursor)
      const secondQuotes = quoteStore.getActiveByCustodyOperationIds(
        fixture.scope.scopeId,
        secondPage.rows.map(({ operationId }) => operationId),
      )
      assert.ok(secondQuotes.length > 0)
      paidQuoteId = secondQuotes[0]!.quote.quoteId
    } finally {
      database.close()
    }

    fixture.setState(paidQuoteId, 'PAID')
    const first = await coordinator.recoverActivePage({ cursor: null })
    assert.equal(first.nextCursor, firstCursor)
    assert.equal(first.hasMore, true)
    assert.ok(first.outcomes.length < 256)
    assert.ok(first.outcomes.every((item) => item.outcome === 'unpaid'))
    assert.equal(fixture.calls.complete, 0)

    const second = await coordinator.recoverActivePage({ cursor: first.nextCursor })
    assert.equal(second.nextCursor, null)
    assert.equal(second.hasMore, false)
    assert.ok(second.outcomes.some((item) => item.outcome === 'recovered'))
    assert.equal(fixture.calls.prepare, 257)
    assert.equal(fixture.calls.complete, 1)
    assert.equal((await fixture.counts()).proofs, 1)
  } finally {
    await fixture.close()
  }
})

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-native-bolt11-coordinator-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const initialized = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT_URL,
    walletSeedHex: WALLET_SEED_HEX,
    nostrSecretKeyHex: NOSTR_SECRET_HEX,
    initializedAtMs: 1,
  })
  const walletId = deriveDurableCustodyWalletId(Buffer.from(WALLET_SEED_HEX, 'hex'))
  const scope = {
    scopeKind: 'wallet' as const,
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId }),
  }
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: initialized.walletScopeId,
    incarnationId: 'native-bolt11-coordinator-test',
    observedAtMs: 2,
  })
  let quoteNumber = 0
  let currentTime = 10
  let duplicateMint = false
  let restoreValid = true
  let nextQuoteCreationError: string | null = null
  let nextQuoteUnit: string | null = null
  let nextInvoice: string | null = null
  let nextPreparedQuote: string | null = null
  const quoteStates = new Map<string, 'UNPAID' | 'PAID' | 'ISSUED'>()
  const outputs = new Map<string, OutputData>()
  const calls = { walletFor: 0, load: 0, quote: 0, prepare: 0, check: 0, complete: 0, restore: 0 }
  const wallet = {
    mint: { mintUrl: MINT_URL },
    loadMint: async () => {
      calls.load += 1
    },
    createMintQuoteBolt11: async (amountMsat: number) => {
      calls.quote += 1
      if (nextQuoteCreationError !== null) {
        const message = nextQuoteCreationError
        nextQuoteCreationError = null
        throw new Error(message)
      }
      const quote = `quote-${++quoteNumber}`
      quoteStates.set(quote, 'UNPAID')
      const unit = nextQuoteUnit ?? 'msat'
      nextQuoteUnit = null
      return {
        quote,
        request: nextInvoice ?? `lnbc-${quote}`,
        unit,
        amount: amountMsat,
        state: 'UNPAID' as const,
        expiry: 1_800_000_000,
      }
    },
    prepareMint: async (
      _method: 'bolt11',
      amountMsat: number,
      quote: { quote: string; expiry?: number | null },
      config: {
        onCountersReserved: (range: {
          keysetId: string
          start: number
          count: number
          next: number
        }) => void
      },
    ) => {
      calls.prepare += 1
      const reserved = await reserveDaemonKeysetCounter(
        KEYSET_ID,
        1,
        { fence, observedAtMs: ++currentTime },
        { normalizedMint: MINT_URL, unit: 'msat' },
      )
      config.onCountersReserved({
        keysetId: KEYSET_ID,
        ...reserved,
        next: reserved.start + reserved.count,
      })
      const output = OutputData.createSingleData(
        amountMsat,
        KEYSET_ID,
        `secret:${quote.quote}`,
        BigInt(reserved.start + 101),
      )
      outputs.set(quote.quote, output)
      const previewQuote = nextPreparedQuote ?? quote.quote
      nextPreparedQuote = null
      return {
        method: 'bolt11',
        payload: { quote: previewQuote, outputs: [output.blindedMessage] },
        outputData: [output],
        keysetId: KEYSET_ID,
        quote: {
          quote: quote.quote,
          ...(quote.expiry === undefined ? {} : { expiry: quote.expiry }),
        },
      }
    },
    checkMintQuote: async (quoteId: string) => {
      calls.check += 1
      return { quote: quoteId, state: quoteStates.get(quoteId) ?? 'UNPAID' }
    },
    completeMint: async (preview: { payload: { quote: string } }) => {
      calls.complete += 1
      if (duplicateMint) throw new MintOperationError(11001, 'Invoice already paid or pending')
      const output = outputs.get(preview.payload.quote)
      if (output === undefined) throw new Error('fixture output plan is absent')
      return [proofForOutput(output)]
    },
    getKeyset: (id?: string) =>
      id === KEYSET_ID ? { id, unit: 'msat', keys: KEYS, fee: 0, verify: () => true } : undefined,
  }
  const restoreExactOutputs = async (input: {
    mintUrl: string
    unit: string
    outputs: readonly {
      secret: string
      blindedMessage: { id: string; amount: string; B_: string }
      blindingFactor: string
    }[]
  }) => {
    calls.restore += 1
    assert.equal(input.mintUrl, MINT_URL)
    assert.equal(input.unit, 'msat')
    if (!restoreValid) return []
    const restored = input.outputs.map((saved) => {
      const output = outputs.get(`quote-${saved.secret.slice('secret:quote-'.length)}`)
      assert.ok(output)
      assert.equal(Buffer.from(output.secret).toString('utf8'), saved.secret)
      assert.equal(output.blindedMessage.B_, saved.blindedMessage.B_)
      return proofForOutput(output)
    })
    return restored
  }
  const coordinator = (
    options: {
      readonly injectFault?: (
        phase: 'transaction-opened' | 'before-commit' | 'after-commit',
      ) => void
    } = {},
  ) =>
    new NativeBolt11MintQuoteCoordinator({
      directory,
      getFence: () => fence,
      walletFor: async (mintUrl, unit) => {
        calls.walletFor += 1
        assert.equal(mintUrl, MINT_URL)
        assert.equal(unit, 'msat')
        return wallet
      },
      restoreExactOutputs,
      now: () => ++currentTime,
      ...options,
    })
  return {
    directory,
    scope,
    fence,
    calls,
    coordinator,
    setState: (quoteId: string, state: 'UNPAID' | 'PAID' | 'ISSUED') =>
      quoteStates.set(quoteId, state),
    setDuplicateMint: (value: boolean) => (duplicateMint = value),
    setRestoreValid: (value: boolean) => (restoreValid = value),
    failNextQuoteCreation: (message = 'fixture quote creation failed') => {
      nextQuoteCreationError = message
    },
    setNextQuoteOverrides: (value: { unit?: string; preparedQuote?: string; invoice?: string }) => {
      nextInvoice = value.invoice ?? null
      nextQuoteUnit = value.unit ?? null
      nextPreparedQuote = value.preparedQuote ?? null
    },
    counts: async () => ({
      quotes: await countScoped(
        directory,
        'SELECT count(*) AS count FROM daemon_bolt11_mint_quotes',
      ),
      operations: await countScoped(directory, 'SELECT count(*) AS count FROM custody_operations'),
      active: await countScoped(directory, 'SELECT count(*) AS count FROM custody_active_work'),
      proofs: await countScoped(directory, 'SELECT count(*) AS count FROM custody_proofs'),
    }),
    counter: async () => {
      const database = await openDaemonStateSqlite(directory)
      try {
        return (
          database
            .prepare(
              `SELECT next_counter AS count FROM custody_keyset_counters
               WHERE scope_id = ? AND normalized_mint = ? AND unit = 'msat' AND keyset_id = ?`,
            )
            .get(scope.scopeId, MINT_URL, KEYSET_ID) as { count: number }
        ).count
      } finally {
        database.close()
      }
    },
    operationResultState: async () => {
      const database = await openDaemonStateSqlite(directory)
      try {
        return database
          .prepare('SELECT result_state AS state FROM custody_operations WHERE scope_id = ?')
          .get(scope.scopeId) as { state: string }
      } finally {
        database.close()
      }
    },
    close: async () => {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function insertUnjoinedGenericOperation(
  fixture: Awaited<ReturnType<typeof createFixture>>,
): Promise<string> {
  const quote = createDurableBolt11MintQuote({
    mintUrl: MINT_URL,
    unit: 'msat',
    requestedAmount: '1',
    quoteId: 'unjoined-generic-operation',
    invoiceRequest: 'lnbc-unjoined',
  })
  const output = OutputData.createSingleData(1, KEYSET_ID, 'secret:unjoined', 987n)
  const operation = serializeDurableWalletMintOperation({
    operationId: quote.walletMintOperationId,
    mintUrl: MINT_URL,
    unit: 'msat',
    preview: {
      method: 'bolt11',
      payload: { quote: quote.quoteId, outputs: [output.blindedMessage] },
      outputData: [output],
      keysetId: KEYSET_ID,
      quote: { quote: quote.quoteId },
    },
  })
  const custodyOperation = toDurableCustodyProofOperationInput(operation)
  const authority = prepareDurableCustodyMintOperationAuthority({
    operation: custodyOperation,
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
  const record = createDurableCustodyProofOperation({
    scope: fixture.scope,
    operation: custodyOperation,
    facts: authority.facts,
    inventoryAccountId: null,
    exactBoundary: {
      method: 'POST',
      path: '/v1/mint/bolt11',
      idempotencyKey: operation.operationId,
      requestBody: authority.exactRequest,
      output: authority.exactOutput,
      privateMaterial: authority.exactAuthority,
    },
  })
  const observedAtMs = Date.now()
  await withDurableCustodyUnitOfWork(fixture.directory, fixture.fence, observedAtMs, (database) => {
    const transaction = new DurableCustodyTransactionSqlite(
      database,
      fixture.scope.scopeId,
      observedAtMs,
    )
    applyDurableCustodyTransaction(
      transaction,
      {
        scope: record.scope,
        owner: {
          incarnationId: fixture.fence.incarnationId,
          fencingEpoch: fixture.fence.fencingEpoch,
          observedAtMs,
        },
        operationRows: [{ operationId: record.operation.operationId, expectedRevision: null }],
      },
      (selected) =>
        bindDurableCustodyProofOperation(selected, record, {
          requestBody: authority.exactRequest,
          output: authority.exactOutput,
          privateMaterial: authority.exactAuthority,
        }),
    )
    database
      .prepare(
        'UPDATE custody_active_work SET next_attempt_at_ms = 0 WHERE scope_id = ? AND operation_id = ?',
      )
      .run(fixture.scope.scopeId, record.operation.operationId)
  })
  return record.operation.operationId
}

function proofForOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    KEYSET_ID,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY)
  return output.toProof(
    {
      id: KEYSET_ID,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: KEYSET_ID, keys: KEYS },
  )
}

async function countScoped(directory: string, sql: string): Promise<number> {
  const database = await openDaemonStateSqlite(directory)
  try {
    return (database.prepare(sql).get() as { count: number }).count
  } finally {
    database.close()
  }
}

test('oversize optional invoice metadata cannot prevent an exact mint credit', async () => {
  const fixture = await createFixture()
  try {
    fixture.setNextQuoteOverrides({ invoice: `lnbc${'a'.repeat(8192)}` })
    const created = await fixture.coordinator().create({ mintUrl: MINT_URL, amountMsat: 1 })
    fixture.setState(created.quoteId, 'PAID')
    const recovered = await fixture.coordinator().recoverActivePage({ cursor: null })
    assert.equal(recovered.outcomes[0]?.outcome, 'recovered')
    assert.equal((await fixture.counts()).proofs, 1)
    const rows = await readActivityRows(fixture.directory)
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.item.amountSubunits, 1)
    assert.equal(rows[0]?.item.lightningInvoice, null)
    assert.equal(rows[0]?.item.txId, created.quoteId)
  } finally {
    await fixture.close()
  }
})
