import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  Amount,
  hashToCurve,
  MintOperationError,
  OutputData,
  type MintKeys,
  type Proof,
  type ProofState,
} from '@cashu/cashu-ts'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { dispatch, type EngineClientLike } from '../src/server.ts'
import { emptyDaemonState, readState, writeState, type StoredProofAsset } from '../src/state.ts'
import { recoverPreparedWalletSends } from '../src/walletOps.ts'
import {
  consolidateWalletProofs,
  recoverWalletProofConsolidations,
} from '../src/walletProofConsolidation.ts'

const MINT_URL = 'https://mint.example'
const SEED = '11'.repeat(64)
const REGULAR_ACTIVE_KEYSET_ID = `01${'a'.repeat(64)}`
const OUTCOME_ACTIVE_KEYSET_ID = `01${'b'.repeat(64)}`
const KEYS = Object.fromEntries(
  Array.from({ length: 21 }, (_, exponent) => [String(2 ** exponent), `key-${exponent}`]),
)

test('manual proof consolidation journals separate regular and CTF groups', async () => {
  await withProfile(async (directory) => {
    const regularAsset = { kind: 'sats', baseAsset: 'sat', unit: 'sat' } as const
    const outcomeAsset = {
      kind: 'Outcome',
      conditionId: 'condition-1',
      outcomeSetId: 'YES',
      baseAsset: 'sat',
      unit: 'msat',
    } as const
    const state = emptyDaemonState()
    addProofs(state, 'regular-old', regularAsset, 'regular')
    addProofs(state, OUTCOME_ACTIVE_KEYSET_ID, outcomeAsset, 'outcome')
    await writeState(state)
    const observedAtMs = Date.now()
    const fence = await claimCustodyScopeLease(directory, {
      scopeId: deriveDurableCustodyScopeId({
        scopeKind: 'wallet',
        walletId: deriveDurableCustodyWalletId(Buffer.from(SEED, 'hex')),
      }),
      incarnationId: 'manual-proof-consolidation-test',
      observedAtMs,
    })
    let clock = observedAtMs
    const result = await consolidateWalletProofs({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs: ++clock }),
      dependencies: fakeDependencies().dependencies,
    })

    assert.equal(result.status, 'completed')
    assert.ok(result.rounds.length >= 2)
    assert.ok(result.rounds.length <= 256)
    assert.deepEqual(new Set(result.rounds.map(({ unit }) => unit)), new Set(['sat', 'msat']))
    const persisted = await readState()
    assert.ok(persisted)
    assert.equal(
      persisted.wallet.proofs.some(({ state: proofState }) => proofState === 'reserved'),
      false,
    )
    assert.equal(
      Object.values(persisted.proofOperations).every(
        ({ state: operationState, metadata }) =>
          operationState === 'completed' && metadata.purpose === 'wallet-proof-consolidation',
      ),
      true,
    )
    assert.equal(
      persisted.wallet.proofs
        .filter(({ asset }) => asset.kind === 'sats')
        .every(({ proof }) => proof.id === REGULAR_ACTIVE_KEYSET_ID),
      true,
    )
    assert.equal(
      persisted.wallet.proofs
        .filter(({ asset }) => asset.kind === 'Outcome')
        .every(({ proof }) => proof.id === OUTCOME_ACTIVE_KEYSET_ID),
      true,
    )
  })
})

test('inactive conditional keysets are reported without an invalid cross-keyset swap', async () => {
  await withProfile(async (directory) => {
    const state = emptyDaemonState()
    addProofs(
      state,
      'outcome-old',
      {
        kind: 'Outcome',
        conditionId: 'condition-1',
        outcomeSetId: 'YES',
        baseAsset: 'sat',
        unit: 'msat',
      },
      'inactive-outcome',
    )
    await writeState(state)
    const { fence, observedAtMs } = await testFence(directory, 'inactive-conditional')
    const fake = fakeDependencies()
    const result = await consolidateWalletProofs({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs }),
      dependencies: fake.dependencies,
    })

    assert.equal(result.status, 'completed')
    assert.equal(result.rounds.length, 0)
    assert.equal(result.skipped[0]?.reason, 'inactive-conditional-keyset')
    assert.equal(fake.calls.prepare, 0)
    assert.equal(Object.keys((await readState())!.proofOperations).length, 0)
    assert.equal(
      (await readState())?.wallet.proofs.every(({ state }) => state === 'available'),
      true,
    )
  })
})

test('group paging reaches groups after the first 256 with bounded reporting', async () => {
  await withProfile(async (directory) => {
    const state = emptyDaemonState()
    for (let index = 0; index < 300; index += 1) {
      state.wallet.proofs.push({
        proof: {
          id: `regular-${String(index).padStart(3, '0')}`,
          amount: 1,
          secret: `group-secret-${index}`,
          C: `group-signature-${index}`,
        },
        mintUrl: MINT_URL,
        state: 'available',
        asset: { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
        createdAt: new Date(1).toISOString(),
        updatedAt: new Date(1).toISOString(),
      })
    }
    await writeState(state)
    const { fence, observedAtMs } = await testFence(directory, 'many-groups')
    const result = await consolidateWalletProofs({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs }),
      dependencies: fakeDependencies().dependencies,
    })

    assert.equal(result.status, 'completed')
    assert.equal(result.rounds.length, 0)
    assert.equal(result.skippedGroupCount, 300)
    assert.equal(result.skipped.length, 256)
    assert.equal(result.skippedTruncated, true)
  })
})

test('RPC fails closed without a fence and delegates with current custody authority', async () => {
  await withProfile(async (directory) => {
    const refused = await dispatch({ method: 'wallet.consolidateProofs' })
    assert.deepEqual(refused, {
      ok: false,
      error: 'wallet proof consolidation requires custody authority',
    })

    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: { id: 'regular-old', amount: 1, secret: 'rpc-secret', C: 'rpc-signature' },
      mintUrl: MINT_URL,
      state: 'available',
      asset: { kind: 'sats', baseAsset: 'sat', unit: 'sat' },
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
    })
    await writeState(state)
    const { fence } = await testFence(directory, 'rpc-current-fence')
    const response = await dispatch(
      { method: 'wallet.consolidateProofs' },
      { ...fakeDependencies().dependencies, getCustodyFence: () => fence },
    )
    assert.equal(response.ok, true)
    assert.equal((response.result as { status?: unknown }).status, 'completed')

    let custodyReady = false
    const degradedDependencies = {
      ...fakeDependencies().dependencies,
      getCustodyFence: () => fence,
      isCustodyReady: () => custodyReady,
      markCustodyReady: () => {
        custodyReady = true
      },
    }
    const health = await dispatch({ method: 'health' }, degradedDependencies)
    assert.equal((health.result as { state?: unknown }).state, 'custody-recovery-pending')
    assert.equal((await dispatch({ method: 'wallet.operations' }, degradedDependencies)).ok, true)
    assert.deepEqual(await dispatch({ method: 'wallet.consolidateProofs' }, degradedDependencies), {
      ok: false,
      code: 'custody-recovery-pending',
      error: 'wallet recovery must complete before this command can use funds',
    })
    const diagnosticEngine: EngineClientLike = {
      async submitOrder() {
        throw new Error('submit unused')
      },
      async getOrderStatus() {
        return {
          orderId: 'diagnostic-order',
          status: 'resting',
          remainingAmountSubunits: 1_000_000,
          fills: [],
          baseAsset: 'sat',
          divisibility: 1_000_000,
          activeSettlementGroup: null,
        }
      },
      async cancelOrder() {
        throw new Error('cancel unused')
      },
      async getOrderBook() {
        throw new Error('order book unused')
      },
      async queryMarkets() {
        return { markets: [], nextCursor: null }
      },
      async getParticipationScore() {
        throw new Error('score unused')
      },
      async payParticipationScoreEcash() {
        throw new Error('score payment unused')
      },
      async getMarket() {
        return { conditionId: 'condition-1', baseAsset: 'sat', divisibility: 1_000_000 }
      },
    }
    const diagnosticStatus = await dispatch(
      {
        method: 'order.status',
        params: { marketId: 'condition-1-YES', orderId: 'diagnostic-order' },
      },
      {
        ...degradedDependencies,
        createEngineClient: () => diagnosticEngine,
      },
    )
    assert.equal(diagnosticStatus.ok, true)
    const recovered = await dispatch({ method: 'wallet.recover' }, degradedDependencies)
    assert.equal(recovered.ok, true)
    assert.equal(custodyReady, true)
    assert.equal(
      ((await dispatch({ method: 'health' }, degradedDependencies)).result as { state?: unknown })
        .state,
      'ready',
    )
  })
})

test('pending explicit recovery keeps funded RPCs disabled until exact replay succeeds', async () => {
  await withProfile(async (directory) => {
    await writeRegularProofs()
    const { fence, observedAtMs } = await testFence(directory, 'degraded-recovery')
    const failed = fakeDependencies({ completeError: new Error('uncertain mint response') })
    const interrupted = await consolidateWalletProofs({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs }),
      dependencies: failed.dependencies,
    })
    assert.equal(interrupted.pending.length, 1)

    let custodyReady = false
    const pendingDependencies = {
      ...fakeDependencies({ inputState: 'PENDING' }).dependencies,
      getCustodyFence: () => fence,
      isCustodyReady: () => custodyReady,
      markCustodyReady: () => {
        custodyReady = true
      },
    }
    const pending = await dispatch({ method: 'wallet.recover' }, pendingDependencies)
    assert.equal(pending.ok, true)
    assert.equal((pending.result as { pending: unknown[] }).pending.length, 1)
    assert.equal(custodyReady, false)
    assert.equal((await dispatch({ method: 'wallet.operations' }, pendingDependencies)).ok, true)
    assert.equal(
      (await dispatch({ method: 'wallet.consolidateProofs' }, pendingDependencies)).ok,
      false,
    )

    const resolvedDependencies = {
      ...fakeDependencies({ inputState: 'UNSPENT' }).dependencies,
      getCustodyFence: () => fence,
      isCustodyReady: () => custodyReady,
      markCustodyReady: () => {
        custodyReady = true
      },
    }
    const resolved = await dispatch({ method: 'wallet.recover' }, resolvedDependencies)
    assert.equal(resolved.ok, true)
    assert.equal((resolved.result as { pending: unknown[] }).pending.length, 0)
    assert.equal(custodyReady, true)
  })
})

test('recovery replays only the exact journaled operation when inputs remain unspent', async () => {
  await withProfile(async (directory) => {
    await writeRegularProofs()
    const { fence, observedAtMs } = await testFence(directory, 'unspent-replay')
    const crashed = fakeDependencies({ completeError: new Error('simulated crash') })
    const interrupted = await consolidateWalletProofs({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs }),
      dependencies: crashed.dependencies,
    })
    assert.equal(interrupted.status, 'partial')
    assert.match(interrupted.failure?.error ?? '', /simulated crash/)
    assert.equal(interrupted.pending.length, 1)
    assert.equal(
      (await readState())?.wallet.proofs.every(({ state }) => state === 'reserved'),
      true,
    )

    const recovery = fakeDependencies({ inputState: 'UNSPENT' })
    const results = await Promise.all(
      Array.from({ length: 2 }, () =>
        recoverWalletProofConsolidations({
          secrets: { walletSeedHex: SEED },
          mutation: () => ({ fence, observedAtMs: observedAtMs + 1 }),
          dependencies: recovery.dependencies,
        }),
      ),
    )
    assert.equal(results.flatMap(({ pending }) => pending).length, 0)
    assert.equal(results.flatMap(({ recovered }) => recovered).length, 1)
    assert.equal(recovery.calls.prepare, 0)
    assert.equal(recovery.calls.complete, 1)
    assert.equal(
      (await readState())?.wallet.proofs.some(({ state }) => state === 'reserved'),
      false,
    )
  })
})

test('a later mint failure returns prior paid rounds and its recoverable operation', async () => {
  await withProfile(async (directory) => {
    await writeRegularProofs()
    const { fence, observedAtMs } = await testFence(directory, 'partial-round-report')
    const mint = fakeDependencies({
      completeErrorAt: 2,
      completeError: new Error('later mint failure'),
    })
    const result = await consolidateWalletProofs({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs }),
      dependencies: mint.dependencies,
    })

    assert.equal(result.status, 'partial')
    assert.equal(result.rounds.length, 1)
    assert.equal(result.rounds[0]?.fee, 1)
    assert.match(result.failure?.error ?? '', /later mint failure/)
    assert.equal(result.failure?.operationId, result.pending[0]?.operationId)
    assert.equal(
      (await readState())?.wallet.proofs.some(({ state }) => state === 'reserved'),
      true,
    )
  })
})

test('definitive rejected replay releases the exact still-unspent reservation', async () => {
  await withProfile(async (directory) => {
    await writeRegularProofs()
    const { fence, observedAtMs } = await testFence(directory, 'definitive-rejection')
    const rejection = new MintOperationError(11001, 'request rejected')
    const firstAttempt = fakeDependencies({ completeError: rejection })
    const interrupted = await consolidateWalletProofs({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs }),
      dependencies: firstAttempt.dependencies,
    })
    assert.equal(interrupted.pending.length, 1)

    const retry = fakeDependencies({ inputState: 'UNSPENT', completeError: rejection })
    const recovery = await recoverWalletProofConsolidations({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs: observedAtMs + 1 }),
      dependencies: retry.dependencies,
    })
    assert.equal(recovery.pending.length, 0)
    assert.equal(recovery.recovered.length, 1)
    const state = await readState()
    assert.equal(
      state?.wallet.proofs.every(({ state }) => state === 'available'),
      true,
    )
    assert.equal(Object.values(state?.proofOperations ?? {})[0]?.state, 'Failed')
    assert.equal(
      Object.values(state?.proofOperations ?? {})[0]?.lastError,
      'wallet-proof-consolidation-mint-rejected-11001',
    )
  })
})

test('post-rejection spentness recheck restores successors instead of releasing predecessors', async () => {
  await withProfile(async (directory) => {
    await writeRegularProofs()
    const { fence, observedAtMs } = await testFence(directory, 'rejection-race')
    const rejection = new MintOperationError(11001, 'request rejected')
    const accepted: Proof[] = []
    const firstAttempt = fakeDependencies({
      completeError: rejection,
      acceptBeforeError: true,
      acceptedProofs: accepted,
    })
    const interrupted = await consolidateWalletProofs({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs }),
      dependencies: firstAttempt.dependencies,
    })
    assert.equal(interrupted.pending.length, 1)
    assert.ok(accepted.length > 0)

    const retry = fakeDependencies({
      inputStates: ['UNSPENT', 'SPENT'],
      completeError: rejection,
      restoreProofs: accepted,
    })
    const recovery = await recoverWalletProofConsolidations({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs: observedAtMs + 1 }),
      dependencies: retry.dependencies,
    })
    assert.equal(recovery.pending.length, 0)
    assert.equal(recovery.recovered.length, 1)
    const state = await readState()
    assert.equal(
      state?.wallet.proofs.some(({ state }) => state === 'reserved'),
      false,
    )
    assert.equal(
      state?.wallet.proofs.every(({ state }) => state === 'available'),
      true,
    )
    assert.equal(
      state?.wallet.proofs.every(({ proof }) =>
        accepted.some(({ secret }) => secret === proof.secret),
      ),
      true,
    )
  })
})

for (const [name, corrupt] of [
  ['truncated', (states: ProofState[]) => states.slice(0, 1)],
  ['duplicate-Y', (states: ProofState[]) => [states[0]!, states[0]!]],
  [
    'foreign-Y',
    (states: ProofState[]) => [
      { ...states[0]!, Y: hashToCurve(new TextEncoder().encode('foreign')).toHex(true) },
    ],
  ],
] as const) {
  test(`post-rejection ${name} NUT-07 response cannot release reserved proofs`, async () => {
    await withProfile(async (directory) => {
      await writeRegularProofs()
      const { fence, observedAtMs } = await testFence(directory, `invalid-state-${name}`)
      const rejection = new MintOperationError(11001, 'request rejected')
      const firstAttempt = fakeDependencies({ completeError: rejection })
      const interrupted = await consolidateWalletProofs({
        secrets: { walletSeedHex: SEED },
        mutation: () => ({ fence, observedAtMs }),
        dependencies: firstAttempt.dependencies,
      })
      assert.equal(interrupted.pending.length, 1)

      const retry = fakeDependencies({
        inputState: 'UNSPENT',
        completeError: rejection,
        proofStateResponse: (states, call) => (call === 2 ? corrupt(states) : states),
      })
      const recovery = await recoverWalletProofConsolidations({
        secrets: { walletSeedHex: SEED },
        mutation: () => ({ fence, observedAtMs: observedAtMs + 1 }),
        dependencies: retry.dependencies,
      })
      assert.equal(recovery.pending.length, 1)
      const state = await readState()
      assert.equal(
        state?.wallet.proofs.every(({ state }) => state === 'reserved'),
        true,
      )
      assert.equal(Object.values(state?.proofOperations ?? {})[0]?.state, 'prepared')
    })
  })
}

test('generic send recovery ignores both exact proof-consolidation purposes', async () => {
  await withProfile(async () => {
    const state = emptyDaemonState()
    for (const [index, purpose] of [
      'wallet-proof-consolidation',
      'ctf-range-authorization-consolidation',
    ].entries()) {
      state.proofOperations[`consolidation-${index}`] = {
        operationId: `consolidation-${index}`,
        kind: 'wallet-send',
        state: 'prepared',
        mintUrl: MINT_URL,
        inputs: [{ id: 'keyset', amount: 2, secret: `input-${index}`, C: `C-${index}` }],
        outputs: { consolidated: [] },
        metadata: { purpose },
        lastError: null,
        createdAt: 1,
        updatedAt: 1,
      }
    }
    await writeState(state)
    let walletCreated = false
    const result = await recoverPreparedWalletSends(
      { walletSeedHex: SEED },
      {
        createCashuWallet: () => {
          walletCreated = true
          throw new Error('generic recovery touched an exact consolidation')
        },
      },
    )
    assert.deepEqual(result, { recovered: [], pending: [] })
    assert.equal(walletCreated, false)
  })
})

test('spent-input recovery validates exact restore before replacing predecessors', async () => {
  await withProfile(async (directory) => {
    await writeRegularProofs()
    const { fence, observedAtMs } = await testFence(directory, 'spent-restore')
    const accepted: Proof[] = []
    const mint = fakeDependencies({ acceptedProofs: accepted })
    const staleFence = { ...fence, incarnationId: 'stale-spent-restore' }
    let mutationCall = 0
    const interrupted = await consolidateWalletProofs({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({
        fence: ++mutationCall <= 2 ? fence : staleFence,
        observedAtMs,
      }),
      dependencies: mint.dependencies,
    })
    assert.match(interrupted.failure?.error ?? '', /stale or expired authority/)
    assert.ok(accepted.length > 0)
    assert.equal(
      (await readState())?.wallet.proofs.every(({ state }) => state === 'reserved'),
      true,
    )

    const invalid = fakeDependencies({
      inputState: 'SPENT',
      restoreProofs: [
        { id: REGULAR_ACTIVE_KEYSET_ID, amount: 1, secret: 'foreign', C: 'C-foreign' },
      ],
    })
    const pending = await recoverWalletProofConsolidations({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs: observedAtMs + 1 }),
      dependencies: invalid.dependencies,
    })
    assert.equal(pending.pending.length, 1)
    assert.equal(
      (await readState())?.wallet.proofs.every(({ state }) => state === 'reserved'),
      true,
    )

    const exact = fakeDependencies({ inputState: 'SPENT', restoreProofs: accepted })
    const recovered = await recoverWalletProofConsolidations({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs: observedAtMs + 2 }),
      dependencies: exact.dependencies,
    })
    assert.equal(recovered.pending.length, 0)
    assert.equal(exact.calls.complete, 0)
    assert.equal(exact.calls.restore, 1)
    assert.equal(
      (await readState())?.wallet.proofs.some(({ state }) => state === 'reserved'),
      false,
    )
  })
})

test('recovery finalizes a completed journal without another mint effect', async () => {
  await withProfile(async (directory) => {
    await writeRegularProofs()
    const { fence, observedAtMs } = await testFence(directory, 'completed-finalize')
    const mint = fakeDependencies()
    const staleFence = { ...fence, incarnationId: 'stale-completed-finalize' }
    let mutationCall = 0
    const interrupted = await consolidateWalletProofs({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({
        fence: ++mutationCall < 4 ? fence : staleFence,
        observedAtMs: observedAtMs + mutationCall,
      }),
      dependencies: mint.dependencies,
    })
    assert.match(interrupted.failure?.error ?? '', /stale or expired authority/)
    assert.equal(Object.values((await readState())!.proofOperations)[0]?.state, 'completed')

    const recovery = fakeDependencies()
    const result = await recoverWalletProofConsolidations({
      secrets: { walletSeedHex: SEED },
      mutation: () => ({ fence, observedAtMs: observedAtMs + 4 }),
      dependencies: recovery.dependencies,
    })
    assert.equal(result.pending.length, 0)
    assert.deepEqual(recovery.calls, { prepare: 0, complete: 0, check: 0, restore: 0 })
    assert.equal(
      (await readState())?.wallet.proofs.some(({ state }) => state === 'reserved'),
      false,
    )
  })
})

function addProofs(
  state: ReturnType<typeof emptyDaemonState>,
  keysetId: string,
  asset: StoredProofAsset,
  prefix: string,
): void {
  state.wallet.proofs.push(
    ...Array.from({ length: 64 }, (_, index) => ({
      proof: {
        id: keysetId,
        amount: 1,
        secret: `${prefix}-${index}`,
        C: `C-${prefix}-${index}`,
      },
      mintUrl: MINT_URL,
      state: 'available' as const,
      asset,
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
    })),
  )
}

function fakeDependencies(
  options: {
    completeError?: Error
    completeErrorAt?: number
    acceptBeforeError?: boolean
    inputState?: 'UNSPENT' | 'SPENT' | 'PENDING'
    inputStates?: Array<'UNSPENT' | 'SPENT' | 'PENDING'>
    proofStateResponse?: (states: ProofState[], call: number) => ProofState[]
    restoreProofs?: Proof[]
    acceptedProofs?: Proof[]
  } = {},
) {
  const calls = { prepare: 0, complete: 0, check: 0, restore: 0 }
  const keysets: Record<string, MintKeys> = {
    [REGULAR_ACTIVE_KEYSET_ID]: { id: REGULAR_ACTIVE_KEYSET_ID, unit: 'sat', keys: KEYS },
    [OUTCOME_ACTIVE_KEYSET_ID]: { id: OUTCOME_ACTIVE_KEYSET_ID, unit: 'msat', keys: KEYS },
  }
  const dependencies = {
    createCashuWallet: (_mintUrl: string, unit: 'sat' | 'msat' = 'sat') => ({
      loadMint: async () => undefined,
      receive: async () => [],
      send: async () => ({ keep: [], send: [] }),
      getKeyset: () =>
        keysets[unit === 'sat' ? REGULAR_ACTIVE_KEYSET_ID : OUTCOME_ACTIVE_KEYSET_ID]!,
      prepareSwapToSend: async (
        amount: number,
        inputs: Proof[],
        config: { keysetId: string },
        outputConfig: { send: { data: OutputData[] } },
      ) => {
        calls.prepare += 1
        return {
          amount: Amount.from(amount),
          fees: Amount.from(1),
          keysetId: config.keysetId,
          inputs,
          sendOutputs: outputConfig.send.data,
          keepOutputs: [],
          unselectedProofs: [],
        }
      },
      completeSwap: async (preview: { sendOutputs?: OutputData[] }) => {
        calls.complete += 1
        const send = (preview.sendOutputs ?? []).map(proofFromOutput)
        if (options.acceptBeforeError) options.acceptedProofs?.push(...send)
        if (options.completeError && (options.completeErrorAt ?? 1) === calls.complete) {
          throw options.completeError
        }
        if (!options.acceptBeforeError) options.acceptedProofs?.push(...send)
        return { keep: [], send }
      },
      checkProofsStates: async (proofs: Proof[]) => {
        calls.check += 1
        const state = options.inputStates?.[calls.check - 1] ?? options.inputState ?? 'UNSPENT'
        const states = proofs.map(({ secret }) => ({
          Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
          state,
          witness: null,
        }))
        return options.proofStateResponse?.(states, calls.check) ?? states
      },
      prepareConditionalSwap: async (input: {
        keysetId: string
        inputs: Proof[]
        outputs: [{ data: OutputData[] }]
      }) => ({
        keysetId: input.keysetId,
        inputs: input.inputs,
        outputDataByLabel: {
          consolidated: input.outputs[0].data,
        },
      }),
      completeConditionalSwap: async (preview: {
        outputDataByLabel: { consolidated: OutputData[] }
      }) => {
        calls.complete += 1
        const consolidated = preview.outputDataByLabel.consolidated.map(proofFromOutput)
        if (options.acceptBeforeError) options.acceptedProofs?.push(...consolidated)
        if (options.completeError && (options.completeErrorAt ?? 1) === calls.complete) {
          throw options.completeError
        }
        if (!options.acceptBeforeError) options.acceptedProofs?.push(...consolidated)
        return { consolidated }
      },
    }),
    resolveInputFeePpkByKeyset: async (_mintUrl: string, keysetIds: string[]) =>
      Object.fromEntries(keysetIds.map((keysetId) => [keysetId, 1])),
    resolveOutputKeysetByCollection: async () => ({ YES: OUTCOME_ACTIVE_KEYSET_ID }),
    resolveMintKeysByKeyset: async (_mintUrl: string, keysetIds: string[]) =>
      Object.fromEntries(keysetIds.map((keysetId) => [keysetId, keysets[keysetId]!])),
    restoreOutputGroups: async () => {
      calls.restore += 1
      return { consolidated: options.restoreProofs ?? [] }
    },
  }
  return { dependencies, calls }
}

async function writeRegularProofs(): Promise<void> {
  const state = emptyDaemonState()
  addProofs(state, 'regular-old', { kind: 'sats', baseAsset: 'sat', unit: 'sat' }, 'regular')
  await writeState(state)
}

async function testFence(directory: string, incarnationId: string) {
  const observedAtMs = Date.now()
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId: deriveDurableCustodyWalletId(Buffer.from(SEED, 'hex')),
    }),
    incarnationId: `manual-${incarnationId}`,
    observedAtMs,
  })
  return { fence, observedAtMs }
}

function proofFromOutput(output: OutputData): Proof {
  return {
    id: output.blindedMessage.id,
    amount: output.blindedMessage.amount,
    secret: new TextDecoder().decode(output.secret),
    C: `C-${output.blindedMessage.B_}`,
  }
}

async function withProfile(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-proof-consolidation-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT_URL,
      walletSeedHex: SEED,
      nostrSecretKeyHex: '22'.repeat(32),
    })
    await run(directory)
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}
