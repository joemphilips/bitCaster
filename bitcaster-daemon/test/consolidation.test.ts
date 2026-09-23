import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  Amount,
  CheckStateEnum,
  MintOperationError,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  type MintKeys,
  type Proof,
} from '@cashu/cashu-ts'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import { COLLATERAL_COLLECTION } from '@bitcaster-market/client-sdk/ctfConsolidation'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { dispatch, type EngineClientLike } from '../src/server.ts'
import { createDaemonSecrets } from '../src/secrets.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import {
  claimCustodyScopeLease,
  releaseCustodyScopeLease,
  type CustodyScopeFence,
} from '../src/profileFencing.ts'
import { withDurableCustodyUnitOfWork } from '../src/durableCustodyUnitOfWork.ts'
import { DurableCustodySqliteStore } from '../src/durableCustodySqliteStore.ts'
import { createCustodyProofSqliteRow } from '../src/custodyProofSqliteRow.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { deserializeOutputGroups, recoverPreparedWalletSends } from '../src/walletOps.ts'
import { emptyDaemonState, readState, writeState, type StoredProofAsset } from '../src/state.ts'

const MINT_URL = 'https://mint-a.example'
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
let activeFence: CustodyScopeFence | null = null

test('wallet.consolidateMarket executes T2 Not-A + Not-B into residual C and base collateral', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])

    const response = await dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
      depsForMarket(market('cond2', 'pending')),
    )

    assert.equal(response.ok, true)
    const result = response.result as { collateralReturnedMsat: number; convertFeeMsat: number }
    assert.equal(result.convertFeeMsat, 1)
    assert.equal(result.collateralReturnedMsat, 1)
    assertWalletProofs(await readState(), {
      sats: 1,
      outcomes: { C: 2 },
      spent: ['secret-not-a', 'secret-not-b'],
    })
    await assertConsolidatedCustody({ spent: 2, retained: 2 })
    const retry = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        ctfConvert: async () => {
          throw new Error('finalized consolidation must not call ctfConvert')
        },
      },
    )
    assert.deepEqual(retry, { recovered: [], pending: [] })
    assertNoProofInternals(response)
  })
})

test('wallet.consolidateMarket executes the existing T1 singleton-plus-top-up path', async () => {
  await withDaemonHome(async () => {
    await seedWallet([
      proofRecord(10, 'A', 'a'),
      proofRecord(10, 'B', 'b'),
      satRecord(1, 'fee-top-up'),
    ])

    const response = await dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond1-A', type: 't1' } },
      depsForMarket(market('cond1', 'pending')),
    )

    assert.equal(response.ok, true)
    const result = response.result as { collateralReturnedMsat: number; convertFeeMsat: number }
    assert.equal(result.convertFeeMsat, 1)
    assert.equal(result.collateralReturnedMsat, 0)
    assertWalletProofs(await readState(), {
      sats: 0,
      outcomes: { 'A|B': 10 },
      spent: ['secret-a', 'secret-b', 'secret-fee-top-up'],
    })
    assertNoProofInternals(response)
  })
})

test('wallet.consolidateMarket executes T3 partial chain into intermediate and base collateral', async () => {
  await withDaemonHome(async () => {
    await seedWallet([
      proofRecord(2, 'A', 't3-a'),
      proofRecord(2, 'B|C', 't3-not-a'),
      proofRecord(1, 'A|B', 'ab'),
    ])

    const response = await dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond3-A', type: 't3' } },
      depsForMarket(market('cond3', 'pending')),
    )

    assert.equal(response.ok, true)
    const result = response.result as { collateralReturnedMsat: number; convertFeeMsat: number }
    assert.equal(result.convertFeeMsat, 1)
    assert.equal(result.collateralReturnedMsat, 1)
    assertWalletProofs(await readState(), {
      sats: 1,
      outcomes: { 'A|B': 1 },
      spent: ['secret-t3-a', 'secret-t3-not-a', 'secret-ab'],
    })
    assertNoProofInternals(response)
  })
})

test('wallet.consolidateMarket refuses non-pending markets with a typed error', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a')])

    const response = await dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: 'closed-A', type: 't2' } },
      depsForMarket(market('closed', 'closed')),
    )

    assert.deepEqual(response, {
      ok: false,
      code: 'market-not-pending',
      error: 'market closed is not pending',
    })
    assertNoProofInternals(response)
  })
})

test('wallet.consolidateMarket returns typed no-gain error without mutating proofs', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(1, 'B|C', 'nogain-not-a'), proofRecord(1, 'A|C', 'nogain-not-b')])

    const response = await dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: 'nogain-A', type: 't2' } },
      depsForMarket(market('nogain', 'pending')),
    )

    assert.deepEqual(response, {
      ok: false,
      code: 'ctf-consolidation-no-gain',
      error: 'market nogain consolidation has no net collateral gain',
    })
    const persisted = await readState()
    assert.equal(persisted?.wallet.proofs.length, 2)
    assertNoProofInternals(response)
  })
})

test('wallet.consolidateMarket never treats ordinary sat proofs as msat collateral', async () => {
  await withDaemonHome(async () => {
    await seedWallet([
      proofRecord(10, 'A', 'a'),
      proofRecord(10, 'B', 'b'),
      satRecord(1, 'ordinary-sat', 'sat'),
    ])

    const response = await dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond1-A', type: 't1' } },
      depsForMarket(market('cond1', 'pending')),
    )

    assert.equal(response.ok, true)
    const persisted = await readState()
    assert.equal(
      persisted?.wallet.proofs.some((record) => record.proof.secret === 'secret-ordinary-sat'),
      true,
    )
    assertNoProofInternals(response)
  })
})

test('wallet.consolidateMarket retains both reservations when the mint result is invalid', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    await assert.rejects(
      dispatch(
        { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
        {
          ...depsForMarket(market('cond2', 'pending')),
          ctfConvert: async (_mintUrl, _request, outputsByCollection) => {
            const valid = Object.fromEntries(
              Object.entries(outputsByCollection).map(([collection, outputs]) => [
                collection,
                outputs.map((output) => signedProofFromOutput(output)),
              ]),
            )
            const firstCollection = Object.keys(valid)[0]!
            valid[firstCollection]![0] = { ...valid[firstCollection]![0]!, secret: 'forged' }
            return valid
          },
        },
      ),
      /CTF consolidation result proof differs from the output plan/,
    )
    const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
    try {
      const target = database
        .prepare(
          `SELECT state FROM target_proof_operations
           WHERE scope_id = ? AND kind = 'ctf-consolidation'`,
        )
        .get(activeFence!.scopeId) as { state: string } | undefined
      assert.equal(target?.state, 'prepared')
      const reserved = database
        .prepare(
          `SELECT COUNT(*) AS count FROM target_wallet_proofs
           WHERE scope_id = ? AND state = 'reserved'`,
        )
        .get(activeFence!.scopeId) as { count: number }
      assert.equal(reserved.count, 2)
      const locked = database
        .prepare(
          `SELECT COUNT(*) AS count FROM custody_proofs
           WHERE scope_id = ? AND selectability = 'locked' AND nut07_state = 'UNSPENT'`,
        )
        .get(activeFence!.scopeId) as { count: number }
      assert.equal(locked.count, 2)
    } finally {
      database.close()
    }
  })
})

test('wallet.consolidateMarket releases both reservations on a definite mint rejection', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    await assert.rejects(
      dispatch(
        { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
        {
          ...depsForMarket(market('cond2', 'pending')),
          createCashuWallet: () => stateReportingWallet(CheckStateEnum.UNSPENT),
          ctfConvert: async () => {
            throw new MintOperationError(11001, 'definite protocol rejection')
          },
        },
      ),
      /CTF consolidation mint rejected before mutation/,
    )
    const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
    try {
      const target = database
        .prepare(
          `SELECT state FROM target_proof_operations
           WHERE scope_id = ? AND kind = 'ctf-consolidation'`,
        )
        .get(activeFence!.scopeId) as { state: string } | undefined
      assert.equal(target?.state, 'failed')
      const reserved = database
        .prepare(
          `SELECT COUNT(*) AS count FROM target_wallet_proofs
           WHERE scope_id = ? AND state = 'reserved'`,
        )
        .get(activeFence!.scopeId) as { count: number }
      assert.equal(reserved.count, 0)
      const custody = database
        .prepare(
          `SELECT COUNT(*) AS count FROM custody_proofs
           WHERE scope_id = ? AND selectability = 'locked'`,
        )
        .get(activeFence!.scopeId) as { count: number }
      assert.equal(custody.count, 0)
    } finally {
      database.close()
    }
  })
})

test('wallet.consolidateMarket keeps reservations when a definite rejection sees spent inputs', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    await assert.rejects(
      dispatch(
        { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
        {
          ...depsForMarket(market('cond2', 'pending')),
          createCashuWallet: () => stateReportingWallet(CheckStateEnum.SPENT),
          ctfConvert: async () => {
            throw new MintOperationError(11001, 'definite protocol rejection')
          },
        },
      ),
      /CTF consolidation mint rejection remains held for exact recovery/,
    )
    const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
    try {
      const target = database
        .prepare(
          `SELECT state FROM target_proof_operations
           WHERE scope_id = ? AND kind = 'ctf-consolidation'`,
        )
        .get(activeFence!.scopeId) as { state: string } | undefined
      assert.equal(target?.state, 'prepared')
      const reserved = database
        .prepare(
          `SELECT COUNT(*) AS count FROM target_wallet_proofs
           WHERE scope_id = ? AND state = 'reserved'`,
        )
        .get(activeFence!.scopeId) as { count: number }
      assert.equal(reserved.count, 2)
      const locked = database
        .prepare(
          `SELECT COUNT(*) AS count FROM custody_proofs
           WHERE scope_id = ? AND selectability = 'locked'`,
        )
        .get(activeFence!.scopeId) as { count: number }
      assert.equal(locked.count, 2)
    } finally {
      database.close()
    }
  })
})

test('wallet.consolidateMarket blocks a competing wallet send before mint I/O', async () => {
  await withDaemonHome(async () => {
    await seedWallet([
      proofRecord(10, 'A', 'a'),
      proofRecord(10, 'B', 'b'),
      satRecord(1, 'fee-top-up'),
    ])
    let enteredMint: (() => void) | undefined
    const mintEntered = new Promise<void>((resolve) => {
      enteredMint = resolve
    })
    let releaseMint: (() => void) | undefined
    const mintGate = new Promise<void>((resolve) => {
      releaseMint = resolve
    })
    let mintCalls = 0
    const first = dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond1-A', type: 't1' } },
      {
        ...depsForMarket(market('cond1', 'pending')),
        ctfConvert: async (_mintUrl, _request, outputsByCollection) => {
          mintCalls += 1
          enteredMint?.()
          await mintGate
          return Object.fromEntries(
            Object.entries(outputsByCollection).map(([collection, outputs]) => [
              collection,
              outputs.map((output) => signedProofFromOutput(output)),
            ]),
          )
        },
      },
    )
    await mintEntered
    await assert.rejects(
      dispatch(
        {
          method: 'wallet.send',
          params: { amountMsat: 1, mintUrl: MINT_URL, operationId: 'competing-send' },
        },
        {
          ...depsForMarket(market('cond1', 'pending')),
          createCashuWallet: () => ({
            loadMint: async () => undefined,
            receive: async () => [],
            send: async () => ({ keep: [], send: [] }),
            prepareSwapToSend: async (_amount, proofs) => {
              assert.equal(proofs.length, 0)
              throw new Error('competing send saw no available proofs')
            },
            completeSwap: async () => ({ keep: [], send: [] }),
          }),
          triggerCustodyRecovery: () => undefined,
          ctfConvert: async () => {
            throw new Error('competing CTF send reached mint')
          },
        },
      ),
      /no available proofs/,
    )
    assert.equal(mintCalls, 1)
    releaseMint?.()
    const response = await first
    assert.equal(response.ok, true)
    assert.equal(mintCalls, 1)
  })
})

test('wallet.consolidateMarket rejects forged canonical proof material before mint I/O', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
    try {
      database
        .prepare(`UPDATE custody_proofs SET amount = amount + 1 WHERE scope_id = ?`)
        .run(activeFence!.scopeId)
    } finally {
      database.close()
    }
    let mintCalls = 0
    await assert.rejects(
      dispatch(
        { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
        {
          ...depsForMarket(market('cond2', 'pending')),
          ctfConvert: async () => {
            mintCalls += 1
            throw new Error('forged material reached mint')
          },
        },
      ),
      /canonical input material differs from custody/,
    )
    assert.equal(mintCalls, 0)
  })
})

test('wallet.consolidateMarket rejects forged canonical asset metadata before mint I/O', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
    try {
      database
        .prepare(`UPDATE custody_proofs SET outcome_set_id = 'forged' WHERE scope_id = ?`)
        .run(activeFence!.scopeId)
    } finally {
      database.close()
    }
    let mintCalls = 0
    await assert.rejects(
      dispatch(
        { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
        {
          ...depsForMarket(market('cond2', 'pending')),
          ctfConvert: async () => {
            mintCalls += 1
            throw new Error('forged asset reached mint')
          },
        },
      ),
      /canonical input material differs from custody/,
    )
    assert.equal(mintCalls, 0)
  })
})

test('wallet.consolidateMarket rolls back canonical preparation faults before mint I/O', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    let mintCalls = 0
    await assert.rejects(
      dispatch(
        { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
        {
          ...depsForMarket(market('cond2', 'pending')),
          injectCustodyFault: (phase) => {
            if (phase === 'before-commit') throw new Error('injected CTF preparation rollback')
          },
          ctfConvert: async () => {
            mintCalls += 1
            throw new Error('preparation fault reached mint')
          },
        },
      ),
      /injected CTF preparation rollback/,
    )
    assert.equal(mintCalls, 0)
    const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
    try {
      const target = database
        .prepare(
          `SELECT COUNT(*) AS count FROM target_proof_operations
           WHERE scope_id = ? AND kind = 'ctf-consolidation'`,
        )
        .get(activeFence!.scopeId) as { count: number }
      assert.equal(target.count, 0)
      const locked = database
        .prepare(
          `SELECT COUNT(*) AS count FROM custody_proofs
           WHERE scope_id = ? AND selectability = 'locked'`,
        )
        .get(activeFence!.scopeId) as { count: number }
      assert.equal(locked.count, 0)
    } finally {
      database.close()
    }
  })
})

test('wallet.consolidateMarket keeps a finalized result recoverable after commit fault', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    let beforeCommitCalls = 0
    const deps = {
      ...depsForMarket(market('cond2', 'pending')),
      injectCustodyFault: (phase: 'transaction-opened' | 'before-commit' | 'after-commit') => {
        if (phase === 'before-commit' && ++beforeCommitCalls === 2) {
          throw new Error('injected CTF finalization rollback')
        }
      },
    }
    await assert.rejects(
      dispatch(
        { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
        deps,
      ),
      /injected CTF finalization rollback/,
    )
    const prepared = await readState()
    assert.ok(prepared)
    const operationId = Object.keys(prepared.proofOperations)[0]
    assert.ok(operationId)
    assert.equal(prepared.proofOperations[operationId]?.state, 'prepared')
    const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
    try {
      const reserved = database
        .prepare(
          `SELECT COUNT(*) AS count FROM target_wallet_proofs
           WHERE scope_id = ? AND state = 'reserved'`,
        )
        .get(activeFence!.scopeId) as { count: number }
      assert.equal(reserved.count, 2)
      const locked = database
        .prepare(
          `SELECT COUNT(*) AS count FROM custody_proofs
           WHERE scope_id = ? AND selectability = 'locked'`,
        )
        .get(activeFence!.scopeId) as { count: number }
      assert.equal(locked.count, 2)
    } finally {
      database.close()
    }
    const recovery = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        ctfConvert: async (_mintUrl, _request, outputsByCollection) =>
          Object.fromEntries(
            Object.entries(outputsByCollection).map(([collection, outputs]) => [
              collection,
              outputs.map((output) => signedProofFromOutput(output)),
            ]),
          ),
      },
    )
    assert.deepEqual(recovery, { recovered: [operationId], pending: [] })
  })
})

test('wallet recovery replays durable CTF result after an after-commit fault', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    let afterCommitCalls = 0
    await assert.rejects(
      dispatch(
        { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
        {
          ...depsForMarket(market('cond2', 'pending')),
          injectCustodyFault: (phase) => {
            if (phase === 'after-commit' && ++afterCommitCalls === 2) {
              throw new Error('injected CTF finalization after-commit fault')
            }
          },
        },
      ),
      /injected CTF finalization after-commit fault/,
    )
    assert.equal(afterCommitCalls, 2)
    const committed = await readState()
    assert.ok(committed)
    const operationId = Object.keys(committed.proofOperations)[0]
    assert.ok(operationId)
    assert.equal(committed.proofOperations[operationId]?.state, 'completed')
    committed.wallet.proofs = []
    await writeState(committed)

    let mintCalls = 0
    let resolverCalls = 0
    const recovery = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        resolveMintKeysByKeyset: async () => {
          resolverCalls += 1
          throw new Error('after-commit replay must not resolve mint keys')
        },
        resolveDurableCustodyKeysets: async () => {
          resolverCalls += 1
          throw new Error('after-commit replay must not resolve custody keysets')
        },
        ctfConvert: async () => {
          mintCalls += 1
          throw new Error('after-commit replay must not call the mint')
        },
      },
    )
    assert.deepEqual(recovery, { recovered: [operationId], pending: [] })
    assert.equal(mintCalls, 0)
    assert.equal(resolverCalls, 0)
    assertWalletProofs(await readState(), {
      sats: 1,
      outcomes: { C: 2 },
      spent: ['secret-not-a', 'secret-not-b'],
    })
    await assertConsolidatedCustody({ spent: 2, retained: 2 })
    const retry = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        ctfConvert: async () => {
          throw new Error('after-commit retry must not call the mint')
        },
      },
    )
    assert.deepEqual(retry, { recovered: [], pending: [] })
  })
})

test('wallet recovery sweep resumes prepared CTF consolidation operations', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    await assert.rejects(
      dispatch(
        { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
        {
          ...depsForMarket(market('cond2', 'pending')),
          ctfConvert: async () => {
            throw new Error('uncertain mint transport')
          },
        },
      ),
      /CTF consolidation mint result is uncertain/,
    )
    const prepared = await readState()
    assert.ok(prepared)
    const operationId = Object.keys(prepared.proofOperations)[0]
    assert.ok(operationId)
    assert.equal(prepared.proofOperations[operationId]?.state, 'prepared')

    let ctfConvertCalls = 0
    const recovery = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        resolveMintKeysByKeyset: async (_mintUrl: string, keysetIds: string[]) =>
          Object.fromEntries(keysetIds.map((id) => [id, fakeMintKeys(id)])),
        resolveDurableCustodyKeysets: async (_mintUrl, keysetIds) =>
          keysetIds.map((id) => ({
            canonicalMintUrl: MINT_URL,
            id,
            unit: 'msat',
            keys: fakeMintKeys(id).keys,
            inputFeePpk: 1,
            finalExpiry: null,
            identity: { kind: 'regular' as const },
          })),
        ctfConvert: async (mintUrl, request, outputsByCollection) => {
          ctfConvertCalls += 1
          assert.equal(mintUrl, MINT_URL)
          assert.equal(request.condition_id, 'cond2')
          assert.deepEqual(Object.keys(request.inputs).sort(), ['A|C', 'B|C'])
          assert.deepEqual(Object.keys(request.outputs).sort(), [COLLATERAL_COLLECTION, 'C'])
          assert.deepEqual(Object.keys(outputsByCollection).sort(), [COLLATERAL_COLLECTION, 'C'])
          return Object.fromEntries(
            Object.entries(outputsByCollection).map(([collection, outputs]) => [
              collection,
              outputs.map((output) => signedProofFromOutput(output)),
            ]),
          )
        },
      },
    )

    assert.deepEqual(recovery, {
      recovered: [operationId],
      pending: [],
    })
    assert.equal(ctfConvertCalls, 1)
    const updated = await readState()
    assert.equal(updated?.proofOperations[operationId]?.state, 'completed')
    assertWalletProofs(updated, {
      sats: 1,
      outcomes: { C: 2 },
      spent: ['secret-not-a', 'secret-not-b'],
    })
  })
})

test('wallet recovery restores exact outputs after a committed mint loses its response', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    await assert.rejects(
      dispatch(
        { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
        {
          ...depsForMarket(market('cond2', 'pending')),
          ctfConvert: async () => {
            throw new Error('local response lost after mint commit')
          },
        },
      ),
      /CTF consolidation mint result is uncertain/,
    )
    const prepared = await readState()
    assert.ok(prepared)
    const operationId = Object.keys(prepared.proofOperations)[0]
    assert.ok(operationId)
    const persistedOutputs = prepared.proofOperations[operationId]!.outputs
    let stateChecks = 0
    let recoveryMintCalls = 0
    let restoreCalls = 0
    const recovery = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        createCashuWallet: () => ({
          loadMint: async () => undefined,
          receive: async () => [],
          send: async () => ({ keep: [], send: [] }),
          checkProofsStates: async (proofs: Array<Pick<Proof, 'id' | 'secret'>>) => {
            stateChecks += 1
            const state = stateChecks === 1 ? CheckStateEnum.UNSPENT : CheckStateEnum.SPENT
            return proofs.map(() => ({ state }))
          },
        }),
        ctfConvert: async () => {
          recoveryMintCalls += 1
          throw new MintOperationError(11001, 'already spent after committed mint')
        },
        restoreOutputGroups: async (_mintUrl, outputs) => {
          restoreCalls += 1
          assert.deepEqual(outputs, persistedOutputs)
          return Object.fromEntries(
            Object.entries(deserializeOutputGroups(outputs)).map(([collection, groupOutputs]) => [
              collection,
              groupOutputs.map((output) => signedProofFromOutput(output)),
            ]),
          )
        },
      },
    )
    assert.deepEqual(recovery, { recovered: [operationId], pending: [] })
    assert.equal(recoveryMintCalls, 1)
    assert.equal(restoreCalls, 1)
    assertWalletProofs(await readState(), {
      sats: 1,
      outcomes: { C: 2 },
      spent: ['secret-not-a', 'secret-not-b'],
    })
    const retry = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        ctfConvert: async () => {
          throw new Error('exactly-once recovery called mint again')
        },
      },
    )
    assert.deepEqual(retry, { recovered: [], pending: [] })
    assert.equal((await readState())?.proofOperations[operationId]?.state, 'completed')
    assert.deepEqual(persistedOutputs, prepared.proofOperations[operationId]!.outputs)
  })
})

test('wallet recovery sweep finalizes completed CTF consolidation operations', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])
    const response = await dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
      depsForMarket(market('cond2', 'pending')),
    )
    assert.equal(response.ok, true)
    const completed = await readState()
    assert.ok(completed)
    const operationId = Object.keys(completed.proofOperations)[0]
    assert.ok(operationId)
    assert.equal(completed.proofOperations[operationId]?.state, 'completed')
    completed.wallet.proofs = []
    await writeState(completed)

    const recovery = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        resolveMintKeysByKeyset: async (_mintUrl: string, keysetIds: string[]) =>
          Object.fromEntries(keysetIds.map((id) => [id, fakeMintKeys(id)])),
        resolveDurableCustodyKeysets: async (_mintUrl, keysetIds) =>
          keysetIds.map((id) => ({
            canonicalMintUrl: MINT_URL,
            id,
            unit: 'msat',
            keys: fakeMintKeys(id).keys,
            inputFeePpk: 1,
            finalExpiry: null,
            identity: { kind: 'regular' as const },
          })),
        ctfConvert: async () => {
          throw new Error('completed operation should not call ctfConvert')
        },
      },
    )

    assert.deepEqual(recovery, {
      recovered: [operationId],
      pending: [],
    })
    assertWalletProofs(await readState(), {
      sats: 1,
      outcomes: { C: 2 },
      spent: ['secret-not-a', 'secret-not-b'],
    })
  })
})

test('wallet recovery preserves committed CTF custody when the wallet projection is stale', async () => {
  await withDaemonHome(async () => {
    const inputs = [proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')]
    await seedWallet(inputs)
    const response = await dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
      depsForMarket(market('cond2', 'pending')),
    )
    assert.equal(response.ok, true)
    const completed = await readState()
    assert.ok(completed)
    const operationId = Object.keys(completed.proofOperations)[0]
    assert.ok(operationId)
    const resultProofs = Object.fromEntries(
      Object.entries(completed.proofOperations[operationId]?.resultProofs ?? {}).map(
        ([collection, proofs]) => [collection, proofs as Proof[]],
      ),
    ) as Record<string, Proof[]>
    assert.equal(Object.keys(resultProofs).length, 2)
    completed.wallet.proofs = []
    await writeState(completed)

    const initialRecovery = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        resolveMintKeysByKeyset: async (_mintUrl: string, keysetIds: string[]) =>
          Object.fromEntries(keysetIds.map((id) => [id, fakeMintKeys(id)])),
        resolveDurableCustodyKeysets: async (_mintUrl, keysetIds) =>
          keysetIds.map((id) => ({
            canonicalMintUrl: MINT_URL,
            id,
            unit: 'msat',
            keys: fakeMintKeys(id).keys,
            inputFeePpk: 1,
            finalExpiry: null,
            identity: { kind: 'regular' as const },
          })),
        ctfConvert: async () => {
          throw new Error('committed consolidation must not call ctfConvert')
        },
      },
    )
    assert.deepEqual(initialRecovery, {
      recovered: [operationId],
      pending: [],
    })

    const committedState = await readState()
    assert.ok(committedState)
    committedState.wallet.proofs = []
    await writeState(committedState)

    const fence = activeFence
    if (fence === null) throw new Error('consolidation test custody fence is missing')
    await withDurableCustodyUnitOfWork(
      process.env.BITCASTER_DAEMON_HOME!,
      fence,
      Date.now(),
      (database) => {
        const custody = new DurableCustodySqliteStore(database)
        const successors = resultProofs[COLLATERAL_COLLECTION]!.concat(resultProofs.C!)
        successors.forEach((proof, index) => {
          const proofRow = database
            .prepare(
              `SELECT proof_id AS proofId FROM custody_proofs
               WHERE scope_id = ? AND keyset_id = ? AND amount = ?`,
            )
            .get(fence.scopeId, proof.id, amountToNumber(proof.amount)) as
            | { proofId: string }
            | undefined
          assert.ok(proofRow)
          const existing = custody.getProof(fence.scopeId, proofRow.proofId)
          assert.ok(existing)
          custody.putProofCas(
            {
              ...existing,
              nut07State: index === 0 ? 'UNSPENT' : 'SPENT',
              selectability: index === 0 ? 'locked' : 'spent',
              reservationOperationId: index === 0 ? 'unrelated-reservation' : null,
              revision: existing.revision + 1,
              updatedAtMs: existing.updatedAtMs + 1,
            },
            existing.revision,
          )
        })
      },
    )

    const retry = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        resolveMintKeysByKeyset: async (_mintUrl: string, keysetIds: string[]) =>
          Object.fromEntries(keysetIds.map((id) => [id, fakeMintKeys(id)])),
        resolveDurableCustodyKeysets: async (_mintUrl, keysetIds) =>
          keysetIds.map((id) => ({
            canonicalMintUrl: MINT_URL,
            id,
            unit: 'msat',
            keys: fakeMintKeys(id).keys,
            inputFeePpk: 1,
            finalExpiry: null,
            identity: { kind: 'regular' as const },
          })),
        ctfConvert: async () => {
          throw new Error('committed consolidation must not call ctfConvert')
        },
      },
    )
    assert.deepEqual(retry, {
      recovered: [operationId],
      pending: [],
    })

    const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
    try {
      const custody = new DurableCustodySqliteStore(database)
      const findSuccessor = (proof: Proof): ReturnType<typeof custody.getProof> => {
        const proofRow = database
          .prepare(
            `SELECT proof_id AS proofId FROM custody_proofs
             WHERE scope_id = ? AND keyset_id = ? AND amount = ?`,
          )
          .get(fence.scopeId, proof.id, amountToNumber(proof.amount)) as
          | { proofId: string }
          | undefined
        assert.ok(proofRow)
        return custody.getProof(fence.scopeId, proofRow.proofId)
      }
      assert.equal(findSuccessor(resultProofs[COLLATERAL_COLLECTION]![0]!)?.selectability, 'locked')
      assert.equal(findSuccessor(resultProofs.C![0]!)?.selectability, 'spent')
    } finally {
      database.close()
    }
    assert.equal((await readState())?.wallet.proofs.length, 2)
  })
})

test('wallet recovery replays applied conditional custody offline after keyset rotation', async () => {
  await withDaemonHome(async () => {
    const conditionId = 'ab'.repeat(32)
    const keysets = conditionalOutputKeysets(conditionId)
    const records = [
      proofRecord(2, 'B|C', 'conditional-not-a'),
      proofRecord(2, 'A|C', 'conditional-not-b'),
    ]
    for (const record of records) {
      if (record.asset.kind === 'Outcome') {
        record.asset = { ...record.asset, conditionId }
        record.proof.id = keysets[record.asset.outcomeSetId]!
      }
    }
    await seedWallet(records)
    const response = await dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: `${conditionId}-A`, type: 't2' } },
      depsForMarket(market(conditionId, 'pending'), { conditionalConditionId: conditionId }),
    )
    assert.equal(response.ok, true)
    const completed = await readState()
    assert.ok(completed)
    const operationId = Object.keys(completed.proofOperations)[0]
    assert.ok(operationId)
    completed.wallet.proofs = []
    await writeState(completed)

    const recovery = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(64) },
      {
        getCustodyFence: () => {
          if (activeFence === null) throw new Error('consolidation test custody fence is missing')
          return activeFence
        },
        resolveMintKeysByKeyset: async () => {
          throw new Error('rotated keyset resolver must not be called for applied replay')
        },
        resolveDurableCustodyKeysets: async () => {
          throw new Error('rotated custody keyset resolver must not be called for applied replay')
        },
        ctfConvert: async () => {
          throw new Error('offline applied replay must not call the mint')
        },
      },
    )
    assert.deepEqual(recovery, { recovered: [operationId], pending: [] })
    assertWalletProofs(await readState(), {
      sats: 1,
      outcomes: { C: 2 },
      spent: ['secret-conditional-not-a', 'secret-conditional-not-b'],
    })
  })
})

async function withDaemonHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-consolidation-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-06-05T00:00:00.000Z')
    const profile = await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT_URL,
      walletSeedHex: secrets.walletSeedHex,
      nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      nostrPublicKeyHex: secrets.nostrPublicKeyHex,
    })
    activeFence = await claimCustodyScopeLease(home, {
      scopeId: profile.walletScopeId,
      incarnationId: 'consolidation-test',
      observedAtMs: Date.now(),
    })
    await run()
  } finally {
    if (activeFence !== null) {
      await releaseCustodyScopeLease(home, activeFence, Date.now()).catch(() => undefined)
      activeFence = null
    }
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

async function seedWallet(records: ReturnType<typeof proofRecord>[]): Promise<void> {
  const state = emptyDaemonState()
  state.wallet.proofs.push(...records)
  await writeState(state)
  await seedCustodyRows(records)
}

async function seedCustodyRows(records: ReturnType<typeof proofRecord>[]): Promise<void> {
  const fence = activeFence
  if (fence === null) throw new Error('consolidation test custody fence is missing')
  await withDurableCustodyUnitOfWork(
    process.env.BITCASTER_DAEMON_HOME!,
    fence,
    Date.now(),
    (database) => {
      const custody = new DurableCustodySqliteStore(database)
      for (const record of records) {
        const asset = record.asset
        const row = createCustodyProofSqliteRow({
          scopeId: fence.scopeId,
          normalizedMint: record.mintUrl,
          unit: asset.unit,
          proof: {
            id: record.proof.id,
            amount: record.proof.amount,
            secret: record.proof.secret,
            C: record.proof.C,
            dleq: record.proof.dleq ?? null,
            p2pkE: record.proof.p2pk_e ?? null,
            witness: record.proof.witness ?? null,
          },
          baseAsset: 'sat',
          conditionId: asset.kind === 'Outcome' ? asset.conditionId : null,
          outcomeSetId: asset.kind === 'Outcome' ? asset.outcomeSetId : null,
          productBinding: null,
          signatureVerified: true,
          dleqState: record.proof.dleq === undefined ? 'not-present' : 'verified',
          nut07State: 'UNSPENT',
          selectability: 'retained',
          storageClass: 'terminal-replay-retained',
          reservationOperationId: null,
          revision: 0,
          nowMs: Date.now(),
        })
        custody.putProofCas(row, null)
      }
    },
  )
}

function depsForMarket(marketResponse: unknown, options: { conditionalConditionId?: string } = {}) {
  const conditionalConditionId = options.conditionalConditionId
  const keysets =
    conditionalConditionId === undefined ? null : conditionalOutputKeysets(conditionalConditionId)
  return {
    getCustodyFence: () => {
      if (activeFence === null) throw new Error('consolidation test custody fence is missing')
      return activeFence
    },
    createEngineClient: () => fakeEngine(marketResponse),
    resolveInputFeePpkByKeyset: async (_mintUrl: string, keysetIds: string[]) =>
      Object.fromEntries(keysetIds.map((id) => [id, 1])),
    resolveOutputKeysetByCollection: async () => keysets ?? outputKeysets(),
    resolveMintKeysByKeyset: async (_mintUrl: string, keysetIds: string[]) =>
      Object.fromEntries(keysetIds.map((id) => [id, fakeMintKeys(id)])),
    resolveDurableCustodyKeysets: async (_mintUrl: string, keysetIds: string[]) =>
      keysetIds.map((id) => ({
        canonicalMintUrl: MINT_URL,
        id,
        unit: 'msat',
        keys: fakeMintKeys(id).keys,
        inputFeePpk: 1,
        finalExpiry: null,
        identity:
          keysets === null || id === keysets['*']
            ? { kind: 'regular' as const }
            : {
                kind: 'conditional' as const,
                conditionId: conditionalConditionId!,
                outcomeCollection:
                  Object.entries(keysets).find(([, keysetId]) => keysetId === id)?.[0] ??
                  (() => {
                    throw new Error('conditional test keyset identity is missing')
                  })(),
                outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
                  conditionId: conditionalConditionId!,
                  outcomeCollection:
                    Object.entries(keysets).find(([, keysetId]) => keysetId === id)?.[0] ??
                    (() => {
                      throw new Error('conditional test keyset identity is missing')
                    })(),
                }),
              },
      })),
    ctfConvert: async (
      _mintUrl: string,
      _request: unknown,
      outputsByCollection: Record<string, OutputData[]>,
    ) =>
      Object.fromEntries(
        Object.entries(outputsByCollection).map(([collection, outputs]) => [
          collection,
          outputs.map((output) => signedProofFromOutput(output)),
        ]),
      ),
  }
}

function stateReportingWallet(state: CheckStateEnum) {
  return {
    loadMint: async () => undefined,
    receive: async () => [],
    send: async () => ({ keep: [], send: [] }),
    checkProofsStates: async (proofs: Array<Pick<Proof, 'id' | 'secret'>>) =>
      proofs.map(() => ({ state })),
  }
}

function fakeEngine(marketResponse: unknown): EngineClientLike {
  return {
    async submitOrder() {
      throw new Error('submitOrder not used')
    },
    async getOrderStatus() {
      throw new Error('getOrderStatus not used')
    },
    async cancelOrder() {
      throw new Error('cancelOrder not used')
    },
    async getOrderBook() {
      throw new Error('getOrderBook not used')
    },
    async queryMarkets() {
      return { markets: [marketResponse] }
    },
    async getMarket() {
      return marketResponse
    },
  }
}

function market(conditionId: string, status: string): unknown {
  return {
    conditionId,
    status,
    outcomes: ['A', 'B', 'C'],
  }
}

function outputKeysets(): Record<string, string> {
  const keysetId = deriveKeysetId(
    Object.fromEntries(
      [
        '1',
        '2',
        '4',
        '8',
        '16',
        '32',
        '64',
        '128',
        '256',
        '512',
        '1024',
        '2048',
        '4096',
        '8192',
        '16384',
      ].map((amount) => [amount, MINT_PUBLIC_KEY]),
    ),
    { unit: 'msat', input_fee_ppk: 1, versionByte: 1 },
  )
  return Object.fromEntries(
    ['*', 'A', 'B', 'C', 'A|B', 'A|C', 'B|C'].map((collection) => [collection, keysetId]),
  )
}

function conditionalOutputKeysets(conditionId: string): Record<string, string> {
  const regular = outputKeysets()['*']!
  const keys = fakeMintKeys(regular).keys
  return Object.fromEntries(
    ['*', 'A', 'B', 'C', 'A|B', 'A|C', 'B|C'].map((collection) => {
      if (collection === '*') return [collection, regular]
      const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
        conditionId,
        outcomeCollection: collection,
      })
      return [
        collection,
        deriveConditionalKeysetId({
          keys,
          unit: 'msat',
          input_fee_ppk: 1,
          conditionId,
          outcomeCollectionId,
        }),
      ]
    }),
  )
}

function fakeMintKeys(id: string): MintKeys {
  return {
    id,
    unit: 'msat',
    active: true,
    input_fee_ppk: 1,
    keys: {
      '1': MINT_PUBLIC_KEY,
      '2': MINT_PUBLIC_KEY,
      '4': MINT_PUBLIC_KEY,
      '8': MINT_PUBLIC_KEY,
      '16': MINT_PUBLIC_KEY,
      '32': MINT_PUBLIC_KEY,
      '64': MINT_PUBLIC_KEY,
      '128': MINT_PUBLIC_KEY,
      '256': MINT_PUBLIC_KEY,
      '512': MINT_PUBLIC_KEY,
      '1024': MINT_PUBLIC_KEY,
      '2048': MINT_PUBLIC_KEY,
      '4096': MINT_PUBLIC_KEY,
      '8192': MINT_PUBLIC_KEY,
      '16384': MINT_PUBLIC_KEY,
    },
  } as MintKeys
}

function signedProofFromOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    MINT_PRIVATE_KEY,
    output.blindedMessage.id,
  )
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), MINT_PRIVATE_KEY)
  return output.toProof(
    {
      id: signature.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: {
        e: Buffer.from(dleq.e).toString('hex'),
        s: Buffer.from(dleq.s).toString('hex'),
      },
    },
    fakeMintKeys(output.blindedMessage.id),
  )
}

function satRecord(
  amount: number,
  label: string,
  unit: 'sat' | 'msat' = 'msat',
): ReturnType<typeof proofRecord> {
  const record = proofRecord(amount, null, label)
  record.asset = { kind: 'sats', baseAsset: 'sat', unit }
  return record
}

function proofRecord(
  amount: number,
  outcomeSetId: string | null,
  label: string,
  keysetId?: string,
): {
  mintUrl: string
  proof: Proof
  state: 'available'
  asset: StoredProofAsset
  createdAt: string
  updatedAt: string
} {
  const asset: StoredProofAsset = outcomeSetId
    ? {
        kind: 'Outcome',
        conditionId: conditionIdForLabel(label),
        outcomeSetId,
        baseAsset: 'sat',
        unit: 'msat',
      }
    : { kind: 'sats', baseAsset: 'sat', unit: 'msat' }
  return {
    mintUrl: MINT_URL,
    proof: {
      id: keysetId ?? (outcomeSetId ? outputKeysets()[outcomeSetId]! : outputKeysets()['*']!),
      amount,
      secret: `secret-${label}`,
      C: `C-${label}`,
    } as Proof,
    state: 'available',
    asset,
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  }
}

function conditionIdForLabel(label: string): string {
  if (label.startsWith('nogain-')) return 'nogain'
  if (label.startsWith('t3-') || label === 'ab') return 'cond3'
  if (label.includes('fee')) return 'cond1'
  if (label === 'a' || label === 'b') return 'cond1'
  if (label === 'not-a' || label === 'not-b') return 'cond2'
  return 'nogain'
}

function assertWalletProofs(
  state: Awaited<ReturnType<typeof readState>>,
  expected: { sats: number; outcomes: Record<string, number>; spent: string[] },
): void {
  assert.ok(state)
  for (const spentSecret of expected.spent) {
    assert.equal(
      state.wallet.proofs.some((record) => record.proof.secret === spentSecret),
      false,
      `${spentSecret} should be removed`,
    )
  }
  const satTotal = state.wallet.proofs
    .filter((record) => record.asset.kind === 'sats')
    .reduce((sum, record) => sum + amountToNumber(record.proof.amount), 0)
  assert.equal(satTotal, expected.sats)
  for (const [outcomeSetId, amount] of Object.entries(expected.outcomes)) {
    const total = state.wallet.proofs
      .filter(
        (record) => record.asset.kind === 'Outcome' && record.asset.outcomeSetId === outcomeSetId,
      )
      .reduce((sum, record) => sum + amountToNumber(record.proof.amount), 0)
    assert.equal(total, amount, `${outcomeSetId} amount`)
  }
}

async function assertConsolidatedCustody(expected: {
  spent: number
  retained: number
}): Promise<void> {
  const fence = activeFence
  if (fence === null) throw new Error('consolidation test custody fence is missing')
  const database = await openDaemonStateSqlite(process.env.BITCASTER_DAEMON_HOME!)
  try {
    const spent = database
      .prepare(
        `SELECT COUNT(*) AS count FROM custody_proofs
         WHERE scope_id = ? AND nut07_state = 'SPENT' AND selectability = 'spent'`,
      )
      .get(fence.scopeId) as { count: number }
    const retained = database
      .prepare(
        `SELECT COUNT(*) AS count FROM custody_proofs
         WHERE scope_id = ? AND nut07_state = 'UNSPENT' AND selectability = 'retained'`,
      )
      .get(fence.scopeId) as { count: number }
    assert.equal(spent.count, expected.spent)
    assert.equal(retained.count, expected.retained)
  } finally {
    database.close()
  }
}

function assertNoProofInternals(value: unknown): void {
  const text = JSON.stringify(value)
  assert.doesNotMatch(text, /secret-|out-secret-|C-|out-C-|witness|mnemonic|nwc/i)
}
