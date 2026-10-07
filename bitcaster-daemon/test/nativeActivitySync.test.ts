import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { finalizeEvent, getPublicKey, type Event as NostrEvent } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'
import { hexToBytes } from 'nostr-tools/utils'
import { deriveDurableCustodyWalletId } from '@bitcaster-market/client-sdk/durableCustody'
import {
  ACTIVITY_LOG_D_TAG,
  encodeActivityLogPayload,
  decodeActivityLogPayload,
  type ActivityItem,
} from '@bitcaster-market/client-sdk/activityLog'
import { createPrivateNip78Content } from '@bitcaster-market/client-sdk/privateNip78'
import { syncNativeActivity } from '../src/nativeActivitySync.ts'
import { NativeNostrRelay } from '../src/nativeNostrRelay.ts'
import {
  queryNativeActivityRelay,
  publishNativeActivityRelay,
  NATIVE_ACTIVITY_RELAY_FRAME_BYTES_MAX,
} from '../src/nativeActivityRelay.ts'
import { NativeActivitySqlite } from '../src/nativeActivitySqlite.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'
import { openDaemonStateSqlite } from '../src/stateSqlite.ts'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import { dispatch, handleRequest } from '../src/server.ts'

const SECRET = '01'.repeat(32)
const SEED = '02'.repeat(64)
const WALLET_A = deriveDurableCustodyWalletId(Buffer.from(SEED, 'hex'))
const WALLET_B = deriveDurableCustodyWalletId(Buffer.from('03'.repeat(64), 'hex'))
const PUBLIC_KEY = getPublicKey(hexToBytes(SECRET))
const RELAYS = ['wss://first.example/Exact?Case=Yes', 'wss://second.example']

function row(
  id: string,
  walletId: string | undefined = WALLET_A,
  amountSubunits = 7,
): ActivityItem {
  return {
    id,
    ...(walletId === undefined ? {} : { walletId }),
    type: 'deposit',
    amountSubunits,
    baseAsset: 'sat',
    date: '2026-10-05T00:00:00.000Z',
    status: 'completed',
    txId: null,
    lightningInvoice: null,
  }
}
function envelope(items: readonly ActivityItem[], created_at = 10): NostrEvent {
  return rawEnvelope(encodeActivityLogPayload(items), created_at)
}
function rawEnvelope(plaintext: string, created_at = 10): NostrEvent {
  return finalizeEvent(
    { ...createPrivateNip78Content(SECRET, ACTIVITY_LOG_D_TAG, plaintext), created_at },
    hexToBytes(SECRET),
  )
}

function transport(
  options: {
    events?: readonly unknown[]
    eventsForQuery?: (query: number, url: string) => readonly unknown[]
    beforeQuery?: (query: number) => Promise<void>
    beforeOpen?: (index: number) => Promise<void>
    rawFrames?: readonly string[]
    eose?: boolean
    open?: boolean
    acknowledge?: boolean
  } = {},
) {
  const sockets: FakeSocket[] = []
  let queries = 0,
    peakActive = 0
  class FakeSocket {
    readyState = 0
    onopen: WebSocket['onopen'] = null
    onclose: WebSocket['onclose'] = null
    onerror: WebSocket['onerror'] = null
    onmessage: WebSocket['onmessage'] = null
    closeCount = 0
    sent: unknown[][] = []
    readonly url: string
    constructor(url: string) {
      this.url = url
      const index = sockets.length
      sockets.push(this)
      peakActive = Math.max(peakActive, sockets.filter((socket) => socket.closeCount === 0).length)
      queueMicrotask(() => {
        void (async () => {
          await options.beforeOpen?.(index)
          if (options.open === false || this.closeCount > 0) return
          this.readyState = 1
          this.onopen?.call(this as unknown as WebSocket, new Event('open'))
        })()
      })
    }
    send(raw: string) {
      const frame = JSON.parse(raw)
      this.sent.push(frame)
      if (frame[0] === 'REQ') {
        const query = ++queries
        setImmediate(() => {
          void (async () => {
            await options.beforeQuery?.(query)
            for (const event of options.eventsForQuery?.(query, this.url) ?? options.events ?? [])
              this.deliver(['EVENT', frame[1], event])
            for (const message of options.rawFrames ?? []) this.deliverRaw(message)
            if (options.eose !== false) this.deliver(['EOSE', frame[1]])
          })()
        })
      }
      if (frame[0] === 'EVENT' && options.acknowledge !== false)
        queueMicrotask(() => this.deliver(['OK', frame[1].id, true, '']))
    }
    deliver(frame: unknown) {
      this.deliverRaw(JSON.stringify(frame))
    }
    deliverRaw(data: string) {
      this.onmessage?.call(this as unknown as WebSocket, new MessageEvent('message', { data }))
    }
    close() {
      this.closeCount++
      this.readyState = 3
    }
  }
  return {
    sockets,
    peakActive: () => peakActive,
    factory: (url: string, config: ConstructorParameters<typeof NativeNostrRelay>[1]) =>
      new NativeNostrRelay(url, {
        ...config,
        websocketImplementation: FakeSocket as unknown as typeof WebSocket,
      }),
  }
}

async function fixture(relays: readonly string[] = RELAYS) {
  const directory = await mkdtemp(join(tmpdir(), 'activity-sync-'))
  const previousHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  const profile = await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: SEED,
    nostrSecretKeyHex: SECRET,
  })
  updateNativeConfig(
    (current) => ({ ...current, daemon: { ...current.daemon, nostrRelays: relays } }),
    { directory },
  )
  const fence = await claimCustodyScopeLease(directory, {
    scopeId: profile.walletScopeId,
    incarnationId: 'activity-sync-test',
    observedAtMs: Date.now(),
  })
  const query = async <T>(action: (database: import('node:sqlite').DatabaseSync) => T) => {
    const database = await openDaemonStateSqlite(directory)
    try {
      return action(database)
    } finally {
      database.close()
    }
  }
  return {
    directory,
    fence,
    query,
    sync: (
      io: ReturnType<typeof transport>,
      request: Parameters<typeof syncNativeActivity>[2] = {},
      extra: Partial<Parameters<typeof syncNativeActivity>[3]> = {},
    ) => syncNativeActivity(directory, () => fence, request, { factory: io.factory, ...extra }),
    rows: () =>
      query((database) => new NativeActivitySqlite(database).page({ walletId: WALLET_A }).items),
    put: (item: ActivityItem) =>
      query((database) =>
        new NativeActivitySqlite(database).upsert({
          walletId: WALLET_A,
          item,
          origin: 'native',
          sourceId: item.id,
        }),
      ),
    close: async () => {
      if (previousHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = previousHome
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function publishedEvents(io: ReturnType<typeof transport>): NostrEvent[] {
  return io.sockets.flatMap((socket) =>
    socket.sent.filter((frame) => frame[0] === 'EVENT').map((frame) => frame[1] as NostrEvent),
  )
}

function browserDecrypt(event: NostrEvent): string {
  const key = nip44.utils.getConversationKey(hexToBytes(SECRET), PUBLIC_KEY)
  return nip44.decrypt(event.content, key)
}

test('default sync imports browser-compatible encrypted rows only for the selected wallet and keeps custody unchanged', async () => {
  const f = await fixture()
  const legacy = row('legacy')
  delete legacy.walletId
  const event = envelope([row('a'), row('b', WALLET_B), legacy])
  const io = transport({ events: [event] })
  try {
    const custodyBefore = await f.query((database) =>
      database.prepare('SELECT * FROM custody_scope_state').all(),
    )
    const result = await f.sync(io)
    assert.equal(result.importedRows, 1)
    assert.equal(result.ignoredRows, 2)
    assert.equal(result.queryComplete, true)
    assert.equal(result.completeHistory, false)
    assert.equal(result.publication.status, 'not-requested')
    assert.equal(publishedEvents(io).length, 0)
    assert.deepEqual(await f.rows(), [row('a')])
    assert.deepEqual(
      await f.query((database) => database.prepare('SELECT * FROM custody_scope_state').all()),
      custodyBefore,
    )
    assert.equal(JSON.stringify(result).includes(SECRET), false)
    const stored = await f.query(
      (database) =>
        database.prepare('SELECT source_id AS id, sequence FROM daemon_activity_feed').get()!,
    )
    assert.equal(stored.id, `nip78:${event.id}`)
    const repeat = await f.sync(transport({ events: [event] }))
    assert.equal(repeat.importedRows, 0)
    assert.equal(repeat.unchangedRows, 1)
    assert.deepEqual(
      await f.query(
        (database) =>
          database.prepare('SELECT source_id AS id, sequence FROM daemon_activity_feed').get()!,
      ),
      stored,
    )
    for (const socket of io.sockets) {
      assert.equal(socket.closeCount, 1)
      assert.equal(socket.onmessage, null)
      assert.deepEqual(socket.sent[0]?.[2], {
        kinds: [30078],
        authors: [PUBLIC_KEY],
        '#d': [ACTIVITY_LOG_D_TAG],
        limit: 1,
      })
    }
    const offline = await dispatch(
      { method: 'wallet.activity' },
      {
        nativeActivitySyncOptions: {
          factory: () => {
            throw new Error('offline feed opened a relay')
          },
        },
      },
    )
    assert.equal(offline.ok, true)
  } finally {
    await f.close()
  }
})

for (const nativeFirst of [true, false]) {
  test(`native exact-ID precedence survives relay arrival ${nativeFirst ? 'after' : 'before'} the local row`, async () => {
    const f = await fixture()
    try {
      const native = row('same', WALLET_A, 9)
      if (nativeFirst) await f.put(native)
      await f.sync(transport({ events: [envelope([row('same')])] }))
      const before = await f.query(
        (database) => database.prepare('SELECT sequence FROM daemon_activity_feed').get()!.sequence,
      )
      if (!nativeFirst) await f.put(native)
      const result = await f.sync(transport({ events: [envelope([row('same')])] }))
      assert.equal(result.nativeRowsKept, 1)
      assert.deepEqual(await f.rows(), [native])
      assert.equal(
        await f.query(
          (database) =>
            database.prepare('SELECT sequence FROM daemon_activity_feed').get()!.sequence,
        ),
        before,
      )
    } finally {
      await f.close()
    }
  })
}

test('publication preserves observed foreign and legacy rows and reports bounded native truncation and relay acknowledgements', async () => {
  const f = await fixture()
  const legacy = row('legacy')
  delete legacy.walletId
  const remote = envelope([row('other-wallet', WALLET_B), legacy])
  const io = transport({ events: [remote] })
  try {
    for (const id of ['one', 'two', 'three']) await f.put(row(id))
    const result = await f.sync(io, { publish: true, limit: 1 })
    assert.equal(result.window.localRows, 1)
    assert.equal(result.window.localTruncated, true)
    assert.equal(result.publication.status, 'acknowledged')
    assert.equal(result.publication.acknowledgedRelayCount, 2)
    assert.equal(result.publication.remainingReadPublishRace, true)
    const events = publishedEvents(io)
    assert.equal(events.length, 2)
    assert.equal(events[0]!.id, events[1]!.id)
    assert.deepEqual(events[0]!.tags, [
      ['d', ACTIVITY_LOG_D_TAG],
      ['encrypted', 'nip44'],
    ])
    const plaintext = browserDecrypt(events[0]!)
    const published = decodeActivityLogPayload(plaintext)!
    assert.equal(published.length, 3)
    assert.ok(published.some((item) => item.id === 'three' && item.walletId === WALLET_A))
    assert.ok(published.some((item) => item.id === 'other-wallet' && item.walletId === WALLET_B))
    assert.ok(published.some((item) => item.id === 'legacy' && item.walletId === undefined))
    assert.equal(result.publication.plaintextBytes, Buffer.byteLength(plaintext))
    assert.equal((await f.rows()).length, 3)
  } finally {
    await f.close()
  }
})

test('shared Claim recovery metadata survives selected-wallet import and encrypted publication', async () => {
  const f = await fixture()
  const recovery: ActivityItem = {
    ...row('recovered-claim'),
    type: 'payout_claimed',
    claimRecovery: {
      kind: 'retained-claim-payout',
      originalOperationId: 'original-failed-claim',
      originalStatus: 'Failed',
      originalFailureCode: 13015,
    },
  }
  const foreignRecovery = { ...recovery, walletId: WALLET_B }
  const io = transport({ events: [envelope([recovery, foreignRecovery])] })
  try {
    const result = await f.sync(io, { publish: true })
    assert.equal(result.importedRows, 1)
    assert.equal(result.ignoredRows, 1)
    assert.equal(result.publication.status, 'acknowledged')
    assert.deepEqual(await f.rows(), [recovery])
    assert.deepEqual(decodeActivityLogPayload(browserDecrypt(publishedEvents(io)[0]!)), [
      recovery,
      foreignRecovery,
    ])
  } finally {
    await f.close()
  }
})

for (const kind of [
  'tampered-ciphertext',
  'unknown-row-field',
  'malformed-row',
  'unknown-envelope-field',
] as const) {
  test(`publication refuses ${kind} instead of rewriting an unsafe remote snapshot`, async () => {
    const f = await fixture()
    try {
      const value = { items: [row('remote')] } as { items: unknown[]; future?: string }
      if (kind === 'unknown-row-field') value.items = [{ ...row('remote'), future: 'must survive' }]
      if (kind === 'malformed-row') value.items.push({ unsupported: true })
      if (kind === 'unknown-envelope-field') value.future = 'must survive'
      let event = rawEnvelope(JSON.stringify(value))
      if (kind === 'tampered-ciphertext')
        event = finalizeEvent(
          {
            kind: event.kind,
            created_at: event.created_at,
            tags: event.tags,
            content: event.content.slice(0, -4) + 'AAAA',
          },
          hexToBytes(SECRET),
        )
      const io = transport({ events: [event] })
      const result = await f.sync(io, { publish: true })
      assert.equal(result.publication.status, 'refused')
      assert.equal(result.publication.reason, 'remote-envelope-cannot-be-preserved')
      assert.equal(publishedEvents(io).length, 0)
      assert.equal(result.importedRows, kind === 'tampered-ciphertext' ? 0 : 1)
    } finally {
      await f.close()
    }
  })
}

test('signature tampering and a foreign author cannot import a wallet row', async () => {
  const f = await fixture()
  try {
    const valid = envelope([row('not-imported')])
    const invalid = { ...valid, content: valid.content + 'tampered' }
    const foreign = finalizeEvent(
      { kind: valid.kind, created_at: valid.created_at, tags: valid.tags, content: valid.content },
      hexToBytes('03'.repeat(32)),
    )
    const result = await f.sync(transport({ events: [invalid, foreign] }))
    assert.equal(result.importedRows, 0)
    assert.equal((await f.rows()).length, 0)
  } finally {
    await f.close()
  }
})

test('a changed exact event ID on final reread refuses publication without a merge/retry loop', async () => {
  const f = await fixture()
  const initial = envelope([row('observed')], 10)
  const changed = envelope([row('new-remote', WALLET_B)], 10)
  const io = transport({ eventsForQuery: (query) => [query <= RELAYS.length ? initial : changed] })
  try {
    const result = await f.sync(io, { publish: true })
    assert.equal(result.importedRows, 1)
    assert.equal(result.publication.status, 'refused')
    assert.equal(result.publication.reason, 'remote-event-changed')
    assert.equal(io.sockets.length, 4)
    assert.equal(publishedEvents(io).length, 0)
  } finally {
    await f.close()
  }
})

test('a future remote timestamp and an oversized preserved payload refuse publication', async () => {
  const f = await fixture()
  try {
    const future = transport({
      events: [envelope([row('future')], Math.floor(Date.now() / 1000) + 100)],
    })
    const refused = await f.sync(future, { publish: true })
    assert.equal(refused.publication.reason, 'remote-event-is-not-older-than-publication')
    for (let index = 0; index < 5; index++)
      await f.put({ ...row(`large-${index}`), lightningInvoice: 'a'.repeat(15000) })
    const empty = transport()
    const overflow = await f.sync(empty, { publish: true })
    assert.equal(overflow.publication.reason, 'preserved-snapshot-exceeds-sync-bound')
    assert.ok(overflow.publication.plaintextBytes! > 65535)
    assert.equal(publishedEvents(empty).length, 0)
    assert.equal((await f.rows()).length, 6)
  } finally {
    await f.close()
  }
})

for (const changed of ['signer', 'config', 'fence', 'cancel'] as const) {
  test(`${changed} change during relay work fences the atomic display import`, async () => {
    const f = await fixture()
    const controller = new AbortController()
    let changedOnce = false
    const io = transport({
      events: [envelope([row('not-imported')])],
      beforeQuery: async () => {
        if (changedOnce) return
        changedOnce = true
        if (changed === 'signer')
          await f.query((database) =>
            database.exec('UPDATE daemon_profile SET signer_revision = signer_revision + 1'),
          )
        if (changed === 'config')
          updateNativeConfig(
            (current) => ({
              ...current,
              daemon: { ...current.daemon, nostrRelays: ['wss://changed.example'] },
            }),
            { directory: f.directory },
          )
        if (changed === 'fence')
          await f.query((database) =>
            database.exec(
              "UPDATE custody_scope_state SET fencing_epoch = fencing_epoch + 1, owner_incarnation_id = 'another-active-owner'",
            ),
          )
        if (changed === 'cancel') controller.abort()
      },
    })
    try {
      await assert.rejects(f.sync(io, {}, { signal: controller.signal }), /changed|stale|cancelled/)
      assert.equal((await f.rows()).length, 0)
      assert.ok(io.sockets.every((socket) => socket.closeCount === 1))
    } finally {
      await f.close()
    }
  })
}

test('a signer revision change while the publication socket connects prevents the EVENT send', async () => {
  const f = await fixture([RELAYS[0]!])
  const io = transport({
    beforeOpen: async (index) => {
      if (index === 2)
        await f.query((database) =>
          database.exec('UPDATE daemon_profile SET signer_revision = signer_revision + 1'),
        )
    },
  })
  try {
    await f.put(row('local'))
    await assert.rejects(f.sync(io, { publish: true }), /changed/)
    assert.equal(publishedEvents(io).length, 0)
    assert.ok(io.sockets.every((socket) => socket.closeCount === 1))
  } finally {
    await f.close()
  }
})

test('incomplete relay reads retain safe observed imports and refuse publication', async () => {
  const f = await fixture()
  const io = transport({ events: [envelope([row('observed')])], eose: false })
  try {
    const result = await f.sync(io, { publish: true }, { deadlineMs: 20 })
    assert.equal(result.queryComplete, false)
    assert.equal(result.importedRows, 1)
    assert.equal(result.publication.reason, 'relay-query-incomplete')
    assert.ok(io.sockets.every((socket) => socket.closeCount === 1))
  } finally {
    await f.close()
  }
})

test('actual relay owners bound oversized bytes, invalid event floods, timeouts, and cancellation', async () => {
  const filter = { kinds: [30078], authors: [PUBLIC_KEY], '#d': [ACTIVITY_LOG_D_TAG], limit: 1 }
  for (const options of [
    { rawFrames: ['x'.repeat(NATIVE_ACTIVITY_RELAY_FRAME_BYTES_MAX + 1)] },
    {
      rawFrames: [
        JSON.stringify(['NOTICE', 'é'.repeat(NATIVE_ACTIVITY_RELAY_FRAME_BYTES_MAX / 2 + 1)]),
      ],
    },
    { rawFrames: Array.from({ length: 65 }, () => JSON.stringify(['NOTICE', 'bounded'])) },
    { events: Array.from({ length: 17 }, () => ({ id: 'invalid', sig: 'invalid' })) },
    { open: false },
  ]) {
    const io = transport(options)
    const result = await queryNativeActivityRelay(RELAYS[0]!, filter, {
      factory: io.factory,
      deadlineMs: 20,
    })
    assert.equal(result.complete, false)
    assert.ok(result.events.length <= 16)
    assert.equal(io.sockets[0]?.closeCount, 1)
  }
  const io = transport({ eose: false })
  const controller = new AbortController()
  const query = queryNativeActivityRelay(RELAYS[0]!, filter, {
    factory: io.factory,
    signal: controller.signal,
  })
  setImmediate(() => controller.abort())
  assert.equal((await query).complete, false)
  assert.equal(io.sockets[0]?.closeCount, 1)
  const stalled = transport({ acknowledge: false })
  assert.equal(
    await publishNativeActivityRelay(RELAYS[0]!, envelope([row('one')]), {
      factory: stalled.factory,
      deadlineMs: 20,
    }),
    false,
  )
  assert.equal(stalled.sockets[0]?.closeCount, 1)
})

test('sync RPC validates before profile reads and keeps the network opt-in separate from wallet activity', async () => {
  for (const params of [
    null,
    [],
    { limit: 0 },
    { limit: 501 },
    { limit: 1.5 },
    { publish: 'true' },
    { cursor: 'not-a-sync-option' },
    { walletId: 'invalid' },
  ]) {
    assert.deepEqual(await dispatch({ method: 'wallet.activity-sync', params } as never), {
      ok: false,
      code: 'invalid-wallet-activity-sync-request',
      error: 'Wallet Activity sync request is invalid',
    })
  }
  const f = await fixture()
  const io = transport({ events: [envelope([row('rpc')])] })
  try {
    const result = await dispatch(
      { method: 'wallet.activity-sync' },
      {
        getCustodyFence: () => f.fence,
        isCustodyReady: () => false,
        nativeActivitySyncOptions: { factory: io.factory },
      },
    )
    assert.equal(result.ok, true)
    assert.equal((result.result as { importedRows: number }).importedRows, 1)
    assert.equal(publishedEvents(io).length, 0)
  } finally {
    await f.close()
  }
})

test('configured relay fan-out stays at four owners and a selection above sixteen is refused before sockets', async () => {
  const f = await fixture(Array.from({ length: 11 }, (_, index) => `wss://relay-${index}.example`))
  try {
    await f.put(row('local'))
    const io = transport()
    const result = await f.sync(io, { publish: true })
    assert.equal(result.selectedRelayCount, 11)
    assert.equal(result.publication.acknowledgedRelayCount, 11)
    assert.equal(io.sockets.length, 33)
    assert.ok(io.peakActive() <= 4)
    assert.ok(io.sockets.every((socket) => socket.closeCount === 1))
    updateNativeConfig(
      (current) => ({
        ...current,
        daemon: {
          ...current.daemon,
          nostrRelays: Array.from({ length: 17 }, (_, index) => `wss://relay-${index}.example`),
        },
      }),
      { directory: f.directory },
    )
    const refused = transport()
    await assert.rejects(f.sync(refused), /selection exceeds its bound/)
    assert.equal(refused.sockets.length, 0)
  } finally {
    await f.close()
  }
})

test('partial publication reports acknowledgements separately from a successful import', async () => {
  const f = await fixture()
  const remote = envelope([row('received')])
  const good = transport({ events: [remote] })
  const bad = transport({ events: [remote], acknowledge: false })
  const factory = (url: string, options: ConstructorParameters<typeof NativeNostrRelay>[1]) =>
    (url === RELAYS[0] ? good : bad).factory(url, options)
  try {
    const result = await syncNativeActivity(
      f.directory,
      () => f.fence,
      { publish: true },
      { factory, deadlineMs: 50 },
    )
    assert.equal(result.importedRows, 1)
    assert.equal(result.publication.status, 'partial')
    assert.equal(result.publication.acknowledgedRelayCount, 1)
    assert.equal((await f.rows()).length, 1)
  } finally {
    await f.close()
  }
})

test('an HTTP caller disconnect cancels the owned relay work before any display import', async () => {
  const f = await fixture()
  class Response extends EventEmitter {
    writableEnded = false
    destroyed = false
    lines: string[] = []
    writeHead() {}
    end(value: string) {
      this.lines.push(value)
      this.writableEnded = true
    }
  }
  const response = new Response()
  const stream = Readable.from([Buffer.from(JSON.stringify({ method: 'wallet.activity-sync' }))])
  const request = Object.assign(stream, {
    method: 'POST',
    url: '/rpc',
    headers: { authorization: 'Bearer test-token' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage
  const io = transport({
    events: [envelope([row('not-imported')])],
    beforeQuery: async () => {
      response.destroyed = true
      response.emit('close')
    },
  })
  try {
    await handleRequest(request, response as unknown as ServerResponse, 'test-token', {
      getCustodyFence: () => f.fence,
      nativeActivitySyncOptions: { factory: io.factory },
    })
    assert.equal(response.lines.length, 0)
    assert.equal((await f.rows()).length, 0)
    assert.ok(io.sockets.every((socket) => socket.closeCount === 1))
    assert.equal(response.listenerCount('close'), 0)
  } finally {
    await f.close()
  }
})

test('Activity sync HTTP owns profile and dispatch read failures without exposing their details', async () => {
  for (const failure of ['profile', 'dispatch'] as const) {
    const f = await fixture()
    class Response extends EventEmitter {
      writableEnded = false
      destroyed = false
      status = 0
      lines: string[] = []
      writeHead(status: number) {
        this.status = status
      }
      end(value: string) {
        this.lines.push(value)
        this.writableEnded = true
      }
    }
    const response = new Response()
    const request = Object.assign(
      Readable.from([Buffer.from(JSON.stringify({ method: 'wallet.activity-sync' }))]),
      {
        method: 'POST',
        url: '/rpc',
        headers: { authorization: 'Bearer test-token' },
        socket: { remoteAddress: '127.0.0.1' },
      },
    ) as unknown as IncomingMessage
    let sockets = 0
    try {
      if (failure === 'profile')
        await f.query((database) =>
          database.prepare('UPDATE daemon_profile SET initialized_at_ms = 9007199254740992').run(),
        )
      await handleRequest(request, response as unknown as ServerResponse, 'test-token', {
        getCustodyFence: () => f.fence,
        ...(failure === 'dispatch'
          ? {
              isCustodyReady: () => {
                throw new Error('secret dispatch failure detail')
              },
            }
          : {}),
        nativeActivitySyncOptions: {
          factory: () => {
            sockets++
            throw new Error('unexpected relay')
          },
        },
      })
      assert.equal(response.status, failure === 'profile' ? 200 : 500)
      assert.deepEqual(JSON.parse(response.lines[0]!), {
        ok: false,
        code: 'wallet-activity-sync-failed',
        error:
          'Wallet Activity sync failed. Check the current signer, wallet, and relay selection.',
      })
      assert.equal(sockets, 0)
      assert.equal(response.listenerCount('close'), 0)
      assert.equal(request.listenerCount('aborted'), 0)
    } finally {
      await f.close()
    }
  }
})
