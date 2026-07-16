import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import {
  createEncryptedWalletBackupKeyHandle,
  type EncryptedWalletBackupRuntime,
} from '../src/encryptedWalletBackup.ts'
import { prepareEncryptedWalletBackupAccountOperation } from '../src/encryptedWalletBackupEnrollment.ts'
import {
  ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE,
  authenticateEncryptedWalletBackupNip98AccountRequest,
  createEncryptedWalletBackupNip98AccountAuthorizationPort,
  type EncryptedWalletBackupNostrEventTemplate,
  type EncryptedWalletBackupSignedNostrEvent,
} from '../src/encryptedWalletBackupNip98AccountAuthorization.ts'
import {
  decodeEncryptedWalletBackupAccountIntent,
  decodeEncryptedWalletBackupAccountRequest,
  requireEncryptedWalletBackupAuthorizationScheme,
} from '../src/encryptedWalletBackupServerCodec.ts'
import { encodeCanonicalBackupCbor } from '../src/encryptedWalletBackupCbor.ts'

const NOW = 1_800_000_000
const ACCOUNT_URL = 'https://backup.example/v1/encrypted-wallet-backup/realms/test/vaults:enroll'
const PRIVATE_KEY = hexToBytes('31'.repeat(32))
const PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(PRIVATE_KEY))

test('account authorization binds the exact canonical intent', async () => {
  const operation = await prepareOperation()
  const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
  const vector = await readVector()
  assert.equal(bytesToHex(decoded.canonicalIntent), vector.expected.canonicalIntentHex)
  assert.equal(decoded.intentDigest, vector.expected.intentDigest)
  assert.equal(new TextDecoder().decode(decoded.authorization), vector.expected.authorizationJson)
  assert.equal(
    bytesToHex(sha256(operation.canonicalRequest)),
    vector.expected.canonicalRequestDigest,
  )
  const event = JSON.parse(new TextDecoder().decode(decoded.authorization)) as {
    id: string
    pubkey: string
    sig: string
  }
  assert.equal(event.id, vector.expected.eventId)
  assert.equal(event.pubkey, vector.expected.ownerSubject)
  assert.equal(event.sig, vector.expected.signature)

  assert.equal(decoded.authorizationScheme, ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE)
  assert.equal(decoded.intent.action, 'enroll')
  assert.equal(decoded.intent.method, 'POST')
  assert.equal(decoded.intent.url, ACCOUNT_URL)
  assert.equal(decoded.intent.realm, 'test')
  assert.equal(decoded.intentDigest, operation.intentDigest)

  const verified = authenticateEncryptedWalletBackupNip98AccountRequest({
    canonicalRequest: operation.canonicalRequest,
    expectedAction: 'enroll',
    expectedRealm: 'test',
    expectedRouteVaultId: null,
    actualUrl: ACCOUNT_URL,
    actualMethod: 'POST',
    serverNowUnixSeconds: NOW,
  })
  assert.deepEqual(
    {
      authorizationScheme: verified.authorizationScheme,
      ownerSubject: verified.ownerSubject,
    },
    {
      authorizationScheme: ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE,
      ownerSubject: PUBLIC_KEY,
    },
  )
})

test('account request decoder rejects an intent digest substitution', async () => {
  const operation = await prepareOperation()
  const tuple = decode(operation.canonicalRequest)
  assert.ok(Array.isArray(tuple))
  tuple[3] = new Uint8Array(32)
  const request = encodeCanonicalBackupCbor(tuple)

  assert.throws(() => decodeEncryptedWalletBackupAccountRequest(request), /account request/)
})

test('account authorization rejects a different intent', async () => {
  const operation = await prepareOperation()
  const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
  const changedIntent = decoded.canonicalIntent.slice()
  changedIntent[changedIntent.byteLength - 1] ^= 1
  const tuple = decode(operation.canonicalRequest)
  assert.ok(Array.isArray(tuple))
  tuple[2] = changedIntent
  tuple[3] = sha256(changedIntent)

  assert.throws(
    () =>
      authenticateEncryptedWalletBackupNip98AccountRequest({
        canonicalRequest: encodeCanonicalBackupCbor(tuple),
        expectedAction: 'enroll',
        expectedRealm: 'test',
        expectedRouteVaultId: null,
        actualUrl: ACCOUNT_URL,
        actualMethod: 'POST',
        serverNowUnixSeconds: NOW,
      }),
    /account authorization/,
  )
})

test('account authorization rejects stale events', async () => {
  const operation = await prepareOperation()

  assert.throws(
    () =>
      authenticateEncryptedWalletBackupNip98AccountRequest({
        canonicalRequest: operation.canonicalRequest,
        expectedAction: 'enroll',
        expectedRealm: 'test',
        expectedRouteVaultId: null,
        actualUrl: ACCOUNT_URL,
        actualMethod: 'POST',
        serverNowUnixSeconds: NOW + 61,
      }),
    /account authorization/,
  )
})

test('account authorization rejects extra and duplicate tags', async () => {
  const operation = await prepareOperation()
  const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
  const authorization = mutateAuthorization(decoded.authorization, (tags) => [
    ...tags,
    ['backup-intent', '00'.repeat(32)],
  ])

  assert.throws(
    () => authenticateWithAuthorization(operation.canonicalRequest, authorization),
    /account authorization/,
  )
})

test('account authorization rejects the standard payload tag', async () => {
  const operation = await prepareOperation()
  const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
  const authorization = mutateAuthorization(decoded.authorization, (tags) => [
    ...tags,
    ['payload', '00'.repeat(32)],
  ])

  assert.throws(
    () => authenticateWithAuthorization(operation.canonicalRequest, authorization),
    /account authorization/,
  )
})

test('account authorization rejects noncanonical JSON', async () => {
  const operation = await prepareOperation()
  const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
  const parsed = JSON.parse(new TextDecoder().decode(decoded.authorization))
  const noncanonical = new TextEncoder().encode(JSON.stringify(parsed, null, 2))

  assert.throws(
    () => authenticateWithAuthorization(operation.canonicalRequest, noncanonical),
    /account authorization/,
  )
})

test('account authentication rejects intent and HTTP URL confusion', async () => {
  const operation = await prepareOperation()
  const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
  const actualUrl =
    'https://backup.example/v1/encrypted-wallet-backup/realms/test/vaults:enroll?attempt=1'
  const authorization = mutateAuthorization(decoded.authorization, (tags) => [
    ['u', actualUrl],
    tags[1]!,
    tags[2]!,
  ])

  assert.throws(
    () =>
      authenticateWithAuthorization(operation.canonicalRequest, authorization, {
        actualUrl,
      }),
    /account authorization/,
  )
})

test('account authentication rejects intent and HTTP method confusion', async () => {
  const operation = await prepareOperation()
  const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
  const authorization = mutateAuthorization(decoded.authorization, (tags) => [
    tags[0]!,
    ['method', 'DELETE'],
    tags[2]!,
  ])

  assert.throws(
    () =>
      authenticateWithAuthorization(operation.canonicalRequest, authorization, {
        actualMethod: 'DELETE',
      }),
    /account authorization/,
  )
})

test('account authentication accepts exact revoke and delete routes', async () => {
  for (const action of ['revoke', 'delete'] as const) {
    const operation = await prepareOperation({ action })
    const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
    const authenticated = authenticateEncryptedWalletBackupNip98AccountRequest({
      canonicalRequest: operation.canonicalRequest,
      expectedAction: action,
      expectedRealm: 'test',
      expectedRouteVaultId: decoded.intent.vaultId,
      actualUrl: decoded.intent.url,
      actualMethod: action === 'delete' ? 'DELETE' : 'POST',
      serverNowUnixSeconds: NOW,
    })
    assert.equal(authenticated.ownerSubject, PUBLIC_KEY)
  }
})

test('account intent rejects an invalid delegated public key', async () => {
  const operation = await prepareOperation()
  const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
  const tuple = decode(decoded.canonicalIntent)
  assert.ok(Array.isArray(tuple))
  tuple[7] = new Uint8Array(32)

  assert.throws(
    () => decodeEncryptedWalletBackupAccountIntent(encodeCanonicalBackupCbor(tuple)),
    /public key/,
  )
})

test('authorization scheme uses one strict client/server grammar', () => {
  assert.equal(
    requireEncryptedWalletBackupAuthorizationScheme(ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE),
    ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE,
  )
  for (const invalid of ['1scheme', 'scheme-', 'scheme.', 'UPPER', '']) {
    assert.throws(() => requireEncryptedWalletBackupAuthorizationScheme(invalid), /scheme/)
  }
})

test('account authorization rejects corrupted signed-event fields', async () => {
  const operation = await prepareOperation()
  const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
  for (const mutate of [
    (event: Record<string, unknown>) => {
      event.id = '00'.repeat(32)
    },
    (event: Record<string, unknown>) => {
      event.sig = '00'.repeat(64)
    },
    (event: Record<string, unknown>) => {
      event.pubkey = '00'.repeat(32)
    },
    (event: Record<string, unknown>) => {
      event.unknown = 'rejected'
    },
  ]) {
    const authorization = mutateCanonicalAuthorization(decoded.authorization, mutate)
    assert.throws(
      () => authenticateWithAuthorization(operation.canonicalRequest, authorization),
      /account authorization/,
    )
  }
})

test('account authorization rejects future events and reordered tags', async () => {
  const operation = await prepareOperation()
  const decoded = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)
  const future = mutateAndResignAuthorization(decoded.authorization, (event) => {
    event.created_at = NOW + 61
  })
  const reordered = mutateAndResignAuthorization(decoded.authorization, (event) => {
    ;[event.tags[0], event.tags[1]] = [event.tags[1]!, event.tags[0]!]
  })
  for (const authorization of [future, reordered]) {
    assert.throws(
      () => authenticateWithAuthorization(operation.canonicalRequest, authorization),
      /account authorization/,
    )
  }
})

test('account request rejects hostile nested CBOR before semantic decoding', () => {
  let nested: unknown = new Uint8Array([1])
  for (let depth = 0; depth < 100; depth += 1) nested = [nested]
  const hostile = encodeCanonicalBackupCbor([
    1,
    'backup-account-request',
    nested,
    new Uint8Array(32),
    ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE,
    new Uint8Array([1]),
  ])

  assert.throws(() => decodeEncryptedWalletBackupAccountRequest(hostile), /cbor|account request/)
})

async function prepareOperation(input?: { action?: 'enroll' | 'revoke' | 'delete' }) {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: new Uint8Array(64).fill(7),
    realm: 'test',
    runtime: deterministicRuntime(),
  })
  const authorizationPort = createEncryptedWalletBackupNip98AccountAuthorizationPort({
    clock: () => NOW,
    signer: {
      signEvent: (template) => Promise.resolve(signEvent(template)),
    },
  })
  const action = input?.action ?? 'enroll'
  const url =
    action === 'enroll'
      ? ACCOUNT_URL
      : action === 'revoke'
        ? `https://backup.example/v1/encrypted-wallet-backup/realms/test/vaults/${keyHandle.vaultId}:revoke`
        : `https://backup.example/v1/encrypted-wallet-backup/realms/test/vaults/${keyHandle.vaultId}`
  return prepareEncryptedWalletBackupAccountOperation({
    keyHandle,
    action,
    url,
    operationId: '22'.repeat(16),
    expectedEnrollmentEpoch: action === 'enroll' ? 0 : 1,
    authorizationPort,
    signal: new AbortController().signal,
  })
}

function mutateAuthorization(
  authorization: Uint8Array,
  mutateTags: (tags: string[][]) => string[][],
): Uint8Array {
  return mutateAndResignAuthorization(authorization, (event) => {
    event.tags = mutateTags(event.tags)
  })
}

type MutableSignedEvent = {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

function mutateCanonicalAuthorization(
  authorization: Uint8Array,
  mutate: (event: Record<string, unknown>) => void,
): Uint8Array {
  const event = JSON.parse(new TextDecoder().decode(authorization)) as Record<string, unknown>
  mutate(event)
  return new TextEncoder().encode(JSON.stringify(event))
}

function mutateAndResignAuthorization(
  authorization: Uint8Array,
  mutate: (event: MutableSignedEvent) => void,
): Uint8Array {
  const event = JSON.parse(new TextDecoder().decode(authorization)) as MutableSignedEvent
  mutate(event)
  resignEvent(event)
  return new TextEncoder().encode(JSON.stringify(event))
}

function resignEvent(event: MutableSignedEvent): void {
  const id = bytesToHex(
    sha256(
      new TextEncoder().encode(
        JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]),
      ),
    ),
  )
  event.id = id
  event.sig = bytesToHex(schnorr.sign(hexToBytes(id), PRIVATE_KEY, new Uint8Array(32)))
}

function authenticateWithAuthorization(
  canonicalRequest: Uint8Array,
  authorization: Uint8Array,
  override?: {
    actualUrl?: string
    actualMethod?: 'POST' | 'DELETE'
    expectedRealm?: string
  },
) {
  const tuple = decode(canonicalRequest)
  assert.ok(Array.isArray(tuple))
  tuple[5] = authorization
  return authenticateEncryptedWalletBackupNip98AccountRequest({
    canonicalRequest: encodeCanonicalBackupCbor(tuple),
    expectedAction: 'enroll',
    expectedRealm: override?.expectedRealm ?? 'test',
    expectedRouteVaultId: null,
    actualUrl: override?.actualUrl ?? ACCOUNT_URL,
    actualMethod: override?.actualMethod ?? 'POST',
    serverNowUnixSeconds: NOW,
  })
}

function signEvent(
  template: EncryptedWalletBackupNostrEventTemplate,
): EncryptedWalletBackupSignedNostrEvent {
  const serialized = JSON.stringify([
    0,
    PUBLIC_KEY,
    template.createdAtUnixSeconds,
    template.kind,
    template.tags,
    template.content,
  ])
  const id = bytesToHex(sha256(new TextEncoder().encode(serialized)))
  return {
    id,
    pubkey: PUBLIC_KEY,
    createdAtUnixSeconds: template.createdAtUnixSeconds,
    kind: template.kind,
    tags: template.tags,
    content: template.content,
    signature: bytesToHex(schnorr.sign(hexToBytes(id), PRIVATE_KEY, new Uint8Array(32))),
  }
}

function deterministicRuntime(): EncryptedWalletBackupRuntime {
  return {
    subtle: webcrypto.subtle,
    getRandomValues<T extends ArrayBufferView | null>(target: T): T {
      if (target !== null) {
        new Uint8Array(target.buffer, target.byteOffset, target.byteLength).fill(9)
      }
      return target
    },
  }
}

async function readVector(): Promise<{
  expected: {
    canonicalIntentHex: string
    intentDigest: string
    authorizationJson: string
    canonicalRequestDigest: string
  }
}> {
  return JSON.parse(
    await readFile(
      new URL('../../test-vectors/encrypted-wallet-backup-account-auth-v1.json', import.meta.url),
      'utf8',
    ),
  )
}
