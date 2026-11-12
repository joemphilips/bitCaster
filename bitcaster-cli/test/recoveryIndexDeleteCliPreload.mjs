import { appendFileSync } from 'node:fs'
import { RecoveryIndexFakeEngine } from '../../bitcaster-client-sdk/test/support/recoveryIndexFakeEngine.ts'

// The engine recovery index routes, in memory. No socket opens.
const engine = new RecoveryIndexFakeEngine(
  process.env.BITCASTER_TEST_RECOVERY_INDEX_REALM,
  'https://engine.example',
)
engine.nowSeconds = Math.floor(Date.now() / 1000)
// A stored document of a permitted size. The delete does not decode it.
engine.rows.set(process.env.BITCASTER_TEST_RECOVERY_INDEX_KEY, {
  version: 3,
  document: new Uint8Array(4_096 + 37),
})
engine.onRequest = (request) =>
  appendFileSync(
    process.env.BITCASTER_TEST_RECOVERY_INDEX_LOG,
    `${JSON.stringify({ method: request.method, key: request.headers['x-recovery-index-key'] })}\n`,
  )
const original = engine.fetch
globalThis.fetch = async (input, init) => {
  const response = await original(input, init)
  if (init?.method === 'DELETE') {
    const row = engine.rows.get(process.env.BITCASTER_TEST_RECOVERY_INDEX_KEY)
    appendFileSync(
      process.env.BITCASTER_TEST_RECOVERY_INDEX_LOG,
      `${JSON.stringify({ tombstone: { version: row.version, hasDocument: row.document !== null } })}\n`,
    )
  }
  return response
}
