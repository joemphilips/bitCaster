// This process meets relays that fail. The parent test checks that it lives
// until every socket closed and that it exits by itself.
import { once } from 'node:events'
import net, { type AddressInfo } from 'node:net'
import { finalizeEvent } from 'nostr-tools/pure'
import { WebSocketServer } from 'ws'
import { readPrimalProfileStats } from '@bitcaster-market/client-sdk/primalProfileIndexer'
import { NativeNostrRelay } from '../../src/nativeNostrRelay.ts'
import { publishNativeOracleEvent } from '../../src/nativeOraclePublication.ts'

const event = finalizeEvent(
  { kind: 88, created_at: 1_900_000_000, tags: [['title', 'Weather']], content: 'public' },
  new Uint8Array(32).fill(1),
)

async function tcpRelay(onRequest: (socket: net.Socket) => void) {
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('data', () => onRequest(socket))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = async () => {
    const closed = once(server, 'close')
    server.close()
    for (const socket of sockets) socket.destroy()
    await closed
  }
  return { url, close }
}

async function webSocketRelay(onMessage: (socket: import('ws').WebSocket, text: string) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  server.on('connection', (socket) => {
    socket.on('error', () => {})
    socket.on('message', (data) => onMessage(socket, String(data)))
  })
  await once(server, 'listening')
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`
  const close = async () => {
    const closed = once(server, 'close')
    server.close()
    for (const socket of server.clients) socket.terminate()
    await closed
  }
  return { url, close }
}

const unused = await tcpRelay(() => {})
await unused.close()
const relays = {
  // Nothing listens on this port any more.
  refused: { url: unused.url, close: async () => {} },
  stalled: await tcpRelay(() => {}),
  reset: await tcpRelay((socket) => socket.resetAndDestroy()),
  notWebSocket: await tcpRelay((socket) => socket.end('HTTP/1.1 503 Busy\r\n\r\n')),
  closesInSession: await webSocketRelay((socket) => socket.close(1001)),
  dropsInSession: await webSocketRelay((socket) => socket.terminate()),
}
const ready = await webSocketRelay((socket, text) => {
  const message = JSON.parse(text) as [string, { id: string }]
  if (message[0] === 'EVENT') socket.send(JSON.stringify(['OK', message[1].id, true, '']))
})

const outcomes: Record<string, string> = {}
const record = async (name: string, work: Promise<unknown>) => {
  outcomes[name] = await work.then(
    (value) => String(value),
    (error: unknown) => String(error),
  )
}

for (const [name, relay] of Object.entries(relays)) {
  await record(`publication ${name}`, publishNativeOracleEvent([relay.url], JSON.stringify(event)))
  await record(
    `session ${name}`,
    (async () => {
      const closed = Promise.withResolvers<void>()
      const owner = new NativeNostrRelay(relay.url, {
        connectTimeoutMs: 1_000,
        onclose: () => closed.resolve(),
      })
      await owner.connect()
      owner.subscribe([{ kinds: [88] }], { onevent: () => {} })
      await closed.promise
      return 'relay closed'
    })(),
  )
  await record(
    `indexer ${name}`,
    readPrimalProfileStats(event.pubkey, {
      timeoutMs: 1_000,
      openSocket: () => new WebSocket(relay.url),
    }),
  )
}
const mixed = await publishNativeOracleEvent(
  [...Object.values(relays).map((relay) => relay.url), ready.url],
  JSON.stringify(event),
)
outcomes.mixed = JSON.stringify({
  accepted: mixed.acceptedRelays.length,
  rejected: mixed.rejectedRelayCount,
})

for (const relay of [...Object.values(relays), ready]) await relay.close()
process.stdout.write(JSON.stringify(outcomes))
