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

function request(): TokenImportKeysetRequest {
  return {
    canonicalMintUrl: 'http://localhost:8085',
    encodedKeysetIds: [REGULAR_ID, CONDITIONAL_ID],
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 10_000,
    maxCandidates: 8,
  }
}
