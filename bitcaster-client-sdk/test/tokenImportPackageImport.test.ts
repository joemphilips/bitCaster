import assert from 'node:assert/strict'
import { test } from 'node:test'

test('public SDK modules are available from standard root and subpath package imports', async () => {
  const root = await import('@bitcaster-market/client-sdk')
  const tokenImportSubpath = await import('@bitcaster-market/client-sdk/tokenImportValidation')
  const v2KeysSubpath = await import('@bitcaster-market/client-sdk/encryptedWalletBackupV2Keys')

  assert.equal(typeof root.validateTokenImport, 'function')
  assert.equal(root.validateTokenImport, tokenImportSubpath.validateTokenImport)
  assert.equal(root.decodeTokenImportLocally, tokenImportSubpath.decodeTokenImportLocally)
  assert.equal(typeof root.createEncryptedWalletBackupV2KeyHandle, 'function')
  assert.equal(
    root.createEncryptedWalletBackupV2KeyHandle,
    v2KeysSubpath.createEncryptedWalletBackupV2KeyHandle,
  )
})
