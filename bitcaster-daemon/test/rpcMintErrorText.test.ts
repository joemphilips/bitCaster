import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { HttpResponseError, MintOperationError } from '@cashu/cashu-ts'
import { handleRequest } from '../src/server.ts'

// A mint answer can quote long text, such as a blinded message or a proof Y
// point. A generic wallet RPC error must not pass that text to the caller.
const RAW_MINT_TEXT = `Token already spent: ${'02ab'.repeat(40)}`

class RecordingResponse extends EventEmitter {
  writableEnded = false
  destroyed = false
  status = 0
  body = ''
  writeHead(status: number) {
    this.status = status
  }
  end(value: string) {
    this.body = value
    this.writableEnded = true
  }
}

async function rpcFailure(error: unknown) {
  const request = Object.assign(
    Readable.from([Buffer.from(JSON.stringify({ method: 'wallet.send', params: {} }))]),
    {
      method: 'POST',
      url: '/rpc',
      headers: { authorization: 'Bearer test-token' },
      socket: { remoteAddress: '127.0.0.1' },
    },
  ) as unknown as IncomingMessage
  const response = new RecordingResponse()
  await handleRequest(request, response as unknown as ServerResponse, 'test-token', {
    // The wallet RPC fails with this error before any funded work.
    isCustodyReady: () => {
      throw error
    },
  })
  assert.equal(response.status, 500)
  return { body: response.body, reply: JSON.parse(response.body) as Record<string, unknown> }
}

test('a coded mint refusal reaches the RPC error only as fixed text and bounded detail', async () => {
  const { body, reply } = await rpcFailure(
    new Error('wallet send failed', { cause: new MintOperationError(11001, RAW_MINT_TEXT) }),
  )

  assert.deepEqual(reply, {
    ok: false,
    error: 'mint request was refused (mint code 11001)',
    mintError: { code: 11001, detail: 'Token already spent: …' },
  })
  assert.ok(!body.includes('02ab02ab'))
})

test('an uncoded mint HTTP answer reaches the RPC error only as its status', async () => {
  const { body, reply } = await rpcFailure(new HttpResponseError(RAW_MINT_TEXT, 502))

  assert.deepEqual(reply, { ok: false, error: 'mint request failed (HTTP 502)' })
  assert.ok(!body.includes('Token already spent'))
})

test('an error without a mint answer keeps its own text', async () => {
  const { reply } = await rpcFailure(new Error('profile is locked'))

  assert.deepEqual(reply, { ok: false, error: 'profile is locked' })
})
