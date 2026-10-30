import { createSpeculativeCounterTranscript } from '@bitcaster-market/client-sdk/speculativeCounterTranscript'
import {
  splitRegularProofsWithOperation,
  splitCompleteSetWithOperation,
  type CtfProofOperationStore,
  type CtfPrepareProofOperationInput,
} from '@bitcaster-market/client-sdk/ctfSplit'
import { createDaemonStateSqliteSession } from '../src/stateSqlite.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { createWallet } from '../src/walletOps.ts'
import { SEED } from './nativePaymentRequestServiceFixture.ts'
import {
  mintDenominationKeys,
  mintDenominationPrivateKey,
} from '../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts'
import { createBlindSignature, pointFromHex } from '@cashu/cashu-ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveConditionalKeysetId, type MintKeys } from '@cashu/cashu-ts'
import type { CtfSplitTransport } from '@bitcaster-market/client-sdk/ctfSplit'
import { serviceFixture, MINT } from './nativePaymentRequestServiceFixture.ts'
import {
  readDaemonProofOperationFromDatabase,
  commitDaemonCounterTranscript,
  readDaemonCounterSnapshots,
  prepareCompleteSetRegularProofOperationFromDatabase,
  prepareCompleteSetCtfProofOperationFromDatabase,
  reserveDaemonKeysetCounter,
  addAvailableProofs,
} from '../src/state.ts'
import { readSecrets } from '../src/secrets.ts'
import { withDaemonStateSqliteTransaction } from '../src/stateSqlite.ts'
import {
  createDaemonCompleteSetOutputMode,
  splitWalletCompleteSet,
} from '../src/completeSetConversion.ts'

const CONDITION = 'a'.repeat(64)
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 13])
const KEYS = mintDenominationKeys(
  PRIVATE_KEY,
  Array.from({ length: 15 }, (_, index) => String(2 ** index)),
)
const OUTCOMES = Object.fromEntries(
  ['A', 'B'].map((name, index) => [
    name,
    deriveConditionalKeysetId({
      keys: KEYS,
      unit: 'msat',
      conditionId: CONDITION,
      outcomeCollectionId: String(index + 1).repeat(64),
    }),
  ]),
)
type Dependencies = Parameters<typeof splitWalletCompleteSet>[0]['deps']
async function fixture(amounts = [128]) {
  const f = await serviceFixture({ defaultWallet: true, largeDenominations: true, inputFeePpk: 1 })
  try {
    const mint = f.deps.createCashuMint!(MINT)
    const keysets = (await mint.getKeys()).keysets
    f.deps.resolveMintKeysByKeyset = async (_mint, ids) =>
      Object.fromEntries(
        ids.map((id) => {
          const found = keysets.find((row) => row.id === id)
          if (!found) throw new Error('unknown fixture keyset')
          return [id, found]
        }),
      )
    f.deps.resolveInputFeePpkByKeyset = async (_mint, ids) =>
      Object.fromEntries(ids.map((id) => [id, 1]))
    await addAvailableProofs(
      MINT,
      amounts.map((amount, i) => f.mintProof(amount, `conversion-input-${i}`)),
      { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
    )
    const posted: Array<Parameters<CtfSplitTransport['postSplit']>[0]> = []
    const ctfControl = { fail: false }
    let partitions = 0
    const transport: CtfSplitTransport = {
      getKeys: async (id) =>
        keysets.find((row) => row.id === id) ??
        ({ id, unit: 'msat', input_fee_ppk: 0, keys: KEYS } as MintKeys),
      getRootPartitionKeysets: async () => {
        partitions++
        return { ...OUTCOMES }
      },
      postSplit: async (request) => {
        if (ctfControl.fail) throw new Error('controlled interrupted CTF post')
        posted.push(structuredClone(request))
        return {
          signatures: Object.fromEntries(
            Object.entries(request.outputs).map(([collection, outputs]) => [
              collection,
              outputs.map((output) => ({
                id: output.id,
                amount: output.amount,
                C_: createBlindSignature(
                  pointFromHex(output.B_),
                  mintDenominationPrivateKey(PRIVATE_KEY, String(output.amount)),
                  output.id,
                ).C_.toHex(true),
              })),
            ]),
          ),
        }
      },
    }
    const deps: Dependencies = {
      ...f.deps,
      createCtfSplitTransport: () => transport,
      createCtfResumeDependencies: () => ({
        proofStateChecker: {
          checkProofsStates: async (proofs) => {
            const wallet = createWallet(MINT, { walletSeedHex: SEED }, f.deps, 'sat', 'msat')
            await wallet.loadMint()
            return wallet.checkProofsStates!(proofs)
          },
        },
        restoreOutputGroups: f.deps.restoreOutputGroups,
      }),
    }
    const secrets = (await readSecrets())!
    return {
      ...f,
      mint,
      transport,
      ctfControl,
      deps,
      posted,
      partitionCount: () => partitions,
      run: (override: Dependencies = deps, amountMsat = 100) =>
        splitWalletCompleteSet({
          operationId: 'atomic-conversion',
          conditionId: CONDITION,
          amountMsat,
          mintUrl: MINT,
          secrets,
          deps: override,
        }),
    }
  } catch (error) {
    await f.close()
    throw error
  }
}
async function facts(directory: string) {
  return withDaemonStateSqliteTransaction(directory, (database) =>
    Object.fromEntries(
      [
        'target_wallet_proofs',
        'target_keyset_counters',
        'custody_keyset_counters',
        'target_proof_operations',
        'custody_artifacts',
        'custody_proofs',
        'custody_operations',
        'custody_proof_reservations',
        'daemon_complete_set_recovery_roots',
      ].map((table) => [
        table,
        database
          .prepare(`SELECT * FROM ${table}`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort(),
      ]),
    ),
  )
}

test('actual default regular send and CTF outputs commit before each mint and exact retry does not swap', async () => {
  const f = await fixture()
  try {
    f.control.beforeSwap = async () => {
      const saved = await facts(f.directory)
      assert.equal(saved.target_proof_operations!.length, 1)
      assert.equal(
        JSON.parse(saved.daemon_complete_set_recovery_roots![0]!).state,
        'regular-prepared',
      )
      assert.equal(saved.target_keyset_counters!.length, 1)
    }
    const result = await f.run()
    assert.deepEqual(result.outcomeProofCounts, { A: 3, B: 3 })
    assert.equal(f.counts.swaps, 1)
    assert.equal(f.posted.length, 1)
    const saved = await facts(f.directory)
    assert.equal(saved.target_keyset_counters!.length, 3)
    assert.deepEqual(saved.daemon_complete_set_recovery_roots, [])
    assert.deepEqual(await f.run(), result)
    assert.deepEqual(await facts(f.directory), saved)
    assert.equal(f.counts.swaps, 1)
    assert.equal(f.posted.length, 1)
  } finally {
    await f.close()
  }
})
for (const stage of ['regular', 'ctf'] as const)
  for (const phase of ['counter-written', 'journal-bound'] as const)
    test(`${stage} ${phase} failure rolls back its counters journal reservation and root`, async () => {
      const f = await fixture()
      try {
        let before = await facts(f.directory)
        await assert.rejects(
          f.run({
            ...f.deps,
            observeCompleteSetPrepared: async (observed) => {
              if (observed === stage) before = await facts(f.directory)
            },
            injectCompleteSetFault: (observedStage, observedPhase) => {
              if (observedStage === stage && observedPhase === phase)
                throw new Error('controlled atomic conversion fault')
            },
          }),
          /controlled atomic conversion fault/,
        )
        assert.deepEqual(await facts(f.directory), before)
        assert.equal(f.counts.swaps, stage === 'regular' ? 0 : 1)
        assert.equal(f.posted.length, 0)
        await f.run()
        assert.equal(f.counts.swaps, 1)
        assert.equal(f.posted.length, 1)
      } finally {
        await f.close()
      }
    })

for (const amounts of [[128], [128, 64]])
  test(`exact collateral selection with ${amounts.length} available proof groups makes no regular swap`, async () => {
    const f = await fixture(amounts)
    try {
      globalThis.fetch = async (input, init) => {
        const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
        if (method.toUpperCase() !== 'GET') throw new Error('fixture mutation HTTP refused')
        const url = new URL(
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
        )
        if (url.origin !== MINT || url.search || url.hash)
          throw new Error('foreign fixture GET refused')
        const body =
          url.pathname === '/v1/info'
            ? await f.mint.getInfo()
            : url.pathname === '/v1/keysets'
              ? await f.mint.getKeySets()
              : url.pathname === '/v1/keys' || /^\/v1\/keys\/01[0-9a-f]{64}$/.test(url.pathname)
                ? await f.mint.getKeys()
                : undefined
        if (!body) throw new Error('unknown fixture GET refused')
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
        })
      }
      await f.run(f.deps, 127)
      assert.equal(f.counts.swaps, 0)
      assert.equal(f.posted.length, 1)
      const saved = await facts(f.directory)
      assert.equal(saved.target_proof_operations!.length, 1)
      assert.equal(saved.target_keyset_counters!.length, 2)
    } finally {
      await f.close()
    }
  })

for (const stage of ['regular', 'ctf'] as const)
  test(`${stage} lost COMMIT reply recovers exact authority without an extra completed regular swap`, async () => {
    const f = await fixture()
    try {
      let current: 'regular' | 'ctf' | undefined
      let injected = false
      await f.run({
        ...f.deps,
        observeCompleteSetPrepared: async (observed) => {
          current = observed
        },
        injectCustodyFault: (phase) => {
          if (!injected && phase === 'after-commit' && current === stage) {
            injected = true
            throw new Error('controlled conversion COMMIT loss')
          }
        },
      })
      assert.equal(injected, true)
      assert.equal(f.counts.swaps, 1)
      assert.equal(f.posted.length, 1)
      const saved = await facts(f.directory)
      await f.run()
      assert.deepEqual(await facts(f.directory), saved)
      assert.equal(f.counts.swaps, 1)
      assert.equal(f.posted.length, 1)
    } finally {
      await f.close()
    }
  })

for (const stage of ['regular', 'ctf'] as const)
  for (const conflicts of [1, 3])
    test(`${stage} ${conflicts} counter conflicts use a stage-local three-draft budget`, async () => {
      const f = await fixture()
      try {
        let drafts = 0
        let fixed: string | undefined
        let before: Awaited<ReturnType<typeof facts>> | undefined
        const run = () =>
          f.run({
            ...f.deps,
            observeCompleteSetPrepared: async (observed, draft) => {
              if (observed !== stage) return
              drafts++
              const metadata = draft.metadata!
              const ids = [
                ...new Set(
                  Object.values(draft.outputs)
                    .flat()
                    .map((output) => output.blindedMessage.id),
                ),
              ].sort()
              assert.ok(ids.length > 0)
              let amount: number
              let fee: number
              if (stage === 'regular') {
                assert.equal(typeof metadata.keysetId, 'string')
                assert.equal(metadata.amount, 101)
                assert.equal(metadata.fees, 1)
                assert.deepEqual(ids, [metadata.keysetId])
                amount = metadata.amount as number
                fee = metadata.fees as number
              } else {
                assert.equal(metadata.amountSubunits, 100)
                assert.deepEqual(metadata.outcomeCollectionKeysets, OUTCOMES)
                assert.deepEqual(ids, Object.values(OUTCOMES).sort())
                amount = metadata.amountSubunits as number
                fee = draft.inputs.reduce((sum, proof) => sum + Number(proof.amount), 0) - amount
                assert.equal(fee, 1)
              }
              const identity = JSON.stringify({
                inputs: draft.inputs,
                amount,
                fee,
                ids,
                outcomes: stage === 'ctf' ? metadata.outcomeCollectionKeysets : null,
              })
              fixed ??= identity
              assert.equal(identity, fixed)
              if (drafts <= conflicts) {
                const id = Object.values(draft.outputs)[0]![0]!.blindedMessage.id
                await reserveDaemonKeysetCounter(
                  id,
                  1,
                  { fence: f.fence, observedAtMs: Date.now() },
                  { normalizedMint: MINT, unit: 'msat' },
                )
                before = await facts(f.directory)
              }
            },
          })
        if (conflicts === 1) await run()
        else await assert.rejects(run(), /counter snapshot changed/)
        assert.equal(drafts, conflicts === 1 ? 2 : 3)
        assert.equal(f.counts.swaps, stage === 'regular' && conflicts === 3 ? 0 : 1)
        assert.equal(f.posted.length, conflicts === 3 ? 0 : 1)
        assert.equal(f.partitionCount(), stage === 'regular' && conflicts === 3 ? 0 : 1)
        if (conflicts === 3) {
          assert.deepEqual(await facts(f.directory), before)
          const saved = await facts(f.directory)
          if (stage === 'ctf')
            assert.equal(
              JSON.parse(saved.daemon_complete_set_recovery_roots![0]!).state,
              'ctf-handoff',
            )
          await f.run()
          assert.equal(f.counts.swaps, 1)
          assert.equal(f.posted.length, 1)
        }
      } finally {
        await f.close()
      }
    })

test('regular counter retry keeps its selected output keyset after the active default changes', async () => {
  const f = await fixture()
  try {
    let selections = 0
    let drafts = 0
    let rotatedId: string | undefined
    const preparedKeysets: string[] = []
    let rotate = async () => {
      throw new Error('fixture wallet not attached')
    }
    const deps: Dependencies = {
      ...f.deps,
      createCashuWallet: (_mint, unit, source) => {
        const wallet = createWallet(
          MINT,
          { walletSeedHex: SEED },
          { ...f.deps, createCashuWallet: undefined },
          'sat',
          unit,
          undefined,
          source,
        )
        const get = wallet.getKeyset!.bind(wallet)
        let current: ReturnType<typeof get> | undefined
        wallet.getKeyset = (id) => (id ? get(id) : (current ?? get()))
        const prepare = wallet.prepareSwapToSend!.bind(wallet)
        wallet.prepareSwapToSend = async (...args) => {
          preparedKeysets.push((args[2] as { keysetId: string }).keysetId)
          return prepare(...args)
        }
        const select = wallet.selectProofsToSend!.bind(wallet)
        wallet.selectProofsToSend = (...args) => {
          if (args.length === 4) selections++
          return select(...args)
        }
        rotate = async () => {
          f.control.alternateKeyset = true
          const other = createWallet(
            MINT,
            { walletSeedHex: SEED },
            { ...f.deps, createCashuWallet: undefined },
            'sat',
            'msat',
          )
          await other.loadMint()
          current = other.getKeyset!()
          rotatedId = current.id
        }
        return wallet
      },
      observeCompleteSetPrepared: async (stage, draft) => {
        if (stage !== 'regular') return
        if (++drafts === 1) {
          const id = String(draft.metadata!.keysetId)
          await reserveDaemonKeysetCounter(
            id,
            1,
            { fence: f.fence, observedAtMs: Date.now() },
            { normalizedMint: MINT, unit: 'msat' },
          )
          await rotate()
        }
      },
    }
    await f.run(deps)
    assert.equal(drafts, 2)
    assert.equal(selections, 1)
    assert.equal(preparedKeysets.length, 2)
    assert.equal(preparedKeysets[0], preparedKeysets[1])
    assert.notEqual(preparedKeysets[0], rotatedId)
    assert.equal(f.counts.swaps, 1)
    assert.equal(f.posted.length, 1)
  } finally {
    await f.close()
  }
})

async function captureFreshOperation(run: (store: CtfProofOperationStore) => Promise<unknown>) {
  let captured: CtfPrepareProofOperationInput | undefined
  const store: CtfProofOperationStore = {
    getProofOperation: async () => null,
    prepareProofOperation: async (operation) => {
      captured = structuredClone(operation)
      throw new Error('controlled captured draft')
    },
    markProofOperationCompleted: async () => {
      throw new Error('captured draft must not execute')
    },
  }
  await assert.rejects(run(store), /controlled captured draft/)
  assert.ok(captured)
  return captured
}
for (const stage of ['regular', 'ctf'] as const)
  test(`${stage} differing saved winner aborts the SDK fresh draft before mint dispatch`, async () => {
    const f = await fixture()
    try {
      let winning: CtfPrepareProofOperationInput | undefined
      let losing: CtfPrepareProofOperationInput | undefined
      let observed = 0
      await f.run({
        ...f.deps,
        observeCompleteSetPrepared: async (current, draft) => {
          if (current !== stage) return
          observed++
          losing = structuredClone(draft)
          const ids =
            stage === 'regular' ? [String(draft.metadata!.keysetId)] : Object.values(OUTCOMES)
          await reserveDaemonKeysetCounter(
            ids[0]!,
            1,
            { fence: f.fence, observedAtMs: Date.now() },
            { normalizedMint: MINT, unit: 'msat' },
          )
          const storage = createDaemonStateSqliteSession(f.directory)
          const transcript = createSpeculativeCounterTranscript(
            await readDaemonCounterSnapshots({
              storage,
              mutation: { fence: f.fence, observedAtMs: Date.now() },
              keysetIds: ids,
              binding: { normalizedMint: MINT, unit: 'msat' },
            }),
          )
          if (stage === 'regular') {
            const wallet = createWallet(
              MINT,
              { walletSeedHex: SEED },
              f.deps,
              'sat',
              'msat',
              undefined,
              transcript.counterSource,
            )
            await wallet.loadMint()
            winning = await captureFreshOperation((store) =>
              splitRegularProofsWithOperation({
                mintUrl: MINT,
                baseAsset: 'sat',
                operationId: draft.operationId,
                wallet,
                proofs: [...draft.inputs],
                amountSubunits: Number(draft.metadata!.amount),
                proofOperationStore: store,
                deterministicPreparation: { seed: Buffer.from(SEED, 'hex') },
              }),
            )
          } else
            winning = await captureFreshOperation((store) =>
              splitCompleteSetWithOperation({
                mintUrl: MINT,
                baseAsset: 'sat',
                operationId: draft.operationId,
                conditionId: CONDITION,
                collateralProofs: [...draft.inputs],
                outcomeCollectionKeysets: OUTCOMES,
                amountSubunits: 100,
                transport: f.transport,
                proofOperationStore: store,
                outputMode: createDaemonCompleteSetOutputMode({
                  walletSeedHex: SEED,
                  deps: f.deps,
                  mintUrl: MINT,
                  counterSource: transcript.counterSource,
                }),
              }),
            )
          assert.notDeepEqual(winning.outputs, losing.outputs)
          const asset = { kind: 'sats', baseAsset: 'sat', unit: 'msat' } as const
          const reservationId = `${winning.operationId}:reservation`
          const successors =
            stage === 'regular'
              ? { send: asset, keep: asset }
              : Object.fromEntries(
                  Object.keys(OUTCOMES).map((outcomeSetId) => [
                    outcomeSetId,
                    {
                      kind: 'Outcome',
                      conditionId: CONDITION,
                      outcomeSetId,
                      baseAsset: 'sat',
                      unit: 'msat',
                    },
                  ]),
                )
          const exact = {
            ...winning,
            metadata: {
              ...winning.metadata,
              purpose:
                stage === 'regular'
                  ? 'daemon-complete-set-regular-split'
                  : 'daemon-complete-set-ctf-split',
              reservationId,
              inputAsset: asset,
              successorAssets: successors,
              rootOperationId: 'atomic-conversion',
              conditionId: CONDITION,
              amountMsat: 100,
            },
            reservationId,
            asset,
            root: {
              rootOperationId: 'atomic-conversion',
              mintUrl: MINT,
              conditionId: CONDITION,
              amountMsat: 100,
              regularOperationId: 'atomic-conversion:regular-split',
              ctfOperationId: null,
            },
          }
          await withDurableCustodyUnitOfWork(storage, f.fence, Date.now(), (database) => {
            commitDaemonCounterTranscript(
              database,
              f.fence.scopeId,
              { normalizedMint: MINT, unit: 'msat' },
              transcript,
              Date.now(),
            )
            if (stage === 'regular')
              prepareCompleteSetRegularProofOperationFromDatabase(database, exact, Date.now())
            else prepareCompleteSetCtfProofOperationFromDatabase(database, exact, Date.now())
          })
        },
      })
      assert.equal(observed, 1)
      assert.equal(f.counts.swaps, 1)
      assert.equal(f.posted.length, 1)
      const identity = (value: { B_: string; id: string; amount: unknown }, collection = '') =>
        JSON.stringify([collection, value.id, String(value.amount), value.B_])
      const identities = (groups: CtfPrepareProofOperationInput['outputs']) =>
        Object.entries(groups)
          .flatMap(([collection, outputs]) =>
            outputs.map(({ blindedMessage }) =>
              identity(blindedMessage, stage === 'ctf' ? collection : ''),
            ),
          )
          .sort()
      const wanted = identities(winning!.outputs)
      const discarded = identities(losing!.outputs)
      const actual =
        stage === 'regular'
          ? JSON.parse(f.swapRequests[0]!)
              .outputs.map((value: { B_: string; id: string; amount: unknown }) => identity(value))
              .sort()
          : Object.entries(f.posted[0]!.outputs)
              .flatMap(([collection, outputs]) =>
                outputs.map((value) => identity(value, collection)),
              )
              .sort()
      assert.deepEqual(actual, wanted)
      assert.notDeepEqual(actual, discarded)
      const saved = await facts(f.directory)
      await f.run()
      assert.deepEqual(await facts(f.directory), saved)
      assert.equal(f.counts.swaps, 1)
      assert.equal(f.posted.length, 1)
    } finally {
      await f.close()
    }
  })

for (const stage of ['regular', 'ctf'] as const)
  test(`${stage} orphan exact reservation without journal or root refuses before metadata`, async () => {
    const f = await fixture()
    try {
      await withDaemonStateSqliteTransaction(f.directory, (database) => {
        database
          .prepare("UPDATE target_wallet_proofs SET state = 'reserved', reserved_by = ?")
          .run(`atomic-conversion:${stage === 'regular' ? 'regular' : 'ctf'}-split:reservation`)
      })
      let wallets = 0
      let transports = 0
      await assert.rejects(
        f.run({
          ...f.deps,
          createCashuWallet: () => {
            wallets++
            throw new Error('metadata must not run')
          },
          createCtfSplitTransport: () => {
            transports++
            throw new Error('transport must not run')
          },
        }),
        /reservation|insufficient|available/,
      )
      assert.equal(f.counts.swaps, 0)
      assert.equal(f.posted.length, 0)
      assert.equal(wallets, 0)
      assert.equal(transports, 0)
    } finally {
      await f.close()
    }
  })
for (const stage of ['regular', 'ctf'] as const)
  for (const corruption of ['root', 'reservation', 'asset', 'operation'] as const)
    test(`${stage} corrupt ${corruption} binding refuses exact recovery before metadata or transport`, async () => {
      const f = await fixture()
      try {
        if (stage === 'regular')
          f.control.beforeSwap = async () => {
            throw new Error('controlled interrupted regular post')
          }
        else f.ctfControl.fail = true
        await assert.rejects(f.run(), /controlled interrupted/)
        await withDaemonStateSqliteTransaction(f.directory, (database) => {
          if (corruption === 'root')
            database
              .prepare('UPDATE daemon_complete_set_recovery_roots SET condition_id = ?')
              .run('f'.repeat(64))
          else if (corruption === 'reservation')
            database
              .prepare('UPDATE target_wallet_proofs SET reserved_by = ? WHERE reserved_by = ?')
              .run(
                'foreign-reservation',
                `atomic-conversion:${stage === 'regular' ? 'regular' : 'ctf'}-split:reservation`,
              )
          else if (corruption === 'operation')
            database
              .prepare('UPDATE target_proof_operations SET kind = ? WHERE operation_id = ?')
              .run(
                stage === 'regular' ? 'ctf-split' : 'regular-split',
                `atomic-conversion:${stage === 'regular' ? 'regular' : 'ctf'}-split`,
              )
          else
            database
              .prepare("UPDATE target_wallet_proofs SET unit = 'sat' WHERE reserved_by = ?")
              .run(`atomic-conversion:${stage === 'regular' ? 'regular' : 'ctf'}-split:reservation`)
        })
        const before = await facts(f.directory)
        const swaps = f.counts.swaps
        let wallets = 0
        let transports = 0
        await assert.rejects(
          f.run({
            ...f.deps,
            createCashuWallet: () => {
              wallets++
              throw new Error('metadata must not run')
            },
            createCtfSplitTransport: () => {
              transports++
              throw new Error('transport must not run')
            },
          }),
          /root|reservation|authority|incomplete|operation|kind/,
        )
        assert.equal(wallets, 0)
        assert.equal(transports, 0)
        assert.equal(f.counts.swaps, swaps)
        assert.deepEqual(await facts(f.directory), before)
      } finally {
        await f.close()
      }
    })

test('prepared CTF recovery uses historical stored keysets with no current partition lookup or allocation', async () => {
  const f = await fixture()
  try {
    f.ctfControl.fail = true
    await assert.rejects(f.run(), /controlled interrupted CTF post/)
    const before = await facts(f.directory)
    const operation = await withDaemonStateSqliteTransaction(f.directory, (database) =>
      readDaemonProofOperationFromDatabase(database, 'atomic-conversion:ctf-split'),
    )
    assert.equal(operation!.state, 'prepared')
    const stored = Object.entries(operation!.outputs)
      .flatMap(([collection, outputs]) =>
        outputs.map((output) =>
          JSON.stringify([
            collection,
            output.blindedMessage.id,
            String(output.blindedMessage.amount),
            output.blindedMessage.B_,
          ]),
        ),
      )
      .sort()
    f.ctfControl.fail = false
    f.control.alternateKeyset = true
    const requested: string[] = []
    await f.run({
      ...f.deps,
      createCtfSplitTransport: () => ({
        ...f.transport,
        getRootPartitionKeysets: async () => {
          throw new Error('current partition must not be read')
        },
        getConditionalKeysets: async () => [],
        getKeys: async (id) => {
          requested.push(id)
          return f.transport.getKeys(id)
        },
      }),
    })
    const after = await facts(f.directory)
    assert.deepEqual(after.target_keyset_counters, before.target_keyset_counters)
    assert.deepEqual(after.custody_keyset_counters, before.custody_keyset_counters)
    assert.equal(f.counts.swaps, 1)
    assert.equal(f.posted.length, 1)
    assert.equal(f.partitionCount(), 1)
    assert.ok(Object.values(OUTCOMES).every((id) => requested.includes(id)))
    const submitted = Object.entries(f.posted[0]!.outputs)
      .flatMap(([collection, outputs]) =>
        outputs.map((output) =>
          JSON.stringify([collection, output.id, String(output.amount), output.B_]),
        ),
      )
      .sort()
    assert.deepEqual(submitted, stored)
  } finally {
    await f.close()
  }
})
