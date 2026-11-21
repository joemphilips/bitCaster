import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isLoopbackHttpUrl,
  normalizeEndpointUrl,
  validateMarketCreateEngineUrl,
} from '../src/engineUrlSecurity.ts'

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

test('endpoint URL normalization trims trailing slashes and preserves base paths', () => {
  assert.equal(
    normalizeEndpointUrl('https://engine.example///', 'engine URL'),
    'https://engine.example',
  )
  assert.equal(
    normalizeEndpointUrl('https://engine.example/api///', 'trusted engine URL'),
    'https://engine.example/api',
  )
  assert.equal(
    normalizeEndpointUrl('http://localhost:5000///', 'engine URL'),
    'http://localhost:5000',
  )
  assert.throws(
    () => normalizeEndpointUrl('http://engine.example', 'engine URL'),
    /expected https or loopback http URL/,
  )
  assert.throws(
    () => normalizeEndpointUrl('ftp://engine.example', 'engine URL'),
    /expected http or https URL/,
  )
})

test('endpoint URL normalization refuses a URL whose text can show another host', () => {
  // The terminal shows the text, not the parsed host. Each URL parses, so the
  // check must read the text itself.
  const spoofed = [
    'https://evil.example/\x1b[1A\x1b[2Khttps://good.example',
    ...Array.from(
      { length: 0x21 },
      (_, code) => `https://engine.example/a${String.fromCharCode(code)}b`,
    ),
    'https://engine.example/a\x7fb',
    '\x00https://engine.example',
    'https://engine.example/ ',
    'https://engine.example/a\u009bb',
    'https://engine.example/‮good',
    'https://bücher.example',
  ]
  for (const value of spoofed) {
    assert.throws(
      () => normalizeEndpointUrl(value, 'engine URL'),
      (error: Error) =>
        error.message ===
        'Invalid engine URL: the URL must contain only printable ASCII characters, with no space or control character',
      JSON.stringify(value),
    )
  }
  for (const value of [
    'https://good.example@evil.example',
    'https://good.example:@evil.example',
    'https://user:secret@engine.example',
    'https://:secret@engine.example',
    'https://@engine.example',
    'http://good.example@localhost:5000',
  ]) {
    assert.throws(
      () => normalizeEndpointUrl(value, 'mint URL'),
      (error: Error) =>
        error.message === 'Invalid mint URL: the URL must not contain a user name or password',
      value,
    )
  }
  // A path may still hold an at sign, and a punycode host is printable ASCII.
  assert.equal(
    normalizeEndpointUrl('https://engine.example/@team/', 'engine URL'),
    'https://engine.example/@team',
  )
  assert.equal(
    normalizeEndpointUrl('https://xn--bcher-kva.example', 'engine URL'),
    'https://xn--bcher-kva.example',
  )
})
