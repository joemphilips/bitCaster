import { describe, it, expect } from 'vitest'
import { generate, validate, validateWord, toSeed } from '../bip39'

describe('bip39 helpers', () => {
  describe('generate', () => {
    it('returns 12 words', () => {
      const words = generate()
      expect(words).toHaveLength(12)
    })

    it('returns valid BIP-39 English words', () => {
      const words = generate()
      for (const word of words) {
        expect(validateWord(word)).toBe(true)
      }
    })

    it('generates a valid mnemonic', () => {
      const words = generate()
      expect(validate(words)).toBe(true)
    })
  })

  describe('validate', () => {
    it('accepts a valid 12-word phrase', () => {
      const words = generate()
      expect(validate(words)).toBe(true)
    })

    it('rejects an invalid phrase (wrong checksum)', () => {
      const badWords = [
        'zoo', 'zoo', 'zoo', 'zoo',
        'zoo', 'zoo', 'zoo', 'zoo',
        'zoo', 'zoo', 'zoo', 'abandon',
      ]
      expect(validate(badWords)).toBe(false)
    })

    it('rejects a phrase with invalid words', () => {
      const words = [
        'zzzzzzz', 'abandon', 'abandon', 'abandon',
        'abandon', 'abandon', 'abandon', 'abandon',
        'abandon', 'abandon', 'abandon', 'about',
      ]
      expect(validate(words)).toBe(false)
    })
  })

  describe('validateWord', () => {
    it('returns true for valid English BIP-39 words', () => {
      expect(validateWord('abandon')).toBe(true)
      expect(validateWord('zoo')).toBe(true)
      expect(validateWord('ability')).toBe(true)
    })

    it('returns false for invalid words', () => {
      expect(validateWord('zzzzzzz')).toBe(false)
      expect(validateWord('bitcoin')).toBe(false)
      expect(validateWord('')).toBe(false)
    })
  })

  describe('toSeed', () => {
    it('returns a Uint8Array of 64 bytes', () => {
      const words = generate()
      const seed = toSeed(words)
      expect(seed).toBeInstanceOf(Uint8Array)
      expect(seed.length).toBe(64)
    })

    it('produces deterministic output for same input', () => {
      const words = generate()
      const seed1 = toSeed(words)
      const seed2 = toSeed(words)
      expect(seed1).toEqual(seed2)
    })
  })
})
