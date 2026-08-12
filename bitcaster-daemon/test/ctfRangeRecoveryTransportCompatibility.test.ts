import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CTF_RANGE_MINT_RESTORE_RESPONSE_BYTES_MAX,
  CtfRangeMintRecoveryAdapter,
  checkCtfRangeInputProofStates,
  decodeCtfRangeEngineResult,
  fetchCtfRangeEngineResultByOperation,
} from '@bitcaster-market/client-sdk/ctfRangeRecoveryTransport'
import {
  DAEMON_CTF_RANGE_MINT_RESTORE_RESPONSE_BYTES_MAX,
  DaemonCtfRangeMintRecoveryAdapter,
  checkDaemonCtfRangeInputProofStates,
  decodeDaemonCtfRangeEngineResult,
  fetchDaemonCtfRangeEngineResultByOperation,
} from '../src/ctfRangeRecoveryTransport.ts'

test('daemon recovery compatibility surface delegates to the shared SDK implementation', () => {
  assert.equal(
    DAEMON_CTF_RANGE_MINT_RESTORE_RESPONSE_BYTES_MAX,
    CTF_RANGE_MINT_RESTORE_RESPONSE_BYTES_MAX,
  )
  assert.equal(DaemonCtfRangeMintRecoveryAdapter, CtfRangeMintRecoveryAdapter)
  assert.equal(checkDaemonCtfRangeInputProofStates, checkCtfRangeInputProofStates)
  assert.equal(decodeDaemonCtfRangeEngineResult, decodeCtfRangeEngineResult)
  assert.equal(fetchDaemonCtfRangeEngineResultByOperation, fetchCtfRangeEngineResultByOperation)
})
