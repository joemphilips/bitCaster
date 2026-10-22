import assert from 'node:assert/strict'
import test from 'node:test'
import * as enrollment from '../src/encryptedWalletBackupEnrollment.ts'

test('owner identity preserves opaque subject identity and existing service bounds', () => {
  const derive = enrollment.deriveEncryptedWalletBackupOwnerScope
  const a = derive({ authorizationScheme: 'test', ownerSubject: 'Alice' })
  assert.notEqual(
    a.ownerScopeId,
    derive({ authorizationScheme: 'test', ownerSubject: 'alice' }).ownerScopeId,
  )
  assert.notEqual(
    a.ownerScopeId,
    derive({ authorizationScheme: 'other', ownerSubject: 'Alice' }).ownerScopeId,
  )
  assert.notEqual(
    derive({ authorizationScheme: 'test', ownerSubject: '\u00e9' }).ownerScopeId,
    derive({ authorizationScheme: 'test', ownerSubject: 'e\u0301' }).ownerScopeId,
  )
  derive({ authorizationScheme: 'test', ownerSubject: 'x'.repeat(512) })
  for (const ownerSubject of ['', 'x'.repeat(513), '\ud800', '\u0000']) {
    assert.throws(() => derive({ authorizationScheme: 'test', ownerSubject }))
  }
})

import { readFileSync } from 'node:fs'
import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import { encodeCanonicalBackupCbor as cbor } from '../src/encryptedWalletBackupCbor.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import { decodeEncryptedWalletBackupAccountRequest } from '../src/encryptedWalletBackupServerCodec.ts'
import {
  createEncryptedWalletBackupNip98AccountAuthorizationPort,
  authenticateEncryptedWalletBackupNip98OwnerAccountRequest,
} from '../src/encryptedWalletBackupNip98AccountAuthorization.ts'
const vector = JSON.parse(
  readFileSync(new URL('./fixtures/backup-owner/vectors.json', import.meta.url), 'utf8'),
)
const seed = Uint8Array.from({ length: 64 }, (_, i) => i)
const signal = () => new AbortController().signal
function port(key = new Uint8Array(32).fill(0x31)) {
  return createEncryptedWalletBackupNip98AccountAuthorizationPort({
    clock: () => vector.now,
    signer: {
      async signEvent(t) {
        const pubkey = bytesToHex(schnorr.getPublicKey(key))
        const id = bytesToHex(
          sha256(
            new TextEncoder().encode(
              JSON.stringify([0, pubkey, t.createdAtUnixSeconds, t.kind, t.tags, t.content]),
            ),
          ),
        )
        return {
          ...t,
          id,
          pubkey,
          signature: bytesToHex(schnorr.sign(hexToBytes(id), key, new Uint8Array(32))),
        }
      },
    },
  })
}
async function prepared(extra: Record<string, unknown> = {}) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm: vector.realm })
  return enrollment.prepareEncryptedWalletBackupOwnerAccountOperation({
    action: 'enroll',
    keyHandle,
    url: vector.url,
    operationId: '01'.repeat(16),
    expectedEnrollmentEpoch: 0,
    authorizationPort: port(),
    signal: signal(),
    runtime: { getRandomValues: (b) => b.fill(0) },
    ...extra,
  })
}
function authenticate(
  wire: Uint8Array,
  action: 'enroll' | 'revoke' | 'delete' = 'enroll',
  url = vector.url,
) {
  return authenticateEncryptedWalletBackupNip98OwnerAccountRequest({
    canonicalRequest: wire,
    expectedAction: action,
    expectedRealm: vector.realm,
    expectedRouteWalletId: action === 'enroll' ? null : vector.walletId,
    actualUrl: url,
    actualMethod: action === 'delete' ? 'DELETE' : 'POST',
    serverNowUnixSeconds: vector.now,
  })
}

test('owner and full enrollment bytes match an independent CBOR/HKDF/signature generator', async () => {
  for (const v of vector.owners)
    assert.equal(
      enrollment.deriveEncryptedWalletBackupOwnerScope({
        authorizationScheme: v.scheme,
        ownerSubject: v.subject,
      }).ownerScopeId,
      v.digest,
    )
  const operation = await prepared()
  assert.equal(bytesToHex(operation.canonicalRequest), vector.wire)
  assert.equal(operation.intentDigest, vector.intentDigest)
  assert.equal(operation.ownerScopeId, vector.owners[0].digest)
  assert.equal(authenticate(operation.canonicalRequest).ownerScopeId, operation.ownerScopeId)
  assert.throws(() => decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest))
  assert.throws(() =>
    enrollment.decodeEncryptedWalletBackupOwnerAccountRequest(hexToBytes(vector.authorizedRequest)),
  )
  operation.canonicalRequest.fill(0)
  assert.equal(
    bytesToHex(enrollment.readPreparedEncryptedWalletBackupOwnerAccountOperation(operation)),
    vector.wire,
  )
  assert.throws(() =>
    enrollment.readPreparedEncryptedWalletBackupOwnerAccountOperation({ ...operation }),
  )
})

test('enrollment possession binds the complete account authorization and every intent field', async () => {
  const original = hexToBytes(vector.wire)
  const outer = decode(original) as any[]
  for (const proof of [null, new Uint8Array(63), new Uint8Array(64), new Uint8Array(65)])
    assert.throws(() => authenticate(cbor([outer[0], outer[1], outer[2], proof])))
  const other = await prepared({ authorizationPort: port(new Uint8Array(32).fill(0x32)) })
  const otherOuter = decode(other.canonicalRequest) as any[]
  assert.throws(() => authenticate(cbor([2, 'backup-account-request', otherOuter[2], outer[3]])))
  // Canonical, rehashed inner mutations still cannot reuse the credential or possession.
  const replacements: [number, unknown][] = [
    [2, 'revoke'],
    [3, 'DELETE'],
    [4, vector.url + '?x=1'],
    [5, 'other'],
    [6, new Uint8Array(32)],
    [7, schnorr.getPublicKey(new Uint8Array(32).fill(0x33))],
    [8, 1],
    [9, new Uint8Array(16).fill(2)],
  ]
  for (const [index, value] of replacements) {
    const a = decode(outer[2]) as any[]
    const i = decode(a[2]) as any[]
    i[index] = value
    a[2] = cbor(i)
    a[3] = sha256(a[2])
    assert.throws(() => authenticate(cbor([2, 'backup-account-request', cbor(a), outer[3]])))
  }
  for (const wire of [
    cbor([3, 'backup-account-request', outer[2], outer[3]]),
    cbor([2, 'wrong', outer[2], outer[3]]),
    cbor([...outer, 0]),
    new Uint8Array(20481),
    Uint8Array.from([...original, 0]),
  ])
    assert.throws(() => enrollment.decodeEncryptedWalletBackupOwnerAccountRequest(wire))
})

test('revoke and delete use public coordinates without seed authority, and refuse extra possession', async () => {
  for (const action of ['revoke', 'delete'] as const) {
    const url = `https://backup.example/wallets/${vector.walletId}${action === 'revoke' ? ':revoke' : ''}`
    const operation = await enrollment.prepareEncryptedWalletBackupOwnerAccountOperation({
      action,
      target: {
        realm: vector.realm,
        walletId: vector.walletId,
        requestAuthPublicKey: vector.requestAuthPublicKey,
      },
      url,
      operationId: '02'.repeat(16),
      expectedEnrollmentEpoch: 1,
      authorizationPort: port(),
      signal: signal(),
    })
    assert.equal(
      authenticate(operation.canonicalRequest, action, url).ownerSubject,
      vector.ownerSubject,
    )
    const outer = decode(operation.canonicalRequest) as any[]
    assert.equal(outer[3], null)
    assert.throws(() =>
      authenticate(cbor([2, 'backup-account-request', outer[2], new Uint8Array(64)]), action, url),
    )
  }
})

test('owner-aware preparation rejects absent subjects, forged handles and cancellation', async () => {
  await assert.rejects(
    prepared({
      authorizationPort: {
        async authorizeBackupAccountOperation() {
          return { scheme: 'test', authorization: new Uint8Array([1]) }
        },
      },
    }),
  )
  await assert.rejects(
    prepared({
      keyHandle: {
        formatVersion: 2,
        realm: vector.realm,
        walletId: vector.walletId,
        requestAuthPublicKey: vector.requestAuthPublicKey,
      },
    }),
  )
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(prepared({ signal: aborted.signal }))
  const late = new AbortController()
  const real = port()
  await assert.rejects(
    prepared({
      signal: late.signal,
      authorizationPort: {
        async authorizeBackupAccountOperation(input: any) {
          const result = await real.authorizeBackupAccountOperation(input)
          late.abort()
          return result
        },
      },
    }),
  )
  const after = new AbortController()
  const operation = await prepared({ signal: after.signal })
  after.abort()
  assert.throws(() => enrollment.readPreparedEncryptedWalletBackupOwnerAccountOperation(operation))
  const valid = enrollment.deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: 'test',
    ownerSubject: 'subject',
  })
  assert.throws(() =>
    enrollment.decodeEncryptedWalletBackupOwnerScope({ ...valid, ownerScopeId: '00'.repeat(32) }),
  )
})

test('owner envelope rejects noncanonical encoding and oversized inner credentials', () => {
  const wire = hexToBytes(vector.wire)
  // Array length4 encoded with an unnecessarily wide argument.
  assert.throws(() =>
    enrollment.decodeEncryptedWalletBackupOwnerAccountRequest(
      Uint8Array.from([0x98, 4, ...wire.slice(1)]),
    ),
  )
  const outer = decode(wire) as any[]
  const inner = decode(outer[2]) as any[]
  inner[5] = new Uint8Array(16385)
  assert.throws(() =>
    enrollment.decodeEncryptedWalletBackupOwnerAccountRequest(
      cbor([2, 'backup-account-request', cbor(inner), outer[3]]),
    ),
  )
  assert.throws(() =>
    enrollment.decodeEncryptedWalletBackupOwnerAccountRequest(
      cbor([2, 'backup-account-request', [], outer[3]]),
    ),
  )
  assert.throws(() =>
    enrollment.decodeEncryptedWalletBackupOwnerAccountRequest(
      cbor([2, 'backup-account-request', outer[2], { proof: outer[3] }]),
    ),
  )
})
