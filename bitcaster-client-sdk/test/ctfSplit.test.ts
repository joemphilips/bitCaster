import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  completedProofAuthorityDigest,
  computeGrossCtfInputAmountSubunits,
  computeGrossCtfInputAmountSats,
  createCtfProofOperationCompletion,
  normalizeProof,
  normalizeProofArray,
  normalizeProofGroups,
  prepareBoundedCtfProofOperation,
  ProofOperationPendingError,
  resolveComplementaryOutcomeLegs,
  resolveInputFeePpkByProofKeyset,
  resolveMintOutcomeSetKey,
  resumeExactPersistedCtfSplit,
  selectRootPartitionKeysets,
  splitRegularProofsWithOperation,
  splitCompleteSetWithOperation,
  mergeCompleteSetToRegularWithOperation,
  selectCompleteSetMergeInputs,
  type CtfPrepareProofOperationInput,
  type CtfProofOperationCompletion,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
  type CtfSplitMakeOutputsInput,
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
import {
  Amount,
  CheckStateEnum,
  OutputData,
  type ProofState,
  type SwapPreview,
} from '@cashu/cashu-ts'

test('computeGrossCtfInputAmountSats is the exported sat alias for gross CTF planning', () => {
  const keyset = {
    id: 'keyset-fee',
    keys: { 1: 'pubkey-1', 2: 'pubkey-2', 4: 'pubkey-4', 8: 'pubkey-8' },
    input_fee_ppk: 501,
  }

  assert.equal(
    computeGrossCtfInputAmountSats({ faceAmountSats: 10, keyset }),
    computeGrossCtfInputAmountSubunits({ faceAmountSubunits: 10, keyset }),
  )
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

test('CTF split enforces input, group, and blinded-output bounds before effects', async () => {
  const inputStore = new MemoryProofOperationStore()
  const inputTransport = new FakeSplitTransport()
  await assert.rejects(
    splitCompleteSetWithOperation({
      ...splitReplayRequest('input-bound', inputStore, inputTransport),
      collateralProofs: Array.from({ length: 257 }, (_, index) =>
        proof('input-keyset', 1, `input-${index}`),
      ),
    }),
    /input proofs proof limit/,
  )
  assert.deepEqual(inputTransport.keyLookups, [])
  assert.equal(inputStore.prepareCalls, 0)

  const groupStore = new MemoryProofOperationStore()
  const groupTransport = new FakeSplitTransport()
  await assert.rejects(
    splitCompleteSetWithOperation({
      ...splitReplayRequest('group-bound', groupStore, groupTransport),
      outcomeCollectionKeysets: Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`group-${index}`, `keyset-${index}`]),
      ),
    }),
    /group limit/,
  )
  assert.deepEqual(groupTransport.keyLookups, [])
  assert.equal(groupStore.prepareCalls, 0)

  const deterministicGroupStore = new MemoryProofOperationStore()
  const deterministicCounter = new CountingCounterSource()
  const deterministicGroupTransport = new DeterministicSplitTransport(deterministicCounter)
  await assert.rejects(
    splitCompleteSetWithOperation({
      ...deterministicSplitRequest(
        'deterministic-group-bound',
        deterministicGroupStore,
        deterministicGroupTransport,
        deterministicCounter,
      ),
      outcomeCollectionKeysets: Object.fromEntries(
        Array.from({ length: 17 }, (_, index) => [`group-${index}`, DETERMINISTIC_KEYSET_A]),
      ),
    }),
    /group limit/,
  )
  assert.deepEqual(deterministicGroupTransport.keyLookups, [])
  assert.deepEqual(deterministicCounter.calls, [])
  assert.equal(deterministicGroupStore.prepareCalls, 0)

  const outputStore = new MemoryProofOperationStore()
  const outputTransport = new FakeSplitTransport()
  await assert.rejects(
    splitCompleteSetWithOperation({
      ...splitReplayRequest('output-bound', outputStore, outputTransport),
      makeOutputs: () =>
        Array.from({ length: 257 }, (_, index) => output(`output-${index}`, 1, 'keyset-yes')),
    }),
    /blinded output limit/,
  )
  assert.equal(outputTransport.posted.length, 0)
  assert.equal(outputStore.prepareCalls, 0)
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
      YES: 'keyset-yes',
      NO: 'keyset-no',
    },
  }

  assert.deepEqual(selectRootPartitionKeysets(condition), {
    YES: 'keyset-yes',
    NO: 'keyset-no',
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
          keysets: { YES: 'keyset-yes', NO: 'keyset-no' },
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
            keysets: { ['b'.repeat(64)]: 'keyset-yes', ['c'.repeat(64)]: 'keyset-no' },
          },
          {
            lockOutcomeSetId: 'YES',
            keepOutcomeSetId: 'NO',
            baseAsset: 'sat',
          },
          [
            {
              id: 'keyset-yes',
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

test('splitCompleteSetWithOperation prepares outputs before posting and completes results', async () => {
  const transport = new FakeSplitTransport()
  const store = new MemoryProofOperationStore()

  const result = await splitCompleteSetWithOperation({
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    parentCollectionId: '0'.repeat(64),
    operationId: 'op-1',
    transport,
    conditionId: CONDITION_ID,
    collateralProofs: [proof('input-keyset', 100, 'input-secret')],
    outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
    amountSubunits: 100,
    proofOperationStore: store,
    makeOutputs: ({ collection, amountSubunits, keyset }) => [
      output(collection, amountSubunits, keyset.id),
    ],
  })

  assert.deepEqual(Object.keys(result).sort(), ['NO', 'YES'])
  assert.equal(result.YES[0].secret, 'proof-YES')
  assert.equal(result.NO[0].secret, 'proof-NO')
  assert.equal(transport.posted.length, 1)
  assert.deepEqual(transport.posted[0].outputs.YES, [
    { amount: 100, id: 'keyset-yes', B_: 'B-YES' },
  ])

  const record = await store.getProofOperation('op-1')
  assert.equal(record?.state, 'completed')
  assert.equal(record?.metadata.conditionId, CONDITION_ID)
  assert.equal(record?.metadata.amountSubunits, 100)
  assert.equal(record?.metadata.baseAsset, 'sat')
  assert.equal(record?.metadata.unit, 'msat')
  assert.equal(record?.metadata.parentCollectionId, '0'.repeat(64))
  assert.deepEqual(record?.metadata.outcomeCollectionKeysets, {
    YES: 'keyset-yes',
    NO: 'keyset-no',
  })
})

test('seed-derived CTF split reserves stable collection plans before mint I/O and reuses them', async () => {
  const counter = new CountingCounterSource()
  const store = new MemoryProofOperationStore()
  const transport = new DeterministicSplitTransport(counter)
  const request = deterministicSplitRequest('seed-split', store, transport, counter)

  await assert.rejects(() => splitCompleteSetWithOperation(request), /stop after prepared split/)
  assert.deepEqual(counter.calls, [
    { keysetId: DETERMINISTIC_KEYSET_A, count: 3 },
    { keysetId: DETERMINISTIC_KEYSET_B, count: 3 },
  ])
  assert.equal(transport.posted.length, 1)
  const prepared = store.records.get('seed-split')
  assert.equal(prepared?.metadata.outputMode, 'seed-derived')
  assert.deepEqual(Object.keys(prepared?.metadata.outputDescriptors as object).sort(), [
    'Alpha',
    'Beta',
  ])
  assert.equal('outputPlans' in (prepared?.metadata ?? {}), false)
  const preparedReplayKeyLookups = transport.keyLookups.length

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        ...request,
        proofStateChecker: { checkProofsStates: async () => pendingInputState() },
      }),
    ProofOperationPendingError,
  )
  assert.equal(counter.calls.length, 2)
  assert.equal(transport.posted.length, 1)
  assert.equal(transport.keyLookups.length - preparedReplayKeyLookups, 2)
})

test('seed-derived CTF split rejects a substituted persisted descriptor before proof-state or mint I/O', async () => {
  const counter = new CountingCounterSource()
  const store = new MemoryProofOperationStore()
  const transport = new DeterministicSplitTransport(counter)
  const request = deterministicSplitRequest('seed-split-substituted', store, transport, counter)
  await assert.rejects(() => splitCompleteSetWithOperation(request), /stop after prepared split/)
  const record = store.records.get('seed-split-substituted')!
  const descriptors = record.metadata.outputDescriptors as Record<string, { counterStart: number }>
  descriptors.Alpha!.counterStart += 1
  let proofStateCalls = 0

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        ...request,
        proofStateChecker: {
          checkProofsStates: async () => {
            proofStateCalls += 1
            return pendingInputState()
          },
        },
      }),
    /does not match/,
  )
  assert.equal(proofStateCalls, 0)
  assert.equal(transport.posted.length, 1)
  assert.equal(counter.calls.length, 2)
})

test('seed-derived CTF split rejects a wrong seed before returning completed outputs', async () => {
  const counter = new CountingCounterSource()
  const store = new MemoryProofOperationStore()
  const transport = new DeterministicSplitTransport(counter)
  const request = deterministicSplitRequest('seed-split-wrong-seed', store, transport, counter)
  await assert.rejects(() => splitCompleteSetWithOperation(request), /stop after prepared split/)
  const record = store.records.get('seed-split-wrong-seed')!
  record.state = 'completed'
  record.resultProofs = Object.fromEntries(
    Object.entries(record.outputs).map(([group, outputs]) => [
      group,
      outputs.map((output) =>
        completedProof(
          output.blindedMessage.id,
          output.blindedMessage.amount,
          Buffer.from(output.secret, 'hex').toString('utf8'),
        ),
      ),
    ]),
  )
  record.resultProofsDigest = completedProofAuthorityDigest(record.resultProofs)

  const terminalReplayKeyLookups = transport.keyLookups.length

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        ...request,
        outputMode: {
          kind: 'seed-derived',
          seed: Uint8Array.from(DETERMINISTIC_SEED, (value) => value ^ 0xff),
          counterSource: counter,
        },
      }),
    /does not match/,
  )
  assert.equal(transport.posted.length, 1)
  assert.equal(counter.calls.length, 2)
  assert.equal(transport.keyLookups.length, terminalReplayKeyLookups)
})

test('legacy and custom split output authority reject a seed-derived replay request', async () => {
  for (const outputMode of [undefined, 'custom'] as const) {
    const operationId = `split-output-authority-${outputMode ?? 'legacy'}`
    const store = new MemoryProofOperationStore()
    const record = completedSplitRecord(operationId)
    if (outputMode !== undefined) record.metadata.outputMode = outputMode
    store.records.set(operationId, record)
    const transport = new FakeSplitTransport()

    await assert.rejects(
      () =>
        splitCompleteSetWithOperation({
          ...splitReplayRequest(operationId, store, transport),
          outputMode: {
            kind: 'seed-derived',
            seed: DETERMINISTIC_SEED,
            counterSource: new CountingCounterSource(),
          },
        }),
      /output authority differs/,
    )
    assert.equal(transport.posted.length, 0)
    assert.equal(transport.keyLookups.length, 0)
  }
})

test('split output mode rejects malformed discriminants before fresh or replay effects', async () => {
  const malformedOutputMode = { kind: 'malformed' } as never
  const freshStore = new MemoryProofOperationStore()
  const freshTransport = new FakeSplitTransport()
  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        ...splitReplayRequest('split-malformed-fresh', freshStore, freshTransport),
        outputMode: malformedOutputMode,
      }),
    /output mode is invalid/,
  )
  assert.equal(freshStore.prepareCalls, 0)
  assert.equal(freshTransport.posted.length, 0)

  const replayStore = new MemoryProofOperationStore()
  replayStore.records.set('split-malformed-replay', completedSplitRecord('split-malformed-replay'))
  const replayTransport = new FakeSplitTransport()
  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        ...splitReplayRequest('split-malformed-replay', replayStore, replayTransport),
        outputMode: malformedOutputMode,
      }),
    /output mode is invalid/,
  )
  assert.equal(replayStore.completedCalls, 0)
  assert.equal(replayTransport.keyLookups.length, 0)
  assert.equal(replayTransport.posted.length, 0)
})

test('legacy split output descriptors reject replay before mint effects', async () => {
  const operationId = 'split-legacy-descriptors'
  const store = new MemoryProofOperationStore()
  const record = completedSplitRecord(operationId)
  record.metadata.outputDescriptors = {}
  store.records.set(operationId, record)
  const transport = new FakeSplitTransport()

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        ...splitReplayRequest(operationId, store, transport),
        makeOutputs: ({ collection, amountSubunits, keyset }) => [
          output(collection, amountSubunits, keyset.id),
        ],
      }),
    /output authority differs/,
  )
  assert.equal(transport.posted.length, 0)
  assert.equal(transport.keyLookups.length, 0)
})

test('16 deterministic groups with 80 outputs fit the durable operation authority bound', async () => {
  const counter = new CountingCounterSource()
  const store = new MemoryProofOperationStore()
  const keysets = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `group-${index.toString().padStart(2, '0')}`,
      `01${index.toString(16).padStart(2, '0')}${'e'.repeat(62)}`,
    ]),
  )
  const firstKeyset = Object.values(keysets)[0]!
  const transport: CtfSplitTransport = {
    getKeys: async (id) =>
      ({
        id,
        unit: 'msat',
        keys: { 1: '02', 2: '02', 4: '02', 8: '02', 16: '02' },
        input_fee_ppk: 0,
      }) as MintKeys,
    getRootPartitionKeysets: async () => keysets,
    postSplit: async () => {
      throw new Error('stop after prepared split')
    },
  }

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'seed-split-16-groups',
        transport,
        conditionId: CONDITION_ID,
        collateralProofs: [proof(firstKeyset, 31, 'input-secret')],
        outcomeCollectionKeysets: keysets,
        amountSubunits: 31,
        proofOperationStore: store,
        outputMode: { kind: 'seed-derived', seed: DETERMINISTIC_SEED, counterSource: counter },
      }),
    /stop after prepared split/,
  )
  const prepared = store.records.get('seed-split-16-groups')!
  assert.equal(Object.values(prepared.outputs).flat().length, 80)
  assert.equal('outputPlans' in prepared.metadata, false)
  assert.ok(new TextEncoder().encode(JSON.stringify(prepared)).byteLength <= 64 * 1024)
})

test('cumulative record limit rejects 16 deterministic groups with 256 outputs before reservation', async () => {
  const counter = new CountingCounterSource()
  let posts = 0
  const groups = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => {
      const suffix = index.toString(16).padStart(2, '0')
      return [`${suffix}${'a'.repeat(62)}`, `01${suffix}${'e'.repeat(62)}`]
    }),
  )
  const firstKeyset = Object.values(groups)[0]!
  const transport: CtfSplitTransport = {
    getKeys: async (id) =>
      ({
        id,
        unit: 'msat',
        keys: Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [String(2 ** index), '02']),
        ),
        input_fee_ppk: 0,
      }) as MintKeys,
    getRootPartitionKeysets: async () => groups,
    postSplit: async () => {
      posts += 1
      throw new Error('must not post an oversized deterministic split')
    },
  }
  const store = new MemoryProofOperationStore()

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'seed-split-256-outputs',
        transport,
        conditionId: CONDITION_ID,
        collateralProofs: [proof(firstKeyset, 65_535, 'input-secret')],
        outcomeCollectionKeysets: groups,
        amountSubunits: 65_535,
        proofOperationStore: store,
        outputMode: { kind: 'seed-derived', seed: DETERMINISTIC_SEED, counterSource: counter },
      }),
    /byte limit/,
  )
  assert.deepEqual(counter.calls, [])
  assert.equal(posts, 0)
  assert.equal(store.prepareCalls, 0)
})

test('conservative 16-by-9 deterministic split record rejects before reservation', async () => {
  const counter = new CountingCounterSource()
  const store = new MemoryProofOperationStore()
  let posts = 0
  const keysets = Object.fromEntries(
    Array.from({ length: 16 }, (_, index) => [
      `group-${index.toString().padStart(2, '0')}`,
      `01${index.toString(16).padStart(2, '0')}${'e'.repeat(62)}`,
    ]),
  )
  const firstKeyset = Object.values(keysets)[0]!
  const transport: CtfSplitTransport = {
    getKeys: async (id) =>
      ({
        id,
        unit: 'msat',
        keys: Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [String(2 ** index), '02']),
        ),
        input_fee_ppk: 0,
      }) as MintKeys,
    getRootPartitionKeysets: async () => keysets,
    postSplit: async () => {
      posts += 1
      throw new Error('must not post an oversized deterministic split')
    },
  }

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'seed-split-16-by-9',
        transport,
        conditionId: CONDITION_ID,
        collateralProofs: [proof(firstKeyset, 511, 'input-secret')],
        outcomeCollectionKeysets: keysets,
        amountSubunits: 511,
        proofOperationStore: store,
        outputMode: { kind: 'seed-derived', seed: DETERMINISTIC_SEED, counterSource: counter },
      }),
    /byte limit/,
  )
  assert.deepEqual(counter.calls, [])
  assert.equal(store.prepareCalls, 0)
  assert.equal(posts, 0)
})

test('seed-derived split rejects a non-msat output keyset before reservation', async () => {
  const counter = new CountingCounterSource()
  const store = new MemoryProofOperationStore()
  let posts = 0
  const transport: CtfSplitTransport = {
    getKeys: async (id) => ({ id, unit: 'sat', keys: { 1: '02' } }) as MintKeys,
    getRootPartitionKeysets: async () => ({}),
    postSplit: async () => {
      posts += 1
      throw new Error('must not post')
    },
  }

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'seed-split-wrong-unit',
        transport,
        conditionId: CONDITION_ID,
        collateralProofs: [proof(DETERMINISTIC_KEYSET_A, 1, 'input-secret')],
        outcomeCollectionKeysets: { Alpha: DETERMINISTIC_KEYSET_A, Beta: DETERMINISTIC_KEYSET_B },
        amountSubunits: 1,
        proofOperationStore: store,
        outputMode: { kind: 'seed-derived', seed: DETERMINISTIC_SEED, counterSource: counter },
      }),
    /unit must be exactly msat/,
  )
  assert.deepEqual(counter.calls, [])
  assert.equal(store.prepareCalls, 0)
  assert.equal(posts, 0)
})

test('fresh seed-derived split rejects an input-only substituted keyset before reservation', async () => {
  const counter = new CountingCounterSource()
  const store = new MemoryProofOperationStore()
  const transport = new FakeSplitTransport({}, { 'input-keyset': 'foreign-keyset' })

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'seed-split-substituted-input-keyset',
        transport,
        conditionId: CONDITION_ID,
        collateralProofs: [proof('input-keyset', 1, 'input-secret')],
        outcomeCollectionKeysets: { Alpha: DETERMINISTIC_KEYSET_A, Beta: DETERMINISTIC_KEYSET_B },
        amountSubunits: 1,
        proofOperationStore: store,
        outputMode: { kind: 'seed-derived', seed: DETERMINISTIC_SEED, counterSource: counter },
      }),
    /keyset input-keyset was not returned exactly/,
  )
  assert.deepEqual(counter.calls, [])
  assert.equal(store.prepareCalls, 0)
  assert.equal(transport.posted.length, 0)
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

test('split dispatch guard runs after preparation on fresh execution and exact UNSPENT replay', async () => {
  const store = new MemoryProofOperationStore()
  const transport = new FakeSplitTransport()
  const request = {
    ...splitReplayRequest('split-dispatch-guard', store, transport),
    makeOutputs: ({ collection, amountSubunits, keyset }: CtfSplitMakeOutputsInput) => [
      canonicalOutput(collection, amountSubunits, keyset.id),
    ],
  }
  const guardStates: Array<string | undefined> = []
  const rejectDispatch = async () => {
    guardStates.push(store.records.get('split-dispatch-guard')?.state)
    throw new Error('dispatch blocked')
  }

  await assert.rejects(
    () => splitCompleteSetWithOperation({ ...request, beforeMintMutation: rejectDispatch }),
    /dispatch blocked/,
  )
  await assert.rejects(
    () =>
      resumeExactPersistedCtfSplit({
        ...request,
        proofStateChecker: {
          checkProofsStates: async () => [{ Y: 'Y-input', state: CheckStateEnum.UNSPENT }],
        },
        beforeMintMutation: rejectDispatch,
      }),
    /dispatch blocked/,
  )
  assert.deepEqual(guardStates, ['prepared', 'prepared'])
  assert.equal(transport.posted.length, 0)
  assert.equal(store.records.get('split-dispatch-guard')?.state, 'prepared')
})

test('splitCompleteSetWithOperation rejects malformed root parents before store or mint effects', async () => {
  const invalidParents = [null, '', '0'.repeat(63), '1'.repeat(64), '0'.repeat(64) + ' ']
  for (const [index, parentCollectionId] of invalidParents.entries()) {
    const transport = new FakeSplitTransport()
    const store = new MemoryProofOperationStore()
    await assert.rejects(
      () =>
        splitCompleteSetWithOperation({
          mintUrl: 'https://mint.example',
          baseAsset: 'sat',
          parentCollectionId,
          operationId: `invalid-parent-${index}`,
          transport,
          conditionId: CONDITION_ID,
          collateralProofs: [proof('input-keyset', 100, 'input-secret')],
          outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
          amountSubunits: 100,
          proofOperationStore: store,
          makeOutputs: ({ collection, amountSubunits, keyset }) => [
            output(collection, amountSubunits, keyset.id),
          ],
        }),
      /parentCollectionId must be omitted or exactly 64 zeroes/,
    )
    assert.deepEqual(transport.keyLookups, [])
    assert.equal(transport.posted.length, 0)
    assert.equal(store.prepareCalls, 0)
    assert.equal(store.records.size, 0)
  }
})

test('splitCompleteSetWithOperation rejects non-msat input or output keysets before journaling', async () => {
  for (const [keysetId, unit] of [
    ['input-keyset', 'sat'],
    ['keyset-yes', 'usd'],
    ['keyset-no', 'MSAT'],
  ]) {
    const transport = new FakeSplitTransport({ [keysetId]: unit })
    const store = new MemoryProofOperationStore()
    await assert.rejects(
      () =>
        splitCompleteSetWithOperation({
          mintUrl: 'https://mint.example',
          baseAsset: 'sat',
          operationId: `invalid-unit-${keysetId}`,
          transport,
          conditionId: CONDITION_ID,
          collateralProofs: [proof('input-keyset', 100, 'input-secret')],
          outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
          amountSubunits: 100,
          proofOperationStore: store,
          makeOutputs: ({ collection, amountSubunits, keyset }) => [
            output(collection, amountSubunits, keyset.id),
          ],
        }),
      /unit must be exactly msat/,
    )
    assert.equal(transport.posted.length, 0)
    assert.equal(store.prepareCalls, 0)
  }
})

test('splitCompleteSetWithOperation accepts msat collateral keysets for sat markets', async () => {
  const transport = new FakeSplitTransport({
    'keyset-yes': 'msat',
    'keyset-no': 'msat',
  })
  const store = new MemoryProofOperationStore()

  await splitCompleteSetWithOperation({
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId: 'op-msat-collateral',
    transport,
    conditionId: CONDITION_ID,
    collateralProofs: [proof('input-keyset', 100, 'input-secret')],
    outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
    amountSubunits: 100,
    proofOperationStore: store,
    makeOutputs: ({ collection, amountSubunits, keyset }) => [
      output(collection, amountSubunits, keyset.id),
    ],
  })

  assert.equal(transport.posted.length, 1)
})

test('splitCompleteSetWithOperation rejects unsupported product base assets before posting', async () => {
  const transport = new FakeSplitTransport({
    'input-keyset': 'usd',
    'keyset-yes': 'usd',
    'keyset-no': 'usd',
  })
  const store = new MemoryProofOperationStore()

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'usd',
        operationId: 'op-usd-collateral',
        transport,
        conditionId: CONDITION_ID,
        collateralProofs: [proof('input-keyset', 100, 'input-secret')],
        outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
        amountSubunits: 100,
        proofOperationStore: store,
        makeOutputs: ({ collection, amountSubunits, keyset }) => [
          output(collection, amountSubunits, keyset.id),
        ],
      }),
    /baseAsset must be exactly sat/,
  )
  assert.equal(transport.posted.length, 0)
  assert.equal(store.records.size, 0)
})

test('splitCompleteSetWithOperation normalizes structured Cashu Amount inputs before mint calls', async () => {
  const transport = new FakeSplitTransport()
  const store = new MemoryProofOperationStore()

  await splitCompleteSetWithOperation({
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId: 'op-structured-input',
    transport,
    conditionId: CONDITION_ID,
    collateralProofs: [
      {
        ...proof('input-keyset', 100, 'input-secret'),
        amount: { value: 100n },
      } as unknown as Proof,
    ],
    outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
    amountSubunits: 100,
    proofOperationStore: store,
    makeOutputs: ({ collection, amountSubunits, keyset }) => [
      output(collection, amountSubunits, keyset.id),
    ],
  })

  assert.equal(typeof transport.posted[0].inputs[0].amount, 'number')
  assert.equal(transport.posted[0].inputs[0].amount, 100)
  assert.equal(typeof store.records.get('op-structured-input')?.inputs[0].amount, 'number')
})

test('splitCompleteSetWithOperation replays completed operations without mint calls', async () => {
  const completed = new MemoryProofOperationStore()
  completed.records.set('op-completed', completedSplitRecord('op-completed'))
  const transport = new FakeSplitTransport()

  const result = await splitCompleteSetWithOperation({
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId: 'op-completed',
    transport,
    conditionId: CONDITION_ID,
    collateralProofs: [proof('input-keyset', 100, 'input-secret')],
    outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
    amountSubunits: 100,
    proofOperationStore: completed,
    makeOutputs: ({ collection, amountSubunits, keyset }) => [
      output(collection, amountSubunits, keyset.id),
    ],
  })

  assert.deepEqual(result, {
    YES: [completedProof('keyset-yes', 100, 'stored-proof')],
    NO: [completedProof('keyset-no', 100, 'stored-proof-no')],
  })
  result.YES[0].secret = 'mutated'
  assert.equal(completed.records.get('op-completed')?.resultProofs?.YES[0].secret, 'stored-proof')
  assert.equal(transport.posted.length, 0)
})

test('exact persisted split resume validates authority and makes no mint call when completed', async () => {
  const store = new MemoryProofOperationStore()
  store.records.set('op-exact-completed', completedSplitRecord('op-exact-completed'))
  const transport = new FakeSplitTransport()

  const result = await resumeExactPersistedCtfSplit({
    mintUrl: 'https://mint.example',
    operationId: 'op-exact-completed',
    conditionId: CONDITION_ID,
    collateralProofs: [proof('input-keyset', 100, 'input-secret')],
    amountSubunits: 100,
    baseAsset: 'sat',
    transport,
    proofOperationStore: store,
  })

  assert.deepEqual(result, completedSplitRecord('op-exact-completed').resultProofs)
  assert.equal(transport.keyLookups.length, 0)
  assert.equal(transport.rootPartitionLookups, 0)
  assert.equal(transport.posted.length, 0)

  await assert.rejects(
    () =>
      resumeExactPersistedCtfSplit({
        mintUrl: 'https://mint.example',
        operationId: 'op-exact-completed',
        conditionId: CONDITION_ID,
        collateralProofs: [proof('input-keyset', 100, 'different-input')],
        amountSubunits: 100,
        baseAsset: 'sat',
        transport,
        proofOperationStore: store,
      }),
    /authority|differ|conflict|does not match/,
  )
  assert.equal(transport.keyLookups.length, 0)
  assert.equal(transport.rootPartitionLookups, 0)
  assert.equal(transport.posted.length, 0)
})

test('exact prepared split resume uses persisted keysets without root rediscovery', async () => {
  const store = new MemoryProofOperationStore()
  const prepared = structuredClone(completedSplitRecord('op-exact-prepared'))
  prepared.state = 'prepared'
  delete prepared.resultProofs
  delete prepared.resultProofsDigest
  store.records.set('op-exact-prepared', prepared)
  const transport = new FakeSplitTransport()

  await assert.rejects(
    () =>
      resumeExactPersistedCtfSplit({
        mintUrl: 'https://mint.example',
        operationId: 'op-exact-prepared',
        conditionId: CONDITION_ID,
        collateralProofs: [proof('input-keyset', 100, 'input-secret')],
        amountSubunits: 100,
        baseAsset: 'sat',
        transport,
        proofOperationStore: store,
        proofStateChecker: {
          checkProofsStates: async () => [
            { Y: 'Y-input', state: CheckStateEnum.PENDING, witness: null },
          ],
        },
      }),
    ProofOperationPendingError,
  )

  assert.deepEqual(transport.keyLookups.sort(), ['input-keyset', 'keyset-no', 'keyset-yes'])
  assert.equal(transport.rootPartitionLookups, 0)
  assert.equal(transport.posted.length, 0)
})

test('prepared split replay fetches each keyset once through UNSPENT execution', async () => {
  const store = new MemoryProofOperationStore()
  const prepared = structuredClone(completedSplitRecord('op-exact-unspent'))
  prepared.state = 'prepared'
  delete prepared.resultProofs
  delete prepared.resultProofsDigest
  store.records.set('op-exact-unspent', prepared)
  const transport = new FakeSplitTransport()

  await assert.rejects(
    () =>
      resumeExactPersistedCtfSplit({
        mintUrl: 'https://mint.example',
        operationId: 'op-exact-unspent',
        conditionId: CONDITION_ID,
        collateralProofs: [proof('input-keyset', 100, 'input-secret')],
        amountSubunits: 100,
        baseAsset: 'sat',
        transport,
        proofOperationStore: store,
        proofStateChecker: {
          checkProofsStates: async () => [{ Y: 'Y-input', state: CheckStateEnum.UNSPENT }],
        },
      }),
    /invalid signature/,
  )

  assert.deepEqual(transport.keyLookups.sort(), ['input-keyset', 'keyset-no', 'keyset-yes'])
  assert.equal(transport.posted.length, 1)
})

test('splitCompleteSetWithOperation fails closed for failed existing operations', async () => {
  const failed = new MemoryProofOperationStore()
  failed.records.set('op-failed', {
    ...completedSplitRecord('op-failed'),
    state: 'Failed',
    resultProofs: undefined,
    lastError: 'mint refused split',
  })
  const transport = new FakeSplitTransport()

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'op-failed',
        transport,
        conditionId: CONDITION_ID,
        collateralProofs: [proof('input-keyset', 100, 'input-secret')],
        outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
        amountSubunits: 100,
        proofOperationStore: failed,
        makeOutputs: ({ collection, amountSubunits, keyset }) => [
          output(collection, amountSubunits, keyset.id),
        ],
      }),
    /previously failed: mint refused split/,
  )
  assert.equal(transport.posted.length, 0)
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

  assert.deepEqual(result.regularProofs, [completedProof('regular-keyset', 9, 'regular-stored')])
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
    makeRegularOutputs: ({ amountSubunits, keyset }: { amountSubunits: number; keyset: MintKeys }) => [
      canonicalOutput('*', amountSubunits, keyset.id),
    ],
  }
  const guardStates: Array<string | undefined> = []
  const rejectDispatch = async () => {
    guardStates.push(store.records.get('merge-dispatch-guard')?.state)
    throw new Error('dispatch blocked')
  }

  await assert.rejects(
    () => mergeCompleteSetToRegularWithOperation({ ...request, beforeMintMutation: rejectDispatch }),
    /dispatch blocked/,
  )
  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({
        ...request,
        proofStateChecker: {
          checkProofsStates: async () => [{ Y: 'Y-alpha', state: CheckStateEnum.UNSPENT }],
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
      checkProofsStates: async () => [{ Y: 'Y-alpha', state: CheckStateEnum.SPENT }],
    },
    restoreOutputGroups: async () => ({ regular: [completedProof('regular-keyset', 9, 'restored')] }),
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
          checkProofsStates: async () => [{ Y: 'Y-alpha', state: CheckStateEnum.PENDING }],
        },
      }),
    ProofOperationPendingError,
  )

  assert.equal(guardCalls, 0)
  assert.equal(transport.converted.length, 0)
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
          YES: [proof('keyset-yes', 10, 'yes')],
          NO: [proof('keyset-no', 10, 'no')],
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

  const mixedTransport = new FakeSplitTransport({ 'keyset-no': 'sat' })
  await assert.rejects(
    () =>
      mergeCompleteSetToRegularWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'merge-invalid-unit',
        transport: mixedTransport,
        conditionId: CONDITION_ID,
        conditionalProofsByCollection: {
          YES: [proof('keyset-yes', 10, 'yes')],
          NO: [proof('keyset-no', 10, 'no')],
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

test('CTF replay rejects noncanonical durable policy and keyset metadata without mutation', async () => {
  const invalidMetadata = [
    { baseAsset: undefined, unit: 'msat', parentCollectionId: '0'.repeat(64) },
    { baseAsset: 'sat', unit: 'sat', parentCollectionId: '0'.repeat(64) },
    { baseAsset: 'sat', unit: 'msat', parentCollectionId: undefined },
    { baseAsset: 'sat', unit: 'msat', parentCollectionId: '1'.repeat(64) },
  ]
  for (const [index, metadata] of invalidMetadata.entries()) {
    const store = new MemoryProofOperationStore()
    store.records.set(`replay-invalid-${index}`, {
      ...completedSplitRecord(`replay-invalid-${index}`),
      metadata: {
        ...completedSplitRecord(`replay-invalid-${index}`).metadata,
        ...metadata,
      },
    })
    const transport = new FakeSplitTransport()
    await assert.rejects(
      () =>
        splitCompleteSetWithOperation({
          mintUrl: 'https://mint.example',
          baseAsset: 'sat',
          operationId: `replay-invalid-${index}`,
          transport,
          conditionId: CONDITION_ID,
          collateralProofs: [proof('input-keyset', 100, 'input-secret')],
          outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
          amountSubunits: 100,
          proofOperationStore: store,
        }),
      /must be exactly sat|must be exactly msat|must be omitted or exactly 64 zeroes/,
    )
    assert.deepEqual(transport.keyLookups, [])
    assert.equal(transport.posted.length, 0)
    assert.equal(store.completedCalls, 0)
  }
})

test('prepared CTF replay validates persisted keysets before proof-state or mint mutation', async () => {
  const store = new MemoryProofOperationStore()
  store.records.set('replay-invalid-output-unit', {
    operationId: 'replay-invalid-output-unit',
    kind: 'ctf-split',
    state: 'prepared',
    mintUrl: 'https://mint.example',
    inputs: [proof('input-keyset', 100, 'input-secret')],
    outputs: {
      YES: [storedOutput('YES', 100, 'keyset-yes')],
      NO: [storedOutput('NO', 100, 'keyset-no')],
    },
    metadata: {
      baseAsset: 'sat',
      unit: 'msat',
      amount: 100,
      parentCollectionId: '0'.repeat(64),
      conditionId: CONDITION_ID,
      amountSubunits: 100,
      outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
    },
    createdAt: 1,
    updatedAt: 2,
  })
  const transport = new FakeSplitTransport({ 'keyset-yes': 'sat' })
  let proofStateCalls = 0

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'replay-invalid-output-unit',
        transport,
        conditionId: CONDITION_ID,
        collateralProofs: [proof('input-keyset', 100, 'input-secret')],
        outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
        amountSubunits: 100,
        proofOperationStore: store,
        proofStateChecker: {
          checkProofsStates: async () => {
            proofStateCalls += 1
            return []
          },
        },
      }),
    /unit must be exactly msat/,
  )
  assert.equal(proofStateCalls, 0)
  assert.equal(transport.posted.length, 0)
  assert.equal(store.completedCalls, 0)
})

test('prepared split replay rejects a substituted keyset identity before proof-state or mint mutation', async () => {
  const store = new MemoryProofOperationStore()
  const record = completedSplitRecord('replay-substituted-split-keyset')
  record.state = 'prepared'
  delete record.resultProofs
  delete record.resultProofsDigest
  store.records.set(record.operationId, record)
  const transport = new FakeSplitTransport({}, { 'keyset-yes': 'foreign-keyset' })
  let proofStateCalls = 0

  await assert.rejects(
    () =>
      splitCompleteSetWithOperation({
        ...splitReplayRequest(record.operationId, store, transport),
        proofStateChecker: {
          checkProofsStates: async () => {
            proofStateCalls += 1
            return []
          },
        },
      }),
    /keyset keyset-yes was not returned exactly/,
  )
  assert.equal(proofStateCalls, 0)
  assert.equal(transport.posted.length, 0)
  assert.equal(store.completedCalls, 0)
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

test('completed CTF split replay rejects every request-authority mismatch without effects', async () => {
  const cases: Array<{
    name: string
    change: (request: SplitReplayRequest) => void
  }> = [
    { name: 'mint', change: (request) => void (request.mintUrl = 'https://other.example') },
    { name: 'condition', change: (request) => void (request.conditionId = 'b'.repeat(64)) },
    { name: 'amount', change: (request) => void (request.amountSubunits = 101) },
    {
      name: 'input',
      change: (request) =>
        void (request.collateralProofs = [proof('input-keyset', 100, 'other-secret')]),
    },
    {
      name: 'outcome mapping',
      change: (request) =>
        void (request.outcomeCollectionKeysets = {
          YES: 'keyset-yes',
          NO: 'different-keyset',
        }),
    },
  ]

  for (const scenario of cases) {
    const operationId = `split-mismatch-${scenario.name}`
    const store = new MemoryProofOperationStore()
    store.records.set(operationId, completedSplitRecord(operationId))
    const transport = new FakeSplitTransport()
    const request = splitReplayRequest(operationId, store, transport)
    scenario.change(request)

    await assert.rejects(
      () => splitCompleteSetWithOperation(request),
      /does not match the current request/,
      scenario.name,
    )
    assert.deepEqual(transport.keyLookups, [], scenario.name)
    assert.equal(transport.posted.length, 0, scenario.name)
    assert.equal(store.completedCalls, 0, scenario.name)
  }
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
          id: 'other-regular-keyset',
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

test('completed CTF replay rejects substituted durable proof authority without effects', async () => {
  const cases: Array<{
    name: string
    mutate: (record: CtfProofOperationRecord) => void
  }> = [
    {
      name: 'missing result digest',
      mutate: (record) => void delete record.resultProofsDigest,
    },
    {
      name: 'substituted result digest',
      mutate: (record) => void (record.resultProofsDigest = '0'.repeat(64)),
    },
    {
      name: 'result secret',
      mutate: (record) => {
        record.resultProofs!.YES[0]!.secret = 'substituted'
        record.resultProofsDigest = completedProofAuthorityDigest(record.resultProofs!)
      },
    },
    {
      name: 'result signature',
      mutate: (record) => {
        record.resultProofs!.YES[0]!.C = 'not-a-point'
        record.resultProofsDigest = completedProofAuthorityDigest(record.resultProofs!)
      },
    },
    {
      name: 'result DLEQ',
      mutate: (record) => {
        record.resultProofs!.YES[0]!.dleq = {
          e: 'not-hex',
          s: '0'.repeat(64),
          r: '0'.repeat(64),
        }
        record.resultProofsDigest = completedProofAuthorityDigest(record.resultProofs!)
      },
    },
    {
      name: 'stored secret',
      mutate: (record) => void (record.outputs.YES![0]!.secret = 'not-hex'),
    },
    {
      name: 'stored blinding factor',
      mutate: (record) => void (record.outputs.YES![0]!.blindingFactor = '01'),
    },
    {
      name: 'out-of-range blinding factor',
      mutate: (record) => void (record.outputs.YES![0]!.blindingFactor = 'f'.repeat(64)),
    },
    {
      name: 'stored blinded point',
      mutate: (record) => void (record.outputs.YES![0]!.blindedMessage.B_ = 'not-a-point'),
    },
  ]

  for (const scenario of cases) {
    const operationId = `completed-authority-${scenario.name}`
    const record = completedSplitRecord(operationId)
    scenario.mutate(record)
    const store = new MemoryProofOperationStore()
    store.records.set(operationId, record)
    const transport = new FakeSplitTransport()

    await assert.rejects(() =>
      splitCompleteSetWithOperation(splitReplayRequest(operationId, store, transport)),
    )
    assert.deepEqual(transport.keyLookups, [], scenario.name)
    assert.equal(transport.posted.length, 0, scenario.name)
    assert.equal(store.completedCalls, 0, scenario.name)
  }
})

test('prepared CTF replay rejects malformed stored outputs before mint effects', async () => {
  const cases: Array<{
    name: string
    mutate: (record: CtfProofOperationRecord) => void
  }> = [
    {
      name: 'stored secret',
      mutate: (record) => void (record.outputs.YES![0]!.secret = 'not-hex'),
    },
    {
      name: 'stored blinding factor',
      mutate: (record) => void (record.outputs.YES![0]!.blindingFactor = '01'),
    },
    {
      name: 'out-of-range blinding factor',
      mutate: (record) => void (record.outputs.YES![0]!.blindingFactor = 'f'.repeat(64)),
    },
    {
      name: 'stored blinded point',
      mutate: (record) => void (record.outputs.YES![0]!.blindedMessage.B_ = 'not-a-point'),
    },
  ]

  for (const scenario of cases) {
    const operationId = `prepared-output-${scenario.name}`
    const record = completedSplitRecord(operationId)
    record.state = 'prepared'
    delete record.resultProofs
    delete record.resultProofsDigest
    scenario.mutate(record)
    const store = new MemoryProofOperationStore()
    store.records.set(operationId, record)
    const transport = new FakeSplitTransport()

    await assert.rejects(() =>
      splitCompleteSetWithOperation(splitReplayRequest(operationId, store, transport)),
    )
    assert.deepEqual(transport.keyLookups, [], scenario.name)
    assert.equal(transport.posted.length, 0, scenario.name)
    assert.equal(store.completedCalls, 0, scenario.name)
  }
})

test('completed BLS CTF replay accepts a canonical secp P2BK ephemeral point', async () => {
  const operationId = 'completed-bls-p2bk'
  const record = completedSplitRecord(operationId)
  const resultProofs = {
    YES: [
      {
        ...completedProof(BLS_KEYSET_ID, 100, 'stored-proof'),
        C: BLS_G1_POINT,
        p2pk_e: SECP256K1_GENERATOR,
      },
    ],
    NO: [
      {
        ...completedProof(BLS_KEYSET_ID, 100, 'stored-proof-no'),
        C: BLS_G1_POINT,
        p2pk_e: SECP256K1_GENERATOR,
      },
    ],
  }
  record.metadata.outcomeCollectionKeysets = { YES: BLS_KEYSET_ID, NO: BLS_KEYSET_ID }
  record.outputs.YES![0]!.blindedMessage.id = BLS_KEYSET_ID
  record.outputs.YES![0]!.blindedMessage.B_ = BLS_G1_POINT
  record.outputs.NO![0]!.blindedMessage.id = BLS_KEYSET_ID
  record.outputs.NO![0]!.blindedMessage.B_ = BLS_G1_POINT
  record.resultProofs = resultProofs
  record.resultProofsDigest = completedProofAuthorityDigest(resultProofs)
  const store = new MemoryProofOperationStore()
  store.records.set(operationId, record)
  const transport = new FakeSplitTransport()
  const request = splitReplayRequest(operationId, store, transport)
  request.outcomeCollectionKeysets = { YES: BLS_KEYSET_ID, NO: BLS_KEYSET_ID }

  const result = await splitCompleteSetWithOperation(request)

  assert.equal(result.YES[0]?.p2pk_e, SECP256K1_GENERATOR)
  assert.deepEqual(transport.keyLookups, [])
  assert.equal(transport.posted.length, 0)
})

test('selectCompleteSetMergeInputs selects equal gross inputs across a complete partition', () => {
  const selection = selectCompleteSetMergeInputs({
    desiredOutputSats: 8,
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
  assert.equal(selection?.grossInputSats, 11)
  assert.equal(selection?.convertFeeSats, 3)
  assert.equal(selection?.outputAmountSubunits, 8)
})

test('selectCompleteSetMergeInputs fails closed for uneven complete-set buckets', () => {
  const selection = selectCompleteSetMergeInputs({
    desiredOutputSats: 8,
    inputFeePpkByKeyset: {
      'keyset-alpha': 0,
      'keyset-beta': 0,
      'keyset-gamma': 0,
    },
    maxScanExtraSats: 2,
    conditionalProofsByCollection: {
      Alpha: [proof('keyset-alpha', 8, 'alpha')],
      Beta: [proof('keyset-beta', 9, 'beta')],
      Gamma: [proof('keyset-gamma', 8, 'gamma')],
    },
  })

  assert.equal(selection, null)
})

test('splitRegularProofsWithOperation turns a larger regular proof into an exact CTF input', async () => {
  const store = new MemoryProofOperationStore()
  const wallet = new FakeRegularSplitWallet({
    preview: {
      amount: 100,
      fees: 0,
      keysetId: 'regular-keyset',
      inputs: [proof('regular-keyset', 210, 'input-210')],
      sendOutputs: [
        new OutputData(
          { amount: 100, id: 'regular-keyset', B_: 'B-send' },
          1n,
          new Uint8Array([1]),
        ),
      ],
      keepOutputs: [
        new OutputData(
          { amount: 110, id: 'regular-keyset', B_: 'B-keep' },
          2n,
          new Uint8Array([2]),
        ),
      ],
      unselectedProofs: [],
    },
    result: {
      send: [proof('regular-keyset', 100, 'send-100')],
      keep: [proof('regular-keyset', 110, 'keep-110')],
    },
  })

  const split = await splitRegularProofsWithOperation({
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId: 'regular-op-210',
    wallet,
    proofs: [proof('regular-keyset', 210, 'input-210')],
    amountSubunits: 100,
    proofOperationStore: store,
  })

  assert.deepEqual(split.send, [proof('regular-keyset', 100, 'send-100')])
  assert.deepEqual(split.keep, [proof('regular-keyset', 110, 'keep-110')])
  assert.deepEqual(split.spent, [proof('regular-keyset', 210, 'input-210')])
  assert.equal(wallet.prepareCalls, 1)
  assert.equal(wallet.completeCalls, 1)
  assert.equal(store.records.get('regular-op-210')?.state, 'completed')
  assert.equal(store.records.get('regular-op-210')?.metadata.baseAsset, 'sat')
})

test('regular split dispatch guard runs after preparation on fresh execution and UNSPENT replay', async () => {
  const store = new MemoryProofOperationStore()
  const wallet = new FakeRegularSplitWallet({
    preview: {
      amount: 100,
      fees: 0,
      keysetId: 'regular-keyset',
      inputs: [proof('regular-keyset', 210, 'input-210')],
      sendOutputs: [new OutputData({ amount: 100, id: 'regular-keyset', B_: 'B-send' }, 1n, new Uint8Array([1]))],
      keepOutputs: [new OutputData({ amount: 110, id: 'regular-keyset', B_: 'B-keep' }, 2n, new Uint8Array([2]))],
      unselectedProofs: [],
    },
    result: {
      send: [proof('regular-keyset', 100, 'send-100')],
      keep: [proof('regular-keyset', 110, 'keep-110')],
    },
  })
  const request = {
    mintUrl: 'https://mint.example',
    baseAsset: 'sat' as const,
    operationId: 'regular-dispatch-guard',
    wallet,
    proofs: [proof('regular-keyset', 210, 'input-210')],
    amountSubunits: 100,
    proofOperationStore: store,
  }
  const guardStates: Array<string | undefined> = []
  const rejectDispatch = async () => {
    guardStates.push(store.records.get('regular-dispatch-guard')?.state)
    throw new Error('dispatch blocked')
  }

  await assert.rejects(
    () => splitRegularProofsWithOperation({ ...request, beforeMintMutation: rejectDispatch }),
    /dispatch blocked/,
  )
  await assert.rejects(
    () => splitRegularProofsWithOperation({ ...request, beforeMintMutation: rejectDispatch }),
    /dispatch blocked/,
  )
  assert.deepEqual(guardStates, ['prepared', 'prepared'])
  assert.equal(wallet.completeCalls, 0)
  assert.equal(store.records.get('regular-dispatch-guard')?.state, 'prepared')
})

test('splitRegularProofsWithOperation replays completed regular splits without mint calls', async () => {
  const store = new MemoryProofOperationStore()
  store.records.set('regular-op-completed', {
    operationId: 'regular-op-completed',
    kind: 'regular-split',
    state: 'completed',
    mintUrl: 'https://mint.example',
    inputs: [proof('regular-keyset', 210, 'input-210')],
    outputs: {},
    metadata: {
      baseAsset: 'sat',
      unit: 'msat',
      amount: 100,
    },
    resultProofs: {
      send: [proof('regular-keyset', 100, 'send-100')],
      keep: [proof('regular-keyset', 110, 'keep-110')],
    },
    createdAt: 1,
    updatedAt: 2,
  })
  const wallet = new FakeRegularSplitWallet()

  const split = await splitRegularProofsWithOperation({
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId: 'regular-op-completed',
    wallet,
    proofs: [],
    amountSubunits: 100,
    proofOperationStore: store,
  })

  assert.deepEqual(split.send, [proof('regular-keyset', 100, 'send-100')])
  assert.equal(wallet.prepareCalls, 0)
  assert.equal(wallet.completeCalls, 0)
})

test('splitRegularProofsWithOperation throws typed pending error and checks proof ids', async () => {
  const store = new MemoryProofOperationStore()
  store.records.set('regular-op-pending', {
    operationId: 'regular-op-pending',
    kind: 'regular-split',
    state: 'prepared',
    mintUrl: 'https://mint.example',
    inputs: [proof('regular-keyset', 210, 'input-210')],
    outputs: {},
    metadata: {
      baseAsset: 'sat',
      unit: 'msat',
      amount: 100,
    },
    createdAt: 1,
    updatedAt: 2,
  })
  const wallet = new FakeRegularSplitWallet()
  wallet.proofStates = [
    { Y: 'Y-input', state: CheckStateEnum.SPENT } as ProofState,
    { Y: 'Y-input', state: CheckStateEnum.UNSPENT } as ProofState,
  ]

  await assert.rejects(
    () =>
      splitRegularProofsWithOperation({
        mintUrl: 'https://mint.example',
        baseAsset: 'sat',
        operationId: 'regular-op-pending',
        wallet,
        proofs: [],
        amountSubunits: 100,
        proofOperationStore: store,
      }),
    ProofOperationPendingError,
  )
  assert.deepEqual(wallet.checkProofCalls, [[{ id: 'regular-keyset', secret: 'input-210' }]])
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

function deterministicSplitRequest(
  operationId: string,
  proofOperationStore: CtfProofOperationStore,
  transport: CtfSplitTransport,
  counterSource: CounterSource,
): Parameters<typeof splitCompleteSetWithOperation>[0] {
  return {
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId,
    transport,
    conditionId: CONDITION_ID,
    collateralProofs: [proof(DETERMINISTIC_KEYSET_A, 100, 'input-secret')],
    outcomeCollectionKeysets: { Beta: DETERMINISTIC_KEYSET_B, Alpha: DETERMINISTIC_KEYSET_A },
    amountSubunits: 100,
    proofOperationStore,
    outputMode: { kind: 'seed-derived', seed: DETERMINISTIC_SEED, counterSource },
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

function pendingInputState(): ProofState[] {
  return [{ Y: 'Y-input', state: CheckStateEnum.PENDING, witness: null }]
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
    return { YES: 'keyset-yes', NO: 'keyset-no' }
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

class FakeRegularSplitWallet {
  prepareCalls = 0
  completeCalls = 0
  proofStates: ProofState[] = []
  checkProofCalls: Array<Array<Pick<Proof, 'id' | 'secret'>>> = []
  private readonly script: {
    preview?: SwapPreview
    result?: { keep: Proof[]; send: Proof[] }
  }

  constructor(
    script: {
      preview?: SwapPreview
      result?: { keep: Proof[]; send: Proof[] }
    } = {},
  ) {
    this.script = script
  }

  async prepareSwapToSend(): Promise<SwapPreview> {
    this.prepareCalls += 1
    if (!this.script.preview) throw new Error('unexpected prepareSwapToSend')
    return this.script.preview
  }

  async completeSwap(): Promise<{ keep: Proof[]; send: Proof[] }> {
    this.completeCalls += 1
    if (!this.script.result) throw new Error('unexpected completeSwap')
    return this.script.result
  }

  async checkProofsStates(proofs: Array<Pick<Proof, 'id' | 'secret'>>): Promise<ProofState[]> {
    this.checkProofCalls.push(proofs)
    return this.proofStates.length > 0
      ? this.proofStates
      : [{ Y: 'Y-input', state: CheckStateEnum.UNSPENT }]
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

type SplitReplayRequest = Parameters<typeof splitCompleteSetWithOperation>[0]
type MergeReplayRequest = Parameters<typeof mergeCompleteSetToRegularWithOperation>[0]

function splitReplayRequest(
  operationId: string,
  proofOperationStore: CtfProofOperationStore,
  transport: CtfSplitTransport,
): SplitReplayRequest {
  return {
    mintUrl: 'https://mint.example',
    baseAsset: 'sat',
    operationId,
    transport,
    conditionId: CONDITION_ID,
    collateralProofs: [proof('input-keyset', 100, 'input-secret')],
    outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
    amountSubunits: 100,
    proofOperationStore,
  }
}

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

function completedSplitRecord(operationId: string): CtfProofOperationRecord {
  const resultProofs = {
    YES: [completedProof('keyset-yes', 100, 'stored-proof')],
    NO: [completedProof('keyset-no', 100, 'stored-proof-no')],
  }
  return {
    operationId,
    kind: 'ctf-split',
    state: 'completed',
    mintUrl: 'https://mint.example',
    inputs: [proof('input-keyset', 100, 'input-secret')],
    outputs: {
      YES: [storedOutput('stored-proof', 100, 'keyset-yes')],
      NO: [storedOutput('stored-proof-no', 100, 'keyset-no')],
    },
    metadata: {
      conditionId: CONDITION_ID,
      amountSubunits: 100,
      baseAsset: 'sat',
      unit: 'msat',
      parentCollectionId: '0'.repeat(64),
      outcomeCollectionKeysets: { YES: 'keyset-yes', NO: 'keyset-no' },
    },
    resultProofs,
    resultProofsDigest: completedProofAuthorityDigest(resultProofs),
    createdAt: 1,
    updatedAt: 2,
  }
}

function completedMergeRecord(operationId: string): CtfProofOperationRecord {
  const resultProofs = {
    regular: [completedProof('regular-keyset', 9, 'regular-stored')],
  }
  return {
    operationId,
    kind: 'ctf-merge',
    state: 'completed',
    mintUrl: 'https://mint.example',
    inputs: [proof('keyset-alpha', 10, 'alpha')],
    outputs: {
      '*': [storedOutput('regular-stored', 9, 'regular-keyset')],
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
const BLS_KEYSET_ID = '02ce4c47836fd0e64f37a08254777b7fd0dedb95fc1ddd0acadf5600674c743c5d'
const BLS_G1_POINT =
  'b7a4881059133fd91a8753600d9a5e524c65d6224f6fe2d5aef9e59f1507fdad90b3b4d48ee46da5c8dfaa0b88e28b69'

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
    id: 'regular-keyset',
    unit: 'msat',
    keys,
    input_fee_ppk: inputFeePpk,
  }
}
