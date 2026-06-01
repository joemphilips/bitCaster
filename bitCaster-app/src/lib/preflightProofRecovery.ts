import type { Proof } from "@cashu/cashu-ts";
import {
  getProofOperations,
  getProofs,
  replaceProofs,
  type ProofOperationRecord,
  type StoredProof,
} from "@/stores/proof-db";

export interface PreflightProofRecoveryResult {
  operationsChecked: number;
  operationsReconciled: number;
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
    states: ["completed"],
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
    inputsRemoved: 0,
    proofsRestored: 0,
  };

  for (const operation of operations) {
    const staleInputs = operation.inputs.filter((proof) =>
      storedSecrets.has(proof.secret),
    );
    if (staleInputs.length === 0) continue;

    const recovered = recoveredProofsForOperation(
      operation,
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
  }

  return result;
}

function recoveredProofsForOperation(
  operation: ProofOperationRecord,
  mintUrl: string,
  activeReservationIds: Set<string>,
): StoredProof[] {
  if (operation.kind === "regular-split") {
    return [
      ...proofGroup(operation.resultProofs?.send),
      ...proofGroup(operation.resultProofs?.keep),
    ].map((proof) => ({ ...proof, mintUrl }));
  }

  if (operation.kind !== "ctf-split") return [];

  const conditionId =
    typeof operation.metadata.conditionId === "string"
      ? operation.metadata.conditionId
      : undefined;
  if (!conditionId) return [];

  const reservationId = reservationIdForPreflightOperation(
    operation.operationId,
  );
  const reservedBy =
    reservationId && activeReservationIds.has(reservationId)
      ? reservationId
      : undefined;

  return Object.entries(operation.resultProofs ?? {}).flatMap(
    ([outcomeCollection, proofs]) =>
      proofGroup(proofs).map((proof) => ({
        ...proof,
        mintUrl,
        conditionId,
        outcomeCollection,
        marketId: `${conditionId}-${outcomeCollection}`,
        reservedBy,
      })),
  );
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
  const existing = preflightSingleFlights.get(key);
  if (existing) await existing.catch(() => undefined);

  const current = task();
  preflightSingleFlights.set(key, current);
  try {
    return await current;
  } finally {
    if (preflightSingleFlights.get(key) === current) {
      preflightSingleFlights.delete(key);
    }
  }
}
