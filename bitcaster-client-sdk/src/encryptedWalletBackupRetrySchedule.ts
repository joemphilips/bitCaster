import { sha256 } from '@noble/hashes/sha2.js'

/** V2 scheduler limit. It is independent from the removed V1 CAS state. */
export const ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX = 32 as const

export const ENCRYPTED_WALLET_BACKUP_RETRY_BASE_MILLISECONDS = 5_000 as const
export const ENCRYPTED_WALLET_BACKUP_RETRY_MAX_MILLISECONDS = 3_600_000 as const
export function planEncryptedWalletBackupRetry(input: {
  realm: string
  walletId: string
  attemptId: string
  currentStreak: number
  minimumDelayMilliseconds: number
}): Readonly<{ streak: number; delayMilliseconds: number }> {
  if (
    typeof input.realm !== 'string' ||
    !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/.test(input.realm)
  )
    throw new Error('backup retry realm is invalid')
  if (!/^[0-9a-f]{64}$/.test(input.walletId) || !/^[0-9a-f]{32}$/.test(input.attemptId))
    throw new Error('backup retry identity is invalid')
  if (
    !Number.isSafeInteger(input.currentStreak) ||
    input.currentStreak < 0 ||
    input.currentStreak > ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX
  )
    throw new Error('backup retry streak is invalid')
  if (
    !Number.isSafeInteger(input.minimumDelayMilliseconds) ||
    input.minimumDelayMilliseconds < 1 ||
    input.minimumDelayMilliseconds > ENCRYPTED_WALLET_BACKUP_RETRY_MAX_MILLISECONDS
  )
    throw new Error('backup retry minimum delay is invalid')
  const streak = Math.min(input.currentStreak + 1, ENCRYPTED_WALLET_BACKUP_RETRY_STREAK_MAX)
  const exponent = Math.min(streak - 1, 10)
  const exponential = Math.min(
    ENCRYPTED_WALLET_BACKUP_RETRY_MAX_MILLISECONDS,
    ENCRYPTED_WALLET_BACKUP_RETRY_BASE_MILLISECONDS * 2 ** exponent,
  )
  const base = Math.max(exponential, input.minimumDelayMilliseconds)
  const jitterRoom = Math.min(
    Math.floor(base / 5),
    ENCRYPTED_WALLET_BACKUP_RETRY_MAX_MILLISECONDS - base,
  )
  const digest = sha256(
    new TextEncoder().encode(
      `bitcaster/encrypted-wallet-backup-retry/v1\0${input.realm}\0${input.walletId}\0${input.attemptId}\0${streak}`,
    ),
  )
  const sample =
    (((digest[0]! << 24) >>> 0) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0
  const jitter = jitterRoom === 0 ? 0 : sample % (jitterRoom + 1)
  return Object.freeze({ streak, delayMilliseconds: base + jitter })
}
