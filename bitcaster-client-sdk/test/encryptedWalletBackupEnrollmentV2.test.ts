import assert from 'node:assert/strict'
import test from 'node:test'
import { createEncryptedWalletBackupKeyHandle } from '../src/encryptedWalletBackup.ts'
import { prepareEncryptedWalletBackupAccountOperation } from '../src/encryptedWalletBackupEnrollment.ts'
import { decodeEncryptedWalletBackupAccountRequest } from '../src/encryptedWalletBackupServerCodec.ts'
import { createEncryptedWalletBackupV2KeyHandle } from '../src/encryptedWalletBackupV2Keys.ts'

const REALM = 'backup.production'
const ORIGIN = 'https://backup.example'
const V2_SEED = Uint8Array.from({ length: 64 }, (_value, index) => index)

test('v2 key handles prepare exact account lifecycle requests', async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: V2_SEED,
    realm: REALM,
  })

  for (const [action, expectedEnrollmentEpoch] of [
    ['enroll', 0],
    ['revoke', 1],
    ['delete', 1],
  ] as const) {
    const url = accountUrl(action, keyHandle.vaultId)
    const operation = await prepareEncryptedWalletBackupAccountOperation({
      keyHandle,
      action,
      url,
      operationId: operationId(action),
      expectedEnrollmentEpoch,
      authorizationPort: authorizationPort(),
      signal: AbortSignal.timeout(60_000),
    })
    const request = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)

    assert.equal(operation.formatVersion, 1)
    assert.equal(operation.realm, REALM)
    assert.equal(operation.vaultId, keyHandle.vaultId)
    assert.equal(operation.requestAuthPublicKey, keyHandle.requestAuthPublicKey)
    assert.equal(request.intent.action, action)
    assert.equal(request.intent.url, url)
    assert.equal(request.intent.realm, REALM)
    assert.equal(request.intent.vaultId, keyHandle.vaultId)
    assert.equal(request.intent.requestAuthPublicKey, keyHandle.requestAuthPublicKey)
    assert.equal(request.intent.expectedEnrollmentEpoch, expectedEnrollmentEpoch)
  }
})

test('account lifecycle rejects forged v2 key handles', async () => {
  const issued = await createEncryptedWalletBackupV2KeyHandle({
    seed: V2_SEED,
    realm: REALM,
  })
  const forged = {
    formatVersion: 2 as const,
    realm: issued.realm,
    vaultId: issued.vaultId,
    requestAuthPublicKey: issued.requestAuthPublicKey,
  }

  await assert.rejects(
    () =>
      prepareEncryptedWalletBackupAccountOperation({
        keyHandle: forged,
        action: 'enroll',
        url: accountUrl('enroll', issued.vaultId),
        operationId: operationId('enroll'),
        expectedEnrollmentEpoch: 0,
        authorizationPort: authorizationPort(),
        signal: AbortSignal.timeout(60_000),
      }),
    /v2 key handle is invalid/,
  )
})

test('v1 key handles still prepare account lifecycle requests', async () => {
  const keyHandle = await createEncryptedWalletBackupKeyHandle({
    seed: new Uint8Array(64).fill(9),
    realm: REALM,
  })
  const operation = await prepareEncryptedWalletBackupAccountOperation({
    keyHandle,
    action: 'enroll',
    url: accountUrl('enroll', keyHandle.vaultId),
    operationId: operationId('enroll'),
    expectedEnrollmentEpoch: 0,
    authorizationPort: authorizationPort(),
    signal: AbortSignal.timeout(60_000),
  })
  const request = decodeEncryptedWalletBackupAccountRequest(operation.canonicalRequest)

  assert.equal(operation.vaultId, keyHandle.vaultId)
  assert.equal(request.intent.requestAuthPublicKey, keyHandle.requestAuthPublicKey)
})

function accountUrl(action: 'enroll' | 'revoke' | 'delete', vaultId: string): string {
  return action === 'enroll'
    ? `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults:enroll`
    : `${ORIGIN}/v1/encrypted-wallet-backup/realms/${REALM}/vaults/${vaultId}:${action}`
}

function operationId(action: 'enroll' | 'revoke' | 'delete'): string {
  return ({ enroll: '01', revoke: '02', delete: '03' } as const)[action].repeat(16)
}

function authorizationPort() {
  return {
    async authorizeBackupAccountOperation() {
      return { scheme: 'test', authorization: Uint8Array.of(1) }
    },
  }
}
