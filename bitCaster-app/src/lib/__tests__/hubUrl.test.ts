import { describe, expect, it } from 'vitest'
import { resolveHubServerUrl } from '../hubUrl'

describe('resolveHubServerUrl', () => {
  it('uses the explicit hub override when present', () => {
    expect(
      resolveHubServerUrl({
        DEV: false,
        VITE_HUB_SERVER_URL: 'https://hubs.example.com/',
        VITE_SERVER_URL: 'https://backend.example.com/',
      }),
    ).toBe('https://hubs.example.com')
  })

  it('uses VITE_SERVER_URL only for local dev compatibility', () => {
    expect(
      resolveHubServerUrl({
        DEV: true,
        VITE_SERVER_URL: 'http://localhost:5100/',
      }),
    ).toBe('http://localhost:5100')
  })

  it('ignores legacy VITE_SERVER_URL in production and uses browser origin', () => {
    expect(
      resolveHubServerUrl(
        {
          DEV: false,
          VITE_SERVER_URL: 'https://backend.example.com/',
        },
        'https://frontend.example.com/',
      ),
    ).toBe('https://frontend.example.com')
  })
})
