import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settings'
import { useWalletStore } from '@/stores/wallet'
import * as cashu from '@/lib/cashu'
import {
  getKnownMints,
  getRelayUrlValidationError,
  ingressReceiveCashuToken,
  ingressRegisterMint,
  normalizeRelayUrl,
  userAddAndSelectMint,
  userAddRelay,
  userRemoveMint,
  userRemoveRelay,
  userSwitchActiveMint,
} from '../walletOps'

vi.mock('@/lib/cashu', () => ({
  decodeToken: vi.fn(),
  receiveToken: vi.fn(),
}))

describe('walletOps facade', () => {
  let addMint: ReturnType<typeof vi.fn>
  let addMintWithoutActivating: ReturnType<typeof vi.fn>
  let removeMint: ReturnType<typeof vi.fn>
  let setActiveMint: ReturnType<typeof vi.fn>

  beforeEach(() => {
    addMint = vi.fn().mockResolvedValue(undefined)
    addMintWithoutActivating = vi.fn().mockResolvedValue(undefined)
    removeMint = vi.fn()
    setActiveMint = vi.fn()
    vi.mocked(cashu.decodeToken).mockReset()
    vi.mocked(cashu.receiveToken).mockReset()
    vi.mocked(cashu.receiveToken).mockResolvedValue([
      { secret: 's1', amount: 21, id: 'kid', C: 'C1' },
      { secret: 's2', amount: 34, id: 'kid', C: 'C2' },
    ] as never)
    useWalletStore.setState({
      mints: [{ url: 'https://active.mint', info: { name: 'Active' } }],
      activeMintUrl: 'https://active.mint',
      _addMint: addMint as never,
      _addMintWithoutActivating: addMintWithoutActivating as never,
      _removeMint: removeMint as never,
      _setActiveMint: setActiveMint as never,
    })
    useSettingsStore.setState({
      relays: [],
      addRelay: vi.fn(),
      removeRelay: vi.fn(),
    })
  })

  it('routes explicit user mint actions through the activating store path', async () => {
    await userAddAndSelectMint('https://new.mint/')
    userSwitchActiveMint('https://new.mint/')
    userRemoveMint('https://old.mint/')

    expect(addMint).toHaveBeenCalledWith('https://new.mint/')
    expect(setActiveMint).toHaveBeenCalledWith('https://new.mint/')
    expect(removeMint).toHaveBeenCalledWith('https://old.mint')
    expect(addMintWithoutActivating).not.toHaveBeenCalled()
  })

  it('registers unknown ingress mints without changing the active mint', async () => {
    const result = await ingressRegisterMint('https://unknown.mint/', 'paste')

    expect(result).toEqual({
      added: true,
      mintUrl: 'https://unknown.mint',
      source: 'paste',
    })
    expect(addMintWithoutActivating).toHaveBeenCalledWith('https://unknown.mint')
    expect(addMint).not.toHaveBeenCalled()
    expect(setActiveMint).not.toHaveBeenCalled()
  })

  it('redeems ingress tokens under the issuing mint and reports the received amount', async () => {
    vi.mocked(cashu.decodeToken).mockResolvedValueOnce({
      mint: 'https://unknown.mint/',
      proofs: [],
    } as never)

    const result = await ingressReceiveCashuToken('cashuB-token', 'scan')

    expect(cashu.receiveToken).toHaveBeenCalledWith('cashuB-token', 'https://unknown.mint')
    expect(addMintWithoutActivating).toHaveBeenCalledWith('https://unknown.mint')
    expect(result).toMatchObject({
      added: true,
      amountSats: 55,
      mintUrl: 'https://unknown.mint',
      source: 'scan',
    })
  })

  it('does not re-register known ingress mints', async () => {
    const result = await ingressReceiveCashuToken('token', 'nip17', {
      mintUrl: 'https://active.mint/',
    })

    expect(result.added).toBe(false)
    expect(addMintWithoutActivating).not.toHaveBeenCalled()
    expect(cashu.decodeToken).not.toHaveBeenCalled()
    expect(cashu.receiveToken).toHaveBeenCalledWith('token', 'https://active.mint')
  })

  it('keeps read-only mint snapshots detached from store mutation', () => {
    const known = getKnownMints()
    known.push({ url: 'https://local-only.mint' })

    expect(useWalletStore.getState().mints).toHaveLength(1)
  })

  it('routes relay mutations through the settings store', () => {
    const store = useSettingsStore.getState()
    userAddRelay('wss://relay.example/')
    userRemoveRelay('wss://relay.example')

    expect(store.addRelay).toHaveBeenCalledWith('wss://relay.example')
    expect(store.removeRelay).toHaveBeenCalledWith('wss://relay.example')
  })

  it('keeps relay URL validation in the facade', () => {
    expect(normalizeRelayUrl(' wss://relay.example/ ')).toBe('wss://relay.example')
    expect(getRelayUrlValidationError('https://relay.example')).toBe(
      'Relay URL must start with wss://',
    )
    expect(() => userAddRelay('https://relay.example')).toThrow(
      'Relay URL must start with wss://',
    )
  })
})
