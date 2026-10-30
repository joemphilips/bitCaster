import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

/** Public test fixtures: each denomination has its own mint signing key. */
export function mintDenominationPrivateKey(root: Uint8Array, amount: string): Uint8Array {
  return hexToBytes(
    (BigInt(`0x${bytesToHex(root)}`) + BigInt(amount) - 1n).toString(16).padStart(64, '0'),
  )
}

export function mintDenominationKeys(
  root: Uint8Array,
  amounts: readonly string[],
): Record<string, string> {
  return Object.fromEntries(
    amounts.map((amount) => [
      amount,
      bytesToHex(secp256k1.getPublicKey(mintDenominationPrivateKey(root, amount), true)),
    ]),
  )
}
