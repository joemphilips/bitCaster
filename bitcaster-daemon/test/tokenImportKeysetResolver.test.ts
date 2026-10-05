import { readFileSync } from 'node:fs'
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
        next_cursor: null,
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

test('daemon resolver finds a conditional keyset on the next cursor page', async () => {
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
    if (url.searchParams.has('cursor')) {
      return new Response(
        JSON.stringify({
          next_cursor: null,
          keysets: [
            firstPage.at(-1),
            { id: fullId, unit: 'sat', active: true, registered_at: 100 },
          ],
        }),
      )
    }
    return new Response(JSON.stringify({ keysets: firstPage, next_cursor: 'opaque+?/=' }))
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
    conditionalUrls.map((url) => url.searchParams.get('cursor')),
    [null, 'opaque+?/='],
  )
  assert.equal(checkedHosts.length, 3)
  assert.equal(
    calls.every((call) => call.redirect === 'error'),
    true,
  )
})

test('daemon resolver consumes all real producer pages and applies destination policy on each request', async () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../bitcaster-client-sdk/test/fixtures/ctf-pagination-real-registration-sqlite.json',
        import.meta.url,
      ),
      'utf8',
    ),
  )
  const target = fixture.keysets_pages[2].keysets[1]
  let destinationChecks = 0
  let pages = 0
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/keysets')) return Response.json({ keysets: [] })
    assert.equal(url.searchParams.has('active'), false)
    const cursor = url.searchParams.get('cursor')
    const index =
      cursor === null
        ? 0
        : fixture.keysets_pages.findIndex(
            (_page: unknown, index: number) =>
              index > 0 && fixture.keysets_pages[index - 1].next_cursor === cursor,
          )
    assert.ok(index >= 0, 'daemon must preserve the producer cursor')
    assert.deepEqual(
      Object.fromEntries(url.searchParams),
      Object.fromEntries(new URL(fixture.keysets_queries[index], url.origin).searchParams),
    )
    pages++
    return Response.json(fixture.keysets_pages[index])
  }
  const resolver = createDaemonTokenImportKeysetResolver({
    allowInsecureLoopbackHttp: true,
    lookupHost: async () => {
      destinationChecks++
      return [{ address: '127.0.0.1' }]
    },
  })
  const result = await resolver(request([target.id]))
  assert.equal(result.conditionalKeysets.length, 1)
  assert.equal(result.conditionalKeysets[0]?.keysetId, target.id)
  assert.equal(pages, 3)
  assert.equal(destinationChecks, 4)
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
