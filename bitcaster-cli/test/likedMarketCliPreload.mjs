import { appendFileSync } from 'node:fs'
import { bookmarkRelayFixture } from '../../bitcaster-daemon/test/bookmarkRelayFixture.ts'

const log = (entry) =>
  appendFileSync(process.env.BITCASTER_TEST_BOOKMARK_LOG, `${JSON.stringify(entry)}\n`)
globalThis.WebSocket = bookmarkRelayFixture({
  events: JSON.parse(process.env.BITCASTER_TEST_BOOKMARK_EVENTS ?? '[]'),
  failConnect: process.env.BITCASTER_TEST_BOOKMARK_FAIL_CONNECT === '1',
  failPublish: process.env.BITCASTER_TEST_BOOKMARK_FAIL_PUBLISH === '1',
  onFrame: (url, frame) => log({ action: 'relay', url, frame }),
}).websocketImplementation

globalThis.fetch = async (input) => {
  const url = new URL(String(input))
  if (url.origin !== 'https://engine.example' || url.pathname !== '/api/v1/markets/query')
    throw new Error('Unexpected network request in bookmark CLI fixture.')
  const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean)
  log({
    action: 'engine',
    ids,
    state: url.searchParams.get('state'),
    pageSize: url.searchParams.get('page_size'),
  })
  if (process.env.BITCASTER_TEST_BOOKMARK_FAIL_ENGINE === '1')
    throw new Error('Fixture engine unavailable.')
  // Public catalogue bounds: at most 100 IDs, page_size in [1, 50], default 20.
  // A filtered query returns one page only.
  const rawPageSize = url.searchParams.get('page_size')
  const pageSize = rawPageSize === null ? 20 : Number(rawPageSize)
  if (ids.length > 100 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 50)
    return new Response(JSON.stringify({ title: 'Bad Request' }), { status: 400 })
  const matches = ids
    .filter((id) => id !== 'unresolved')
    .reverse()
    .map((conditionId) => ({ conditionId, title: `Title ${conditionId}`, state: 'open' }))
  return new Response(
    JSON.stringify({
      markets: matches.slice(0, pageSize),
      nextCursor: matches.length > pageSize ? 'next-page' : null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}
