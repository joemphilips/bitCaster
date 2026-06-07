import { describe, it, expect } from 'vitest'
import { detectMintCapabilities } from '../mints'

describe('detectMintCapabilities', () => {
  it('returns ctf:true when the /v1/info nuts map carries a CTF entry (T4.4.a)', () => {
    const info = {
      name: 'CTF mint',
      nuts: {
        '4': { methods: [] },
        '5': { methods: [] },
        CTF: { supported: true },
      },
    }
    expect(detectMintCapabilities(info)).toEqual({ ctf: true })
  })

  it('returns ctf:false for a vanilla mint that omits the CTF key (T4.4.b)', () => {
    const info = {
      name: 'Plain mint',
      nuts: {
        '4': { methods: [] },
        '5': { methods: [] },
      },
    }
    expect(detectMintCapabilities(info)).toEqual({ ctf: false })
  })

  it('returns ctf:false when info is undefined (mint never resolved)', () => {
    expect(detectMintCapabilities(undefined)).toEqual({ ctf: false })
  })

  it('returns ctf:false when info is missing the nuts map entirely', () => {
    expect(detectMintCapabilities({ name: 'Truncated' })).toEqual({ ctf: false })
  })

  it('parses CTF keyset policy and registration fee settings', () => {
    const info = {
      nuts: {
        CTF: {
          default_keyset_creation: 'one-vs-rest',
          registration_fee_base: '10',
          registration_fee_per_keyset: 2,
        },
      },
    }

    expect(detectMintCapabilities(info)).toEqual({
      ctf: true,
      ctfSettings: {
        defaultKeysetCreation: 'one-vs-rest',
        registrationFeeBase: 10,
        registrationFeePerKeyset: 2,
      },
    })
  })

  it('leaves CTF settings undefined when the advertised policy is missing or invalid', () => {
    expect(detectMintCapabilities({ nuts: { CTF: { supported: true } } })).toEqual({
      ctf: true,
    })
    expect(
      detectMintCapabilities({
        nuts: {
          CTF: {
            default_keyset_creation: 'invalid',
            registration_fee_base: 0,
            registration_fee_per_keyset: 0,
          },
        },
      }),
    ).toEqual({ ctf: true })
  })
})
