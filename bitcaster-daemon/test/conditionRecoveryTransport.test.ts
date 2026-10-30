import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveConditionalKeysetId } from '@cashu/cashu-ts'
import { deriveRootCtfOutcomeCollectionId } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { createAllKeysetRecoveryTransport } from '../src/emergencySeedRecovery.ts'

const conditionId = 'ab'.repeat(32)
const mintUrl = 'https://mint.example'
function descriptor(outcome: string, condition = conditionId) {
  const outcomeId = deriveRootCtfOutcomeCollectionId({
    conditionId: condition,
    outcomeCollection: outcome,
  })
  const keys = { '1': '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798' }
  return {
    id: deriveConditionalKeysetId({
      keys,
      unit: 'msat',
      input_fee_ppk: 0,
      final_expiry: 100,
      conditionId: condition,
      outcomeCollectionId: outcomeId,
    }),
    unit: 'msat',
    active: false,
    input_fee_ppk: 0,
    final_expiry: 100,
    condition_id: condition,
    outcome_collection: outcome,
    outcome_collection_id: outcomeId,
    registered_at: 1,
  }
}

test('production recovery transport uses only scoped historical pages after explicit capability', async (t) => {
  const first = descriptor('NO')
  const second = descriptor('YES')
  const pages: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input))
    assert.equal(url.origin, mintUrl)
    if (url.pathname === '/v1/info')
      return Response.json({ nuts: { CTF: { condition_keyset_filter: true } } })
    assert.equal(url.pathname, '/v1/conditional_keysets')
    assert.equal(url.searchParams.get('condition_id'), conditionId)
    assert.equal(url.searchParams.get('limit'), '100')
    assert.equal(url.searchParams.has('active'), false)
    assert.equal(url.searchParams.has('since'), false)
    pages.push(url.search)
    return Response.json(
      url.searchParams.has('cursor')
        ? { keysets: [second], next_cursor: null }
        : { keysets: [first], next_cursor: 'opaque+?/=' },
    )
  })
  const transport = createAllKeysetRecoveryTransport(mintUrl, 'msat', '07'.repeat(64))
  assert.deepEqual(await transport.listConditionalKeysets(conditionId), {
    keysets: [first, second],
  })
  assert.equal(pages.length, 2)
  assert.equal(new URLSearchParams(pages[1]).get('cursor'), 'opaque+?/=')
})

test('production transport refuses missing/false capability without conditional or global fallback', async (t) => {
  for (const CTF of [
    undefined,
    {},
    { condition_keyset_filter: false },
    { condition_keyset_filter: 'true' },
  ]) {
    const paths: string[] = []
    const mocked = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname
      paths.push(path)
      assert.equal(path, '/v1/info')
      return Response.json({ nuts: CTF === undefined ? {} : { CTF } })
    })
    await assert.rejects(
      createAllKeysetRecoveryTransport(mintUrl, 'msat', '07'.repeat(64)).listConditionalKeysets(
        conditionId,
      ),
    )
    assert.deepEqual(paths, ['/v1/info'])
    mocked.mock.restore()
  }
})

test('production transport rejects a foreign condition before exposing recovery metadata', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    if (path === '/v1/info')
      return Response.json({ nuts: { CTF: { condition_keyset_filter: true } } })
    assert.equal(path, '/v1/conditional_keysets')
    return Response.json({ keysets: [descriptor('YES', 'cd'.repeat(32))], next_cursor: null })
  })
  await assert.rejects(
    createAllKeysetRecoveryTransport(mintUrl, 'msat', '07'.repeat(64)).listConditionalKeysets(
      conditionId,
    ),
    /foreign scope/,
  )
})

test('default regular discovery does not require CTF or enumerate conditions', async (t) => {
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname
    paths.push(path)
    assert.equal(path, '/v1/keysets')
    return Response.json({ keysets: [] })
  })
  assert.deepEqual(
    await createAllKeysetRecoveryTransport(mintUrl, 'msat', '07'.repeat(64)).listRegularKeysets(),
    { keysets: [] },
  )
  assert.deepEqual(paths, ['/v1/keysets'])
})
