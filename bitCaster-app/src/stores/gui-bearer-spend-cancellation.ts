import Dexie from "dexie";
import { Amount, type Proof } from "@cashu/cashu-ts";
import {
  completeDurableBearerSpendReclaim,
  issueDurableBearerSpendReclaimCompletionCapability,
  planDurableBearerSpendReclaimIntent,
  reduceDurableBearerSpendReclaimLineage,
  replaceDurableBearerSpendReclaimIntent,
  selectDurableBearerSpendUnspentProofs,
  type DurableBearerSpendDeliveryRecord,
  type DurableBearerSpendReclaimIntent,
} from "@bitcaster/client-sdk/durableBearerSpendDelivery";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  decodeOperationRow,
  type DexieCustodyOperationRow,
} from "./durable-custody-dexie-model";
import {
  guiWalletContextForWallet,
  withGuiCustodyProfileLockForWallet,
} from "./gui-custody-authority";
import {
  createGuiBearerSpendDeliveryRow,
  requireGuiBearerSpendDeliveryRow,
  requireGuiBearerSpendDeliveryRowWithinByteBound,
} from "./gui-bearer-spend-delivery";
import {
  reconcileGuiBearerSpendDeliveryNow,
  requestGuiBearerSpendRecovery,
} from "./gui-bearer-spend-recovery";
import {
  readGuiBearerSpendReclaimBinding,
  sameGuiBearerSpendReclaimBinding,
  type GuiBearerSpendReclaimBinding,
} from "./gui-bearer-spend-reclaim-binding";
import { requireGuiDexieWriteTransaction } from "./gui-dexie-transaction";
import {
  dispatchGuiBearerReclaimOperation,
  prepareGuiBearerReclaimOperation,
} from "./gui-ordinary-wallet-operation";
import {
  readGuiWalletSendDeliveryMetadata,
  requireGuiWalletSendDeliveryPayloadRow,
  type GuiWalletSendDeliveryPayloadRow,
} from "./gui-wallet-send-delivery";
import { requireGuiWalletSendBearerAuthority } from "./gui-wallet-proof-operation-custody";
import { useWalletStore } from "./wallet";
import {
  currentGuiWalletId,
  db,
  ensureDurableSwapStorage,
  proofOperationPrimaryKey,
  rehydrateStoredProofGroups,
  requireProofOperationRecord,
  type ProofOperationRecord,
} from "./proof-db";

export interface GuiBearerSpendCancellationPreview {
  operationId: string;
  deliveryId: string;
  mintUrl: string;
  amount: number;
  fee: number;
  returnedAmount: number;
  proofCount: number;
  partial: boolean;
  fingerprint: string;
}

export type GuiBearerSpendCancellationResult =
  | {
      kind: "completed";
      preview: GuiBearerSpendCancellationPreview;
      returnedProofs: Proof[];
    }
  | {
      kind: "changed";
      preview: GuiBearerSpendCancellationPreview;
    };

export interface PendingGuiBearerSpendReapproval {
  operationId: string;
  preview: GuiBearerSpendCancellationPreview;
}

interface BearerMutationSnapshot {
  operation: ProofOperationRecord;
  payload: GuiWalletSendDeliveryPayloadRow | undefined;
  record: DurableBearerSpendDeliveryRecord;
  custody: ReturnType<typeof decodeOperationRow>;
}

interface PreparedBearerMutation {
  nextRecord: DurableBearerSpendDeliveryRecord;
  nextRow: ReturnType<typeof createGuiBearerSpendDeliveryRow>;
  deletePayload: boolean;
}

export async function inspectGuiBearerSpendCancellation(
  operationId: string,
): Promise<GuiBearerSpendCancellationPreview> {
  const walletId = currentGuiWalletId();
  const record = await reconcileGuiBearerSpendDeliveryNow(
    walletId,
    operationId,
  );
  return cancellationPreview(walletId, operationId, record);
}

export async function findPendingGuiBearerSpendReapproval(): Promise<PendingGuiBearerSpendReapproval | null> {
  const walletId = currentGuiWalletId();
  await ensureDurableSwapStorage(walletId);
  await requestGuiBearerSpendRecovery();
  const rawRow = await db.bearerSpendDeliveries
    .where("[walletId+active+reclaimPrepared+updatedAtMs+deliveryId]")
    .between(
      [walletId, 1, 1, 0, Dexie.minKey],
      [walletId, 1, 1, Number.MAX_SAFE_INTEGER, Dexie.maxKey],
    )
    .first();
  if (!rawRow) return null;
  const row = requireGuiBearerSpendDeliveryRow(rawRow, walletId);
  const operationId = operationIdFromPayloadHandle(row.payloadHandle);
  const record = await reconcileGuiBearerSpendDeliveryNow(
    walletId,
    operationId,
  );
  if (record.reclaim.kind !== "prepared") return null;
  const preview = await cancellationPreview(walletId, operationId, record);
  if (preview.fingerprint === record.reclaim.requestFingerprint) {
    await resumeGuiBearerSpendCancellation(walletId, operationId, record);
    return null;
  }
  return { operationId, preview };
}

export async function cancelGuiBearerSpend(
  operationId: string,
  expectedPreviewFingerprint: string,
): Promise<GuiBearerSpendCancellationResult> {
  const walletId = currentGuiWalletId();
  const before = await reconcileGuiBearerSpendDeliveryNow(
    walletId,
    operationId,
  );
  const beforePreview = await cancellationPreview(
    walletId,
    operationId,
    before,
  );
  if (beforePreview.fingerprint !== expectedPreviewFingerprint) {
    return { kind: "changed", preview: beforePreview };
  }
  const intent = planDurableBearerSpendReclaimIntent(before, {
    requestFingerprint: expectedPreviewFingerprint,
    approvedFee: beforePreview.fee.toString(),
    approvedReturnAmount: beforePreview.returnedAmount.toString(),
  });
  await journalReclaimIntent(walletId, operationId, intent);
  const rechecked = await reconcileGuiBearerSpendDeliveryNow(
    walletId,
    operationId,
  );
  const exactPreview = await cancellationPreview(
    walletId,
    operationId,
    rechecked,
  );
  if (exactPreview.fingerprint !== expectedPreviewFingerprint) {
    return { kind: "changed", preview: exactPreview };
  }
  const proofs = selectDurableBearerSpendUnspentProofs(rechecked);
  const plan = await prepareGuiBearerReclaimOperation({
    expectedWalletId: walletId,
    record: rechecked,
    intent,
    proofs,
  });
  await markReclaimSubmitted(walletId, operationId, intent);
  const returnedProofs = await dispatchGuiBearerReclaimOperation(plan);
  await finalizeReclaim(walletId, operationId, plan.binding);
  return { kind: "completed", preview: exactPreview, returnedProofs };
}

export async function resumeGuiBearerSpendCancellation(
  walletId: string,
  operationId: string,
  record: DurableBearerSpendDeliveryRecord,
): Promise<"completed" | "approval-changed"> {
  if (record.reclaim.kind !== "prepared") {
    throw new Error("GUI bearer reclaim is not prepared");
  }
  const preview = await cancellationPreview(walletId, operationId, record);
  if (preview.fingerprint !== record.reclaim.requestFingerprint) {
    return "approval-changed";
  }
  const intent = {
    operationId: record.reclaim.operationId,
    requestFingerprint: record.reclaim.requestFingerprint,
    approvedInputFingerprint: record.reclaim.approvedInputFingerprint,
    approvedInputAmount: record.reclaim.approvedInputAmount,
    approvedFee: record.reclaim.approvedFee,
    approvedReturnAmount: record.reclaim.approvedReturnAmount,
  };
  const proofs = selectDurableBearerSpendUnspentProofs(record);
  const plan = await prepareGuiBearerReclaimOperation({
    expectedWalletId: walletId,
    record,
    intent,
    proofs,
  });
  await markReclaimSubmitted(walletId, operationId, intent);
  await dispatchGuiBearerReclaimOperation(plan);
  await finalizeReclaim(walletId, operationId, plan.binding);
  return "completed";
}

export async function requireGuiBearerReclaimTransportReady(
  walletId: string,
  binding: GuiBearerSpendReclaimBinding,
): Promise<void> {
  await mutateBearerRecord(
    walletId,
    binding.walletSendOperationId,
    (record) => {
      requireBindingMatchesRecord(binding, record);
      if (record.reclaim.kind === "submitted") return record;
      return reduceDurableBearerSpendReclaimLineage(record, {
        kind: "submitted",
        operationId: binding.reclaimOperationId,
        requestFingerprint: binding.requestFingerprint,
        approvedInputFingerprint: binding.approvedInputFingerprint,
        approvedInputAmount: binding.approvedInputAmount,
        approvedFee: binding.approvedFee,
        approvedReturnAmount: binding.approvedReturnAmount,
      });
    },
  );
}

export async function finalizeGuiBearerReclaimFromCompletedChild(
  walletId: string,
  binding: GuiBearerSpendReclaimBinding,
): Promise<void> {
  await finalizeReclaim(walletId, binding.walletSendOperationId, binding);
}

async function cancellationPreview(
  walletId: string,
  operationId: string,
  record: DurableBearerSpendDeliveryRecord,
): Promise<GuiBearerSpendCancellationPreview> {
  const proofs = selectDurableBearerSpendUnspentProofs(record);
  const wallet = await useWalletStore
    .getState()
    .getWalletForUnit(record.mintUrl, record.unit, {
      expectedWalletId: walletId,
    });
  const amount = proofs.reduce(
    (sum, proof) => sum + amountToNumber(proof.amount),
    0,
  );
  const fee = amountToNumber(wallet.getFeesForProofs(proofs));
  const returnedAmount = amount - fee;
  if (returnedAmount <= 0) {
    throw new Error("The mint fee would consume the reclaimable amount");
  }
  const fingerprint = deriveDurableCustodyArtifactFingerprint({
    domain: "gui-bearer-cancellation-preview/v1",
    operationId,
    deliveryId: record.deliveryId,
    tokenDigest: record.tokenDigest,
    proofs: proofs.map((proof) => ({
      id: proof.id,
      secret: proof.secret,
      amount: Amount.from(proof.amount).toBigInt().toString(),
      C: proof.C,
    })),
    fee,
    returnedAmount,
  });
  return {
    operationId,
    deliveryId: record.deliveryId,
    mintUrl: record.mintUrl,
    amount,
    fee,
    returnedAmount,
    proofCount: proofs.length,
    partial: record.proofEntries.some((entry) => entry.kind === "spent"),
    fingerprint,
  };
}

async function markReclaimSubmitted(
  walletId: string,
  operationId: string,
  intent: DurableBearerSpendReclaimIntent,
): Promise<void> {
  await mutateBearerRecord(walletId, operationId, (record) =>
    reduceDurableBearerSpendReclaimLineage(record, {
      kind: "submitted",
      ...intent,
    }),
  );
}

async function journalReclaimIntent(
  walletId: string,
  operationId: string,
  intent: DurableBearerSpendReclaimIntent,
): Promise<void> {
  await mutateBearerRecord(
    walletId,
    operationId,
    (record) => {
      if (record.reclaim.kind === "none") {
        return reduceDurableBearerSpendReclaimLineage(record, {
          kind: "prepared",
          ...intent,
        });
      }
      if (record.reclaim.kind !== "prepared") {
        throw new Error("GUI bearer reclaim intent is not replaceable");
      }
      if (
        record.reclaim.operationId === intent.operationId &&
        record.reclaim.requestFingerprint === intent.requestFingerprint
      ) {
        return record;
      }
      return replaceDurableBearerSpendReclaimIntent(record, intent);
    },
    undefined,
    true,
  );
}

async function finalizeReclaim(
  walletId: string,
  operationId: string,
  binding: GuiBearerSpendReclaimBinding,
): Promise<void> {
  await mutateBearerRecord(
    walletId,
    operationId,
    (record, child) => {
      requireBindingMatchesRecord(binding, record);
      if (!child || child.state !== "completed") {
        throw new Error("GUI bearer reclaim child is not complete");
      }
      if (!child.resultProofs) {
        throw new Error("GUI bearer reclaim child result is missing");
      }
      const childBinding = readGuiBearerSpendReclaimBinding(child);
      if (
        childBinding === null ||
        !sameGuiBearerSpendReclaimBinding(childBinding, binding)
      ) {
        throw new Error("GUI bearer reclaim child binding conflicts");
      }
      const intent = {
        operationId: binding.reclaimOperationId,
        requestFingerprint: binding.requestFingerprint,
        approvedInputFingerprint: binding.approvedInputFingerprint,
        approvedInputAmount: binding.approvedInputAmount,
        approvedFee: binding.approvedFee,
        approvedReturnAmount: binding.approvedReturnAmount,
      };
      const capability = issueDurableBearerSpendReclaimCompletionCapability({
        record,
        intent,
        walletOperation: child.metadata.durableWalletOperation,
        resultGroups: rehydrateStoredProofGroups(child.resultProofs),
      });
      return completeDurableBearerSpendReclaim({
        record,
        capability,
        completedAtMs: child.updatedAt,
      });
    },
    binding.reclaimOperationId,
  );
}

async function mutateBearerRecord(
  walletId: string,
  operationId: string,
  mutate: (
    record: DurableBearerSpendDeliveryRecord,
    child?: ProofOperationRecord,
  ) => DurableBearerSpendDeliveryRecord,
  childOperationId?: string,
  requireNoExistingReclaimChild = false,
): Promise<DurableBearerSpendDeliveryRecord> {
  return withGuiCustodyProfileLockForWallet(walletId, async () =>
    db.transaction(
      "rw",
      db.bearerSpendDeliveries,
      db.walletSendDeliveryPayloads,
      db.proofOperations,
      db.custodyOperations,
      async () =>
        await commitBearerMutation({
          walletId,
          operationId,
          mutate,
          childOperationId,
          requireNoExistingReclaimChild,
        }),
    ),
  );
}

async function commitBearerMutation(input: {
  walletId: string;
  operationId: string;
  mutate: (
    record: DurableBearerSpendDeliveryRecord,
    child?: ProofOperationRecord,
  ) => DurableBearerSpendDeliveryRecord;
  childOperationId?: string;
  requireNoExistingReclaimChild: boolean;
}): Promise<DurableBearerSpendDeliveryRecord> {
  const snapshot = await readMutationSnapshot(
    input.walletId,
    input.operationId,
  );
  await requireNoExistingReclaimChild(input, snapshot.record);
  const child = await readOptionalReclaimChild(
    input.walletId,
    input.childOperationId,
  );
  const prepared = prepareBearerMutation(snapshot, input.mutate, child);
  await db.bearerSpendDeliveries.put(prepared.nextRow);
  requireGuiDexieWriteTransaction(
    db,
    "GUI bearer cancellation requires a write transaction",
  );
  if (prepared.deletePayload) {
    await db.walletSendDeliveryPayloads.delete([
      input.walletId,
      input.operationId,
    ]);
    requireGuiDexieWriteTransaction(
      db,
      "GUI bearer cancellation payload deletion requires a write transaction",
    );
  }
  return prepared.nextRecord;
}

async function requireNoExistingReclaimChild(
  input: {
    walletId: string;
    requireNoExistingReclaimChild: boolean;
  },
  record: DurableBearerSpendDeliveryRecord,
): Promise<void> {
  if (
    !input.requireNoExistingReclaimChild ||
    record.reclaim.kind !== "prepared"
  ) {
    return;
  }
  const child = await db.proofOperations.get(
    proofOperationPrimaryKey(input.walletId, record.reclaim.operationId),
  );
  if (child) throw new Error("GUI bearer reclaim child already exists");
}

async function readOptionalReclaimChild(
  walletId: string,
  operationId: string | undefined,
): Promise<ProofOperationRecord | undefined> {
  if (!operationId) return undefined;
  return requireProofOperationRecord(
    await db.proofOperations.get(
      proofOperationPrimaryKey(walletId, operationId),
    ),
    walletId,
    operationId,
  );
}

function prepareBearerMutation(
  snapshot: BearerMutationSnapshot,
  mutate: (
    record: DurableBearerSpendDeliveryRecord,
    child?: ProofOperationRecord,
  ) => DurableBearerSpendDeliveryRecord,
  child: ProofOperationRecord | undefined,
): PreparedBearerMutation {
  const nextRecord = mutate(snapshot.record, child);
  const nextRow = createGuiBearerSpendDeliveryRow(nextRecord);
  const metadata = readGuiWalletSendDeliveryMetadata(snapshot.operation);
  if (!metadata) {
    throw new Error("GUI bearer cancellation admission is missing");
  }
  requireGuiBearerSpendDeliveryRowWithinByteBound(
    nextRow,
    metadata.admission.bearerPolicyRowBytesUpperBound,
  );
  const nextPayload = nextRow.presentable === 1 ? snapshot.payload : undefined;
  requireGuiWalletSendBearerAuthority(
    snapshot.custody,
    snapshot.operation,
    nextPayload,
    nextRow,
  );
  return {
    nextRecord,
    nextRow,
    deletePayload: nextPayload === undefined && snapshot.payload !== undefined,
  };
}

async function readMutationSnapshot(
  walletId: string,
  operationId: string,
): Promise<BearerMutationSnapshot> {
  const operation = requireProofOperationRecord(
    await db.proofOperations.get(
      proofOperationPrimaryKey(walletId, operationId),
    ),
    walletId,
    operationId,
  );
  const deliveryId = `delivery:${operation.custodyOperationId}:wallet-send`;
  const row = requireGuiBearerSpendDeliveryRow(
    await db.bearerSpendDeliveries.get([walletId, deliveryId]),
    walletId,
    deliveryId,
    operation.custodyOperationId,
  );
  const payloadValue = await db.walletSendDeliveryPayloads.get([
    walletId,
    operationId,
  ]);
  const payload = payloadValue
    ? requireGuiWalletSendDeliveryPayloadRow(
        payloadValue,
        walletId,
        operationId,
        operation.custodyOperationId,
      )
    : undefined;
  const rawCustody = await db.custodyOperations.get(
    operation.custodyOperationId,
  );
  if (!rawCustody) throw new Error("GUI bearer custody operation is missing");
  const custody = decodeOperationRow(
    rawCustody as DexieCustodyOperationRow,
    guiWalletContextForWallet(walletId).scope,
  );
  requireGuiWalletSendBearerAuthority(custody, operation, payload, row);
  return { operation, payload, record: row.record, custody };
}

function requireBindingMatchesRecord(
  binding: GuiBearerSpendReclaimBinding,
  record: DurableBearerSpendDeliveryRecord,
): void {
  if (
    binding.deliveryId !== record.deliveryId ||
    binding.parentOperationId !== record.parentOperationId ||
    binding.tokenDigest !== record.tokenDigest ||
    record.reclaim.kind === "none" ||
    binding.reclaimOperationId !== record.reclaim.operationId ||
    binding.requestFingerprint !== record.reclaim.requestFingerprint ||
    binding.approvedInputFingerprint !==
      record.reclaim.approvedInputFingerprint ||
    binding.approvedInputAmount !== record.reclaim.approvedInputAmount ||
    binding.approvedFee !== record.reclaim.approvedFee ||
    binding.approvedReturnAmount !== record.reclaim.approvedReturnAmount
  ) {
    throw new Error("GUI bearer reclaim binding conflicts");
  }
}

function operationIdFromPayloadHandle(value: string): string {
  const prefix = "wallet-send:";
  if (!value.startsWith(prefix) || value.length === prefix.length) {
    throw new Error("GUI bearer cancellation payload handle is invalid");
  }
  return value.slice(prefix.length);
}
