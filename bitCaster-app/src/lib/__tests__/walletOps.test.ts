import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/settings'
import { useWalletStore } from '@/stores/wallet'
import { currentGuiWalletId } from '@/stores/proof-db'
import * as cashu from '@/lib/cashu'
import * as ordinaryWallet from '@/stores/gui-ordinary-wallet-operation'
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
}))

vi.mock('@/stores/gui-ordinary-wallet-operation', () => ({
  receiveGuiCashuToken: vi.fn(),
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    addMint = vi.fn().mockResolvedValue(undefined)
    addMintWithoutActivating = vi.fn().mockResolvedValue(undefined)
    removeMint = vi.fn()
    setActiveMint = vi.fn()
    vi.mocked(cashu.decodeToken).mockReset()
    vi.mocked(ordinaryWallet.receiveGuiCashuToken).mockReset()
    vi.mocked(ordinaryWallet.receiveGuiCashuToken).mockResolvedValue([
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
      relays: [{ url: 'ws://localhost:7777', connectionStatus: 'disconnected' }],
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
    const expectedWalletId = currentGuiWalletId()
    const result = await ingressRegisterMint('https://unknown.mint/', 'paste')

    expect(result).toEqual({
      added: true,
      mintUrl: 'https://unknown.mint',
      source: 'paste',
    })
    expect(addMintWithoutActivating).toHaveBeenCalledWith(
      'https://unknown.mint',
      { expectedWalletId },
    )
    expect(addMint).not.toHaveBeenCalled()
    expect(setActiveMint).not.toHaveBeenCalled()
  })

  it('redeems ingress tokens under the issuing mint and reports the received amount', async () => {
    const expectedWalletId = currentGuiWalletId()
    vi.mocked(cashu.decodeToken).mockResolvedValueOnce({
      mint: 'https://unknown.mint/',
      proofs: [],
    } as never)

    const result = await ingressReceiveCashuToken('cashuB-token', 'scan')

    expect(ordinaryWallet.receiveGuiCashuToken).toHaveBeenCalledWith({
      token: expect.objectContaining({ mint: 'https://unknown.mint/' }),
      mintUrl: 'https://unknown.mint',
      unit: 'sat',
      expectedWalletId,
    })
    expect(addMintWithoutActivating).toHaveBeenCalledWith(
      'https://unknown.mint',
      { expectedWalletId },
    )
    expect(result).toMatchObject({
      added: true,
      amountSats: 55,
      unit: 'sat',
      mintUrl: 'https://unknown.mint',
      source: 'scan',
    })
  })

  it('preserves the token unit for non-sat tokens', async () => {
    const expectedWalletId = currentGuiWalletId()
    vi.mocked(cashu.decodeToken).mockResolvedValueOnce({
      mint: 'https://usd.mint/',
      unit: 'usd',
      proofs: [],
    } as never)

    const result = await ingressReceiveCashuToken('cashuB-usd-token', 'paste')

    expect(ordinaryWallet.receiveGuiCashuToken).toHaveBeenCalledWith({
      token: expect.objectContaining({ unit: 'usd' }),
      mintUrl: 'https://usd.mint',
      unit: 'usd',
      expectedWalletId,
    })
    expect(result).toMatchObject({
      unit: 'usd',
      mintUrl: 'https://usd.mint',
    })
  })

  it('rejects an explicitly unsupported token unit instead of defaulting to sat', async () => {
    vi.mocked(cashu.decodeToken).mockResolvedValueOnce({
      mint: 'https://unknown-unit.mint/',
      unit: 'private-bearer-unit',
      proofs: [],
    } as never)

    await expect(
      ingressReceiveCashuToken('cashuB-unknown-unit', 'paste'),
    ).rejects.toThrow('Unsupported Cashu token unit')

    expect(addMintWithoutActivating).not.toHaveBeenCalled()
    expect(ordinaryWallet.receiveGuiCashuToken).not.toHaveBeenCalled()
  })

  it('preserves conditional metadata returned by the durable coordinator', async () => {
    vi.mocked(cashu.decodeToken).mockResolvedValueOnce({
      mint: 'https://conditional.mint/',
      unit: 'sat',
      proofs: [],
    } as never)
    vi.mocked(ordinaryWallet.receiveGuiCashuToken).mockResolvedValueOnce([
      {
        secret: 's1',
        amount: 21,
        id: 'kid',
        C: 'C1',
        conditionId: 'condition-1',
        outcomeCollection: 'B',
        marketId: 'condition-1-B',
      },
      {
        secret: 's2',
        amount: 34,
        id: 'kid',
        C: 'C2',
        conditionId: 'condition-1',
        outcomeCollection: 'B',
        marketId: 'condition-1-B',
      },
    ] as never)

    const result = await ingressReceiveCashuToken('cashuB-conditional-token', 'paste')

    expect(result.proofs).toEqual([
      expect.objectContaining({
        secret: 's1',
        conditionId: 'condition-1',
        outcomeCollection: 'B',
        marketId: 'condition-1-B',
      }),
      expect.objectContaining({
        secret: 's2',
        conditionId: 'condition-1',
        outcomeCollection: 'B',
        marketId: 'condition-1-B',
      }),
    ])
  })

  it('does not re-register known ingress mints', async () => {
    const expectedWalletId = currentGuiWalletId()
    vi.mocked(cashu.decodeToken).mockResolvedValueOnce({
      mint: 'https://active.mint/',
      proofs: [],
    } as never)

    const result = await ingressReceiveCashuToken('token', 'nip17', {
      mintUrl: 'https://active.mint/',
    })

    expect(result.added).toBe(false)
    expect(addMintWithoutActivating).not.toHaveBeenCalled()
    // decodeToken is always called to read the token's unit (NUT-00)
    expect(cashu.decodeToken).toHaveBeenCalledWith('token')
    expect(ordinaryWallet.receiveGuiCashuToken).toHaveBeenCalledWith({
      token: expect.any(Object),
      mintUrl: 'https://active.mint',
      unit: 'sat',
      expectedWalletId,
    })
  })

  it('does not start a receive operation after the seed changes during mint registration', async () => {
    const delayedRegistration = deferred<void>()
    addMintWithoutActivating.mockReturnValueOnce(delayedRegistration.promise)
    vi.mocked(cashu.decodeToken).mockResolvedValueOnce({
      mint: 'https://delayed.mint/',
      proofs: [],
    } as never)
    const expectedWalletId = currentGuiWalletId()

    const receive = ingressReceiveCashuToken('cashuB-delayed', 'paste')
    void receive.catch(() => undefined)
    await vi.waitFor(() =>
      expect(addMintWithoutActivating).toHaveBeenCalledWith(
        'https://delayed.mint',
        { expectedWalletId },
      ),
    )
    useWalletStore.setState({
      mnemonic:
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
    })
    delayedRegistration.resolve()

    await expect(receive).rejects.toThrow('wallet seed changed')
    expect(ordinaryWallet.receiveGuiCashuToken).not.toHaveBeenCalled()
  })

  it('captures the wallet identity before awaiting token decoding', async () => {
    const delayedDecode = deferred<{
      mint: string
      proofs: never[]
    }>()
    vi.mocked(cashu.decodeToken).mockReturnValueOnce(delayedDecode.promise as never)

    const receive = ingressReceiveCashuToken('cashuB-delayed-decode', 'scan')
    void receive.catch(() => undefined)
    await vi.waitFor(() =>
      expect(cashu.decodeToken).toHaveBeenCalledWith(
        'cashuB-delayed-decode',
      ),
    )
    useWalletStore.setState({
      mnemonic:
        'legal winner thank year wave sausage worth useful legal winner thank yellow',
    })
    delayedDecode.resolve({
      mint: 'https://delayed-decode.mint',
      proofs: [],
    })

    await expect(receive).rejects.toThrow('wallet seed changed')
    expect(addMintWithoutActivating).not.toHaveBeenCalled()
    expect(ordinaryWallet.receiveGuiCashuToken).not.toHaveBeenCalled()
  })

  it('keeps read-only mint snapshots detached from store mutation', () => {
    const known = getKnownMints()
    known.push({ url: 'https://local-only.mint' })

    expect(useWalletStore.getState().mints).toHaveLength(1)
  })

  it('routes relay mutations through the settings store', () => {
    const store = useSettingsStore.getState()
    userAddRelay('ws://localhost:7778/')
    userRemoveRelay('ws://localhost:7778')

    expect(store.addRelay).toHaveBeenCalledWith('ws://localhost:7778')
    expect(store.removeRelay).toHaveBeenCalledWith('ws://localhost:7778')
  })

  it('keeps relay URL validation in the facade', () => {
    expect(normalizeRelayUrl(' ws://localhost:7778/ ')).toBe('ws://localhost:7778')
    expect(getRelayUrlValidationError('https://relay.example')).toBe('Relay URL must start with wss:// or local ws://')
    expect(getRelayUrlValidationError('wss://relay.example')).toBe(
      'Relay URL must be the configured bitCaster relay or a local relay.',
    )
    expect(getRelayUrlValidationError('wss://relay.damus.io')).toBe(
      'Public Nostr relays are not supported. Use a bitCaster-owned relay.',
    )
    expect(() => userAddRelay('https://relay.example')).toThrow('Relay URL must start with wss:// or local ws://')
    expect(() => userAddRelay('wss://nos.lol')).toThrow(
      'Public Nostr relays are not supported. Use a bitCaster-owned relay.',
    )
  })

  it('creates NIP-17 payment requests with relays and a stable request id', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValueOnce('abcdef12-3456-7890-abcd-ef1234567890')
    const nip17 = await import('@/lib/nip17')

    const result = userCreatePaymentRequest('https://active.mint/')

    expect(result.id).toBe('abcdef12')
    expect(result.encoded).toMatch(/^creq/)
    expect(nip17.getNostrNprofile).toHaveBeenCalledWith('1'.repeat(64), ['ws://localhost:7777'])
  })

  it('fails payment request creation when the wallet has no mnemonic', () => {
    useWalletStore.setState({ mnemonic: '' })

    expect(() => userCreatePaymentRequest('https://active.mint')).toThrow('Wallet not set up')
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
