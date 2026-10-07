import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { resolveCtfConsolidationOutputKeysets } from '../src/walletOps.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

test('native output discovery follows every active-registry page before selecting outcome keysets', async () => {
  const queries: URL[] = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/keysets') {
      return Response.json({
        keysets: [{ id: 'regular', unit: 'msat', active: true, input_fee_ppk: 0 }],
      })
    }
    assert.equal(url.pathname, '/v1/conditional_keysets')
    queries.push(url)
    assert.equal(url.searchParams.get('active'), 'true')
    assert.equal(url.searchParams.get('limit'), '100')
    if (!url.searchParams.has('cursor')) {
      return Response.json({ keysets: [], next_cursor: 'opaque+?/=' })
    }
    assert.equal(url.searchParams.get('cursor'), 'opaque+?/=')
    return Response.json({
      next_cursor: null,
      keysets: [
        {
          id: 'conditional',
          unit: 'msat',
          active: true,
          input_fee_ppk: 0,
          condition_id: 'target',
          outcome_collection: 'YES',
          outcome_collection_id: 'yes-collection',
          registered_at: 7,
        },
        {
          id: 'foreign-unit',
          unit: 'sat',
          active: true,
          input_fee_ppk: 0,
          condition_id: 'target',
          outcome_collection: 'YES',
          outcome_collection_id: 'yes-collection',
          registered_at: 7,
        },
      ],
    })
  }
  const keysets = await resolveCtfConsolidationOutputKeysets('https://mint.example', 'target')
  assert.equal(keysets['YES'], 'conditional')
  assert.equal(keysets['yes-collection'], 'conditional')
  assert.equal(queries.length, 2)
})

test('native output discovery rejects a later registry failure instead of returning regular-only metadata', async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname === '/v1/keysets') {
      return Response.json({ keysets: [{ id: 'regular', unit: 'msat', active: true }] })
    }
    if (!url.searchParams.has('cursor')) {
      return Response.json({ keysets: [], next_cursor: 'second' })
    }
    throw new Error('later registry unavailable')
  }
  await assert.rejects(
    resolveCtfConsolidationOutputKeysets('https://mint.example', 'target'),
    /later registry unavailable/,
  )
})
