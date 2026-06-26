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
  sumProofs,
  takeProofsForLock,
} from "@bitcaster/client-sdk/proofSelection";
import {
  registrationFeeForPolicy,
  requiredMarketCreationOutcomeCollections,
} from "@bitcaster/client-sdk/ctfRegistration";
import {
  deserializeOutputGroups,
  serializeOutputDataArray,
} from "@bitcaster/client-sdk/ctfSplit";
import { defaultCollateralUnit, normalizeMarketBaseAsset, parseCashuProofUnit, type CashuProofUnit } from "@bitcaster/client-sdk/marketUnits";
import {
  MintError,
  registerCondition,
} from "@/lib/markets";
import { getWalletForUnit } from "@/lib/cashu";
import {
  addProofs,
  getUnitProofs,
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

export const MAX_CONDITION_REGISTRATION_FEE_SUBUNITS = 1_000_000;

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

export { registrationFeeForPolicy, requiredMarketCreationOutcomeCollections };

export async function getAvailableRegularBalanceSubunits(
  mintUrl: string,
  baseAsset?: string | null,
): Promise<number> {
  const proofs = await getUnitProofs(mintUrl, { unit: defaultCollateralUnit(baseAsset) });
  return sumProofs(proofs);
}

export async function registerConditionWithFee(input: {
  mintUrl: string;
  request: ConditionRegistrationRequest;
  requiredFeeSubunits: number;
}): Promise<ConditionRegistrationResult> {
  if (input.requiredFeeSubunits <= 0) {
    return registerCondition(input.request);
  }
  if (
    !Number.isSafeInteger(input.requiredFeeSubunits) ||
    input.requiredFeeSubunits > MAX_CONDITION_REGISTRATION_FEE_SUBUNITS
  ) {
    throw new Error(
      `Condition registration fee must be between 1 and ${MAX_CONDITION_REGISTRATION_FEE_SUBUNITS} subunits.`,
    );
  }

  const operationId = await buildOperationId(
    input.request,
    input.requiredFeeSubunits,
  );
  const feeUnit = registrationFeeUnit(input.request);
  const existing = await getProofOperation(operationId);
  if (existing) {
    return resumeOrRetryRegistration(input.mintUrl, input.request, existing);
  }

  const wallet = await getWalletForUnit(input.mintUrl, feeUnit);
  const regularKeysetIds = await getRegularKeysetIdsForUnit(wallet, feeUnit);
  const available = await getUnitProofs(input.mintUrl, {
    unit: feeUnit,
  }).then((proofs) => proofs.filter((proof) => regularKeysetIds.has(proof.id)));
  const selected = takeProofsForLock(
    available,
    input.requiredFeeSubunits,
  );
  if (!selected) {
    throw new Error(
      `Not enough regular ${feeUnit} proofs are available for the ${input.requiredFeeSubunits} ${feeUnit} condition registration fee.`,
    );
  }

  const selectedTotal = sumProofs(selected);
  const changeAmount = selectedTotal - input.requiredFeeSubunits;
  const changeOutputs =
    changeAmount > 0
      ? await prepareRegularOutputs(input.mintUrl, changeAmount, feeUnit)
      : [];

  await prepareProofOperation({
    operationId,
    kind: "ctf-condition-registration",
    mintUrl: input.mintUrl,
    inputs: selected,
    outputs: { change: serializeOutputDataArray(changeOutputs) },
    metadata: {
      requiredFeeSubunits: input.requiredFeeSubunits,
      feeUnit,
      unit: feeUnit,
      selectedTotalSubunits: selectedTotal,
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
    feeUnit,
  });
}

async function resumeOrRetryRegistration(
  mintUrl: string,
  request: ConditionRegistrationRequest,
  entry: ProofOperationRecord,
): Promise<ConditionRegistrationResult> {
  const feeUnit = registrationFeeUnit(request);
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

  const wallet = await getWalletForUnit(mintUrl, feeUnit);
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
      feeUnit,
    );
    return registerCondition(request);
  }
  if (
    states.length > 0 &&
    states.every((state) => state.state === CheckStateEnum.UNSPENT)
  ) {
    const outputs = (deserializeOutputGroups({
      change: entry.outputs.change ?? [],
    }).change ?? []) as RegistrationOutputData[];
    await reserveProofs(
      entry.inputs.map((proof) => proof.secret),
      entry.operationId,
    );
    return postPreparedRegistration(mintUrl, request, {
      operationId: entry.operationId,
      inputs: entry.inputs,
      outputs,
      feeUnit,
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
    feeUnit: string;
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
      prepared.feeUnit,
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
  unit: string,
): Promise<void> {
  const proofUnit = requireCashuProofUnit(unit);
  if (changeProofs.length > 0) {
    await addProofs(changeProofs.map((proof) => ({
      ...proof,
      mintUrl,
      baseAsset: normalizeMarketBaseAsset(proofUnit),
      unit: proofUnit,
    })));
  }
  await removeProofs(inputs.map((proof) => proof.secret));
  await markProofOperationCompleted(operationId, { change: changeProofs });
}

function requireCashuProofUnit(value: string | null | undefined): CashuProofUnit {
  const unit = parseCashuProofUnit(value);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${value ?? ""}'`);
  return unit;
}

async function prepareRegularOutputs(
  mintUrl: string,
  amountSubunits: number,
  unit: string,
): Promise<RegistrationOutputData[]> {
  const wallet = await getWalletForUnit(mintUrl, unit);
  const keyset = await getActiveRegularKeyset(wallet, unit);
  const positiveOutputs = OutputData.createRandomData(
    Amount.from(amountSubunits),
    keyset,
  ) as RegistrationOutputData[];
  return positiveOutputs.map(
    (output) =>
      new OutputData(
        {
          ...output.blindedMessage,
          amount: Amount.from(0),
        },
        output.blindingFactor,
        output.secret,
      ) as RegistrationOutputData,
  );
}

async function getActiveRegularKeyset(
  wallet: CashuWallet,
  unit: string,
): Promise<MintKeys> {
  const response = await wallet.mint.getKeys();
  const keyset =
    response.keysets.find(
      (candidate) => candidate.unit === unit && candidate.active !== false,
    ) ??
    response.keysets.find((candidate) => candidate.unit === unit);
  if (!keyset) throw new Error(`Mint did not return a regular ${unit} keyset`);
  return keyset;
}

async function getRegularKeysetIdsForUnit(
  wallet: CashuWallet,
  unit: string,
): Promise<Set<string>> {
  const response = await wallet.mint.getKeys();
  const ids = response.keysets
    .filter((candidate) => candidate.unit === unit)
    .map((candidate) => candidate.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (ids.length === 0) throw new Error(`Mint did not return a regular ${unit} keyset`);
  return new Set(ids);
}

async function buildChangeProofs(
  mintUrl: string,
  outputData: RegistrationOutputData[],
  signatures: SerializedBlindedSignature[],
): Promise<Proof[]> {
  if (signatures.length > outputData.length) {
    throw new Error(
      `Mint returned ${signatures.length} registration-fee change signatures, but only ${outputData.length} change outputs were prepared`,
    );
  }
  const result: Proof[] = [];
  for (let index = 0; index < signatures.length; index++) {
    const output = outputData[index];
    const signature = normalizeChangeSignature(signatures[index]);
    validateChangeSignature(output.blindedMessage, signature);
    const keyset = await getKeyset(mintUrl, signature.id);
    result.push(output.toProof(signature, keyset));
  }
  return result;
}

function normalizeChangeSignature(
  signature: SerializedBlindedSignature,
): SerializedBlindedSignature {
  return {
    ...signature,
    amount: Amount.from(amountToNumber(signature.amount)) as never,
  };
}

function validateChangeSignature(
  output: SerializedBlindedMessage,
  signature: SerializedBlindedSignature,
): void {
  if (signature.id !== output.id || amountToNumber(signature.amount) <= 0) {
    throw new Error("Mint returned a registration-fee change signature for the wrong output");
  }
}

async function restoreChangeOutputs(
  mintUrl: string,
  storedOutputs: StoredOutputData[],
): Promise<Proof[]> {
  const outputData = (
    deserializeOutputGroups({ change: storedOutputs }).change ?? []
  ) as RegistrationOutputData[];
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

async function buildOperationId(
  request: ConditionRegistrationRequest,
  requiredFeeSubunits: number,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      request: stableRegistrationRequest(request),
      requiredFeeSubunits,
      feeUnit: registrationFeeUnit(request),
    }),
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

function registrationFeeUnit(request: ConditionRegistrationRequest): string {
  return request.collateral.trim().toLowerCase();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
