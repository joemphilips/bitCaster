import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mock state so the wallet store mock can swap in per-test data.
const mocks = vi.hoisted(() => {
  const walletState: {
    mints: { url: string }[]
    addMint: ReturnType<typeof vi.fn>
  } = {
    mints: [],
    addMint: vi.fn(async (_url: string) => {}),
  }
  return { walletState }
})

vi.mock('@/stores/wallet', () => ({
  useWalletStore: {
    getState: () => mocks.walletState,
  },
}))

import { ensureMintRegistered } from '../cashu'

beforeEach(() => {
  mocks.walletState.mints = []
  mocks.walletState.addMint.mockReset()
  mocks.walletState.addMint.mockImplementation(async (_url: string) => {})
})

describe('ensureMintRegistered', () => {
  it('returns false and does not call addMint when the mint is already configured', async () => {
    mocks.walletState.mints = [{ url: 'http://mint.example' }]

    const added = await ensureMintRegistered('http://mint.example')

    expect(added).toBe(false)
    expect(mocks.walletState.addMint).not.toHaveBeenCalled()
  })

  it('normalises the input URL before comparing — trailing slash is not a new mint', async () => {
    mocks.walletState.mints = [{ url: 'http://mint.example' }]

    const added = await ensureMintRegistered('http://mint.example/')

    expect(added).toBe(false)
    expect(mocks.walletState.addMint).not.toHaveBeenCalled()
  })

  it('calls addMint with the normalised URL and returns true when the mint is unknown', async () => {
    mocks.walletState.mints = [{ url: 'http://other.mint' }]

    const added = await ensureMintRegistered('http://new.mint/')

    expect(added).toBe(true)
    expect(mocks.walletState.addMint).toHaveBeenCalledOnce()
    expect(mocks.walletState.addMint).toHaveBeenCalledWith('http://new.mint')
  })

  it('propagates addMint failures to the caller (must not be swallowed)', async () => {
    mocks.walletState.mints = []
    mocks.walletState.addMint.mockRejectedValueOnce(new Error('mint unreachable'))

    await expect(ensureMintRegistered('http://broken.mint')).rejects.toThrow(
      'mint unreachable'
    )
  })
})
