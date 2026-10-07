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
  return new Response(
    JSON.stringify({
      markets: ids
        .filter((id) => id !== 'unresolved')
        .reverse()
        .map((id) => ({ id, title: `Title ${id}`, state: 'Open' })),
      nextCursor: null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}
