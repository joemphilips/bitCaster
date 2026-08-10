import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Amount,
  CheckStateEnum,
  OutputData,
  hashToCurve,
  hashToCurveBls,
  isBlsKeyset,
  type Proof,
  type ProofState,
  type MintPreview,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  decodeDurableWalletOperation,
  deriveDurableWalletOperationAuthority,
  requireDurableWalletOperationFromCustody,
  runDurableWalletMintOperation,
  runDurableWalletReceiveOperation,
  hydrateDurableWalletMintPreview,
  serializeDurableWalletMintOperation,
  serializeDurableWalletReceiveOperation,
  toDurableCustodyProofOperationInput,
  type DurableWalletMintOperationSnapshot,
  type DurableWalletMintOperationStore,
  type DurableWalletReceiveOperationSnapshot,
  type DurableWalletReceiveOperationStore,
} from '../src/durableWalletOperation.ts'

test('wallet mint preview roundtrips exact request and private output authority', () => {
  const output = OutputData.createSingleData('2', 'keyset-1', 'mint-output', 3n)
  const preview: MintPreview<{ quote: string; expiry: number }> = {
    method: 'bolt11',
    payload: {
      quote: 'quote-1',
      outputs: [output.blindedMessage],
      signature: 'quote-signature',
    },
    outputData: [output],
    keysetId: 'keyset-1',
    quote: { quote: 'quote-1', expiry: 123 },
  }
  const operation = serializeDurableWalletMintOperation({
    operationId: 'wallet-mint-1',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview,
  })

  const hydrated = hydrateDurableWalletMintPreview(operation)

  assert.deepEqual(
    serializeDurableWalletMintOperation({
      operationId: operation.operationId,
      mintUrl: operation.mintUrl,
      unit: operation.unit,
      preview: hydrated,
    }),
    operation,
  )
  assert.equal(hydrated.outputData[0] instanceof OutputData, true)
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...operation,
        preview: {
          ...operation.preview,
          payload: {
            ...operation.preview.payload,
            outputs: [{ ...operation.preview.payload.outputs[0], B_: 'foreign' }],
          },
        },
      }),
    /conflicts/,
  )
})

test('wallet mint restart replays only the persisted preview', async () => {
  const operation = mintOperation('restart')
  const result = mintResult(operation)
  const harness = mintHarness({ operation, result })

  const settled = await runDurableWalletMintOperation({
    mode: 'recover',
    operationId: operation.operationId,
    store: harness.store,
    wallet: harness.wallet,
    restoreExactOutputs: harness.restoreExactOutputs,
  })

  assert.equal(settled.state, 'completed')
  assert.equal(harness.calls.completes, 1)
  assert.equal(harness.calls.restores, 0)
  assert.equal(harness.calls.persists, 1)
  assert.equal(
    new TextDecoder().decode(harness.completedPreview!.outputData[0]!.secret),
    operation.preview.outputData[0]!.secret,
  )
  assert.equal(
    harness.completedPreview!.payload.outputs[0]!.B_,
    operation.preview.payload.outputs[0]!.B_,
  )
})

test('wallet mint duplicate-output recovery restores only persisted outputs', async () => {
  const operation = mintOperation('restore')
  const result = mintResult(operation)
  const harness = mintHarness({
    operation,
    result,
    completeError: duplicateMintOutputError(),
    restore: result,
  })

  await runDurableWalletMintOperation({
    mode: 'recover',
    operationId: operation.operationId,
    store: harness.store,
    wallet: harness.wallet,
    restoreExactOutputs: harness.restoreExactOutputs,
  })

  assert.equal(harness.calls.completes, 1)
  assert.equal(harness.calls.restores, 1)
  assert.equal(harness.calls.persists, 1)
  assert.equal(harness.restoredOutputs![0]!.secret, operation.preview.outputData[0]!.secret)
})

function mintOperation(suffix: string) {
  const output = OutputData.createSingleData('2', 'keyset-1', `mint-output-${suffix}`, 3n)
  return serializeDurableWalletMintOperation({
    operationId: `wallet-mint-${suffix}`,
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview: {
      method: 'bolt11',
      payload: { quote: `quote-${suffix}`, outputs: [output.blindedMessage] },
      outputData: [output],
      keysetId: 'keyset-1',
      quote: { quote: `quote-${suffix}` },
    },
  })
}

function mintResult(operation: ReturnType<typeof mintOperation>): Proof[] {
  return operation.preview.outputData.map((output, index) => ({
    id: output.blindedMessage.id,
    amount: Amount.from(output.blindedMessage.amount),
    secret: output.secret,
    C: `mint-signature-${index}`,
  }))
}

function duplicateMintOutputError(): Error {
  return Object.assign(new Error('Blinded message already signed or pending'), {
    name: 'MintOperationError',
    status: 400,
  })
}

function mintHarness(input: {
  operation: ReturnType<typeof mintOperation>
  result: Proof[]
  completeError?: Error
  restore?: Proof[]
}) {
  const calls = { loads: 0, completes: 0, restores: 0, persists: 0 }
  let completedPreview: MintPreview<{ quote: string; expiry?: number | null }> | null = null
  let restoredOutputs: readonly { secret: string }[] | null = null
  const snapshot: DurableWalletMintOperationSnapshot = {
    operation: input.operation,
    state: 'prepared',
    result: null,
  }
  const store: DurableWalletMintOperationStore = {
    loadOperation: async () => {
      calls.loads += 1
      return snapshot
    },
    persistCompletedResult: async () => {
      calls.persists += 1
      return 'completed'
    },
  }
  return {
    calls,
    store,
    wallet: {
      completeMint: async (preview: MintPreview<{ quote: string; expiry?: number | null }>) => {
        calls.completes += 1
        completedPreview = preview
        if (input.completeError) throw input.completeError
        return input.result
      },
    },
    restoreExactOutputs: async ({ outputs }: { outputs: readonly { secret: string }[] }) => {
      calls.restores += 1
      restoredOutputs = outputs
      return input.restore ?? input.result
    },
    get completedPreview() {
      return completedPreview
    },
    get restoredOutputs() {
      return restoredOutputs
    },
  }
}

function walletSend() {
  return {
    schemaVersion: 1,
    operationId: 'wallet-send-1',
    kind: 'wallet-send',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview: {
      amount: '1',
      fees: '0',
      keysetId: 'keyset-1',
      inputs: [
        {
          id: 'keyset-1',
          amount: '1',
          secret: 'input-secret',
          C: 'input-signature',
          dleq: null,
          p2pkE: null,
          witness: null,
        },
      ],
      sendOutputs: [
        {
          blindedMessage: { amount: '1', id: 'keyset-1', B_: 'blinded-1' },
          blindingFactor: 'blinding-1',
          secret: 'output-secret',
          ephemeralE: null,
        },
      ],
      keepOutputs: [],
      unselectedProofs: [],
    },
  } as const
}

test('wallet operation decoder is strict and binds exact mint/unit authority', () => {
  const operation = decodeDurableWalletOperation(walletSend())
  assert.equal(operation.kind, 'wallet-send')
  assert.equal(operation.unit, 'sat')
  assert.throws(
    () => decodeDurableWalletOperation({ ...walletSend(), foreignAuthority: true }),
    /foreign fields/,
  )
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        mintUrl: 'https://mint.example/',
      }),
    /normalized/,
  )
  assert.throws(() => decodeDurableWalletOperation({ ...walletSend(), unit: '' }), /unit/)
})

test('wallet operation converts to and recovers from exact custody authority', () => {
  const custody = toDurableCustodyProofOperationInput(walletSend())
  const recovered = requireDurableWalletOperationFromCustody(custody)
  const authority = deriveDurableWalletOperationAuthority(recovered)
  assert.equal(custody.kind, 'wallet-send')
  assert.equal(custody.metadata?.unit, 'sat')
  assert.match(authority.requestFingerprint, /^[0-9a-f]{64}$/)
  assert.match(authority.outputPlanFingerprint, /^[0-9a-f]{64}$/)
  assert.throws(
    () =>
      requireDurableWalletOperationFromCustody({
        ...custody,
        mintUrl: 'https://foreign.example',
      }),
    /exact persisted operation/,
  )
})

test('wallet operation rejects mixed or foreign persisted variants', () => {
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        kind: 'foreign-operation',
      }),
    /kind/,
  )
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        preview: {
          ...walletSend().preview,
          foreignAuthority: 1,
        },
      }),
    /foreign fields/,
  )
})

test('wallet operation enforces the shared proof maximum exactly', () => {
  const proof = walletSend().preview.inputs[0]!
  const unselectedProofs = Array.from({ length: 512 }, (_, index) => ({
    ...proof,
    secret: `unselected-${index}`,
    C: `signature-${index}`,
  }))
  assert.equal(
    (
      decodeDurableWalletOperation({
        ...walletSend(),
        preview: { ...walletSend().preview, unselectedProofs },
      }) as { preview: { unselectedProofs: unknown[] } }
    ).preview.unselectedProofs.length,
    512,
  )
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        preview: {
          ...walletSend().preview,
          unselectedProofs: [...unselectedProofs, proof],
        },
      }),
    /unselected proofs are invalid/,
  )
})

test('wallet operation rejects URL aliases and foreign nested DLEQ fields', () => {
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        mintUrl: 'https://mint.example:443',
      }),
    /normalized/,
  )
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...walletSend(),
        preview: {
          ...walletSend().preview,
          inputs: [
            {
              ...walletSend().preview.inputs[0],
              dleq: { e: 'e', s: 's', r: null, foreign: true },
            },
          ],
        },
      }),
    /foreign fields/,
  )
})

test('wallet receive preview roundtrips exact Amount, proof, and OutputData authority', async () => {
  const preview = receivePreview(2)
  const operation = serializeDurableWalletReceiveOperation({
    operationId: 'wallet-receive-roundtrip',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview,
  })
  const harness = receiveHarness({ operation, swap: receiveResult(operation) })
  await runReceive(operation, harness, 'execute')
  const hydrated = harness.completedPreview!

  assert.ok(hydrated.amount instanceof Amount)
  assert.ok(hydrated.fees instanceof Amount)
  assert.equal(hydrated.amount.toString(), preview.amount.toString())
  assert.equal(hydrated.fees.toString(), preview.fees.toString())
  assert.deepEqual(reserializePreview(operation, hydrated), operation.preview)
  assert.equal(hydrated.keepOutputs?.[0] instanceof OutputData, true)
  assert.equal(hydrated.inputs[0]?.amount instanceof Amount, true)
})

test('wallet receive binds its exact deterministic derivation range', () => {
  const preview = receivePreview(2)
  const operation = serializeDurableWalletReceiveOperation({
    operationId: 'wallet-receive-range',
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview,
    derivationRange: { keysetId: preview.keysetId, counterStart: 7, counterCount: 1 },
  })

  assert.deepEqual(operation.derivationRange, {
    keysetId: preview.keysetId,
    counterStart: 7,
    counterCount: 1,
  })
  assert.throws(
    () =>
      decodeDurableWalletOperation({
        ...operation,
        derivationRange: { ...operation.derivationRange!, counterCount: 2 },
      }),
    /derivation range/,
  )
})

test('wallet receive rejects 129 proofs or outputs before durable or mint effects', async () => {
  const base = receivePreview(1)
  const proof = base.inputs[0]!
  const output = base.keepOutputs![0]!
  const effects = effectCounters()

  assert.throws(
    () =>
      serializeDurableWalletReceiveOperation({
        operationId: 'wallet-receive-129-inputs',
        mintUrl: 'https://mint.example',
        unit: 'sat',
        preview: {
          ...base,
          inputs: Array.from({ length: 129 }, (_, index) => ({
            ...proof,
            secret: `input-${index}`,
          })),
        },
      }),
    /128|limit/,
  )
  assert.throws(
    () =>
      serializeDurableWalletReceiveOperation({
        operationId: 'wallet-receive-129-outputs',
        mintUrl: 'https://mint.example',
        unit: 'sat',
        preview: {
          ...base,
          keepOutputs: Array.from({ length: 129 }, () => output),
        },
      }),
    /128|limit/,
  )
  assert.deepEqual(effects, effectCounters())
})

test('wallet receive accepts exactly 128 inputs and successor proofs', async () => {
  const operation = receiveOperation('128', 128, 128)
  const result = receiveResult(operation)
  const harness = receiveHarness({ operation, swap: result })

  const settled = await runReceive(operation, harness, 'execute')

  assert.equal(operation.preview.inputs.length, 128)
  assert.equal(settled.proofs.length, 128)
  assert.deepEqual(harness.calls, { loads: 1, persists: 1, checks: 0, swaps: 1, restores: 0 })
})

test('wallet receive rejects absent, wrong-kind, and foreign snapshots before effects', async () => {
  const operation = receiveOperation('snapshot')
  const foreign = receiveOperation('foreign-snapshot')
  const cases = [
    { name: 'absent', snapshot: null, error: /absent/ },
    {
      name: 'wrong kind',
      snapshot: { operation: walletSend(), state: 'prepared', result: null },
      error: /not a receive/,
    },
    {
      name: 'foreign id',
      snapshot: { operation: foreign, state: 'prepared', result: null },
      error: /identity is foreign/,
    },
  ] as const
  for (const item of cases) {
    const harness = receiveHarness({
      operation,
      loadedSnapshot: item.snapshot as DurableWalletReceiveOperationSnapshot | null,
    })
    await assert.rejects(runReceive(operation, harness, 'recover'), item.error, item.name)
    assert.deepEqual(harness.calls, {
      loads: 1,
      persists: 0,
      checks: 0,
      swaps: 0,
      restores: 0,
    })
  }
})

test('wallet receive validates exact NUT-07 Y authority for secp and BLS keysets', async () => {
  const operation = receiveOperation('proof-state', 2)
  const exact = [
    inputState(operation, 0, CheckStateEnum.PENDING),
    inputState(operation, 1, CheckStateEnum.PENDING),
  ]
  const cases = [
    { name: 'missing', states: exact.slice(0, 1), error: /incomplete/ },
    { name: 'duplicate', states: [exact[0]!, exact[0]!], error: /foreign/ },
    { name: 'foreign', states: [exact[0]!, { ...exact[1]!, Y: 'foreign' }], error: /foreign/ },
  ]
  for (const item of cases) {
    const harness = receiveHarness({ operation, states: item.states })
    await assert.rejects(runReceive(operation, harness, 'recover'), item.error, item.name)
    assert.equal(harness.calls.persists, 0)
    assert.equal(harness.calls.swaps, 0)
    assert.equal(harness.calls.restores, 0)
  }

  const bls = receiveOperation('bls-proof-state', 1, 1, `02${'11'.repeat(32)}`)
  const harness = receiveHarness({
    operation: bls,
    states: [inputState(bls, 0, CheckStateEnum.PENDING)],
  })
  const pending = await runReceive(bls, harness, 'recover')
  assert.equal(pending.state, 'nonterminal')
})

test('wallet receive rejects invalid mint results before persistence', async () => {
  const single = receiveOperation('invalid-result')
  const [proof] = receiveResult(single)
  const pair = receiveOperation('duplicate-result', 2, 2)
  const [first] = receiveResult(pair)
  const cases: Array<{
    name: string
    operation: ReturnType<typeof receiveOperation>
    keep: Proof[]
    send?: Proof[]
    error: RegExp
  }> = [
    {
      name: 'foreign send',
      operation: single,
      keep: [proof!],
      send: [proof!],
      error: /send group/,
    },
    { name: 'empty', operation: single, keep: [], error: /exact output plan/ },
    { name: 'duplicate', operation: pair, keep: [first!, first!], error: /duplicate/ },
    { name: 'wrong id', operation: single, keep: [{ ...proof!, id: 'foreign' }], error: /exact/ },
    {
      name: 'wrong amount',
      operation: single,
      keep: [{ ...proof!, amount: Amount.from(3) }],
      error: /exact/,
    },
    {
      name: '129 proofs',
      operation: single,
      keep: Array.from({ length: 129 }, (_, index) => ({ ...proof!, secret: `foreign-${index}` })),
      error: /limit/,
    },
  ]
  for (const item of cases) {
    const harness = receiveHarness({
      operation: item.operation,
      swap: item.keep,
      ...(item.send === undefined ? {} : { send: item.send }),
    })
    await assert.rejects(runReceive(item.operation, harness, 'execute'), item.error, item.name)
    assert.equal(harness.calls.persists, 0)
  }
})

test('wallet receive rejects malformed terminal snapshots without wallet or mint I/O', async () => {
  const operation = receiveOperation('malformed-terminal')
  const result = { receive: receiveResult(operation) }
  const cases = [
    { operation, state: 'prepared', result },
    { operation, state: 'completed', result: null },
    { operation, state: 'external-applied', result: null },
    { operation, state: 'completed', result: { receive: [] } },
  ] as const
  for (const snapshot of cases) {
    const harness = receiveHarness({
      operation,
      loadedSnapshot: snapshot as DurableWalletReceiveOperationSnapshot,
    })
    await assert.rejects(runReceive(operation, harness, 'recover'))
    assert.deepEqual(harness.calls, {
      loads: 1,
      persists: 0,
      checks: 0,
      swaps: 0,
      restores: 0,
    })
  }
})

test('wallet receive roundtrips each supported Cashu proof witness', async () => {
  const witnesses: NonNullable<Proof['witness']>[] = [
    'serialized-witness',
    {},
    { signatures: [] },
    { signatures: ['signature'] },
    { preimage: 'preimage' },
    { preimage: 'preimage', signatures: ['signature'] },
  ]
  for (const [index, witness] of witnesses.entries()) {
    const preview = receivePreview(1)
    preview.inputs[0]!.witness = witness
    const operation = serializeDurableWalletReceiveOperation({
      operationId: `wallet-receive-witness-${index}`,
      mintUrl: 'https://mint.example',
      unit: 'sat',
      preview,
    })
    const harness = receiveHarness({ operation, swap: receiveResult(operation) })
    await runReceive(operation, harness, 'execute')
    assert.deepEqual(harness.completedPreview!.inputs[0]!.witness, witness)
  }
})

test('wallet receive rejects malformed persisted proof witnesses', () => {
  const malformed: unknown[] = [
    [],
    true,
    1,
    { foreign: true },
    { signatures: 'signature' },
    { signatures: [1] },
    { preimage: '' },
    { preimage: 'preimage', foreign: true },
  ]
  for (const witness of malformed) {
    const operation = structuredClone(receiveOperation('malformed-witness'))
    ;(operation.preview.inputs[0] as { witness: unknown }).witness = witness
    assert.throws(() => decodeDurableWalletOperation(operation), /witness|foreign/)
  }
})

for (const state of ['completed', 'external-applied'] as const) {
  test(`wallet receive ${state} replay returns persisted result without wallet or mint I/O`, async () => {
    const operation = receiveOperation(`terminal-${state}`)
    const result = receiveResult(operation)
    const harness = receiveHarness({ operation, state, result: { receive: result } })

    const settled = await runDurableWalletReceiveOperation({
      mode: 'recover',
      operationId: operation.operationId,
      store: harness.store,
      wallet: harness.wallet,
      restoreExactOutputs: harness.restoreExactOutputs,
    })

    assert.equal(settled.state, state)
    assert.equal(settled.proofs[0]?.secret, result[0]?.secret)
    assert.deepEqual(harness.calls, { loads: 1, persists: 0, checks: 0, swaps: 0, restores: 0 })
  })
}

test('wallet receive recovery restores only exact persisted outputs when every input is spent', async () => {
  const operation = receiveOperation('spent')
  const result = receiveResult(operation)
  const harness = receiveHarness({ operation, inputState: CheckStateEnum.SPENT, restore: result })

  const settled = await runDurableWalletReceiveOperation({
    mode: 'recover',
    operationId: operation.operationId,
    store: harness.store,
    wallet: harness.wallet,
    restoreExactOutputs: harness.restoreExactOutputs,
  })

  assert.equal(settled.state, 'completed')
  assert.deepEqual(harness.calls, { loads: 1, persists: 1, checks: 1, swaps: 0, restores: 1 })
  assert.equal(harness.restoredPreview?.[0]?.secret, operation.preview.keepOutputs[0]?.secret)
})

test('wallet receive recovery submits the exact persisted preview when every input is unspent', async () => {
  const operation = receiveOperation('unspent')
  const result = receiveResult(operation)
  const harness = receiveHarness({ operation, inputState: CheckStateEnum.UNSPENT, swap: result })

  await runDurableWalletReceiveOperation({
    mode: 'recover',
    operationId: operation.operationId,
    store: harness.store,
    wallet: harness.wallet,
    restoreExactOutputs: harness.restoreExactOutputs,
  })

  assert.deepEqual(harness.calls, { loads: 1, persists: 1, checks: 1, swaps: 1, restores: 0 })
  assert.deepEqual(reserializePreview(operation, harness.completedPreview!), operation.preview)
})

test('wallet receive prepared execution skips NUT-07 and submits only the persisted preview', async () => {
  const operation = receiveOperation('execute')
  const result = receiveResult(operation)
  const harness = receiveHarness({ operation, swap: result })

  await runDurableWalletReceiveOperation({
    mode: 'execute',
    operationId: operation.operationId,
    store: harness.store,
    wallet: harness.wallet,
    restoreExactOutputs: harness.restoreExactOutputs,
  })

  assert.deepEqual(harness.calls, { loads: 1, persists: 1, checks: 0, swaps: 1, restores: 0 })
})

test('wallet receive mixed, pending, and unknown states remain nonterminal', async () => {
  for (const [suffix, values] of [
    ['mixed', [CheckStateEnum.SPENT, CheckStateEnum.UNSPENT]],
    ['pending', [CheckStateEnum.PENDING, CheckStateEnum.PENDING]],
    ['unknown', ['UNKNOWN', CheckStateEnum.UNSPENT]],
  ] as const) {
    const operation = receiveOperation(suffix, 2)
    const harness = receiveHarness({
      operation,
      states: values.map((state, index) => inputState(operation, index, state)),
    })
    const pending = await runDurableWalletReceiveOperation({
      mode: 'recover',
      operationId: operation.operationId,
      store: harness.store,
      wallet: harness.wallet,
      restoreExactOutputs: harness.restoreExactOutputs,
    })
    assert.equal(pending.state, 'nonterminal')
    assert.equal(harness.calls.persists, 0)
  }
})

test('wallet receive rejects foreign restore groups before result persistence', async () => {
  const operation = receiveOperation('foreign-result')
  const result = receiveResult(operation)
  const harness = receiveHarness({ operation, inputState: CheckStateEnum.SPENT })

  await assert.rejects(
    runDurableWalletReceiveOperation({
      mode: 'recover',
      operationId: operation.operationId,
      store: harness.store,
      wallet: harness.wallet,
      restoreExactOutputs: async () => ({ foreign: result }),
    }),
    /result group/,
  )
  assert.equal(harness.calls.persists, 0)
})

test('wallet receive rejects a substituted restored proof before result persistence', async () => {
  const operation = receiveOperation('substituted-result')
  const [proof] = receiveResult(operation)
  const harness = receiveHarness({
    operation,
    inputState: CheckStateEnum.SPENT,
    restore: [{ ...proof!, secret: 'foreign-secret' }],
  })

  await assert.rejects(
    runDurableWalletReceiveOperation({
      mode: 'recover',
      operationId: operation.operationId,
      store: harness.store,
      wallet: harness.wallet,
      restoreExactOutputs: harness.restoreExactOutputs,
    }),
    /exact output plan/,
  )
  assert.equal(harness.calls.persists, 0)
})

test('wallet receive rejects a conflicting current preview before wallet or mint effects', async () => {
  const operation = receiveOperation('conflict')
  const harness = receiveHarness({ operation })
  const conflicting = receivePreview(1)
  conflicting.amount = Amount.from(3)

  await assert.rejects(
    runDurableWalletReceiveOperation({
      mode: 'recover',
      operationId: operation.operationId,
      currentPreview: conflicting,
      store: harness.store,
      wallet: harness.wallet,
      restoreExactOutputs: harness.restoreExactOutputs,
    }),
    /conflicts with persisted authority/,
  )
  assert.deepEqual(harness.calls, { loads: 1, persists: 0, checks: 0, swaps: 0, restores: 0 })
})

function receivePreview(inputCount: number, outputCount = 1, keysetId = 'keyset-1'): SwapPreview {
  const outputAmount = inputCount === outputCount ? 1 : inputCount
  const outputs = Array.from({ length: outputCount }, (_, index) =>
    OutputData.createSingleData(
      String(outputAmount),
      keysetId,
      `receive-output-${index}`,
      BigInt(index + 3),
    ),
  )
  return {
    amount: Amount.from(inputCount),
    fees: Amount.zero(),
    keysetId,
    inputs: Array.from({ length: inputCount }, (_, index) => ({
      id: keysetId,
      amount: Amount.from(1),
      secret: `receive-input-${index}`,
      C: `input-signature-${index}`,
      ...(index === 0 ? { witness: { signatures: ['signature'] } } : {}),
    })),
    keepOutputs: outputs,
  }
}

function receiveOperation(suffix: string, inputCount = 1, outputCount = 1, keysetId = 'keyset-1') {
  return serializeDurableWalletReceiveOperation({
    operationId: `wallet-receive-${suffix}`,
    mintUrl: 'https://mint.example',
    unit: 'sat',
    preview: receivePreview(inputCount, outputCount, keysetId),
  })
}

function reserializePreview(operation: ReturnType<typeof receiveOperation>, preview: SwapPreview) {
  return serializeDurableWalletReceiveOperation({
    operationId: operation.operationId,
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    preview,
  }).preview
}

function receiveResult(operation: ReturnType<typeof receiveOperation>): Proof[] {
  return operation.preview.keepOutputs.map((output, index) => ({
    id: output.blindedMessage.id,
    amount: Amount.from(output.blindedMessage.amount),
    secret: output.secret,
    C: `result-signature-${index}`,
  }))
}

function inputState(
  operation: ReturnType<typeof receiveOperation>,
  index: number,
  state: ProofState['state'] | string,
): ProofState {
  const proof = operation.preview.inputs[index]!
  const secret = new TextEncoder().encode(proof.secret)
  return {
    Y: isBlsKeyset(proof.id) ? hashToCurveBls(secret).toHex(true) : hashToCurve(secret).toHex(true),
    state,
    witness: null,
  } as ProofState
}

function effectCounters() {
  return { loads: 0, persists: 0, checks: 0, swaps: 0, restores: 0 }
}

function receiveHarness(input: {
  operation: ReturnType<typeof receiveOperation>
  loadedSnapshot?: DurableWalletReceiveOperationSnapshot | null
  state?: DurableWalletReceiveOperationSnapshot['state']
  result?: DurableWalletReceiveOperationSnapshot['result']
  inputState?: ProofState['state']
  states?: ProofState[]
  swap?: Proof[]
  send?: Proof[]
  restore?: Proof[]
}) {
  const calls = effectCounters()
  let snapshot: DurableWalletReceiveOperationSnapshot = {
    operation: input.operation,
    state: input.state ?? 'prepared',
    result: input.result ?? null,
  }
  let completedPreview: SwapPreview | null = null
  let restoredPreview: readonly { secret: string }[] | null = null
  const store: DurableWalletReceiveOperationStore = {
    loadOperation: async () => {
      calls.loads += 1
      return input.loadedSnapshot === undefined ? snapshot : input.loadedSnapshot
    },
    persistCompletedResult: async ({ result }) => {
      calls.persists += 1
      snapshot = { ...snapshot, state: 'completed', result }
      return 'completed'
    },
  }
  return {
    calls,
    store,
    wallet: {
      checkProofsStates: async () => {
        calls.checks += 1
        return (
          input.states ??
          input.operation.preview.inputs.map((_, index) =>
            inputState(input.operation, index, input.inputState ?? CheckStateEnum.PENDING),
          )
        )
      },
      completeSwap: async (preview: SwapPreview) => {
        calls.swaps += 1
        completedPreview = preview
        return { keep: input.swap ?? [], send: input.send ?? [] }
      },
    },
    restoreExactOutputs: async (request: { outputs: readonly { secret: string }[] }) => {
      calls.restores += 1
      restoredPreview = request.outputs
      return { receive: input.restore ?? [] }
    },
    get completedPreview() {
      return completedPreview
    },
    get restoredPreview() {
      return restoredPreview
    },
  }
}

function runReceive(
  operation: ReturnType<typeof receiveOperation>,
  harness: ReturnType<typeof receiveHarness>,
  mode: 'execute' | 'recover',
) {
  return runDurableWalletReceiveOperation({
    mode,
    operationId: operation.operationId,
    store: harness.store,
    wallet: harness.wallet,
    restoreExactOutputs: harness.restoreExactOutputs,
  })
}
