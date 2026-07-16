import { Amount, getEncodedTokenV4 } from "@cashu/cashu-ts";
import { describe, expect, it } from "vitest";
import { createDurableBearerSpendDeliveryRecord } from "@bitcaster/client-sdk/durableBearerSpendDelivery";
import {
  createGuiBearerSpendDeliveryRow,
  requireGuiBearerSpendDeliveryRow,
  requireGuiBearerSpendDeliveryRowWithinByteBound,
} from "../gui-bearer-spend-delivery";
import { planDurableBearerSpendPolicyRowBytes } from "@bitcaster/client-sdk/durableWalletSendDelivery";
import {
  createGuiDurableStorageRowArtifact,
  GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS,
} from "../gui-durable-storage-artifacts";
import {
  canonicalKeysetId,
  canonicalSecpPoint,
} from "../../test/cashu-proof-fixtures";

const WALLET_ID = "aa".repeat(32);
const PROOF = {
  id: canonicalKeysetId(1),
  amount: Amount.from(1),
  secret: "11".repeat(32),
  C: canonicalSecpPoint(1),
};

describe("GUI bearer spend delivery row", () => {
  it("derives every indexed mirror from the strict SDK record", () => {
    const row = createGuiBearerSpendDeliveryRow(record());

    expect(row.adapterSchemaVersion).toBe(1);
    expect(row.walletId).toBe(WALLET_ID);
    expect(row.parentOperationId).toBe("custody-operation-1");
    expect(row.active).toBe(1);
    expect(row.presentable).toBe(1);
    expect(row.createdAtMs).toBe(row.record.createdAtMs);
    expect(row.nextAttemptAtMs).toBe(row.record.createdAtMs);
    expect(() =>
      requireGuiBearerSpendDeliveryRow({ ...row, active: 0 }),
    ).toThrow(/row is invalid/);
    expect(() =>
      requireGuiBearerSpendDeliveryRow({ ...row, presentable: 0 }),
    ).toThrow(/row is invalid/);
    expect(() =>
      requireGuiBearerSpendDeliveryRow({
        ...row,
        parentOperationId: "foreign-operation",
      }),
    ).toThrow(/row is invalid/);
  });

  it("applies the dedicated bounded physical-row artifact policy", () => {
    const row = createGuiBearerSpendDeliveryRow(record());
    const artifact = createGuiDurableStorageRowArtifact({
      table: "bearerSpendDeliveries",
      key: [row.walletId, row.deliveryId],
      artifactRole: "private-material",
      row,
    });

    expect(
      new TextEncoder().encode(artifact.encodedJson).byteLength,
    ).toBeLessThan(
      GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.bearerSpendDeliveries,
    );
    expect(
      GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.bearerSpendDeliveries,
    ).toBe(8 * 1_024 * 1_024);
  });

  it("keeps every bearer proof-count boundary within its admitted row bound", () => {
    for (const count of [1, 64, 128, 256]) {
      const proofs = Array.from({ length: count }, (_, index) => ({
        ...PROOF,
        secret: index.toString(16).padStart(64, "0"),
      }));
      const row = createGuiBearerSpendDeliveryRow(
        createDurableBearerSpendDeliveryRecord({
          deliveryId: `delivery-${count}`,
          walletId: WALLET_ID,
          parentOperationId: `custody-operation-${count}`,
          payloadHandle: `wallet-send:native-operation-${count}`,
          mintUrl: "https://mint.example",
          unit: "sat",
          encodedToken: getEncodedTokenV4({
            mint: "https://mint.example",
            unit: "sat",
            proofs,
          }),
          proofs,
          origin: "local",
          createdAtMs: 1_000,
        }),
      );
      const bound = planDurableBearerSpendPolicyRowBytes(count);
      expect(
        requireGuiBearerSpendDeliveryRowWithinByteBound(row, bound).deliveryId,
      ).toBe(row.deliveryId);
    }
  });

  it("rejects a row that exceeds its supplied admission bound", () => {
    const row = createGuiBearerSpendDeliveryRow(record());
    const artifact = createGuiDurableStorageRowArtifact({
      table: "bearerSpendDeliveries",
      key: [row.walletId, row.deliveryId],
      artifactRole: "private-material",
      row,
    });
    const actualBytes = new TextEncoder().encode(
      artifact.encodedJson,
    ).byteLength;

    expect(() =>
      requireGuiBearerSpendDeliveryRowWithinByteBound(row, actualBytes - 1),
    ).toThrow(/exceeds its admitted byte bound/);
  });
});

function record() {
  return createDurableBearerSpendDeliveryRecord({
    deliveryId: "delivery:custody-operation-1:wallet-send",
    walletId: WALLET_ID,
    parentOperationId: "custody-operation-1",
    payloadHandle: "wallet-send:native-operation-1",
    mintUrl: "https://mint.example",
    unit: "sat",
    encodedToken: getEncodedTokenV4({
      mint: "https://mint.example",
      unit: "sat",
      proofs: [PROOF],
    }),
    proofs: [PROOF],
    origin: "local",
    createdAtMs: 1_000,
  });
}
