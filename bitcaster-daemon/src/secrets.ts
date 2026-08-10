import { createECDH, randomBytes } from 'node:crypto'
import { isMissingDaemonProfileError, profileDatabasePath, profileDir } from './profile.ts'
import { readBootstrappedProfileSecrets } from './profileBootstrap.ts'
import { openDaemonStateSqlite } from './stateSqlite.ts'
import { withProfileStorageAccess } from './profileAccess.ts'

export interface DaemonSecrets {
  walletSeedHex: string
  nostrSecretKeyHex: string
  nostrPublicKeyHex: string
  createdAt: string
}

export function secretsPath(): string {
  return profileDatabasePath()
}

export function createDaemonSecrets(now = new Date().toISOString()): DaemonSecrets {
  const nostr = createECDH('secp256k1')
  nostr.generateKeys()
  return createDaemonSecretsFromImport(
    {
      walletSeedHex: randomBytes(64).toString('hex'),
      nostrSecretKeyHex: nostr.getPrivateKey('hex'),
    },
    now,
  )
}

export function createDaemonSecretsFromImport(
  input: { walletSeedHex: string; nostrSecretKeyHex: string },
  now = new Date().toISOString(),
): DaemonSecrets {
  const walletSeedHex = normalizeWalletSeedHex(input.walletSeedHex)
  const nostrSecretKeyHex = normalizePrivateKeyHex(input.nostrSecretKeyHex)
  const nostr = createECDH('secp256k1')
  try {
    nostr.setPrivateKey(Buffer.from(nostrSecretKeyHex, 'hex'))
  } catch {
    throw new Error('nostr secret key is not a valid secp256k1 private key')
  }
  return {
    walletSeedHex,
    nostrSecretKeyHex,
    nostrPublicKeyHex: nostr.getPublicKey(undefined, 'compressed').subarray(1).toString('hex'),
    createdAt: normalizeIsoTime(now),
  }
}

export async function ensureSecrets(): Promise<DaemonSecrets> {
  const secrets = await readSecrets()
  if (secrets === null) {
    throw new Error('daemon secrets are not initialized; run bitcaster-daemon init')
  }
  return secrets
}

export async function readSecrets(): Promise<DaemonSecrets | null> {
  return withProfileStorageAccess(async () => {
    try {
      const identity = await readBootstrappedProfileSecrets(profileDir(), daemonPassphrase())
      return {
        ...identity,
        createdAt: (await readCreatedAt()).toISOString(),
      }
    } catch (error) {
      if (await isMissingDaemonProfileError(error)) return null
      throw error
    }
  })
}

export async function assertDaemonStorageBindings(): Promise<void> {
  await ensureSecrets()
}

export async function writeSecrets(_secrets: DaemonSecrets): Promise<void> {
  throw new Error('daemon identity secrets are immutable after fresh atomic init')
}

async function readCreatedAt(): Promise<Date> {
  const database = await openDaemonStateSqlite(profileDir())
  try {
    const row = database
      .prepare(
        'SELECT created_at_ms AS createdAtMs FROM daemon_secret_authority WHERE singleton = 1',
      )
      .get() as { createdAtMs: number }
    return new Date(row.createdAtMs)
  } finally {
    database.close()
  }
}

function daemonPassphrase(): string | undefined {
  return process.env.BITCASTER_DAEMON_PASSPHRASE || undefined
}

function normalizeWalletSeedHex(value: string): string {
  if (!/^[0-9a-f]{128}$/.test(value)) {
    throw new Error('wallet seed must be exactly 64 bytes of hex')
  }
  return value
}

function normalizePrivateKeyHex(value: string): string {
  if (!/^[0-9a-f]+$/i.test(value)) {
    throw new Error('secp256k1 private key must be hex encoded')
  }
  if (value.length > 64) {
    throw new Error('secp256k1 private key is longer than 32 bytes')
  }
  return value.padStart(64, '0').toLowerCase()
}

function normalizeIsoTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new Error('daemon secret time is invalid')
  return new Date(timestamp).toISOString()
}
