import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RequestFn } from '@cashu/cashu-ts'
import { DEFAULT_PUBLIC_NOSTR_RELAYS } from '@bitcaster-market/client-sdk/nostrRelays'
import {
  activeNativeConfig,
  createNativeConfig,
  defaultNativeConfig,
  freezeNativeConfigAtStartup,
  readNativeConfig,
} from '../src/nativeConfig.ts'
import {
  addNativeMint,
  addNativeRelay,
  listNativeMints,
  listNativeRelays,
  removeNativeMint,
  removeNativeRelay,
  selectNativeMint,
} from '../src/nativeSettings.ts'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
} from '../src/profileBootstrap.ts'
import { createNativeOracleCreationStore } from '../src/nativeOracleCreationStore.ts'

const FIRST = 'http://localhost:8085'
const SECOND = 'https://second.example'
const THIRD = 'https://third.example'
const RELAY = 'wss://relay.example/Case?Key=Value'

test('saved mint list is offline; add and select validate through shared metadata transport', async () => {
  await withDirectory(async (directory) => {
    let reads = 0
    const request = metadataRequest(() => {
      reads += 1
    })
    const options = { directory, request }
    assert.deepEqual(listNativeMints(options).mintUrls, [FIRST])
    assert.equal(reads, 0)
    await addNativeMint(`${SECOND}/`, options)
    await addNativeMint(SECOND, options)
    assert.equal(reads, 6)
    assert.deepEqual(listNativeMints(options).mintUrls, [FIRST, SECOND])
    assert.equal(listNativeMints(options).selectedMintUrl, SECOND)
    await selectNativeMint(`${FIRST}/`, options)
    assert.equal(reads, 9)
    assert.equal(listNativeMints(options).selectedMintUrl, FIRST)
    const offline = listNativeMints({
      directory,
      request: async () => {
        throw new Error('offline')
      },
    })
    assert.deepEqual(offline.mintUrls, [FIRST, SECOND])
    offline.mintUrls.push(THIRD)
    assert.deepEqual(listNativeMints(options).mintUrls, [FIRST, SECOND])
  })
})

test('mint removal keeps selection or selects the first remaining mint; final removal is refused', async () => {
  await withDirectory(async (directory) => {
    const options = { directory, request: metadataRequest() }
    await addNativeMint(SECOND, options)
    await addNativeMint(THIRD, options)
    removeNativeMint(SECOND, options)
    assert.equal(listNativeMints(options).selectedMintUrl, THIRD)
    removeNativeMint(THIRD, options)
    assert.deepEqual(listNativeMints(options).mintUrls, [FIRST])
    assert.equal(listNativeMints(options).selectedMintUrl, FIRST)
    const before = await readFile(join(directory, 'config.json'), 'utf8')
    assert.throws(() => removeNativeMint(FIRST, options), /final mint/)
    assert.throws(() => removeNativeMint(SECOND, options), /not in the saved list/)
    assert.equal(await readFile(join(directory, 'config.json'), 'utf8'), before)
  })
})

test('invalid mint URL, unsupported metadata, unknown selection, and read failure do not write', async () => {
  await withDirectory(async (directory) => {
    const initial = createNativeConfig(defaultNativeConfig(), directory)
    let reads = 0
    const request = metadataRequest(() => {
      reads += 1
    })
    await assert.rejects(addNativeMint('invalid', { directory, request }), /Invalid mint URL/)
    await assert.rejects(selectNativeMint(SECOND, { directory, request }), /not in the saved list/)
    assert.equal(reads, 0)
    await assert.rejects(
      addNativeMint(SECOND, { directory, request: metadataRequest(undefined, 'sat') }),
      /active regular.*msat/,
    )
    for (const fields of [
      { condition_id: 'condition' },
      { conditional: {} },
      { active: false },
      { active: 'true' },
      { id: `02${'ab'.repeat(32)}` },
    ]) {
      await assert.rejects(
        addNativeMint(SECOND, { directory, request: metadataRequest(undefined, 'msat', fields) }),
        /active regular.*msat/,
      )
    }
    await assert.rejects(
      addNativeMint(SECOND, {
        directory,
        request: async () => {
          throw new Error('offline')
        },
      }),
      /offline/,
    )
    assert.equal(readNativeConfig(false, directory).revision, initial.revision)
  })
})

test('mint validation refuses stale writes after another settings edit', async () => {
  await withDirectory(async (directory) => {
    const initial = createNativeConfig(defaultNativeConfig(), directory)
    let edited = false
    const request = metadataRequest(() => {
      if (edited) return
      edited = true
      addNativeRelay(RELAY, { directory })
    })
    await assert.rejects(addNativeMint(SECOND, { directory, request }), /changed before write/)
    assert.deepEqual(listNativeMints({ directory }).mintUrls, [FIRST])
    assert.ok(listNativeRelays({ directory }).nostrRelays.includes(RELAY))
    let reads = 0
    await assert.rejects(
      addNativeMint(SECOND, {
        directory,
        expectedRevision: initial.revision,
        request: metadataRequest(() => {
          reads += 1
        }),
      }),
      /changed before write/,
    )
    assert.equal(reads, 0)
    assert.throws(
      () => removeNativeRelay(RELAY, { directory, expectedRevision: initial.revision }),
      /changed before write/,
    )
  })
})

test('relay settings normalize duplicates and preserve an explicit empty list through restart', async () => {
  await withDirectory(async (directory) => {
    const options = { directory }
    assert.deepEqual(listNativeRelays(options).nostrRelays, [...DEFAULT_PUBLIC_NOSTR_RELAYS])
    createNativeConfig(defaultNativeConfig(), directory)
    for (const relay of DEFAULT_PUBLIC_NOSTR_RELAYS) removeNativeRelay(relay, options)
    assert.deepEqual(listNativeRelays(options).nostrRelays, [])
    addNativeRelay('wss://RELAY.example/Case?Key=Value', options)
    addNativeRelay(RELAY, options)
    assert.deepEqual(listNativeRelays(options).nostrRelays, [RELAY])
    for (const invalid of [
      'https://relay.example',
      'ws://remote.example',
      'wss://u:p@relay.example',
      `${RELAY}#x`,
    ]) {
      assert.throws(() => addNativeRelay(invalid, options))
    }
    removeNativeRelay(RELAY, options)
    assert.deepEqual(readNativeConfig(false, directory).config.daemon.nostrRelays, [])
    const restarted = await import(
      new URL('../src/nativeConfig.ts?relay-restart', import.meta.url).href
    )
    assert.deepEqual(restarted.freezeNativeConfigAtStartup().config.daemon.nostrRelays, [])
  })
})

test('settings change only next-start destinations and preserve saved recovery records', async () => {
  await withDirectory(async (directory) => {
    await bootstrapFreshDaemonProfile({
      directory: join(directory, 'profile'),
      engineBaseUrl: 'https://engine.example',
      mintUrl: SECOND,
      walletSeedHex: '11'.repeat(64),
      nostrSecretKeyHex: '22'.repeat(32),
      nativeOracleNonceSeedHex: '33'.repeat(32),
    })
    const home = join(directory, 'profile')
    const prior = process.env.BITCASTER_DAEMON_HOME
    process.env.BITCASTER_DAEMON_HOME = home
    try {
      const store = createNativeOracleCreationStore(home)
      const canonicalInput = JSON.stringify({
        mintUrl: SECOND,
        engineBaseUrl: 'https://engine.example',
        relays: [RELAY],
      })
      const saved = await store.reserveCreation({
        creationId: 'saved',
        eventId: 'event-saved',
        canonicalInput,
      })
      assert.equal(activeNativeConfig().config.daemon.mintUrl, SECOND)
      const live = freezeNativeConfigAtStartup()
      const options = { directory: home, request: metadataRequest() }
      await addNativeMint(THIRD, options)
      removeNativeMint(SECOND, options)
      for (const relay of listNativeRelays(options).nostrRelays) removeNativeRelay(relay, options)
      assert.equal(activeNativeConfig().revision, live.revision)
      assert.equal(activeNativeConfig().config.daemon.mintUrl, SECOND)
      assert.deepEqual(activeNativeConfig().config.daemon.nostrRelays, [
        ...DEFAULT_PUBLIC_NOSTR_RELAYS,
      ])
      assert.equal(listNativeMints(options).selectedMintUrl, THIRD)
      assert.deepEqual(listNativeRelays(options).nostrRelays, [])
      const reopened = await createNativeOracleCreationStore(home).readCreation('saved')
      assert.equal(reopened?.canonicalInput, saved.canonicalInput)
      assert.equal(reopened?.nonceIndex, saved.nonceIndex)
      assert.equal((await readBootstrappedProfileSecrets(home)).walletSeedHex, '11'.repeat(64))
      const restarted = await import(
        new URL('../src/nativeConfig.ts?mint-restart', import.meta.url).href
      )
      assert.equal(restarted.activeNativeConfig().config.daemon.mintUrl, THIRD)
      assert.equal(restarted.freezeNativeConfigAtStartup().config.daemon.mintUrl, THIRD)
      assert.deepEqual(restarted.activeNativeConfig().config.daemon.nostrRelays, [])
    } finally {
      if (prior === undefined) delete process.env.BITCASTER_DAEMON_HOME
      else process.env.BITCASTER_DAEMON_HOME = prior
    }
  })
})

function metadataRequest(
  onRead?: () => void,
  unit = 'msat',
  fields: Record<string, unknown> = {},
): RequestFn {
  return async <T>({ endpoint }: Parameters<RequestFn>[0]) => {
    onRead?.()
    const keyset = { id: `01${'ab'.repeat(32)}`, unit, active: true, input_fee_ppk: 0, ...fields }
    if (endpoint.endsWith('/v1/keysets')) return { keysets: [keyset] } as T
    if (endpoint.endsWith('/v1/keys'))
      return { keysets: [{ ...keyset, keys: { '1': 'key' } }] } as T
    assert.ok(endpoint.endsWith('/v1/info'))
    return {
      name: 'Mint',
      pubkey: 'ab'.repeat(32),
      version: '2.0',
      contact: [],
      nuts: {
        '4': { methods: [], disabled: false },
        '5': { methods: [], disabled: false },
      },
    } as T
  }
}

async function withDirectory(action: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'native-settings-'))
  await chmod(directory, 0o700)
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    await action(directory)
  } finally {
    if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previous
    await rm(directory, { recursive: true, force: true })
  }
}
