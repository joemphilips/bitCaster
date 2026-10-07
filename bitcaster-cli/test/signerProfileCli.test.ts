import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { finalizeEvent } from 'nostr-tools/pure'
import { bootstrapFreshDaemonProfile } from '../../bitcaster-daemon/src/profileBootstrap.ts'
import { updateNativeConfig } from '../../bitcaster-daemon/src/nativeConfig.ts'

const execute = promisify(execFile)
const secret = '01'.repeat(32)
const seed = '02'.repeat(64)
const nonce = '03'.repeat(32)
const profile = finalizeEvent(
  {
    kind: 0,
    created_at: 10,
    tags: [],
    content:
      '{"display_name":"Public display","about":"Public bio","nip05":"name@example.test","privateKey":"ignored"}',
  },
  new Uint8Array(32).fill(1),
)
const selectedRelays = ['wss://selected.example/Exact?Case=Yes']

async function fixture(relays = selectedRelays) {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-profile-cli-'))
  const directory = join(root, 'profile')
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: seed,
    nostrSecretKeyHex: secret,
    nativeOracleNonceSeedHex: nonce,
    passphrase: 'test-only-password',
  })
  const priorHome = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    updateNativeConfig((config) => ({
      ...config,
      daemon: { ...config.daemon, nostrRelays: relays },
    }))
  } finally {
    if (priorHome === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = priorHome
  }
  const run = (args: string[], mode: 'found' | 'missing' | 'forbidden' = 'found') => {
    const preload = `
      const profile=${JSON.stringify(profile)};
      const selected=${JSON.stringify(relays)};
      const mode=${JSON.stringify(mode)};
      globalThis.fetch=()=>{throw Error('Profile command attempted HTTP I/O')};
      globalThis.WebSocket=class {
        readyState=0; onopen=null; onclose=null; onerror=null; onmessage=null;
        constructor(url){
          if(mode==='forbidden'||!selected.includes(url))throw Error('Unexpected profile socket');
          queueMicrotask(()=>{this.readyState=1;this.onopen?.(new Event('open'))});
        }
        send(raw){
          const message=JSON.parse(raw);
          if(message[0]==='CLOSE')return;
          if(message[0]!=='REQ'||JSON.stringify(message[2])!==JSON.stringify({kinds:[0],authors:[profile.pubkey],limit:1}))
            throw Error('Profile command used the wrong public identity or filter');
          queueMicrotask(()=>{
            if(mode==='found')this.onmessage?.(new MessageEvent('message',{data:JSON.stringify(['EVENT',message[1],profile])}));
            this.onmessage?.(new MessageEvent('message',{data:JSON.stringify(['EOSE',message[1]])}));
          });
        }
        close(){this.readyState=3}
      };
    `
    return execute(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        'data:text/javascript,' + encodeURIComponent(preload),
        join(import.meta.dirname, '../src/main.ts'),
        '--datadir',
        directory,
        ...args,
      ],
      {
        env: { ...process.env, NODE_NO_WARNINGS: '1', BITCASTER_DAEMON_PASSPHRASE: '' },
        timeout: 10_000,
        maxBuffer: 128 * 1024,
      },
    )
  }
  return { run, close: () => rm(root, { recursive: true, force: true }) }
}

function redacted(value: string) {
  for (const privateValue of [secret, seed, nonce, 'test-only-password'])
    assert.equal(value.includes(privateValue), false, 'Profile command exposed private authority')
}

test('actual signer profile entry reads and refreshes only public selected identity metadata without a passphrase', async () => {
  const f = await fixture()
  try {
    const before = (await f.run(['signer', 'show'], 'forbidden')).stdout
    const read = await f.run(['signer', 'profile'])
    const result = JSON.parse(read.stdout)
    assert.deepEqual(result.signer, JSON.parse(before))
    assert.equal(result.status, 'found')
    assert.deepEqual(Object.keys(result).sort(), [
      'completedRelayCount',
      'failedRelayCount',
      'profile',
      'signer',
      'status',
    ])
    assert.deepEqual(result.profile, {
      pubkey: profile.pubkey,
      displayName: 'Public display',
      avatar: '',
      nip05: 'name@example.test',
      nip05verified: false,
      bio: 'Public bio',
      eventId: profile.id,
      createdAt: 10,
    })
    redacted(read.stdout + read.stderr)
    assert.equal((await f.run(['signer', 'show'], 'forbidden')).stdout, before)
    const fresh = JSON.parse((await f.run(['signer', 'profile'], 'missing')).stdout)
    assert.equal(fresh.status, 'not-found')
    assert.equal(fresh.profile, null)
  } finally {
    await f.close()
  }
})

test('actual profile help states fresh relay reads, and dry run makes no network request', async () => {
  const f = await fixture()
  try {
    assert.match(
      (await f.run(['signer', 'profile', '--help'], 'forbidden')).stdout,
      /selected relays[\s\S]*No stored\s+cache/,
    )
    const result = await f.run(['--dry-run', 'signer', 'profile'], 'forbidden')
    assert.deepEqual(JSON.parse(result.stdout), { action: 'profile', dryRun: true })
    redacted(result.stdout + result.stderr)
  } finally {
    await f.close()
  }
})

test('actual profile command refuses explicit empty relays rather than connecting to defaults', async () => {
  const f = await fixture([])
  try {
    await assert.rejects(f.run(['signer', 'profile'], 'forbidden'), (error) => {
      const failure = error as { code: number; stdout: string; stderr: string }
      assert.equal(failure.code, 1)
      assert.match(failure.stderr, /Configure a Nostr relay/)
      redacted(failure.stdout + failure.stderr)
      return true
    })
  } finally {
    await f.close()
  }
})

test('actual profile command refuses disconnected signer and preserves offline public status', async () => {
  const f = await fixture()
  try {
    const saved = (await f.run(['signer', 'disconnect', '--expected-revision', '0'], 'forbidden'))
      .stdout
    await assert.rejects(f.run(['signer', 'profile'], 'forbidden'), (error) => {
      const failure = error as { code: number; stdout: string; stderr: string }
      assert.equal(failure.code, 1)
      assert.match(failure.stderr, /Signer is disconnected.*Connect/)
      redacted(failure.stdout + failure.stderr)
      return true
    })
    assert.equal((await f.run(['signer', 'show'], 'forbidden')).stdout, saved)
  } finally {
    await f.close()
  }
})
