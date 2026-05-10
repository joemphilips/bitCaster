import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proof } from '@cashu/cashu-ts'
import {
  buildReceiveToken,
  buyerPrepareSwap,
  MIN_LOCKTIME_DELTA_SECS,
  sellerClaimSwap,
  sellerPrepareSwap,
  type ProofOperationStore,
  type SwapContext,
  validateLocktimeOrdering,
} from '../atomicSwap'
import {
  computeSharedSecret,
  decrypt,
  deriveEncryptionKey,
  generateEphemeralKeypair,
} from '../ecdh'

const cashuMockState = vi.hoisted(() => ({
  failNextFeeLookup: false,
  loadedKeysets: [] as Array<{ keys: Record<number, string> }>,
  prepareSwapToSendCalls: 0,
  prepareSwapToReceiveCalls: 0,
  completeSwapCalls: 0,
  restoreCalls: 0,
  completeSwapError: null as Error | null,
  proofState: 'UNSPENT' as 'UNSPENT' | 'SPENT' | 'PENDING',
}))

const proofDbMockState = vi.hoisted(() => ({
  operations: new Map<string, any>(),
}))

vi.mock('@cashu/cashu-ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cashu/cashu-ts')>()
  const makeProof = (
    secret: string,
    amount: number,
    id = 'test-keyset',
    C = '02'.padEnd(66, '0'),
  ): Proof =>
    ({
      id,
      amount,
      secret,
      C,
    }) as Proof

  class MockOutputData {
    blindedMessage: { amount: number; id: string; B_: string }
    blindingFactor: bigint
    secret: Uint8Array

    constructor(
      blindedMessage: { amount: number; id: string; B_: string },
      blindingFactor: bigint,
      secret: Uint8Array,
    ) {
      this.blindedMessage = blindedMessage
      this.blindingFactor = blindingFactor
      this.secret = secret
    }

    toProof(signature: { C_?: string }): Proof {
      return makeProof(
        `restored-${Array.from(this.secret).join('-')}`,
        Number(this.blindedMessage.amount),
        this.blindedMessage.id,
        signature.C_ ?? '02'.padEnd(66, '9'),
      )
    }
  }
  let outputCounter = 0
  const output = (amount: number, group: string) =>
    new MockOutputData(
      {
        amount,
        id: 'test-keyset',
        B_: `02${group}${outputCounter++}`.padEnd(66, '0'),
      },
      1n,
      new Uint8Array([outputCounter]),
    )
  return {
    ...actual,
    OutputData: MockOutputData,
    Mint: vi.fn(function MockMint() {
      return {
        getInfo: vi.fn().mockResolvedValue({
          name: 'test mint',
          pubkey: '02'.padEnd(66, '0'),
          version: 'test',
          contact: [],
          nuts: {
            '4': { methods: [], disabled: false },
            '5': { methods: [], disabled: false },
          },
        }),
        getKeys: vi.fn(async (keysetId: string) => ({
          keysets: [
            {
              id: keysetId,
              unit: 'sat',
              active: true,
              keys: { 1: '02'.padEnd(66, '1') },
            },
          ],
        })),
        restore: vi.fn(async ({ outputs }: { outputs: Array<{ amount: number; id: string }> }) => {
          cashuMockState.restoreCalls++
          return {
            outputs,
            signatures: outputs.map((o, index) => ({
              amount: o.amount,
              id: o.id,
              C_: `02restored${index}`.padEnd(66, '9'),
            })),
          }
        }),
      }
    }),
    Wallet: vi.fn(function MockWallet() {
      const keyset = { keys: {} }
      cashuMockState.loadedKeysets.push(keyset)
      return {
        loadMint: vi.fn().mockResolvedValue(undefined),
        keyChain: {
          getKeyset: vi.fn(() => keyset),
        },
        getFeesForProofs: vi.fn(() => {
          if (cashuMockState.failNextFeeLookup) {
            cashuMockState.failNextFeeLookup = false
            throw new Error("Keyset 'conditional-keyset' not found")
          }
          return 0
        }),
        send: vi.fn().mockImplementation(async (_amount: number, proofs: Proof[]) => ({
          send: proofs,
          keep: [],
        })),
        prepareSwapToSend: vi.fn().mockImplementation(
          async (amount: number, proofs: Proof[]) => {
            cashuMockState.prepareSwapToSendCalls++
            return {
              amount,
              fees: 0,
              keysetId: proofs[0]?.id ?? 'test-keyset',
              inputs: proofs,
              sendOutputs: [output(amount, 'send')],
              keepOutputs: [],
              unselectedProofs: [],
            }
          },
        ),
        prepareSwapToReceive: vi.fn().mockImplementation(async (token: { proofs: Proof[] }) => {
          cashuMockState.prepareSwapToReceiveCalls++
          const amount = token.proofs.reduce((sum, p) => sum + p.amount, 0)
          return {
            amount,
            fees: 0,
            keysetId: token.proofs[0]?.id ?? 'test-keyset',
            inputs: token.proofs,
            keepOutputs: [output(amount, 'keep')],
            unselectedProofs: [],
          }
        }),
        completeSwap: vi.fn().mockImplementation(async (preview: {
          sendOutputs?: Array<{ blindedMessage: { amount: number; id: string } }>
          keepOutputs?: Array<{ blindedMessage: { amount: number; id: string } }>
        }) => {
          cashuMockState.completeSwapCalls++
          if (cashuMockState.completeSwapError) {
            throw cashuMockState.completeSwapError
          }
          return {
            send: (preview.sendOutputs ?? []).map((o, index) =>
              makeProof(`send-${index}`, Number(o.blindedMessage.amount), o.blindedMessage.id),
            ),
            keep: (preview.keepOutputs ?? []).map((o, index) =>
              makeProof(`keep-${index}`, Number(o.blindedMessage.amount), o.blindedMessage.id),
            ),
          }
        }),
        checkProofsStates: vi.fn().mockImplementation(async (proofs: Proof[]) =>
          proofs.map((p) => ({
            Y: p.secret,
            state: cashuMockState.proofState,
            witness: null,
          })),
        ),
        receive: vi.fn().mockResolvedValue([]),
      }
    }),
  }
})

vi.mock('@/stores/proof-db', () => ({
  getProofOperation: vi.fn(async (operationId: string) =>
    proofDbMockState.operations.get(operationId) ?? null,
  ),
  prepareProofOperation: vi.fn(async (input: any) => {
    const existing = proofDbMockState.operations.get(input.operationId)
    if (existing) return existing
    const record = {
      ...input,
      state: 'prepared',
      metadata: input.metadata ?? {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    proofDbMockState.operations.set(input.operationId, record)
    return record
  }),
  markProofOperationCompleted: vi.fn(async (operationId: string, resultProofs: Record<string, Proof[]>) => {
    const existing = proofDbMockState.operations.get(operationId)
    const record = {
      ...existing,
      state: 'completed',
      resultProofs,
      updatedAt: Date.now(),
    }
    proofDbMockState.operations.set(operationId, record)
    return record
  }),
}))

const proofOperationStore: ProofOperationStore = {
  getProofOperation: async (operationId: string) =>
    proofDbMockState.operations.get(operationId) ?? null,
  prepareProofOperation: async (input) => {
    const existing = proofDbMockState.operations.get(input.operationId)
    if (existing) return existing
    const record = {
      ...input,
      state: 'prepared' as const,
      metadata: input.metadata ?? {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    proofDbMockState.operations.set(input.operationId, record)
    return record
  },
  markProofOperationCompleted: async (operationId, resultProofs) => {
    const existing = proofDbMockState.operations.get(operationId)
    const record = {
      ...existing,
      state: 'completed' as const,
      resultProofs,
      updatedAt: Date.now(),
    }
    proofDbMockState.operations.set(operationId, record)
    return record
  },
}

beforeEach(() => {
  cashuMockState.failNextFeeLookup = false
  cashuMockState.loadedKeysets.length = 0
  cashuMockState.prepareSwapToSendCalls = 0
  cashuMockState.prepareSwapToReceiveCalls = 0
  cashuMockState.completeSwapCalls = 0
  cashuMockState.restoreCalls = 0
  cashuMockState.completeSwapError = null
  cashuMockState.proofState = 'UNSPENT'
  proofDbMockState.operations.clear()
})

// ---------------------------------------------------------------------------
// validateLocktimeOrdering
//
// The protocol requires `T_YES > T_sat + Δ` — i.e.
// `sellerLocktime > buyerLocktime + MIN_LOCKTIME_DELTA_SECS`. The frontend
// gate mirrors the wallet-service's defense-in-depth check so a buggy or
// malicious engine cannot trick the user into locking proofs in a vulnerable
// shape.
// ---------------------------------------------------------------------------

describe('validateLocktimeOrdering', () => {
  const buyer = 1_700_000_000

  it('accepts the engine default (90s vs 60s — Δ = 30s)', () => {
    expect(validateLocktimeOrdering(buyer + 30, buyer)).toBeNull()
  })

  it('accepts the minimum gap exactly above Δ', () => {
    expect(
      validateLocktimeOrdering(buyer + MIN_LOCKTIME_DELTA_SECS + 1, buyer),
    ).toBeNull()
  })

  it('rejects an inverted ordering', () => {
    const err = validateLocktimeOrdering(buyer, buyer + 60)
    expect(err).toMatch(/locktime ordering/i)
    expect(err).toContain(`sellerLocktime=${buyer}`)
    expect(err).toContain(`buyerLocktime=${buyer + 60}`)
  })

  it('rejects equal locktimes', () => {
    expect(validateLocktimeOrdering(buyer, buyer)).toMatch(/locktime ordering/i)
  })

  it('rejects when the gap is exactly Δ (boundary is strict)', () => {
    expect(
      validateLocktimeOrdering(buyer + MIN_LOCKTIME_DELTA_SECS, buyer),
    ).toMatch(/locktime ordering/i)
  })

  it('rejects non-finite values', () => {
    expect(validateLocktimeOrdering(NaN, buyer)).toMatch(/invalid locktime/i)
    expect(validateLocktimeOrdering(buyer + 30, NaN)).toMatch(/invalid locktime/i)
    expect(validateLocktimeOrdering(Infinity, buyer)).toMatch(/invalid locktime/i)
  })
})

describe('buyerPrepareSwap', () => {
  it('returns the verified seller pre-sigs from Alice locked-proofs ciphertext', async () => {
    const sellerKey = generateEphemeralKeypair()
    const buyerKey = generateEphemeralKeypair()
    const sellerCtx: SwapContext = {
      tradeId: 'trade-1',
      role: 'seller',
      ephemeralKey: sellerKey,
      counterpartyPubkey: buyerKey.publicKey,
      sellerLocktime: 1_700_000_100,
      buyerLocktime: 1_700_000_000,
      mintUrl: 'https://mint.test',
    }
    const buyerCtx: SwapContext = {
      ...sellerCtx,
      role: 'buyer',
      ephemeralKey: buyerKey,
      counterpartyPubkey: sellerKey.publicKey,
    }

    const sellerOut = await sellerPrepareSwap(sellerCtx, [proof('alice-1', 7)])
    const buyerOut = await buyerPrepareSwap(
      buyerCtx,
      sellerOut.adaptorPointCipher,
      sellerOut.lockedProofsCipher,
      [proof('bob-1', 7)],
    )

    const sharedKey = await deriveEncryptionKey(
      computeSharedSecret(buyerKey.privateKey, sellerKey.publicKey),
    )
    const sellerLockedPlain = await decrypt(sharedKey, sellerOut.lockedProofsCipher)
    const sellerLocked = JSON.parse(sellerLockedPlain) as { preSigs: string[] }
    expect(buyerOut.sellerPreSigsHex).toEqual(sellerLocked.preSigs)
    expect(buyerOut.sellerPreSigsHex).toHaveLength(1)
  })
})

describe('sellerPrepareSwap', () => {
  it('loads mint-returned keys for condition-derived CTF keysets', async () => {
    cashuMockState.failNextFeeLookup = true

    const sellerKey = generateEphemeralKeypair()
    const buyerKey = generateEphemeralKeypair()
    const ctx: SwapContext = {
      tradeId: 'trade-conditional-keyset',
      role: 'seller',
      ephemeralKey: sellerKey,
      counterpartyPubkey: buyerKey.publicKey,
      sellerLocktime: 1_700_000_100,
      buyerLocktime: 1_700_000_000,
      mintUrl: 'https://mint.test',
    }

    await sellerPrepareSwap(ctx, [proof('conditional-proof', 1, 'conditional-keyset')])

    expect(cashuMockState.loadedKeysets.at(-1)?.keys).toEqual({
      1: '02'.padEnd(66, '1'),
    })
  })
})

describe('browser proof operation recovery', () => {
  it('reuses a completed lock operation instead of asking the mint to swap again', async () => {
    const { sellerCtx } = swapContexts('trade-browser-lock')
    const operationId = 'trade-browser-lock/browser/seller-lock'

    await sellerPrepareSwap(sellerCtx, [proof('alice-1', 7)], {
      operationId,
      proofOperationStore,
    })
    await sellerPrepareSwap(sellerCtx, [proof('alice-1', 7)], {
      operationId,
      proofOperationStore,
    })

    expect(cashuMockState.prepareSwapToSendCalls).toBe(1)
    expect(cashuMockState.completeSwapCalls).toBe(1)
  })

  it('restores prepared claim outputs when the mint spent inputs before the browser persisted fresh proofs', async () => {
    const { sellerCtx, buyerCtx } = swapContexts('trade-browser-claim')
    const sellerOut = await sellerPrepareSwap(sellerCtx, [proof('alice-1', 7)])
    const buyerOut = await buyerPrepareSwap(
      buyerCtx,
      sellerOut.adaptorPointCipher,
      sellerOut.lockedProofsCipher,
      [proof('bob-1', 7)],
    )
    const operationId = 'trade-browser-claim/browser/seller-claim'

    cashuMockState.completeSwapError = new Error('network closed after swap')
    await expect(
      sellerClaimSwap(
        sellerCtx,
        sellerOut.adaptorPoint,
        buyerOut.lockedProofsCipher,
        { operationId, proofOperationStore },
      ),
    ).rejects.toThrow(/network closed/)

    cashuMockState.completeSwapError = null
    cashuMockState.proofState = 'SPENT'
    const restored = await sellerClaimSwap(
      sellerCtx,
      sellerOut.adaptorPoint,
      buyerOut.lockedProofsCipher,
      { operationId, proofOperationStore },
    )

    expect(cashuMockState.restoreCalls).toBe(1)
    expect(restored).toEqual([
      expect.objectContaining({
        amount: 7,
        secret: expect.stringMatching(/^restored-/),
      }),
    ])
  })
})

describe('buildReceiveToken', () => {
  it('sets the Cashu unit expected by the swap receive wallet', () => {
    const p = proof('locked-1', 7)
    expect(buildReceiveToken('https://mint.test', [p])).toEqual({
      mint: 'https://mint.test',
      unit: 'sat',
      proofs: [p],
    })
  })
})

function swapContexts(tradeId: string): {
  sellerCtx: SwapContext
  buyerCtx: SwapContext
} {
  const sellerKey = generateEphemeralKeypair()
  const buyerKey = generateEphemeralKeypair()
  const sellerCtx: SwapContext = {
    tradeId,
    role: 'seller',
    ephemeralKey: sellerKey,
    counterpartyPubkey: buyerKey.publicKey,
    sellerLocktime: 1_700_000_100,
    buyerLocktime: 1_700_000_000,
    mintUrl: 'https://mint.test',
  }
  const buyerCtx: SwapContext = {
    ...sellerCtx,
    role: 'buyer',
    ephemeralKey: buyerKey,
    counterpartyPubkey: sellerKey.publicKey,
  }
  return { sellerCtx, buyerCtx }
}

function proof(
  secret: string,
  amount: number,
  id = 'test-keyset',
  C = '02'.padEnd(66, '0'),
): Proof {
  return {
    id,
    amount,
    secret,
    C,
  } as Proof
}
