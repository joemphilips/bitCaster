import assert from 'node:assert/strict'
import { test } from 'node:test'
import { redactSwapFailureForTelemetry } from '../src/swapFailure.ts'

test('Block2_SwapFailureTelemetryRedaction emits only kind and refund locktime', () => {
  assert.deepEqual(
    redactSwapFailureForTelemetry({
      kind: 'PartialLockHeld',
      refundLocktime: 1_779_393_600,
      affectedKeysets: ['A', 'B'],
      detail: 'leg 1 locked; leg 2 failed',
    }),
    {
      kind: 'PartialLockHeld',
      refundLocktime: 1_779_393_600,
    },
  )
})
