import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { deriveDlcConditionId } from "@bitcaster/client-sdk/managedConditionInventory";
import { requireVerifiedConditionOracleEvidence } from "@bitcaster/client-sdk/conditionOracleEvidence";

const TEST_ORACLE_KEY = Uint8Array.from([...new Uint8Array(31), 3]);
const ORACLE_PUBLIC_KEY = bytesToHex(schnorr.getPublicKey(TEST_ORACLE_KEY));
const EVENT_ID = "browser-claim-d4-fixture";
export const BROWSER_D4_CONDITION = deriveDlcConditionId({
  eventId: EVENT_ID,
  outcomeCount: 2,
  oraclePublicKeys: [ORACLE_PUBLIC_KEY],
});

/** Synthetic signing fixture. The separate adapter test uses captured producer bytes. */
export function browserD4OracleEvidence(
  scopeId: string,
  mintUrl: string,
  outcome = "Beta",
  outcomes: readonly string[] = ["Alpha", "Beta"],
) {
  const tag = sha256(new TextEncoder().encode("DLC/oracle/attestation/v0"));
  const message = sha256(concatBytes(tag, tag, new TextEncoder().encode(outcome)));
  const signature = bytesToHex(schnorr.sign(message, TEST_ORACLE_KEY, new Uint8Array(32)));
  return requireVerifiedConditionOracleEvidence({
    registered: {
      schemaVersion: 1,
      scopeId,
      normalizedMint: mintUrl,
      unit: "msat",
      conditionId: BROWSER_D4_CONDITION,
      canonicalParentCollectionId: null,
      eventId: EVENT_ID,
      outcomes,
      threshold: 1,
      oracles: [
        {
          oraclePublicKey: ORACLE_PUBLIC_KEY,
          noncePoint: signature.slice(0, 64),
          announcementIdentity: "44".repeat(32),
        },
      ],
    },
    evidence: {
      schemaVersion: 1,
      source: "dlc-oracle-attestation",
      resolvedOutcome: outcome,
      attestations: [{ oraclePublicKey: ORACLE_PUBLIC_KEY, signature }],
    },
  });
}
