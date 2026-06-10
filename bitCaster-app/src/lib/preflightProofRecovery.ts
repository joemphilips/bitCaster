import type { Proof } from "@cashu/cashu-ts";
import {
  CashuMintCtfSplitTransport,
  splitCompleteSetWithOperation,
  splitRegularProofsWithOperation,
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from "@/lib/ctfSplit";
import {
  getProofOperation,
  getProofOperations,
  getProofs,
  markProofOperationCompleted,
  prepareProofOperation,
  replaceProofs,
  type ProofOperationRecord,
  type StoredProof,
} from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";
import { storedConditionalProofsFromMintMetadata } from "@/lib/conditionalKeysetMetadata";
import { normalizeMarketBaseAsset } from "@bitcaster/client-sdk/marketUnits";

export interface PreflightProofRecoveryResult {
  operationsChecked: number;
  operationsReconciled: number;
  invalidCtfOperationsSkipped: number;
  inputsRemoved: number;
  proofsRestored: number;
}

export async function reconcileCompletedPreflightProofOperations(input: {
  mintUrl: string;
  activeReservationIds?: Iterable<string>;
}): Promise<PreflightProofRecoveryResult> {
  const activeReservationIds = new Set(input.activeReservationIds ?? []);
  const operations = await getProofOperations({
    mintUrl: input.mintUrl,
    states: ["prepared", "completed"],
    kinds: ["regular-split", "ctf-split"],
    operationIdPrefix: "order-preflight:",
  });
  const storedSecrets = new Set(
    (await getProofs(input.mintUrl, { includeReserved: true })).map(
      (proof) => proof.secret,
    ),
  );
  const result: PreflightProofRecoveryResult = {
    operationsChecked: operations.length,
    operationsReconciled: 0,
    invalidCtfOperationsSkipped: 0,
    inputsRemoved: 0,
    proofsRestored: 0,
  };

  for (const operation of operations) {
    const staleInputs = operation.inputs.filter((proof) =>
      storedSecrets.has(proof.secret),
    );
    if (staleInputs.length === 0) continue;
    if (operation.kind === "ctf-split" && !ctfConditionId(operation)) {
      result.invalidCtfOperationsSkipped += 1;
      continue;
    }

    const completedOperation =
      operation.state === "prepared"
        ? await resumePreparedPreflightOperation(operation, input.mintUrl)
        : operation;
    const recovered = await recoveredProofsForOperation(
      completedOperation,
      input.mintUrl,
      activeReservationIds,
    );
    if (recovered.length === 0) continue;

    await replaceProofs(
      staleInputs.map((proof) => proof.secret),
      recovered,
    );
    for (const proof of staleInputs) storedSecrets.delete(proof.secret);
    for (const proof of recovered) storedSecrets.add(proof.secret);
    result.operationsReconciled += 1;
    result.inputsRemoved += staleInputs.length;
    result.proofsRestored += recovered.length;
  }

  if (result.operationsReconciled > 0) {
    console.info("[cashu.preflight-recovery]", result);
  } else if (result.invalidCtfOperationsSkipped > 0) {
    console.info("[cashu.preflight-recovery]", {
      operationsChecked: result.operationsChecked,
      invalidCtfOperationsSkipped: result.invalidCtfOperationsSkipped,
    });
  }

  return result;
}

async function recoveredProofsForOperation(
  operation: ProofOperationRecord,
  mintUrl: string,
  activeReservationIds: Set<string>,
): Promise<StoredProof[]> {
  if (operation.kind === "regular-split") {
    return [
      ...proofGroup(operation.resultProofs?.send),
      ...proofGroup(operation.resultProofs?.keep),
    ].map((proof) => ({ ...proof, mintUrl }));
  }

  if (operation.kind !== "ctf-split") return [];

  const conditionId = ctfConditionId(operation);
  if (!conditionId) return [];

  const reservationId = reservationIdForPreflightOperation(
    operation.operationId,
  );
  const reservedBy =
    reservationId && activeReservationIds.has(reservationId)
      ? reservationId
      : undefined;

  return storedConditionalProofsFromMintMetadata({
    mintUrl,
    proofs: Object.values(operation.resultProofs ?? {}).flatMap(proofGroup),
    expectedConditionId: conditionId,
    reservedBy,
    baseAsset: operationBaseAsset(operation),
  });
}

function ctfConditionId(operation: ProofOperationRecord): string | undefined {
  const conditionId = operation.metadata.conditionId;
  return typeof conditionId === "string" && conditionId.length > 0
    ? conditionId
    : undefined;
}

async function resumePreparedPreflightOperation(
  operation: ProofOperationRecord,
  mintUrl: string,
): Promise<ProofOperationRecord> {
  if (operation.kind === "regular-split") {
    const baseAsset = operationBaseAsset(operation);
    const wallet = await useWalletStore.getState().getWallet(mintUrl, baseAsset);
    const split = await splitRegularProofsWithOperation({
      mintUrl,
      baseAsset,
      operationId: operation.operationId,
      wallet,
      proofs: [],
      amountSats: preparedAmountSats(operation),
      proofOperationStore: ctfProofOperationStore,
    });
    return {
      ...operation,
      state: "completed",
      resultProofs: {
        send: split.send,
        keep: split.keep,
      },
    };
  }

  if (operation.kind === "ctf-split") {
    const metadata = operation.metadata as {
      conditionId?: string;
      amountSats?: number;
      baseAsset?: string | null;
      outcomeCollectionKeysets?: Record<string, string>;
    };
    const resultProofs = await splitCompleteSetWithOperation({
      mintUrl,
      baseAsset: metadata.baseAsset,
      operationId: operation.operationId,
      transport: new CashuMintCtfSplitTransport(mintUrl),
      conditionId: metadata.conditionId ?? "",
      collateralProofs: [],
      outcomeCollectionKeysets: metadata.outcomeCollectionKeysets ?? {},
      amountSats: metadata.amountSats ?? 1,
      proofOperationStore: ctfProofOperationStore,
      makeOutputs: () => [],
    });
    return {
      ...operation,
      state: "completed",
      resultProofs,
    };
  }

  return operation;
}

function operationBaseAsset(operation: ProofOperationRecord): string {
  return normalizeMarketBaseAsset(
    typeof operation.metadata.baseAsset === "string"
      ? operation.metadata.baseAsset
      : undefined,
  );
}

function preparedAmountSats(operation: ProofOperationRecord): number {
  const amount = operation.metadata.amount;
  if (
    typeof amount === "number" &&
    Number.isSafeInteger(amount) &&
    amount > 0
  ) {
    return amount;
  }
  const inputTotal = operation.inputs.reduce(
    (sum, proof) => sum + Number(proof.amount),
    0,
  );
  return Number.isSafeInteger(inputTotal) && inputTotal > 0 ? inputTotal : 1;
}

function proofGroup(proofs: Proof[] | undefined): Proof[] {
  return Array.isArray(proofs) ? proofs : [];
}

function reservationIdForPreflightOperation(
  operationId: string,
): string | undefined {
  const marker = ":ctf-split:";
  const index = operationId.indexOf(marker);
  if (index < 0) return undefined;
  return operationId.slice(0, index);
}

const preflightSingleFlights = new Map<string, Promise<unknown>>();

export async function runPreflightMintSingleFlight<T>(
  mintUrl: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = `preflight:${mintUrl}`;
  const previous = preflightSingleFlights.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(task);
  preflightSingleFlights.set(key, current);
  try {
    return await current;
  } finally {
    if (preflightSingleFlights.get(key) === current) {
      preflightSingleFlights.delete(key);
    }
  }
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
