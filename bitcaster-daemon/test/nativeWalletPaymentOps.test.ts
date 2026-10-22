import {
  recoverAllDaemonWalletFromSeed,
  type AllKeysetSeedRecoveryTransport,
} from '../src/emergencySeedRecovery.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { DAEMON_PROFILE_DATABASE } from '../src/profileSchema.ts'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  Amount,
  Mint as CashuMint,
  Wallet as CashuWallet,
  Keyset,
  hashToCurve,
  type SerializedBlindedMessage,
  type CounterSource,
  type MeltPreview,
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
import { createWallet } from '../src/walletOps.ts'
import { NativeWalletPaymentOps } from '../src/nativeWalletPaymentOps.ts'
import type { NativeWalletPaymentWallet } from '../src/nativeWalletPaymentOps.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease, renewCustodyScopeLease } from '../src/profileFencing.ts'
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
const PRIVATE_KEYS = Object.fromEntries(
  ['1', '1024', '2048'].map((amount, index) => [
    amount,
    Uint8Array.from([...new Uint8Array(31), index + 7]),
  ]),
)
const KEYS = Object.fromEntries(
  Object.entries(PRIVATE_KEYS).map(([amount, key]) => [
    amount,
    bytesToHex(secp256k1.getPublicKey(key, true)),
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
      load: 3,
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

    assert.deepEqual(await fixture.availableSecrets(), [fixture.changeProof().secret])
    assert.deepEqual(await fixture.ops.pay(approval), paid)
    assert.deepEqual(fixture.calls, countsAfterPayment)
    assert.deepEqual(await fixture.availableSecrets(), [fixture.changeProof().secret])
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
      walletFor: async (_mintUrl, _unit, source) => ({
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
          assert.ok(source)
          const range = await source.reserve(KEYSET_ID, 1)
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
          id === undefined || id === KEYSET_ID
            ? { id: KEYSET_ID, unit: 'msat', keys: KEYS, fee: 1, verify: () => true }
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
    assert.equal(fixture.calls.load, 3)
    assert.equal(fixture.calls.complete, 1)
  } finally {
    await fixture.close()
  }
})

test('default seeded wallet commits NUT08 blanks and signed change atomically', async () => {
  const f = await createFixture(true)
  try {
    const quote = await f.ops.quote({ invoice: INVOICE })
    const result = await f.ops.pay({ ...quote, approvedMaxDebitMsat: 1200 })
    assert.equal(result.state, 'paid')
    assert.equal(result.changeCount, 1)
    assert.equal(f.draftPoints[0]!.length, 11)
    assert.equal(f.signatures.size, 1)
    assert.equal(f.calls.complete, 1)
  } finally {
    await f.close()
  }
})

test('real no-change withdrawal accepts inactive V2 keyset without counter allocation', async () => {
  const f = await createFixture(true, true)
  try {
    const quote = await f.ops.quote({ invoice: INVOICE })
    const result = await f.ops.pay({ ...quote, approvedMaxDebitMsat: INPUT_AMOUNT })
    assert.deepEqual(result, { operationId: quote.operationId, state: 'paid', changeCount: 0 })
    assert.equal(f.draftPoints[0]!.length, 0)
    assert.deepEqual(await f.counterRows(), [])
    assert.equal(f.calls.complete, 1)
  } finally {
    await f.close()
  }
})

test('melt preparation rollback restores paired counters, exact inputs and all custody authority', async () => {
  const f = await createFixture(true)
  try {
    const quote = await f.ops.quote({ invoice: INVOICE })
    const before = await f.facts()
    f.injectFault((phase) => {
      if (phase === 'before-commit') throw new Error('melt atomic rollback')
    })
    await assert.rejects(
      f.ops.pay({ ...quote, approvedMaxDebitMsat: 1200 }),
      /melt atomic rollback/,
    )
    assert.deepEqual(await f.facts(), before)
    assert.equal(f.calls.complete, 0)
  } finally {
    await f.close()
  }
})

test('melt lost COMMIT reply selects saved authority without a new range', async () => {
  const f = await createFixture(true)
  try {
    const quote = await f.ops.quote({ invoice: INVOICE })
    let faults = 0
    f.injectFault((phase) => {
      if (phase === 'after-commit') {
        faults += 1
        throw new Error('lost melt COMMIT')
      }
    })
    assert.equal((await f.ops.pay({ ...quote, approvedMaxDebitMsat: 1200 })).state, 'paid')
    assert.equal(faults, 1)
    assert.equal(f.calls.prepare, 1)
    assert.equal(f.calls.complete, 1)
    assert.equal(Number((await f.counterRows())[0]!.next_counter), 11)
  } finally {
    await f.close()
  }
})

test('lost COMMIT readback propagates corrupt saved authority before mint', async () => {
  const f = await createFixture(true)
  try {
    const quote = await f.ops.quote({ invoice: INVOICE })
    let corrupted = false
    f.injectFault((phase) => {
      if (phase !== 'after-commit') return
      const database = new DatabaseSync(join(f.directory, DAEMON_PROFILE_DATABASE))
      try {
        database
          .prepare("UPDATE custody_artifacts SET body = ? WHERE artifact_kind = 'private-material'")
          .run(Buffer.from('{}'))
        corrupted = true
      } finally {
        database.close()
      }
      throw new Error('uncertain corrupt COMMIT')
    })
    await assert.rejects(f.ops.pay({ ...quote, approvedMaxDebitMsat: 1200 }), /artifact|authority/)
    assert.equal(corrupted, true)
    assert.equal(f.calls.complete, 0)
    assert.equal(f.calls.prepare, 1)
    assert.equal(Number((await f.counterRows())[0]!.next_counter), 11)
    assert.equal(await f.operationCount(), 1)
  } finally {
    await f.close()
  }
})

test('pending public melt retry reuses saved blanks without fresh preparation', async () => {
  const f = await createFixture(true)
  try {
    const quote = await f.ops.quote({ invoice: INVOICE })
    const approval = { ...quote, approvedMaxDebitMsat: 1200 }
    f.failTransport(true)
    assert.equal((await f.ops.pay(approval)).state, 'pending')
    f.failTransport(false)
    assert.equal((await f.makeOps().pay(approval)).state, 'paid')
    assert.equal(f.calls.prepare, 1)
    assert.equal(f.submitted.length, 2)
    assert.deepEqual(f.submitted[0], f.submitted[1])
    assert.equal(Number((await f.counterRows())[0]!.next_counter), 11)
  } finally {
    await f.close()
  }
})

test('melt three typed counter conflicts never submit or reserve inputs', async () => {
  const f = await createFixture(true)
  try {
    const quote = await f.ops.quote({ invoice: INVOICE })
    f.observePrepared(async () => {
      await reserveDaemonKeysetCounter(
        KEYSET_ID,
        1,
        { fence: f.fence, observedAtMs: f.nextTime() },
        { normalizedMint: MINT_URL, unit: 'msat' },
      )
    })
    await assert.rejects(f.ops.pay({ ...quote, approvedMaxDebitMsat: 1200 }), /counter snapshot/)
    assert.equal(f.calls.prepare, 3)
    assert.equal(f.calls.complete, 0)
    assert.equal(await f.operationCount(), 0)
    assert.deepEqual(await f.availableSecrets(), ['melt-input'])
    assert.equal(Number((await f.counterRows())[0]!.next_counter), 3)
  } finally {
    await f.close()
  }
})

test('melt differing saved winner replays exact saved blank outputs', async () => {
  const f = await createFixture(true)
  try {
    const quote = await f.ops.quote({ invoice: INVOICE })
    const approval = { ...quote, approvedMaxDebitMsat: 1200 }
    f.observePrepared(async () => {
      f.observePrepared(undefined)
      await reserveDaemonKeysetCounter(
        KEYSET_ID,
        1,
        { fence: f.fence, observedAtMs: f.nextTime() },
        { normalizedMint: MINT_URL, unit: 'msat' },
      )
      f.failTransport(true)
      assert.equal((await f.makeOps().pay(approval)).state, 'pending')
      f.failTransport(false)
    })
    assert.equal((await f.ops.pay(approval)).state, 'paid')
    assert.equal(f.draftPoints.length, 2)
    assert.notDeepEqual(f.draftPoints[0], f.draftPoints[1])
    assert.deepEqual(f.submitted, [f.draftPoints[1], f.draftPoints[1]])
    assert.equal(Number((await f.counterRows())[0]!.next_counter), 12)
    assert.equal(await f.operationCount(), 1)
  } finally {
    await f.close()
  }
})

test('no-change retains existing durable legacy selected-keyset refusal before commit', async () => {
  const f = await createFixture(true, true, true)
  try {
    const quote = await f.ops.quote({ invoice: INVOICE })
    const before = await f.facts()
    await assert.rejects(
      f.ops.pay({ ...quote, approvedMaxDebitMsat: INPUT_AMOUNT }),
      /durable wallet melt keyset id must be a canonical NUT-02 V2/,
    )
    assert.deepEqual(await f.facts(), before)
    assert.equal(f.calls.complete, 0)
  } finally {
    await f.close()
  }
})

test('melt refuses owner switch after draft and permits same-identity lease renewal', async () => {
  for (const changed of [false, true]) {
    const f = await createFixture(true)
    try {
      const quote = await f.ops.quote({ invoice: INVOICE })
      const before = await f.facts()
      f.observePrepared(async () => {
        f.setFence(
          changed
            ? { ...f.fence, scopeId: 'foreign' }
            : await renewCustodyScopeLease(f.directory, f.fence, f.nextTime()),
        )
      })
      const result = f.ops.pay({ ...quote, approvedMaxDebitMsat: 1200 })
      if (changed) {
        await assert.rejects(result, /operation fence changed/)
        assert.deepEqual(await f.facts(), before)
        assert.equal(f.calls.complete, 0)
      } else assert.equal((await result).state, 'paid')
    } finally {
      await f.close()
    }
  }
})

test('completed real NUT08 change is recovered by production regular-msat seed scanner', async () => {
  const f = await createFixture(true)
  let recoveryDirectory: string | undefined
  try {
    const quote = await f.ops.quote({ invoice: INVOICE })
    assert.equal((await f.ops.pay({ ...quote, approvedMaxDebitMsat: 1200 })).state, 'paid')
    const expected = await readAvailableWalletProofsFenced({
      mintUrl: MINT_URL,
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      mutation: { fence: f.fence, observedAtMs: f.nextTime() },
    })
    recoveryDirectory = await mkdtemp(join(tmpdir(), 'melt-change-seed-scan-'))
    await bootstrapFreshDaemonProfile({
      directory: recoveryDirectory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT_URL,
      walletSeedHex: WALLET_SEED_HEX,
      nostrSecretKeyHex: '42'.repeat(32),
      initializedAtMs: 1,
    })
    const fence = await claimCustodyScopeLease(recoveryDirectory, {
      scopeId: f.fence.scopeId,
      incarnationId: 'melt-change-seed-scan',
      observedAtMs: 2,
    })
    process.env.BITCASTER_DAEMON_HOME = recoveryDirectory
    const keyset = new Keyset(KEYSET_ID, 'msat', true, 1)
    keyset.keys = KEYS
    const transport: AllKeysetSeedRecoveryTransport = {
      wallet: {
        loadMint: async () => undefined,
        keyChain: { getKeyset: () => keyset, ensureKeysetKeys: async () => keyset },
        checkProofsStates: async (proofs) =>
          proofs.map((proof) => ({
            Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
            state: 'UNSPENT' as const,
          })),
      },
      listRegularKeysets: async () => ({
        keysets: [{ id: KEYSET_ID, unit: 'msat', active: true, keys: KEYS, input_fee_ppk: 1 }],
      }),
      listConditionalKeysets: async () => {
        throw new Error('must not list conditions')
      },
      getConditionalKeyset: async () => {
        throw new Error('must not load conditions')
      },
      restoreCandidates: async (candidates) => {
        const outputs = (candidates as SerializedBlindedMessage[]).filter((output) =>
          f.signatures.has(output.B_),
        )
        return { outputs, signatures: outputs.map((output) => f.signatures.get(output.B_)!) }
      },
    }
    const result = await recoverAllDaemonWalletFromSeed(
      {
        recoveryId: 'completed-melt-change',
        mintUrl: MINT_URL,
        unit: 'msat',
        walletSeedHex: WALLET_SEED_HEX,
        disclosureAcknowledged: true,
      },
      { directory: recoveryDirectory, getFence: () => fence, nowMs: () => 3, transport },
    )
    assert.equal(result.state, 'completed')
    assert.equal(result.scannedRanges[0]!.keysetId, KEYSET_ID)
    const actual = await readAvailableWalletProofsFenced({
      mintUrl: MINT_URL,
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      mutation: { fence, observedAtMs: 3 },
    })
    const identity = (rows: typeof actual) =>
      rows
        .map((row) => ({
          id: row.proof.id,
          amount: row.proof.amount.toString(),
          secret: row.proof.secret,
          C: row.proof.C,
        }))
        .sort((a, b) => a.secret.localeCompare(b.secret))
    assert.deepEqual(identity(actual), identity(expected))
    assert.equal(actual.length, 1)
  } finally {
    if (recoveryDirectory) await rm(recoveryDirectory, { recursive: true, force: true })
    await f.close()
  }
})

async function createFixture(realWallet = false, noChange = false, legacySelection = false) {
  const keysetId = noChange
    ? deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1, input_fee_ppk: 0 })
    : KEYSET_ID
  const outputKeysetId = legacySelection
    ? deriveKeysetId(KEYS, { unit: 'msat', versionByte: 0 })
    : keysetId
  const fee = noChange ? 0 : 1
  const quoteAmount = noChange ? INPUT_AMOUNT : QUOTE_AMOUNT
  const feeReserve = noChange ? 0 : FEE_RESERVE
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
  let fence = await claimCustodyScopeLease(directory, {
    scopeId,
    incarnationId: 'native-wallet-payment-test',
    observedAtMs: nowMs,
  })
  const inputOutput = OutputData.createSingleData(INPUT_AMOUNT, keysetId, 'melt-input', 0x12345n)
  const inputProof = signedProof(inputOutput)
  let changeOutput = OutputData.createSingleData(0, keysetId, 'melt-change', 0x23456n)
  let changeProof = signedProof(changeOutput, 1_024)
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
      amount: Amount.from(quoteAmount),
      fee_reserve: Amount.from(feeReserve),
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
      assert.equal(amountToSend, quoteAmount + feeReserve)
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
        keysetId: keysetId,
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
      return [(outputs[0] as OutputData).toProof(signatures[0]!, { id: keysetId, keys: KEYS })]
    },
    getKeyset(id) {
      return {
        id: id ?? keysetId,
        unit: 'msat',
        keys: KEYS,
        fee,
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
  let observer: ((operation: unknown) => Promise<void>) | undefined
  let fault: ((phase: import('../src/stateSqlite.ts').StateSqliteFaultPhase) => void) | undefined
  let failTransport = false
  const submitted: string[][] = []
  const draftPoints: string[][] = []
  const signatures = new Map<string, ReturnType<typeof signatureForOutput>>()
  const makeOps = () =>
    new NativeWalletPaymentOps({
      profile,
      secrets,
      directory,
      getFence: () => fence,
      now: () => ++nowMs,
      observePrepared: async (operation) => {
        await observer?.(operation)
      },
      injectPreparationFault: (phase) => {
        fault?.(phase)
      },
      walletFor: async (_mint, _unit, source) => {
        if (!realWallet)
          return {
            ...wallet,
            prepareMelt: async (method, quote, proofs, config) => {
              const preview = await wallet.prepareMelt(method, quote, proofs, config)
              assert.ok(source)
              const range = await source.reserve(keysetId, 11)
              config!.onCountersReserved({
                keysetId: keysetId,
                ...range,
                next: range.start + range.count,
              })
              const outputs = OutputData.createDeterministicData(
                0,
                Buffer.from(WALLET_SEED_HEX, 'hex'),
                range.start,
                { id: keysetId, keys: KEYS },
                Array(11).fill(0),
              )
              changeOutput = outputs[0]!
              changeProof = signedProof(changeOutput, 1024)
              return { ...preview, outputData: outputs }
            },
          }
        const mint = new CashuMint(MINT_URL)
        mint.getInfo = async () => ({
          nuts: { '5': { methods: [{ method: 'bolt11', unit: 'msat' }], disabled: false } },
        })
        mint.getKeySets = async () => ({
          keysets: [
            { id: keysetId, unit: 'msat', active: !noChange, input_fee_ppk: fee },
            ...(legacySelection
              ? [{ id: outputKeysetId, unit: 'msat', active: false, input_fee_ppk: 0 }]
              : []),
          ],
        })
        mint.getKeys = async () => ({
          keysets: [
            { id: keysetId, unit: 'msat', keys: KEYS },
            ...(legacySelection ? [{ id: outputKeysetId, unit: 'msat', keys: KEYS }] : []),
          ],
        })
        mint.melt = async (_method, payload) => {
          calls.complete += 1
          if (noChange) return { ...quoteResponse(payload.quote, 'PAID'), change: [] }
          submitted.push(payload.outputs!.map((output) => output.B_))
          if (failTransport) throw new Error('controlled mint transport failure')
          const blindedMessage = { ...payload.outputs![0]!, amount: Amount.from(0) }
          const signature = signatureForOutput({ blindedMessage }, 1024)
          signatures.set(blindedMessage.B_, signature)
          return { ...quoteResponse(payload.quote, 'PAID'), change: [signature] }
        }
        let lastPreview: MeltPreview<MeltQuoteResponse> | undefined
        const actual = (noChange
          ? new CashuWallet(mint, {
              unit: 'msat',
              keysetId: outputKeysetId,
              bip39seed: Buffer.from(WALLET_SEED_HEX, 'hex'),
              counterSource: source,
            })
          : createWallet(
              MINT_URL,
              secrets,
              { getCustodyFence: () => fence, createCashuMint: () => mint },
              'sat',
              'msat',
              undefined,
              source,
            )) as unknown as NativeWalletPaymentWallet
        actual.createMeltQuoteBolt11 = wallet.createMeltQuoteBolt11
        actual.checkMeltQuote = wallet.checkMeltQuote
        const prepare = actual.prepareMelt.bind(actual)
        actual.prepareMelt = async (...args) => {
          lastPreview = await prepare(...args)
          calls.prepare += 1
          calls.counter += 1
          draftPoints.push(lastPreview.outputData.map((output) => output.blindedMessage.B_))
          return lastPreview
        }
        return actual
      },
    })
  const ops = makeOps()
  const operationId = `wallet-melt:${deriveDurableCustodyArtifactFingerprint({
    mintUrl: MINT_URL,
    unit: 'msat',
    quote: { quote: QUOTE_ID, amount: String(quoteAmount) },
  })}`
  return {
    directory,
    facts: async () =>
      withDaemonStateSqliteTransaction(directory, (database) =>
        Object.fromEntries(
          [
            'target_keyset_counters',
            'custody_keyset_counters',
            'target_proof_operations',
            'target_wallet_proofs',
            'custody_proofs',
            'custody_operations',
            'custody_operation_inputs',
            'custody_artifacts',
            'custody_operation_artifact_links',
            'custody_active_work',
          ].map((table) => [
            table,
            database
              .prepare(`SELECT * FROM ${table}`)
              .all()
              .map((row) => JSON.stringify(row))
              .sort(),
          ]),
        ),
      ),
    counterRows: async () =>
      withDaemonStateSqliteTransaction(directory, (database) =>
        database.prepare('SELECT * FROM custody_keyset_counters').all(),
      ),
    walletId,
    makeOps,
    observePrepared: (value: typeof observer) => {
      observer = value
    },
    injectFault: (value: typeof fault) => {
      fault = value
    },
    draftPoints,
    signatures,
    submitted,
    failTransport: (value: boolean) => {
      failTransport = value
    },
    changeProof: () => changeProof,
    operationId,
    fence,
    setFence: (value: typeof fence) => {
      fence = value
    },
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
      await Promise.allSettled([ops.status({ operationId })])
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
  return output.toProof(signatureForOutput(output, amount), {
    id: output.blindedMessage.id,
    keys: KEYS,
  })
}

function signatureForOutput(output: Pick<OutputData, 'blindedMessage'>, amount: number) {
  const blinded = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEYS[String(amount)]!,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEYS[String(amount)]!,
  )
  return {
    id: output.blindedMessage.id,
    amount: Amount.from(amount),
    C_: blinded.C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  }
}
