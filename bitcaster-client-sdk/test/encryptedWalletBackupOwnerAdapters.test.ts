import {
  encodeEncryptedWalletBackupHttpResponse,
  decodeEncryptedWalletBackupHttpResponse,
} from '../src/encryptedWalletBackupHttpCodec.ts'
import { webcrypto } from 'node:crypto'
import { prepareEncryptedWalletBackupV2RequestProof } from '../src/encryptedWalletBackupV2RequestProof.ts'
import { encodeEncryptedWalletBackupRequestProof } from '../src/encryptedWalletBackup.ts'
import { prepareEncryptedWalletBackupV2TransportBundle } from '../src/encryptedWalletBackupV2Bundle.ts'
import {
  createEncryptedWalletBackupOwnerCurrentHead,
  collectEncryptedWalletBackupOwnerDescriptorPages,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from '../src/encryptedWalletBackupOwnerHead.ts'
import { prepareEncryptedWalletBackupOwnerBundleSupersessionMutation } from '../src/encryptedWalletBackupOwnerMutation.ts'
import {
  encodeEncryptedWalletBackupOwnerUploadGroup,
  decodeEncryptedWalletBackupOwnerUploadGroup,
} from '../src/encryptedWalletBackupOwnerUpload.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import * as proofApi from '../src/encryptedWalletBackupOwnerRequestProof.ts'
import * as server from '../src/encryptedWalletBackupOwnerDelegatedServerCodec.ts'
import * as http from '../src/encryptedWalletBackupOwnerHttpCodec.ts'
import * as discovery from '../src/encryptedWalletBackupOwnerDiscoveryError.ts'
import * as ownerDiscovery from '../src/encryptedWalletBackupOwnerDiscovery.ts'
import * as account from '../src/encryptedWalletBackupOwnerAccountHttp.ts'
import { prepareEncryptedWalletBackupOwnerAccountOperation } from '../src/encryptedWalletBackupOwnerAccount.ts'
import { deriveEncryptedWalletBackupOwnerScope } from '../src/encryptedWalletBackupOwnerScope.ts'
import { encodeCanonicalBackupCbor } from '../src/encryptedWalletBackupCbor.ts'
import { decode } from 'cborg'
const load = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/backup-owner/${name}.json`, import.meta.url), 'utf8'))
const v = load('request-vectors'),
  h = load('http-vectors'),
  av = load('vectors')
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')
const bytes = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'))
const owner = deriveEncryptedWalletBackupOwnerScope({
  authorizationScheme: 'test',
  ownerSubject: 'Alice',
})
const seed = Uint8Array.from({ length: 64 }, (_, i) => i)
async function issue(
  operation: 'current-inventory' | 'owner-discovery' | 'enrollment-epoch' = 'current-inventory',
  cursor: string | null = null,
  staticUrl = false,
) {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm: v.realm })
  const route: server.EncryptedWalletBackupOwnerServerRoute =
    operation === 'owner-discovery'
      ? { operation, realm: v.realm, walletId: v.walletId, requestedCursor: cursor }
      : { operation, realm: v.realm, walletId: v.walletId, ownerScopeId: owner.ownerScopeId }
  const target = server.encryptedWalletBackupOwnerServerRoute(route),
    cycle = new AbortController()
  const proof = await proofApi.prepareEncryptedWalletBackupOwnerRequestProof({
    keyHandle,
    route: target.context,
    enrollmentEpoch: operation === 'current-inventory' ? 1 : 0,
    method: target.method,
    url: staticUrl
      ? operation === 'owner-discovery'
        ? 'https://backup.example/owners'
        : v.scoped.url
      : 'https://backup.example' + target.rawTarget,
    issuedAtUnixSeconds: v.now,
    expiresAtUnixSeconds: v.now + 60,
    payload: new Uint8Array(),
    signal: cycle.signal,
    runtime: { getRandomValues: (b) => b.fill(0x11) },
  })
  const canonicalProof = proofApi.encodeEncryptedWalletBackupOwnerRequestProof(proof)
  const input = {
    rawAuthorizationHeaderValues: ['BackupV1 ' + Buffer.from(canonicalProof).toString('base64url')],
    configuredOrigin: 'https://backup.example',
    rawTarget: target.rawTarget,
    method: target.method,
    route,
    payload: new Uint8Array(),
    serverNowUnixSeconds: v.now,
  }
  const verified = () =>
    server.verifyAndDecodeEncryptedWalletBackupOwnerDelegatedServerRequest(input)
  const row = {
    ...owner,
    realm: v.realm,
    walletId: v.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: 1,
    status: 'active' as const,
    accountStatus: 'active' as const,
  }
  const evidence = () =>
    proofApi.verifyEncryptedWalletBackupOwnerRequest({
      canonicalProof,
      route: target.context,
      expectedMethod: proof.method,
      expectedUrl: proof.url,
      payload: new Uint8Array(),
      serverNowUnixSeconds: v.now,
    })
  return { proof, input, verified, row, cycle, evidence, keyHandle }
}
test('owner selection requires an explicit choice from a complete verified page', async () => {
  const listing = await issue('owner-discovery')
  const bytes = ownerDiscovery.encodeEncryptedWalletBackupOwnerDiscoveryPage({
    request: listing.evidence(),
    entries: [{ ...owner, enrollmentEpoch: 3 }],
    nextCursor: null,
    firstAccountOwnerScopeId: owner.ownerScopeId,
  })
  const page = ownerDiscovery.verifyEncryptedWalletBackupOwnerDiscoveryPage({
    bytes,
    request: listing.proof,
  })

  assert.throws(
    () => ownerDiscovery.selectEncryptedWalletBackupOwnerCandidate({ page, ownerScopeId: null }),
    (error: unknown) =>
      error instanceof ownerDiscovery.EncryptedWalletBackupOwnerSelectionError &&
      error.code === 'selection-required',
  )
  assert.equal(
    ownerDiscovery.selectEncryptedWalletBackupOwnerCandidate({
      page,
      ownerScopeId: owner.ownerScopeId,
    }).ownerScopeId,
    owner.ownerScopeId,
  )
  assert.throws(
    () =>
      ownerDiscovery.selectEncryptedWalletBackupOwnerCandidate({
        page,
        ownerScopeId: 'ff'.repeat(32),
      }),
    (error: unknown) =>
      error instanceof ownerDiscovery.EncryptedWalletBackupOwnerSelectionError &&
      error.code === 'owner-not-listed',
  )
  assert.throws(() =>
    ownerDiscovery.selectEncryptedWalletBackupOwnerCandidate({
      page: { ...page },
      ownerScopeId: owner.ownerScopeId,
    }),
  )
  const partial = ownerDiscovery.verifyEncryptedWalletBackupOwnerDiscoveryPage({
    bytes: ownerDiscovery.encodeEncryptedWalletBackupOwnerDiscoveryPage({
      request: listing.evidence(),
      entries: [{ ...owner, enrollmentEpoch: 3 }],
      nextCursor: owner.ownerScopeId,
      firstAccountOwnerScopeId: owner.ownerScopeId,
    }),
    request: listing.proof,
  })
  assert.throws(
    () =>
      ownerDiscovery.selectEncryptedWalletBackupOwnerCandidate({
        page: partial,
        ownerScopeId: owner.ownerScopeId,
      }),
    (error: unknown) =>
      error instanceof ownerDiscovery.EncryptedWalletBackupOwnerSelectionError &&
      error.code === 'selection-incomplete',
  )
  listing.cycle.abort()
  assert.throws(() =>
    ownerDiscovery.selectEncryptedWalletBackupOwnerCandidate({
      page,
      ownerScopeId: owner.ownerScopeId,
    }),
  )
})
test('owner selection can require an explicit choice across a verified complete page chain', async () => {
  const otherOwner = deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: 'test',
    ownerSubject: 'owner-b',
  })
  const candidates = [owner, otherOwner].sort((left, right) =>
    left.ownerScopeId.localeCompare(right.ownerScopeId),
  )
  const firstRequest = await issue('owner-discovery')
  const first = ownerDiscovery.verifyEncryptedWalletBackupOwnerDiscoveryPage({
    bytes: ownerDiscovery.encodeEncryptedWalletBackupOwnerDiscoveryPage({
      request: firstRequest.evidence(),
      entries: [{ ...candidates[0]!, enrollmentEpoch: 2 }],
      nextCursor: candidates[0]!.ownerScopeId,
      firstAccountOwnerScopeId: owner.ownerScopeId,
    }),
    request: firstRequest.proof,
  })
  const secondRequest = await issue('owner-discovery', candidates[0]!.ownerScopeId)
  const second = ownerDiscovery.verifyEncryptedWalletBackupOwnerDiscoveryPage({
    bytes: ownerDiscovery.encodeEncryptedWalletBackupOwnerDiscoveryPage({
      request: secondRequest.evidence(),
      entries: [{ ...candidates[1]!, enrollmentEpoch: 4 }],
      nextCursor: null,
      firstAccountOwnerScopeId: owner.ownerScopeId,
    }),
    request: secondRequest.proof,
  })
  const pages = [first, second]
  assert.throws(
    () =>
      ownerDiscovery.selectEncryptedWalletBackupOwnerCandidateFromPages({
        pages,
        ownerScopeId: null,
      }),
    (error: unknown) =>
      error instanceof ownerDiscovery.EncryptedWalletBackupOwnerSelectionError &&
      error.code === 'selection-required',
  )
  assert.equal(
    ownerDiscovery.selectEncryptedWalletBackupOwnerCandidateFromPages({
      pages,
      ownerScopeId: candidates[1]!.ownerScopeId,
    }).ownerScopeId,
    candidates[1]!.ownerScopeId,
  )
  firstRequest.cycle.abort()
  secondRequest.cycle.abort()
  assert.throws(() =>
    ownerDiscovery.selectEncryptedWalletBackupOwnerCandidateFromPages({
      pages,
      ownerScopeId: candidates[1]!.ownerScopeId,
    }),
  )
})
test('owner HTTP wrappers match independent canonical full-byte vectors', async () => {
  const i = await issue('current-inventory', null, true)
  const envelope = {
    kind: 'current-inventory' as const,
    requestDigest: proofApi.encryptedWalletBackupOwnerRequestDigest(i.proof),
    ownerScopeId: v.ownerA,
    realm: v.realm,
    walletId: v.walletId,
    enrollmentEpoch: 1,
    body: Uint8Array.of(1, 2, 3),
  }
  assert.equal(hex(http.encodeEncryptedWalletBackupOwnerHttpResponse(envelope)), h.scoped)
  assert.deepEqual(
    http.consumeEncryptedWalletBackupOwnerHttpResponse({
      request: i.proof,
      bytes: bytes(h.scoped),
    }),
    envelope,
  )
  const error = {
    operation: 'current-inventory' as const,
    code: 'unavailable' as const,
    retryAfterSeconds: 1,
  }
  assert.equal(hex(http.encodeEncryptedWalletBackupOwnerHttpError(error)), h.error)
  assert.equal(
    hex(
      http.encodeEncryptedWalletBackupOwnerHttpResponse({
        ...envelope,
        kind: 'error',
        body: bytes(h.error),
      }),
    ),
    h.scopedError,
  )
  assert.equal(
    hex(
      http.encodeEncryptedWalletBackupOwnerEnrollmentEpochResult({
        result: 'active',
        enrollmentEpoch: 1,
      }),
    ),
    h.epoch,
  )
  const listing = await issue('owner-discovery', null, true)
  assert.equal(
    hex(
      discovery.encodeEncryptedWalletBackupOwnerDiscoveryError({
        request: listing.evidence(),
        code: 'rate-limited',
        retryAfterSeconds: 2,
      }),
    ),
    h.discoveryError,
  )
  assert.equal(
    discovery.consumeEncryptedWalletBackupOwnerDiscoveryError({
      request: listing.proof,
      bytes: bytes(h.discoveryError),
    }).code,
    'rate-limited',
  )
  const c = {
    action: 'enroll' as const,
    ownerScopeId: v.ownerA,
    realm: v.realm,
    walletId: v.walletId,
    operationId: '01'.repeat(16),
    intentDigest: av.intentDigest,
  }
  assert.equal(
    hex(
      account.encodeEncryptedWalletBackupOwnerAccountHttpResponse({
        ...c,
        kind: 'account-result',
        result: 'committed',
        enrollmentEpoch: 1,
        lifecycle: 'active',
      }),
    ),
    h.accountResult,
  )
  assert.equal(
    hex(
      account.encodeEncryptedWalletBackupOwnerAccountHttpResponse({
        ...c,
        kind: 'account-error',
        code: 'unavailable',
        retryAfterSeconds: 1,
      }),
    ),
    h.accountError,
  )
  assert.equal(
    hex(
      account.encodeEncryptedWalletBackupOwnerAccountHttpResponse({
        kind: 'error',
        code: 'unauthorized',
        retryAfterSeconds: null,
      }),
    ),
    h.genericError,
  )
})
test('server authorization requires exact route, derived owner, enrollment, and genuine one-use evidence', async () => {
  const i = await issue()
  const verified = i.verified()
  assert.equal(
    server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
      verifiedRequest: verified,
      enrollment: i.row,
    }).state,
    'enrollment-authorized',
  )
  assert.throws(() =>
    server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
      verifiedRequest: verified,
      enrollment: i.row,
    }),
  )
  assert.throws(() =>
    server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
      verifiedRequest: { state: 'verified', operation: 'current-inventory' },
      enrollment: i.row,
    }),
  )
  for (const row of [
    null,
    { ...i.row, ownerSubject: 'Bob' },
    { ...i.row, enrollmentEpoch: 2 },
    { ...i.row, accountStatus: 'disabled' as const },
    { ...i.row, status: 'revoked' as const },
  ])
    assert.throws(
      () =>
        server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
          verifiedRequest: i.verified(),
          enrollment: row,
        }),
      server.EncryptedWalletBackupOwnerDelegatedServerRejection,
    )
  for (const extra of [
    { rawTarget: i.input.rawTarget + '?after=x' },
    { rawTarget: i.input.rawTarget + '/' },
    { method: 'POST' as const },
    { configuredOrigin: 'https://backup.example/' },
    { payload: Uint8Array.of(0) },
    {
      rawAuthorizationHeaderValues: [
        ...i.input.rawAuthorizationHeaderValues,
        ...i.input.rawAuthorizationHeaderValues,
      ],
    },
  ])
    assert.throws(() =>
      server.verifyAndDecodeEncryptedWalletBackupOwnerDelegatedServerRequest({
        ...i.input,
        ...extra,
      }),
    )
  const listing = await issue('owner-discovery')
  assert.equal(
    server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
      verifiedRequest: listing.verified(),
      enrollment: null,
    }).operation,
    'owner-discovery',
  )
  assert.throws(() =>
    server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
      verifiedRequest: listing.verified(),
      enrollment: i.row,
    }),
  )
  const epoch = await issue('enrollment-epoch')
  assert.deepEqual(
    server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
      verifiedRequest: epoch.verified(),
      enrollment: i.row,
    }).discovery,
    { status: 'active', enrollmentEpoch: 1 },
  )
  assert.deepEqual(
    server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
      verifiedRequest: epoch.verified(),
      enrollment: null,
    }).discovery,
    { status: 'not-enrolled' },
  )
})
test('response consumption rejects cross-owner, route, epoch, digest, version and aborted capabilities', async () => {
  const i = await issue(),
    digest = proofApi.encryptedWalletBackupOwnerRequestDigest(i.proof)
  const envelope = {
    kind: 'current-inventory' as const,
    requestDigest: digest,
    ownerScopeId: v.ownerA,
    realm: v.realm,
    walletId: v.walletId,
    enrollmentEpoch: 1,
    body: Uint8Array.of(1),
  }
  const consume = (value: http.EncryptedWalletBackupOwnerHttpResponseEnvelope) =>
    http.consumeEncryptedWalletBackupOwnerHttpResponse({
      request: i.proof,
      bytes: http.encodeEncryptedWalletBackupOwnerHttpResponse(value),
    })
  consume(envelope)
  for (const extra of [
    { ownerScopeId: v.ownerB },
    { enrollmentEpoch: 2 },
    { requestDigest: '01'.repeat(32) },
    { walletId: '01'.repeat(32) },
    { realm: 'another' },
    { kind: 'object' as const },
  ])
    assert.throws(() => consume({ ...envelope, ...extra }))
  const tuple = decode(http.encodeEncryptedWalletBackupOwnerHttpResponse(envelope))
  tuple[0] = 2
  assert.throws(() =>
    http.consumeEncryptedWalletBackupOwnerHttpResponse({
      request: i.proof,
      bytes: encodeCanonicalBackupCbor(tuple),
    }),
  )
  assert.throws(() =>
    http.consumeEncryptedWalletBackupOwnerHttpResponse({
      request: { ...i.proof },
      bytes: http.encodeEncryptedWalletBackupOwnerHttpResponse(envelope),
    }),
  )
  i.cycle.abort()
  assert.throws(() => consume(envelope))
  const listing = await issue('owner-discovery'),
    error = discovery.encodeEncryptedWalletBackupOwnerDiscoveryError({
      request: listing.evidence(),
      code: 'unavailable',
      retryAfterSeconds: 1,
    })
  discovery.consumeEncryptedWalletBackupOwnerDiscoveryError({
    request: listing.proof,
    bytes: error,
  })
  const other = await issue('owner-discovery', '01'.repeat(32))
  assert.throws(() =>
    discovery.consumeEncryptedWalletBackupOwnerDiscoveryError({
      request: other.proof,
      bytes: error,
    }),
  )
  listing.cycle.abort()
  assert.throws(() =>
    discovery.consumeEncryptedWalletBackupOwnerDiscoveryError({
      request: listing.proof,
      bytes: error,
    }),
  )
})
test('maximum legal owner response fits existing bound; oversized and deeply nested inputs refuse', () => {
  const value = {
    kind: 'object' as const,
    requestDigest: '01'.repeat(32),
    ownerScopeId: v.ownerA,
    realm: 'r'.repeat(64),
    walletId: v.walletId,
    enrollmentEpoch: Number.MAX_SAFE_INTEGER,
    body: new Uint8Array(300000),
  }
  const encoded = http.encodeEncryptedWalletBackupOwnerHttpResponse(value)
  assert.ok(encoded.length <= 300256)
  assert.equal(http.decodeEncryptedWalletBackupOwnerHttpResponse(encoded).body.length, 300000)
  assert.throws(() =>
    http.encodeEncryptedWalletBackupOwnerHttpResponse({ ...value, body: new Uint8Array(300001) }),
  )
  assert.throws(() => http.decodeEncryptedWalletBackupOwnerHttpResponse(new Uint8Array(300257)))
  assert.throws(() =>
    http.decodeEncryptedWalletBackupOwnerHttpResponse(encodeCanonicalBackupCbor([[[[[[]]]]]])),
  )
})
test('account result and contextual failure consume only the original live prepared operation', async () => {
  const i = await issue(),
    cycle = new AbortController()
  const prepared = await prepareEncryptedWalletBackupOwnerAccountOperation({
    action: 'enroll',
    keyHandle: i.keyHandle,
    url: 'https://backup.example/enroll',
    operationId: '01'.repeat(16),
    expectedEnrollmentEpoch: 0,
    authorizationPort: {
      async authorizeBackupAccountOperation() {
        return { scheme: 'test', ownerSubject: 'Alice', authorization: Uint8Array.of(1) }
      },
    },
    signal: cycle.signal,
    runtime: { getRandomValues: (b) => b.fill(0) },
  })
  const result = {
    kind: 'account-result' as const,
    action: 'enroll' as const,
    ownerScopeId: owner.ownerScopeId,
    realm: v.realm,
    walletId: v.walletId,
    operationId: '01'.repeat(16),
    intentDigest: prepared.intentDigest,
    result: 'committed' as const,
    enrollmentEpoch: 1,
    lifecycle: 'active' as const,
  }
  const consume = (value: account.EncryptedWalletBackupOwnerAccountResponse, status = 200) =>
    account.consumeEncryptedWalletBackupOwnerAccountHttpResponse({
      prepared,
      httpStatus: status,
      bytes: account.encodeEncryptedWalletBackupOwnerAccountHttpResponse(value),
    })
  assert.equal(consume(result).kind, 'account-result')
  for (const extra of [
    { ownerScopeId: v.ownerB },
    { action: 'delete' as const },
    { intentDigest: '02'.repeat(32) },
    { operationId: '02'.repeat(16) },
  ])
    assert.throws(() => consume({ ...result, ...extra }))
  assert.throws(() => consume(result, 403))
  assert.equal(
    consume({ ...result, kind: 'account-error', code: 'unavailable', retryAfterSeconds: 1 }, 503)
      .kind,
    'account-error',
  )
  assert.equal(
    consume({ kind: 'error', code: 'unauthorized', retryAfterSeconds: null }, 401).kind,
    'error',
  )
  assert.throws(() =>
    account.consumeEncryptedWalletBackupOwnerAccountHttpResponse({
      prepared: { ...prepared },
      httpStatus: 200,
      bytes: account.encodeEncryptedWalletBackupOwnerAccountHttpResponse(result),
    }),
  )
  cycle.abort()
  assert.throws(() => consume(result))
})

test('genuine legacy proof in the unchanged BackupV1 carrier cannot authorize owner routes', async () => {
  const i = await issue()
  const legacy = await prepareEncryptedWalletBackupV2RequestProof({
    keyHandle: i.keyHandle,
    enrollmentEpoch: 1,
    method: 'GET',
    url: i.proof.url,
    issuedAtUnixSeconds: v.now,
    expiresAtUnixSeconds: v.now + 60,
    payload: new Uint8Array(),
    signal: new AbortController().signal,
    runtime: { getRandomValues: (b) => b.fill(0x11) },
  })
  const header =
    'BackupV1 ' + Buffer.from(encodeEncryptedWalletBackupRequestProof(legacy)).toString('base64url')
  assert.throws(() =>
    server.verifyAndDecodeEncryptedWalletBackupOwnerDelegatedServerRequest({
      ...i.input,
      rawAuthorizationHeaderValues: [header],
    }),
  )
})
test('owner upload composes unchanged ciphertext objects with exact signed owner mutation and route', async () => {
  const i = await issue(),
    scope = { ownerScopeId: v.ownerA, realm: v.realm, walletId: v.walletId, enrollmentEpoch: 1 }
  let random = 0
  const runtime = {
    subtle: webcrypto.subtle,
    getRandomValues: (target: Uint8Array) => target.fill(++random),
  }
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle: i.keyHandle,
    asset: { mintUrl: 'https://mint.example', unit: 'msat', assetIdentity: 'cashu:ordinary' },
    declaredAmount: 2n,
    custodyRevision: 1n,
    canonicalPayload: new Uint8Array(262112 + 262128 * 14),
    runtime,
  })
  assert.equal(prepared.objects.length, 15)
  const head = createEncryptedWalletBackupOwnerCurrentHead({
    ...scope,
    headVersion: 0,
    bundles: [],
  })
  const evidence = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles: [] }),
    scope,
  )
  const envelope = await prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
    keyHandle: i.keyHandle,
    expectedContext: scope,
    expectedHeadEvidence: evidence,
    addedBundle: prepared.descriptor,
    supersededBundleIds: [],
    runtime,
  })
  const wire = encodeEncryptedWalletBackupOwnerUploadGroup({ envelope, objects: prepared.objects })
  const decoded = decodeEncryptedWalletBackupOwnerUploadGroup({
    bytes: wire,
    expectedContext: scope,
    expectedRequestAuthPublicKey: i.keyHandle.requestAuthPublicKey,
  })
  assert.deepEqual(decoded.objects, prepared.objects)
  assert.throws(() =>
    decodeEncryptedWalletBackupOwnerUploadGroup({
      bytes: wire,
      expectedContext: { ...scope, ownerScopeId: v.ownerB },
      expectedRequestAuthPublicKey: i.keyHandle.requestAuthPublicKey,
    }),
  )
  assert.throws(() =>
    encodeEncryptedWalletBackupOwnerUploadGroup({
      envelope,
      objects: [...prepared.objects].reverse(),
    }),
  )
  const tuple = decode(wire)
  tuple[0] = 2
  assert.throws(() =>
    decodeEncryptedWalletBackupOwnerUploadGroup({
      bytes: encodeCanonicalBackupCbor(tuple),
      expectedContext: scope,
      expectedRequestAuthPublicKey: i.keyHandle.requestAuthPublicKey,
    }),
  )
  const corrupted = decode(wire)
  corrupted[3][0][corrupted[3][0].length - 1] ^= 1
  assert.throws(() =>
    decodeEncryptedWalletBackupOwnerUploadGroup({
      bytes: encodeCanonicalBackupCbor(corrupted),
      expectedContext: scope,
      expectedRequestAuthPublicKey: i.keyHandle.requestAuthPublicKey,
    }),
  )
  const route = {
      operation: 'bundle-supersession' as const,
      realm: v.realm,
      walletId: v.walletId,
      ownerScopeId: v.ownerA,
    },
    target = server.encryptedWalletBackupOwnerServerRoute(route)
  const proof = await proofApi.prepareEncryptedWalletBackupOwnerRequestProof({
    keyHandle: i.keyHandle,
    route: target.context,
    enrollmentEpoch: 1,
    method: 'POST',
    url: 'https://backup.example' + target.rawTarget,
    issuedAtUnixSeconds: v.now,
    expiresAtUnixSeconds: v.now + 60,
    payload: wire,
    signal: new AbortController().signal,
    runtime,
  })
  const verified = server.verifyAndDecodeEncryptedWalletBackupOwnerDelegatedServerRequest({
    rawAuthorizationHeaderValues: [
      'BackupV1 ' +
        Buffer.from(proofApi.encodeEncryptedWalletBackupOwnerRequestProof(proof)).toString(
          'base64url',
        ),
    ],
    configuredOrigin: 'https://backup.example',
    rawTarget: target.rawTarget,
    route,
    method: 'POST',
    payload: wire,
    serverNowUnixSeconds: v.now,
  })
  const authorized = server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
    verifiedRequest: verified,
    enrollment: i.row,
  })
  assert.equal(
    authorized.decodedUploadGroup?.mutationEvidence.envelope.requestDigest,
    envelope.requestDigest,
  )
})

test('closed scalar domains and each inner payload limit refuse before consumption', () => {
  for (const [kind, limit] of [
    ['object', 300000],
    ['current-inventory', 60000],
    ['descriptor-page', 65536],
    ['bundle-supersession-receipt', 65536],
    ['error', 128],
    ['enrollment-epoch', 64],
  ] as const) {
    const value = {
      kind,
      requestDigest: '01'.repeat(32),
      ownerScopeId: v.ownerA,
      realm: 'r'.repeat(64),
      walletId: v.walletId,
      enrollmentEpoch: Number.MAX_SAFE_INTEGER,
      body: new Uint8Array(limit),
    }
    const encoded = http.encodeEncryptedWalletBackupOwnerHttpResponse(value)
    assert.equal(http.decodeEncryptedWalletBackupOwnerHttpResponse(encoded).body.length, limit)
    assert.throws(() =>
      http.encodeEncryptedWalletBackupOwnerHttpResponse({
        ...value,
        body: new Uint8Array(limit + 1),
      }),
    )
    const tuple = decode(encoded)
    tuple[8] = new Uint8Array(limit + 1)
    assert.throws(() =>
      http.decodeEncryptedWalletBackupOwnerHttpResponse(encodeCanonicalBackupCbor(tuple)),
    )
  }
  assert.throws(() =>
    http.encodeEncryptedWalletBackupOwnerEnrollmentEpochResult({
      result: 'other' as 'active',
      enrollmentEpoch: 1,
    }),
  )
  assert.throws(() =>
    http.encodeEncryptedWalletBackupOwnerEnrollmentEpochResult({
      result: 'active',
      enrollmentEpoch: 0,
    }),
  )
  assert.throws(() =>
    http.encodeEncryptedWalletBackupOwnerEnrollmentEpochResult({
      result: 'not-enrolled',
      enrollmentEpoch: 1,
    }),
  )
  for (const retryAfterSeconds of [0, 3601, 1.5])
    assert.throws(() =>
      http.encodeEncryptedWalletBackupOwnerHttpError({
        operation: 'owner-discovery',
        code: 'unavailable',
        retryAfterSeconds,
      }),
    )
  assert.throws(() =>
    http.encodeEncryptedWalletBackupOwnerHttpError({
      operation: 'owner-discovery',
      code: 'unauthorized',
      retryAfterSeconds: 1,
    }),
  )
})
test('one-use server capability is captured once even with an accessor input', async () => {
  const i = await issue(),
    a = i.verified(),
    b = i.verified()
  let reads = 0
  server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
    get verifiedRequest() {
      return ++reads === 1 ? a : b
    },
    enrollment: i.row,
  })
  assert.equal(reads, 1)
  assert.throws(() =>
    server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
      verifiedRequest: a,
      enrollment: i.row,
    }),
  )
  assert.equal(
    server.authorizeVerifiedEncryptedWalletBackupOwnerDelegatedServerRequest({
      verifiedRequest: b,
      enrollment: i.row,
    }).state,
    'enrollment-authorized',
  )
})

test('committed account lifecycle matches each action; conflicts preserve observed state', async () => {
  const i = await issue()
  const lifecycles = ['active', 'revoked', 'deleted'] as const
  for (const [action, expectedLifecycle] of [
    ['enroll', 'active'],
    ['revoke', 'revoked'],
    ['delete', 'deleted'],
  ] as const) {
    const common = {
      url: 'https://backup.example/' + action,
      operationId: '01'.repeat(16),
      expectedEnrollmentEpoch: action === 'enroll' ? 0 : 1,
      authorizationPort: {
        async authorizeBackupAccountOperation() {
          return { scheme: 'test', ownerSubject: 'Alice', authorization: Uint8Array.of(1) }
        },
      },
      signal: new AbortController().signal,
      runtime: { getRandomValues: (b: Uint8Array) => b.fill(0) },
    }
    const prepared = await prepareEncryptedWalletBackupOwnerAccountOperation(
      action === 'enroll'
        ? { ...common, action, keyHandle: i.keyHandle }
        : { ...common, action, target: i.keyHandle },
    )
    const result = {
      kind: 'account-result' as const,
      action,
      ownerScopeId: owner.ownerScopeId,
      realm: v.realm,
      walletId: v.walletId,
      operationId: common.operationId,
      intentDigest: prepared.intentDigest,
      result: 'committed' as const,
      enrollmentEpoch: 1,
      lifecycle: expectedLifecycle,
    }
    const canonical = account.encodeEncryptedWalletBackupOwnerAccountHttpResponse(result)
    const consume = (wire: Uint8Array) =>
      account.consumeEncryptedWalletBackupOwnerAccountHttpResponse({
        prepared,
        httpStatus: 200,
        bytes: wire,
      })
    assert.equal(consume(canonical).kind, 'account-result')
    for (const lifecycle of lifecycles) {
      // Alter the canonical wire directly. An encoder guard cannot satisfy this assertion.
      const tuple = decode(canonical)
      tuple[10] = lifecycle
      if (lifecycle !== expectedLifecycle)
        assert.throws(() => consume(encodeCanonicalBackupCbor(tuple)), /lifecycle/)
      tuple[8] = 'conflict'
      const conflict = consume(encodeCanonicalBackupCbor(tuple))
      assert.equal(conflict.kind, 'account-result')
      if (conflict.kind === 'account-result') {
        assert.equal(conflict.result, 'conflict')
        assert.equal(conflict.lifecycle, lifecycle)
      }
    }
  }
})

test('shared account lifecycle validator preserves legacy committed and conflict semantics', () => {
  for (const [operation, expectedLifecycle] of [
    ['account-enroll', 'active'],
    ['account-revoke', 'revoked'],
    ['account-delete', 'deleted'],
  ] as const) {
    for (const result of ['committed', 'conflict'] as const) {
      for (const lifecycle of ['active', 'revoked', 'deleted'] as const) {
        const input = {
          operation,
          expectedOperationId: '01'.repeat(16),
          expectedIntentDigest: '02'.repeat(32),
          httpStatus: 200,
          body: encodeEncryptedWalletBackupHttpResponse({
            kind: 'account-result',
            operationId: '01'.repeat(16),
            intentDigest: '02'.repeat(32),
            result,
            enrollmentEpoch: 1,
            lifecycle,
          }),
        }
        if (result === 'committed' && lifecycle !== expectedLifecycle)
          assert.throws(() => decodeEncryptedWalletBackupHttpResponse(input), /lifecycle/)
        else assert.equal(decodeEncryptedWalletBackupHttpResponse(input).result, result)
      }
    }
  }
})
