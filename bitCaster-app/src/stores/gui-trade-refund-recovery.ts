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
import type {
  DurableRefundSalvageEvidence,
  DurableTradeProofOperationLink,
} from "@bitcaster/client-sdk/durableTradeRecovery";
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
  requireDurableWalletProofTransition,
} from "@bitcaster/client-sdk/durableWalletProofTransition";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  inspectExactPreparedProofOperation,
  restoreExactPreparedProofOperation,
  type ProofOperationRecord as SwapProofOperationRecord,
} from "@bitcaster/swap-protocol/atomicSwap";
import type { ActiveSwap } from "./activeSwaps";
import {
  getProofOperationUnderLock,
  db,
  ensureDurableSwapStorage,
  requireProofOperationRecord,
  type ProofOperationRecord,
} from "./proof-db";
import {
  loadGuiDurableTradeSessionUnderLock,
  markGuiProofOperationMintSubmittedWithSessionUnderLock,
  prepareGuiProofOperationWithSessionUnderLock,
  resolveGuiProofOperationPreparation,
  withGuiSwapSessionOwnership,
} from "./swap-session-db";
import { useWalletStore } from "./wallet";
import {
  walletIdFromHeldGuiWalletLock,
  type GuiWalletLockContext,
} from "./gui-wallet-lock";

const GUI_TRADE_PROOF_OPERATION_LIMIT = 16;
const GUI_EXPIRED_REFUND_OPERATION_STEP = "expired-refund";

export type GuiTradeRefundPreparation =
  | { kind: "not-due"; retryAtMs: number }
  | { kind: "no-locked-value" }
  | { kind: "ready"; operation: DurableTradeProofOperationLink }
  | { kind: "completed" };

export function guiTradeRefundDueAtMs(swap: ActiveSwap): number {
  const locktime =
    swap.role === "seller" ? swap.sellerLocktime : swap.buyerLocktime;
  if (!swap.role || locktime === null || !Number.isSafeInteger(locktime)) {
    throw new Error("Durable GUI refund is missing its exact locktime");
  }
  return locktime * 1_000;
}

export function isGuiTradeRefundLink(
  operation: DurableTradeProofOperationLink,
): boolean {
  return operation.stage === "refund";
}

export async function prepareGuiTradeRefund(
  swap: ActiveSwap,
  nowMs: number,
  walletId: string,
): Promise<GuiTradeRefundPreparation> {
  const retryAtMs = guiTradeRefundDueAtMs(swap);
  if (nowMs < retryAtMs) return { kind: "not-due", retryAtMs };
  const operationId = `${swap.tradeId}/browser/${GUI_EXPIRED_REFUND_OPERATION_STEP}`;
  const existing = await withGuiSwapSessionOwnership(
    swap.tradeId,
    (lock) => getProofOperationUnderLock(lock, operationId),
    walletId,
  );
  if (existing) {
    return withGuiSwapSessionOwnership(
      swap.tradeId,
      (lock) => advanceExistingRefund(lock, swap, existing),
      walletId,
    );
  }

  const locked = await withGuiSwapSessionOwnership(
    swap.tradeId,
    (lock) => loadExactLockedProofs(lock, swap),
    walletId,
  );
  if (locked === null) return { kind: "no-locked-value" };
  const wallet = await useWalletStore
    .getState()
    .getWalletForUnit(requireMintUrl(swap), locked.unit, {
      expectedWalletId: walletId,
      enableCtf: locked.requiresCtf,
    });
  const preview = await wallet.prepareSwapToReceive(
    getEncodedToken({
      mint: requireMintUrl(swap),
      unit: locked.unit,
      proofs: locked.proofs,
    }),
    undefined,
    { type: "random" },
  );
  const input = refundOperationInput(
    operationId,
    swap,
    locked.proofs,
    locked.unit,
    locked.requiresCtf,
    preview,
  );
  const resolved = await resolveGuiProofOperationPreparation(input, swap);
  return withGuiSwapSessionOwnership(
    swap.tradeId,
    async (lock) => {
      const operation = await prepareGuiProofOperationWithSessionUnderLock(
        lock,
        input,
        swap,
        resolved,
      );
      return advanceExistingRefund(lock, swap, operation);
    },
    walletId,
  );
}

export async function guiTradeRefundEvidenceUnderLock(
  lock: GuiWalletLockContext,
  swap: ActiveSwap,
  operation: DurableTradeProofOperationLink,
): Promise<(DurableRefundSalvageEvidence & { privateKeyHex: string }) | null> {
  if (!isGuiTradeRefundLink(operation)) return null;
  const session = await loadGuiDurableTradeSessionUnderLock(lock, swap.tradeId);
  if (!session) return null;
  return {
    tradeId: session.tradeId,
    role: session.role,
    localProtocolPubkey: session.localProtocolPubkey,
    counterpartyProtocolPubkey: session.counterpartyProtocolPubkey,
    mintUrl: session.mintUrl,
    sellerLocktimeSecs: session.sellerLocktimeSecs,
    buyerLocktimeSecs: session.buyerLocktimeSecs,
    keyHandle: session.ephemeralKeyHandle,
    proofOperation: structuredClone(operation),
    privateKeyHex: swap.ephemeralPrivkeyHex,
  };
}

export async function salvageGuiTradeRefund(
  swap: ActiveSwap,
  operation: DurableTradeProofOperationLink,
  walletId: string,
): Promise<Record<string, Proof[]>> {
  const entry = await withGuiSwapSessionOwnership(
    swap.tradeId,
    (lock) => findExactOperation(lock, operation),
    walletId,
  );
  if (entry.kind !== "swap-refund") {
    throw new Error("Durable GUI refund link targets another operation kind");
  }
  const wallet = await useWalletStore
    .getState()
    .getWalletForUnit(entry.mintUrl, requireUnit(entry), {
      expectedWalletId: walletId,
      enableCtf: requireBooleanMetadata(entry, "enableCtf"),
    });
  const state = await inspectExactPreparedProofOperation(
    wallet,
    entry as unknown as SwapProofOperationRecord,
  );
  const result =
    state === "all-spent"
      ? await restoreExactPreparedProofOperation(
          entry as unknown as SwapProofOperationRecord,
        )
      : state === "all-unspent"
        ? {
            refund: (
              await wallet.completeSwap(
                refundSwapPreview(entry),
                swap.ephemeralPrivkeyHex,
              )
            ).keep,
          }
        : null;
  if (!result)
    throw new Error("Durable GUI refund remains pending at the mint");
  return { refund: requireExactRefundResult(entry, result.refund) };
}

async function advanceExistingRefund(
  lock: GuiWalletLockContext,
  swap: ActiveSwap,
  operation: ProofOperationRecord,
): Promise<GuiTradeRefundPreparation> {
  assertRefundOperation(operation, swap);
  if (operation.state === "completed") return { kind: "completed" };
  if (operation.state === "Failed") {
    throw new Error("Durable GUI refund is terminally failed");
  }
  const submitted =
    operation.state === "prepared"
      ? await markGuiProofOperationMintSubmittedWithSessionUnderLock(
          lock,
          operation.operationId,
          swap,
          requireMintUrl(swap),
        )
      : operation;
  const link = submitted.durableTradeRecovery;
  if (!link || !isGuiTradeRefundLink(link) || link.state !== "mint-submitted") {
    throw new Error("Durable GUI refund has no submitted SDK binding");
  }
  return { kind: "ready", operation: structuredClone(link) };
}

async function loadExactLockedProofs(
  lock: GuiWalletLockContext,
  swap: ActiveSwap,
): Promise<{
  proofs: Proof[];
  unit: string;
  requiresCtf: boolean;
} | null> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  await ensureDurableSwapStorage(walletId);
  const rows = (
    await db.proofOperations
      .where("[walletId+durableTradeId]")
      .equals([walletId, swap.tradeId])
      .limit(GUI_TRADE_PROOF_OPERATION_LIMIT + 1)
      .toArray()
  ).map((row) => requireProofOperationRecord(row, walletId, row.operationId));
  if (rows.length > GUI_TRADE_PROOF_OPERATION_LIMIT) {
    throw new Error("Durable GUI trade proof-operation capacity is corrupt");
  }
  const proofs: Proof[] = [];
  const units = new Set<string>();
  let requiresCtf = false;
  for (const row of rows) {
    if (row.state !== "completed") continue;
    const group = lockedResultGroup(row);
    if (group.length === 0) continue;
    proofs.push(...group);
    units.add(requireUnit(row));
    requiresCtf ||=
      row.kind === "conditional-keyset-swap" || row.kind === "ctf-split";
  }
  if (proofs.length === 0) return null;
  if (units.size !== 1)
    throw new Error("Durable GUI refund has mixed Cashu units");
  return { proofs, unit: [...units][0]!, requiresCtf };
}

function lockedResultGroup(operation: ProofOperationRecord): Proof[] {
  if (
    operation.kind !== "swap-lock" &&
    operation.kind !== "conditional-keyset-swap" &&
    operation.kind !== "ctf-split"
  ) {
    return [];
  }
  const transition = requireDurableWalletProofTransition(
    operation.metadata,
    Object.keys(operation.outputs),
  );
  const locked = Object.entries(transition.resultGroups).flatMap(
    ([group, disposition]) =>
      disposition.kind === "operation"
        ? (operation.resultProofs?.[group] ?? [])
        : [],
  );
  return normalizeCashuProofs(locked);
}

function refundOperationInput(
  operationId: string,
  swap: ActiveSwap,
  inputs: Proof[],
  unit: string,
  enableCtf: boolean,
  preview: SwapPreview,
) {
  return {
    operationId,
    kind: "swap-refund" as const,
    mintUrl: requireMintUrl(swap),
    inputs,
    outputs: { refund: serializeOutputDataArray(preview.keepOutputs ?? []) },
    metadata: addDurableWalletProofTransitionMetadata(
      {
        unit,
        amount: amountToNumber(preview.amount),
        fees: amountToNumber(preview.fees),
        keysetId: preview.keysetId,
        enableCtf,
        unselectedProofs: [],
      },
      createDurableWalletProofTransition({
        inputSource: "external",
        plannedOutputLabels: ["refund"],
        resultGroups: {
          refund: { kind: "wallet", asset: "regular", reservedBy: null },
        },
      }),
    ),
  };
}

async function findExactOperation(
  lock: GuiWalletLockContext,
  operation: DurableTradeProofOperationLink,
): Promise<ProofOperationRecord> {
  const walletId = walletIdFromHeldGuiWalletLock(lock);
  const storedRow = await db.proofOperations
    .where("[walletId+durableOperationId]")
    .equals([walletId, operation.operationId])
    .first();
  const row = storedRow
    ? requireProofOperationRecord(storedRow, walletId, storedRow.operationId)
    : undefined;
  const link = row?.durableTradeRecovery;
  if (
    !row ||
    !link ||
    row.operationId !== operation.operationKey ||
    row.durableOperationId !== operation.operationId ||
    row.durableTradeId !== operation.tradeId ||
    link.operationId !== operation.operationId ||
    link.operationKey !== operation.operationKey ||
    link.tradeId !== operation.tradeId ||
    link.role !== operation.role ||
    link.stage !== operation.stage ||
    link.kind !== operation.kind ||
    link.state !== operation.state
  ) {
    throw new Error("Durable GUI refund operation is missing");
  }
  return row;
}

function refundSwapPreview(operation: ProofOperationRecord): SwapPreview {
  const outputs = deserializeOutputGroups({
    refund: operation.outputs.refund ?? [],
  });
  return {
    amount: Amount.from(requireNumberMetadata(operation, "amount")),
    fees: Amount.from(requireNumberMetadata(operation, "fees")),
    keysetId: requireStringMetadata(operation, "keysetId"),
    inputs: normalizeCashuProofs(operation.inputs),
    sendOutputs: [],
    keepOutputs: outputs.refund ?? [],
    unselectedProofs: [],
  };
}

function normalizeCashuProofs(proofs: Proof[]): Proof[] {
  return proofs.map((proof) => ({
    ...structuredClone(proof),
    amount: Amount.from(amountToNumber(proof.amount)),
  }));
}

function requireExactRefundResult(
  operation: ProofOperationRecord,
  value: Proof[] | undefined,
): Proof[] {
  if (!Array.isArray(value))
    throw new Error("Durable GUI refund result is missing");
  const outputs = operation.outputs.refund ?? [];
  const expectedSecrets = new Set(outputs.map(({ secret }) => secret));
  const actualSecrets = new Set(value.map(({ secret }) => secret));
  const expectedAmount = outputs.reduce(
    (sum, output) => sum + output.blindedMessage.amount,
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
    throw new Error("Durable GUI refund result conflicts with exact outputs");
  }
  return normalizeCashuProofs(value);
}

function assertRefundOperation(
  operation: ProofOperationRecord,
  swap: ActiveSwap,
): void {
  if (
    operation.kind !== "swap-refund" ||
    operation.mintUrl !== requireMintUrl(swap) ||
    operation.durableTradeRecovery?.tradeId !== swap.tradeId ||
    operation.durableTradeRecovery.stage !== "refund"
  ) {
    throw new Error("Durable GUI refund operation conflicts with its swap");
  }
}

function requireMintUrl(swap: ActiveSwap): string {
  if (!swap.mintUrl) throw new Error("Durable GUI refund has no exact mint");
  return swap.mintUrl;
}

function requireUnit(operation: ProofOperationRecord): string {
  const value = operation.metadata.unit;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Durable GUI refund has no exact Cashu unit");
  }
  return value;
}

function requireNumberMetadata(
  operation: ProofOperationRecord,
  key: string,
): number {
  const value = operation.metadata[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Durable GUI refund metadata ${key} is invalid`);
  }
  return value;
}

function requireStringMetadata(
  operation: ProofOperationRecord,
  key: string,
): string {
  const value = operation.metadata[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Durable GUI refund metadata ${key} is invalid`);
  }
  return value;
}

function requireBooleanMetadata(
  operation: ProofOperationRecord,
  key: string,
): boolean {
  const value = operation.metadata[key];
  if (typeof value !== "boolean") {
    throw new Error(`Durable GUI refund metadata ${key} is invalid`);
  }
  return value;
}
