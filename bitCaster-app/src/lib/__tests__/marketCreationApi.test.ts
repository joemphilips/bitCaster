import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerCondition, registerPartition, createMarket, MintError } from '../markets'

const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

function mockFetchSuccess(body: unknown) {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  )
}

function mockFetchError(status: number, body: { code: number; detail: string }) {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }),
  )
}

function mockFetchErrorNoBody(status: number) {
  vi.mocked(globalThis.fetch).mockResolvedValueOnce(
    new Response('not json', { status }),
  )
}

const conditionParams = { tags: [['description', 'test']], announcementHex: 'abc123' }

describe('registerCondition', () => {
  it('returns condition_id on success', async () => {
    mockFetchSuccess({ condition_id: 'cond-123' })
    const result = await registerCondition(conditionParams)
    expect(result.condition_id).toBe('cond-123')
  })

  it('throws MintError with CDK code 13011 on oracle announcement verification failure', async () => {
    mockFetchError(400, { code: 13011, detail: 'Oracle announcement verification failed' })
    await expect(registerCondition(conditionParams)).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError)
      expect(e.code).toBe(13011)
      expect(e.detail).toBe('Oracle announcement verification failed')
      // message includes [Mint] prefix for UI display
      expect(e.message).toBe('[Mint] Oracle announcement verification failed')
      return true
    })
  })

  it('throws MintError with CDK code 13020 on invalid condition ID', async () => {
    mockFetchError(400, { code: 13020, detail: 'Invalid condition ID' })
    await expect(registerCondition(conditionParams)).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError)
      expect(e.code).toBe(13020)
      return true
    })
  })

  it('throws MintError with CDK code 13027 on oracle threshold not met', async () => {
    mockFetchError(400, { code: 13027, detail: 'Oracle threshold not met' })
    await expect(registerCondition(conditionParams)).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError)
      expect(e.code).toBe(13027)
      return true
    })
  })

  it('throws MintError with CDK code 13028 on condition already exists', async () => {
    mockFetchError(409, { code: 13028, detail: 'Condition already exists' })
    await expect(registerCondition(conditionParams)).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError)
      expect(e.code).toBe(13028)
      return true
    })
  })

  it('throws MintError with code 0 and fallback message when body is not JSON', async () => {
    mockFetchErrorNoBody(500)
    await expect(registerCondition(conditionParams)).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError)
      expect(e.code).toBe(0)
      expect(e.detail).toBe('not json')
      return true
    })
  })

  it('propagates network errors', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'))
    await expect(registerCondition(conditionParams)).rejects.toThrow('Failed to fetch')
  })
})

describe('registerPartition', () => {
  it('returns keysets on success', async () => {
    mockFetchSuccess({ keysets: { Yes: 'ks1', No: 'ks2' } })
    const result = await registerPartition('cond-123', ['Yes', 'No'])
    expect(result.keysets).toEqual({ Yes: 'ks1', No: 'ks2' })
  })

  it('sends collateral and parent_collection_id in request body', async () => {
    mockFetchSuccess({ keysets: { Yes: 'ks1', No: 'ks2' } })
    await registerPartition('cond-123', ['Yes', 'No'])

    const call = vi.mocked(globalThis.fetch).mock.calls[0]
    const body = JSON.parse(call[1]?.body as string)
    expect(body).toEqual({
      collateral: 'sat',
      partition: ['Yes', 'No'],
      parent_collection_id: '0000000000000000000000000000000000000000000000000000000000000000',
    })
  })

  it('throws MintError with CDK error code on condition not found', async () => {
    mockFetchError(404, { code: 13021, detail: 'Condition not found' })
    await expect(registerPartition('nonexistent', ['Yes', 'No'])).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError)
      expect(e.code).toBe(13021)
      expect(e.detail).toBe('Condition not found')
      return true
    })
  })

  it('throws MintError with CDK error code on overlapping outcome collections', async () => {
    mockFetchError(400, { code: 13037, detail: 'Overlapping outcome collections' })
    await expect(registerPartition('cond-123', ['A|B', 'B|C'])).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError)
      expect(e.code).toBe(13037)
      return true
    })
  })

  it('throws MintError with CDK error code on incomplete partition', async () => {
    mockFetchError(400, { code: 13038, detail: 'Incomplete partition' })
    await expect(registerPartition('cond-123', ['Yes'])).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError)
      expect(e.code).toBe(13038)
      return true
    })
  })

  it('throws MintError with code 0 and fallback message when body is not JSON', async () => {
    mockFetchErrorNoBody(500)
    await expect(registerPartition('cond-123', ['Yes', 'No'])).rejects.toSatisfy((e: MintError) => {
      expect(e).toBeInstanceOf(MintError)
      expect(e.code).toBe(0)
      expect(e.detail).toBe('not json')
      return true
    })
  })
})

const createMarketParams = {
  title: 'Test Market',
  description: 'Test description',
  outcomes: [
    { name: 'Yes', probability: 50 },
    { name: 'No', probability: 50 },
  ],
  liquiditySats: 10000,
  categoryTags: ['crypto'],
}

// createMarket calls generateNip98Header which requires an NDK signer.
// Mock the nostr module so tests don't need a real signer.
vi.mock('@/lib/nostr', () => ({
  getNdk: () => ({
    signer: {
      sign: vi.fn(),
    },
  }),
}))

// Mock NDKEvent so NIP-98 header generation doesn't hit real crypto
vi.mock('@nostr-dev-kit/ndk', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@nostr-dev-kit/ndk')>()
  return {
    ...mod,
    NDKEvent: class MockNDKEvent {
      kind = 0
      created_at = 0
      content = ''
      tags: string[][] = []
      async sign() { /* no-op */ }
      rawEvent() {
        return { kind: this.kind, created_at: this.created_at, content: this.content, tags: this.tags, id: 'mock', pubkey: 'mock', sig: 'mock' }
      }
    },
  }
})

describe('createMarket', () => {
  it('returns response on success', async () => {
    const body = { conditionId: 'cond-123', marketsCreated: ['cond-123-Yes', 'cond-123-No'], thumbnailUrl: null }
    mockFetchSuccess(body)
    const result = await createMarket('cond-123', createMarketParams)
    expect(result.conditionId).toBe('cond-123')
    expect(result.marketsCreated).toEqual(['cond-123-Yes', 'cond-123-No'])
  })

  it('sends metadata as form data', async () => {
    mockFetchSuccess({ conditionId: 'cond-123', marketsCreated: [], thumbnailUrl: null })
    await createMarket('cond-123', createMarketParams)

    const call = vi.mocked(globalThis.fetch).mock.calls[0]
    expect(call[0]).toContain('/api/v1/markets/cond-123')
    expect(call[1]?.method).toBe('POST')
    expect(call[1]?.body).toBeInstanceOf(FormData)
  })

  it('throws on validation error (400)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('At least 2 outcomes required', { status: 400 }),
    )
    await expect(createMarket('cond-123', createMarketParams)).rejects.toThrow(/Failed to create market/)
  })

  it('throws on conflict (409)', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce(
      new Response('Market already exists', { status: 409 }),
    )
    await expect(createMarket('cond-123', createMarketParams)).rejects.toThrow(/Failed to create market/)
  })
})
