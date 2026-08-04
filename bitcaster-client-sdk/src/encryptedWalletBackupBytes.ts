/** Returns an ArrayBuffer that contains only the visible byte range. */
export function exactEncryptedWalletBackupArrayBuffer(value: Uint8Array): ArrayBuffer {
  if (!(value instanceof Uint8Array)) throw new Error('encrypted backup bytes are invalid')
  if (
    value.buffer instanceof ArrayBuffer &&
    value.byteOffset === 0 &&
    value.byteLength === value.buffer.byteLength
  ) {
    return value.buffer
  }
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return copy.buffer
}
