import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { after, before, test } from 'node:test'
import { PaymentRequest } from '@cashu/cashu-ts'
import {
  createAmountlessCashuPaymentRequest,
  derivePaymentRequestReceiveKeyPair,
} from '@bitcaster-market/client-sdk/paymentRequest'
import { bootstrapFreshDaemonProfile } from '../../bitcaster-daemon/src/profileBootstrap.ts'

const execFileAsync = promisify(execFile)
const REQUEST_ID = 'wallet-request-fixture'
const MINT = 'https://mint.example'
const NPROFILE =
  'nprofile1qy28wumn8ghj7un9d3shjtnyv9kh2uewd9hsz9mhwden5te0wfjkccte9curxven9eehqctrv5hszrthwden5te0dehhxtnvdakqqgydaqy7curk439ykptkysv7udhdhu68sucm295akqefdehkf0d495cwunl5'
const CREATED = {
  requestId: REQUEST_ID,
  encoded: createAmountlessCashuPaymentRequest({
    id: REQUEST_ID,
    mintUrl: MINT,
    nprofile: NPROFILE,
  }).encoded,
  mintUrl: MINT,
  unit: 'msat',
  receivePublicKey: derivePaymentRequestReceiveKeyPair(new Uint8Array(64).fill(0x11)).publicKey,
  createdAtMs: 1790895600000,
}
const CREDITED = { state: 'credited', requestId: REQUEST_ID, amountMsat: 1, proofCount: 1 }
let directory: string
let token: string
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'wallet-request-cli-'))
  token = (
    await bootstrapFreshDaemonProfile({
      directory,
      engineBaseUrl: 'https://engine.example',
      mintUrl: MINT,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
    })
  ).rpcToken
})
after(async () => {
  await rm(directory, { recursive: true, force: true })
})

function preload(command: unknown, result: unknown, mode: string): string {
  const code = `
    import assert from 'node:assert/strict'
    import { readRpcToken } from ${JSON.stringify(import.meta.resolve('@bitcaster-market/daemon/rpcAuth'))}
    globalThis[Symbol.for('bitcaster.test.daemon-url')] = 'http://daemon.test'
    let calls = 0, cancelled = 0, signal
    const mode = ${JSON.stringify(mode)}
    process.once('beforeExit', () => {
      assert.equal(calls, mode === 'none' ? 0 : 1)
      if (mode === 'cancel' || mode === 'terminate') {
        assert.equal(signal.aborted, true)
        assert.equal(cancelled, 1)
      }
    })
    globalThis.fetch = async (url, init) => {
      calls++
      assert.equal(url, 'http://daemon.test/rpc')
      assert.equal(init.method, 'POST')
      assert.equal(new Headers(init.headers).get('authorization') === 'Bearer ' + await readRpcToken(), true, 'wrong selected-profile authorization')
      assert.equal(JSON.stringify(JSON.parse(init.body)) === ${JSON.stringify(JSON.stringify(command))}, true, 'unexpected request command')
      signal = init.signal
      if (mode === 'rpc') return Response.json({ ok: true, result: ${JSON.stringify(result)} })
      if (mode === 'refused') return Response.json({ ok: false, code: 'payment-request-unavailable', error: 'native payment request service is unavailable' })
      assert.equal(new Headers(init.headers).get('accept'), 'application/x-ndjson')
      if (mode === 'cancel' || mode === 'terminate') {
        setImmediate(() => process.emit(mode === 'cancel' ? 'SIGINT' : 'SIGTERM'))
        return new Response(new ReadableStream({ cancel() { cancelled++ } }), { headers: { 'content-type': 'application/x-ndjson' } })
      }
      const frames = mode === 'error'
        ? [{ type: 'error', code: 'watch-failed', error: 'fixture-private-proof-secret' }]
        : mode === 'oversize'
          ? [{ type: 'event', event: 'wallet-request-status', data: 'x'.repeat(4 * 1024 * 1024) }]
          : [{ type: 'event', event: 'wallet-request-status', data: { state: 'awaiting', requestId: ${JSON.stringify(REQUEST_ID)} } }, { type: 'event', event: 'wallet-request-status', data: { state: 'pending', requestId: ${JSON.stringify(REQUEST_ID)} } }, { type: 'event', event: 'wallet-request-status', data: ${JSON.stringify(CREDITED)} }, { type: 'complete' }]
      const bytes = new TextEncoder().encode(frames.map(frame => JSON.stringify(frame) + '\\n').join(''))
      return new Response(new ReadableStream({ start(body) { body.enqueue(bytes.subarray(0, 13)); body.enqueue(bytes.subarray(13)); body.close() } }), { headers: { 'content-type': 'application/x-ndjson' } })
    }
  `
  return `data:text/javascript,${encodeURIComponent(code)}`
}

function run(args: string[], command?: unknown, result?: unknown, mode = 'none') {
  return execFileAsync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--import',
      preload(command, result ?? null, mode),
      join(import.meta.dirname, '..', 'src', 'main.ts'),
      '--datadir',
      directory,
      ...args,
    ],
    { env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 10000, maxBuffer: 128 * 1024 },
  )
}

function assertPublic(text: string) {
  for (const secret of [
    'walletSeedHex',
    'nostrSecretKeyHex',
    'proofs',
    'fixture-private-proof-secret',
    token,
  ])
    assert.equal(text.includes(secret), false, 'private material reached request output')
}

test('actual create returns an amountless msat mint-bound request that the shared protocol parser can read', async () => {
  const result = await run(
    ['wallet', 'request', 'create'],
    { method: 'wallet.request.create' },
    CREATED,
    'rpc',
  )
  const response = JSON.parse(result.stdout)
  assert.deepEqual(response, { ok: true, result: CREATED })
  const decoded = PaymentRequest.fromEncodedRequest(response.result.encoded)
  assert.equal(decoded.id, REQUEST_ID)
  assert.equal(decoded.amount, undefined)
  assert.equal(decoded.unit, 'msat')
  assert.deepEqual(decoded.mints, [MINT])
  assert.deepEqual(decoded.transport, [{ type: 'nostr', target: NPROFILE, tags: [['n', '17']] }])
  assertPublic(result.stdout)
  assert.equal(result.stderr, '')
})

test('actual create forwards only the explicit request identity, including the UTF-8 boundary', async () => {
  const requestId = 'é'.repeat(128)
  const result = await run(
    ['wallet', 'request', 'create', '--request-id', requestId],
    { method: 'wallet.request.create', params: { requestId } },
    {
      ...CREATED,
      requestId,
      encoded: createAmountlessCashuPaymentRequest({
        id: requestId,
        mintUrl: MINT,
        nprofile: NPROFILE,
      }).encoded,
    },
    'rpc',
  )
  assert.equal(JSON.parse(result.stdout).result.requestId, requestId)
  assertPublic(result.stdout)
})

for (const state of ['awaiting', 'pending', 'credited']) {
  test(`actual status preserves ${state} public state and exact millisatoshis without balance inference`, async () => {
    const status = state === 'credited' ? CREDITED : { state, requestId: REQUEST_ID }
    const result = await run(
      ['wallet', 'request', 'status', REQUEST_ID],
      { method: 'wallet.request.status', params: { requestId: REQUEST_ID } },
      status,
      'rpc',
    )
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: status })
    assertPublic(result.stdout)
    assert.equal(result.stderr, '')
  })
}

test('actual recover addresses one saved request and prints pending or credited state without receiving proof bodies', async () => {
  const result = await run(
    ['wallet', 'request', 'recover', REQUEST_ID],
    { method: 'wallet.request.recover', params: { requestId: REQUEST_ID } },
    CREDITED,
    'rpc',
  )
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: CREDITED })
  assertPublic(result.stdout)
})

for (const paged of [false, true]) {
  test(`actual list returns a bounded page and does not call receipt acceptance a credit (paged: ${paged})`, async () => {
    const cursor = 'opaque-cursor-123'
    const page = {
      rows: [
        {
          requestId: REQUEST_ID,
          mintUrl: MINT,
          unit: 'msat',
          createdAtMs: CREATED.createdAtMs,
          receiptAccepted: true,
        },
      ],
      nextCursor: paged ? null : cursor,
      hasMore: !paged,
    }
    const args = paged ? ['--cursor', cursor, '--page-size', '256'] : []
    const command = paged
      ? { method: 'wallet.request.list', params: { cursor, pageSize: 256 } }
      : { method: 'wallet.request.list' }
    const result = await run(['wallet', 'request', 'list', ...args], command, page, 'rpc')
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, result: page })
    assert.equal(result.stdout.includes('credited'), false)
    assertPublic(result.stdout)
  })
}

test('actual list preserves the 4096-byte cursor boundary and minimum page size', async () => {
  const cursor = 'é'.repeat(2048)
  const page = { rows: [], nextCursor: null, hasMore: false }
  const result = await run(
    ['wallet', 'request', 'list', '--cursor', cursor, '--page-size', '1'],
    { method: 'wallet.request.list', params: { cursor, pageSize: 1 } },
    page,
    'rpc',
  )
  assert.deepEqual(JSON.parse(result.stdout).result, page)
})

for (const method of ['create', 'status', 'list', 'recover']) {
  test(`actual ${method} returns the bounded daemon refusal and exit 1`, async () => {
    const args = method === 'status' || method === 'recover' ? [REQUEST_ID] : []
    const command = args.length
      ? { method: `wallet.request.${method}`, params: { requestId: REQUEST_ID } }
      : { method: `wallet.request.${method}` }
    await assert.rejects(
      run(['wallet', 'request', method, ...args], command, undefined, 'refused'),
      (error: unknown) => {
        const result = error as { code: number; stdout: string; stderr: string }
        assert.equal(result.code, 1)
        assert.deepEqual(JSON.parse(result.stdout), {
          ok: false,
          code: 'payment-request-unavailable',
          error: 'native payment request service is unavailable',
        })
        assert.equal(result.stderr, '')
        assertPublic(result.stdout)
        return true
      },
    )
  })
}

test('actual watch prints split and coalesced awaiting, pending, and exact credited states before completion', async () => {
  const result = await run(
    ['wallet', 'request', 'watch', REQUEST_ID],
    { method: 'wallet.request.watch', params: { requestId: REQUEST_ID } },
    undefined,
    'watch',
  )
  const frames = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.deepEqual(frames, [
    {
      type: 'event',
      event: 'wallet-request-status',
      data: { state: 'awaiting', requestId: REQUEST_ID },
    },
    {
      type: 'event',
      event: 'wallet-request-status',
      data: { state: 'pending', requestId: REQUEST_ID },
    },
    { type: 'event', event: 'wallet-request-status', data: CREDITED },
    { type: 'complete' },
  ])
  assertPublic(result.stdout)
  assert.equal(result.stderr, '')
})

test('actual watch terminal failure exits 1 with one redacted error frame and no duplicate exception', async () => {
  await assert.rejects(
    run(
      ['wallet', 'request', 'watch', REQUEST_ID],
      { method: 'wallet.request.watch', params: { requestId: REQUEST_ID } },
      undefined,
      'error',
    ),
    (error: unknown) => {
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
      assertPublic(result.stdout)
      return true
    },
  )
})

for (const mode of ['cancel', 'terminate']) {
  test(`actual watch ${mode} aborts and releases only its response, without a request cancellation RPC`, async () => {
    const result = await run(
      ['wallet', 'request', 'watch', REQUEST_ID],
      { method: 'wallet.request.watch', params: { requestId: REQUEST_ID } },
      undefined,
      mode,
    )
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  })
}

test('actual watch retains the shared frame-size bound', async () => {
  await assert.rejects(
    run(
      ['wallet', 'request', 'watch', REQUEST_ID],
      { method: 'wallet.request.watch', params: { requestId: REQUEST_ID } },
      undefined,
      'oversize',
    ),
    (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string }
      assert.equal(result.code, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /byte limit/)
      return true
    },
  )
})

test('actual commands refuse unsupported payment and authority options before any I/O', async () => {
  for (const args of [
    ['create', '--amount-msat', '1'],
    ['create', '--mint', MINT],
    ['create', '--wallet-id', 'ab'.repeat(32)],
    ['create', '--seed-file', '/fixture/private-seed'],
    ['create', '--nprofile', NPROFILE],
    ['create', '--unit', 'sat'],
    ['create', '--description', 'unsupported'],
    ['pay', CREATED.encoded],
    ['create', 'extra'],
    ['list', 'extra'],
    ['recover'],
    ['watch'],
    ['status'],
    ['status', REQUEST_ID, 'extra'],
    ['recover', REQUEST_ID, 'extra'],
    ['watch', REQUEST_ID, 'extra'],
  ]) {
    await assert.rejects(run(['wallet', 'request', ...args]), (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string }
      assert.equal(result.code, 2)
      assert.match(
        result.stdout + result.stderr,
        /unknown option|unknown command|too many arguments|missing required argument/,
      )
      return true
    })
  }
})

test('actual command validation uses byte bounds and safe page sizes without echoing oversized input', async () => {
  const longId = 'é'.repeat(129)
  const longCursor = 'é'.repeat(2049)
  const cases = [
    ['create', '--request-id', ''],
    ['create', '--request-id', longId],
    ['status', ''],
    ['status', longId],
    ['recover', longId],
    ['watch', longId],
    ['list', '--cursor', longCursor],
    ...['0', '-1', '257', '1.5', 'NaN', '9007199254740992'].map((value) => [
      'list',
      '--page-size',
      value,
    ]),
  ]
  for (const args of cases) {
    await assert.rejects(run(['wallet', 'request', ...args]), (error: unknown) => {
      const result = error as { code: number; stdout: string; stderr: string }
      assert.equal(result.code, 2)
      assert.equal((result.stdout + result.stderr).includes(longId), false)
      assert.equal((result.stdout + result.stderr).includes(longCursor), false)
      return true
    })
  }
})

test('actual dry-run validates all command envelopes and performs no daemon or monitoring I/O', async () => {
  const cases = [
    { args: ['create'], command: { method: 'wallet.request.create' } },
    {
      args: ['create', '--request-id', REQUEST_ID],
      command: { method: 'wallet.request.create', params: { requestId: REQUEST_ID } },
    },
    {
      args: ['status', REQUEST_ID],
      command: { method: 'wallet.request.status', params: { requestId: REQUEST_ID } },
    },
    {
      args: ['list', '--page-size', '2'],
      command: { method: 'wallet.request.list', params: { pageSize: 2 } },
    },
    {
      args: ['recover', REQUEST_ID],
      command: { method: 'wallet.request.recover', params: { requestId: REQUEST_ID } },
    },
    {
      args: ['watch', REQUEST_ID],
      command: { method: 'wallet.request.watch', params: { requestId: REQUEST_ID } },
    },
  ]
  for (const { args, command } of cases) {
    const result = await run(['--dry-run', 'wallet', 'request', ...args])
    assert.deepEqual(JSON.parse(result.stdout), command)
    assertPublic(result.stdout)
  }
})

test('actual help documents receive-only requests, fixed msat/mint authority, pagination and persistent watching', async () => {
  const group = await run(['wallet', 'request', '--help'])
  for (const method of ['create', 'status', 'list', 'recover', 'watch'])
    assert.match(group.stdout, new RegExp(method))
  assert.match(group.stdout, /amountless/)
  assert.match(group.stdout, /msat/)
  assert.match(group.stdout, /configured mint/)
  assert.match(group.stdout, /receive|receiv/i)
  const list = await run(['wallet', 'request', 'list', '--help'])
  assert.match(list.stdout, /receipt acceptance[\s\S]*credit/i)
  assert.match(list.stdout, /1\.\.256/)
  const watch = await run(['wallet', 'request', 'watch', '--help'])
  assert.match(watch.stdout, /does not cancel[\s\S]*request/i)
})
