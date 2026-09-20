import { buildTokenHoldings } from "@bitcaster/client-sdk/tradingClient";
import { normalizeMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { getCanonicalSelectableProofs, isCtfProof, type StoredProof } from "@/stores/proof-db";
import {
  activeBrowserWalletScopeId,
  requireActiveBrowserWalletScopeId,
} from "@/lib/browserWalletProfile";
import { normalizeUrl } from "@/lib/url";

export async function buildIndexedDbTokenHoldings(input: {
  mintUrl?: string;
  conditionId: string;
  baseAsset?: string | null;
}) {
  const primitiveProofsByAtom: Record<string, Array<{ amount: number }>> = {};
  const baseUnitProofs: Array<{ amount: number }> = [];
  const baseAsset = normalizeMarketBaseAsset(input.baseAsset);

  const scopeId = requireActiveBrowserWalletScopeId();
  const proofs = await getCanonicalSelectableProofs(scopeId);
  if (activeBrowserWalletScopeId() !== scopeId)
    throw new Error("The wallet profile changed during trade preflight");
  if (proofs === null) throw new Error("Canonical wallet custody is unavailable");
  const normalizedMint = input.mintUrl ? normalizeUrl(input.mintUrl) : undefined;
  for (const proof of proofs) {
    if (normalizedMint && proof.mintUrl !== normalizedMint) continue;
    if (proofBaseAsset(proof) !== baseAsset) continue;
    if (isCtfProof(proof)) {
      if (proofConditionId(proof) !== input.conditionId) continue;
      for (const atom of atomsFromOutcomeSet(proofOutcomeCollection(proof))) {
        (primitiveProofsByAtom[atom] ??= []).push({
          amount: amountToNumber(proof.amount),
        });
      }
    } else {
      baseUnitProofs.push({ amount: amountToNumber(proof.amount) });
    }
  }

  // Complement proof tracking is intentionally empty in this phase. This gate
  // is UX-only; bypasses still hit the engine and final Cashu/mint settlement.
  return buildTokenHoldings(primitiveProofsByAtom, {}, baseUnitProofs);
}

function proofBaseAsset(proof: StoredProof): string {
  return normalizeMarketBaseAsset(proof.baseAsset);
}

function proofConditionId(proof: StoredProof): string | undefined {
  const candidate = proof as StoredProof & { condition_id?: string };
  return candidate.conditionId ?? candidate.condition_id;
}

function proofOutcomeCollection(proof: StoredProof): string {
  const candidate = proof as StoredProof & { outcome_collection?: string };
  return candidate.outcomeCollection ?? candidate.outcome_collection ?? "";
}

function atomsFromOutcomeSet(outcomeSetId: string): string[] {
  return outcomeSetId
    .split("|")
    .map((atom) => atom.trim())
    .filter(Boolean);
}
