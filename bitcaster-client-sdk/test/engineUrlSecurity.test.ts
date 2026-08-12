import assert from 'node:assert/strict'
import test from 'node:test'
import { isLoopbackHttpUrl, validateMarketCreateEngineUrl } from '../src/engineUrlSecurity.ts'

test('engine URL policy accepts HTTPS and explicit loopback HTTP forms', () => {
  assert.equal(validateMarketCreateEngineUrl('https://engine.example', false).ok, true)
  for (const url of ['http://localhost:5000', 'http://127.0.0.1:5000', 'http://[::1]:5000']) {
    assert.equal(isLoopbackHttpUrl(url), true)
    assert.equal(validateMarketCreateEngineUrl(url, true).ok, true)
    assert.equal(validateMarketCreateEngineUrl(url, false).ok, false)
  }
  assert.equal(isLoopbackHttpUrl('http://engine.example'), false)
  assert.equal(validateMarketCreateEngineUrl('http://engine.example', true).ok, false)
})
