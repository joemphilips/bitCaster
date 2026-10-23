import { constants } from 'node:fs'
import { open } from 'node:fs/promises'

const MAX_RECOVERY_PHRASE_FILE_BYTES = 1_024

/** Read one bounded owner-only phrase file without following links or blocking on special files. */
export async function readOwnerPrivateRecoveryPhraseFile(path: string): Promise<string> {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new Error(
      '--recovery-phrase-file is not supported on this platform until owner ACL validation is available',
    )
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) throw new Error('--recovery-phrase-file must name a regular file')
    if (metadata.uid !== process.getuid()) {
      throw new Error('--recovery-phrase-file must be owned by the current user')
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error('--recovery-phrase-file must not be accessible by group or other users')
    }
    if (metadata.size > MAX_RECOVERY_PHRASE_FILE_BYTES) {
      throw new Error(`--recovery-phrase-file exceeds ${MAX_RECOVERY_PHRASE_FILE_BYTES} bytes`)
    }
    const bytes = Buffer.allocUnsafe(MAX_RECOVERY_PHRASE_FILE_BYTES + 1)
    let total = 0
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > MAX_RECOVERY_PHRASE_FILE_BYTES) {
      throw new Error(`--recovery-phrase-file exceeds ${MAX_RECOVERY_PHRASE_FILE_BYTES} bytes`)
    }
    let phrase: string
    try {
      phrase = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total))
    } catch {
      throw new Error('--recovery-phrase-file must contain valid UTF-8')
    }
    return phrase
  } finally {
    await file.close()
  }
}
