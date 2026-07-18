import {
  Amount,
  CheckStateEnum,
  OutputData,
  getEncodedTokenV4,
  hashToCurve,
  type Proof,
  type ProofState,
  type SwapPreview,
} from "@cashu/cashu-ts";
import {
  createDurableBearerSpendDeliveryRecord,
  planDurableBearerSpendCustodyHandoff,
  reconcileDurableBearerSpendDelivery,
  type DurableBearerSpendDeliveryRecord,
} from "../src/durableBearerSpendDelivery.ts";
import {
  deriveDurableCustodyWalletId,
} from "../src/durableCustody.ts";
import {
  createDurableWalletSendOperation,
} from "../src/durableWalletOperation.ts";
import {
  DURABLE_WALLET_SEND_NATIVE_OPERATION_BYTES_LIMIT_MAX,
  DURABLE_WALLET_SEND_PROOF_COUNT_LIMIT_MAX,
  DURABLE_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX,
  DURABLE_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX,
  planDurableWalletSendDeliveryAdmission,
} from "../src/durableWalletSendDelivery.ts";
import { prepareDurableWalletSendDelivery } from "../src/durableWalletSendDeliveryPreparation.ts";
import {
  describeDurableWalletSendExactPayload,
  planDurableWalletSendExactPayload,
  type DurableWalletSendExactPayload,
} from "../src/durableWalletSendExactPayload.ts";
import {
  deriveEncryptedWalletBackupPendingSendRecordId,
  type EncryptedWalletBackupCommittedPendingSendSnapshot,
  type EncryptedWalletBackupPendingSendSnapshotStore,
} from "../src/encryptedWalletBackup.ts";
import {
  createRecipientCustodyState,
  recipientOwnerAuthorization,
} from "./durableRecipientDeliveryFixture.ts";

export const PENDING_SEND_FIXTURE_KEYSET_ID = "0011223344556677";
export const PENDING_SEND_FIXTURE_MINT = "https://mint.example";
export const PENDING_SEND_FIXTURE_POINT =
  "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
export const PENDING_SEND_FIXTURE_SEED = new Uint8Array(64).fill(7);

export function createPendingSendFixture(
  proofCount: number,
  options?: {
    readonly unselectedProofs?: readonly Proof[];
    readonly outputSecretPaddingBytes?: number;
  },
) {
  const unselectedProofs = options?.unselectedProofs ?? [];
  const preview = pendingSendPreview(
    proofCount,
    unselectedProofs,
    options?.outputSecretPaddingBytes ?? 0,
  );
  const proofs = preview.sendOutputs.map(proofForOutput);
  const encodedToken = getEncodedTokenV4({
    mint: PENDING_SEND_FIXTURE_MINT,
    unit: "sat",
    proofs,
  });
  const walletOperation = createDurableWalletSendOperation({
    operationId: `send-${proofCount}`,
    mintUrl: PENDING_SEND_FIXTURE_MINT,
    unit: "sat",
    preview,
  });
  const preparation = prepareDurableWalletSendDelivery({
    walletOperation,
    policy: { kind: "user-export" },
    admission: planPendingSendEnvelope(
      proofCount,
      unselectedProofs,
      options?.outputSecretPaddingBytes ?? 0,
    ),
  });
  const resultGroups = {
    keep: unselectedProofs.map(persistedProof),
    send: proofs.map(persistedProof),
  };
  const exactPayload = planDurableWalletSendExactPayload({
    preparation,
    walletOperation,
    resultGroups,
    payloadHandle: `payload-${proofCount}`,
    encodedToken,
  });
  return createPendingSendCustodyFixture({
    walletOperation,
    preparation,
    proofs,
    encodedToken,
    exactPayload,
    resultGroups,
  });
}

export function createMaximumPlannerPendingSendFixture() {
  const unselectedProofCount = maximumPlannerUnselectedProofCount();
  const outputSecretPaddingBytes = maximumPlannerOutputSecretPadding(
    unselectedProofCount,
  );
  const unselectedProofs = Array.from(
    { length: unselectedProofCount },
    (_, index) => pendingSendProof(2_000 + index),
  );
  return {
    unselectedProofCount,
    outputSecretPaddingBytes,
    fixture: createPendingSendFixture(256, {
      unselectedProofs,
      outputSecretPaddingBytes,
    }),
  };
}

export function planPendingSendEnvelope(
  proofCount: number,
  unselectedProofs: readonly Proof[],
  outputSecretPaddingBytes: number,
) {
  const walletOperation = createDurableWalletSendOperation({
    operationId: "maximum-envelope-plan",
    mintUrl: PENDING_SEND_FIXTURE_MINT,
    unit: "sat",
    preview: pendingSendPreview(
      proofCount,
      unselectedProofs,
      outputSecretPaddingBytes,
    ),
  });
  return planDurableWalletSendDeliveryAdmission({
    outputPlan: {
      mintUrl: PENDING_SEND_FIXTURE_MINT,
      unit: "sat",
      sendOutputs: walletOperation.preview.sendOutputs,
      keepOutputs: walletOperation.preview.keepOutputs,
      passthroughProofs: walletOperation.preview.unselectedProofs,
      inputProofs: walletOperation.preview.inputs,
    },
    limits: {
      encodedTokenBytes: DURABLE_WALLET_SEND_TOKEN_BYTES_LIMIT_MAX,
      proofCount: DURABLE_WALLET_SEND_PROOF_COUNT_LIMIT_MAX,
      durableStorageBytes: DURABLE_WALLET_SEND_STORAGE_BYTES_LIMIT_MAX,
      nativeOperationRowBytes:
        DURABLE_WALLET_SEND_NATIVE_OPERATION_BYTES_LIMIT_MAX,
    },
  });
}

export async function createPartialPendingSendDeliveryRecord(
  record: DurableBearerSpendDeliveryRecord,
): Promise<DurableBearerSpendDeliveryRecord> {
  const activeProofs = record.proofEntries.flatMap((entry) =>
    entry.kind === "active" ? [entry.proof] : [],
  );
  return reconcileDurableBearerSpendDelivery({
    record,
    observedAtMs: (record.state.lastObservedAtMs ?? record.createdAtMs) + 1_000,
    checker: {
      async checkProofsStates() {
        return activeProofs.map((proof, index) =>
          proofState(
            proof,
            index === 0 ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
          ),
        );
      },
    },
  });
}

export function exactPendingSendSnapshotStore(
  snapshot: EncryptedWalletBackupCommittedPendingSendSnapshot,
): EncryptedWalletBackupPendingSendSnapshotStore {
  return {
    async withCommittedPendingSendSnapshot(recordId, read) {
      if (recordId !== snapshot.recordId) {
        throw new Error("pending-send fixture record id changed");
      }
      return read(snapshot);
    },
  };
}

export function pendingSendProof(index: number): Proof {
  return {
    id: PENDING_SEND_FIXTURE_KEYSET_ID,
    amount: 1,
    secret: index.toString(16).padStart(64, "0"),
    C: PENDING_SEND_FIXTURE_POINT,
  };
}

function createPendingSendCustodyFixture(input: {
  readonly walletOperation: ReturnType<typeof createDurableWalletSendOperation>;
  readonly preparation: ReturnType<typeof prepareDurableWalletSendDelivery>;
  readonly proofs: readonly Proof[];
  readonly encodedToken: string;
  readonly exactPayload: DurableWalletSendExactPayload;
  readonly resultGroups: Readonly<{
    keep: readonly Proof[];
    send: readonly Proof[];
  }>;
}) {
  const walletId = deriveDurableCustodyWalletId(PENDING_SEND_FIXTURE_SEED);
  const previousCustodyState = createRecipientCustodyState(input, walletId);
  const delivery = previousCustodyState.operation.operation.delivery;
  if (
    delivery.deliveryKind !== "outbox" ||
    delivery.deliveryId === null ||
    delivery.payloadHandle === null
  ) {
    throw new Error("missing exact bearer handoff fixture");
  }
  const deliveryRecord = createDurableBearerSpendDeliveryRecord({
    deliveryId: delivery.deliveryId,
    walletId,
    parentOperationId: previousCustodyState.operation.operation.operationId,
    payloadHandle: delivery.payloadHandle,
    mintUrl: PENDING_SEND_FIXTURE_MINT,
    unit: "sat",
    encodedToken: input.encodedToken,
    proofs: input.proofs,
    origin: "local",
    createdAtMs: 1_000,
  });
  const handoffPlan = planDurableBearerSpendCustodyHandoff({
    bearerRecord: deliveryRecord,
    custodyState: previousCustodyState,
    exactPayload: input.exactPayload,
    authorization: recipientOwnerAuthorization,
  });
  return {
    ...input,
    previousCustodyState,
    deliveryRecord,
    handoffPlan,
    snapshot: parentSnapshot(input, deliveryRecord, previousCustodyState, handoffPlan),
  };
}

function parentSnapshot(
  input: Parameters<typeof createPendingSendCustodyFixture>[0],
  deliveryRecord: DurableBearerSpendDeliveryRecord,
  previousCustodyState: ReturnType<typeof createRecipientCustodyState>,
  handoffPlan: ReturnType<typeof planDurableBearerSpendCustodyHandoff>,
): EncryptedWalletBackupCommittedPendingSendSnapshot {
  const recordId = deriveEncryptedWalletBackupPendingSendRecordId({
    walletId: deliveryRecord.walletId,
    parentOperationId: deliveryRecord.parentOperationId,
    deliveryId: deliveryRecord.deliveryId,
  });
  return {
    schemaVersion: 1,
    snapshotId: "snapshot-1",
    revision: 1,
    recordId,
    progression: "parent",
    parentCommitment: null,
    walletOperation: input.walletOperation,
    walletResultGroups: input.resultGroups,
    exactPayloadMetadata: describeDurableWalletSendExactPayload(
      input.exactPayload,
    ),
    previousCustodyState,
    handoffPlan,
    deliveryRecord,
    encodedToken: input.encodedToken,
  };
}

function maximumPlannerUnselectedProofCount(): number {
  let accepted = 0;
  let rejected = 257;
  while (accepted + 1 < rejected) {
    const candidate = Math.floor((accepted + rejected) / 2);
    try {
      planPendingSendEnvelope(
        256,
        Array.from({ length: candidate }, (_, index) =>
          pendingSendProof(4_000 + index),
        ),
        0,
      );
      accepted = candidate;
    } catch {
      rejected = candidate;
    }
  }
  return accepted;
}

function maximumPlannerOutputSecretPadding(
  unselectedProofCount: number,
): number {
  const unselectedProofs = Array.from(
    { length: unselectedProofCount },
    (_, index) => pendingSendProof(4_000 + index),
  );
  let accepted = 0;
  let rejected = 1_985;
  while (accepted + 1 < rejected) {
    const candidate = Math.floor((accepted + rejected) / 2);
    try {
      planPendingSendEnvelope(256, unselectedProofs, candidate);
      accepted = candidate;
    } catch {
      rejected = candidate;
    }
  }
  return accepted;
}

function pendingSendPreview(
  proofCount: number,
  unselectedProofs: readonly Proof[],
  outputSecretPaddingBytes: number,
): SwapPreview {
  return {
    amount: Amount.from(proofCount),
    fees: Amount.from(0),
    keysetId: PENDING_SEND_FIXTURE_KEYSET_ID,
    inputs: [{ ...pendingSendProof(512), amount: Amount.from(proofCount) }],
    sendOutputs: Array.from({ length: proofCount }, (_, index) =>
      pendingSendOutput(index, outputSecretPaddingBytes),
    ),
    keepOutputs: [],
    unselectedProofs: [...unselectedProofs],
  };
}

function pendingSendOutput(index: number, paddingBytes: number): OutputData {
  return new OutputData(
    {
      amount: Amount.from(1),
      id: PENDING_SEND_FIXTURE_KEYSET_ID,
      B_: PENDING_SEND_FIXTURE_POINT,
    },
    2n,
    new TextEncoder().encode(
      `${index.toString(16).padStart(64, "0")}${"a".repeat(paddingBytes)}`,
    ),
  );
}

function proofForOutput(output: OutputData): Proof {
  return {
    id: output.blindedMessage.id,
    amount: Amount.from(output.blindedMessage.amount),
    secret: new TextDecoder().decode(output.secret),
    C: PENDING_SEND_FIXTURE_POINT,
  };
}

function persistedProof(proof: Proof): Proof {
  return { ...structuredClone(proof), amount: Amount.from(proof.amount).toBigInt().toString() };
}

function proofState(proof: Proof, state: ProofState["state"]): ProofState {
  return {
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state,
    witness: null,
  };
}
