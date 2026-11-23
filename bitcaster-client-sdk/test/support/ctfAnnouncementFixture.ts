import { schnorr } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils.js'
import { finalizeEvent } from 'nostr-tools/pure'

const text = new TextEncoder()
const bs = (n: number) => (n < 253 ? Uint8Array.of(n) : Uint8Array.of(253, n >>> 8, n & 255))
const str = (s: string) => concatBytes(bs(text.encode(s).length), text.encode(s))
const tlv = (type: number, body: Uint8Array) => concatBytes(bs(type), bs(body.length), body)
const tagged = (tag: string, bytes: Uint8Array) => {
  const hash = sha256(text.encode(tag))
  return sha256(concatBytes(hash, hash, bytes))
}

/** The fixture oracle scalar. It is public test data, not a credential. */
export function fixtureOracleKey(scalar = 7): Uint8Array {
  const key = new Uint8Array(32)
  key[31] = scalar
  return key
}

/** Deterministic public test registration. The fixed private scalar is fixture-only. */
export function signedCtfRegistrationFixture(
  outcomes: readonly string[],
  eventId: string,
  noncePoint?: string,
  options: { readonly privateKey?: Uint8Array; readonly maturityEpoch?: number } = {},
) {
  const key = options.privateKey ?? fixtureOracleKey()
  const pubkey = schnorr.getPublicKey(key)
  const maturity = options.maturityEpoch ?? 1
  const event = tlv(
    55330,
    concatBytes(
      Uint8Array.of(0, 1),
      noncePoint ? hexToBytes(noncePoint) : pubkey,
      Uint8Array.of(
        maturity >>> 24,
        (maturity >>> 16) & 255,
        (maturity >>> 8) & 255,
        maturity & 255,
      ),
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

/** Sign one enum outcome with the DLC attestation tag and a deterministic nonce. */
export function signFixtureOutcome(outcome: string, privateKey = fixtureOracleKey()): string {
  return bytesToHex(
    schnorr.sign(
      tagged('DLC/oracle/attestation/v0', text.encode(outcome)),
      privateKey,
      new Uint8Array(32),
    ),
  )
}

/**
 * One registered condition whose announced nonce is the nonce of the
 * deterministic signature of `winner`. Thus the fixture oracle can attest `winner`.
 */
export function attestableCtfConditionFixture(input: {
  readonly outcomes: readonly string[]
  readonly eventId: string
  readonly winner: string
  readonly maturityEpoch?: number
  readonly privateKey?: Uint8Array
}) {
  const privateKey = input.privateKey ?? fixtureOracleKey()
  const signature = signFixtureOutcome(input.winner, privateKey)
  const registration = signedCtfRegistrationFixture(
    input.outcomes,
    input.eventId,
    signature.slice(0, 64),
    { privateKey, maturityEpoch: input.maturityEpoch },
  )
  const oraclePublicKey = bytesToHex(schnorr.getPublicKey(privateKey))
  return { registration, signature, oraclePublicKey, privateKey }
}

/** A kind-89 event whose content is the base64 DLC `oracle_attestation` body. */
export function signedCtfAttestationEventFixture(input: {
  readonly eventId: string
  readonly outcome: string
  readonly signature: string
  readonly attestationKey?: Uint8Array
  readonly nostrKey?: Uint8Array
  readonly createdAt?: number
}) {
  const attestationKey = input.attestationKey ?? fixtureOracleKey()
  const body = concatBytes(
    str(input.eventId),
    schnorr.getPublicKey(attestationKey),
    Uint8Array.of(0, 1),
    hexToBytes(input.signature),
    Uint8Array.of(0, 1),
    str(input.outcome),
  )
  return finalizeEvent(
    {
      kind: 89,
      created_at: input.createdAt ?? 1_900_000_100,
      tags: [['e', '44'.repeat(32)]],
      content: btoa(String.fromCharCode(...body)),
    },
    input.nostrKey ?? attestationKey,
  )
}
