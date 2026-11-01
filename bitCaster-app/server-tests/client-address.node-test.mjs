import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request } from 'node:http'
import net from 'node:net'
import { after, test } from 'node:test'

const deadline = 5000
const headerLines = (rawHeaders, name) =>
  rawHeaders.filter((_, index) => index % 2 === 1 && rawHeaders[index - 1].toLowerCase() === name)
const observed = (req) => ({
  clientAddress: headerLines(req.rawHeaders, 'x-bitcaster-client-ip'),
  forwardedHost: headerLines(req.rawHeaders, 'x-forwarded-host'),
  forwardedProto: headerLines(req.rawHeaders, 'x-forwarded-proto'),
})

// The backend and the mint answer with the forwarded header lines that they received.
const backend = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(observed(req)))
})
backend.on('upgrade', (req, socket) => {
  socket.end(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
      `x-observed: ${JSON.stringify(observed(req))}\r\n\r\n`,
  )
})
let frontend
after(async () => {
  frontend?.closeAllConnections()
  backend.closeAllConnections()
  await Promise.all([
    frontend ? new Promise((resolve) => frontend.close(resolve)) : undefined,
    new Promise((resolve) => backend.close(resolve)),
  ])
})
backend.listen(0, '127.0.0.1')
await once(backend, 'listening', { signal: AbortSignal.timeout(deadline) })

process.env.PORT = '0'
process.env.BACKEND_URL = `http://127.0.0.1:${backend.address().port}`
process.env.MINT_URL = process.env.BACKEND_URL
// The server listens when it is imported. Keep its instance to read the assigned port and to close it.
const listen = net.Server.prototype.listen
net.Server.prototype.listen = function (...args) {
  frontend = this
  return listen.apply(this, args)
}
let server
try {
  server = await import('../server.js')
} finally {
  net.Server.prototype.listen = listen
}
if (!frontend.listening)
  await once(frontend, 'listening', { signal: AbortSignal.timeout(deadline) })
const { clientAddressFromForwardedFor } = server
// Node sends this Host header for a request to the frontend.
const frontendHost = `127.0.0.1:${frontend.address().port}`

function send(path, headers, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: frontend.address().port,
        path,
        method,
        headers,
        signal: AbortSignal.timeout(deadline),
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () =>
          res.statusCode === 200
            ? resolve(JSON.parse(body))
            : reject(new Error(`HTTP ${res.statusCode}`)),
        )
      },
    )
    req.on('error', reject)
    req.end()
  })
}

function upgrade(path, headers) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: frontend.address().port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        ...headers,
      },
      signal: AbortSignal.timeout(deadline),
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(JSON.parse(res.headers['x-observed']))
    })
    req.on('response', (res) => {
      res.resume()
      reject(new Error(`Upgrade refused with HTTP ${res.statusCode}`))
    })
    req.on('error', reject)
    req.end()
  })
}

const spoofed = {
  'x-bitcaster-client-ip': '198.51.100.99',
  'x-forwarded-host': 'evil.example',
}

// Keep this test first. The proxy library subscribes its own upgrade listener on the
// first HTTP request that reaches it, and later tests make HTTP requests.
test('a WebSocket upgrade before any HTTP request carries only this server headers', async () => {
  // Only the server's own upgrade listener exists, and it calls the proxy upgrade.
  assert.equal(frontend.listenerCount('upgrade'), 1)
  assert.deepEqual(
    await upgrade('/hubs/probe', {
      ...spoofed,
      'x-forwarded-for': '198.51.100.1, [2001:db8::1]:5678',
    }),
    { clientAddress: ['2001:db8::1'], forwardedHost: [frontendHost], forwardedProto: ['http'] },
  )
})

test('takes the rightmost X-Forwarded-For element and strips its port', () => {
  for (const [forwardedFor, expected] of [
    ['203.0.113.7', '203.0.113.7'],
    ['203.0.113.7:5678', '203.0.113.7'],
    ['198.51.100.1, 203.0.113.7', '203.0.113.7'],
    ['198.51.100.1,203.0.113.7:5678', '203.0.113.7'],
    ['[2001:db8::1]:5678', '2001:db8::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['198.51.100.1, 2001:db8::1', '2001:db8::1'],
    ['::ffff:203.0.113.7', '::ffff:203.0.113.7'],
  ]) {
    assert.equal(clientAddressFromForwardedFor(forwardedFor), expected, forwardedFor)
  }
})

test('refuses a missing or malformed rightmost element, whatever the elements to its left are', () => {
  for (const forwardedFor of [
    undefined,
    '',
    'garbage',
    'unknown',
    '203.0.113.7, garbage',
    '203.0.113.7,',
    '203.0.113.7:',
    '203.0.113.7:port',
    '203.0.113.7 5678',
    '[203.0.113.7]:5678',
    '[2001:db8::1',
    'fe80::1%eth0',
    '[fe80::1%eth0]:5678',
    '01.2.3.4',
  ]) {
    assert.equal(clientAddressFromForwardedFor(forwardedFor), undefined, String(forwardedFor))
  }
})

test('the API proxy forwards only its own client-address header', async () => {
  const clientAddress = async (headers) => (await send('/api/probe', headers)).clientAddress
  assert.deepEqual(
    await clientAddress({ ...spoofed, 'x-forwarded-for': '198.51.100.1, 203.0.113.7:5678' }),
    ['203.0.113.7'],
  )
  assert.deepEqual(
    await clientAddress({ ...spoofed, 'x-forwarded-for': ['198.51.100.1', '[2001:db8::1]:5678'] }),
    ['2001:db8::1'],
  )
  assert.deepEqual(
    await clientAddress({
      'x-bitcaster-client-ip': ['198.51.100.98', '198.51.100.99'],
      'x-forwarded-for': '203.0.113.7',
    }),
    ['203.0.113.7'],
  )
  assert.deepEqual(await clientAddress({ ...spoofed }), [])
  assert.deepEqual(await clientAddress({ ...spoofed, 'x-forwarded-for': 'garbage' }), [])
  // The proxy skips its request hook when the request has an Expect header.
  assert.deepEqual(await clientAddress({ ...spoofed, expect: '100-continue' }), [])
  assert.deepEqual(
    await clientAddress({
      ...spoofed,
      expect: '100-continue',
      'x-forwarded-for': '198.51.100.1, 203.0.113.7',
    }),
    ['203.0.113.7'],
  )
})

test('the API proxy forwards the browser-facing host and protocol, with or without Expect', async () => {
  const headers = { ...spoofed, 'x-forwarded-proto': 'http, https' }
  const expected = { forwardedHost: [frontendHost], forwardedProto: ['https'] }
  const forwarded = ({ forwardedHost, forwardedProto }) => ({ forwardedHost, forwardedProto })
  assert.deepEqual(forwarded(await send('/api/probe', headers)), expected)
  assert.deepEqual(
    forwarded(await send('/api/probe', { ...headers, expect: '100-continue' })),
    expected,
  )
})

test('the API proxy ignores a rightmost protocol that is not a web scheme', async () => {
  // This test server is plain HTTP, so the fallback is http.
  const forwarded = await send('/api/probe', { ...spoofed, 'x-forwarded-proto': 'https, evil' })
  assert.deepEqual(forwarded.forwardedProto, ['http'])
})

test('the hub proxy forwards only its own forwarded headers over HTTP and WebSocket', async () => {
  assert.deepEqual(
    await send(
      '/hubs/market/negotiate?negotiateVersion=1',
      { ...spoofed, 'x-forwarded-for': '203.0.113.7:5678' },
      'POST',
    ),
    { clientAddress: ['203.0.113.7'], forwardedHost: [frontendHost], forwardedProto: ['http'] },
  )
  assert.deepEqual((await send('/hubs/probe', { ...spoofed })).clientAddress, [])
  // The proxy library now handles the upgrade with its own listener.
  assert.equal(frontend.listenerCount('upgrade'), 2)
  assert.deepEqual(
    await upgrade('/hubs/probe', {
      ...spoofed,
      'x-forwarded-for': '198.51.100.1, [2001:db8::1]:5678',
    }),
    { clientAddress: ['2001:db8::1'], forwardedHost: [frontendHost], forwardedProto: ['http'] },
  )
  assert.deepEqual((await upgrade('/hubs/probe', { ...spoofed })).clientAddress, [])
})

test('the mint proxy forwards no client-address header', async () => {
  const { clientAddress } = await send('/v1/info', {
    ...spoofed,
    'x-forwarded-for': '203.0.113.7',
  })
  assert.deepEqual(clientAddress, [])
})
