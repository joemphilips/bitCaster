import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent, verifyEvent, type Event as NostrEvent } from 'nostr-tools/pure'
import { prepareNostrProfileEdit } from '@bitcaster-market/client-sdk'
import { editNativeSignerProfile } from '../src/nativeSignerProfile.ts'
import { withNativeProfileEditSession } from '../src/nativeProfileCache.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import { readSelectedDaemonSigner, replaceDaemonSigner } from '../src/secrets.ts'
import { acquireDaemonRunLock } from '../src/runLock.ts'

const key = new Uint8Array(32).fill(1)
const base = finalizeEvent(
  {
    kind: 0,
    created_at: 10,
    tags: [],
    content: '{"name":"Old","custom":{"keep":true},"display_name":"Alias"}',
  },
  key,
)
const relays = ['wss://first.example/Exact?Case=Yes', 'wss://second.example']

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-profile-edit-'))
  const beforeHome = process.env.BITCASTER_DAEMON_HOME
  const beforePassword = process.env.BITCASTER_DAEMON_PASSPHRASE
  process.env.BITCASTER_DAEMON_HOME = join(root, 'profile')
  process.env.BITCASTER_DAEMON_PASSPHRASE = 'profile-edit-test-password'
  await bootstrapFreshDaemonProfile({
    directory: process.env.BITCASTER_DAEMON_HOME,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '02'.repeat(64),
    nostrSecretKeyHex: '01'.repeat(32),
    nativeOracleNonceSeedHex: '03'.repeat(32),
    passphrase: 'profile-edit-test-password',
  })
  updateNativeConfig((config) => ({ ...config, daemon: { ...config.daemon, nostrRelays: relays } }))
  return async () => {
    if (beforeHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = beforeHome
    if (beforePassword === undefined) delete process.env.BITCASTER_DAEMON_PASSPHRASE
    else process.env.BITCASTER_DAEMON_PASSPHRASE = beforePassword
    await rm(root, { recursive: true, force: true })
  }
}

interface TransportScript {
  event?: NostrEvent
  floodRead?: boolean
  floodPublish?: boolean
  failedReads?: readonly string[]
  statuses?: readonly ('accepted' | 'rejected' | 'unacknowledged')[]
  beforeEose?: () => Promise<void>
  beforeOpen?: (connection: number) => Promise<void>
  onPublish?: (event: NostrEvent, url: string) => Promise<void>
  acknowledgment?: (event: NostrEvent) => unknown[]
  openingFrame?: unknown[]
}

function transport(script: TransportScript = {}) {
  const sockets: FakeSocket[] = []
  const published: { event: NostrEvent; url: string }[] = []
  class FakeSocket {
    readonly url: string
    readyState = 0
    onopen: WebSocket['onopen'] = null
    onclose: WebSocket['onclose'] = null
    onerror: WebSocket['onerror'] = null
    onmessage: WebSocket['onmessage'] = null
    constructor(url: string) {
      this.url = url
      sockets.push(this)
      const connection = sockets.length
      void (async () => {
        await script.beforeOpen?.(connection)
        this.readyState = 1
        this.onopen?.call(this as unknown as WebSocket, new Event('open'))
        if (script.openingFrame) this.deliver(script.openingFrame)
      })()
    }
    deliver(frame: unknown[]) {
      this.onmessage?.call(
        this as unknown as WebSocket,
        new MessageEvent('message', { data: JSON.stringify(frame) }),
      )
    }
    send(raw: string) {
      const message = JSON.parse(raw)
      if (message[0] === 'REQ')
        void (async () => {
          await script.beforeEose?.()
          if (script.floodRead) for (let i = 0; i < 65; i++) this.deliver(['NOTICE', 'ignored'])
          if (script.failedReads?.includes(this.url))
            this.deliver(['CLOSED', message[1], 'private relay reason'])
          else {
            this.deliver(['EVENT', message[1], script.event ?? base])
            this.deliver(['EOSE', message[1]])
          }
        })()
      if (message[0] === 'EVENT')
        void (async () => {
          const event = message[1] as NostrEvent
          published.push({ event, url: this.url })
          await script.onPublish?.(event, this.url)
          if (script.floodPublish) for (let i = 0; i < 65; i++) this.deliver(['NOTICE', 'ignored'])
          const status = script.statuses?.[relays.indexOf(this.url)] ?? 'accepted'
          if (status !== 'unacknowledged')
            this.deliver(
              script.acknowledgment?.(event) ?? [
                'OK',
                event.id,
                status === 'accepted',
                'private relay reason',
              ],
            )
        })()
    }
    close() {
      this.readyState = 3
    }
  }
  return {
    sockets,
    published,
    websocketImplementation: FakeSocket as unknown as typeof WebSocket,
    publishTimeoutMs: 20,
    nowSeconds: () => 20,
  }
}

test('ACK, durable reload, and older relay replies preserve previous canonical and unrelated fields', async () => {
  const close = await fixture()
  try {
    const first = transport()
    const saved = await editNativeSignerProfile({ about: 'Retained bio' }, first)
    assert.equal(saved.status, 'saved')
    assert.equal(saved.published, true)
    assert.equal(saved.retained, true)
    assert.deepEqual(saved.acceptedRelays, relays)
    assert.ok(first.published.every(({ event }) => verifyEvent(event)))
    const reloaded = await withNativeProfileEditSession(base.pubkey, (session) => session.read())
    assert.equal(reloaded!.id, saved.eventId)
    const next = transport()
    const result = await editNativeSignerProfile({ name: 'Next', picture: '' }, next)
    assert.equal(result.status, 'saved')
    const sent = next.published[0]!.event
    assert.equal(sent.created_at, 21)
    assert.deepEqual(JSON.parse(sent.content), {
      name: 'Next',
      custom: { keep: true },
      display_name: 'Alias',
      about: 'Retained bio',
      picture: '',
    })
    assert.equal(JSON.stringify(result).includes('01'.repeat(32)), false)
  } finally {
    await close()
  }
})

test('partial ACK succeeds with accurate explicit rejection and uncertain destinations', async () => {
  const close = await fixture()
  try {
    for (const second of ['rejected', 'unacknowledged'] as const) {
      const io = transport({ statuses: ['accepted', second] })
      const result = await editNativeSignerProfile({ name: second }, io)
      assert.equal(result.status, 'saved')
      assert.deepEqual(result.acceptedRelays, [relays[0]])
      assert.deepEqual(result.rejectedRelays, second === 'rejected' ? [relays[1]] : [])
      assert.deepEqual(result.unacknowledgedRelays, second === 'unacknowledged' ? [relays[1]] : [])
      assert.ok(io.sockets.every((socket) => socket.readyState === 3))
    }
  } finally {
    await close()
  }
})

test('complete rejection and missing ACK never retain or claim publication', async () => {
  const close = await fixture()
  try {
    for (const status of ['rejected', 'unacknowledged'] as const) {
      const io = transport({ statuses: [status, status] })
      const result = await editNativeSignerProfile({ name: 'Retry' }, io)
      assert.equal(result.status, 'not-acknowledged')
      assert.equal(result.published, false)
      assert.equal(result.retained, false)
      assert.equal(
        await withNativeProfileEditSession(base.pubkey, (session) => session.read()),
        null,
      )
    }
  } finally {
    await close()
  }
})

test('incomplete and unusable newest reads refuse before signer invocation or publication', async () => {
  const close = await fixture()
  try {
    let signed = 0
    for (const script of [
      { failedReads: [relays[1]!] },
      { failedReads: relays },
      { event: finalizeEvent({ kind: 0, created_at: 99, tags: [], content: '{' }, key) },
    ]) {
      const io = transport(script)
      await assert.rejects(
        editNativeSignerProfile(
          { name: 'Retry' },
          {
            ...io,
            sign: async () => {
              signed += 1
              return base
            },
          },
        ),
        /completed|read failed|unusable/,
      )
      assert.equal(io.published.length, 0)
    }
    assert.equal(signed, 0)
  } finally {
    await close()
  }
})

test('signing refusal and altered signed output leave the draft unpublished', async () => {
  const close = await fixture()
  try {
    const io = transport()
    await assert.rejects(
      editNativeSignerProfile(
        { name: 'Draft' },
        {
          ...io,
          sign: async () => {
            throw new Error('Refused')
          },
        },
      ),
      /Refused/,
    )
    await assert.rejects(
      editNativeSignerProfile(
        { name: 'Draft' },
        { ...io, sign: async (template) => finalizeEvent({ ...template, content: '{}' }, key) },
      ),
      /signer/,
    )
    assert.equal(io.published.length, 0)
  } finally {
    await close()
  }
})

test('relay configuration changes after connection prevent the EVENT send', async () => {
  const close = await fixture()
  try {
    const io = transport({
      beforeOpen: async (connection) => {
        if (connection === 3)
          updateNativeConfig((config) => ({
            ...config,
            daemon: { ...config.daemon, nostrRelays: [] },
          }))
      },
    })
    const result = await editNativeSignerProfile({ name: 'Draft' }, io)
    assert.equal(result.status, 'selection-changed')
    assert.equal(io.published.length, 0)
    assert.equal(result.published, false)
  } finally {
    await close()
  }
})

test('A/B/A signer changes during read invalidate the captured revision', async () => {
  const close = await fixture()
  try {
    let changed = false
    const io = transport({
      beforeEose: async () => {
        if (changed) return
        changed = true
        await replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: '04'.repeat(32) })
        await replaceDaemonSigner({ expectedRevision: 1, nostrSecretKeyHex: '01'.repeat(32) })
      },
    })
    await assert.rejects(editNativeSignerProfile({ name: 'Draft' }, io), /settings changed/)
    assert.equal((await readSelectedDaemonSigner()).publicKeyHex, base.pubkey)
    assert.equal(io.published.length, 0)
  } finally {
    await close()
  }
})

test('ACK after identity changes retains the exact original event and fences later destinations', async () => {
  const close = await fixture()
  try {
    const io = transport({
      onPublish: async (_, url) => {
        if (url === relays[0])
          await replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: '04'.repeat(32) })
      },
    })
    const result = await editNativeSignerProfile(
      { name: 'Original owner' },
      { ...io, publishTimeoutMs: 2_000 },
    )
    assert.equal(result.status, 'selection-changed')
    assert.equal(result.retained, true)
    assert.equal(result.published, true)
    assert.equal(io.published.length, 1)
    assert.deepEqual(result.acceptedRelays, [relays[0]])
    assert.deepEqual(result.unacknowledgedRelays, [])
    assert.deepEqual(result.unsentRelays, [relays[1]])
    const retained = await withNativeProfileEditSession(base.pubkey, (session) => session.read())
    assert.equal(retained!.id, result.eventId)
    assert.equal(retained!.pubkey, base.pubkey)
  } finally {
    await close()
  }
})

test('cache failure after an ACK reports publication and retention failure separately', async () => {
  const close = await fixture()
  try {
    const io = transport()
    const result = await editNativeSignerProfile(
      { name: 'Published' },
      {
        ...io,
        withSession: (owner, action, options) =>
          withNativeProfileEditSession(
            owner,
            (session) =>
              action({
                read: session.read,
                retain: async () => {
                  throw new Error('private disk reason')
                },
              }),
            options,
          ),
      },
    )
    assert.equal(result.status, 'published-retention-failed')
    assert.equal(result.published, true)
    assert.equal(result.retained, false)
    assert.deepEqual(result.acceptedRelays, relays)
    assert.equal(await withNativeProfileEditSession(base.pubkey, (session) => session.read()), null)
    assert.equal(JSON.stringify(result).includes('private disk reason'), false)
  } finally {
    await close()
  }
})

test('public profile editing succeeds while the daemon run lock is active', async () => {
  const close = await fixture()
  const lock = await acquireDaemonRunLock()
  try {
    const result = await editNativeSignerProfile({ name: 'Daemon stays active' }, transport())
    assert.equal(result.status, 'saved')
    assert.equal(result.retained, true)
  } finally {
    await lock.release()
    await close()
  }
})

test('malformed OK and unsolicited pre-send OK cannot fabricate acceptance', async () => {
  const close = await fixture()
  try {
    const malformed = transport({ acknowledgment: (event) => ['OK', event.id, true, '', 'extra'] })
    const uncertain = await editNativeSignerProfile({ name: 'New' }, malformed)
    assert.equal(uncertain.status, 'not-acknowledged')
    assert.deepEqual(uncertain.unacknowledgedRelays, relays)
    const expected = finalizeEvent(
      prepareNostrProfileEdit(base.pubkey, base, { name: 'New' }, 20),
      key,
    )
    const unsolicited = transport({
      openingFrame: ['OK', expected.id, true, ''],
      statuses: ['rejected', 'rejected'],
    })
    const rejected = await editNativeSignerProfile({ name: 'New' }, unsolicited)
    assert.equal(rejected.status, 'not-acknowledged')
    assert.deepEqual(rejected.rejectedRelays, relays)
    assert.deepEqual(rejected.acceptedRelays, [])
    assert.equal(await withNativeProfileEditSession(base.pubkey, (session) => session.read()), null)
  } finally {
    await close()
  }
})

test('profile frame floods refuse reads and cannot fabricate a later accepted ACK', async () => {
  const cleanup = await fixture()
  try {
    const read = transport({ floodRead: true })
    await assert.rejects(editNativeSignerProfile({ name: 'Draft' }, read), /read failed/)
    assert.equal(read.published.length, 0)
    const saved = await editNativeSignerProfile(
      { name: 'Draft' },
      transport({ floodPublish: true }),
    )
    assert.equal(saved.status, 'not-acknowledged')
    assert.equal(saved.published, false)
    assert.equal(saved.retained, false)
    assert.deepEqual(saved.acceptedRelays, [])
    assert.deepEqual(saved.unacknowledgedRelays, relays)
  } finally {
    await cleanup()
  }
})
