import { oraclePublicationDeliveryPending } from "@bitcaster/client-sdk/oraclePublication";
import { creatorOraclePublication, type BrowserOracleOwner } from "@/stores/creatorMarkets";
import { assertNever } from "./enumDiscipline";

export interface BrowserOraclePublicationRetry {
  readonly conditionId: string;
  readonly outcome: string;
}

/**
 * Select saved resolution work for an automatic retry. The outcome is always the saved one.
 * A saved choice without a signature comes from an interrupted signing. Only the oracle's own
 * local key can sign it, so it waits until that key is selected.
 */
export function browserOraclePublicationRetry(
  owner: BrowserOracleOwner,
  signerPublicKey: string | null,
): BrowserOraclePublicationRetry | null {
  switch (owner.kind) {
    case "imported": {
      const publication = owner.oracle.publication;
      if (publication === null || !oraclePublicationDeliveryPending(publication)) return null;
      if (publication.attestation === null && owner.oracle.binding.oraclePubkey !== signerPublicKey)
        return null;
      return { conditionId: owner.oracle.binding.conditionId, outcome: publication.chosenOutcome };
    }
    case "created": {
      const oracle = owner.market.oracle;
      const outcome = oracle?.chosenOutcome ?? oracle?.attestedOutcome;
      if (!oracle || !outcome) return null;
      if (oracle.chosenOutcome) {
        let publication;
        try {
          publication = creatorOraclePublication(owner.market);
        } catch {
          // Incomplete public metadata still needs its exact delivery recovery.
          publication = null;
        }
        if (publication !== null && !oraclePublicationDeliveryPending(publication)) return null;
      }
      if (
        !oracle.attestationHex &&
        (!oracle.oraclePubkey || oracle.oraclePubkey !== signerPublicKey)
      )
        return null;
      return { conditionId: owner.market.conditionId, outcome };
    }
    default:
      return assertNever(owner);
  }
}
