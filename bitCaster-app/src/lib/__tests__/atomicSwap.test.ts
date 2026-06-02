import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proof } from '@cashu/cashu-ts'
import {
  buildReceiveToken,
  buyerClaimSwap,
  buyerPrepareSwap,
  conditionalKeysetSwap,
  MIN_LOCKTIME_DELTA_SECS,
  sellerClaimSwap,
  sellerLockOutcomeProofs,
  sellerPreparePrelockedSwap,
  sellerPrepareSwap,
  splitProofsForExactSend,
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
import { amountToNumber } from '@bitcaster/client-sdk/proofSelection'

const cashuMockState = vi.hoisted(() => ({
  failNextFeeLookup: false,
  loadedKeysets: [] as Array<{ keys: Record<number, string> }>,
  prepareSwapToSendAmounts: [] as number[],
  prepareSwapToSendConfigs: [] as unknown[],
  prepareSwapToSendCalls: 0,
  prepareSwapToReceiveCalls: 0,
  completeSwapCalls: 0,
  mintSwapCalls: 0,
  restoreCalls: 0,
  sendError: null as Error | null,
  completeSwapError: null as Error | null,
  conditionalSwapError: null as Error | null,
  proofState: 'UNSPENT' as 'UNSPENT' | 'SPENT' | 'PENDING',
  proofAmountAsBigInt: false,
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
    }) as unknown as Proof

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
        new TextDecoder().decode(this.secret) ||
          `restored-${Array.from(this.secret).join('-')}`,
        cashuMockState.proofAmountAsBigInt
          ? (BigInt(this.blindedMessage.amount) as never)
          : Number(this.blindedMessage.amount),
        this.blindedMessage.id,
        signature.C_ ?? '02'.padEnd(66, '9'),
      )
    }

    static createRandomData(
      amount: number,
      keyset: { id: string },
    ): MockOutputData[] {
      return [output(amount, 'random', keyset.id)]
    }

    static createP2PKData(
      p2pk: {
        pubkey: string[]
        requiredSignatures?: number
        locktime?: number
        refundKeys?: string[]
        sigFlag?: string
      },
      amount: number,
      keyset: { id: string },
    ): MockOutputData[] {
      const tags: string[][] = [
        ['n_sigs', String(p2pk.requiredSignatures ?? 1)],
      ]
      if (p2pk.pubkey.length > 1) tags.push(['pubkeys', ...p2pk.pubkey.slice(1)])
      if (p2pk.locktime !== undefined) tags.push(['locktime', String(p2pk.locktime)])
      if (p2pk.refundKeys?.length) tags.push(['refund', ...p2pk.refundKeys])
      if (p2pk.sigFlag) tags.push(['sigflag', p2pk.sigFlag])
      return [
        output(
          amount,
          'p2pk',
          keyset.id,
          JSON.stringify([
            'P2PK',
            {
              nonce: '00'.repeat(32),
              data: p2pk.pubkey[0],
              tags,
            },
          ]),
        ),
      ]
    }
  }
  let outputCounter = 0
  const p2pkSecret = (p2pk: {
    pubkey: string[]
    requiredSignatures?: number
    locktime?: number
    refundKeys?: string[]
    sigFlag?: string
  }) => {
    const tags: string[][] = [['n_sigs', String(p2pk.requiredSignatures ?? 1)]]
    if (p2pk.pubkey.length > 1) tags.push(['pubkeys', ...p2pk.pubkey.slice(1)])
    if (p2pk.locktime !== undefined) tags.push(['locktime', String(p2pk.locktime)])
    if (p2pk.refundKeys?.length) tags.push(['refund', ...p2pk.refundKeys])
    if (p2pk.sigFlag) tags.push(['sigflag', p2pk.sigFlag])
    return JSON.stringify([
      'P2PK',
      {
        nonce: '00'.repeat(32),
        data: p2pk.pubkey[0],
        tags,
      },
    ])
  }
  const output = (
    amount: number,
    group: string,
    keysetId = 'test-keyset',
    secret = `mock-${group}-${outputCounter + 1}`,
  ) =>
    new MockOutputData(
      {
        amount,
        id: keysetId,
        B_: `02${group}${outputCounter++}`.padEnd(66, '0'),
      },
      1n,
      new TextEncoder().encode(secret),
    )
  return {
    ...actual,
    CheckStateEnum: { SPENT: 'SPENT', UNSPENT: 'UNSPENT' },
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
        swap: vi.fn(async ({ outputs }: { outputs: Array<{ amount: number; id: string }> }) => {
          cashuMockState.mintSwapCalls++
          if (cashuMockState.conditionalSwapError) {
            throw cashuMockState.conditionalSwapError
          }
          return {
            signatures: outputs.map((o, index) => ({
              amount: o.amount,
              id: o.id,
              C_: `02swap${index}`.padEnd(66, '9'),
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
        send: vi.fn().mockImplementation(async (_amount: number, proofs: Proof[], _config?: unknown, outputConfig?: any) => {
          if (cashuMockState.sendError) throw cashuMockState.sendError
          const send = outputConfig?.send?.type === 'p2pk'
            ? proofs.map((p) => ({
                ...p,
                secret: p2pkSecret(outputConfig.send.options),
              }))
            : proofs
          return {
            send,
            keep: [],
          }
        }),
        prepareSwapToSend: vi.fn().mockImplementation(
          async (amount: number, proofs: Proof[], config?: { keysetId?: string }, outputConfig?: any) => {
            cashuMockState.prepareSwapToSendCalls++
            cashuMockState.prepareSwapToSendAmounts.push(amount)
            cashuMockState.prepareSwapToSendConfigs.push(config)
            const inputTotal = proofs.reduce(
              (sum, proof) => sum + amountToNumber(proof.amount),
              0,
            )
            const change = Math.max(0, inputTotal - amount)
            const outputKeysetId = config?.keysetId ?? 'test-keyset'
            const sendSecret =
              outputConfig?.send?.type === 'p2pk'
                ? p2pkSecret(outputConfig.send.options)
                : undefined
            return {
              amount,
              fees: 0,
              keysetId: proofs[0]?.id ?? 'test-keyset',
              inputs: proofs,
              sendOutputs: [output(amount, 'send', outputKeysetId, sendSecret)],
              keepOutputs: change > 0 ? [output(change, 'keep', outputKeysetId)] : [],
              unselectedProofs: [],
            }
          },
        ),
        prepareSwapToReceive: vi.fn().mockImplementation(async (token: { proofs: Proof[] }) => {
          cashuMockState.prepareSwapToReceiveCalls++
          const amount = token.proofs.reduce(
            (sum, p) => sum + amountToNumber(p.amount),
            0,
          )
          return {
            amount,
            fees: 0,
            keysetId: token.proofs[0]?.id ?? 'test-keyset',
            inputs: token.proofs,
            keepOutputs: [output(amount, 'keep')],
            unselectedProofs: [],
          }
        }),
        prepareConditionalSwap: vi.fn().mockImplementation(async (options: {
          inputs: Proof[]
          outputs: Array<{
            label: string
            kind: 'random' | 'p2pk'
            amount: number
            p2pk?: {
              pubkey: string[]
              requiredSignatures?: number
              locktime?: number
              refundKeys?: string[]
              sigFlag?: string
            }
          }>
        }) => ({
          keysetId: options.inputs[0]?.id ?? 'conditional-keyset',
          inputs: options.inputs,
          outputDataByLabel: Object.fromEntries(
            options.outputs.map((group) => [
              group.label,
              group.kind === 'p2pk'
                ? MockOutputData.createP2PKData(
                    group.p2pk ?? { pubkey: ['02'.padEnd(66, '2')] },
                    group.amount,
                    { id: options.inputs[0]?.id ?? 'conditional-keyset' },
                  )
                : MockOutputData.createRandomData(
                    group.amount,
                    { id: options.inputs[0]?.id ?? 'conditional-keyset' },
                  ),
            ]),
          ),
        })),
        completeConditionalSwap: vi.fn().mockImplementation(async (preview: {
          outputDataByLabel: Record<string, MockOutputData[]>
        }) => {
          cashuMockState.mintSwapCalls++
          if (cashuMockState.conditionalSwapError) {
            throw cashuMockState.conditionalSwapError
          }
          return Object.fromEntries(
            Object.entries(preview.outputDataByLabel).map(([label, outputs]) => [
              label,
              outputs.map((o, index) =>
                o.toProof({ C_: `02conditional${label}${index}`.padEnd(66, '9') }),
              ),
            ]),
          )
        }),
        completeSwap: vi.fn().mockImplementation(async (preview: {
          sendOutputs?: Array<{
            blindedMessage: { amount: number; id: string }
            toProof?: (signature: { C_?: string }) => Proof
          }>
          keepOutputs?: Array<{
            blindedMessage: { amount: number; id: string }
            toProof?: (signature: { C_?: string }) => Proof
          }>
        }) => {
          cashuMockState.completeSwapCalls++
          if (cashuMockState.completeSwapError) {
            throw cashuMockState.completeSwapError
          }
          return {
            send: (preview.sendOutputs ?? []).map((o, index) =>
              o.toProof
                ? o.toProof({ C_: `02send${index}`.padEnd(66, '9') })
                : makeProof(`send-${index}`, Number(o.blindedMessage.amount), o.blindedMessage.id),
            ),
            keep: (preview.keepOutputs ?? []).map((o, index) =>
              o.toProof
                ? o.toProof({ C_: `02keep${index}`.padEnd(66, '9') })
                : makeProof(`keep-${index}`, Number(o.blindedMessage.amount), o.blindedMessage.id),
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

vi.mock('../../../../cashu-ts/lib/cashu-ts.es.js', () => {
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
    }) as unknown as Proof

  class MockCtfAmount {
    private readonly value: number

    constructor(value: unknown) {
      this.value = Number(value)
    }

    static from(value: unknown): MockCtfAmount {
      return value instanceof MockCtfAmount ? value : new MockCtfAmount(value)
    }

    equals(other: unknown): boolean {
      return this.value === Number(other instanceof MockCtfAmount ? other.value : other)
    }

    isZero(): boolean {
      return this.value === 0
    }

    toNumber(): number {
      return this.value
    }

    toString(): string {
      return String(this.value)
    }

    toJSON(): number {
      return this.value
    }
  }

  class MockCtfOutputData {
    blindedMessage: { amount: MockCtfAmount; id: string; B_: string }
    blindingFactor: bigint
    secret: Uint8Array

    constructor(
      blindedMessage: { amount: unknown; id: string; B_: string },
      blindingFactor: bigint,
      secret: Uint8Array,
    ) {
      if (typeof (blindedMessage.amount as { isZero?: unknown })?.isZero !== 'function') {
        throw new TypeError('amount.isZero is not a function')
      }
      this.blindedMessage = {
        ...blindedMessage,
        amount: MockCtfAmount.from(blindedMessage.amount),
      }
      this.blindingFactor = blindingFactor
      this.secret = secret
    }

    toProof(signature: { C_?: string }): Proof {
      return makeProof(
        new TextDecoder().decode(this.secret) ||
          `restored-${Array.from(this.secret).join('-')}`,
        this.blindedMessage.amount.toNumber(),
        this.blindedMessage.id,
        signature.C_ ?? '02'.padEnd(66, '9'),
      )
    }

    static createRandomData(
      amount: MockCtfAmount,
      keyset: { id: string },
    ): MockCtfOutputData[] {
      if (typeof amount?.isZero !== 'function') {
        throw new TypeError('amount.isZero is not a function')
      }
      return [ctfOutput(amount, 'random', keyset.id)]
    }

    static createP2PKData(
      p2pk: {
        pubkey: string[]
        requiredSignatures?: number
        locktime?: number
        refundKeys?: string[]
        sigFlag?: string
      },
      amount: MockCtfAmount,
      keyset: { id: string },
    ): MockCtfOutputData[] {
      if (typeof amount?.isZero !== 'function') {
        throw new TypeError('amount.isZero is not a function')
      }
      const tags: string[][] = [
        ['n_sigs', String(p2pk.requiredSignatures ?? 1)],
      ]
      if (p2pk.pubkey.length > 1) tags.push(['pubkeys', ...p2pk.pubkey.slice(1)])
      if (p2pk.locktime !== undefined) tags.push(['locktime', String(p2pk.locktime)])
      if (p2pk.refundKeys?.length) tags.push(['refund', ...p2pk.refundKeys])
      if (p2pk.sigFlag) tags.push(['sigflag', p2pk.sigFlag])
      return [
        ctfOutput(
          amount,
          'p2pk',
          keyset.id,
          JSON.stringify([
            'P2PK',
            {
              nonce: '00'.repeat(32),
              data: p2pk.pubkey[0],
              tags,
            },
          ]),
        ),
      ]
    }
  }

  let outputCounter = 0
  const ctfOutput = (
    amount: MockCtfAmount,
    group: string,
    keysetId = 'test-keyset',
    secret = `mock-ctf-${group}-${outputCounter + 1}`,
  ) =>
    new MockCtfOutputData(
      {
        amount,
        id: keysetId,
        B_: `02ctf${group}${outputCounter++}`.padEnd(66, '0'),
      },
      1n,
      new TextEncoder().encode(secret),
    )

  return {
    Amount: MockCtfAmount,
    Mint: vi.fn(function MockCtfMint() {
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
        restore: vi.fn(async ({ outputs }: { outputs: Array<{ amount: unknown; id: string }> }) => {
          cashuMockState.restoreCalls++
          return {
            outputs,
            signatures: outputs.map((o, index) => ({
              amount: MockCtfAmount.from(o.amount),
              id: o.id,
              C_: `02restored${index}`.padEnd(66, '9'),
            })),
          }
        }),
        swap: vi.fn(async ({ outputs }: { outputs: Array<{ amount: unknown; id: string }> }) => {
          cashuMockState.mintSwapCalls++
          if (cashuMockState.conditionalSwapError) {
            throw cashuMockState.conditionalSwapError
          }
          return {
            signatures: outputs.map((o, index) => ({
              amount: MockCtfAmount.from(o.amount),
              id: o.id,
              C_: `02swap${index}`.padEnd(66, '9'),
            })),
          }
        }),
      }
    }),
    OutputData: MockCtfOutputData,
    Wallet: vi.fn(function MockCtfWallet() {
      return {
        checkProofsStates: vi.fn().mockImplementation(async (proofs: Proof[]) =>
          proofs.map((p) => ({
            Y: p.secret,
            state: cashuMockState.proofState,
            witness: null,
          })),
        ),
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
  cashuMockState.prepareSwapToSendAmounts.length = 0
  cashuMockState.prepareSwapToSendConfigs.length = 0
  cashuMockState.prepareSwapToSendCalls = 0
  cashuMockState.prepareSwapToReceiveCalls = 0
  cashuMockState.completeSwapCalls = 0
  cashuMockState.mintSwapCalls = 0
  cashuMockState.restoreCalls = 0
  cashuMockState.sendError = null
  cashuMockState.completeSwapError = null
  cashuMockState.conditionalSwapError = null
  cashuMockState.proofState = 'UNSPENT'
  cashuMockState.proofAmountAsBigInt = false
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

  it('does not receive seller local proof metadata from prelocked openings', async () => {
    const { sellerCtx, buyerCtx } = swapContexts('trade-prelocked-metadata')
    const sellerOut = await sellerPreparePrelockedSwap(sellerCtx, [
      {
        ...p2pkLockedProof('alice-prelocked', 7, sellerCtx),
        reservedBy: 'order-preflight:local-only',
        marketId: 'condition-YES',
      } as unknown as Proof & { reservedBy: string; marketId: string },
    ])

    const buyerOut = await buyerPrepareSwap(
      buyerCtx,
      sellerOut.adaptorPointCipher,
      sellerOut.lockedProofsCipher,
      [proof('bob-1', 7)],
    )

    const sharedKey = await deriveEncryptionKey(
      computeSharedSecret(buyerCtx.ephemeralKey.privateKey, sellerCtx.ephemeralKey.publicKey),
    )
    const sellerLockedPlain = await decrypt(sharedKey, sellerOut.lockedProofsCipher)
    const sellerLocked = JSON.parse(sellerLockedPlain) as {
      proofs: Array<Proof & { reservedBy?: string; marketId?: string }>
    }
    expect(sellerLocked.proofs[0].reservedBy).toBeUndefined()
    expect(sellerLocked.proofs[0].marketId).toBeUndefined()
    expect(buyerOut.sellerPreSigsHex).toHaveLength(1)
  })

  it('rejects raw outcome proofs passed to the prelocked seller opening', async () => {
    const { sellerCtx } = swapContexts('trade-prelocked-raw-proof')

    await expect(
      sellerPreparePrelockedSwap(sellerCtx, [proof('raw-outcome-proof', 100)]),
    ).rejects.toThrow(/requires P2PK-locked proofs/i)
  })
})

describe('conditionalKeysetSwap', () => {
  it('mints every output on the source conditional keyset and persists the operation', async () => {
    const outputs = await conditionalKeysetSwap(
      'https://mint.test',
      [proof('conditional-source', 136, 'conditional-keyset')],
      [
        { label: 'lock', kind: 'random', amount: 100 },
        { label: 'change', kind: 'random', amount: 36 },
      ],
      {
        operationId: 'trade-conditional/browser/conditional-keyset-swap',
        proofOperationStore,
      },
    )

    expect(outputs.lock).toEqual([
      expect.objectContaining({ amount: 100, id: 'conditional-keyset' }),
    ])
    expect(outputs.change).toEqual([
      expect.objectContaining({ amount: 36, id: 'conditional-keyset' }),
    ])
    expect(cashuMockState.mintSwapCalls).toBe(1)
    expect(
      proofDbMockState.operations.get(
        'trade-conditional/browser/conditional-keyset-swap',
      ),
    ).toEqual(
      expect.objectContaining({
        kind: 'conditional-keyset-swap',
        state: 'completed',
        resultProofs: outputs,
      }),
    )
  })

  it('normalizes cashu-ts BigInt proof amounts before persisting operations', async () => {
    cashuMockState.proofAmountAsBigInt = true

    const outputs = await conditionalKeysetSwap(
      'https://mint.test',
      [proof('conditional-source', 136, 'conditional-keyset')],
      [
        { label: 'lock', kind: 'random', amount: 100 },
        { label: 'change', kind: 'random', amount: 36 },
      ],
      {
        operationId: 'trade-conditional/browser/bigint-proof-amount',
        proofOperationStore,
      },
    )

    expect(outputs.lock?.[0]?.amount).toBe(100)
    expect(outputs.change?.[0]?.amount).toBe(36)
    expect(() =>
      JSON.stringify(
        proofDbMockState.operations.get(
          'trade-conditional/browser/bigint-proof-amount',
        )?.resultProofs,
      ),
    ).not.toThrow()
  })

  it('restores prepared conditional outputs when inputs are already spent', async () => {
    await expect(
      conditionalKeysetSwap(
        'https://mint.test',
        [proof('conditional-source', 136, 'conditional-keyset')],
        [
          { label: 'lock', kind: 'random', amount: 100 },
          { label: 'change', kind: 'random', amount: 36 },
        ],
        {
          operationId: 'trade-conditional/browser/restore',
          proofOperationStore,
        },
      ),
    ).resolves.toBeTruthy()
    const prepared = proofDbMockState.operations.get(
      'trade-conditional/browser/restore',
    )
    proofDbMockState.operations.set('trade-conditional/browser/restore', {
      ...prepared,
      state: 'prepared',
      resultProofs: undefined,
    })
    cashuMockState.mintSwapCalls = 0
    cashuMockState.proofState = 'SPENT'

    const restored = await conditionalKeysetSwap(
      'https://mint.test',
      [proof('conditional-source', 136, 'conditional-keyset')],
      [
        { label: 'lock', kind: 'random', amount: 100 },
        { label: 'change', kind: 'random', amount: 36 },
      ],
      {
        operationId: 'trade-conditional/browser/restore',
        proofOperationStore,
      },
    )

    expect(cashuMockState.mintSwapCalls).toBe(0)
    expect(cashuMockState.restoreCalls).toBe(1)
    expect(restored.lock).toEqual([
      expect.objectContaining({ amount: 100, id: 'conditional-keyset' }),
    ])
  })
})

describe('sellerLockOutcomeProofs', () => {
  it('locks the requested amount and returns unlocked conditional-keyset change', async () => {
    const { sellerCtx } = swapContexts('trade-seller-lock-outcome')

    const locked = await sellerLockOutcomeProofs(
      sellerCtx,
      [proof('outcome-136', 136, 'conditional-keyset')],
      100,
      {
        operationId: 'trade-seller-lock-outcome/browser/seller-inventory-lock',
        proofOperationStore,
      },
    )

    expect(locked.lockedProofs).toEqual([
      expect.objectContaining({
        amount: 100,
        id: 'conditional-keyset',
        secret: expect.stringContaining('"P2PK"'),
      }),
    ])
    expect(locked.changeProofs).toEqual([
      expect.objectContaining({
        amount: 36,
        id: 'conditional-keyset',
        secret: expect.stringContaining('random'),
      }),
    ])
    await expect(
      sellerPreparePrelockedSwap(sellerCtx, locked.lockedProofs),
    ).resolves.toEqual(
      expect.objectContaining({
        lockedProofs: locked.lockedProofs,
      }),
    )
  })
})

describe('buyerClaimSwap', () => {
  it('refreshes witnessed conditional proofs with a same-keyset claim swap', async () => {
    const { sellerCtx, buyerCtx } = swapContexts('trade-browser-conditional-claim')
    const sellerOut = await sellerPrepareSwap(sellerCtx, [proof('alice-1', 7)])
    const buyerOut = await buyerPrepareSwap(
      buyerCtx,
      sellerOut.adaptorPointCipher,
      sellerOut.lockedProofsCipher,
      [proof('bob-1', 7)],
    )
    const operationId = 'trade-browser-conditional-claim/browser/buyer-claim'

    const claimed = await buyerClaimSwap(
      buyerCtx,
      sellerOut.adaptorPoint.secret,
      sellerOut.lockedProofsCipher,
      buyerOut.sellerPreSigsHex,
      { operationId, proofOperationStore },
    )

    expect(claimed).toEqual([
      expect.objectContaining({
        amount: 7,
        id: 'test-keyset',
        secret: expect.any(String),
      }),
    ])
    expect(claimed[0].witness).toBeUndefined()
    expect(cashuMockState.mintSwapCalls).toBe(1)
    expect(proofDbMockState.operations.get(operationId)).toEqual(
      expect.objectContaining({
        state: 'completed',
        resultProofs: { keep: claimed },
      }),
    )
  })

  it('fails loudly when the mint rejects same-keyset conditional refresh', async () => {
    const { sellerCtx, buyerCtx } = swapContexts('trade-browser-conditional-claim-fallback')
    const sellerOut = await sellerPrepareSwap(sellerCtx, [proof('alice-1', 7)])
    const buyerOut = await buyerPrepareSwap(
      buyerCtx,
      sellerOut.adaptorPointCipher,
      sellerOut.lockedProofsCipher,
      [proof('bob-1', 7)],
    )
    cashuMockState.conditionalSwapError = new Error(
      'Inputs must use the same conditional keyset',
    )

    await expect(
      buyerClaimSwap(
        buyerCtx,
        sellerOut.adaptorPoint.secret,
        sellerOut.lockedProofsCipher,
        buyerOut.sellerPreSigsHex,
        {
          operationId: 'trade-browser-conditional-claim-fallback/browser/buyer-claim',
          proofOperationStore,
        },
      ),
    ).rejects.toThrow('Inputs must use the same conditional keyset')
  })

  it('restores a spent first keyset leg and completes the remaining leg on retry', async () => {
    const { sellerCtx, buyerCtx } = swapContexts('trade-browser-multi-claim')
    const sellerOut = await sellerPreparePrelockedSwap(sellerCtx, [
      p2pkLockedProof('alice-B', 7, sellerCtx, 'keyset-B'),
      p2pkLockedProof('alice-C', 7, sellerCtx, 'keyset-C'),
    ])
    const buyerOut = await buyerPrepareSwap(
      buyerCtx,
      sellerOut.adaptorPointCipher,
      sellerOut.lockedProofsCipher,
      [proof('bob-1', 14)],
    )
    const operationId = 'trade-browser-multi-claim/browser/buyer-claim'

    cashuMockState.conditionalSwapError = new Error('network closed after first leg')
    await expect(
      buyerClaimSwap(
        buyerCtx,
        sellerOut.adaptorPoint.secret,
        sellerOut.lockedProofsCipher,
        buyerOut.sellerPreSigsHex,
        { operationId, proofOperationStore },
      ),
    ).rejects.toThrow(/network closed/)

    const keysetBOperation = `${operationId}/keyset/keyset-B`
    expect(proofDbMockState.operations.get(keysetBOperation)).toEqual(
      expect.objectContaining({ state: 'prepared' }),
    )

    cashuMockState.conditionalSwapError = null
    cashuMockState.proofState = 'SPENT'
    const claimed = await buyerClaimSwap(
      buyerCtx,
      sellerOut.adaptorPoint.secret,
      sellerOut.lockedProofsCipher,
      buyerOut.sellerPreSigsHex,
      { operationId, proofOperationStore },
    )

    expect(cashuMockState.restoreCalls).toBe(1)
    expect(proofDbMockState.operations.get(keysetBOperation)).toEqual(
      expect.objectContaining({ state: 'completed' }),
    )
    expect(
      proofDbMockState.operations.get(`${operationId}/keyset/keyset-C`),
    ).toEqual(expect.objectContaining({ state: 'completed' }))
    expect(claimed).toEqual([
      expect.objectContaining({ id: 'keyset-B', amount: 7 }),
      expect.objectContaining({ id: 'keyset-C', amount: 7 }),
    ])
  })
})

describe('splitProofsForExactSend', () => {
  it('splits an oversized reserved proof into exact send proofs and change', async () => {
    const split = await splitProofsForExactSend({
      mintUrl: 'https://mint.test',
      sourceProofs: [proof('reserved-no-136', 136)],
      amountSats: 100,
      operationId: 'trade-browser-preflight-overpay/browser/preflight-lock-exact',
      proofOperationStore,
    })

    expect(cashuMockState.prepareSwapToSendAmounts).toEqual([100])
    expect(split.sendProofs).toEqual([
      expect.objectContaining({ amount: 100 }),
    ])
    expect(split.changeProofs).toEqual([
      expect.objectContaining({ amount: 36 }),
    ])
    expect(split.spentProofs).toEqual([
      expect.objectContaining({ secret: 'reserved-no-136' }),
    ])
  })

  it('preserves the conditional keyset when exact-splitting CTF outcome proofs', async () => {
    const split = await splitProofsForExactSend({
      mintUrl: 'https://mint.test',
      sourceProofs: [
        {
          ...proof('reserved-no-136', 136, 'conditional-keyset'),
          conditionId: 'condition-1',
          outcomeCollection: 'NO',
        } as unknown as Proof,
      ],
      amountSats: 100,
      operationId: 'trade-browser-preflight-overpay/browser/preflight-lock-exact-v2',
      proofOperationStore,
    })

    expect(cashuMockState.prepareSwapToSendConfigs).toEqual([])
    expect(cashuMockState.mintSwapCalls).toBe(1)
    expect(split.sendProofs).toEqual([
      expect.objectContaining({ amount: 100, id: 'conditional-keyset' }),
    ])
    expect(split.changeProofs).toEqual([
      expect.objectContaining({ amount: 36, id: 'conditional-keyset' }),
    ])
  })

  it('fails closed when regular proof fees cannot be calculated from loaded keysets', async () => {
    cashuMockState.failNextFeeLookup = true

    await expect(
      splitProofsForExactSend({
        mintUrl: 'https://mint.test',
        sourceProofs: [proof('regular-e2e-seed', 210, 'keyset-00')],
        amountSats: 100,
        operationId: 'trade-browser-regular-preflight/browser/preflight-lock-exact-v2',
        proofOperationStore,
      }),
    ).rejects.toThrow("Keyset 'conditional-keyset' not found")
    expect(cashuMockState.mintSwapCalls).toBe(0)
  })
})

describe('sellerPrepareSwap', () => {
  it('surfaces mint errors when regular direct locking fails', async () => {
    cashuMockState.sendError = new Error('Inputs must use the same conditional keyset')

    const sellerKey = generateEphemeralKeypair()
    const buyerKey = generateEphemeralKeypair()
    const ctx: SwapContext = {
      tradeId: 'trade-direct-ctf-unsupported',
      role: 'seller',
      ephemeralKey: sellerKey,
      counterpartyPubkey: buyerKey.publicKey,
      sellerLocktime: 1_700_000_100,
      buyerLocktime: 1_700_000_000,
      mintUrl: 'https://mint.test',
    }

    await expect(
      sellerPrepareSwap(ctx, [proof('regular-proof', 1)]),
    ).rejects.toThrow(/Inputs must use the same conditional keyset/)
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
        secret: expect.any(String),
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
  } as unknown as Proof
}

function p2pkLockedProof(
  label: string,
  amount: number,
  ctx: SwapContext,
  id = 'test-keyset',
): Proof {
  return proof(
    JSON.stringify([
      'P2PK',
      {
        nonce: label,
        data: ctx.ephemeralKey.publicKey,
        tags: [
          ['pubkeys', ctx.counterpartyPubkey],
          ['n_sigs', '2'],
          ['locktime', String(ctx.sellerLocktime)],
          ['refund', ctx.ephemeralKey.publicKey],
          ['sigflag', 'SIG_INPUTS'],
        ],
      },
    ]),
    amount,
    id,
  )
}
