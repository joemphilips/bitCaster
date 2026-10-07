import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { bootstrapFreshDaemonProfile } from '../../bitcaster-daemon/src/profileBootstrap.ts'

const execFileAsync = promisify(execFile)
const conditionId = 'ab'.repeat(32)
const categoryId = 'cd'.repeat(32)
let directory: string
let token: string
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'market-watch-cli-'))
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

function preload(mode: string, ids: string[]): string {
  const code = `
    import assert from 'node:assert/strict'
    globalThis[Symbol.for('bitcaster.test.daemon-url')] = 'http://daemon.test'
    let calls = 0, cancelled = 0, signal
    const mode = ${JSON.stringify(mode)}
    process.once('beforeExit', () => {
      assert.equal(calls, mode === 'none' ? 0 : 1)
      if (mode === 'cancel' || mode === 'closed') {
        assert.equal(signal.aborted, true)
        assert.equal(cancelled, 1)
      }
    })
    globalThis.fetch = async (url, init) => {
      calls++
      assert.equal(url, 'http://daemon.test/rpc')
      assert.equal(init.method, 'POST')
      assert.equal(new Headers(init.headers).get('authorization'), ${JSON.stringify(`Bearer ${token}`)})
      assert.equal(new Headers(init.headers).get('accept'), 'application/x-ndjson')
      assert.deepEqual(JSON.parse(init.body), { method: 'market.watch', params: { conditionIds: ${JSON.stringify(ids)} } })
      signal = init.signal
      if (mode === 'cancel' || mode === 'closed') {
        setImmediate(() => mode === 'cancel' ? process.emit('SIGINT') : process.stdout.emit('close'))
        return new Response(new ReadableStream({ cancel() { cancelled++ } }), { headers: { 'content-type': 'application/x-ndjson' } })
      }
      const frames = mode === 'error'
        ? [{ type: 'error', code: 'watch-failed', error: 'fixture-private-details' }]
        : mode === 'oversize'
        ? [{ type: 'event', event: 'market.snapshot', data: 'x'.repeat(4 * 1024 * 1024) }]
        : [{ type: 'event', event: 'market.connection', data: { state: 'connected' } },
           { type: 'event', event: 'market.snapshot', data: { conditionId: ${JSON.stringify(conditionId)}, label: 'Alpha 😀', market: { fundingRevision: 'event-3' }, orderBooks: [] } },
           { type: 'complete' }]
      const bytes = new TextEncoder().encode(frames.map(frame => JSON.stringify(frame) + '\\n').join(''))
      return new Response(new ReadableStream({
        start(body) {
          body.enqueue(bytes.subarray(0, 17))
          body.enqueue(bytes.subarray(17))
          body.close()
        }
      }), { headers: { 'content-type': 'application/x-ndjson' } })
    }
  `
  return `data:text/javascript,${encodeURIComponent(code)}`
}

function run(args: string[], mode = 'none', ids: string[] = []) {
  return execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      preload(mode, ids),
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      '--datadir',
      directory,
      ...args,
    ],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 10000, maxBuffer: 128 * 1024 },
  )
}

test('actual market watch command prints bounded JSON lines through authenticated transport', async () => {
  const result = await run(['market', 'watch', conditionId, categoryId], 'frames', [
    conditionId,
    categoryId,
  ])
  const lines = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(lines.length, 3)
  assert.equal(lines[0].event, 'market.connection')
  assert.equal(lines[1].event, 'market.snapshot')
  assert.equal(lines[1].data.conditionId, conditionId)
  assert.equal(lines[1].data.label, 'Alpha 😀')
  assert.equal(lines[1].data.market.fundingRevision, 'event-3')
  assert.equal(lines[2].type, 'complete')
  assert.equal(result.stderr, '')
})

test('actual market watch help shows explicit IDs and selection bounds', async () => {
  const result = await run(['market', 'watch', '--help'])
  assert.match(result.stdout, /watch.*\[conditionIds\.\.\.\]/)
  assert.match(result.stdout, /200 explicit condition IDs/)
  assert.match(result.stdout, /--liked/)
})

test('actual market watch exits unsuccessfully after one redacted terminal error frame', async () => {
  await assert.rejects(
    run(['market', 'watch', conditionId], 'error', [conditionId]),
    (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string }
      assert.equal(result.code, 1)
      const lines = result.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      assert.deepEqual(lines, [
        { type: 'error', code: 'watch-failed', error: 'daemon watch failed' },
      ])
      assert.equal(result.stderr, '')
      assert.equal(result.stdout.includes('fixture-private-details'), false)
      return true
    },
  )
})

test('actual market watch refuses missing, malformed, duplicate, and excessive selections before I/O', async () => {
  for (const ids of [
    [],
    ['bad-id'],
    [conditionId, conditionId],
    Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(64, '0')),
  ]) {
    await assert.rejects(run(['market', 'watch', ...ids]), (error: unknown) => {
      assert.equal((error as { code: number }).code, ids.length === 0 ? 2 : 1)
      const result = error as { stdout: string; stderr: string }
      assert.match(
        result.stdout + result.stderr,
        /Specify --liked or at least one explicit condition ID|invalid daemon watch command/,
      )
      return true
    })
  }
})

test('actual market watch cancels pending reads on SIGINT and releases the response', async () => {
  const result = await run(['market', 'watch', conditionId], 'cancel', [conditionId])
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('actual market watch cancels pending reads when stdout closes', async () => {
  await assert.rejects(
    run(['market', 'watch', conditionId], 'closed', [conditionId]),
    (error: unknown) => {
      assert.equal((error as { code: number }).code, 1)
      assert.match((error as { stderr: string }).stderr, /request aborted/)
      return true
    },
  )
})

test('actual market watch enforces the existing frame limit before stdout writes', async () => {
  await assert.rejects(
    run(['market', 'watch', conditionId], 'oversize', [conditionId]),
    (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string }
      assert.equal(result.code, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /byte limit/)
      return true
    },
  )
})
