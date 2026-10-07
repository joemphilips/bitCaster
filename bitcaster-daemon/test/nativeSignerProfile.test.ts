import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finalizeEvent } from 'nostr-tools/pure'
import { readNativeSignerProfile } from '../src/nativeSignerProfile.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { updateNativeConfig } from '../src/nativeConfig.ts'
import {
  readSelectedDaemonSigner,
  disconnectDaemonSigner,
  replaceDaemonSigner,
} from '../src/secrets.ts'

const secret = '01'.repeat(32)
const profileEvent = finalizeEvent(
  { kind: 0, created_at: 10, tags: [], content: '{"name":"Selected"}' },
  new Uint8Array(32).fill(1),
)
const selectedRelays = ['wss://first.example/Exact?Case=Yes', 'wss://second.example']

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-signer-profile-'))
  const prior = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = join(root, 'profile')
  await bootstrapFreshDaemonProfile({
    directory: process.env.BITCASTER_DAEMON_HOME,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '02'.repeat(64),
    nostrSecretKeyHex: secret,
    nativeOracleNonceSeedHex: '03'.repeat(32),
    passphrase: 'test-only-profile-password',
  })
  updateNativeConfig((current) => ({
    ...current,
    daemon: { ...current.daemon, nostrRelays: selectedRelays },
  }))
  return async () => {
    if (prior === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = prior
    await rm(root, { recursive: true, force: true })
  }
}

function transport(
  mode: 'found' | 'missing' | 'closed' | 'timeout' = 'found',
  beforeEose?: () => Promise<void>,
) {
  const sockets: FakeSocket[] = []
  class FakeSocket {
    readonly url: string
    readyState = 0
    onopen: WebSocket['onopen'] = null
    onclose: WebSocket['onclose'] = null
    onerror: WebSocket['onerror'] = null
    onmessage: WebSocket['onmessage'] = null
    closeCount = 0
    sent: unknown[][] = []
    constructor(url: string) {
      this.url = url
      sockets.push(this)
      queueMicrotask(() => {
        this.readyState = 1
        this.onopen?.call(this as unknown as WebSocket, new Event('open'))
      })
    }
    send(raw: string) {
      const message = JSON.parse(raw)
      this.sent.push(message)
      if (message[0] !== 'REQ') return
      void (async () => {
        await beforeEose?.()
        const deliver = (data: unknown) =>
          this.onmessage?.call(
            this as unknown as WebSocket,
            new MessageEvent('message', { data: JSON.stringify(data) }),
          )
        if (mode === 'found') deliver(['EVENT', message[1], profileEvent])
        if (mode === 'closed') deliver(['CLOSED', message[1], 'untrusted private text'])
        else if (mode !== 'timeout') deliver(['EOSE', message[1]])
      })()
    }
    close() {
      this.closeCount += 1
      this.readyState = 3
    }
  }
  return { sockets, websocketImplementation: FakeSocket as unknown as typeof WebSocket }
}

test('profile read uses exact current relays and selected public signer without unlocking protected secrets', async () => {
  const close = await fixture()
  const io = transport()
  try {
    const before = await readSelectedDaemonSigner()
    const result = await readNativeSignerProfile(io)
    assert.deepEqual(result.signer, before)
    assert.equal(result.profile!.pubkey, before.publicKeyHex)
    assert.equal(result.profile!.displayName, 'Selected')
    assert.deepEqual(
      io.sockets.map((socket) => socket.url),
      selectedRelays,
    )
    for (const socket of io.sockets) {
      assert.deepEqual(socket.sent[0]![2], { kinds: [0], authors: [before.publicKeyHex], limit: 1 })
      assert.equal(socket.closeCount, 1)
      assert.equal(socket.onmessage, null)
    }
    assert.deepEqual(await readSelectedDaemonSigner(), before)
    assert.equal(JSON.stringify(result).includes(secret), false)
  } finally {
    await close()
  }
})

test('empty relay selection refuses before creating a socket', async () => {
  const close = await fixture()
  const io = transport()
  try {
    updateNativeConfig((current) => ({
      ...current,
      daemon: { ...current.daemon, nostrRelays: [] },
    }))
    await assert.rejects(readNativeSignerProfile(io), /Configure a Nostr relay/)
    assert.equal(io.sockets.length, 0)
  } finally {
    await close()
  }
})

test('disconnected signer refuses before network I/O and keeps the saved public selection', async () => {
  const close = await fixture()
  const io = transport()
  try {
    const saved = await disconnectDaemonSigner(0)
    await assert.rejects(readNativeSignerProfile(io), /Signer is disconnected.*Connect/)
    assert.equal(io.sockets.length, 0)
    assert.deepEqual(await readSelectedDaemonSigner(), saved)
  } finally {
    await close()
  }
})

for (const mode of ['missing', 'closed'] as const)
  test(`relay ${mode} produces an honest terminal result and releases sockets`, async () => {
    const close = await fixture()
    const io = transport(mode)
    try {
      if (mode === 'missing') {
        const result = await readNativeSignerProfile(io)
        assert.equal(result.status, 'not-found')
        assert.equal(result.profile, null)
      } else
        await assert.rejects(readNativeSignerProfile(io), {
          message: 'Nostr profile read failed. Check the configured relays and retry.',
        })
      assert.ok(io.sockets.every((socket) => socket.closeCount === 1 && socket.onmessage === null))
    } finally {
      await close()
    }
  })

test('the owned deadline refuses a missing EOSE instead of treating a synthetic EOSE as not-found', async (t) => {
  const close = await fixture()
  const io = transport('timeout')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const pending = readNativeSignerProfile(io)
    const rejected = assert.rejects(pending, /Check the configured relays/)
    for (
      let turn = 0;
      turn < 100 &&
      (io.sockets.length !== 2 || io.sockets.some((socket) => socket.sent.length === 0));
      turn += 1
    )
      await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(io.sockets.length, 2)
    assert.ok(io.sockets.every((socket) => socket.sent.length > 0))
    t.mock.timers.tick(8_000)
    await rejected
    assert.ok(io.sockets.every((socket) => socket.closeCount === 1 && socket.onmessage === null))
  } finally {
    await close()
  }
})

test('relay selection changed during a read refuses stale display metadata', async () => {
  const close = await fixture()
  const io = transport('found', async () => {
    updateNativeConfig((current) => ({
      ...current,
      daemon: { ...current.daemon, nostrRelays: [] },
    }))
  })
  try {
    await assert.rejects(readNativeSignerProfile(io), /settings changed.*Retry/)
  } finally {
    await close()
  }
})

test('signer replacement during a read refuses outgoing identity metadata', async () => {
  const close = await fixture()
  const priorPassword = process.env.BITCASTER_DAEMON_PASSPHRASE
  process.env.BITCASTER_DAEMON_PASSPHRASE = 'test-only-profile-password'
  let changed = false
  const io = transport('found', async () => {
    if (changed) return
    changed = true
    await replaceDaemonSigner({ expectedRevision: 0, nostrSecretKeyHex: '04'.repeat(32) })
  })
  try {
    await assert.rejects(readNativeSignerProfile(io), /Signer or relay settings changed/)
  } finally {
    if (priorPassword === undefined) delete process.env.BITCASTER_DAEMON_PASSPHRASE
    else process.env.BITCASTER_DAEMON_PASSPHRASE = priorPassword
    await close()
  }
})
