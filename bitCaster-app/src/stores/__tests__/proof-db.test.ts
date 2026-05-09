import { beforeEach, describe, expect, it, vi } from 'vitest'

// Mock Dexie before importing the module under test — we don't need a real
// IndexedDB (no polyfill installed in the jsdom harness), just an object
// that records what addProofs wrote so we can assert normalization.
type AnyProof = {
  secret: string
  mintUrl: string
  amount: number
  id?: string
  C?: string
  receivedAt?: number
  conditionId?: string
  condition_id?: string
  outcomeCollection?: string
  outcome_collection?: string
}

const store = new Map<string, AnyProof>()
const txCallbacks: Array<() => Promise<void>> = []

vi.mock('dexie', () => {
  class FakeTable {
    async bulkPut(rows: AnyProof[]): Promise<void> {
      for (const r of rows) store.set(r.secret, r)
    }
    async bulkDelete(keys: string[]): Promise<void> {
      for (const k of keys) store.delete(k)
    }
    async toArray(): Promise<AnyProof[]> {
      return Array.from(store.values())
    }
    where(_field: string) {
      return {
        equals: (v: string) => ({
          toArray: async () =>
            Array.from(store.values()).filter((r) => r.mintUrl === v),
        }),
      }
    }
    async put(row: AnyProof): Promise<void> {
      store.set(row.secret, row)
    }
  }

  class FakeDexie {
    constructor(_name: string) {}
    // Real Dexie assigns tables onto the instance as a side-effect of
    // `.stores()`, which runs AFTER the subclass's field initializers
    // have zeroed the slots with `!:` declarations. Mirror that lazy
    // assignment so `this.proofs` isn't clobbered to undefined.
    version(_v: number) {
      const self = this as unknown as Record<string, FakeTable>
      return {
        stores: (schema: Record<string, string>) => {
          for (const name of Object.keys(schema)) {
            if (!self[name]) self[name] = new FakeTable()
          }
          return self
        },
      }
    }
    async transaction(
      _mode: string,
      _table: unknown,
      cb: () => Promise<void>,
    ): Promise<void> {
      txCallbacks.push(cb)
      await cb()
    }
  }

  return { default: FakeDexie }
})

// Import after mock so the module picks up the fake.
import {
  addProofs,
  getBaseProofs,
  getOutcomeProofs,
  getProofs,
  normalizeStoredMintUrls,
} from '../proof-db'

beforeEach(() => {
  store.clear()
  txCallbacks.length = 0
})

describe('proof-db normalization', () => {
  it('normalizes trailing slash on write', async () => {
    await addProofs([
      {
        secret: 's1',
        amount: 100,
        id: 'id1',
        C: 'C1',
        mintUrl: 'http://mint.example/',
      },
    ])
    const rows = await getProofs('http://mint.example')
    expect(rows).toHaveLength(1)
    expect(rows[0].mintUrl).toBe('http://mint.example')
  })

  it('getProofs also normalizes the query argument', async () => {
    await addProofs([
      {
        secret: 's1',
        amount: 100,
        id: 'id1',
        C: 'C1',
        mintUrl: 'http://mint.example',
      },
    ])
    const rows = await getProofs('http://mint.example//')
    expect(rows).toHaveLength(1)
  })

  it('migration rewrites pre-existing un-normalized rows', async () => {
    // Seed directly so we bypass the write-time normalizer.
    store.set('legacy', {
      secret: 'legacy',
      amount: 500,
      id: 'idL',
      C: 'CL',
      mintUrl: 'https://mint.staging//',
    })
    const changed = await normalizeStoredMintUrls()
    expect(changed).toBe(1)
    const rows = await getProofs('https://mint.staging')
    expect(rows).toHaveLength(1)
  })

  it('migration is a no-op when all rows are already normalized', async () => {
    await addProofs([
      { secret: 's1', amount: 100, id: 'id1', C: 'C1', mintUrl: 'http://m' },
    ])
    const changed = await normalizeStoredMintUrls()
    expect(changed).toBe(0)
  })

  it('getBaseProofs excludes CTF proofs from spendable ecash balances', async () => {
    await addProofs([
      { secret: 'base', amount: 100, id: 'id1', C: 'C1', mintUrl: 'http://m' },
      {
        secret: 'ctf',
        amount: 200,
        id: 'id2',
        C: 'C2',
        mintUrl: 'http://m',
        conditionId: 'cond-yes',
      } as never,
    ])

    const rows = await getBaseProofs('http://m')

    expect(rows.map((r) => r.secret)).toEqual(['base'])
  })

  it('getOutcomeProofs returns only the requested condition outcome', async () => {
    await addProofs([
      {
        secret: 'yes',
        amount: 100,
        id: 'id1',
        C: 'C1',
        mintUrl: 'http://m',
        conditionId: 'cond',
        outcomeCollection: 'YES',
      },
      {
        secret: 'no',
        amount: 100,
        id: 'id2',
        C: 'C2',
        mintUrl: 'http://m',
        condition_id: 'cond',
        outcome_collection: 'NO',
      } as never,
      { secret: 'base', amount: 100, id: 'id3', C: 'C3', mintUrl: 'http://m' },
    ])

    const rows = await getOutcomeProofs('http://m', 'cond', 'YES')

    expect(rows.map((r) => r.secret)).toEqual(['yes'])
  })
})
