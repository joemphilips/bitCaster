import { describe, expect, it } from 'vitest'
import { generateTradeHubAccessToken } from '../useTradeHub'

describe('generateTradeHubAccessToken', () => {
  it('returns the raw NIP-98 token for SignalR Bearer transport', () => {
    const privateKey = new Uint8Array(32)
    privateKey[31] = 1

    const token = generateTradeHubAccessToken(
      privateKey,
      'https://example.com/hubs/trade',
    )

    expect(token).not.toMatch(/^Nostr\s+/)
    expect(() => JSON.parse(atob(token))).not.toThrow()
  })
})
