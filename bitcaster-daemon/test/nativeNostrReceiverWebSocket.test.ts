import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createNativeNostrReceiverWebSocket } from '../src/nativeNostrReceiverWebSocket.ts'
import { fakeReceiverWebSocket } from './fixtures/nativeReceiverWebSocket.ts'

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

test('stream cancellation owns connecting socket and ignores late open', async () => {
  const fake = fakeReceiverWebSocket()
  const Constructor = createNativeNostrReceiverWebSocket(fake.implementation)
  const socket = new Constructor('wss://custom.example/Exact?Case=Yes')
  let opened = 0
  socket.onopen = () => {
    opened += 1
  }
  socket.close()
  socket.close()
  fake.sockets[0]!.open()
  await turn()
  assert.equal(opened, 0)
  assert.equal(fake.sockets[0]!.closeCount, 1)
  assert.equal(fake.sockets[0]!.listenerCount('open'), 0)
})

test('real installed stream pauses residual frames and terminal close never resumes a late callback', async () => {
  const fake = fakeReceiverWebSocket()
  const Constructor = createNativeNostrReceiverWebSocket(fake.implementation)
  const socket = new Constructor('wss://custom.example')
  let finish!: () => void
  const blocked = new Promise<void>((resolve) => {
    finish = resolve
  })
  let messages = 0
  socket.onmessage = (async () => {
    messages += 1
    await blocked
  }) as WebSocket['onmessage']
  fake.sockets[0]!.open()
  fake.sockets[0]!.archive(
    Array.from({ length: 30 }, () => 'frame'),
    2,
  )
  await turn()
  assert.equal(messages, 1)
  assert.equal(fake.sockets[0]!.isPaused, true)
  const resumes = fake.sockets[0]!.resumeCount
  socket.close()
  finish()
  await turn()
  assert.equal(messages, 1)
  assert.equal(fake.sockets[0]!.resumeCount, resumes)
  assert.equal(fake.sockets[0]!.closeCount, 1)
})

test('binary frames and rejected callbacks terminate without exposing raw error', async () => {
  for (const mode of ['binary', 'callback'] as const) {
    const fake = fakeReceiverWebSocket()
    const Constructor = createNativeNostrReceiverWebSocket(fake.implementation)
    const socket = new Constructor('wss://custom.example')
    let closed = 0,
      exposed = 0
    socket.onclose = () => {
      closed += 1
    }
    socket.onerror = () => {
      exposed += 1
    }
    socket.onmessage = (async () => {
      throw new Error('private content')
    }) as WebSocket['onmessage']
    fake.sockets[0]!.open()
    if (mode === 'binary') fake.sockets[0]!.emit('message', Buffer.from('private binary'), true)
    else fake.sockets[0]!.archive(['valid text'])
    await turn()
    assert.equal(closed, 1)
    assert.equal(exposed, 0)
    assert.equal(fake.sockets[0]!.closeCount, 1)
  }
})
