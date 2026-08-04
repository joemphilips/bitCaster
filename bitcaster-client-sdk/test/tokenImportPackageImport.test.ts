import assert from 'node:assert/strict'
import { test } from 'node:test'

test('public SDK modules are available from standard root and subpath package imports', async () => {
  const root = await import('@bitcaster-market/client-sdk')
  const tokenImportSubpath = await import('@bitcaster-market/client-sdk/tokenImportValidation')
  const manifestPageSubpath =
    await import('@bitcaster-market/client-sdk/encryptedWalletBackupManifestPagePersistence')
  const uploadPlanningSubpath =
    await import('@bitcaster-market/client-sdk/encryptedWalletBackupUploadPlanningPersistence')

  assert.equal(typeof root.validateTokenImport, 'function')
  assert.equal(root.validateTokenImport, tokenImportSubpath.validateTokenImport)
  assert.equal(root.decodeTokenImportLocally, tokenImportSubpath.decodeTokenImportLocally)
  assert.equal(typeof root.persistNextEncryptedWalletBackupManifestPage, 'function')
  assert.equal(
    root.persistNextEncryptedWalletBackupManifestPage,
    manifestPageSubpath.persistNextEncryptedWalletBackupManifestPage,
  )
  assert.equal(typeof root.decodeEncryptedWalletBackupUploadCursor, 'function')
  assert.equal(
    root.decodeEncryptedWalletBackupUploadCursor,
    uploadPlanningSubpath.decodeEncryptedWalletBackupUploadCursor,
  )
})
