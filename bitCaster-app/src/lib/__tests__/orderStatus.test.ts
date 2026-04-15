import { describe, expect, it } from 'vitest'
import { splitMarketId } from '../orderStatus'

describe('splitMarketId', () => {
  it('splits on the first hyphen so outcome names with hyphens survive', () => {
    expect(splitMarketId('deadbeef-Alice')).toEqual({
      conditionId: 'deadbeef',
      outcomeName: 'Alice',
    })
    expect(splitMarketId('cond123-Alice-Smith')).toEqual({
      conditionId: 'cond123',
      outcomeName: 'Alice-Smith',
    })
  })

  it('returns null for inputs without a usable separator', () => {
    expect(splitMarketId('no-separator-at-start'.replace(/-/g, ''))).toBeNull()
    expect(splitMarketId('-leadingDash')).toBeNull()
    expect(splitMarketId('trailingDash-')).toBeNull()
    expect(splitMarketId('')).toBeNull()
  })
})
