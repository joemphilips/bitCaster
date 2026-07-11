import { beforeEach, describe, expect, it, vi } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import type { ActiveSwap } from '../activeSwaps'

const rows = new Map<string, Record<string, unknown>>()
const proofOperations = new Map<string, Record<string, unknown>>()
const transactionTables: unknown[][] = []
let storageOpenError: Error | null = null

vi.mock('../proof-db', () => ({
  ensureDurableSwapStorage: async () => {
    if (storageOpenError) {
      throw new Error(
        `Durable swap storage is unavailable: ${storageOpenError.message}`,
      )
    }
  },
  prepareProofOperation: async (input: {
    operationId: string
    kind: string
    mintUrl: string
    inputs: unknown[]
    outputs: Record<string, unknown>
  }) => {
    const record = {
      ...input,
      state: 'prepared',
      metadata: {},
      createdAt: 1,
      updatedAt: 1,
    }
    proofOperations.set(input.operationId, record)
    return record
  },
  markProofOperationCompleted: async (
    operationId: string,
    resultProofs: Record<string, unknown[]>,
  ) => {
    const existing = proofOperations.get(operationId) ?? { operationId }
    const record = { ...existing, state: 'completed', resultProofs }
    proofOperations.set(operationId, record)
    return record
  },
  db: {
    open: async () => {
      if (storageOpenError) throw storageOpenError
    },
    transaction: async (...args: unknown[]) => {
      transactionTables.push(args.slice(1, -1))
      return (args.at(-1) as () => Promise<unknown>)()
    },
    swapSessions: {
      get: async (tradeId: string) => rows.get(tradeId),
      put: async (row: { tradeId: string }) => {
        rows.set(row.tradeId, row as Record<string, unknown>)
      },
      toArray: async () => Array.from(rows.values()),
      delete: async (tradeId: string) => {
        rows.delete(tradeId)
      },
    },
    proofOperations: {
      get: async (operationId: string) => proofOperations.get(operationId),
      where: (field: string) => ({
        equals: (value: string) => ({
          first: async () =>
            Array.from(proofOperations.values()).find(
              (operation) => operation[field] === value,
            ),
          toArray: async () =>
            Array.from(proofOperations.values()).filter(
              (operation) => operation[field] === value,
            ),
        }),
      }),
      put: async (row: { operationId: string }) => {
        proofOperations.set(row.operationId, row as Record<string, unknown>)
      },
      toArray: async () => Array.from(proofOperations.values()),
    },
  },
}))

import {
  MAX_ACTIVE_GUI_SWAP_SESSIONS,
  loadRecoverableGuiSwapSessions,
  prepareGuiProofOperationWithSession,
  completeGuiProofOperationWithSession,
  recoverGuiDurableTradeSession,
  persistGuiSwapSession,
  removeGuiSwapSession,
  resumeGuiSwapSession,
  withGuiSwapSessionOwnership,
} from '../swap-session-db'

function swap(overrides: Partial<ActiveSwap> = {}): ActiveSwap {
  const ephemeralPrivkeyHex = '01'.repeat(32)
  const ephemeralPubkeyHex = Array.from(
    secp256k1.getPublicKey(new Uint8Array(32).fill(1), true),
  )
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')
  return {
    tradeId: 'trade-001',
    orderId: 'order-001',
    marketId: 'condition-YES',
    ephemeralPrivkeyHex,
    ephemeralPubkeyHex,
    role: 'seller',
    counterpartyPubkey: `03${'b'.repeat(64)}`,
    sellerLocktime: 120,
    buyerLocktime: 100,
    outcomeFaceAmountSats: null,
    outcomeFaceAmountSubunits: null,
    quotePaymentSats: null,
    baseAsset: 'sat',
    divisibility: 10_000,
    quotePaymentSubunits: null,
    settlementKind: 'DirectSwap',
    sellerKeepOutcomeSetId: null,
    sellerLockOutcomeSetId: null,
    step: 'awaiting-counterparty',
    messages: {},
    sellerState: null,
    buyerState: null,
    inFlightSteps: {},
    error: null,
    startedAt: 1,
    ...overrides,
  }
}

beforeEach(() => {
  rows.clear()
  proofOperations.clear()
  transactionTables.length = 0
  storageOpenError = null
})

async function withWebLocks<T>(action: () => Promise<T>): Promise<T> {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async (
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ) => callback(),
    },
  })
  try {
    return await action()
  } finally {
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: undefined,
      })
  }
}

describe('GUI durable swap session repository', () => {
  it('persists and hydrates a protocol-bound GUI session', async () => {
    const active = swap()
    await persistGuiSwapSession(active, 'https://mint.example')

    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([active])
  })

  it('serializes repeated writes through a monotonic session revision', async () => {
    await persistGuiSwapSession(swap(), 'https://mint.example')
    await persistGuiSwapSession(
      swap({ step: 'driving' }),
      'https://mint.example',
    )

    const row = rows.get('trade-001') as { session: { revision: number } }
    expect(row.session.revision).toBe(1)
  })

  it('refuses a row whose GUI payload no longer matches its persisted protocol binding', async () => {
    await persistGuiSwapSession(swap(), 'https://mint.example')
    const row = rows.get('trade-001') as {
      adapterState: ActiveSwap
    }
    row.adapterState = {
      ...row.adapterState,
      counterpartyPubkey: `02${'c'.repeat(64)}`,
    }

    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([])
  })

  it('refuses a row whose private key no longer matches its protocol public key', async () => {
    await persistGuiSwapSession(swap(), 'https://mint.example')
    const row = rows.get('trade-001') as { adapterState: ActiveSwap }
    row.adapterState = {
      ...row.adapterState,
      ephemeralPrivkeyHex: '02'.repeat(32),
    }

    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([])
  })

  it('removes only a successful terminal session after proof reconciliation', async () => {
    await persistGuiSwapSession(
      swap({ step: 'completed' }),
      'https://mint.example',
    )
    await expect(loadRecoverableGuiSwapSessions()).resolves.toEqual([])
    await removeGuiSwapSession('trade-001')
    expect(rows.has('trade-001')).toBe(false)
  })

  it('fails closed when Web Locks are unavailable', async () => {
    const result = await withGuiSwapSessionOwnership(
      'trade-001',
      async () => 'owned',
    )

    expect(result).toBeNull()
  })

  it('uses an exclusive per-trade Web Lock before durable recovery work', async () => {
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    const request = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        action: () => Promise<string>,
      ) => action(),
    )
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request },
    })

    try {
      await expect(
        withGuiSwapSessionOwnership('trade-001', async () => 'owned'),
      ).resolves.toBe('owned')
      expect(request).toHaveBeenCalledWith(
        'bitcaster-swap:trade-001',
        { mode: 'exclusive' },
        expect.any(Function),
      )
    } finally {
      if (originalLocks)
        Object.defineProperty(navigator, 'locks', originalLocks)
      else
        Object.defineProperty(navigator, 'locks', {
          configurable: true,
          value: undefined,
        })
    }
  })

  it('co-commits the prepared proof operation and durable swap session', async () => {
    await prepareGuiProofOperationWithSession(
      {
        operationId: 'trade-001/browser/buyer-lock',
        kind: 'swap-lock',
        mintUrl: 'https://mint.example',
        inputs: [],
        outputs: {},
      },
      swap(),
    )

    const operation = proofOperations.get('trade-001/browser/buyer-lock') as {
      durableOperationId?: string
      durableTradeRecovery?: { operationKey: string; state: string }
    }
    const session = (
      rows.get('trade-001') as {
        session: {
          stage: string
          proofOperations: Array<{ operationKey: string; state: string }>
        }
      }
    ).session

    expect(operation.durableTradeRecovery).toMatchObject({
      operationKey: 'trade-001/browser/buyer-lock',
      state: 'prepared',
    })
    expect(operation.durableOperationId).toBe(
      'trade-recovery:trade-001:seller:proof-reservation:trade-001%2Fbrowser%2Fbuyer-lock',
    )
    expect(session.stage).toBe('proof-reserved')
    expect(session.proofOperations).toMatchObject([
      {
        operationKey: 'trade-001/browser/buyer-lock',
        state: 'prepared',
      },
    ])
  })

  it('co-commits completed proof outputs and the durable swap session', async () => {
    await prepareGuiProofOperationWithSession(
      {
        operationId: 'trade-001/browser/buyer-lock',
        kind: 'swap-lock',
        mintUrl: 'https://mint.example',
        inputs: [],
        outputs: {},
      },
      swap(),
    )
    await completeGuiProofOperationWithSession(
      'trade-001/browser/buyer-lock',
      { receive: [] },
      swap(),
      'https://mint.example',
    )

    expect(proofOperations.get('trade-001/browser/buyer-lock')?.state).toBe(
      'completed',
    )
    const session = (
      rows.get('trade-001') as {
        session: { stage: string; proofOperations: Array<{ state: string }> }
      }
    ).session
    expect(session.stage).toBe('reconciliation-complete')
    expect(session.proofOperations[0]?.state).toBe('reconciled')
  })

  it('reconciles a persisted GUI proof operation through the SDK coordinator', async () => {
    await prepareGuiProofOperationWithSession(
      {
        operationId: 'trade-001/browser/buyer-lock',
        kind: 'swap-lock',
        mintUrl: 'https://mint.example',
        inputs: [],
        outputs: {},
      },
      swap(),
    )
    const restored: string[] = []
    const result = await withWebLocks(() =>
      recoverGuiDurableTradeSession('trade-001', {
        mint: {
          inspect: async () => ({ kind: 'prepared-spent-restorable' }),
          restoreExactPersistedOutputs: async (operation) => {
            restored.push(operation.operationId)
          },
          resumeExactPreparedOperation: async () => {
            throw new Error('spent operation must restore, not resume')
          },
        },
        transport: {
          joinTrade: async () => undefined,
          sendCipher: async () => undefined,
        },
        clock: { nowMs: () => 1 },
        hashCiphertext: async () => '0'.repeat(64),
      }),
    )

    expect(restored).toEqual([
      'trade-recovery:trade-001:seller:proof-reservation:trade-001%2Fbrowser%2Fbuyer-lock',
    ])
    expect(result?.sessions).toEqual([
      expect.objectContaining({ kind: 'ready', tradeId: 'trade-001' }),
    ])
    expect(proofOperations.get('trade-001/browser/buyer-lock')).toMatchObject({
      state: 'completed',
      durableTradeRecovery: { state: 'reconciled' },
    })
    expect(
      (
        rows.get('trade-001') as {
          session: { proofOperations: Array<{ state: string }> }
        }
      ).session.proofOperations,
    ).toEqual([expect.objectContaining({ state: 'reconciled' })])
    expect(transactionTables.some((tables) => tables.length === 2)).toBe(true)
  })

  it('rejoins then replays the SDK-owned durable outbox without regenerating ciphers', async () => {
    await persistGuiSwapSession(
      swap({
        sellerState: {
          adaptorPoint: {} as never,
          adaptorPointCipher: 'adaptor-cipher',
          lockedProofsCipher: 'seller-cipher',
        },
      }),
      'https://mint.example',
    )
    const calls: string[] = []

    const result = await resumeGuiSwapSession('trade-001', {
      joinTrade: async (tradeId) => {
        calls.push(`join:${tradeId}`)
      },
      sendCipher: async (_tradeId, messageType, ciphertext) => {
        calls.push(`${messageType}:${ciphertext}`)
      },
    })

    expect(result?.kind).toBe('replayed')
    expect(calls).toEqual([
      'join:trade-001',
      'adaptor-point:adaptor-cipher',
      'locked-proofs-seller:seller-cipher',
    ])
  })

  it('fails closed instead of evicting a live durable session at capacity', async () => {
    for (let i = 0; i < MAX_ACTIVE_GUI_SWAP_SESSIONS; i += 1) {
      const tradeId = `trade-${i}`
      rows.set(tradeId, {
        tradeId,
        session: {},
        adapterState: swap({ tradeId }),
        updatedAt: i,
      })
    }

    await expect(
      persistGuiSwapSession(
        swap({ tradeId: 'trade-overflow' }),
        'https://mint.example',
      ),
    ).rejects.toThrow(/capacity is exhausted/)
    expect(rows).toHaveLength(MAX_ACTIVE_GUI_SWAP_SESSIONS)
  })

  it('fails before creating a proof operation when durable storage is unavailable', async () => {
    storageOpenError = new Error('IndexedDB open blocked')

    await expect(
      prepareGuiProofOperationWithSession(
        {
          operationId: 'trade-001/browser/buyer-lock',
          kind: 'swap-lock',
          mintUrl: 'https://mint.example',
          inputs: [],
          outputs: {},
        },
        swap(),
      ),
    ).rejects.toThrow(/Durable swap storage is unavailable/)
    expect(proofOperations).toHaveLength(0)
    expect(rows).toHaveLength(0)
  })
})
