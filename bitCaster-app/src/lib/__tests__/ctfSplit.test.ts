import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proof } from '@cashu/cashu-ts'
import {
  splitRootCompleteSetForSwap,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from '@/lib/ctfSplit'

vi.mock('@cashu/cashu-ts', () => {
  class MockOutputData {
    blindedMessage: { amount: number; id: string; B_: string }
    blindingFactor = 1n
    secret = new Uint8Array([1])

    constructor(kind: 'p2pk' | 'random', amount: number, keyset: { id: string }) {
      this.blindedMessage = {
        amount,
        id: keyset.id,
        B_: `${kind}-${keyset.id}`,
      }
    }

    static createP2PKData(
      _p2pk: unknown,
      amount: number,
      keyset: { id: string },
    ): MockOutputData[] {
      return [new MockOutputData('p2pk', amount, keyset)]
    }

    static createRandomData(amount: number, keyset: { id: string }): MockOutputData[] {
      return [new MockOutputData('random', amount, keyset)]
    }

    toProof(signature: { id: string; amount: number; C_: string }): Proof {
      return {
        id: signature.id,
        amount: signature.amount,
        secret: `proof-${this.blindedMessage.B_}`,
        C: signature.C_,
      } as Proof
    }
  }

  return {
    CheckStateEnum: { SPENT: 'SPENT', UNSPENT: 'UNSPENT' },
    OutputData: MockOutputData,
    Mint: vi.fn(function MockMint() {
      return {
        getKeys: vi.fn(async (keysetId: string) => ({
          keysets: [
            {
              id: keysetId,
              unit: 'sat',
              active: true,
              input_fee_ppk: 0,
              keys: { 1: '02'.padEnd(66, '1') },
            },
          ],
        })),
        restore: vi.fn(),
      }
    }),
    Wallet: vi.fn(),
  }
})

const conditionId = 'a'.repeat(64)
const zeroCollectionId = '0'.repeat(64)
const inputProof = {
  id: 'sat-keyset',
  amount: 100,
  secret: 'input-secret',
  C: '02'.padEnd(66, '0'),
} as Proof

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

function mockConditionFetch(keysets: Record<string, string>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as {
          outputs: Record<string, Array<{ id: string; amount: number }>>
        }
        return new Response(
          JSON.stringify({
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
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      }

      return new Response(
        JSON.stringify({
          condition: {
            condition_id: conditionId,
            partitions: [
              {
                collateral: 'sat',
                parent_collection_id: zeroCollectionId,
                keysets,
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }),
  )
}

describe('splitRootCompleteSetForSwap', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('keys split outputs by resolved mint outcome-set keys and locks the resolved branch', async () => {
    mockConditionFetch({
      'Bob|Carol': 'keyset-not-alice',
      Alice: 'keyset-alice',
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

    const postBody = JSON.parse(
      String(vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === 'POST')?.[1]?.body),
    ) as { outputs: Record<string, Array<{ B_: string }>> }
    expect(Object.keys(postBody.outputs)).toEqual(['Bob|Carol', 'Alice'])
    expect(postBody.outputs['Bob|Carol'][0].B_).toBe('p2pk-keyset-not-alice')
    expect(postBody.outputs.Alice[0].B_).toBe('random-keyset-alice')
    expect(result.resolvedLockOutcomeSetId).toBe('Bob|Carol')
    expect(result.resolvedKeepOutcomeSetId).toBe('Alice')
    expect(result.lockedProofs[0].id).toBe('keyset-not-alice')
    expect(result.keepProofs[0].id).toBe('keyset-alice')
  })

  it('throws before posting when an engine outcome-set id matches multiple mint keys', async () => {
    mockConditionFetch({
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
    ).rejects.toThrow('matched 2 mint keyset-map keys')
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(
      false,
    )
  })
})
