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
import type { DurableCustodyProofMaterial } from '@bitcaster-market/client-sdk/durableCustodyProofMaterial'
import {
  applyDurableCustodyTransaction,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  deriveDurableCustodyProofId,
  deriveDurableCustodyArtifactFingerprint,
  encodeBoundedDurableArtifact,
} from '@bitcaster-market/client-sdk/durableCustody'
import { NativeBolt11MintQuoteCoordinator } from '../src/nativeBolt11MintQuoteCoordinator.ts'
import {
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import { serializeDurableCustodyOutput } from '@bitcaster-market/client-sdk/durableCustodyProofOperation'
import {
  decodeDurableWalletOperation,
  serializeDurableWalletProof,
  toDurableCustodyProofOperationInput,
  type DurableWalletMeltOperation,
} from '@bitcaster-market/client-sdk/durableWalletOperation'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from '../src/durableCustodyTransactionSqlite.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import {
  NativeWalletMeltCoordinator,
  type NativeWalletMeltWallet,
} from '../src/nativeWalletMeltCoordinator.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import {
  admitExactAvailableWalletProofsFromDatabase,
  reserveDaemonKeysetCounter,
  readAvailableWalletProofsFenced,
} from '../src/state.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'

const MINT_URL = 'https://mint.example'
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEYS = Object.fromEntries(
  ['1024', '2048'].map((amount) => [amount, bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true))]),
)
const KEYSET_ID = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1, input_fee_ppk: 1 })
const QUOTE_AMOUNT = 1_000
const FEE_RESERVE = 23
const INPUT_FEE = 1
const TOTAL_DEBIT = QUOTE_AMOUNT + FEE_RESERVE + INPUT_FEE

test('preparation binds quote fees and approval before reservation, not selected input face value', async () => {
  const fixture = await createFixture()
  try {
    const prepared = await fixture.coordinator.prepare({
      operation: fixture.operation,
      wallet: fixture.wallet(),
      approvalContext: fixture.approvalContext,
      approvedMaxDebitMsat: 1_200,
    })
    assert.deepEqual(prepared, {
      operationId: fixture.operation.operationId,
      totalWalletDebitMsat: TOTAL_DEBIT,
    })
    const rows = await fixture.readRows()
    assert.equal(rows.operationCount, 1)
    assert.equal(rows.reservationCount, 1)
    assert.equal(rows.predecessorState, 'locked')
    assert.equal(rows.approval?.totalWalletDebitMsat, TOTAL_DEBIT)
    assert.equal(rows.approval?.approvedMaxDebitMsat, 1_200)
    assert.deepEqual(await fixture.availableProofSecrets(), [])
    assert.deepEqual(
      await fixture.coordinator.prepare({
        operation: fixture.operation,
        wallet: fixture.wallet({
          async checkMeltQuote() {
            throw new Error('exact preparation retry must use saved quote authority')
          },
        }),
        approvalContext: fixture.approvalContext,
        approvedMaxDebitMsat: 1_200,
      }),
      prepared,
    )
    await assert.rejects(
      fixture.coordinator.prepare({
        operation: fixture.operation,
        wallet: fixture.wallet(),
        approvalContext: fixture.approvalContext,
        approvedMaxDebitMsat: 1_300,
      }),
      /conflicts with saved quote or approval/,
    )
    assert.equal((await fixture.readRows()).reservationCount, 1)
  } finally {
    await fixture.close()
  }
})

test('approved debit overrun leaves custody input unreserved', async () => {
  const fixture = await createFixture()
  try {
    await assert.rejects(
      fixture.coordinator.prepare({
        operation: fixture.operation,
        wallet: fixture.wallet(),
        approvalContext: fixture.approvalContext,
        approvedMaxDebitMsat: TOTAL_DEBIT - 1,
      }),
      /exceeds the approved maximum debit/,
    )
    const rows = await fixture.readRows()
    assert.equal(rows.operationCount, 0)
    assert.equal(rows.reservationCount, 0)
    assert.equal(rows.predecessorState, 'selectable')
    assert.deepEqual(await fixture.availableProofSecrets(), ['melt-input'])
  } finally {
    await fixture.close()
  }
})

test('preparation rejects foreign quote authority before reserving inputs', async () => {
  const fixture = await createFixture()
  try {
    await assert.rejects(
      fixture.coordinator.prepare({
        operation: fixture.operation,
        wallet: fixture.wallet({
          async checkMeltQuote() {
            return fixture.quote('foreign-quote', 'UNPAID')
          },
        }),
        approvalContext: fixture.approvalContext,
        approvedMaxDebitMsat: 1_200,
      }),
      /quote authority is foreign or not unpaid/,
    )
    const rows = await fixture.readRows()
    assert.equal(rows.operationCount, 0)
    assert.equal(rows.reservationCount, 0)
    assert.equal(rows.predecessorState, 'selectable')
    assert.deepEqual(await fixture.availableProofSecrets(), ['melt-input'])
  } finally {
    await fixture.close()
  }
})

test('preparation rejects caller proof material that differs from canonical custody', async () => {
  const fixture = await createFixture()
  try {
    const forged = decodeDurableWalletOperation({
      ...fixture.operation,
      preview: {
        ...fixture.operation.preview,
        inputs: [{ ...fixture.operation.preview.inputs[0]!, C: `02${'99'.repeat(32)}` }],
      },
    }) as DurableWalletMeltOperation
    await assert.rejects(
      fixture.coordinator.prepare({
        operation: forged,
        wallet: fixture.wallet(),
        approvalContext: fixture.approvalContext,
        approvedMaxDebitMsat: 1_200,
      }),
      /exact input is unavailable/,
    )
    const rows = await fixture.readRows()
    assert.equal(rows.operationCount, 0)
    assert.equal(rows.reservationCount, 0)
    assert.equal(rows.predecessorState, 'selectable')
    assert.deepEqual(await fixture.availableProofSecrets(), ['melt-input'])
  } finally {
    await fixture.close()
  }
})

test('paid response verifies exact change, retires inputs, admits once, and terminal retry has no transport', async () => {
  const fixture = await createFixture()
  try {
    await fixture.prepare()
    const calls: string[] = []
    const result = await fixture.coordinator.execute({
      operationId: fixture.operation.operationId,
      wallet: fixture.wallet({
        async completeMelt(preview) {
          calls.push('complete')
          assert.equal(preview.quote.quote, fixture.operation.preview.quote.quote)
          assert.equal(preview.outputData[0]?.blindedMessage.amount.toString(), '0')
          return {
            quote: { quote: fixture.operation.preview.quote.quote, state: 'PAID' },
            change: [fixture.changeProof],
          }
        },
      }),
    })
    assert.equal(result.state, 'paid')
    assert.equal(result.proofs[0]?.amount.toString(), '1024')
    const rows = await fixture.readRows()
    assert.equal(rows.predecessorState, 'spent')
    assert.equal(rows.reservationCount, 0)
    assert.equal(rows.successorCount, 1)
    assert.equal(rows.targetProofCount, 1)
    assert.deepEqual(await fixture.availableProofSecrets(), ['melt-change'])
    const replay = await fixture.coordinator.recover({
      operationId: fixture.operation.operationId,
      wallet: fixture.wallet({
        async checkMeltQuote() {
          calls.push('status')
          throw new Error('applied melt must not check the mint')
        },
        async completeMelt() {
          calls.push('complete-again')
          throw new Error('applied melt must not submit again')
        },
      }),
    })
    assert.equal(replay.state, 'paid')
    assert.deepEqual(
      replay.proofs.map(({ secret }) => secret),
      [fixture.changeProof.secret],
    )
    assert.deepEqual(calls, ['complete'])
  } finally {
    await fixture.close()
  }
})

test('retained wallet proofs pay only after their exact projection rows are reserved', async () => {
  const fixture = await createFixture('retained')
  try {
    await fixture.prepare()
    assert.deepEqual(await fixture.availableProofSecrets(), [])
    const result = await fixture.coordinator.execute({
      operationId: fixture.operation.operationId,
      wallet: fixture.wallet(),
    })
    assert.equal(result.state, 'paid')
    const rows = await fixture.readRows()
    assert.equal(rows.predecessorState, 'spent')
    assert.equal(rows.reservationCount, 0)
    assert.equal(rows.targetProofCount, 1)
    assert.deepEqual(await fixture.availableProofSecrets(), ['melt-change'])
  } finally {
    await fixture.close()
  }
})

test('paid native mint invoice outputs can fund a retained-input melt', async () => {
  const fixture = await createFixture()
  try {
    const quoteStates = new Map<string, 'UNPAID' | 'PAID'>([])
    const quoteOutputs = new Map<string, OutputData>()
    const mintWallet = {
      mint: { mintUrl: MINT_URL },
      async loadMint() {},
      async createMintQuoteBolt11(amountMsat: number) {
        const quote = 'invoice-funded-melt-source'
        quoteStates.set(quote, 'UNPAID')
        return {
          quote,
          request: `lnbc-${quote}`,
          unit: 'msat' as const,
          amount: amountMsat,
          state: 'UNPAID' as const,
          expiry: 1_800_000_000,
        }
      },
      async prepareMint(
        _method: 'bolt11',
        amountMsat: number,
        quote: { quote: string; expiry?: number | null },
        config: {
          readonly onCountersReserved: (range: {
            readonly keysetId: string
            readonly start: number
            readonly count: number
            readonly next: number
          }) => void
        },
      ) {
        const range = await reserveDaemonKeysetCounter(
          KEYSET_ID,
          1,
          { fence: fixture.fence, observedAtMs: Date.now() },
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
          `invoice:${quote.quote}`,
          BigInt(range.start + 123),
        )
        quoteOutputs.set(quote.quote, output)
        return {
          method: 'bolt11' as const,
          payload: { quote: quote.quote, outputs: [output.blindedMessage] },
          outputData: [output],
          keysetId: KEYSET_ID,
          quote: { quote: quote.quote, expiry: quote.expiry },
        }
      },
      async checkMintQuote(quote: string) {
        return { quote, state: quoteStates.get(quote) ?? 'UNPAID' }
      },
      async completeMint(preview: { payload: { quote: string } }) {
        const output = quoteOutputs.get(preview.payload.quote)
        assert.ok(output)
        return [signedProof(output)]
      },
      getKeyset(id?: string) {
        if (id !== KEYSET_ID) return undefined
        return { id, unit: 'msat', keys: KEYS, fee: 1, verify: () => true }
      },
    }
    const mintQuotes = new NativeBolt11MintQuoteCoordinator({
      directory: fixture.directory,
      getFence: () => fixture.fence,
      walletFor: async () => mintWallet,
      restoreExactOutputs: async ({ outputs }) =>
        outputs.map((saved) => {
          const output = [...quoteOutputs.values()].find(
            (candidate) => Buffer.from(candidate.secret).toString('utf8') === saved.secret,
          )
          assert.ok(output)
          return signedProof(output)
        }),
    })
    const invoice = await mintQuotes.create({ mintUrl: MINT_URL, amountMsat: 2_048 })
    quoteStates.set(invoice.quoteId, 'PAID')
    const recovered = await mintQuotes.recoverActivePage({ cursor: null })
    assert.equal(recovered.outcomes[0]?.outcome, 'recovered')

    const availableAfterMint = await readAvailableWalletProofsFenced({
      mintUrl: MINT_URL,
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      mutation: { fence: fixture.fence, observedAtMs: Date.now() },
    })
    const mintedProof = availableAfterMint.find(({ proof }) =>
      proof.secret.startsWith('invoice:'),
    )?.proof
    assert.ok(mintedProof)
    const mintedCustodyProofId = deriveDurableCustodyProofId({
      scopeId: fixture.fence.scopeId,
      normalizedMint: MINT_URL,
      unit: 'msat',
      keysetId: mintedProof.id!,
      secret: mintedProof.secret,
    })
    const before = await withDaemonStateSqliteTransaction(
      fixture.directory,
      (database) =>
        database
          .prepare('SELECT selectability FROM custody_proofs WHERE scope_id = ? AND proof_id = ?')
          .get(fixture.fence.scopeId, mintedCustodyProofId) as { selectability: string },
    )
    assert.equal(before.selectability, 'retained')

    const meltOperation = decodeDurableWalletOperation({
      ...fixture.operation,
      operationId: 'wallet-melt:paid-invoice-output',
      preview: {
        ...fixture.operation.preview,
        inputs: [serializeDurableWalletProof(mintedProof as unknown as Proof)],
        quote: { quote: 'melt-from-paid-invoice', amount: String(QUOTE_AMOUNT) },
      },
    }) as DurableWalletMeltOperation
    await fixture.coordinator.prepare({
      operation: meltOperation,
      wallet: fixture.wallet(),
      approvalContext: fixture.approvalContext,
      approvedMaxDebitMsat: 1_200,
    })
    const payment = await fixture.coordinator.execute({
      operationId: meltOperation.operationId,
      wallet: fixture.wallet(),
    })
    assert.equal(payment.state, 'paid')
    const after = await withDaemonStateSqliteTransaction(
      fixture.directory,
      (database) =>
        database
          .prepare('SELECT selectability FROM custody_proofs WHERE scope_id = ? AND proof_id = ?')
          .get(fixture.fence.scopeId, mintedCustodyProofId) as { selectability: string },
    )
    assert.equal(after.selectability, 'spent')
    assert.deepEqual(
      (await fixture.availableProofSecrets()).sort(),
      ['melt-change', 'melt-input'].sort(),
    )
  } finally {
    await fixture.close()
  }
})

test('paid quote recovery completes the saved change output plan and admits it once', async () => {
  const fixture = await createFixture()
  try {
    await fixture.prepare()
    await assert.rejects(
      fixture.coordinator.execute({
        operationId: fixture.operation.operationId,
        wallet: fixture.wallet({
          async completeMelt() {
            throw new Error('lost payment response')
          },
        }),
      }),
      /lost payment response/,
    )
    let restoredOutputSecret = ''
    const reopened = new NativeWalletMeltCoordinator(fixture.directory, () => fixture.fence)
    const recovered = await reopened.recover({
      operationId: fixture.operation.operationId,
      wallet: fixture.wallet({
        async checkMeltQuote(method, quote) {
          assert.equal(method, 'bolt11')
          assert.equal(quote, fixture.operation.preview.quote.quote)
          return fixture.quote(quote, 'PAID', [
            {
              id: KEYSET_ID,
              amount: Amount.from(1_024),
              C_: fixture.changeSignature.C_,
              dleq: fixture.changeSignature.dleq,
            },
          ])
        },
        createMeltChangeProofs(outputs, signatures) {
          restoredOutputSecret = new TextDecoder().decode((outputs[0] as OutputData).secret)
          return [(outputs[0] as OutputData).toProof(signatures[0]!, { id: KEYSET_ID, keys: KEYS })]
        },
        async completeMelt() {
          throw new Error('paid quote recovery must not resubmit')
        },
      }),
    })
    assert.equal(recovered.state, 'paid')
    assert.equal(restoredOutputSecret, 'melt-change')
    assert.equal((await fixture.readRows()).successorCount, 1)
  } finally {
    await fixture.close()
  }
})

test('staged result recovery admits saved change without mint transport', async () => {
  const fixture = await createFixture()
  try {
    await fixture.prepare()
    const scopeId = fixture.fence.scopeId
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      const store = new DurableCustodySqliteStore(database)
      const record = store.getOperation(fixture.custodyOperationId)
      assert.ok(record)
      const authority = prepareDurableCustodyMintOperationAuthority({
        operation: fixture.custodyInput,
        keysets: fixture.keysets,
        applicationAuthority: fixture.approval,
      })
      const prepared = prepareDurableCustodyVerifiedMintResult({
        record,
        exactAuthority: authority.exactAuthority,
        result: { change: [fixture.changeProof] },
      })
      const observedAtMs = Date.now()
      const authorization = {
        incarnationId: fixture.fence.incarnationId,
        fencingEpoch: fixture.fence.fencingEpoch,
        observedAtMs,
      }
      const transaction = new DurableCustodyTransactionSqlite(database, scopeId, observedAtMs, [
        record,
      ])
      applyDurableCustodyTransaction(
        transaction,
        {
          scope: record.scope,
          owner: authorization,
          operationRows: [
            { operationId: record.operation.operationId, expectedRevision: record.revision },
          ],
        },
        (selected) =>
          selected.transitionOperation({
            operationId: record.operation.operationId,
            expectedRevision: record.revision,
            transition: {
              kind: 'mark-transport-attempted',
              authorization,
              expectedRevision: record.revision,
            },
          }),
      )
      const attempted = transaction.getOperation(record.operation.operationId)
      assert.ok(attempted)
      stageDurableCustodyPreparedMintResult({
        transaction,
        record: attempted,
        prepared,
        authorization,
      })
    })
    const reopened = new NativeWalletMeltCoordinator(fixture.directory, () => fixture.fence)
    const recovered = await reopened.recover({
      operationId: fixture.operation.operationId,
      wallet: fixture.wallet({
        async checkMeltQuote() {
          throw new Error('staged recovery must not check quote')
        },
        async completeMelt() {
          throw new Error('staged recovery must not submit')
        },
      }),
    })
    assert.equal(recovered.state, 'paid')
    assert.deepEqual(
      recovered.proofs.map(({ secret }) => secret),
      [fixture.changeProof.secret],
    )
    const rows = await fixture.readRows()
    assert.equal(rows.successorCount, 1)
    assert.equal(rows.reservationCount, 0)
    assert.deepEqual(await fixture.availableProofSecrets(), ['melt-change'])
  } finally {
    await fixture.close()
  }
})

test('UNPAID status alone and PENDING keep inputs reserved; only explicit UNPAID response releases', async () => {
  const fixture = await createFixture()
  try {
    await fixture.prepare()
    await assert.rejects(
      fixture.coordinator.execute({
        operationId: fixture.operation.operationId,
        wallet: fixture.wallet({
          async completeMelt() {
            throw new Error('uncertain first attempt')
          },
        }),
      }),
      /uncertain first attempt/,
    )
    await assert.rejects(
      fixture.coordinator.recover({
        operationId: fixture.operation.operationId,
        wallet: fixture.wallet({
          async checkMeltQuote(_method, quote) {
            return fixture.quote(quote, 'PENDING')
          },
          async completeMelt() {
            throw new Error('pending must not retry')
          },
        }),
      }),
      /remains pending/,
    )
    assert.equal((await fixture.readRows()).predecessorState, 'locked')
    await assert.rejects(
      fixture.coordinator.recover({
        operationId: fixture.operation.operationId,
        wallet: fixture.wallet({
          async checkMeltQuote(_method, quote) {
            return fixture.quote(quote, 'UNPAID')
          },
          async completeMelt() {
            throw new Error('uncertain retry')
          },
        }),
      }),
      /uncertain retry/,
    )
    assert.equal((await fixture.readRows()).predecessorState, 'locked')
    const released = await fixture.coordinator.recover({
      operationId: fixture.operation.operationId,
      wallet: fixture.wallet({
        async checkMeltQuote(_method, quote) {
          return fixture.quote(quote, 'UNPAID')
        },
        async completeMelt(preview) {
          assert.equal(preview.quote.quote, fixture.operation.preview.quote.quote)
          return {
            quote: { quote: fixture.operation.preview.quote.quote, state: 'UNPAID' },
            change: [],
          }
        },
      }),
    })
    assert.deepEqual(released, {
      state: 'unpaid',
      proofs: [],
      operationId: fixture.operation.operationId,
    })
    const rows = await fixture.readRows()
    assert.equal(rows.predecessorState, 'selectable')
    assert.equal(rows.reservationCount, 0)
    assert.equal(rows.operationState, 'aborted')
    assert.deepEqual(await fixture.availableProofSecrets(), ['melt-input'])
  } finally {
    await fixture.close()
  }
})

test('foreign wallet-mirror reservation blocks release and rolls back custody transition', async () => {
  const fixture = await createFixture()
  try {
    await fixture.prepare()
    await assert.rejects(
      fixture.coordinator.execute({
        operationId: fixture.operation.operationId,
        wallet: fixture.wallet({
          async completeMelt() {
            throw new Error('uncertain payment response')
          },
        }),
      }),
      /uncertain payment response/,
    )
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      database
        .prepare(
          `UPDATE target_wallet_proofs SET reserved_by = ?
           WHERE scope_id = ? AND secret = ? AND state = 'reserved'`,
        )
        .run('foreign-reservation', fixture.fence.scopeId, 'melt-input')
    })

    await assert.rejects(
      fixture.coordinator.recover({
        operationId: fixture.operation.operationId,
        wallet: fixture.wallet({
          async checkMeltQuote(_method, quote) {
            return fixture.quote(quote, 'UNPAID')
          },
          async completeMelt(preview) {
            return { quote: { quote: preview.quote.quote, state: 'UNPAID' }, change: [] }
          },
        }),
      }),
      /mirror reservation does not match the exact input set/,
    )
    const rows = await fixture.readRows()
    assert.equal(rows.predecessorState, 'locked')
    assert.equal(rows.reservationCount, 1)
    assert.equal(rows.operationState, 'transport-attempted')
    assert.deepEqual(await fixture.availableProofSecrets(), [])
    const mirror = await withDaemonStateSqliteTransaction(
      fixture.directory,
      (database) =>
        database
          .prepare(
            'SELECT state, reserved_by AS reservedBy FROM target_wallet_proofs WHERE scope_id = ? AND secret = ?',
          )
          .get(fixture.fence.scopeId, 'melt-input') as {
          state: string
          reservedBy: string
        },
    )
    assert.equal(mirror.state, 'reserved')
    assert.equal(mirror.reservedBy, 'foreign-reservation')
  } finally {
    await fixture.close()
  }
})

test('reload rejects malformed persisted approval authority before transport', async () => {
  const fixture = await createFixture()
  try {
    await fixture.prepare()
    await withDaemonStateSqliteTransaction(fixture.directory, (database) => {
      const row = database
        .prepare(
          'SELECT artifact_id AS artifactId, body FROM custody_artifacts WHERE artifact_kind = ?',
        )
        .get('private-material') as { artifactId: string; body: Uint8Array }
      const artifact = JSON.parse(new TextDecoder().decode(row.body)) as {
        applicationAuthority: { approvedMaxDebitMsat: number }
      }
      artifact.applicationAuthority.approvedMaxDebitMsat = TOTAL_DEBIT - 1
      const encoded = encodeBoundedDurableArtifact(artifact, 64 * 1_024)
      database
        .prepare('UPDATE custody_artifacts SET body = ?, fingerprint = ? WHERE artifact_id = ?')
        .run(encoded, deriveDurableCustodyArtifactFingerprint(artifact), row.artifactId)
    })
    let calls = 0
    await assert.rejects(
      fixture.coordinator.recover({
        operationId: fixture.operation.operationId,
        wallet: fixture.wallet({
          async checkMeltQuote(_method, quote) {
            calls += 1
            return fixture.quote(quote, 'PAID')
          },
          async completeMelt() {
            calls += 1
            throw new Error('invalid approval must stop transport')
          },
        }),
      }),
      /approval authority exceeds its maximum/,
    )
    assert.equal(calls, 0)
    assert.equal((await fixture.readRows()).predecessorState, 'locked')
  } finally {
    await fixture.close()
  }
})

async function createFixture(selectability: 'selectable' | 'retained' = 'selectable') {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-melt-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const seed = '31'.repeat(64)
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT_URL,
    walletSeedHex: seed,
    nostrSecretKeyHex: '42'.repeat(32),
  })
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: 'wallet',
    walletId: deriveDurableCustodyWalletId(Buffer.from(seed, 'hex')),
  })
  const fence = await claimCustodyScopeLease(directory, {
    scopeId,
    incarnationId: 'native-melt-test',
    observedAtMs: Date.now(),
  })
  const inputOutput = OutputData.createSingleData(2_048, KEYSET_ID, 'melt-input', 0x12345n)
  const inputProof = signedProof(inputOutput)
  const changeOutput = OutputData.createSingleData(0, KEYSET_ID, 'melt-change', 0x23456n)
  const changeProof = signedProof(changeOutput, 1_024)
  const changeSignature = blindSignature(changeOutput, 1_024)
  const operation = decodeDurableWalletOperation({
    schemaVersion: 1,
    operationId: 'wallet-melt:fixture-quote',
    kind: 'wallet-melt',
    mintUrl: MINT_URL,
    unit: 'msat',
    preview: {
      method: 'bolt11',
      inputs: [serializeDurableWalletProof(inputProof)],
      outputData: [{ ...serializeDurableCustodyOutput(changeOutput), ephemeralE: null }],
      keysetId: KEYSET_ID,
      quote: { quote: 'melt-quote-1', amount: String(QUOTE_AMOUNT) },
      requestOptions: { preferAsync: false, extraPayload: {} },
    },
  }) as DurableWalletMeltOperation
  const custodyInput = toDurableCustodyProofOperationInput(operation)
  const keysetAuthority = {
    canonicalMintUrl: MINT_URL,
    id: KEYSET_ID,
    unit: 'msat',
    keys: KEYS,
    inputFeePpk: 1,
    finalExpiry: null,
    identity: { kind: 'regular' as const },
  }
  const approval = {
    schemaVersion: 2 as const,
    kind: 'native-wallet-melt-approval-v2',
    mintUrl: MINT_URL,
    unit: 'msat' as const,
    method: 'bolt11' as const,
    quote: 'melt-quote-1',
    invoice: 'lnbc-test-invoice',
    expiryUnixSeconds: 1_800_000_000,
    quoteAmountMsat: QUOTE_AMOUNT,
    feeReserveMsat: FEE_RESERVE,
    quotedSelectedInputFeeMsat: INPUT_FEE,
    selectedInputFeeMsat: INPUT_FEE,
    totalWalletDebitMsat: TOTAL_DEBIT,
    approvedMaxDebitMsat: 1_200,
  }
  const coordinator = new NativeWalletMeltCoordinator(directory, () => fence)

  const wallet = (overrides: Partial<NativeWalletMeltWallet> = {}): NativeWalletMeltWallet => ({
    async checkMeltQuote(_method, quote) {
      return quoteResponse(quote, 'UNPAID')
    },
    async completeMelt(preview) {
      return { quote: { quote: preview.quote.quote, state: 'PAID' }, change: [changeProof] }
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
    ...overrides,
  })

  await withDaemonStateSqliteTransaction(directory, (database) => {
    const nowMs = Date.now()
    const proof = createCustodyProofSqliteRow({
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
      selectability,
      storageClass: 'pinned-operation-bound-deterministic',
      reservationOperationId: null,
      revision: 0,
      nowMs,
    })
    new DurableCustodySqliteStore(database).putProofBatchCas([{ proof, expectedRevision: null }])
    admitExactAvailableWalletProofsFromDatabase(database, {
      mintUrl: MINT_URL,
      proofs: [inputProof],
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
      nowMs,
    })
  })

  return {
    directory,
    fence,
    operation,
    custodyInput,
    keysets: [keysetAuthority],
    approval,
    changeProof,
    changeSignature,
    coordinator,
    wallet,
    quote: quoteResponse,
    approvalContext: {
      invoice: 'lnbc-test-invoice',
      expiryUnixSeconds: 1_800_000_000,
      amountMsat: QUOTE_AMOUNT,
      feeReserveMsat: FEE_RESERVE,
      quotedSelectedInputFeeMsat: INPUT_FEE,
    },
    prepare: () =>
      coordinator.prepare({
        operation,
        wallet: wallet(),
        approvalContext: {
          invoice: 'lnbc-test-invoice',
          expiryUnixSeconds: 1_800_000_000,
          amountMsat: QUOTE_AMOUNT,
          feeReserveMsat: FEE_RESERVE,
          quotedSelectedInputFeeMsat: INPUT_FEE,
        },
        approvedMaxDebitMsat: 1_200,
      }),
    custodyOperationId: custodyId(scopeId, operation.operationId),
    availableProofSecrets: async () =>
      (
        await readAvailableWalletProofsFenced({
          mintUrl: MINT_URL,
          asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
          mutation: { fence, observedAtMs: Date.now() },
        })
      ).map(({ proof }) => proof.secret),
    readRows: async () =>
      withDaemonStateSqliteTransaction(directory, (database) => {
        const operationRow = database
          .prepare(
            'SELECT operation_state AS operationState FROM custody_operations WHERE operation_id = ?',
          )
          .get(custodyId(scopeId, operation.operationId)) as { operationState: string } | undefined
        const proof = database
          .prepare('SELECT selectability FROM custody_proofs WHERE scope_id = ? AND proof_id = ?')
          .get(scopeId, proofId(scopeId, inputProof)) as { selectability: string }
        const approvalRow = database
          .prepare(
            'SELECT body FROM custody_artifacts WHERE artifact_kind = ? AND scope_id = ? LIMIT 1',
          )
          .get('private-material', scopeId) as { body: Uint8Array } | undefined
        const approvalValue =
          approvalRow === undefined
            ? null
            : ((
                JSON.parse(new TextDecoder().decode(approvalRow.body)) as {
                  applicationAuthority?: {
                    totalWalletDebitMsat?: number
                    approvedMaxDebitMsat?: number
                  }
                }
              ).applicationAuthority ?? null)
        return {
          operationCount: (
            database.prepare('SELECT COUNT(*) AS count FROM custody_operations').get() as {
              count: number
            }
          ).count,
          reservationCount: (
            database.prepare('SELECT COUNT(*) AS count FROM custody_proof_reservations').get() as {
              count: number
            }
          ).count,
          predecessorState: proof.selectability,
          operationState: operationRow?.operationState ?? null,
          successorCount: (
            database
              .prepare('SELECT COUNT(*) AS count FROM custody_proofs WHERE proof_id <> ?')
              .get(proofId(scopeId, inputProof)) as { count: number }
          ).count,
          targetProofCount: (
            database.prepare('SELECT COUNT(*) AS count FROM target_wallet_proofs').get() as {
              count: number
            }
          ).count,
          approval: approvalValue,
        }
      }),
    close: async () => {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function quoteResponse(
  quote: string,
  state: MeltQuoteResponse['state'],
  change?: MeltQuoteResponse['change'],
): MeltQuoteResponse {
  return {
    quote,
    amount: Amount.from(QUOTE_AMOUNT),
    fee_reserve: Amount.from(FEE_RESERVE),
    unit: 'msat',
    state,
    request: 'lnbc-test-invoice',
    expiry: 1_800_000_000,
    payment_preimage: null,
    ...(change === undefined ? {} : { change }),
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
  return output.toProof(blindSignature(output, amount), { id: KEYSET_ID, keys: KEYS })
}

function blindSignature(output: OutputData, amount: number) {
  const blinded = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    KEYSET_ID,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY)
  return {
    id: KEYSET_ID,
    amount: Amount.from(amount),
    C_: blinded.C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  }
}

function proofId(scopeId: string, proof: Proof): string {
  return deriveDurableCustodyProofId({
    scopeId,
    normalizedMint: MINT_URL,
    unit: 'msat',
    keysetId: proof.id,
    secret: proof.secret,
  })
}

function custodyId(scopeId: string, operationId: string): string {
  return deriveDurableCustodyOperationId(scopeId, {
    retainedOperationKey: operationId,
    binding: { kind: 'wallet', activityId: operationId, stage: 'send' },
  })
}
