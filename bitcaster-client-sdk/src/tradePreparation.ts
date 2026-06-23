import type { Proof } from "@cashu/cashu-ts";
import {
  selectCompleteSetMergeInputs,
  type CompleteSetMergeInputSelection,
} from "./ctfSplit.ts";
import { takeProofsForLock } from "./proofSelection.ts";

export type PreparedSellerSwapInputs =
  | {
      status: "prepared";
      source: "existing-outcome";
      outcomeProofs: Proof[];
      lockOutcomeSetId: string;
      spentRegularProofs: Proof[];
      regularChangeProofs: Proof[];
      producedOutcomeProofsByCollection: Record<string, Proof[]>;
    }
  | {
      status: "prepared";
      source: "regular-ctf-split";
      outcomeProofs: Proof[];
      lockOutcomeSetId: string;
      spentRegularProofs: Proof[];
      regularChangeProofs: Proof[];
      producedOutcomeProofsByCollection: Record<string, Proof[]>;
    }
  | {
      status: "unavailable";
      reason: "missing-outcome-proofs" | "missing-split-adapter";
    };

export type PreparedBuyerSwapInputs =
  | {
      status: "prepared";
      source: "existing-regular";
      regularProofs: Proof[];
      spentOutcomeProofsByCollection: Record<string, Proof[]>;
      producedRegularProofs: Proof[];
      mergeSelection: null;
    }
  | {
      status: "prepared";
      source: "complete-set-ctf-merge";
      regularProofs: Proof[];
      spentOutcomeProofsByCollection: Record<string, Proof[]>;
      producedRegularProofs: Proof[];
      mergeSelection: CompleteSetMergeInputSelection;
    }
  | {
      status: "unavailable";
      reason:
        | "missing-regular-proofs"
        | "missing-complete-set-proofs"
        | "missing-merge-adapter"
        | "merged-regular-proofs-insufficient";
    };

export type PreparedSellerSwapInputsForTrade = PreparedSellerSwapInputs & {
  role: "seller";
};

export type PreparedBuyerSwapInputsForTrade = PreparedBuyerSwapInputs & {
  role: "buyer";
};

export type PreparedSwapInputsForTrade =
  | PreparedSellerSwapInputsForTrade
  | PreparedBuyerSwapInputsForTrade;

export type PrepareSellerSwapInputsForTradeParams = {
  role: "seller";
} & PrepareSellerSwapInputsParams;

export type PrepareBuyerSwapInputsForTradeParams = {
  role: "buyer";
} & PrepareBuyerSwapInputsParams;

export type PrepareSwapInputsForTradeParams =
  | PrepareSellerSwapInputsForTradeParams
  | PrepareBuyerSwapInputsForTradeParams;

export interface PrepareSellerSwapInputsParams {
  lockOutcomeSetId: string;
  amountSubunits?: number;
  amountSats?: number;
  outcomeProofsByCollection: Record<string, Proof[]>;
  regularProofs: Proof[];
  regularInputFeePpkByKeyset?: Record<string, number>;
  splitRegularToOutcome?: (input: {
    amountSubunits: number;
    lockOutcomeSetId: string;
    regularProofs: Proof[];
  }) => Promise<{
    proofsByCollection: Record<string, Proof[]>;
    spentRegularProofs: Proof[];
    regularChangeProofs: Proof[];
  }>;
}

export interface PrepareBuyerSwapInputsParams {
  quotePaymentSubunits?: number;
  quotePaymentSats?: number;
  regularProofs: Proof[];
  completeSetProofsByCollection: Record<string, Proof[]>;
  conditionalInputFeePpkByKeyset:
    | Record<string, number>
    | (() => Promise<Record<string, number>>);
  regularInputFeePpkByKeyset?:
    | Record<string, number>
    | ((proofs: Proof[]) => Promise<Record<string, number>>);
  buyerLockFeeReserveSats?: number;
  maxMergeScanExtraSats?: number;
  mergeCompleteSetToRegular?: (input: {
    selection: CompleteSetMergeInputSelection;
    outputAmountSubunits: number;
  }) => Promise<{
    regularProofs: Proof[];
    spentOutcomeProofsByCollection: Record<string, Proof[]>;
  }>;
}

export async function prepareSellerSwapInputs(
  params: PrepareSellerSwapInputsParams,
): Promise<PreparedSellerSwapInputs> {
  const amountSubunits = params.amountSubunits ?? params.amountSats;
  assertPositiveSafeInteger(amountSubunits, "amountSubunits");

  const existingOutcome = takeProofsForLock(
    params.outcomeProofsByCollection[params.lockOutcomeSetId] ?? [],
    amountSubunits,
  );
  if (existingOutcome) {
    return {
      status: "prepared",
      source: "existing-outcome",
      outcomeProofs: existingOutcome,
      lockOutcomeSetId: params.lockOutcomeSetId,
      spentRegularProofs: [],
      regularChangeProofs: [],
      producedOutcomeProofsByCollection: {},
    };
  }

  if (!params.splitRegularToOutcome) {
    return { status: "unavailable", reason: "missing-split-adapter" };
  }

  const split = await params.splitRegularToOutcome({
    amountSubunits,
    lockOutcomeSetId: params.lockOutcomeSetId,
    regularProofs: params.regularProofs,
  });
  const splitOutcome = takeProofsForLock(
    split.proofsByCollection[params.lockOutcomeSetId] ?? [],
    amountSubunits,
  );
  if (!splitOutcome) {
    return { status: "unavailable", reason: "missing-outcome-proofs" };
  }

  return {
    status: "prepared",
    source: "regular-ctf-split",
    outcomeProofs: splitOutcome,
    lockOutcomeSetId: params.lockOutcomeSetId,
    spentRegularProofs: split.spentRegularProofs,
    regularChangeProofs: split.regularChangeProofs,
    producedOutcomeProofsByCollection: split.proofsByCollection,
  };
}

/**
 * Public trade-intent planner for clients that need to execute an atomic swap.
 *
 * The low-level buyer/seller helpers stay exported for tests and specialized
 * callers, but client applications should prefer this wrapper so GUI, daemon,
 * CLI, and wallet-service share the same fallback order:
 * use already-held tokens first, then run the required pre-trade CTF
 * conversion through caller-provided adapters, then fail closed.
 */
export function prepareSwapInputsForTrade(
  params: PrepareSellerSwapInputsForTradeParams,
): Promise<PreparedSellerSwapInputsForTrade>;
export function prepareSwapInputsForTrade(
  params: PrepareBuyerSwapInputsForTradeParams,
): Promise<PreparedBuyerSwapInputsForTrade>;
export async function prepareSwapInputsForTrade(
  params: PrepareSwapInputsForTradeParams,
): Promise<PreparedSwapInputsForTrade> {
  if (params.role === "seller") {
    const result = await prepareSellerSwapInputs(params);
    return { ...result, role: "seller" };
  }

  const result = await prepareBuyerSwapInputs(params);
  return { ...result, role: "buyer" };
}

export async function prepareBuyerSwapInputs(
  params: PrepareBuyerSwapInputsParams,
): Promise<PreparedBuyerSwapInputs> {
  const quotePaymentSubunits = params.quotePaymentSubunits ?? params.quotePaymentSats;
  assertPositiveSafeInteger(quotePaymentSubunits, "quotePaymentSubunits");
  const regularInputFeePpkForAvailable = await resolveInputFeePpkByKeyset(
    params.regularInputFeePpkByKeyset,
    params.regularProofs,
  );

  const existingRegular = takeProofsForLock(
    params.regularProofs,
    quotePaymentSubunits,
    regularInputFeePpkForAvailable,
  );
  if (existingRegular) {
    return {
      status: "prepared",
      source: "existing-regular",
      regularProofs: existingRegular,
      spentOutcomeProofsByCollection: {},
      producedRegularProofs: [],
      mergeSelection: null,
    };
  }

  if (!params.mergeCompleteSetToRegular) {
    return { status: "unavailable", reason: "missing-merge-adapter" };
  }

  const desiredRegularOutputSats =
    quotePaymentSubunits + (params.buyerLockFeeReserveSats ?? 0);
  const conditionalInputFeePpkByKeyset =
    typeof params.conditionalInputFeePpkByKeyset === "function"
      ? await params.conditionalInputFeePpkByKeyset()
      : params.conditionalInputFeePpkByKeyset;
  const selection = selectCompleteSetMergeInputs({
    conditionalProofsByCollection: params.completeSetProofsByCollection,
    desiredOutputSats: desiredRegularOutputSats,
    inputFeePpkByKeyset: conditionalInputFeePpkByKeyset,
    maxScanExtraSats: params.maxMergeScanExtraSats,
  });
  if (!selection) {
    return { status: "unavailable", reason: "missing-complete-set-proofs" };
  }

  const merged = await params.mergeCompleteSetToRegular({
    selection,
    outputAmountSubunits: selection.outputAmountSubunits,
  });
  const regularInputFeePpkForMerged = await resolveInputFeePpkByKeyset(
    params.regularInputFeePpkByKeyset,
    merged.regularProofs,
  );
  const selectedRegular = takeProofsForLock(
    merged.regularProofs,
    quotePaymentSubunits,
    regularInputFeePpkForMerged,
  );
  if (!selectedRegular) {
    return {
      status: "unavailable",
      reason: "merged-regular-proofs-insufficient",
    };
  }

  return {
    status: "prepared",
    source: "complete-set-ctf-merge",
    regularProofs: selectedRegular,
    spentOutcomeProofsByCollection: merged.spentOutcomeProofsByCollection,
    producedRegularProofs: merged.regularProofs,
    mergeSelection: selection,
  };
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

async function resolveInputFeePpkByKeyset(
  source:
    | Record<string, number>
    | ((proofs: Proof[]) => Promise<Record<string, number>>)
    | undefined,
  proofs: Proof[],
): Promise<Record<string, number> | undefined> {
  if (!source) return undefined;
  return typeof source === "function" ? await source(proofs) : source;
}
