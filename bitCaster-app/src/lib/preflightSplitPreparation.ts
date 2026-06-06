import type { Proof } from "@cashu/cashu-ts";
import { diagnoseProofStates } from "@/lib/proofDiagnostics";
import {
  computeGrossCtfInputAmountSats,
  selectCollateralForCtfSplit,
  splitRegularProofsWithOperation,
  splitRootCompleteSetForPreflightOrder,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from "@/lib/ctfSplit";
import {
  getBaseProofs,
  getProofOperation,
  markProofOperationCompleted,
  prepareProofOperation,
  releaseProofReservation,
  replaceProofs,
  reserveProofs,
  type StoredProof,
} from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";
import type { MarketDetail as MarketDetailType } from "@/types/market-detail";
import { storedConditionalProofsFromMintMetadata } from "@/lib/conditionalKeysetMetadata";
import { resolveGrossCtfInputPlanningKeyset } from "@/lib/ctfGrossInputPlanning";

export interface PreparedPreflightSplit {
  reservationId: string;
  conditionId: string;
  keepOutcomeSetId: string;
  lockOutcomeSetId: string;
  amountSats: number;
}

interface PreparedCollateralLot {
  inputs: Proof[];
  availableSpentSecrets: string[];
  keepProofs: Proof[];
}

export async function preparePreflightSplitForLimitBuy(input: {
  mintUrl: string;
  market: MarketDetailType;
  selectedOutcomeSetId: string;
  complementOutcomeSetId: string;
  amountSats: number;
  reservationId: string;
}): Promise<PreparedPreflightSplit> {
  if (input.amountSats % 100 !== 0) {
    throw new Error("Pre-flight split requires 100 sat order increments.");
  }

  const available: Proof[] = await getBaseProofs(input.mintUrl);
  let resolvedKeepOutcomeSetId = input.selectedOutcomeSetId;
  let resolvedLockOutcomeSetId = input.complementOutcomeSetId;

  try {
    const lotIndex = 0;
    const collateral = await prepareCollateralLotForCtfSplit({
      mintUrl: input.mintUrl,
      available,
      faceAmountSats: input.amountSats,
      reservationId: input.reservationId,
      lotIndex,
    });
    const operationId = `${input.reservationId}:ctf-split:${lotIndex}`;
    await diagnoseProofStates({
      label: "preflight:ctf-split-inputs-before",
      mintUrl: input.mintUrl,
      proofs: collateral.inputs,
      extra: {
        lotIndex,
        conditionId: input.market.id,
        operationId,
      },
    });
    const split = await splitRootCompleteSetForPreflightOrder({
      mintUrl: input.mintUrl,
      conditionId: input.market.id,
      collateralProofs: collateral.inputs,
      amountSats: input.amountSats,
      keepOutcomeSetId: input.selectedOutcomeSetId,
      lockOutcomeSetId: input.complementOutcomeSetId,
      operationId,
      proofOperationStore: ctfProofOperationStore,
    });

    resolvedKeepOutcomeSetId = split.resolvedKeepOutcomeSetId;
    resolvedLockOutcomeSetId = split.resolvedLockOutcomeSetId;
    await replaceProofs(
      split.spentSatProofs.map((proof) => proof.secret),
      await ctfProofsToStore({
        mintUrl: input.mintUrl,
        conditionId: input.market.id,
        reservationId: input.reservationId,
        proofsByCollection: split.proofsByCollection,
      }),
    );
  } catch (err) {
    await releaseProofReservation(input.reservationId);
    throw err;
  }

  return {
    reservationId: input.reservationId,
    conditionId: input.market.id,
    keepOutcomeSetId: resolvedKeepOutcomeSetId,
    lockOutcomeSetId: resolvedLockOutcomeSetId,
    amountSats: input.amountSats,
  };
}

export async function prepareCollateralLotForCtfSplit(input: {
  mintUrl: string;
  available: Proof[];
  faceAmountSats: number;
  reservationId: string;
  lotIndex: number;
}): Promise<PreparedCollateralLot> {
  const operationId = `${input.reservationId}:regular-split:${input.lotIndex}`;
  const existingRegularSplit = await getProofOperation(operationId);
  if (existingRegularSplit) {
    const wallet = await useWalletStore.getState().getWallet(input.mintUrl);
    const grossPlanningKeyset = await resolveGrossCtfInputPlanningKeyset(wallet);
    const grossCtfInputSats = computeGrossCtfInputAmountSats({
      faceAmountSats: input.faceAmountSats,
      keyset: grossPlanningKeyset,
    });
    const regularSplit = await splitRegularProofsWithOperation({
      mintUrl: input.mintUrl,
      operationId,
      wallet,
      proofs: [],
      amountSats: grossCtfInputSats,
      proofOperationStore: ctfProofOperationStore,
    });
    const exact = await selectCollateralForCtfSplit(
      input.mintUrl,
      regularSplit.send,
      input.faceAmountSats,
    );
    const regularSpentSecrets = regularSplit.spent.map((proof) => proof.secret);
    const storedInputStillPresent = input.available.some((proof) =>
      regularSpentSecrets.includes(proof.secret),
    );
    if (storedInputStillPresent) {
      await replaceProofs(regularSpentSecrets, [
        ...regularSplit.keep.map((proof) => ({
          ...proof,
          mintUrl: input.mintUrl,
        })),
        ...exact.inputs.map((proof) => ({
          ...proof,
          mintUrl: input.mintUrl,
          reservedBy: input.reservationId,
        })),
      ]);
    } else {
      await reserveProofs(
        exact.inputs.map((proof) => proof.secret),
        input.reservationId,
      );
    }
    return {
      inputs: exact.inputs,
      availableSpentSecrets: regularSpentSecrets,
      keepProofs: regularSplit.keep,
    };
  }

  try {
    const exact = await selectCollateralForCtfSplit(
      input.mintUrl,
      input.available,
      input.faceAmountSats,
    );
    await diagnoseProofStates({
      label: "preflight:exact-collateral",
      mintUrl: input.mintUrl,
      proofs: exact.inputs,
      extra: {
        lotIndex: input.lotIndex,
        faceAmountSats: input.faceAmountSats,
      },
    });
    await reserveProofs(
      exact.inputs.map((proof) => proof.secret),
      input.reservationId,
    );
    return {
      inputs: exact.inputs,
      availableSpentSecrets: exact.inputs.map((proof) => proof.secret),
      keepProofs: [],
    };
  } catch {
    // No exact net input is available. Split larger/fragmented regular sats
    // into a gross input that will net to the requested CTF face amount.
  }

  const wallet = await useWalletStore.getState().getWallet(input.mintUrl);
  if (!wallet.selectProofsToSend || !wallet.getFeesForProofs) {
    throw new Error(
      "Cashu wallet adapter does not support fee-aware proof selection.",
    );
  }
  const grossPlanningKeyset = await resolveGrossCtfInputPlanningKeyset(wallet);
  const grossCtfInputSats = computeGrossCtfInputAmountSats({
    faceAmountSats: input.faceAmountSats,
    keyset: grossPlanningKeyset,
  });
  const selected = wallet.selectProofsToSend(
    input.available,
    grossCtfInputSats,
    true,
    false,
  );
  if (selected.send.length === 0) {
    throw new Error(
      "No regular collateral proofs are available for CTF split.",
    );
  }
  await diagnoseProofStates({
    label: "preflight:regular-split-inputs",
    mintUrl: input.mintUrl,
    proofs: selected.send,
    wallet,
    extra: {
      lotIndex: input.lotIndex,
      faceAmountSats: input.faceAmountSats,
    },
  });
  const regularSplit = await splitRegularProofsWithOperation({
    mintUrl: input.mintUrl,
    operationId,
    wallet,
    proofs: selected.send,
    amountSats: grossCtfInputSats,
    proofOperationStore: ctfProofOperationStore,
  });
  const exact = await selectCollateralForCtfSplit(
    input.mintUrl,
    regularSplit.send,
    input.faceAmountSats,
  );
  await replaceProofs(
    regularSplit.spent.map((proof) => proof.secret),
    [
      ...regularSplit.keep.map((proof) => ({
        ...proof,
        mintUrl: input.mintUrl,
      })),
      ...exact.inputs.map((proof) => ({
        ...proof,
        mintUrl: input.mintUrl,
        reservedBy: input.reservationId,
      })),
    ],
  );
  return {
    inputs: exact.inputs,
    availableSpentSecrets: regularSplit.spent.map((proof) => proof.secret),
    keepProofs: regularSplit.keep,
  };
}

async function ctfProofsToStore(input: {
  mintUrl: string;
  conditionId: string;
  reservationId: string;
  proofsByCollection: Record<string, Proof[]>;
}): Promise<StoredProof[]> {
  return storedConditionalProofsFromMintMetadata({
    mintUrl: input.mintUrl,
    proofs: Object.values(input.proofsByCollection).flat(),
    expectedConditionId: input.conditionId,
    reservedBy: input.reservationId,
  });
}

const ctfProofOperationStore: CtfProofOperationStore = {
  getProofOperation: async (operationId) =>
    (await getProofOperation(operationId)) as CtfProofOperationRecord | null,
  prepareProofOperation: async (input) =>
    (await prepareProofOperation(input)) as CtfProofOperationRecord,
  markProofOperationCompleted: async (operationId, resultProofs) =>
    (await markProofOperationCompleted(
      operationId,
      resultProofs,
    )) as CtfProofOperationRecord,
};
