import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  randomBytes,
  scryptSync,
} from 'node:crypto'

export type SecretProtectionKind =
  | 'owner-only-plaintext'
  | 'scrypt-aes-256-gcm'

export interface ProtectedSecretBody {
  readonly protection: SecretProtectionKind
  readonly kdf: 'scrypt-v1' | null
  readonly salt: Uint8Array | null
  readonly iv: Uint8Array | null
  readonly authTag: Uint8Array | null
  readonly body: Uint8Array
}

export interface InitialProfileSecrets {
  readonly walletSeedHex: string
  readonly nostrSecretKeyHex: string
  readonly nostrPublicKeyHex: string
}

export class ProfileSecretProtectionError extends Error {
  readonly reason:
    | 'passphrase-required'
    | 'unlock-failed'
    | 'secret-binding-mismatch'
    | 'secret-body-invalid'

  constructor(reason: ProfileSecretProtectionError['reason']) {
    const messages = {
      'passphrase-required': 'daemon profile passphrase is required',
      'unlock-failed': 'daemon profile secrets could not be unlocked',
      'secret-binding-mismatch': 'daemon profile secret binding does not match',
      'secret-body-invalid': 'daemon profile secret body is invalid',
    } as const
    super(messages[reason])
    this.name = 'ProfileSecretProtectionError'
    this.reason = reason
  }
}

export function normalizeInitialProfileSecrets(input: {
  readonly walletSeedHex: string
  readonly nostrSecretKeyHex: string
  readonly nostrPublicKeyHex?: string
}): InitialProfileSecrets {
  const walletSeedHex = exactPrivateHex(input.walletSeedHex)
  const nostrSecretKeyHex = exactPrivateHex(input.nostrSecretKeyHex)
  const nostrPublicKeyHex = deriveNostrPublicKey(nostrSecretKeyHex)
  if (
    input.nostrPublicKeyHex !== undefined &&
    input.nostrPublicKeyHex !== nostrPublicKeyHex
  ) {
    throw new ProfileSecretProtectionError('secret-binding-mismatch')
  }
  return { walletSeedHex, nostrSecretKeyHex, nostrPublicKeyHex }
}

export function protectInitialProfileSecrets(
  secrets: InitialProfileSecrets,
  walletScopeId: string,
  passphrase: string | undefined,
): ProtectedSecretBody {
  const plaintext = Buffer.from(
    JSON.stringify({
      version: 1,
      walletSeedHex: secrets.walletSeedHex,
      nostrSecretKeyHex: secrets.nostrSecretKeyHex,
    }),
    'utf8',
  )
  return protectBody(
    plaintext,
    profileSecretBinding(walletScopeId, secrets.nostrPublicKeyHex),
    passphrase,
  )
}

export function unlockInitialProfileSecrets(
  protectedBody: ProtectedSecretBody,
  walletScopeId: string,
  nostrPublicKeyHex: string,
  passphrase: string | undefined,
): InitialProfileSecrets {
  const plaintext = unlockBody(
    protectedBody,
    profileSecretBinding(walletScopeId, nostrPublicKeyHex),
    passphrase,
  )
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(plaintext).toString('utf8'))
  } catch {
    throw new ProfileSecretProtectionError('secret-body-invalid')
  }
  if (
    !isExactRecord(parsed, [
      'version',
      'walletSeedHex',
      'nostrSecretKeyHex',
    ]) ||
    parsed.version !== 1 ||
    typeof parsed.walletSeedHex !== 'string' ||
    typeof parsed.nostrSecretKeyHex !== 'string'
  ) {
    throw new ProfileSecretProtectionError('secret-body-invalid')
  }
  const secrets = normalizeInitialProfileSecrets({
    walletSeedHex: parsed.walletSeedHex,
    nostrSecretKeyHex: parsed.nostrSecretKeyHex,
    nostrPublicKeyHex,
  })
  return secrets
}

export function protectTargetEphemeralPrivateKey(
  privateKeyHex: string,
  binding: {
    readonly walletScopeId: string
    readonly orderId: string
    readonly tradeId: string | null
    readonly marketId: string
    readonly publicKeyHex: string
  },
  passphrase: string | undefined,
): ProtectedSecretBody {
  return protectBody(
    Buffer.from(exactPrivateHex(privateKeyHex), 'utf8'),
    targetEphemeralBinding(binding),
    passphrase,
  )
}

export function unlockTargetEphemeralPrivateKey(
  protectedBody: ProtectedSecretBody,
  binding: {
    readonly walletScopeId: string
    readonly orderId: string
    readonly tradeId: string | null
    readonly marketId: string
    readonly publicKeyHex: string
  },
  passphrase: string | undefined,
): string {
  const privateKeyHex = Buffer.from(
    unlockBody(protectedBody, targetEphemeralBinding(binding), passphrase),
  ).toString('utf8')
  const normalized = exactPrivateHex(privateKeyHex)
  const ecdh = createECDH('secp256k1')
  try {
    ecdh.setPrivateKey(Buffer.from(normalized, 'hex'))
  } catch {
    throw new ProfileSecretProtectionError('secret-body-invalid')
  }
  if (ecdh.getPublicKey('hex', 'compressed') !== binding.publicKeyHex) {
    throw new ProfileSecretProtectionError('secret-binding-mismatch')
  }
  return normalized
}

function protectBody(
  plaintext: Uint8Array,
  binding: Uint8Array,
  passphrase: string | undefined,
): ProtectedSecretBody {
  if (passphrase === undefined || passphrase.length === 0) {
    return {
      protection: 'owner-only-plaintext',
      kdf: null,
      salt: null,
      iv: null,
      authTag: null,
      body: Uint8Array.from(plaintext),
    }
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv(
    'aes-256-gcm',
    scryptSync(passphrase, salt, 32),
    iv,
  )
  cipher.setAAD(binding)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    protection: 'scrypt-aes-256-gcm',
    kdf: 'scrypt-v1',
    salt,
    iv,
    authTag: cipher.getAuthTag(),
    body,
  }
}

function unlockBody(
  protectedBody: ProtectedSecretBody,
  binding: Uint8Array,
  passphrase: string | undefined,
): Uint8Array {
  if (protectedBody.protection === 'owner-only-plaintext') {
    if (
      protectedBody.kdf !== null ||
      protectedBody.salt !== null ||
      protectedBody.iv !== null ||
      protectedBody.authTag !== null
    ) {
      throw new ProfileSecretProtectionError('secret-body-invalid')
    }
    return Uint8Array.from(protectedBody.body)
  }
  if (!passphrase) {
    throw new ProfileSecretProtectionError('passphrase-required')
  }
  if (
    protectedBody.kdf !== 'scrypt-v1' ||
    protectedBody.salt?.length !== 16 ||
    protectedBody.iv?.length !== 12 ||
    protectedBody.authTag?.length !== 16
  ) {
    throw new ProfileSecretProtectionError('secret-body-invalid')
  }
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      scryptSync(passphrase, protectedBody.salt, 32),
      protectedBody.iv,
    )
    decipher.setAAD(binding)
    decipher.setAuthTag(protectedBody.authTag)
    return Buffer.concat([
      decipher.update(protectedBody.body),
      decipher.final(),
    ])
  } catch {
    throw new ProfileSecretProtectionError('unlock-failed')
  }
}

function profileSecretBinding(
  walletScopeId: string,
  nostrPublicKeyHex: string,
): Uint8Array {
  return Buffer.from(
    `bitcaster-daemon/profile-secrets/v1\0${walletScopeId}\0${nostrPublicKeyHex}`,
    'utf8',
  )
}

function targetEphemeralBinding(binding: {
  readonly walletScopeId: string
  readonly orderId: string
  readonly tradeId: string | null
  readonly marketId: string
  readonly publicKeyHex: string
}): Uint8Array {
  return Buffer.from(
    [
      'bitcaster-daemon/target-ephemeral/v1',
      binding.walletScopeId,
      binding.orderId,
      binding.tradeId ?? '',
      binding.marketId,
      binding.publicKeyHex,
    ].join('\0'),
    'utf8',
  )
}

function exactPrivateHex(value: string): string {
  const normalized = value.trim().replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new ProfileSecretProtectionError('secret-body-invalid')
  }
  return normalized
}

function deriveNostrPublicKey(privateKeyHex: string): string {
  const ecdh = createECDH('secp256k1')
  try {
    ecdh.setPrivateKey(Buffer.from(privateKeyHex, 'hex'))
  } catch {
    throw new ProfileSecretProtectionError('secret-body-invalid')
  }
  return ecdh.getPublicKey(undefined, 'compressed').subarray(1).toString('hex')
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).sort().join('\0') ===
      [...keys].sort().join('\0')
  )
}
