import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  buildAssetMonitoringHoldingsFromProofFacts,
  computeAssetMonitoringOutcomeUniverseDigest,
  type AssetMonitoringProofFact,
  type AssetMonitoringReportedHolding,
} from "@bitcaster/client-sdk/assetMonitoring";
import {
  ASSET_MONITORING_CONDITIONS_MAX,
  AssetMonitoringReporter,
  fetchAssetMonitoringCatalogue,
  type AssetMonitoringCatalogueEntry,
} from "@bitcaster/client-sdk/assetMonitoringReporter";
import {
  COLLATERAL_UNIT_REGISTRY,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import { canonicalizeOutcomeSet } from "@bitcaster/client-sdk/outcomeSets";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { normalizeUrl } from "@/lib/url";
import { isCtfProof, type StoredProof } from "@/stores/proof-db";

const ROOT_CONDITION_ID = "0".repeat(64);

export interface AssetMonitoringSnapshotInput {
  readonly proofs: readonly StoredProof[];
  readonly catalogue: readonly AssetMonitoringCatalogueEntry[];
}

export { AssetMonitoringReporter, fetchAssetMonitoringCatalogue };
export { ASSET_MONITORING_CONDITIONS_MAX };
export type { AssetMonitoringCatalogueEntry };

/**
 * Builds one complete local monitoring snapshot.
 *
 * This function keeps proof bodies in local variables only. It returns only
 * canonical holding data. A missing or conflicting condition catalogue entry
 * aborts the whole snapshot.
 */
export function buildAssetMonitoringHoldings(
  input: AssetMonitoringSnapshotInput,
): AssetMonitoringReportedHolding[] | null {
  const conditions = new Set<string>();
  for (const proof of input.proofs) {
    if (!isCurrentProof(proof)) continue;
    if (isCtfProof(proof)) {
      const conditionId = conditionalMetadata(proof)?.conditionId;
      if (!conditionId) return null;
      conditions.add(conditionId);
      if (conditions.size > ASSET_MONITORING_CONDITIONS_MAX) return null;
    }
  }

  const catalogue = catalogueByCondition(input.catalogue, conditions);
  if (catalogue === null) return null;

  try {
    const facts: AssetMonitoringProofFact[] = [];
    for (const proof of input.proofs) {
      if (!isCurrentProof(proof)) continue;
      const asset = assetForProof(proof, catalogue);
      if (asset === null) return null;
      facts.push({
        proofIdentity: proofIdentity(proof),
        asset,
        keysetId: proof.id,
        amount: amountToNumber(proof.amount),
        state: proof.reservedBy ? "pending" : "available",
      });
    }
    return buildAssetMonitoringHoldingsFromProofFacts(facts);
  } catch {
    return null;
  }
}

function catalogueByCondition(
  entries: readonly AssetMonitoringCatalogueEntry[],
  conditions: ReadonlySet<string>,
): Map<string, AssetMonitoringCatalogueEntry> | null {
  const catalogue = new Map<string, AssetMonitoringCatalogueEntry>();
  for (const entry of entries) {
    if (!conditions.has(entry.conditionId) || catalogue.has(entry.conditionId)) return null;
    catalogue.set(entry.conditionId, entry);
  }
  return catalogue.size === conditions.size ? catalogue : null;
}

function assetForProof(
  proof: StoredProof,
  catalogue: ReadonlyMap<string, AssetMonitoringCatalogueEntry>,
): AssetMonitoringProofFact["asset"] | null {
  const unit = parseCashuProofUnit(proof.unit);
  if (unit === null) return null;
  const canonicalMintUrl = normalizeUrl(proof.mintUrl);
  const displayBaseAsset = COLLATERAL_UNIT_REGISTRY[unit].baseAsset;
  if (normalizeMarketBaseAsset(proof.baseAsset) !== displayBaseAsset) return null;
  if (!isCtfProof(proof)) {
    return { canonicalMintUrl, kind: "collateral", cashuUnit: unit, displayBaseAsset };
  }
  const metadata = conditionalMetadata(proof);
  if (metadata === null) return null;
  const entry = catalogue.get(metadata.conditionId);
  if (!entry || !isCanonicalOutcomeSet(metadata.outcomeCollection, entry.outcomes)) return null;
  return {
    canonicalMintUrl,
    kind: "conditional",
    cashuUnit: unit,
    displayBaseAsset,
    conditionId: metadata.conditionId,
    parentConditionId: ROOT_CONDITION_ID,
    outcomeUniverseDigest: computeAssetMonitoringOutcomeUniverseDigest(entry.outcomes),
    internalOutcomeSetId: metadata.outcomeCollection,
  };
}

function conditionalMetadata(
  proof: StoredProof,
): { conditionId: string; outcomeCollection: string } | null {
  const candidate = proof as StoredProof & {
    condition_id?: unknown;
    outcome_collection?: unknown;
  };
  if (
    (candidate.conditionId !== undefined &&
      candidate.condition_id !== undefined &&
      candidate.conditionId !== candidate.condition_id) ||
    (candidate.outcomeCollection !== undefined &&
      candidate.outcome_collection !== undefined &&
      candidate.outcomeCollection !== candidate.outcome_collection)
  ) {
    return null;
  }
  const conditionId = candidate.conditionId ?? candidate.condition_id;
  const outcomeCollection = candidate.outcomeCollection ?? candidate.outcome_collection;
  return typeof conditionId === "string" && typeof outcomeCollection === "string"
    ? { conditionId, outcomeCollection }
    : null;
}

function isCanonicalOutcomeSet(value: string, universe: readonly string[]): boolean {
  const selected = value.split("|");
  return (
    selected.length >= 1 &&
    selected.length < universe.length &&
    canonicalizeOutcomeSet(selected) === value &&
    selected.every((outcome) => universe.includes(outcome))
  );
}

function isCurrentProof(proof: StoredProof): boolean {
  return (
    proof.terminalOperationId === undefined &&
    (proof as { selectability?: unknown }).selectability !== "spent"
  );
}

function proofIdentity(proof: StoredProof): string {
  return bytesToHex(sha256(utf8ToBytes(`${proof.id}\u0000${proof.C}`)));
}
