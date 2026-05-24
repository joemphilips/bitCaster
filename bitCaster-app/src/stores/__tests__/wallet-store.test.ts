import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useWalletStore } from '../wallet'
import * as bip39 from '@/lib/bip39'

// Reset store state before each test
beforeEach(() => {
  useWalletStore.setState({
    mnemonic: '',
    setupComplete: false,
    mints: [],
    activeMintUrl: 'http://localhost:8085',
    keysetCounters: {},
    keysetCountersRecovered: {},
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

    it('clears keysetCounters and keysetCountersRecovered when seed changes (codex review #6)', () => {
      // Pre-existing wallet had counters and a recovery flag. Switching to
      // a new seed via recoverFromMnemonic must NOT carry those over —
      // otherwise the new seed is treated as already-recovered against the
      // mint and counter collisions are not caught.
      useWalletStore.setState({
        mnemonic: 'old seed words placeholder',
        keysetCounters: { k1: 42 },
        keysetCountersRecovered: { k1: true },
      })
      const words = bip39.generate()
      useWalletStore.getState().recoverFromMnemonic(words)

      const state = useWalletStore.getState()
      expect(state.mnemonic).toBe(words.join(' '))
      expect(state.keysetCounters).toEqual({})
      expect(state.keysetCountersRecovered).toEqual({})
    })
  })

  describe('generateMnemonic — also clears counter state (codex review #6)', () => {
    it('resets keysetCounters and keysetCountersRecovered on new mnemonic', () => {
      useWalletStore.setState({
        keysetCounters: { k1: 99 },
        keysetCountersRecovered: { k1: true },
      })
      useWalletStore.getState().generateMnemonic()

      const state = useWalletStore.getState()
      expect(state.mnemonic.split(' ')).toHaveLength(12)
      expect(state.keysetCounters).toEqual({})
      expect(state.keysetCountersRecovered).toEqual({})
    })
  })

  describe('testMintConnection', () => {
    it('returns connected on successful fetch', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response('{}', { status: 200 })
      )
      const status = await useWalletStore.getState().testMintConnection('http://localhost:8085')
      expect(status).toBe('connected')
      expect(useWalletStore.getState().mintConnectionStatuses['http://localhost:8085']).toBe('connected')
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

  describe('_removeMint', () => {
    it('cannot remove the last mint', () => {
      useWalletStore.setState({
        mints: [{ url: 'http://localhost:8085' }],
        activeMintUrl: 'http://localhost:8085',
      })
      useWalletStore.getState()._removeMint('http://localhost:8085')
      expect(useWalletStore.getState().mints).toHaveLength(1)
    })

    it('removes a mint when there are multiple', () => {
      useWalletStore.setState({
        mints: [{ url: 'http://a.com' }, { url: 'http://b.com' }],
        activeMintUrl: 'http://a.com',
      })
      useWalletStore.getState()._removeMint('http://b.com')
      expect(useWalletStore.getState().mints).toHaveLength(1)
      expect(useWalletStore.getState().mints[0].url).toBe('http://a.com')
    })
  })

  describe('completeSetup', () => {
    it('sets setupComplete to true', async () => {
      // Pre-populate mints so completeSetup skips the internal add-mint network call
      useWalletStore.setState({ mints: [{ url: 'http://localhost:8085' }] })
      expect(useWalletStore.getState().setupComplete).toBe(false)
      await useWalletStore.getState().completeSetup()
      expect(useWalletStore.getState().setupComplete).toBe(true)
    })
  })

  describe('_addMintWithoutActivating + _setActiveMint — P8 Finding 3 split', () => {
    // The activating add-mint side effect that retargets activeMintUrl is the AGENTS.md-
    // documented anti-pattern that bit P8 Issue 4. These tests pin the
    // separation: untrusted-input ingress paths use addMintWithoutActivating;
    // setActiveMint is the explicit user-consent action.
    beforeEach(() => {
      useWalletStore.setState({
        mints: [{ url: 'http://staging.example' } as never],
        activeMintUrl: 'http://staging.example',
      })
    })

    it('_addMintWithoutActivating registers the mint but leaves activeMintUrl untouched', async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const u = String(input)
        if (u.endsWith('/v1/info')) {
          return Response.json({
            name: 'test mint',
            pubkey: 'abc',
            version: 'test',
            nuts: {
              4: { methods: [] },
              5: { methods: [] },
            },
          })
        }
        if (u.endsWith('/v1/keysets')) return new Response('{"keysets":[]}')
        if (u.endsWith('/v1/keys')) return new Response('{"keysets":[{"id":"k","unit":"sat","keys":{}}]}')
        return new Response('{}')
      })

      await useWalletStore.getState()._addMintWithoutActivating('https://attacker.example')

      const state = useWalletStore.getState()
      expect(state.mints.map((m) => m.url)).toContain('https://attacker.example')
      // Critical assertion: untrusted-input registration MUST NOT change the
      // user's active mint. If this assertion ever fails, the activating add-mint anti-
      // pattern has been re-introduced — re-read bitcaster-coding-guideline
      // Rule 5 in the bitCaster submodule's SKILL.md.
      expect(state.activeMintUrl).toBe('http://staging.example')
    })

    it('_setActiveMint switches activeMintUrl only when the target is already a registered mint', () => {
      useWalletStore.setState({
        mints: [
          { url: 'http://staging.example' } as never,
          { url: 'https://other.example' } as never,
        ],
      })

      useWalletStore.getState()._setActiveMint('https://other.example')
      expect(useWalletStore.getState().activeMintUrl).toBe('https://other.example')

      // Switching to an unregistered mint is a no-op (no surprise activation
      // from a typo or stale URL).
      useWalletStore.getState()._setActiveMint('https://unknown.example')
      expect(useWalletStore.getState().activeMintUrl).toBe('https://other.example')
    })
  })
})
