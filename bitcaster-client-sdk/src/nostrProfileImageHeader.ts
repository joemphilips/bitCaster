import {
  MAX_NOSTR_PROFILE_IMAGE_BYTES,
  NostrMediaUploadError,
  type NostrProfileImageType,
} from './nostrMediaUpload.ts'

const MAX_PIXELS = 16_000_000

/** Bound raster dimensions before a browser allocates the decoded pixel buffer. */
export function readNostrProfileImageHeader(
  bytes: Uint8Array,
  type: NostrProfileImageType,
): { width: number; height: number } {
  const invalid = (): never => {
    throw new NostrMediaUploadError('invalid-image')
  }
  if (bytes.length === 0 || bytes.length > MAX_NOSTR_PROFILE_IMAGE_BYTES) return invalid()
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const text = (offset: number, value: string) =>
    [...value].every((char, index) => bytes[offset + index] === char.charCodeAt(0))
  const result = (width: number, height: number) => {
    if (
      !Number.isSafeInteger(width) ||
      !Number.isSafeInteger(height) ||
      width < 1 ||
      height < 1 ||
      width * height > MAX_PIXELS
    )
      return invalid()
    return { width, height }
  }
  if (type === 'image/png') {
    if (
      bytes.length < 33 ||
      ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) ||
      view.getUint32(8) !== 13 ||
      !text(12, 'IHDR')
    )
      return invalid()
    return result(view.getUint32(16), view.getUint32(20))
  }
  if (type === 'image/jpeg') {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return invalid()
    let offset = 2
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) return invalid()
      while (bytes[offset] === 0xff) offset++
      const marker = bytes[offset++]
      if (marker === undefined || marker === 0xda || marker === 0xd9 || marker === 0x00)
        return invalid()
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
      if (offset + 2 > bytes.length) return invalid()
      const size = view.getUint16(offset)
      if (size < 2 || offset + size > bytes.length) return invalid()
      if (
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker,
        )
      ) {
        if (size < 8) return invalid()
        return result(view.getUint16(offset + 5), view.getUint16(offset + 3))
      }
      offset += size
    }
    return invalid()
  }
  if (
    type !== 'image/webp' ||
    bytes.length < 20 ||
    !text(0, 'RIFF') ||
    !text(8, 'WEBP') ||
    view.getUint32(4, true) + 8 !== bytes.length
  )
    return invalid()
  const little24 = (offset: number) =>
    bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const size = view.getUint32(offset + 4, true)
    const data = offset + 8
    if (size > bytes.length - data) return invalid()
    if (text(offset, 'VP8X')) {
      if (size !== 10) return invalid()
      return result(little24(data + 4) + 1, little24(data + 7) + 1)
    }
    if (text(offset, 'VP8L')) {
      if (size < 5 || bytes[data] !== 0x2f) return invalid()
      const packed = view.getUint32(data + 1, true)
      return result((packed & 0x3fff) + 1, ((packed >>> 14) & 0x3fff) + 1)
    }
    if (text(offset, 'VP8 ')) {
      if (
        size < 10 ||
        bytes[data + 3] !== 0x9d ||
        bytes[data + 4] !== 0x01 ||
        bytes[data + 5] !== 0x2a
      )
        return invalid()
      return result(
        view.getUint16(data + 6, true) & 0x3fff,
        view.getUint16(data + 8, true) & 0x3fff,
      )
    }
    offset = data + size + (size % 2)
  }
  return invalid()
}
