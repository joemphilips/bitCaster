import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readNostrProfileImageHeader } from '../src/nostrProfileImageHeader.ts'

function png(width = 1024, height = 512) {
  const bytes = new Uint8Array(33)
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}
function webp(chunk: string, payload: number[]) {
  const bytes = new Uint8Array(20 + payload.length + (payload.length % 2))
  bytes.set(Buffer.from('RIFF'))
  bytes.set(Buffer.from('WEBP'), 8)
  bytes.set(Buffer.from(chunk), 12)
  bytes.set(payload, 20)
  const view = new DataView(bytes.buffer)
  view.setUint32(4, bytes.length - 8, true)
  view.setUint32(16, payload.length, true)
  return bytes
}
test('reads PNG and baseline/progressive JPEG dimensions', () => {
  assert.deepEqual(readNostrProfileImageHeader(png(), 'image/png'), { width: 1024, height: 512 })
  for (const marker of [0xc0, 0xc2]) {
    const jpeg = Uint8Array.from([
      0xff,
      0xd8,
      0xff,
      0xe1,
      0,
      4,
      1,
      2,
      0xff,
      marker,
      0,
      11,
      8,
      1,
      0,
      2,
      0,
      1,
      1,
      0x11,
      0,
    ])
    assert.deepEqual(readNostrProfileImageHeader(jpeg, 'image/jpeg'), { width: 512, height: 256 })
  }
})
test('reads extended, lossless and lossy WebP dimensions', () => {
  assert.deepEqual(
    readNostrProfileImageHeader(webp('VP8X', [0, 0, 0, 0, 255, 1, 0, 255, 0, 0]), 'image/webp'),
    { width: 512, height: 256 },
  )
  const packed = ((255 << 14) | 511) >>> 0
  assert.deepEqual(
    readNostrProfileImageHeader(
      webp('VP8L', [
        0x2f,
        packed & 255,
        (packed >>> 8) & 255,
        (packed >>> 16) & 255,
        packed >>> 24,
      ]),
      'image/webp',
    ),
    { width: 512, height: 256 },
  )
  assert.deepEqual(
    readNostrProfileImageHeader(webp('VP8 ', [0, 0, 0, 0x9d, 1, 0x2a, 0, 2, 0, 1]), 'image/webp'),
    { width: 512, height: 256 },
  )
})
test('rejects MIME spoofing, missing dimensions, truncated segments and oversized dimensions', () => {
  const cases = [
    () => readNostrProfileImageHeader(png(), 'image/jpeg'),
    () => readNostrProfileImageHeader(Buffer.from('GIF89a'), 'image/png'),
    () => readNostrProfileImageHeader(png().slice(0, 20), 'image/png'),
    () => readNostrProfileImageHeader(png(4001, 4000), 'image/png'),
    () => readNostrProfileImageHeader(png(0, 20), 'image/png'),
    () =>
      readNostrProfileImageHeader(
        Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]),
        'image/jpeg',
      ),
    () => readNostrProfileImageHeader(webp('VP8X', [0]), 'image/webp'),
    () => readNostrProfileImageHeader(new Uint8Array(5 * 1024 * 1024 + 1), 'image/png'),
  ]
  for (const read of cases) assert.throws(read, { code: 'invalid-image' })
})
test('handles typed-array byte offsets without reading adjacent data', () => {
  const padded = new Uint8Array(100)
  padded.set(png(10, 20), 20)
  assert.deepEqual(readNostrProfileImageHeader(padded.subarray(20, 53), 'image/png'), {
    width: 10,
    height: 20,
  })
})
