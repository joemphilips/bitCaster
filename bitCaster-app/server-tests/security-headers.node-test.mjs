import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { after, test } from 'node:test'
import { CONTENT_SECURITY_POLICY } from '../content-security-policy.js'
import { deadline, startFrontendServer } from './frontend-server.mjs'

// The backend answers every proxied request without a policy of its own.
const backend = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')
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
;({ frontend } = await startFrontendServer({
  BACKEND_URL: `http://127.0.0.1:${backend.address().port}`,
}))

async function policyOf(path) {
  const response = await fetch(`http://127.0.0.1:${frontend.address().port}${path}`, {
    signal: AbortSignal.timeout(deadline),
  })
  await response.arrayBuffer()
  assert.equal(response.status, 200, path)
  const header = response.headers.get('content-security-policy')
  assert.ok(header, `${path} has no Content-Security-Policy`)
  // The build writes the digest of this shared policy into index.html.
  assert.equal(header, CONTENT_SECURITY_POLICY, path)
  return Object.fromEntries(
    header
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name, sources]),
  )
}

// The two style attribute values of the QR scanner overlay (qr-scanner 1.4.2).
const scanRegionStyle =
  'position:absolute;width:100%;height:100%;left:0;top:0;fill:none;stroke:#e9b213;stroke-width:4;stroke-linecap:round;stroke-linejoin:round'
const codeOutlineStyle =
  'display:none;width:100%;height:100%;fill:none;stroke:#e9b213;stroke-width:5;stroke-dasharray:25;stroke-linecap:round;stroke-linejoin:round'
const hashSource = (value) => `'sha256-${createHash('sha256').update(value).digest('base64')}'`

// Each source has a reason: the app loads its scripts, styles, workers and manifest from
// this origin, compiles the oracle WASM, and uses Google Fonts. It connects to user-chosen
// mints over https and to Nostr relays over wss. Profile pictures are https or data:
// images, image previews are blob: URLs, and the QR scanner starts a blob: worker. Script
// code from any other source must not run. No other inline style is allowed.
const expected = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'style-src': [
    "'self'",
    'https://fonts.googleapis.com',
    "'unsafe-hashes'",
    hashSource(scanRegionStyle),
    hashSource(codeOutlineStyle),
  ],
  'font-src': ["'self'", 'https://fonts.gstatic.com'],
  'img-src': ["'self'", 'data:', 'blob:', 'https:'],
  'connect-src': ["'self'", 'https:', 'wss:'],
  'worker-src': ["'self'", 'blob:'],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'"],
}

test('the app document, its client routes, the service worker and the API carry the policy', async () => {
  // The source tree has no built sw.js, so the app fallback answers /sw.js here. The policy
  // middleware runs before the static files, the fallback and the proxies.
  for (const path of ['/', '/markets/some-market', '/user/npub1example', '/sw.js', '/api/probe'])
    assert.deepEqual(await policyOf(path), expected, path)
  // The backend, not the app fallback, answered /api/probe.
  const api = await fetch(`http://127.0.0.1:${frontend.address().port}/api/probe`, {
    signal: AbortSignal.timeout(deadline),
  })
  assert.equal(await api.text(), '{}')
})

test('the hashed styles are the style attributes that the installed QR scanner writes', () => {
  // A QR scanner update that changes its overlay markup must update the policy too.
  const scanner = readFileSync(
    createRequire(import.meta.url).resolve('qr-scanner/qr-scanner.min.js'),
    'utf8',
  )
  const styles = [...scanner.matchAll(/style="([^"]*)"/g)].map(([, value]) => value)
  assert.deepEqual(styles, [scanRegionStyle, codeOutlineStyle])
})
