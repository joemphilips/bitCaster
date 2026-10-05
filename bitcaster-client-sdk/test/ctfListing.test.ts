import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { Mint, MintOperationError, type RequestFn, type ReqArgs } from '@cashu/cashu-ts'
import { selectPagedTokenImportKeysetCandidates } from '../src/tokenImportValidation.ts'
import { collectCtfListing } from '../src/ctfListing.ts'
import { CashuMintCtfSplitTransport } from '../src/ctfSplit.ts'

const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/ctf-pagination-real-registration-sqlite.json', import.meta.url),
    'utf8',
  ),
)

test('real mint pages retain every same-second condition and keyset through the SDK and mint decoder', async () => {
  const originalFetch = globalThis.fetch
  const queries: URL[] = []
  const nextByCursor = new Map<string | undefined, unknown>()
  fixture.keysets_pages.forEach((page: { next_cursor: string | null }, index: number) => {
    nextByCursor.set(index === 0 ? undefined : fixture.keysets_pages[index - 1].next_cursor, page)
  })
  globalThis.fetch = async (input) => {
    const url = new URL(String(input))
    queries.push(url)
    assert.deepEqual(
      Object.fromEntries(url.searchParams),
      Object.fromEntries(
        new URL(fixture.keysets_queries[queries.length - 1], url.origin).searchParams,
      ),
    )
    assert.equal(url.pathname, '/v1/conditional_keysets')
    assert.equal(url.searchParams.get('limit'), '100')
    assert.equal(url.searchParams.has('active'), false)
    const page = nextByCursor.get(url.searchParams.get('cursor') ?? undefined)
    assert.ok(page, 'the adapter must send the exact producer continuation')
    return new Response(JSON.stringify(page), { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const transport = new CashuMintCtfSplitTransport('https://mint.example')
    const keysets = await transport.getConditionalKeysets()
    assert.equal(keysets.length, 202)
    assert.deepEqual(keysets.map(({ id }) => id).sort(), [...fixture.keyset_ids].sort())
    assert.equal(queries.length, 3)
  } finally {
    globalThis.fetch = originalFetch
  }

  const conditionPages = new Map<string | undefined, unknown>()
  fixture.conditions_pages.forEach((page: { next_cursor: string | null }, index: number) => {
    conditionPages.set(
      index === 0 ? undefined : fixture.conditions_pages[index - 1].next_cursor,
      page,
    )
  })
  const request = (async (options: ReqArgs) => {
    const url = new URL(options.endpoint)
    if (url.pathname !== '/v1/conditions')
      throw new MintOperationError(13021, 'Condition not found')
    assert.equal(url.searchParams.get('limit'), '100')
    assert.equal(url.searchParams.has('since'), false)
    const page = conditionPages.get(url.searchParams.get('cursor') ?? undefined)
    assert.ok(page, 'condition lookup must preserve the producer continuation')
    return page
  }) as RequestFn
  const mint = new Mint('https://mint.example', { customRequest: request })
  const conditions = await collectCtfListing({
    fetchPage: async (cursor) => {
      const page = await mint.getConditions({ limit: 100, cursor })
      return { items: page.conditions, next_cursor: page.next_cursor }
    },
    getId: (condition) => condition.condition_id,
    maxRecords: 10_000,
    maxPages: 100,
  })
  assert.equal(conditions.length, 101)
  assert.deepEqual(
    conditions.map(({ condition_id }) => condition_id).sort(),
    [...fixture.condition_ids].sort(),
  )
  const targetId = fixture.conditions_pages[1].conditions[0].condition_id
  const target = await mint.getCtfCondition(targetId)
  assert.equal(target.condition_id, targetId)
  assert.equal(Object.keys(target.keysets).length, 2)
})

test('token import reads a requested inactive-capable keyset on the third real mint page', async () => {
  const target = fixture.keysets_pages[2].keysets[1]
  const queries: Array<{ limit: number; cursor?: string }> = []
  const result = await selectPagedTokenImportKeysetCandidates({
    request: {
      canonicalMintUrl: 'https://mint.example',
      encodedKeysetIds: [target.id],
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 10_000,
      maxCandidates: 1,
    },
    regularResponse: Promise.resolve({ keysets: [] }),
    fetchConditionalPage: async (query) => {
      queries.push(query)
      const index =
        query.cursor === undefined
          ? 0
          : fixture.keysets_pages.findIndex(
              (_page: unknown, index: number) =>
                index > 0 && fixture.keysets_pages[index - 1].next_cursor === query.cursor,
            )
      assert.ok(index >= 0, 'token import must send the real producer cursor')
      return fixture.keysets_pages[index]
    },
  })
  assert.equal(queries.length, 3)
  assert.equal(result.conditionalKeysets.length, 1)
  assert.equal(result.conditionalKeysets[0]?.keysetId, target.id)
})

test('complete listing follows short pages, deduplicates exact rows, and accepts a full terminal page', async () => {
  const pages = [
    { items: [{ id: 'first' }], next_cursor: 'opaque+?/=' },
    {
      items: [
        { id: 'first' },
        ...Array.from({ length: 99 }, (_, index) => ({ id: String(index) })),
      ],
      next_cursor: null,
    },
  ]
  const requests: Array<string | undefined> = []
  const result = await collectCtfListing({
    fetchPage: async (cursor) => {
      requests.push(cursor)
      return pages[requests.length - 1]!
    },
    getId: ({ id }) => id,
    maxRecords: 101,
    maxPages: 2,
  })
  assert.equal(result.length, 100)
  assert.deepEqual(requests, [undefined, 'opaque+?/='])
})

for (const cursor of [undefined, '', true, {}, 'x'.repeat(4097)]) {
  test(`complete listing rejects an invalid continuation (${typeof cursor})`, async () => {
    await assert.rejects(
      collectCtfListing({
        fetchPage: async () => ({ items: [{ id: 'first' }], next_cursor: cursor }),
        getId: ({ id }) => id,
        maxRecords: 100,
        maxPages: 1,
      }),
      /invalid CTF continuation cursor/,
    )
  })
}

test('complete listing rejects repeated cursors and failed later pages', async () => {
  let calls = 0
  await assert.rejects(
    collectCtfListing({
      fetchPage: async () => {
        calls += 1
        return { items: [{ id: 'same' }], next_cursor: 'same' }
      },
      getId: ({ id }) => id,
      maxRecords: 100,
      maxPages: 100,
    }),
    /pagination did not advance/,
  )
  assert.equal(calls, 2)
  calls = 0
  await assert.rejects(
    collectCtfListing({
      fetchPage: async () => {
        if (calls++ === 0) return { items: [{ id: 'first' }], next_cursor: 'second' }
        throw new Error('later page failed')
      },
      getId: ({ id }) => id,
      maxRecords: 100,
      maxPages: 100,
    }),
    /later page failed/,
  )
})

test('complete listing enforces record and page bounds and rejects conflicting duplicates', async () => {
  await assert.rejects(
    collectCtfListing({
      fetchPage: async () => ({ items: [{ id: 'one' }, { id: 'two' }], next_cursor: null }),
      getId: ({ id }) => id,
      maxRecords: 1,
      maxPages: 1,
    }),
    /record limit/,
  )
  await assert.rejects(
    collectCtfListing({
      fetchPage: async () => ({ items: [], next_cursor: 'more' }),
      getId: ({ id }: { id: string }) => id,
      maxRecords: 100,
      maxPages: 1,
    }),
    /page bound/,
  )
  await assert.rejects(
    collectCtfListing({
      fetchPage: async () => ({
        items: [
          { id: 'one', active: true },
          { id: 'one', active: false },
        ],
        next_cursor: null,
      }),
      getId: ({ id }) => id,
      maxRecords: 100,
      maxPages: 1,
    }),
    /conflicting CTF listing metadata/,
  )
})
