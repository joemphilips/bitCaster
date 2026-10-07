const ANNOUNCEMENT_HEX_TEXT_BYTES_MAX = 48 * 1024
const DLC_ORACLE_ANNOUNCEMENT_TYPE_ID = 55_332

/** Return the kind-88 base64 body from the canonical public DLC announcement TLV. */
export function announcementContentFromTlv(announcementTlvHex: string): string | undefined {
  // Bound and validate the text before allocating the decoded byte array.
  if (
    typeof announcementTlvHex !== 'string' ||
    announcementTlvHex.length === 0 ||
    announcementTlvHex.length > ANNOUNCEMENT_HEX_TEXT_BYTES_MAX ||
    announcementTlvHex.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(announcementTlvHex)
  )
    return undefined

  const bytes = new Uint8Array(announcementTlvHex.length / 2)
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(announcementTlvHex.slice(index * 2, index * 2 + 2), 16)

  const type = readDlcBigSize(bytes, 0)
  if (type === undefined || type.value !== DLC_ORACLE_ANNOUNCEMENT_TYPE_ID) return undefined
  const length = readDlcBigSize(bytes, type.nextOffset)
  if (length === undefined || length.value !== bytes.length - length.nextOffset) return undefined

  // Nostr signs the body. The public DLC artifact adds this outer TLV header.
  let body = ''
  for (const byte of bytes.subarray(length.nextOffset)) body += String.fromCharCode(byte)
  return btoa(body)
}

function readDlcBigSize(
  bytes: Uint8Array,
  offset: number,
): { readonly value: number; readonly nextOffset: number } | undefined {
  if (offset >= bytes.length) return undefined
  const marker = bytes[offset]
  if (marker === undefined) return undefined
  if (marker <= 0xfc) return { value: marker, nextOffset: offset + 1 }

  const width = marker === 0xfd ? 2 : marker === 0xfe ? 4 : 8
  const nextOffset = offset + 1 + width
  if (nextOffset > bytes.length) return undefined

  let value = 0n
  for (let index = offset + 1; index < nextOffset; index += 1) {
    const byte = bytes[index]
    if (byte === undefined) return undefined
    value = (value << 8n) | BigInt(byte)
  }

  const minimum = marker === 0xfd ? 0xfdn : marker === 0xfe ? 0x1_0000n : 0x1_0000_0000n
  if (value < minimum || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return { value: Number(value), nextOffset }
}
