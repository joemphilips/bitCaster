import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nprofileEncode, decode } from 'nostr-tools/nip19'
import {
  decryptNip17PaymentRequestMessage,
  encodeNip17PaymentRequestNprofile,
  NIP44_V2_PAYLOAD_CHARS_MAX,
} from '../src/nip17PaymentRequest.ts'
import {
  createPaymentRequestGiftwrap,
  paymentRequestFixtureRecipient,
  paymentRequestFixtureRecipientPubkey,
} from './fixtures/nip17PaymentRequest.ts'

test('real NIP-17 wrap, seal and unsigned rumor authenticate content without proof credit', () => {
  const fixture = createPaymentRequestGiftwrap()
  const result = decryptNip17PaymentRequestMessage({
    wrap: fixture.wrap,
    privateKey: paymentRequestFixtureRecipient,
  })
  assert.ok(result)
  assert.equal(result.wrapId, fixture.wrap.id)
  assert.equal(result.rumorId, fixture.rumorId)
  assert.equal(result.senderPubkey, fixture.senderPubkey)
  assert.equal(result.content === fixture.content, true, 'authenticated content must remain exact')
})

test('both encrypted parser layers refuse malformed plaintext without throwing or logging it', (t) => {
  const warning = t.mock.method(console, 'warn', () => {})
  for (const patch of [
    { sealPlaintext: '{"fixture":invalid_plaintext}' },
    { rumorPlaintext: '{"fixture":invalid_plaintext}' },
  ]) {
    const { wrap } = createPaymentRequestGiftwrap(patch)
    assert.equal(
      decryptNip17PaymentRequestMessage({ wrap, privateKey: paymentRequestFixtureRecipient }),
      null,
    )
  }
  assert.equal(warning.mock.calls.length, 0)
})

test('protocol guards reject foreign recipient, kind, seal tags, signature and rumor identity', () => {
  const invalid = [
    createPaymentRequestGiftwrap({ recipientKey: new Uint8Array(32).fill(4) }),
    createPaymentRequestGiftwrap({ wrapPatch: { kind: 1 } }),
    createPaymentRequestGiftwrap({ wrapPatch: { tags: [['p', '11'.repeat(32)]] } }),
    createPaymentRequestGiftwrap({ sealPatch: { kind: 14 } }),
    createPaymentRequestGiftwrap({
      sealPatch: { tags: [['p', paymentRequestFixtureRecipientPubkey]] },
    }),
    createPaymentRequestGiftwrap({ badSealSignature: true }),
    createPaymentRequestGiftwrap({ rumorPatch: { sig: '' } }),
    createPaymentRequestGiftwrap({ rumorPatch: { kind: 1 } }),
    createPaymentRequestGiftwrap({ rumorPatch: { id: '11'.repeat(32) } }),
    createPaymentRequestGiftwrap({ rumorPatch: { pubkey: '11'.repeat(32) } }),
    createPaymentRequestGiftwrap({ rumorPatch: { created_at: undefined } }),
    createPaymentRequestGiftwrap({ rumorPatch: { tags: [] } }),
  ]
  for (const { wrap } of invalid)
    assert.equal(
      decryptNip17PaymentRequestMessage({ wrap, privateKey: paymentRequestFixtureRecipient }),
      null,
    )
})

test('signature-cache mutation and oversized ciphertext never bypass ingress validation', () => {
  const { wrap } = createPaymentRequestGiftwrap()
  wrap.sig = '00'.repeat(64)
  assert.equal(
    decryptNip17PaymentRequestMessage({ wrap, privateKey: paymentRequestFixtureRecipient }),
    null,
  )
  wrap.content = 'A'.repeat(NIP44_V2_PAYLOAD_CHARS_MAX + 1)
  assert.equal(
    decryptNip17PaymentRequestMessage({ wrap, privateKey: paymentRequestFixtureRecipient }),
    null,
  )
  assert.equal(
    decryptNip17PaymentRequestMessage({ wrap: null, privateKey: paymentRequestFixtureRecipient }),
    null,
  )
})

test('seed presentation keeps exact relay replacement and explicit empty hints', () => {
  const urls = ['wss://CUSTOM.example/Path?B=2&A=Case', 'wss://custom.example/Path/']
  const encoded = encodeNip17PaymentRequestNprofile(paymentRequestFixtureRecipientPubkey, urls)
  assert.equal(
    encoded,
    nprofileEncode({
      pubkey: paymentRequestFixtureRecipientPubkey,
      relays: ['wss://custom.example/Path?B=2&A=Case', urls[1]!],
    }),
  )
  const empty = decode(encodeNip17PaymentRequestNprofile(paymentRequestFixtureRecipientPubkey, []))
  assert.equal(empty.type, 'nprofile')
  if (empty.type !== 'nprofile') assert.fail('expected nprofile')
  assert.equal(empty.data.pubkey, paymentRequestFixtureRecipientPubkey)
  assert.deepEqual(empty.data.relays, [])
})

test('invalid hints and NIP-19 one-byte TLV overflow refuse without corrupting presentation', () => {
  for (const urls of [['https://custom.example'], [`wss://custom.example/${'x'.repeat(256)}`]])
    assert.throws(
      () => encodeNip17PaymentRequestNprofile(paymentRequestFixtureRecipientPubkey, urls),
      /^Error: payment receive nprofile is invalid$/,
    )
})
test('shared NIP-17 validation is available through built root and subpath exports', async () => {
  const root = await import('@bitcaster-market/client-sdk')
  const subpath = await import('@bitcaster-market/client-sdk/nip17PaymentRequest')
  assert.equal(root.decryptNip17PaymentRequestMessage, subpath.decryptNip17PaymentRequestMessage)
  assert.equal(root.encodeNip17PaymentRequestNprofile, subpath.encodeNip17PaymentRequestNprofile)
  assert.equal(subpath.NIP17_PAYMENT_REQUEST_FRAME_BYTES_MAX, 4 * 1024 * 1024)
})
