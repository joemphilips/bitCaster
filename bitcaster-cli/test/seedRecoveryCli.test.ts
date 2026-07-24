import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('recover-seed accepts only acknowledged owner-private seed-file input', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bitcaster-cli-recovery-'))
  try {
    const seedPath = join(home, 'wallet-seed.hex')
    const seed = 'ab'.repeat(32)
    await writeFile(seedPath, `${seed}\n`, { mode: 0o600 })
    const result = await runCli(home, [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      seedPath,
      '--recovery-id',
      'recovery-1',
      '--mint',
      'https://mint.example',
      '--unit',
      'sat',
      '--keyset-id',
      'keyset-1',
      '--acknowledge-seed-disclosure',
    ])
    assert.equal(result.code, 0)
    assert.match(result.stdout, /"recoveryId": "recovery-1"/)
    assert.doesNotMatch(result.stdout, /walletSeedHex/)
    assert.doesNotMatch(result.stdout, new RegExp(seed))

    const noAcknowledgement = await runCli(home, [
      '--dry-run',
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      seedPath,
      '--recovery-id',
      'recovery-2',
      '--mint',
      'https://mint.example',
      '--unit',
      'sat',
      '--keyset-id',
      'keyset-1',
    ])
    assert.notEqual(noAcknowledgement.code, 0)
    assert.match(noAcknowledgement.stderr, /acknowledge-seed-disclosure/)

    await chmod(seedPath, 0o640)
    const readable = await recoveryCli(home, seedPath)
    assert.notEqual(readable.code, 0)
    assert.match(readable.stderr, /group or other users/)

    await chmod(seedPath, 0o600)
    const linkPath = join(home, 'wallet-seed-link.hex')
    await symlink(seedPath, linkPath)
    const linked = await recoveryCli(home, linkPath)
    assert.notEqual(linked.code, 0)
    assert.match(linked.stderr, /ELOOP|symbolic/i)

    const argvSecret = await runCli(home, [
      'wallet',
      'recover-seed',
      '--wallet-seed-hex-file',
      seedPath,
      '--recovery-id',
      'recovery-argv-rejected',
      '--mint',
      'https://mint.example',
      '--unit',
      'sat',
      '--keyset-id',
      'keyset-1',
      '--acknowledge-seed-disclosure',
      '--wallet-seed-hex',
      seed,
    ])
    assert.notEqual(argvSecret.code, 0)
    const argvOutput = `${argvSecret.stdout}\n${argvSecret.stderr}`
    assert.match(argvOutput, /unknown option/)
    assert.doesNotMatch(argvOutput, new RegExp(seed))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

async function recoveryCli(home: string, seedPath: string) {
  return runCli(home, [
    '--dry-run',
    'wallet',
    'recover-seed',
    '--wallet-seed-hex-file',
    seedPath,
    '--recovery-id',
    'recovery-private',
    '--mint',
    'https://mint.example',
    '--unit',
    'sat',
    '--keyset-id',
    'keyset-1',
    '--acknowledge-seed-disclosure',
  ])
}

async function runCli(
  home: string,
  args: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const childEnv = { ...process.env, HOME: home }
  delete childEnv.NODE_TEST_CONTEXT
  const stdoutPath = join(home, `stdout-${Date.now()}-${Math.random()}`)
  const stderrPath = join(home, `stderr-${Date.now()}-${Math.random()}`)
  const stdoutFile = await open(stdoutPath, 'wx', 0o600)
  const stderrFile = await open(stderrPath, 'wx', 0o600)
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', join(import.meta.dirname, '..', 'src', 'main.ts'), ...args],
    {
      cwd: join(import.meta.dirname, '..'),
      env: childEnv,
      stdio: ['ignore', stdoutFile.fd, stderrFile.fd],
    },
  )
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (exitCode) => resolve(exitCode ?? 1))
  })
  await Promise.all([stdoutFile.close(), stderrFile.close()])
  const [stdout, stderr] = await Promise.all([
    readFile(stdoutPath, 'utf8'),
    readFile(stderrPath, 'utf8'),
  ])
  return { code, stdout, stderr }
}
