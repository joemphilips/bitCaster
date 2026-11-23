import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  completedProofAuthorityDigest,
  computeGrossCtfInputAmountSubunits,
  createCtfProofOperationCompletion,
  normalizeProof,
  normalizeProofArray,
  normalizeProofGroups,
  prepareBoundedCtfProofOperation,
  ProofOperationPendingError,
  resolveComplementaryOutcomeLegs,
  resolveInputFeePpkByProofKeyset,
  resolveMintOutcomeSetKey,
  selectRootPartitionKeysets,
  mergeCompleteSetToRegularWithOperation,
  selectCompleteSetMergeInputs,
  type CtfPrepareProofOperationInput,
  type CtfProofOperationCompletion,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
  type CtfSplitOutputData,
  type CtfSplitTransport,
} from '../src/ctfSplit.ts'
import type {
  MintKeys,
  CounterSource,
  Proof,
  SerializedBlindedMessage,
  SerializedBlindedSignature,
} from '@cashu/cashu-ts'
import { Amount, CheckStateEnum, OutputData, hashToCurve, type ProofState } from '@cashu/cashu-ts'

const REGULAR_KEYSET_ID = '01' + '0a'.repeat(32)
const YES_KEYSET_ID = '01' + '0b'.repeat(32)
const NO_KEYSET_ID = '01' + '0c'.repeat(32)
const OTHER_REGULAR_KEYSET_ID = '01' + '0d'.repeat(32)

test('computeGrossCtfInputAmountSubunits plans in native proof subunits', () => {
  const keyset = {
    id: 'keyset-fee',
    keys: { 1: 'pubkey-1', 2: 'pubkey-2', 4: 'pubkey-4', 8: 'pubkey-8' },
    input_fee_ppk: 501,
  }

  assert.equal(computeGrossCtfInputAmountSubunits({ faceAmountSubunits: 10, keyset }), 12)
})

test('proof normalization helpers are exported for wallet-service sharing', () => {
  const proof = { id: 'k', amount: Amount.from(2), secret: 's', C: 'c' } as unknown as Proof

  assert.deepEqual(normalizeProof(proof), { ...proof, amount: 2 })
  assert.deepEqual(normalizeProofArray([proof]), [{ ...proof, amount: 2 }])
  assert.deepEqual(normalizeProofGroups({ outcome: [proof] }), {
    outcome: [{ ...proof, amount: 2 }],
  })
})

test('proof operation completion carries SDK-owned digest only for CTF split and merge', () => {
  const resultProofs = { result: [completedProof('keyset', 1, 'secret')] }
  const split = createCtfProofOperationCompletion('ctf-split', resultProofs)
  const merge = createCtfProofOperationCompletion('ctf-merge', resultProofs)
  const redeem = createCtfProofOperationCompletion('ctf-redeem', resultProofs)
  const regular = createCtfProofOperationCompletion('regular-split', resultProofs)

  assert.equal(split.resultProofsDigest, completedProofAuthorityDigest(resultProofs))
  assert.equal(merge.resultProofsDigest, completedProofAuthorityDigest(resultProofs))
  assert.equal('resultProofsDigest' in redeem, false)
  assert.equal('resultProofsDigest' in regular, false)
})

test('completed proof authority sorting does not consult the process locale', () => {
  const original = String.prototype.localeCompare
  String.prototype.localeCompare = () => {
    throw new Error('locale-dependent comparison was used')
  }
  try {
    const left = {
      Z: [completedProof('keyset', 1, 'z')],
      a: [completedProof('keyset', 1, 'a')],
    }
    const right = { a: left.a, Z: left.Z }
    assert.equal(completedProofAuthorityDigest(left), completedProofAuthorityDigest(right))
  } finally {
    String.prototype.localeCompare = original
  }
})

test('completed proof authority enforces ADR-033 bounds before proof mapping', () => {
  const oversizedGroups = Object.fromEntries(
    Array.from({ length: 17 }, (_, index) => [
      `group-${index}`,
      [completedProof('keyset', 1, `secret-${index}`)],
    ]),
  )
  assert.throws(() => completedProofAuthorityDigest(oversizedGroups), /group limit/)

  const unmappable = {
    get id(): string {
      throw new Error('proof mapping started before the result count bound')
    },
    amount: 1,
    secret: 'secret',
    C: SECP256K1_GENERATOR,
  } as Proof
  assert.throws(
    () => completedProofAuthorityDigest({ result: Array.from({ length: 513 }, () => unmappable) }),
    /result proof limit/,
  )

  assert.throws(
    () =>
      completedProofAuthorityDigest({
        result: [
          {
            ...completedProof('keyset', 1, 'secret'),
            witness: { signatures: ['x'.repeat(65 * 1_024)] },
          },
        ],
      }),
    /byte limit|string limit/,
  )

  let nested: unknown = 'leaf'
  for (let depth = 0; depth < 34; depth += 1) nested = { child: nested }
  assert.throws(
    () =>
      completedProofAuthorityDigest({
        result: [{ ...completedProof('keyset', 1, 'secret'), witness: nested }],
      }),
    /structure limit/,
  )
})

test('proof operation preparation enforces the 64 KiB record authority before persistence', async () => {
  let storeCalls = 0
  const store = {
    async prepareProofOperation(input: CtfPrepareProofOperationInput) {
      storeCalls += 1
      return input as unknown as CtfProofOperationRecord
    },
  } as CtfProofOperationStore
  const metadata = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [`field${index}`, 'x'.repeat(15_000)]),
  )

  await assert.rejects(
    async () =>
      prepareBoundedCtfProofOperation(store, {
        operationId: 'operation',
        kind: 'ctf-split',
        mintUrl: 'https://mint.example',
        inputs: [completedProof('keyset', 1, 'secret')],
        outputs: {},
        metadata,
      }),
    /byte limit/,
  )
  assert.equal(storeCalls, 0)
})

test('resolveMintOutcomeSetKey matches engine outcome sets to mint keyset-map keys', () => {
  const keysets = {
    'Bob|Carol': 'keyset-not-alice',
    Alice: 'keyset-alice',
  }

  assert.equal(resolveMintOutcomeSetKey('Carol|Bob', keysets, 'lock'), 'Bob|Carol')
  assert.equal(resolveMintOutcomeSetKey('Alice', keysets, 'keep'), 'Alice')
})

test('resolveMintOutcomeSetKey fails closed on ambiguous mint keyset-map matches', () => {
  assert.throws(
    () =>
      resolveMintOutcomeSetKey(
        'Bob|Alice',
        {
          'Alice|Bob': 'keyset-1',
          'Bob|Alice': 'keyset-2',
          Carol: 'keyset-3',
        },
        'lock',
      ),
    /matched 2 mint keyset-map keys/,
  )
})

test('resolveComplementaryOutcomeLegs decomposes compound outcome sets into primitive mint collections', () => {
  const keysets = {
    Alice: 'keyset-alice',
    Bob: 'keyset-bob',
    Carol: 'keyset-carol',
    Dave: 'keyset-dave',
  }

  assert.deepEqual(resolveComplementaryOutcomeLegs('Bob|Carol', 'Alice|Dave', keysets), {
    resolvedLockOutcomeSetId: 'Bob|Carol',
    resolvedKeepOutcomeSetId: 'Alice|Dave',
    lockCollections: ['Bob', 'Carol'],
    keepCollections: ['Alice', 'Dave'],
  })
})

test('resolveComplementaryOutcomeLegs accepts a composite root collection as one branch', () => {
  const keysets = {
    Alice: 'keyset-alice',
    'Bob|Carol|Dave': 'keyset-not-alice',
  }

  assert.deepEqual(resolveComplementaryOutcomeLegs('Alice', 'Carol|Bob|Dave', keysets), {
    resolvedLockOutcomeSetId: 'Alice',
    resolvedKeepOutcomeSetId: 'Bob|Carol|Dave',
    lockCollections: ['Alice'],
    keepCollections: ['Bob|Carol|Dave'],
  })
})

test('resolveComplementaryOutcomeLegs requires strict complete primitive coverage', () => {
  assert.throws(
    () =>
      resolveComplementaryOutcomeLegs('Bob|Carol', 'Alice', {
        Alice: 'keyset-alice',
        Bob: 'keyset-bob',
        Carol: 'keyset-carol',
        Dave: 'keyset-dave',
      }),
    /do not cover the full primitive outcome set; missing Dave/,
  )
})

test('selectRootPartitionKeysets chooses the root partition matching the requested split target', () => {
  const condition = {
    condition_id: CONDITION_ID,
    collateral: 'msat',
    keysets: {
      Alice: 'keyset-alice',
      'Bob|Carol|Dave': 'keyset-not-alice',
      Bob: 'keyset-bob',
      'Alice|Carol|Dave': 'keyset-not-bob',
      Carol: 'keyset-carol',
      'Alice|Bob|Dave': 'keyset-not-carol',
    },
  }

  assert.deepEqual(
    selectRootPartitionKeysets(condition, {
      lockOutcomeSetId: 'Alice',
      keepOutcomeSetId: 'Carol|Bob|Dave',
      baseAsset: 'sat',
    }),
    {
      Alice: 'keyset-alice',
      'Bob|Carol|Dave': 'keyset-not-alice',
    },
  )
})

test('selectRootPartitionKeysets expands one-vs-rest primitive root partitions', () => {
  const condition = {
    condition_id: CONDITION_ID,
    collateral: 'msat',
    keysets: {
      Alice: 'keyset-alice',
      Bob: 'keyset-bob',
      Carol: 'keyset-carol',
    },
  }

  assert.deepEqual(
    selectRootPartitionKeysets(condition, {
      lockOutcomeSetId: 'Alice',
      keepOutcomeSetId: 'Bob|Carol',
      baseAsset: 'sat',
    }),
    {
      Alice: 'keyset-alice',
      Bob: 'keyset-bob',
      Carol: 'keyset-carol',
    },
  )
})

test('selectRootPartitionKeysets resolves id-keyed root keysets through conditional metadata', () => {
  const aliceCollectionId = 'a'.repeat(64)
  const notAliceCollectionId = 'b'.repeat(64)
  const condition = {
    condition_id: CONDITION_ID,
    collateral: 'msat',
    keysets: {
      [aliceCollectionId]: 'keyset-alice',
      [notAliceCollectionId]: 'keyset-not-alice',
    },
  }

  assert.deepEqual(
    selectRootPartitionKeysets(
      condition,
      {
        lockOutcomeSetId: 'Alice',
        keepOutcomeSetId: 'Carol|Bob|Dave',
        baseAsset: 'sat',
      },
      [
        {
          id: 'keyset-alice',
          condition_id: CONDITION_ID,
          outcome_collection: 'Alice',
          outcome_collection_id: aliceCollectionId,
          unit: 'msat',
        },
        {
          id: 'keyset-not-alice',
          condition_id: CONDITION_ID,
          outcome_collection: 'Bob|Carol|Dave',
          outcome_collection_id: notAliceCollectionId,
          unit: 'msat',
        },
      ],
    ),
    {
      Alice: 'keyset-alice',
      'Bob|Carol|Dave': 'keyset-not-alice',
    },
  )
})

test('selectRootPartitionKeysets rejects mixed conditional collateral metadata', () => {
  const condition = {
    condition_id: CONDITION_ID,
    collateral: 'msat',
    keysets: {
      Alice: 'usd-keyset-alice',
      'Bob|Carol|Dave': 'usd-keyset-not-alice',
    },
  }

  assert.throws(
    () =>
      selectRootPartitionKeysets(
        condition,
        {
          lockOutcomeSetId: 'Alice',
          keepOutcomeSetId: 'Carol|Bob|Dave',
          baseAsset: 'sat',
        },
        [
          {
            id: 'usd-keyset-alice',
            condition_id: CONDITION_ID,
            outcome_collection: 'Alice',
            outcome_collection_id: 'alice-usd',
            unit: 'usd',
          },
          {
            id: 'usd-keyset-not-alice',
            condition_id: CONDITION_ID,
            outcome_collection: 'Bob|Carol|Dave',
            outcome_collection_id: 'not-alice-usd',
            unit: 'usd',
          },
          {
            id: 'sat-keyset-alice',
            condition_id: CONDITION_ID,
            outcome_collection: 'Alice',
            outcome_collection_id: 'alice-sat',
            unit: 'msat',
          },
          {
            id: 'sat-keyset-not-alice',
            condition_id: CONDITION_ID,
            outcome_collection: 'Bob|Carol|Dave',
            outcome_collection_id: 'not-alice-sat',
            unit: 'msat',
          },
        ],
      ),
    /unit must be exactly msat/,
  )
})

test('selectRootPartitionKeysets keeps binary single-root compatibility without a target', () => {
  const condition = {
    condition_id: CONDITION_ID,
    collateral: 'msat',
    keysets: {
      YES: YES_KEYSET_ID,
      NO: NO_KEYSET_ID,
    },
  }

  assert.deepEqual(selectRootPartitionKeysets(condition), {
    YES: YES_KEYSET_ID,
    NO: NO_KEYSET_ID,
  })
})

test('selectRootPartitionKeysets rejects non-exact condition and conditional keyset units', () => {
  const invalidUnits = [undefined, null, 'sat', 'usd', 'MSAT', ' msat', 'msat ']
  for (const collateral of invalidUnits) {
    assert.throws(
      () =>
        selectRootPartitionKeysets({
          condition_id: CONDITION_ID,
          collateral,
          keysets: {
            YES: YES_KEYSET_ID,
            NO: NO_KEYSET_ID,
          },
        }),
      /must be exactly msat/,
    )
  }

  for (const unit of invalidUnits) {
    assert.throws(
      () =>
        selectRootPartitionKeysets(
          {
            condition_id: CONDITION_ID,
            collateral: 'msat',
            keysets: {
              ['b'.repeat(64)]: YES_KEYSET_ID,
              ['c'.repeat(64)]: NO_KEYSET_ID,
            },
          },
          {
            lockOutcomeSetId: 'YES',
            keepOutcomeSetId: 'NO',
            baseAsset: 'sat',
          },
          [
            {
              id: YES_KEYSET_ID,
              condition_id: CONDITION_ID,
              outcome_collection: 'YES',
              outcome_collection_id: 'b'.repeat(64),
              unit,
            },
          ],
        ),
      /must be exactly msat/,
    )
  }
})

test('near-bound deterministic merge record rejects before counter reservation', async () => {
  const counter = new CountingCounterSource()
  const store = new MemoryProofOperationStore()
  const transport = new DeterministicSplitTransport(counter)
  const conditionalProofsByCollection = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `group-${index.toString().padStart(2, '0')}`,
      [proof(DETERMINISTIC_KEYSET_A, 1, 's'.repeat(1_100))],
    ]),
  )

  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'seed-merge-oversized-record',
        transport,
        conditionId: CONDITION_ID,
        conditionalProofsByCollection,
        outputAmountSubunits: 1,
        regularKeyset: {
          id: DETERMINISTIC_KEYSET_C,
          unit: 'msat',
          keys: { 1: '02' },
          input_fee_ppk: 0,
        } as MintKeys,
        proofOperationStore: store,
        outputMode: { kind: 'seed-derived', seed: DETERMINISTIC_SEED, counterSource: counter },
      }),
    /byte limit/,
  )
  assert.deepEqual(counter.calls, [])
  assert.equal(transport.converted.length, 0)
  assert.equal(store.prepareCalls, 0)
})

test('mergeCompleteSetToRegularWithOperation prepares conditional inputs and regular outputs', async () => {
  const transport = new FakeSplitTransport()
  const store = new MemoryProofOperationStore()

  const result = await mergeCompleteSetToRegularWithOperation({
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId: 'merge-op-1',
    transport,
    conditionId: CONDITION_ID,
    conditionalProofsByCollection: {
      Alpha: [proof('keyset-alpha', 10, 'alpha')],
      Beta: [proof('keyset-beta', 10, 'beta')],
      Gamma: [proof('keyset-gamma', 10, 'gamma')],
    },
    outputAmountSubunits: 9,
    regularKeyset: feePlanningKeyset(0, { 1: 'regular' }) as MintKeys,
    proofOperationStore: store,
    makeRegularOutputs: ({ amountSubunits, keyset }) => [output('*', amountSubunits, keyset.id)],
  })

  assert.equal(result.regularProofs[0].secret, 'proof-*')
  assert.deepEqual(Object.keys(result.spentConditionalProofsByCollection).sort(), [
    'Alpha',
    'Beta',
    'Gamma',
  ])
  assert.equal(result.outputAmountSubunits, 9)
  assert.equal(transport.converted.length, 1)
  assert.equal(transport.converted[0].parent_collection_id, '0'.repeat(64))
  assert.deepEqual(Object.keys(transport.converted[0].inputs).sort(), ['Alpha', 'Beta', 'Gamma'])
  assert.deepEqual(Object.keys(transport.converted[0].outputs), ['*'])
  assert.equal(store.records.get('merge-op-1')?.kind, 'ctf-merge')
  assert.equal(store.records.get('merge-op-1')?.metadata.baseAsset, 'sat')
})

test('new CTF merge operations require explicit output authority', async () => {
  const transport = new FakeSplitTransport()
  const store = new MemoryProofOperationStore()

  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation(
        mergeReplayRequest('merge-no-output-mode', store, transport),
      ),
    /requires an explicit output mode/,
  )
  assert.equal(transport.converted.length, 0)
  assert.equal(store.prepareCalls, 0)
})

test('seed-derived CTF merge reserves one persisted plan before mint I/O and reuses it', async () => {
  const counter = new CountingCounterSource()
  const store = new MemoryProofOperationStore()
  const transport = new DeterministicSplitTransport(counter)
  const request = deterministicMergeRequest('seed-merge', store, transport, counter)

  await assert.rejects(
    () => mergeCompleteSetToRegularWithOperation(request),
    /stop after prepared merge/,
  )
  assert.deepEqual(counter.calls, [{ keysetId: DETERMINISTIC_KEYSET_C, count: 3 }])
  assert.equal(transport.converted.length, 1)
  assert.equal(store.records.get('seed-merge')?.metadata.outputMode, 'seed-derived')
  store.records.get('seed-merge')!.state = 'Failed'
  store.records.get('seed-merge')!.lastError = 'mint transport stopped after preparation'

  await assert.rejects(
    () => mergeCompleteSetToRegularWithOperation(request),
    /previously failed: mint transport stopped after preparation/,
  )
  assert.equal(counter.calls.length, 1)
  assert.equal(transport.converted.length, 1)
})

test('seed-derived CTF merge rejects a substituted output before recovery exposure', async () => {
  const counter = new CountingCounterSource()
  const store = new MemoryProofOperationStore()
  const transport = new DeterministicSplitTransport(counter)
  const request = deterministicMergeRequest('seed-merge-substituted', store, transport, counter)
  await assert.rejects(
    () => mergeCompleteSetToRegularWithOperation(request),
    /stop after prepared merge/,
  )
  store.records.get('seed-merge-substituted')!.outputs['*']![0]!.secret = '00'

  await assert.rejects(() => mergeCompleteSetToRegularWithOperation(request), /does not match/)
  assert.equal(counter.calls.length, 1)
  assert.equal(transport.converted.length, 1)
})

test('legacy and custom merge output authority reject a seed-derived replay request', async () => {
  for (const outputMode of [undefined, 'custom'] as const) {
    const operationId = `merge-output-authority-${outputMode ?? 'legacy'}`
    const store = new MemoryProofOperationStore()
    const record = completedMergeRecord(operationId)
    if (outputMode !== undefined) record.metadata.outputMode = outputMode
    store.records.set(operationId, record)
    const transport = new FakeSplitTransport()

    await assert.rejects(
      () =>
        mergeCompleteSetToRegularWithOperation({
          ...mergeReplayRequest(operationId, store, transport),
          outputMode: {
            kind: 'seed-derived',
            seed: DETERMINISTIC_SEED,
            counterSource: new CountingCounterSource(),
          },
        }),
      /output authority differs/,
    )
    assert.equal(transport.converted.length, 0)
    assert.equal(transport.keyLookups.length, 0)
  }
})

test('merge output mode rejects malformed discriminants before fresh or replay effects', async () => {
  const malformedOutputMode = { kind: 'malformed' } as never
  const freshStore = new MemoryProofOperationStore()
  const freshTransport = new FakeSplitTransport()
  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({
        ...mergeReplayRequest('merge-malformed-fresh', freshStore, freshTransport),
        outputMode: malformedOutputMode,
      }),
    /output mode is invalid/,
  )
  assert.equal(freshStore.prepareCalls, 0)
  assert.equal(freshTransport.converted.length, 0)

  const replayStore = new MemoryProofOperationStore()
  replayStore.records.set('merge-malformed-replay', completedMergeRecord('merge-malformed-replay'))
  const replayTransport = new FakeSplitTransport()
  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({
        ...mergeReplayRequest('merge-malformed-replay', replayStore, replayTransport),
        outputMode: malformedOutputMode,
      }),
    /output mode is invalid/,
  )
  assert.equal(replayStore.completedCalls, 0)
  assert.equal(replayTransport.keyLookups.length, 0)
  assert.equal(replayTransport.converted.length, 0)
})

test('mergeCompleteSetToRegularWithOperation replays completed operations without mint calls', async () => {
  const store = new MemoryProofOperationStore()
  store.records.set('merge-op-completed', completedMergeRecord('merge-op-completed'))
  const transport = new FakeSplitTransport()

  const result = await mergeCompleteSetToRegularWithOperation({
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId: 'merge-op-completed',
    transport,
    conditionId: CONDITION_ID,
    conditionalProofsByCollection: {
      Alpha: [proof('keyset-alpha', 10, 'alpha')],
    },
    outputAmountSubunits: 9,
    regularKeyset: feePlanningKeyset(0, { 1: 'regular' }) as MintKeys,
    proofOperationStore: store,
  })

  assert.deepEqual(result.regularProofs, [completedProof(REGULAR_KEYSET_ID, 9, 'regular-stored')])
  assert.deepEqual(result.spentConditionalProofsByCollection, {
    Alpha: [proof('keyset-alpha', 10, 'alpha')],
  })
  assert.equal(transport.converted.length, 0)
})

test('merge dispatch guard runs after preparation on fresh execution and UNSPENT replay', async () => {
  const store = new MemoryProofOperationStore()
  const transport = new FakeSplitTransport()
  const request = {
    ...mergeReplayRequest('merge-dispatch-guard', store, transport),
    makeRegularOutputs: ({
      amountSubunits,
      keyset,
    }: {
      amountSubunits: number
      keyset: MintKeys
    }) => [canonicalOutput('*', amountSubunits, keyset.id)],
  }
  const guardStates: Array<string | undefined> = []
  const rejectDispatch = async () => {
    guardStates.push(store.records.get('merge-dispatch-guard')?.state)
    throw new Error('dispatch blocked')
  }

  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({ ...request, beforeMintMutation: rejectDispatch }),
    /dispatch blocked/,
  )
  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({
        ...request,
        proofStateChecker: {
          checkProofsStates: async () => [exactState('alpha', CheckStateEnum.UNSPENT)],
        },
        beforeMintMutation: rejectDispatch,
      }),
    /dispatch blocked/,
  )
  assert.deepEqual(guardStates, ['prepared', 'prepared'])
  assert.equal(transport.converted.length, 0)
  assert.equal(store.records.get('merge-dispatch-guard')?.state, 'prepared')
})

test('merge dispatch guard skips terminal, spent restore, and pending replay paths', async () => {
  let guardCalls = 0
  const beforeMintMutation = async () => {
    guardCalls += 1
    throw new Error('dispatch must not run')
  }
  const transport = new FakeSplitTransport()
  const request = (operationId: string, store: MemoryProofOperationStore) => ({
    ...mergeReplayRequest(operationId, store, transport),
    beforeMintMutation,
  })

  const completedStore = new MemoryProofOperationStore()
  completedStore.records.set('merge-guard-completed', completedMergeRecord('merge-guard-completed'))
  await mergeCompleteSetToRegularWithOperation(request('merge-guard-completed', completedStore))

  const failedStore = new MemoryProofOperationStore()
  failedStore.records.set('merge-guard-failed', {
    ...completedMergeRecord('merge-guard-failed'),
    state: 'Failed',
    resultProofs: undefined,
    lastError: 'mint refused merge',
  })
  await assert.rejects(
    () => mergeCompleteSetToRegularWithOperation(request('merge-guard-failed', failedStore)),
    /previously failed/,
  )

  const spentStore = new MemoryProofOperationStore()
  const spent = completedMergeRecord('merge-guard-spent')
  spent.state = 'prepared'
  delete spent.resultProofs
  delete spent.resultProofsDigest
  spentStore.records.set('merge-guard-spent', spent)
  await mergeCompleteSetToRegularWithOperation({
    ...request('merge-guard-spent', spentStore),
    proofStateChecker: {
      checkProofsStates: async () => [exactState('alpha', CheckStateEnum.SPENT)],
    },
    restoreOutputGroups: async () => ({
      regular: [completedProof(REGULAR_KEYSET_ID, 9, 'restored')],
    }),
  })

  const pendingStore = new MemoryProofOperationStore()
  const pending = completedMergeRecord('merge-guard-pending')
  pending.state = 'prepared'
  delete pending.resultProofs
  delete pending.resultProofsDigest
  pendingStore.records.set('merge-guard-pending', pending)
  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({
        ...request('merge-guard-pending', pendingStore),
        proofStateChecker: {
          checkProofsStates: async () => [exactState('alpha', CheckStateEnum.PENDING)],
        },
      }),
    ProofOperationPendingError,
  )

  assert.equal(guardCalls, 0)
  assert.equal(transport.converted.length, 0)
})

test('merge recovery restores or replays only on a reading of each exact input Y', async () => {
  const alpha = proof('keyset-alpha', 10, 'alpha')
  const beta = proof('keyset-bravo', 10, 'beta')
  await assertRecoveryActsOnlyOnExactInputYs('alpha', 'beta', async (states) => {
    const store = new MemoryProofOperationStore()
    const record = completedMergeRecord('merge-exact-y')
    record.state = 'prepared'
    delete record.resultProofs
    delete record.resultProofsDigest
    record.inputs = [alpha, beta]
    record.metadata = { ...record.metadata, inputsByCollection: { Alpha: [alpha], Beta: [beta] } }
    store.records.set('merge-exact-y', record)
    const effects = { restores: 0, dispatches: 0 }
    const outcome = await recoveryOutcome(
      mergeCompleteSetToRegularWithOperation({
        ...mergeReplayRequest('merge-exact-y', store, new FakeSplitTransport()),
        conditionalProofsByCollection: { Alpha: [alpha], Beta: [beta] },
        proofStateChecker: { checkProofsStates: async () => states },
        restoreOutputGroups: async () => {
          effects.restores += 1
          return { regular: [completedProof(REGULAR_KEYSET_ID, 9, 'restored')] }
        },
        beforeMintMutation: async () => {
          effects.dispatches += 1
          throw new Error('dispatch reached')
        },
      }),
    )
    return { outcome, ...effects }
  })
})

test('mergeCompleteSetToRegularWithOperation rejects malformed policy before store or mint effects', async () => {
  const transport = new FakeSplitTransport()
  const store = new MemoryProofOperationStore()
  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        parentCollectionId: '1'.repeat(64),
        operationId: 'merge-invalid-parent',
        transport,
        conditionId: CONDITION_ID,
        conditionalProofsByCollection: {
          YES: [proof(YES_KEYSET_ID, 10, 'yes')],
          NO: [proof(NO_KEYSET_ID, 10, 'no')],
        },
        outputAmountSubunits: 10,
        regularKeyset: feePlanningKeyset(0, { 1: 'regular' }) as MintKeys,
        proofOperationStore: store,
      }),
    /parentCollectionId must be omitted or exactly 64 zeroes/,
  )
  assert.deepEqual(transport.keyLookups, [])
  assert.equal(transport.converted.length, 0)
  assert.equal(store.prepareCalls, 0)

  const mixedTransport = new FakeSplitTransport({
    [NO_KEYSET_ID]: 'sat',
  })
  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'merge-invalid-unit',
        transport: mixedTransport,
        conditionId: CONDITION_ID,
        conditionalProofsByCollection: {
          YES: [proof(YES_KEYSET_ID, 10, 'yes')],
          NO: [proof(NO_KEYSET_ID, 10, 'no')],
        },
        outputAmountSubunits: 10,
        regularKeyset: feePlanningKeyset(0, { 1: 'regular' }) as MintKeys,
        proofOperationStore: store,
      }),
    /unit must be exactly msat/,
  )
  assert.equal(mixedTransport.converted.length, 0)
  assert.equal(store.prepareCalls, 0)
})

test('prepared merge replay rejects a substituted keyset identity before proof-state or mint mutation', async () => {
  const store = new MemoryProofOperationStore()
  const record = completedMergeRecord('replay-substituted-merge-keyset')
  record.state = 'prepared'
  delete record.resultProofs
  delete record.resultProofsDigest
  store.records.set(record.operationId, record)
  const transport = new FakeSplitTransport({}, { 'keyset-alpha': 'foreign-keyset' })
  let proofStateCalls = 0

  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({
        ...mergeReplayRequest(record.operationId, store, transport),
        proofStateChecker: {
          checkProofsStates: async () => {
            proofStateCalls += 1
            return []
          },
        },
      }),
    /keyset keyset-alpha was not returned exactly/,
  )
  assert.equal(proofStateCalls, 0)
  assert.equal(transport.converted.length, 0)
  assert.equal(store.completedCalls, 0)
})

test('completed CTF merge replay rejects every request-authority mismatch without effects', async () => {
  const cases: Array<{
    name: string
    change: (request: MergeReplayRequest) => void
  }> = [
    { name: 'mint', change: (request) => void (request.mintUrl = 'https://other.example') },
    { name: 'condition', change: (request) => void (request.conditionId = 'b'.repeat(64)) },
    { name: 'amount', change: (request) => void (request.outputAmountSubunits = 8) },
    {
      name: 'input',
      change: (request) =>
        void (request.conditionalProofsByCollection = {
          Alpha: [proof('keyset-alpha', 10, 'other-alpha')],
        }),
    },
    {
      name: 'output keyset',
      change: (request) =>
        void (request.regularKeyset = {
          ...request.regularKeyset,
          id: OTHER_REGULAR_KEYSET_ID,
        }),
    },
  ]

  for (const scenario of cases) {
    const operationId = `merge-mismatch-${scenario.name}`
    const store = new MemoryProofOperationStore()
    store.records.set(operationId, completedMergeRecord(operationId))
    const transport = new FakeSplitTransport()
    const request = mergeReplayRequest(operationId, store, transport)
    scenario.change(request)

    await assert.rejects(
      () => mergeCompleteSetToRegularWithOperation(request),
      /does not match the current request|stored output authority/,
      scenario.name,
    )
    assert.deepEqual(transport.keyLookups, [], scenario.name)
    assert.equal(transport.converted.length, 0, scenario.name)
    assert.equal(store.completedCalls, 0, scenario.name)
  }
})

test('completed CTF merge replay accepts canonical groups regardless of object key order', async () => {
  const operationId = 'merge-key-order'
  const record = completedMergeRecord(operationId)
  const alpha = proof('keyset-alpha', 10, 'alpha')
  const beta = proof('keyset-beta', 10, 'beta')
  record.inputs = [alpha, beta]
  record.metadata.inputsByCollection = { Alpha: [alpha], Beta: [beta] }
  const store = new MemoryProofOperationStore()
  store.records.set(operationId, record)
  const transport = new FakeSplitTransport()
  const request = mergeReplayRequest(operationId, store, transport)
  request.conditionalProofsByCollection = { Beta: [beta], Alpha: [alpha] }

  const result = await mergeCompleteSetToRegularWithOperation(request)

  assert.deepEqual(result.spentConditionalProofsByCollection, { Alpha: [alpha], Beta: [beta] })
  assert.deepEqual(transport.keyLookups, [])
  assert.equal(transport.converted.length, 0)
})

test('selectCompleteSetMergeInputs selects equal gross inputs across a complete partition', () => {
  const selection = selectCompleteSetMergeInputs({
    desiredOutputSubunits: 8,
    inputFeePpkByKeyset: {
      'keyset-alpha': 1_000,
      'keyset-beta': 1_000,
      'keyset-gamma': 1_000,
    },
    conditionalProofsByCollection: {
      Alpha: [proof('keyset-alpha', 11, 'alpha')],
      Beta: [proof('keyset-beta', 11, 'beta')],
      Gamma: [proof('keyset-gamma', 11, 'gamma')],
    },
  })

  assert.deepEqual(Object.keys(selection?.selectedProofsByCollection ?? {}).sort(), [
    'Alpha',
    'Beta',
    'Gamma',
  ])
  assert.equal(selection?.grossInputSubunits, 11)
  assert.equal(selection?.convertFeeSubunits, 3)
  assert.equal(selection?.outputAmountSubunits, 8)
})

test('selectCompleteSetMergeInputs fails closed for uneven complete-set buckets', () => {
  const selection = selectCompleteSetMergeInputs({
    desiredOutputSubunits: 8,
    inputFeePpkByKeyset: {
      'keyset-alpha': 0,
      'keyset-beta': 0,
      'keyset-gamma': 0,
    },
    maxScanExtraSubunits: 2,
    conditionalProofsByCollection: {
      Alpha: [proof('keyset-alpha', 8, 'alpha')],
      Beta: [proof('keyset-beta', 9, 'beta')],
      Gamma: [proof('keyset-gamma', 8, 'gamma')],
    },
  })

  assert.equal(selection, null)
})

test('resolveInputFeePpkByProofKeyset throws when mint omits a proof keyset', async () => {
  await assert.rejects(
    () =>
      resolveInputFeePpkByProofKeyset(
        {
          getKeys: async () => ({ keysets: [] }),
        },
        [proof('missing-keyset', 1, 'secret')],
      ),
    /Mint did not return keys for keyset missing-keyset/,
  )
})

test('computeGrossCtfInputAmountSubunits funds the convert fee from the output proof count', () => {
  const keyset = feePlanningKeyset(1, { 1: 'k1', 2: 'k2', 4: 'k4' })

  assert.equal(
    computeGrossCtfInputAmountSubunits({
      faceAmountSubunits: 2,
      keyset,
    }),
    3,
  )
})

test('computeGrossCtfInputAmountSubunits handles F greater than 1 for many proofs', () => {
  const keyset = feePlanningKeyset(1, { 1: 'k1' })

  assert.equal(
    computeGrossCtfInputAmountSubunits({
      faceAmountSubunits: 1001,
      keyset,
    }),
    1003,
  )
})

test('computeGrossCtfInputAmountSubunits refuses a face amount that no gross amount nets in bounded work', () => {
  // At 1000 ppk each proof costs 1 subunit, so a gross amount G nets G - popcount(G).
  // No G nets 20000: 20007 (0b100111000100111) nets 19999 and 20008 (0b100111000101000) nets 20002.
  let keysetReads = 0
  const keys = new Proxy(
    Object.fromEntries(Array.from({ length: 16 }, (_, bit) => [2 ** bit, `k${bit}`])),
    {
      ownKeys(target) {
        keysetReads += 1
        return Reflect.ownKeys(target)
      },
    },
  )

  assert.throws(
    () =>
      computeGrossCtfInputAmountSubunits({
        faceAmountSubunits: 20_000,
        keyset: feePlanningKeyset(1000, keys),
      }),
    /Could not find gross CTF input amount that nets 20000 subunits after input fees/,
  )
  // The planner reads the keyset once for each candidate proof count, not once for each subunit.
  assert.ok(keysetReads < 1_000, 'gross planning must not scan the face amount')
})

test('computeGrossCtfInputAmountSubunits finds an exact gross amount that the fee iteration misses', () => {
  // At 3000 ppk each proof costs 3 subunits. From 14 the iteration alternates between 23 and 26.
  // 20 (0b10100) has two proofs, so it nets 20 - 6 = 14. No smaller gross amount nets 14.
  const keyset = feePlanningKeyset(3000, { 1: 'k1', 2: 'k2', 4: 'k4', 8: 'k8', 16: 'k16' })

  assert.equal(computeGrossCtfInputAmountSubunits({ faceAmountSubunits: 14, keyset }), 20)
})

const CONDITION_ID = 'a'.repeat(64)
const DETERMINISTIC_KEYSET_A = `01${'b'.repeat(64)}`
const DETERMINISTIC_KEYSET_B = `01${'c'.repeat(64)}`
const DETERMINISTIC_KEYSET_C = `01${'d'.repeat(64)}`
const DETERMINISTIC_SEED = Uint8Array.from({ length: 64 }, (_, index) => index + 1)

class CountingCounterSource implements CounterSource {
  readonly calls: Array<{ keysetId: string; count: number }> = []
  #next = 0

  async reserve(keysetId: string, count: number) {
    this.calls.push({ keysetId, count })
    const start = this.#next
    this.#next += count
    return { start, count }
  }

  async advanceToAtLeast(): Promise<void> {}
}

class DeterministicSplitTransport implements CtfSplitTransport {
  readonly keyLookups: string[] = []
  readonly posted: Array<Parameters<CtfSplitTransport['postSplit']>[0]> = []
  readonly converted: Array<Parameters<NonNullable<CtfSplitTransport['postConvert']>>[0]> = []
  private readonly counter: CountingCounterSource

  constructor(counter: CountingCounterSource) {
    this.counter = counter
  }

  async getKeys(keysetId: string): Promise<MintKeys> {
    this.keyLookups.push(keysetId)
    return {
      id: keysetId,
      unit: 'msat',
      keys: { 1: '02', 4: '02', 32: '02', 64: '02' },
      input_fee_ppk: 0,
    } as MintKeys
  }

  async getRootPartitionKeysets(): Promise<Record<string, string>> {
    throw new Error('root partition discovery is not used')
  }

  async postSplit(
    request: Parameters<CtfSplitTransport['postSplit']>[0],
  ): ReturnType<CtfSplitTransport['postSplit']> {
    if (this.counter.calls.length !== 2)
      throw new Error('split counters were not reserved before mint I/O')
    this.posted.push(request)
    throw new Error('stop after prepared split')
  }

  async postConvert(
    request: Parameters<NonNullable<CtfSplitTransport['postConvert']>>[0],
  ): ReturnType<NonNullable<CtfSplitTransport['postConvert']>> {
    if (this.counter.calls.length !== 1)
      throw new Error('merge counter was not reserved before mint I/O')
    this.converted.push(request)
    throw new Error('stop after prepared merge')
  }
}

function deterministicMergeRequest(
  operationId: string,
  proofOperationStore: CtfProofOperationStore,
  transport: CtfSplitTransport,
  counterSource: CounterSource,
): Parameters<typeof mergeCompleteSetToRegularWithOperation>[0] {
  return {
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId,
    transport,
    conditionId: CONDITION_ID,
    conditionalProofsByCollection: {
      Alpha: [proof(DETERMINISTIC_KEYSET_A, 100, 'alpha')],
      Beta: [proof(DETERMINISTIC_KEYSET_B, 100, 'beta')],
    },
    outputAmountSubunits: 100,
    regularKeyset: {
      id: DETERMINISTIC_KEYSET_C,
      unit: 'msat',
      keys: { 1: '02', 4: '02', 32: '02', 64: '02' },
      input_fee_ppk: 0,
    } as MintKeys,
    proofOperationStore,
    outputMode: { kind: 'seed-derived', seed: DETERMINISTIC_SEED, counterSource },
  }
}

function exactState(secret: string, state: CheckStateEnum): ProofState {
  return { Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true), state, witness: null }
}

async function recoveryOutcome(run: Promise<unknown>): Promise<string> {
  try {
    await run
    return 'completed'
  } catch (error) {
    return error instanceof ProofOperationPendingError ? 'pending' : (error as Error).message
  }
}

/**
 * Probe one prepared two-input recovery path. Only a reading of each exact input
 * Y may restore (all SPENT) or reach mint dispatch (all UNSPENT).
 */
async function assertRecoveryActsOnlyOnExactInputYs(
  a: string,
  b: string,
  probe: (
    states: ProofState[],
  ) => Promise<{ outcome: string; restores: number; dispatches: number }>,
): Promise<void> {
  const retained = { outcome: 'pending', restores: 0, dispatches: 0 }
  const scenarios: Array<[string, ProofState[], typeof retained]> = []
  for (const state of [CheckStateEnum.SPENT, CheckStateEnum.UNSPENT]) {
    scenarios.push(
      [`missing ${state}`, [exactState(a, state)], retained],
      [
        `extra ${state}`,
        [exactState(a, state), exactState(b, state), exactState('foreign', state)],
        retained,
      ],
      [`duplicate ${state}`, [exactState(a, state), exactState(a, state)], retained],
      [`foreign ${state}`, [exactState(a, state), exactState('foreign', state)], retained],
    )
  }
  scenarios.push(
    [
      'reordered SPENT',
      [exactState(b, CheckStateEnum.SPENT), exactState(a, CheckStateEnum.SPENT)],
      { outcome: 'completed', restores: 1, dispatches: 0 },
    ],
    [
      'reordered UNSPENT',
      [exactState(b, CheckStateEnum.UNSPENT), exactState(a, CheckStateEnum.UNSPENT)],
      { outcome: 'dispatch reached', restores: 0, dispatches: 1 },
    ],
    [
      'mixed',
      [exactState(a, CheckStateEnum.SPENT), exactState(b, CheckStateEnum.UNSPENT)],
      retained,
    ],
  )
  const actual: Record<string, unknown> = {}
  const expected: Record<string, unknown> = {}
  for (const [name, states, outcome] of scenarios) {
    actual[name] = await probe(states)
    expected[name] = outcome
  }
  assert.deepEqual(actual, expected)
}

class FakeSplitTransport implements CtfSplitTransport {
  private readonly unitByKeysetId: Record<string, string>
  private readonly returnedIdByKeysetId: Record<string, string>

  readonly keyLookups: string[] = []
  rootPartitionLookups = 0
  readonly posted: Array<Parameters<CtfSplitTransport['postSplit']>[0]> = []
  readonly converted: Array<Parameters<NonNullable<CtfSplitTransport['postConvert']>>[0]> = []

  constructor(
    unitByKeysetId: Record<string, string> = {},
    returnedIdByKeysetId: Record<string, string> = {},
  ) {
    this.unitByKeysetId = unitByKeysetId
    this.returnedIdByKeysetId = returnedIdByKeysetId
  }

  async getKeys(keysetId: string): Promise<MintKeys> {
    this.keyLookups.push(keysetId)
    return {
      id: this.returnedIdByKeysetId[keysetId] ?? keysetId,
      unit: this.unitByKeysetId[keysetId] ?? 'msat',
      keys: {},
      input_fee_ppk: 0,
    } as MintKeys
  }

  async getRootPartitionKeysets(): Promise<Record<string, string>> {
    this.rootPartitionLookups += 1
    return {
      YES: YES_KEYSET_ID,
      NO: NO_KEYSET_ID,
    }
  }

  async postSplit(
    request: Parameters<CtfSplitTransport['postSplit']>[0],
  ): ReturnType<CtfSplitTransport['postSplit']> {
    this.posted.push(request)
    return {
      signatures: Object.fromEntries(
        Object.entries(request.outputs).map(([collection, outputs]) => [
          collection,
          outputs.map((message) => signature(message)),
        ]),
      ),
    }
  }

  async postConvert(
    request: Parameters<NonNullable<CtfSplitTransport['postConvert']>>[0],
  ): ReturnType<NonNullable<CtfSplitTransport['postConvert']>> {
    this.converted.push(request)
    return {
      signatures: Object.fromEntries(
        Object.entries(request.outputs).map(([collection, outputs]) => [
          collection,
          outputs.map((message) => signature(message)),
        ]),
      ),
    }
  }
}

class MemoryProofOperationStore implements CtfProofOperationStore {
  readonly records = new Map<string, CtfProofOperationRecord>()
  prepareCalls = 0
  completedCalls = 0

  async getProofOperation(operationId: string): Promise<CtfProofOperationRecord | null> {
    return this.records.get(operationId) ?? null
  }

  async prepareProofOperation(
    input: CtfPrepareProofOperationInput,
  ): Promise<CtfProofOperationRecord> {
    this.prepareCalls += 1
    const record: CtfProofOperationRecord = {
      ...input,
      state: 'prepared',
      createdAt: 1,
      updatedAt: 1,
    }
    this.records.set(input.operationId, record)
    return record
  }

  async markProofOperationCompleted(
    operationId: string,
    completion: CtfProofOperationCompletion,
  ): Promise<CtfProofOperationRecord> {
    this.completedCalls += 1
    const existing = this.records.get(operationId)
    if (!existing) throw new Error(`missing operation ${operationId}`)
    if (existing.kind !== completion.kind) throw new Error('completion kind mismatch')
    const completed: CtfProofOperationRecord = {
      ...existing,
      state: 'completed',
      resultProofs: completion.resultProofs,
      resultProofsDigest:
        'resultProofsDigest' in completion ? completion.resultProofsDigest : undefined,
      updatedAt: existing.updatedAt + 1,
    }
    this.records.set(operationId, completed)
    return completed
  }
}

function proof(id: string, amount: number, secret: string): Proof {
  return {
    id,
    amount,
    secret,
    C: `C-${secret}`,
  }
}

function output(collection: string, amount: number, keysetId: string): CtfSplitOutputData {
  return {
    blindedMessage: { amount, id: keysetId, B_: `B-${collection}` },
    blindingFactor: 1n,
    secret: new TextEncoder().encode(`secret-${collection}`),
    toProof: (sig) => proof(sig.id, sig.amount, `proof-${collection}`),
  }
}

function canonicalOutput(collection: string, amount: number, keysetId: string): CtfSplitOutputData {
  return new OutputData(
    { amount, id: keysetId, B_: SECP256K1_GENERATOR },
    1n,
    new TextEncoder().encode(`secret-${collection}`),
  )
}

type MergeReplayRequest = Parameters<typeof mergeCompleteSetToRegularWithOperation>[0]

function mergeReplayRequest(
  operationId: string,
  proofOperationStore: CtfProofOperationStore,
  transport: CtfSplitTransport,
): MergeReplayRequest {
  return {
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId,
    transport,
    conditionId: CONDITION_ID,
    conditionalProofsByCollection: {
      Alpha: [proof('keyset-alpha', 10, 'alpha')],
    },
    outputAmountSubunits: 9,
    regularKeyset: feePlanningKeyset(0, { 1: 'regular' }) as MintKeys,
    proofOperationStore,
  }
}

function completedMergeRecord(operationId: string): CtfProofOperationRecord {
  const resultProofs = {
    regular: [completedProof(REGULAR_KEYSET_ID, 9, 'regular-stored')],
  }
  return {
    operationId,
    kind: 'ctf-merge',
    state: 'completed',
    mintUrl: 'https://mint.example',
    inputs: [proof('keyset-alpha', 10, 'alpha')],
    outputs: {
      '*': [storedOutput('regular-stored', 9, REGULAR_KEYSET_ID)],
    },
    metadata: {
      conditionId: CONDITION_ID,
      outputAmountSubunits: 9,
      baseAsset: 'sat',
      unit: 'msat',
      parentCollectionId: '0'.repeat(64),
      inputsByCollection: {
        Alpha: [proof('keyset-alpha', 10, 'alpha')],
      },
    },
    resultProofs,
    resultProofsDigest: completedProofAuthorityDigest(resultProofs),
    createdAt: 1,
    updatedAt: 2,
  }
}

const SECP256K1_GENERATOR = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

function completedProof(id: string, amount: number, secret: string): Proof {
  return {
    id,
    amount,
    secret,
    C: SECP256K1_GENERATOR,
  }
}

function storedOutput(secret: string, amount: number, keysetId: string) {
  return {
    blindedMessage: { amount, id: keysetId, B_: SECP256K1_GENERATOR },
    blindingFactor: '1',
    secret: Array.from(new TextEncoder().encode(secret))
      .map((value) => value.toString(16).padStart(2, '0'))
      .join(''),
  }
}

function signature(message: SerializedBlindedMessage): SerializedBlindedSignature {
  return {
    amount: message.amount,
    id: message.id,
    C_: `C-${message.B_}`,
  }
}

function feePlanningKeyset(inputFeePpk: number, keys: Record<number, string>) {
  return {
    id: REGULAR_KEYSET_ID,
    unit: 'msat',
    keys,
    input_fee_ppk: inputFeePpk,
  }
}
