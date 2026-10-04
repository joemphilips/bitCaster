import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode } from 'nostr-tools/nip19'
import { createNativePaymentRequestReceiver } from '../src/nativePaymentRequestReceiver.ts'
import { fakeReceiverWebSocket } from './fixtures/nativeReceiverWebSocket.ts'
import {
  createPaymentRequestGiftwrap,
  paymentRequestFixtureSeed,
  paymentRequestFixtureRecipientPubkey,
} from '../../bitcaster-client-sdk/test/fixtures/nip17PaymentRequest.ts'

const seedHex = Buffer.from(paymentRequestFixtureSeed).toString('hex')
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function ready(
  t: { after(fn: () => void): void },
  input: {
    urls?: string[]
    onContent?: (content: string) => Promise<void>
    onclose?: () => void
  } = {},
) {
  const transport = fakeReceiverWebSocket()
  const abort = new AbortController()
  const receiver = createNativePaymentRequestReceiver({
    walletSeedHex: seedHex,
    relayUrls: input.urls ?? ['wss://custom.example/Path?B=Case&A=2'],
    websocketImplementation: transport.implementation,
    now: () => 1_900_000_000_000,
  })
  const opening = receiver.subscribe({
    signal: abort.signal,
    onContent: input.onContent ?? (async () => {}),
    onclose: input.onclose,
  })
  transport.sockets.forEach((socket) => socket.open())
  const owner = await opening
  t.after(() => owner.close())
  const frame = (index: number, wrap: unknown) => {
    const request = JSON.parse(
      transport.sockets[index]!.sent.find((value) => JSON.parse(value)[0] === 'REQ')!,
    )
    return JSON.stringify(['EVENT', request[1], wrap])
  }
  return { ...transport, receiver, owner, abort, frame }
}

test('seed identity and exact relay selection reach the real stream constructor', async (t) => {
  const current = await ready(t)
  const profile = decode(current.receiver.nprofile)
  assert.equal(profile.type, 'nprofile')
  if (profile.type !== 'nprofile') throw new Error('fixture profile is invalid')
  assert.equal(profile.data.pubkey, paymentRequestFixtureRecipientPubkey)
  assert.deepEqual(profile.data.relays, ['wss://custom.example/Path?B=Case&A=2'])
  const socket = current.sockets[0]!
  assert.equal(socket.url, 'wss://custom.example/Path?B=Case&A=2')
  assert.equal(socket.options.maxPayload, 4 * 1024 * 1024)
  assert.equal(socket.options.perMessageDeflate, false)
  const request = JSON.parse(socket.sent[0]!)
  assert.deepEqual(request[2], {
    kinds: [1059],
    '#p': [paymentRequestFixtureRecipientPubkey],
    since: 1_900_000_000 - 604800,
  })
})

test('empty selection and pre-abort create no socket', async () => {
  const transport = fakeReceiverWebSocket()
  const receiver = createNativePaymentRequestReceiver({
    walletSeedHex: seedHex,
    relayUrls: [],
    websocketImplementation: transport.implementation,
  })
  const owner = await receiver.subscribe({
    signal: new AbortController().signal,
    onContent: async () => {},
  })
  owner.close()
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(receiver.subscribe({ signal: abort.signal, onContent: async () => {} }), {
    message: 'native payment request receiver is unavailable',
  })
  assert.equal(transport.sockets.length, 0)
})

test('finite archive drains on the same socket after slow custody and residual buffered frames', async (t) => {
  const blocked = deferred()
  let calls = 0,
    running = 0,
    peak = 0
  const current = await ready(t, {
    onContent: async () => {
      calls += 1
      running += 1
      peak = Math.max(peak, running)
      if (calls === 1) await blocked.promise
      running -= 1
    },
  })
  const frames = Array.from({ length: 48 }, (_, index) =>
    current.frame(0, createPaymentRequestGiftwrap({ content: `archive-${index}` }).wrap),
  )
  current.sockets[0]!.archive(frames, 3)
  await turn()
  assert.equal(calls, 1)
  assert.equal(peak, 1)
  assert.equal(current.sockets[0]!.isPaused, true)
  assert.equal(current.sockets[0]!.closeCount, 0)
  assert.ok(current.sockets[0]!.backlog.length > 0)
  blocked.resolve()
  for (let index = 0; index < 100 && calls < frames.length; index += 1) await turn()
  assert.equal(calls, 48)
  assert.equal(peak, 1)
  assert.equal(current.sockets.length, 1)
  assert.equal(current.sockets[0]!.closeCount, 0)
})

test('malformed and foreign archive events do not block a valid payment request', async (t) => {
  const content: string[] = []
  const current = await ready(t, {
    onContent: async (value) => {
      content.push(value)
    },
  })
  const malformed = createPaymentRequestGiftwrap({ rumorPlaintext: '{invalid_plaintext}' })
  const foreign = createPaymentRequestGiftwrap({ recipientKey: new Uint8Array(32).fill(4) })
  const valid = createPaymentRequestGiftwrap({ content: 'valid-payment-request' })
  current.sockets[0]!.archive(
    [malformed, foreign, valid].map((message) => current.frame(0, message.wrap)),
  )
  for (let index = 0; index < 10 && content.length === 0; index += 1) await turn()
  assert.deepEqual(content, ['valid-payment-request'])
})

test('cross-relay duplicates await only one custody callback and fresh owner replays after abort', async (t) => {
  const blocked = deferred()
  let calls = 0
  const current = await ready(t, {
    urls: ['wss://a.example', 'wss://b.example'],
    onContent: async () => {
      calls += 1
      await blocked.promise
    },
  })
  const event = createPaymentRequestGiftwrap().wrap
  current.sockets.forEach((socket, index) => socket.archive([current.frame(index, event)]))
  await turn()
  assert.equal(calls, 1)
  current.abort.abort()
  blocked.resolve()
  await turn()
  assert.equal(calls, 1)
  assert.ok(current.sockets.every((socket) => socket.closeCount === 1))
  const opening = current.receiver.subscribe({
    signal: new AbortController().signal,
    onContent: async () => {
      calls += 1
    },
  })
  current.sockets.slice(2).forEach((socket) => socket.open())
  const restarted = await opening
  t.after(() => restarted.close())
  const request = JSON.parse(current.sockets[2]!.sent[0]!)
  current.sockets[2]!.archive([JSON.stringify(['EVENT', request[1], event])])
  await turn()
  assert.equal(calls, 2)
})

test('remote terminal notification occurs once only after all selected owners stop', async (t) => {
  let closed = 0
  const current = await ready(t, {
    urls: ['wss://a.example', 'wss://b.example'],
    onclose: () => {
      closed += 1
    },
  })
  current.sockets[0]!.remoteClose()
  assert.equal(closed, 0)
  current.sockets[1]!.remoteClose()
  await turn()
  assert.equal(closed, 1)
  current.owner.close()
  current.abort.abort()
  assert.equal(closed, 1)
})

test('an unmatched rumor can reach newly eligible custody on the same receiver', async (t) => {
  let eligible = false,
    deliveries = 0,
    accepted = 0
  const current = await ready(t, {
    onContent: async () => {
      deliveries += 1
      if (eligible) accepted += 1
    },
  })
  const initial = createPaymentRequestGiftwrap({ content: 'same-request-body' })
  current.sockets[0]!.archive([current.frame(0, initial.wrap)])
  await turn()
  assert.equal(deliveries, 1)
  assert.equal(accepted, 0)
  eligible = true
  // A fresh gift wrap can carry the same canonical rumor. Transport is not admission authority.
  const retry = createPaymentRequestGiftwrap({ content: 'same-request-body' })
  assert.equal(retry.rumorId, initial.rumorId)
  current.sockets[0]!.archive([current.frame(0, retry.wrap)])
  await turn()
  assert.equal(deliveries, 2)
  assert.equal(accepted, 1)
})

test('local abort closes a blocked callback without notification or late admission', async (t) => {
  const blocked = deferred()
  let calls = 0,
    notifications = 0
  const current = await ready(t, {
    onContent: async () => {
      calls += 1
      await blocked.promise
    },
    onclose: () => {
      notifications += 1
    },
  })
  current.sockets[0]!.archive([current.frame(0, createPaymentRequestGiftwrap().wrap)])
  await turn()
  current.abort.abort()
  blocked.resolve()
  current.sockets[0]!.open()
  current.sockets[0]!.archive([
    current.frame(0, createPaymentRequestGiftwrap({ content: 'late' }).wrap),
  ])
  await turn()
  assert.equal(calls, 1)
  assert.equal(notifications, 0)
  assert.equal(current.sockets[0]!.closeCount, 1)
})

test('refused startup and oversize wire frames fail with redacted terminal state', async (t) => {
  const transport = fakeReceiverWebSocket()
  const receiver = createNativePaymentRequestReceiver({
    walletSeedHex: seedHex,
    relayUrls: ['wss://a.example'],
    websocketImplementation: transport.implementation,
  })
  const opening = receiver.subscribe({
    signal: new AbortController().signal,
    onContent: async () => {},
  })
  transport.sockets[0]!.fail()
  await assert.rejects(opening, { message: 'native payment request receiver is unavailable' })
  let calls = 0,
    terminal = 0
  const current = await ready(t, {
    onContent: async () => {
      calls += 1
    },
    onclose: () => {
      terminal += 1
    },
  })
  current.sockets[0]!.archive(['x'.repeat(4 * 1024 * 1024 + 1)])
  await turn()
  assert.equal(calls, 0)
  assert.equal(terminal, 1)
  assert.equal(current.sockets[0]!.closeCount, 1)
})
