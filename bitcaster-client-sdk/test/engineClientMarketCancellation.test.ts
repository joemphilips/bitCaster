import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BitcasterEngineClient } from '../src/engineClient.ts'

const conditionId = 'ab'.repeat(32)
const reads = [
  [
    'registration',
    (client: BitcasterEngineClient, signal: AbortSignal) =>
      client.getMarketRegistration(conditionId, signal),
  ],
  [
    'market',
    (client: BitcasterEngineClient, signal: AbortSignal) => client.getMarket(conditionId, signal),
  ],
  [
    'query',
    (client: BitcasterEngineClient, signal: AbortSignal) =>
      client.queryMarkets({ ids: [conditionId] }, signal),
  ],
  [
    'order book',
    (client: BitcasterEngineClient, signal: AbortSignal) =>
      client.getOrderBook(`${conditionId}-YES`, signal),
  ],
] as const

for (const [name, read] of reads) {
  test(`${name} read skips authorization and fetch after cancellation`, async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const client = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
      authorization: async () => {
        calls++
        return 'test'
      },
      fetchImpl: async () => {
        calls++
        return new Response(null, { status: 404 })
      },
    })
    await assert.rejects(read(client, controller.signal), /aborted/)
    assert.equal(calls, 0)
  })

  test(`${name} read does not fetch after cancellation during signing`, async () => {
    const controller = new AbortController()
    let finishSigning!: (value: string) => void
    let fetches = 0
    const client = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
      authorization: () =>
        new Promise<string>((resolve) => {
          finishSigning = resolve
        }),
      fetchImpl: async () => {
        fetches++
        return new Response(null, { status: 404 })
      },
    })
    const pending = read(client, controller.signal)
    controller.abort()
    finishSigning('test')
    await assert.rejects(pending, /aborted/)
    assert.equal(fetches, 0)
  })

  test(`${name} read passes its cancellation signal to fetch`, async () => {
    const controller = new AbortController()
    let requests = 0
    const client = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
      fetchImpl: async (_input, init) => {
        requests++
        assert.equal(init?.signal, controller.signal)
        return new Promise<Response>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => reject(controller.signal.reason), {
            once: true,
          })
          controller.abort()
        })
      },
    })
    await assert.rejects(read(client, controller.signal), /aborted/)
    assert.equal(requests, 1)
  })

  test(`${name} read cancels a late response body without decoding it`, async () => {
    const controller = new AbortController()
    let cancelled = 0
    let decoded = 0
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled++
        },
      }),
    )
    response.json = async () => {
      decoded++
      throw new Error('unexpected body decode')
    }
    const client = new BitcasterEngineClient({
      baseUrl: 'https://engine.example',
      fetchImpl: async () => {
        controller.abort()
        return response
      },
    })
    await assert.rejects(read(client, controller.signal), /aborted/)
    assert.equal(cancelled, 1)
    assert.equal(decoded, 0)
  })
}
