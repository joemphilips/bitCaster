import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  randomBytes,
  scryptSync,
} from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeSecp256k1PrivateKeyHex } from './ephemeralKey.ts'
import { ensureProfileDir, profileDir } from './profile.ts'

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
  return join(profileDir(), 'daemon-secrets.json')
}

let secretsUpdateQueue: Promise<unknown> = Promise.resolve()
let secretsWriteSequence = 0

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
  return withSecretsUpdateLock(async () => {
    const latest = await readSecrets()
    if (latest) return latest
    const fresh = createDaemonSecrets()
    await writeSecrets(fresh)
    return fresh
  })
}

export async function readSecrets(): Promise<DaemonSecrets | null> {
  try {
    const file = JSON.parse(await readFile(secretsPath(), 'utf8')) as SecretFile
    if (file.protection === 'file-mode-0600') {
      return normalizeSecrets(file.secrets)
    }
    return decryptSecrets(file)
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

export async function writeSecrets(secrets: DaemonSecrets): Promise<void> {
  const dir = await ensureProfileDir()
  const target = secretsPath()
  const sequence = ++secretsWriteSequence
  const tmp = join(
    dir,
    `.daemon-secrets.${process.pid}.${Date.now()}.${sequence}.tmp`,
  )
  const file = encodeSecrets(secrets)
  await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 })
  await rename(tmp, target)
}

export async function updateSecrets<T>(
  update: (secrets: DaemonSecrets, now: string) => T,
): Promise<T> {
  return withSecretsUpdateLock(async () => {
    const secrets = (await readSecrets()) ?? createDaemonSecrets()
    const result = update(secrets, new Date().toISOString())
    await writeSecrets(secrets)
    return result
  })
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

function normalizeSecrets(secrets: Partial<DaemonSecrets>): DaemonSecrets {
  if (
    !secrets.walletSeedHex ||
    !secrets.nostrSecretKeyHex ||
    !secrets.nostrPublicKeyHex ||
    !secrets.createdAt
  ) {
    throw new Error('daemon secrets file is malformed')
  }
  const nostrSecretKeyHex = normalizeNostrSecretKeyHex(secrets.nostrSecretKeyHex)
  return {
    walletSeedHex: normalizeHexSecret(secrets.walletSeedHex, 'wallet seed'),
    nostrSecretKeyHex,
    nostrPublicKeyHex: secrets.nostrPublicKeyHex,
    orderEphemeralKeys: secrets.orderEphemeralKeys ?? {},
    createdAt: secrets.createdAt,
  }
}
