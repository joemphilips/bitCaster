import { oraclePublicationDeliveryPending } from "@bitcaster/client-sdk/oraclePublication";
import { creatorOraclePublication, type BrowserOracleOwner } from "@/stores/creatorMarkets";
import { assertNever } from "./enumDiscipline";

export interface BrowserOraclePublicationRetry {
  readonly conditionId: string;
  readonly outcome: string;
}

/**
 * A former host of this site serves no API. Its engine is the engine of this host, so a record
 * that names it reads through this host. VITE_FORMER_ENGINE_ORIGINS is a comma-separated list.
 */
function currentEngineUrl(saved: string): string {
  const former = (import.meta.env.VITE_FORMER_ENGINE_ORIGINS ?? "")
    .split(",")
    .map((origin: string) => origin.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return former.includes(saved.replace(/\/+$/, "")) ? window.location.origin : saved;
}

/**
 * The engine that registered the market. A public creator-market mirror has none. The current
 * origin cannot replace it, because the mirror can come from another deployment.
 */
export function browserOracleSavedEngineUrl(owner: BrowserOracleOwner): string | null {
  let saved: string | null;
  switch (owner.kind) {
    case "imported":
      saved = owner.oracle.destinations.engineUrl;
      break;
    case "created":
      saved =
        owner.market.oracle?.destinations?.engineUrl ?? owner.market.oracle?.engineBaseUrl ?? null;
      break;
    default:
      return assertNever(owner);
  }
  return saved === null ? null : currentEngineUrl(saved);
}

/**
 * Select saved resolution work for an automatic retry. The outcome is always the saved one.
 * A saved choice without a signature comes from an interrupted signing. Only the oracle's own
 * local key can sign it, so it waits until that key is selected. A row without its saved engine
 * cannot succeed, so it is not retried.
 */
export function browserOraclePublicationRetry(
  owner: BrowserOracleOwner,
  signerPublicKey: string | null,
): BrowserOraclePublicationRetry | null {
  if (browserOracleSavedEngineUrl(owner) === null) return null;
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
