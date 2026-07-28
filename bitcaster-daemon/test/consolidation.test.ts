import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { MintKeys, OutputData, Proof } from '@cashu/cashu-ts'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import { COLLATERAL_COLLECTION } from '@bitcaster-market/client-sdk/ctfConsolidation'
import { dispatch, type EngineClientLike } from '../src/server.ts'
import { createDaemonSecrets } from '../src/secrets.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { recoverPreparedWalletSends } from '../src/walletOps.ts'
import {
  emptyDaemonState,
  markProofOperationCompleted,
  prepareProofOperation,
  readState,
  writeState,
  type StoredProofAsset,
} from '../src/state.ts'

const MINT_URL = 'https://mint-a.example'

test('wallet.consolidateMarket executes T2 Not-A + Not-B into residual C and base collateral', async () => {
  await withDaemonHome(async () => {
    await seedWallet([proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b')])

    const response = await dispatch(
      { method: 'wallet.consolidateMarket', params: { marketId: 'cond2-A', type: 't2' } },
      depsForMarket(market('cond2', 'pending')),
    )

    assert.equal(response.ok, true)
    const result = response.result as { collateralReturnedSats: number; convertFeeSats: number }
    assert.equal(result.convertFeeSats, 1)
    assert.equal(result.collateralReturnedSats, 1)
    assertWalletProofs(await readState(), {
      sats: 1,
      outcomes: { C: 2 },
      spent: ['secret-not-a', 'secret-not-b'],
    })
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
    const result = response.result as { collateralReturnedSats: number; convertFeeSats: number }
    assert.equal(result.convertFeeSats, 1)
    assert.equal(result.collateralReturnedSats, 0)
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
    const result = response.result as { collateralReturnedSats: number; convertFeeSats: number }
    assert.equal(result.convertFeeSats, 1)
    assert.equal(result.collateralReturnedSats, 1)
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

test('wallet recovery sweep resumes prepared CTF consolidation operations', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.wallet.proofs.push(proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b'))
    await writeState(state)
    await prepareProofOperation({
      operationId: 'ctf-consolidation-recover',
      kind: 'ctf-consolidation',
      mintUrl: MINT_URL,
      inputs: state.wallet.proofs.map((record) => record.proof),
      outputs: {
        [COLLATERAL_COLLECTION]: [storedOutput('ks-base', 1, 'base')],
        C: [storedOutput('ks-C', 2, 'C')],
      },
      metadata: {
        marketId: 'cond2-A',
        conditionId: 'cond2',
        type: 't2',
        inputCollections: ['B|C', 'A|C'],
        feeSats: 1,
        collateralOutputSats: 1,
      },
    })

    let ctfConvertCalls = 0
    const recovery = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(32) },
      {
        ctfConvert: async (mintUrl, request, outputsByCollection) => {
          ctfConvertCalls += 1
          assert.equal(mintUrl, MINT_URL)
          assert.equal(request.condition_id, 'cond2')
          assert.deepEqual(Object.keys(request.inputs).sort(), ['A|C', 'B|C'])
          assert.deepEqual(Object.keys(request.outputs).sort(), [COLLATERAL_COLLECTION, 'C'])
          assert.deepEqual(Object.keys(outputsByCollection).sort(), [COLLATERAL_COLLECTION, 'C'])
          return {
            [COLLATERAL_COLLECTION]: [cashuProof(1, 'recovered-base', 'ks-base')],
            C: [cashuProof(2, 'recovered-C', 'ks-C')],
          }
        },
      },
    )

    assert.deepEqual(recovery, {
      recovered: ['ctf-consolidation-recover'],
      pending: [],
    })
    assert.equal(ctfConvertCalls, 1)
    const updated = await readState()
    assert.equal(updated?.proofOperations['ctf-consolidation-recover']?.state, 'completed')
    assertWalletProofs(updated, {
      sats: 1,
      outcomes: { C: 2 },
      spent: ['secret-not-a', 'secret-not-b'],
    })
  })
})

test('wallet recovery sweep finalizes completed CTF consolidation operations', async () => {
  await withDaemonHome(async () => {
    const state = emptyDaemonState()
    state.wallet.proofs.push(proofRecord(2, 'B|C', 'not-a'), proofRecord(2, 'A|C', 'not-b'))
    await writeState(state)
    await prepareProofOperation({
      operationId: 'ctf-consolidation-finalize',
      kind: 'ctf-consolidation',
      mintUrl: MINT_URL,
      inputs: state.wallet.proofs.map((record) => record.proof),
      outputs: {
        [COLLATERAL_COLLECTION]: [storedOutput('ks-base', 1, 'base')],
        C: [storedOutput('ks-C', 2, 'C')],
      },
      metadata: {
        marketId: 'cond2-A',
        conditionId: 'cond2',
        type: 't2',
        inputCollections: ['B|C', 'A|C'],
        feeSats: 1,
        collateralOutputSats: 1,
      },
    })
    await markProofOperationCompleted('ctf-consolidation-finalize', {
      [COLLATERAL_COLLECTION]: [cashuProof(1, 'finalized-base', 'ks-base')],
      C: [cashuProof(2, 'finalized-C', 'ks-C')],
    })

    const recovery = await recoverPreparedWalletSends(
      { walletSeedHex: '00'.repeat(32) },
      {
        ctfConvert: async () => {
          throw new Error('completed operation should not call ctfConvert')
        },
      },
    )

    assert.deepEqual(recovery, {
      recovered: ['ctf-consolidation-finalize'],
      pending: [],
    })
    assertWalletProofs(await readState(), {
      sats: 1,
      outcomes: { C: 2 },
      spent: ['secret-not-a', 'secret-not-b'],
    })
  })
})

async function withDaemonHome(run: () => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-consolidation-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = home
  try {
    const secrets = createDaemonSecrets('2026-06-05T00:00:00.000Z')
    await bootstrapFreshDaemonProfile({
      directory: home,
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT_URL,
      walletSeedHex: secrets.walletSeedHex,
      nostrSecretKeyHex: secrets.nostrSecretKeyHex,
      nostrPublicKeyHex: secrets.nostrPublicKeyHex,
    })
    await run()
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
}

async function seedWallet(records: ReturnType<typeof proofRecord>[]): Promise<void> {
  const state = emptyDaemonState()
  state.wallet.proofs.push(...records)
  await writeState(state)
}

function depsForMarket(marketResponse: unknown) {
  return {
    createEngineClient: () => fakeEngine(marketResponse),
    resolveInputFeePpkByKeyset: async (_mintUrl: string, keysetIds: string[]) =>
      Object.fromEntries(keysetIds.map((id) => [id, 1])),
    resolveOutputKeysetByCollection: async () => outputKeysets(),
    resolveMintKeysByKeyset: async (_mintUrl: string, keysetIds: string[]) =>
      Object.fromEntries(keysetIds.map((id) => [id, fakeMintKeys(id)])),
    ctfConvert: async (
      _mintUrl: string,
      _request: unknown,
      outputsByCollection: Record<string, OutputData[]>,
    ) =>
      Object.fromEntries(
        Object.entries(outputsByCollection).map(([collection, outputs]) => [
          collection,
          outputs.map((output, index) => ({
            id: output.blindedMessage.id,
            amount: amountToNumber(output.blindedMessage.amount),
            secret: `out-secret-${collection}-${index}`,
            C: `out-C-${collection}-${index}`,
          })),
        ]),
      ),
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
  return {
    '*': 'ks-base',
    A: 'ks-A',
    B: 'ks-B',
    C: 'ks-C',
    'A|B': 'ks-A|B',
    'A|C': 'ks-A|C',
    'B|C': 'ks-B|C',
  }
}

function fakeMintKeys(id: string): MintKeys {
  return {
    id,
    unit: 'sat',
    active: true,
    input_fee_ppk: 1,
    keys: {
      '1': '02'.padEnd(66, '1'),
      '2': '02'.padEnd(66, '2'),
      '4': '02'.padEnd(66, '3'),
      '8': '02'.padEnd(66, '4'),
      '16': '02'.padEnd(66, '5'),
    },
  } as MintKeys
}

function storedOutput(keysetId: string, amount: number, label: string) {
  return {
    blindedMessage: {
      amount,
      id: keysetId,
      B_: `B-${label}`,
    },
    blindingFactor: '01',
    secret: `00${label.charCodeAt(0).toString(16)}`,
  }
}

function cashuProof(amount: number, label: string, id: string): Proof {
  return {
    id,
    amount,
    secret: `secret-${label}`,
    C: `C-${label}`,
  } as Proof
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
      id: outcomeSetId ? outputKeysets()[outcomeSetId] : 'ks-base',
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

function assertNoProofInternals(value: unknown): void {
  const text = JSON.stringify(value)
  assert.doesNotMatch(text, /secret-|out-secret-|C-|out-C-|witness|mnemonic|nwc/i)
}
