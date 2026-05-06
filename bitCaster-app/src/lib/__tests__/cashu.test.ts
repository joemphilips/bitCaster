import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mock state so the wallet store mock can swap in per-test data.
const mocks = vi.hoisted(() => {
  const walletState: {
    mints: { url: string }[]
    addMint: ReturnType<typeof vi.fn>
    addMintWithoutActivating: ReturnType<typeof vi.fn>
    activeMintUrl: string
  } = {
    mints: [],
    addMint: vi.fn(async (_url: string) => {}),
    addMintWithoutActivating: vi.fn(async (_url: string) => {}),
    activeMintUrl: 'http://staging.example',
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
  mocks.walletState.addMintWithoutActivating.mockReset()
  mocks.walletState.addMintWithoutActivating.mockImplementation(async (_url: string) => {})
  mocks.walletState.activeMintUrl = 'http://staging.example'
})

describe('ensureMintRegistered', () => {
  // P8 security review Finding 3: ALL of these tests must assert the safe
  // (no-activate) variant is called, NOT the side-effecting `addMint` —
  // otherwise an attacker-controlled mint URL pasted into the receive flow
  // silently retargets the user's `activeMintUrl`. See bitcaster-coding-
  // guideline Rule 5.
  it('returns false and does not call any addMint when the mint is already configured', async () => {
    mocks.walletState.mints = [{ url: 'http://mint.example' }]

    const added = await ensureMintRegistered('http://mint.example')

    expect(added).toBe(false)
    expect(mocks.walletState.addMint).not.toHaveBeenCalled()
    expect(mocks.walletState.addMintWithoutActivating).not.toHaveBeenCalled()
  })

  it('normalises the input URL before comparing — trailing slash is not a new mint', async () => {
    mocks.walletState.mints = [{ url: 'http://mint.example' }]

    const added = await ensureMintRegistered('http://mint.example/')

    expect(added).toBe(false)
    expect(mocks.walletState.addMint).not.toHaveBeenCalled()
    expect(mocks.walletState.addMintWithoutActivating).not.toHaveBeenCalled()
  })

  it('calls addMintWithoutActivating (NOT addMint) with the normalised URL when the mint is unknown', async () => {
    mocks.walletState.mints = [{ url: 'http://other.mint' }]

    const added = await ensureMintRegistered('http://new.mint/')

    expect(added).toBe(true)
    expect(mocks.walletState.addMintWithoutActivating).toHaveBeenCalledOnce()
    expect(mocks.walletState.addMintWithoutActivating).toHaveBeenCalledWith('http://new.mint')
    // Critical: addMint MUST NOT be called from ingress paths because it
    // retargets activeMintUrl. Anyone re-introducing addMint here would
    // re-introduce the AGENTS.md anti-pattern.
    expect(mocks.walletState.addMint).not.toHaveBeenCalled()
  })

  it('propagates addMintWithoutActivating failures to the caller (must not be swallowed)', async () => {
    mocks.walletState.mints = []
    mocks.walletState.addMintWithoutActivating.mockRejectedValueOnce(
      new Error('mint unreachable')
    )

    await expect(ensureMintRegistered('http://broken.mint')).rejects.toThrow(
      'mint unreachable'
    )
  })
})

describe('extractMintUrlFromV4Token', () => {
  // P8 smoke regression — see commit message for context.
  //
  // Pasting a cashuB v4 token from a mint NOT yet in the user's store used
  // to throw "Couldn't map short keyset ID … to any known keysets of the
  // current Mint" because decodeToken's last-resort path fetched keysets from
  // the user's ACTIVE mint (e.g. bitcaster-staging) instead of the token's
  // issuing mint (e.g. testnut.cashu.space). The fix is a CBOR walker that
  // reads the v4 token's `m` field directly so we can target the right mint.
  //
  // These tests pin the extractor's behaviour directly so a future refactor
  // that drops or weakens the CBOR walk fails CI loudly rather than silently
  // re-introducing the bug (which only manifests against a real third-party
  // mint that the test environment can't easily simulate).
  const TESTNUT_V4_TOKEN =
    'cashuBo2F0gaJhaUgBiEp0uy_F7mFwhKNhYRBhc3hAMGE3ZDg3OWY4ZGY2OTRkY2RiMjc5NGQ0YzQ3ZDNhMjI4ODk3YzBiNWQ0MjhkMTFkYmJlZDQ5N2JjYTEzMGUyYmFjWCEC6E46HGmFL4V0zCB44J5iA4tFstICSsuTnj_4caoMXXSjYWEQYXN4QDM0OWJiZGQ1YjMyNjVlZWFjYTA0MGUyNGExZGQ0MmNlNTUxMDIzYmEyOTE4MzliZmM2Yjg0ZWRiMTdlZDExMDJhY1ghA-XD2T9-GXjmTgeXfVa1Xj-HuAVvnzVINliMHhhFqD3ao2FhEGFzeEA0ZDhmYzEzMTQzNmMyNzBkNDNjYmZjMmRkMjQ3MTlhZDM5Yjc2MzJmZGFiNTJhMWY0ODk0Y2U5MGNiYTU4NjgwYWNYIQIhQapBCpm5NWU0uwjNHqQBoVAFF2PxGmo1l9NpV20fs6NhYQJhc3hAYmRjNDg3NjQyN2Y2YWZjZjlmNjg1ODllNjIxNTg5ODkwNDQ3NWRjODU2OGZjOTYyOWYzZTcxODQzZjQ5ZTk4NWFjWCED4y_imdNoYT_5Uy8C8HH90nzU7DXWEG7xZLXlFsn_27VhbXgbaHR0cHM6Ly90ZXN0bnV0LmNhc2h1LnNwYWNlYXVjc2F0'

  it('returns the issuing mint URL from a real testnut v4 token', async () => {
    const { extractMintUrlFromV4Token } = await import('@/lib/cashu')
    expect(extractMintUrlFromV4Token(TESTNUT_V4_TOKEN)).toBe(
      'https://testnut.cashu.space'
    )
  })

  it('returns null for non-cashuB tokens (v3, junk, empty)', async () => {
    const { extractMintUrlFromV4Token } = await import('@/lib/cashu')
    expect(extractMintUrlFromV4Token('cashuAabcd')).toBeNull()
    expect(extractMintUrlFromV4Token('not-a-token')).toBeNull()
    expect(extractMintUrlFromV4Token('')).toBeNull()
  })

  it('returns null on CBOR garbage rather than throwing', async () => {
    const { extractMintUrlFromV4Token } = await import('@/lib/cashu')
    // valid base64 of garbage that is not a CBOR map
    expect(extractMintUrlFromV4Token('cashuBYWFhYQ')).toBeNull()
  })
})
