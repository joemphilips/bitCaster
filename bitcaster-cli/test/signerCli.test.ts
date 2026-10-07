import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile, stat, symlink, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { nsecEncode } from 'nostr-tools/nip19'
import { encrypt } from 'nostr-tools/nip49'
import {
  bootstrapFreshDaemonProfile,
  readBootstrappedProfileSecrets,
} from '../../bitcaster-daemon/src/profileBootstrap.ts'

const execute = promisify(execFile)
const seed = '11'.repeat(64)
const oldSecret = '22'.repeat(32)
const nonceSeed = '33'.repeat(32)
const privateKey = new Uint8Array(32)
privateKey[31] = 1
const newHex = `${'0'.repeat(63)}1`
const newPubkey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const noNetwork =
  'data:text/javascript,' +
  encodeURIComponent("globalThis.fetch=()=>{throw Error('Signer command attempted network I/O')}")

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bitcaster-signer-cli-'))
  const directory = join(root, 'profile')
  await bootstrapFreshDaemonProfile({
    directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: seed,
    nostrSecretKeyHex: oldSecret,
    nativeOracleNonceSeedHex: nonceSeed,
  })
  const run = (args: string[]) =>
    execute(
      process.execPath,
      [
        '--experimental-strip-types',
        '--import',
        noNetwork,
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
  return { root, directory, run, close: () => rm(root, { recursive: true, force: true }) }
}

function assertRedacted(output: string, values: string[] = []) {
  for (const secret of [seed, oldSecret, nonceSeed, newHex, nsecEncode(privateKey), ...values]) {
    assert.equal(output.includes(secret), false, 'Signer command exposed private input')
  }
}

function failed(outputPattern: RegExp, privateValues: string[] = []) {
  return (error: unknown) => {
    const result = error as { code: number; stdout: string; stderr: string }
    assert.equal(result.code, 1)
    assert.match(result.stdout + result.stderr, outputPattern)
    assertRedacted(result.stdout + result.stderr, privateValues)
    return true
  }
}

test('actual signer status, disconnect and reconnect preserve wallet authority and refuse a stale revision', async () => {
  const f = await fixture()
  try {
    const initial = JSON.parse((await f.run(['signer', 'show'])).stdout)
    assert.deepEqual(Object.keys(initial).sort(), ['enabled', 'publicKeyHex', 'revision'])
    assert.equal(initial.enabled, true)
    assert.equal(initial.revision, 0)
    const disconnected = JSON.parse(
      (await f.run(['signer', 'disconnect', '--expected-revision', '0'])).stdout,
    )
    assert.deepEqual(disconnected, { ...initial, enabled: false, revision: 1 })
    await assert.rejects(
      f.run(['signer', 'connect', '--expected-revision', '0']),
      failed(/Selected signer changed/),
    )
    const connected = JSON.parse(
      (await f.run(['signer', 'connect', '--expected-revision', '1'])).stdout,
    )
    assert.deepEqual(connected, { ...initial, enabled: true, revision: 2 })
    const retained = await readBootstrappedProfileSecrets(f.directory)
    assert.equal(retained!.walletSeedHex, seed)
    assert.equal(retained!.nativeOracleNonceSeedHex, nonceSeed)
    assert.equal(retained!.nostrSecretKeyHex, oldSecret)
    assertRedacted(JSON.stringify([initial, disconnected, connected]))
  } finally {
    await f.close()
  }
})

for (const format of ['nsec', 'hex', 'ncryptsec'] as const) {
  test(`actual signer import accepts ${format}, preserves custody identity, and exports only to a private new file`, async () => {
    const f = await fixture()
    try {
      const keyFile = join(f.root, 'key')
      const passwordFile = join(f.root, 'password')
      const passphrase = ' key password '
      const inputs = {
        nsec: nsecEncode(privateKey),
        hex: newHex,
        ncryptsec: encrypt(privateKey, passphrase, 4),
      }
      await writeFile(keyFile, inputs[format], { mode: 0o600 })
      await writeFile(passwordFile, `${passphrase}\n`, { mode: 0o600 })
      const command = ['signer', 'import', '--key-file', keyFile, '--expected-revision', '0']
      if (format === 'ncryptsec') command.push('--key-passphrase-file', passwordFile)
      const result = await f.run(command)
      assert.deepEqual(JSON.parse(result.stdout), {
        publicKeyHex: newPubkey,
        enabled: true,
        revision: 1,
      })
      assertRedacted(result.stdout + result.stderr, [inputs[format], passphrase])
      const retained = await readBootstrappedProfileSecrets(f.directory)
      assert.equal(retained!.walletSeedHex, seed)
      assert.equal(retained!.nativeOracleNonceSeedHex, nonceSeed)
      assert.equal(retained!.nostrSecretKeyHex, newHex)
      const outputFile = join(f.root, 'export.nsec')
      const exported = await f.run(['signer', 'export', '--output-file', outputFile])
      assert.deepEqual(JSON.parse(exported.stdout), { publicKeyHex: newPubkey, exported: true })
      assert.equal(await readFile(outputFile, 'utf8'), `${nsecEncode(privateKey)}\n`)
      assert.equal((await stat(outputFile)).mode & 0o777, 0o600)
      assertRedacted(exported.stdout + exported.stderr)
      await assert.rejects(
        f.run(['signer', 'export', '--output-file', outputFile]),
        failed(/Use a new private file path/),
      )
      assert.equal(await readFile(outputFile, 'utf8'), `${nsecEncode(privateKey)}\n`)
    } finally {
      await f.close()
    }
  })
}

test('actual signer import refuses insecure, linked, malformed and oversized inputs without changing the signer', async () => {
  const f = await fixture()
  try {
    const baseline = (await f.run(['signer', 'show'])).stdout
    const valid = join(f.root, 'valid')
    const link = join(f.root, 'link')
    const publicFile = join(f.root, 'public')
    const invalidFile = join(f.root, 'invalid')
    const oversize = join(f.root, 'oversize')
    const malformed = 'fixture-invalid-private-value'
    await writeFile(valid, newHex, { mode: 0o600 })
    await symlink(valid, link)
    await writeFile(publicFile, newHex, { mode: 0o644 })
    await chmod(publicFile, 0o644)
    await writeFile(invalidFile, malformed, { mode: 0o600 })
    await writeFile(oversize, 'x'.repeat(513), { mode: 0o600 })
    for (const path of [link, publicFile, invalidFile, oversize]) {
      await assert.rejects(
        f.run(['signer', 'import', '--key-file', path, '--expected-revision', '0']),
        failed(/Private input|Private Nostr key/, [malformed]),
      )
      assert.equal((await f.run(['signer', 'show'])).stdout, baseline)
    }
  } finally {
    await f.close()
  }
})

test('actual signer dry run leaves authority and output destinations untouched, while generation creates only public output', async () => {
  const f = await fixture()
  try {
    const baseline = (await f.run(['signer', 'show'])).stdout
    const keyFile = join(f.root, 'key')
    await writeFile(keyFile, newHex, { mode: 0o600 })
    const outputFile = join(f.root, 'not-exported')
    for (const args of [
      ['import', '--key-file', keyFile, '--expected-revision', '0'],
      ['generate', '--expected-revision', '0'],
      ['disconnect', '--expected-revision', '0'],
      ['export', '--output-file', outputFile],
    ]) {
      const result = await f.run(['--dry-run', 'signer', ...args])
      assert.equal(JSON.parse(result.stdout).dryRun, true)
      assertRedacted(result.stdout + result.stderr)
    }
    assert.equal((await f.run(['signer', 'show'])).stdout, baseline)
    await assert.rejects(stat(outputFile), { code: 'ENOENT' })
    const generated = await f.run(['signer', 'generate', '--expected-revision', '0'])
    const status = JSON.parse(generated.stdout)
    assert.deepEqual(Object.keys(status).sort(), ['enabled', 'publicKeyHex', 'revision'])
    assert.match(status.publicKeyHex, /^[0-9a-f]{64}$/)
    assert.equal(status.revision, 1)
    assert.notEqual(status.publicKeyHex, JSON.parse(baseline).publicKeyHex)
    assertRedacted(generated.stdout + generated.stderr)
  } finally {
    await f.close()
  }
})
