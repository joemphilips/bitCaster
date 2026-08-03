import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CheckStateEnum, type MintKeys, type Proof, type ProofState } from '@cashu/cashu-ts'
import {
  completedProofAuthorityDigest,
  createCtfProofOperationCompletion,
  splitCompleteSetWithOperation,
  type CtfPrepareProofOperationInput,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
  type CtfSplitTransport,
} from '@bitcaster-market/client-sdk/ctfSplit'
import {
  completeCompleteSetCtfProofOperationFenced,
  completeRegularSplitWithCompleteSetHandoffFenced,
  emptyDaemonState,
  prepareCompleteSetCtfProofOperationFenced,
  prepareCompleteSetRegularProofOperationFenced,
  readDaemonKeysetCounters,
  readProofOperationFenced,
  readRecoverableCompleteSetProofOperationPage,
  readState,
  reserveDaemonKeysetCounter,
  writeState,
  type CompleteSetRecoveryRoot,
  type ExactProofOperationAuthority,
  type FencedStateMutation,
  type StoredOutputData,
  type StoredProofAsset,
} from '../src/state.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { readSecrets } from '../src/secrets.ts'
import {
  createDaemonCompleteSetOutputMode,
  recoverCompleteSetRecoveryPages,
  recoverCompleteSetSplits,
  splitWalletCompleteSet,
} from '../src/completeSetConversion.ts'
import type { CashuWalletLike } from '../src/walletOps.ts'

const MINT_URL = 'https://mint.example'
const CONDITION_ID = 'a'.repeat(64)
const SOURCE_KEYSET = `01${'b'.repeat(64)}`
const HANDOFF_KEYSET = `01${'c'.repeat(64)}`
const OUTCOME_A_KEYSET = `01${'d'.repeat(64)}`
const OUTCOME_B_KEYSET = `01${'e'.repeat(64)}`
const CURRENT_PLANNING_KEYSET = `01${'f'.repeat(64)}`
const SECP256K1_GENERATOR = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const SAT_ASSET: StoredProofAsset = { kind: 'sats', baseAsset: 'sat', unit: 'msat' }
const COUNTER_BINDING = { normalizedMint: MINT_URL, unit: 'msat' as const }

test('recovers a regular-prepared complete-set split from persisted collateral amount', async () => {
  await withProfile(async ({ mutation, fence }) => {
    const root = rootFor('regular-prepared')
    const source = proof(SOURCE_KEYSET, 101, 'regular-prepared-source')
    const handoff = proof(HANDOFF_KEYSET, 101, 'regular-prepared-handoff')
    await initializeRegularPrepared(root, source, mutation)

    const wallet = new RecoveryWallet({ send: [handoff], keep: [proof(SOURCE_KEYSET, 1, 'keep')] })
    const transport = new FakeCtfTransport()
    let planningKeysetCalls = 0
    const inputFeeKeysetCalls: string[][] = []
    const result = await recoverCompleteSetSplits({
      secrets: (await readSecrets())!,
      deps: {
        getCustodyFence: () => fence,
        createCashuWallet: () => wallet,
        createCtfSplitTransport: () => transport,
        resolveMintKeysByKeyset: async () => {
          planningKeysetCalls += 1
          throw new Error('recovery must not read current regular split planning keyset')
        },
        resolveInputFeePpkByKeyset: async (_mintUrl, keysetIds) => {
          inputFeeKeysetCalls.push([...keysetIds])
          return Object.fromEntries(keysetIds.map((keysetId) => [keysetId, 1_000]))
        },
      },
    })

    assert.deepEqual(result, { recovered: [root.rootOperationId], recoveredCount: 1, pending: [] })
    assert.equal(wallet.selectCalls, 0)
    assert.equal(wallet.keysetId, CURRENT_PLANNING_KEYSET)
    assert.equal(wallet.currentInputFeePpk, 9_999)
    assert.equal(wallet.feeCalls, 0)
    assert.equal(planningKeysetCalls, 0)
    assert.deepEqual(inputFeeKeysetCalls, [[HANDOFF_KEYSET]])
    assertExactHandoff(transport, handoff)
    await assertCompletedAndFinalized(root, mutation)
  })
})

test('recovers a CTF handoff without exposing the reserved send proof', async () => {
  await withProfile(async ({ mutation, fence }) => {
    const root = rootFor('ctf-handoff')
    const source = proof(SOURCE_KEYSET, 101, 'ctf-handoff-source')
    const handoff = proof(HANDOFF_KEYSET, 101, 'ctf-handoff-proof')
    await initializeRegularHandoff(root, source, handoff, mutation)
    const before = await readProofOperationFenced(root.regularOperationId!, mutation)
    assert.equal(before?.state, 'completed')

    const transport = new FakeCtfTransport()
    const wallet = new RecoveryWallet()
    const result = await recoverCompleteSetSplits({
      secrets: (await readSecrets())!,
      deps: {
        getCustodyFence: () => fence,
        createCashuWallet: () => wallet,
        createCtfSplitTransport: () => transport,
        resolveInputFeePpkByKeyset: async (_mintUrl, keysetIds) =>
          Object.fromEntries(keysetIds.map((keysetId) => [keysetId, 1_000])),
      },
    })

    assert.deepEqual(result, { recovered: [root.rootOperationId], recoveredCount: 1, pending: [] })
    assert.equal(wallet.selectCalls, 0)
    assert.equal(wallet.loadMintCalls, 0)
    assertExactHandoff(transport, handoff)
    await assertCompletedAndFinalized(root, mutation)
  })
})

test('complete-set recovery processes fresh bounded pages and keeps its sample bounded', async () => {
  const activeRoots = Array.from({ length: 65 }, (_, index) => ({
    root: { rootOperationId: `complete-set-root-${index}` },
  }))
  let pageReads = 0

  const result = await recoverCompleteSetRecoveryPages({
    readPage: async () => {
      pageReads += 1
      return { roots: activeRoots.slice(0, 64), hasMore: activeRoots.length > 64 }
    },
    recoverRoot: async (recoveryReference) => {
      const index = activeRoots.indexOf(recoveryReference)
      assert.notEqual(index, -1)
      activeRoots.splice(index, 1)
    },
  })

  assert.equal(pageReads, 2)
  assert.equal(result.recoveredCount, 65)
  assert.equal(result.recovered.length, 64)
  assert.equal(result.recovered[0], 'complete-set-root-0')
  assert.equal(result.recovered.at(-1), 'complete-set-root-63')
  assert.deepEqual(result.pending, [])
  assert.deepEqual(activeRoots, [])
})

test('complete-set recovery returns the first failed root without retrying it', async () => {
  const roots = ['first', 'failing', 'later'].map((rootOperationId) => ({
    root: { rootOperationId },
  }))
  const recoveredRoots: string[] = []
  let pageReads = 0

  const result = await recoverCompleteSetRecoveryPages({
    readPage: async () => {
      pageReads += 1
      return { roots, hasMore: false }
    },
    recoverRoot: async (recoveryReference) => {
      if (recoveryReference.root.rootOperationId === 'failing') throw new Error('mint unavailable')
      recoveredRoots.push(recoveryReference.root.rootOperationId)
    },
  })

  assert.equal(pageReads, 1)
  assert.deepEqual(recoveredRoots, ['first'])
  assert.deepEqual(result, {
    recovered: ['first'],
    recoveredCount: 1,
    pending: [{ operationId: 'failing', error: 'mint unavailable' }],
  })
})

test('recovers a CTF-prepared complete-set split with its exact deterministic output range', async () => {
  await withProfile(async ({ mutation, fence }) => {
    const root = rootFor('ctf-prepared')
    const source = proof(SOURCE_KEYSET, 101, 'ctf-prepared-source')
    const handoff = proof(HANDOFF_KEYSET, 101, 'ctf-prepared-handoff')
    await initializeRegularHandoff(root, source, handoff, mutation)
    await reserveDaemonKeysetCounter(OUTCOME_A_KEYSET, 7, mutation, COUNTER_BINDING)
    await reserveDaemonKeysetCounter(OUTCOME_B_KEYSET, 11, mutation, COUNTER_BINDING)

    const preparationTransport = new FakeCtfTransport({ failPostSplit: true })
    await assert.rejects(
      () =>
        splitCompleteSetWithOperation({
          mintUrl: MINT_URL,
          baseAsset: 'sat',
          operationId: ctfOperationId(root),
          transport: preparationTransport,
          conditionId: CONDITION_ID,
          collateralProofs: [handoff],
          outcomeCollectionKeysets: outcomeKeysets(),
          amountSubunits: root.amountSats,
          proofOperationStore: createCtfStore(root, mutation),
          outputMode: createDaemonCompleteSetOutputMode({
            walletSeedHex: '11'.repeat(64),
            deps: { getCustodyFence: () => fence },
            mintUrl: MINT_URL,
          }),
        }),
      /stop after prepared CTF split/,
    )
    const prepared = await readProofOperationFenced(ctfOperationId(root), mutation)
    assert.equal(prepared?.state, 'prepared')
    const counterAfterPreparation = await readDaemonKeysetCounters(COUNTER_BINDING)

    const recoveryTransport = new FakeCtfTransport()
    const result = await recoverCompleteSetSplits({
      secrets: (await readSecrets())!,
      deps: {
        getCustodyFence: () => fence,
        createCtfSplitTransport: () => recoveryTransport,
        createCtfResumeDependencies: () => ({
          proofStateChecker: { checkProofsStates: async () => unspentStates() },
        }),
      },
    })

    assert.deepEqual(result, { recovered: [root.rootOperationId], recoveredCount: 1, pending: [] })
    assertExactHandoff(recoveryTransport, handoff)
    assert.deepEqual(await readDaemonKeysetCounters(COUNTER_BINDING), counterAfterPreparation)
    await assertCompletedAndFinalized(root, mutation)
  })
})

test('rejects a completed CTF replay from a different mint before recovery I/O', async () => {
  await withProfile(async ({ mutation, fence }) => {
    const root = rootFor('completed-foreign-mint')
    const state = emptyDaemonState()
    state.wallet.proofs.push({
      proof: proof(SOURCE_KEYSET, 1, 'unchanged-inventory'),
      mintUrl: MINT_URL,
      state: 'available',
      asset: SAT_ASSET,
      createdAt: new Date(1).toISOString(),
      updatedAt: new Date(1).toISOString(),
    })
    state.proofOperations[ctfOperationId(root)] = completedCtfOperation(
      root,
      'https://other-mint.example',
    )
    await writeState(state)
    const countersBefore = await readDaemonKeysetCounters(COUNTER_BINDING)
    const inventoryBefore = proofInventory(await readState())
    const secrets = (await readSecrets())!
    let transportFactoryCalls = 0
    let resumeFactoryCalls = 0

    await assert.rejects(
      () =>
        splitWalletCompleteSet({
          mintUrl: MINT_URL,
          conditionId: CONDITION_ID,
          amountSats: root.amountSats,
          operationId: root.rootOperationId,
          secrets,
          deps: {
            getCustodyFence: () => fence,
            createCtfSplitTransport: () => {
              transportFactoryCalls += 1
              throw new Error('foreign mint replay must not create a CTF transport')
            },
            createCtfResumeDependencies: () => {
              resumeFactoryCalls += 1
              throw new Error('foreign mint replay must not create resume dependencies')
            },
          },
        }),
      /complete-set CTF recovery operation is incompatible/,
    )

    assert.equal(transportFactoryCalls, 0)
    assert.equal(resumeFactoryCalls, 0)
    assert.deepEqual(await readDaemonKeysetCounters(COUNTER_BINDING), countersBefore)
    assert.deepEqual(proofInventory(await readState()), inventoryBefore)
    assert.equal(
      (await readProofOperationFenced(ctfOperationId(root), mutation))?.state,
      'completed',
    )
  })
})

test('rejects cross-root, cross-condition, cross-amount, and cross-mint recovery references', async () => {
  await withProfile(async ({ mutation, fence }) => {
    const root = rootFor('reference-binding')
    const source = proof(SOURCE_KEYSET, 101, 'reference-binding-source')
    await initializeRegularPrepared(root, source, mutation)
    const page = await readRecoverableCompleteSetProofOperationPage({
      regularPurpose: 'daemon-complete-set-regular-split',
      ctfPurpose: 'daemon-complete-set-ctf-split',
      limit: 64,
    })
    const reference = page.roots[0]!
    const invalidRoots = [
      { ...reference.root, rootOperationId: 'other-root' },
      { ...reference.root, conditionId: 'b'.repeat(64) },
      { ...reference.root, amountSats: root.amountSats + 1 },
      { ...reference.root, mintUrl: 'https://other-mint.example' },
    ]
    const secrets = (await readSecrets())!
    let transportCalls = 0

    for (const invalidRoot of invalidRoots) {
      await assert.rejects(
        () =>
          splitWalletCompleteSet({
            mintUrl: root.mintUrl,
            conditionId: root.conditionId,
            amountSats: root.amountSats,
            operationId: root.rootOperationId,
            secrets,
            deps: {
              getCustodyFence: () => fence,
              createCtfSplitTransport: () => {
                transportCalls += 1
                throw new Error('invalid recovery reference must not create a CTF transport')
              },
            },
            recoveryReference: { ...reference, root: invalidRoot },
          }),
        /complete-set recovery operation is incompatible/,
      )
    }

    assert.equal(transportCalls, 0)
  })
})

async function withProfile(
  run: (context: {
    mutation: FencedStateMutation
    fence: FencedStateMutation['fence']
  }) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-complete-set-recovery-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    const profile = await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT_URL,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
    const fence = await claimCustodyScopeLease(directory, {
      scopeId: profile.walletScopeId,
      incarnationId: `complete-set-recovery-${Date.now()}`,
      observedAtMs: Date.now(),
    })
    await run({ mutation: { fence, observedAtMs: Date.now() }, fence })
  } finally {
    if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previousHome
    await rm(directory, { recursive: true, force: true })
  }
}

function rootFor(suffix: string): CompleteSetRecoveryRoot {
  const rootOperationId = `complete-set-${suffix}`
  return {
    rootOperationId,
    mintUrl: MINT_URL,
    conditionId: CONDITION_ID,
    amountSats: 100,
    regularOperationId: `${rootOperationId}:regular-split`,
    ctfOperationId: null,
  }
}

async function initializeRegularPrepared(
  root: CompleteSetRecoveryRoot,
  source: Proof,
  mutation: FencedStateMutation,
): Promise<void> {
  const state = emptyDaemonState()
  state.wallet.proofs.push({
    proof: source,
    mintUrl: MINT_URL,
    state: 'available',
    asset: SAT_ASSET,
    createdAt: new Date(1).toISOString(),
    updatedAt: new Date(1).toISOString(),
  })
  await writeState(state)
  await prepareCompleteSetRegularProofOperationFenced(regularPreparation(root, source), mutation)
}

async function initializeRegularHandoff(
  root: CompleteSetRecoveryRoot,
  source: Proof,
  handoff: Proof,
  mutation: FencedStateMutation,
): Promise<void> {
  await initializeRegularPrepared(root, source, mutation)
  await completeRegularSplitWithCompleteSetHandoffFenced(
    {
      operationId: root.regularOperationId!,
      completion: createCtfProofOperationCompletion('regular-split', {
        send: [handoff],
        keep: [proof(SOURCE_KEYSET, 1, `${root.rootOperationId}-keep`)],
      }),
      regularAuthority: regularAuthority(root),
      ctfAuthority: { reservationId: ctfReservation(root), inputAsset: SAT_ASSET },
      root,
    },
    mutation,
  )
}

function regularPreparation(root: CompleteSetRecoveryRoot, source: Proof) {
  const authority = regularAuthority(root)
  return {
    operationId: root.regularOperationId!,
    kind: 'regular-split' as const,
    mintUrl: MINT_URL,
    inputs: [source],
    outputs: {
      send: [storedOutput('regular-send-output', 101, HANDOFF_KEYSET)],
      keep: [storedOutput('regular-keep-output', 1, SOURCE_KEYSET)],
    },
    metadata: {
      amount: 101,
      fees: 0,
      keysetId: SOURCE_KEYSET,
      baseAsset: 'sat',
      unit: 'msat',
      unselectedProofs: [],
      purpose: authority.purpose,
      reservationId: authority.reservationId,
      inputAsset: authority.inputAsset,
      successorAssets: authority.successorAssets,
      rootOperationId: root.rootOperationId,
      conditionId: root.conditionId,
      amountSats: root.amountSats,
    },
    reservationId: authority.reservationId,
    asset: SAT_ASSET,
    root,
  }
}

function regularAuthority(root: CompleteSetRecoveryRoot): ExactProofOperationAuthority {
  return {
    purpose: 'daemon-complete-set-regular-split',
    reservationId: `${root.rootOperationId}:regular-split:reservation`,
    inputAsset: SAT_ASSET,
    successorAssets: { send: SAT_ASSET, keep: SAT_ASSET },
  }
}

function ctfAuthority(root: CompleteSetRecoveryRoot): ExactProofOperationAuthority {
  return {
    purpose: 'daemon-complete-set-ctf-split',
    reservationId: ctfReservation(root),
    inputAsset: SAT_ASSET,
    successorAssets: Object.fromEntries(
      Object.keys(outcomeKeysets()).map((outcomeSetId) => [
        outcomeSetId,
        {
          kind: 'Outcome',
          conditionId: CONDITION_ID,
          outcomeSetId,
          baseAsset: 'sat',
          unit: 'msat',
        },
      ]),
    ),
  }
}

function ctfReservation(root: CompleteSetRecoveryRoot): string {
  return `${ctfOperationId(root)}:reservation`
}

function ctfOperationId(root: CompleteSetRecoveryRoot): string {
  return `${root.rootOperationId}:ctf-split`
}

function completedCtfOperation(
  root: CompleteSetRecoveryRoot,
  mintUrl: string,
): CtfProofOperationRecord {
  const resultProofs = {
    A: [proof(OUTCOME_A_KEYSET, root.amountSats, `${root.rootOperationId}-outcome-A`)],
    B: [proof(OUTCOME_B_KEYSET, root.amountSats, `${root.rootOperationId}-outcome-B`)],
  }
  return {
    operationId: ctfOperationId(root),
    kind: 'ctf-split',
    state: 'completed',
    mintUrl,
    inputs: [proof(HANDOFF_KEYSET, 101, `${root.rootOperationId}-handoff`)],
    outputs: {
      A: [storedOutput(`${root.rootOperationId}-output-A`, root.amountSats, OUTCOME_A_KEYSET)],
      B: [storedOutput(`${root.rootOperationId}-output-B`, root.amountSats, OUTCOME_B_KEYSET)],
    },
    metadata: {
      purpose: 'daemon-complete-set-ctf-split',
      reservationId: ctfReservation(root),
      inputAsset: SAT_ASSET,
      successorAssets: ctfAuthority(root).successorAssets,
      rootOperationId: root.rootOperationId,
      conditionId: root.conditionId,
      amountSats: root.amountSats,
      amountSubunits: root.amountSats,
      baseAsset: 'sat',
      unit: 'msat',
      parentCollectionId: null,
      outcomeCollectionKeysets: outcomeKeysets(),
      outputMode: 'seed-derived',
      outputDescriptors: {},
    },
    resultProofs,
    resultProofsDigest: completedProofAuthorityDigest(resultProofs),
    lastError: null,
    createdAt: 1,
    updatedAt: 2,
  }
}

function proofInventory(state: Awaited<ReturnType<typeof readState>>): string[] {
  return state.wallet.proofs
    .map(
      (record) =>
        `${record.mintUrl}:${record.state}:${record.reservedBy ?? ''}:${record.proof.secret}`,
    )
    .sort()
}

function createCtfStore(
  root: CompleteSetRecoveryRoot,
  mutation: FencedStateMutation,
): CtfProofOperationStore {
  const authority = ctfAuthority(root)
  return {
    getProofOperation: async (operationId) =>
      (await readProofOperationFenced(operationId, mutation)) as CtfProofOperationRecord | null,
    prepareProofOperation: async (operation) =>
      (await prepareCompleteSetCtfProofOperationFenced(
        ctfPreparation(operation, root, authority),
        mutation,
      )) as CtfProofOperationRecord,
    markProofOperationCompleted: async (operationId, completion) =>
      (await completeCompleteSetCtfProofOperationFenced(
        { operationId, completion, authority, root },
        mutation,
      )) as CtfProofOperationRecord,
  }
}

function ctfPreparation(
  operation: CtfPrepareProofOperationInput,
  root: CompleteSetRecoveryRoot,
  authority: ExactProofOperationAuthority,
) {
  return {
    ...operation,
    metadata: {
      ...operation.metadata,
      purpose: authority.purpose,
      reservationId: authority.reservationId,
      inputAsset: authority.inputAsset,
      successorAssets: authority.successorAssets,
      rootOperationId: root.rootOperationId,
      conditionId: root.conditionId,
      amountSats: root.amountSats,
    },
    reservationId: authority.reservationId,
    asset: SAT_ASSET,
    root,
  }
}

async function assertCompletedAndFinalized(
  root: CompleteSetRecoveryRoot,
  mutation: FencedStateMutation,
): Promise<void> {
  const operation = await readProofOperationFenced(ctfOperationId(root), mutation)
  assert.equal(operation?.state, 'completed')
  assert.equal(Object.keys(operation?.resultProofs ?? {}).length, 2)
  const expectedOutcomeSecrets = Object.values(operation?.resultProofs ?? {})
    .flat()
    .map((proof) => proof.secret)
    .sort()
  const admittedOutcomeProofs = (await readState()).wallet.proofs.filter(
    (record) =>
      record.mintUrl === MINT_URL &&
      record.state === 'available' &&
      record.asset.kind === 'Outcome' &&
      record.asset.conditionId === CONDITION_ID,
  )
  assert.deepEqual(
    admittedOutcomeProofs.map((record) => record.proof.secret).sort(),
    expectedOutcomeSecrets,
  )
  const active = await readRecoverableCompleteSetProofOperationPage({
    regularPurpose: 'daemon-complete-set-regular-split',
    ctfPurpose: 'daemon-complete-set-ctf-split',
    limit: 64,
  })
  assert.deepEqual(active.roots, [])
  assert.equal(active.hasMore, false)
}

function assertExactHandoff(transport: FakeCtfTransport, handoff: Proof): void {
  assert.equal(transport.posted.length, 1)
  const inputs = transport.posted[0]!.inputs
  assert.equal(inputs.length, 1)
  assert.equal(inputs[0]!.secret, handoff.secret)
  assert.equal(inputs[0]!.id, handoff.id)
  assert.equal(inputs[0]!.amount, handoff.amount)
  assert.equal(inputs[0]!.C, handoff.C)
}

function outcomeKeysets(): Record<string, string> {
  return { A: OUTCOME_A_KEYSET, B: OUTCOME_B_KEYSET }
}

function proof(id: string, amount: number, secret: string): Proof {
  return { id, amount, secret, C: SECP256K1_GENERATOR }
}

function storedOutput(secret: string, amount: number, keysetId: string): StoredOutputData {
  return {
    blindedMessage: { amount, id: keysetId, B_: SECP256K1_GENERATOR },
    blindingFactor: '1',
    secret: Buffer.from(secret, 'utf8').toString('hex'),
  }
}

function unspentStates(): ProofState[] {
  return [{ Y: 'Y-handoff', state: CheckStateEnum.UNSPENT, witness: null }]
}

class RecoveryWallet implements CashuWalletLike {
  readonly keysetId = CURRENT_PLANNING_KEYSET
  readonly currentInputFeePpk = 9_999
  feeCalls = 0
  selectCalls = 0
  loadMintCalls = 0
  private readonly split: { send: Proof[]; keep: Proof[] }

  constructor(split: { send: Proof[]; keep: Proof[] } = { send: [], keep: [] }) {
    this.split = split
  }

  async loadMint(): Promise<void> {
    this.loadMintCalls += 1
  }

  async receive(): Promise<Proof[]> {
    throw new Error('unexpected receive')
  }

  async send(): Promise<{ keep: Proof[]; send: Proof[] }> {
    throw new Error('unexpected send')
  }

  selectProofsToSend(): { keep: Proof[]; send: Proof[] } {
    this.selectCalls += 1
    throw new Error('reserved handoff must not be reselected')
  }

  getFeesForProofs(): number {
    this.feeCalls += 1
    return this.currentInputFeePpk
  }

  async completeSwap(): Promise<{ keep: Proof[]; send: Proof[] }> {
    return this.split
  }

  async checkProofsStates(): Promise<ProofState[]> {
    return unspentStates()
  }
}

class FakeCtfTransport implements CtfSplitTransport {
  readonly posted: Array<Parameters<CtfSplitTransport['postSplit']>[0]> = []
  private readonly failPostSplit: boolean

  constructor(options: { failPostSplit?: boolean } = {}) {
    this.failPostSplit = options.failPostSplit ?? false
  }

  async getKeys(keysetId: string): Promise<MintKeys> {
    return {
      id: keysetId,
      unit: 'msat',
      keys: {
        1: SECP256K1_GENERATOR,
        4: SECP256K1_GENERATOR,
        32: SECP256K1_GENERATOR,
        64: SECP256K1_GENERATOR,
      },
      input_fee_ppk: keysetId === HANDOFF_KEYSET ? 1_000 : 0,
    } as MintKeys
  }

  async getRootPartitionKeysets(): Promise<Record<string, string>> {
    return outcomeKeysets()
  }

  async postSplit(
    request: Parameters<CtfSplitTransport['postSplit']>[0],
  ): ReturnType<CtfSplitTransport['postSplit']> {
    this.posted.push(request)
    if (this.failPostSplit) throw new Error('stop after prepared CTF split')
    return {
      signatures: Object.fromEntries(
        Object.entries(request.outputs).map(([collection, outputs]) => [
          collection,
          outputs.map((output) => ({
            amount: output.amount,
            id: output.id,
            C_: SECP256K1_GENERATOR,
          })),
        ]),
      ),
    }
  }
}
