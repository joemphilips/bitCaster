import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { hexToBytes, bytesToHex } from '@noble/hashes/utils.js'
import { decode } from 'cborg'
import * as api from '../src/encryptedWalletBackupV2RequestProof.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import { deriveEncryptedWalletBackupOwnerScope } from '../src/encryptedWalletBackupOwnerScope.ts'
import { encodeCanonicalBackupCbor as cbor } from '../src/encryptedWalletBackupCbor.ts'
import { decodeEncryptedWalletBackupRequestProofClaims } from '../src/encryptedWalletBackupDelegatedServerCodec.ts'
const v = JSON.parse(
  readFileSync(new URL('./fixtures/backup-owner/request-vectors.json', import.meta.url), 'utf8'),
)
const seed = Uint8Array.from({ length: 64 }, (_, i) => i)
const candidate = (name: string) => ({
  ...deriveEncryptedWalletBackupOwnerScope({ authorizationScheme: 'test', ownerSubject: name }),
  enrollmentEpoch: 1,
})
const alice = candidate('Alice'),
  bob = candidate('Bob')
const route = (
  owner: string | null = null,
  cursor: string | null = null,
): api.EncryptedWalletBackupOwnerRouteContext => ({
  operation: owner === null ? 'owner-discovery' : 'current-inventory',
  realm: v.realm,
  walletId: v.walletId,
  ownerScopeId: owner,
  requestedCursor: cursor,
})
async function issued(
  owner: string | null = null,
  cursor: string | null = null,
  extra: Record<string, unknown> = {},
) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm: v.realm })
  return api.prepareEncryptedWalletBackupOwnerRequestProof({
    keyHandle,
    route: route(owner, cursor),
    enrollmentEpoch: owner === null ? 0 : 1,
    method: 'GET',
    url:
      owner === null
        ? 'https://backup.example/owners' + (cursor === null ? '' : '?after=' + cursor)
        : v.scoped.url,
    issuedAtUnixSeconds: v.now,
    expiresAtUnixSeconds: v.now + 60,
    payload: new Uint8Array(),
    signal: new AbortController().signal,
    runtime: { getRandomValues: (b) => b.fill(0x11) },
    ...extra,
  })
}
function verify(
  proof: api.EncryptedWalletBackupOwnerRequestProof,
  context = route(proof.ownerScopeId),
) {
  return api.verifyEncryptedWalletBackupOwnerRequest({
    canonicalProof: api.encodeEncryptedWalletBackupOwnerRequestProof(proof),
    route: context,
    expectedMethod: proof.method,
    expectedUrl: proof.url,
    payload: new Uint8Array(),
    serverNowUnixSeconds: v.now,
  })
}
function page(
  proof: api.EncryptedWalletBackupOwnerRequestProof,
  entries: api.EncryptedWalletBackupOwnerCandidate[],
  next: string | null = null,
  context = route(proof.ownerScopeId),
) {
  return api.encodeEncryptedWalletBackupOwnerDiscoveryPage({
    request: verify(proof, context),
    entries,
    nextCursor: next,
  })
}

test('owner request signatures and discovery page match independent full-byte vectors', async () => {
  for (const [owner, expected] of [
    [null, v.discovery],
    [v.ownerA, v.scoped],
  ] as const) {
    const proof = await issued(owner)
    assert.equal(bytesToHex(api.encodeEncryptedWalletBackupOwnerRequestProof(proof)), expected.wire)
    assert.equal(api.encryptedWalletBackupOwnerRequestDigest(proof), expected.digest)
    assert.equal(verify(proof).claims.ownerScopeId, owner)
    assert.throws(() =>
      decodeEncryptedWalletBackupRequestProofClaims(
        api.encodeEncryptedWalletBackupOwnerRequestProof(proof),
      ),
    )
  }
  const proof = await issued()
  const bytes = page(proof, [alice])
  assert.equal(bytesToHex(bytes), v.page)
  const parsed = api.verifyEncryptedWalletBackupOwnerDiscoveryPage({ bytes, request: proof })
  assert.equal(api.uniqueEncryptedWalletBackupOwnerCandidate(parsed)?.ownerScopeId, v.ownerA)
  assert.throws(() => api.uniqueEncryptedWalletBackupOwnerCandidate({ ...parsed }))
})

test('equal key and epoch cannot exchange owners, purpose or exact request targets', async () => {
  const proof = await issued(v.ownerA)
  assert.throws(() => verify(proof, route(v.ownerB)))
  assert.throws(() => verify({ ...proof, ownerScopeId: v.ownerB }, route(v.ownerB)))
  assert.throws(() =>
    verify(
      { ...proof, purpose: 'owner-discovery', ownerScopeId: null, enrollmentEpoch: 0 },
      route(),
    ),
  )
  const listing = await issued()
  assert.throws(() => verify(listing, { ...route(), operation: 'enrollment-epoch' }))
  assert.throws(() =>
    verify(
      { ...listing, purpose: 'scoped', ownerScopeId: v.ownerA },
      { ...route(v.ownerA), operation: 'enrollment-epoch' },
    ),
  )
  const input = {
    canonicalProof: api.encodeEncryptedWalletBackupOwnerRequestProof(proof),
    route: route(v.ownerA),
    expectedMethod: 'GET' as const,
    expectedUrl: proof.url,
    payload: new Uint8Array(),
    serverNowUnixSeconds: v.now,
  }
  for (const delta of [
    { expectedUrl: proof.url + '?x=1' },
    { expectedMethod: 'POST' as const },
    { payload: new Uint8Array([1]) },
    { serverNowUnixSeconds: v.now + 61 },
    { serverNowUnixSeconds: v.now - 31 },
  ])
    assert.throws(() => api.verifyEncryptedWalletBackupOwnerRequest({ ...input, ...delta }))
  assert.equal(
    api.verifyEncryptedWalletBackupOwnerRequest({ ...input, serverNowUnixSeconds: v.now + 60 })
      .state,
    'verified',
  )
  assert.throws(() => api.requireVerifiedEncryptedWalletBackupOwnerRequest({ ...verify(proof) }))
})

test('discovery refuses false uniqueness on later pages and binds exact query/cursor', async () => {
  const owners = [alice, bob].sort((a, b) => a.ownerScopeId.localeCompare(b.ownerScopeId))
  const first = await issued()
  const firstPage = api.verifyEncryptedWalletBackupOwnerDiscoveryPage({
    bytes: page(first, [owners[0]!], owners[0]!.ownerScopeId),
    request: first,
  })
  assert.equal(api.uniqueEncryptedWalletBackupOwnerCandidate(firstPage), null)
  const later = await issued(null, owners[0]!.ownerScopeId)
  const laterBytes = page(later, [owners[1]!], null, route(null, owners[0]!.ownerScopeId))
  assert.equal(
    api.uniqueEncryptedWalletBackupOwnerCandidate(
      api.verifyEncryptedWalletBackupOwnerDiscoveryPage({ bytes: laterBytes, request: later }),
    ),
    null,
  )
  assert.throws(() =>
    api.verifyEncryptedWalletBackupOwnerDiscoveryPage({ bytes: laterBytes, request: first }),
  )
  for (const suffix of [
    '?after=' + owners[0]!.ownerScopeId + '&x=1',
    '?after=' + owners[0]!.ownerScopeId + '&after=' + owners[0]!.ownerScopeId,
    '?after=' + owners[1]!.ownerScopeId,
    '#fragment',
    '?after=',
  ])
    await assert.rejects(
      issued(null, owners[0]!.ownerScopeId, { url: 'https://backup.example/owners' + suffix }),
    )
  const changedNonce = await issued(null, null, {
    runtime: { getRandomValues: (b: Uint8Array) => b.fill(0x12) },
  })
  assert.throws(() =>
    api.verifyEncryptedWalletBackupOwnerDiscoveryPage({
      bytes: page(first, [alice]),
      request: changedNonce,
    }),
  )
})

test('bounded pages reject incorrect IDs, repeated order, cursors, excess entries and forged evidence', async () => {
  const proof = await issued()
  const good = page(proof, [alice])
  const change = (f: (t: any[]) => void) => {
    const t = decode(good) as any[]
    f(t)
    return cbor(t)
  }
  for (const bytes of [
    change((t) => {
      t[7][0][0] = new Uint8Array(32)
    }),
    change((t) => {
      t[7].push(t[7][0])
    }),
    change((t) => {
      t[8] = v.ownerB
    }),
    change((t) => {
      t[7] = Array(17).fill(t[7][0])
    }),
    change((t) => {
      t[2] = new Uint8Array(32)
    }),
    change((t) => {
      t[6] = '00'.repeat(32)
    }),
    new Uint8Array(16385),
  ])
    assert.throws(() =>
      api.verifyEncryptedWalletBackupOwnerDiscoveryPage({ bytes, request: proof }),
    )
  assert.throws(() =>
    api.encodeEncryptedWalletBackupOwnerDiscoveryPage({
      request: { ...verify(proof) },
      entries: [alice],
      nextCursor: null,
    }),
  )
  assert.throws(() =>
    api.verifyEncryptedWalletBackupOwnerDiscoveryPage({ bytes: good, request: { ...proof } }),
  )
  const scoped = await issued(v.ownerA)
  assert.throws(() => page(scoped, [alice]))
  const empty = api.verifyEncryptedWalletBackupOwnerDiscoveryPage({
    bytes: page(proof, []),
    request: proof,
  })
  assert.equal(api.uniqueEncryptedWalletBackupOwnerCandidate(empty), null)
})

test('owner proof rejects malformed versions/encoding and aborts, scoped epoch0 needs explicit discovery', async () => {
  const proof = await issued(v.ownerA),
    wire = api.encodeEncryptedWalletBackupOwnerRequestProof(proof)
  const tuple = decode(wire) as any[]
  for (const bad of [
    cbor([1, ...tuple.slice(1)]),
    cbor([...tuple, 0]),
    new Uint8Array(4097),
    Uint8Array.from([0x98, 16, ...wire.slice(1)]),
  ])
    assert.throws(() => api.decodeEncryptedWalletBackupOwnerRequestProof(bad))
  await assert.rejects(issued(v.ownerA, null, { enrollmentEpoch: 0 }))
  const discovery = await issued(v.ownerA, null, {
    enrollmentEpoch: 0,
    route: { ...route(v.ownerA), operation: 'enrollment-epoch' },
  })
  assert.equal(
    verify(discovery, { ...route(v.ownerA), operation: 'enrollment-epoch' }).state,
    'verified',
  )
  const abort = new AbortController()
  abort.abort()
  await assert.rejects(issued(null, null, { signal: abort.signal }))
  const after = new AbortController()
  const pending = await issued(null, null, { signal: after.signal })
  after.abort()
  assert.throws(() => api.requireIssuedEncryptedWalletBackupOwnerRequest(pending))
})

test('verified owner selection expires with its originating recovery cycle', async () => {
  const cycle = new AbortController()
  const request = await issued(null, null, { signal: cycle.signal })
  const verified = api.verifyEncryptedWalletBackupOwnerDiscoveryPage({
    bytes: page(request, [alice]),
    request,
  })
  assert.equal(
    api.uniqueEncryptedWalletBackupOwnerCandidate(verified)?.ownerScopeId,
    alice.ownerScopeId,
  )
  cycle.abort()
  assert.throws(() => api.uniqueEncryptedWalletBackupOwnerCandidate(verified))
})

test('owner listing refuses empty query and fragment delimiters', async () => {
  for (const suffix of ['?', '#', '?#']) {
    await assert.rejects(issued(null, null, { url: 'https://backup.example/owners' + suffix }))
  }
})
