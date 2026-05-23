/**
 * Coverage for `waitForMintQuotePaid` — the bounded mint-quote poller that
 * replaces the P8 forever-spinner.
 *
 * Each branch of the discriminated `MintQuoteWaitResult` is exercised:
 *   - PAID via the polling path
 *   - ISSUED → terminal ERROR (don't loop on already-minted quotes)
 *   - bolt11 expiry → terminal EXPIRED
 *   - repeated transient poll errors → propagate via onTransientError, not terminal
 *   - unsubscribe stops further polls
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MintQuoteResponse, PartialMintQuoteResponse } from '@cashu/cashu-ts'

// Mock the wallet store so the cashu.ts `getWallet()` short-circuits into our
// mock wallet instead of constructing a real `CashuWallet` (which would try to
// hit the network in jsdom). cashu.ts:48-52 — when the store carries a
// mnemonic it delegates to `store.getWallet(mintUrl)`.
const mockCheckMintQuote = vi.fn<(id: string) => Promise<PartialMintQuoteResponse>>()
const mockMintQuotePaidOn = vi.fn<
  (id: string, paid: (q: PartialMintQuoteResponse) => void, err: (e: Error) => void) => Promise<() => void>
>()

const fakeWallet = {
  checkMintQuote: (id: string) => mockCheckMintQuote(id),
  on: { mintQuotePaid: (id: string, p: (q: PartialMintQuoteResponse) => void, e: (err: Error) => void) => mockMintQuotePaidOn(id, p, e) },
}

vi.mock('@/stores/wallet', () => ({
  useWalletStore: {
    getState: () => ({
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      mints: [],
      getWallet: async () => fakeWallet,
    }),
  },
}))

import { waitForMintQuotePaid, type MintQuoteWaitResult } from '../cashu'

const NOW_SEC = 1_700_000_000
const POLL_MS = 50

function makeQuote(overrides: Partial<MintQuoteResponse> = {}): MintQuoteResponse {
  return {
    quote: 'q-test-1',
    request: 'lnbc-test',
    amount: 1000,
    unit: 'sat',
    state: 'UNPAID',
    expiry: NOW_SEC + 3600,  // 1h in the future by default
    ...overrides,
  } as unknown as MintQuoteResponse
}

function partialQuote(state: 'UNPAID' | 'PAID' | 'ISSUED'): PartialMintQuoteResponse {
  return {
    quote: 'q-test-1',
    request: 'lnbc-test',
    amount: 1000,
    unit: 'sat',
    state,
    expiry: NOW_SEC + 3600,
  } as unknown as PartialMintQuoteResponse
}

describe('waitForMintQuotePaid', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW_SEC * 1000)
    mockCheckMintQuote.mockReset()
    mockMintQuotePaidOn.mockReset()
    // Default: WS subscribe pends forever — polling carries the suite.
    mockMintQuotePaidOn.mockReturnValue(new Promise(() => {}))
  })
  afterEach(() => vi.useRealTimers())

  it('fires PAID when the poll observes state="PAID"', async () => {
    mockCheckMintQuote.mockResolvedValueOnce(partialQuote('PAID'))
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>()

    await waitForMintQuotePaid(makeQuote(), onResult, { pollIntervalMs: POLL_MS })
    await vi.advanceTimersByTimeAsync(POLL_MS + 5)

    expect(onResult).toHaveBeenCalledOnce()
    expect(onResult.mock.calls[0][0].status).toBe('PAID')
  })

  it('fires terminal ERROR when ISSUED arrives without us having minted', async () => {
    mockCheckMintQuote.mockResolvedValueOnce(partialQuote('ISSUED'))
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>()

    await waitForMintQuotePaid(makeQuote(), onResult, { pollIntervalMs: POLL_MS })
    await vi.advanceTimersByTimeAsync(POLL_MS + 5)

    expect(onResult).toHaveBeenCalledOnce()
    const result = onResult.mock.calls[0][0]
    expect(result.status).toBe('ERROR')
    if (result.status === 'ERROR') {
      expect(result.error.message).toMatch(/already issued/i)
    }
  })

  it('fires EXPIRED at the bolt11 expiry boundary instead of polling forever', async () => {
    // Quote expires in 5 seconds.
    mockCheckMintQuote.mockResolvedValue(partialQuote('UNPAID'))
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>()

    await waitForMintQuotePaid(
      makeQuote({ expiry: NOW_SEC + 5 }),
      onResult,
      { pollIntervalMs: POLL_MS },
    )

    // Advance past expiry — poll keeps returning UNPAID; expiry timer fires.
    await vi.advanceTimersByTimeAsync(5_500)

    expect(onResult).toHaveBeenCalledOnce()
    expect(onResult.mock.calls[0][0].status).toBe('EXPIRED')
  })

  it('fires EXPIRED immediately when the quote is already past expiry at call time', async () => {
    mockCheckMintQuote.mockResolvedValue(partialQuote('UNPAID'))
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>()

    await waitForMintQuotePaid(
      makeQuote({ expiry: NOW_SEC - 10 }),  // already expired
      onResult,
      { pollIntervalMs: POLL_MS },
    )
    await vi.advanceTimersByTimeAsync(5)

    expect(onResult).toHaveBeenCalledOnce()
    expect(onResult.mock.calls[0][0].status).toBe('EXPIRED')
  })

  it('reports repeated transient poll errors via onTransientError without firing terminal', async () => {
    mockCheckMintQuote.mockRejectedValue(new Error('mint network blip'))
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>()
    const onTransientError = vi.fn<(e: Error) => void>()

    await waitForMintQuotePaid(makeQuote(), onResult, {
      pollIntervalMs: POLL_MS,
      onTransientError,
    })
    await vi.advanceTimersByTimeAsync(POLL_MS * 3 + 5)

    expect(onResult).not.toHaveBeenCalled()
    expect(onTransientError.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(onTransientError.mock.calls[0][0].message).toMatch(/network blip/i)
  })

  it('unsubscribe stops further polling and prevents the result callback', async () => {
    mockCheckMintQuote.mockImplementation(async () => partialQuote('PAID'))
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>()

    const unsub = await waitForMintQuotePaid(makeQuote(), onResult, {
      pollIntervalMs: POLL_MS,
    })
    unsub()
    await vi.advanceTimersByTimeAsync(POLL_MS * 5 + 5)

    expect(onResult).not.toHaveBeenCalled()
  })

  it('ignores UNPAID and continues polling until PAID', async () => {
    mockCheckMintQuote
      .mockResolvedValueOnce(partialQuote('UNPAID'))
      .mockResolvedValueOnce(partialQuote('UNPAID'))
      .mockResolvedValueOnce(partialQuote('PAID'))
    const onResult = vi.fn<(r: MintQuoteWaitResult) => void>()

    await waitForMintQuotePaid(makeQuote(), onResult, { pollIntervalMs: POLL_MS })
    await vi.advanceTimersByTimeAsync(POLL_MS * 4 + 5)

    expect(onResult).toHaveBeenCalledOnce()
    expect(onResult.mock.calls[0][0].status).toBe('PAID')
  })
})
