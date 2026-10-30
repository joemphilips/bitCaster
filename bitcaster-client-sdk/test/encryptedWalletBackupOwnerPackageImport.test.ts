import assert from 'node:assert/strict'
import test from 'node:test'

test('only reviewed owner evidence validators are available through the public SDK subpath', async () => {
  const authority =
    await import('@bitcaster-market/client-sdk/encryptedWalletBackupOwnerDeletionAuthority')
  assert.equal(typeof authority.requireEncryptedWalletBackupOwnerCollectedHeadEvidence, 'function')
  assert.equal(typeof authority.requireEncryptedWalletBackupOwnerContext, 'function')
  assert.equal(
    typeof authority.requireEncryptedWalletBackupOwnerBackupReachabilityEvidence,
    'function',
  )
  assert.equal('verifyEncryptedWalletBackupOwnerBundleSupersessionMutation' in authority, false)
  assert.equal('issueEncryptedWalletBackupOwnerBundleSupersessionReceipt' in authority, false)
})
