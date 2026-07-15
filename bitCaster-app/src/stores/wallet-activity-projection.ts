import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import Dexie from "dexie";
import {
  COLLATERAL_UNIT_REGISTRY,
  parseCashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
import { decodeActivityItem } from "@/lib/activityLogCodec";
import type { ActivityItem } from "@/types/portfolio";
import {
  db,
  ensureDurableSwapStorage,
  requireGuiWalletId,
  type ProofOperationRecord,
} from "./proof-db";

export const GUI_DEPOSIT_ACTIVITY_METADATA_KEY =
  "guiDepositActivityProjection" as const;

export interface GuiDepositActivityMetadata {
  schemaVersion: 1;
  lightningInvoice: string | null;
}

export type WalletActivityRow = ActivityItem & { walletId: string };

export function guiDepositActivityMetadata(
  lightningInvoice: string | null,
): GuiDepositActivityMetadata {
  if (
    lightningInvoice !== null &&
    (lightningInvoice.length === 0 || lightningInvoice.length > 16_384)
  ) {
    throw new Error("GUI deposit invoice is invalid");
  }
  return { schemaVersion: 1, lightningInvoice };
}

export function readGuiDepositActivityMetadata(
  operation: Pick<ProofOperationRecord, "metadata">,
): GuiDepositActivityMetadata | null {
  const value = operation.metadata[GUI_DEPOSIT_ACTIVITY_METADATA_KEY];
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GUI deposit activity metadata is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (field) => field !== "schemaVersion" && field !== "lightningInvoice",
    ) ||
    record.schemaVersion !== 1 ||
    (record.lightningInvoice !== null &&
      (typeof record.lightningInvoice !== "string" ||
        record.lightningInvoice.length === 0 ||
        record.lightningInvoice.length > 16_384))
  ) {
    throw new Error("GUI deposit activity metadata is invalid");
  }
  return {
    schemaVersion: 1,
    lightningInvoice: record.lightningInvoice as string | null,
  };
}

export function projectCompletedGuiDepositActivity(
  operation: ProofOperationRecord,
): WalletActivityRow | null {
  if (operation.kind !== "wallet-mint" && operation.kind !== "wallet-receive") {
    return null;
  }
  if (operation.state !== "completed" || !operation.resultProofs) {
    throw new Error("GUI deposit activity requires a completed operation");
  }
  const labels = Object.keys(operation.resultProofs);
  if (labels.length !== 1 || labels[0] !== "receive") {
    throw new Error("GUI deposit activity result is invalid");
  }
  const unit = parseCashuProofUnit(operation.metadata.unit);
  if (!unit) throw new Error("GUI deposit activity unit is invalid");
  const amountSats = (operation.resultProofs.receive ?? []).reduce(
    (sum, proof) => sum + amountToNumber(proof.amount),
    0,
  );
  if (!Number.isSafeInteger(amountSats) || amountSats < 1) {
    throw new Error("GUI deposit activity amount is invalid");
  }
  const metadata = readGuiDepositActivityMetadata(operation);
  return requireWalletActivityRow(
    {
      walletId: operation.walletId,
      id: operation.operationId,
      type: "deposit",
      amountSats,
      baseAsset: COLLATERAL_UNIT_REGISTRY[unit].baseAsset,
      date: new Date(operation.createdAt).toISOString(),
      status: "completed",
      txId: null,
      lightningInvoice: metadata?.lightningInvoice ?? null,
    },
    operation.walletId,
  );
}

export async function listWalletActivities(
  walletId: string,
): Promise<ActivityItem[]> {
  requireGuiWalletId(walletId);
  await ensureDurableSwapStorage(walletId);
  const rows = await db.walletActivities
    .where("[walletId+date]")
    .between([walletId, Dexie.minKey], [walletId, Dexie.maxKey])
    .reverse()
    .limit(500)
    .toArray();
  return rows.map((row) => {
    const { walletId: _walletId, ...item } = requireWalletActivityRow(
      row,
      walletId,
    );
    return item;
  });
}

export function requireWalletActivityRow(
  value: unknown,
  expectedWalletId: string,
): WalletActivityRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GUI wallet activity row is invalid");
  }
  const row = value as Record<string, unknown>;
  const expectedFields = [
    "walletId",
    "id",
    "type",
    "amountSats",
    "baseAsset",
    "date",
    "status",
    "txId",
    "lightningInvoice",
  ];
  if (
    Object.keys(row).length !== expectedFields.length ||
    Object.keys(row).some((field) => !expectedFields.includes(field))
  ) {
    throw new Error("GUI wallet activity row is invalid");
  }
  const { walletId: rawWalletId, ...rawActivity } = row;
  if (typeof rawWalletId !== "string") {
    throw new Error("GUI wallet activity row is invalid");
  }
  const walletId = requireGuiWalletId(rawWalletId);
  const activity = decodeActivityItem(rawActivity);
  if (
    walletId !== expectedWalletId ||
    activity === null ||
    activity.status !== "completed" ||
    activity.type !== "deposit" ||
    activity.baseAsset === undefined ||
    activity.txId !== null
  ) {
    throw new Error("GUI wallet activity row is invalid");
  }
  return { walletId, ...activity };
}
