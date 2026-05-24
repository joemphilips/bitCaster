import { createECDH } from 'node:crypto'

export interface OrderEphemeralKeypair {
  privateKeyHex: string
  publicKeyHex: string
}

export function generateOrderEphemeralKeypair(): OrderEphemeralKeypair {
  const ecdh = createECDH('secp256k1')
  ecdh.generateKeys()
  return {
    privateKeyHex: normalizeSecp256k1PrivateKeyHex(ecdh.getPrivateKey('hex')),
    publicKeyHex: ecdh.getPublicKey(undefined, 'compressed').toString('hex'),
  }
}

export function normalizeSecp256k1PrivateKeyHex(hex: string): string {
  if (!/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('secp256k1 private key must be hex encoded')
  }
  if (hex.length > 64) {
    throw new Error('secp256k1 private key is longer than 32 bytes')
  }
  return hex.padStart(64, '0').toLowerCase()
}
