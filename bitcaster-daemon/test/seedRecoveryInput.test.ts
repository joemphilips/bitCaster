import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { readRecoverySeedInput } from '../src/emergencySeedRecovery.ts'

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const EXPECTED_SEED =
  '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'

test('daemon seed input accepts a private checksum-valid phrase file and derives its seed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-recovery-phrase-'))
  try {
    const path = join(directory, 'phrase.txt')
    await writeFile(path, `${PHRASE}\n`, { mode: 0o600 })
    assert.equal(await readRecoverySeedInput({ recoveryPhraseFile: path }), EXPECTED_SEED)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('daemon seed input rejects invalid, ambiguous, nonprivate, and linked phrase files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bitcaster-daemon-recovery-phrase-'))
  try {
    const path = join(directory, 'phrase.txt')
    await writeFile(path, `${PHRASE.replace(/about$/, 'abandon')}\n`, { mode: 0o600 })
    await assert.rejects(
      readRecoverySeedInput({ recoveryPhraseFile: path }),
      /valid English BIP-39/,
    )
    await assert.rejects(readRecoverySeedInput({}), /exactly one of/)
    await assert.rejects(
      readRecoverySeedInput({ walletSeedHexFile: path, recoveryPhraseFile: path }),
      /exactly one of/,
    )

    await writeFile(path, `${PHRASE}\n`, { mode: 0o600 })
    await chmod(path, 0o640)
    await assert.rejects(
      readRecoverySeedInput({ recoveryPhraseFile: path }),
      /group or other users/,
    )
    await chmod(path, 0o600)
    const linkPath = join(directory, 'phrase-link.txt')
    await symlink(path, linkPath)
    await assert.rejects(readRecoverySeedInput({ recoveryPhraseFile: linkPath }), /ELOOP|symbolic/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
