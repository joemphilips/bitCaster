import { releaseCustodyScopeLease } from '../src/profileFencing.ts'
import {
  prepareExactProofConsolidationOperation,
  validateExactProofConsolidationOperation,
  type ExactProofConsolidationWallet,
} from '@bitcaster-market/client-sdk/proofConsolidationOperation'
import { createSpeculativeCounterTranscript } from '@bitcaster-market/client-sdk/speculativeCounterTranscript'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { createWallet, serializeOutputDataArray } from '../src/walletOps.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { serviceFixture, MINT, SEED } from './nativePaymentRequestServiceFixture.ts'
import {
  commitDaemonCounterTranscript,
  readDaemonCounterSnapshots,
  prepareProofOperationWithExactReservationFromDatabase,
  reserveDaemonKeysetCounter,
  addAvailableProofs,
} from '../src/state.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import { consolidateWalletProofs } from '../src/walletProofConsolidation.ts'

async function fixture() {
  const f = await serviceFixture({
    defaultWallet: true,
    largeDenominations: true,
    inputFeePpk: 1000,
  })
  try {
    f.deps.resolveInputFeePpkByKeyset = async (_mint, ids) =>
      Object.fromEntries(ids.map((id) => [id, 1000]))
    await addAvailableProofs(
      MINT,
      Array.from({ length: 8 }, (_, i) => f.mintProof(8, `manual-input-${i}`)),
      { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
    )
    return {
      ...f,
      run: (
        dependencies: NonNullable<
          Parameters<typeof consolidateWalletProofs>[0]['dependencies']
        > = f.deps,
      ) =>
        consolidateWalletProofs({
          secrets: { walletSeedHex: SEED },
          mutation: () => ({ fence: f.fence, observedAtMs: Date.now() }),
          dependencies,
        }),
    }
  } catch (error) {
    await f.close()
    throw error
  }
}
async function facts(directory: string) {
  return withDaemonStateSqliteTransaction(directory, (db) =>
    Object.fromEntries(
      [
        'target_wallet_proofs',
        'target_keyset_counters',
        'custody_keyset_counters',
        'target_proof_operations',
        'custody_proofs',
        'custody_operations',
        'custody_proof_reservations',
        'custody_artifacts',
      ].map((table) => [
        table,
        db
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    ),
  )
}

test('actual default consolidation commits paired counters and exact reservation before mint', async () => {
  const f = await fixture()
  try {
    f.control.beforeSwap = async () => {
      const saved = await facts(f.directory)
      assert.equal(saved.target_proof_operations!.length, 1)
      assert.equal(saved.target_keyset_counters!.length, 1)
      assert.equal(saved.custody_keyset_counters!.length, 1)
      assert.equal(
        saved.target_wallet_proofs!.filter((row) => JSON.parse(row).state === 'reserved').length,
        8,
      )
    }
    const result = await f.run()
    assert.equal(result.status, 'completed')
    assert.equal(result.rounds.length, 1)
    assert.equal(result.rounds[0]!.fee, 8)
    assert.equal(f.counts.swaps, 1)
  } finally {
    await f.close()
  }
})

for (const phase of ['counter-written', 'journal-bound'] as const)
  test(`actual default consolidation ${phase} failure rolls all fund rows back`, async () => {
    const f = await fixture()
    try {
      const before = await facts(f.directory)
      const result = await f.run({
        ...f.deps,
        injectConsolidationFault: (observed) => {
          if (observed === phase) throw new Error('controlled consolidation rollback')
        },
      })
      assert.equal(result.status, 'partial')
      assert.match(result.failure!.error, /controlled consolidation rollback/)
      assert.deepEqual(await facts(f.directory), before)
      assert.equal(f.counts.swaps, 0)
    } finally {
      await f.close()
    }
  })

for (const phase of ['before-commit', 'after-commit'] as const)
  test(`actual default consolidation ${phase} uses only committed authority`, async () => {
    const f = await fixture()
    try {
      const before = await facts(f.directory)
      let injected = false
      const result = await f.run({
        ...f.deps,
        injectCustodyFault: (observed) => {
          if (!injected && observed === phase) {
            injected = true
            throw new Error('controlled consolidation COMMIT reply')
          }
        },
      })
      assert.equal(injected, true)
      if (phase === 'before-commit') {
        assert.equal(result.status, 'partial')
        assert.deepEqual(await facts(f.directory), before)
        assert.equal(f.counts.swaps, 0)
      } else {
        assert.equal(result.status, 'completed')
        assert.equal(result.rounds.length, 1)
        assert.equal(f.counts.swaps, 1)
        assert.equal(f.proofStateRequests.length, 1)
      }
    } finally {
      await f.close()
    }
  })

for (const conflicts of [1, 3])
  test(`actual default consolidation ${conflicts} counter conflicts use at most three drafts`, async () => {
    const f = await fixture()
    try {
      let drafts = 0
      let selected: string | undefined
      let keyset: string | undefined
      const result = await f.run({
        ...f.deps,
        observeConsolidationPrepared: async (draft) => {
          drafts++
          const identities = draft.inputs
            .map((proof) => proof.secret)
            .sort()
            .join(',')
          selected ??= identities
          assert.equal(identities, selected)
          keyset ??= String(draft.metadata!.keysetId)
          assert.equal(draft.metadata!.keysetId, keyset)
          assert.equal(draft.metadata!.fees, 8)
          if (drafts <= conflicts)
            await reserveDaemonKeysetCounter(
              keyset,
              1,
              { fence: f.fence, observedAtMs: Date.now() },
              { normalizedMint: MINT, unit: 'msat' },
            )
        },
      })
      assert.equal(drafts, conflicts === 1 ? 2 : 3)
      assert.equal(result.status, conflicts === 1 ? 'completed' : 'partial')
      assert.equal(f.counts.swaps, conflicts === 1 ? 1 : 0)
      if (conflicts === 3) {
        const saved = await facts(f.directory)
        assert.equal(saved.target_proof_operations!.length, 0)
        assert.equal(
          saved.target_wallet_proofs!.filter((row) => JSON.parse(row).state === 'reserved').length,
          0,
        )
        assert.equal(JSON.parse(saved.target_keyset_counters![0]!).next_counter, 3)
        assert.equal(JSON.parse(saved.custody_keyset_counters![0]!).next_counter, 3)
      }
    } finally {
      await f.close()
    }
  })

test('competing saved round wins over different private output bytes and enters exact recovery', async () => {
  const f = await fixture()
  try {
    let winnerOutputs: string[] = []
    let draftOutputs: string[] = []
    let completedOutputs: string[] = []
    f.deps.createCashuWallet = (_mint, unit, source) => {
      const wallet = createWallet(
        MINT,
        { walletSeedHex: SEED },
        { ...f.deps, createCashuWallet: undefined },
        'sat',
        unit,
        undefined,
        source,
      )
      const complete = wallet.completeSwap!.bind(wallet)
      wallet.completeSwap = async (preview) => {
        completedOutputs = preview.sendOutputs!.map((output) => output.blindedMessage.B_)
        return complete(preview)
      }
      return wallet
    }
    const result = await f.run({
      ...f.deps,
      observeConsolidationPrepared: async (draft) => {
        draftOutputs = draft.outputs.consolidated!.map((output) => output.blindedMessage.B_)
        const keysetId = String(draft.metadata!.keysetId)
        await reserveDaemonKeysetCounter(
          keysetId,
          1,
          { fence: f.fence, observedAtMs: Date.now() },
          { normalizedMint: MINT, unit: 'msat' },
        )
        const storage = createDaemonStateSqliteSession(f.directory)
        const transcript = createSpeculativeCounterTranscript(
          await readDaemonCounterSnapshots({
            storage,
            mutation: { fence: f.fence, observedAtMs: Date.now() },
            keysetIds: [keysetId],
            binding: { normalizedMint: MINT, unit: 'msat' },
          }),
        )
        const wallet = createWallet(MINT, { walletSeedHex: SEED }, f.deps, 'sat', 'msat')
        await wallet.loadMint()
        const winner = await prepareExactProofConsolidationOperation({
          operationId: draft.operationId,
          bindingId: String(draft.metadata!.bindingId),
          purpose: String(draft.metadata!.purpose),
          mintUrl: MINT,
          unit: 'msat',
          inputKeysetId: String(draft.metadata!.inputKeysetId),
          outputKeysetId: keysetId,
          outputKeyset: wallet.getKeyset!(keysetId),
          inputs: draft.inputs.map((proof) => ({ ...proof, amount: Number(proof.amount) })),
          conditional: false,
          inputFeePpk: 1000,
          plannedRound: {
            inputs: draft.inputs.map((proof) => String(proof.amount)),
            outputs: draft.outputs.consolidated!.map((output) =>
              String(output.blindedMessage.amount),
            ),
            fee: '8',
          },
          seed: Buffer.from(SEED, 'hex'),
          counterSource: transcript.counterSource,
          wallet: wallet as ExactProofConsolidationWallet,
        })
        winnerOutputs = winner.outputs.consolidated!.map((output) => output.blindedMessage.B_)
        assert.notDeepEqual(winnerOutputs, draftOutputs)
        const validated = validateExactProofConsolidationOperation(winner, {
          purpose: 'wallet-proof-consolidation',
        })
        const reservationId = `${winner.operationId}:reservation`
        await withDurableCustodyUnitOfWork(storage, f.fence, Date.now(), (database) => {
          commitDaemonCounterTranscript(
            database,
            f.fence.scopeId,
            { normalizedMint: MINT, unit: 'msat' },
            transcript,
            Date.now(),
          )
          prepareProofOperationWithExactReservationFromDatabase(database, {
            operationId: winner.operationId,
            kind: 'proof-consolidation',
            mintUrl: MINT,
            inputs: [...winner.inputs],
            outputs: { consolidated: serializeOutputDataArray(validated.outputs) },
            metadata: {
              purpose: 'wallet-proof-consolidation',
              bindingId: winner.metadata!.bindingId,
              reservationId,
              unit: 'msat',
              inputKeysetId: winner.metadata!.inputKeysetId,
              outputKeysetId: keysetId,
              assetKind: 'sats',
              baseAsset: 'sat',
              conditionId: null,
              outcomeSetId: null,
              exactOperation: winner,
            },
            reservationId,
            asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
          })
        })
      },
    })
    assert.equal(result.status, 'completed', result.failure?.error)
    assert.equal(f.counts.swaps, 1)
    const submitted = JSON.parse(f.swapRequests[0]!).outputs.map(
      (output: { B_: string }) => output.B_,
    )
    assert.deepEqual(completedOutputs, winnerOutputs)
    assert.equal(f.proofStateRequests.length, 1)
    assert.deepEqual([...submitted].sort(), [...winnerOutputs].sort())
    assert.notDeepEqual([...submitted].sort(), [...draftOutputs].sort())
    const saved = await facts(f.directory)
    assert.equal(saved.target_proof_operations!.length, 1)
    assert.equal(JSON.parse(saved.target_keyset_counters![0]!).next_counter, 4)
    assert.equal(JSON.parse(saved.custody_keyset_counters![0]!).next_counter, 4)
  } finally {
    await f.close()
  }
})

test('changed exact input reservation refuses once and rolls both counter authorities back', async () => {
  const f = await fixture()
  try {
    let drafts = 0
    let foreign: Awaited<ReturnType<typeof facts>> | undefined
    const result = await f.run({
      ...f.deps,
      observeConsolidationPrepared: async () => {
        drafts++
        await withDaemonStateSqliteTransaction(f.directory, (db) => {
          db.prepare(
            "UPDATE target_wallet_proofs SET state = 'reserved', reserved_by = 'foreign-reservation' WHERE proof_id = (SELECT proof_id FROM target_wallet_proofs LIMIT 1)",
          ).run()
        })
        foreign = await facts(f.directory)
      },
    })
    assert.equal(result.status, 'partial')
    assert.equal(drafts, 1)
    assert.deepEqual(await facts(f.directory), foreign)
    assert.equal(f.counts.swaps, 0)
  } finally {
    await f.close()
  }
})

test('lost fence refuses a private draft without a preparation retry or mint request', async () => {
  const f = await fixture()
  try {
    const before = await facts(f.directory)
    let drafts = 0
    const result = await f.run({
      ...f.deps,
      observeConsolidationPrepared: async () => {
        drafts++
        await releaseCustodyScopeLease(f.directory, f.fence, Date.now())
      },
    })
    assert.equal(result.status, 'partial')
    assert.equal(drafts, 1)
    assert.deepEqual(await facts(f.directory), before)
    assert.equal(f.counts.swaps, 0)
  } finally {
    await f.close()
  }
})

test('corrupt saved reservation binding refuses recovery before creating a metadata wallet', async () => {
  const f = await fixture()
  try {
    f.control.beforeSwap = async () => {
      throw new Error('controlled interrupted consolidation')
    }
    const first = await f.run()
    assert.equal(first.pending.length, 1)
    await withDaemonStateSqliteTransaction(f.directory, (db) => {
      db.prepare("UPDATE target_proof_operations SET reservation_id = 'foreign-reservation'").run()
    })
    const before = await facts(f.directory)
    let wallets = 0
    f.deps.createCashuWallet = () => {
      wallets++
      throw new Error('metadata must not run')
    }
    const refused = await f.run()
    assert.equal(refused.status, 'partial')
    assert.equal(refused.pending.length, 1)
    assert.match(refused.pending[0]!.error, /reservation|journal|request/)
    assert.equal(wallets, 0)
    assert.deepEqual(await facts(f.directory), before)
  } finally {
    await f.close()
  }
})
