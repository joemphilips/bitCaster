import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proof } from '@cashu/cashu-ts'
import {
  splitRootCompleteSetForPreflightOrder,
  splitRootCompleteSetForSwap,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@/lib/ctfSplit'

const { MockAmount, MockOutputData, MockCtfMint, ctfMintState } = vi.hoisted(() => {
  class MockAmount {
    constructor(readonly value: number) {}
    static from(value: unknown) {
      return value instanceof MockAmount ? value : new MockAmount(Number(value))
    }
    isZero() {
      return this.value === 0
    }
    equals(other: unknown) {
      return this.value === Number(other instanceof MockAmount ? other.value : other)
    }
    toNumber() {
      return this.value
    }
    toJSON() {
      return String(this.value)
    }
  }

  class MockOutputData {
    blindedMessage: { amount: MockAmount; id: string; B_: string }
    blindingFactor = 1n
    secret = new Uint8Array([1])

    constructor(kind: 'p2pk' | 'random', amount: MockAmount, keyset: { id: string }) {
      if (typeof amount?.isZero !== 'function') {
        throw new TypeError('amount.isZero is not a function')
      }
      this.blindedMessage = {
        amount,
        id: keyset.id,
        B_: `${kind}-${keyset.id}`,
      }
    }

    static createP2PKData(
      _p2pk: unknown,
      amount: MockAmount,
      keyset: { id: string },
    ): MockOutputData[] {
      return [new MockOutputData('p2pk', amount, keyset)]
    }

    static createRandomData(amount: MockAmount, keyset: { id: string }): MockOutputData[] {
      return [new MockOutputData('random', amount, keyset)]
    }

    toProof(signature: { id: string; amount: unknown; C_: string }) {
      const amount =
        signature.amount instanceof MockAmount ? signature.amount.toNumber() : Number(signature.amount)
      return {
        id: signature.id,
        amount,
        secret: `proof-${this.blindedMessage.B_}`,
        C: signature.C_,
      }
    }
  }

  const ctfMintState = {
    keysets: {} as Record<string, string>,
    splitRequests: [] as Array<{
      condition_id: string
      inputs: Proof[]
      outputs: Record<string, Array<{ id: string; amount: number; B_: string }>>
    }>,
  }

  class MockCtfMint {
    constructor(readonly mintUrl: string) {}

    async getKeys(keysetId: string) {
      return {
        keysets: [
          {
            id: keysetId,
            unit: 'sat',
            active: true,
            input_fee_ppk: 0,
            keys: { 1: '02'.padEnd(66, '1') },
          },
        ],
      }
    }

    async getCtfCondition(conditionIdArg: string) {
      return {
        condition_id: conditionIdArg,
        partitions: [
          {
            collateral: 'sat',
            parent_collection_id: '0'.repeat(64),
            keysets: ctfMintState.keysets,
          },
        ],
      }
    }

    async ctfSplit(request: {
      condition_id: string
      inputs: Proof[]
      outputs: Record<string, Array<{ id: string; amount: number; B_: string }>>
    }) {
      ctfMintState.splitRequests.push(request)
      for (const outputs of Object.values(request.outputs)) {
        expect(outputs.every((output) => typeof output.amount === 'number')).toBe(true)
      }
      return {
        signatures: Object.fromEntries(
          Object.entries(request.outputs).map(([collection, outputs]) => [
            collection,
            outputs.map((output) => ({
              id: output.id,
              amount: output.amount,
              C_: `02${collection}`.padEnd(66, '0'),
            })),
          ]),
        ),
      }
    }
  }

  return { MockAmount, MockOutputData, MockCtfMint, ctfMintState }
})

vi.mock('/home/joemphilips/working/src/cashu/bitCaster-matching-engine-2/bitCaster/cashu-ts/lib/cashu-ts.es.js', () => ({
  Amount: MockAmount,
  Mint: MockCtfMint,
  OutputData: MockOutputData,
}))

vi.mock('@cashu/cashu-ts', () => {
  return {
    Amount: MockAmount,
    CheckStateEnum: { SPENT: 'SPENT', UNSPENT: 'UNSPENT' },
    OutputData: MockOutputData,
    Mint: vi.fn(function MockMint(mintUrl: string) {
      return new MockCtfMint(mintUrl)
    }),
    Wallet: vi.fn(),
  }
})

const conditionId = 'a'.repeat(64)
const inputProof = {
  id: 'sat-keyset',
  amount: 100,
  secret: 'input-secret',
  C: '02'.padEnd(66, '0'),
} as unknown as Proof

function proofOperationStore(): CtfProofOperationStore {
  return {
    getProofOperation: vi.fn(async () => null),
    prepareProofOperation: vi.fn(
      async (input): Promise<CtfProofOperationRecord> => ({
        ...input,
        state: 'prepared',
        resultProofs: undefined,
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    ),
    markProofOperationCompleted: vi.fn(
      async (operationId, resultProofs): Promise<CtfProofOperationRecord> => ({
        operationId,
        kind: 'ctf-split',
        state: 'completed',
        mintUrl: 'https://mint.example',
        inputs: [inputProof],
        outputs: {},
        metadata: {},
        resultProofs,
        lastError: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    ),
  }
}

function mockMintCondition(keysets: Record<string, string>) {
  ctfMintState.keysets = keysets
  ctfMintState.splitRequests = []
}

describe('splitRootCompleteSetForSwap', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    mockMintCondition({})
  })

  it('keys split outputs by resolved mint outcome-set keys and locks the resolved branch', async () => {
    mockMintCondition({
      Alice: 'keyset-alice',
      Bob: 'keyset-bob',
      Carol: 'keyset-carol',
    })

    const result = await splitRootCompleteSetForSwap({
      mintUrl: 'https://mint.example',
      conditionId,
      collateralProofs: [inputProof],
      amountSats: 100,
      lockOutcomeSetId: 'Carol|Bob',
      keepOutcomeSetId: 'Alice',
      p2pk: { pubkey: ['02'.padEnd(66, '2')], locktime: 1 },
      operationId: 'op-1',
      proofOperationStore: proofOperationStore(),
    })

    const splitRequest = ctfMintState.splitRequests[0]
    expect(Object.keys(splitRequest.outputs)).toEqual(['Alice', 'Bob', 'Carol'])
    expect(splitRequest.outputs.Alice[0].B_).toBe('random-keyset-alice')
    expect(splitRequest.outputs.Bob[0].B_).toBe('p2pk-keyset-bob')
    expect(splitRequest.outputs.Carol[0].B_).toBe('p2pk-keyset-carol')
    expect(result.resolvedLockOutcomeSetId).toBe('Bob|Carol')
    expect(result.resolvedKeepOutcomeSetId).toBe('Alice')
    expect(result.lockedProofs.map((proof) => proof.id).sort()).toEqual([
      'keyset-bob',
      'keyset-carol',
    ])
    expect(result.keepProofs[0].id).toBe('keyset-alice')
  })

  it('pre-flight splits both outcome branches as regular proofs for later reservation', async () => {
    mockMintCondition({
      NO: 'keyset-no',
      YES: 'keyset-yes',
    })

    const result = await splitRootCompleteSetForPreflightOrder({
      mintUrl: 'https://mint.example',
      conditionId,
      collateralProofs: [inputProof],
      amountSats: 100,
      lockOutcomeSetId: 'NO',
      keepOutcomeSetId: 'YES',
      operationId: 'op-preflight',
      proofOperationStore: proofOperationStore(),
    })

    const splitRequest = ctfMintState.splitRequests[0]
    expect(splitRequest.outputs.NO[0].B_).toBe('random-keyset-no')
    expect(splitRequest.outputs.YES[0].B_).toBe('random-keyset-yes')
    expect(result.lockProofs[0].id).toBe('keyset-no')
    expect(result.keepProofs[0].id).toBe('keyset-yes')
    expect(result.proofsByCollection.NO[0].secret).toBe('proof-random-keyset-no')
    expect(result.proofsByCollection.YES[0].secret).toBe('proof-random-keyset-yes')
  })

  it('throws before posting when the mint root keyset map is not primitive', async () => {
    mockMintCondition({
      'Alice|Bob': 'keyset-1',
      'Bob|Alice': 'keyset-2',
      Carol: 'keyset-3',
    })

    await expect(
      splitRootCompleteSetForSwap({
        mintUrl: 'https://mint.example',
        conditionId,
        collateralProofs: [inputProof],
        amountSats: 100,
        lockOutcomeSetId: 'Bob|Alice',
        keepOutcomeSetId: 'Carol',
        p2pk: { pubkey: ['02'.padEnd(66, '2')], locktime: 1 },
        operationId: 'op-2',
        proofOperationStore: proofOperationStore(),
      }),
    ).rejects.toThrow('root outcome collection Alice|Bob is not primitive')
    expect(ctfMintState.splitRequests).toHaveLength(0)
  })
})
