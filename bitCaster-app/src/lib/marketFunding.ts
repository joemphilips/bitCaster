export interface MarketFundingObservation {
  readonly ammBotBudgetSubunits: number;
  readonly fundingRevision: string | null;
}

type CurrentMarketFundingObservation = {
  readonly ammBotBudgetSubunits: number;
  readonly fundingRevision?: string | null;
};

function compareRevision(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Merge the total and its source revision as one observation. A null revision
 * is the unversioned pre-receipt baseline, so it cannot replace a committed
 * funding receipt already observed by this client.
 */
export function mergeMarketFundingObservation(
  current: CurrentMarketFundingObservation,
  incoming: MarketFundingObservation,
): MarketFundingObservation {
  const currentRevision = current.fundingRevision ?? null;
  const incomingRevision = incoming.fundingRevision;
  const nextObservation = {
    ammBotBudgetSubunits: incoming.ammBotBudgetSubunits,
    fundingRevision: incomingRevision,
  };

  if (currentRevision === null) return nextObservation;
  if (incomingRevision === null) {
    return { ammBotBudgetSubunits: current.ammBotBudgetSubunits, fundingRevision: currentRevision };
  }

  const revisionOrder = compareRevision(incomingRevision, currentRevision);
  if (revisionOrder > 0) return nextObservation;
  return { ammBotBudgetSubunits: current.ammBotBudgetSubunits, fundingRevision: currentRevision };
}
