// A browser that has the cached app gets the stopped page after the host stops.
// Needs both builds: `npm run test:stopped-host:browser` makes them and runs this test.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, cp, mkdir, mkdtemp, rm, stat, symlink } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const deadline = 30000
const SEED = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
const app = fileURLToPath(new URL('..', import.meta.url))
for (const file of [
  'dist/index.html',
  'dist/sw.js',
  'dist-stopped/index.html',
  'dist-stopped/sw.js',
])
  await stat(join(app, file)).catch(() => {
    throw new Error(`${file} is missing. Run npm run build and npm run build:stopped first.`)
  })

// The package layout of scripts/prepare-frontend-package.sh: the app build, the stopped build
// in ./stopped, and the server files.
const scratch = await mkdtemp(join(tmpdir(), 'stopped-sw-'))
const served = join(scratch, 'app')
await cp(join(app, 'dist'), served, { recursive: true })
await cp(join(app, 'dist-stopped'), join(served, 'stopped'), { recursive: true })
for (const file of ['server.js', 'content-security-policy.js', 'deployment-identity.js'])
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

// A service worker belongs to one origin. Both servers use the same port.
const holder = createServer().listen(0, '127.0.0.1')
await once(holder, 'listening')
const port = holder.address().port
await new Promise((resolve) => holder.close(resolve))
const origin = `http://localhost:${port}`

let server
async function startServer(env) {
  const child = spawn(process.execPath, [join(served, 'server.js')], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const listening = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (output.includes('Listening on port')) resolve()
    })
    child.stderr.on('data', (chunk) => (output += chunk))
    child.once('exit', (code) => reject(new Error(`server exited with ${code}: ${output}`)))
  })
  await Promise.race([
    listening,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('server did not listen')), deadline),
    ),
  ])
  return child
}
async function stopServer() {
  if (!server || server.exitCode !== null) return
  const exit = once(server, 'exit')
  server.kill()
  await exit
}

const browser = await chromium.launch()
after(async () => {
  await browser.close()
  await stopServer()
  await rm(scratch, { recursive: true, force: true })
})

test(
  'the cached app updates to the stopped page and keeps the wallet storage',
  { timeout: 4 * deadline },
  async () => {
    server = await startServer({})
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.goto(`${origin}/`)
    // The app service worker installs and controls the page.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: deadline,
    })
    await page.evaluate((seed) => {
      localStorage.setItem(
        'bitcaster-wallet',
        JSON.stringify({ state: { mnemonic: seed, setupComplete: true }, version: 0 }),
      )
    }, SEED)
    await page.reload()
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: deadline,
    })
    const before = await page.evaluate(() => ({ ...localStorage }))
    assert.match(before['bitcaster-wallet'], /abandon ability/)

    await stopServer()
    server = await startServer({ STOPPED_HOST_NAMES: 'localhost' })
    const requests = []
    page.on('request', (request) => requests.push(request.url()))
    const refusals = []
    page.on('console', (message) => {
      if (/Content Security Policy|Refused/.test(message.text())) refusals.push(message.text())
    })
    // The old service worker serves the cached app. The app registers its worker again, the
    // browser finds the new worker, and the new worker reloads the page from the network.
    await page.reload()
    await page
      .getByRole('heading', { level: 1 })
      .filter({
        hasText: /bitCaster is temporarily unavailable|bitcasterは現在一時的に公開を停止しています/,
      })
      .waitFor({ timeout: deadline })
    // The new worker removes its registration: no worker serves the cached app again.
    await page.waitForFunction(
      async () => (await navigator.serviceWorker.getRegistrations()).length === 0,
      null,
      { timeout: deadline },
    )

    // From here on, only the stopped page runs in this tab.
    requests.length = 0
    refusals.length = 0
    // The cached app runs for a moment before the reload and can add its own entries. No
    // entry is removed or changed.
    const stoppedStorage = await page.evaluate(() => ({ ...localStorage }))
    for (const [key, value] of Object.entries(before)) assert.equal(stoppedStorage[key], value, key)
    await page.getByRole('button', { name: /Show recovery phrase|復元フレーズを表示/ }).click()
    assert.deepEqual(await page.getByTestId('seed-word').allTextContents(), SEED.split(' '))

    // A new visit gets the stopped page from the network, with no worker.
    await page.goto(`${origin}/markets/some-market`)
    await page.getByRole('heading', { level: 1 }).waitFor({ timeout: deadline })
    assert.equal(await page.evaluate(() => navigator.serviceWorker.controller), null)
    // The stopped page writes nothing.
    assert.deepEqual(await page.evaluate(() => ({ ...localStorage })), stoppedStorage)
    assert.ok(requests.length > 0)
    for (const url of requests) assert.equal(new URL(url).origin, origin, url)
    assert.deepEqual(refusals, [])
    await context.close()
  },
)
