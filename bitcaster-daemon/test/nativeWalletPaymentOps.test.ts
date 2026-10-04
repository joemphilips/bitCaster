import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  Amount,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  pointFromHex,
  type MeltQuoteResponse,
  type Proof,
} from '@cashu/cashu-ts'
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyProofId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  encodeBoundedDurableArtifact,
  type DurableCustodyProofMaterial,
} from '@bitcaster-market/client-sdk/durableCustody'
import { NativeBolt11MintQuoteCoordinator } from '../src/nativeBolt11MintQuoteCoordinator.ts'
import { NativeWalletPaymentOps } from '../src/nativeWalletPaymentOps.ts'
import type { NativeWalletPaymentWallet } from '../src/nativeWalletPaymentOps.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import {
  admitExactAvailableWalletProofsFromDatabase,
  readAvailableWalletProofsFenced,
  reserveDaemonKeysetCounter,
} from '../src/state.ts'

const MINT_URL = 'https://mint.example'
const WALLET_SEED_HEX = '31'.repeat(64)
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEYS = Object.fromEntries(
  ['1', '1024', '2048'].map((amount) => [
    amount,
    bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)),
  ]),
)
const KEYSET_ID = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1, input_fee_ppk: 1 })
const INPUT_AMOUNT = 2_048
const QUOTE_AMOUNT = 1_000
const FEE_RESERVE = 23
const INPUT_FEE = 1
const TOTAL_DEBIT = QUOTE_AMOUNT + FEE_RESERVE + INPUT_FEE
const INVOICE = 'lnbc-service-test-invoice'
const QUOTE_ID = 'service-quote-1'
const QUOTE_EXPIRY = 1_900_000_000

test('quote reports exact msat debit facts without preparing outputs or reserving proofs', async () => {
  const fixture = await createFixture()
  try {
    const quote = await fixture.ops.quote({ invoice: INVOICE })
    assert.deepEqual(quote, {
      operationId: fixture.operationId,
      walletId: fixture.walletId,
      mintUrl: MINT_URL,
      unit: 'msat',
      method: 'bolt11',
      invoice: INVOICE,
      quoteId: QUOTE_ID,
      amountMsat: QUOTE_AMOUNT,
      feeReserveMsat: FEE_RESERVE,
      selectedInputFeeMsat: INPUT_FEE,
      totalWalletDebitMsat: TOTAL_DEBIT,
      expiryUnixSeconds: QUOTE_EXPIRY,
      state: 'UNPAID',
    })
    assert.deepEqual(fixture.calls, {
      load: 1,
      createQuote: 1,
      checkQuote: 0,
      select: 1,
      prepare: 0,
      counter: 0,
      complete: 0,
    })
    assert.deepEqual(await fixture.availableSecrets(), ['melt-input'])
    assert.equal(await fixture.operationCount(), 0)
  } finally {
    await fixture.close()
  }
})

test('approved payment saves exact work and terminal retry loads no wallet or transport', async () => {
  const fixture = await createFixture()
  try {
    const quote = await fixture.ops.quote({ invoice: INVOICE })
    const approval = { ...quote, approvedMaxDebitMsat: 1_200 }
    const paid = await fixture.ops.pay(approval)
    assert.deepEqual(paid, {
      operationId: fixture.operationId,
      state: 'paid',
      changeCount: 1,
    })
    const countsAfterPayment = { ...fixture.calls }
    assert.deepEqual(countsAfterPayment, {
      load: 2,
      createQuote: 1,
      checkQuote: 2,
      select: 2,
      prepare: 1,
      counter: 1,
      complete: 1,
    })

    const status = await fixture.ops.status({ operationId: fixture.operationId })
    assert.ok(status)
    assert.equal(status.walletId, fixture.walletId)
    assert.equal(status.invoice, INVOICE)
    assert.equal(status.expiryUnixSeconds, QUOTE_EXPIRY)
    assert.equal(status.selectedInputFeeMsat, INPUT_FEE)
    assert.equal(status.totalWalletDebitMsat, TOTAL_DEBIT)
    assert.equal(status.approvedMaxDebitMsat, 1_200)
    assert.equal(status.resultState, 'applied')
    assert.equal('proofs' in status, false)
    assert.equal('outputData' in status, false)

    assert.deepEqual(await fixture.availableSecrets(), ['melt-change'])
    assert.deepEqual(await fixture.ops.pay(approval), paid)
    assert.deepEqual(fixture.calls, countsAfterPayment)
    assert.deepEqual(await fixture.availableSecrets(), ['melt-change'])
  } finally {
    await fixture.close()
  }
})

test('a debit cap below amount, reserve, and selected fee fails before output preparation', async () => {
  const fixture = await createFixture()
  try {
    const quote = await fixture.ops.quote({ invoice: INVOICE })
    await assert.rejects(
      fixture.ops.pay({ ...quote, approvedMaxDebitMsat: QUOTE_AMOUNT + FEE_RESERVE }),
      /below the quoted total debit/,
    )
    assert.equal(fixture.calls.prepare, 0)
    assert.equal(fixture.calls.counter, 0)
    assert.equal(fixture.calls.complete, 0)
    assert.deepEqual(await fixture.availableSecrets(), ['melt-input'])
    assert.equal(await fixture.operationCount(), 0)
  } finally {
    await fixture.close()
  }
})

test('pay rejects a changed invoice against the exact mint quote before preparing outputs', async () => {
  const fixture = await createFixture()
  try {
    const quote = await fixture.ops.quote({ invoice: INVOICE })
    await assert.rejects(
      fixture.ops.pay({
        ...quote,
        invoice: 'lnbc-different-invoice',
        approvedMaxDebitMsat: 1_200,
      }),
      /quote authority is foreign or malformed/,
    )
    assert.equal(fixture.calls.prepare, 0)
    assert.equal(fixture.calls.counter, 0)
    assert.deepEqual(await fixture.availableSecrets(), ['melt-input'])
    assert.equal(await fixture.operationCount(), 0)
  } finally {
    await fixture.close()
  }
})

test('recovery skips valid mint work and advances the shared active-work cursor', async () => {
  const fixture = await createFixture()
  try {
    let quoteIndex = 0
    const minter = new NativeBolt11MintQuoteCoordinator({
      directory: fixture.directory,
      getFence: () => fixture.fence,
      now: fixture.nextTime,
      walletFor: async () => ({
        mint: { mintUrl: MINT_URL },
        loadMint: async () => undefined,
        createMintQuoteBolt11: async (amountMsat) => {
          const quote = `non-melt-${++quoteIndex}`
          return {
            quote,
            request: `lnbc-${quote}`,
            amount: amountMsat,
            unit: 'msat',
            state: 'UNPAID' as const,
            expiry: QUOTE_EXPIRY,
          }
        },
        prepareMint: async (_method, amountMsat, quote, config) => {
          const range = await reserveDaemonKeysetCounter(
            KEYSET_ID,
            1,
            { fence: fixture.fence, observedAtMs: fixture.nextTime() },
            { normalizedMint: MINT_URL, unit: 'msat' },
          )
          config.onCountersReserved({
            keysetId: KEYSET_ID,
            ...range,
            next: range.start + range.count,
          })
          const output = OutputData.createSingleData(
            amountMsat,
            KEYSET_ID,
            `non-melt-output:${quote.quote}`,
            BigInt(range.start + 10_000),
          )
          return {
            method: 'bolt11',
            payload: { quote: quote.quote, outputs: [output.blindedMessage] },
            outputData: [output],
            keysetId: KEYSET_ID,
            quote: { quote: quote.quote, expiry: quote.expiry },
          }
        },
        checkMintQuote: async (quote) => ({ quote, state: 'UNPAID' as const }),
        completeMint: async () => [],
        getKeyset: (id) =>
          id === KEYSET_ID
            ? { id, unit: 'msat', keys: KEYS, fee: 1, verify: () => true }
            : undefined,
      }),
      restoreExactOutputs: async () => [],
    })
    for (let index = 0; index < 257; index += 1) {
      await minter.create({ mintUrl: MINT_URL, amountMsat: 1 })
    }

    const first = await fixture.ops.recoverActivePage({ cursor: null })
    assert.deepEqual(first.outcomes, [])
    assert.ok(first.nextCursor)
    assert.equal(first.hasMore, true)
    const second = await fixture.ops.recoverActivePage({ cursor: first.nextCursor })
    assert.deepEqual(second.outcomes, [])
    assert.equal(second.nextCursor, null)
    assert.equal(second.hasMore, false)
    assert.deepEqual(fixture.calls, {
      load: 0,
      createQuote: 0,
      checkQuote: 0,
      select: 0,
      prepare: 0,
      counter: 0,
      complete: 0,
    })
  } finally {
    await fixture.close()
  }
})

test('recovery reports malformed saved melt approval as an error', async () => {
  const fixture = await createFixture()
  try {
    const quote = await fixture.ops.quote({ invoice: INVOICE })
    fixture.wallet.completeMelt = async () => {
      fixture.calls.complete += 1
      throw new Error('simulated uncertain transport')
    }
    assert.deepEqual(await fixture.ops.pay({ ...quote, approvedMaxDebitMsat: 1_200 }), {
      operationId: quote.operationId,
      state: 'pending',
      changeCount: 0,
    })
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      const row = database
        .prepare(
          `SELECT artifact_id AS artifactId, body
           FROM custody_artifacts WHERE artifact_kind = 'private-material' LIMIT 1`,
        )
        .get() as { artifactId: string; body: Uint8Array }
      const artifact = JSON.parse(new TextDecoder().decode(row.body)) as {
        applicationAuthority: { expiryUnixSeconds: number }
      }
      artifact.applicationAuthority.expiryUnixSeconds = 'bad' as unknown as number
      const body = encodeBoundedDurableArtifact(artifact, 64 * 1_024)
      database
        .prepare('UPDATE custody_artifacts SET body = ?, fingerprint = ? WHERE artifact_id = ?')
        .run(body, deriveDurableCustodyArtifactFingerprint(artifact), row.artifactId)
    })

    const recovered = await fixture.ops.recoverActivePage({ cursor: null })
    assert.equal(recovered.outcomes.length, 1)
    assert.equal(recovered.outcomes[0]?.outcome, 'error')
    assert.equal(recovered.outcomes[0]?.error, 'native wallet payment recovery failed')
    assert.equal(fixture.calls.load, 2)
    assert.equal(fixture.calls.complete, 1)
  } finally {
    await fixture.close()
  }
})

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-native-wallet-payment-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT_URL,
    walletSeedHex: WALLET_SEED_HEX,
    nostrSecretKeyHex: '42'.repeat(32),
    initializedAtMs: 1,
  })
  const walletId = deriveDurableCustodyWalletId(Buffer.from(WALLET_SEED_HEX, 'hex'))
  const scopeId = deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId })
  let nowMs = 10
  const fence = await claimCustodyScopeLease(directory, {
    scopeId,
    incarnationId: 'native-wallet-payment-test',
    observedAtMs: nowMs,
  })
  const inputOutput = OutputData.createSingleData(INPUT_AMOUNT, KEYSET_ID, 'melt-input', 0x12345n)
  const inputProof = signedProof(inputOutput)
  const changeOutput = OutputData.createSingleData(0, KEYSET_ID, 'melt-change', 0x23456n)
  const changeProof = signedProof(changeOutput, 1_024)
  const calls = {
    load: 0,
    createQuote: 0,
    checkQuote: 0,
    select: 0,
    prepare: 0,
    counter: 0,
    complete: 0,
  }
  const quoteResponse = (quote = QUOTE_ID, state: MeltQuoteResponse['state'] = 'UNPAID') =>
    ({
      quote,
      amount: Amount.from(QUOTE_AMOUNT),
      fee_reserve: Amount.from(FEE_RESERVE),
      unit: 'msat',
      state,
      request: INVOICE,
      expiry: QUOTE_EXPIRY,
      payment_preimage: null,
    }) satisfies MeltQuoteResponse
  const wallet: NativeWalletPaymentWallet = {
    async loadMint() {
      calls.load += 1
    },
    async createMeltQuoteBolt11(invoice) {
      calls.createQuote += 1
      return quoteResponse()
    },
    async checkMeltQuote(_method, quote) {
      calls.checkQuote += 1
      return quoteResponse(quote)
    },
    selectProofsToSend(proofs, amountToSend, includeFees) {
      calls.select += 1
      assert.equal(amountToSend, QUOTE_AMOUNT + FEE_RESERVE)
      assert.equal(includeFees, true)
      const selected = proofs.filter(({ secret }) => secret === inputProof.secret)
      return { keep: [], send: selected }
    },
    async prepareMelt(_method, quote, proofs) {
      calls.prepare += 1
      calls.counter += 1
      assert.equal(quote.quote, QUOTE_ID)
      assert.equal(proofs.length, 1)
      assert.equal(proofs[0]?.secret, inputProof.secret)
      return {
        method: 'bolt11',
        inputs: [...proofs],
        outputData: [changeOutput],
        keysetId: KEYSET_ID,
        quote: { quote: quote.quote, amount: quote.amount },
      }
    },
    async completeMelt(preview) {
      calls.complete += 1
      return {
        quote: { quote: preview.quote.quote, state: 'PAID' },
        change: [changeProof],
      }
    },
    createMeltChangeProofs(outputs, signatures) {
      return [(outputs[0] as OutputData).toProof(signatures[0]!, { id: KEYSET_ID, keys: KEYS })]
    },
    getKeyset(id) {
      return {
        id: id ?? KEYSET_ID,
        unit: 'msat',
        keys: KEYS,
        fee: 1,
        verify: () => true,
      }
    },
  }
  await withDaemonStateSqliteTransaction(directory, (database) => {
    const row = createCustodyProofSqliteRow({
      scopeId,
      normalizedMint: MINT_URL,
      unit: 'msat',
      proof: custodyMaterial(inputProof),
      baseAsset: 'sat',
      conditionId: null,
      outcomeSetId: null,
      productBinding: null,
      signatureVerified: true,
      dleqState: 'verified',
      nut07State: 'UNSPENT',
      selectability: 'selectable',
      storageClass: 'pinned-operation-bound-deterministic',
      reservationOperationId: null,
      revision: 0,
      nowMs,
    })
    new DurableCustodySqliteStore(database).putProofBatchCas([
      { proof: row, expectedRevision: null },
    ])
    admitExactAvailableWalletProofsFromDatabase(database, {
      mintUrl: MINT_URL,
      proofs: [inputProof],
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      nowMs,
    })
  })
  const profile = {
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT_URL,
    initializedAt: new Date(1).toISOString(),
  }
  const secrets = { walletSeedHex: WALLET_SEED_HEX }
  const ops = new NativeWalletPaymentOps({
    profile,
    secrets,
    directory,
    getFence: () => fence,
    now: () => ++nowMs,
    walletFor: async () => wallet,
  })
  const operationId = `wallet-melt:${deriveDurableCustodyArtifactFingerprint({
    mintUrl: MINT_URL,
    unit: 'msat',
    quote: { quote: QUOTE_ID, amount: String(QUOTE_AMOUNT) },
  })}`
  return {
    directory,
    walletId,
    operationId,
    fence,
    nextTime: () => ++nowMs,
    wallet,
    calls,
    ops,
    availableSecrets: async () =>
      (
        await readAvailableWalletProofsFenced({
          mintUrl: MINT_URL,
          asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
          mutation: { fence, observedAtMs: ++nowMs },
        })
      ).map(({ proof }) => proof.secret),
    operationCount: async () =>
      withDaemonStateSqliteTransaction(
        directory,
        (database) =>
          database.prepare('SELECT COUNT(*) AS count FROM custody_operations').get() as {
            count: number
          },
      ).then(({ count }) => count),
    close: async () => {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function custodyMaterial(proof: Proof): DurableCustodyProofMaterial {
  return {
    id: proof.id,
    amount: proof.amount,
    secret: proof.secret,
    C: proof.C,
    dleq: proof.dleq ?? null,
    p2pkE: proof.p2pk_e ?? null,
    witness: proof.witness ?? null,
  }
}

function signedProof(output: OutputData, amount = Number(output.blindedMessage.amount)): Proof {
  const blinded = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    KEYSET_ID,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY)
  return output.toProof(
    {
      id: KEYSET_ID,
      amount: Amount.from(amount),
      C_: blinded.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: KEYSET_ID, keys: KEYS },
  )
}
