import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chown, chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readOwnerPrivateRecoveryPhraseFile } from '../src/seedRecoveryPhraseFile.ts'

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

test('owner phrase reader accepts the current owner private regular file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-phrase-file-'))
  try {
    const path = join(directory, 'phrase.txt')
    await writeFile(path, `${PHRASE}\n`, { mode: 0o600 })
    assert.equal(await readOwnerPrivateRecoveryPhraseFile(path), `${PHRASE}\n`)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('owner phrase reader rejects symlinks, nonprivate mode, invalid UTF-8, and oversized files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-phrase-file-'))
  try {
    const path = join(directory, 'phrase.txt')
    await writeFile(path, `${PHRASE}\n`, { mode: 0o600 })
    const link = join(directory, 'phrase-link.txt')
    await symlink(path, link)
    await assert.rejects(readOwnerPrivateRecoveryPhraseFile(link), /ELOOP|symbolic/)

    await chmod(path, 0o640)
    await assert.rejects(readOwnerPrivateRecoveryPhraseFile(path), /group or other users/)
    await chmod(path, 0o600)

    await writeFile(path, Buffer.from([0xff]), { mode: 0o600 })
    await assert.rejects(readOwnerPrivateRecoveryPhraseFile(path), /valid UTF-8/)

    await writeFile(path, Buffer.alloc(1_025, 0x61), { mode: 0o600 })
    await assert.rejects(readOwnerPrivateRecoveryPhraseFile(path), /exceeds 1024 bytes/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('owner phrase reader rejects a FIFO without waiting for a writer', async (t) => {
  if (process.platform === 'win32') return t.skip('FIFO is not supported on Windows')
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-phrase-fifo-'))
  try {
    const path = join(directory, 'phrase.pipe')
    try {
      execFileSync('mkfifo', [path])
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOENT') {
        return t.skip('the test environment cannot create a FIFO')
      }
      throw error
    }
    await assert.rejects(readOwnerPrivateRecoveryPhraseFile(path), /regular file/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('owner phrase reader rejects files owned by a different uid when chown is available', async (t) => {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    return t.skip('POSIX file ownership is not available')
  }
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-recovery-phrase-owner-'))
  try {
    const path = join(directory, 'phrase.txt')
    await writeFile(path, `${PHRASE}\n`, { mode: 0o600 })
    try {
      await chown(path, process.getuid() + 1, process.getgid())
    } catch {
      return t.skip('the test process cannot change file ownership')
    }
    await assert.rejects(readOwnerPrivateRecoveryPhraseFile(path), /owned by the current user/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
