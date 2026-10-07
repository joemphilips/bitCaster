import { readActivityRows } from './nativeActivityTestHelpers.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { bytesToHex } from '@noble/curves/utils.js'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  CheckStateEnum,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  hashToCurve,
  pointFromHex,
  type Proof,
} from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { DurableWalletProofImportCoordinator } from '../src/durableWalletProofImportCoordinator.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { withDaemonStateSqliteTransaction, type StateSqliteFaultPhase } from '../src/stateSqlite.ts'
import { prepareProofOperation, writeState, emptyDaemonState } from '../src/state.ts'
import { recoverDurableWalletProofImports } from '../src/walletOps.ts'
import { dispatch, type EngineClientLike } from '../src/server.ts'

const MINT = 'https://mint.example'
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 9])
const KEYS = { '1': bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) }
const ASSET = {
  kind: 'Outcome' as const,
  conditionId: 'ab'.repeat(32),
  outcomeSetId: 'YES',
  baseAsset: 'sat' as const,
  unit: 'msat' as const,
}
const COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: ASSET.conditionId,
  outcomeCollection: ASSET.outcomeSetId,
})
const KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: 'msat',
  conditionId: ASSET.conditionId,
  outcomeCollectionId: COLLECTION_ID,
})
const KEYSET = {
  canonicalMintUrl: MINT,
  id: KEYSET_ID,
  unit: 'msat' as const,
  keys: KEYS,
  inputFeePpk: 0,
  finalExpiry: null,
  identity: {
    kind: 'conditional' as const,
    conditionId: ASSET.conditionId,
    outcomeCollection: ASSET.outcomeSetId,
    outcomeCollectionId: COLLECTION_ID,
  },
}
const PROOFS = Array.from({ length: 33 }, (_, index) => signedProof(index))

for (const later of ['spent', 'reserved', 'revised', 'retired'] as const) {
  test(`restart retains an applied ${later} page and admits only the retained remaining page`, async () => {
    const f = await fixture()
    try {
      await f.crashAfterFirstPage()
      assert.equal((await readActivityRows(f.directory)).length, 0)
      const before = await f.query((db) =>
        db.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
      )
      assert.equal(before.length, 32)
      if (later === 'retired') {
        await prepareProofOperation({
          operationId: 'later-retirement',
          kind: 'ctf-redeem',
          mintUrl: MINT,
          inputs: [],
          outputs: {},
        })
      }
      await f.query((db) => {
        if (later === 'spent') {
          db.exec(
            `UPDATE custody_proofs SET selectability = 'spent', nut07_state = 'SPENT', revision = revision + 1; DELETE FROM target_wallet_proofs`,
          )
        } else if (later === 'reserved') {
          db.exec(
            `UPDATE custody_proofs SET selectability = 'locked', reservation_operation_id = 'later-reservation', revision = revision + 1; UPDATE target_wallet_proofs SET state = 'locked', reserved_by = 'later-reservation'`,
          )
        } else if (later === 'revised') {
          db.exec(`UPDATE custody_proofs SET revision = revision + 1`)
        } else {
          db.exec(`UPDATE custody_proofs SET selectability = 'retained', revision = revision + 1`)
          for (const row of db.prepare('SELECT proof_id, proof_body FROM custody_proofs').all()) {
            const secret = JSON.parse(Buffer.from(row.proof_body as Uint8Array).toString()).secret
            db.prepare(
              `UPDATE target_wallet_proofs SET state = 'locked', reserved_by = 'later-retirement', retired_by_operation_id = 'later-retirement', retired_at_ms = 1, retired_custody_proof_id = ? WHERE secret = ?`,
            ).run(row.proof_id, secret)
          }
          assert.equal(
            db
              .prepare(
                'SELECT count(*) AS count FROM target_wallet_proofs WHERE retired_at_ms IS NOT NULL',
              )
              .get()!.count,
            32,
          )
        }
      })
      const saved = await f.query((db) =>
        db.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
      )
      const targetSaved = await f.query((db) =>
        db.prepare('SELECT * FROM target_wallet_proofs ORDER BY proof_id').all(),
      )
      let checked = 0
      const restarted = f.coordinator()
      const result = await restarted.recover({
        checkProofsStates: async (_mint, _asset, proofs) => {
          checked += proofs.length
          assert.equal(proofs.length, 1)
          assert.equal(
            before.some(
              (row) =>
                JSON.parse(Buffer.from(row.proof_body as Uint8Array).toString()).secret ===
                proofs[0]?.secret,
            ),
            false,
          )
          return unspent(proofs)
        },
      })
      assert.equal(result.recoveredCount, 1)
      assert.equal(result.pendingCount, 0)
      assert.equal(checked, 1)
      const activity = await readActivityRows(f.directory)
      assert.equal(activity.length, 1)
      assert.equal(activity[0]?.item.amountSubunits, 33)
      assert.equal(activity[0]?.item.type, 'deposit')
      assert.equal(activity[0]?.item.lightningInvoice, null)
      assert.equal(activity[0]?.item.walletId, f.fence.scopeId.slice('custody:wallet:'.length))
      const after = await f.query((db) =>
        db.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
      )
      const oldIds = new Set(saved.map((row) => row.proof_id))
      assert.equal(
        isDeepStrictEqual(
          after.filter((row) => oldIds.has(row.proof_id)),
          saved,
        ),
        true,
        'applied proof state changed',
      )
      const targetAfter = await f.query((db) =>
        db.prepare('SELECT * FROM target_wallet_proofs ORDER BY proof_id').all(),
      )
      const oldTargetIds = new Set(targetSaved.map((row) => row.proof_id))
      assert.equal(
        isDeepStrictEqual(
          targetAfter.filter((row) => oldTargetIds.has(row.proof_id)),
          targetSaved,
        ),
        true,
        'applied wallet state changed',
      )
      if (later === 'spent') assert.equal(targetAfter.length, 1)
      if (later === 'retired')
        await assert.rejects(f.importAll(restarted), /retired wallet custody/)
      else
        await f.importAll(restarted, async () => {
          throw new Error('applied pages must not call the mint')
        })
      assert.deepEqual(await readActivityRows(f.directory), activity)
    } finally {
      await f.close()
    }
  })
}

for (const remaining of [
  'PENDING',
  'SPENT',
  'missing',
  'invalid',
  'missing-link',
  'invalid-source',
] as const) {
  test(`remaining ${remaining} page fails closed without admitting the applied page again`, async () => {
    const f = await fixture()
    try {
      await f.crashAfterFirstPage()
      assert.equal((await readActivityRows(f.directory)).length, 0)
      const saved = await f.query((db) =>
        db.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all(),
      )
      if (remaining === 'missing-link')
        await f.query((db) => {
          const trigger = String(
            db
              .prepare(
                "SELECT sql FROM sqlite_schema WHERE name = 'wallet_proof_import_pages_no_delete'",
              )
              .get()!.sql,
          )
          db.exec(
            'DROP TRIGGER wallet_proof_import_pages_no_delete; DELETE FROM wallet_proof_import_pages WHERE page_index = 1',
          )
          db.exec(trigger)
        })
      if (remaining === 'invalid-source')
        await f.query((db) => {
          const trigger = String(
            db
              .prepare(
                "SELECT sql FROM sqlite_schema WHERE name = 'wallet_proof_import_root_immutable'",
              )
              .get()!.sql,
          )
          db.exec('DROP TRIGGER wallet_proof_import_root_immutable')
          const row = db.prepare('SELECT source_body FROM wallet_proof_import_roots').get()!
          const body = JSON.parse(Buffer.from(row.source_body as Uint8Array).toString())
          body.proofs[32].C = '02' + '00'.repeat(32)
          db.prepare('UPDATE wallet_proof_import_roots SET source_body = ?').run(
            Buffer.from(JSON.stringify(body)),
          )
          db.exec(trigger)
        })
      const result = await f.coordinator().recover({
        checkProofsStates: async (_mint, _asset, proofs) => {
          assert.equal(proofs.length, 1)
          if (remaining === 'missing') return []
          if (remaining === 'invalid') return [{ ...unspent(proofs)[0]!, Y: 'foreign' }]
          return unspent(proofs).map((row) => ({
            ...row,
            state: remaining === 'PENDING' ? CheckStateEnum.PENDING : CheckStateEnum.SPENT,
          }))
        },
      })
      assert.equal(result.recoveredCount, 0)
      assert.equal(result.pending.length, 1)
      assert.equal(result.pendingCount, 1)
      assert.equal((await readActivityRows(f.directory)).length, 0)
      assert.equal(
        isDeepStrictEqual(
          await f.query((db) => db.prepare('SELECT * FROM custody_proofs ORDER BY proof_id').all()),
          saved,
        ),
        true,
        'proof state changed on failed recovery',
      )
      assert.equal(
        await f.query(
          (db) =>
            db
              .prepare(
                "SELECT count(*) AS count FROM wallet_proof_import_roots WHERE state = 'complete'",
              )
              .get()!.count,
        ),
        0,
      )
    } finally {
      await f.close()
    }
  })
}

for (const commit of [1, 2, 3, 4, 5, 6, 7, 8]) {
  for (const phase of ['before-commit', 'after-commit'] as const) {
    test(`${phase} failure at transaction ${commit} retains exact recoverable source and no orphan page links`, async () => {
      const f = await fixture()
      try {
        let commits = 0
        await assert.rejects(
          f.importAll(
            f.coordinator((observed) => {
              if (observed === phase && ++commits === commit) throw new Error('simulated crash')
            }),
          ),
          /simulated crash/,
        )
        const links = await f.query(
          (db) =>
            db
              .prepare(
                `SELECT count(*) AS count FROM wallet_proof_import_pages p LEFT JOIN custody_operations o ON o.scope_id = p.scope_id AND o.operation_id = p.bound_operation_id WHERE p.bound_operation_id IS NOT NULL AND o.operation_id IS NULL`,
              )
              .get()!.count,
        )
        assert.equal(links, 0)
        const result = await f
          .coordinator()
          .recover({ checkProofsStates: async (_mint, _asset, proofs) => unspent(proofs) })
        assert.equal(result.pendingCount, 0)
        // A rollback of the initial source transaction has not accepted the import.
        assert.equal(
          await f.query(
            (db) => db.prepare('SELECT count(*) AS count FROM custody_proofs').get()!.count,
          ),
          commit === 1 && phase === 'before-commit' ? 0 : 33,
        )
      } finally {
        await f.close()
      }
    })
  }
}

test('typed import manifests reject rebind, premature completion, and foreign page links', async () => {
  const f = await fixture()
  try {
    await f.crashAfterFirstPage()
    await f.query((db) => {
      assert.equal(
        db.prepare('SELECT proof_count FROM wallet_proof_import_roots').get()!.proof_count,
        33,
      )
      assert.equal(
        db.prepare('SELECT page_count FROM wallet_proof_import_roots').get()!.page_count,
        2,
      )
      assert.equal(
        db
          .prepare(
            'SELECT count(*) AS count FROM wallet_proof_import_pages WHERE bound_operation_id IS NOT NULL',
          )
          .get()!.count,
        1,
      )
      assert.throws(
        () =>
          db.exec(
            "UPDATE wallet_proof_import_roots SET normalized_mint = 'https://foreign.example'",
          ),
        /source is immutable/,
      )
      assert.throws(
        () => db.exec("UPDATE wallet_proof_import_pages SET expected_operation_id = 'foreign'"),
        /page is immutable/,
      )
      assert.throws(
        () =>
          db.exec(
            'UPDATE wallet_proof_import_pages SET bound_operation_id = NULL WHERE page_index = 0',
          ),
        /binding is immutable/,
      )
      assert.throws(
        () =>
          db.exec(
            "UPDATE wallet_proof_import_pages SET bound_operation_id = 'foreign' WHERE page_index = 1",
          ),
        /CHECK constraint/,
      )
      assert.throws(
        () => db.exec("UPDATE wallet_proof_import_roots SET state = 'complete'"),
        /import is incomplete/,
      )
    })
    assert.equal(
      (
        await f
          .coordinator()
          .recover({ checkProofsStates: async (_mint, _asset, proofs) => unspent(proofs) })
      ).recoveredCount,
      1,
    )
  } finally {
    await f.close()
  }
})

test('one failed root does not prevent the durable recovery cursor from reaching another root', async () => {
  const f = await fixture()
  try {
    await f.crashAfterFirstPage()
    let saved = false
    await assert.rejects(
      f
        .coordinator((phase) => {
          if (phase === 'after-commit' && !saved) {
            saved = true
            throw new Error('simulated crash')
          }
        })
        .importOutcomeProofs({
          mintUrl: MINT,
          asset: ASSET,
          proofs: [signedProof(1000)],
          keysets: [KEYSET],
          checkProofsStates: async (proofs) => unspent(proofs),
        }),
      /simulated crash/,
    )
    const blocked = await f.coordinator().recover({
      checkProofsStates: async (_mint, _asset, proofs) =>
        unspent(proofs).map((row) => ({ ...row, state: CheckStateEnum.PENDING })),
    })
    assert.equal(blocked.pendingCount, 2)
    assert.equal(blocked.hasMore, true)
    const next = await f
      .coordinator()
      .recover({ checkProofsStates: async (_mint, _asset, proofs) => unspent(proofs) })
    assert.equal(next.recoveredCount, 1)
    assert.equal(next.pendingCount, 1)
    assert.equal(next.hasMore, false)
    assert.notEqual(next.recovered[0], blocked.pending[0]?.operationId)
    const remaining = await f
      .coordinator()
      .recover({ checkProofsStates: async (_mint, _asset, proofs) => unspent(proofs) })
    assert.equal(remaining.recoveredCount, 1)
    assert.equal(remaining.pendingCount, 0)
  } finally {
    await f.close()
  }
})

test('manual wallet recovery uses the retained source and blocks the write gate while a page is pending', async () => {
  const f = await fixture()
  try {
    await f.crashAfterFirstPage()
    let observed = 0
    let status: unknown
    const deps = {
      getCustodyFence: () => f.fence,
      onManualCustodyRecoveryStatus: (value: unknown) => {
        status = value
      },
      createEngineClient: () => ({}) as EngineClientLike,
      createCashuWallet: () => ({
        loadMint: async () => {},
        receive: async () => [],
        send: async () => ({ keep: [], send: [] }),
        checkProofsStates: async (proofs: Array<Pick<Proof, 'id' | 'secret'>>) => {
          observed += proofs.length
          return unspent(proofs).map((row) => ({ ...row, state: CheckStateEnum.PENDING }))
        },
      }),
    }
    const blocked = await dispatch({ method: 'wallet.recover', params: {} }, deps)
    assert.equal(blocked.ok, true)
    assert.equal(observed, 1)
    assert.equal((status as { nonRetirementPending: boolean }).nonRetirementPending, true)
    const result = await recoverDurableWalletProofImports(
      { walletSeedHex: '11'.repeat(64) },
      {
        getCustodyFence: () => f.fence,
        createCashuWallet: () => ({
          loadMint: async () => {},
          receive: async () => [],
          send: async () => ({ keep: [], send: [] }),
          checkProofsStates: async (proofs) => unspent(proofs),
        }),
      },
    )
    assert.equal(result.recoveredCount, 1)
    assert.equal(result.pendingCount, 0)
    await dispatch({ method: 'wallet.recover', params: {} }, deps)
    assert.equal((status as { nonRetirementPending: boolean }).nonRetirementPending, false)
    const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
    assert.match(main, /const importRecovery = await recoverDurableWalletProofImports/)
    assert.match(main, /composeStartupCustodyRecovery\(\[[\s\S]*?importRecovery,/)
    assert.match(main, /const blockingPending =[\s\S]*?importRecovery\.pendingCount > 0/)
  } finally {
    await f.close()
  }
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'conditional-import-'))
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const profile = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: MINT,
    walletSeedHex: '11'.repeat(64),
    nostrSecretKeyHex: '22'.repeat(32),
  })
  await writeState(emptyDaemonState())
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: profile.walletScopeId,
    incarnationId: 'conditional-import-test',
    observedAtMs: Date.now(),
  })
  const coordinator = (fault?: (phase: StateSqliteFaultPhase) => void) =>
    new DurableWalletProofImportCoordinator(directory, () => fence, Date.now, fault)
  const importAll = (
    coordinator: DurableWalletProofImportCoordinator,
    checkProofsStates = async (proofs: readonly Pick<Proof, 'id' | 'secret'>[]) => unspent(proofs),
  ) =>
    coordinator.importOutcomeProofs({
      mintUrl: MINT,
      asset: ASSET,
      proofs: PROOFS,
      keysets: [KEYSET],
      checkProofsStates,
    })
  return {
    directory,
    fence,
    coordinator,
    importAll,
    query: <T>(action: (database: import('node:sqlite').DatabaseSync) => T) =>
      withDaemonStateSqliteTransaction(directory, action),
    crashAfterFirstPage: async () => {
      let commit = 0
      await assert.rejects(
        importAll(
          coordinator((phase) => {
            if (phase === 'before-commit' && ++commit === 5) throw new Error('simulated crash')
          }),
        ),
        /simulated crash/,
      )
    },
    close: async () => {
      if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previous
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function unspent(proofs: readonly Pick<Proof, 'id' | 'secret'>[]) {
  return proofs.map((proof) => ({
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state: CheckStateEnum.UNSPENT,
    witness: null,
  }))
}

function signedProof(index: number): Proof {
  const output = OutputData.createSingleData(
    1,
    KEYSET_ID,
    `conditional-proof-${index}`,
    BigInt(index + 1),
  )
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
