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
  type CtfProofOperationRecord,
  type CtfProofOperationStore,
} from "@bitcaster/client-sdk/ctfSplit";
import {
  defaultCollateralUnit,
  parseCashuProofUnit,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
  DURABLE_WALLET_PROOF_TRANSITION_METADATA_KEY,
  requireDurableWalletProofTransition,
} from "@bitcaster/client-sdk/durableWalletProofTransition";
import { MintError, registerCondition } from "@/lib/markets";
import { getWalletForUnit } from "@/lib/cashu";
import { normalizeUrl } from "@/lib/url";
import {
  getUnitProofs,
  getUnitProofsUnderLock,
  type ProofOperationRecord,
  type StoredOutputData,
} from "@/stores/proof-db";
import {
  withGuiCustodyProfileLock,
  withGuiCustodyProfileLockForWallet,
} from "@/stores/gui-custody-authority";
import { createCapturedGuiWalletProofOperationStore } from "@/stores/gui-wallet-proof-operation-store";

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

interface ConditionRegistrationAuthority {
  walletId: string;
  mintUrl: string;
  request: ConditionRegistrationRequest;
  requiredFeeSubunits: number;
  feeUnit: CashuProofUnit;
  selectedTotalSubunits: number;
}

interface CanonicalConditionRegistrationInput {
  mintUrl: string;
  request: ConditionRegistrationRequest;
  requiredFeeSubunits: number;
}

interface RegularKeysetAuthority {
  ids: ReadonlySet<string>;
  active: MintKeys;
}

type ExpectedConditionRegistration = Pick<
  ConditionRegistrationAuthority,
  "mintUrl" | "request" | "requiredFeeSubunits" | "feeUnit"
>;

export { registrationFeeForPolicy, requiredMarketCreationOutcomeCollections };

export async function getAvailableRegularBalanceSubunits(
  mintUrl: string,
  baseAsset?: string | null,
): Promise<number> {
  const proofs = await getUnitProofs(mintUrl, {
    unit: defaultCollateralUnit(baseAsset),
  });
  return sumProofs(proofs);
}

export async function registerConditionWithFee(input: {
  mintUrl: string;
  request: ConditionRegistrationRequest;
  requiredFeeSubunits: number;
}): Promise<ConditionRegistrationResult> {
  const requiredFeeSubunits = requireRegistrationFee(input.requiredFeeSubunits);
  const request = requireRegistrationRequest(input.request);
  if (requiredFeeSubunits === 0) return registerCondition(request);
  const canonicalInput = {
    mintUrl: requireRegistrationMintUrl(input.mintUrl),
    request,
    requiredFeeSubunits,
  };
  const walletId = await captureCurrentGuiWalletId();
  return registerConditionWithFeeForWallet(canonicalInput, walletId);
}

async function captureCurrentGuiWalletId(): Promise<string> {
  return withGuiCustodyProfileLock(async (context) => context.walletId);
}

async function registerConditionWithFeeForWallet(
  input: CanonicalConditionRegistrationInput,
  walletId: string,
): Promise<ConditionRegistrationResult> {
  const operationStore = createCapturedGuiWalletProofOperationStore(walletId);
  const operationId = await buildOperationId(
    input.mintUrl,
    input.request,
    input.requiredFeeSubunits,
  );
  const feeUnit = registrationFeeUnit(input.request);
  const existing = await operationStore.getProofOperation(operationId);
  if (existing) {
    return resumeOrRetryRegistration(
      requireWalletOperationRecord(existing, walletId),
      operationStore,
      walletId,
      {
        mintUrl: input.mintUrl,
        request: input.request,
        requiredFeeSubunits: input.requiredFeeSubunits,
        feeUnit,
      },
    );
  }

  const wallet = await getWalletForUnit(input.mintUrl, feeUnit, {
    expectedWalletId: walletId,
  });
  const keysets = await getRegularKeysetAuthority(wallet, feeUnit);
  const selected = await selectRegistrationFeeProofs(
    walletId,
    input,
    feeUnit,
    keysets.ids,
  );
  const selectedTotal = sumProofs(selected);
  const changeAmount = selectedTotal - input.requiredFeeSubunits;
  const changeOutputs =
    changeAmount > 0 ? prepareRegularOutputs(keysets.active, changeAmount) : [];

  const prepared = await operationStore.prepareProofOperation({
    operationId,
    kind: "ctf-condition-registration",
    mintUrl: input.mintUrl,
    inputs: selected,
    outputs: { change: serializeOutputDataArray(changeOutputs) },
    metadata: addDurableWalletProofTransitionMetadata(
      {
        requiredFeeSubunits: input.requiredFeeSubunits,
        feeUnit,
        unit: feeUnit,
        selectedTotalSubunits: selectedTotal,
        request: stableRegistrationRequest(input.request),
      },
      createDurableWalletProofTransition({
        inputSource: "wallet",
        plannedOutputLabels: ["change"],
        resultGroups: {
          change: {
            kind: "wallet",
            asset: "regular",
            reservedBy: null,
          },
        },
        resultCardinality: { change: "prefix" },
      }),
    ),
  });
  const persisted = requireWalletOperationRecord(prepared, walletId);
  const authority = await requireConditionRegistrationAuthority(
    persisted,
    walletId,
  );
  assertExpectedConditionRegistration(authority, {
    mintUrl: input.mintUrl,
    request: input.request,
    requiredFeeSubunits: input.requiredFeeSubunits,
    feeUnit,
  });
  return postPreparedRegistration(persisted, authority, operationStore);
}

async function selectRegistrationFeeProofs(
  walletId: string,
  input: CanonicalConditionRegistrationInput,
  feeUnit: CashuProofUnit,
  regularKeysetIds: ReadonlySet<string>,
): Promise<Proof[]> {
  return withGuiCustodyProfileLockForWallet(
    walletId,
    async (_context, lock) => {
      const proofs = await getUnitProofsUnderLock(lock, input.mintUrl, {
        unit: feeUnit,
      });
      const available = proofs.filter((proof) =>
        regularKeysetIds.has(proof.id),
      );
      const selected = takeProofsForLock(available, input.requiredFeeSubunits);
      if (!selected) {
        throw new Error(
          `Not enough regular ${feeUnit} proofs are available for the ${input.requiredFeeSubunits} ${feeUnit} condition registration fee.`,
        );
      }
      return selected;
    },
  );
}

async function resumeOrRetryRegistration(
  entry: ProofOperationRecord,
  operationStore: CtfProofOperationStore,
  expectedWalletId: string,
  expected: ExpectedConditionRegistration,
): Promise<ConditionRegistrationResult> {
  const authority = await requireConditionRegistrationAuthority(
    entry,
    expectedWalletId,
  );
  assertExpectedConditionRegistration(authority, expected);
  switch (entry.state) {
    case "completed":
      return registerCondition(authority.request);
    case "Failed":
      throw new Error(
        "Condition registration fee operation previously failed.",
      );
    case "prepared":
    case "mint-submitted":
      return resumePendingRegistration(entry, authority, operationStore);
    default:
      return assertNeverOperationState(entry.state);
  }
}

/** Recover one already-selected native fee operation without holding Web Locks. */
export async function recoverGuiConditionRegistrationOperation(
  entry: ProofOperationRecord,
): Promise<void> {
  const walletId = entry.walletId;
  const operationStore = createCapturedGuiWalletProofOperationStore(walletId);
  const current = await operationStore.getProofOperation(entry.operationId);
  if (!current) {
    throw new Error("Condition registration recovery operation is missing.");
  }
  const currentEntry = requireWalletOperationRecord(current, walletId);
  const expectedAuthority = await requireConditionRegistrationAuthority(
    entry,
    walletId,
  );
  const authority = await requireConditionRegistrationAuthority(
    currentEntry,
    walletId,
  );
  assertExpectedConditionRegistration(authority, expectedAuthority);
  switch (currentEntry.state) {
    case "completed":
    case "Failed":
      return;
    case "prepared":
    case "mint-submitted":
      await resumePendingRegistration(currentEntry, authority, operationStore);
      return;
    default:
      return assertNeverOperationState(currentEntry.state);
  }
}

async function resumePendingRegistration(
  entry: ProofOperationRecord,
  authority: ConditionRegistrationAuthority,
  operationStore: CtfProofOperationStore,
): Promise<ConditionRegistrationResult> {
  const wallet = await getWalletForUnit(authority.mintUrl, authority.feeUnit, {
    expectedWalletId: authority.walletId,
  });
  if (!wallet.checkProofsStates) {
    throw new Error(
      "Cashu wallet adapter does not support condition registration recovery checks.",
    );
  }
  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  );
  if (
    states.length === entry.inputs.length &&
    states.every((state) => state.state === CheckStateEnum.SPENT)
  ) {
    if (entry.state !== "mint-submitted") {
      throw new Error(
        "Condition registration inputs changed before durable dispatch.",
      );
    }
    const changeProofs = await restoreChangeOutputs(
      authority.mintUrl,
      entry.outputs.change ?? [],
    );
    await completeRegistrationFeeOperation(
      entry,
      authority,
      changeProofs,
      operationStore,
    );
    return registerCondition(authority.request);
  }
  if (
    states.length === entry.inputs.length &&
    states.every((state) => state.state === CheckStateEnum.UNSPENT)
  ) {
    return postPreparedRegistration(entry, authority, operationStore);
  }

  throw new Error(
    "Condition registration fee payment is still pending at the mint. Refresh wallet recovery before paying again.",
  );
}

async function postPreparedRegistration(
  entry: ProofOperationRecord,
  authority: ConditionRegistrationAuthority,
  operationStore: CtfProofOperationStore,
): Promise<ConditionRegistrationResult> {
  try {
    const submittedRecord =
      await operationStore.markProofOperationMintSubmitted(entry.operationId);
    const submitted = requireWalletOperationRecord(
      submittedRecord,
      authority.walletId,
    );
    const submittedAuthority = await requireConditionRegistrationAuthority(
      submitted,
      authority.walletId,
    );
    assertExpectedConditionRegistration(submittedAuthority, authority);
    if (submitted.state !== "mint-submitted") {
      throw new Error(
        "Condition registration recovery was not durably submitted.",
      );
    }
    const outputs = deserializeRegistrationOutputs(submitted);
    const response = await registerCondition({
      ...submittedAuthority.request,
      fee: submitted.inputs,
      outputs:
        outputs.length > 0
          ? outputs.map((output) => output.blindedMessage)
          : undefined,
    });
    const changeProofs = await buildChangeProofs(
      submittedAuthority.mintUrl,
      outputs,
      response.change ?? [],
    );
    await completeRegistrationFeeOperation(
      submitted,
      submittedAuthority,
      changeProofs,
      operationStore,
    );
    return response;
  } catch (error) {
    if (
      error instanceof MintError &&
      (error.code === 13044 || error.code === 13047)
    ) {
      if (!operationStore.markProofOperationFailed) {
        throw new Error("Condition registration store cannot persist failure");
      }
      await operationStore.markProofOperationFailed(
        entry.operationId,
        "Condition registration fee was rejected by the mint.",
        error.code,
      );
    }
    throw mapRegistrationFeeMintError(error);
  }
}

function mapRegistrationFeeMintError(error: unknown): unknown {
  if (error instanceof MintError && error.code === 13044) {
    return new Error("Registration fee was missing or insufficient.");
  }
  if (error instanceof MintError && error.code === 13047) {
    return new Error(
      "Registration fee change outputs were invalid or insufficient.",
    );
  }
  return error;
}

async function completeRegistrationFeeOperation(
  entry: ProofOperationRecord,
  authority: ConditionRegistrationAuthority,
  changeProofs: Proof[],
  operationStore: CtfProofOperationStore,
): Promise<void> {
  const completedRecord = await operationStore.markProofOperationCompleted(
    entry.operationId,
    {
      change: changeProofs,
    },
  );
  const completed = requireWalletOperationRecord(
    completedRecord,
    authority.walletId,
  );
  const completedAuthority = await requireConditionRegistrationAuthority(
    completed,
    authority.walletId,
  );
  assertExpectedConditionRegistration(completedAuthority, authority);
  if (completed.state !== "completed") {
    throw new Error("Condition registration recovery did not complete.");
  }
}

function requireWalletOperationRecord(
  value: CtfProofOperationRecord,
  expectedWalletId: string,
): ProofOperationRecord {
  if (!isRecord(value) || value.walletId !== expectedWalletId) {
    throw new Error("Condition registration wallet authority is invalid.");
  }
  return value as unknown as ProofOperationRecord;
}

function deserializeRegistrationOutputs(
  entry: ProofOperationRecord,
): RegistrationOutputData[] {
  return (deserializeOutputGroups({
    change: entry.outputs.change ?? [],
  }).change ?? []) as RegistrationOutputData[];
}

function prepareRegularOutputs(
  keyset: MintKeys,
  amountSubunits: number,
): RegistrationOutputData[] {
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

async function getRegularKeysetAuthority(
  wallet: CashuWallet,
  unit: string,
): Promise<RegularKeysetAuthority> {
  const response = await wallet.mint.getKeys();
  const keysets = response.keysets.filter(
    (candidate) => candidate.unit === unit,
  );
  const active =
    keysets.find(
      (candidate) => candidate.unit === unit && candidate.active !== false,
    ) ?? keysets[0];
  const ids = keysets
    .map((candidate) => candidate.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (!active || ids.length === 0) {
    throw new Error(`Mint did not return a regular ${unit} keyset`);
  }
  return { active, ids: new Set(ids) };
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
    throw new Error(
      "Mint returned a registration-fee change signature for the wrong output",
    );
  }
}

async function restoreChangeOutputs(
  mintUrl: string,
  storedOutputs: StoredOutputData[],
): Promise<Proof[]> {
  const outputData = (deserializeOutputGroups({ change: storedOutputs })
    .change ?? []) as RegistrationOutputData[];
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
  if (!keysetId)
    throw new Error("Missing keyset id for registration-fee change output");
  const mint = new CashuMint(mintUrl);
  const response = await mint.getKeys(keysetId);
  const keyset = response.keysets.find(
    (candidate) => candidate.id === keysetId,
  );
  if (!keyset)
    throw new Error(`Mint did not return keys for keyset ${keysetId}`);
  return keyset;
}

const CONDITION_REGISTRATION_METADATA_KEYS = new Set([
  "requiredFeeSubunits",
  "feeUnit",
  "unit",
  "selectedTotalSubunits",
  "request",
  DURABLE_WALLET_PROOF_TRANSITION_METADATA_KEY,
]);

async function requireConditionRegistrationAuthority(
  entry: ProofOperationRecord,
  expectedWalletId: string,
): Promise<ConditionRegistrationAuthority> {
  if (
    entry.kind !== "ctf-condition-registration" ||
    entry.walletId !== expectedWalletId
  ) {
    throw new Error("Condition registration recovery authority is invalid.");
  }
  const mintUrl = requirePersistedRegistrationMintUrl(entry.mintUrl);
  const metadata = entry.metadata;
  if (
    !isRecord(metadata) ||
    Object.keys(metadata).some(
      (key) => !CONDITION_REGISTRATION_METADATA_KEYS.has(key),
    )
  ) {
    throw new Error("Condition registration recovery metadata is invalid.");
  }
  const request = requireRegistrationRequest(metadata.request);
  const feeUnit = registrationFeeUnit(request);
  if (metadata.feeUnit !== feeUnit || metadata.unit !== feeUnit) {
    throw new Error("Condition registration recovery unit is invalid.");
  }
  const requiredFeeSubunits = requirePersistedRegistrationFee(
    metadata.requiredFeeSubunits,
  );
  const selectedTotalSubunits = requireSelectedTotal(
    metadata.selectedTotalSubunits,
    entry.inputs,
    requiredFeeSubunits,
  );
  assertRegistrationOutputs(entry, selectedTotalSubunits, requiredFeeSubunits);
  assertRegistrationTransition(entry);
  if (
    entry.operationId !==
    (await buildOperationId(mintUrl, request, requiredFeeSubunits))
  ) {
    throw new Error("Condition registration recovery identity is invalid.");
  }
  return {
    walletId: expectedWalletId,
    mintUrl,
    request,
    requiredFeeSubunits,
    feeUnit,
    selectedTotalSubunits,
  };
}

function requireSelectedTotal(
  value: unknown,
  inputs: readonly Proof[],
  requiredFeeSubunits: number,
): number {
  if (
    inputs.length === 0 ||
    !Number.isSafeInteger(value) ||
    (value as number) <= 0
  ) {
    throw new Error("Condition registration recovery input total is invalid.");
  }
  const selectedTotalSubunits = value as number;
  const actualTotal = sumProofs(inputs);
  if (
    !Number.isSafeInteger(actualTotal) ||
    actualTotal !== selectedTotalSubunits ||
    selectedTotalSubunits < requiredFeeSubunits
  ) {
    throw new Error("Condition registration recovery input total is invalid.");
  }
  return selectedTotalSubunits;
}

function assertRegistrationOutputs(
  entry: ProofOperationRecord,
  selectedTotalSubunits: number,
  requiredFeeSubunits: number,
): void {
  if (
    Object.keys(entry.outputs).length !== 1 ||
    !Array.isArray(entry.outputs.change) ||
    (selectedTotalSubunits === requiredFeeSubunits) !==
      (entry.outputs.change.length === 0)
  ) {
    throw new Error("Condition registration recovery outputs are invalid.");
  }
  try {
    deserializeOutputGroups({ change: entry.outputs.change });
  } catch {
    throw new Error("Condition registration recovery outputs are invalid.");
  }
}

function assertRegistrationTransition(entry: ProofOperationRecord): void {
  const transition = requireDurableWalletProofTransition(entry.metadata, [
    "change",
  ]);
  const change = transition.resultGroups.change;
  if (
    transition.inputSource !== "wallet" ||
    change?.kind !== "wallet" ||
    change.asset !== "regular" ||
    change.reservedBy !== null ||
    Object.keys(transition.passthroughResultGroups).length !== 0
  ) {
    throw new Error("Condition registration recovery transition is invalid.");
  }
}

function assertExpectedConditionRegistration(
  authority: ConditionRegistrationAuthority,
  expected: ExpectedConditionRegistration,
): void {
  if (
    authority.mintUrl !== expected.mintUrl ||
    authority.requiredFeeSubunits !== expected.requiredFeeSubunits ||
    authority.feeUnit !== expected.feeUnit ||
    JSON.stringify(authority.request) !== JSON.stringify(expected.request)
  ) {
    throw new Error("Condition registration recovery request is invalid.");
  }
}

function requireRegistrationFee(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > MAX_CONDITION_REGISTRATION_FEE_SUBUNITS
  ) {
    throw new Error(
      `Condition registration fee must be between 0 and ${MAX_CONDITION_REGISTRATION_FEE_SUBUNITS} subunits.`,
    );
  }
  return value as number;
}

function requirePersistedRegistrationFee(value: unknown): number {
  const fee = requireRegistrationFee(value);
  if (fee === 0) {
    throw new Error("Condition registration recovery fee is invalid.");
  }
  return fee;
}

function requireRegistrationMintUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Condition registration mint is invalid.");
  }
  const normalized = normalizeUrl(value);
  if (normalized.length === 0) {
    throw new Error("Condition registration mint is invalid.");
  }
  return normalized;
}

function requirePersistedRegistrationMintUrl(value: unknown): string {
  const normalized = requireRegistrationMintUrl(value);
  if (value !== normalized) {
    throw new Error("Condition registration recovery mint is not canonical.");
  }
  return normalized;
}

function requireRegistrationRequest(
  value: unknown,
): ConditionRegistrationRequest {
  if (!isRecord(value) || hasForeignRegistrationRequestField(value)) {
    throw new Error("Condition registration request is invalid.");
  }
  if (
    !Array.isArray(value.tags) ||
    !value.tags.every(
      (tag) =>
        Array.isArray(tag) && tag.every((item) => typeof item === "string"),
    ) ||
    typeof value.announcementHex !== "string" ||
    value.announcementHex.length === 0
  ) {
    throw new Error("Condition registration request is invalid.");
  }
  const feeUnit =
    typeof value.collateral === "string"
      ? parseCashuProofUnit(value.collateral)
      : null;
  if (!feeUnit) throw new Error("Condition registration request is invalid.");
  const outcomeCollections = value.outcomeCollections;
  if (
    outcomeCollections !== undefined &&
    (!Array.isArray(outcomeCollections) ||
      !outcomeCollections.every((item) => typeof item === "string"))
  ) {
    throw new Error("Condition registration request is invalid.");
  }
  return stableRegistrationRequest({
    tags: value.tags as string[][],
    announcementHex: value.announcementHex,
    collateral: feeUnit,
    ...(outcomeCollections === undefined
      ? {}
      : { outcomeCollections: outcomeCollections as string[] }),
  });
}

function hasForeignRegistrationRequestField(
  value: Record<string, unknown>,
): boolean {
  return Object.keys(value).some(
    (key) =>
      key !== "tags" &&
      key !== "announcementHex" &&
      key !== "collateral" &&
      key !== "outcomeCollections",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNeverOperationState(_value: never): never {
  throw new Error("Condition registration recovery state is invalid.");
}

async function buildOperationId(
  mintUrl: string,
  request: ConditionRegistrationRequest,
  requiredFeeSubunits: number,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      mintUrl,
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
  const stable: ConditionRegistrationRequest = {
    tags: request.tags.map((tag) => [...tag]),
    announcementHex: request.announcementHex,
    collateral: request.collateral,
  };
  if (request.outcomeCollections !== undefined) {
    stable.outcomeCollections = [...request.outcomeCollections];
  }
  return stable;
}

function registrationFeeUnit(
  request: ConditionRegistrationRequest,
): CashuProofUnit {
  const unit = parseCashuProofUnit(request.collateral);
  if (!unit) throw new Error("Condition registration unit is unsupported.");
  return unit;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
