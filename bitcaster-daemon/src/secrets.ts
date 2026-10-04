import { createECDH, randomBytes } from 'node:crypto'
import { isMissingDaemonProfileError, profileDatabasePath, profileDir } from './profile.ts'
import { readBootstrappedProfileSecrets, readProfileSecretAuthority } from './profileBootstrap.ts'
import { openDaemonStateSqlite, createDaemonStateSqliteSession } from './stateSqlite.ts'
import { withProfileStorageAccess } from './profileAccess.ts'
import { acquireDaemonRunLock } from './runLock.ts'
import {
  normalizeInitialProfileSecrets,
  protectInitialProfileSecrets,
} from './profileSecretProtection.ts'
import type { DatabaseSync } from 'node:sqlite'

export interface SelectedDaemonSigner {
  readonly publicKeyHex: string
  readonly enabled: boolean
  readonly revision: number
}

export class DaemonSignerEditError extends Error {
  readonly reason: 'stale-edit' | 'unfinished-account-work'
  constructor(reason: DaemonSignerEditError['reason']) {
    super(
      reason === 'stale-edit'
        ? 'Selected signer changed; read it again before editing.'
        : 'Finish pending account-bound work before replacing the signer.',
    )
    this.reason = reason
  }
}

export async function readSelectedDaemonSigner(): Promise<SelectedDaemonSigner> {
  return createDaemonStateSqliteSession(profileDir()).read(readSelectedSignerRow)
}

export function disconnectDaemonSigner(expectedRevision: number): Promise<SelectedDaemonSigner> {
  return editDaemonSigner({ expectedRevision, enabled: false })
}

export function reconnectDaemonSigner(expectedRevision: number): Promise<SelectedDaemonSigner> {
  return editDaemonSigner({ expectedRevision, enabled: true })
}

export function replaceDaemonSigner(input: {
  readonly expectedRevision: number
  readonly nostrSecretKeyHex: string
  readonly injectFault?: (phase: 'before-protection' | 'before-commit') => void
}): Promise<SelectedDaemonSigner> {
  return editDaemonSigner(input)
}

async function editDaemonSigner(input: {
  readonly expectedRevision: number
  readonly enabled?: boolean
  readonly nostrSecretKeyHex?: string
  readonly injectFault?: (phase: 'before-protection' | 'before-commit') => void
}): Promise<SelectedDaemonSigner> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0)
    throw new DaemonSignerEditError('stale-edit')
  const lock = await acquireDaemonRunLock()
  try {
    return await createDaemonStateSqliteSession(profileDir()).transaction(
      (database) => {
        const current = readSelectedSignerRow(database)
        if (
          current.revision !== input.expectedRevision ||
          current.revision === Number.MAX_SAFE_INTEGER
        )
          throw new DaemonSignerEditError('stale-edit')
        if (input.nostrSecretKeyHex !== undefined) {
          replaceSignerAuthority(database, input.nostrSecretKeyHex, input.injectFault)
        }
        // Replacement does not silently reconnect a disconnected identity.
        database
          .prepare(
            'UPDATE daemon_profile SET signer_enabled=?,signer_revision=signer_revision+1 WHERE singleton=1',
          )
          .run(input.enabled === undefined ? Number(current.enabled) : Number(input.enabled))
        return readSelectedSignerRow(database)
      },
      {
        injectFault: (phase) => {
          if (phase === 'before-commit') input.injectFault?.(phase)
        },
      },
    )
  } finally {
    await lock.release()
  }
}

function replaceSignerAuthority(
  database: DatabaseSync,
  nostrSecretKeyHex: string,
  injectFault?: (phase: 'before-protection' | 'before-commit') => void,
): void {
  const old = readProfileSecretAuthority(database, daemonPassphrase())
  const next = normalizeInitialProfileSecrets({
    ...old,
    nostrSecretKeyHex: nostrSecretKeyHex,
    nostrPublicKeyHex: undefined,
  })
  if (next.nostrPublicKeyHex !== old.nostrPublicKeyHex) assertSignerReplacementRecoverable(database)
  injectFault?.('before-protection')
  const scope = (
    database.prepare('SELECT wallet_scope_id AS scope FROM daemon_profile').get() as {
      scope: string
    }
  ).scope
  const protectedBody = protectInitialProfileSecrets(next, scope, daemonPassphrase())
  database
    .prepare(
      `UPDATE daemon_secret_authority SET nostr_public_key_hex=?,protection=?,kdf=?,salt=?,iv=?,auth_tag=?,secret_body=? WHERE singleton=1`,
    )
    .run(
      next.nostrPublicKeyHex,
      protectedBody.protection,
      protectedBody.kdf,
      protectedBody.salt,
      protectedBody.iv,
      protectedBody.authTag,
      protectedBody.body,
    )
  database
    .prepare('UPDATE daemon_profile SET nostr_public_key_hex=? WHERE singleton=1')
    .run(next.nostrPublicKeyHex)
}

function readSelectedSignerRow(database: DatabaseSync): SelectedDaemonSigner {
  const row = database
    .prepare(
      'SELECT nostr_public_key_hex AS publicKeyHex,signer_enabled AS enabled,signer_revision AS revision FROM daemon_profile WHERE singleton=1',
    )
    .get() as { publicKeyHex: string; enabled: number; revision: number } | undefined
  if (row === undefined || ![0, 1].includes(row.enabled))
    throw new Error('Selected signer authority is invalid.')
  return { ...row, enabled: row.enabled === 1 }
}

function assertSignerReplacementRecoverable(database: DatabaseSync): void {
  if (hasUnfinishedAccountWork(database)) throw new DaemonSignerEditError('unfinished-account-work')
}

export async function hasUnfinishedDaemonAccountWork(): Promise<boolean> {
  return createDaemonStateSqliteSession(profileDir()).read(hasUnfinishedAccountWork)
}

function hasUnfinishedAccountWork(database: DatabaseSync): boolean {
  const active = database
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM daemon_ctf_range_preparations
        WHERE scope_id=(SELECT wallet_scope_id FROM daemon_profile WHERE singleton=1)
        AND lifecycle_state <> 'terminal')
    OR EXISTS(SELECT 1 FROM daemon_outgoing_cashu_transfers
      WHERE scope_id=(SELECT wallet_scope_id FROM daemon_profile WHERE singleton=1)
      AND delivery_policy='durable-recipient-ack'
      AND delivery_state IN ('prepared','delivery-pending')) AS active`,
    )
    .get() as { active: number }
  return active.active !== 0
}

export interface DaemonSecrets {
  walletSeedHex: string
  nostrSecretKeyHex: string
  nostrPublicKeyHex: string
  nativeOracleNonceSeedHex: string
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
    nativeOracleNonceSeedHex: randomBytes(32).toString('hex'),
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
