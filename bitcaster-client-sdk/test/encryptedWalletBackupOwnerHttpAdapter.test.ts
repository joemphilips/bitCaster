import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import {
  decodeEncryptedWalletBackupOwnerRequestProof,
  verifyEncryptedWalletBackupOwnerRequest,
} from '../src/encryptedWalletBackupOwnerRequestProof.ts'
import { encodeEncryptedWalletBackupOwnerDiscoveryPage } from '../src/encryptedWalletBackupOwnerDiscovery.ts'
import { encryptedWalletBackupOwnerServerRoute } from '../src/encryptedWalletBackupOwnerDelegatedServerCodec.ts'
import { EncryptedWalletBackupOwnerHttpAdapter } from '../src/encryptedWalletBackupOwnerHttpAdapter.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'
import {
  decodeEncryptedWalletBackupOwnerAccountRequest,
  prepareEncryptedWalletBackupOwnerAccountOperation,
} from '../src/encryptedWalletBackupOwnerAccount.ts'
import { deriveEncryptedWalletBackupOwnerScope } from '../src/encryptedWalletBackupOwnerScope.ts'
import { encodeEncryptedWalletBackupOwnerAccountHttpResponse } from '../src/encryptedWalletBackupOwnerAccountHttp.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })

test('owner HTTP adapter binds bounded discovery to the exact issued request and route', async () => {
  const handle = await createEncryptedWalletBackupV2KeyHandle({
    seed: Uint8Array.from({ length: 64 }, (_, i) => i),
    realm: 'mainnet',
  })
  const owner = deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: 'test',
    ownerSubject: 'owner-a',
  })
  let observedUrl = ''
  const adapter = new EncryptedWalletBackupOwnerHttpAdapter({
    origin: 'https://backup.example',
    keyHandle: handle,
    nowUnixSeconds: () => 1_800_000_000,
    fetch: async (input, init) => {
      observedUrl = String(input)
      assert.equal(init.method, 'GET')
      assert.equal(init.redirect, 'error')
      assert.equal(init.credentials, 'omit')
      assert.match(String(new Headers(init.headers).get('authorization')), /^BackupV1 /u)
      const rawAuth = String(new Headers(init.headers).get('authorization')).slice(
        'BackupV1 '.length,
      )
      const proofBytes = Uint8Array.from(Buffer.from(rawAuth, 'base64url'))
      const proof = decodeEncryptedWalletBackupOwnerRequestProof(proofBytes)
      const route = encryptedWalletBackupOwnerServerRoute({
        operation: 'owner-discovery',
        realm: handle.realm,
        walletId: handle.walletId,
        requestedCursor: null,
      })
      const evidence = verifyEncryptedWalletBackupOwnerRequest({
        canonicalProof: proofBytes,
        route: route.context,
        expectedMethod: 'GET',
        expectedUrl: observedUrl,
        payload: new Uint8Array(),
        serverNowUnixSeconds: 1_800_000_000,
      })
      const body = encodeEncryptedWalletBackupOwnerDiscoveryPage({
        request: evidence,
        entries: [{ ...owner, enrollmentEpoch: 3 }],
        nextCursor: null,
        firstAccountOwnerScopeId: null,
      })
      const response = new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/cbor', 'cache-control': 'no-store' },
      })
      Object.defineProperty(response, 'url', { value: observedUrl })
      return response
    },
  })

  const page = await adapter.discover({
    requestedCursor: null,
    signal: new AbortController().signal,
  })
  assert.equal(
    observedUrl,
    'https://backup.example/v1/encrypted-wallet-backup/realms/mainnet/wallets/' +
      handle.walletId +
      '/owners',
  )
  assert.equal(page.entries.length, 1)
  assert.equal(page.entries[0]?.ownerScopeId, owner.ownerScopeId)
  assert.equal(page.entries[0]?.enrollmentEpoch, 3)
})

test('owner HTTP adapter refuses a non-HTTPS origin before dispatch', async () => {
  const handle = await createEncryptedWalletBackupV2KeyHandle({
    seed: Uint8Array.from({ length: 64 }, (_, i) => i),
    realm: 'mainnet',
  })
  assert.throws(
    () =>
      new EncryptedWalletBackupOwnerHttpAdapter({
        origin: 'http://backup.example',
        keyHandle: handle,
      }),
    /invalid-request/u,
  )
})

test('owner HTTP adapter sends a bounded account-authorized enrollment request', async () => {
  const handle = await createEncryptedWalletBackupV2KeyHandle({
    seed: Uint8Array.from({ length: 64 }, (_, i) => i),
    realm: 'mainnet',
  })
  const owner = deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: 'test',
    ownerSubject: 'owner-a',
  })
  const prepared = await prepareEncryptedWalletBackupOwnerAccountOperation({
    action: 'enroll',
    keyHandle: handle,
    url: `https://backup.example/v1/encrypted-wallet-backup/realms/mainnet/wallets:enroll`,
    operationId: '01'.repeat(16),
    expectedEnrollmentEpoch: 0,
    authorizationPort: {
      async authorizeBackupAccountOperation() {
        return { scheme: 'test', ownerSubject: 'owner-a', authorization: Uint8Array.of(1) }
      },
    },
    signal: new AbortController().signal,
    runtime: { getRandomValues: (bytes) => bytes.fill(0) },
  })
  const decoded = decodeEncryptedWalletBackupOwnerAccountRequest(prepared.canonicalRequest)
  const intent = decoded.accountRequest.intent
  let observedUrl = ''
  const adapter = new EncryptedWalletBackupOwnerHttpAdapter({
    origin: 'https://backup.example',
    keyHandle: handle,
    fetch: async (input, init) => {
      observedUrl = String(input)
      assert.equal(init.method, 'POST')
      assert.equal(init.redirect, 'error')
      assert.equal(init.credentials, 'omit')
      assert.equal(new Headers(init.headers).get('authorization'), null)
      assert.deepEqual(new Uint8Array(init.body as ArrayBuffer), prepared.canonicalRequest)
      const body = encodeEncryptedWalletBackupOwnerAccountHttpResponse({
        kind: 'account-result',
        action: 'enroll',
        ownerScopeId: owner.ownerScopeId,
        realm: 'mainnet',
        walletId: handle.walletId,
        operationId: intent.operationId,
        intentDigest: prepared.intentDigest,
        result: 'committed',
        enrollmentEpoch: 1,
        lifecycle: 'active',
      })
      const response = new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/cbor', 'cache-control': 'no-store' },
      })
      Object.defineProperty(response, 'url', { value: observedUrl })
      return response
    },
  })
  const result = await adapter.accountOperation({
    operation: prepared,
    signal: new AbortController().signal,
  })
  assert.equal(observedUrl, intent.url)
  assert.equal(result.kind, 'account-result')
  if (result.kind === 'account-result') {
    assert.equal(result.ownerScopeId, owner.ownerScopeId)
    assert.equal(result.enrollmentEpoch, 1)
  }
})

test('owner HTTP adapter aborts a late body read and releases its request slot', async () => {
  const handle = await createEncryptedWalletBackupV2KeyHandle({
    seed: Uint8Array.from({ length: 64 }, (_, i) => i),
    realm: 'mainnet',
  })
  let startRead!: () => void
  let releaseRead!: () => void
  const readStarted = new Promise<void>((resolve) => (startRead = resolve))
  const blockedRead = new Promise<void>((resolve) => (releaseRead = resolve))
  let calls = 0
  const adapter = new EncryptedWalletBackupOwnerHttpAdapter({
    origin: 'https://backup.example',
    keyHandle: handle,
    nowUnixSeconds: () => 1_800_000_000,
    fetch: async (input, init) => {
      calls += 1
      const url = String(input)
      if (calls === 1) {
        const response = new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              startRead()
              await blockedRead
              controller.enqueue(Uint8Array.of(1))
              controller.close()
            },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/cbor', 'cache-control': 'no-store' },
          },
        )
        Object.defineProperty(response, 'url', { value: url })
        return response
      }
      const rawAuth = String(new Headers(init.headers).get('authorization')).slice(
        'BackupV1 '.length,
      )
      const proofBytes = Uint8Array.from(Buffer.from(rawAuth, 'base64url'))
      const proof = decodeEncryptedWalletBackupOwnerRequestProof(proofBytes)
      const route = encryptedWalletBackupOwnerServerRoute({
        operation: 'owner-discovery',
        realm: handle.realm,
        walletId: handle.walletId,
        requestedCursor: null,
      })
      const verified = verifyEncryptedWalletBackupOwnerRequest({
        canonicalProof: proofBytes,
        route: route.context,
        expectedMethod: 'GET',
        expectedUrl: url,
        payload: new Uint8Array(),
        serverNowUnixSeconds: 1_800_000_000,
      })
      const body = encodeEncryptedWalletBackupOwnerDiscoveryPage({
        request: verified,
        entries: [],
        nextCursor: null,
        firstAccountOwnerScopeId: null,
      })
      const response = new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/cbor', 'cache-control': 'no-store' },
      })
      Object.defineProperty(response, 'url', { value: url })
      return response
    },
  })
  const controller = new AbortController()
  const late = adapter.discover({ requestedCursor: null, signal: controller.signal })
  await readStarted
  controller.abort()
  releaseRead()
  await assert.rejects(
    late,
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'EncryptedWalletBackupOwnerHttpTransportError' &&
      'code' in error &&
      error.code === 'deadline-exceeded',
  )
  const page = await adapter.discover({
    requestedCursor: null,
    signal: new AbortController().signal,
  })
  assert.equal(page.entries.length, 0)
  assert.equal(calls, 2)
})
