import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { relative } from 'node:path'
import { PassThrough } from 'node:stream'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  createNativeOracleHelperAdapter,
  NativeOracleHelperError,
  NATIVE_ORACLE_HELPER_DESCRIPTION_BYTES_MAX,
  NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX,
  NATIVE_ORACLE_HELPER_HEX_TEXT_BYTES_MAX,
  NATIVE_ORACLE_HELPER_INPUT_BYTES_MAX,
  NATIVE_ORACLE_HELPER_OUTPUT_BYTES_MAX,
  NATIVE_ORACLE_HELPER_STDERR_BYTES_MAX,
  NATIVE_ORACLE_HELPER_TITLE_BYTES_MAX,
  resolveNativeOracleHelperPath,
  type NativeOracleCreateEnumRequest,
  type NativeOracleSignEnumRequest,
} from '../src/nativeOracleHelper.ts'

const require = createRequire(import.meta.url)
const nostrTools = require('nostr-tools/pure') as {
  finalizeEvent(
    template: {
      readonly kind: number
      readonly created_at: number
      readonly tags: readonly (readonly string[])[]
      readonly content: string
    },
    secretKey: Uint8Array,
  ): SignedNostrEvent
  getPublicKey(secretKey: Uint8Array): string
}

const ORACLE_SECRET = '01'.repeat(32)
const NONCE_SEED = '02'.repeat(32)
const ANNOUNCEMENT_BODY_HEX = '01'.repeat(260)
const ANNOUNCEMENT_TLV_HEX = `fdd824fd0104${ANNOUNCEMENT_BODY_HEX}`
const ANNOUNCEMENT_CONTENT = Buffer.from(ANNOUNCEMENT_BODY_HEX, 'hex').toString('base64')

interface SignedNostrEvent {
  readonly id: string
  readonly pubkey: string
  readonly created_at: number
  readonly kind: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
  readonly sig: string
}

interface CapturedSpawn {
  readonly command: string
  readonly args: readonly string[]
  readonly options: {
    readonly cwd?: string
    readonly env?: NodeJS.ProcessEnv
    readonly shell?: boolean
    readonly stdio?: unknown
  }
  readonly input: () => Buffer
}

function createExecutableFixture(): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'bitcaster-oracle-helper-'))
  const path = join(directory, 'helper')
  writeFileSync(path, '')
  chmodSync(path, 0o700)
  return { path, cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

function fakeSpawn(options: {
  readonly stdout?: Buffer | string
  readonly stderr?: Buffer | string
  readonly exitCode?: number
  readonly signal?: NodeJS.Signals | null
  readonly complete?: boolean
  readonly emitError?: boolean
}): { spawn: typeof import('node:child_process').spawn; calls: CapturedSpawn[] } {
  const calls: CapturedSpawn[] = []
  const spawn = ((command: string, args: readonly string[], spawnOptions: object) => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      kill: (signal?: NodeJS.Signals) => boolean
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    let input = Buffer.alloc(0)
    child.stdin.on('data', (chunk: Buffer) => {
      input = Buffer.concat([input, chunk])
    })
    child.kill = (signal?: NodeJS.Signals) => {
      child.emit('close', null, signal ?? 'SIGKILL')
      return true
    }
    calls.push({
      command,
      args,
      options: spawnOptions as CapturedSpawn['options'],
      input: () => input,
    })
    child.stdin.once('finish', () => {
      if (options.complete === false) return
      setImmediate(() => {
        if (options.emitError === true) {
          child.emit('error', new Error('private test failure'))
          return
        }
        if (options.stdout !== undefined) child.stdout.end(options.stdout)
        else child.stdout.end()
        if (options.stderr !== undefined) child.stderr.end(options.stderr)
        else child.stderr.end()
        child.emit('close', options.exitCode ?? 0, options.signal ?? null)
      })
    })
    return child as unknown as ChildProcessWithoutNullStreams
  }) as typeof import('node:child_process').spawn
  return { spawn, calls }
}

function makeCreateRequest(overrides: Partial<NativeOracleCreateEnumRequest> = {}) {
  return {
    oracleSecretKeyHex: ORACLE_SECRET,
    nonceSeedHex: NONCE_SEED,
    reservedNonceIndex: 7,
    eventId: 'market-event-7',
    outcomes: ['YES', 'NO'],
    eventMaturityEpoch: 1_800_000_000,
    title: 'Market title',
    description: 'Market description',
    ...overrides,
  }
}

function makeSignRequest(
  announcementNostrEventJson = JSON.stringify(makeNostrEvent(88, [], 'AQ==')),
  overrides: Partial<NativeOracleSignEnumRequest> = {},
) {
  return {
    oracleSecretKeyHex: ORACLE_SECRET,
    nonceSeedHex: NONCE_SEED,
    reservedNonceIndex: 7,
    eventId: 'market-event-7',
    chosenOutcome: 'YES',
    announcementTlvHex: 'aabb',
    announcementNostrEventJson,
    ...overrides,
  }
}

function makeNostrEvent(
  kind: number,
  tags: readonly (readonly string[])[],
  content: string,
): SignedNostrEvent {
  return nostrTools.finalizeEvent(
    {
      kind,
      created_at: 1_800_000_000,
      tags,
      content,
    },
    Buffer.from(ORACLE_SECRET, 'hex'),
  )
}

function successResponse(response: unknown): string {
  return `${JSON.stringify(response)}\n`
}

function successCreateResponse(
  request: NativeOracleCreateEnumRequest,
  overrides: Record<string, unknown> = {},
) {
  const tags: string[][] = []
  if (request.title.length > 0) tags.push(['title', request.title])
  if (request.description.length > 0) tags.push(['description', request.description])
  const announcement = makeNostrEvent(88, tags, ANNOUNCEMENT_CONTENT)
  return {
    version: 1,
    ok: true,
    action: 'create-enum',
    eventId: request.eventId,
    oraclePublicKeyHex: nostrTools.getPublicKey(Buffer.from(ORACLE_SECRET, 'hex')),
    announcementTlvHex: ANNOUNCEMENT_TLV_HEX,
    announcementNostrEventId: announcement.id,
    announcementNostrEventJson: JSON.stringify(announcement),
    ...overrides,
  }
}

function successSignResponse(
  request: NativeOracleSignEnumRequest,
  announcement: SignedNostrEvent,
  overrides: Record<string, unknown> = {},
) {
  const attestationHex = 'beef'
  const attestation = makeNostrEvent(
    89,
    [['e', announcement.id]],
    Buffer.from(attestationHex, 'hex').toString('base64'),
  )
  return {
    version: 1,
    ok: true,
    action: 'sign-enum',
    eventId: request.eventId,
    chosenOutcome: request.chosenOutcome,
    attestationHex,
    attestationNostrEventId: attestation.id,
    attestationNostrEventJson: JSON.stringify(attestation),
    ...overrides,
  }
}

function withAdapter<T>(
  run: (fixture: ReturnType<typeof createExecutableFixture>) => Promise<T>,
): Promise<T> {
  const fixture = createExecutableFixture()
  return run(fixture).finally(fixture.cleanup)
}

test('create sends one bounded private JSON request and validates the signed kind-88 response', async () => {
  await withAdapter(async (fixture) => {
    const request = makeCreateRequest()
    const mock = fakeSpawn({ stdout: successResponse(successCreateResponse(request)) })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mock.spawn,
    })

    adapter.assertAvailable()
    const response = await adapter.createEnum(request)

    assert.equal(response.eventId, request.eventId)
    assert.equal(
      response.oraclePublicKeyHex,
      nostrTools.getPublicKey(Buffer.from(ORACLE_SECRET, 'hex')),
    )
    assert.equal(response.announcementTlvHex, ANNOUNCEMENT_TLV_HEX)
    assert.equal(mock.calls.length, 1)
    assert.equal(mock.calls[0].args.length, 0)
    assert.equal(mock.calls[0].options.shell, false)
    assert.equal(Object.keys(mock.calls[0].options.env ?? {}).length, 0)
    const sent = JSON.parse(mock.calls[0].input().toString('utf8')) as Record<string, unknown>
    assert.equal(sent.action, 'create-enum')
    assert.equal(sent.oracleSecretKeyHex, ORACLE_SECRET)
    assert.equal(sent.nonceSeedHex, NONCE_SEED)
  })
})

test('create rejects a validly signed kind-88 event that does not encode the returned TLV body', async () => {
  await withAdapter(async (fixture) => {
    const request = makeCreateRequest()
    const validResponse = successCreateResponse(request)
    const tags: string[][] = []
    if (request.title.length > 0) tags.push(['title', request.title])
    if (request.description.length > 0) tags.push(['description', request.description])
    const mismatchedAnnouncement = makeNostrEvent(88, tags, 'Ag==')
    const mock = fakeSpawn({
      stdout: successResponse({
        ...validResponse,
        announcementNostrEventId: mismatchedAnnouncement.id,
        announcementNostrEventJson: JSON.stringify(mismatchedAnnouncement),
      }),
    })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mock.spawn,
    })

    await assert.rejects(adapter.createEnum(request), {
      reason: 'malformed-response',
      uncertain: true,
    })
    assert.equal(mock.calls.length, 1)
  })
})

test('sign binds the attestation to the persisted kind-88 event and requested outcome', async () => {
  await withAdapter(async (fixture) => {
    const announcement = makeNostrEvent(88, [], 'AQ==')
    const request = makeSignRequest(JSON.stringify(announcement))
    const mock = fakeSpawn({
      stdout: successResponse(successSignResponse(request, announcement)),
    })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mock.spawn,
    })

    const response = await adapter.signEnum(request)

    assert.equal(response.eventId, request.eventId)
    assert.equal(response.chosenOutcome, request.chosenOutcome)
    assert.equal(response.attestationHex, 'beef')
    const sent = JSON.parse(mock.calls[0].input().toString('utf8')) as Record<string, unknown>
    assert.equal(sent.action, 'sign-enum')
    assert.equal(sent.announcementNostrEventJson, request.announcementNostrEventJson)
  })
})

test('create accepts the 191-byte outcome boundary and refuses 192 before process launch', async () => {
  await withAdapter(async (fixture) => {
    const boundaryRequest = makeCreateRequest({ outcomes: ['A'.repeat(191), 'NO'] })
    const boundarySpawn = fakeSpawn({
      stdout: successResponse(successCreateResponse(boundaryRequest)),
    })
    const boundaryAdapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: boundarySpawn.spawn,
    })
    await boundaryAdapter.createEnum(boundaryRequest)
    const sent = JSON.parse(boundarySpawn.calls[0].input().toString('utf8')) as {
      outcomes: readonly string[]
    }
    assert.equal(sent.outcomes[0].length, 191)

    const tooLongSpawn = fakeSpawn({ stdout: '{}\n' })
    const tooLongAdapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: tooLongSpawn.spawn,
    })
    await assert.rejects(
      tooLongAdapter.createEnum(makeCreateRequest({ outcomes: ['A'.repeat(192), 'NO'] })),
      {
        reason: 'invalid-request',
        uncertain: false,
      },
    )
    assert.equal(tooLongSpawn.calls.length, 0)
  })
})

test('metadata and request envelope limits accept the exact bound and reject overflow', async () => {
  await withAdapter(async (fixture) => {
    const mock = fakeSpawn({ complete: false })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mock.spawn,
      timeoutMs: 20,
    })
    const request = makeCreateRequest({
      title: 't'.repeat(NATIVE_ORACLE_HELPER_TITLE_BYTES_MAX),
      description: 'd'.repeat(NATIVE_ORACLE_HELPER_DESCRIPTION_BYTES_MAX),
    })
    await assert.rejects(adapter.createEnum(request), {
      reason: 'timed-out',
      uncertain: true,
    })
    assert.equal(mock.calls.length, 1)
    assert.ok(mock.calls[0].input().length <= NATIVE_ORACLE_HELPER_INPUT_BYTES_MAX)

    for (const oversized of [
      makeCreateRequest({ title: 't'.repeat(NATIVE_ORACLE_HELPER_TITLE_BYTES_MAX + 1) }),
      makeCreateRequest({
        description: 'd'.repeat(NATIVE_ORACLE_HELPER_DESCRIPTION_BYTES_MAX + 1),
      }),
    ]) {
      await assert.rejects(adapter.createEnum(oversized), {
        reason: 'invalid-request',
        uncertain: false,
      })
    }
    const escapedRequest = makeCreateRequest({ title: '\u0001'.repeat(180_000) })
    await assert.rejects(adapter.createEnum(escapedRequest), {
      reason: 'invalid-request',
      uncertain: false,
    })
    assert.equal(mock.calls.length, 1)
  })
})

test('signed announcement JSON accepts 256 KiB and refuses larger input before spawn', async () => {
  await withAdapter(async (fixture) => {
    const emptyEvent = JSON.stringify(makeNostrEvent(88, [], ''))
    const content = 'x'.repeat(
      NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX - Buffer.byteLength(emptyEvent, 'utf8'),
    )
    const eventJson = JSON.stringify(makeNostrEvent(88, [], content))
    assert.equal(Buffer.byteLength(eventJson, 'utf8'), NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX)

    const mock = fakeSpawn({ complete: false })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mock.spawn,
      timeoutMs: 30,
    })
    await assert.rejects(adapter.signEnum(makeSignRequest(eventJson)), {
      reason: 'timed-out',
      uncertain: true,
    })
    assert.equal(mock.calls.length, 1)

    await assert.rejects(
      adapter.signEnum(makeSignRequest('x'.repeat(NATIVE_ORACLE_HELPER_EVENT_JSON_BYTES_MAX + 1))),
      { reason: 'invalid-request', uncertain: false },
    )
    assert.equal(mock.calls.length, 1)
  })
})

test('announcement hex accepts 48 KiB of text and refuses larger input before spawn', async () => {
  await withAdapter(async (fixture) => {
    const mock = fakeSpawn({ complete: false })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mock.spawn,
      timeoutMs: 30,
    })
    const maximumHex = 'ab'.repeat(NATIVE_ORACLE_HELPER_HEX_TEXT_BYTES_MAX / 2)
    await assert.rejects(
      adapter.signEnum(makeSignRequest(undefined, { announcementTlvHex: maximumHex })),
      {
        reason: 'timed-out',
        uncertain: true,
      },
    )
    assert.equal(mock.calls.length, 1)

    await assert.rejects(
      adapter.signEnum(
        makeSignRequest(undefined, {
          announcementTlvHex: `${maximumHex}ab`,
        }),
      ),
      { reason: 'invalid-request', uncertain: false },
    )
    assert.equal(mock.calls.length, 1)
  })
})

test('missing executable fails availability before any child process call', async () => {
  const mock = fakeSpawn({ stdout: '{}\n' })
  const adapter = createNativeOracleHelperAdapter({
    resolveExecutable: () => '/path/not-present/bitcaster-oracle-helper',
    spawnProcess: mock.spawn,
  })
  assert.throws(adapter.assertAvailable, {
    reason: 'helper-unavailable',
    uncertain: false,
  })
  assert.equal(mock.calls.length, 0)
})

test('verify sends public artifacts only and failures never imply uncertain signing', async () => {
  await withAdapter(async (fixture) => {
    const announcement = makeNostrEvent(88, [], 'AQ==')
    const attestation = makeNostrEvent(89, [['e', announcement.id]], 'Ag==')
    const request = {
      eventId: 'event-1',
      oraclePublicKeyHex: announcement.pubkey,
      chosenOutcome: 'Yes',
      announcementTlvHex: 'aabb',
      announcementNostrEventJson: JSON.stringify(announcement),
      attestationHex: '02',
      attestationNostrEventJson: JSON.stringify(attestation),
    }
    const response = {
      version: 1,
      ok: true,
      action: 'verify-enum',
      eventId: request.eventId,
      oraclePublicKeyHex: request.oraclePublicKeyHex,
      chosenOutcome: request.chosenOutcome,
      announcementNostrEventId: announcement.id,
      attestationNostrEventId: attestation.id,
      noncePointHex: '11'.repeat(32),
      oracleSignatureHex: '22'.repeat(64),
    }
    const mocked = fakeSpawn({ stdout: successResponse(response) })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mocked.spawn,
    })
    assert.equal((await adapter.verifyEnum(request)).attestationNostrEventId, attestation.id)
    const sent = JSON.parse(mocked.calls[0].input().toString('utf8'))
    assert.deepEqual(sent, { version: 1, action: 'verify-enum', ...request })
    assert.equal('oracleSecretKeyHex' in sent, false)
    assert.equal('nonceSeedHex' in sent, false)
    assert.equal('reservedNonceIndex' in sent, false)
    assert.deepEqual(mocked.calls[0].args, [])
    for (const stdout of [
      successResponse({ ...response, action: 'sign-enum' }),
      successResponse({ version: 1, ok: false, code: 'invalid-announcement' }),
    ]) {
      const failed = fakeSpawn({ stdout })
      await assert.rejects(
        createNativeOracleHelperAdapter({
          resolveExecutable: () => fixture.path,
          spawnProcess: failed.spawn,
        }).verifyEnum(request),
        (error: unknown) => error instanceof NativeOracleHelperError && error.uncertain === false,
      )
    }
  })
})

test('helper rejection is fixed and does not echo request secrets', async () => {
  await withAdapter(async (fixture) => {
    const secret = '03'.repeat(32)
    const request = makeCreateRequest({ oracleSecretKeyHex: secret })
    const mock = fakeSpawn({
      stdout: successResponse({ version: 1, ok: false, code: 'invalid-outcome' }),
      exitCode: 1,
    })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mock.spawn,
    })
    await assert.rejects(adapter.createEnum(request), (error: unknown) => {
      assert.ok(error instanceof NativeOracleHelperError)
      assert.equal(error.reason, 'helper-rejected')
      assert.equal(error.helperCode, 'invalid-outcome')
      assert.equal(error.uncertain, false)
      assert.equal(error.message.includes(secret), false)
      return true
    })
  })
})

test('wrong action or public bindings fail as uncertain malformed helper output', async () => {
  await withAdapter(async (fixture) => {
    const request = makeCreateRequest()
    for (const override of [
      { action: 'sign-enum' },
      { eventId: 'other-event' },
      { oraclePublicKeyHex: 'ff'.repeat(32) },
    ]) {
      const mock = fakeSpawn({
        stdout: successResponse(successCreateResponse(request, override)),
      })
      const adapter = createNativeOracleHelperAdapter({
        resolveExecutable: () => fixture.path,
        spawnProcess: mock.spawn,
      })
      await assert.rejects(adapter.createEnum(request), {
        reason: 'malformed-response',
        uncertain: true,
      })
    }
  })
})

test('sign refuses a valid kind-89 event that cites another kind-88 ID', async () => {
  await withAdapter(async (fixture) => {
    const announcement = makeNostrEvent(88, [], 'AQ==')
    const request = makeSignRequest(JSON.stringify(announcement))
    const wrongReference = makeNostrEvent(
      89,
      [['e', '11'.repeat(32)]],
      Buffer.from('beef', 'hex').toString('base64'),
    )
    const response = successSignResponse(request, announcement, {
      attestationNostrEventId: wrongReference.id,
      attestationNostrEventJson: JSON.stringify(wrongReference),
    })
    const mock = fakeSpawn({ stdout: successResponse(response) })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mock.spawn,
    })
    await assert.rejects(adapter.signEnum(request), {
      reason: 'malformed-response',
      uncertain: true,
    })
  })
})

test('invalid incoming announcement is rejected before helper invocation', async () => {
  await withAdapter(async (fixture) => {
    const mock = fakeSpawn({ stdout: '{}\n' })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mock.spawn,
    })
    await assert.rejects(adapter.signEnum(makeSignRequest('{"kind":88}')), {
      reason: 'invalid-request',
      uncertain: false,
    })
    assert.equal(mock.calls.length, 0)
  })
})

test('stdout and stderr caps terminate the helper without exposing its output', async () => {
  await withAdapter(async (fixture) => {
    for (const output of [
      { stdout: Buffer.alloc(NATIVE_ORACLE_HELPER_OUTPUT_BYTES_MAX + 1) },
      { stderr: Buffer.alloc(NATIVE_ORACLE_HELPER_STDERR_BYTES_MAX + 1) },
    ]) {
      const mock = fakeSpawn(output)
      const adapter = createNativeOracleHelperAdapter({
        resolveExecutable: () => fixture.path,
        spawnProcess: mock.spawn,
      })
      await assert.rejects(adapter.createEnum(makeCreateRequest()), (error: unknown) => {
        assert.ok(error instanceof NativeOracleHelperError)
        assert.equal(error.reason, 'output-limit')
        assert.equal(error.uncertain, true)
        assert.equal(error.message.includes(ORACLE_SECRET), false)
        return true
      })
    }
  })
})

test('timeout and process errors stay uncertain and redact child error text', async () => {
  await withAdapter(async (fixture) => {
    const timeoutMock = fakeSpawn({ complete: false })
    const timeoutAdapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: timeoutMock.spawn,
      timeoutMs: 10,
    })
    await assert.rejects(timeoutAdapter.createEnum(makeCreateRequest()), {
      reason: 'timed-out',
      uncertain: true,
    })

    const processMock = fakeSpawn({ emitError: true })
    const processAdapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: processMock.spawn,
    })
    await assert.rejects(processAdapter.createEnum(makeCreateRequest()), (error: unknown) => {
      assert.ok(error instanceof NativeOracleHelperError)
      assert.equal(error.reason, 'process-failure')
      assert.equal(error.uncertain, true)
      assert.equal(error.message.includes('private test failure'), false)
      return true
    })
  })
})

test('helper resolution follows the installed daemon package native directory', async () => {
  const packageRoot = fileURLToPath(new URL('../', import.meta.url))
  assert.equal(
    relative(packageRoot, resolveNativeOracleHelperPath()),
    `native/${process.platform}-${process.arch}/bitcaster-oracle-helper`,
  )
  await withAdapter(async (fixture) => {
    const mock = fakeSpawn({ stdout: '{}\n' })
    const adapter = createNativeOracleHelperAdapter({
      resolveExecutable: () => fixture.path,
      spawnProcess: mock.spawn,
    })
    const request = makeCreateRequest()
    await assert.rejects(adapter.createEnum(request), { reason: 'malformed-response' })
    assert.equal(mock.calls[0].command, fixture.path)
    assert.equal(mock.calls[0].command.includes('target'), false)
    assert.equal(mock.calls[0].args.length, 0)
    assert.ok(mock.calls[0].options.cwd?.endsWith('/bitcaster-daemon/'))
  })
})
