import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'

const rows = new Map<string, Record<string, unknown>>()
let storageError: Error | null = null
let activeWalletId = 'aa'.repeat(32)
let storageOpenGate: Promise<void> | null = null
let recordWriteGate: Promise<void> | null = null
const WALLET_A = 'aa'.repeat(32)
const WALLET_B = 'bb'.repeat(32)
const ORIGINAL_LOCKS = Object.getOwnPropertyDescriptor(navigator, 'locks')

vi.mock('../proof-db', () => ({
  ensureDurableSwapStorage: async () => {
    if (storageError) throw storageError
    await storageOpenGate
  },
  currentGuiWalletId: () => activeWalletId,
  db: {
    transaction: async (...args: unknown[]) =>
      (args.at(-1) as () => Promise<unknown>)(),
    swapIntents: {
      get: async (tradeId: string) => rows.get(tradeId),
      put: async (row: { tradeId: string }) => {
        await recordWriteGate
        rows.set(row.tradeId, row as Record<string, unknown>)
      },
      where: (field: string) => ({
        equals: (value: string) => ({
          toArray: async () => Array.from(rows.values()).filter(
            (row) => row[field] === value,
          ),
        }),
      }),
      delete: async (tradeId: string) => { rows.delete(tradeId) },
    },
  },
}))

vi.mock('../gui-custody-authority', () => ({
  withGuiCustodyProfileLock: async <T>(
    action: (context: { walletId: string; scope: unknown }) => Promise<T>,
  ): Promise<T | null> => {
    if (!navigator.locks) {
      throw new Error('Browser custody locking is unavailable')
    }
    const walletId = activeWalletId
    return navigator.locks.request(
      `bitcaster-custody:${walletId}`,
      { mode: 'exclusive' },
      async () => {
        if (activeWalletId !== walletId) {
          throw new Error('GUI wallet changed while awaiting custody ownership')
        }
        return action({
          walletId,
          scope: { scopeKind: 'wallet', walletId },
        })
      },
    )
  },
}))

import {
  getGuiPendingSwapIntent,
  getOrCreateGuiPendingSwapIntent,
  loadGuiPendingSwapIntents,
  migrateLegacyGuiPendingSwapIntents,
  parseLegacyPendingSwapIntents,
  markGuiPendingSwapIntentSubmitted,
  persistGuiPendingSwapIntent,
  removeGuiPendingSwapIntent,
} from '../pending-swap-intent-db'

const intent = {
  tradeId: 'trade-001',
  orderId: 'order-001',
  marketId: 'condition-YES',
  pubkey: Array.from(secp256k1.getPublicKey(new Uint8Array(32).fill(1), true))
    .map((part) => part.toString(16).padStart(2, '0'))
    .join(''),
  privkey: '01'.repeat(32),
  deadline: '2099-01-01T00:00:00.000Z',
  submitted: false,
}

beforeEach(() => {
  rows.clear()
  storageError = null
  storageOpenGate = null
  recordWriteGate = null
  activeWalletId = WALLET_A
  installWebLocks()
  window.localStorage.clear()
})

afterEach(() => {
  restoreWebLocks()
})

describe('GUI pending swap intent repository', () => {
  it('accepts only valid legacy Zustand entries for durable migration', () => {
    const parsed = parseLegacyPendingSwapIntents(JSON.stringify({
      state: {
        byTradeId: {
          [intent.tradeId]: intent,
          malformed: { ...intent, tradeId: 'malformed', privkey: 'bad' },
        },
      },
    }))

    expect(parsed).toEqual([intent])
  })

  it('migrates valid legacy intent records before clearing the local-storage payload', async () => {
    window.localStorage.setItem('bitcaster-pending-pubkeys', JSON.stringify({
      state: { byTradeId: { [intent.tradeId]: intent } },
    }))

    await expect(migrateLegacyGuiPendingSwapIntents()).resolves.toEqual([intent])
    await expect(getGuiPendingSwapIntent(intent.tradeId)).resolves.toEqual(intent)
    expect(window.localStorage.getItem('bitcaster-pending-pubkeys')).toBeNull()
  })

  it('keeps the legacy payload until every durable write commits', async () => {
    window.localStorage.setItem('bitcaster-pending-pubkeys', JSON.stringify({
      state: { byTradeId: { [intent.tradeId]: intent } },
    }))
    const write = deferred()
    recordWriteGate = write.promise

    const migration = migrateLegacyGuiPendingSwapIntents()
    await vi.waitFor(() => {
      expect(window.localStorage.getItem('bitcaster-pending-pubkeys')).not.toBeNull()
    })
    expect(rows).toHaveLength(0)

    write.resolve()
    await expect(migration).resolves.toEqual([intent])
    expect(rows).toHaveLength(1)
    expect(window.localStorage.getItem('bitcaster-pending-pubkeys')).toBeNull()
  })

  it('persists and hydrates a pre-TradeCreated private key binding', async () => {
    await persistGuiPendingSwapIntent(intent)

    await expect(getGuiPendingSwapIntent(intent.tradeId)).resolves.toEqual(intent)
    await expect(loadGuiPendingSwapIntents()).resolves.toEqual([intent])
  })

  it('marks the durable intent submitted without changing its key binding', async () => {
    await persistGuiPendingSwapIntent(intent)
    await markGuiPendingSwapIntentSubmitted(intent.tradeId)
    await persistGuiPendingSwapIntent(intent)

    await expect(getGuiPendingSwapIntent(intent.tradeId)).resolves.toEqual({ ...intent, submitted: true })
  })

  it('fails closed when submission completion has no durable pending intent', async () => {
    await expect(markGuiPendingSwapIntentSubmitted(intent.tradeId))
      .rejects.toThrow(/missing/)
  })

  it('fails closed before storing a pre-session key when durable storage is unavailable', async () => {
    storageError = new Error('IndexedDB unavailable')

    await expect(persistGuiPendingSwapIntent(intent)).rejects.toThrow(/IndexedDB unavailable/)
    expect(rows).toHaveLength(0)
  })

  it('fails closed without Web Locks before creating or storing a key', async () => {
    delete (navigator as { locks?: LockManager }).locks
    let generated = 0

    await expect(getOrCreateGuiPendingSwapIntent({
      tradeId: intent.tradeId,
      orderId: intent.orderId,
      marketId: intent.marketId,
      deadline: intent.deadline,
      create: () => {
        generated += 1
        return intent
      },
    })).rejects.toThrow(/custody/)

    expect(generated).toBe(0)
    expect(rows).toHaveLength(0)
  })

  it('fails closed without Web Locks before marking a key submitted', async () => {
    await persistGuiPendingSwapIntent(intent)
    delete (navigator as { locks?: LockManager }).locks

    await expect(markGuiPendingSwapIntentSubmitted(intent.tradeId))
      .rejects.toThrow(/custody/)
    expect(rows.get(intent.tradeId)?.submitted).toBe(false)
  })

  it('fails closed without Web Locks before removing or cleaning up a key', async () => {
    await persistGuiPendingSwapIntent({
      ...intent,
      deadline: '2000-01-01T00:00:00.000Z',
    })
    delete (navigator as { locks?: LockManager }).locks

    await expect(removeGuiPendingSwapIntent(intent.tradeId))
      .rejects.toThrow(/custody/)
    await expect(loadGuiPendingSwapIntents())
      .rejects.toThrow(/custody/)
    expect(rows).toHaveLength(1)
  })

  it('preserves legacy state when migration cannot acquire Web Locks', async () => {
    const serialized = JSON.stringify({
      state: { byTradeId: { [intent.tradeId]: intent } },
    })
    window.localStorage.setItem('bitcaster-pending-pubkeys', serialized)
    delete (navigator as { locks?: LockManager }).locks

    await expect(migrateLegacyGuiPendingSwapIntents())
      .rejects.toThrow(/custody/)
    expect(window.localStorage.getItem('bitcaster-pending-pubkeys')).toBe(serialized)
    expect(rows).toHaveLength(0)
  })

  it('rejects a pre-session private key that does not derive its stored public key', async () => {
    await expect(persistGuiPendingSwapIntent({
      ...intent,
      pubkey: `02${'b'.repeat(64)}`,
    })).rejects.toThrow(/private key does not match/)
  })

  it('serializes concurrent pending-intent creation to one durable key', async () => {
    let generated = 0
    const create = () => {
      generated += 1
      return intent
    }

    const [first, second] = await Promise.all([
      getOrCreateGuiPendingSwapIntent({
        tradeId: intent.tradeId,
        orderId: intent.orderId,
        marketId: intent.marketId,
        deadline: intent.deadline,
        create,
      }),
      getOrCreateGuiPendingSwapIntent({
        tradeId: intent.tradeId,
        orderId: intent.orderId,
        marketId: intent.marketId,
        deadline: intent.deadline,
        create,
      }),
    ])

    expect(generated).toBe(1)
    expect(first).toEqual(intent)
    expect(second).toEqual(intent)
  })

  it('serializes separate module contexts to one durable key through Web Locks', async () => {
    vi.resetModules()
    const otherContext = await import('../pending-swap-intent-db')
    let generated = 0
    const input = {
      tradeId: intent.tradeId,
      orderId: intent.orderId,
      marketId: intent.marketId,
      deadline: intent.deadline,
      create: () => {
        generated += 1
        return intent
      },
    }

    const [first, second] = await Promise.all([
      getOrCreateGuiPendingSwapIntent(input),
      otherContext.getOrCreateGuiPendingSwapIntent(input),
    ])

    expect(generated).toBe(1)
    expect(first).toEqual(intent)
    expect(second).toEqual(intent)
    expect(rows).toHaveLength(1)
  })

  it('keeps a write pinned to its captured wallet when the seed changes', async () => {
    const storage = deferred()
    storageOpenGate = storage.promise

    const persistence = persistGuiPendingSwapIntent(intent)
    await Promise.resolve()
    activeWalletId = WALLET_B
    storage.resolve()

    await expect(persistence).resolves.toBeUndefined()
    expect(rows.get(intent.tradeId)?.walletId).toBe(WALLET_A)
  })

  it('fails closed instead of replacing another wallet pending intent', async () => {
    rows.set(intent.tradeId, {
      walletId: WALLET_B,
      tradeId: intent.tradeId,
    })

    await expect(persistGuiPendingSwapIntent(intent))
      .rejects.toThrow(/another wallet scope/)
    expect(rows.get(intent.tradeId)?.walletId).toBe(WALLET_B)
  })

  it('retains corrupt authority and never generates a replacement private key', async () => {
    rows.set(intent.tradeId, {
      ...storedIntentRecord(intent),
      ephemeralPrivkeyHex: 'corrupt',
    })
    let generated = 0

    await expect(getOrCreateGuiPendingSwapIntent({
      tradeId: intent.tradeId,
      orderId: intent.orderId,
      marketId: intent.marketId,
      deadline: intent.deadline,
      create: () => {
        generated += 1
        return intent
      },
    })).rejects.toThrow(/corrupt/)

    expect(generated).toBe(0)
    expect(rows.get(intent.tradeId)?.ephemeralPrivkeyHex).toBe('corrupt')
  })

  it('retains unknown authority fields and blocks replacement key generation', async () => {
    rows.set(intent.tradeId, {
      ...storedIntentRecord(intent),
      unknownAuthority: 'future-schema',
    })
    let generated = 0

    await expect(getOrCreateGuiPendingSwapIntent({
      tradeId: intent.tradeId,
      orderId: intent.orderId,
      marketId: intent.marketId,
      deadline: intent.deadline,
      create: () => {
        generated += 1
        return intent
      },
    })).rejects.toThrow(/record fields are invalid/)

    expect(generated).toBe(0)
    expect(rows.get(intent.tradeId)?.unknownAuthority).toBe('future-schema')
  })

  it('rejects a physical and internal trade-id mismatch without deleting it', async () => {
    rows.set(intent.tradeId, {
      ...storedIntentRecord(intent),
      intent: {
        ...(storedIntentRecord(intent).intent as Record<string, unknown>),
        tradeId: 'trade-other',
      },
    })

    await expect(loadGuiPendingSwapIntents()).rejects.toThrow(/trade id mismatch/)
    expect(rows).toHaveLength(1)
  })

  it('rejects a conflicting same-wallet overwrite and preserves the first binding', async () => {
    await persistGuiPendingSwapIntent(intent)

    await expect(persistGuiPendingSwapIntent({
      ...intent,
      orderId: 'order-conflict',
    })).rejects.toThrow(/conflicts with the existing trade binding/)

    await expect(getGuiPendingSwapIntent(intent.tradeId)).resolves.toEqual(intent)
  })

  it('retains a past-deadline submitted private key until explicit retirement', async () => {
    const submitted = {
      ...intent,
      deadline: '2000-01-01T00:00:00.000Z',
      submitted: true,
    }
    await persistGuiPendingSwapIntent(submitted)

    await expect(loadGuiPendingSwapIntents()).resolves.toEqual([submitted])
    await expect(getGuiPendingSwapIntent(intent.tradeId)).resolves.toEqual(submitted)
    expect(rows).toHaveLength(1)

    await removeGuiPendingSwapIntent(intent.tradeId)

    await expect(loadGuiPendingSwapIntents()).resolves.toEqual([])
    expect(rows).toHaveLength(0)
  })

  it('reloads a past-deadline response-unknown intent without generating a replacement key', async () => {
    const responseUnknown = {
      ...intent,
      deadline: '2000-01-01T00:00:00.000Z',
    }
    await persistGuiPendingSwapIntent(responseUnknown)
    vi.resetModules()
    const restarted = await import('../pending-swap-intent-db')
    let generated = 0

    await expect(restarted.getOrCreateGuiPendingSwapIntent({
      tradeId: responseUnknown.tradeId,
      orderId: responseUnknown.orderId,
      marketId: responseUnknown.marketId,
      deadline: responseUnknown.deadline,
      create: () => {
        generated += 1
        return intent
      },
    })).resolves.toEqual(responseUnknown)

    expect(generated).toBe(0)
    expect(rows).toHaveLength(1)
  })
})

function storedIntentRecord(input: typeof intent): Record<string, unknown> {
  return {
    walletId: WALLET_A,
    tradeId: input.tradeId,
    intent: {
      schemaVersion: 2,
      tradeId: input.tradeId,
      orderId: input.orderId,
      marketId: input.marketId,
      localProtocolPubkey: input.pubkey,
      deadline: input.deadline,
    },
    ephemeralPrivkeyHex: input.privkey,
    submitted: input.submitted,
    updatedAt: 1,
  }
}

function installWebLocks(): void {
  let tail = Promise.resolve()
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ): Promise<T> => {
        const prior = tail
        const next = deferred()
        tail = next.promise
        await prior
        try {
          return await callback()
        } finally {
          next.resolve()
        }
      },
    },
  })
}

function restoreWebLocks(): void {
  if (ORIGINAL_LOCKS) {
    Object.defineProperty(navigator, 'locks', ORIGINAL_LOCKS)
    return
  }
  delete (navigator as { locks?: LockManager }).locks
}

function deferred(): {
  promise: Promise<void>
  resolve: () => void
} {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
