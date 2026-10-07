import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, chmod, writeFile, symlink, mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { finalizeEvent } from 'nostr-tools/pure'
import { withNativeProfileEditSession } from '../src/nativeProfileCache.ts'
import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { NOSTR_PROFILE_CACHE_DIRECTORY, validateDaemonProfileSchema } from '../src/profileSchema.ts'
import { getFinalProfileSchemaManifest } from '../src/profileSchemaManifest.ts'

const event = (time: number, identity = 1) =>
  finalizeEvent(
    { kind: 0, created_at: time, tags: [], content: '{"name":"Alice","custom":{"keep":true}}' },
    new Uint8Array(32).fill(identity),
  )
const first = event(10)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bc-profile-cache-'))
  const directory = join(root, 'profile')
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: '02'.repeat(64),
    nostrSecretKeyHex: '01'.repeat(32),
    nativeOracleNonceSeedHex: '03'.repeat(32),
    passphrase: 'test-only-password',
  })
  return { directory, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test('native profile cache round trip retains newest per identity and remains an admissible profile', async () => {
  const f = await fixture()
  try {
    await withNativeProfileEditSession(
      first.pubkey,
      async (session) => {
        assert.equal(await session.read(), null)
        await session.retain(event(20))
        await session.retain(first)
      },
      f,
    )
    const other = event(15, 2)
    await withNativeProfileEditSession(other.pubkey, (session) => session.retain(other), f)
    await withNativeProfileEditSession(
      first.pubkey,
      async (session) => {
        assert.equal((await session.read())?.id, event(20).id)
      },
      f,
    )
    await withNativeProfileEditSession(
      other.pubkey,
      async (session) => {
        assert.equal((await session.read())?.id, other.id)
      },
      f,
    )
    await validateDaemonProfileSchema(f.directory, getFinalProfileSchemaManifest())
  } finally {
    await f.cleanup()
  }
})

test('native cache refuses corrupt, wrong-owner, oversized, and linked records without replacing them', async () => {
  const f = await fixture()
  try {
    await withNativeProfileEditSession(first.pubkey, (session) => session.retain(first), f)
    const path = join(f.directory, NOSTR_PROFILE_CACHE_DIRECTORY, `${first.pubkey}.json`)
    for (const bytes of ['{', JSON.stringify(event(12, 2)), 'x'.repeat(131_073)]) {
      await writeFile(path, bytes, { mode: 0o600 })
      await assert.rejects(
        withNativeProfileEditSession(first.pubkey, (session) => session.retain(event(20)), f),
      )
      assert.ok((await readFile(path, 'utf8')) === bytes, 'Refused record must remain unchanged.')
    }
    await rm(path)
    const target = join(f.directory, NOSTR_PROFILE_CACHE_DIRECTORY, 'target.json')
    await writeFile(target, JSON.stringify(first), { mode: 0o600 })
    await symlink(target, path)
    await assert.rejects(withNativeProfileEditSession(first.pubkey, (session) => session.read(), f))
    await rm(path)
    execFileSync('mkfifo', [path], { stdio: 'ignore' })
    await chmod(path, 0o600)
    await assert.rejects(
      withNativeProfileEditSession(first.pubkey, (session) => session.read(), f),
      /ownership or permissions/,
    )
  } finally {
    await f.cleanup()
  }
})

test('profile admission rejects a nonprivate or symlinked public cache directory', async () => {
  const f = await fixture()
  try {
    const path = join(f.directory, NOSTR_PROFILE_CACHE_DIRECTORY)
    await mkdir(path, { mode: 0o700 })
    await chmod(path, 0o755)
    await assert.rejects(validateDaemonProfileSchema(f.directory, getFinalProfileSchemaManifest()))
    await rm(path, { recursive: true })
    const target = join(f.directory, 'unused-target')
    await symlink(target, path)
    await assert.rejects(validateDaemonProfileSchema(f.directory, getFinalProfileSchemaManifest()))
  } finally {
    await f.cleanup()
  }
})

const childSource = `
import { withNativeProfileEditSession } from './bitcaster-daemon/src/nativeProfileCache.ts';
import { finalizeEvent } from 'nostr-tools/pure';
import files from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const [directory, pubkey, mode] = process.argv.slice(1);
if (mode === 'interrupt-write') {
  files.rename = async () => { process.stdout.write('READY\\n'); await new Promise(() => {}); };
  syncBuiltinESMExports();
}
const keepAlive = setInterval(() => {}, 1000);
await withNativeProfileEditSession(pubkey, async session => {
  if (mode === 'interrupt-write') {
    await session.retain(finalizeEvent({kind:0,created_at:30,tags:[],content:'{"name":"New"}'},new Uint8Array(32).fill(1)));
  } else {
    process.stdout.write('READY\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
  }
}, {directory});
clearInterval(keepAlive);
`

async function childHolding(directory: string, mode: string) {
  const child = spawn(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      childSource,
      directory,
      first.pubkey,
      mode,
    ],
    {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  const exited = once(child, 'exit')
  let output = ''
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (bytes) => {
      output += bytes
      if (output.includes('READY\n')) resolve()
    })
    child.once('error', reject)
    child.once('exit', () =>
      reject(new Error('Owned profile-cache child exited before readiness.')),
    )
  })
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Owned profile-cache child readiness timed out.')),
          10_000,
        ).unref(),
      ),
    ])
  } catch (error) {
    child.kill('SIGKILL')
    await exited
    throw error
  }
  return {
    child,
    exited,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
    },
  }
}

test(
  'two processes serialize a full edit and recover the lock after owner death',
  { timeout: 25_000 },
  async () => {
    const f = await fixture()
    let holder: Awaited<ReturnType<typeof childHolding>> | undefined
    try {
      holder = await childHolding(f.directory, 'hold')
      let ran = false
      await assert.rejects(
        withNativeProfileEditSession(
          first.pubkey,
          async () => {
            ran = true
          },
          { ...f, lockTimeoutMs: 50 },
        ),
        /Another Nostr profile edit/,
      )
      assert.equal(ran, false)
      await holder.stop()
      await withNativeProfileEditSession(first.pubkey, (session) => session.retain(first), f)
      await withNativeProfileEditSession(
        first.pubkey,
        async (session) => assert.equal((await session.read())?.id, first.id),
        f,
      )
    } finally {
      await holder?.stop()
      await f.cleanup()
    }
  },
)

test(
  'process death before atomic rename preserves prior record and normal profile admission',
  { timeout: 25_000 },
  async () => {
    const f = await fixture()
    let holder: Awaited<ReturnType<typeof childHolding>> | undefined
    try {
      await withNativeProfileEditSession(first.pubkey, (session) => session.retain(first), f)
      holder = await childHolding(f.directory, 'interrupt-write')
      await holder.stop()
      await withNativeProfileEditSession(
        first.pubkey,
        async (session) => assert.equal((await session.read())?.id, first.id),
        f,
      )
      await withNativeProfileEditSession(first.pubkey, (session) => session.retain(event(40)), f)
      await assert.rejects(
        readFile(join(f.directory, NOSTR_PROFILE_CACHE_DIRECTORY, `${first.pubkey}.tmp`)),
        { code: 'ENOENT' },
      )
      await withNativeProfileEditSession(
        first.pubkey,
        async (session) => assert.equal((await session.read())?.id, event(40).id),
        f,
      )
      await validateDaemonProfileSchema(f.directory, getFinalProfileSchemaManifest())
    } finally {
      await holder?.stop()
      await f.cleanup()
    }
  },
)
