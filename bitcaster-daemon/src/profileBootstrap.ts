import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { normalizeEndpointUrl } from './profile.ts'
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  assertDaemonProfilePlatformSupported,
  assertFreshDaemonProfileInventory,
  DAEMON_PROFILE_DATABASE,
  inventoryDaemonProfile,
  validateDaemonProfileSchema,
  withValidatedDaemonProfileReadSnapshot,
} from './profileSchema.ts'
import {
  FINAL_PROFILE_APPLICATION_ID,
  FINAL_PROFILE_SCHEMA_SQL,
  FINAL_PROFILE_SCHEMA_VERSION,
  getFinalProfileSchemaManifest,
} from './profileSchemaManifest.ts'
import { NativeActivitySqlite } from './nativeActivitySqlite.ts'
import {
  normalizeInitialProfileSecrets,
  ProfileSecretProtectionError,
  protectInitialProfileSecrets,
  type InitialProfileSecrets,
  type ProtectedSecretBody,
  unlockInitialProfileSecrets,
} from './profileSecretProtection.ts'
import {
  assertNativeConfigSourceAdmissible,
  defaultNativeConfig,
  ensureNativeConfig,
  removeNativeConfigIfRevisionMatches,
} from './nativeConfig.ts'

export type ProfileBootstrapFaultPhase =
  | 'staging-reserved'
  | 'database-reserved'
  | 'before-database-open'
  | 'schema-created'
  | 'authority-written'
  | 'during-initialization'
  | 'before-commit'
  | 'after-commit'
  | 'before-publication'
  | 'after-publication'

export interface FreshDaemonProfileBootstrapInput {
  readonly directory: string
  readonly engineBaseUrl: string
  readonly mintUrl: string
  readonly walletSeedHex: string
  readonly nostrSecretKeyHex: string
  readonly nostrPublicKeyHex?: string
  readonly nativeOracleNonceSeedHex?: string
  readonly rpcToken?: string
  readonly passphrase?: string
  readonly initializedAtMs?: number
  /** Test-only deterministic fault boundary. */
  readonly injectFault?: (phase: ProfileBootstrapFaultPhase) => void
}

export interface FreshDaemonProfileBootstrapResult {
  readonly walletScopeId: string
  readonly nostrPublicKeyHex: string
  readonly rpcToken: string
}

/**
 * Creates the only admitted daemon profile shape. Existing profile artifacts
 * are never migrated or repaired here, including an already-valid database.
 */
export async function bootstrapFreshDaemonProfile(
  input: FreshDaemonProfileBootstrapInput,
): Promise<FreshDaemonProfileBootstrapResult> {
  assertDaemonProfilePlatformSupported()
  assertNativeConfigSourceAdmissible(input.directory)
  const initialInventory = await inventoryDaemonProfile(input.directory)
  assertFreshDaemonProfileInventory(initialInventory)

  const secrets = normalizeInitialProfileSecrets({
    ...input,
    nativeOracleNonceSeedHex: input.nativeOracleNonceSeedHex ?? randomBytes(32).toString('hex'),
  })
  const initializedAtMs = exactTimestamp(input.initializedAtMs ?? Date.now())
  const engineBaseUrl = normalizeEndpointUrl(input.engineBaseUrl, 'engine URL')
  const mintUrl = normalizeEndpointUrl(input.mintUrl, 'mint URL')
  const walletIdentity = deriveWalletIdentity(secrets.walletSeedHex)
  const rpcToken = input.rpcToken ?? randomBytes(32).toString('base64url')
  if (!/^[A-Za-z0-9_-]{43}$/.test(rpcToken)) {
    throw new Error('daemon RPC token is invalid')
  }
  const protectedSecrets = protectInitialProfileSecrets(
    secrets,
    walletIdentity.walletScopeId,
    input.passphrase,
  )

  let createdDirectory = false
  if (!initialInventory.directoryExists) {
    await mkdir(input.directory, { mode: 0o700 })
    createdDirectory = true
  }

  const stagingPath = join(input.directory, '.bootstrap')
  const databasePath = join(stagingPath, DAEMON_PROFILE_DATABASE)
  const finalDatabasePath = join(input.directory, DAEMON_PROFILE_DATABASE)
  let directoryHandle: Awaited<ReturnType<typeof open>> | undefined
  let stagingHandle: Awaited<ReturnType<typeof open>> | undefined
  let directoryIdentity: BootstrapIdentity | undefined
  let stagingIdentity: BootstrapIdentity | undefined
  let reservedIdentity: BootstrapIdentity | undefined
  let ownedSidecarIdentities: ReadonlyMap<string, BootstrapIdentity> | undefined
  let reservation: Awaited<ReturnType<typeof open>> | undefined
  let database: DatabaseSync | undefined
  let published = false
  let createdConfigRevision: string | null = null
  try {
    directoryHandle = await openBootstrapDirectory(input.directory)
    directoryIdentity = await directoryHandle.stat({ bigint: true })
    await assertDirectoryHasIdentity(input.directory, directoryIdentity)
    if (
      initialInventory.directoryIdentity !== undefined &&
      (initialInventory.directoryIdentity.device !== directoryIdentity.dev ||
        initialInventory.directoryIdentity.inode !== directoryIdentity.ino)
    ) {
      throw new Error('daemon profile bootstrap directory identity changed')
    }
    // The fixed, exclusive directory serializes init and makes a crash fail closed.
    await mkdir(stagingPath, { mode: 0o700 })
    stagingHandle = await openBootstrapDirectory(stagingPath)
    stagingIdentity = await stagingHandle.stat({ bigint: true })
    await assertBootstrapDirectories(
      input.directory,
      directoryIdentity,
      stagingPath,
      stagingIdentity,
    )
    const inventory = await inventoryDaemonProfile(input.directory)
    const marker = inventory.artifacts.find(({ name }) => name === '.bootstrap')
    if (
      marker?.kind !== 'directory' ||
      marker.identity.device !== stagingIdentity.dev ||
      marker.identity.inode !== stagingIdentity.ino
    ) {
      throw new Error('daemon profile bootstrap inode identity changed')
    }
    // Exclude only this invocation's verified marker from the fresh-profile check.
    assertFreshDaemonProfileInventory({
      ...inventory,
      artifacts: inventory.artifacts.filter((artifact) => artifact !== marker),
      unknownArtifacts: inventory.unknownArtifacts.filter((artifact) => artifact !== marker),
    })
    // Persist the crash marker before any config or authority can be written.
    await directoryHandle.sync()
    input.injectFault?.('staging-reserved')
    await assertBootstrapDirectories(
      input.directory,
      directoryIdentity,
      stagingPath,
      stagingIdentity,
    )
    createdConfigRevision = prepareBootstrapConfig(input.directory, engineBaseUrl, mintUrl)
    reservation = await open(databasePath, 'wx+', 0o600)
    reservedIdentity = await reservation.stat({ bigint: true })
    input.injectFault?.('database-reserved')

    input.injectFault?.('before-database-open')
    await assertBootstrapDirectories(
      input.directory,
      directoryIdentity,
      stagingPath,
      stagingIdentity,
    )
    await assertPathHasIdentity(databasePath, reservedIdentity)
    // A private unpublished pathname gives SQLite portable WAL/SHM paths.
    database = new DatabaseSync(databasePath, { allowExtension: false })
    await assertBootstrapDirectories(
      input.directory,
      directoryIdentity,
      stagingPath,
      stagingIdentity,
    )
    await assertPathHasIdentity(databasePath, reservedIdentity)
    configureWritableProfileConnection(database)
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(`
        PRAGMA application_id = ${FINAL_PROFILE_APPLICATION_ID};
        PRAGMA user_version = ${FINAL_PROFILE_SCHEMA_VERSION};
        ${FINAL_PROFILE_SCHEMA_SQL.join(';\n')};
      `)
      ownedSidecarIdentities = await captureSidecarIdentities(databasePath)
      input.injectFault?.('schema-created')
      await assertBootstrapDirectories(
        input.directory,
        directoryIdentity,
        stagingPath,
        stagingIdentity,
      )
      await assertPathHasIdentity(databasePath, reservedIdentity)
      writeAuthorityRows(database, {
        walletScopeId: walletIdentity.walletScopeId,
        walletId: walletIdentity.walletId,
        walletSeedDigest: walletIdentity.walletSeedDigest,
        secrets,
        protectedSecrets,
        rpcToken,
        initializedAtMs,
      })
      input.injectFault?.('authority-written')
      input.injectFault?.('during-initialization')
      await assertBootstrapDirectories(
        input.directory,
        directoryIdentity,
        stagingPath,
        stagingIdentity,
      )
      await assertPathHasIdentity(databasePath, reservedIdentity)
      input.injectFault?.('before-commit')
      await assertPathHasIdentity(databasePath, reservedIdentity)
      database.exec('COMMIT')
    } catch (error) {
      try {
        database.exec('ROLLBACK')
      } catch {
        // BEGIN or COMMIT may not have completed.
      }
      throw error
    }
    input.injectFault?.('after-commit')
    const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined
    if (checkpoint?.busy !== 0 || checkpoint.log !== 0 || checkpoint.checkpointed !== 0) {
      throw new Error('daemon profile bootstrap checkpoint did not complete')
    }
    database.close()
    database = undefined
    await reservation.sync()
    await assertBootstrapDirectories(
      input.directory,
      directoryIdentity,
      stagingPath,
      stagingIdentity,
    )
    await assertPathHasIdentity(databasePath, reservedIdentity)
    await assertBootstrapSidecarsEmpty(databasePath)
    await validateDaemonProfileSchema(stagingPath, getFinalProfileSchemaManifest())
    input.injectFault?.('before-publication')
    await assertBootstrapDirectories(
      input.directory,
      directoryIdentity,
      stagingPath,
      stagingIdentity,
    )
    await assertPathHasIdentity(databasePath, reservedIdentity)
    // link is exclusive: an existing final file or symlink is never overwritten.
    await link(databasePath, finalDatabasePath)
    published = true
    input.injectFault?.('after-publication')
    await assertPathHasIdentity(finalDatabasePath, reservedIdentity)
    await directoryHandle.sync()
    await removeBootstrapStaging(
      input.directory,
      directoryIdentity,
      stagingPath,
      stagingIdentity,
      databasePath,
      reservedIdentity,
      ownedSidecarIdentities,
    )
    await directoryHandle.sync()
    await validateDaemonProfileSchema(input.directory, getFinalProfileSchemaManifest())
    return {
      walletScopeId: walletIdentity.walletScopeId,
      nostrPublicKeyHex: secrets.nostrPublicKeyHex,
      rpcToken,
    }
  } catch (error) {
    try {
      database?.close()
    } catch {
      // Preserve the initiating failure; cleanup below remains identity-bound.
    }
    if (directoryIdentity !== undefined && stagingIdentity !== undefined) {
      try {
        await assertBootstrapDirectories(
          input.directory,
          directoryIdentity,
          stagingPath,
          stagingIdentity,
        )
        if (published) {
          await assertPathHasIdentity(finalDatabasePath, reservedIdentity!)
          await directoryHandle?.sync()
        } else if (createdConfigRevision !== null) {
          // Keep the exclusive marker until our config cleanup has completed.
          removeNativeConfigIfRevisionMatches(createdConfigRevision, input.directory)
        }
        await removeBootstrapStaging(
          input.directory,
          directoryIdentity,
          stagingPath,
          stagingIdentity,
          databasePath,
          reservedIdentity,
          ownedSidecarIdentities,
        )
        await directoryHandle?.sync()
      } catch {
        // A changed path or retained staging artifact remains a fail-closed marker.
      }
    }
    // After publication the complete profile and its config belong to the user.
    if (!published && createdDirectory && directoryIdentity !== undefined) {
      try {
        await assertDirectoryHasIdentity(input.directory, directoryIdentity)
        if ((await readdir(input.directory)).length === 0) await rmdir(input.directory)
      } catch {
        // Never broaden cleanup beyond the directory created by this call.
      }
    }
    throw error
  } finally {
    await reservation?.close().catch(() => undefined)
    await stagingHandle?.close().catch(() => undefined)
    await directoryHandle?.close().catch(() => undefined)
  }
}

interface BootstrapIdentity {
  readonly dev: bigint
  readonly ino: bigint
}

async function openBootstrapDirectory(path: string) {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
}

async function assertDirectoryHasIdentity(
  path: string,
  identity: BootstrapIdentity,
): Promise<void> {
  const current = await lstat(path, { bigint: true })
  if (
    !current.isDirectory() ||
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    current.uid !== BigInt(process.getuid!()) ||
    (current.mode & 0o777n) !== 0o700n
  ) {
    throw new Error('daemon profile bootstrap directory identity changed')
  }
}

async function assertBootstrapDirectories(
  directory: string,
  directoryIdentity: BootstrapIdentity,
  staging: string,
  stagingIdentity: BootstrapIdentity,
): Promise<void> {
  await assertDirectoryHasIdentity(directory, directoryIdentity)
  await assertDirectoryHasIdentity(staging, stagingIdentity)
}

async function assertBootstrapSidecarsEmpty(databasePath: string): Promise<void> {
  for (const path of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      const current = await lstat(path)
      if (!current.isFile() || current.size !== 0) {
        throw new Error('daemon profile bootstrap sidecar remains after checkpoint')
      }
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
}

async function removeBootstrapStaging(
  directory: string,
  directoryIdentity: BootstrapIdentity,
  staging: string,
  stagingIdentity: BootstrapIdentity,
  databasePath: string,
  databaseIdentity: BootstrapIdentity | undefined,
  sidecars: ReadonlyMap<string, BootstrapIdentity> | undefined,
): Promise<void> {
  await assertBootstrapDirectories(directory, directoryIdentity, staging, stagingIdentity)
  if (databaseIdentity !== undefined) await removeOwnedPath(databasePath, databaseIdentity)
  if (sidecars !== undefined) {
    for (const [path, identity] of sidecars) await removeOwnedPath(path, identity)
  }
  await assertBootstrapDirectories(directory, directoryIdentity, staging, stagingIdentity)
  await rmdir(staging)
}

function prepareBootstrapConfig(
  directory: string,
  engineUrl: string,
  mintUrl: string,
): string | null {
  const defaults = defaultNativeConfig()
  const result = ensureNativeConfig(
    {
      ...defaults,
      daemon: { ...defaults.daemon, engineUrl, mintUrl, mintUrls: [mintUrl] },
    },
    directory,
  )
  return result.created ? result.snapshot.revision : null
}

export async function readBootstrappedProfileSecrets(
  directory: string,
  passphrase?: string,
): Promise<InitialProfileSecrets> {
  await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
  const database = openImmutableProfileDatabase(directory)
  try {
    return readProfileSecretAuthority(database, passphrase)
  } finally {
    database.close()
  }
}

/** Reads and validates the secret/public binding inside an existing transaction. */
export function readProfileSecretAuthority(
  database: DatabaseSync,
  passphrase?: string,
): InitialProfileSecrets {
  const row = database
    .prepare(
      `SELECT secrets.wallet_scope_id AS walletScopeId,
          secrets.nostr_public_key_hex AS nostrPublicKeyHex,
          secrets.protection, secrets.kdf, secrets.salt, secrets.iv,
          secrets.auth_tag AS authTag, secrets.secret_body AS body,
          profile.wallet_scope_id AS profileWalletScopeId,
          profile.nostr_public_key_hex AS profileNostrPublicKeyHex,
          scope.wallet_id AS walletId,
          scope.wallet_seed_digest AS walletSeedDigest
         FROM daemon_secret_authority AS secrets
         JOIN daemon_profile AS profile ON profile.singleton = secrets.singleton
         JOIN custody_scopes AS scope
           ON scope.scope_id = profile.wallet_scope_id
         WHERE secrets.singleton = 1`,
    )
    .get() as SecretAuthorityRow | undefined
  if (row === undefined) throw new Error('daemon secret authority is missing')
  const secrets = unlockInitialProfileSecrets(
    protectedBodyFromRow(row),
    row.walletScopeId,
    row.nostrPublicKeyHex,
    passphrase,
  )
  const derived = deriveWalletIdentity(secrets.walletSeedHex)
  if (
    row.walletScopeId !== row.profileWalletScopeId ||
    row.nostrPublicKeyHex !== row.profileNostrPublicKeyHex ||
    row.walletScopeId !== derived.walletScopeId ||
    row.walletId !== derived.walletId ||
    row.walletSeedDigest !== derived.walletSeedDigest
  ) {
    throw new ProfileSecretProtectionError('secret-binding-mismatch')
  }
  return secrets
}

export async function readBootstrappedRpcToken(directory: string): Promise<string> {
  await validateDaemonProfileSchema(directory, getFinalProfileSchemaManifest())
  const database = openImmutableProfileDatabase(directory)
  try {
    return readProfileRpcTokenAuthority(database)
  } finally {
    database.close()
  }
}

export function readLiveBootstrappedRpcToken(directory: string): Promise<string> {
  return withValidatedDaemonProfileReadSnapshot(
    directory,
    getFinalProfileSchemaManifest(),
    readProfileRpcTokenAuthority,
  )
}

function readProfileRpcTokenAuthority(database: DatabaseSync): string {
  const row = database.prepare('SELECT token FROM daemon_rpc_token WHERE singleton = 1').get() as
    | { token: string }
    | undefined
  if (row === undefined || !/^[A-Za-z0-9_-]{43}$/.test(row.token)) {
    throw new Error('daemon RPC token is invalid')
  }
  return row.token
}

function configureWritableProfileConnection(database: DatabaseSync): void {
  const journal = database.prepare('PRAGMA journal_mode = WAL').get() as
    | { journal_mode: string }
    | undefined
  if (journal?.journal_mode.toLowerCase() !== 'wal') {
    throw new Error('daemon profile WAL mode is required')
  }
  database.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `)
}

function openImmutableProfileDatabase(directory: string): DatabaseSync {
  const url = pathToFileURL(join(directory, DAEMON_PROFILE_DATABASE))
  url.searchParams.set('mode', 'ro')
  url.searchParams.set('immutable', '1')
  return new DatabaseSync(url, {
    readOnly: true,
    allowExtension: false,
    enableDoubleQuotedStringLiterals: false,
  })
}

function writeAuthorityRows(
  database: DatabaseSync,
  input: {
    readonly walletScopeId: string
    readonly walletId: string
    readonly walletSeedDigest: string
    readonly secrets: InitialProfileSecrets
    readonly protectedSecrets: ProtectedSecretBody
    readonly rpcToken: string
    readonly initializedAtMs: number
  },
): void {
  database
    .prepare(
      `INSERT INTO custody_scopes
        (scope_id, scope_kind, wallet_id, wallet_seed_digest, created_at_ms)
       VALUES (?, 'wallet', ?, ?, ?)`,
    )
    .run(input.walletScopeId, input.walletId, input.walletSeedDigest, input.initializedAtMs)
  database
    .prepare(
      `INSERT INTO custody_scope_state
        (scope_id, fencing_epoch, owner_incarnation_id, lease_expires_at_ms,
         high_water_mark_ms)
       VALUES (?, 0, NULL, NULL, ?)`,
    )
    .run(input.walletScopeId, input.initializedAtMs)
  database
    .prepare(
      `INSERT INTO daemon_profile
        (singleton, nostr_public_key_hex, wallet_scope_id, initialized_at_ms)
       VALUES (1, ?, ?, ?)`,
    )
    .run(input.secrets.nostrPublicKeyHex, input.walletScopeId, input.initializedAtMs)
  const protectedBody = input.protectedSecrets
  database
    .prepare(
      `INSERT INTO daemon_secret_authority
        (singleton, wallet_scope_id, nostr_public_key_hex, protection, kdf,
         salt, iv, auth_tag, secret_body, created_at_ms)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.walletScopeId,
      input.secrets.nostrPublicKeyHex,
      protectedBody.protection,
      protectedBody.kdf,
      nullableBytes(protectedBody.salt),
      nullableBytes(protectedBody.iv),
      nullableBytes(protectedBody.authTag),
      Buffer.from(protectedBody.body),
      input.initializedAtMs,
    )
  database
    .prepare(
      `INSERT INTO daemon_rpc_token (singleton, token, created_at_ms)
       VALUES (1, ?, ?)`,
    )
    .run(input.rpcToken, input.initializedAtMs)
  database
    .prepare(
      `INSERT INTO daemon_oracle_nonce_allocator (singleton, next_nonce_index)
       VALUES (1, 0)`,
    )
    .run()
  new NativeActivitySqlite(database).initialize(randomUUID())
  database
    .prepare(
      `INSERT INTO profile_schema_marker
        (singleton, schema_name, schema_version, initialized_at_ms)
       VALUES (1, 'bitcaster-daemon-profile', ?, ?)`,
    )
    .run(FINAL_PROFILE_SCHEMA_VERSION, input.initializedAtMs)
}

async function removeOwnedPath(
  path: string,
  ownedIdentity: { readonly dev: bigint; readonly ino: bigint },
): Promise<void> {
  try {
    const current = await lstat(path, { bigint: true })
    if (
      current.isFile() &&
      current.dev === ownedIdentity.dev &&
      current.ino === ownedIdentity.ino
    ) {
      await unlink(path)
    }
  } catch (error) {
    if (!isMissing(error)) throw error
  }
}

function deriveWalletIdentity(walletSeedHex: string): {
  readonly walletId: string
  readonly walletScopeId: string
  readonly walletSeedDigest: string
} {
  const seedBytes = Buffer.from(walletSeedHex, 'hex')
  const walletId = deriveDurableCustodyWalletId(seedBytes)
  return {
    walletId,
    walletScopeId: deriveDurableCustodyScopeId({
      scopeKind: 'wallet',
      walletId,
    }),
    walletSeedDigest: createHash('sha256').update(seedBytes).digest('hex'),
  }
}

function exactTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('daemon profile timestamp is invalid')
  }
  return value
}

function nullableBytes(value: Uint8Array | null): Buffer | null {
  return value === null ? null : Buffer.from(value)
}

interface SecretAuthorityRow {
  readonly walletScopeId: string
  readonly nostrPublicKeyHex: string
  readonly protection: ProtectedSecretBody['protection']
  readonly kdf: ProtectedSecretBody['kdf']
  readonly salt: Uint8Array | null
  readonly iv: Uint8Array | null
  readonly authTag: Uint8Array | null
  readonly body: Uint8Array
  readonly profileWalletScopeId: string
  readonly profileNostrPublicKeyHex: string
  readonly walletId: string
  readonly walletSeedDigest: string
}

function protectedBodyFromRow(row: SecretAuthorityRow): ProtectedSecretBody {
  return {
    protection: row.protection,
    kdf: row.kdf,
    salt: row.salt === null ? null : Uint8Array.from(row.salt),
    iv: row.iv === null ? null : Uint8Array.from(row.iv),
    authTag: row.authTag === null ? null : Uint8Array.from(row.authTag),
    body: Uint8Array.from(row.body),
  }
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

async function assertPathHasIdentity(
  path: string,
  identity: { readonly dev: bigint; readonly ino: bigint },
): Promise<void> {
  const current = await lstat(path, { bigint: true })
  if (!current.isFile() || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error('daemon profile bootstrap inode identity changed')
  }
}

async function captureSidecarIdentities(
  databasePath: string,
): Promise<ReadonlyMap<string, { readonly dev: bigint; readonly ino: bigint }>> {
  const identities = new Map<string, { readonly dev: bigint; readonly ino: bigint }>()
  for (const path of [`${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      const current = await lstat(path, { bigint: true })
      if (!current.isFile()) {
        throw new Error('daemon profile bootstrap sidecar is not a plain file')
      }
      identities.set(path, { dev: current.dev, ino: current.ino })
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  return identities
}
