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
  refreshMintInfoWithoutActivating,
  userAddAndSelectMint,
  userAddRelay,
  userCreatePaymentRequest,
  userRemoveMint,
  userRemoveRelay,
  userSwitchActiveMint,
} from '../walletOps'

vi.mock('@/lib/cashu', () => ({
  decodeToken: vi.fn(),
  receiveToken: vi.fn(),
}))

vi.mock('@/lib/nip17', () => ({
  deriveNostrKeyPair: vi.fn().mockReturnValue({
    privateKey: new Uint8Array(32),
    privateKeyHex: '0'.repeat(64),
    publicKey: '1'.repeat(64),
  }),
  getNostrNprofile: vi.fn().mockReturnValue('nprofile1test'),
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
      mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      mints: [{ url: 'https://active.mint', info: { name: 'Active' } }],
      activeMintUrl: 'https://active.mint',
      _addMint: addMint as never,
      _addMintWithoutActivating: addMintWithoutActivating as never,
      _removeMint: removeMint as never,
      _setActiveMint: setActiveMint as never,
    })
    useSettingsStore.setState({
      relays: [{ url: 'wss://relay.example', connectionStatus: 'disconnected' }],
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

  it('refreshes mint info without changing the active mint', async () => {
    await refreshMintInfoWithoutActivating('https://active.mint/')

    expect(addMintWithoutActivating).toHaveBeenCalledWith('https://active.mint/')
    expect(addMint).not.toHaveBeenCalled()
    expect(setActiveMint).not.toHaveBeenCalled()
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

  it('creates NIP-17 payment requests with relays and a stable request id', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('abcdef12-3456-7890-abcd-ef1234567890')
    const nip17 = await import('@/lib/nip17')

    const result = userCreatePaymentRequest('https://active.mint/')

    expect(result.id).toBe('abcdef12')
    expect(result.encoded).toMatch(/^creq/)
    expect(nip17.getNostrNprofile).toHaveBeenCalledWith('1'.repeat(64), ['wss://relay.example'])
  })

  it('fails payment request creation when the wallet has no mnemonic', () => {
    useWalletStore.setState({ mnemonic: '' })

    expect(() => userCreatePaymentRequest('https://active.mint')).toThrow('Wallet not set up')
  })
})
