import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { TokenImportKeysetRequest } from '@bitcaster-market/client-sdk/tokenImportValidation'
import { createDaemonTokenImportKeysetResolver } from '../src/tokenImportKeysetResolver.ts'

const REGULAR_ID = '0011223344556677'
const CONDITIONAL_ID = '00ffeeddccbbaa99'
const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('daemon resolver uses bounded shared parsing and rejects redirects', async () => {
  const calls: Array<{ url: string; redirect?: RequestRedirect }> = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), redirect: init?.redirect })
    const conditional = String(input).includes('conditional_keysets')
    return new Response(
      JSON.stringify({
        keysets: [
          {
            id: conditional ? CONDITIONAL_ID : REGULAR_ID,
            unit: conditional ? 'msat' : 'sat',
            active: false,
            ...(conditional ? { registered_at: 0 } : {}),
          },
        ],
      }),
    )
  }
  const resolver = createDaemonTokenImportKeysetResolver({
    allowInsecureLoopbackHttp: true,
    lookupHost: async () => [{ address: '127.0.0.1' }],
  })

  const result = await resolver(request())

  assert.deepEqual(result.regularKeysets, [{ keysetId: REGULAR_ID, unit: 'sat', active: false }])
  assert.deepEqual(result.conditionalKeysets, [
    { keysetId: CONDITIONAL_ID, unit: 'msat', active: false },
  ])
  assert.equal(calls.length, 2)
  assert.equal(
    calls.every((call) => call.redirect === 'error'),
    true,
  )
})

test('daemon resolver rejects oversized responses before body allocation', async () => {
  globalThis.fetch = async () =>
    new Response(null, { headers: { 'Content-Length': String(1_048_577) } })
  const resolver = createDaemonTokenImportKeysetResolver({
    allowInsecureLoopbackHttp: true,
    lookupHost: async () => [{ address: '127.0.0.1' }],
  })

  await assert.rejects(resolver(request()), /response byte limit exceeded/)
})

test('daemon resolver finds a conditional keyset on the next inclusive page', async () => {
  const prefix = '01d8a2e36a064e11'
  const fullId = `${prefix}${'ab'.repeat(25)}`
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: `01${(index + 1).toString(16).padStart(64, '0')}`,
    unit: 'sat',
    active: true,
    registered_at: index,
  }))
  const conditionalUrls: URL[] = []
  const checkedHosts: string[] = []
  const calls: Array<{ url: string; redirect?: RequestRedirect }> = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input))
    calls.push({ url: String(url), redirect: init?.redirect })
    if (url.pathname.endsWith('/keysets')) return new Response(JSON.stringify({ keysets: [] }))
    conditionalUrls.push(url)
    if (url.searchParams.has('since')) {
      return new Response(
        JSON.stringify({
          keysets: [
            firstPage.at(-1),
            { id: fullId, unit: 'sat', active: true, registered_at: 100 },
          ],
        }),
      )
    }
    return new Response(JSON.stringify({ keysets: firstPage }))
  }
  const resolver = createDaemonTokenImportKeysetResolver({
    allowInsecureLoopbackHttp: true,
    lookupHost: async (hostname) => {
      checkedHosts.push(hostname)
      return [{ address: '127.0.0.1' }]
    },
  })

  const result = await resolver(request([prefix], 512))

  assert.deepEqual(result.conditionalKeysets, [{ keysetId: fullId, unit: 'sat', active: true }])
  assert.deepEqual(
    conditionalUrls.map((url) => url.searchParams.get('limit')),
    ['100', '100'],
  )
  assert.deepEqual(
    conditionalUrls.map((url) => url.searchParams.get('since')),
    [null, '99'],
  )
  assert.equal(checkedHosts.length, 3)
  assert.equal(
    calls.every((call) => call.redirect === 'error'),
    true,
  )
})

function request(
  encodedKeysetIds: readonly string[] = [REGULAR_ID, CONDITIONAL_ID],
  maxCandidates = 8,
): TokenImportKeysetRequest {
  return {
    canonicalMintUrl: 'http://localhost:8085',
    encodedKeysetIds,
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10_000,
    maxCandidates,
  }
}
