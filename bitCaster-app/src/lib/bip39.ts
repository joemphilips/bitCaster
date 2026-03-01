import {
  generateMnemonic as _generateMnemonic,
  validateMnemonic as _validateMnemonic,
  mnemonicToSeedSync,
} from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'

export function generate(): string[] {
  const phrase = _generateMnemonic(wordlist)
  return phrase.split(' ')
}

export function validate(words: string[]): boolean {
  return _validateMnemonic(words.join(' '), wordlist)
}

export function validateWord(word: string): boolean {
  return wordlist.includes(word.toLowerCase())
}

export function toSeed(words: string[]): Uint8Array {
  return mnemonicToSeedSync(words.join(' '))
}
