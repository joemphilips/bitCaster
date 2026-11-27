import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CONTENT_SECURITY_POLICY } from '../content-security-policy.js'
import { deadline, startFrontendServer } from './frontend-server.mjs'

const STOPPED_HOST = 'old.market.test'
const APP_HOST = 'app.market.test'

// The backend and the mint record each request that reaches them.
const upstreamPaths = []
const upstream = createServer((req, res) => {
  upstreamPaths.push(req.url)
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')
})
let frontend
after(async () => {
  frontend?.closeAllConnections()
  upstream.closeAllConnections()
  await Promise.all([
    frontend ? new Promise((resolve) => frontend.close(resolve)) : undefined,
    new Promise((resolve) => upstream.close(resolve)),
  ])
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening', { signal: AbortSignal.timeout(deadline) })
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
;({ frontend } = await startFrontendServer({
  BACKEND_URL: upstreamUrl,
  MINT_URL: upstreamUrl,
  // The operator value can have other case, spaces and an empty element.
  STOPPED_HOST_NAMES: ` OLD.market.test, ,other-old.market.test `,
}))

// fetch() does not send a chosen Host header. A user agent sends the host of the URL.
function get(path, host, method = 'GET') {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: '127.0.0.1',
        port: frontend.address().port,
        method,
        path,
        headers: { host },
        signal: AbortSignal.timeout(deadline),
      },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => (body += chunk))
        response.on('end', () =>
          resolve({ status: response.statusCode, headers: response.headers, body }),
        )
      },
    )
    outgoing.on('error', reject)
    outgoing.end()
  })
}

test('a stopped host serves the stopped page for every client route', async () => {
  for (const host of [STOPPED_HOST, `${STOPPED_HOST.toUpperCase()}:443`, 'other-old.market.test']) {
    for (const path of ['/', '/index.html', '/markets/some-market', '/portfolio']) {
      const document = await get(path, host)
      assert.equal(document.status, 200, `${host}${path}`)
      assert.match(document.body, /src\/stopped\/main\.tsx/, `${host}${path}`)
      assert.doesNotMatch(document.body, /"\/src\/main\.tsx"/, `${host}${path}`)
    }
  }
})

test('a stopped host does not serve the files of the app', async () => {
  // These files exist in the app directory. The stopped host serves only its own directory.
  for (const path of [
    '/src/main.tsx',
    '/vite.config.ts',
    '/server-tests/stopped-host.node-test.mjs',
  ]) {
    const response = await get(path, STOPPED_HOST)
    assert.match(response.body, /src\/stopped\/main\.tsx/, path)
  }
})

test('a stopped host forwards nothing to the backend or the mint', async () => {
  upstreamPaths.length = 0
  for (const path of [
    '/api/v1/markets/query',
    '/hubs/market/negotiate',
    '/v1/info',
    '/api',
    '/v1',
  ]) {
    const response = await get(path, STOPPED_HOST)
    assert.equal(response.status, 503, path)
    assert.equal(response.body, '', path)
  }
  // Another method does not continue to the app routes either.
  for (const path of ['/markets', '/server.js', '/api/v1/orders']) {
    const response = await get(path, STOPPED_HOST, 'POST')
    assert.ok([404, 503].includes(response.status), path)
    assert.equal(response.body, '', path)
  }
  assert.deepEqual(upstreamPaths, [])
  // The app host keeps its proxy.
  assert.equal((await get('/v1/info', APP_HOST)).status, 200)
  assert.deepEqual(upstreamPaths, ['/v1/info'])
})

test('a stopped host refuses a WebSocket upgrade', async () => {
  // An app request through the hub proxy makes the proxy library listen for upgrades itself.
  assert.equal((await get('/markets', APP_HOST)).status, 200)
  upstreamPaths.length = 0
  const socket = connect(frontend.address().port, '127.0.0.1')
  await once(socket, 'connect', { signal: AbortSignal.timeout(deadline) })
  socket.write(
    `GET /hubs/market HTTP/1.1\r\nHost: ${STOPPED_HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
      'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
  )
  let received = ''
  socket.on('data', (chunk) => (received += chunk))
  await once(socket, 'close', { signal: AbortSignal.timeout(deadline) })
  assert.equal(received, '')
  // An HTTP request after the upgrade reaches the backend first if the upgrade reached it.
  assert.equal((await get('/api/v1/after-upgrade', APP_HOST)).status, 200)
  assert.deepEqual(upstreamPaths, ['/api/v1/after-upgrade'])
})

test('a stopped host sends a policy that admits only its own script and style, and no referrer', async () => {
  const { headers } = await get('/', STOPPED_HOST)
  const policy = headers['content-security-policy']
  assert.notEqual(policy, CONTENT_SECURITY_POLICY)
  const directives = Object.fromEntries(
    policy.split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/)
      return [name, values.join(' ')]
    }),
  )
  // Every other fetch directive falls back to default-src, so the page makes no network call.
  assert.equal(directives['default-src'], "'none'")
  for (const name of ['script-src', 'style-src']) assert.equal(directives[name], "'self'", name)
  for (const name of [
    'connect-src',
    'img-src',
    'font-src',
    'worker-src',
    'manifest-src',
    'frame-src',
  ])
    assert.equal(directives[name], undefined, name)
  assert.equal(directives['frame-ancestors'], "'none'")
  assert.equal(directives['form-action'], "'none'")
  assert.equal(directives['base-uri'], "'none'")
  assert.equal(headers['referrer-policy'], 'no-referrer')
  assert.equal(headers['x-frame-options'], 'DENY')
  assert.equal(headers['x-content-type-options'], 'nosniff')
})

test('every host sends the noindex header', async () => {
  for (const host of [STOPPED_HOST, APP_HOST])
    assert.equal((await get('/', host)).headers['x-robots-tag'], 'noindex', host)
})

test('the app host keeps the app document and its policy', async () => {
  const document = await get('/markets/some-market', APP_HOST)
  assert.equal(document.status, 200)
  assert.match(document.body, /"\/src\/main\.tsx"/)
  assert.equal(document.headers['content-security-policy'], CONTENT_SECURITY_POLICY)
})

test('the server does not start with a stopped host but without the stopped page', async () => {
  const app = fileURLToPath(new URL('..', import.meta.url))
  const scratch = await mkdtemp(join(tmpdir(), 'frontend-server-'))
  try {
    const served = join(scratch, 'app')
    await mkdir(served)
    for (const file of [
      'server.js',
      'content-security-policy.js',
      'deployment-identity.js',
      'index.html',
    ])
      await copyFile(join(app, file), join(served, file))
    await symlink(join(app, 'node_modules'), join(served, 'node_modules'), 'dir')
    const workspaceModules = join(app, '..', 'node_modules')
    if (
      await stat(workspaceModules).then(
        (entry) => entry.isDirectory(),
        () => false,
      )
    )
      await symlink(workspaceModules, join(scratch, 'node_modules'), 'dir')
    const child = spawn(process.execPath, [join(served, 'server.js')], {
      env: { ...process.env, PORT: '0', STOPPED_HOST_NAMES: STOPPED_HOST },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const exit = once(child, 'exit', { signal: AbortSignal.timeout(deadline) })
    let code
    try {
      ;[code] = await exit
    } finally {
      child.kill()
    }
    assert.notEqual(code, 0, output)
    assert.match(output, /stopped page/)
    assert.doesNotMatch(output, /Listening on port/)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
