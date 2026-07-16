import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { EncryptedWalletBackupAccountAuthorizationPort } from './encryptedWalletBackupEnrollment.ts'
import {
  decodeEncryptedWalletBackupAccountRequest,
  type DecodedEncryptedWalletBackupAccountAction,
  type DecodedEncryptedWalletBackupAccountRequest,
} from './encryptedWalletBackupServerCodec.ts'

export const ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE = 'nip98-backup-intent-v1'

const NIP98_KIND = 27_235
const MAX_EVENT_AGE_SECONDS = 60
const MAX_AUTHORIZATION_BYTES = 16 * 1_024

export interface EncryptedWalletBackupNostrEventTemplate {
  readonly kind: 27_235
  readonly createdAtUnixSeconds: number
  readonly tags: readonly (readonly string[])[]
  readonly content: ''
}

export interface EncryptedWalletBackupSignedNostrEvent {
  readonly id: string
  readonly pubkey: string
  readonly createdAtUnixSeconds: number
  readonly kind: number
  readonly tags: readonly (readonly string[])[]
  readonly content: string
  readonly signature: string
}

export interface EncryptedWalletBackupNostrEventSigner {
  signEvent(
    template: EncryptedWalletBackupNostrEventTemplate,
  ): Promise<EncryptedWalletBackupSignedNostrEvent>
}

export interface VerifiedEncryptedWalletBackupAccountAuthorization {
  readonly authorizationScheme: typeof ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE
  readonly ownerSubject: string
}

export interface AuthenticatedEncryptedWalletBackupAccountRequest extends VerifiedEncryptedWalletBackupAccountAuthorization {
  readonly request: DecodedEncryptedWalletBackupAccountRequest
}

export function createEncryptedWalletBackupNip98AccountAuthorizationPort(input: {
  signer: EncryptedWalletBackupNostrEventSigner
  clock?: () => number
}): EncryptedWalletBackupAccountAuthorizationPort {
  if (
    typeof input.signer !== 'object' ||
    input.signer === null ||
    typeof input.signer.signEvent !== 'function'
  ) {
    throw new Error('encrypted backup account signer is invalid')
  }
  const clock = input.clock ?? (() => Math.floor(Date.now() / 1_000))
  if (typeof clock !== 'function') {
    throw new Error('encrypted backup account clock is invalid')
  }
  const port: EncryptedWalletBackupAccountAuthorizationPort = {
    async authorizeBackupAccountOperation(
      operation: Parameters<
        EncryptedWalletBackupAccountAuthorizationPort['authorizeBackupAccountOperation']
      >[0],
    ) {
      const createdAtUnixSeconds = requireTimestamp(clock(), 'account authorization issue time')
      const template = Object.freeze({
        kind: NIP98_KIND,
        createdAtUnixSeconds,
        tags: Object.freeze([
          Object.freeze(['u', operation.url]),
          Object.freeze(['method', operation.method]),
          Object.freeze(['backup-intent', operation.intentDigest]),
        ]),
        content: '' as const,
      })
      const signed = await input.signer.signEvent(template)
      const authorization = encodeAndValidateSignedEvent(signed, {
        expectedCreatedAtUnixSeconds: createdAtUnixSeconds,
        expectedUrl: operation.url,
        expectedMethod: operation.method,
        expectedIntentDigest: operation.intentDigest,
      })
      return {
        scheme: ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE,
        authorization,
      }
    },
  }
  return Object.freeze(port)
}

export function authenticateEncryptedWalletBackupNip98AccountRequest(input: {
  canonicalRequest: Uint8Array
  expectedAction: DecodedEncryptedWalletBackupAccountAction
  expectedRealm: string
  expectedRouteVaultId: string | null
  actualUrl: string
  actualMethod: 'POST' | 'DELETE'
  serverNowUnixSeconds: number
}): AuthenticatedEncryptedWalletBackupAccountRequest {
  try {
    const request = decodeEncryptedWalletBackupAccountRequest(input.canonicalRequest)
    if (
      request.authorizationScheme !== ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE ||
      request.intent.action !== input.expectedAction ||
      request.intent.realm !== input.expectedRealm ||
      request.intent.url !== requireExactHttpsUrl(input.actualUrl) ||
      request.intent.method !== requireMethod(input.actualMethod) ||
      (request.intent.action === 'enroll') !== (input.expectedRouteVaultId === null) ||
      (input.expectedRouteVaultId === null
        ? false
        : request.intent.vaultId !==
          requireLowerHex(input.expectedRouteVaultId, 32, 'route vault id'))
    ) {
      throw new Error()
    }
    const event = decodeCanonicalSignedEvent(request.authorization)
    validateSignedEvent(event, {
      expectedCreatedAtUnixSeconds: null,
      expectedUrl: request.intent.url,
      expectedMethod: request.intent.method,
      expectedIntentDigest: request.intentDigest,
    })
    const now = requireTimestamp(input.serverNowUnixSeconds, 'server time')
    if (Math.abs(now - event.createdAtUnixSeconds) > MAX_EVENT_AGE_SECONDS) {
      throw new Error()
    }
    return Object.freeze({
      authorizationScheme: ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE,
      ownerSubject: event.pubkey,
      request,
    })
  } catch {
    throw new Error('encrypted backup account authorization failed')
  }
}

function encodeAndValidateSignedEvent(
  value: EncryptedWalletBackupSignedNostrEvent,
  expected: ExpectedEvent,
): Uint8Array {
  validateSignedEvent(value, expected)
  return encodeCanonicalSignedEvent(value)
}

interface ExpectedEvent {
  readonly expectedCreatedAtUnixSeconds: number | null
  readonly expectedUrl: string
  readonly expectedMethod: 'POST' | 'DELETE'
  readonly expectedIntentDigest: string
}

function validateSignedEvent(
  value: EncryptedWalletBackupSignedNostrEvent,
  expected: ExpectedEvent,
): void {
  const event = requireSignedEvent(value)
  if (
    event.kind !== NIP98_KIND ||
    event.content !== '' ||
    (expected.expectedCreatedAtUnixSeconds !== null &&
      event.createdAtUnixSeconds !== expected.expectedCreatedAtUnixSeconds) ||
    !equalTags(event.tags, [
      ['u', expected.expectedUrl],
      ['method', expected.expectedMethod],
      ['backup-intent', expected.expectedIntentDigest],
    ])
  ) {
    throw new Error('encrypted backup signed account event is invalid')
  }
  const computedId = computeEventId(event)
  if (
    event.id !== computedId ||
    !schnorr.verify(hexToBytes(event.signature), hexToBytes(event.id), hexToBytes(event.pubkey))
  ) {
    throw new Error('encrypted backup signed account event is invalid')
  }
}

function decodeCanonicalSignedEvent(
  authorization: Uint8Array,
): EncryptedWalletBackupSignedNostrEvent {
  const bytes = requireBytes(authorization, 1, MAX_AUTHORIZATION_BYTES, 'account authorization')
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw new Error('encrypted backup account event is invalid')
  }
  const event = requireSignedEvent(parsed)
  if (!equalBytes(bytes, encodeCanonicalSignedEvent(event))) {
    throw new Error('encrypted backup account event is invalid')
  }
  return event
}

function encodeCanonicalSignedEvent(value: EncryptedWalletBackupSignedNostrEvent): Uint8Array {
  const event = requireSignedEvent(value)
  return new TextEncoder().encode(
    JSON.stringify({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.createdAtUnixSeconds,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.signature,
    }),
  )
}

function requireSignedEvent(value: unknown): EncryptedWalletBackupSignedNostrEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('encrypted backup signed account event is invalid')
  }
  const raw = value as Record<string, unknown>
  const serializedShape =
    'created_at' in raw || 'sig' in raw
      ? {
          id: raw.id,
          pubkey: raw.pubkey,
          createdAtUnixSeconds: raw.created_at,
          kind: raw.kind,
          tags: raw.tags,
          content: raw.content,
          signature: raw.sig,
        }
      : raw
  const fields = ['id', 'pubkey', 'createdAtUnixSeconds', 'kind', 'tags', 'content', 'signature']
  if (Object.keys(serializedShape).some((field) => !fields.includes(field))) {
    throw new Error('encrypted backup signed account event is invalid')
  }
  const event = serializedShape as Record<string, unknown>
  return Object.freeze({
    id: requireLowerHex(event.id, 32, 'event id'),
    pubkey: requireLowerHex(event.pubkey, 32, 'event public key'),
    createdAtUnixSeconds: requireTimestamp(event.createdAtUnixSeconds, 'event issue time'),
    kind: requireInteger(event.kind, 0, Number.MAX_SAFE_INTEGER, 'event kind'),
    tags: requireTags(event.tags),
    content: requireString(event.content, 0, 0, 'event content'),
    signature: requireLowerHex(event.signature, 64, 'event signature'),
  })
}

function computeEventId(event: EncryptedWalletBackupSignedNostrEvent): string {
  return bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([
          0,
          event.pubkey,
          event.createdAtUnixSeconds,
          event.kind,
          event.tags,
          event.content,
        ]),
      ),
    ),
  )
}

function requireTags(value: unknown): readonly (readonly string[])[] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error('encrypted backup account event tags are invalid')
  }
  return Object.freeze(
    value.map((tag) => {
      if (!Array.isArray(tag) || tag.length !== 2) {
        throw new Error('encrypted backup account event tag is invalid')
      }
      return Object.freeze([
        requireString(tag[0], 1, 64, 'event tag name'),
        requireString(tag[1], 1, 2_048, 'event tag value'),
      ])
    }),
  )
}

function equalTags(
  left: readonly (readonly string[])[],
  right: readonly (readonly string[])[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (tag, index) =>
        tag.length === right[index]!.length &&
        tag.every((value, item) => value === right[index]![item]),
    )
  )
}

function requireMethod(value: unknown): 'POST' | 'DELETE' {
  if (value !== 'POST' && value !== 'DELETE') {
    throw new Error('encrypted backup account method is invalid')
  }
  return value
}

function requireExactHttpsUrl(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2_048 ||
    /[^\x21-\x7e]/.test(value)
  ) {
    throw new Error('encrypted backup account URL is invalid')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('encrypted backup account URL is invalid')
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.hash !== '' ||
    parsed.href !== value
  ) {
    throw new Error('encrypted backup account URL is invalid')
  }
  return value
}

function requireTimestamp(value: unknown, name: string): number {
  return requireInteger(value, 0, Number.MAX_SAFE_INTEGER, name)
}

function requireInteger(value: unknown, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value as number
}

function requireString(value: unknown, minimum: number, maximum: number, name: string): string {
  if (
    typeof value !== 'string' ||
    new TextEncoder().encode(value).byteLength < minimum ||
    new TextEncoder().encode(value).byteLength > maximum
  ) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireLowerHex(value: unknown, bytes: number, name: string): string {
  if (typeof value !== 'string' || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`).test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function requireBytes(value: unknown, minimum: number, maximum: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < minimum || value.byteLength > maximum) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!
  }
  return difference === 0
}
