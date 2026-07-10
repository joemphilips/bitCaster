import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Amount } from '@cashu/cashu-ts'

// Mock Dexie before importing the module under test — we don't need a real
// IndexedDB (no polyfill installed in the jsdom harness), just an object
// that records what addProofs wrote so we can assert normalization.
type AnyProof = {
  secret: string
  mintUrl: string
  amount: unknown
  id?: string
  C?: string
  receivedAt?: number
  reservedBy?: string
  conditionId?: string
  condition_id?: string
  outcomeCollection?: string
  outcome_collection?: string
  baseAsset?: string
  unit?: string
}

const store = new Map<string, AnyProof>()
const txCallbacks: Array<() => Promise<void>> = []
let transactionTail = Promise.resolve()

vi.mock('dexie', () => {
  class FakeTable {
    async bulkPut(rows: AnyProof[]): Promise<void> {
      for (const r of rows) store.set(r.secret, r)
    }
    async bulkDelete(keys: string[]): Promise<void> {
      for (const k of keys) store.delete(k)
    }
    async bulkGet(keys: string[]): Promise<Array<AnyProof | undefined>> {
      return keys.map((key) => store.get(key))
    }
    async toArray(): Promise<AnyProof[]> {
      return Array.from(store.values())
    }
    filter(predicate: (row: AnyProof) => boolean) {
      return {
        toArray: async () => Array.from(store.values()).filter(predicate),
      }
    }
    where(field: string) {
      return {
        equals: (v: string | [string, string, string]) => ({
          toArray: async () =>
            Array.from(store.values()).filter((r) => {
              if (field === 'mintUrl') return r.mintUrl === v
              if (field === '[mintUrl+conditionId+outcomeCollection]') {
                const [mintUrl, conditionId, outcomeCollection] = v as [
                  string,
                  string,
                  string,
                ]
                return (
                  r.mintUrl === mintUrl &&
                  r.conditionId === conditionId &&
                  r.outcomeCollection === outcomeCollection
                )
              }
              return false
            }),
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
      const run = transactionTail.then(cb)
      transactionTail = run.catch(() => undefined)
      await run
    }
  }

  return { default: FakeDexie }
})

// Import after mock so the module picks up the fake.
import {
  addProofs,
  getBaseProofs,
  getConditionCtfProofs,
  getOutcomeProofs,
  getProofs,
  getUnitProofs,
  getReservedProofs,
  normalizeStoredMintUrls,
  releaseProofReservation,
  releaseProofReservationsBySecret,
  reserveProofs,
  selectAndReserveUnitProofs,
  tryReserveProofs,
} from '../proof-db'

beforeEach(() => {
  store.clear()
  txCallbacks.length = 0
  transactionTail = Promise.resolve()
})

describe('proof-db normalization', () => {
  it('normalizes trailing slash on write', async () => {
    await addProofs([
      {
        secret: 's1',
        amount: Amount.from(100),
        id: 'id1',
        C: 'C1',
        mintUrl: 'http://mint.example/',
      },
    ])
    const rows = await getProofs('http://mint.example')
    expect(rows).toHaveLength(1)
    expect(rows[0].mintUrl).toBe('http://mint.example')
  })

  it('normalizes Cashu Amount values to numbers on write', async () => {
    await addProofs([
      {
        secret: 's1',
        amount: Amount.from(100),
        id: 'id1',
        C: 'C1',
        mintUrl: 'http://mint.example',
      },
      {
        secret: 's2',
        amount: { value: 110n },
        id: 'id2',
        C: 'C2',
        mintUrl: 'http://mint.example',
      } as never,
    ])

    const rows = await getProofs('http://mint.example')

    expect(rows.map((proof) => proof.amount)).toEqual([100, 110])
    expect(Array.from(store.values()).map((proof) => proof.amount)).toEqual([100, 110])
  })

  it('getProofs also normalizes the query argument', async () => {
    await addProofs([
      {
        secret: 's1',
        amount: Amount.from(100),
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
      amount: Amount.from(500),
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
      { secret: 's1', amount: Amount.from(100), id: 'id1', C: 'C1', mintUrl: 'http://m' },
    ])
    const changed = await normalizeStoredMintUrls()
    expect(changed).toBe(0)
  })

  it('getBaseProofs excludes CTF proofs from spendable ecash balances', async () => {
    await addProofs([
      { secret: 'base', amount: Amount.from(100), id: 'id1', C: 'C1', mintUrl: 'http://m' },
      {
        secret: 'ctf',
        amount: Amount.from(200),
        id: 'id2',
        C: 'C2',
        mintUrl: 'http://m',
        conditionId: 'cond-yes',
      } as never,
    ])

    const rows = await getBaseProofs('http://m')

    expect(rows.map((r) => r.secret)).toEqual(['base'])
  })

  it('getBaseProofs filters by base asset and defaults legacy rows to sat', async () => {
    await addProofs([
      { secret: 'legacy-sat', amount: Amount.from(100), id: 'id1', C: 'C1', mintUrl: 'http://m' },
      { secret: 'usd', amount: Amount.from(100), id: 'id2', C: 'C2', mintUrl: 'http://m', baseAsset: 'usd' },
    ])

    expect((await getBaseProofs('http://m')).map((r) => r.secret)).toEqual([
      'legacy-sat',
    ])
    expect((await getBaseProofs('http://m', { baseAsset: 'usd' })).map((r) => r.secret)).toEqual([
      'usd',
    ])
  })

  it('getUnitProofs filters exact sat and msat units while getBaseProofs groups both for display', async () => {
    await addProofs([
      { secret: 'sat-proof', amount: Amount.from(100), id: 'id1', C: 'C1', mintUrl: 'http://m', baseAsset: 'sat', unit: 'sat' },
      { secret: 'msat-proof', amount: Amount.from(200), id: 'id2', C: 'C2', mintUrl: 'http://m', baseAsset: 'sat', unit: 'msat' },
    ])

    expect((await getUnitProofs('http://m', { unit: 'msat' })).map((r) => r.secret)).toEqual([
      'msat-proof',
    ])
    expect((await getUnitProofs('http://m', { unit: 'sat' })).map((r) => r.secret)).toEqual([
      'sat-proof',
    ])
    expect((await getBaseProofs('http://m', { baseAsset: 'sat' })).map((r) => r.secret)).toEqual([
      'sat-proof',
      'msat-proof',
    ])
  })

  it('getUnitProofs excludes legacy rows without an explicit unit', async () => {
    await addProofs([
      { secret: 'legacy-sat', amount: Amount.from(100), id: 'id1', C: 'C1', mintUrl: 'http://m', baseAsset: 'sat' },
      { secret: 'msat-proof', amount: Amount.from(200), id: 'id2', C: 'C2', mintUrl: 'http://m', baseAsset: 'sat', unit: 'msat' },
    ])

    expect((await getUnitProofs('http://m', { unit: 'msat' })).map((r) => r.secret)).toEqual([
      'msat-proof',
    ])
    expect((await getUnitProofs('http://m', { unit: 'sat' })).map((r) => r.secret)).toEqual([])
    expect((await getBaseProofs('http://m', { baseAsset: 'sat' })).map((r) => r.secret)).toEqual([
      'legacy-sat',
      'msat-proof',
    ])
  })

  it('rejects mismatched base asset and unit on write', async () => {
    await expect(addProofs([
      { secret: 'bad', amount: Amount.from(100), id: 'id1', C: 'C1', mintUrl: 'http://m', baseAsset: 'sat', unit: 'usd' },
    ])).rejects.toThrow("Stored proof unit 'usd' is not compatible with base asset 'sat'")
  })

  it('derives base asset from explicit unit before validating on write', async () => {
    await addProofs([
      { secret: 'usd-without-base', amount: Amount.from(100), id: 'id1', C: 'C1', mintUrl: 'http://m', unit: 'usd' },
    ])

    const rows = await getProofs('http://m')

    expect(rows[0]).toMatchObject({
      secret: 'usd-without-base',
      baseAsset: 'usd',
      unit: 'usd',
    })
  })

  it('getOutcomeProofs returns only the requested condition outcome', async () => {
    await addProofs([
      {
        secret: 'yes',
        amount: Amount.from(100),
        id: 'id1',
        C: 'C1',
        mintUrl: 'http://m',
        conditionId: 'cond',
        outcomeCollection: 'YES',
      },
      {
        secret: 'no',
        amount: Amount.from(100),
        id: 'id2',
        C: 'C2',
        mintUrl: 'http://m',
        condition_id: 'cond',
        outcome_collection: 'NO',
      } as never,
      { secret: 'base', amount: Amount.from(100), id: 'id3', C: 'C3', mintUrl: 'http://m' },
    ])

    const rows = await getOutcomeProofs('http://m', 'cond', 'YES')

    expect(rows.map((r) => r.secret)).toEqual(['yes'])
  })

  it('getConditionCtfProofs gathers every keyset leg regardless of label storage', async () => {
    await addProofs([
      // composite-label storage: both keysets tagged "A|B"
      {
        secret: 'compA',
        amount: Amount.from(100),
        id: 'keyset-A',
        C: 'C1',
        mintUrl: 'http://m',
        conditionId: 'cond',
        outcomeCollection: 'A|B',
      },
      {
        secret: 'compB',
        amount: Amount.from(100),
        id: 'keyset-B',
        C: 'C2',
        mintUrl: 'http://m',
        conditionId: 'cond',
        outcomeCollection: 'A|B',
      },
      // per-primitive storage variant under condition_id snake-case key
      {
        secret: 'primC',
        amount: Amount.from(100),
        id: 'keyset-C',
        C: 'C3',
        mintUrl: 'http://m',
        condition_id: 'cond',
        outcome_collection: 'C',
      } as never,
      // different condition — must be excluded
      {
        secret: 'other',
        amount: Amount.from(100),
        id: 'keyset-A',
        C: 'C4',
        mintUrl: 'http://m',
        conditionId: 'cond2',
        outcomeCollection: 'A',
      },
      // base (non-CTF) proof — must be excluded
      { secret: 'base', amount: Amount.from(100), id: 'id5', C: 'C5', mintUrl: 'http://m' },
    ])

    const rows = await getConditionCtfProofs('http://m', 'cond')

    expect(rows.map((r) => r.secret).sort()).toEqual(['compA', 'compB', 'primC'])
    // Bucketing by real keyset id recovers all three legs.
    expect(new Set(rows.map((r) => r.id))).toEqual(
      new Set(['keyset-A', 'keyset-B', 'keyset-C']),
    )
  })

  it('getOutcomeProofs filters by base asset and defaults legacy rows to sat', async () => {
    await addProofs([
      {
        secret: 'legacy-sat-yes',
        amount: Amount.from(100),
        id: 'id1',
        C: 'C1',
        mintUrl: 'http://m',
        conditionId: 'cond',
        outcomeCollection: 'YES',
      },
      {
        secret: 'usd-yes',
        amount: Amount.from(100),
        id: 'id2',
        C: 'C2',
        mintUrl: 'http://m',
        conditionId: 'cond',
        outcomeCollection: 'YES',
        baseAsset: 'usd',
      },
    ])

    expect((await getOutcomeProofs('http://m', 'cond', 'YES')).map((r) => r.secret)).toEqual([
      'legacy-sat-yes',
    ])
    expect((await getOutcomeProofs('http://m', 'cond', 'YES', { baseAsset: 'usd' })).map((r) => r.secret)).toEqual([
      'usd-yes',
    ])
  })

  it('hides reserved proofs from spendable base and outcome queries', async () => {
    await addProofs([
      { secret: 'base-free', amount: Amount.from(100), id: 'id1', C: 'C1', mintUrl: 'http://m' },
      { secret: 'base-reserved', amount: Amount.from(100), id: 'id2', C: 'C2', mintUrl: 'http://m' },
      {
        secret: 'yes-free',
        amount: Amount.from(100),
        id: 'id3',
        C: 'C3',
        mintUrl: 'http://m',
        conditionId: 'cond',
        outcomeCollection: 'YES',
      },
      {
        secret: 'yes-reserved',
        amount: Amount.from(100),
        id: 'id4',
        C: 'C4',
        mintUrl: 'http://m',
        conditionId: 'cond',
        outcomeCollection: 'YES',
      },
    ])
    await reserveProofs(['base-reserved', 'yes-reserved'], 'order-1')

    expect((await getBaseProofs('http://m')).map((r) => r.secret)).toEqual([
      'base-free',
    ])
    expect((await getOutcomeProofs('http://m', 'cond', 'YES')).map((r) => r.secret)).toEqual([
      'yes-free',
    ])
    expect((await getReservedProofs('order-1')).map((r) => r.secret)).toEqual([
      'base-reserved',
      'yes-reserved',
    ])
  })

  it('releases reserved proofs by owner or selected secret', async () => {
    await addProofs([
      { secret: 's1', amount: Amount.from(100), id: 'id1', C: 'C1', mintUrl: 'http://m' },
      { secret: 's2', amount: Amount.from(100), id: 'id2', C: 'C2', mintUrl: 'http://m' },
    ])
    await reserveProofs(['s1', 's2'], 'order-1')
    await releaseProofReservationsBySecret(['s1'])

    expect((await getProofs('http://m')).map((r) => r.secret)).toEqual(['s1'])

    await releaseProofReservation('order-1')
    expect((await getProofs('http://m')).map((r) => r.secret)).toEqual([
      's1',
      's2',
    ])
  })

  it('selects spendable unit proofs and reserves them in one transaction', async () => {
    await addProofs([
      { secret: 's1', amount: Amount.from(60), id: 'id1', C: 'C1', mintUrl: 'http://m', baseAsset: 'sat', unit: 'msat' },
      { secret: 's2', amount: Amount.from(50), id: 'id2', C: 'C2', mintUrl: 'http://m', baseAsset: 'sat', unit: 'msat' },
      { secret: 's3', amount: Amount.from(100), id: 'id3', C: 'C3', mintUrl: 'http://m', baseAsset: 'sat', unit: 'sat' },
      { secret: 'ctf', amount: Amount.from(100), id: 'id4', C: 'C4', mintUrl: 'http://m', baseAsset: 'sat', unit: 'msat', conditionId: 'cond' },
    ])

    const selected = await selectAndReserveUnitProofs('http://m/', { unit: 'msat' }, 'pay-1')

    expect(txCallbacks).toHaveLength(1)
    expect(selected.map((proof) => proof.secret)).toEqual(['s1', 's2'])
    expect((await getReservedProofs('pay-1')).map((proof) => proof.secret)).toEqual(['s1', 's2'])
    expect((await getUnitProofs('http://m', { unit: 'msat' })).map((proof) => proof.secret)).toEqual([])
  })

  it('allows only one concurrent owner to reserve the same proof set', async () => {
    await addProofs([
      { secret: 'shared', amount: Amount.from(100), id: 'id1', C: 'C1', mintUrl: 'http://m', baseAsset: 'sat', unit: 'msat' },
    ])

    const [first, second] = await Promise.all([
      tryReserveProofs(['shared'], 'trade-a'),
      tryReserveProofs(['shared'], 'trade-b'),
    ])

    expect([first, second].filter(Boolean)).toHaveLength(1)
    expect((await getReservedProofs('trade-a')).length + (await getReservedProofs('trade-b')).length).toBe(1)
  })

  it('fails atomic unit proof selection when the selected proofs cannot satisfy the requested amount', async () => {
    await addProofs([
      { secret: 'reserved', amount: Amount.from(60), id: 'id1', C: 'C1', mintUrl: 'http://m', baseAsset: 'sat', unit: 'msat' },
      { secret: 'free', amount: Amount.from(20), id: 'id2', C: 'C2', mintUrl: 'http://m', baseAsset: 'sat', unit: 'msat' },
    ])
    await reserveProofs(['reserved'], 'other-flow')

    await expect(
      selectAndReserveUnitProofs('http://m', { unit: 'msat', minimumAmount: 50 }, 'pay-1'),
    ).rejects.toThrow('Insufficient spendable proofs')
    expect(await getReservedProofs('pay-1')).toEqual([])
  })
})
