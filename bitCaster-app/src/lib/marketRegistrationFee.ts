import {
  Amount,
  CheckStateEnum,
  Mint as CashuMint,
  OutputData,
  Wallet as CashuWallet,
  type MintKeys,
  type OutputDataLike,
  type Proof,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
} from "@cashu/cashu-ts";
import {
  amountToNumber,
  computeInputFeeSatsForProofs,
  sumProofs,
  takeProofsForLock,
} from "@bitcaster/client-sdk/proofSelection";
import type { CtfMintSettings } from "@/lib/mints";
import {
  MintError,
  registerCondition,
  requiredMarketCreationOutcomeCollections,
} from "@/lib/markets";
import { getWallet } from "@/lib/cashu";
import { hexToBytes } from "@/lib/ecdh";
import {
  addProofs,
  getBaseProofs,
  getProofOperation,
  markProofOperationCompleted,
  markProofOperationFailed,
  prepareProofOperation,
  releaseProofReservation,
  removeProofs,
  reserveProofs,
  type ProofOperationRecord,
  type StoredOutputData,
} from "@/stores/proof-db";

export const MAX_CONDITION_REGISTRATION_FEE_SATS = 1_000;

export interface ConditionRegistrationRequest {
  tags: string[][];
  announcementHex: string;
  collateral: string;
  outcomeCollections?: readonly string[];
}

export interface ConditionRegistrationResult {
  condition_id: string;
  keysets: Record<string, string>;
}

type RegistrationOutputData = OutputDataLike & {
  blindedMessage: SerializedBlindedMessage;
  toProof(sig: SerializedBlindedSignature, keyset: MintKeys): Proof;
};

export function registrationFeeForPolicy(
  outcomes: readonly string[],
  settings: CtfMintSettings,
): number {
  const numKeysets =
    settings.defaultKeysetCreation === "none"
      ? requiredMarketCreationOutcomeCollections(outcomes).length
      : settings.defaultKeysetCreation === "one-vs-rest"
        ? new Set(outcomes.map((outcome) => outcome.trim()).filter(Boolean))
            .size
        : Math.max(0, 2 ** outcomes.length - 2);
  const fee =
    settings.registrationFeeBase +
    settings.registrationFeePerKeyset * numKeysets;
  if (!Number.isSafeInteger(fee) || fee < 0) {
    throw new Error("Active mint registration fee settings are invalid.");
  }
  return fee;
}

export async function getAvailableRegularBalanceSats(
  mintUrl: string,
): Promise<number> {
  const proofs = await getBaseProofs(mintUrl);
  return spendableProofAmount(
    proofs,
    await inputFeePpkByKeysetForProofs(mintUrl, proofs),
  );
}

export async function registerConditionWithFee(input: {
  mintUrl: string;
  request: ConditionRegistrationRequest;
  requiredFeeSats: number;
}): Promise<ConditionRegistrationResult> {
  if (input.requiredFeeSats <= 0) {
    return registerCondition(input.request);
  }
  if (
    !Number.isSafeInteger(input.requiredFeeSats) ||
    input.requiredFeeSats > MAX_CONDITION_REGISTRATION_FEE_SATS
  ) {
    throw new Error(
      `Condition registration fee must be between 1 and ${MAX_CONDITION_REGISTRATION_FEE_SATS} sats.`,
    );
  }

  const operationId = await buildOperationId(
    input.request,
    input.requiredFeeSats,
  );
  const existing = await getProofOperation(operationId);
  if (existing) {
    return resumeOrRetryRegistration(input.mintUrl, input.request, existing);
  }

  const available = await getBaseProofs(input.mintUrl);
  const inputFeePpkByKeyset = await inputFeePpkByKeysetForProofs(
    input.mintUrl,
    available,
  );
  const selected = takeProofsForLock(
    available,
    input.requiredFeeSats,
    inputFeePpkByKeyset,
  );
  if (!selected) {
    throw new Error(
      `Not enough regular sat proofs are available for the ${input.requiredFeeSats} sat condition registration fee.`,
    );
  }

  const selectedTotal = sumProofs(selected);
  const selectedInputFeeSats = computeInputFeeSatsForProofs(
    selected,
    inputFeePpkByKeyset,
  );
  const selectedSpendableSats = selectedTotal - selectedInputFeeSats;
  const changeAmount = selectedSpendableSats - input.requiredFeeSats;
  const changeOutputs =
    changeAmount > 0
      ? await prepareRegularOutputs(input.mintUrl, changeAmount)
      : [];

  await prepareProofOperation({
    operationId,
    kind: "ctf-condition-registration",
    mintUrl: input.mintUrl,
    inputs: selected,
    outputs: { change: serializeOutputDataArray(changeOutputs) },
    metadata: {
      requiredFeeSats: input.requiredFeeSats,
      selectedTotalSats: selectedTotal,
      selectedInputFeeSats,
      selectedSpendableSats,
      request: stableRegistrationRequest(input.request),
    },
  });
  await reserveProofs(
    selected.map((proof) => proof.secret),
    operationId,
  );

  return postPreparedRegistration(input.mintUrl, input.request, {
    operationId,
    inputs: selected,
    outputs: changeOutputs,
  });
}

async function resumeOrRetryRegistration(
  mintUrl: string,
  request: ConditionRegistrationRequest,
  entry: ProofOperationRecord,
): Promise<ConditionRegistrationResult> {
  if (entry.kind !== "ctf-condition-registration") {
    throw new Error(`proof operation ${entry.operationId} is not condition registration`);
  }

  if (entry.state === "completed") {
    return registerCondition(request);
  }
  if (entry.state === "failed") {
    throw new Error(
      `condition registration fee operation previously failed: ${entry.lastError ?? "unknown error"}`,
    );
  }

  const wallet = await getWallet(mintUrl);
  if (!wallet.checkProofsStates) {
    throw new Error(
      "Cashu wallet adapter does not support condition registration recovery checks.",
    );
  }
  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  );
  if (
    states.length > 0 &&
    states.every((state) => state.state === CheckStateEnum.SPENT)
  ) {
    const changeProofs = await restoreChangeOutputs(
      mintUrl,
      entry.outputs.change ?? [],
    );
    await completeRegistrationFeeOperation(
      entry.operationId,
      mintUrl,
      entry.inputs,
      changeProofs,
    );
    return registerCondition(request);
  }
  if (
    states.length > 0 &&
    states.every((state) => state.state === CheckStateEnum.UNSPENT)
  ) {
    const outputs = deserializeOutputDataArray(entry.outputs.change ?? []);
    await reserveProofs(
      entry.inputs.map((proof) => proof.secret),
      entry.operationId,
    );
    return postPreparedRegistration(mintUrl, request, {
      operationId: entry.operationId,
      inputs: entry.inputs,
      outputs,
    });
  }

  throw new Error(
    "Condition registration fee payment is still pending at the mint. Refresh wallet recovery before paying again.",
  );
}

async function postPreparedRegistration(
  mintUrl: string,
  request: ConditionRegistrationRequest,
  prepared: {
    operationId: string;
    inputs: Proof[];
    outputs: RegistrationOutputData[];
  },
): Promise<ConditionRegistrationResult> {
  try {
    const response = await registerCondition({
      ...request,
      fee: prepared.inputs,
      outputs:
        prepared.outputs.length > 0
          ? prepared.outputs.map((output) => output.blindedMessage)
          : undefined,
    });
    const changeProofs = await buildChangeProofs(
      mintUrl,
      prepared.outputs,
      response.change ?? [],
    );
    await completeRegistrationFeeOperation(
      prepared.operationId,
      mintUrl,
      prepared.inputs,
      changeProofs,
    );
    return response;
  } catch (error) {
    if (
      error instanceof MintError &&
      (error.code === 13044 || error.code === 13047)
    ) {
      await releaseProofReservation(prepared.operationId);
      await markProofOperationFailed(prepared.operationId, error);
    }
    throw mapRegistrationFeeMintError(error);
  }
}

function mapRegistrationFeeMintError(error: unknown): unknown {
  if (error instanceof MintError && error.code === 13044) {
    return new Error("Registration fee was missing or insufficient.");
  }
  if (error instanceof MintError && error.code === 13047) {
    return new Error("Registration fee change outputs were invalid or insufficient.");
  }
  return error;
}

async function completeRegistrationFeeOperation(
  operationId: string,
  mintUrl: string,
  inputs: Proof[],
  changeProofs: Proof[],
): Promise<void> {
  if (changeProofs.length > 0) {
    await addProofs(changeProofs.map((proof) => ({ ...proof, mintUrl })));
  }
  await removeProofs(inputs.map((proof) => proof.secret));
  await markProofOperationCompleted(operationId, { change: changeProofs });
}

async function prepareRegularOutputs(
  mintUrl: string,
  amountSats: number,
): Promise<RegistrationOutputData[]> {
  const wallet = await getWallet(mintUrl);
  const keyset = await getActiveRegularKeyset(wallet);
  return OutputData.createRandomData(
    Amount.from(amountSats),
    keyset,
  ) as RegistrationOutputData[];
}

async function getActiveRegularKeyset(wallet: CashuWallet): Promise<MintKeys> {
  const response = await wallet.mint.getKeys();
  const keyset =
    response.keysets.find(
      (candidate) => candidate.unit === "sat" && candidate.active !== false,
    ) ??
    response.keysets.find((candidate) => candidate.unit === "sat") ??
    response.keysets[0];
  if (!keyset) throw new Error("Mint did not return a regular keyset");
  return keyset;
}

async function inputFeePpkByKeysetForProofs(
  mintUrl: string,
  proofs: Array<Pick<Proof, "id">>,
): Promise<Record<string, number>> {
  const keysetIds = [...new Set(proofs.map((proof) => proof.id).filter(Boolean))] as string[];
  if (keysetIds.length === 0) return {};
  const mint = new CashuMint(mintUrl);
  const result: Record<string, number> = {};
  for (const keysetId of keysetIds) {
    const response = await mint.getKeys(keysetId);
    const keyset = response.keysets.find((candidate) => candidate.id === keysetId);
    if (!keyset) throw new Error(`Mint did not return keys for keyset ${keysetId}`);
    result[keysetId] = keyset.input_fee_ppk ?? 0;
  }
  return result;
}

function spendableProofAmount(
  proofs: readonly Proof[],
  inputFeePpkByKeyset: Record<string, number>,
): number {
  if (proofs.length === 0) return 0;
  return sumProofs(proofs) - computeInputFeeSatsForProofs(proofs, inputFeePpkByKeyset);
}

async function buildChangeProofs(
  mintUrl: string,
  outputData: RegistrationOutputData[],
  signatures: SerializedBlindedSignature[],
): Promise<Proof[]> {
  if (signatures.length !== outputData.length) {
    throw new Error(
      `Mint returned ${signatures.length} registration-fee change signatures, expected ${outputData.length}`,
    );
  }
  const result: Proof[] = [];
  for (let index = 0; index < outputData.length; index++) {
    const output = outputData[index];
    const signature = signatures[index];
    validateChangeSignature(output.blindedMessage, signature);
    const keyset = await getKeyset(mintUrl, output.blindedMessage.id);
    result.push(output.toProof(signature, keyset));
  }
  return result;
}

function validateChangeSignature(
  output: SerializedBlindedMessage,
  signature: SerializedBlindedSignature,
): void {
  if (
    signature.id !== output.id ||
    amountToNumber(signature.amount) !== amountToNumber(output.amount)
  ) {
    throw new Error("Mint returned a registration-fee change signature for the wrong output");
  }
}

async function restoreChangeOutputs(
  mintUrl: string,
  storedOutputs: StoredOutputData[],
): Promise<Proof[]> {
  const outputData = deserializeOutputDataArray(storedOutputs);
  if (outputData.length === 0) return [];
  const mint = new CashuMint(mintUrl);
  const response = await mint.restore({
    outputs: outputData.map((output) => output.blindedMessage),
  });
  return buildChangeProofs(mintUrl, outputData, response.signatures);
}

async function getKeyset(
  mintUrl: string,
  keysetId?: string,
): Promise<MintKeys> {
  if (!keysetId) throw new Error("Missing keyset id for registration-fee change output");
  const mint = new CashuMint(mintUrl);
  const response = await mint.getKeys(keysetId);
  const keyset = response.keysets.find(
    (candidate) => candidate.id === keysetId,
  );
  if (!keyset) throw new Error(`Mint did not return keys for keyset ${keysetId}`);
  return keyset;
}

function serializeOutputDataArray(
  outputs: RegistrationOutputData[],
): StoredOutputData[] {
  return outputs.map((output) => ({
    blindedMessage: {
      amount: amountToNumber(output.blindedMessage.amount),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor.toString(16),
    secret: bytesToHex(output.secret),
  }));
}

function deserializeOutputDataArray(
  outputs: StoredOutputData[],
): RegistrationOutputData[] {
  return outputs.map(
    (output) =>
      new OutputData(
        {
          ...output.blindedMessage,
          amount: Amount.from(output.blindedMessage.amount),
        },
        BigInt(`0x${output.blindingFactor}`),
        hexToBytes(output.secret),
      ) as RegistrationOutputData,
  );
}

async function buildOperationId(
  request: ConditionRegistrationRequest,
  requiredFeeSats: number,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ request: stableRegistrationRequest(request), requiredFeeSats }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `ctf-condition-registration:${bytesToHex(new Uint8Array(digest))}`;
}

function stableRegistrationRequest(
  request: ConditionRegistrationRequest,
): ConditionRegistrationRequest {
  return {
    tags: request.tags.map((tag) => [...tag]),
    announcementHex: request.announcementHex,
    collateral: request.collateral,
    outcomeCollections: request.outcomeCollections
      ? [...request.outcomeCollections]
      : undefined,
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
