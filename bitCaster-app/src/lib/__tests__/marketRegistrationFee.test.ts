import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  addProofs: vi.fn(),
  getBaseProofs: vi.fn(),
  getProofOperation: vi.fn(),
  markProofOperationCompleted: vi.fn(),
  markProofOperationFailed: vi.fn(),
  prepareProofOperation: vi.fn(),
  releaseProofReservation: vi.fn(),
  removeProofs: vi.fn(),
  reserveProofs: vi.fn(),
  registerCondition: vi.fn(),
  getWallet: vi.fn(),
  createdOutputs: [] as Array<{
    blindedMessage: { amount: number; id: string; B_: string }
    blindingFactor: bigint
    secret: Uint8Array
    toProof: ReturnType<typeof vi.fn>
  }>,
}))

vi.mock('@/stores/proof-db', () => ({
  addProofs: mocks.addProofs,
  getBaseProofs: mocks.getBaseProofs,
  getProofOperation: mocks.getProofOperation,
  markProofOperationCompleted: mocks.markProofOperationCompleted,
  markProofOperationFailed: mocks.markProofOperationFailed,
  prepareProofOperation: mocks.prepareProofOperation,
  releaseProofReservation: mocks.releaseProofReservation,
  removeProofs: mocks.removeProofs,
  reserveProofs: mocks.reserveProofs,
}))

vi.mock('@/lib/cashu', () => ({
  getWallet: mocks.getWallet,
}))

vi.mock('@/lib/markets', () => ({
  MintError: class MintError extends Error {
    constructor(public readonly code: number, public readonly detail: string) {
      super(detail)
      this.name = 'MintError'
    }
  },
  registerCondition: (...args: unknown[]) => mocks.registerCondition(...args),
  requiredMarketCreationOutcomeCollections: (outcomes: readonly string[]) => {
    const universe = [...new Set(outcomes.map((outcome) => outcome.trim()))].filter(Boolean)
    const collections = new Set<string>()
    for (const outcome of universe) {
      collections.add(outcome)
      const complement = universe.filter((candidate) => candidate !== outcome)
      if (complement.length > 0) collections.add(complement.join('|'))
    }
    return [...collections]
  },
}))

vi.mock('@cashu/cashu-ts', () => {
  class Mint {
    constructor(public readonly mintUrl: string) {}

    async getKeys(keysetId = 'regular-keyset') {
      return {
        keysets: [{
          id: keysetId,
          unit: 'sat',
          active: true,
          input_fee_ppk: 0,
          keys: { '1': 'k1', '2': 'k2', '4': 'k4', '5': 'k5' },
        }],
      }
    }

    async restore() {
      return { signatures: [] }
    }
  }

  class OutputData {
    toProof: ReturnType<typeof vi.fn>

    constructor(
      public readonly blindedMessage: { amount: number; id: string; B_: string },
      public readonly blindingFactor: bigint,
      public readonly secret: Uint8Array,
    ) {
      const index = mocks.createdOutputs.length
      this.toProof = vi.fn((signature: { amount: number; id: string }) => ({
        id: signature.id,
        amount: signature.amount,
        C: `C-${index}`,
        secret: new TextDecoder().decode(secret),
      }))
      mocks.createdOutputs.push(this)
    }

    static createRandomData() {
      return [1, 4].map((amount, index) => ({
        blindedMessage: {
          amount,
          id: 'regular-keyset',
          B_: `B_${index}`,
        },
        blindingFactor: BigInt(index + 1),
        secret: new TextEncoder().encode(`change-secret-${index}`),
        toProof: vi.fn((signature: { amount: number; id: string }) => ({
          id: signature.id,
          amount: signature.amount,
          C: `C-${index}`,
          secret: `change-secret-${index}`,
        })),
      }))
    }
  }

  return {
    Amount: { from: (value: number) => value },
    CheckStateEnum: { SPENT: 'SPENT', UNSPENT: 'UNSPENT' },
    Mint,
    OutputData,
  }
})

const {
  registerConditionWithFee,
  registrationFeeForPolicy,
} = await import('../marketRegistrationFee')

describe('registerConditionWithFee', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createdOutputs = []
    mocks.getBaseProofs.mockResolvedValue([{
      id: 'regular-keyset',
      amount: 8,
      secret: 'fee-proof-secret',
      C: 'fee-proof-C',
    }])
    mocks.getProofOperation.mockResolvedValue(null)
    mocks.prepareProofOperation.mockResolvedValue(undefined)
    mocks.reserveProofs.mockResolvedValue(undefined)
    mocks.removeProofs.mockResolvedValue(undefined)
    mocks.addProofs.mockResolvedValue(undefined)
    mocks.markProofOperationCompleted.mockResolvedValue(undefined)
    mocks.markProofOperationFailed.mockResolvedValue(undefined)
    mocks.releaseProofReservation.mockResolvedValue(undefined)
    mocks.getWallet.mockResolvedValue({
      mint: {
        getKeys: async () => ({
          keysets: [{
            id: 'regular-keyset',
            unit: 'sat',
            active: true,
            input_fee_ppk: 0,
            keys: { '1': 'k1', '2': 'k2', '4': 'k4', '5': 'k5' },
          }],
        }),
      },
    })
  })

  it('charges one-vs-rest registration fees for every generated collection', () => {
    expect(registrationFeeForPolicy(['A', 'B', 'C'], {
      defaultKeysetCreation: 'one-vs-rest',
      registrationFeeBase: 1,
      registrationFeePerKeyset: 1,
    })).toBe(7)
  })

  it('accepts fewer registration-fee change signatures than prepared blank outputs', async () => {
    mocks.registerCondition.mockResolvedValue({
      condition_id: 'cond-1',
      keysets: { Yes: 'ks-yes', No: 'ks-no' },
      change: [{ id: 'regular-keyset', amount: 5, C_: 'blind-sig' }],
    })

    const result = await registerConditionWithFee({
      mintUrl: 'https://mint.example.test',
      requiredFeeSats: 3,
      request: {
        tags: [['title', 'Fee change']],
        announcementHex: 'announcement',
        collateral: 'sat',
      },
    })

    expect(result.condition_id).toBe('cond-1')
    expect(mocks.createdOutputs).toHaveLength(2)
    expect(mocks.registerCondition.mock.calls[0][0].outputs.map(
      (output: { amount: number }) => output.amount,
    )).toEqual([0, 0])
    expect(mocks.createdOutputs[0].toProof).toHaveBeenCalledWith(
      { id: 'regular-keyset', amount: 5, C_: 'blind-sig' },
      expect.objectContaining({ id: 'regular-keyset' }),
    )
    expect(mocks.addProofs).toHaveBeenCalledWith([
      expect.objectContaining({
        mintUrl: 'https://mint.example.test',
        amount: 5,
        secret: 'change-secret-0',
      }),
    ])
    expect(mocks.removeProofs).toHaveBeenCalledWith(['fee-proof-secret'])
    expect(mocks.markProofOperationCompleted).toHaveBeenCalledWith(
      expect.stringMatching(/^ctf-condition-registration:/),
      { change: [expect.objectContaining({ amount: 5 })] },
    )
  })

  it('rejects more registration-fee change signatures than prepared outputs', async () => {
    mocks.registerCondition.mockResolvedValue({
      condition_id: 'cond-1',
      keysets: { Yes: 'ks-yes', No: 'ks-no' },
      change: [
        { id: 'regular-keyset', amount: 1, C_: 'sig-1' },
        { id: 'regular-keyset', amount: 2, C_: 'sig-2' },
        { id: 'regular-keyset', amount: 2, C_: 'sig-3' },
      ],
    })

    await expect(registerConditionWithFee({
      mintUrl: 'https://mint.example.test',
      requiredFeeSats: 3,
      request: {
        tags: [['title', 'Fee change']],
        announcementHex: 'announcement',
        collateral: 'sat',
      },
    })).rejects.toThrow(
      'Mint returned 3 registration-fee change signatures, but only 2 change outputs were prepared',
    )
    expect(mocks.addProofs).not.toHaveBeenCalled()
    expect(mocks.removeProofs).not.toHaveBeenCalled()
  })
})
