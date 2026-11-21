import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HttpResponseError, MintOperationError, NetworkError } from '@cashu/cashu-ts'
import { boundedErrorText } from '../src/mintErrorText.ts'

const RAW_MINT_TEXT = `Token already spent: ${'02ab'.repeat(40)}`

test('a mint answer in an error or its cause gets fixed text', () => {
  assert.equal(
    boundedErrorText(
      new Error('sweep failed', { cause: new MintOperationError(11001, RAW_MINT_TEXT) }),
    ),
    'mint request was refused (mint code 11001)',
  )
  assert.equal(
    boundedErrorText(
      new Error('sweep failed', { cause: new HttpResponseError(RAW_MINT_TEXT, 500) }),
    ),
    'mint request failed (HTTP 500)',
  )
})

test('an error without a mint answer keeps its own text', () => {
  assert.equal(
    boundedErrorText(new NetworkError('Network request failed')),
    'Network request failed',
  )
  assert.equal(boundedErrorText('plain failure'), 'plain failure')
})
