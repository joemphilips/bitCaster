import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DURABLE_ARTIFACT_BYTES_LIMIT_MAX,
  encodeBoundedDurableArtifact,
} from "../src/durableCustody.ts";
import { DURABLE_WALLET_OPERATION_ARRAY_LENGTH_MAX } from "../src/durableWalletOperation.ts";
import { aggregateEncryptedWalletBackupPendingSendParentFragments } from "../src/encryptedWalletBackupPendingSend.ts";
import {
  derivePendingSendLogicalRecordId,
  derivePendingSendParentCommitment,
  derivePendingSendParentFragmentCommitment,
  derivePendingSendParentFragmentRecordId,
  decodeEncryptedWalletBackupPendingSendOperation,
} from "../src/encryptedWalletBackupPendingSendParentCodec.ts";

const POINT =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

test("caller-owned artifact limits cannot exceed the fixed global ceiling", () => {
  assert.equal(
    encodeBoundedDurableArtifact("x", DURABLE_ARTIFACT_BYTES_LIMIT_MAX)
      .byteLength,
    3,
  );
  assert.throws(
    () =>
      encodeBoundedDurableArtifact("x", DURABLE_ARTIFACT_BYTES_LIMIT_MAX + 1),
    /byte limit is invalid/,
  );
});

test("pending-send projection reuses the durable wallet array-count bound", () => {
  const maximum = pendingSendOperationProjection(
    DURABLE_WALLET_OPERATION_ARRAY_LENGTH_MAX,
  );
  assert.equal(
    decodeEncryptedWalletBackupPendingSendOperation(maximum).preview
      .unselectedProofCount,
    DURABLE_WALLET_OPERATION_ARRAY_LENGTH_MAX,
  );
  assert.throws(
    () =>
      decodeEncryptedWalletBackupPendingSendOperation(
        pendingSendOperationProjection(
          DURABLE_WALLET_OPERATION_ARRAY_LENGTH_MAX + 1,
        ),
      ),
    /unselected proof count is invalid/,
  );
});

function pendingSendOperationProjection(unselectedProofCount: number) {
  return {
    schemaVersion: 1,
    operationId: "operation-1",
    kind: "wallet-send",
    mintUrl: "https://mint.example",
    unit: "sat",
    preview: {
      amount: "1",
      fees: "0",
      keysetId: "0011223344556677",
      inputs: [
        {
          id: "0011223344556677",
          amount: "1",
          secret: "22".repeat(32),
          C: POINT,
          dleq: null,
          p2pkE: null,
          witness: null,
        },
      ],
      sendOutputs: [
        {
          blindedMessage: {
            amount: "1",
            id: "0011223344556677",
            B_: POINT,
          },
          blindingFactor: "2",
          secret: "33".repeat(32),
          ephemeralE: null,
        },
      ],
      keepOutputs: [],
      unselectedProofCount,
      unselectedProofsFingerprint: "44".repeat(32),
    },
    requestFingerprint: "55".repeat(32),
    outputPlanFingerprint: "66".repeat(32),
  };
}

test("fragment aggregation revalidates the committed fragment bytes", () => {
  const logicalRecordId = derivePendingSendLogicalRecordId("delivery-1");
  const fragment = new Uint8Array([1]);
  const commitment = derivePendingSendParentFragmentCommitment({
    logicalRecordId,
    fragmentIndex: 0,
    fragmentCount: 1,
    totalBytes: 1,
    fragment,
  });
  const parentCommitment = derivePendingSendParentCommitment(logicalRecordId, [
    commitment,
  ]);
  const decoded = {
    recordId: derivePendingSendParentFragmentRecordId(logicalRecordId, 0),
    commitment,
    logicalRecordId,
    parentCommitment,
    fragmentIndex: 0,
    fragmentCount: 1,
    totalBytes: 1,
    fragment: new Uint8Array([2]),
  };
  assert.throws(
    () => aggregateEncryptedWalletBackupPendingSendParentFragments([decoded]),
    /pending-send parent fragment is invalid/,
  );
});

test("public backup entry hides record issuers and low-level aggregation", async () => {
  const publicApi: Record<string, unknown> =
    await import("../src/encryptedWalletBackup.ts");
  for (const forbidden of [
    "issuePreparedEncryptedWalletBackupRecord",
    "requirePreparedEncryptedWalletBackupRecord",
    "aggregateEncryptedWalletBackupPendingSendParentFragments",
    "decodeEncryptedWalletBackupPendingSendParentFragment",
  ]) {
    assert.equal(
      forbidden in publicApi,
      false,
      `${forbidden} must stay internal`,
    );
  }
});
