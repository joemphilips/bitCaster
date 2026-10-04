import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import test from 'node:test'
import { CheckStateEnum } from '@cashu/cashu-ts'
import { awaitAbortable } from '@bitcaster-market/client-sdk/engineClient'
import {
  NativePaymentRequestService,
  type NativePaymentRequestReceiver,
} from '../src/nativePaymentRequestService.ts'
import { dispatch, handleRequest, type EngineClientLike } from '../src/server.ts'
import { DAEMON_WATCH_MEDIA_TYPE, type DaemonCommand } from '../src/protocol.ts'
import { createCustodyReadinessTracker } from '../src/startupRecovery.ts'
import { disconnectDaemonSigner } from '../src/secrets.ts'
import { assertRedacted, message, serviceFixture } from './nativePaymentRequestServiceFixture.ts'

const TOKEN = 'fixture-auth-token'
class Response extends EventEmitter {
  status = 0
  lines: string[] = []
  destroyed = false
  ended = false
  writeHead(status: number) {
    this.status = status
  }
  write(line: string) {
    this.lines.push(line)
    this.emit('frame')
    return true
  }
  end(line?: string) {
    if (line !== undefined) this.lines.push(line)
    this.ended = true
  }
  asResponse() {
    return this as unknown as ServerResponse
  }
}
function request(command: unknown, authorization = `Bearer ${TOKEN}`, watch = false) {
  let consumed = 0
  const stream = Readable.from(
    (async function* () {
      consumed++
      yield Buffer.from(JSON.stringify(command))
    })(),
  )
  return {
    consumed: () => consumed,
    request: Object.assign(stream, {
      method: 'POST',
      url: '/rpc',
      headers: { authorization, ...(watch ? { accept: DAEMON_WATCH_MEDIA_TYPE } : {}) },
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage,
  }
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  assert.fail('expected lifecycle transition did not occur')
}
async function fixture() {
  const f = await serviceFixture()
  const readiness = createCustodyReadinessTracker({
    nonRetirementPending: false,
    retryPending: false,
    retirementPending: false,
  })
  let subscribed = 0
  let closed = 0
  let triggered = 0
  let receive: ((content: string) => Promise<void>) | undefined
  const receiver: NativePaymentRequestReceiver = {
    nprofile: f.nprofile,
    subscribe: async (input) => {
      assert.equal(await f.requestCount(), 1, 'request was not persisted before receiver I/O')
      subscribed++
      receive = input.onContent
      return {
        close: () => {
          closed++
        },
      }
    },
  }
  const service = new NativePaymentRequestService({
    ops: f.ops,
    receiver,
    directory: f.directory,
    isCustodyReady: readiness.isReady,
    triggerCustodyRecovery: () => {
      triggered++
    },
  })
  const deps = {
    ...f.deps,
    nativePaymentRequests: service,
    isCustodyReady: readiness.isReady,
    onManualCustodyRecoveryStatus: readiness.updateManualRecovery,
    createEngineClient: () => ({}) as EngineClientLike,
  }
  return {
    ...f,
    readiness,
    service,
    deps,
    subscribed: () => subscribed,
    closed: () => closed,
    triggered: () => triggered,
    receive: async (content = message()) => {
      assert.ok(receive)
      await receive(content)
    },
    close: async () => {
      await service.stop()
      await f.close()
    },
  }
}

test('disconnected RPC persists an amountless wallet-seed request and allows every request command', async () => {
  const f = await fixture()
  try {
    await disconnectDaemonSigner(0)
    const req = request({ method: 'wallet.request.create', params: { requestId: 'request' } })
    const res = new Response()
    await handleRequest(req.request, res.asResponse(), TOKEN, f.deps)
    assert.equal(res.status, 200)
    const result = JSON.parse(res.lines[0]!)
    assert.equal(result.ok, true)
    assert.equal(result.result.unit, 'msat')
    assert.equal(result.result.mintUrl, 'https://mint.example')
    assert.equal('amount' in result.result, false)
    assert.equal('nostrSecretKeyHex' in result.result, false)
    assert.equal(
      (
        await dispatch(
          { method: 'wallet.request.create', params: { requestId: 'request' } },
          f.deps,
        )
      ).ok,
      true,
    )
    assert.equal(f.subscribed(), 1)
    assert.equal(await f.requestCount(), 1)
    for (const command of [
      { method: 'wallet.request.status', params: { requestId: 'request' } },
      { method: 'wallet.request.list' },
      { method: 'wallet.request.recover', params: { requestId: 'request' } },
    ] satisfies DaemonCommand[]) {
      const response = await dispatch(command, f.deps)
      assert.equal(response.ok, true, command.method)
      assertRedacted(response)
    }
    assertRedacted(result)
  } finally {
    await f.close()
  }
})

test('disconnected NDJSON request watch bypasses generic watch, credits once, and completes', async () => {
  const f = await fixture()
  try {
    await disconnectDaemonSigner(0)
    await f.service.create({ requestId: 'request' })
    const req = request(
      { method: 'wallet.request.watch', params: { requestId: 'request' } },
      `Bearer ${TOKEN}`,
      true,
    )
    const res = new Response()
    const streaming = handleRequest(req.request, res.asResponse(), TOKEN, {
      ...f.deps,
      watch: () => {
        assert.fail('request watch reached the generic watch owner')
      },
    })
    await until(() => res.lines.length === 1)
    assert.equal(JSON.parse(res.lines[0]!).data.state, 'awaiting')
    await f.receive()
    await streaming
    await f.receive(message(true))
    const frames = res.lines.map((line) => JSON.parse(line))
    assert.equal(frames.at(-1).type, 'complete')
    assert.equal(frames.filter((frame) => frame.data?.state === 'credited').length, 1)
    assert.equal(f.counts.prepared, 1)
    assert.equal(await f.targetCount(), 2)
    assert.equal(f.closed(), 0, 'terminal watch discarded the process receiver')
    assertRedacted(frames)
  } finally {
    await f.close()
  }
})

test('watch cancellation cleans up a waiting iterator but preserves request and receiver', async () => {
  const f = await fixture()
  try {
    await f.service.create({ requestId: 'request' })
    const signal = new AbortController()
    const iterator = f.service.watch('request', signal.signal)[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).done, false)
    const waiting = iterator.next()
    signal.abort()
    assert.equal((await waiting).done, true)
    const disconnected = request(
      { method: 'wallet.request.watch', params: { requestId: 'request' } },
      `Bearer ${TOKEN}`,
      true,
    )
    const disconnectedResponse = new Response()
    const streaming = handleRequest(
      disconnected.request,
      disconnectedResponse.asResponse(),
      TOKEN,
      f.deps,
    )
    await until(() => disconnectedResponse.lines.length === 1)
    disconnectedResponse.destroyed = true
    disconnectedResponse.emit('close')
    await streaming
    await f.receive()
    assert.equal((await f.service.status({ requestId: 'request' })).state, 'credited')
    assert.equal(f.closed(), 0)
    const req = request(
      { method: 'wallet.request.watch', params: { requestId: 'request' } },
      'Bearer wrong',
      true,
    )
    const res = new Response()
    await handleRequest(req.request, res.asResponse(), TOKEN, f.deps)
    assert.equal(res.status, 401)
    assert.equal(req.consumed(), 0)
    await f.service.create({ requestId: 'request2' })
    const terminal = f.service
      .watch('request2', new AbortController().signal)
      [Symbol.asyncIterator]()
    await terminal.next()
    const terminalWaiting = terminal.next()
    await f.service.stop()
    assert.equal((await terminalWaiting).done, true)
    assert.equal(f.closed(), 1)
  } finally {
    await f.close()
  }
})

test('pending funds gate refuses create and pauses admission; bounded manual recovery resumes after gate update', async () => {
  const f = await fixture()
  try {
    await f.service.create({ requestId: 'request' })
    f.control.failAfterMintEffect = true
    await f.receive()
    assert.equal(f.triggered(), 1)
    assert.equal((await f.service.status({ requestId: 'request' })).state, 'pending')
    f.readiness.updateManualRecovery({
      nonRetirementPending: true,
      retryPending: true,
      retirementPending: false,
    })
    assert.equal(await f.service.resumeReceiving(), false)
    assert.equal(f.closed(), 1)
    assert.equal(
      (
        await dispatch(
          { method: 'wallet.request.create', params: { requestId: 'blocked' } },
          f.deps,
        )
      ).ok,
      false,
    )
    assert.equal(
      (
        await dispatch(
          { method: 'wallet.request.status', params: { requestId: 'request' } },
          f.deps,
        )
      ).ok,
      true,
    )
    assert.equal((await dispatch({ method: 'wallet.request.list' }, f.deps)).ok, true)
    f.control.state = CheckStateEnum.SPENT
    f.control.restore = true
    const recovered = await dispatch({ method: 'wallet.recover' }, f.deps)
    assert.equal(recovered.ok, true)
    assert.equal(f.readiness.isReady(), true)
    assert.equal(f.subscribed(), 1, 'credited-only history opened another receiver')
    assert.equal((await f.service.status({ requestId: 'request' })).state, 'credited')
    assert.equal(f.counts.prepared, 1)
    assert.equal(f.counts.swaps, 1)
    assert.equal(await f.targetCount(), 2)
    assertRedacted(recovered)
  } finally {
    await f.close()
  }
})

test('strict request commands reject injected authority and redact receiver failures', async () => {
  const f = await fixture()
  try {
    const invalid: unknown[] = [
      { method: 'wallet.request.create', params: { amount: 1 } },
      { method: 'wallet.request.create', params: { mintUrl: 'https://other.example' } },
      { method: 'wallet.request.create', params: { nprofile: f.nprofile } },
      { method: 'wallet.request.status', params: { requestId: '' } },
      { method: 'wallet.request.recover', params: { requestId: 'request', scopeId: 'foreign' } },
      { method: 'wallet.request.list', params: { pageSize: 257 } },
      { method: 'wallet.request.list', params: { cursor: [] } },
    ]
    for (const command of invalid) {
      const response = await dispatch(command as DaemonCommand, f.deps)
      assert.equal(response.ok, false)
      assert.equal(response.code, 'invalid-payment-request')
    }
    assert.equal(f.subscribed(), 0)
    assert.equal(await f.requestCount(), 0)
    for (const params of [null, [], { requestId: '' }, { requestId: 'request', proofs: [] }]) {
      const req = request({ method: 'wallet.request.watch', params }, `Bearer ${TOKEN}`, true)
      const res = new Response()
      await handleRequest(req.request, res.asResponse(), TOKEN, f.deps)
      assert.equal(res.status, 400)
    }
    const unknown = request(
      { method: 'wallet.request.watch', params: { requestId: 'unknown' } },
      `Bearer ${TOKEN}`,
      true,
    )
    const unknownResponse = new Response()
    await handleRequest(unknown.request, unknownResponse.asResponse(), TOKEN, f.deps)
    assert.equal(JSON.parse(unknownResponse.lines[0]!).code, 'watch-failed')
    assertRedacted(unknownResponse.lines)
    const unavailable = new NativePaymentRequestService({
      ops: f.ops,
      directory: f.directory,
      receiver: {
        nprofile: f.nprofile,
        subscribe: async () => {
          throw new Error(message())
        },
      },
      isCustodyReady: () => true,
      triggerCustodyRecovery: () => {},
    })
    try {
      const response = await dispatch(
        { method: 'wallet.request.create', params: { requestId: 'request' } },
        { nativePaymentRequests: unavailable },
      )
      assert.equal(response.ok, false)
      assertRedacted(response)
      assert.equal(await f.requestCount(), 1, 'subscription failure deleted durable request')
    } finally {
      await unavailable.stop()
    }
  } finally {
    await f.close()
  }
})

test('terminal stop cancels opening and closes a late receiver exactly once', async () => {
  const f = await serviceFixture()
  let complete: ((connection: { close(): void }) => void) | undefined
  let signal: AbortSignal | undefined
  let closes = 0
  let entered!: () => void
  let didClose!: () => void
  const subscriptionEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  const lateClosed = new Promise<void>((resolve) => {
    didClose = resolve
  })
  const service = new NativePaymentRequestService({
    ops: f.ops,
    directory: f.directory,
    receiver: {
      nprofile: f.nprofile,
      subscribe: (input) => {
        signal = input.signal
        return new Promise((resolve) => {
          complete = resolve
          entered()
        })
      },
    },
    isCustodyReady: () => true,
    triggerCustodyRecovery: () => {},
  })
  try {
    const opening = service.create({ requestId: 'request' })
    const failed = assert.rejects(opening, {
      message: 'native payment request receiver is unavailable',
    })
    await awaitAbortable(subscriptionEntered, AbortSignal.timeout(5000))
    await service.stop()
    await failed
    assert.equal(signal?.aborted, true)
    complete!({
      close: () => {
        closes++
        didClose()
      },
    })
    await awaitAbortable(lateClosed, AbortSignal.timeout(5000))
    await service.stop()
    assert.equal(closes, 1)
    assert.equal(await service.resumeReceiving(), false)
  } finally {
    await service.stop()
    await f.close()
  }
})

test('restart resumes retained requests only after existing startup recovery clears the funds gate', async () => {
  const f = await fixture()
  let restarted: NativePaymentRequestService | undefined
  let subscriptions = 0
  try {
    await f.service.create({ requestId: 'request' })
    f.control.failAfterMintEffect = true
    await f.receive()
    await f.service.stop()
    f.readiness.updateManualRecovery({
      nonRetirementPending: true,
      retryPending: true,
      retirementPending: false,
    })
    restarted = new NativePaymentRequestService({
      ops: f.createOps(),
      directory: f.directory,
      receiver: {
        nprofile: f.nprofile,
        subscribe: async () => {
          subscriptions++
          return { close: () => {} }
        },
      },
      isCustodyReady: f.readiness.isReady,
      triggerCustodyRecovery: () => {},
    })
    assert.equal(await restarted.resumeReceiving(), false)
    assert.equal(subscriptions, 0)
    const status = await dispatch(
      { method: 'wallet.request.status', params: { requestId: 'request' } },
      { ...f.deps, nativePaymentRequests: restarted },
    )
    assert.equal(status.ok, true)
    f.control.state = CheckStateEnum.SPENT
    f.control.restore = true
    const recovery = await dispatch(
      { method: 'wallet.recover' },
      { ...f.deps, nativePaymentRequests: restarted },
    )
    assert.equal(recovery.ok, true)
    assert.equal(subscriptions, 0, 'credited-only history opened a restart receiver')
    assert.equal((await restarted.status({ requestId: 'request' })).state, 'credited')
    assert.equal(f.counts.prepared, 1)
    assert.equal(f.counts.swaps, 1)
    assert.equal(f.counts.restores, 1)
    assert.equal(await f.targetCount(), 2)
    assertRedacted([status, recovery])
  } finally {
    await restarted?.stop()
    await f.close()
  }
})
