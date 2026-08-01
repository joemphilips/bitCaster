import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CheckStateEnum, type MintKeys, type Proof, type ProofState } from '@cashu/cashu-ts'
import {
  buildKeysetRedeemOperationId,
  getActiveRegularKeyset,
  isLosingLegError,
  ORACLE_NOT_ATTESTED_OUTCOME_CODE,
  readAuthenticatedCtfRedeemTerminalEvidence,
  redeemOutcomeLegWithOperation,
  type AuthenticatedCtfRedeemTerminalEvidence,
  type RedeemWallet,
} from '../src/ctfRedeem.ts'
import type {
  CtfPrepareProofOperationInput,
  CtfProofOperationCompletion,
  CtfProofOperationRecord,
  CtfProofOperationStore,
} from '../src/ctfSplit.ts'
import { DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX } from '../src/durableCustody.ts'

test('isLosingLegError recognizes the mint oracle-not-attested error code', () => {
  assert.equal(isLosingLegError({ code: ORACLE_NOT_ATTESTED_OUTCOME_CODE }), true)
  assert.equal(isLosingLegError({ code: 13014 }), false)
  assert.equal(isLosingLegError(new Error('oracle not attested outcome')), false)
  assert.equal(isLosingLegError(null), false)
})

test('buildKeysetRedeemOperationId is stable across proof ordering', () => {
  const left = buildKeysetRedeemOperationId({
    mintUrl: 'https://mint.example',
    unit: 'msat',
    conditionId: 'ABCDEF',
    keysetId: 'keyset',
    proofs: ['b', 'a'],
  })
  const right = buildKeysetRedeemOperationId({
    mintUrl: 'https://mint.example/',
    unit: 'msat',
    conditionId: 'abcdef',
    keysetId: 'keyset',
    proofs: ['a', 'b'],
  })
  assert.match(left, /^ctf-redeem:[0-9a-f]{64}$/)
  assert.equal(left, right)
})

test('buildKeysetRedeemOperationId is unambiguous and never contains proof secrets', () => {
  const left = buildKeysetRedeemOperationId({
    mintUrl: 'https://mint.example',
    unit: 'msat',
    conditionId: 'condition',
    keysetId: 'keyset',
    proofs: ['secret-one|secret-two', 'secret-three'],
  })
  const right = buildKeysetRedeemOperationId({
    mintUrl: 'https://mint.example',
    unit: 'msat',
    conditionId: 'condition',
    keysetId: 'keyset',
    proofs: ['secret-one', 'secret-two|secret-three'],
  })
  assert.notEqual(left, right)
  assert.doesNotMatch(left, /secret-/)
})

test('redeemOutcomeLegWithOperation prepares, redeems, and marks completed', async () => {
  const store = new MemoryProofOperationStore()
  const inputProofs = [proof('ctf-keyset', 'input-a', 7)]
  const settledProofs = [proof('regular-keyset', 'regular-a', 7)]
  const wallet = new FakeRedeemWallet({ settledProofs })

  const result = await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:success',
    wallet,
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'YES',
    unit: 'sat',
    oracleWitness: '{"attested":true}',
    proofs: inputProofs,
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => {
      throw new Error('restore should not be called')
    },
  })

  assert.deepEqual(result, { proofs: settledProofs, losing: false })
  assert.equal(wallet.loadMintCalls, 1)
  assert.equal(wallet.redeemCalls.length, 1)
  assert.deepEqual(
    wallet.redeemCalls[0]?.inputs.map((input) => input.witness),
    ['{"attested":true}'],
  )
  const entry = await store.getProofOperation('redeem:success')
  assert.equal(entry?.kind, 'ctf-redeem')
  assert.equal(entry?.state, 'completed')
  assert.equal(entry?.metadata.oracleWitness, '{"attested":true}')
  assert.deepEqual(entry?.resultProofs?.regular, settledProofs)
})

test('redeemOutcomeLegWithOperation terminally records losing legs', async () => {
  const store = new MemoryProofOperationStore()
  const wallet = new FakeRedeemWallet({ error: { code: ORACLE_NOT_ATTESTED_OUTCOME_CODE } })

  const result = await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:losing',
    wallet,
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'NO',
    unit: 'sat',
    oracleWitness: 'witness',
    proofs: [proof('ctf-keyset', 'loser', 3)],
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({}),
  })

  assert.deepEqual(result, { proofs: [], losing: true })
  const entry = await store.getProofOperation('redeem:losing')
  assert.equal(entry?.state, 'Failed')
  assert.equal(entry?.failureCode, ORACLE_NOT_ATTESTED_OUTCOME_CODE)
  assert.deepEqual(
    readAuthenticatedCtfRedeemTerminalEvidence(store.terminalEvidence.get('redeem:losing')!),
    {
      transportProvenance: 'authenticated-mint-transport',
      operationId: 'redeem:losing',
      normalizedMint: 'https://mint.example',
      rejectionBody: { code: ORACLE_NOT_ATTESTED_OUTCOME_CODE },
    },
  )

  const retryWallet = new FakeRedeemWallet()
  const retry = await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:losing',
    wallet: retryWallet,
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'NO',
    unit: 'sat',
    oracleWitness: 'witness',
    proofs: [proof('ctf-keyset', 'loser', 3)],
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({}),
  })
  assert.deepEqual(retry, { proofs: [], losing: true })
  assert.equal(retryWallet.loadMintCalls, 0)
  assert.equal(retryWallet.checkProofStateCalls, 0)
  assert.equal(retryWallet.redeemCalls.length, 0)
})

test('redeemOutcomeLegWithOperation returns a completed exact retry before mint I/O', async () => {
  const store = new MemoryProofOperationStore()
  const inputs = [proof('ctf-keyset', 'completed-input', 2)]
  const settled = [proof('regular-keyset', 'completed-output', 2)]
  await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:completed-retry',
    wallet: new FakeRedeemWallet({ settledProofs: settled }),
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'YES',
    unit: 'sat',
    oracleWitness: 'persisted-witness',
    proofs: inputs,
    regularKeyset: regularKeyset(),
  })

  const retryWallet = new FakeRedeemWallet()
  const result = await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:completed-retry',
    wallet: retryWallet,
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'YES',
    unit: 'sat',
    oracleWitness: 'persisted-witness',
    proofs: inputs,
    regularKeyset: regularKeyset(),
  })

  assert.deepEqual(result, { proofs: settled, losing: false })
  assert.equal(retryWallet.loadMintCalls, 0)
  assert.equal(retryWallet.checkProofStateCalls, 0)
  assert.equal(retryWallet.redeemCalls.length, 0)
})

test('redeemOutcomeLegWithOperation rejects malformed completion before mint I/O', async () => {
  const store = new MemoryProofOperationStore()
  const inputs = [proof('ctf-keyset', 'malformed-completion-input', 2)]
  await store.prepareProofOperation({
    operationId: 'redeem:malformed-completion',
    kind: 'ctf-redeem',
    mintUrl: 'https://mint.example',
    inputs,
    outputs: {},
    metadata: {
      conditionId: 'condition',
      outcome: 'YES',
      outcomeKeysetId: 'ctf-keyset',
      regularKeysetId: 'regular-keyset',
      unit: 'sat',
      amountSubunits: 2,
      oracleWitness: 'persisted-witness',
    },
  })
  store.records.set('redeem:malformed-completion', {
    ...(await store.getProofOperation('redeem:malformed-completion'))!,
    state: 'completed',
  })
  const wallet = new FakeRedeemWallet()

  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: 'https://mint.example',
        operationId: 'redeem:malformed-completion',
        wallet,
        proofOperationStore: store,
        conditionId: 'condition',
        outcome: 'YES',
        unit: 'sat',
        oracleWitness: 'persisted-witness',
        proofs: inputs,
        regularKeyset: regularKeyset(),
      }),
    /invalid regular proofs/,
  )
  assert.equal(wallet.loadMintCalls, 0)
  assert.equal(wallet.checkProofStateCalls, 0)
  assert.equal(wallet.redeemCalls.length, 0)
})

test('redeemOutcomeLegWithOperation restores outputs when prepared inputs are spent', async () => {
  const store = new MemoryProofOperationStore()
  const inputs = [proof('ctf-keyset', 'spent-input', 5)]
  const restored = [proof('regular-keyset', 'restored', 5)]
  const wallet = new FakeRedeemWallet({ states: [state(CheckStateEnum.SPENT)] })

  await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:restore',
    wallet: new FakeRedeemWallet({ error: new Error('crash after mint') }),
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'YES',
    unit: 'sat',
    oracleWitness: 'witness',
    proofs: inputs,
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({}),
  }).catch(() => undefined)
  assert.equal(store.terminalEvidence.has('redeem:restore'), false)
  assert.equal((await store.getProofOperation('redeem:restore'))?.state, 'prepared')

  const result = await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:restore',
    wallet,
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'YES',
    unit: 'sat',
    oracleWitness: 'witness',
    proofs: inputs,
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({ regular: restored }),
  })

  assert.deepEqual(result, { proofs: restored, losing: false })
  assert.equal(wallet.redeemCalls.length, 0)
  assert.equal((await store.getProofOperation('redeem:restore'))?.state, 'completed')
})

test('redeemOutcomeLegWithOperation re-executes prepared operations when inputs remain unspent', async () => {
  const store = new MemoryProofOperationStore()
  const inputs = [proof('ctf-keyset', 'unspent-input', 5)]

  await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:retry',
    wallet: new FakeRedeemWallet({ error: new Error('transient') }),
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'YES',
    unit: 'sat',
    oracleWitness: 'witness',
    proofs: inputs,
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({}),
  }).catch(() => undefined)

  const settledProofs = [proof('regular-keyset', 'retried', 5)]
  const wallet = new FakeRedeemWallet({
    states: [state(CheckStateEnum.UNSPENT)],
    settledProofs,
  })
  const result = await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:retry',
    wallet,
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'YES',
    unit: 'sat',
    oracleWitness: 'witness',
    proofs: inputs,
    regularKeyset: regularKeyset(),
    restoreOutputGroups: async () => ({}),
  })

  assert.deepEqual(result, { proofs: settledProofs, losing: false })
  assert.equal(wallet.redeemCalls.length, 1)
  assert.deepEqual(
    wallet.redeemCalls[0]?.inputs.map(({ witness }) => witness),
    ['witness'],
  )
})

test('redeemOutcomeLegWithOperation rejects witness substitution before mint I/O', async () => {
  const store = new MemoryProofOperationStore()
  const inputs = [proof('ctf-keyset', 'witness-bound-input', 5)]
  await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:witness-bound',
    wallet: new FakeRedeemWallet({ error: new Error('transient') }),
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'YES',
    unit: 'sat',
    oracleWitness: 'persisted-witness',
    proofs: inputs,
    regularKeyset: regularKeyset(),
  }).catch(() => undefined)

  const retryWallet = new FakeRedeemWallet({
    states: [state(CheckStateEnum.UNSPENT)],
    settledProofs: [proof('regular-keyset', 'must-not-settle', 5)],
  })
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: 'https://mint.example',
        operationId: 'redeem:witness-bound',
        wallet: retryWallet,
        proofOperationStore: store,
        conditionId: 'condition',
        outcome: 'YES',
        unit: 'sat',
        oracleWitness: 'substituted-witness',
        proofs: inputs,
        regularKeyset: regularKeyset(),
      }),
    /does not match the current request/,
  )
  assert.equal(retryWallet.loadMintCalls, 0)
  assert.equal(retryWallet.checkProofStateCalls, 0)
  assert.equal(retryWallet.redeemCalls.length, 0)
})

test('redeemOutcomeLegWithOperation rejects an oversized witness before persistence or mint I/O', async () => {
  const store = new MemoryProofOperationStore()
  const wallet = new FakeRedeemWallet()

  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: 'https://mint.example',
        operationId: 'redeem:oversized-witness',
        wallet,
        proofOperationStore: store,
        conditionId: 'condition',
        outcome: 'YES',
        unit: 'sat',
        oracleWitness: 'w'.repeat(DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX + 1),
        proofs: [proof('ctf-keyset', 'oversized-witness-input', 1)],
        regularKeyset: regularKeyset(),
      }),
    /record byte limit exceeded/,
  )
  assert.equal(store.prepareCalls, 0)
  assert.equal(wallet.loadMintCalls, 0)
  assert.equal(wallet.redeemCalls.length, 0)
})

test('redeemOutcomeLegWithOperation accepts the exact witness byte boundary', async () => {
  const store = new MemoryProofOperationStore()
  const wallet = new FakeRedeemWallet({ error: new Error('transient') })
  const witness = 'w'.repeat(DURABLE_CUSTODY_COMPOSITE_ID_LIMIT_MAX)

  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: 'https://mint.example',
        operationId: 'redeem:bounded-witness',
        wallet,
        proofOperationStore: store,
        conditionId: 'condition',
        outcome: 'YES',
        unit: 'sat',
        oracleWitness: witness,
        proofs: [proof('ctf-keyset', 'bounded-witness-input', 1)],
        regularKeyset: regularKeyset(),
      }),
    /transient/,
  )
  assert.equal(store.prepareCalls, 1)
  assert.equal(wallet.loadMintCalls, 1)
  assert.equal(
    (await store.getProofOperation('redeem:bounded-witness'))?.metadata.oracleWitness,
    witness,
  )
})

test('redeemOutcomeLegWithOperation rejects a legacy record without a witness before mint I/O', async () => {
  const store = new MemoryProofOperationStore()
  const inputs = [proof('ctf-keyset', 'legacy-input', 1)]
  await store.prepareProofOperation({
    operationId: 'redeem:legacy',
    kind: 'ctf-redeem',
    mintUrl: 'https://mint.example',
    inputs,
    outputs: {},
    metadata: {
      conditionId: 'condition',
      outcome: 'YES',
      outcomeKeysetId: 'ctf-keyset',
      regularKeysetId: 'regular-keyset',
      unit: 'sat',
      amountSubunits: 1,
    },
  })
  const wallet = new FakeRedeemWallet()

  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: 'https://mint.example',
        operationId: 'redeem:legacy',
        wallet,
        proofOperationStore: store,
        conditionId: 'condition',
        outcome: 'YES',
        unit: 'sat',
        oracleWitness: 'current-witness',
        proofs: inputs,
        regularKeyset: regularKeyset(),
      }),
    /oracle witness must be a non-empty string/,
  )
  assert.equal(wallet.loadMintCalls, 0)
  assert.equal(wallet.checkProofStateCalls, 0)
  assert.equal(wallet.redeemCalls.length, 0)
})

test('redeemOutcomeLegWithOperation rejects request substitution before mint effects', async () => {
  const store = new MemoryProofOperationStore()
  const original = [proof('ctf-keyset', 'original-input', 5)]
  await redeemOutcomeLegWithOperation({
    mintUrl: 'https://mint.example',
    operationId: 'redeem:authority',
    wallet: new FakeRedeemWallet({ error: new Error('transient') }),
    proofOperationStore: store,
    conditionId: 'condition',
    outcome: 'YES',
    outcomeKeysetId: 'ctf-keyset',
    unit: 'sat',
    oracleWitness: 'witness',
    proofs: original,
    regularKeyset: regularKeyset(),
  }).catch(() => undefined)

  const retryWallet = new FakeRedeemWallet()
  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: 'https://mint.example',
        operationId: 'redeem:authority',
        wallet: retryWallet,
        proofOperationStore: store,
        conditionId: 'condition',
        outcome: 'YES',
        outcomeKeysetId: 'ctf-keyset',
        unit: 'sat',
        oracleWitness: 'witness',
        proofs: [proof('ctf-keyset', 'substituted-input', 5)],
        regularKeyset: regularKeyset(),
      }),
    /does not match the current request/,
  )
  assert.equal(retryWallet.redeemCalls.length, 0)
})

test('getActiveRegularKeyset rejects an inactive-only keyset response', async () => {
  await assert.rejects(
    () =>
      getActiveRegularKeyset(
        {
          mint: {
            getKeys: async () => ({
              keysets: [{ ...regularKeyset(), active: false }],
            }),
          },
        },
        'sat',
      ),
    /active regular sat keyset/,
  )
})

test('redeemOutcomeLegWithOperation refuses non-losing failed records', async () => {
  const store = new MemoryProofOperationStore()
  await store.prepareProofOperation({
    operationId: 'redeem:failed',
    kind: 'ctf-redeem',
    mintUrl: 'https://mint.example',
    inputs: [proof('ctf-keyset', 'input', 1)],
    outputs: {},
    metadata: {
      conditionId: 'condition',
      outcome: 'YES',
      outcomeKeysetId: 'ctf-keyset',
      regularKeysetId: 'regular-keyset',
      unit: 'sat',
      amountSubunits: 1,
      oracleWitness: 'witness',
    },
  })
  store.records.set('redeem:failed', {
    ...(await store.getProofOperation('redeem:failed'))!,
    state: 'Failed',
    lastError: 'boom',
    failureCode: 999,
  })

  await assert.rejects(
    () =>
      redeemOutcomeLegWithOperation({
        mintUrl: 'https://mint.example',
        operationId: 'redeem:failed',
        wallet: new FakeRedeemWallet(),
        proofOperationStore: store,
        conditionId: 'condition',
        outcome: 'YES',
        unit: 'sat',
        oracleWitness: 'witness',
        proofs: [proof('ctf-keyset', 'input', 1)],
        regularKeyset: regularKeyset(),
        restoreOutputGroups: async () => ({}),
      }),
    /non-losing failure code 999/,
  )
})

function proof(id: string, secret: string, amount: number): Proof {
  return { id, secret, amount, C: `C-${secret}` } as Proof
}

function state(value: CheckStateEnum): ProofState {
  return { state: value, secret: 'secret' } as ProofState
}

function regularKeyset(): MintKeys {
  return {
    id: 'regular-keyset',
    unit: 'sat',
    active: true,
    input_fee_ppk: 0,
    keys: { 1: '02'.repeat(33), 2: '03'.repeat(33), 4: '04'.repeat(33) },
  } as unknown as MintKeys
}

class FakeRedeemWallet implements RedeemWallet {
  loadMintCalls = 0
  checkProofStateCalls = 0
  redeemCalls: Array<{ inputs: Proof[]; outputs: unknown[] }> = []
  private readonly script: {
    settledProofs?: Proof[]
    states?: ProofState[]
    error?: unknown
  }

  constructor(
    script: {
      settledProofs?: Proof[]
      states?: ProofState[]
      error?: unknown
    } = {},
  ) {
    this.script = script
  }

  async loadMint(): Promise<void> {
    this.loadMintCalls += 1
  }

  async redeemOutcomeProofs(options: { inputs: Proof[]; outputs: unknown[] }): Promise<Proof[]> {
    this.redeemCalls.push(options)
    if (this.script.error) throw this.script.error
    return this.script.settledProofs ?? []
  }

  async checkProofsStates(): Promise<ProofState[]> {
    this.checkProofStateCalls += 1
    return this.script.states ?? []
  }
}

class MemoryProofOperationStore implements CtfProofOperationStore {
  readonly records = new Map<string, CtfProofOperationRecord>()
  readonly terminalEvidence = new Map<string, AuthenticatedCtfRedeemTerminalEvidence>()
  prepareCalls = 0

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

  async markProofOperationFailed(
    operationId: string,
    message: string,
    terminalEvidence: AuthenticatedCtfRedeemTerminalEvidence,
  ): Promise<CtfProofOperationRecord> {
    const existing = this.records.get(operationId)
    if (!existing) throw new Error(`missing operation ${operationId}`)
    const failed: CtfProofOperationRecord = {
      ...existing,
      state: 'Failed',
      lastError: message,
      failureCode: readAuthenticatedCtfRedeemTerminalEvidence(terminalEvidence).rejectionBody.code,
      updatedAt: existing.updatedAt + 1,
    }
    this.records.set(operationId, failed)
    this.terminalEvidence.set(operationId, terminalEvidence)
    return failed
  }
}
