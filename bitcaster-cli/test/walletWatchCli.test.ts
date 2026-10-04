import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { bootstrapFreshDaemonProfile } from '../../bitcaster-daemon/src/profileBootstrap.ts'

const execFileAsync = promisify(execFile)
let directory: string
let token: string
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wallet-watch-cli-'))
  token = (
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: 'https://mint.example',
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
  ).rpcToken
})
after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function preload(mode: string): string {
  const code = `
    import assert from 'node:assert/strict'
    import childProcess from 'node:child_process'
    import { syncBuiltinESMExports } from 'node:module'
    globalThis[Symbol.for('bitcaster.test.daemon-url')] = 'http://daemon.test'
    let calls = 0, cancelled = 0, registrations = 0, spawns = 0, signal
    const mode = ${JSON.stringify(mode)}
    if (mode === 'dry-run') {
      const once = process.once
      process.once = function(event, listener) {
        if (event === 'SIGINT' || event === 'SIGTERM') registrations++
        return once.call(this, event, listener)
      }
      childProcess.spawn = () => { spawns++; throw new Error('unexpected daemon spawn') }
      syncBuiltinESMExports()
    }
    process.once('beforeExit', () => {
      assert.equal(calls, mode === 'none' || mode === 'dry-run' ? 0 : 1)
      if (mode === 'dry-run') {
        assert.equal(registrations, 0)
        assert.equal(spawns, 0)
      }
      if (mode === 'cancel' || mode === 'terminate') {
        assert.equal(signal.aborted, true)
        assert.equal(cancelled, 1)
      }
    })
    globalThis.fetch = async (url, init) => {
      calls++
      if (mode === 'dry-run') throw new TypeError('fetch failed')
      assert.equal(url, 'http://daemon.test/rpc')
      assert.equal(init.method, 'POST')
      assert.equal(new Headers(init.headers).get('authorization') === ${JSON.stringify(`Bearer ${token}`)}, true)
      assert.equal(new Headers(init.headers).get('accept'), 'application/x-ndjson')
      assert.deepEqual(JSON.parse(init.body), { method: 'wallet.watch' })
      signal = init.signal
      if (mode === 'cancel' || mode === 'terminate') {
        setImmediate(() => process.emit(mode === 'cancel' ? 'SIGINT' : 'SIGTERM'))
        return new Response(new ReadableStream({ cancel() { cancelled++ } }), { headers: { 'content-type': 'application/x-ndjson' } })
      }
      const frames = mode === 'error'
        ? [{ type: 'error', code: 'watch-failed', error: 'fixture-private-details' }]
        : mode === 'oversize'
          ? [{ type: 'event', event: 'wallet.snapshot', data: 'x'.repeat(4 * 1024 * 1024) }]
          : [{ type: 'event', event: 'wallet.snapshot', data: { localHoldings: { totalAvailableSats: 12 }, monitoring: { status: mode === 'disabled' ? 'disabled' : 'unavailable' } } }, { type: 'complete' }]
      const bytes = new TextEncoder().encode(frames.map(frame => JSON.stringify(frame) + '\\n').join(''))
      return new Response(new ReadableStream({ start(body) { body.enqueue(bytes.subarray(0, 13)); body.enqueue(bytes.subarray(13)); body.close() } }), { headers: { 'content-type': 'application/x-ndjson' } })
    }
  `
  return `data:text/javascript,${encodeURIComponent(code)}`
}

async function profileDigest(): Promise<string> {
  const digest = createHash('sha256')
  for (const name of (await readdir(directory, { recursive: true })).sort()) {
    digest.update(name)
    try {
      digest.update(await readFile(join(directory, name)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error
    }
  }
  return digest.digest('hex')
}

test('actual global dry-run wallet watch prints only the validated envelope without signals, transport, spawn or profile writes', async () => {
  const before = await profileDigest()
  const result = await run(['--dry-run', 'wallet', 'watch'], 'dry-run').catch((error: unknown) => {
    assert.fail(
      `dry-run CLI exited ${(error as { code: number }).code} instead of returning before I/O`,
    )
  })
  assert.deepEqual(JSON.parse(result.stdout), { method: 'wallet.watch' })
  assert.equal(result.stderr, '')
  assert.equal(await profileDigest(), before)
})

function run(args: string[], mode = 'none') {
  return execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      preload(mode),
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      '--datadir',
      directory,
      ...args,
    ],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 10000, maxBuffer: 128 * 1024 },
  )
}

for (const status of ['disabled', 'unavailable']) {
  test(`actual wallet watch prints local holdings with ${status} monitoring through authenticated transport`, async () => {
    const result = await run(['wallet', 'watch'], status)
    const lines = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    assert.equal(lines.length, 2)
    assert.equal(lines[0].event, 'wallet.snapshot')
    assert.equal(lines[0].sourceRevision, undefined)
    assert.equal(lines[0].data.localHoldings.totalAvailableSats, 12)
    assert.deepEqual(lines[0].data.monitoring, { status })
    assert.equal(lines[1].type, 'complete')
    assert.equal(result.stderr, '')
  })
}

test('actual wallet watch reports a terminal failure with exit 1 and one redacted JSON line', async () => {
  await assert.rejects(run(['wallet', 'watch'], 'error'), (error: unknown) => {
    const result = error as { code: number; stdout: string; stderr: string }
    assert.equal(result.code, 1)
    assert.deepEqual(
      result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
      [{ type: 'error', code: 'watch-failed', error: 'daemon watch failed' }],
    )
    assert.equal(result.stderr, '')
    assert.equal(result.stdout.includes('fixture-private-details'), false)
    return true
  })
})

for (const signal of ['cancel', 'terminate']) {
  test(`actual wallet watch ${signal} releases a pending response`, async () => {
    const result = await run(['wallet', 'watch'], signal)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  })
}

test('actual wallet watch refuses caller-selected wallet IDs and unsupported options before I/O', async () => {
  for (const args of [
    ['another-wallet'],
    ['--wallet-id', 'ab'.repeat(32)],
    ['--timeframe', '1W'],
  ]) {
    await assert.rejects(run(['wallet', 'watch', ...args]), (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string }
      assert.equal(result.code, 2)
      assert.match(result.stdout + result.stderr, /too many arguments|unknown option/)
      return true
    })
  }
})

test('actual wallet watch help states local holdings and optional display estimates', async () => {
  const result = await run(['wallet', 'watch', '--help'])
  assert.match(result.stdout, /wallet watch/)
  assert.match(result.stdout, /local holdings and optional display-only portfolio estimates/)
})

test('actual wallet watch applies the existing frame bound before printing snapshot data', async () => {
  await assert.rejects(run(['wallet', 'watch'], 'oversize'), (error: unknown) => {
    const result = error as { code: number; stdout: string; stderr: string }
    assert.equal(result.code, 1)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /byte limit/)
    return true
  })
})
