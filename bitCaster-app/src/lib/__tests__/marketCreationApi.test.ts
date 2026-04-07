import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { registerCondition, registerPartition, MintError } from '../markets'

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

  it('throws MintError 13011 on oracle announcement verification failure', async () => {
    mockFetchError(400, { code: 13011, detail: 'Oracle announcement verification failed' })
    await expect(registerCondition(conditionParams)).rejects.toThrow(MintError)
    try {
      mockFetchError(400, { code: 13011, detail: 'Oracle announcement verification failed' })
      await registerCondition(conditionParams)
    } catch (e) {
      expect(e).toBeInstanceOf(MintError)
      expect((e as MintError).code).toBe(13011)
      expect((e as MintError).detail).toBe('Oracle announcement verification failed')
    }
  })

  it('throws MintError 13020 on invalid condition ID', async () => {
    mockFetchError(400, { code: 13020, detail: 'Invalid condition ID' })
    try {
      await registerCondition(conditionParams)
    } catch (e) {
      expect(e).toBeInstanceOf(MintError)
      expect((e as MintError).code).toBe(13020)
    }
  })

  it('throws MintError 13027 on oracle threshold not met', async () => {
    mockFetchError(400, { code: 13027, detail: 'Oracle threshold not met' })
    try {
      await registerCondition(conditionParams)
    } catch (e) {
      expect(e).toBeInstanceOf(MintError)
      expect((e as MintError).code).toBe(13027)
    }
  })

  it('throws MintError 13028 on condition already exists with different config', async () => {
    mockFetchError(409, { code: 13028, detail: 'Condition already exists' })
    try {
      await registerCondition(conditionParams)
    } catch (e) {
      expect(e).toBeInstanceOf(MintError)
      expect((e as MintError).code).toBe(13028)
    }
  })

  it('throws MintError with code 0 and fallback message when body is not JSON', async () => {
    mockFetchErrorNoBody(500)
    try {
      await registerCondition(conditionParams)
    } catch (e) {
      expect(e).toBeInstanceOf(MintError)
      expect((e as MintError).code).toBe(0)
      expect((e as MintError).detail).toMatch(/Failed to register condition: 500/)
    }
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

  it('throws MintError 13021 on condition not found', async () => {
    mockFetchError(404, { code: 13021, detail: 'Condition not found' })
    try {
      await registerPartition('nonexistent', ['Yes', 'No'])
    } catch (e) {
      expect(e).toBeInstanceOf(MintError)
      expect((e as MintError).code).toBe(13021)
    }
  })

  it('throws MintError 13037 on overlapping outcome collections', async () => {
    mockFetchError(400, { code: 13037, detail: 'Overlapping outcome collections' })
    try {
      await registerPartition('cond-123', ['A|B', 'B|C'])
    } catch (e) {
      expect(e).toBeInstanceOf(MintError)
      expect((e as MintError).code).toBe(13037)
    }
  })

  it('throws MintError 13038 on incomplete partition', async () => {
    mockFetchError(400, { code: 13038, detail: 'Incomplete partition' })
    try {
      await registerPartition('cond-123', ['Yes'])
    } catch (e) {
      expect(e).toBeInstanceOf(MintError)
      expect((e as MintError).code).toBe(13038)
    }
  })

  it('throws MintError with code 0 and fallback message when body is not JSON', async () => {
    mockFetchErrorNoBody(500)
    try {
      await registerPartition('cond-123', ['Yes', 'No'])
    } catch (e) {
      expect(e).toBeInstanceOf(MintError)
      expect((e as MintError).code).toBe(0)
      expect((e as MintError).detail).toMatch(/Failed to register partition: 500/)
    }
  })
})
