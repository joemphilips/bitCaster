import { createSeedRecoveryScanPolicy } from '@bitcaster-market/client-sdk/seedRecoveryScanPolicy'
import { mintDenominationPrivateKey } from '../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  Amount,
  CheckStateEnum,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  hashToCurve,
  pointFromHex,
  type MintKeys,
  type Proof,
  type SerializedBlindedMessage,
} from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { advanceDaemonKeysetCounter, readAvailableWalletProofsFenced } from '../src/state.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import {
  recoverAllDaemonWalletFromSeed,
  type AllKeysetSeedRecoveryTransport,
} from '../src/emergencySeedRecovery.ts'
import { createSeedRecoveryProfile, withDaemonHome } from './seedRecoveryTestSupport.ts'

const V2_ID = `01${'a'.repeat(64)}`
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const CONDITION_ID = 'ab'.repeat(32)
const MSAT_RECOVERY_COUNTER_BINDING = {
  normalizedMint: 'https://mint.example',
  unit: 'msat' as const,
}

test('all-keyset recovery finalizes only after complete empty listings', async () => {
  const fixture = await recoveryFixture('empty')
  try {
    const result = await recoverAllDaemonWalletFromSeed(
      request(fixture),
      dependencies(fixture, emptyTransport()),
    )
    assert.deepEqual(result, {
      recoveryId: 'all-empty',
      state: 'completed',
      selectedKeysetCount: 0,
      completedChildCount: 0,
      batchesProcessed: 0,
      gapLimit: 300,
      retainedOutputProofsImported: 0,
      scanPolicy: createSeedRecoveryScanPolicy(),
      scannedRanges: [],
      uncoveredLocalCounterBindings: { count: 0, capped: false, diagnostic: null },
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('all-keyset recovery rejects non-V2 regular authority before wallet restore I/O', async () => {
  const fixture = await recoveryFixture('v2x')
  try {
    let loaded = false
    const transport = emptyTransport({ keysets: [{ id: `02${'b'.repeat(64)}`, unit: 'msat' }] })
    transport.wallet.loadMint = async () => {
      loaded = true
    }
    await assert.rejects(
      () => recoverAllDaemonWalletFromSeed(request(fixture), dependencies(fixture, transport)),
      /V2/,
    )
    assert.equal(loaded, false)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('all-keyset recovery reports an uncovered local binding without global fallback', async () => {
  const fixture = await recoveryFixture('high-water')
  try {
    await withDaemonHome(fixture.directory, () =>
      advanceDaemonKeysetCounter(V2_ID, 1, fixture.mutation, MSAT_RECOVERY_COUNTER_BINDING),
    )
    const result = await recoverAllDaemonWalletFromSeed(
      request(fixture),
      dependencies(fixture, emptyTransport()),
    )
    assert.equal(result.state, 'completed')
    assert.deepEqual(result.uncoveredLocalCounterBindings, {
      count: 1,
      capped: false,
      diagnostic: 'uncovered-local-counter-bindings',
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('all-keyset recovery spends its four-batch budget on one continuing child', async () => {
  const fixture = await recoveryFixture('continuation')
  try {
    await withDaemonHome(fixture.directory, () =>
      advanceDaemonKeysetCounter(V2_ID, 1_500, fixture.mutation, MSAT_RECOVERY_COUNTER_BINDING),
    )
    const starts: number[] = []
    const transport = emptyTransport({ keysets: [{ id: V2_ID, unit: 'msat' }] })
    let start = 0
    transport.restoreCandidates = async () => {
      starts.push(start)
      start += 300
      return { outputs: [], signatures: [] }
    }
    const result = await recoverAllDaemonWalletFromSeed(
      request(fixture),
      dependencies(fixture, transport),
    )
    assert.deepEqual(starts, [0, 300, 600, 900])
    assert.equal(result.state, 'active')
    assert.equal(result.batchesProcessed, 4)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('all-keyset recovery fetches exact keys for an inactive regular keyset', async () => {
  const fixture = await recoveryFixture('inactive-regular')
  const inactive = regularKeyset({ '1': MINT_PUBLIC_KEY })
  const fetched: string[] = []
  const starts: number[] = []
  const transport = recoveryTransport({
    regular: [{ id: inactive.id, unit: inactive.unit, active: false }],
    onEnsureKeysetKeys(id) {
      fetched.push(id)
      return inactive
    },
    onRestore(_keysetId, start, outputs) {
      starts.push(start)
      return start === 0
        ? restoreResponse(outputs.slice(0, 1), [1])
        : { outputs: [], signatures: [] }
    },
    onCheckStates: (proofs) => proofs.map((proof) => proofState(proof, CheckStateEnum.UNSPENT)),
  })
  try {
    const result = await recoverAllDaemonWalletFromSeed(
      request(fixture),
      dependencies(fixture, transport),
    )
    assert.deepEqual(fetched, [inactive.id])
    assert.deepEqual(starts, [0, 300])
    assert.equal(result.state, 'completed')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('all-keyset recovery discovers inactive CTF authority and admits exact Outcome proofs', async () => {
  const fixture = await recoveryFixture('conditional')
  const conditional = conditionalAuthority({ active: false, finalExpiry: 10 })
  const regular = regularKeyset({ '1': MINT_PUBLIC_KEY }, 'msat')
  const fetched: string[] = []
  const starts = new Map<string, number[]>()
  const transport = recoveryTransport({
    regular: [{ id: regular.id, unit: 'msat' }],
    conditional: [conditionalDescriptor(conditional)],
    regularKeys: [regular],
    onConditionalFetch(id) {
      fetched.push(id)
      return conditional
    },
    onRestore(keysetId, start, outputs) {
      appendStart(starts, keysetId, start)
      return keysetId === conditional.id && start === 0
        ? restoreResponse(outputs.slice(0, 2), [1, 2], true)
        : { outputs: [], signatures: [] }
    },
    onCheckStates(proofs) {
      return [...proofs].reverse().map((proof) => proofState(proof, CheckStateEnum.UNSPENT))
    },
  })
  transport.wallet.loadMint = async () => {
    throw new Error('condition recovery must not load the global mint')
  }
  try {
    const result = await recoverAllDaemonWalletFromSeed(
      {
        ...request(fixture, 'msat'),
        scanPolicy: createSeedRecoveryScanPolicy({ conditionId: CONDITION_ID }),
      },
      { ...dependencies(fixture, transport), _allowConditionFixture: true },
    )
    assert.deepEqual(fetched, [conditional.id])
    assert.equal(starts.has(regular.id), false)
    assert.deepEqual(starts.get(conditional.id), [0, 300])
    assert.equal(result.selectedKeysetCount, 1)
    assert.equal(result.completedChildCount, 1)
    assert.equal(result.batchesProcessed, 2)

    await withDaemonHome(fixture.directory, async () => {
      const available = await readAvailableWalletProofsFenced({
        mintUrl: 'https://mint.example',
        asset: {
          kind: 'Outcome',
          conditionId: conditional.condition_id,
          outcomeSetId: conditional.outcome_collection,
          baseAsset: 'sat',
          unit: 'msat',
        },
        mutation: { fence: fixture.fence, observedAtMs: 5 },
      })
      assert.deepEqual(
        available.map(({ proof }) => Number(proof.amount)).sort((left, right) => left - right),
        [1, 2],
      )
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('condition fixture refuses an unrelated listing without global fallback', async () => {
  const fixture = await recoveryFixture('condition-foreign')
  let regularCalls = 0
  const transport = recoveryTransport({
    conditional: [conditionalDescriptor(conditionalAuthority({ conditionId: 'bc'.repeat(32) }))],
  })
  transport.listRegularKeysets = async () => {
    regularCalls++
    throw new Error('global fallback')
  }
  try {
    await assert.rejects(
      () =>
        recoverAllDaemonWalletFromSeed(
          {
            ...request(fixture),
            scanPolicy: createSeedRecoveryScanPolicy({ conditionId: CONDITION_ID }),
          },
          { ...dependencies(fixture, transport), _allowConditionFixture: true },
        ),
      /condition listing is foreign/,
    )
    assert.equal(regularCalls, 0)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('regular recovery refuses a keyset counter alias before scan or roster writes', async () => {
  const fixture = await recoveryFixture('regular-counter-alias')
  const regular = regularKeyset({ '1': MINT_PUBLIC_KEY })
  let restoreCalls = 0
  let loadedMint = false
  const transport = recoveryTransport({
    regular: [{ id: regular.id, unit: regular.unit }],
    regularKeys: [regular],
  })
  transport.wallet.loadMint = async () => {
    loadedMint = true
  }
  try {
    await insertCounterAlias(fixture, 'target_keyset_counters', regular.id)
    const before = await readRecoveryAuthoritySnapshot(fixture.directory, fixture.fence.scopeId)
    await assert.rejects(
      () => recoverAllDaemonWalletFromSeed(request(fixture), dependencies(fixture, transport)),
      /another mint URL/,
    )
    assert.equal(restoreCalls, 0)
    assert.equal(loadedMint, false)
    const after = await readRecoveryAuthoritySnapshot(fixture.directory, fixture.fence.scopeId)
    assert.deepEqual(after.targetCounters, before.targetCounters)
    assert.deepEqual(after.custodyCounters, before.custodyCounters)
    assert.deepEqual(after.recoveryKeysets, before.recoveryKeysets)
    assert.equal(after.recoveryJobs.length, 1)
    assert.equal(after.recoveryJobs[0]!.discovery_state, 'pending')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('conditional recovery refuses an alias before unmatched discovery or roster writes', async () => {
  const fixture = await recoveryFixture('conditional-counter-alias')
  const conditional = conditionalAuthority()
  let restoreCalls = 0
  let fetchedKeys = 0
  let loadedMint = false
  const transport = recoveryTransport({
    conditional: [conditionalDescriptor(conditional)],
    onConditionalFetch() {
      fetchedKeys += 1
      throw new Error('unmatched conditional keysets must not fetch keys')
    },
  })
  transport.wallet.loadMint = async () => {
    loadedMint = true
  }
  try {
    await insertCounterAlias(fixture, 'custody_keyset_counters', conditional.id)
    const before = await readRecoveryAuthoritySnapshot(fixture.directory, fixture.fence.scopeId)
    await assert.rejects(
      () =>
        recoverAllDaemonWalletFromSeed(
          {
            ...request(fixture, 'msat'),
            scanPolicy: createSeedRecoveryScanPolicy({ conditionId: CONDITION_ID }),
          },
          { ...dependencies(fixture, transport), _allowConditionFixture: true },
        ),
      /another mint URL/,
    )
    assert.equal(restoreCalls, 0)
    assert.equal(fetchedKeys, 0)
    assert.equal(loadedMint, false)
    const after = await readRecoveryAuthoritySnapshot(fixture.directory, fixture.fence.scopeId)
    assert.deepEqual(after.targetCounters, before.targetCounters)
    assert.deepEqual(after.custodyCounters, before.custodyCounters)
    assert.deepEqual(after.recoveryKeysets, before.recoveryKeysets)
    assert.equal(after.recoveryJobs.length, 1)
    assert.equal(after.recoveryJobs[0]!.discovery_state, 'pending')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('local conditional counter authority selects a keyset without a discovery match', async () => {
  const fixture = await recoveryFixture('conditional-high-water')
  const conditional = conditionalAuthority()
  const starts: number[] = []
  try {
    await withDaemonHome(fixture.directory, () =>
      advanceDaemonKeysetCounter(conditional.id, 1, fixture.mutation, {
        normalizedMint: 'https://mint.example',
        unit: 'msat',
      }),
    )
    const transport = recoveryTransport({
      conditional: [conditionalDescriptor(conditional)],
      onConditionalFetch: () => conditional,
      onRestore(_keysetId, start) {
        starts.push(start)
        return { outputs: [], signatures: [] }
      },
    })
    const result = await recoverAllDaemonWalletFromSeed(
      {
        ...request(fixture, 'msat'),
        scanPolicy: createSeedRecoveryScanPolicy({ conditionId: CONDITION_ID }),
      },
      { ...dependencies(fixture, transport), _allowConditionFixture: true },
    )
    assert.deepEqual(starts, [0, 1])
    assert.equal(result.selectedKeysetCount, 1)
    assert.equal(result.state, 'completed')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('a pending child consumes one attempt while another child completes', async () => {
  const fixture = await recoveryFixture('pending-child')
  const pendingKeyset = regularKeyset({ '1': MINT_PUBLIC_KEY })
  const otherKeyset = regularKeyset({ '2': MINT_PUBLIC_KEY })
  const starts = new Map<string, number[]>()
  const transport = recoveryTransport({
    regular: [pendingKeyset, otherKeyset].map(({ id, unit }) => ({ id, unit })),
    regularKeys: [pendingKeyset, otherKeyset],
    onRestore(keysetId, start, outputs) {
      appendStart(starts, keysetId, start)
      return keysetId === pendingKeyset.id
        ? restoreResponse(outputs.slice(0, 1), [1])
        : { outputs: [], signatures: [] }
    },
    onCheckStates: (proofs) => proofs.map((proof) => proofState(proof, CheckStateEnum.PENDING)),
  })
  try {
    const result = await recoverAllDaemonWalletFromSeed(
      request(fixture),
      dependencies(fixture, transport),
    )
    assert.deepEqual(starts.get(pendingKeyset.id), [0])
    assert.deepEqual(starts.get(otherKeyset.id), [0])
    assert.equal(result.state, 'active')
    assert.equal(result.selectedKeysetCount, 2)
    assert.equal(result.completedChildCount, 1)
    assert.equal(result.batchesProcessed, 2)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('a durable roster resumes a pending conditional child without rediscovery', async () => {
  const fixture = await recoveryFixture('durable-roster')
  const conditional = conditionalAuthority()
  const first = recoveryTransport({
    conditional: [conditionalDescriptor(conditional)],
    onConditionalFetch: () => conditional,
    onRestore(_keysetId, _start, outputs) {
      return restoreResponse(outputs.slice(0, 1), [1])
    },
    onCheckStates: (proofs) => proofs.map((proof) => proofState(proof, CheckStateEnum.PENDING)),
  })
  try {
    const pending = await recoverAllDaemonWalletFromSeed(
      {
        ...request(fixture, 'msat'),
        scanPolicy: createSeedRecoveryScanPolicy({ conditionId: CONDITION_ID }),
      },
      { ...dependencies(fixture, first), _allowConditionFixture: true },
    )
    assert.equal(pending.state, 'active')

    const starts: number[] = []
    const resumed = recoveryTransport({
      conditional: [conditionalDescriptor(conditional)],
      onConditionalFetch: () => conditional,
      onRestore(_keysetId, start) {
        starts.push(start)
        return { outputs: [], signatures: [] }
      },
    })
    const completed = await recoverAllDaemonWalletFromSeed(
      {
        ...request(fixture, 'msat'),
        scanPolicy: createSeedRecoveryScanPolicy({ conditionId: CONDITION_ID }),
      },
      { ...dependencies(fixture, resumed), _allowConditionFixture: true },
    )
    assert.deepEqual(starts, [0])
    assert.equal(completed.state, 'completed')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('fair scan rotation reaches a fifth blocked child on the next invocation', async () => {
  const fixture = await recoveryFixture('fair-scan')
  const keysets = [1, 2, 4, 8, 16]
    .map((amount) => regularKeyset({ [String(amount)]: MINT_PUBLIC_KEY }))
    .sort((left, right) => left.id.localeCompare(right.id))
  const attempted: string[] = []
  const createTransport = () =>
    recoveryTransport({
      regular: keysets.map(({ id, unit }) => ({ id, unit })),
      regularKeys: keysets,
      onRestore(keysetId, _start, outputs) {
        attempted.push(keysetId)
        const amount = Number(Object.keys(keysets.find(({ id }) => id === keysetId)!.keys)[0])
        return restoreResponse(outputs.slice(0, 1), [amount])
      },
      onCheckStates: (proofs) => proofs.map((proof) => proofState(proof, CheckStateEnum.PENDING)),
    })
  try {
    await recoverAllDaemonWalletFromSeed(request(fixture), dependencies(fixture, createTransport()))
    assert.deepEqual(
      attempted,
      keysets.slice(0, 4).map(({ id }) => id),
    )
    attempted.length = 0
    await recoverAllDaemonWalletFromSeed(request(fixture), dependencies(fixture, createTransport()))
    assert.equal(attempted[0], keysets[4]!.id)
    assert.equal(new Set(attempted).size, 4)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('full recovery rejects missing DLEQ without advancing its durable cursor', async () => {
  const fixture = await recoveryFixture('missing-dleq')
  const keyset = regularKeyset({ '1': MINT_PUBLIC_KEY })
  const invalid = recoveryTransport({
    regular: [{ id: keyset.id, unit: keyset.unit }],
    regularKeys: [keyset],
    onRestore(_keysetId, _start, outputs) {
      const response = restoreResponse(outputs.slice(0, 1), [1])
      return {
        ...response,
        signatures: response.signatures.map(({ dleq: _, ...signature }) => signature),
      }
    },
  })
  try {
    await assert.rejects(
      () => recoverAllDaemonWalletFromSeed(request(fixture), dependencies(fixture, invalid)),
      /DLEQ/i,
    )
    const starts: number[] = []
    const resumed = recoveryTransport({
      regular: [{ id: keyset.id, unit: keyset.unit }],
      regularKeys: [keyset],
      onRestore(_keysetId, start) {
        starts.push(start)
        return { outputs: [], signatures: [] }
      },
    })
    await recoverAllDaemonWalletFromSeed(request(fixture), dependencies(fixture, resumed))
    assert.deepEqual(starts, [0])
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('full recovery rejects a foreign raw row without advancing its durable cursor', async () => {
  const fixture = await recoveryFixture('foreign-raw-row')
  const keyset = regularKeyset({ '1': MINT_PUBLIC_KEY })
  const invalid = recoveryTransport({
    regular: [{ id: keyset.id, unit: keyset.unit }],
    regularKeys: [keyset],
    onRestore(_keysetId, _start, outputs) {
      const response = restoreResponse(outputs.slice(0, 1), [1])
      return {
        ...response,
        outputs: response.outputs.map((output) => ({ ...output, B_: MINT_PUBLIC_KEY })),
      }
    },
  })
  try {
    await assert.rejects(
      () => recoverAllDaemonWalletFromSeed(request(fixture), dependencies(fixture, invalid)),
      /foreign/,
    )
    const starts: number[] = []
    const resumed = recoveryTransport({
      regular: [{ id: keyset.id, unit: keyset.unit }],
      regularKeys: [keyset],
      onRestore(_keysetId, start) {
        starts.push(start)
        return { outputs: [], signatures: [] }
      },
    })
    await recoverAllDaemonWalletFromSeed(request(fixture), dependencies(fixture, resumed))
    assert.deepEqual(starts, [0])
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

async function recoveryFixture(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `bitcaster-all-recovery-${label}-`))
  const walletSeedHex = '42'.repeat(64)
  const { fence } = await createSeedRecoveryProfile({
    directory,
    walletSeedHex,
    nostrSecretKeyHex: '43'.repeat(32),
    incarnationId: `all-recovery-${label}`,
  })
  return { directory, walletSeedHex, fence, mutation: { fence, observedAtMs: 3 } }
}

async function insertCounterAlias(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  table: 'target_keyset_counters' | 'custody_keyset_counters',
  keysetId: string,
): Promise<void> {
  const database = await openDaemonStateSqlite(fixture.directory)
  try {
    if (table === 'target_keyset_counters') {
      database
        .prepare(
          `INSERT INTO target_keyset_counters (
             scope_id, normalized_mint, unit, keyset_id, next_counter, updated_at_ms
           ) VALUES (?, 'https://mint-alias.example', 'sat', ?, 9, 2)`,
        )
        .run(fixture.fence.scopeId, keysetId)
      return
    }
    database
      .prepare(
        `INSERT INTO custody_keyset_counters (
           scope_id, normalized_mint, unit, keyset_id,
           next_counter, revision, updated_at_ms
         ) VALUES (?, 'https://mint-alias.example', 'sat', ?, 9, 0, 2)`,
      )
      .run(fixture.fence.scopeId, keysetId)
  } finally {
    database.close()
  }
}

async function readRecoveryAuthoritySnapshot(directory: string, scopeId: string) {
  const database = await openDaemonStateSqlite(directory)
  try {
    return {
      targetCounters: database
        .prepare(
          `SELECT * FROM target_keyset_counters WHERE scope_id = ?
           ORDER BY normalized_mint, unit, keyset_id`,
        )
        .all(scopeId),
      custodyCounters: database
        .prepare(
          `SELECT * FROM custody_keyset_counters WHERE scope_id = ?
           ORDER BY normalized_mint, unit, keyset_id`,
        )
        .all(scopeId),
      recoveryJobs: database
        .prepare('SELECT * FROM seed_recovery_jobs WHERE scope_id = ? ORDER BY recovery_id')
        .all(scopeId),
      recoveryKeysets: database
        .prepare(
          `SELECT * FROM seed_recovery_keysets
           WHERE recovery_id IN (
             SELECT recovery_id FROM seed_recovery_jobs WHERE scope_id = ?
           ) ORDER BY recovery_id, keyset_id`,
        )
        .all(scopeId),
    }
  } finally {
    database.close()
  }
}

function request(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  unit: 'sat' | 'msat' = 'msat',
) {
  return {
    recoveryId: 'all-empty',
    mintUrl: 'https://mint.example',
    unit,
    walletSeedHex: fixture.walletSeedHex,
    disclosureAcknowledged: true as const,
  }
}

function dependencies(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  transport: AllKeysetSeedRecoveryTransport,
  nowMs = 4,
) {
  return {
    directory: fixture.directory,
    getFence: () => fixture.fence,
    transport,
    nowMs: () => nowMs,
    invocationId: () => 'all-keyset-test',
  }
}

function regularKeyset(keys: Record<string, string>, unit = 'msat'): MintKeys {
  return { id: deriveKeysetId(keys, { unit, versionByte: 1 }), unit, keys }
}

function conditionalAuthority(
  input: { active?: boolean; conditionId?: string; finalExpiry?: number } = {},
) {
  const conditionId = input.conditionId ?? CONDITION_ID
  const outcomeCollection = 'NO|YES'
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({ conditionId, outcomeCollection })
  const keys = {
    '1': MINT_PUBLIC_KEY,
    '2': '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5',
  }
  return {
    id: deriveConditionalKeysetId({
      keys,
      unit: 'msat',
      final_expiry: input.finalExpiry ?? 10,
      conditionId,
      outcomeCollectionId,
    }),
    unit: 'msat' as const,
    active: input.active ?? true,
    final_expiry: input.finalExpiry ?? 10,
    condition_id: conditionId,
    outcome_collection: outcomeCollection,
    outcome_collection_id: outcomeCollectionId,
    registered_at: 0,
    keys,
  }
}

function conditionalDescriptor(authority: ReturnType<typeof conditionalAuthority>) {
  const { keys: _, ...descriptor } = authority
  return descriptor
}

function proofState(proof: Proof, state: (typeof CheckStateEnum)[keyof typeof CheckStateEnum]) {
  return {
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state,
    witness: null,
  }
}

function appendStart(starts: Map<string, number[]>, keysetId: string, start: number): void {
  const values = starts.get(keysetId) ?? []
  values.push(start)
  starts.set(keysetId, values)
}

function recoveryTransport(input: {
  regular?: readonly Record<string, unknown>[]
  conditional?: readonly Record<string, unknown>[]
  regularKeys?: readonly MintKeys[]
  onEnsureKeysetKeys?: (id: string) => MintKeys
  onConditionalFetch?: (id: string) => ReturnType<typeof conditionalAuthority>
  onRestore?: (
    keysetId: string,
    start: number,
    outputs: readonly SerializedBlindedMessage[],
  ) => unknown
  onCheckStates?: (proofs: readonly Proof[]) => ReturnType<typeof proofState>[]
}): AllKeysetSeedRecoveryTransport {
  const keys = new Map((input.regularKeys ?? []).map((keyset) => [keyset.id, keyset]))
  const starts = new Map<string, number>()
  const wallet = {
    async loadMint() {},
    keyChain: {
      getKeysets: () => [...keys.values()].map(({ id }) => ({ id })),
      getKeyset: (id?: string) => keys.get(id ?? '')!,
      async ensureKeysetKeys(id: string) {
        if (!keys.has(id) && input.onEnsureKeysetKeys !== undefined) {
          const keyset = input.onEnsureKeysetKeys(id)
          keys.set(keyset.id, keyset)
        }
        const keyset = keys.get(id)
        if (keyset === undefined) throw new Error(`test keyset ${id} is unavailable`)
        return keyset
      },
      registerConditionalKeyset: (_metadata: unknown, keyset: MintKeys) => {
        keys.set(keyset.id, keyset)
      },
    },
    getKeyset: (id?: string) => keys.get(id ?? '')!,
    async checkProofsStates(proofs: Proof[]) {
      return input.onCheckStates?.(proofs) ?? []
    },
  }
  return {
    wallet,
    async listRegularKeysets() {
      return { keysets: input.regular ?? [] }
    },
    async listConditionalKeysets() {
      return { keysets: input.conditional ?? [] }
    },
    async getConditionalKeyset(id) {
      if (input.onConditionalFetch === undefined) throw new Error('unexpected fetch')
      return input.onConditionalFetch(id)
    },
    async restoreCandidates(outputs) {
      const keysetId = (outputs[0] as SerializedBlindedMessage).id
      const start = starts.get(keysetId) ?? 0
      starts.set(keysetId, start + outputs.length)
      return (
        input.onRestore?.(keysetId, start, outputs as SerializedBlindedMessage[]) ?? {
          outputs: [],
          signatures: [],
        }
      )
    },
  }
}

function emptyTransport(regular: unknown = { keysets: [] }): AllKeysetSeedRecoveryTransport {
  return {
    wallet: {
      async loadMint() {},
      keyChain: {
        getKeysets: () => [],
        getKeyset: () => ({ id: V2_ID, unit: 'msat', keys: {} }),
        async ensureKeysetKeys() {
          return { id: V2_ID, unit: 'msat', keys: {} }
        },
      },
      getKeyset: () => ({ id: V2_ID, unit: 'msat', keys: {} }),
      async checkProofsStates() {
        throw new Error('empty recovery must not query NUT-07')
      },
    },
    async listRegularKeysets() {
      return regular
    },
    async listConditionalKeysets() {
      throw new Error('regular recovery must not list conditional keysets')
    },
    async getConditionalKeyset() {
      throw new Error('empty recovery must not fetch conditional keys')
    },
    async restoreCandidates() {
      return { outputs: [], signatures: [] }
    },
  }
}

function restoreResponse(
  outputs: readonly SerializedBlindedMessage[],
  amounts: readonly number[],
  distinctDenominations = false,
) {
  return {
    outputs: outputs.map((output) => ({ ...output, amount: Amount.from(0) })),
    signatures: outputs.map((output, index) => {
      const privateKey = distinctDenominations
        ? mintDenominationPrivateKey(MINT_PRIVATE_KEY, String(amounts[index]!))
        : MINT_PRIVATE_KEY
      const signature = createBlindSignature(pointFromHex(output.B_), privateKey, output.id)
      const dleq = createDLEQProof(pointFromHex(output.B_), privateKey)
      return {
        id: output.id,
        amount: Amount.from(amounts[index]!),
        C_: signature.C_.toHex(true),
        dleq: {
          e: Buffer.from(dleq.e).toString('hex'),
          s: Buffer.from(dleq.s).toString('hex'),
        },
      }
    }),
  }
}

test('a reopened job pins scope and gap, while a new job can scan deeper', async () => {
  const fixture = await recoveryFixture('policy-reopen')
  let calls = 0
  const transport = emptyTransport({ keysets: [{ id: V2_ID, unit: 'msat' }] })
  transport.restoreCandidates = async (outputs) => {
    calls++
    assert.equal(outputs.length, calls === 1 ? 7 : 11)
    return { outputs: [], signatures: [] }
  }
  const original = {
    ...request(fixture),
    scanPolicy: createSeedRecoveryScanPolicy({ gapLimit: 7 }),
  }
  try {
    const first = await recoverAllDaemonWalletFromSeed(original, dependencies(fixture, transport))
    assert.equal(first.scannedRanges[0]!.nextCounter, 7)
    const forbidden = emptyTransport()
    forbidden.listRegularKeysets = async () => {
      throw new Error('completed retry must not use transport')
    }
    const resumed = await recoverAllDaemonWalletFromSeed(original, dependencies(fixture, forbidden))
    assert.equal(resumed.batchesProcessed, 0)
    assert.deepEqual(resumed.scannedRanges, first.scannedRanges)
    await assert.rejects(
      () =>
        recoverAllDaemonWalletFromSeed(
          { ...original, scanPolicy: createSeedRecoveryScanPolicy({ gapLimit: 11 }) },
          dependencies(fixture, forbidden),
        ),
      /binding is foreign/,
    )
    await assert.rejects(
      () =>
        recoverAllDaemonWalletFromSeed(
          {
            ...original,
            scanPolicy: createSeedRecoveryScanPolicy({ conditionId: CONDITION_ID, gapLimit: 7 }),
          },
          { ...dependencies(fixture, forbidden), _allowConditionFixture: true },
        ),
      /binding is foreign/,
    )
    const deeper = await recoverAllDaemonWalletFromSeed(
      {
        ...original,
        recoveryId: 'deeper-job',
        scanPolicy: createSeedRecoveryScanPolicy({ gapLimit: 11 }),
      },
      { ...dependencies(fixture, transport), invocationId: () => 'deeper-invocation' },
    )
    assert.equal(deeper.scannedRanges[0]!.nextCounter, 11)
    assert.equal(calls, 2)
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('selected condition fixture scans beyond counter zero with its explicit larger gap', async () => {
  const fixture = await recoveryFixture('condition-deeper')
  const conditional = conditionalAuthority()
  const starts: number[] = []
  const counts: number[] = []
  const transport = recoveryTransport({
    conditional: [conditionalDescriptor(conditional)],
    onConditionalFetch: () => conditional,
    onRestore(_id, start, outputs) {
      starts.push(start)
      counts.push(outputs.length)
      return start === 300
        ? restoreResponse(outputs.slice(100, 101), [1])
        : { outputs: [], signatures: [] }
    },
    onCheckStates: (proofs) => proofs.map((proof) => proofState(proof, CheckStateEnum.SPENT)),
  })
  transport.wallet.loadMint = async () => {
    throw new Error('global mint access')
  }
  transport.listRegularKeysets = async () => {
    throw new Error('global listing')
  }
  try {
    const result = await recoverAllDaemonWalletFromSeed(
      {
        ...request(fixture),
        scanPolicy: createSeedRecoveryScanPolicy({ conditionId: CONDITION_ID, gapLimit: 701 }),
      },
      { ...dependencies(fixture, transport), _allowConditionFixture: true },
    )
    assert.deepEqual(starts, [0, 300, 600, 900])
    assert.deepEqual(counts, [300, 300, 300, 202])
    assert.equal(result.state, 'completed')
    assert.equal(result.scannedRanges[0]!.nextCounter, 1102)
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      assert.equal(
        (
          database
            .prepare('SELECT next_counter AS next FROM target_keyset_counters WHERE keyset_id=?')
            .get(conditional.id) as { next: number }
        ).next,
        401,
      )
      assert.equal(
        (
          database.prepare('SELECT count(*) AS count FROM custody_proofs').get() as {
            count: number
          }
        ).count,
        0,
      )
    } finally {
      database.close()
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('failed discovery keeps an explicit policy declaration and exact retry publishes one roster', async () => {
  const fixture = await recoveryFixture('discovery-fault')
  const input = { ...request(fixture), scanPolicy: createSeedRecoveryScanPolicy({ gapLimit: 9 }) }
  let listingCalls = 0
  const broken = emptyTransport()
  broken.listRegularKeysets = async () => {
    listingCalls++
    throw new Error('injected discovery failure')
  }
  try {
    await assert.rejects(
      recoverAllDaemonWalletFromSeed(input, dependencies(fixture, broken)),
      /injected discovery failure/,
    )
    const database = await openDaemonStateSqlite(fixture.directory)
    try {
      assert.equal(
        database.prepare('SELECT discovery_state AS state FROM seed_recovery_jobs').get()!.state,
        'pending',
      )
      assert.equal(
        database.prepare('SELECT count(*) AS count FROM seed_recovery_keysets').get()!.count,
        0,
      )
    } finally {
      database.close()
    }
    await assert.rejects(
      recoverAllDaemonWalletFromSeed(
        { ...input, scanPolicy: createSeedRecoveryScanPolicy({ gapLimit: 10 }) },
        dependencies(fixture, broken),
      ),
      /binding is foreign/,
    )
    assert.equal(listingCalls, 1)
    const result = await recoverAllDaemonWalletFromSeed(
      input,
      dependencies(fixture, emptyTransport()),
    )
    assert.equal(result.state, 'completed')
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})
