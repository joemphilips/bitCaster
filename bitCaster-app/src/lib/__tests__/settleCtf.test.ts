import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Proof } from '@cashu/cashu-ts'

// ---------------------------------------------------------------------------
// Mock state (hoisted so the vi.mock factories can close over it)
// ---------------------------------------------------------------------------

const proofDbState = vi.hoisted(() => ({
  store: new Map<string, any>(),
  operations: new Map<string, any>(),
  addedProofs: [] as any[],
  removedSecrets: [] as string[],
}))

const cashuState = vi.hoisted(() => ({
  // outcome collections the mint considers winning, keyed by keyset id.
  // A redeem for a keyset NOT in this set throws OracleNotAttestedOutcome.
  winningKeysets: new Set<string>(),
  redeemCalls: [] as Array<{ inputs: Proof[] }>,
  transientFailKeysets: new Set<string>(),
}))

// ---------------------------------------------------------------------------
// proof-db mock — in-memory, records adds/removes + op ledger
// ---------------------------------------------------------------------------

vi.mock('@/stores/proof-db', () => {
  return {
    addProofs: vi.fn(async (proofs: any[]) => {
      for (const p of proofs) {
        proofDbState.addedProofs.push(p)
        proofDbState.store.set(p.secret, p)
      }
    }),
    removeProofs: vi.fn(async (secrets: string[]) => {
      for (const s of secrets) {
        proofDbState.removedSecrets.push(s)
        proofDbState.store.delete(s)
      }
    }),
    getProofOperation: vi.fn(async (operationId: string) => {
      return proofDbState.operations.get(operationId) ?? null
    }),
    prepareProofOperation: vi.fn(async (input: any) => {
      const existing = proofDbState.operations.get(input.operationId)
      if (existing) return existing
      const record = {
        ...input,
        state: 'prepared',
        metadata: input.metadata ?? {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      proofDbState.operations.set(input.operationId, record)
      return record
    }),
    markProofOperationCompleted: vi.fn(
      async (operationId: string, resultProofs: any) => {
        const existing = proofDbState.operations.get(operationId)
        const updated = { ...existing, state: 'completed', resultProofs }
        proofDbState.operations.set(operationId, updated)
        return updated
      },
    ),
    markProofOperationFailed: vi.fn(
      async (operationId: string, error: unknown) => {
        const existing = proofDbState.operations.get(operationId)
        const updated = {
          ...existing,
          state: 'failed',
          lastError: error instanceof Error ? error.message : String(error),
        }
        proofDbState.operations.set(operationId, updated)
        return updated
      },
    ),
  }
})

// ---------------------------------------------------------------------------
// cashu-ts mock — only the surface settleCtfPosition touches
// ---------------------------------------------------------------------------

vi.mock('@cashu/cashu-ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cashu/cashu-ts')>()

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
      return {
        id: this.blindedMessage.id,
        amount: this.blindedMessage.amount,
        secret: new TextDecoder().decode(this.secret),
        C: signature.C_ ?? '02'.padEnd(66, '9'),
      } as unknown as Proof
    }
    static createRandomData(
      amount: { value: bigint } | number,
      keyset: { id: string },
    ): MockOutputData[] {
      const value = typeof amount === 'number' ? amount : Number(amount.value)
      return [
        new MockOutputData(
          { amount: value, id: keyset.id, B_: '02'.padEnd(66, '0') },
          1n,
          new TextEncoder().encode(`regular-${keyset.id}-${value}`),
        ),
      ]
    }
  }

  class MockMint {
    url: string
    constructor(url: string) {
      this.url = url
    }
    async getKeys() {
      return {
        keysets: [
          {
            id: 'regular-keyset',
            unit: 'sat',
            active: true,
            keys: { 1: '02'.padEnd(66, '1') },
          },
        ],
      }
    }
    async getInfo() {
      return { name: 'mock', nuts: {} }
    }
  }

  class MockWallet {
    mint: MockMint
    constructor(mint: MockMint) {
      this.mint = mint
    }
    async loadMint() {}
    async redeemOutcomeProofs({
      inputs,
      outputs,
    }: {
      inputs: Proof[]
      outputs: MockOutputData[]
    }): Promise<Proof[]> {
      cashuState.redeemCalls.push({ inputs })
      const keysetId = inputs[0]?.id ?? ''
      if (cashuState.transientFailKeysets.has(keysetId)) {
        throw new Error('network timeout while contacting mint')
      }
      if (!cashuState.winningKeysets.has(keysetId)) {
        throw new Error('OracleNotAttestedOutcome')
      }
      return outputs.map((o) =>
        o.toProof({ C_: '02'.padEnd(66, '7') }),
      )
    }
  }

  return {
    ...actual,
    CheckStateEnum: { SPENT: 'SPENT', UNSPENT: 'UNSPENT' },
    OutputData: MockOutputData,
    Mint: MockMint,
    Wallet: MockWallet,
  }
})

// Wallet store: no mnemonic → getWallet uses the fallback CashuWallet path.
vi.mock('@/stores/wallet', () => ({
  useWalletStore: {
    getState: () => ({ mnemonic: undefined, activeMintUrl: 'http://mint.test' }),
  },
}))

const CONDITION_ID = 'a'.repeat(64)

function makeProof(
  secret: string,
  amount: number,
  keysetId: string,
  outcomeCollection: string,
): Proof {
  return {
    id: keysetId,
    amount,
    secret,
    C: '02'.padEnd(66, '0'),
    outcomeCollection,
  } as unknown as Proof
}

function mockAttestation(attestedOutcome: string): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes(`/conditions/${CONDITION_ID}/attestation`)) {
      return new Response(
        JSON.stringify({
          conditionId: CONDITION_ID,
          attestedOutcome,
          oracleWitness: { oracle_sig: 'deadbeef' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    throw new Error(`unexpected fetch ${url}`)
  }) as never
}

describe('settleCtfPosition — per-keyset redeem', () => {
  let originalFetch: typeof globalThis.fetch

  beforeEach(() => {
    originalFetch = globalThis.fetch
    proofDbState.store.clear()
    proofDbState.operations.clear()
    proofDbState.addedProofs.length = 0
    proofDbState.removedSecrets.length = 0
    cashuState.winningKeysets.clear()
    cashuState.transientFailKeysets.clear()
    cashuState.redeemCalls.length = 0
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('composite "A|B" stored per-primitive: redeems A leg, removes B leg without a mint call', async () => {
    // 3-outcome market A/B/C; taker holds composite "A|B" across keysets A and B.
    // Stored per-primitive: A-keyset proof labelled "A", B-keyset proof labelled "B".
    cashuState.winningKeysets.add('keyset-A')
    mockAttestation('A')
    const { settleCtfPosition } = await import('@/lib/cashu')

    const proofs = [
      makeProof('sA', 100, 'keyset-A', 'A'),
      makeProof('sB', 100, 'keyset-B', 'B'),
    ]
    const regular = await settleCtfPosition({
      conditionId: CONDITION_ID,
      amountSats: 200,
      proofs,
      mintUrl: 'http://mint.test',
    })

    // A leg redeemed → 100 sats credited. B leg never hits the mint.
    expect(regular.reduce((s, p) => s + Number(p.amount), 0)).toBe(100)
    expect(cashuState.redeemCalls).toHaveLength(1)
    expect(cashuState.redeemCalls[0].inputs[0].id).toBe('keyset-A')
    // Both legs removed locally (A spent, B discarded).
    expect(proofDbState.removedSecrets.sort()).toEqual(['sA', 'sB'])
  })

  it('composite "A|B" stored under composite label: B leg attempted then removed terminally, no error', async () => {
    // Composite-label storage: BOTH legs carry label "A|B" → both look like winners.
    // The B-keyset redeem fails terminally at the mint; we remove it silently.
    cashuState.winningKeysets.add('keyset-A')
    mockAttestation('A')
    const { settleCtfPosition } = await import('@/lib/cashu')

    const proofs = [
      makeProof('sA', 100, 'keyset-A', 'A|B'),
      makeProof('sB', 100, 'keyset-B', 'A|B'),
    ]
    const regular = await settleCtfPosition({
      conditionId: CONDITION_ID,
      amountSats: 200,
      proofs,
      mintUrl: 'http://mint.test',
    })

    expect(regular.reduce((s, p) => s + Number(p.amount), 0)).toBe(100)
    // Both keysets were attempted at the mint (composite label can't pre-classify).
    expect(cashuState.redeemCalls).toHaveLength(2)
    // Both legs removed locally; losing leg surfaced NO error (resolved fine).
    expect(proofDbState.removedSecrets.sort()).toEqual(['sA', 'sB'])
    const losingOp = Array.from(proofDbState.operations.values()).find(
      (op) => op.metadata?.keysetId === 'keyset-B',
    )
    expect(losingOp?.state).toBe('failed')
  })

  it('singular "A" maker claim still redeems the single keyset', async () => {
    cashuState.winningKeysets.add('keyset-A')
    mockAttestation('A')
    const { settleCtfPosition } = await import('@/lib/cashu')

    const proofs = [makeProof('sA', 150, 'keyset-A', 'A')]
    const regular = await settleCtfPosition({
      conditionId: CONDITION_ID,
      amountSats: 150,
      proofs,
      mintUrl: 'http://mint.test',
    })

    expect(regular.reduce((s, p) => s + Number(p.amount), 0)).toBe(150)
    expect(cashuState.redeemCalls).toHaveLength(1)
    expect(proofDbState.removedSecrets).toEqual(['sA'])
  })

  it('transient failure on a winning leg rethrows and leaves the op resumable (prepared)', async () => {
    cashuState.winningKeysets.add('keyset-A')
    cashuState.transientFailKeysets.add('keyset-A')
    mockAttestation('A')
    const { settleCtfPosition } = await import('@/lib/cashu')

    const proofs = [makeProof('sA', 100, 'keyset-A', 'A')]
    await expect(
      settleCtfPosition({
        conditionId: CONDITION_ID,
        amountSats: 100,
        proofs,
        mintUrl: 'http://mint.test',
      }),
    ).rejects.toThrow(/network timeout/)

    // Winning-leg transient failure must NOT mark the op failed (would block
    // resume) and must NOT remove the still-valuable proofs.
    const op = Array.from(proofDbState.operations.values())[0]
    expect(op.state).toBe('prepared')
    expect(proofDbState.removedSecrets).toEqual([])
  })
})
