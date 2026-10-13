import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'

/** Deterministic public test registration. The fixed private scalar is fixture-only. */
export function signedCtfRegistrationFixture(
  outcomes: readonly string[],
  eventId: string,
  noncePoint?: string,
) {
  const text = new TextEncoder()
  const bs = (n: number) => (n < 253 ? Uint8Array.of(n) : Uint8Array.of(253, n >>> 8, n & 255))
  const str = (s: string) => concatBytes(bs(text.encode(s).length), text.encode(s))
  const tlv = (type: number, body: Uint8Array) => concatBytes(bs(type), bs(body.length), body)
  const tagged = (tag: string, bytes: Uint8Array) => {
    const hash = sha256(text.encode(tag))
    return sha256(concatBytes(hash, hash, bytes))
  }
  const key = new Uint8Array(32)
  key[31] = 7
  const pubkey = schnorr.getPublicKey(key)
  const event = tlv(
    55330,
    concatBytes(
      Uint8Array.of(0, 1),
      noncePoint ? hexToBytes(noncePoint) : pubkey,
      Uint8Array.of(0, 0, 0, 1),
      tlv(55302, concatBytes(Uint8Array.of(0, outcomes.length), ...outcomes.map(str))),
      str(eventId),
    ),
  )
  const announcement = bytesToHex(
    tlv(
      55332,
      concatBytes(
        schnorr.sign(tagged('DLC/oracle/announcement/v0', event), key, new Uint8Array(32)),
        pubkey,
        event,
      ),
    ),
  )
  return {
    condition_id: bytesToHex(
      tagged(
        'Cashu_condition_id',
        concatBytes(pubkey, text.encode(eventId), Uint8Array.of(outcomes.length)),
      ),
    ),
    threshold: 1,
    collateral: 'msat',
    announcements: [announcement],
  }
}
