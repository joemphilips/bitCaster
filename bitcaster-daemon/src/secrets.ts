import { createECDH, randomBytes } from 'node:crypto'
import {
  generateOrderEphemeralKeypair,
  normalizeSecp256k1PrivateKeyHex,
  type OrderEphemeralKeypair,
} from './ephemeralKey.ts'
import { isMissingDaemonProfileError, profileDatabasePath, profileDir } from './profile.ts'
import { readBootstrappedProfileSecrets } from './profileBootstrap.ts'
import {
  protectTargetEphemeralPrivateKey,
  unlockTargetEphemeralPrivateKey,
  type ProtectedSecretBody,
} from './profileSecretProtection.ts'
import { withDaemonStateSqliteTransaction } from './stateSqlite.ts'
import { openDaemonStateSqlite } from './stateSqlite.ts'
import { withProfileStorageAccess } from './profileAccess.ts'

export interface DaemonSecrets {
  walletSeedHex: string
  nostrSecretKeyHex: string
  nostrPublicKeyHex: string
  orderEphemeralKeys: Record<string, OrderEphemeralSecret>
  createdAt: string
}

export type DaemonIdentitySecrets = Omit<DaemonSecrets, 'orderEphemeralKeys'>

export interface OrderEphemeralSecret {
  orderId: string
  tradeId?: string
  marketId: string
  privateKeyHex: string
  publicKeyHex: string
  createdAt: string
}

export function secretsPath(): string {
  return profileDatabasePath()
}

let secretsUpdateQueue: Promise<unknown> = Promise.resolve()

async function withSecretsUpdateLock<T>(run: () => Promise<T>): Promise<T> {
  const next = secretsUpdateQueue.then(run, run)
  secretsUpdateQueue = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

export function createDaemonSecrets(now = new Date().toISOString()): DaemonSecrets {
  const nostr = createECDH('secp256k1')
  nostr.generateKeys()
  return createDaemonSecretsFromImport(
    {
      walletSeedHex: randomBytes(32).toString('hex'),
      nostrSecretKeyHex: nostr.getPrivateKey('hex'),
    },
    now,
  )
}

export function createDaemonSecretsFromImport(
  input: { walletSeedHex: string; nostrSecretKeyHex: string },
  now = new Date().toISOString(),
): DaemonSecrets {
  const walletSeedHex = normalizeHexSecret(input.walletSeedHex, 'wallet seed')
  const nostrSecretKeyHex = normalizeSecp256k1PrivateKeyHex(input.nostrSecretKeyHex)
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
    orderEphemeralKeys: {},
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

export async function readIdentitySecrets(): Promise<DaemonIdentitySecrets | null> {
  return withProfileStorageAccess(readIdentitySecretsUnlocked)
}

async function readIdentitySecretsUnlocked(): Promise<DaemonIdentitySecrets | null> {
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
}

export async function readSecrets(): Promise<DaemonSecrets | null> {
  return withProfileStorageAccess(async () => {
    const identity = await readIdentitySecretsUnlocked()
    if (identity === null) return null
    const database = await openDaemonStateSqlite(profileDir())
    try {
      const rows = database
        .prepare(
          `SELECT key_id AS keyId, scope_id AS scopeId, order_id AS orderId,
            trade_id AS tradeId, market_id AS marketId,
            public_key_hex AS publicKeyHex, protection, kdf, salt, iv,
            auth_tag AS authTag, private_key_body AS body,
            created_at_ms AS createdAtMs
           FROM target_ephemeral_keys ORDER BY key_id`,
        )
        .all() as unknown as EphemeralRow[]
      const orderEphemeralKeys: Record<string, OrderEphemeralSecret> = {}
      for (const row of rows) {
        orderEphemeralKeys[row.keyId] = decodeEphemeralRow(row)
      }
      return { ...identity, orderEphemeralKeys }
    } finally {
      database.close()
    }
  })
}

export async function readOrderEphemeralSecret(
  keyId: string,
): Promise<OrderEphemeralSecret | null> {
  const secrets = await readSecrets()
  return secrets?.orderEphemeralKeys[keyId] ?? null
}

export async function assertDaemonStorageBindings(): Promise<void> {
  await ensureSecrets()
}

export async function writeSecrets(_secrets: DaemonSecrets): Promise<void> {
  throw new Error('daemon identity secrets are immutable after fresh atomic init')
}

export async function updateSecrets<T>(
  update: (secrets: DaemonSecrets, now: string) => T,
): Promise<T> {
  return withSecretsUpdateLock(async () => {
    const current = await ensureSecrets()
    const next = structuredClone(current)
    const now = new Date().toISOString()
    const result = update(next, now)
    assertIdentityUnchanged(current, next)
    await persistNewEphemeralKeys(current, next)
    return result
  })
}

export async function getOrCreateOrderEphemeralKeypair(input: {
  keyId: string
  orderId: string
  tradeId?: string
  marketId: string
}): Promise<OrderEphemeralKeypair> {
  const existing = await readOrderEphemeralSecret(input.keyId)
  if (existing !== null) {
    return {
      privateKeyHex: existing.privateKeyHex,
      publicKeyHex: existing.publicKeyHex,
    }
  }
  const created = generateOrderEphemeralKeypair()
  return updateSecrets((secrets, now): OrderEphemeralKeypair => {
    const winner = secrets.orderEphemeralKeys[input.keyId]
    if (winner !== undefined) {
      return {
        privateKeyHex: winner.privateKeyHex,
        publicKeyHex: winner.publicKeyHex,
      }
    }
    secrets.orderEphemeralKeys[input.keyId] = {
      orderId: input.orderId,
      ...(input.tradeId === undefined ? {} : { tradeId: input.tradeId }),
      marketId: input.marketId,
      ...created,
      createdAt: now,
    }
    return created
  })
}

async function persistNewEphemeralKeys(current: DaemonSecrets, next: DaemonSecrets): Promise<void> {
  const additions = Object.entries(next.orderEphemeralKeys).filter(
    ([keyId]) => current.orderEphemeralKeys[keyId] === undefined,
  )
  for (const [keyId, existing] of Object.entries(current.orderEphemeralKeys)) {
    const replacement = next.orderEphemeralKeys[keyId]
    if (replacement === undefined || JSON.stringify(existing) !== JSON.stringify(replacement)) {
      throw new Error('daemon ephemeral key authority is immutable')
    }
  }
  if (additions.length === 0) return
  await withDaemonStateSqliteTransaction(profileDir(), (database) => {
    for (const [keyId, key] of additions) {
      const protectedKey = protectTargetEphemeralPrivateKey(
        key.privateKeyHex,
        {
          walletScopeId: readWalletScopeId(database),
          orderId: key.orderId,
          tradeId: key.tradeId ?? null,
          marketId: key.marketId,
          publicKeyHex: key.publicKeyHex,
        },
        daemonPassphrase(),
      )
      database
        .prepare(
          `INSERT INTO target_ephemeral_keys (
            key_id, scope_id, order_id, trade_id, market_id, public_key_hex,
            protection, kdf, salt, iv, auth_tag, private_key_body, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          keyId,
          readWalletScopeId(database),
          key.orderId,
          key.tradeId ?? null,
          key.marketId,
          key.publicKeyHex,
          protectedKey.protection,
          protectedKey.kdf,
          protectedKey.salt === null ? null : Buffer.from(protectedKey.salt),
          protectedKey.iv === null ? null : Buffer.from(protectedKey.iv),
          protectedKey.authTag === null ? null : Buffer.from(protectedKey.authTag),
          Buffer.from(protectedKey.body),
          Date.parse(key.createdAt),
        )
    }
  })
}

function decodeEphemeralRow(row: EphemeralRow): OrderEphemeralSecret {
  const privateKeyHex = unlockTargetEphemeralPrivateKey(
    protectedBody(row),
    {
      walletScopeId: row.scopeId,
      orderId: row.orderId,
      tradeId: row.tradeId,
      marketId: row.marketId,
      publicKeyHex: row.publicKeyHex,
    },
    daemonPassphrase(),
  )
  return {
    orderId: row.orderId,
    ...(row.tradeId === null ? {} : { tradeId: row.tradeId }),
    marketId: row.marketId,
    privateKeyHex,
    publicKeyHex: row.publicKeyHex,
    createdAt: new Date(row.createdAtMs).toISOString(),
  }
}

function protectedBody(row: EphemeralRow): ProtectedSecretBody {
  return {
    protection: row.protection,
    kdf: row.kdf,
    salt: row.salt === null ? null : Uint8Array.from(row.salt),
    iv: row.iv === null ? null : Uint8Array.from(row.iv),
    authTag: row.authTag === null ? null : Uint8Array.from(row.authTag),
    body: Uint8Array.from(row.body),
  }
}

function readWalletScopeId(database: import('node:sqlite').DatabaseSync): string {
  const row = database
    .prepare('SELECT wallet_scope_id AS scopeId FROM daemon_profile WHERE singleton = 1')
    .get() as { scopeId: string } | undefined
  if (row === undefined) throw new Error('daemon wallet scope is missing')
  return row.scopeId
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

function assertIdentityUnchanged(current: DaemonSecrets, next: DaemonSecrets): void {
  if (
    current.walletSeedHex !== next.walletSeedHex ||
    current.nostrSecretKeyHex !== next.nostrSecretKeyHex ||
    current.nostrPublicKeyHex !== next.nostrPublicKeyHex ||
    current.createdAt !== next.createdAt
  ) {
    throw new Error('daemon identity secrets are immutable')
  }
}

function normalizeHexSecret(value: string, label: string): string {
  const normalized = value.trim().replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be exactly 32 bytes of hex`)
  }
  return normalized
}

function normalizeIsoTime(value: string): string {
  const time = new Date(value)
  if (!Number.isFinite(time.getTime())) throw new Error('secret creation time is invalid')
  return time.toISOString()
}

function daemonPassphrase(): string | undefined {
  return process.env.BITCASTER_DAEMON_PASSPHRASE || undefined
}

interface EphemeralRow {
  keyId: string
  scopeId: string
  orderId: string
  tradeId: string | null
  marketId: string
  publicKeyHex: string
  protection: ProtectedSecretBody['protection']
  kdf: ProtectedSecretBody['kdf']
  salt: Uint8Array | null
  iv: Uint8Array | null
  authTag: Uint8Array | null
  body: Uint8Array
  createdAtMs: number
}
