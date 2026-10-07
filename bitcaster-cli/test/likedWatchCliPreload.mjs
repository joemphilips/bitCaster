import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { BitcasterEngineClient } from '@bitcaster-market/client-sdk/engineClient'
import { createMarketWatch } from '../../bitcaster-daemon/dist/marketWatch.js'
import { createLikedMarketWatch } from '../../bitcaster-daemon/dist/likedMarketWatch.js'
import { readRpcToken } from '../../bitcaster-daemon/dist/rpcAuth.js'
import { readSelectedDaemonSigner } from '../../bitcaster-daemon/dist/secrets.js'
import { validateDaemonWatchCommand } from '../../bitcaster-daemon/dist/protocol.js'

globalThis[Symbol.for('bitcaster.test.daemon-url')] = 'http://daemon.test'
const mode = process.env.BITCASTER_TEST_LIKED_WATCH_MODE ?? 'none'
const log = (entry) =>
  appendFileSync(process.env.BITCASTER_TEST_LIKED_WATCH_LOG, `${JSON.stringify(entry)}\n`)
let calls = 0,
  cancelled = 0,
  released = 0,
  signal,
  state = mode === 'first-closed' ? 'closed' : 'open'
process.once('beforeExit', () => {
  assert.equal(calls, mode === 'none' ? 0 : 1)
  if (mode === 'cancel') {
    assert.equal(signal.aborted, true)
    assert.equal(cancelled, 1)
    assert.equal(released, 1)
  }
})

globalThis.fetch = async (url, init) => {
  assert.notEqual(mode, 'none', 'Command must not make network requests.')
  calls++
  assert.equal(url, 'http://daemon.test/rpc')
  assert.equal(init.method, 'POST')
  assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${await readRpcToken()}`)
  assert.equal(new Headers(init.headers).get('accept'), 'application/x-ndjson')
  const command = validateDaemonWatchCommand(JSON.parse(init.body))
  assert.deepEqual(command, { method: 'market.watch', params: { liked: true } })
  log({ action: 'rpc', command })
  signal = init.signal
  const owners = new Map()
  const engine = new BitcasterEngineClient({
    baseUrl: 'https://engine.example',
    fetchImpl: async (input) => {
      const target = new URL(String(input))
      log({ action: 'engine', path: target.pathname + target.search })
      if (target.pathname.endsWith('/registration'))
        return Response.json({
          conditionId: target.pathname.split('/').at(-2),
          outcomes: ['YES', 'NO'],
          baseAsset: 'sat',
          divisibility: 1000,
        })
      if (target.pathname.endsWith('/query'))
        return Response.json({
          markets: [{ conditionId: target.searchParams.get('ids'), state }],
          nextCursor: null,
        })
      return Response.json({ marketId: target.pathname.split('/').at(-2), bids: [], asks: [] })
    },
  })
  const marketWatch = createMarketWatch({
    engine,
    hub: {
      start: async () => {},
      isConnected: () => true,
      setMarkets: async (owner, routes) => {
        owners.set(owner, routes)
        log({ action: 'joined', routes })
      },
      releaseMarkets: async (owner) => {
        owners.delete(owner)
        released++
        log({ action: 'released' })
      },
    },
  })
  const signer = await readSelectedDaemonSigner()
  const iterator = createLikedMarketWatch({
    marketWatch,
    assertCanWatch: () => {
      assert.equal(signer.enabled, true)
    },
  }).watch(signal)
  let finished = false
  return new Response(
    new ReadableStream({
      async pull(body) {
        try {
          if (finished) {
            await iterator.return()
            assert.equal(owners.size, 0)
            body.enqueue(new TextEncoder().encode('{"type":"complete"}\n'))
            body.close()
            return
          }
          const next = await iterator.next()
          if (next.done) {
            finished = true
            return this.pull(body)
          }
          body.enqueue(new TextEncoder().encode(JSON.stringify(next.value) + '\n'))
          if (
            next.value.event === 'market.closed' ||
            (mode === 'first-closed' && next.value.event === 'market.snapshot')
          )
            finished = true
          if (next.value.event === 'market.snapshot' && state === 'open') {
            if (mode === 'cancel') setImmediate(() => process.emit('SIGINT'))
            else {
              state = 'closed'
              marketWatch.invalidate(next.value.data.conditionId)
            }
          }
        } catch (error) {
          // Keep the response open on cancellation so the real client owns body cancellation.
          if (!signal.aborted) body.error(error)
        }
      },
      async cancel() {
        cancelled++
        await iterator.return()
        assert.equal(owners.size, 0)
      },
    }),
    { headers: { 'content-type': 'application/x-ndjson' } },
  )
}
