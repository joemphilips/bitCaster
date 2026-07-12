import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  randomBytes,
  scryptSync,
} from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import {
  generateOrderEphemeralKeypair,
  normalizeSecp256k1PrivateKeyHex,
  type OrderEphemeralKeypair,
} from './ephemeralKey.ts'
import {
  ensureDaemonSecretsTable,
  ensureProfileDir,
  openProfileDatabase,
  profileDatabaseExists,
  profileDatabasePath,
  profileInitializationIsComplete,
  tableExists,
} from './profile.ts'

export interface DaemonSecrets {
  walletSeedHex: string
  nostrSecretKeyHex: string
  nostrPublicKeyHex: string
  orderEphemeralKeys: Record<string, OrderEphemeralSecret>
  createdAt: string
}

export interface OrderEphemeralSecret {
  orderId: string
  tradeId?: string
  marketId: string
  privateKeyHex: string
  publicKeyHex: string
  createdAt: string
}

interface PlaintextSecretFile {
  version: 1
  protection: 'file-mode-0600'
  secrets: DaemonSecrets
}

interface EncryptedSecretFile {
  version: 1
  protection: 'passphrase-aes-256-gcm'
  kdf: 'scrypt'
  salt: string
  iv: string
  tag: string
  ciphertext: string
}

type SecretFile = PlaintextSecretFile | EncryptedSecretFile

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
  const nostrSecretKeyHex = normalizeNostrSecretKeyHex(nostr.getPrivateKey('hex'))
  return {
    walletSeedHex: randomBytes(32).toString('hex'),
    nostrSecretKeyHex,
    nostrPublicKeyHex: compressedSecp256k1ToNostrPubkey(
      nostr.getPublicKey(undefined, 'compressed'),
    ),
    orderEphemeralKeys: {},
    createdAt: now,
  }
}

export function createDaemonSecretsFromImport(
  input: {
    walletSeedHex: string
    nostrSecretKeyHex: string
  },
  now = new Date().toISOString(),
): DaemonSecrets {
  const walletSeedHex = normalizeHexSecret(
    input.walletSeedHex,
    'wallet seed',
  )
  const nostrSecretKeyHex = normalizeNostrSecretKeyHex(input.nostrSecretKeyHex)
  const nostr = createECDH('secp256k1')
  try {
    nostr.setPrivateKey(Buffer.from(nostrSecretKeyHex, 'hex'))
  } catch {
    throw new Error('nostr secret key is not a valid secp256k1 private key')
  }
  return {
    walletSeedHex,
    nostrSecretKeyHex,
    nostrPublicKeyHex: compressedSecp256k1ToNostrPubkey(
      nostr.getPublicKey(undefined, 'compressed'),
    ),
    orderEphemeralKeys: {},
    createdAt: now,
  }
}

export async function ensureSecrets(): Promise<DaemonSecrets> {
  const existing = await readSecrets()
  if (existing) return existing
  throw new Error('daemon secrets are not initialized; run bitcaster-daemon init')
}

export async function readSecrets(): Promise<DaemonSecrets | null> {
  if (!(await profileDatabaseExists())) return null
  const database = openSecretsDatabase()
  try {
    if (!secretsTableExists(database)) {
      if (profileInitializationIsComplete(database)) {
        throw new Error('daemon secrets schema is missing')
      }
      return null
    }
    const secrets = readSecretsFromDatabase(database)
    if (!secrets) {
      if (profileInitializationIsComplete(database)) {
        throw new Error('daemon secrets row is missing')
      }
      return null
    }
    return secrets
  } finally {
    database.close()
  }
}

export async function writeSecrets(secrets: DaemonSecrets): Promise<void> {
  await ensureProfileDir()
  const database = openSecretsDatabase()
  try {
    if (process.platform !== 'win32') await chmod(secretsPath(), 0o600)
    ensureDaemonSecretsTable(database)
    database.exec('BEGIN IMMEDIATE')
    try {
      writeSecretsToDatabase(database, secrets)
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // The transaction may already have completed.
      }
      throw error
    }
  } finally {
    database.close()
  }
}

export async function updateSecrets<T>(
  update: (secrets: DaemonSecrets, now: string) => T,
): Promise<T> {
  return withSecretsUpdateLock(async () => {
    await ensureProfileDir()
    const database = openSecretsDatabase()
    try {
      if (process.platform !== 'win32') await chmod(secretsPath(), 0o600)
      if (!secretsTableExists(database)) {
        throw new Error('daemon secrets are not initialized; run bitcaster-daemon init')
      }
      database.exec('BEGIN IMMEDIATE')
      try {
        const secrets = readSecretsFromDatabase(database)
        if (!secrets) throw new Error('daemon secrets row is missing')
        const result = update(secrets, new Date().toISOString())
        writeSecretsToDatabase(database, secrets)
        database.exec('COMMIT')
        return result
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // The transaction may already have completed.
        }
        throw error
      }
    } finally {
      database.close()
    }
  })
}

/**
 * Persists the exact private/public protocol key before any caller can submit
 * its public half. Repeated callbacks reuse the retained key by trade ID.
 */
export async function getOrCreateOrderEphemeralKeypair(input: {
  tradeId: string
  orderId: string
  marketId: string
  /** Test seam; production uses the native secp256k1 generator. */
  generateEphemeralKeypair?: () => OrderEphemeralKeypair
}): Promise<OrderEphemeralKeypair> {
  let selected: OrderEphemeralSecret | undefined
  await updateSecrets((secrets, now) => {
    const existing = secrets.orderEphemeralKeys[input.tradeId]
    if (existing) {
      if (existing.tradeId !== input.tradeId
        || existing.orderId !== input.orderId
        || existing.marketId !== input.marketId) {
        throw new Error('stored ephemeral key conflicts with pending pubkey request')
      }
      selected = existing
      return
    }
    const created = input.generateEphemeralKeypair?.() ?? generateOrderEphemeralKeypair()
    selected = {
      orderId: input.orderId,
      tradeId: input.tradeId,
      marketId: input.marketId,
      privateKeyHex: created.privateKeyHex,
      publicKeyHex: created.publicKeyHex,
      createdAt: now,
    }
    secrets.orderEphemeralKeys[input.tradeId] = selected
  })
  if (!selected) throw new Error('failed to retain pending pubkey keypair')
  return {
    privateKeyHex: selected.privateKeyHex,
    publicKeyHex: selected.publicKeyHex,
  }
}

/** Runs inside bootstrap's replacement transaction to protect live custody. */
export function assertStoredSecretsHaveNoEphemeralKeysForIdentityReplacement(
  database: DatabaseSync,
): void {
  const secrets = readSecretsFromDatabase(database)
  if (!secrets) throw new Error('daemon secrets row is missing')
  if (Object.keys(secrets.orderEphemeralKeys).length > 0) {
    throw new Error('daemon secrets retain ephemeral protocol keys; refusing identity replacement')
  }
}

function openSecretsDatabase(): DatabaseSync {
  return openProfileDatabase()
}

function secretsTableExists(database: DatabaseSync): boolean {
  return tableExists(database, 'daemon_secrets')
}

function readSecretsFromDatabase(database: DatabaseSync): DaemonSecrets | null {
  const row = database.prepare(
    'SELECT schema_version, payload FROM daemon_secrets WHERE singleton = 1',
  ).get() as { schema_version?: unknown; payload?: unknown } | undefined
  if (!row) return null
  if (row.schema_version !== 1 || typeof row.payload !== 'string') {
    throw new Error('daemon secrets row is invalid')
  }
  const file = decodeSecretFile(row.payload)
  return file.protection === 'file-mode-0600'
    ? normalizeSecrets(file.secrets)
    : decryptSecrets(file)
}

function writeSecretsToDatabase(database: DatabaseSync, secrets: DaemonSecrets): void {
  const payload = encodeDaemonSecretsForStorage(secrets)
  database.prepare(
    `INSERT INTO daemon_secrets (singleton, schema_version, payload)
     VALUES (1, 1, ?)
     ON CONFLICT(singleton) DO UPDATE SET payload = excluded.payload`,
  ).run(payload)
}

/** Returns a validated secret envelope for the atomic profile bootstrap transaction. */
export function encodeDaemonSecretsForStorage(secrets: DaemonSecrets): string {
  return JSON.stringify(encodeSecrets(normalizeSecrets(secrets)))
}

function encodeSecrets(secrets: DaemonSecrets): SecretFile {
  const passphrase = process.env.BITCASTER_DAEMON_PASSPHRASE
  if (!passphrase) {
    return {
      version: 1,
      protection: 'file-mode-0600',
      secrets,
    }
  }

  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = deriveKey(passphrase, salt)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = JSON.stringify(secrets)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  return {
    version: 1,
    protection: 'passphrase-aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  }
}

function decodeSecretFile(payload: string): SecretFile {
  let value: unknown
  try {
    value = JSON.parse(payload) as unknown
  } catch {
    throw new Error('daemon secrets payload is corrupt')
  }
  if (!isSecretRecord(value) || value.version !== 1 || typeof value.protection !== 'string') {
    throw new Error('daemon secrets payload is invalid')
  }
  if (value.protection === 'file-mode-0600') {
    requireSecretFields(value, ['version', 'protection', 'secrets'])
    if (!isSecretRecord(value.secrets)) throw new Error('daemon secrets payload is invalid')
    return {
      version: 1,
      protection: 'file-mode-0600',
      secrets: value.secrets as unknown as DaemonSecrets,
    }
  }
  if (value.protection === 'passphrase-aes-256-gcm') {
    requireSecretFields(value, ['version', 'protection', 'kdf', 'salt', 'iv', 'tag', 'ciphertext'])
    if (value.kdf !== 'scrypt') throw new Error('daemon secrets payload is invalid')
    return {
      version: 1,
      protection: 'passphrase-aes-256-gcm',
      kdf: 'scrypt',
      salt: requireSecretText(value.salt),
      iv: requireSecretText(value.iv),
      tag: requireSecretText(value.tag),
      ciphertext: requireSecretText(value.ciphertext),
    }
  }
  throw new Error('daemon secrets payload is invalid')
}

function isSecretRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireSecretFields(
  record: Record<string, unknown>,
  expected: readonly string[],
  optional: readonly string[] = [],
): void {
  for (const key of Object.keys(record)) {
    if (!expected.includes(key)) throw new Error('daemon secrets payload is invalid')
  }
  for (const key of expected) {
    if (!optional.includes(key) && !(key in record)) {
      throw new Error('daemon secrets payload is invalid')
    }
  }
}

function requireSecretText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('daemon secrets payload is invalid')
  return value
}

function decryptSecrets(file: EncryptedSecretFile): DaemonSecrets {
  const passphrase = process.env.BITCASTER_DAEMON_PASSPHRASE
  if (!passphrase) {
    throw new Error(
      'BITCASTER_DAEMON_PASSPHRASE is required to unlock daemon secrets',
    )
  }
  const key = deriveKey(passphrase, Buffer.from(file.salt, 'hex'))
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(file.iv, 'hex'),
  )
  decipher.setAuthTag(Buffer.from(file.tag, 'hex'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(file.ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8')
  return normalizeSecrets(JSON.parse(plaintext) as Partial<DaemonSecrets>)
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32)
}

function compressedSecp256k1ToNostrPubkey(compressed: Buffer): string {
  if (compressed.length !== 33) {
    throw new Error('unexpected secp256k1 public key length')
  }
  return compressed.subarray(1).toString('hex')
}

function normalizeHexSecret(value: string, label: string): string {
  const normalized = value.trim().replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} must be a 32-byte hex string`)
  }
  return normalized
}

function normalizeNostrSecretKeyHex(value: string): string {
  const normalized = normalizeSecp256k1PrivateKeyHex(
    value.trim().replace(/^0x/i, ''),
  )
  const nostr = createECDH('secp256k1')
  try {
    nostr.setPrivateKey(Buffer.from(normalized, 'hex'))
  } catch {
    throw new Error('nostr secret key is not a valid secp256k1 private key')
  }
  return normalized
}

function normalizeSecrets(value: unknown): DaemonSecrets {
  if (!isSecretRecord(value)) throw new Error('daemon secrets payload is malformed')
  requireSecretFields(value, [
    'walletSeedHex', 'nostrSecretKeyHex', 'nostrPublicKeyHex', 'orderEphemeralKeys', 'createdAt',
  ])
  const walletSeedHex = requireSecretText(value.walletSeedHex)
  const nostrSecretKeyHex = normalizeNostrSecretKeyHex(requireSecretText(value.nostrSecretKeyHex))
  const nostrPublicKeyHex = requireSecretText(value.nostrPublicKeyHex).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(nostrPublicKeyHex)) {
    throw new Error('daemon secrets payload is malformed')
  }
  if (nostrPublicKeyHex !== compressedSecp256k1ToNostrPubkey(
    Buffer.from(deriveCompressedPublicKeyHex(nostrSecretKeyHex), 'hex'),
  )) {
    throw new Error('daemon secrets payload is malformed')
  }
  const createdAt = requireSecretText(value.createdAt)
  const orderEphemeralKeys = decodeOrderEphemeralSecrets(value.orderEphemeralKeys)
  return {
    walletSeedHex: normalizeHexSecret(walletSeedHex, 'wallet seed'),
    nostrSecretKeyHex,
    nostrPublicKeyHex,
    orderEphemeralKeys,
    createdAt,
  }
}

function decodeOrderEphemeralSecrets(value: unknown): Record<string, OrderEphemeralSecret> {
  if (!isSecretRecord(value)) throw new Error('daemon secrets payload is malformed')
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    if (key.length === 0 || !isSecretRecord(raw)) {
      throw new Error('daemon secrets payload is malformed')
    }
    requireSecretFields(raw, [
      'orderId', 'tradeId', 'marketId', 'privateKeyHex', 'publicKeyHex', 'createdAt',
    ], ['tradeId'])
    const orderId = requireSecretText(raw.orderId)
    const tradeId = raw.tradeId === undefined ? undefined : requireSecretText(raw.tradeId)
    if (orderId !== key && tradeId !== key) throw new Error('daemon secrets payload is malformed')
    const privateKeyHex = normalizeSecp256k1PrivateKeyHex(
      requireSecretText(raw.privateKeyHex),
    )
    const publicKeyHex = requireSecretText(raw.publicKeyHex).toLowerCase()
    if (!/^(02|03)[0-9a-f]{64}$/.test(publicKeyHex)) {
      throw new Error('daemon secrets payload is malformed')
    }
    if (publicKeyHex !== deriveCompressedPublicKeyHex(privateKeyHex)) {
      throw new Error('daemon secrets payload is malformed')
    }
    return [key, {
      orderId,
      ...(tradeId === undefined ? {} : { tradeId }),
      marketId: requireSecretText(raw.marketId),
      privateKeyHex,
      publicKeyHex,
      createdAt: requireSecretText(raw.createdAt),
    }]
  }))
}

function deriveCompressedPublicKeyHex(privateKeyHex: string): string {
  const key = createECDH('secp256k1')
  try {
    key.setPrivateKey(Buffer.from(privateKeyHex, 'hex'))
  } catch {
    throw new Error('daemon secrets payload is malformed')
  }
  return key.getPublicKey(undefined, 'compressed').toString('hex')
}
