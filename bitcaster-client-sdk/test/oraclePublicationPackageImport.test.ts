import assert from 'node:assert/strict'
import { test } from 'node:test'

test('built SDK exposes oracle publication and explanation through package and root exports', async () => {
  const publication = await import('@bitcaster-market/client-sdk/oraclePublication')
  const explanation = await import('@bitcaster-market/client-sdk/oracleResolutionExplanation')
  const sdk = await import('@bitcaster-market/client-sdk')
  assert.equal(typeof publication.publishOracleOutcome, 'function')
  assert.equal(typeof publication.retryOraclePublication, 'function')
  assert.equal(typeof publication.snapshotOraclePublicationRecord, 'function')
  assert.equal(explanation.ORACLE_EXPLANATION_UTF8_BYTES_MAX, 4_096)
  assert.equal(sdk.publishOracleOutcome, publication.publishOracleOutcome)
  assert.equal(sdk.verifyOracleResolutionExplanation, explanation.verifyOracleResolutionExplanation)
})
