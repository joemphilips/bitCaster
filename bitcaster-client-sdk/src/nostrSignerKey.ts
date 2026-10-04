import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { decode, nsecEncode } from 'nostr-tools/nip19'
import { decrypt } from 'nostr-tools/nip49'

export interface PrivateNostrSignerKey {
  readonly secretKeyHex: string
  readonly publicKeyHex: string
  readonly nsec: string
}

export function decodePrivateNostrSignerKey(
  value: string,
  decryptionPassphrase?: string,
): PrivateNostrSignerKey {
  try {
    const text = value.trim()
    if (text.length === 0 || text.length > 512) throw new Error('invalid key size')
    let secret: Uint8Array
    if (/^[0-9a-fA-F]{64}$/.test(text)) {
      secret = Uint8Array.from(text.match(/../g)!, (byte) => Number.parseInt(byte, 16))
    } else if (text.startsWith('ncryptsec1')) {
      if (decryptionPassphrase === undefined) throw new Error('missing key passphrase')
      secret = decrypt(text, decryptionPassphrase)
    } else {
      const result = decode(text)
      switch (result.type) {
        case 'nsec':
          secret = result.data
          break
        case 'nevent':
        case 'nprofile':
        case 'naddr':
        case 'npub':
        case 'note':
          throw new Error('not a private key')
        default: {
          const unknown: never = result
          throw new Error(`unknown private key encoding: ${typeof unknown}`)
        }
      }
    }
    return privateSignerKey(secret)
  } catch {
    // Parser and decryption errors can contain the supplied private input.
    throw new Error('Private Nostr key is invalid or could not be decrypted.')
  }
}

export function generatePrivateNostrSignerKey(): PrivateNostrSignerKey {
  return privateSignerKey(generateSecretKey())
}

function privateSignerKey(secret: Uint8Array): PrivateNostrSignerKey {
  try {
    if (secret.length !== 32) throw new Error('invalid private key length')
    return {
      secretKeyHex: Array.from(secret, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      publicKeyHex: getPublicKey(secret),
      nsec: nsecEncode(secret),
    }
  } finally {
    secret.fill(0)
  }
}
