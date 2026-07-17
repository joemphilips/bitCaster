import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  createEncryptedWalletBackupKeyHandle,
  encodeEncryptedWalletBackupRequestProof,
  encryptedWalletBackupRequestDigest,
  type EncryptedWalletBackupRequestProof,
} from '../src/encryptedWalletBackup.ts'
import { prepareEncryptedWalletBackupAccountOperation } from '../src/encryptedWalletBackupEnrollment.ts'
import {
  EncryptedWalletBackupHttpAdapter,
  EncryptedWalletBackupHttpTransportError,
} from '../src/encryptedWalletBackupHttpAdapter.ts'
import { encodeEncryptedWalletBackupHttpResponse } from '../src/encryptedWalletBackupHttpCodec.ts'
import { encodeCanonicalBackupCbor } from '../src/encryptedWalletBackupCbor.ts'

const ORIGIN = 'https://backup.example'
const REALM = 'adapter-test'
const VAULT_ID = '11'.repeat(32)
const PUBLIC_KEY = '12'.repeat(32)
const EMPTY_DIGEST = bytesToHex(sha256(new Uint8Array()))
const ATTEMPT_ID = '18'.repeat(16)
const OBJECT_ID = '15'.repeat(16)
const MINIMAL_PUT_PAYLOAD = encodeCanonicalBackupCbor([
  1,
  'object-put',
  hexToBytes(ATTEMPT_ID),
  2,
  REALM,
  hexToBytes(VAULT_ID),
  hexToBytes(OBJECT_ID),
  1,
  65_536,
  hexToBytes('19'.repeat(32)),
  Uint8Array.of(1),
  new Uint8Array(65_564),
])
const MINIMAL_CAS_PAYLOAD = encodeCanonicalBackupCbor([
  1,
  'head-cas',
  hexToBytes(ATTEMPT_ID),
  null,
  Uint8Array.of(1),
  Uint8Array.of(2),
])
const MINIMAL_ABORT_PAYLOAD = encodeCanonicalBackupCbor([
  1,
  'upload-attempt-abort',
  hexToBytes(ATTEMPT_ID),
  hexToBytes('19'.repeat(32)),
])

test('delegated GET uses the exact endpoint, proof header, zero body, and hardened fetch options', async () => {
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/head`
  const proof = fakeProof('GET', url, new Uint8Array())
  const requestDigest = encryptedWalletBackupRequestDigest(proof)
  let calls = 0
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async (input, init) => {
      calls += 1
      assert.equal(input, url)
      assert.equal(init?.method, 'GET')
      assert.equal(init?.body, undefined)
      assert.equal(init?.redirect, 'error')
      assert.equal(init?.credentials, 'omit')
      assert.equal(init?.referrerPolicy, 'no-referrer')
      assert.equal(init?.cache, 'no-store')
      const headers = new Headers(init?.headers)
      assert.equal(headers.get('accept'), 'application/cbor')
      assert.equal(headers.get('content-type'), 'application/cbor')
      assert.equal(headers.get('cache-control'), 'no-store')
      assert.equal(
        headers.get('authorization'),
        `BackupV1 ${base64Url(encodeEncryptedWalletBackupRequestProof(proof))}`,
      )
      return response(
        url,
        200,
        encodeEncryptedWalletBackupHttpResponse({
          kind: 'head-result',
          requestDigest,
          result: 'not-found',
          enrollmentEpoch: 3,
        }),
      )
    },
  })

  assert.deepEqual(await adapter.readCurrentHead({ requestProof: proof }), {
    status: 'not-found',
  })
  assert.equal(calls, 1)
})

test('account lifecycle sends only the scheme-neutral CBOR envelope', async () => {
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults:enroll`
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: new Uint8Array(64).fill(8),
    realm: REALM,
  })
  const operation = await prepareEncryptedWalletBackupAccountOperation({
    keyHandle,
    action: 'enroll',
    url,
    operationId: '13'.repeat(16),
    expectedEnrollmentEpoch: 0,
    signal: AbortSignal.timeout(60_000),
    authorizationPort: {
      async authorizeBackupAccountOperation() {
        return { scheme: 'test', authorization: Uint8Array.of(1, 2, 3) }
      },
    },
  })
  const canonicalRequest = operation.canonicalRequest
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async (_input, init) => {
      const headers = new Headers(init?.headers)
      assert.equal(headers.has('authorization'), false)
      assert.strictEqual(init?.body, canonicalRequest)
      return response(
        url,
        200,
        encodeEncryptedWalletBackupHttpResponse({
          kind: 'account-result',
          operationId: operation.operationId,
          intentDigest: operation.intentDigest,
          result: 'committed',
          enrollmentEpoch: 3,
          lifecycle: 'active',
        }),
      )
    },
  })

  assert.equal(
    (
      await adapter.executeAccountOperation({
        operation,
        canonicalRequest,
      })
    ).status,
    'committed',
  )
})

test('account revoke and delete bind their exact vault endpoints and methods', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: new Uint8Array(64).fill(9),
    realm: REALM,
  })
  for (const [index, action] of (['revoke', 'delete'] as const).entries()) {
    const method = action === 'delete' ? ('DELETE' as const) : ('POST' as const)
    const suffix =
      action === 'delete' ? `/vaults/${keyHandle.vaultId}` : `/vaults/${keyHandle.vaultId}:revoke`
    const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}${suffix}`
    const operation = await prepareEncryptedWalletBackupAccountOperation({
      keyHandle,
      action,
      url,
      operationId: `${index + 4}`.repeat(32),
      expectedEnrollmentEpoch: 3,
      signal: AbortSignal.timeout(60_000),
      authorizationPort: {
        async authorizeBackupAccountOperation() {
          return { scheme: 'test', authorization: Uint8Array.of(1) }
        },
      },
    })
    const adapter = new EncryptedWalletBackupHttpAdapter({
      origin: ORIGIN,
      fetch: async (input, init) => {
        assert.equal(input, url)
        assert.equal(init?.method, method)
        assert.equal(new Headers(init?.headers).has('authorization'), false)
        assert.strictEqual(init?.body, operation.canonicalRequest)
        return response(
          url,
          200,
          encodeEncryptedWalletBackupHttpResponse({
            kind: 'account-result',
            operationId: operation.operationId,
            intentDigest: operation.intentDigest,
            result: 'committed',
            enrollmentEpoch: 4,
            lifecycle: action === 'delete' ? 'deleted' : 'revoked',
          }),
        )
      },
    })
    assert.equal(
      (
        await adapter.executeAccountOperation({
          operation,
          canonicalRequest: operation.canonicalRequest,
        })
      ).status,
      'committed',
    )
  }
})

test('account enrollment exposes lifetime quota refusal while revoke and delete reject it', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: new Uint8Array(64).fill(10),
    realm: REALM,
  })
  for (const action of ['enroll', 'revoke', 'delete'] as const) {
    const suffix =
      action === 'enroll'
        ? '/vaults:enroll'
        : action === 'revoke'
          ? `/vaults/${keyHandle.vaultId}:revoke`
          : `/vaults/${keyHandle.vaultId}`
    const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}${suffix}`
    const operation = await prepareEncryptedWalletBackupAccountOperation({
      keyHandle,
      action,
      url,
      operationId:
        action === 'enroll'
          ? '21'.repeat(16)
          : action === 'revoke'
            ? '22'.repeat(16)
            : '23'.repeat(16),
      expectedEnrollmentEpoch: action === 'enroll' ? 0 : 3,
      signal: AbortSignal.timeout(60_000),
      authorizationPort: {
        async authorizeBackupAccountOperation() {
          return { scheme: 'test', authorization: Uint8Array.of(1) }
        },
      },
    })
    const adapter = new EncryptedWalletBackupHttpAdapter({
      origin: ORIGIN,
      fetch: async () =>
        response(
          url,
          429,
          encodeEncryptedWalletBackupHttpResponse({
            kind: 'error',
            code: 'quota-exceeded',
            retryAfterSeconds: null,
          }),
        ),
    })
    const execute = () =>
      adapter.executeAccountOperation({
        operation,
        canonicalRequest: operation.canonicalRequest,
      })
    if (action === 'enroll') {
      assert.deepEqual(await execute(), {
        status: 'quota-exceeded',
        retryAfterSeconds: null,
      })
    } else {
      await assert.rejects(
        execute,
        (error) =>
          error instanceof EncryptedWalletBackupHttpTransportError &&
          error.code === 'invalid-response' &&
          error.dispatchState === 'uncertain',
      )
    }
  }
})

test('fifth concurrent operation fails before inspecting proof or calling fetch', async () => {
  const releases: (() => void)[] = []
  let fetchCalls = 0
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async (input) => {
      fetchCalls += 1
      await new Promise<void>((resolve) => releases.push(resolve))
      return response(
        String(input),
        200,
        encodeEncryptedWalletBackupHttpResponse({
          kind: 'head-result',
          requestDigest: encryptedWalletBackupRequestDigest(
            fakeProof('GET', String(input), new Uint8Array()),
          ),
          result: 'not-found',
          enrollmentEpoch: 3,
        }),
      )
    },
  })
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/head`
  const running = Array.from({ length: 4 }, () =>
    adapter.readCurrentHead({
      requestProof: fakeProof('GET', url, new Uint8Array()),
    }),
  )
  await Promise.resolve()
  const fifthInput = Object.defineProperty({}, 'requestProof', {
    get(): never {
      throw new Error('proof was inspected')
    },
  })
  await assert.rejects(
    adapter.readCurrentHead(fifthInput as never),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'concurrency-exhausted' &&
      error.dispatchState === 'not-dispatched',
  )
  assert.equal(fetchCalls, 4)
  for (const release of releases) release()
  await Promise.all(running)
})

test('response body limits are enforced before and during streaming', async () => {
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/head`
  const proof = fakeProof('GET', url, new Uint8Array())
  let cancelled = false
  const oversized = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(132_097))
    },
    cancel() {
      cancelled = true
    },
  })
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async () => response(url, 200, oversized),
  })
  await assert.rejects(
    adapter.readCurrentHead({ requestProof: proof }),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError && error.code === 'invalid-response',
  )
  assert.equal(cancelled, true)

  const declared = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async () =>
      response(url, 200, new Uint8Array(), {
        'content-length': '132097',
      }),
  })
  await assert.rejects(declared.readCurrentHead({ requestProof: proof }))

  let emitted = 0
  let fragmentedCancelled = false
  const fragmented = new ReadableStream<Uint8Array>({
    pull(controller) {
      emitted += 1
      controller.enqueue(Uint8Array.of(1))
    },
    cancel() {
      fragmentedCancelled = true
    },
  })
  const fragmentedAdapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async () => response(url, 200, fragmented),
  })
  await assert.rejects(fragmentedAdapter.readCurrentHead({ requestProof: proof }))
  assert.ok(emitted >= 4_097 && emitted <= 4_099)
  assert.equal(fragmentedCancelled, true)

  let emptyReads = 0
  let emptyCancelled = false
  const emptyChunks = new ReadableStream<Uint8Array>({
    pull(controller) {
      emptyReads += 1
      controller.enqueue(new Uint8Array())
    },
    cancel() {
      emptyCancelled = true
    },
  })
  const emptyAdapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async () => response(url, 200, emptyChunks),
  })
  await assert.rejects(emptyAdapter.readCurrentHead({ requestProof: proof }))
  assert.ok(emptyReads >= 4_097 && emptyReads <= 4_099)
  assert.equal(emptyCancelled, true)
})

test('deadline abort cancels and awaits the response reader, marks a dispatched mutation uncertain, and never retries', async () => {
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/objects/${'15'.repeat(16)}`
  const payload = MINIMAL_PUT_PAYLOAD
  const proof = fakeProof('PUT', url, payload)
  let fetchCalls = 0
  let cancelFinished = false
  const stalled = new ReadableStream<Uint8Array>({
    pull() {},
    async cancel() {
      await Promise.resolve()
      cancelFinished = true
    },
  })
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fallbackTimeoutMilliseconds: 10,
    fetch: async () => {
      fetchCalls += 1
      return response(url, 200, stalled)
    },
  })
  await assert.rejects(
    adapter.putObject({
      requestProof: proof,
      canonicalPutPayload: payload,
    }),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'deadline-exceeded' &&
      error.dispatchState === 'uncertain',
  )
  await waitFor(() => cancelFinished)
  assert.equal(cancelFinished, true)
  assert.equal(fetchCalls, 1)
})

test('a never-settling response cancellation returns the public deadline but keeps permits fail-closed', async () => {
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/objects/${OBJECT_ID}`
  const proof = fakeProof('PUT', url, MINIMAL_PUT_PAYLOAD)
  let fetchCalls = 0
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fallbackTimeoutMilliseconds: 10,
    fetch: async () => {
      fetchCalls += 1
      return response(
        url,
        200,
        new ReadableStream<Uint8Array>({
          pull() {},
          cancel() {
            return new Promise<void>(() => undefined)
          },
        }),
      )
    },
  })
  const running = Array.from({ length: 4 }, () =>
    adapter
      .putObject({
        requestProof: proof,
        canonicalPutPayload: MINIMAL_PUT_PAYLOAD,
      })
      .then(
        () => 'fulfilled' as const,
        (error: unknown) => error,
      ),
  )
  const visible = await Promise.all(running)
  for (const result of visible) {
    assert.ok(result instanceof EncryptedWalletBackupHttpTransportError)
    assert.equal(result.code, 'deadline-exceeded')
    assert.equal(result.dispatchState, 'uncertain')
  }
  await assert.rejects(
    adapter.putObject({
      requestProof: proof,
      canonicalPutPayload: MINIMAL_PUT_PAYLOAD,
    }),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'concurrency-exhausted',
  )
  assert.equal(fetchCalls, 4)

  await new Promise((resolve) => setTimeout(resolve, 250))
  await assert.rejects(
    adapter.putObject({
      requestProof: proof,
      canonicalPutPayload: MINIMAL_PUT_PAYLOAD,
    }),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'concurrency-exhausted',
  )
  assert.equal(fetchCalls, 4)
})

test('transport rejects redirects, final URL drift, response metadata, and invalid origins without leaking details', async () => {
  assert.throws(() => new EncryptedWalletBackupHttpAdapter({ origin: 'http://backup.example' }))
  assert.throws(() => new EncryptedWalletBackupHttpAdapter({ origin: `${ORIGIN}/path` }))
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/head`
  const proof = fakeProof('GET', url, new Uint8Array())
  for (const bad of [
    response(`${ORIGIN}/other`, 200, new Uint8Array()),
    response(url, 200, new Uint8Array(), {
      'content-type': 'application/cbor; charset=utf-8',
    }),
    response(url, 200, new Uint8Array(), { 'cache-control': 'public' }),
    response(url, 200, new Uint8Array(), { 'content-encoding': 'gzip' }),
  ]) {
    const adapter = new EncryptedWalletBackupHttpAdapter({
      origin: ORIGIN,
      fetch: async () => bad,
    })
    await assert.rejects(adapter.readCurrentHead({ requestProof: proof }), (error) => {
      assert.equal(String(error).includes(ORIGIN), false)
      assert.equal(String(error).includes(VAULT_ID), false)
      return error instanceof EncryptedWalletBackupHttpTransportError
    })
  }
})

test('all delegated mutation endpoints preserve exact bodies and never turn cleanup into authority', async () => {
  const objectId = OBJECT_ID
  const attemptId = ATTEMPT_ID
  const objectUrl = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/objects/${objectId}`
  const casUrl = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/head:compare-and-swap`
  const abortUrl = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/upload-attempts/${attemptId}`
  const putBody = MINIMAL_PUT_PAYLOAD
  const casBody = MINIMAL_CAS_PAYLOAD
  const abortBody = MINIMAL_ABORT_PAYLOAD
  const proofs = new Map<string, EncryptedWalletBackupRequestProof>([
    [objectUrl, fakeProof('PUT', objectUrl, putBody)],
    [casUrl, fakeProof('POST', casUrl, casBody)],
    [abortUrl, fakeProof('DELETE', abortUrl, abortBody)],
  ])
  const deleteProof = fakeProof('DELETE', objectUrl, new Uint8Array())
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async (input, init) => {
      const url = String(input)
      const headers = new Headers(init?.headers)
      assert.match(headers.get('authorization') ?? '', /^BackupV1 /u)
      if (url === objectUrl && init?.method === 'DELETE') {
        assert.equal(init.body, undefined)
        assert.equal(deleteProof.payloadLength, 0)
        assert.equal(deleteProof.payloadDigest, EMPTY_DIGEST)
        return response(
          url,
          200,
          encodeEncryptedWalletBackupHttpResponse({
            kind: 'object-delete-result',
            requestDigest: encryptedWalletBackupRequestDigest(deleteProof),
            result: 'deleted',
          }),
        )
      }
      const proof = proofs.get(url)
      assert.ok(proof)
      const expectedBody = url === objectUrl ? putBody : url === casUrl ? casBody : abortBody
      assert.strictEqual(init?.body, expectedBody)
      if (url === objectUrl) {
        return response(
          url,
          200,
          encodeEncryptedWalletBackupHttpResponse({
            kind: 'object-put-result',
            requestDigest: encryptedWalletBackupRequestDigest(proof),
            result: 'stored',
          }),
        )
      }
      if (url === casUrl) {
        return response(
          url,
          200,
          encodeEncryptedWalletBackupHttpResponse({
            kind: 'head-cas-result',
            requestDigest: encryptedWalletBackupRequestDigest(proof),
            result: 'conflict',
          }),
        )
      }
      return response(
        url,
        200,
        encodeEncryptedWalletBackupHttpResponse({
          kind: 'upload-attempt-abort-result',
          requestDigest: encryptedWalletBackupRequestDigest(proof),
          result: 'abandoned',
        }),
      )
    },
  })

  assert.deepEqual(
    await adapter.putObject({
      requestProof: proofs.get(objectUrl)!,
      canonicalPutPayload: putBody,
    }),
    { status: 'stored' },
  )
  assert.deepEqual(
    await adapter.compareAndSwapCurrentHead({
      requestProof: proofs.get(casUrl)!,
      canonicalCasPayload: casBody,
    }),
    { status: 'conflict' },
  )
  assert.deepEqual(
    await adapter.abortUploadAttempt({
      requestProof: proofs.get(abortUrl)!,
      canonicalAbortPayload: abortBody,
    }),
    { status: 'abandoned' },
  )
  const deletion = await adapter.deleteObject({ requestProof: deleteProof })
  assert.deepEqual(deletion, { status: 'deleted' })
  assert.equal('receipt' in deletion, false)
  assert.equal('head' in deletion, false)
  assert.equal('eviction' in deletion, false)
})

test('quota rejection and retry hints remain explicit adapter results', async () => {
  const casUrl = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/head:compare-and-swap`
  const headUrl = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/head`
  const casProof = fakeProof('POST', casUrl, MINIMAL_CAS_PAYLOAD)
  const headProof = fakeProof('GET', headUrl, new Uint8Array())
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async (input) => {
      if (input === casUrl) {
        return response(
          casUrl,
          429,
          encodeEncryptedWalletBackupHttpResponse({
            kind: 'error',
            code: 'quota-exceeded',
            retryAfterSeconds: null,
          }),
        )
      }
      return response(
        headUrl,
        429,
        encodeEncryptedWalletBackupHttpResponse({
          kind: 'error',
          code: 'rate-limited',
          retryAfterSeconds: 17,
        }),
      )
    },
  })

  assert.deepEqual(
    await adapter.compareAndSwapCurrentHead({
      requestProof: casProof,
      canonicalCasPayload: MINIMAL_CAS_PAYLOAD,
    }),
    { status: 'quota-exceeded', retryAfterSeconds: null },
  )
  assert.deepEqual(await adapter.readCurrentHead({ requestProof: headProof }), {
    status: 'rate-limited',
    retryAfterSeconds: 17,
  })
})

test('semantic not-found requires a successful response and generic HTTP 404 fails closed', async () => {
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/head`
  const proof = fakeProof('GET', url, new Uint8Array())
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async () =>
      response(
        url,
        404,
        encodeEncryptedWalletBackupHttpResponse({
          kind: 'error',
          code: 'not-found',
          retryAfterSeconds: null,
        }),
      ),
  })

  await assert.rejects(
    adapter.readCurrentHead({ requestProof: proof }),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'remote-rejected' &&
      error.dispatchState === 'dispatched',
  )
})

test('operation-specific payload preflights reject malformed mutations before fetch', async () => {
  let fetchCalls = 0
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async () => {
      fetchCalls += 1
      throw new Error('fetch must not run')
    },
  })
  const objectUrl = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/objects/${OBJECT_ID}`
  const casUrl = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/head:compare-and-swap`
  const abortUrl = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/upload-attempts/${ATTEMPT_ID}`
  const malformed = Uint8Array.of(1)
  const calls = [
    () =>
      adapter.putObject({
        requestProof: fakeProof('PUT', objectUrl, malformed),
        canonicalPutPayload: malformed,
      }),
    () =>
      adapter.compareAndSwapCurrentHead({
        requestProof: fakeProof('POST', casUrl, malformed),
        canonicalCasPayload: malformed,
      }),
    () =>
      adapter.abortUploadAttempt({
        requestProof: fakeProof('DELETE', abortUrl, malformed),
        canonicalAbortPayload: malformed,
      }),
  ]
  for (const call of calls) {
    await assert.rejects(
      call(),
      (error) =>
        error instanceof EncryptedWalletBackupHttpTransportError &&
        error.code === 'invalid-request' &&
        error.dispatchState === 'not-dispatched',
    )
  }
  assert.equal(fetchCalls, 0)
})

test('a response stream failure remains a transport failure with uncertain mutation state', async () => {
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/objects/${OBJECT_ID}`
  const proof = fakeProof('PUT', url, MINIMAL_PUT_PAYLOAD)
  const broken = new ReadableStream<Uint8Array>({
    pull() {
      throw new Error('secret stream detail')
    },
  })
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async () => response(url, 200, broken),
  })

  await assert.rejects(
    adapter.putObject({
      requestProof: proof,
      canonicalPutPayload: MINIMAL_PUT_PAYLOAD,
    }),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'transport-failure' &&
      error.dispatchState === 'uncertain' &&
      !String(error).includes('secret stream detail'),
  )
})

test('object GET streams one exact bound object and returns parsed data without storage authority', async () => {
  const objectId = '15'.repeat(16)
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/objects/${objectId}`
  const proof = fakeProof('GET', url, new Uint8Array())
  const aad = encodeCanonicalBackupCbor([
    1,
    2,
    REALM,
    hexToBytes(VAULT_ID),
    hexToBytes(objectId),
    2,
    65_536,
  ])
  const encryptedBody = new Uint8Array(65_564).fill(23)
  const objectDigest = framedDigest(aad, encryptedBody)
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async (_input, init) => {
      assert.equal(init?.body, undefined)
      return response(
        url,
        200,
        encodeEncryptedWalletBackupHttpResponse({
          kind: 'object-result',
          requestDigest: encryptedWalletBackupRequestDigest(proof),
          result: 'found',
          kindCode: 2,
          realm: REALM,
          vaultId: VAULT_ID,
          objectId,
          generation: 2,
          paddedLength: 65_536,
          objectDigest,
          aad,
          encryptedBody,
        }),
      )
    },
  })
  const found = await adapter.getObject({
    requestProof: proof,
    expectedKindCode: 2,
    expectedObjectDigest: objectDigest,
    currentHeadGeneration: 2,
  })
  assert.equal(found.status, 'found')
  if (found.status !== 'found') throw new Error('expected found object')
  assert.equal(found.objectDigest, objectDigest)
  assert.equal(found.encryptedBody.byteLength, 65_564)
  assert.equal('authority' in found, false)
})

test('caller abort and saturation fail before protected input access, and slots are released', async () => {
  const controller = new AbortController()
  controller.abort()
  let proofReads = 0
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async () => {
      throw new Error('fetch must not run')
    },
  })
  const input = {
    signal: controller.signal,
    get requestProof(): never {
      proofReads += 1
      throw new Error('proof must not be read')
    },
  }
  await assert.rejects(
    adapter.readCurrentHead(input),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'deadline-exceeded' &&
      error.dispatchState === 'not-dispatched',
  )
  assert.equal(proofReads, 0)

  for (let index = 0; index < 6; index += 1) {
    await assert.rejects(
      adapter.readCurrentHead({ signal: {} as AbortSignal } as never),
      (error) =>
        error instanceof EncryptedWalletBackupHttpTransportError &&
        error.code === 'invalid-request' &&
        error.dispatchState === 'not-dispatched',
    )
  }

  const hostileShape = {
    get aborted(): never {
      throw new Error('hostile aborted getter')
    },
    addEventListener(): never {
      throw new Error('hostile add listener')
    },
    removeEventListener(): never {
      throw new Error('hostile remove listener')
    },
  }
  await assert.rejects(
    adapter.readCurrentHead({ signal: hostileShape as never } as never),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'invalid-request' &&
      !String(error).includes('hostile'),
  )

  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/head`
  const proof = fakeProof('GET', url, new Uint8Array())
  const overridden = new AbortController().signal
  Object.defineProperties(overridden, {
    aborted: {
      get(): never {
        throw new Error('hostile genuine getter')
      },
    },
    addEventListener: {
      value(): never {
        throw new Error('hostile genuine add listener')
      },
    },
    removeEventListener: {
      value(): never {
        throw new Error('hostile genuine remove listener')
      },
    },
  })
  await assert.rejects(
    adapter.readCurrentHead({ requestProof: proof, signal: overridden }),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'transport-failure' &&
      !String(error).includes('hostile'),
  )
  for (let index = 0; index < 6; index += 1) {
    await assert.rejects(adapter.readCurrentHead({ requestProof: proof }))
  }
})

test('a dispatched mutation transport failure is uncertain and is never retried', async () => {
  const objectId = '15'.repeat(16)
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/objects/${objectId}`
  const body = MINIMAL_PUT_PAYLOAD
  const proof = fakeProof('PUT', url, body)
  let calls = 0
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fetch: async () => {
      calls += 1
      throw new Error('secret upstream detail')
    },
  })
  await assert.rejects(
    adapter.putObject({ requestProof: proof, canonicalPutPayload: body }),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'transport-failure' &&
      error.dispatchState === 'uncertain' &&
      !String(error).includes('secret upstream detail'),
  )
  assert.equal(calls, 1)
})

test('fetch-stage abort retains all four slots until late responses are cancelled', async () => {
  const objectId = '15'.repeat(16)
  const url = `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${VAULT_ID}/objects/${objectId}`
  const body = MINIMAL_PUT_PAYLOAD
  const proof = fakeProof('PUT', url, body)
  const resolvers: Array<(response: Response) => void> = []
  let cancelled = 0
  const adapter = new EncryptedWalletBackupHttpAdapter({
    origin: ORIGIN,
    fallbackTimeoutMilliseconds: 10,
    fetch: async () => new Promise<Response>((resolve) => resolvers.push(resolve)),
  })
  const running = Array.from({ length: 4 }, () =>
    adapter
      .putObject({
        requestProof: proof,
        canonicalPutPayload: body,
      })
      .then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      ),
  )
  await new Promise((resolve) => setTimeout(resolve, 20))
  await assert.rejects(
    adapter.putObject({ requestProof: proof, canonicalPutPayload: body }),
    (error) =>
      error instanceof EncryptedWalletBackupHttpTransportError &&
      error.code === 'concurrency-exhausted' &&
      error.dispatchState === 'not-dispatched',
  )
  assert.equal(resolvers.length, 4)
  for (const resolve of resolvers) {
    const stream = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled += 1
      },
    })
    resolve(response(url, 200, stream))
  }
  const settled = await Promise.all(running)
  await waitFor(() => cancelled === 4)
  assert.equal(cancelled, 4)
  for (const item of settled) {
    assert.equal(item.status, 'rejected')
    if (item.status === 'rejected') {
      assert.ok(item.reason instanceof EncryptedWalletBackupHttpTransportError)
      assert.equal(item.reason.code, 'deadline-exceeded')
      assert.equal(item.reason.dispatchState, 'uncertain')
    }
  }
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('timed out waiting for adapter cleanup')
}

function fakeProof(
  method: EncryptedWalletBackupRequestProof['method'],
  url: string,
  payload: Uint8Array,
): EncryptedWalletBackupRequestProof {
  return Object.freeze({
    formatVersion: 1,
    realm: REALM,
    vaultId: VAULT_ID,
    requestAuthPublicKey: PUBLIC_KEY,
    enrollmentEpoch: 3,
    method,
    url,
    issuedAtUnixSeconds: 1,
    expiresAtUnixSeconds: 61,
    replayNonce: '16'.repeat(16),
    payloadLength: payload.byteLength,
    payloadDigest: bytesToHex(sha256(payload)),
    signature: '17'.repeat(64),
  })
}

function response(
  url: string,
  status: number,
  body: Uint8Array | ReadableStream<Uint8Array>,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers({
    'content-type': 'application/cbor',
    'cache-control': 'private, no-store',
    ...extra,
  })
  const stream =
    body instanceof Uint8Array
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body)
            controller.close()
          },
        })
      : body
  return {
    status,
    url,
    redirected: false,
    headers,
    body: stream,
  } as Response
}

function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url')
}

function framedDigest(aad: Uint8Array, body: Uint8Array): string {
  const length = Uint8Array.of(
    aad.byteLength >>> 24,
    aad.byteLength >>> 16,
    aad.byteLength >>> 8,
    aad.byteLength,
  )
  return bytesToHex(sha256.create().update(length).update(aad).update(body).digest())
}
