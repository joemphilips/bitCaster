import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWalletStore } from '../wallet'
import * as bip39 from '@/lib/bip39'

// Reset store state before each test
beforeEach(() => {
  useWalletStore.setState({
    mnemonic: '',
    setupComplete: false,
    mints: [],
    activeMintUrl: 'http://localhost:3338',
    keysetCounters: {},
    mintConnectionStatuses: {},
  })
})

describe('useWalletStore', () => {
  describe('generateMnemonic', () => {
    it('produces 12 valid BIP-39 English words', () => {
      useWalletStore.getState().generateMnemonic()
      const mnemonic = useWalletStore.getState().mnemonic
      const words = mnemonic.split(' ')
      expect(words).toHaveLength(12)
      expect(bip39.validate(words)).toBe(true)
    })
  })

  describe('recoverFromMnemonic', () => {
    it('accepts a valid phrase', () => {
      const words = bip39.generate()
      const result = useWalletStore.getState().recoverFromMnemonic(words)
      expect(result.valid).toBe(true)
      expect(useWalletStore.getState().mnemonic).toBe(words.join(' '))
    })

    it('rejects invalid phrase', () => {
      const result = useWalletStore.getState().recoverFromMnemonic([
        'zoo', 'zoo', 'zoo', 'zoo',
        'zoo', 'zoo', 'zoo', 'zoo',
        'zoo', 'zoo', 'zoo', 'abandon',
      ])
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
    })

    it('rejects wrong word count', () => {
      const result = useWalletStore.getState().recoverFromMnemonic(['abandon', 'abandon'])
      expect(result.valid).toBe(false)
      expect(result.error).toContain('12 words')
    })
  })

  describe('testMintConnection', () => {
    it('returns connected on successful fetch', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('{}', { status: 200 })
      )
      const status = await useWalletStore.getState().testMintConnection('http://localhost:3338')
      expect(status).toBe('connected')
      expect(useWalletStore.getState().mintConnectionStatuses['http://localhost:3338']).toBe('connected')
      vi.restoreAllMocks()
    })

    it('returns failed on fetch error', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network'))
      const status = await useWalletStore.getState().testMintConnection('http://bad:1234')
      expect(status).toBe('failed')
      expect(useWalletStore.getState().mintConnectionStatuses['http://bad:1234']).toBe('failed')
      vi.restoreAllMocks()
    })
  })

  describe('removeMint', () => {
    it('cannot remove the last mint', () => {
      useWalletStore.setState({
        mints: [{ url: 'http://localhost:3338' }],
        activeMintUrl: 'http://localhost:3338',
      })
      useWalletStore.getState().removeMint('http://localhost:3338')
      expect(useWalletStore.getState().mints).toHaveLength(1)
    })

    it('removes a mint when there are multiple', () => {
      useWalletStore.setState({
        mints: [{ url: 'http://a.com' }, { url: 'http://b.com' }],
        activeMintUrl: 'http://a.com',
      })
      useWalletStore.getState().removeMint('http://b.com')
      expect(useWalletStore.getState().mints).toHaveLength(1)
      expect(useWalletStore.getState().mints[0].url).toBe('http://a.com')
    })
  })

  describe('completeSetup', () => {
    it('sets setupComplete to true', () => {
      expect(useWalletStore.getState().setupComplete).toBe(false)
      useWalletStore.getState().completeSetup()
      expect(useWalletStore.getState().setupComplete).toBe(true)
    })
  })
})
