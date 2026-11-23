import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { deadline, startFrontendServer } from './frontend-server.mjs'

let frontend
after(async () => {
  frontend?.closeAllConnections()
  if (frontend) await new Promise((resolve) => frontend.close(resolve))
})
;({ frontend } = await startFrontendServer({}))

async function get(path) {
  const response = await fetch(`http://127.0.0.1:${frontend.address().port}${path}`, {
    signal: AbortSignal.timeout(deadline),
  })
  return { status: response.status, body: await response.text() }
}

test('the server does not serve its own source and package files', async () => {
  // These files are in the served directory. The block list answers before the static files.
  for (const path of [
    '/server.js',
    '/content-security-policy.js',
    '/deployment-identity.js',
    '/package.json',
  ])
    assert.equal((await get(path)).status, 404, path)
})

test('a client route at any depth gets the app document', async () => {
  const document = await get('/')
  assert.equal(document.status, 200)
  assert.match(document.body, /<div id="root">/)
  for (const path of ['/markets', '/markets/some-market/trade', '/user/npub1example/settings'])
    assert.deepEqual(await get(path), document, path)
})

test('the server stops with an error when it cannot listen on its port', async () => {
  // A port that another listener holds makes the listen call fail.
  const holder = createServer()
  holder.listen(0)
  await once(holder, 'listening', { signal: AbortSignal.timeout(deadline) })
  try {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('../server.js', import.meta.url))],
      {
        env: { ...process.env, PORT: String(holder.address().port) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
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
    assert.match(output, /EADDRINUSE/)
    assert.doesNotMatch(output, /Listening on port/)
  } finally {
    await new Promise((resolve) => holder.close(resolve))
  }
})
