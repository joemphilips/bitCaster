import assert from 'node:assert/strict'
import test from 'node:test'
import { decode } from 'cborg'
import { bytesToHex } from '@noble/hashes/utils.js'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import { deriveEncryptedWalletBackupOwnerScope } from '../src/encryptedWalletBackupOwnerScope.ts'
import { encodeCanonicalBackupCbor as cbor } from '../src/encryptedWalletBackupCbor.ts'
import {
  prepareEncryptedWalletBackupOwnerRequestProof,
  encodeEncryptedWalletBackupOwnerRequestProof,
  verifyEncryptedWalletBackupOwnerRequest,
} from '../src/encryptedWalletBackupOwnerRequestProof.ts'
import {
  encodeEncryptedWalletBackupOwnerDiscoveryPage,
  verifyEncryptedWalletBackupOwnerDiscoveryPage,
  resolveEncryptedWalletBackupFirstAccount,
  EncryptedWalletBackupFirstAccountError,
  type EncryptedWalletBackupOwnerCandidate,
} from '../src/encryptedWalletBackupOwnerDiscovery.ts'
const now = 1_800_000_000
const owner = deriveEncryptedWalletBackupOwnerScope({
  authorizationScheme: 'test',
  ownerSubject: 'original',
})
const other = deriveEncryptedWalletBackupOwnerScope({
  authorizationScheme: 'test',
  ownerSubject: 'other',
})
const candidate = { ...owner, enrollmentEpoch: 7 }
const key = await createEncryptedWalletBackupV2KeyHandle({
  seed: new Uint8Array(64).fill(31),
  realm: 'first-account',
})
async function page(
  binding: string | null,
  entries: readonly EncryptedWalletBackupOwnerCandidate[],
  after: string | null = null,
  next: string | null = null,
) {
  const route = {
    operation: 'owner-discovery' as const,
    realm: key.realm,
    walletId: key.walletId,
    ownerScopeId: null,
    requestedCursor: after,
  }
  const proof = await prepareEncryptedWalletBackupOwnerRequestProof({
    keyHandle: key,
    route,
    enrollmentEpoch: 0,
    method: 'GET',
    url: 'https://backup.example/owners' + (after === null ? '' : '?after=' + after),
    issuedAtUnixSeconds: now,
    expiresAtUnixSeconds: now + 30,
    payload: new Uint8Array(),
    signal: new AbortController().signal,
  })
  const request = verifyEncryptedWalletBackupOwnerRequest({
    canonicalProof: encodeEncryptedWalletBackupOwnerRequestProof(proof),
    route,
    expectedMethod: 'GET',
    expectedUrl: proof.url,
    payload: new Uint8Array(),
    serverNowUnixSeconds: now,
  })
  const bytes = encodeEncryptedWalletBackupOwnerDiscoveryPage({
    request,
    entries,
    nextCursor: next,
    firstAccountOwnerScopeId: binding,
  })
  return {
    proof,
    bytes,
    value: verifyEncryptedWalletBackupOwnerDiscoveryPage({ bytes, request: proof }),
  }
}
const code = (expected: string) => (error: unknown) =>
  error instanceof EncryptedWalletBackupFirstAccountError && error.code === expected

test('first-account uses verified binding independently from active candidate', async () => {
  const active = await page(owner.ownerScopeId, [candidate])
  assert.deepEqual(
    resolveEncryptedWalletBackupFirstAccount({ pages: [active.value], authenticatedOwner: owner }),
    { kind: 'active', owner: candidate },
  )
  {
    const inactive = await page(owner.ownerScopeId, [])
    assert.deepEqual(
      resolveEncryptedWalletBackupFirstAccount({
        pages: [inactive.value],
        authenticatedOwner: owner,
      }),
      { kind: 'inactive', ownerScopeId: owner.ownerScopeId },
    )
    assert.throws(
      () =>
        resolveEncryptedWalletBackupFirstAccount({
          pages: [inactive.value],
          authenticatedOwner: other,
        }),
      code('wrong-account'),
    )
  }
  const absent = await page(null, [])
  assert.deepEqual(
    resolveEncryptedWalletBackupFirstAccount({ pages: [absent.value], authenticatedOwner: owner }),
    { kind: 'absent' },
  )
  assert.throws(
    () =>
      resolveEncryptedWalletBackupFirstAccount({ pages: [absent.value], authenticatedOwner: null }),
    code('account-required'),
  )
})

test('null binding with active candidates and duplicate legacy owners never become absent', async () => {
  for (const [binding, entries] of [
    [null, [candidate]],
    [
      owner.ownerScopeId,
      [candidate, { ...other, enrollmentEpoch: 2 }].sort((a, b) =>
        a.ownerScopeId.localeCompare(b.ownerScopeId),
      ),
    ],
    [other.ownerScopeId, [candidate]],
  ] as const) {
    const observed = await page(binding, entries)
    assert.throws(
      () =>
        resolveEncryptedWalletBackupFirstAccount({
          pages: [observed.value],
          authenticatedOwner: owner,
        }),
      code('incompatible-discovery'),
    )
  }
})

test('binding requires exact format2 and issued request-bound pages', async () => {
  const observed = await page(owner.ownerScopeId, [candidate])
  const tuple = decode(observed.bytes) as unknown[]
  assert.equal(tuple.length, 10)
  assert.equal(tuple[0], 2)
  const old = tuple.slice(0, 9)
  old[0] = 1
  assert.throws(() =>
    verifyEncryptedWalletBackupOwnerDiscoveryPage({ bytes: cbor(old), request: observed.proof }),
  )
  const malformed = [...tuple]
  malformed[9] = new Uint8Array(31)
  assert.throws(() =>
    verifyEncryptedWalletBackupOwnerDiscoveryPage({
      bytes: cbor(malformed),
      request: observed.proof,
    }),
  )
  assert.throws(() =>
    resolveEncryptedWalletBackupFirstAccount({
      pages: [{ ...observed.value }],
      authenticatedOwner: owner,
    }),
  )
  const otherRequest = await page(owner.ownerScopeId, [candidate])
  assert.notEqual(bytesToHex(observed.bytes), bytesToHex(otherRequest.bytes))
  assert.throws(() =>
    verifyEncryptedWalletBackupOwnerDiscoveryPage({
      bytes: observed.bytes,
      request: otherRequest.proof,
    }),
  )
})

test('pages with changed immutable binding or incomplete cursor refuse', async () => {
  const first = await page(owner.ownerScopeId, [], null, owner.ownerScopeId).catch(() => null)
  // Empty-page next cursors are invalid at the owning canonical codec.
  assert.equal(first, null)
  const start = await page(owner.ownerScopeId, [candidate], null, owner.ownerScopeId)
  assert.throws(() =>
    resolveEncryptedWalletBackupFirstAccount({ pages: [start.value], authenticatedOwner: owner }),
  )
  const tail = await page(other.ownerScopeId, [], owner.ownerScopeId, null)
  assert.throws(() =>
    resolveEncryptedWalletBackupFirstAccount({
      pages: [start.value, tail.value],
      authenticatedOwner: owner,
    }),
  )
})
