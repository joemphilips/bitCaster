import { nip19 } from "nostr-tools";
import { finalizeEvent } from "nostr-tools/pure";
import { hexToBytes } from "nostr-tools/utils";
import type { components } from "@/generated/api";

export type OracleNostrEvent = components["schemas"]["OracleNostrEvent"];

const KIND_DLC_ORACLE_ATTESTATION = 89 as const;

/**
 * Wrap a kormir-produced DLC `oracle_attestation` payload in a signed NIP-01
 * kind-89 envelope, ready to POST to the matching engine's
 * `oracle-attestation` endpoint.
 *
 * Why this is NOT a signer
 * ------------------------
 * The cryptographically load-bearing signature — the BIP-340 schnorr signature
 * over `tagged_hash("DLC/oracle/attestation/v0", R‖P‖outcome)` produced against
 * the announcement's *committed* nonce `R` — is created by kormir
 * (`kormir.sign_enum_event`, surfaced as {@link signEnumAttestation}). This
 * module never recomputes that signature. The earlier hand-rolled signer that
 * lived here produced a *fresh-nonce* schnorr signature with a different
 * message (`tagged_hash(tag, outcome)`); the CDK mint enforces the committed-
 * nonce DLC scheme and rejected those attestations at redeem time, leaving
 * markets "closed but unclaimable". That signer has been retired.
 *
 * The only signature this function makes is the *outer* NIP-01 event-id
 * signature (via {@link finalizeEvent}), which authenticates the envelope to
 * relays and the engine. The engine recomputes the event id and schnorr-
 * verifies that outer signature, then base64-decodes `content` and verifies
 * each embedded DLC signature against the announcement's committed nonce.
 *
 * @param nsec - the oracle's secp256k1 private key (`nsec1…` bech32 or 64-hex).
 *   This MUST be the same key kormir signed the attestation with, otherwise the
 *   envelope pubkey and the TLV oracle pubkey disagree and the engine rejects.
 * @param attestationHex - hex-encoded rust-dlc `OracleAttestation` bytes, exactly
 *   as returned by {@link signEnumAttestation} / `kormir.sign_enum_event`.
 * @param announcementEventId - Nostr kind-88 announcement event id tagged by
 *   the kind-89 attestation.
 */
export function buildOracleAttestationEvent(
  nsec: string,
  attestationHex: string,
  announcementEventId: string,
): OracleNostrEvent {
  const privateKey = decodeNsecToBytes(nsec);
  const content = base64FromBytes(decodeAttestationHex(attestationHex));
  const signed = finalizeEvent(
    {
      kind: KIND_DLC_ORACLE_ATTESTATION,
      created_at: Math.floor(Date.now() / 1000),
      tags: [["e", announcementEventId]],
      content,
    },
    privateKey,
  );

  return {
    id: signed.id,
    pubkey: signed.pubkey,
    createdAt: signed.created_at,
    kind: KIND_DLC_ORACLE_ATTESTATION,
    tags: signed.tags,
    content: signed.content,
    sig: signed.sig,
  };
}

function decodeAttestationHex(attestationHex: string): Uint8Array {
  const trimmed = attestationHex.trim();
  if (!/^[0-9a-fA-F]*$/.test(trimmed) || trimmed.length === 0 || trimmed.length % 2 !== 0) {
    throw new Error("Oracle attestation must be a non-empty even-length hex string");
  }
  return hexToBytes(trimmed);
}

function decodeNsecToBytes(nsec: string): Uint8Array {
  const trimmed = nsec.trim();
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") throw new Error("Expected an nsec private key");
    return decoded.data;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  throw new Error("Expected an nsec1... or 64-character hex private key");
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
