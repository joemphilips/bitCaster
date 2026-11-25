import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// This test needs the real WebSocket of the running Node.js release. Node.js 22
// dispatches an error event inside close() of a connecting socket. nostr-tools
// 2.25.2 to 2.26.1 call close() in their error handler, so one failed relay
// connection ended the process. A mocked socket does not show this.
test('a relay that cannot be reached or that closes does not end the process', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      fileURLToPath(new URL('./fixtures/relayFailureProcess.ts', import.meta.url)),
    ],
    { encoding: 'utf8', timeout: 60_000, env: { ...process.env, NODE_NO_WARNINGS: '1' } },
  )
  assert.equal(child.status, 0, `signal ${child.signal}\n${child.stdout}${child.stderr}`)
  assert.equal(child.stderr, '')
  const unacknowledged = 'Error: No relay acknowledged the oracle event. Retry the same operation.'
  const unconnected = 'Error: Nostr relay connection failed.'
  const expected: Record<string, string> = {}
  for (const name of ['refused', 'stalled', 'reset', 'notWebSocket']) {
    expected[`publication ${name}`] = unacknowledged
    expected[`session ${name}`] = unconnected
    expected[`indexer ${name}`] = 'null'
  }
  for (const name of ['closesInSession', 'dropsInSession']) {
    expected[`publication ${name}`] = unacknowledged
    expected[`session ${name}`] = 'relay closed'
    expected[`indexer ${name}`] = 'null'
  }
  expected.mixed = JSON.stringify({ accepted: 1, rejected: 6 })
  assert.deepEqual(JSON.parse(child.stdout), expected)
})
