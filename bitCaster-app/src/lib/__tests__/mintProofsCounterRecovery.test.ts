/**
 * P8 follow-up regression tests for `mintProofs` counter recovery.
 *
 * The bug we are guarding against:
 *
 * - CDK rejects re-used deterministic blinded outputs as a database
 *   duplicate. Older builds mislabeled that as `"Invoice already paid or
 *   pending"`; current builds expose `"Blinded message already signed or
 *   pending"` (`cdk-common/src/error.rs`, `Database(Duplicate)` →
 *   `ErrorCode::BlindedMessageAlreadySigned`).
 * - The `cdk-buy-yes` codex investigation (2026-05-06) traced this back to
 *   `ZustandCounterSource` lacking a migration for wallets that pre-existed
 *   commit `8711c73` — `keysetCounters[keysetId]` is `undefined`/0 while the
 *   mint already signed outputs at counter 0..N.
 *
 * The fix has two layers, both exercised here:
 *
 * 1. `mintProofs` catches the exact CDK error message, runs counter recovery
 *    against the active keyset, then retries `wallet.mintProofs` once.
 * 2. Non-recovery errors propagate unchanged so genuine LN payment failures
 *    are not swallowed by the recovery path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mocks — the cashu-ts wallet, the wallet store, and the proof DB
// are all swapped out per-test via these handles.
const mocks = vi.hoisted(() => {
  const wallet = {
    createMintQuote: vi.fn(),
    mintProofs: vi.fn(),
    batchRestore: vi.fn(),
    groupProofsByState: vi.fn(),
    mint: { getKeySets: vi.fn() },
    getKeyset: vi.fn(),
  }
  const getWallet = vi.fn(async () => wallet)
  const store: {
    mnemonic: string
    activeMintUrl: string
    mints: { url: string; keysets?: { id: string; unit?: string }[] }[]
    keysetCounters: Record<string, number>
    keysetCountersRecovered: Record<string, boolean>
    getWallet: (url?: string) => Promise<unknown>
  } = {
    mnemonic: 'seed words',
    activeMintUrl: 'https://mint.test',
    mints: [{ url: 'https://mint.test', keysets: [{ id: 'k1' }] }],
    keysetCounters: {},
    keysetCountersRecovered: {},
    getWallet,
  }
  const setStateImpl = vi.fn((updater: unknown) => {
    if (typeof updater === 'function') {
      const next = (updater as (s: typeof store) => Partial<typeof store>)(store)
      Object.assign(store, next)
    }
  })
  const addProofs = vi.fn(async (_p: unknown[]) => {})
  return { wallet, store, setStateImpl, addProofs, getWallet }
})

vi.mock('@/stores/wallet', () => ({
  useWalletStore: {
    getState: () => mocks.store,
    setState: mocks.setStateImpl,
  },
}))

vi.mock('@/stores/proof-db', () => ({
  addProofs: mocks.addProofs,
}))

// `getWallet` is also defined in cashu.ts, but the mintProofs helper uses
// the module's own getWallet (resolved at call site). We replace the entire
// module's `getWallet` via a vitest spy in beforeEach.

import * as cashu from '../cashu'

// `MintOperationError`-shape helper: real cashu-ts errors carry `.name`,
// `.code` and `.status`. The structural sanity check in
// `isCdkDuplicateOutputsError` requires at least one to match, so the
// tests build their thrown errors via this helper rather than bare `Error`.
function cdkDuplicateError(
  message = 'Blinded message already signed or pending',
): Error {
  const e = new Error(message) as Error & {
    name: string; code: number; status: number
  }
  e.name = 'MintOperationError'
  e.code = message.includes('Blinded message') ? 11003 : 20006
  e.status = 400
  return e
}

beforeEach(() => {
  mocks.wallet.createMintQuote.mockReset()
  mocks.wallet.mintProofs.mockReset()
  mocks.wallet.batchRestore.mockReset()
  mocks.wallet.groupProofsByState.mockReset()
  mocks.wallet.getKeyset.mockReset()
  mocks.wallet.getKeyset.mockReturnValue({ id: 'k1' })
  // Default: every recovered proof is treated as UNSPENT unless a test
  // overrides — keeps existing tests behaving the same as before the
  // spent-filter landed.
  mocks.wallet.groupProofsByState.mockImplementation(async (proofs: unknown[]) => ({
    unspent: proofs,
    pending: [],
    spent: [],
  }))
  mocks.wallet.mint.getKeySets.mockReset()
  mocks.wallet.mint.getKeySets.mockResolvedValue({ keysets: [{ id: 'k1' }] })
  mocks.store.keysetCounters = {}
  mocks.store.keysetCountersRecovered = {}
  mocks.store.activeMintUrl = 'https://mint.test'
  mocks.store.mints = [{ url: 'https://mint.test', keysets: [{ id: 'k1' }] }]
  mocks.store.mnemonic = 'seed words'
  mocks.addProofs.mockClear()
  mocks.getWallet.mockClear()
  mocks.getWallet.mockResolvedValue(mocks.wallet)
  mocks.store.getWallet = mocks.getWallet
})

describe('mintProofs — CDK duplicate-output recovery', () => {
  const QUOTE = { quote: 'q1', request: 'lnbc1...' } as never
  const PROOFS = [{ id: 'k1', amount: 100, secret: 's1', C: 'C1' }] as never

  it('scales sat-market mint quote requests into msat collateral subunits', async () => {
    const quote = { quote: 'q-msat', request: 'lnbc1...', unit: 'msat' }
    mocks.wallet.createMintQuote.mockResolvedValueOnce(quote)

    const result = await cashu.createMintQuote(13, 'https://mint.test', 'sat')

    expect(result).toBe(quote)
    expect(mocks.wallet.createMintQuote).toHaveBeenCalledWith(13_000)
  })

  it('scales sat-market mintProofs requests into msat collateral subunits', async () => {
    mocks.wallet.mintProofs.mockResolvedValueOnce(PROOFS)

    await cashu.mintProofs(13, QUOTE, 'https://mint.test', 'sat')

    expect(mocks.wallet.mintProofs).toHaveBeenCalledWith(13_000, 'q1')
  })

  it('advances persisted counters after a successful deterministic mint even when the wallet adapter did not persist the reservation', async () => {
    mocks.wallet.mintProofs.mockResolvedValueOnce(PROOFS)

    const result = await cashu.mintProofs(100, QUOTE, 'https://mint.test', 'usd')

    expect(result).toEqual(PROOFS)
    expect(mocks.store.keysetCounters.k1).toBe(1)
  })

  it('does not double-advance counters when cashu-ts already reserved the minted output range', async () => {
    mocks.store.keysetCounters = { k1: 7 }
    mocks.wallet.mintProofs.mockImplementationOnce(async () => {
      mocks.store.keysetCounters = { k1: 8 }
      return PROOFS
    })

    await cashu.mintProofs(100, QUOTE, 'https://mint.test', 'usd')

    expect(mocks.store.keysetCounters.k1).toBe(8)
  })

  it('retries mintProofs once after running counter recovery on CDK duplicate error', async () => {
    mocks.wallet.mintProofs
      .mockRejectedValueOnce(cdkDuplicateError('Invoice already paid or pending'))
      .mockResolvedValueOnce(PROOFS)
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 7,
    })

    const result = await cashu.mintProofs(100, QUOTE, 'https://mint.test')

    expect(result).toEqual(PROOFS)
    // Counter advanced past the highest known signature and the retry mint.
    expect(mocks.store.keysetCounters.k1).toBe(9)
    // Recovery flag set so the next mintProofs call doesn't re-run batchRestore.
    expect(mocks.store.keysetCountersRecovered.k1).toBe(true)
    expect(mocks.wallet.mintProofs).toHaveBeenCalledTimes(2)
    expect(mocks.wallet.batchRestore).toHaveBeenCalledTimes(1)
  })

  it('also retries the current CDK blinded-message duplicate detail', async () => {
    mocks.wallet.mintProofs
      .mockRejectedValueOnce(cdkDuplicateError('Blinded message already signed or pending'))
      .mockResolvedValueOnce(PROOFS)
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: 'k1', unit: 'usd' }],
    })
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 11,
    })

    const result = await cashu.mintProofs(100, QUOTE, 'https://mint.test', 'usd')

    expect(result).toEqual(PROOFS)
    expect(mocks.store.keysetCounters.k1).toBe(13)
    expect(mocks.wallet.mintProofs).toHaveBeenCalledTimes(2)
  })

  it('falls back to a bounded active-keyset counter bump when duplicate recovery cannot scan the unit', async () => {
    mocks.wallet.mintProofs
      .mockRejectedValueOnce(cdkDuplicateError('Blinded message already signed or pending'))
      .mockResolvedValueOnce(PROOFS)
    mocks.wallet.getKeyset.mockReturnValue({ id: 'usd-keyset' })
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: 'usd-keyset', unit: 'usd' }],
    })
    mocks.wallet.batchRestore.mockRejectedValueOnce(new Error('restore unavailable'))

    const result = await cashu.mintProofs(100, QUOTE, 'https://mint.test', 'usd')

    expect(result).toEqual(PROOFS)
    expect(mocks.wallet.batchRestore).toHaveBeenCalledOnce()
    expect(mocks.store.keysetCounters['usd-keyset']).toBe(100)
    expect(mocks.wallet.mintProofs).toHaveBeenCalledTimes(2)
  })

  it('persists any proofs that batchRestore recovers (so the user does not lose ecash)', async () => {
    mocks.wallet.mintProofs
      .mockRejectedValueOnce(cdkDuplicateError())
      .mockResolvedValueOnce(PROOFS)
    const recoveredProofs = [
      { id: 'k1', amount: 50, secret: 'rs1', C: 'rC1' },
    ] as never
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: 'k1', unit: 'usd' }],
    })
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: recoveredProofs,
      lastCounterWithSignature: 3,
    })

    await cashu.mintProofs(100, QUOTE, 'https://mint.test', 'usd')

    expect(mocks.addProofs).toHaveBeenCalledOnce()
    expect(mocks.addProofs).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          secret: 'rs1',
          mintUrl: 'https://mint.test',
          baseAsset: 'usd',
        }),
      ]),
    )
  })

  it('does NOT swallow non-CDK-duplicate errors (real LN payment failures must propagate)', async () => {
    mocks.wallet.mintProofs.mockRejectedValueOnce(
      new Error('Lightning payment timeout'),
    )

    await expect(
      cashu.mintProofs(100, QUOTE, 'https://mint.test'),
    ).rejects.toThrow('Lightning payment timeout')
    expect(mocks.wallet.batchRestore).not.toHaveBeenCalled()
    expect(mocks.wallet.mintProofs).toHaveBeenCalledTimes(1)
  })

  it('does not retry indefinitely — second CDK duplicate propagates', async () => {
    // After recovery, the retry STILL fails — could happen if cashu-ts has a
    // stale internal counter that the next reserve() pulls before
    // ZustandCounterSource sees the update. Bail with the original error
    // rather than spinning.
    mocks.wallet.mintProofs.mockRejectedValue(
      cdkDuplicateError(),
    )
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 5,
    })

    await expect(
      cashu.mintProofs(100, QUOTE, 'https://mint.test'),
    ).rejects.toThrow('Blinded message already signed or pending')
    expect(mocks.wallet.mintProofs).toHaveBeenCalledTimes(2) // one retry, no more
  })

  // Note on the anonymous-wallet (no-mnemonic) corner case: the
  // deterministic-counter recovery only makes sense for mnemonic-derived
  // wallets — without a seed, cashu-ts mints with random secrets and CDK
  // cannot have a stale signature collision for those outputs. The
  // `recoverKeysetCountersForMint` early-return handles this. We do not
  // unit-test it here because the no-mnemonic path in `cashu.ts:getWallet`
  // bypasses the mocked store's `getWallet` and constructs a fresh wallet
  // that calls `loadMint()` over HTTP — out of scope for a vitest mock.
})

describe('recoverKeysetCountersForMint — idempotency', () => {
  it('skips keysets already marked recovered', async () => {
    mocks.store.keysetCountersRecovered = { k1: true }

    await cashu.recoverKeysetCountersForMint('https://mint.test')

    expect(mocks.wallet.batchRestore).not.toHaveBeenCalled()
  })

  it('walks every keyset of the mint and marks each recovered', async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: 'k1' }, { id: 'k2' }],
    })
    mocks.wallet.batchRestore
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 4 })
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 9 })

    const r = await cashu.recoverKeysetCountersForMint('https://mint.test')

    expect(mocks.store.keysetCounters).toEqual({ k1: 5, k2: 10 })
    expect(mocks.store.keysetCountersRecovered).toEqual({ k1: true, k2: true })
    expect(r.scannedKeysets).toEqual(['k1', 'k2'])
  })

  it('walks every advertised keyset unit when no baseAsset filter is provided', async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: 'sat-keyset', unit: 'sat' }, { id: 'usd-keyset', unit: 'usd' }],
    })
    mocks.wallet.batchRestore
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 2 })
      .mockResolvedValueOnce({ proofs: [], lastCounterWithSignature: 8 })

    const r = await cashu.recoverKeysetCountersForMint('https://mint.test')

    expect(mocks.getWallet).toHaveBeenCalledWith('https://mint.test', 'sat')
    expect(mocks.getWallet).toHaveBeenCalledWith('https://mint.test', 'usd')
    expect(mocks.store.keysetCounters).toEqual({ 'sat-keyset': 3, 'usd-keyset': 9 })
    expect(r.scannedKeysets).toEqual(['sat-keyset', 'usd-keyset'])
  })

  it('filters recovery to the requested non-sat unit', async () => {
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({
      keysets: [{ id: 'sat-keyset', unit: 'sat' }, { id: 'usd-keyset', unit: 'usd' }],
    })
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 4,
    })

    const r = await cashu.recoverKeysetCountersForMint('https://mint.test', { baseAsset: 'usd' })

    expect(mocks.wallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, 'usd-keyset')
    expect(mocks.wallet.batchRestore).toHaveBeenCalledTimes(1)
    expect(mocks.store.keysetCounters).toEqual({ 'usd-keyset': 5 })
    expect(r.scannedKeysets).toEqual(['usd-keyset'])
  })

  it('uses fresh keysets from mint.getKeySets, not stale store keysets (codex review #3)', async () => {
    // Store has only k1; the mint has rotated to k2.
    mocks.store.mints = [{ url: 'https://mint.test', keysets: [{ id: 'k1' }] }]
    mocks.wallet.mint.getKeySets.mockResolvedValueOnce({ keysets: [{ id: 'k2' }] })
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [], lastCounterWithSignature: 2,
    })

    const r = await cashu.recoverKeysetCountersForMint('https://mint.test')

    expect(mocks.wallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, 'k2')
    expect(mocks.store.keysetCounters.k2).toBe(3)
    expect(r.scannedKeysets).toEqual(['k2'])
  })

  it('falls back to stored keysets if mint.getKeySets fails (network down)', async () => {
    mocks.wallet.mint.getKeySets.mockRejectedValueOnce(new Error('network'))
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [], lastCounterWithSignature: 1,
    })

    const r = await cashu.recoverKeysetCountersForMint('https://mint.test')

    expect(mocks.wallet.batchRestore).toHaveBeenCalledWith(300, 100, 0, 'k1')
    expect(r.scannedKeysets).toEqual(['k1'])
  })

  it('honours { force: true } and rescans even when keysetCountersRecovered is true (codex review #2)', async () => {
    mocks.store.keysetCountersRecovered = { k1: true }
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [], lastCounterWithSignature: 12,
    })

    const r = await cashu.recoverKeysetCountersForMint('https://mint.test', { force: true })

    // Counter was advanced despite the flag — proves the safety-net path
    // can re-scan even after the startup migration already ran.
    expect(mocks.store.keysetCounters.k1).toBe(13)
    expect(r.scannedKeysets).toEqual(['k1'])
  })

  it('returns empty scannedKeysets when no mnemonic (anonymous wallet)', async () => {
    mocks.store.mnemonic = ''
    const r = await cashu.recoverKeysetCountersForMint('https://mint.test')
    expect(r.scannedKeysets).toEqual([])
    expect(mocks.wallet.batchRestore).not.toHaveBeenCalled()
  })

  it('filters SPENT proofs out via groupProofsByState (codex review #1 BLOCKER)', async () => {
    // batchRestore returns ALL signed outputs — including spent ones.
    // Persisting spent proofs would inflate the displayed balance and
    // cause spent-token errors on the next spend. The fix uses
    // groupProofsByState to keep only UNSPENT.
    const recoveredProofs = [
      { id: 'k1', amount: 50, secret: 'unspent1', C: 'C1' },
      { id: 'k1', amount: 100, secret: 'spent1', C: 'C2' },
      { id: 'k1', amount: 25, secret: 'pending1', C: 'C3' },
    ] as never
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: recoveredProofs, lastCounterWithSignature: 5,
    })
    mocks.wallet.groupProofsByState.mockResolvedValueOnce({
      unspent: [recoveredProofs[0]],
      spent: [recoveredProofs[1]],
      pending: [recoveredProofs[2]],
    })

    await cashu.recoverKeysetCountersForMint('https://mint.test')

    expect(mocks.addProofs).toHaveBeenCalledOnce()
    const persisted = mocks.addProofs.mock.calls[0][0] as { secret: string }[]
    expect(persisted.map((p) => p.secret)).toEqual(['unspent1'])
    // Spent proofs MUST NOT land in IndexedDB.
    expect(persisted.find((p) => p.secret === 'spent1')).toBeUndefined()
    // Pending proofs are also excluded — they may resolve to SPENT shortly.
    expect(persisted.find((p) => p.secret === 'pending1')).toBeUndefined()
  })

  it('handles batchRestore returning no signatures (fresh wallet) by setting counter to 0', async () => {
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: undefined,
    })

    await cashu.recoverKeysetCountersForMint('https://mint.test')

    expect(mocks.store.keysetCounters.k1).toBe(0)
    expect(mocks.store.keysetCountersRecovered.k1).toBe(true)
  })

  it('does NOT lower an existing higher counter (max(current, recovered+1))', async () => {
    mocks.store.keysetCounters = { k1: 100 }
    mocks.wallet.batchRestore.mockResolvedValueOnce({
      proofs: [],
      lastCounterWithSignature: 5,
    })

    await cashu.recoverKeysetCountersForMint('https://mint.test')

    expect(mocks.store.keysetCounters.k1).toBe(100)
  })
})
