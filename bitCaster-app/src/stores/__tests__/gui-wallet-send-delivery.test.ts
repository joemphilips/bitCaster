import { describe, expect, it } from "vitest";
import {
  requireProofOperationRecord,
  type ProofOperationRecord,
} from "../proof-db";
import { createGuiDurableStorageRowArtifact } from "../gui-durable-storage-artifacts";
import {
  GUI_WALLET_SEND_PROOF_COUNT_LIMIT_MAX,
  GUI_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX,
  GUI_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX,
  createGuiWalletSendDeliveryReservationRow,
  guiWalletSendDeliveryMetadata,
  readGuiWalletSendDeliveryMetadata,
  requireGuiWalletSendDeliveryPayloadRow,
  requireGuiWalletSendDeliveryReservationRow,
} from "../gui-wallet-send-delivery";

const OUTPUT_PLAN = {
  mintUrl: "https://mint.example",
  unit: "sat",
  sendOutputs: [
    {
      blindedMessage: { id: "0011223344556677" },
      secret: "11".repeat(32),
    },
  ],
};

function operation(
  kind: ProofOperationRecord["kind"],
  metadata: Record<string, unknown>,
): Pick<ProofOperationRecord, "kind" | "metadata"> {
  return { kind, metadata };
}

describe("GUI wallet-send delivery metadata", () => {
  it("round-trips strict user-export metadata", () => {
    const metadata = guiWalletSendDeliveryMetadata(OUTPUT_PLAN);
    expect(
      readGuiWalletSendDeliveryMetadata(
        operation("wallet-send", { guiWalletSendDelivery: metadata }),
      ),
    ).toEqual(metadata);
  });

  it("rejects unknown fields and foreign operation kinds", () => {
    expect(() =>
      readGuiWalletSendDeliveryMetadata(
        operation("wallet-send", {
          guiWalletSendDelivery: {
            schemaVersion: 1,
            mode: "user-export",
            unknown: true,
          },
        }),
      ),
    ).toThrow(/invalid/);
    expect(() =>
      readGuiWalletSendDeliveryMetadata(
        operation("wallet-receive", {
          guiWalletSendDelivery: guiWalletSendDeliveryMetadata(OUTPUT_PLAN),
        }),
      ),
    ).toThrow(/invalid/);
  });

  it("rejects delivery payloads beyond the GUI physical envelope", () => {
    expect(() =>
      requireGuiWalletSendDeliveryPayloadRow({
        walletId: "aa".repeat(32),
        operationId: "wallet-send-1",
        custodyOperationId: "custody-wallet-send-1",
        encodedToken: "x".repeat(GUI_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX + 1),
        tokenDigest: "00".repeat(32),
        tokenByteLength: GUI_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX + 1,
        createdAt: 1,
      }),
    ).toThrow("exceeds its byte limit");
  });

  it("rejects missing, foreign, and corrupt reservation custody identities", () => {
    const metadata = guiWalletSendDeliveryMetadata(OUTPUT_PLAN);
    const operation = {
      walletId: "aa".repeat(32),
      operationId: "wallet-send-1",
      custodyOperationId: "custody-wallet-send-1",
      kind: "wallet-send",
      state: "prepared",
      mintUrl: OUTPUT_PLAN.mintUrl,
      inputs: [],
      outputs: {},
      metadata: { unit: "sat", guiWalletSendDelivery: metadata },
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    } satisfies ProofOperationRecord;
    const row = createGuiWalletSendDeliveryReservationRow(operation);

    expect(() =>
      requireGuiWalletSendDeliveryReservationRow(row, {
        ...operation,
        custodyOperationId: undefined as never,
      }),
    ).toThrow(/invalid/);
    expect(() =>
      requireGuiWalletSendDeliveryReservationRow(row, {
        ...operation,
        custodyOperationId: "foreign-custody",
      }),
    ).toThrow(/invalid/);
    expect(() =>
      requireGuiWalletSendDeliveryReservationRow(
        { ...row, custodyOperationId: "" },
        operation,
      ),
    ).toThrow(/invalid/);
  });

  it("admits a maximum completed row and rejects one output beyond it", () => {
    const output = (index: number) => ({
      blindedMessage: { id: index.toString(16).padStart(16, "0") },
      secret: index.toString(16).padStart(64, "0"),
    });
    let metadata: ReturnType<typeof guiWalletSendDeliveryMetadata> | null =
      null;
    let admittedCount = 0;
    for (
      let count = 1;
      count <= GUI_WALLET_SEND_PROOF_COUNT_LIMIT_MAX;
      count += 1
    ) {
      try {
        metadata = guiWalletSendDeliveryMetadata({
          ...OUTPUT_PLAN,
          sendOutputs: Array.from({ length: count }, (_, index) =>
            output(index + 1),
          ),
        });
        admittedCount = count;
      } catch (error) {
        expect(error).toHaveProperty(
          "message",
          expect.stringContaining("native operation row limit"),
        );
        break;
      }
    }
    expect(metadata).not.toBeNull();
    if (!metadata) throw new Error("missing admitted wallet-send boundary");
    expect(admittedCount).toBeGreaterThan(0);
    expect(admittedCount).toBeLessThan(GUI_WALLET_SEND_PROOF_COUNT_LIMIT_MAX);
    expect(() =>
      guiWalletSendDeliveryMetadata({
        ...OUTPUT_PLAN,
        sendOutputs: Array.from({ length: admittedCount + 1 }, (_, index) =>
          output(index + 1),
        ),
      }),
    ).toThrow("native operation row limit");

    const outputs = Array.from({ length: admittedCount }, (_, index) => ({
      blindedMessage: {
        amount: 1,
        id: output(index + 1).blindedMessage.id,
        B_: `02${"11".repeat(32)}`,
      },
      blindingFactor: "22".repeat(32),
      secret: output(index + 1).secret,
    }));
    const resultProofs = outputs.map((planned) => ({
      id: planned.blindedMessage.id,
      amount: 1,
      secret: planned.secret,
      C: `02${"33".repeat(32)}`,
    }));
    const row = requireProofOperationRecord({
      walletId: "aa".repeat(32),
      operationId: "wallet-send-max-row",
      custodyOperationId: "custody-wallet-send-max-row",
      kind: "wallet-send",
      state: "completed",
      mintUrl: OUTPUT_PLAN.mintUrl,
      inputs: [],
      outputs: { send: outputs },
      metadata: {
        unit: "sat",
        guiWalletSendDelivery: metadata,
        durableWalletOperation: {
          schemaVersion: 1,
          operationId: "wallet-send-max-row",
          kind: "wallet-send",
          mintUrl: OUTPUT_PLAN.mintUrl,
          unit: "sat",
          preview: {
            inputs: [],
            sendOutputs: outputs,
            keepOutputs: [],
            unselectedProofs: [],
          },
        },
      },
      resultProofs: { send: resultProofs },
      lastError: null,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(() =>
      createGuiDurableStorageRowArtifact({
        table: "proofOperations",
        key: [row.walletId, row.operationId],
        artifactRole: "exact-operation",
        row,
      }),
    ).not.toThrow();

    expect(metadata.admission.encodedTokenBytesUpperBound).toBeLessThanOrEqual(
      GUI_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX,
    );
    expect(
      metadata.admission.nativeOperationRowBytesUpperBound,
    ).toBeLessThanOrEqual(metadata.admission.nativeOperationRowBytesLimit);
    expect(metadata.admission.durableStorageBytesRequired).toBeLessThanOrEqual(
      GUI_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX,
    );
  });
});
