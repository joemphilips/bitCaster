import { normalizeMarketBaseAsset, type MarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";
import type { PortfolioCustodyProofMetadata } from "@/stores/portfolio-custody";

/**
 * One held conditional position: the canonical custody proofs of one mint,
 * unit, condition, outcome collection and base asset.
 */
export interface PortfolioCustodyPosition {
  readonly conditionId: string;
  readonly outcomeCollection: string;
  readonly baseAsset: MarketBaseAsset;
  readonly unit: PortfolioCustodyProofMetadata["unit"];
  /** Amount that wallet actions can use. Retained unverified proofs are excluded. */
  readonly amount: number;
  readonly retainedUnverifiedAmountSubunits: number;
  readonly mintUrl: string;
  readonly firstReceivedAt: number;
  readonly allVerifiedLosing: boolean;
  readonly claimRecoveryPending: boolean;
  readonly removalPending: boolean;
}

/** Group conditional custody metadata into held positions, in first-seen order. */
export function summarizePortfolioCustodyPositions(
  proofs: readonly PortfolioCustodyProofMetadata[],
): PortfolioCustodyPosition[] {
  const byOutcome = new Map<string, PortfolioCustodyPosition>();
  for (const proof of proofs) {
    if (proof.assetKind !== "conditional") continue;
    const { conditionId, outcomeCollection } = proof;
    if (!conditionId || !outcomeCollection) continue;
    const baseAsset = normalizeMarketBaseAsset(proof.baseAsset);
    const key = JSON.stringify([
      proof.normalizedMint,
      proof.unit,
      conditionId,
      outcomeCollection,
      baseAsset,
    ]);
    const current = byOutcome.get(key);
    const retained = proof.selectability === "retained-unverified";
    byOutcome.set(key, {
      conditionId,
      outcomeCollection,
      baseAsset,
      amount: (current?.amount ?? 0) + (retained ? 0 : proof.amount),
      retainedUnverifiedAmountSubunits:
        (current?.retainedUnverifiedAmountSubunits ?? 0) + (retained ? proof.amount : 0),
      unit: proof.unit,
      mintUrl: proof.normalizedMint,
      claimRecoveryPending: (current?.claimRecoveryPending ?? false) || proof.claimRecoveryPending,
      removalPending:
        (current?.removalPending ?? false) || proof.selectability === "pending-removal",
      allVerifiedLosing:
        (current?.allVerifiedLosing ?? true) &&
        (retained ||
          proof.selectability === "verified-losing" ||
          proof.selectability === "pending-removal"),
      firstReceivedAt: Math.min(
        current?.firstReceivedAt ?? Number.POSITIVE_INFINITY,
        proof.receivedAtMs,
      ),
    });
  }
  return Array.from(byOutcome.values());
}
