import assert from 'node:assert/strict'
import { test } from 'node:test'

test('public SDK modules are available from standard root and subpath package imports', async () => {
  const root = await import('@bitcaster-market/client-sdk')
  const tokenImportSubpath = await import('@bitcaster-market/client-sdk/tokenImportValidation')
  const assetIdentitySubpath =
    await import('@bitcaster-market/client-sdk/encryptedWalletBackupV2ProofSet')
  const paymentRequestSubpath = await import('@bitcaster-market/client-sdk/paymentRequest')

  assert.equal(typeof root.validateTokenImport, 'function')
  assert.equal(root.validateTokenImport, tokenImportSubpath.validateTokenImport)
  assert.equal(root.decodeTokenImportLocally, tokenImportSubpath.decodeTokenImportLocally)
  assert.equal(typeof root.createEncryptedWalletBackupV2AssetIdentity, 'function')
  assert.equal(
    root.createEncryptedWalletBackupV2AssetIdentity,
    assetIdentitySubpath.createEncryptedWalletBackupV2AssetIdentity,
  )
  assert.equal(
    root.createAmountlessCashuPaymentRequest,
    paymentRequestSubpath.createAmountlessCashuPaymentRequest,
  )
  assert.equal(
    root.derivePaymentRequestReceiveKeyPair,
    paymentRequestSubpath.derivePaymentRequestReceiveKeyPair,
  )
  assert.equal(
    root.readPendingCashuPaymentRequestMessage,
    paymentRequestSubpath.readPendingCashuPaymentRequestMessage,
  )
})

// The recovery index replaced the old encrypted backup. Browser custody rows
// still store its asset identity and terminal seal, so only these codecs stay.
test('the SDK root keeps only the stored asset identity and terminal seal codecs of the old backup', async () => {
  const root = await import('@bitcaster-market/client-sdk')

  assert.deepEqual(
    Object.keys(root)
      .filter((name) => /encryptedwalletbackup/i.test(name))
      .sort(),
    [
      'createEncryptedWalletBackupV2AssetIdentity',
      'decodeEncryptedWalletBackupV2AssetIdentity',
      'decodeEncryptedWalletBackupV2TerminalSeal',
      'encryptedWalletBackupV2LocalAssetKey',
    ],
  )
})
