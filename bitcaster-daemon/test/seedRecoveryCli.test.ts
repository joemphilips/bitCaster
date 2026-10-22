import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const run = promisify(execFile)

test('daemon recovery flags refuse unapproved condition before any profile or phrase access', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-cli-'))
  try {
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const base = [
      '--experimental-strip-types',
      join(import.meta.dirname, '../src/main.ts'),
      '--datadir',
      directory,
      'recover-seed',
      '--wallet-seed-hex-file',
      join(directory, 'absent-phrase'),
      '--recovery-id',
      'condition-refusal',
      '--mint',
      'https://mint.example',
      '--acknowledge-seed-disclosure',
      '--condition-id',
      'ab'.repeat(32),
    ]
    for (const extra of [[], ['--gap-limit', '701']]) {
      await assert.rejects(
        run(process.execPath, [...base, ...extra], { env, timeout: 5_000, maxBuffer: 16_384 }),
        (error) =>
          error instanceof Error &&
          /condition recovery requires approved mint discovery filter/.test(
            String((error as { stderr?: string }).stderr),
          ),
      )
      assert.deepEqual(await readdir(directory), [])
    }
    for (const gap of ['0', '-1', '1.5', '01', '2147483649']) {
      await assert.rejects(
        run(process.execPath, [...base, '--gap-limit', gap], {
          env,
          timeout: 5_000,
          maxBuffer: 16_384,
        }),
        (error) =>
          error instanceof Error &&
          /gap limit|scan policy/.test(String((error as { stderr?: string }).stderr)),
      )
      assert.deepEqual(await readdir(directory), [])
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
