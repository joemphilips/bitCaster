/**
 * JSON.parse discards duplicate object keys. New compact wire records reject them
 * before any normalization, matching serde's strict DTO decoder. Existing v1 JSON
 * keeps its historical read behavior. Signed-event JSON strings remain opaque.
 */
export function parseOracleBackupWireJson(json: string): unknown {
  const parsed: unknown = JSON.parse(json)
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    !('schemaVersion' in parsed) ||
    parsed.schemaVersion !== 2
  )
    return parsed
  let offset = 0
  const whitespace = () => {
    while (/\s/.test(json[offset] ?? '') && offset < json.length) offset++
  }
  function string(): string {
    const start = offset++
    while (offset < json.length) {
      if (json[offset] === '\\') offset += 2
      else if (json[offset++] === '"') return JSON.parse(json.slice(start, offset)) as string
    }
    throw new Error('Invalid oracle wire JSON.')
  }
  function value(depth: number): void {
    // The strict v2 DTO is shallow. Bound parser work independently of plaintext bytes.
    if (depth > 16) throw new Error('Invalid oracle wire JSON.')
    whitespace()
    if (json[offset] === '{') {
      offset++
      whitespace()
      const keys = new Set<string>()
      if (json[offset] === '}') {
        offset++
        return
      }
      for (;;) {
        const key = string()
        if (keys.has(key)) throw new Error('Duplicate oracle wire JSON key.')
        keys.add(key)
        whitespace()
        offset++ // ':'; JSON.parse already checked token grammar.
        value(depth + 1)
        whitespace()
        if (json[offset++] === '}') return
        whitespace()
      }
    }
    if (json[offset] === '[') {
      offset++
      whitespace()
      if (json[offset] === ']') {
        offset++
        return
      }
      for (;;) {
        value(depth + 1)
        whitespace()
        if (json[offset++] === ']') return
      }
    }
    if (json[offset] === '"') {
      string()
      return
    }
    while (offset < json.length && !/[\s,\]}]/.test(json[offset])) offset++
  }
  value(0)
  return parsed
}
