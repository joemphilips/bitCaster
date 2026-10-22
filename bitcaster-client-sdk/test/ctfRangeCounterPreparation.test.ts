import assert from 'node:assert/strict'
import test from 'node:test'
import * as protocol from '../src/ctfRangeOrderProtocol.ts'

test('counter preparation exposes its bounded codec and reconstruction entry points', () => {
  for (const name of [
    'createCtfRangePreparationIntent',
    'createCounterCtfRangePreparation',
    'decodeCounterCtfRangePreparation',
    'reconstructCtfRangePreparation',
  ]) {
    assert.equal(typeof (protocol as Record<string, unknown>)[name], 'function', name)
  }
})

test('counter-derived IDs match independent Python HMAC and UUIDv8 vectors', () => {
  assert.deepEqual(
    protocol.deriveCounterCtfRangeIdentity(new Uint8Array(64).fill(7), '01' + 'ab'.repeat(32), 5),
    {
      operationId: '2813a75a-df49-816f-b3dd-fb2b403777e6',
      authorizationId: '1cf0b415-837a-8620-b098-406caedeb8b8',
    },
  )
  for (const counter of [-1, 0.5, 2147483648, NaN])
    assert.throws(() =>
      protocol.deriveCounterCtfRangeIdentity(new Uint8Array(64), '01' + 'ab'.repeat(32), counter),
    )
  assert.throws(() =>
    protocol.deriveCounterCtfRangeIdentity(new Uint8Array(63), '01' + 'ab'.repeat(32), 0),
  )
})
