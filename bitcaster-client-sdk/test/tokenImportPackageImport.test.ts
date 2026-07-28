import assert from 'node:assert/strict'
import { test } from 'node:test'

test('token-import validator is available from standard root and subpath package imports', async () => {
  const root = await import('@bitcaster-market/client-sdk')
  const subpath = await import('@bitcaster-market/client-sdk/tokenImportValidation')

  assert.equal(typeof root.validateTokenImport, 'function')
  assert.equal(root.validateTokenImport, subpath.validateTokenImport)
  assert.equal(root.decodeTokenImportLocally, subpath.decodeTokenImportLocally)
})
