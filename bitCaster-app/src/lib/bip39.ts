import {
  generateMnemonic as _generateMnemonic,
  validateMnemonic as _validateMnemonic,
  mnemonicToSeedSync,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export function generate(): string[] {
  const phrase = _generateMnemonic(wordlist);
  return phrase.split(" ");
}

export function validate(words: string[]): boolean {
  return _validateMnemonic(words.join(" "), wordlist);
}

export function validateWord(word: string): boolean {
  return wordlist.includes(word.toLowerCase());
}

// PBKDF2 with 2,048 rounds takes tens of milliseconds. Recovery passes derive
// the seed of the active wallet many times, so keep the last result. The
// phrase is already in memory, so the cached seed adds no exposure.
let lastSeed: { readonly phrase: string; readonly seed: Uint8Array } | null = null;

export function toSeed(words: string[]): Uint8Array {
  const phrase = words.join(" ");
  if (lastSeed?.phrase !== phrase) lastSeed = { phrase, seed: mnemonicToSeedSync(phrase) };
  // A caller can change its copy.
  return lastSeed.seed.slice();
}
