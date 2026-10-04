import { finalizeEvent, getEventHash, getPublicKey, type EventTemplate } from 'nostr-tools/pure'
import { v2 as nip44 } from 'nostr-tools/nip44'

// Public artificial keys. They never belong to a profile or real wallet.
export const paymentRequestFixtureSeed = new Uint8Array(64).fill(1)
export const paymentRequestFixtureRecipient = paymentRequestFixtureSeed.slice(0, 32)
export const paymentRequestFixtureRecipientPubkey = getPublicKey(paymentRequestFixtureRecipient)
const senderKey = new Uint8Array(32).fill(2)
const wrapperKey = new Uint8Array(32).fill(3)

export function createPaymentRequestGiftwrap(
  input: {
    readonly content?: string
    readonly recipientKey?: Uint8Array
    readonly rumorPatch?: Record<string, unknown>
    readonly rumorPlaintext?: string
    readonly sealPlaintext?: string
    readonly sealPatch?: Partial<EventTemplate>
    readonly wrapPatch?: Partial<EventTemplate>
    readonly badSealSignature?: boolean
  } = {},
) {
  const recipientPubkey = getPublicKey(input.recipientKey ?? paymentRequestFixtureRecipient)
  const senderPubkey = getPublicKey(senderKey)
  const rumor = {
    kind: 14,
    created_at: 1_900_000_000,
    pubkey: senderPubkey,
    tags: [['p', recipientPubkey]],
    content:
      input.content ??
      JSON.stringify({
        id: 'request-unit',
        mint: 'https://mint.example',
        unit: 'msat',
        proofs: [
          {
            id: `01${'00'.repeat(7)}`,
            amount: 1,
            secret: 'public-unit-test-proof',
            C: `02${'11'.repeat(32)}`,
          },
        ],
      }),
  }
  const patchedRumor = { ...rumor, id: getEventHash(rumor), ...input.rumorPatch }
  const seal = finalizeEvent(
    {
      kind: 13,
      created_at: 1_900_000_000,
      tags: [],
      content: nip44.encrypt(
        input.rumorPlaintext ?? JSON.stringify(patchedRumor),
        nip44.utils.getConversationKey(senderKey, recipientPubkey),
      ),
      ...input.sealPatch,
    },
    senderKey,
  )
  if (input.badSealSignature) seal.sig = '00'.repeat(64)
  const wrap = finalizeEvent(
    {
      kind: 1059,
      created_at: 1_900_000_000,
      tags: [['p', recipientPubkey]],
      content: nip44.encrypt(
        input.sealPlaintext ?? JSON.stringify(seal),
        nip44.utils.getConversationKey(wrapperKey, recipientPubkey),
      ),
      ...input.wrapPatch,
    },
    wrapperKey,
  )
  return { wrap, rumorId: patchedRumor.id, senderPubkey, recipientPubkey, content: rumor.content }
}
