import { createECDH, randomBytes } from 'node:crypto'
import { chmod } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import {
  generateOrderEphemeralKeypair,
  normalizeSecp256k1PrivateKeyHex,
  type OrderEphemeralKeypair,
} from './ephemeralKey.ts'
import {
  ensureProfileDir,
  openProfileDatabase,
  profileDatabaseExists,
  profileDatabasePath,
  profileInitializationIsComplete,
} from './profile.ts'
import { validateDaemonTradeAuthorityFacts } from './durableTradeBinding.ts'

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

export function createDaemonSecrets(
  now = new Date().toISOString(),
): DaemonSecrets {
  const nostr = createECDH('secp256k1')
  nostr.generateKeys()
  const nostrSecretKeyHex = normalizeNostrSecretKeyHex(
    nostr.getPrivateKey('hex'),
  )
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
  const walletSeedHex = normalizeHexSecret(input.walletSeedHex, 'wallet seed')
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
  throw new Error(
    'daemon secrets are not initialized; run bitcaster-daemon init',
  )
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

/** Reads only the singleton wallet/authentication identity on hot paths. */
export async function readIdentitySecrets(): Promise<DaemonIdentitySecrets | null> {
  if (!(await profileDatabaseExists())) return null
  const database = openSecretsDatabase()
  try {
    if (!secretsTableExists(database)) {
      if (profileInitializationIsComplete(database)) {
        throw new Error('daemon secrets schema is missing')
      }
      return null
    }
    const identity = readIdentitySecretsFromDatabase(database)
    if (!identity && profileInitializationIsComplete(database)) {
      throw new Error('daemon secrets row is missing')
    }
    return identity
  } finally {
    database.close()
  }
}

/** Reads one protocol key without hydrating unrelated retained trade keys. */
export async function readOrderEphemeralSecret(
  keyId: string,
): Promise<OrderEphemeralSecret | null> {
  if (keyId.length === 0) throw new Error('ephemeral key id is required')
  if (!(await profileDatabaseExists())) return null
  const database = openSecretsDatabase()
  try {
    if (!secretsTableExists(database)) {
      if (profileInitializationIsComplete(database)) {
        throw new Error('daemon secrets schema is missing')
      }
      return null
    }
    assertDaemonSecretsSchema(database)
    const identity = database
      .prepare(
        'SELECT schema_version FROM daemon_identity_secrets WHERE singleton = 1',
      )
      .get() as { schema_version?: unknown } | undefined
    if (identity === undefined) {
      if (profileInitializationIsComplete(database)) {
        throw new Error('daemon secrets row is missing')
      }
      return null
    }
    if (identity.schema_version !== 1) {
      throw new Error('daemon secrets schema is unsupported')
    }
    const row = database
      .prepare(
        `SELECT key_id, schema_version, order_id, trade_id, market_id,
              private_key_hex, public_key_hex, created_at
         FROM daemon_order_ephemeral_keys
        WHERE key_id = ?`,
      )
      .get(keyId) as Record<string, unknown> | undefined
    return row === undefined ? null : decodeOrderEphemeralSecretRow(row)
  } finally {
    database.close()
  }
}

/** Validates every cross-table authority used by restart recovery. */
export async function assertDaemonStorageBindings(): Promise<void> {
  if (!(await profileDatabaseExists())) {
    throw new Error(
      'daemon profile is not initialized; run bitcaster-daemon init',
    )
  }
  const database = openSecretsDatabase()
  try {
    ensureDaemonSecretsSchema(database)
    const identity = readIdentitySecretsFromDatabase(database)
    if (!identity) throw new Error('daemon secrets row is missing')
    const profile = database
      .prepare(
        `SELECT mint_url, nostr_public_key
         FROM daemon_profile WHERE singleton = 1`,
      )
      .get() as { mint_url?: unknown; nostr_public_key?: unknown } | undefined
    if (
      !profile ||
      profile.nostr_public_key !== identity.nostrPublicKeyHex ||
      typeof profile.mint_url !== 'string' ||
      profile.mint_url.length === 0
    ) {
      throw new Error('daemon profile identity binding is invalid')
    }
    if (
      !tableExists(database, 'daemon_trade_sessions') ||
      !tableExists(database, 'daemon_swaps')
    ) {
      throw new Error('daemon recovery state schema is incomplete')
    }
    const bindingPage = database.prepare(
        `SELECT
         session.trade_id AS session_trade_id,
         session.role AS session_role,
         session.local_protocol_pubkey,
         session.counterparty_protocol_pubkey AS session_counterparty_protocol_pubkey,
         session.mint_url AS session_mint_url,
         session.seller_locktime_secs AS session_seller_locktime_secs,
         session.buyer_locktime_secs AS session_buyer_locktime_secs,
         session.key_id AS session_key_id,
         key.key_id, key.schema_version, key.order_id, key.trade_id,
         key.market_id, key.private_key_hex, key.public_key_hex, key.created_at,
         swap.trade_id AS swap_trade_id,
         swap.role AS swap_role,
         swap.counterparty_pubkey AS swap_counterparty_pubkey,
         swap.seller_locktime AS swap_seller_locktime,
         swap.buyer_locktime AS swap_buyer_locktime,
         swap.order_id AS swap_order_id,
         swap.market_id AS swap_market_id
       FROM daemon_trade_sessions AS session
       LEFT JOIN daemon_order_ephemeral_keys AS key
         ON key.key_id = session.key_id
       LEFT JOIN daemon_swaps AS swap
         ON swap.trade_id = session.trade_id
       WHERE session.trade_id > ?
       ORDER BY session.trade_id
       LIMIT 256`,
    )
    let cursor = ''
    for (;;) {
      const rows = bindingPage.all(cursor) as Array<Record<string, unknown>>
      for (const row of rows) {
        validateStorageBindingRow(row, requireSecretText(profile.mint_url))
      }
      if (rows.length < 256) break
      cursor = requireSecretText(rows[rows.length - 1]?.session_trade_id)
    }
    const foreignKeyFailures = database
      .prepare('PRAGMA foreign_key_check')
      .all() as Array<Record<string, unknown>>
    if (foreignKeyFailures.length > 0) {
      throw new Error('daemon profile foreign keys are corrupt')
    }
  } finally {
    database.close()
  }
}

function validateStorageBindingRow(
  row: Record<string, unknown>,
  profileMintUrl: string,
): void {
  const tradeId = requireSecretText(row.session_trade_id)
  if (row.key_id === null) {
    throw new Error(`durable trade ${tradeId} has no retained protocol key`)
  }
  const key = decodeOrderEphemeralSecretRow(row)
  const bindingError = validateDaemonTradeAuthorityFacts({
    tradeId,
    sessionTradeId: row.session_trade_id,
    swapTradeId: row.swap_trade_id,
    sessionRole: row.session_role,
    swapRole: row.swap_role,
    sessionLocalProtocolPubkey: row.local_protocol_pubkey,
    retainedKeyPublicKey: key.publicKeyHex,
    sessionCounterpartyProtocolPubkey:
      row.session_counterparty_protocol_pubkey,
    swapCounterpartyPubkey: row.swap_counterparty_pubkey,
    sessionSellerLocktimeSecs: row.session_seller_locktime_secs,
    swapSellerLocktimeSecs: row.swap_seller_locktime,
    sessionBuyerLocktimeSecs: row.session_buyer_locktime_secs,
    swapBuyerLocktimeSecs: row.swap_buyer_locktime,
    sessionMintUrl: row.session_mint_url,
    profileMintUrl,
    sessionKeyId: row.session_key_id,
    retainedKeyId: row.key_id,
    retainedKeyOrderId: key.orderId,
    swapOrderId: row.swap_order_id,
    retainedKeyTradeId: key.tradeId,
    retainedKeyMarketId: key.marketId,
    swapMarketId: row.swap_market_id,
  })
  if (bindingError) {
    throw new Error(
      `durable trade ${tradeId} protocol authority binding is invalid: ${bindingError}`,
    )
  }
}

export async function writeSecrets(secrets: DaemonSecrets): Promise<void> {
  await ensureProfileDir()
  const database = openSecretsDatabase()
  try {
    if (process.platform !== 'win32') await chmod(secretsPath(), 0o600)
    ensureDaemonSecretsSchema(database)
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
        throw new Error(
          'daemon secrets are not initialized; run bitcaster-daemon init',
        )
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
  return withSecretsUpdateLock(async () => {
    await ensureProfileDir()
    const database = openSecretsDatabase()
    try {
      if (process.platform !== 'win32') await chmod(secretsPath(), 0o600)
      if (!secretsTableExists(database)) {
        throw new Error(
          'daemon secrets are not initialized; run bitcaster-daemon init',
        )
      }
      assertDaemonSecretsSchema(database)
      database.exec('BEGIN IMMEDIATE')
      try {
        const identity = database
          .prepare(
            'SELECT schema_version FROM daemon_identity_secrets WHERE singleton = 1',
          )
          .get() as { schema_version?: unknown } | undefined
        if (identity?.schema_version !== 1) {
          throw new Error('daemon secrets row is missing')
    }
        const row = database
          .prepare(
            `SELECT key_id, schema_version, order_id, trade_id, market_id,
                  private_key_hex, public_key_hex, created_at
             FROM daemon_order_ephemeral_keys WHERE key_id = ?`,
          )
          .get(input.tradeId) as Record<string, unknown> | undefined
        let selected: OrderEphemeralSecret
        if (row !== undefined) {
          selected = decodeOrderEphemeralSecretRow(row)
          if (
            selected.tradeId !== input.tradeId ||
            selected.orderId !== input.orderId ||
            selected.marketId !== input.marketId
          ) {
            throw new Error(
              'stored ephemeral key conflicts with pending pubkey request',
            )
          }
        } else {
          const created =
            input.generateEphemeralKeypair?.() ??
            generateOrderEphemeralKeypair()
          selected = decodeOrderEphemeralSecrets({
            [input.tradeId]: {
      orderId: input.orderId,
      tradeId: input.tradeId,
      marketId: input.marketId,
      privateKeyHex: created.privateKeyHex,
      publicKeyHex: created.publicKeyHex,
              createdAt: new Date().toISOString(),
            },
          })[input.tradeId]!
          database
            .prepare(
              `INSERT INTO daemon_order_ephemeral_keys (
              key_id, schema_version, order_id, trade_id, market_id,
              private_key_hex, public_key_hex, created_at
            ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              input.tradeId,
              selected.orderId,
              selected.tradeId ?? null,
              selected.marketId,
              selected.privateKeyHex,
              selected.publicKeyHex,
              selected.createdAt,
            )
    }
        database.exec('COMMIT')
  return {
    privateKeyHex: selected.privateKeyHex,
    publicKeyHex: selected.publicKeyHex,
  }
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

/** Runs inside bootstrap's replacement transaction to protect live custody. */
export function assertStoredSecretsHaveNoEphemeralKeysForIdentityReplacement(
  database: DatabaseSync,
): void {
  const secrets = readSecretsFromDatabase(database)
  if (!secrets) throw new Error('daemon secrets row is missing')
  if (Object.keys(secrets.orderEphemeralKeys).length > 0) {
    throw new Error(
      'daemon secrets retain ephemeral protocol keys; refusing identity replacement',
    )
  }
}

function openSecretsDatabase(): DatabaseSync {
  return openProfileDatabase()
}

function secretsTableExists(database: DatabaseSync): boolean {
  return tableExists(database, 'daemon_identity_secrets')
}

function readSecretsFromDatabase(database: DatabaseSync): DaemonSecrets | null {
  assertDaemonSecretsSchema(database)
  const identity = readIdentitySecretsFromDatabase(database)
  if (!identity) return null
  const orderEphemeralKeys = Object.fromEntries(
    (
      database
        .prepare(
          `SELECT key_id, schema_version, order_id, trade_id, market_id, private_key_hex,
              public_key_hex, created_at
         FROM daemon_order_ephemeral_keys ORDER BY key_id`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((key) => {
      const decoded = decodeOrderEphemeralSecretRow(key)
      return [requireSecretText(key.key_id), decoded]
    }),
  )
  return { ...identity, orderEphemeralKeys }
}

function readIdentitySecretsFromDatabase(
  database: DatabaseSync,
): DaemonIdentitySecrets | null {
  assertDaemonSecretsSchema(database)
  const row = database
    .prepare(
      `SELECT schema_version, wallet_seed_hex, nostr_secret_key_hex,
            nostr_public_key_hex, created_at
       FROM daemon_identity_secrets WHERE singleton = 1`,
    )
    .get() as Record<string, unknown> | undefined
  if (!row) return null
  const normalized = normalizeSecrets({
    walletSeedHex: row.wallet_seed_hex,
    nostrSecretKeyHex: row.nostr_secret_key_hex,
    nostrPublicKeyHex: row.nostr_public_key_hex,
    orderEphemeralKeys: {},
    createdAt: row.created_at,
  })
  const { orderEphemeralKeys: _, ...identity } = normalized
  return identity
}

function decodeOrderEphemeralSecretRow(
  row: Record<string, unknown>,
): OrderEphemeralSecret {
  if (row.schema_version !== 1) {
    throw new Error('daemon secrets schema is unsupported')
  }
  const keyId = requireSecretText(row.key_id)
  const decoded = decodeOrderEphemeralSecrets({
    [keyId]: {
      orderId: row.order_id,
      ...(row.trade_id === null ? {} : { tradeId: row.trade_id }),
      marketId: row.market_id,
      privateKeyHex: row.private_key_hex,
      publicKeyHex: row.public_key_hex,
      createdAt: row.created_at,
    },
  })[keyId]
  if (!decoded) throw new Error('daemon secrets payload is malformed')
  return decoded
}

function writeSecretsToDatabase(
  database: DatabaseSync,
  secrets: DaemonSecrets,
): void {
  const normalized = normalizeSecrets(secrets)
  const existingKeys = new Map(
    (
      database
        .prepare(
          `SELECT key_id, schema_version, order_id, trade_id, market_id,
              private_key_hex, public_key_hex, created_at
         FROM daemon_order_ephemeral_keys ORDER BY key_id`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => [
      requireSecretText(row.key_id),
      decodeOrderEphemeralSecretRow(row),
    ]),
  )
  if (tableExists(database, 'daemon_trade_sessions')) {
    const referencedKeyIds = database
      .prepare('SELECT key_id FROM daemon_trade_sessions ORDER BY key_id')
      .all() as Array<{ key_id: unknown }>
    for (const row of referencedKeyIds) {
      const keyId = requireSecretText(row.key_id)
      const existing = existingKeys.get(keyId)
      const replacement = normalized.orderEphemeralKeys[keyId]
      if (
        !existing ||
        !replacement ||
        JSON.stringify(existing) !== JSON.stringify(replacement)
      ) {
        throw new Error('active durable trade key authority cannot be replaced')
      }
    }
  }
  database
    .prepare(
      `INSERT INTO daemon_identity_secrets (
      singleton, schema_version, wallet_seed_hex, nostr_secret_key_hex,
      nostr_public_key_hex, created_at
    ) VALUES (1, 1, ?, ?, ?, ?)
    ON CONFLICT(singleton) DO UPDATE SET
      schema_version = excluded.schema_version,
      wallet_seed_hex = excluded.wallet_seed_hex,
      nostr_secret_key_hex = excluded.nostr_secret_key_hex,
      nostr_public_key_hex = excluded.nostr_public_key_hex,
      created_at = excluded.created_at`,
    )
    .run(
      normalized.walletSeedHex,
      normalized.nostrSecretKeyHex,
      normalized.nostrPublicKeyHex,
      normalized.createdAt,
    )
  for (const [keyId, key] of Object.entries(normalized.orderEphemeralKeys)) {
    database
      .prepare(
        `INSERT INTO daemon_order_ephemeral_keys (
        key_id, schema_version, order_id, trade_id, market_id,
        private_key_hex, public_key_hex, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(key_id) DO UPDATE SET
        schema_version = excluded.schema_version,
        order_id = excluded.order_id,
        trade_id = excluded.trade_id,
        market_id = excluded.market_id,
        private_key_hex = excluded.private_key_hex,
        public_key_hex = excluded.public_key_hex,
        created_at = excluded.created_at`,
      )
      .run(
        keyId,
        key.orderId,
        key.tradeId ?? null,
        key.marketId,
        key.privateKeyHex,
        key.publicKeyHex,
        key.createdAt,
      )
}
  for (const keyId of existingKeys.keys()) {
    if (normalized.orderEphemeralKeys[keyId] !== undefined) continue
    database
      .prepare('DELETE FROM daemon_order_ephemeral_keys WHERE key_id = ?')
      .run(keyId)
    }
  }

/** Initializes typed secret rows inside profile bootstrap's transaction. */
export function initializeDaemonSecretsInDatabase(
  database: DatabaseSync,
  secrets: DaemonSecrets,
): void {
  ensureDaemonSecretsSchema(database)
  writeSecretsToDatabase(database, secrets)
  }

const SECRET_TABLES = [
  'daemon_identity_secrets',
  'daemon_order_ephemeral_keys',
] as const

const SECRETS_SCHEMA_SQL = `
  CREATE TABLE daemon_identity_secrets (
    singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    wallet_seed_hex TEXT NOT NULL CHECK (length(wallet_seed_hex) = 64 AND wallet_seed_hex NOT GLOB '*[^0-9a-f]*'),
    nostr_secret_key_hex TEXT NOT NULL CHECK (length(nostr_secret_key_hex) = 64 AND nostr_secret_key_hex NOT GLOB '*[^0-9a-f]*'),
    nostr_public_key_hex TEXT NOT NULL CHECK (length(nostr_public_key_hex) = 64 AND nostr_public_key_hex NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z')
  ) STRICT;

  CREATE TABLE daemon_order_ephemeral_keys (
    key_id TEXT PRIMARY KEY NOT NULL CHECK (length(key_id) > 0),
    schema_version INTEGER NOT NULL CHECK (schema_version = 1),
    order_id TEXT NOT NULL CHECK (length(order_id) > 0),
    trade_id TEXT CHECK (trade_id IS NULL OR length(trade_id) > 0),
    market_id TEXT NOT NULL CHECK (length(market_id) > 0),
    private_key_hex TEXT NOT NULL CHECK (length(private_key_hex) = 64 AND private_key_hex NOT GLOB '*[^0-9a-f]*'),
    public_key_hex TEXT NOT NULL CHECK (length(public_key_hex) = 66 AND public_key_hex NOT GLOB '*[^0-9a-f]*' AND substr(public_key_hex, 1, 2) IN ('02', '03')),
    created_at TEXT NOT NULL CHECK (length(created_at) = 24 AND created_at GLOB '????-??-??T??:??:??.???Z'),
    CHECK (key_id = order_id OR key_id = trade_id)
  ) STRICT;
`

export function ensureDaemonSecretsSchema(database: DatabaseSync): void {
  const identity = tableExists(database, 'daemon_identity_secrets')
  const operationKeys = tableExists(database, 'daemon_order_ephemeral_keys')
  if (!identity && !operationKeys) {
    if (tableExists(database, 'daemon_secrets')) {
      throw new Error('legacy daemon secrets schema is unsupported')
    }
    database.exec(SECRETS_SCHEMA_SQL)
    return
  }
  if (!identity || !operationKeys) {
    throw new Error('daemon secrets schema is incomplete')
  }
  assertDaemonSecretsSchema(database)
}

function assertDaemonSecretsSchema(database: DatabaseSync): void {
  if (
    JSON.stringify(readSecretSchemaObjects(database)) !==
    JSON.stringify(expectedSecretSchemaObjects())
  ) {
    throw new Error('daemon secrets schema is unsupported')
  }
  const marker = database
    .prepare(
      'SELECT schema_version FROM daemon_identity_secrets WHERE singleton = 1',
    )
    .get() as { schema_version?: unknown } | undefined
  if (marker !== undefined && marker.schema_version !== 1) {
    throw new Error('daemon secrets schema is unsupported')
  }
    }

let cachedExpectedSecretSchemaObjects: Array<Record<string, string>> | undefined

function expectedSecretSchemaObjects(): Array<Record<string, string>> {
  if (cachedExpectedSecretSchemaObjects !== undefined) {
    return cachedExpectedSecretSchemaObjects
  }
  const reference = new DatabaseSync(':memory:')
  try {
    reference.exec(SECRETS_SCHEMA_SQL)
    cachedExpectedSecretSchemaObjects = readSecretSchemaObjects(reference)
    return cachedExpectedSecretSchemaObjects
  } finally {
    reference.close()
    }
  }

function readSecretSchemaObjects(
  database: DatabaseSync,
): Array<Record<string, string>> {
  const placeholders = SECRET_TABLES.map(() => '?').join(', ')
  return (
    database
      .prepare(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
        WHERE tbl_name IN (${placeholders})
          AND sql IS NOT NULL
        ORDER BY type, name`,
      )
      .all(...SECRET_TABLES) as Array<Record<string, unknown>>
  ).map((row) => ({
    type: requireSecretText(row.type),
    name: requireSecretText(row.name),
    table: requireSecretText(row.tbl_name),
    sql: requireSecretText(row.sql).replace(/\s+/g, ' ').trim(),
  }))
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
    if (!expected.includes(key))
      throw new Error('daemon secrets payload is invalid')
  }
  for (const key of expected) {
    if (!optional.includes(key) && !(key in record)) {
      throw new Error('daemon secrets payload is invalid')
    }
  }
}

function requireSecretText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error('daemon secrets payload is invalid')
  return value
}

function tableExists(database: DatabaseSync, tableName: string): boolean {
  return (
    database
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
    )
      .get(tableName) !== undefined
  )
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
  if (!isSecretRecord(value))
    throw new Error('daemon secrets payload is malformed')
  requireSecretFields(value, [
    'walletSeedHex',
    'nostrSecretKeyHex',
    'nostrPublicKeyHex',
    'orderEphemeralKeys',
    'createdAt',
  ])
  const walletSeedHex = requireSecretText(value.walletSeedHex)
  const nostrSecretKeyHex = normalizeNostrSecretKeyHex(
    requireSecretText(value.nostrSecretKeyHex),
  )
  const nostrPublicKeyHex = requireSecretText(
    value.nostrPublicKeyHex,
  ).toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(nostrPublicKeyHex)) {
    throw new Error('daemon secrets payload is malformed')
  }
  if (
    nostrPublicKeyHex !==
    compressedSecp256k1ToNostrPubkey(
    Buffer.from(deriveCompressedPublicKeyHex(nostrSecretKeyHex), 'hex'),
    )
  ) {
    throw new Error('daemon secrets payload is malformed')
  }
  const createdAt = requireSecretText(value.createdAt)
  const orderEphemeralKeys = decodeOrderEphemeralSecrets(
    value.orderEphemeralKeys,
  )
  return {
    walletSeedHex: normalizeHexSecret(walletSeedHex, 'wallet seed'),
    nostrSecretKeyHex,
    nostrPublicKeyHex,
    orderEphemeralKeys,
    createdAt,
  }
}

function decodeOrderEphemeralSecrets(
  value: unknown,
): Record<string, OrderEphemeralSecret> {
  if (!isSecretRecord(value))
    throw new Error('daemon secrets payload is malformed')
  return Object.fromEntries(
    Object.entries(value).map(([key, raw]) => {
    if (key.length === 0 || !isSecretRecord(raw)) {
      throw new Error('daemon secrets payload is malformed')
    }
      requireSecretFields(
        raw,
        [
          'orderId',
          'tradeId',
          'marketId',
          'privateKeyHex',
          'publicKeyHex',
          'createdAt',
        ],
        ['tradeId'],
      )
    const orderId = requireSecretText(raw.orderId)
      const tradeId =
        raw.tradeId === undefined ? undefined : requireSecretText(raw.tradeId)
      if (orderId !== key && tradeId !== key)
        throw new Error('daemon secrets payload is malformed')
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
      return [
        key,
        {
      orderId,
      ...(tradeId === undefined ? {} : { tradeId }),
      marketId: requireSecretText(raw.marketId),
      privateKeyHex,
      publicKeyHex,
      createdAt: requireSecretText(raw.createdAt),
        },
      ]
    }),
  )
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
