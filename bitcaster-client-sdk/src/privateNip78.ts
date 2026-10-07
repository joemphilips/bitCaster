import { v2 as nip44 } from 'nostr-tools/nip44'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from 'nostr-tools/utils'

export const BITCASTER_PRIVATE_STATE_KIND = 30078 as const

export function encryptSelfNip44(privateKeyHex: string, plaintext: string): string {
  const privateKey = hexToBytes(privateKeyHex)
  const publicKey = getPublicKey(privateKey)
  const conversationKey = nip44.utils.getConversationKey(privateKey, publicKey)
  return nip44.encrypt(plaintext, conversationKey)
}

export function decryptSelfNip44(
  privateKeyHex: string,
  publicKey: string,
  ciphertext: string,
): string {
  const conversationKey = nip44.utils.getConversationKey(hexToBytes(privateKeyHex), publicKey)
  return nip44.decrypt(ciphertext, conversationKey)
}

/** The adapter owns the event timestamp, signing, and relay transport. */
export function createPrivateNip78Content(privateKeyHex: string, dTag: string, plaintext: string) {
  return {
    kind: BITCASTER_PRIVATE_STATE_KIND,
    tags: [
      ['d', dTag],
      ['encrypted', 'nip44'],
    ],
    content: encryptSelfNip44(privateKeyHex, plaintext),
  }
}
