import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import {
  encryptedWalletBackupRequestDigest,
  encodeEncryptedWalletBackupRequestProof,
  type EncryptedWalletBackupRequestProof,
} from '../src/encryptedWalletBackup.ts'
import { prepareEncryptedWalletBackupAccountOperation } from '../src/encryptedWalletBackupEnrollment.ts'
import { encodeEncryptedWalletBackupHttpResponse } from '../src/encryptedWalletBackupHttpCodec.ts'
import {
  authorizeVerifiedEncryptedWalletBackupV2DelegatedServerRequest,
  consumeEncryptedWalletBackupV2EnrollmentDiscoveryReplay,
  EncryptedWalletBackupV2DelegatedServerRejection,
  verifyAndDecodeEncryptedWalletBackupV2DelegatedServerRequest,
  type EncryptedWalletBackupV2ServerEnrollment,
} from '../src/encryptedWalletBackupV2DelegatedServerCodec.ts'
import {
  EncryptedWalletBackupV2HttpAdapter,
  EncryptedWalletBackupV2HttpTransportError,
} from '../src/encryptedWalletBackupV2HttpAdapter.ts'
import {
  encodeEncryptedWalletBackupV2HttpResponse,
  encodeEncryptedWalletBackupV2HttpError,
  encodeEncryptedWalletBackupV2EnrollmentEpochResult,
} from '../src/encryptedWalletBackupV2HttpCodec.ts'
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2CurrentHead,
  enumerateEncryptedWalletBackupV2DescriptorPages,
} from '../src/encryptedWalletBackupV2Head.ts'
import { encodeEncryptedWalletBackupV2DescriptorPage } from '../src/encryptedWalletBackupV2ServiceCodec.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import {
  prepareEncryptedWalletBackupV2TransportBundle,
  encodeEncryptedWalletBackupV2BundleObjectWire,
} from '../src/encryptedWalletBackupV2Bundle.ts'
import { prepareEncryptedWalletBackupV2BundleSupersessionMutation } from '../src/encryptedWalletBackupV2Mutation.ts'
import {
  decodeEncryptedWalletBackupV2UploadGroup,
  encodeEncryptedWalletBackupV2UploadGroup,
  encodeEncryptedWalletBackupV2BundleSupersessionReceipt,
} from '../src/encryptedWalletBackupV2ServiceCodec.ts'
import { issueEncryptedWalletBackupV2BundleSupersessionReceipt } from '../src/encryptedWalletBackupV2Receipt.ts'
import {
  prepareEncryptedWalletBackupV2EnrollmentEpochDiscoveryProof,
  prepareEncryptedWalletBackupV2RequestProof,
  type EncryptedWalletBackupV2RequestProof,
} from '../src/encryptedWalletBackupV2RequestProof.ts'
import { ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES } from '../src/encryptedWalletBackupV2Limits.ts'

const ORIGIN = 'https://backup.example'
const REALM = 'v2-http-test'

test('V2 adapter forwards only the scheme-neutral enrollment lifecycle endpoint', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(6),
    realm: REALM,
    runtime: webcrypto,
  })
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/wallets:enroll`
  const operation = await prepareEncryptedWalletBackupAccountOperation({
    keyHandle,
    action: 'enroll',
    url,
    operationId: '11'.repeat(16),
    expectedEnrollmentEpoch: 0,
    authorizationPort: {
      authorizeBackupAccountOperation: async () => ({
        scheme: 'nip98-backup-intent-v1',
        authorization: new Uint8Array([1]),
      }),
    },
    signal: new AbortController().signal,
  })
  const adapter = new EncryptedWalletBackupV2HttpAdapter({
    origin: ORIGIN,
    fetch: async (input, init) => {
      assert.equal(input, url)
      assert.equal(init.method, 'POST')
      assert.equal(new Headers(init.headers).get('authorization'), null)
      return response(
        url,
        encodeEncryptedWalletBackupHttpResponse({
          kind: 'account-result',
          operationId: operation.operationId,
          intentDigest: operation.intentDigest,
          result: 'committed',
          enrollmentEpoch: 1,
          lifecycle: 'active',
        }),
      )
    },
  })
  assert.deepEqual(
    await adapter.executeAccountOperation({
      operation,
      canonicalRequest: operation.canonicalRequest,
      signal: new AbortController().signal,
    }),
    {
      status: 'committed',
      operationId: operation.operationId,
      intentDigest: operation.intentDigest,
      enrollmentEpoch: 1,
      lifecycle: 'active',
    },
  )
})

test('V2 adapter maps a redacted account transport failure and preserves dispatch uncertainty', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(5),
    realm: REALM,
    runtime: webcrypto,
  })
  const operation = await prepareEncryptedWalletBackupAccountOperation({
    keyHandle,
    action: 'enroll',
    url: `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/wallets:enroll`,
    operationId: '12'.repeat(16),
    expectedEnrollmentEpoch: 0,
    authorizationPort: {
      authorizeBackupAccountOperation: async () => ({
        scheme: 'nip98-backup-intent-v1',
        authorization: new Uint8Array([1]),
      }),
    },
    signal: new AbortController().signal,
  })
  const adapter = new EncryptedWalletBackupV2HttpAdapter({
    origin: ORIGIN,
    fetch: async () => Promise.reject(new Error('network details must not escape')),
  })
  await assert.rejects(
    adapter.executeAccountOperation({
      operation,
      canonicalRequest: operation.canonicalRequest,
      signal: new AbortController().signal,
    }),
    (error) =>
      error instanceof EncryptedWalletBackupV2HttpTransportError &&
      error.code === 'transport-failure' &&
      error.dispatchState === 'uncertain' &&
      error.retryAfterSeconds === null &&
      !error.message.includes('network details'),
  )
})

test('V2 descriptor routes bind the cursor, method, body, request digest, and V2 scope', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(7),
    realm: REALM,
    runtime: webcrypto,
  })
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${keyHandle.walletId}/head`
  const proof = await prepareProof(keyHandle, 3, 'GET', url, new Uint8Array())
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 3,
    headVersion: 0,
    bundles: [],
  })
  const page = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [] })[0]!
  const adapter = new EncryptedWalletBackupV2HttpAdapter({
    origin: ORIGIN,
    fetch: async (input, init) => {
      assert.equal(input, url)
      assert.equal(init.method, 'GET')
      assert.equal(init.body, undefined)
      assert.equal(new Headers(init.headers).get('authorization')?.startsWith('BackupV1 '), true)
      return response(
        url,
        encodeEncryptedWalletBackupV2HttpResponse({
          kind: 'descriptor-page',
          requestDigest: requestDigest(proof),
          realm: REALM,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 3,
          body: encodeEncryptedWalletBackupV2DescriptorPage(page),
        }),
      )
    },
  })
  assert.equal(
    (await adapter.readDescriptorPage({ requestProof: proof, afterBundleId: null })).head
      .headVersion,
    0,
  )
  await assert.rejects(
    adapter.readDescriptorPage({ requestProof: proof, afterBundleId: '11'.repeat(16) }),
    (error) =>
      error instanceof EncryptedWalletBackupV2HttpTransportError &&
      error.code === 'invalid-request',
  )
})

test('V2 server content verification does not consume replay, but discovery does', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(8),
    realm: REALM,
    runtime: webcrypto,
  })
  const base = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${keyHandle.walletId}`
  const enrollment = {
    status: 'active' as const,
    protocolVersion: 2 as const,
    realm: REALM,
    walletId: keyHandle.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: 3,
  }
  const contentProof = await prepareProof(keyHandle, 3, 'GET', `${base}/head`, new Uint8Array())
  const content = verifyAndDecodeEncryptedWalletBackupV2DelegatedServerRequest({
    rawAuthorizationHeaderValues: [
      `BackupV1 ${base64Url(encodeEncryptedWalletBackupRequestProof(contentProof))}`,
    ],
    configuredOrigin: ORIGIN,
    rawTarget: `/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${keyHandle.walletId}/head`,
    method: 'GET',
    route: {
      operation: 'descriptor-page',
      routeRealm: REALM,
      routeWalletId: keyHandle.walletId,
      routeAfterBundleId: null,
    },
    payload: new Uint8Array(),
    serverNowUnixSeconds: 1_000,
  })
  assert.equal(
    authorizeVerifiedEncryptedWalletBackupV2DelegatedServerRequest({
      verifiedRequest: content,
      enrollment,
    }).operation,
    'descriptor-page',
  )
  let consumed = 0
  const discoveryProof = await prepareProof(
    keyHandle,
    0,
    'GET',
    `${base}/enrollment-epoch`,
    new Uint8Array(),
  )
  const discovery = verifyAndDecodeEncryptedWalletBackupV2DelegatedServerRequest({
    rawAuthorizationHeaderValues: [
      `BackupV1 ${base64Url(encodeEncryptedWalletBackupRequestProof(discoveryProof))}`,
    ],
    configuredOrigin: ORIGIN,
    rawTarget: `/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${keyHandle.walletId}/enrollment-epoch`,
    method: 'GET',
    route: { operation: 'enrollment-epoch', routeRealm: REALM, routeWalletId: keyHandle.walletId },
    payload: new Uint8Array(),
    serverNowUnixSeconds: 1_000,
  })
  const authorized = await consumeEncryptedWalletBackupV2EnrollmentDiscoveryReplay({
    verifiedRequest: discovery,
    enrollment,
    replayStore: {
      async consumeReplayNonce() {
        consumed += 1
        return 'consumed'
      },
    },
  })
  assert.equal(consumed, 1)
  assert.deepEqual(authorized.discovery, { status: 'active', enrollmentEpoch: 3 })
})

test('V2 server rejects a legacy enrollment at runtime', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(18),
    realm: REALM,
    runtime: webcrypto,
  })
  const base = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${keyHandle.walletId}`
  const proof = await prepareProof(keyHandle, 2, 'GET', `${base}/head`, new Uint8Array())
  const verified = verifyAndDecodeEncryptedWalletBackupV2DelegatedServerRequest({
    rawAuthorizationHeaderValues: [
      `BackupV1 ${base64Url(encodeEncryptedWalletBackupRequestProof(proof))}`,
    ],
    configuredOrigin: ORIGIN,
    rawTarget: `/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${keyHandle.walletId}/head`,
    method: 'GET',
    route: {
      operation: 'descriptor-page',
      routeRealm: REALM,
      routeWalletId: keyHandle.walletId,
      routeAfterBundleId: null,
    },
    payload: new Uint8Array(),
    serverNowUnixSeconds: 1_000,
  })
  const legacyEnrollment = {
    status: 'active',
    realm: REALM,
    walletId: keyHandle.walletId,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
    enrollmentEpoch: 2,
  } as unknown as EncryptedWalletBackupV2ServerEnrollment
  assert.throws(
    () =>
      authorizeVerifiedEncryptedWalletBackupV2DelegatedServerRequest({
        verifiedRequest: verified,
        enrollment: legacyEnrollment,
      }),
    (error) =>
      error instanceof EncryptedWalletBackupV2DelegatedServerRejection &&
      error.code === 'unauthorized' &&
      error.requestDigest === v2RequestDigest(proof),
  )
})

test('V2 discovery binds response epoch zero and returns the active enrollment epoch from its body', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(11),
    realm: REALM,
    runtime: webcrypto,
  })
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${keyHandle.walletId}/enrollment-epoch`
  const proof = await prepareEncryptedWalletBackupV2EnrollmentEpochDiscoveryProof({
    keyHandle,
    url,
    issuedAtUnixSeconds: 990,
    expiresAtUnixSeconds: 1_020,
    signal: AbortSignal.timeout(60_000),
    runtime: deterministic(['09'.repeat(16), '0a'.repeat(32)]),
  })
  const adapter = new EncryptedWalletBackupV2HttpAdapter({
    origin: ORIGIN,
    fetch: async () =>
      response(
        url,
        encodeEncryptedWalletBackupV2HttpResponse({
          kind: 'enrollment-epoch',
          requestDigest: requestDigest(proof),
          realm: REALM,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 0,
          body: encodeEncryptedWalletBackupV2EnrollmentEpochResult({
            result: 'active',
            enrollmentEpoch: 3,
          }),
        }),
      ),
  })
  assert.deepEqual(await adapter.discoverEnrollmentEpoch({ requestProof: proof }), {
    status: 'active',
    enrollmentEpoch: 3,
  })
})

test('V2 rejects malformed and oversized response bodies before a caller receives them', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(9),
    realm: REALM,
    runtime: webcrypto,
  })
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${keyHandle.walletId}/head`
  const proof = await prepareProof(keyHandle, 3, 'GET', url, new Uint8Array())
  const adapter = new EncryptedWalletBackupV2HttpAdapter({
    origin: ORIGIN,
    fetch: async () => response(url, new Uint8Array(300_257)),
  })
  await assert.rejects(
    adapter.readDescriptorPage({ requestProof: proof, afterBundleId: null }),
    (error) =>
      error instanceof EncryptedWalletBackupV2HttpTransportError &&
      error.code === 'invalid-response',
  )
  assert.throws(() =>
    encodeEncryptedWalletBackupV2EnrollmentEpochResult({ result: 'active', enrollmentEpoch: 0 }),
  )
})

test('V2 maps only request-bound canonical service failures', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(10),
    realm: REALM,
    runtime: webcrypto,
  })
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${keyHandle.walletId}/head`
  const proof = await prepareProof(keyHandle, 3, 'GET', url, new Uint8Array())
  for (const code of [
    'unauthorized',
    'replay-rejected',
    'conflict',
    'not-found',
    'quota-exceeded',
    'rate-limited',
    'overloaded',
    'unavailable',
  ] as const) {
    const adapter = new EncryptedWalletBackupV2HttpAdapter({
      origin: ORIGIN,
      fetch: async () =>
        response(
          url,
          encodeEncryptedWalletBackupV2HttpResponse({
            kind: 'error',
            requestDigest: requestDigest(proof),
            realm: REALM,
            walletId: keyHandle.walletId,
            enrollmentEpoch: 3,
            body: encodeEncryptedWalletBackupV2HttpError({
              operation: 'descriptor-page',
              code,
              retryAfterSeconds: code === 'rate-limited' ? 1 : null,
            }),
          }),
          errorStatus(code),
        ),
    })
    await assert.rejects(
      adapter.readDescriptorPage({ requestProof: proof, afterBundleId: null }),
      (error) =>
        error instanceof EncryptedWalletBackupV2HttpTransportError &&
        error.code === code &&
        error.retryAfterSeconds === (code === 'rate-limited' ? 1 : null),
    )
  }
  assert.throws(() =>
    encodeEncryptedWalletBackupV2HttpError({
      operation: 'descriptor-page',
      code: 'conflict',
      retryAfterSeconds: 1,
    }),
  )
  assert.throws(() =>
    encodeEncryptedWalletBackupV2HttpError({
      operation: 'descriptor-page',
      code: 'rate-limited',
      retryAfterSeconds: 0,
    }),
  )
  const mismatched = new EncryptedWalletBackupV2HttpAdapter({
    origin: ORIGIN,
    fetch: async () =>
      response(
        url,
        encodeEncryptedWalletBackupV2HttpResponse({
          kind: 'error',
          requestDigest: requestDigest(proof),
          realm: REALM,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 3,
          body: encodeEncryptedWalletBackupV2HttpError({
            operation: 'descriptor-page',
            code: 'conflict',
            retryAfterSeconds: null,
          }),
        }),
      ),
  })
  await assert.rejects(
    mismatched.readDescriptorPage({ requestProof: proof, afterBundleId: null }),
    (error) =>
      error instanceof EncryptedWalletBackupV2HttpTransportError &&
      error.code === 'invalid-response',
  )
})

test('V2 adapter sends one atomic upload and reads one immutable descriptor-bound object', async () => {
  const { key, prepared, mutation, group, post, receipt, object, objectProof } =
    await createV2HttpOperationFixture()
  const adapter = new EncryptedWalletBackupV2HttpAdapter({
    origin: ORIGIN,
    fetch: async (url, init) => {
      if (init.method === 'POST') {
        assert.equal(url, post.url)
        assert.equal((init.body as Uint8Array).byteLength, group.byteLength)
        return response(
          post.url,
          encodeEncryptedWalletBackupV2HttpResponse({
            kind: 'bundle-supersession-receipt',
            requestDigest: requestDigest(post),
            realm: REALM,
            walletId: key.walletId,
            enrollmentEpoch: 1,
            body: encodeEncryptedWalletBackupV2BundleSupersessionReceipt(receipt),
          }),
        )
      }
      assert.equal(url, objectProof.url)
      return response(
        objectProof.url,
        encodeEncryptedWalletBackupV2HttpResponse({
          kind: 'object',
          requestDigest: requestDigest(objectProof),
          realm: REALM,
          walletId: key.walletId,
          enrollmentEpoch: 1,
          body: encodeEncryptedWalletBackupV2BundleObjectWire(object, prepared.descriptor),
        }),
      )
    },
  })
  assert.equal(
    (await adapter.mutateHeadOnce({ requestProof: post, canonicalUploadGroup: group })).mutationId,
    mutation.mutation.mutationId,
  )
  assert.equal(
    (
      await adapter.readObject({
        requestProof: objectProof,
        objectId: object.objectId,
        expectedDescriptor: prepared.descriptor,
      })
    ).digest,
    object.digest,
  )
})

test('V2 adapter maps operation-specific conflict and object absence', async () => {
  const { key, prepared, group, post, object, objectProof } = await createV2HttpOperationFixture()
  const conflict = operationErrorAdapter(key, post, 'bundle-supersession', 'conflict', 409)
  await assert.rejects(
    conflict.mutateHeadOnce({ requestProof: post, canonicalUploadGroup: group }),
    hasTransportCode('conflict'),
  )
  const absent = operationErrorAdapter(key, objectProof, 'object-get', 'not-found', 404)
  await assert.rejects(
    absent.readObject({
      requestProof: objectProof,
      objectId: object.objectId,
      expectedDescriptor: prepared.descriptor,
    }),
    hasTransportCode('not-found'),
  )
})

test('V2 request authentication accepts one maximum fifteen-object upload group', async () => {
  const key = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(13),
    realm: REALM,
    runtime: webcrypto,
  })
  const objectCount = 15
  const random = deterministic([
    '21'.repeat(16),
    ...Array.from({ length: objectCount }, (_item, index) =>
      (index + 34).toString(16).padStart(2, '0').repeat(12),
    ),
  ])
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle: key,
    asset: { mintUrl: 'https://mint.example', unit: 'sat', assetIdentity: 'maximum' },
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: new Uint8Array(262_112 + 262_128 * 14),
    runtime: { subtle: webcrypto.subtle, getRandomValues: random.getRandomValues },
  })
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: key.walletId,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  })
  const mutation = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle: key,
    expectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(
      enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [] }),
    ),
    addedBundle: prepared.descriptor,
    supersededBundleIds: [],
    runtime: deterministic(['31'.repeat(16), '32'.repeat(32)]),
  })
  const group = encodeEncryptedWalletBackupV2UploadGroup({
    envelope: mutation,
    objects: prepared.objects,
  })
  assert.equal(group.byteLength > 272 * 1_024, true)
  assert.equal(group.byteLength <= ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES, true)
  const base = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${key.walletId}`
  const proof = await prepareV2Proof(key, 'POST', `${base}/head:compare-and-swap`, group, [
    '33'.repeat(16),
    '34'.repeat(32),
  ])
  verifyV2Post(key, proof, group, mutation.requestDigest)
  const adapter = operationErrorAdapter(key, proof, 'bundle-supersession', 'conflict', 409)
  await assert.rejects(
    adapter.mutateHeadOnce({ requestProof: proof, canonicalUploadGroup: group }),
    hasTransportCode('conflict'),
  )
})

async function createV2HttpOperationFixture() {
  const key = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(12),
    realm: REALM,
    runtime: webcrypto,
  })
  const initial = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: key.walletId,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  })
  const random = deterministic(['01'.repeat(16), '02'.repeat(12)])
  const prepared = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle: key,
    asset: { mintUrl: 'https://mint.example', unit: 'sat', assetIdentity: 'x' },
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: Uint8Array.of(1),
    runtime: { subtle: webcrypto.subtle, getRandomValues: random.getRandomValues },
  })
  const mutation = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle: key,
    expectedHeadEvidence: collectEncryptedWalletBackupV2DescriptorPages(
      enumerateEncryptedWalletBackupV2DescriptorPages({ head: initial, bundles: [] }),
    ),
    addedBundle: prepared.descriptor,
    supersededBundleIds: [],
    runtime: deterministic(['03'.repeat(16), '04'.repeat(32)]),
  })
  const group = encodeEncryptedWalletBackupV2UploadGroup({
    envelope: mutation,
    objects: prepared.objects,
  })
  const base = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${key.walletId}`
  const post = await prepareV2Proof(key, 'POST', `${base}/head:compare-and-swap`, group, [
    '05'.repeat(16),
    '06'.repeat(32),
  ])
  const result = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    walletId: key.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [prepared.descriptor],
  })
  const evidence = decodeEncryptedWalletBackupV2UploadGroup({
    bytes: group,
    expectedRequestAuthPublicKey: key.requestAuthPublicKey,
    expectedContext: { realm: REALM, walletId: key.walletId, enrollmentEpoch: 1 },
  }).mutationEvidence
  const privateKey = Uint8Array.from({ length: 32 }, () => 5)
  const receipt = await issueEncryptedWalletBackupV2BundleSupersessionReceipt({
    mutationEvidence: evidence,
    resultHead: result,
    signingKeyId: '06'.repeat(16),
    signingPublicKey: bytesToHex(schnorr.getPublicKey(privateKey)),
    signDigest: (digest) => schnorr.sign(digest, privateKey),
  })
  const object = prepared.objects[0]!
  const objectProof = await prepareV2Proof(
    key,
    'GET',
    `${base}/objects/${object.objectId}`,
    new Uint8Array(),
    ['07'.repeat(16), '08'.repeat(32)],
  )
  verifyV2Post(key, post, group, mutation.requestDigest)
  return { key, prepared, mutation, group, post, receipt, object, objectProof }
}

function verifyV2Post(
  key: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
  proof: EncryptedWalletBackupRequestProof,
  payload: Uint8Array,
  expectedMutationDigest: string,
): void {
  const route = `/v1/encrypted-wallet-backup/realms/${REALM}/wallets/${key.walletId}/head:compare-and-swap`
  const verified = verifyAndDecodeEncryptedWalletBackupV2DelegatedServerRequest({
    rawAuthorizationHeaderValues: [
      `BackupV1 ${base64Url(
        encodeEncryptedWalletBackupRequestProof(
          proof,
          ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
        ),
      )}`,
    ],
    configuredOrigin: ORIGIN,
    rawTarget: route,
    method: 'POST',
    route: { operation: 'bundle-supersession', routeRealm: REALM, routeWalletId: key.walletId },
    payload,
    serverNowUnixSeconds: 1_000,
  })
  const authorized = authorizeVerifiedEncryptedWalletBackupV2DelegatedServerRequest({
    verifiedRequest: verified,
    enrollment: {
      status: 'active',
      protocolVersion: 2,
      realm: REALM,
      walletId: key.walletId,
      requestAuthPublicKey: key.requestAuthPublicKey,
      enrollmentEpoch: 1,
    },
  })
  assert.equal(
    authorized.decodedUploadGroup?.mutationEvidence.envelope.requestDigest,
    expectedMutationDigest,
  )
}

function operationErrorAdapter(
  key: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
  proof: EncryptedWalletBackupRequestProof,
  operation: 'bundle-supersession' | 'object-get',
  code: 'conflict' | 'not-found',
  status: 404 | 409,
): EncryptedWalletBackupV2HttpAdapter {
  return new EncryptedWalletBackupV2HttpAdapter({
    origin: ORIGIN,
    fetch: async () =>
      response(
        proof.url,
        encodeEncryptedWalletBackupV2HttpResponse({
          kind: 'error',
          requestDigest: v2RequestDigest(proof),
          realm: REALM,
          walletId: key.walletId,
          enrollmentEpoch: 1,
          body: encodeEncryptedWalletBackupV2HttpError({
            operation,
            code,
            retryAfterSeconds: null,
          }),
        }),
        status,
      ),
  })
}

function hasTransportCode(code: 'conflict' | 'not-found') {
  return (error: unknown): boolean =>
    error instanceof EncryptedWalletBackupV2HttpTransportError && error.code === code
}

async function prepareProof(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
  enrollmentEpoch: number,
  method: 'GET',
  url: string,
  payload: Uint8Array,
): Promise<
  ReturnType<typeof prepareEncryptedWalletBackupV2RequestProof> extends Promise<infer T> ? T : never
> {
  if (enrollmentEpoch === 0) {
    return prepareEncryptedWalletBackupV2EnrollmentEpochDiscoveryProof({
      keyHandle,
      url,
      issuedAtUnixSeconds: 990,
      expiresAtUnixSeconds: 1_020,
      signal: AbortSignal.timeout(60_000),
      runtime: globalThis.crypto,
    })
  }
  return prepareEncryptedWalletBackupV2RequestProof({
    keyHandle,
    enrollmentEpoch,
    method,
    url,
    issuedAtUnixSeconds: 990,
    expiresAtUnixSeconds: 1_020,
    payload,
    signal: AbortSignal.timeout(60_000),
    runtime: globalThis.crypto,
  })
}

function requestDigest(proof: EncryptedWalletBackupRequestProof): string {
  return encryptedWalletBackupRequestDigest(
    proof,
    ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
  )
}

function v2RequestDigest(proof: EncryptedWalletBackupRequestProof): string {
  return encryptedWalletBackupRequestDigest(
    proof,
    ENCRYPTED_WALLET_BACKUP_V2_REQUEST_PAYLOAD_MAX_BYTES,
  )
}

function response(url: string, body: Uint8Array, status = 200): Response {
  return {
    status,
    url,
    redirected: false,
    headers: new Headers({
      'content-type': 'application/cbor',
      'cache-control': 'private, no-store',
    }),
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(body)
        controller.close()
      },
    }),
  } as Response
}

function errorStatus(
  code:
    | 'unauthorized'
    | 'replay-rejected'
    | 'conflict'
    | 'not-found'
    | 'quota-exceeded'
    | 'rate-limited'
    | 'overloaded'
    | 'unavailable',
): number {
  switch (code) {
    case 'unauthorized':
      return 401
    case 'replay-rejected':
    case 'conflict':
      return 409
    case 'not-found':
      return 404
    case 'quota-exceeded':
      return 413
    case 'rate-limited':
      return 429
    case 'overloaded':
    case 'unavailable':
      return 503
  }
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function deterministic(values: string[]) {
  const queue = values.map((v) =>
    Uint8Array.from(v.match(/../g)!.map((x) => Number.parseInt(x, 16))),
  )
  return {
    getRandomValues(target: Uint8Array) {
      const value = queue.shift()!
      target.set(value)
      return target
    },
  }
}
function prepareV2Proof(
  keyHandle: Awaited<ReturnType<typeof createEncryptedWalletBackupV2KeyHandle>>,
  method: 'GET' | 'POST',
  url: string,
  payload: Uint8Array,
  random: readonly string[],
): Promise<EncryptedWalletBackupRequestProof> {
  return prepareEncryptedWalletBackupV2RequestProof({
    keyHandle,
    enrollmentEpoch: 1,
    method,
    url,
    issuedAtUnixSeconds: 990,
    expiresAtUnixSeconds: 1_020,
    payload,
    signal: AbortSignal.timeout(60_000),
    runtime: deterministic([...random]),
  })
}
