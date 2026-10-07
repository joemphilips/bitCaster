import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Amount,
  OutputData,
  type OperationCounters,
  type Proof,
  type SwapPreview,
} from '@cashu/cashu-ts'
import {
  prepareDeterministicOutgoingCashuSend,
  type DeterministicOutgoingCashuWallet,
} from '../src/deterministicOutgoingCashuPreparation.ts'

const KEYSET_ID = `01${'a'.repeat(64)}`
const SEED = new Uint8Array(64).fill(7)
const INPUT_PROOF = {
  id: KEYSET_ID,
  amount: Amount.from(4),
  secret: 'input-proof-secret',
  C: 'input-proof-signature',
} as Proof

test('prepares one deterministic V2 send and returns exact keep-output locators', async () => {
  const counters: OperationCounters = {
    keysetId: KEYSET_ID,
    start: 17,
    count: 3,
    next: 20,
  }
  const preview = createPreview(counters.start)
  const wallet = walletFor(preview, counters)
  const result = await prepareDeterministicOutgoingCashuSend({
    amount: 2,
    proofs: [INPUT_PROOF],
    seed: SEED,
    wallet,
    diagnosticLabel: 'test send',
  })

  assert.equal(result.preview.keysetId, KEYSET_ID)
  assert.equal(result.preview.sendOutputs?.length, 1)
  assert.deepEqual(result.counters, counters)
  assert.deepEqual(result.keepProofDerivationLocators, [
    { schemaVersion: 1, kind: 'nut13', keysetId: KEYSET_ID, counter: 18 },
    { schemaVersion: 1, kind: 'nut13', keysetId: KEYSET_ID, counter: 19 },
  ])
})

test('requests the canonical keyset, fee-free preparation, and deterministic outputs', async () => {
  const counters: OperationCounters = {
    keysetId: KEYSET_ID,
    start: 21,
    count: 3,
    next: 24,
  }
  const preview = createPreview(counters.start)
  let prepareCalls = 0
  const wallet: DeterministicOutgoingCashuWallet = {
    getKeyset: (keysetId) => {
      assert.equal(keysetId, undefined)
      return { id: KEYSET_ID }
    },
    prepareSwapToSend: async (amount, proofs, config, outputConfig) => {
      prepareCalls += 1
      assert.equal(amount, 2)
      assert.equal(proofs.length, 1)
      assert.equal(config.includeFees, false)
      assert.equal(config.keysetId, KEYSET_ID)
      assert.deepEqual(outputConfig, {
        send: { type: 'deterministic', counter: 0 },
        keep: { type: 'deterministic', counter: 0 },
      })
      config.onCountersReserved(counters)
      return preview
    },
  }

  await prepareDeterministicOutgoingCashuSend({
    amount: 2,
    proofs: [INPUT_PROOF],
    seed: SEED,
    wallet,
    diagnosticLabel: 'test send',
  })

  assert.equal(prepareCalls, 1)
})

test('rejects a missing or duplicate counter reservation', async () => {
  const counters: OperationCounters = {
    keysetId: KEYSET_ID,
    start: 31,
    count: 3,
    next: 34,
  }
  const preview = createPreview(counters.start)
  const missing = walletFor(preview, counters, () => undefined)
  const duplicate = walletFor(preview, counters, (reserve) => {
    reserve()
    reserve()
  })

  await assert.rejects(
    prepareDeterministicOutgoingCashuSend({
      amount: 2,
      proofs: [INPUT_PROOF],
      seed: SEED,
      wallet: missing,
      diagnosticLabel: 'test send',
    }),
    /counter reservation is missing/,
  )
  await assert.rejects(
    prepareDeterministicOutgoingCashuSend({
      amount: 2,
      proofs: [INPUT_PROOF],
      seed: SEED,
      wallet: duplicate,
      diagnosticLabel: 'test send',
    }),
    /counters were reserved twice/,
  )
})

test('rejects counter ranges that do not match the exact output plan or seed lineage', async () => {
  const counters: OperationCounters = {
    keysetId: KEYSET_ID,
    start: 41,
    count: 3,
    next: 44,
  }
  const preview = createPreview(counters.start)
  const wrongOutputCount = walletFor({ ...preview, keepOutputs: [] }, counters)
  const wrongSeedLineage = walletFor(
    createPreview(counters.start, new Uint8Array(64).fill(8)),
    counters,
  )

  await assert.rejects(
    prepareDeterministicOutgoingCashuSend({
      amount: 2,
      proofs: [INPUT_PROOF],
      seed: SEED,
      wallet: wrongOutputCount,
      diagnosticLabel: 'test send',
    }),
    /conflicts with the output plan/,
  )
  await assert.rejects(
    prepareDeterministicOutgoingCashuSend({
      amount: 2,
      proofs: [INPUT_PROOF],
      seed: SEED,
      wallet: wrongSeedLineage,
      diagnosticLabel: 'test send',
    }),
    /does not match the exact deterministic counter range/,
  )
})

test('rejects invalid amounts and non-V2 keysets before preparing outputs', async () => {
  const counters: OperationCounters = {
    keysetId: KEYSET_ID,
    start: 51,
    count: 3,
    next: 54,
  }
  let prepareCalls = 0
  const wallet = walletFor(createPreview(counters.start), counters, () => {
    prepareCalls += 1
  })

  for (const amount of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(
      prepareDeterministicOutgoingCashuSend({
        amount,
        proofs: [INPUT_PROOF],
        seed: SEED,
        wallet,
        diagnosticLabel: 'test send',
      }),
      /amount is invalid/,
    )
  }

  const v3Wallet = walletFor(
    createPreview(counters.start),
    counters,
    () => undefined,
    `02${'b'.repeat(64)}`,
  )
  await assert.rejects(
    prepareDeterministicOutgoingCashuSend({
      amount: 2,
      proofs: [INPUT_PROOF],
      seed: SEED,
      wallet: v3Wallet,
      diagnosticLabel: 'test send',
    }),
    /canonical V2 keyset/,
  )
  assert.equal(prepareCalls, 0)
})

function walletFor(
  preview: SwapPreview,
  counters: OperationCounters,
  onPrepare: (reserve: () => void) => void = (reserve) => reserve(),
  keysetId = KEYSET_ID,
): DeterministicOutgoingCashuWallet {
  return {
    getKeyset: () => ({ id: keysetId }),
    prepareSwapToSend: async (_amount, _proofs, config) => {
      onPrepare(() => config.onCountersReserved(counters))
      return preview
    },
  }
}

function createPreview(counterStart: number, seed = SEED): SwapPreview {
  return {
    amount: Amount.from(2),
    fees: Amount.from(0),
    keysetId: KEYSET_ID,
    inputs: [INPUT_PROOF],
    sendOutputs: [OutputData.createSingleDeterministicData(2, seed, counterStart, KEYSET_ID)],
    keepOutputs: [
      OutputData.createSingleDeterministicData(1, seed, counterStart + 1, KEYSET_ID),
      OutputData.createSingleDeterministicData(1, seed, counterStart + 2, KEYSET_ID),
    ],
    unselectedProofs: [],
  }
}
