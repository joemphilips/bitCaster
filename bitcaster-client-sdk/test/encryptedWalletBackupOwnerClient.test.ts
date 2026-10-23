import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import test from 'node:test'
import { encodeEncryptedWalletBackupOwnerDiscoveryPage } from '../src/encryptedWalletBackupOwnerDiscovery.ts'
import { deriveEncryptedWalletBackupOwnerScope } from '../src/encryptedWalletBackupOwnerScope.ts'
import {
  decodeEncryptedWalletBackupOwnerRequestProof,
  encryptedWalletBackupOwnerRequestDigest,
  verifyEncryptedWalletBackupOwnerRequest,
} from '../src/encryptedWalletBackupOwnerRequestProof.ts'
import { encryptedWalletBackupOwnerServerRoute } from '../src/encryptedWalletBackupOwnerDelegatedServerCodec.ts'
import {
  encodeEncryptedWalletBackupOwnerEnrollmentEpochResult,
  encodeEncryptedWalletBackupOwnerHttpResponse,
} from '../src/encryptedWalletBackupOwnerHttpCodec.ts'
import { EncryptedWalletBackupOwnerClient } from '../src/encryptedWalletBackupOwnerClient.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'

Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })

const now = 1_800_000_000

test('owner client requires explicit multi-owner selection and binds epoch to selected candidate', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: Uint8Array.from({ length: 64 }, (_, index) => index),
    realm: 'mainnet',
  })
  const candidates = ['alice', 'bob']
    .map((ownerSubject) =>
      deriveEncryptedWalletBackupOwnerScope({
        authorizationScheme: 'test',
        ownerSubject,
      }),
    )
    .sort((left, right) => left.ownerScopeId.localeCompare(right.ownerScopeId))
  const fetch = async (resource: string, init: RequestInit): Promise<Response> => {
    const url = String(resource)
    const route = url.endsWith('/owners')
      ? encryptedWalletBackupOwnerServerRoute({
          operation: 'owner-discovery',
          realm: keyHandle.realm,
          walletId: keyHandle.walletId,
          requestedCursor: null,
        })
      : encryptedWalletBackupOwnerServerRoute({
          operation: 'enrollment-epoch',
          realm: keyHandle.realm,
          walletId: keyHandle.walletId,
          ownerScopeId: candidates[1]!.ownerScopeId,
        })
    const proofBytes = Uint8Array.from(
      Buffer.from(
        String(new Headers(init.headers).get('authorization')).slice('BackupV1 '.length),
        'base64url',
      ),
    )
    const proof = decodeEncryptedWalletBackupOwnerRequestProof(proofBytes)
    const verified = verifyEncryptedWalletBackupOwnerRequest({
      canonicalProof: proofBytes,
      route: route.context,
      expectedMethod: route.method,
      expectedUrl: url,
      payload: new Uint8Array(),
      serverNowUnixSeconds: now,
    })
    const responseBytes =
      route.context.operation === 'owner-discovery'
        ? encodeEncryptedWalletBackupOwnerDiscoveryPage({
            request: verified,
            entries: candidates.map((candidate, index) => ({
              ...candidate,
              enrollmentEpoch: index === 1 ? 3 : 1,
            })),
            nextCursor: null,
          })
        : encodeEncryptedWalletBackupOwnerHttpResponse({
            kind: 'enrollment-epoch',
            requestDigest: encryptedWalletBackupOwnerRequestDigest(proof),
            ownerScopeId: candidates[1]!.ownerScopeId,
            realm: keyHandle.realm,
            walletId: keyHandle.walletId,
            enrollmentEpoch: 0,
            body: encodeEncryptedWalletBackupOwnerEnrollmentEpochResult({
              result: 'active',
              enrollmentEpoch: 3,
            }),
          })
    const response = new Response(responseBytes, {
      status: 200,
      headers: { 'content-type': 'application/cbor', 'cache-control': 'no-store' },
    })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }
  const client = new EncryptedWalletBackupOwnerClient({
    origin: 'https://backup.example',
    keyHandle,
    pinnedReceiptKeys: [{ keyId: '01'.repeat(16), publicKey: '02'.repeat(32) }],
    fetch,
    nowUnixSeconds: () => now,
  })
  const signal = new AbortController().signal
  await assert.rejects(
    () => client.selectOwner({ signal }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'selection-required')
      return true
    },
  )
  const selected = await client.selectOwner({
    signal,
    ownerScopeId: candidates[1]!.ownerScopeId,
  })
  assert.equal(selected.ownerSubject, candidates[1]!.ownerSubject)
  assert.deepEqual(await client.readEnrollmentEpoch({ owner: selected, signal }), {
    status: 'active',
    enrollmentEpoch: 3,
  })
  await assert.rejects(() => client.selectOwner({ signal, ownerScopeId: 'ff'.repeat(32) }))
})
