import { describe, it, expect } from 'vitest'
import en from '../locales/en.json'
import ja from '../locales/ja.json'

/**
 * Recursively flatten a translation catalogue object into a list of dotted
 * key paths. Sorting keeps test failure messages stable across runs and
 * makes diffs easy to read when a translator forgets a key.
 */
function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (obj === null || typeof obj !== 'object') return []
  const out: string[] = []
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      out.push(...flattenKeys(value, path))
    } else {
      out.push(path)
    }
  }
  return out.sort()
}

/**
 * Returns the set of `{{name}}` interpolation tokens used in a translation
 * string. i18next plain interpolation only — pluralisation suffixes are
 * caught at the key level (each plural variant is a separate JSON key).
 */
function extractPlaceholders(value: string): Set<string> {
  const tokens = new Set<string>()
  const re = /\{\{\s*([^}\s]+)\s*\}\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(value)) !== null) {
    tokens.add(match[1])
  }
  return tokens
}

function getValueAt(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, segment) => {
    if (acc !== null && typeof acc === 'object' && segment in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[segment]
    }
    return undefined
  }, obj)
}

/**
 * Asserts every key in `a` exists in `b`. Returns the offending keys for the
 * test runner to print.
 */
export function getMissingKeys(a: object, b: object): string[] {
  const aKeys = flattenKeys(a)
  const bKeys = new Set(flattenKeys(b))
  return aKeys.filter((k) => !bKeys.has(k))
}

/**
 * Returns keys whose `{{token}}` placeholder set differs between the two
 * catalogues. A mismatch means a translator forgot to keep an interpolation
 * variable that the calling code passes at runtime — the "translated"
 * string would silently swallow the variable.
 */
export function getPlaceholderMismatches(a: object, b: object): string[] {
  const aKeys = flattenKeys(a)
  const offenders: string[] = []
  for (const key of aKeys) {
    const aVal = getValueAt(a, key)
    const bVal = getValueAt(b, key)
    if (typeof aVal !== 'string' || typeof bVal !== 'string') continue
    const aTokens = extractPlaceholders(aVal)
    const bTokens = extractPlaceholders(bVal)
    if (aTokens.size !== bTokens.size) {
      offenders.push(key)
      continue
    }
    for (const token of aTokens) {
      if (!bTokens.has(token)) {
        offenders.push(key)
        break
      }
    }
  }
  return offenders
}

describe('i18n catalogue parity', () => {
  it('every key in en.json exists in ja.json', () => {
    const missing = getMissingKeys(en, ja)
    expect(missing, `Keys present in en.json but missing in ja.json:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('every key in ja.json exists in en.json', () => {
    const missing = getMissingKeys(ja, en)
    expect(missing, `Keys present in ja.json but missing in en.json:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  it('placeholder tokens (e.g. {{count}}) match between en.json and ja.json', () => {
    const mismatches = getPlaceholderMismatches(en, ja)
    expect(mismatches, `Placeholder mismatches between en.json and ja.json:\n  ${mismatches.join('\n  ')}`).toEqual([])
  })
})
