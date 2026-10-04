import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { nip19 } from 'nostr-tools'
import {
  Amount,
  CheckStateEnum,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type Proof,
  type SwapPreview,
} from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { serializeDurableWalletReceiveOperation } from '@bitcaster-market/client-sdk/durableWalletOperation'
import { derivePaymentRequestReceiveKeyPair } from '@bitcaster-market/client-sdk/paymentRequest'
import { NativePaymentRequestReceiptCoordinator } from '../src/nativePaymentRequestReceiptCoordinator.ts'
import {
  NativePaymentRequestReceiptSqlite,
  paymentRequestReceiptBinding,
} from '../src/nativePaymentRequestReceiptSqlite.ts'
import { DurableWalletProofImportCoordinator } from '../src/durableWalletProofImportCoordinator.ts'
import { DaemonDurableWalletReceiveCoordinator } from '../src/durableWalletReceiveCoordinator.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { emptyDaemonState, reserveDaemonKeysetCounter, writeState } from '../src/state.ts'
import { withDaemonStateSqliteTransaction, type StateSqliteFaultPhase } from '../src/stateSqlite.ts'

const MINT = 'https://mint.example'
const SEED = '11'.repeat(64)
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7])
const KEYS = { '1': bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) }
const REGULAR_ID = deriveKeysetId(KEYS, { unit: 'msat', versionByte: 1 })
const REGULAR = [proof(REGULAR_ID, 'external-a'), proof(REGULAR_ID, 'external-b')]
const CONDITIONAL = ['ab', 'ac'].map((prefix) => {
  const conditionId = prefix.repeat(32)
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId,
    outcomeCollection: 'YES',
  })
  const id = deriveConditionalKeysetId({
    keys: KEYS,
    unit: 'msat',
    conditionId,
    outcomeCollectionId,
  })
  return {
    canonicalMintUrl: MINT,
    id,
    unit: 'msat' as const,
    keys: KEYS,
    inputFeePpk: 0,
    finalExpiry: null,
    identity: {
      kind: 'conditional' as const,
      conditionId,
      outcomeCollection: 'YES',
      outcomeCollectionId,
    },
  }
})
const CONDITIONAL_PROOFS = [
  ...Array.from({ length: 33 }, (_, i) => proof(CONDITIONAL[0]!.id, `position-a-${i}`)),
  proof(CONDITIONAL[1]!.id, 'position-b'),
]

test('request presentation commits before return and remains bound to the seed identity', async () => {
  const f = await fixture()
  try {
    const created = await f.create()
    await assert.rejects(
      f.service().create({ requestId: 'x'.repeat(257), nprofile: created.nprofile }),
      /presentation exceeds bounds/,
    )
    await assert.rejects(
      f.service().create({ requestId: 'large', nprofile: 'x'.repeat(65537) }),
      /presentation exceeds bounds/,
    )
    await assert.rejects(
      f.query((db) =>
        new NativePaymentRequestReceiptSqlite(db).createRequest({
          ...created,
          requestId: 'large-record',
          encoded: 'x'.repeat(64513),
        }),
      ),
      /CHECK constraint/,
    )
    assert.equal(
      (
        await f.query((db) =>
          new NativePaymentRequestReceiptSqlite(db).getRequest(f.fence.scopeId, 'request'),
        )
      )?.encoded,
      created.encoded,
    )
    assert.deepEqual(await f.create(), created)
    const foreign = nip19.nprofileEncode({ pubkey: '22'.repeat(32) })
    await assert.rejects(
      f.service().create({ requestId: 'other', nprofile: foreign }),
      /identity is foreign/,
    )
    await assert.rejects(
      f.service().create({
        requestId: 'request',
        nprofile: nip19.nprofileEncode({
          pubkey: created.receivePublicKey,
          relays: ['wss://other.example'],
        }),
      }),
      /presentation is already bound/,
    )
    assert.equal((await f.service().status('request')).state, 'awaiting')
  } finally {
    await f.close()
  }
})

test('concurrent reordered duplicate receipts replay once before fresh classification or preparation', async () => {
  const f = await fixture()
  try {
    await f.create()
    const [first, second] = await Promise.all([
      f.service().receive(message(REGULAR)),
      f.service().receive(
        JSON.stringify({
          sender: 'not-authority',
          proofs: [...REGULAR].reverse(),
          unit: 'msat',
          mint: MINT,
          id: 'request',
        }),
      ),
    ])
    assert.deepEqual(first, {
      state: 'credited',
      requestId: 'request',
      amountMsat: 2,
      proofCount: 2,
    })
    assert.deepEqual(second, first)
    assert.deepEqual(f.counts, { resolved: 1, prepared: 1, complete: 1, checked: 0 })
    const counters = await f.query((db) =>
      db.prepare('SELECT * FROM custody_keyset_counters').all(),
    )
    await f.query((db) => {
      db.exec(
        "UPDATE custody_proofs SET selectability = 'spent', nut07_state = 'SPENT', revision = revision + 1; DELETE FROM target_wallet_proofs",
      )
    })
    assert.deepEqual(await f.service().receive(message(REGULAR)), first)
    assert.deepEqual(
      await f.query((db) => db.prepare('SELECT * FROM custody_keyset_counters').all()),
      counters,
    )
    assert.equal(await f.targetCount(), 0)
    await assert.rejects(f.service().receive(message([REGULAR[0]!])), /different receipt/)
    await assert.rejects(
      f.service().receive(message([REGULAR[0]!, REGULAR[0]!])),
      /duplicate proofs/,
    )
    assert.deepEqual(f.counts, { resolved: 1, prepared: 1, complete: 1, checked: 0 })
  } finally {
    await f.close()
  }
})

for (const phase of ['before-commit', 'after-commit'] as const) {
  test(`regular bind ${phase} interruption has no orphan receipt or operation and resumes exact counters`, async () => {
    const f = await fixture()
    try {
      await f.create()
      let fired = false
      await assert.rejects(
        f
          .service({
            receiveFault: (observed) => {
              if (!fired && observed === phase) {
                fired = true
                throw new Error('bind crash')
              }
            },
          })
          .receive(message(REGULAR)),
        /bind crash/,
      )
      const bound = await f.query((db) => ({
        receipts: db.prepare('SELECT count(*) n FROM native_payment_request_receipts').get()!.n,
        operations: db.prepare('SELECT count(*) n FROM custody_operations').get()!.n,
      }))
      assert.deepEqual(
        bound,
        phase === 'before-commit' ? { receipts: 0, operations: 0 } : { receipts: 1, operations: 1 },
      )
      assert.equal(f.counts.complete, 0)
      if (phase === 'after-commit') {
        assert.equal((await f.service().recover('request')).state, 'credited')
        assert.equal(f.counts.prepared, 1)
      } else {
        assert.equal((await f.service().receive(message(REGULAR)))?.state, 'credited')
        assert.equal(f.counts.prepared, 2)
      }
      assert.equal(await f.targetCount(), 2)
    } finally {
      await f.close()
    }
  })
}

for (const remaining of [
  CheckStateEnum.UNSPENT,
  CheckStateEnum.PENDING,
  CheckStateEnum.SPENT,
] as const) {
  test(`regular saved receipt recovery with ${remaining} inputs never prepares another range`, async () => {
    const f = await fixture()
    try {
      await f.create()
      f.control.failMint = true
      await assert.rejects(f.service().receive(message(REGULAR)), /mint unavailable/)
      f.control.failMint = false
      f.control.state = remaining
      const status = await f.service().recover('request')
      assert.equal(status.state, remaining === CheckStateEnum.UNSPENT ? 'credited' : 'pending')
      assert.equal(await f.targetCount(), remaining === CheckStateEnum.UNSPENT ? 2 : 0)
      assert.equal(f.counts.prepared, 1)
      assert.equal(f.counts.resolved, 1)
      if (remaining === CheckStateEnum.SPENT)
        assert.equal(
          (await f.service().status('request')).state,
          'pending',
          'recipient-spent must not be credited',
        )
    } finally {
      await f.close()
    }
  })
}

for (const commit of [2, 3]) {
  for (const phase of ['before-commit', 'after-commit'] as const) {
    test(`regular mint-effect interruption at ${phase} ${commit} reuses the saved output range`, async () => {
      const f = await fixture()
      try {
        await f.create()
        let commits = 0
        await assert.rejects(
          f
            .service({
              receiveFault: (observed) => {
                if (observed === phase && ++commits === commit) throw new Error('result crash')
              },
            })
            .receive(message(REGULAR)),
          /result crash/,
        )
        const counters = await f.query((db) =>
          db.prepare('SELECT * FROM custody_keyset_counters').all(),
        )
        f.control.state = CheckStateEnum.SPENT
        f.control.restoreOutputs = true
        assert.equal((await f.service().recover('request')).state, 'credited')
        assert.equal(await f.targetCount(), 2)
        assert.equal(f.counts.prepared, 1)
        assert.equal(f.counts.resolved, 1)
        assert.equal(f.counts.complete, 1)
        assert.deepEqual(
          await f.query((db) => db.prepare('SELECT * FROM custody_keyset_counters').all()),
          counters,
        )
      } finally {
        await f.close()
      }
    })
  }
}

for (const remaining of [
  CheckStateEnum.UNSPENT,
  CheckStateEnum.PENDING,
  CheckStateEnum.SPENT,
  'missing',
] as const) {
  test(`complete multi-group source survives page interruption; remaining ${remaining} controls completion`, async () => {
    const f = await fixture()
    try {
      await f.create()
      let commits = 0
      await assert.rejects(
        f
          .service({
            importFault: (phase) => {
              if (phase === 'before-commit' && ++commits === 5) throw new Error('page crash')
            },
          })
          .receive(message(CONDITIONAL_PROOFS)),
        /page crash/,
      )
      const saved = await f.query((db) => ({
        receipts: db.prepare('SELECT * FROM native_payment_request_receipts').all(),
        groups: db.prepare('SELECT * FROM native_payment_request_receipt_groups').all(),
        pages: db.prepare('SELECT * FROM wallet_proof_import_pages').all(),
        proofs: db.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
      }))
      assert.equal(saved.receipts.length, 1)
      assert.equal(saved.groups.length, 2)
      assert.equal(saved.pages.length, 3)
      assert.equal(saved.proofs.length, 32)
      assert.equal((await f.service().status('request')).state, 'pending')
      await f.query((db) =>
        db.exec(
          "UPDATE custody_proofs SET selectability = 'spent', nut07_state = 'SPENT', revision = revision + 1; DELETE FROM target_wallet_proofs",
        ),
      )
      const revised = await f.query((db) =>
        db.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
      )
      f.control.state = remaining === 'missing' ? CheckStateEnum.UNSPENT : remaining
      f.control.missingStates = remaining === 'missing'
      f.counts.checked = 0
      if (remaining === CheckStateEnum.UNSPENT) {
        assert.equal((await f.service().recover('request')).state, 'credited')
        assert.equal(f.counts.checked, 2)
        assert.equal(await f.targetCount(), 2)
        assert.deepEqual(
          (
            await f.query((db) =>
              db.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
            )
          ).filter((row) => revised.some((old) => old.proof_id === row.proof_id)),
          revised,
        )
        assert.equal(
          (await f.service().receive(message([...CONDITIONAL_PROOFS].reverse())))?.state,
          'credited',
        )
        assert.equal(f.counts.checked, 2)
      } else {
        await assert.rejects(f.service().recover('request'), /not spendable|state response/)
        assert.equal((await f.service().status('request')).state, 'pending')
        assert.equal(await f.targetCount(), 0)
      }
      assert.equal(f.counts.resolved, 1)
      assert.equal(f.counts.prepared, 0)
    } finally {
      await f.close()
    }
  })
}

test('complete conditional acceptance rolls back source roots, page links, and receipt together', async () => {
  const f = await fixture()
  try {
    await f.create()
    await assert.rejects(
      f
        .service({
          importFault: (phase) => {
            if (phase === 'before-commit') throw new Error('accept crash')
          },
        })
        .receive(message(CONDITIONAL_PROOFS)),
      /accept crash/,
    )
    const counts = await f.query((db) =>
      [
        'native_payment_request_receipts',
        'native_payment_request_receipt_groups',
        'wallet_proof_import_roots',
        'wallet_proof_import_pages',
        'custody_operations',
      ].map((table) => db.prepare(`SELECT count(*) n FROM ${table}`).get()!.n),
    )
    assert.deepEqual(counts, [0, 0, 0, 0, 0])
    assert.equal((await f.service().status('request')).state, 'awaiting')
  } finally {
    await f.close()
  }
})

test('unmatched mint, unit, request, and malformed messages do not perform mint I/O', async () => {
  const f = await fixture()
  try {
    await f.create()
    for (const content of [
      '{',
      message(REGULAR, { mint: 'https://other.example' }),
      message(REGULAR, { unit: 'sat' }),
      message(REGULAR, { id: 'other' }),
    ])
      assert.equal(await f.service().receive(content), null)
    assert.deepEqual(f.counts, { resolved: 0, prepared: 0, complete: 0, checked: 0 })
    const first = paymentRequestReceiptBinding({
      scopeId: f.fence.scopeId,
      requestId: 'request',
      mintUrl: MINT,
      proofs: REGULAR,
    })
    assert.equal(
      first.fingerprint,
      paymentRequestReceiptBinding({
        scopeId: f.fence.scopeId,
        requestId: 'different',
        mintUrl: MINT,
        proofs: [...REGULAR].reverse(),
      }).fingerprint,
    )
  } finally {
    await f.close()
  }
})

test('mixed sources and invalid conditional metadata fail before receipt acceptance', async () => {
  const f = await fixture()
  try {
    await f.create()
    await assert.rejects(
      f.service().receive(message([REGULAR[0]!, CONDITIONAL_PROOFS[0]!])),
      /mixed regular and conditional/,
    )
    f.control.invalidMetadata = true
    await assert.rejects(
      f.service().receive(message(CONDITIONAL_PROOFS)),
      /conditional metadata is invalid/,
    )
    assert.equal((await f.service().status('request')).state, 'awaiting')
    assert.equal(await f.targetCount(), 0)
    assert.equal(f.counts.prepared, 0)
    assert.equal(f.counts.checked, 0)
  } finally {
    await f.close()
  }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'native-request-receipt-'))
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const profile = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT,
    walletSeedHex: SEED,
    nostrSecretKeyHex: '22'.repeat(32),
  })
  await writeState(emptyDaemonState())
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: profile.walletScopeId,
    incarnationId: 'request-receipt-test',
    observedAtMs: Date.now(),
  })
  const counts = { resolved: 0, prepared: 0, complete: 0, checked: 0 }
  const control = {
    failMint: false,
    state: CheckStateEnum.UNSPENT as CheckStateEnum,
    missingStates: false,
    restoreOutputs: false,
    invalidMetadata: false,
  }
  const outputs = [
    OutputData.createSingleData(1, REGULAR_ID, 'local-a', 13n),
    OutputData.createSingleData(1, REGULAR_ID, 'local-b', 17n),
  ]
  const wallet = {
    loadMint: async () => {},
    receive: async () => [],
    send: async () => ({ keep: [], send: [] }),
    completeSwap: async () => {
      counts.complete++
      if (control.failMint) throw new Error('mint unavailable')
      return { keep: outputs.map(sign), send: [] }
    },
    checkProofsStates: async (proofs: readonly Pick<Proof, 'id' | 'secret'>[]) =>
      states(proofs, control.state),
    getKeyset: () => ({ id: REGULAR_ID, unit: 'msat', keys: KEYS, fee: 0, verify: () => true }),
  }
  const service = (
    faults: {
      receiveFault?: (phase: StateSqliteFaultPhase) => void
      importFault?: (phase: StateSqliteFaultPhase) => void
    } = {},
  ) =>
    new NativePaymentRequestReceiptCoordinator({
      directory,
      getFence: () => fence,
      walletSeedHex: SEED,
      mintUrl: MINT,
      dependencies: {
        receive: new DaemonDurableWalletReceiveCoordinator(
          directory,
          () => fence,
          async (_mint, groups) => {
            assert.deepEqual(
              groups.receive.map((item) => item.secret).sort(),
              outputs.map((item) => Buffer.from(item.secret).toString('hex')).sort(),
            )
            return { receive: control.restoreOutputs ? outputs.map(sign) : [] }
          },
          Date.now,
          faults.receiveFault,
        ),
        conditional: new DurableWalletProofImportCoordinator(
          directory,
          () => fence,
          Date.now,
          faults.importFault,
        ),
        resolveKeysets: async (request) => {
          counts.resolved++
          return {
            canonicalMintUrl: MINT,
            freshness: 'fresh',
            regularKeysets: request.encodedKeysetIds.includes(REGULAR_ID)
              ? [{ keysetId: REGULAR_ID, unit: 'msat', active: true }]
              : [],
            conditionalKeysets: CONDITIONAL.filter((keyset) =>
              request.encodedKeysetIds.includes(keyset.id),
            ).map((keyset) => ({
              keysetId: keyset.id,
              unit: 'msat',
              active: true,
              ...keyset.identity,
              ...(control.invalidMetadata ? { outcomeCollectionId: 'invalid' } : {}),
            })),
          }
        },
        conditionalKeysets: async (_mint, ids) =>
          CONDITIONAL.filter((keyset) => ids.includes(keyset.id)),
        walletFor: async () => wallet,
        checkProofsStates: async (_mint, proofs) => {
          counts.checked += proofs.length
          return control.missingStates ? [] : states(proofs, control.state)
        },
        prepareRegular: async ({ proofs }) => {
          counts.prepared++
          const { start: counterStart } = await reserveDaemonKeysetCounter(
            REGULAR_ID,
            2,
            { fence, observedAtMs: Date.now() },
            { normalizedMint: MINT, unit: 'msat' },
          )
          const preview: SwapPreview = {
            amount: Amount.from(2),
            fees: Amount.zero(),
            keysetId: REGULAR_ID,
            inputs: [...proofs],
            keepOutputs: outputs,
          }
          return {
            wallet,
            prepared: {
              operation: serializeDurableWalletReceiveOperation({
                operationId: `wallet-receive:request-${counterStart}`,
                mintUrl: MINT,
                unit: 'msat',
                preview,
                derivationRange: { keysetId: REGULAR_ID, counterStart, counterCount: 2 },
              }),
            },
          }
        },
      },
    })
  const query = <T>(run: (db: import('node:sqlite').DatabaseSync) => T) =>
    withDaemonStateSqliteTransaction(directory, run)
  return {
    directory,
    fence,
    service,
    query,
    counts,
    control,
    create: () =>
      service().create({
        requestId: 'request',
        nprofile: nip19.nprofileEncode({
          pubkey: derivePaymentRequestReceiveKeyPair(Buffer.from(SEED, 'hex')).publicKey,
          relays: ['wss://relay.example'],
        }),
      }),
    targetCount: () =>
      query((db) => Number(db.prepare('SELECT count(*) n FROM target_wallet_proofs').get()!.n)),
    close: async () => {
      if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function message(proofs: readonly Proof[], overrides: Record<string, unknown> = {}) {
  return JSON.stringify({ id: 'request', mint: MINT, unit: 'msat', proofs, ...overrides })
}
function states(proofs: readonly Pick<Proof, 'id' | 'secret'>[], state: CheckStateEnum) {
  return proofs.map((proof) => ({
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state,
    witness: null,
  }))
}
function proof(id: string, secret: string): Proof {
  return sign(OutputData.createSingleData(1, id, secret, 19n))
}
function sign(output: OutputData): Proof {
  const id = output.blindedMessage.id
  const signature = createBlindSignature(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY, id)
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY)
  return output.toProof(
    {
      id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id, keys: KEYS },
  )
}
