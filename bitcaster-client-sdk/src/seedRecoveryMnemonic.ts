import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

/** Derive the standard 64-byte BIP-39 seed from an English recovery phrase. */
export function seedRecoveryMnemonicBytes(input: string): Uint8Array {
  if (typeof input !== 'string') {
    throw new Error('recovery phrase must be a string')
  }
  const phrase = input.normalize('NFKD').trim().split(/\s+/u).join(' ')
  if (!validateMnemonic(phrase, wordlist)) {
    throw new Error('recovery phrase is not a valid English BIP-39 mnemonic')
  }
  return mnemonicToSeedSync(phrase)
}
