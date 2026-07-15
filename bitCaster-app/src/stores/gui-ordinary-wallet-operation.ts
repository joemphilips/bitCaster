import {
  Amount,
  CheckStateEnum,
  type MintQuoteResponse,
  type OutputDataLike,
  type Proof,
  type Token,
  type Wallet,
} from "@cashu/cashu-ts";
import {
  createDurableWalletMintOperation,
  createDurableWalletReceiveOperation,
  decodeDurableWalletOperation,
  decideDurableWalletOperationRecovery,
  deriveDurableWalletOperationAuthority,
  rehydrateDurableWalletOperation,
  restoreDurableWalletOperationOutputs,
  toDurableCustodyProofOperationInput,
  type DurableWalletOperation,
  type DurableWalletOperationRecoveryEvidence,
} from "@bitcaster/client-sdk/durableWalletOperation";
import {
  deriveDurableCustodyArtifactFingerprint,
  type DurableCustodyRetryReason,
} from "@bitcaster/client-sdk/durableCustody";
import { deriveDurableCustodyProofOperationFingerprints } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import type { CashuProofUnit } from "@bitcaster/client-sdk/marketUnits";
import { getWalletForUnit } from "@/lib/cashu";
import { proofsWithOptionalConditionalMetadata } from "@/lib/conditionalKeysetMetadata";
import { normalizeUrl } from "@/lib/url";
import {
  currentGuiWalletId,
  getProofOperationForWallet,
  type PrepareProofOperationInput,
  type ProofOperationRecord,
} from "./proof-db";
import {
  abortPreparedGuiWalletMintForWallet,
  claimPreparedProofOperationMintSubmissionForWallet,
  markProofOperationCompletedForWallet,
  prepareProofOperationForWallet,
  requireCompletedGuiWalletProofOperationAuthorityForWallet,
} from "./gui-wallet-proof-operation-custody";
import { GuiCustodyMintKeysUnavailable } from "./gui-custody-authority";
import {
  GuiDurableStorageHeadroomUnavailable,
  requireGuiNewEffectHeadroomForWallet,
} from "./gui-durable-storage-headroom-custody-unit-of-work";
import {
  GUI_DEPOSIT_ACTIVITY_METADATA_KEY,
  guiDepositActivityMetadata,
  readGuiDepositActivityMetadata,
  type GuiDepositActivityMetadata,
} from "./wallet-activity-projection";

export interface GuiLightningMintPlan {
  walletId: string;
  operationId: string;
  mintUrl: string;
  unit: CashuProofUnit;
}

export async function prepareGuiLightningMint(input: {
  amount: number;
  quote: MintQuoteResponse;
  mintUrl: string;
  unit: CashuProofUnit;
}): Promise<GuiLightningMintPlan> {
  const walletId = currentGuiWalletId();
  const mintUrl = normalizeUrl(input.mintUrl);
  const exactQuote = requireExactMintQuote(
    input.quote,
    input.quote.quote,
    input.unit,
    input.amount,
  );
  const operationId = mintOperationId(mintUrl, input.unit, input.quote.quote);
  const existing = await loadExactOperation(walletId, operationId);
  if (existing) {
    requireExistingMintPlan(existing, input, mintUrl, exactQuote);
    assertCapturedWallet(walletId);
    return { walletId, operationId, mintUrl, unit: input.unit };
  }

  const wallet = await walletForCapturedSeed(walletId, mintUrl, input.unit);
  const preview = await fencedWalletCall(walletId, () =>
    wallet.prepareMint("bolt11", input.amount, input.quote),
  );
  const operation = createDurableWalletMintOperation({
    operationId,
    mintUrl,
    unit: input.unit,
    quoteExpiryUnixSeconds: exactQuote.expiryUnixSeconds,
    preview,
  });
  await persistOperation(
    walletId,
    operation,
    guiDepositActivityMetadata(input.quote.request),
  );
  assertCapturedWallet(walletId);
  return { walletId, operationId, mintUrl, unit: input.unit };
}

function requireExistingMintPlan(
  existing: DurableWalletOperation,
  input: { amount: number; quote: MintQuoteResponse; unit: CashuProofUnit },
  mintUrl: string,
  exactQuote: { expiryUnixSeconds: number | null },
): void {
  requireOperationIdentity(existing, "wallet-mint", mintUrl, input.unit);
  if (existing.preview.payload.quote !== input.quote.quote) {
    throw new Error("GUI mint quote conflicts with its durable operation");
  }
  if (
    existing.preview.quoteExpiryUnixSeconds !== exactQuote.expiryUnixSeconds
  ) {
    throw new Error("GUI mint expiry conflicts with its durable operation");
  }
  const amount = existing.preview.outputData.reduce(
    (sum, output) => sum + amountToNumber(output.blindedMessage.amount),
    0,
  );
  if (amount !== input.amount) {
    throw new Error("GUI mint amount conflicts with its durable operation");
  }
}

export async function completeGuiLightningMint(
  plan: GuiLightningMintPlan,
): Promise<Proof[]> {
  assertCapturedWallet(plan.walletId);
  const operation = await requireExactOperation(
    plan.walletId,
    plan.operationId,
  );
  requireOperationIdentity(operation, "wallet-mint", plan.mintUrl, plan.unit);
  return dispatchForegroundExactOperation(plan.walletId, operation);
}

export async function receiveGuiCashuToken(input: {
  expectedWalletId: string;
  token: Token;
  mintUrl: string;
  unit: CashuProofUnit;
}): Promise<Proof[]> {
  const walletId = input.expectedWalletId;
  assertCapturedWallet(walletId);
  const mintUrl = normalizeUrl(input.mintUrl);
  const operationId = receiveOperationId(
    mintUrl,
    input.unit,
    input.token.proofs,
  );
  let operation = await loadExactOperation(walletId, operationId);
  if (!operation) {
    const wallet = await walletForCapturedSeed(walletId, mintUrl, input.unit);
    const token = { ...input.token, mint: mintUrl, unit: input.unit };
    const preview = await fencedWalletCall(walletId, () =>
      wallet.prepareSwapToReceive(token, undefined, { type: "random" }),
    );
    operation = createDurableWalletReceiveOperation({
      operationId,
      mintUrl,
      unit: input.unit,
      preview,
    });
    await persistOperation(
      walletId,
      operation,
      guiDepositActivityMetadata(null),
    );
    assertCapturedWallet(walletId);
  }
  requireOperationIdentity(operation, "wallet-receive", mintUrl, input.unit);
  return dispatchForegroundExactOperation(walletId, operation);
}

/** Runs one exact ordinary-wallet recovery attempt outside the startup scan lock. */
export type GuiOrdinaryWalletRecoveryOutcome =
  | { kind: "settled" }
  | { kind: "retry-later"; reason: DurableCustodyRetryReason }
  | { kind: "blocked" };

export async function recoverGuiOrdinaryWalletOperation(
  record: ProofOperationRecord,
): Promise<GuiOrdinaryWalletRecoveryOutcome> {
  let operation: DurableWalletOperation;
  try {
    operation = await requireExactOperation(
      record.walletId,
      record.operationId,
    );
  } catch (error) {
    if (error instanceof RetryableGuiWalletOperationFailure) {
      return { kind: "retry-later", reason: "mint-response-unknown" };
    }
    throw error;
  }
  if (operation.kind !== "wallet-mint" && operation.kind !== "wallet-receive") {
    throw new Error("Unsupported GUI ordinary wallet recovery operation");
  }
  let wallet: Wallet;
  try {
    wallet = await walletForPersistedOperation(
      record.walletId,
      operation.mintUrl,
      requireUnit(operation.unit),
    );
  } catch (error) {
    if (error instanceof RetryableGuiWalletOperationFailure) {
      return { kind: "retry-later", reason: "mint-response-unknown" };
    }
    throw error;
  }
  let assessment: RecoveryAssessment;
  try {
    assessment = await collectRecoveryEvidence(
      record.walletId,
      wallet,
      operation,
      submissionState(record),
    );
  } catch (error) {
    if (error instanceof ExternalRecoveryEvidenceUnavailable) {
      return { kind: "retry-later", reason: "mint-response-unknown" };
    }
    throw error;
  }
  const decision = decideDurableWalletOperationRecovery(
    operation,
    assessment.evidence,
  );
  switch (decision.kind) {
    case "abort-no-transport":
      await abortPreparedGuiWalletMintForWallet(
        record.walletId,
        operation.operationId,
        decision,
      );
      return { kind: "settled" };
    case "reissue-exact-operation":
      try {
        await requireGuiNewEffectHeadroomForWallet(record.walletId);
        await dispatchExactOperation(
          record.walletId,
          decision.operation,
          wallet,
          "recovery",
        );
      } catch (error) {
        if (error instanceof GuiDurableStorageHeadroomUnavailable) {
          return { kind: "retry-later", reason: "storage-unavailable" };
        }
        if (error instanceof RetryableGuiWalletOperationFailure) {
          return { kind: "retry-later", reason: "mint-response-unknown" };
        }
        throw error;
      }
      return { kind: "settled" };
    case "reconcile-exact-operation": {
      const restored = assessment.restored;
      if (
        !restored ||
        restored.kind !== "exact" ||
        decision.result.kind !== "restored-proofs" ||
        restored.resultFingerprint !== decision.result.resultFingerprint
      ) {
        throw new Error(
          "GUI wallet restore result changed after classification",
        );
      }
      await completeOperation(
        record.walletId,
        operation,
        restored.resultGroups,
      );
      return { kind: "settled" };
    }
    case "retry-later":
      return { kind: "retry-later", reason: decision.classification };
    case "fail-closed":
      return { kind: "blocked" };
  }
}

async function dispatchExactOperation(
  walletId: string,
  operation: DurableWalletOperation,
  loadedWallet?: Wallet,
  authority: "direct" | "recovery" = "direct",
): Promise<Proof[]> {
  const row = await getProofOperationForWallet(walletId, operation.operationId);
  if (!row) throw new Error("GUI wallet operation is missing");
  if (row.state === "completed") {
    const completed =
      await requireCompletedGuiWalletProofOperationAuthorityForWallet(
        walletId,
        operation.operationId,
      );
    assertCapturedWallet(walletId);
    return exactCompletedProofs(completed);
  }
  if (row.state === "Failed") {
    throw new Error("GUI wallet operation is terminally failed");
  }
  const wallet =
    loadedWallet ??
    (await walletForPersistedOperation(
      walletId,
      operation.mintUrl,
      requireUnit(operation.unit),
    ));
  if (row.state === "mint-submitted") {
    if (authority === "direct") {
      return recoverSubmittedOperation(walletId, wallet, operation);
    }
  } else {
    const claim = await claimPreparedProofOperationMintSubmissionForWallet(
      walletId,
      operation.operationId,
    );
    assertCapturedWallet(walletId);
    if (!claim.claimed) {
      return authority === "direct"
        ? recoverSubmittedOperation(walletId, wallet, operation)
        : pendingRecovery();
    }
  }
  return transportExactOperation(walletId, wallet, operation);
}

async function recoverSubmittedOperation(
  walletId: string,
  wallet: Wallet,
  operation: DurableWalletOperation,
): Promise<Proof[]> {
  let assessment: RecoveryAssessment;
  try {
    assessment = await collectRecoveryEvidence(
      walletId,
      wallet,
      operation,
      "submitted",
    );
  } catch (error) {
    if (error instanceof ExternalRecoveryEvidenceUnavailable) {
      return pendingRecovery();
    }
    throw error;
  }
  const decision = decideDurableWalletOperationRecovery(
    operation,
    assessment.evidence,
  );
  switch (decision.kind) {
    case "abort-no-transport":
      throw new Error("Submitted GUI wallet operation cannot be aborted");
    case "reconcile-exact-operation": {
      const restored = assessment.restored;
      if (
        !restored ||
        restored.kind !== "exact" ||
        decision.result.kind !== "restored-proofs" ||
        restored.resultFingerprint !== decision.result.resultFingerprint
      ) {
        throw new Error(
          "GUI wallet restore result changed after classification",
        );
      }
      const completed = await completeOperation(
        walletId,
        operation,
        restored.resultGroups,
      );
      return completed.receive ?? [];
    }
    case "reissue-exact-operation":
      await requireReissueHeadroom(walletId);
      return transportExactOperation(walletId, wallet, decision.operation);
    case "retry-later":
      return pendingRecovery();
    case "fail-closed":
      throw new Error(`GUI wallet recovery failed closed: ${decision.reason}`);
  }
}

async function requireReissueHeadroom(walletId: string): Promise<void> {
  try {
    await requireGuiNewEffectHeadroomForWallet(walletId);
  } catch (error) {
    if (!(error instanceof GuiDurableStorageHeadroomUnavailable)) throw error;
    throw retryableWalletFailure(
      "GUI wallet storage headroom is unavailable",
      error,
    );
  }
}

function pendingRecovery(): never {
  throw new RetryableGuiWalletOperationFailure(
    "GUI wallet operation recovery is pending",
  );
}

async function transportExactOperation(
  walletId: string,
  wallet: Wallet,
  operation: DurableWalletOperation,
): Promise<Proof[]> {
  const runtime = rehydrateDurableWalletOperation(operation);
  let proofs: Proof[];
  switch (runtime.kind) {
    case "wallet-mint":
      proofs = await exactTransportPortCall(walletId, () =>
        wallet.completeMint(runtime.preview),
      );
      break;
    case "wallet-receive": {
      const result = await exactTransportPortCall(walletId, () =>
        wallet.completeSwap(runtime.preview),
      );
      proofs = result.keep;
      break;
    }
    case "wallet-send":
    case "wallet-melt":
      throw new Error("Unsupported GUI ordinary wallet dispatch operation");
  }
  const completed = await completeOperation(walletId, operation, {
    receive: proofs,
  });
  return completed.receive ?? [];
}

async function completeOperation(
  walletId: string,
  operation: DurableWalletOperation,
  resultGroups: Record<string, Proof[]>,
): Promise<Record<string, Proof[]>> {
  const groups =
    operation.kind === "wallet-receive"
      ? {
          receive: await fencedWalletCall(walletId, () =>
            proofsWithOptionalConditionalMetadata({
              mintUrl: operation.mintUrl,
              proofs: resultGroups.receive ?? [],
            }),
          ),
        }
      : resultGroups;
  await markProofOperationCompletedForWallet(
    walletId,
    operation.operationId,
    groups,
  );
  assertCapturedWallet(walletId);
  return groups;
}

async function collectRecoveryEvidence(
  walletId: string,
  wallet: Wallet,
  operation: DurableWalletOperation,
  submission: RecoverySubmissionState,
): Promise<RecoveryAssessment> {
  switch (operation.kind) {
    case "wallet-mint":
      return collectMintRecoveryEvidence(
        walletId,
        wallet,
        operation,
        submission,
      );
    case "wallet-receive":
      return collectReceiveRecoveryEvidence(
        walletId,
        wallet,
        operation,
        submission,
      );
    case "wallet-send":
    case "wallet-melt":
      throw new Error("Unsupported GUI ordinary wallet recovery operation");
  }
}

async function collectMintRecoveryEvidence(
  walletId: string,
  wallet: Wallet,
  operation: Extract<DurableWalletOperation, { kind: "wallet-mint" }>,
  submission: RecoverySubmissionState,
): Promise<RecoveryAssessment> {
  const authority = deriveDurableWalletOperationAuthority(operation);
  const quote = await recoveryEvidencePortCall(walletId, () =>
    wallet.checkMintQuote<MintQuoteResponse>(
      operation.preview.method,
      operation.preview.payload.quote,
    ),
  );
  const observedAtUnixSeconds = Math.floor(Date.now() / 1_000);
  const amount = operation.preview.outputData.reduce(
    (sum, output) => sum + amountToNumber(output.blindedMessage.amount),
    0,
  );
  const exactQuote = requireExactMintQuote(
    quote,
    operation.preview.payload.quote,
    requireUnit(operation.unit),
    amount,
    operation.preview.quoteExpiryUnixSeconds,
  );
  const restored =
    exactQuote.state === "ISSUED"
      ? await restoreExactOutputs(walletId, wallet, operation)
      : null;
  return {
    restored,
    evidence: {
      schemaVersion: 1,
      operationId: operation.operationId,
      requestFingerprint: authority.requestFingerprint,
      submissionState: submission,
      quote: {
        kind: "mint",
        method: operation.preview.method,
        quoteId: operation.preview.payload.quote,
        state: exactQuote.state,
        expiryUnixSeconds: exactQuote.expiryUnixSeconds,
        observedAtUnixSeconds,
      },
      inputStates: [],
      restore: restoreEvidence(restored),
    },
  };
}

async function collectReceiveRecoveryEvidence(
  walletId: string,
  wallet: Wallet,
  operation: Extract<DurableWalletOperation, { kind: "wallet-receive" }>,
  submission: RecoverySubmissionState,
): Promise<RecoveryAssessment> {
  const authority = deriveDurableWalletOperationAuthority(operation);
  const custody = toDurableCustodyProofOperationInput(operation);
  const states = await recoveryEvidencePortCall(walletId, () =>
    wallet.checkProofsStates(
      custody.inputs.map(({ id, secret }) => ({
        id: requireText(id, "wallet recovery keyset"),
        secret,
      })),
    ),
  );
  if (states.length !== custody.inputs.length) {
    throw new Error("Mint returned a partial NUT-07 result");
  }
  const inputStates = custody.inputs.map((proof, index) => ({
    keysetId: requireText(proof.id, "wallet recovery keyset"),
    secret: proof.secret,
    state: requireProofState(states[index]?.state),
  }));
  const allSpent = inputStates.every(({ state }) => state === "SPENT");
  const restored = allSpent
    ? await restoreExactOutputs(walletId, wallet, operation)
    : null;
  return {
    restored,
    evidence: {
      schemaVersion: 1,
      operationId: operation.operationId,
      requestFingerprint: authority.requestFingerprint,
      submissionState: submission,
      quote: null,
      inputStates,
      restore: restoreEvidence(restored),
    },
  };
}

type ExactRestoreResult = Awaited<
  ReturnType<typeof restoreDurableWalletOperationOutputs>
>;

interface RecoveryAssessment {
  evidence: DurableWalletOperationRecoveryEvidence;
  restored: ExactRestoreResult | null;
}

type RecoverySubmissionState = "not-submitted" | "submitted";

class ExternalRecoveryEvidenceUnavailable extends Error {}

class RetryableGuiWalletOperationFailure extends Error {}

class CapturedGuiWalletChanged extends Error {}

function restoreEvidence(
  restored: ExactRestoreResult | null,
): DurableWalletOperationRecoveryEvidence["restore"] {
  if (!restored) return { kind: "none" };
  return restored.kind === "partial" ? { kind: "partial" } : restored;
}

function restoreExactOutputs(
  walletId: string,
  wallet: Wallet,
  operation: DurableWalletOperation,
) {
  return restoreDurableWalletOperationOutputs(operation, {
    restoreVerifiedOutputGroups: async ({ outputs }) =>
      restoreVerifiedOutputGroups(walletId, wallet, outputs),
  });
}

async function restoreVerifiedOutputGroups(
  walletId: string,
  wallet: Wallet,
  groups: Readonly<Record<string, readonly OutputDataLike[]>>,
): Promise<Record<string, Proof[]>> {
  const allOutputs = Object.values(groups).flat();
  const byBlindedMessage = new Map(
    allOutputs.map((output) => [output.blindedMessage.B_, output]),
  );
  if (byBlindedMessage.size !== allOutputs.length) {
    throw new Error("GUI wallet restore plan contains duplicate outputs");
  }
  for (const keysetId of new Set(
    allOutputs.map(({ blindedMessage }) => blindedMessage.id),
  )) {
    await recoveryEvidencePortCall(walletId, () =>
      wallet.keyChain.ensureKeysetKeys(keysetId),
    );
  }
  const response = await recoveryEvidencePortCall(walletId, () =>
    wallet.mint.restore({
      outputs: allOutputs.map(({ blindedMessage }) => blindedMessage),
    }),
  );
  if (response.outputs.length !== response.signatures.length) {
    throw new Error("Mint returned a malformed NUT-09 response");
  }
  const restored = new Map<string, Proof>();
  response.outputs.forEach((message, index) => {
    const planned = byBlindedMessage.get(message.B_);
    const signature = response.signatures[index];
    if (!planned || !signature || restored.has(message.B_)) {
      throw new Error("Mint returned a foreign NUT-09 output");
    }
    restored.set(
      message.B_,
      planned.toProof(signature, wallet.getKeyset(planned.blindedMessage.id)),
    );
  });
  return Object.fromEntries(
    Object.entries(groups).map(([label, outputs]) => [
      label,
      outputs.flatMap((output) => {
        const proof = restored.get(output.blindedMessage.B_);
        return proof ? [proof] : [];
      }),
    ]),
  );
}

async function persistOperation(
  walletId: string,
  operation: DurableWalletOperation,
  activity: GuiDepositActivityMetadata | null,
): Promise<void> {
  await prepareProofOperationForWallet(
    walletId,
    guiOperationInput(operation, activity),
  );
}

async function loadExactOperation(
  walletId: string,
  operationId: string,
): Promise<DurableWalletOperation | null> {
  const record = await getProofOperationForWallet(walletId, operationId);
  if (!record) return null;
  const operation = decodeDurableWalletOperation(
    record.metadata.durableWalletOperation,
  );
  const activity = readGuiDepositActivityMetadata(record);
  const actual = deriveDurableCustodyProofOperationFingerprints(
    operationInputFromRecord(record),
  );
  const expected = deriveDurableCustodyProofOperationFingerprints(
    guiOperationInput(operation, activity),
  );
  if (
    operation.operationId !== operationId ||
    actual.requestFingerprint !== expected.requestFingerprint ||
    actual.outputPlanFingerprint !== expected.outputPlanFingerprint
  ) {
    throw new Error("GUI wallet operation identity is corrupt");
  }
  try {
    await persistOperation(walletId, operation, activity);
  } catch (error) {
    if (error instanceof GuiCustodyMintKeysUnavailable) {
      throw retryableWalletFailure(
        "GUI custody mint keys are unavailable",
        error,
      );
    }
    throw error;
  }
  assertCapturedWallet(walletId);
  return operation;
}

async function requireExactOperation(
  walletId: string,
  operationId: string,
): Promise<DurableWalletOperation> {
  const operation = await loadExactOperation(walletId, operationId);
  if (!operation) throw new Error("GUI wallet operation is missing");
  return operation;
}

function guiOperationInput(
  operation: DurableWalletOperation,
  activity: GuiDepositActivityMetadata | null,
): PrepareProofOperationInput {
  const input = normalizeGuiOperationInput(
    toDurableCustodyProofOperationInput(operation),
  );
  return activity === null
    ? input
    : {
        ...input,
        metadata: {
          ...input.metadata,
          [GUI_DEPOSIT_ACTIVITY_METADATA_KEY]: structuredClone(activity),
        },
      };
}

function operationInputFromRecord(
  record: ProofOperationRecord,
): PrepareProofOperationInput {
  return {
    operationId: record.operationId,
    kind: record.kind,
    mintUrl: record.mintUrl,
    inputs: structuredClone(record.inputs),
    outputs: structuredClone(record.outputs),
    metadata: structuredClone(record.metadata),
  };
}

function normalizeGuiOperationInput(
  input: ReturnType<typeof toDurableCustodyProofOperationInput>,
): PrepareProofOperationInput {
  if (input.kind !== "wallet-mint" && input.kind !== "wallet-receive") {
    throw new Error("Unsupported GUI ordinary wallet operation");
  }
  return {
    operationId: input.operationId,
    kind: input.kind,
    mintUrl: input.mintUrl,
    inputs: input.inputs.map((proof) => ({
      ...proof,
      amount: Amount.from(amountToNumber(proof.amount)),
    })) as Proof[],
    outputs: Object.fromEntries(
      Object.entries(input.outputs).map(([label, outputs]) => [
        label,
        outputs.map((output) => ({
          ...output,
          blindedMessage: {
            ...output.blindedMessage,
            amount: amountToNumber(output.blindedMessage.amount),
          },
        })),
      ]),
    ),
    metadata: structuredClone(input.metadata ?? {}),
  };
}

function mintOperationId(
  mintUrl: string,
  unit: CashuProofUnit,
  quoteId: string,
): string {
  return `wallet-mint:${deriveDurableCustodyArtifactFingerprint({ mintUrl, unit, quoteId })}`;
}

function receiveOperationId(
  mintUrl: string,
  unit: CashuProofUnit,
  proofs: readonly Proof[],
): string {
  const authority = proofs
    .map((proof) => ({
      id: proof.id,
      amount: amountToNumber(proof.amount),
      secret: proof.secret,
      C: proof.C,
      dleq: proof.dleq ?? null,
      p2pk_e: proof.p2pk_e ?? null,
      witness: proof.witness ?? null,
    }))
    .sort((left, right) =>
      `${left.id}:${left.secret}`.localeCompare(`${right.id}:${right.secret}`),
    );
  return `wallet-receive:${deriveDurableCustodyArtifactFingerprint({ mintUrl, unit, proofs: authority })}`;
}

async function walletForCapturedSeed(
  walletId: string,
  mintUrl: string,
  unit: CashuProofUnit,
): Promise<Wallet> {
  return fencedWalletCall(walletId, () =>
    getWalletForUnit(mintUrl, unit, { expectedWalletId: walletId }),
  );
}

async function walletForPersistedOperation(
  walletId: string,
  mintUrl: string,
  unit: CashuProofUnit,
): Promise<Wallet> {
  try {
    return await walletForCapturedSeed(walletId, mintUrl, unit);
  } catch (error) {
    if (error instanceof CapturedGuiWalletChanged) throw error;
    throw retryableWalletFailure("GUI wallet bootstrap is unavailable", error);
  }
}

async function dispatchForegroundExactOperation(
  walletId: string,
  operation: DurableWalletOperation,
): Promise<Proof[]> {
  try {
    return await dispatchExactOperation(walletId, operation);
  } catch (error) {
    if (error instanceof RetryableGuiWalletOperationFailure) {
      requestPersistedOperationRecovery(walletId);
    }
    throw error;
  }
}

function requestPersistedOperationRecovery(walletId: string): void {
  void import("./gui-native-proof-operation-recovery")
    .then(({ requestGuiNativeProofOperationRecovery }) => {
      if (currentGuiWalletId() !== walletId) return undefined;
      return requestGuiNativeProofOperationRecovery();
    })
    .catch(() => undefined);
}

async function fencedWalletCall<T>(
  walletId: string,
  action: () => Promise<T>,
): Promise<T> {
  assertCapturedWallet(walletId);
  const result = await action();
  assertCapturedWallet(walletId);
  return result;
}

async function exactTransportPortCall<T>(
  walletId: string,
  action: () => Promise<T>,
): Promise<T> {
  assertCapturedWallet(walletId);
  try {
    const result = await action();
    assertCapturedWallet(walletId);
    return result;
  } catch (error) {
    assertCapturedWallet(walletId);
    throw retryableWalletFailure(
      "GUI wallet transport result is unavailable",
      error,
    );
  }
}

function retryableWalletFailure(
  fallbackMessage: string,
  cause: unknown,
): RetryableGuiWalletOperationFailure {
  const message =
    cause instanceof Error && cause.message.length > 0
      ? cause.message
      : fallbackMessage;
  return new RetryableGuiWalletOperationFailure(message, { cause });
}

async function recoveryEvidencePortCall<T>(
  walletId: string,
  action: () => Promise<T>,
): Promise<T> {
  assertCapturedWallet(walletId);
  try {
    const result = await action();
    assertCapturedWallet(walletId);
    return result;
  } catch (error) {
    assertCapturedWallet(walletId);
    throw new ExternalRecoveryEvidenceUnavailable(undefined, {
      cause: error,
    });
  }
}

function assertCapturedWallet(walletId: string): void {
  if (currentGuiWalletId() !== walletId) {
    throw new CapturedGuiWalletChanged(
      "Active wallet seed changed during wallet operation",
    );
  }
}

function requireOperationIdentity<K extends "wallet-mint" | "wallet-receive">(
  operation: DurableWalletOperation,
  kind: K,
  mintUrl: string,
  unit: CashuProofUnit,
): asserts operation is Extract<DurableWalletOperation, { kind: K }> {
  if (
    operation.kind !== kind ||
    operation.mintUrl !== normalizeUrl(mintUrl) ||
    operation.unit !== unit
  ) {
    throw new Error("GUI wallet operation has foreign authority");
  }
}

function exactCompletedProofs(record: ProofOperationRecord): Proof[] {
  if (record.state !== "completed" || !record.resultProofs) {
    throw new Error("GUI wallet operation is not completed");
  }
  const labels = Object.keys(record.resultProofs);
  if (labels.length !== 1 || labels[0] !== "receive") {
    throw new Error("GUI wallet completed result is corrupt");
  }
  return structuredClone(record.resultProofs.receive ?? []);
}

function requireMintQuoteState(value: unknown): "UNPAID" | "PAID" | "ISSUED" {
  if (value === "UNPAID" || value === "PAID" || value === "ISSUED") {
    return value;
  }
  throw new Error("Mint returned an unknown quote state");
}

function requireExactMintQuote(
  value: MintQuoteResponse,
  quoteId: string,
  unit: CashuProofUnit,
  amount: number,
  expectedExpiryUnixSeconds?: number | null,
): {
  state: "UNPAID" | "PAID" | "ISSUED";
  expiryUnixSeconds: number | null;
} {
  let returnedAmount: number;
  try {
    returnedAmount = amountToNumber(value.amount);
  } catch {
    throw new Error("Mint returned a foreign quote authority");
  }
  const expiryUnixSeconds = requireMintQuoteExpiry(value.expiry);
  if (
    typeof quoteId !== "string" ||
    quoteId.length === 0 ||
    value.quote !== quoteId ||
    value.unit !== unit ||
    returnedAmount !== amount ||
    typeof value.request !== "string" ||
    value.request.length === 0 ||
    (expectedExpiryUnixSeconds !== undefined &&
      expiryUnixSeconds !== expectedExpiryUnixSeconds)
  ) {
    throw new Error("Mint returned a foreign quote authority");
  }
  return {
    state: requireMintQuoteState(value.state),
    expiryUnixSeconds,
  };
}

function requireMintQuoteExpiry(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error("Mint returned a foreign quote authority");
  }
  return value as number;
}

function submissionState(
  record: ProofOperationRecord,
): RecoverySubmissionState {
  switch (record.state) {
    case "prepared":
      return "not-submitted";
    case "mint-submitted":
      return "submitted";
    case "completed":
    case "Failed":
      throw new Error("Terminal GUI wallet operation cannot be recovered");
  }
}

function requireProofState(value: unknown): "UNSPENT" | "PENDING" | "SPENT" {
  switch (value) {
    case CheckStateEnum.UNSPENT:
    case CheckStateEnum.PENDING:
    case CheckStateEnum.SPENT:
      return value;
    default:
      throw new Error("Mint returned an unknown proof state");
  }
}

function requireUnit(value: string): CashuProofUnit {
  if (value === "sat" || value === "msat" || value === "usd") return value;
  throw new Error("GUI wallet operation has an unsupported Cashu unit");
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
