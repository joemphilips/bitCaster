export function requireLowerHex(value: unknown, byteLength: number, name: string): string {
  if (typeof value !== 'string' || value.length !== byteLength * 2 || !/^[0-9a-f]+$/u.test(value)) {
    throw new Error(`${name} is invalid`)
  }
  return value
}

export function requireRealm(value: unknown): string {
  const realm = requireUtf8Text(value, 64, 'encrypted backup realm')
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u.test(realm)) {
    throw new Error('encrypted backup realm is invalid')
  }
  return realm
}

export function requireUtf8Text(value: unknown, maximumBytes: number, name: string): string {
  if (typeof value !== 'string' || value.length === 0 || hasInvalidText(value))
    throw new Error(`${name} is invalid`)
  if (new TextEncoder().encode(value).byteLength > maximumBytes)
    throw new Error(`${name} is invalid`)
  return value
}

function hasInvalidText(value: string): boolean {
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return true
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}
