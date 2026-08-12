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
import {
  recoverAllDaemonWalletFromSeed,
  type AllKeysetSeedRecoveryTransport,
} from '../src/emergencySeedRecovery.ts'
import {
  createSeedRecoveryProfile,
  RECOVERY_COUNTER_BINDING,
  withDaemonHome,
} from './seedRecoveryTestSupport.ts'

const V2_ID = `01${'a'.repeat(64)}`
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1])
const MINT_PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const CONDITION_ID = 'ab'.repeat(32)

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
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('all-keyset recovery rejects non-V2 regular authority before wallet restore I/O', async () => {
  const fixture = await recoveryFixture('v2x')
  try {
    let loaded = false
    const transport = emptyTransport({ keysets: [{ id: `02${'b'.repeat(64)}`, unit: 'sat' }] })
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

test('all-keyset recovery fails closed when a local high-water keyset is absent', async () => {
  const fixture = await recoveryFixture('high-water')
  try {
    await withDaemonHome(fixture.directory, () =>
      advanceDaemonKeysetCounter(V2_ID, 1, fixture.mutation, RECOVERY_COUNTER_BINDING),
    )
    await assert.rejects(
      () =>
        recoverAllDaemonWalletFromSeed(request(fixture), dependencies(fixture, emptyTransport())),
      /absent from complete keyset listings/,
    )
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('all-keyset recovery spends its four-batch budget on one continuing child', async () => {
  const fixture = await recoveryFixture('continuation')
  try {
    await withDaemonHome(fixture.directory, () =>
      advanceDaemonKeysetCounter(V2_ID, 1_500, fixture.mutation, RECOVERY_COUNTER_BINDING),
    )
    const starts: number[] = []
    const transport = emptyTransport({ keysets: [{ id: V2_ID, unit: 'sat' }] })
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
    onRestoreCandidates(outputs) {
      const output = outputs[7] as { id: string; amount: unknown; B_: string }
      return {
        outputs: [output],
        signatures: [{ id: output.id, amount: Amount.from(1), C_: MINT_PUBLIC_KEY }],
      }
    },
    onConditionalFetch(id) {
      fetched.push(id)
      return conditional
    },
    onRestore(keysetId, start, outputs) {
      appendStart(starts, keysetId, start)
      return keysetId === conditional.id && start === 0
        ? restoreResponse(outputs.slice(0, 2), [1, 2])
        : { outputs: [], signatures: [] }
    },
    onCheckStates(proofs) {
      return [...proofs].reverse().map((proof) => proofState(proof, CheckStateEnum.UNSPENT))
    },
  })
  try {
    const result = await recoverAllDaemonWalletFromSeed(
      request(fixture, 'msat'),
      dependencies(fixture, transport),
    )
    assert.deepEqual(fetched, [conditional.id])
    assert.deepEqual(starts.get(regular.id), [0])
    assert.deepEqual(starts.get(conditional.id), [0, 300])
    assert.deepEqual(result, {
      recoveryId: 'all-empty',
      state: 'completed',
      selectedKeysetCount: 2,
      completedChildCount: 2,
      batchesProcessed: 3,
      gapLimit: 300,
    })
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

test('conditional discovery skips expired and unmatched keysets without fetching keys', async () => {
  const fixture = await recoveryFixture('conditional-filter')
  const eligible = conditionalAuthority({ conditionId: 'bc'.repeat(32), finalExpiry: 10 })
  const expired = conditionalAuthority({ conditionId: 'cd'.repeat(32), finalExpiry: 1 })
  let outputCount = 0
  let fetchCount = 0
  const transport = recoveryTransport({
    conditional: [conditionalDescriptor(eligible), conditionalDescriptor(expired)],
    onRestoreCandidates(outputs) {
      outputCount += outputs.length
      assert.equal(
        outputs.every((output) => (output as { id: string }).id === eligible.id),
        true,
      )
      return { outputs: [], signatures: [] }
    },
    onConditionalFetch() {
      fetchCount += 1
      throw new Error('unmatched conditional keysets must not fetch keys')
    },
  })
  try {
    await withDaemonHome(fixture.directory, () =>
      advanceDaemonKeysetCounter(expired.id, 1, fixture.mutation, {
        normalizedMint: 'https://mint.example',
        unit: 'msat',
      }),
    )
    const result = await recoverAllDaemonWalletFromSeed(
      request(fixture, 'msat'),
      dependencies(fixture, transport, 2_000),
    )
    assert.equal(outputCount, 300)
    assert.equal(fetchCount, 0)
    assert.equal(result.selectedKeysetCount, 0)
    assert.equal(result.state, 'completed')
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
      request(fixture, 'msat'),
      dependencies(fixture, transport),
    )
    assert.deepEqual(starts, [0])
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
    assert.deepEqual(result, {
      recoveryId: 'all-empty',
      state: 'active',
      selectedKeysetCount: 2,
      completedChildCount: 1,
      batchesProcessed: 2,
      gapLimit: 300,
    })
  } finally {
    await rm(fixture.directory, { recursive: true, force: true })
  }
})

test('a durable roster resumes a pending conditional child without rediscovery', async () => {
  const fixture = await recoveryFixture('durable-roster')
  const conditional = conditionalAuthority()
  const first = recoveryTransport({
    conditional: [conditionalDescriptor(conditional)],
    onRestoreCandidates(outputs) {
      const output = outputs[0] as SerializedBlindedMessage
      return {
        outputs: [output],
        signatures: [{ id: output.id, amount: Amount.from(1), C_: MINT_PUBLIC_KEY }],
      }
    },
    onConditionalFetch: () => conditional,
    onRestore(_keysetId, _start, outputs) {
      return restoreResponse(outputs.slice(0, 1), [1])
    },
    onCheckStates: (proofs) => proofs.map((proof) => proofState(proof, CheckStateEnum.PENDING)),
  })
  try {
    const pending = await recoverAllDaemonWalletFromSeed(
      request(fixture, 'msat'),
      dependencies(fixture, first),
    )
    assert.equal(pending.state, 'active')

    const starts: number[] = []
    const resumed = recoveryTransport({
      conditional: [conditionalDescriptor(conditional)],
      expectDiscovery: false,
      onRestoreCandidates() {
        throw new Error('a durable roster must not repeat discovery')
      },
      onConditionalFetch: () => conditional,
      onRestore(_keysetId, start) {
        starts.push(start)
        return { outputs: [], signatures: [] }
      },
    })
    const completed = await recoverAllDaemonWalletFromSeed(
      request(fixture, 'msat'),
      dependencies(fixture, resumed),
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

function request(
  fixture: Awaited<ReturnType<typeof recoveryFixture>>,
  unit: 'sat' | 'msat' = 'sat',
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

function regularKeyset(keys: Record<string, string>, unit = 'sat'): MintKeys {
  return { id: deriveKeysetId(keys, { unit, versionByte: 1 }), unit, keys }
}

function conditionalAuthority(
  input: { active?: boolean; conditionId?: string; finalExpiry?: number } = {},
) {
  const conditionId = input.conditionId ?? CONDITION_ID
  const outcomeCollection = 'NO|YES'
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({ conditionId, outcomeCollection })
  const keys = { '1': MINT_PUBLIC_KEY, '2': MINT_PUBLIC_KEY }
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
  onRestoreCandidates?: (outputs: readonly unknown[]) => unknown
  onConditionalFetch?: (id: string) => ReturnType<typeof conditionalAuthority>
  onRestore?: (
    keysetId: string,
    start: number,
    outputs: readonly SerializedBlindedMessage[],
  ) => unknown
  onCheckStates?: (proofs: readonly Proof[]) => ReturnType<typeof proofState>[]
  expectDiscovery?: boolean
}): AllKeysetSeedRecoveryTransport {
  const keys = new Map((input.regularKeys ?? []).map((keyset) => [keyset.id, keyset]))
  const starts = new Map<string, number>()
  let discoveryPending = input.expectDiscovery ?? (input.conditional?.length ?? 0) > 0
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
      if (discoveryPending) {
        discoveryPending = false
        return input.onRestoreCandidates?.(outputs) ?? { outputs: [], signatures: [] }
      }
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
        getKeyset: () => ({ id: V2_ID, unit: 'sat', keys: {} }),
        async ensureKeysetKeys() {
          return { id: V2_ID, unit: 'sat', keys: {} }
        },
      },
      getKeyset: () => ({ id: V2_ID, unit: 'sat', keys: {} }),
      async checkProofsStates() {
        throw new Error('empty recovery must not query NUT-07')
      },
    },
    async listRegularKeysets() {
      return regular
    },
    async listConditionalKeysets() {
      return { keysets: [] }
    },
    async getConditionalKeyset() {
      throw new Error('empty recovery must not fetch conditional keys')
    },
    async restoreCandidates() {
      return { outputs: [], signatures: [] }
    },
  }
}

function restoreResponse(outputs: readonly SerializedBlindedMessage[], amounts: readonly number[]) {
  return {
    outputs: outputs.map((output) => ({ ...output, amount: Amount.from(0) })),
    signatures: outputs.map((output, index) => {
      const signature = createBlindSignature(pointFromHex(output.B_), MINT_PRIVATE_KEY, output.id)
      const dleq = createDLEQProof(pointFromHex(output.B_), MINT_PRIVATE_KEY)
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
