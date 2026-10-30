import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ownedRecoveryCommand } from './fixtures/ownedRecoveryCommand.ts'

test(
  'recovery command drains child and grandchild on timeout and overflow',
  { timeout: 15_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'recovery-command-'))
    try {
      for (const mode of ['timeout', 'overflow']) {
        const signal = join(directory, mode)
        const grandchild = `
        const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(signal)}, JSON.stringify([process.ppid, process.pid]));
        ${mode === 'overflow' ? "process.stdout.write('x'.repeat(8192));" : ''}
        setInterval(() => {}, 1000);
      `
        const child = `
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}],
          {stdio: ['ignore', 'inherit', 'inherit']});
        setInterval(() => {}, 1000);
      `
        // This real deadline is the behavior under test. The grandchild writes its
        // explicit start record before overflow, and must exist for timeout proof.
        await assert.rejects(
          ownedRecoveryCommand(process.execPath, ['-e', child], directory, 1000, 1024),
        )
        const pids = JSON.parse(await readFile(signal, 'utf8')) as number[]
        assert.equal(pids.length, 2)
        for (const pid of pids) {
          assert.throws(
            () => process.kill(pid, 0),
            (error: NodeJS.ErrnoException) => error.code === 'ESRCH',
          )
        }
      }
      assert.equal(
        await ownedRecoveryCommand(
          process.execPath,
          ['-e', "process.stdout.write('ok')"],
          directory,
          1000,
        ),
        'ok',
      )
      await assert.rejects(
        ownedRecoveryCommand(process.execPath, ['-e', 'process.exit(9)'], directory, 1000),
      )
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  },
)
