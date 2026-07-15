import {
  Amount,
  getEncodedToken,
  type Proof,
  type SwapPreview,
} from "@cashu/cashu-ts";
import {
  deserializeOutputGroups,
  serializeOutputDataArray,
} from "@bitcaster/client-sdk/ctfSplit";
import {
  parseCashuProofUnit,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
} from "@bitcaster/client-sdk/durableWalletProofTransition";
import {
  inspectExactPreparedProofOperation,
  restoreExactPreparedProofOperation,
  type ProofOperationRecord as SwapProofOperationRecord,
} from "@bitcaster/swap-protocol/atomicSwap";
import { validateDurableProofOperationLink } from "@bitcaster/client-sdk/durableTradeRecovery";
import {
  currentGuiWalletId,
  getProofOperationUnderLock,
  getReservedProofsUnderLock,
  type ProofOperationRecord,
} from "@/stores/proof-db";
import {
  completeGuiProofOperationWithSessionUnderLock,
  loadGuiSwapSessionStateUnderLock,
  markGuiProofOperationMintSubmittedWithSessionUnderLock,
  prepareGuiProofOperationWithSessionUnderLock,
  resolveGuiProofOperationPreparation,
  withGuiSwapSessionOwnership,
} from "@/stores/swap-session-db";
import {
  getGuiPartialLockFailureUnderLock,
  listElapsedGuiPartialLockFailures,
  removeGuiPartialLockFailureUnderLock,
} from "@/stores/partial-lock-failure-db";
import type { GuiPartialLockFailureRecord } from "@/stores/partial-lock-failure-model";
import { samePaymentProofSet } from "@/stores/pending-local-wallet-payment-model";
import type { CashuProofArtifactLike } from "@bitcaster/client-sdk/proofSelection";
import type { ActiveSwap } from "@/stores/activeSwaps";
import { useWalletStore } from "@/stores/wallet";
import type { GuiWalletLockContext } from "@/stores/gui-wallet-lock";

const PARTIAL_LOCK_REFUND_MARGIN_SECS = 60;

export async function sweepElapsedPartialLockFailures(): Promise<void> {
  const nowSecs = Math.floor(Date.now() / 1_000);
  const records = await listElapsedGuiPartialLockFailures(
    Math.max(0, nowSecs - PARTIAL_LOCK_REFUND_MARGIN_SECS),
  );

  for (const record of records) {
    await sweepPartialLockUnderProfileLock(record.tradeId).catch(() => {
      console.warn("[swap.partial-lock-refund]", {
        tradeId: record.tradeId,
        code: "refund-deferred",
      });
    });
  }
}

async function sweepPartialLockUnderProfileLock(
  tradeId: string,
): Promise<void> {
  const walletId = currentGuiWalletId();
  const authority = await withGuiSwapSessionOwnership(
    tradeId,
    (lock) => loadPartialLockSweepAuthority(tradeId, lock),
    walletId,
  );
  if (!authority) return;
  await sweepOnePartialLockFailure(authority, walletId);
}

interface PartialLockSweepAuthority {
  record: GuiPartialLockFailureRecord;
  swap: ActiveSwap;
  locked: Proof[];
  operation: ProofOperationRecord | null;
}

async function loadPartialLockSweepAuthority(
  tradeId: string,
  lock: GuiWalletLockContext,
): Promise<PartialLockSweepAuthority | null> {
  const record = await getGuiPartialLockFailureUnderLock(lock, tradeId);
  if (!record) return null;
  const swap = await loadGuiSwapSessionStateUnderLock(lock, tradeId);
  if (!swap) {
    throw new Error(
      "Partial-lock refund has no exact persisted swap authority",
    );
  }
  assertRefundLocktime(record, swap);

  const locked = await getReservedProofsUnderLock(lock, tradeId);
  if (locked.length === 0) {
    const operationId = `${tradeId}/browser/partial-lock-refund`;
    const operation = await getProofOperationUnderLock(lock, operationId);
    requireExactCompletedRefundCleanupAuthority(
      record,
      swap,
      operationId,
      operation,
    );
    await removeGuiPartialLockFailureUnderLock(lock, tradeId);
    return null;
  }
  const operationId = `${tradeId}/browser/partial-lock-refund`;
  const operation = await getProofOperationUnderLock(lock, operationId);
  return { record, swap, locked, operation };
}

async function sweepOnePartialLockFailure(
  authority: PartialLockSweepAuthority,
  walletId: string,
): Promise<void> {
  const { record, swap, locked } = authority;
  const unit = unitForLockedProofs(locked);
  const operationId = `${record.tradeId}/browser/partial-lock-refund`;
  let operation = authority.operation;
  const wallet = await useWalletStore
    .getState()
    .getWalletForUnit(record.mintUrl, unit, {
      expectedWalletId: walletId,
    });
  if (!operation) {
    const preview = await wallet.prepareSwapToReceive(
      getEncodedToken({ mint: record.mintUrl, unit, proofs: locked }),
      undefined,
      { type: "random" },
    );
    const input = refundOperationInput(
      operationId,
      record,
      locked,
      unit,
      preview,
    );
    const resolved = await resolveGuiProofOperationPreparation(input, swap);
    operation = await withGuiSwapSessionOwnership(
      record.tradeId,
      (lock) =>
        prepareGuiProofOperationWithSessionUnderLock(
          lock,
          input,
          swap,
          resolved,
        ),
      walletId,
    );
  }

  await recoverOrCompleteRefund(
    operation,
    wallet,
    swap.ephemeralPrivkeyHex,
    swap,
    record,
    walletId,
  );
  await withGuiSwapSessionOwnership(
    record.tradeId,
    (lock) => removeGuiPartialLockFailureUnderLock(lock, record.tradeId),
    walletId,
  );
}

function requireExactCompletedRefundCleanupAuthority(
  record: GuiPartialLockFailureRecord,
  swap: ActiveSwap,
  operationId: string,
  operation: ProofOperationRecord | null,
): void {
  const link = operation?.durableTradeRecovery;
  if (
    !operation ||
    operation.operationId !== operationId ||
    operation.kind !== "swap-refund" ||
    operation.state !== "completed" ||
    operation.mintUrl !== record.mintUrl ||
    operation.metadata.tradeId !== record.tradeId ||
    operation.metadata.refundLocktime !== record.refundLocktime ||
    !samePaymentProofSet(
      operation.inputs,
      exactLockedProofIdentities(record),
    ) ||
    !link ||
    validateDurableProofOperationLink(link) !== null ||
    link.operationKey !== operationId ||
    link.tradeId !== record.tradeId ||
    link.role !== swap.role ||
    link.stage !== "refund" ||
    link.state !== "reconciled" ||
    operation.durableOperationId !== link.operationId ||
    operation.durableTradeId !== link.tradeId ||
    typeof operation.custodyOperationId !== "string" ||
    operation.custodyOperationId.length === 0
  ) {
    throw new Error("Missing exact completed partial-lock refund authority");
  }
  requireExactRefundResult(operation, operation.resultProofs?.refund);
}

function exactLockedProofIdentities(
  record: GuiPartialLockFailureRecord,
): CashuProofArtifactLike[] {
  return record.lockedProofs.map((proof) => {
    if (!proof.id) {
      throw new Error("Partial-lock refund input keyset is missing");
    }
    return {
      ...proof,
      id: proof.id,
      amount: proof.amount as Proof["amount"],
    };
  });
}

async function recoverOrCompleteRefund(
  operation: ProofOperationRecord,
  wallet: Awaited<
    ReturnType<ReturnType<typeof useWalletStore.getState>["getWallet"]>
  >,
  refundPrivateKey: string,
  swap: ActiveSwap,
  failure: GuiPartialLockFailureRecord,
  walletId: string,
): Promise<void> {
  if (operation.state === "Failed") {
    throw new Error("Partial-lock refund operation is terminally failed");
  }
  if (operation.state === "completed") {
    throw new Error(
      "Completed partial-lock refund still owns its exact input proofs",
    );
  }
  const exact = operation as unknown as SwapProofOperationRecord;
  const state = await inspectExactPreparedProofOperation(wallet, exact);
  let result: Record<string, Proof[]>;
  if (state === "all-spent") {
    result = await restoreExactPreparedProofOperation(exact);
  } else if (state === "all-unspent") {
    await withGuiSwapSessionOwnership(
      swap.tradeId,
      (lock) =>
        markGuiProofOperationMintSubmittedWithSessionUnderLock(
          lock,
          operation.operationId,
          swap,
          failure.mintUrl,
        ),
      walletId,
    );
    const completed = await wallet.completeSwap(
      refundSwapPreview(operation),
      refundPrivateKey,
    );
    result = { refund: completed.keep };
  } else {
    throw new Error("Partial-lock refund remains pending or mixed at the mint");
  }
  const refund = requireExactRefundResult(operation, result.refund);
  await withGuiSwapSessionOwnership(
    swap.tradeId,
    (lock) =>
      completeGuiProofOperationWithSessionUnderLock(
        lock,
        operation.operationId,
        { refund },
        swap,
        failure.mintUrl,
      ),
    walletId,
  );
}

function refundOperationInput(
  operationId: string,
  record: GuiPartialLockFailureRecord,
  inputs: Proof[],
  unit: CashuProofUnit,
  preview: SwapPreview,
) {
  const resultPolicy = createDurableWalletProofTransition({
    inputSource: "wallet",
    plannedOutputLabels: ["refund"],
    resultGroups: {
      refund: {
        kind: "wallet",
        asset: "conditional",
        reservedBy: null,
      },
    },
  });
  const conditionIds = new Set(
    Object.values(record.outcomeByKeyset).map(({ conditionId }) => conditionId),
  );
  if (conditionIds.size !== 1) {
    throw new Error("Partial-lock refund has mixed condition metadata");
  }
  const conditionId = [...conditionIds][0];
  if (!conditionId) {
    throw new Error("Partial-lock refund has no condition metadata");
  }
  return {
    operationId,
    kind: "swap-refund" as const,
    mintUrl: record.mintUrl,
    inputs,
    outputs: { refund: serializeOutputDataArray(preview.keepOutputs ?? []) },
    metadata: addDurableWalletProofTransitionMetadata(
      {
        tradeId: record.tradeId,
        refundLocktime: record.refundLocktime,
        affectedKeysets: record.affectedKeysets,
        amount: amountToNumber(preview.amount),
        fees: amountToNumber(preview.fees),
        keysetId: preview.keysetId,
        unit,
        unselectedProofs: [],
        conditionId,
        outcomeByKeyset: record.outcomeByKeyset,
      },
      resultPolicy,
    ),
  };
}

function refundSwapPreview(operation: ProofOperationRecord): SwapPreview {
  const refundOutputs =
    deserializeOutputGroups({ refund: operation.outputs.refund ?? [] })
      .refund ?? [];
  return {
    amount: Amount.from(requireNumberMetadata(operation, "amount")),
    fees: Amount.from(requireNumberMetadata(operation, "fees")),
    keysetId: requireStringMetadata(operation, "keysetId"),
    inputs: operation.inputs,
    keepOutputs: refundOutputs,
  } as SwapPreview;
}

function requireExactRefundResult(
  operation: ProofOperationRecord,
  value: Proof[] | undefined,
): Proof[] {
  if (!Array.isArray(value)) {
    throw new Error("Partial-lock refund result is missing");
  }
  const outputs = operation.outputs.refund ?? [];
  const expectedSecrets = new Set(outputs.map((output) => output.secret));
  const actualSecrets = new Set(value.map((proof) => proof.secret));
  const expectedAmount = outputs.reduce(
    (sum, output) => sum + amountToNumber(output.blindedMessage.amount),
    0,
  );
  const actualAmount = value.reduce(
    (sum, proof) => sum + amountToNumber(proof.amount),
    0,
  );
  if (
    value.length !== outputs.length ||
    actualSecrets.size !== expectedSecrets.size ||
    [...expectedSecrets].some((secret) => !actualSecrets.has(secret)) ||
    actualAmount !== expectedAmount
  ) {
    throw new Error("Partial-lock refund result does not match exact outputs");
  }
  return structuredClone(value);
}

function assertRefundLocktime(
  record: GuiPartialLockFailureRecord,
  swap: ActiveSwap,
): void {
  const ownLocktime =
    swap.role === "seller" ? swap.sellerLocktime : swap.buyerLocktime;
  if (ownLocktime !== record.refundLocktime) {
    throw new Error("Partial-lock refund locktime is not bound to the swap");
  }
}

function requireNumberMetadata(
  operation: ProofOperationRecord,
  key: string,
): number {
  const value = operation.metadata[key];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Partial-lock refund metadata ${key} is invalid`);
  }
  return value as number;
}

function requireStringMetadata(
  operation: ProofOperationRecord,
  key: string,
): string {
  const value = operation.metadata[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Partial-lock refund metadata ${key} is invalid`);
  }
  return value;
}

function unitForLockedProofs(
  proofs: Array<Proof & { unit?: unknown }>,
): CashuProofUnit {
  const units = new Set<CashuProofUnit>();
  for (const proof of proofs) {
    const unit =
      typeof proof.unit === "string" ? parseCashuProofUnit(proof.unit) : null;
    if (!unit) {
      throw new Error(
        `Cannot refund partial lock without exact Cashu unit for keyset ${proof.id ?? "<missing>"}`,
      );
    }
    units.add(unit);
  }
  if (units.size !== 1) {
    throw new Error(
      `Cannot refund partial lock with mixed Cashu units: ${[...units].join(",")}`,
    );
  }
  const unit = [...units][0];
  if (!unit)
    throw new Error("Cannot refund partial lock without locked proofs");
  return unit;
}
