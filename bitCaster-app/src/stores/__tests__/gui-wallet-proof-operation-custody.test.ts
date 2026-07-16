import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Amount,
  CheckStateEnum,
  getEncodedTokenV4,
  hashToCurve,
  Mint as CashuMint,
  OutputData,
  type Proof,
  type ProofState,
} from "@cashu/cashu-ts";
import Dexie from "dexie";
import { createDurableWalletProofTransition } from "@bitcaster/client-sdk/durableWalletProofTransition";
import {
  createDurableWalletSendOperation,
  decodeDurableWalletOperation,
  toDurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableWalletOperation";
import { prepareDurableWalletSendDelivery } from "@bitcaster/client-sdk/durableWalletSendDeliveryPreparation";
import { planDurableWalletSendExactPayload } from "@bitcaster/client-sdk/durableWalletSendExactPayload";
import {
  readDurableRecipientSubmissionAuthority,
  type DurableRecipientSubmissionAuthority,
} from "@bitcaster/client-sdk/durableRecipientSubmission";
import { deriveDurableCustodyProofResultFingerprint } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import { participationScoreRecipientProductBinding } from "@bitcaster/client-sdk/durableRecipientProductBinding";
import {
  createDurableBearerSpendDeliveryRecord,
  decodeDurableBearerSpendDeliveryRecord,
  isDurableBearerSpendTokenPresentable,
  planDurableBearerSpendReclaimIntent,
  planDurableBearerSpendCustodyHandoff,
  reconcileDurableBearerSpendDelivery,
  reduceDurableBearerSpendReclaimLineage,
  selectDurableBearerSpendUnspentProofs,
  type DurableBearerSpendDeliveryRecord,
} from "@bitcaster/client-sdk/durableBearerSpendDelivery";
import {
  abortPreparedGuiWalletMintForWallet,
  claimPreparedProofOperationMintSubmissionForWallet,
  getPendingGuiWalletSendDeliveryForWallet,
  markProofOperationCompleted,
  markProofOperationFailed,
  markProofOperationMintSubmitted,
  prepareProofOperation,
  requireCompletedGuiWalletProofOperationAuthorityForWallet,
  requireGuiWalletSendTokenForWallet,
} from "../gui-wallet-proof-operation-custody";
import {
  currentGuiWalletId,
  db,
  prepareStoredProofForWrite,
  proofOperationPrimaryKey,
} from "../proof-db";
import { useWalletStore } from "../wallet";
import {
  guiWalletLockName,
  tryWithGuiWalletBearerRecoveryLock,
} from "../gui-wallet-lock";
import { createCapturedGuiWalletProofOperationStore } from "../gui-wallet-proof-operation-store";
import { listWalletActivities } from "../wallet-activity-projection";
import {
  acquireGuiCustodyAuthority,
  releaseGuiCustodyAuthority,
  withGuiCustodyProfileLock,
} from "../gui-custody-authority";
import {
  guiDurableStorageAdmissionTables,
  initializeGuiDurableStorageAdmission,
  releaseGuiDurableStorageHeadroomInCurrentTransaction,
} from "../gui-durable-storage-admission-dexie";
import { withGuiOriginStorageAdmissionLock } from "../gui-origin-storage-admission-lock";
import {
  GuiDurableStorageHeadroomUnavailable,
  requireGuiNewEffectHeadroomForWallet,
} from "../gui-durable-storage-headroom-custody-unit-of-work";
import {
  commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction,
  guiCustodyUnitOfWorkTables,
  prepareGuiCustodyUnitOfWork,
  readGuiCustodyNativeSnapshot,
  readGuiCustodyOperationSnapshot,
} from "../gui-custody-unit-of-work";
import { prepareGuiCustodyTransition } from "../gui-proof-operation-custody";
import {
  __resetGuiNativeProofOperationRecoverySchedulerForTests,
  recoverGuiNativeProofOperations,
} from "../gui-native-proof-operation-recovery";
import {
  guiWalletSendDeliveryMetadata,
  createGuiWalletSendDeliveryPayloadRow,
  readGuiWalletSendDeliveryMetadata,
} from "../gui-wallet-send-delivery";
import { createGuiBearerSpendDeliveryRow } from "../gui-bearer-spend-delivery";
import {
  __resetGuiBearerSpendRecoveryForTests,
  __setGuiBearerSpendRecoveryMintTimeoutForTests,
  __scheduleGuiBearerSpendRecoveryWakeForTests,
  __setGuiBearerSpendRecoveryTimerForTests,
  requestGuiBearerSpendRecovery,
} from "../gui-bearer-spend-recovery";
import {
  cancelGuiBearerSpend,
  findPendingGuiBearerSpendReapproval,
  inspectGuiBearerSpendCancellation,
} from "../gui-bearer-spend-cancellation";
import {
  readGuiBearerSpendTokenPresentable,
  withGuiBearerSpendTokenPresentation,
} from "../gui-bearer-spend-presentation";
import { prepareGuiBearerReclaimOperation } from "../gui-ordinary-wallet-operation";
import { advanceGuiOutgoingRecipientDeliveryOnce } from "../gui-outgoing-recipient-coordinator";
import { advanceGuiParticipationScoreDelivery } from "../../lib/participationScorePayment";

const scoreRemoteMocks = vi.hoisted(() => ({
  getParticipationScore: vi.fn(),
  getParticipationScorePayment: vi.fn(),
  payParticipationScoreEcash: vi.fn(),
}));

vi.mock("@/lib/markets", () => ({
  getParticipationScore: scoreRemoteMocks.getParticipationScore,
  getParticipationScorePayment: scoreRemoteMocks.getParticipationScorePayment,
  payParticipationScoreEcash: scoreRemoteMocks.payParticipationScoreEcash,
}));

const KEYSET_ID = `00${"22".repeat(7)}`;
const PUBLIC_KEY = `02${"33".repeat(32)}`;
const MNEMONIC = `${"abandon ".repeat(11)}about`;
const OTHER_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

function operationInput() {
  return {
    operationId: "wallet-operation-001",
    kind: "regular-split" as const,
    mintUrl: "https://mint.example",
    inputs: [
      {
        id: KEYSET_ID,
        amount: Amount.from(2),
        secret: "11".repeat(32),
        C: PUBLIC_KEY,
      },
    ],
    outputs: {
      change: [
        {
          blindedMessage: {
            amount: 1,
            id: KEYSET_ID,
            B_: PUBLIC_KEY,
          },
          blindingFactor: "44".repeat(32),
          secret: "55".repeat(32),
        },
      ],
    },
    metadata: {
      unit: "sat",
      durableWalletProofTransition: createDurableWalletProofTransition({
        inputSource: "wallet",
        plannedOutputLabels: ["change"],
        resultGroups: {
          change: {
            kind: "wallet",
            asset: "regular",
            reservedBy: null,
          },
        },
      }),
    },
  };
}

function resultProofs() {
  return {
    change: [
      {
        id: KEYSET_ID,
        amount: Amount.from(1),
        secret: "55".repeat(32),
        C: PUBLIC_KEY,
      },
    ],
  };
}

function ordinaryExternalOperationInput(
  kind: "wallet-mint" | "wallet-receive" = "wallet-receive",
) {
  const input = operationInput();
  return {
    ...input,
    operationId: `${kind}-operation-001`,
    kind,
    inputs: kind === "wallet-mint" ? [] : input.inputs,
    outputs: { receive: input.outputs.change },
    metadata: {
      unit: "sat",
      durableWalletProofTransition: createDurableWalletProofTransition({
        inputSource: "external",
        plannedOutputLabels: ["receive"],
        resultGroups: {
          receive: {
            kind: "wallet",
            asset: "regular",
            reservedBy: null,
          },
        },
      }),
    },
  };
}

function ordinaryExternalResultProofs() {
  return { receive: resultProofs().change };
}

function ordinarySendOperationInput() {
  const input = operationInput();
  const passthrough = {
    id: KEYSET_ID,
    amount: Amount.from(2),
    secret: "88".repeat(32),
    C: PUBLIC_KEY,
  };
  const sendOutputs = [
    {
      blindedMessage: {
        amount: 1,
        id: KEYSET_ID,
        B_: PUBLIC_KEY,
      },
      blindingFactor: "66".repeat(32),
      secret: "77".repeat(32),
    },
  ];
  const durableWalletOperation = createDurableWalletSendOperation({
    operationId: "wallet-send-operation-001",
    mintUrl: input.mintUrl,
    unit: "sat",
    preview: {
      amount: Amount.from(1),
      fees: Amount.from(0),
      keysetId: KEYSET_ID,
      inputs: input.inputs,
      keepOutputs: input.outputs.change.map(durableOutputData),
      sendOutputs: sendOutputs.map(durableOutputData),
      unselectedProofs: [passthrough],
    },
  });
  return {
    ...input,
    operationId: "wallet-send-operation-001",
    kind: "wallet-send" as const,
    outputs: {
      keep: input.outputs.change,
      send: sendOutputs,
    },
    metadata: {
      unit: "sat",
      durableWalletOperation,
      guiWalletSendDelivery: walletSendDeliveryMetadata(durableWalletOperation),
      durableWalletProofTransition: createDurableWalletProofTransition({
        inputSource: "wallet",
        plannedOutputLabels: ["keep", "send"],
        resultGroups: {
          keep: { kind: "wallet", asset: "regular", reservedBy: null },
          send: { kind: "operation" },
        },
        passthroughResultGroups: { keep: [passthrough] },
      }),
    },
    passthrough,
  };
}

function ordinarySendResultProofs() {
  const input = ordinarySendOperationInput();
  return {
    keep: [...resultProofs().change, input.passthrough],
    send: [
      {
        id: KEYSET_ID,
        amount: Amount.from(1),
        secret: "77".repeat(32),
        C: PUBLIC_KEY,
      },
    ],
  };
}

function ordinarySendEncodedToken(): string {
  return getEncodedTokenV4({
    mint: ordinarySendOperationInput().mintUrl,
    unit: "sat",
    proofs: ordinarySendResultProofs().send,
  });
}

function durableOutputData(output: {
  blindedMessage: { amount: number; id: string; B_: string };
  blindingFactor: string;
  secret: string;
  ephemeralE?: string;
}): OutputData {
  return new OutputData(
    {
      ...output.blindedMessage,
      amount: Amount.from(output.blindedMessage.amount),
    },
    BigInt(`0x${output.blindingFactor}`),
    new TextEncoder().encode(output.secret),
    output.ephemeralE,
  );
}

function walletSendDeliveryMetadata(
  operation: ReturnType<typeof createDurableWalletSendOperation>,
) {
  return guiWalletSendDeliveryMetadata({
    mintUrl: operation.mintUrl,
    unit: operation.unit,
    sendOutputs: operation.preview.sendOutputs,
    keepOutputs: operation.preview.keepOutputs,
    passthroughProofs: operation.preview.unselectedProofs,
    inputProofs: operation.preview.inputs,
  });
}

function ordinaryRecipientSendOperationInput() {
  const { passthrough, ...base } = ordinarySendOperationInput();
  const durableWalletOperation = createDurableWalletSendOperation({
    operationId: "wallet-send-recipient-operation-001",
    mintUrl: base.mintUrl,
    unit: "sat",
    preview: {
      amount: Amount.from(1),
      fees: Amount.from(0),
      keysetId: KEYSET_ID,
      inputs: base.inputs,
      keepOutputs: base.outputs.keep.map(durableOutputData),
      sendOutputs: base.outputs.send.map(durableOutputData),
      unselectedProofs: [passthrough],
    },
  });
  const durableInput = toDurableCustodyProofOperationInput(
    durableWalletOperation,
  );
  return {
    ...durableInput,
    kind: "wallet-send" as const,
    inputs: durableInput.inputs.map((proof) => ({
      ...proof,
      amount: Amount.from(Number(proof.amount)),
    })) as Proof[],
    outputs: Object.fromEntries(
      Object.entries(durableInput.outputs).map(([label, outputs]) => [
        label,
        outputs.map((output) => ({
          ...output,
          blindedMessage: {
            ...output.blindedMessage,
            amount: Number(output.blindedMessage.amount),
          },
          blindingFactor: durableBlindingFactorHex(output.blindingFactor),
        })),
      ]),
    ),
    metadata: {
      ...durableInput.metadata,
      guiWalletSendDelivery: guiWalletSendDeliveryMetadata({
        mintUrl: durableWalletOperation.mintUrl,
        unit: durableWalletOperation.unit,
        sendOutputs: durableWalletOperation.preview.sendOutputs,
        keepOutputs: durableWalletOperation.preview.keepOutputs,
        passthroughProofs: durableWalletOperation.preview.unselectedProofs,
        inputProofs: durableWalletOperation.preview.inputs,
        policy: {
          kind: "durable-recipient-ack",
          recipient: {
            deliveryId: "00000000-0000-4000-8000-000000000001",
            accountSubject: "account:alice",
            recipientKind: "matching-engine",
            purpose: "participation-score",
            destinationId: "participation-score",
            productBinding: participationScoreRecipientProductBinding(),
            mintUrl: durableWalletOperation.mintUrl,
            unit: durableWalletOperation.unit,
            requestedAmount: "1",
            creditPolicy: { kind: "exact-amount" },
          },
        },
        adapter: { kind: "participation-score" },
      }),
    },
    passthrough,
  };
}

function independentOrdinarySendProofPlan(index: number) {
  const secret = (offset: number) =>
    (index * 8 + offset).toString(16).padStart(2, "0").repeat(32);
  const inputProof = {
    id: KEYSET_ID,
    amount: Amount.from(2),
    secret: secret(1),
    C: PUBLIC_KEY,
  };
  const passthrough = {
    id: KEYSET_ID,
    amount: Amount.from(2),
    secret: secret(2),
    C: PUBLIC_KEY,
  };
  const keepOutput = {
    blindedMessage: { amount: 1, id: KEYSET_ID, B_: PUBLIC_KEY },
    blindingFactor: secret(3),
    secret: secret(4),
  };
  const sendOutput = {
    blindedMessage: { amount: 1, id: KEYSET_ID, B_: PUBLIC_KEY },
    blindingFactor: secret(5),
    secret: secret(6),
  };
  return { inputProof, passthrough, keepOutput, sendOutput };
}

function independentOrdinarySendFixture(index: number, mintUrl: string) {
  const { inputProof, passthrough, keepOutput, sendOutput } =
    independentOrdinarySendProofPlan(index);
  const durableWalletOperation = createDurableWalletSendOperation({
    operationId: `independent-wallet-send-${index}`,
    mintUrl,
    unit: "sat",
    preview: {
      amount: Amount.from(1),
      fees: Amount.from(0),
      keysetId: KEYSET_ID,
      inputs: [inputProof],
      keepOutputs: [durableOutputData(keepOutput)],
      sendOutputs: [durableOutputData(sendOutput)],
      unselectedProofs: [passthrough],
    },
  });
  const input = {
    operationId: `independent-wallet-send-${index}`,
    kind: "wallet-send" as const,
    mintUrl,
    inputs: [inputProof],
    outputs: { keep: [keepOutput], send: [sendOutput] },
    metadata: {
      unit: "sat",
      durableWalletOperation,
      guiWalletSendDelivery: walletSendDeliveryMetadata(durableWalletOperation),
      durableWalletProofTransition: createDurableWalletProofTransition({
        inputSource: "wallet",
        plannedOutputLabels: ["keep", "send"],
        resultGroups: {
          keep: { kind: "wallet", asset: "regular", reservedBy: null },
          send: { kind: "operation" },
        },
        passthroughResultGroups: { keep: [passthrough] },
      }),
    },
  };
  const result = {
    keep: [
      { ...inputProof, amount: Amount.from(1), secret: keepOutput.secret },
      passthrough,
    ],
    send: [
      { ...inputProof, amount: Amount.from(1), secret: sendOutput.secret },
    ],
  };
  return {
    input,
    passthrough,
    result,
    encodedToken: getEncodedTokenV4({
      mint: mintUrl,
      unit: "sat",
      proofs: result.send,
    }),
  };
}

function ordinarySendAlternateEncodedToken(): string {
  return getEncodedTokenV4({
    mint: ordinarySendOperationInput().mintUrl,
    unit: "sat",
    proofs: ordinarySendResultProofs().send,
    memo: "alternate valid presentation",
  });
}

function ordinaryMultiSendOperationInput() {
  const single = ordinarySendOperationInput();
  const secondOutput = {
    ...single.outputs.send[0]!,
    secret: "99".repeat(32),
  };
  const sendOutputs = [...single.outputs.send, secondOutput];
  const durableWalletOperation = createDurableWalletSendOperation({
    operationId: "wallet-multi-send-operation-001",
    mintUrl: single.mintUrl,
    unit: "sat",
    preview: {
      amount: Amount.from(2),
      fees: Amount.from(0),
      keysetId: KEYSET_ID,
      inputs: single.inputs,
      keepOutputs: single.outputs.keep.map(durableOutputData),
      sendOutputs: sendOutputs.map(durableOutputData),
      unselectedProofs: [single.passthrough],
    },
  });
  return {
    ...single,
    operationId: "wallet-multi-send-operation-001",
    outputs: { ...single.outputs, send: sendOutputs },
    metadata: {
      ...single.metadata,
      durableWalletOperation,
      guiWalletSendDelivery: walletSendDeliveryMetadata(durableWalletOperation),
      durableWalletProofTransition: createDurableWalletProofTransition({
        inputSource: "wallet",
        plannedOutputLabels: ["keep", "send"],
        resultGroups: {
          keep: { kind: "wallet", asset: "regular", reservedBy: null },
          send: { kind: "operation" },
        },
        passthroughResultGroups: { keep: [single.passthrough] },
      }),
    },
  };
}

function ordinaryMultiSendResultProofs() {
  const single = ordinarySendResultProofs();
  return {
    ...single,
    send: [...single.send, { ...single.send[0]!, secret: "99".repeat(32) }],
  };
}

function ordinaryMultiSendEncodedToken(): string {
  return getEncodedTokenV4({
    mint: ordinaryMultiSendOperationInput().mintUrl,
    unit: "sat",
    proofs: ordinaryMultiSendResultProofs().send,
  });
}

describe("GUI wallet custody coordinator", () => {
  beforeEach(async () => {
    scoreRemoteMocks.getParticipationScore.mockReset();
    scoreRemoteMocks.getParticipationScorePayment.mockReset();
    scoreRemoteMocks.payParticipationScoreEcash.mockReset();
    scoreRemoteMocks.getParticipationScore.mockResolvedValue({
      accountSubject: "account:alice",
      balance: 0,
      purchasedTotal: 0,
      consumedTotal: 0,
      penaltyTotal: 0,
      matchDebitScore: 1,
      enabled: true,
    });
    useWalletStore.setState({ mnemonic: MNEMONIC });
    vi.spyOn(CashuMint.prototype, "getKeys").mockResolvedValue({
      keysets: [{ id: KEYSET_ID, unit: "sat", keys: { "1": PUBLIC_KEY } }],
    });
    installWebLocks();
    db.close();
    await db.delete();
    await db.open();
    await db.proofs.put(
      prepareStoredProofForWrite(
        {
          ...operationInput().inputs[0]!,
          mintUrl: "https://mint.example",
          unit: "sat",
        },
        1,
        currentGuiWalletId(),
      ),
    );
  });

  afterEach(async () => {
    __resetGuiBearerSpendRecoveryForTests();
    vi.restoreAllMocks();
    delete (navigator as { locks?: LockManager }).locks;
    db.close();
    await db.delete();
  });

  it("co-commits a wallet operation with canonical proof ownership", async () => {
    const prepared = await prepareProofOperation(operationInput());
    const custodyOperationId = prepared.custodyOperationId;
    expect(custodyOperationId).toBeDefined();
    expect(await db.custodySessionLinks.count()).toBe(0);
    expect(await db.durableStorageAccounting.count()).toBe(1);
    expect(await db.durableStorageHeadroom.count()).toBe(1);
    expect((await storedRow("11".repeat(32)))?.reservedBy).toBe(
      "wallet-operation-001",
    );
    expect(
      (await db.custodyOperations.get(custodyOperationId!))?.record.operation
        .binding,
    ).toMatchObject({
      kind: "wallet",
      activityId: "wallet-operation-001",
    });

    await markProofOperationMintSubmitted(prepared.operationId);
    await markProofOperationCompleted(prepared.operationId, resultProofs());

    expect((await storedOperation(prepared.operationId))?.state).toBe(
      "completed",
    );
    expect(
      (await db.custodyOperations.get(custodyOperationId!))?.record.operation
        .result.state,
    ).toBe("applied");
    expect(await storedRow("11".repeat(32))).toBeUndefined();
    expect(await storedRow("55".repeat(32))).toMatchObject({
      mintUrl: "https://mint.example",
      unit: "sat",
      baseAsset: "sat",
    });
  });

  it("blocks new effects after headroom release but permits exact reconciliation", async () => {
    const prepared = await prepareProofOperation(operationInput());
    await markProofOperationMintSubmitted(prepared.operationId);
    await releaseHeadroom();

    await expect(
      requireGuiNewEffectHeadroomForWallet(currentGuiWalletId()),
    ).rejects.toBeInstanceOf(GuiDurableStorageHeadroomUnavailable);

    await expect(
      prepareProofOperation({
        ...ordinaryExternalOperationInput("wallet-mint"),
        operationId: "wallet-mint-headroom-blocked",
      }),
    ).rejects.toThrow("emergency headroom is unavailable");
    expect(
      await db.proofOperations.get(
        proofOperationPrimaryKey(
          currentGuiWalletId(),
          "wallet-mint-headroom-blocked",
        ),
      ),
    ).toBeUndefined();

    await markProofOperationCompleted(prepared.operationId, resultProofs());
    expect(await storedOperation(prepared.operationId)).toMatchObject({
      state: "completed",
    });
    expect(await db.durableStorageHeadroom.count()).toBe(0);
  });

  it("initializes accounting over valid pre-existing ordinary custody", async () => {
    const prepared = await prepareProofOperation(operationInput());
    const operationCount = await db.proofOperations.count();
    const custodyCount = await db.custodyOperations.count();
    await db.durableStorageAccounting.clear();
    await db.durableStorageHeadroom.clear();

    await withGuiCustodyProfileLock(async (_context, walletLock) =>
      withGuiOriginStorageAdmissionLock(
        walletLock,
        currentGuiWalletId,
        (originLock) => initializeGuiDurableStorageAdmission(originLock),
      ),
    );

    expect(await storedOperation(prepared.operationId)).toBeDefined();
    expect(await db.proofOperations.count()).toBe(operationCount);
    expect(await db.custodyOperations.count()).toBe(custodyCount);
    expect(await db.durableStorageHeadroom.count()).toBe(1);
  });

  it("commits an opaque prepared unit only inside its caller-owned write transaction", async () => {
    await withGuiCustodyProfileLock(async ({ walletId }, lock) => {
      const authority = await acquireGuiCustodyAuthority(lock);
      try {
        const snapshot = await readGuiCustodyNativeSnapshot(
          null,
          null,
          walletId,
        );
        const plan = await authority.store.prepareTransaction(
          { scope: authority.scope, owner: authority.owner, operationIds: [] },
          () => "committed" as const,
        );
        const prepared = await prepareGuiCustodyUnitOfWork({
          authority,
          plan,
          snapshot,
        });

        await expect(
          commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction(prepared),
        ).rejects.toThrow("active write transaction");
        await expect(
          commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction({
            walletId,
          } as never),
        ).rejects.toThrow("was not prepared");

        const result = await db.transaction(
          "rw",
          guiCustodyUnitOfWorkTables(authority),
          async () =>
            commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction(prepared),
        );
        expect(result).toBe("committed");
      } finally {
        await releaseGuiCustodyAuthority(lock, authority);
      }
    });
  });

  it("prepares an ordinary wallet mint without inventing input proofs", async () => {
    await db.proofs.clear();

    const prepared = await prepareProofOperation(
      ordinaryExternalOperationInput("wallet-mint"),
    );

    expect(prepared).toMatchObject({
      kind: "wallet-mint",
      state: "prepared",
      inputs: [],
    });
  });

  it("atomically aborts one unsubmitted expired mint and admits a regenerated invoice", async () => {
    const first = await prepareProofOperation(
      ordinaryExternalOperationInput("wallet-mint"),
    );

    await abortPreparedGuiWalletMintForWallet(
      first.walletId,
      first.operationId,
      {
        kind: "abort-no-transport",
        classification: "all-inputs-unspent",
        reason: "mint-quote-expired",
      },
    );

    expect(await storedOperation(first.operationId)).toMatchObject({
      state: "Failed",
      failureCode: 408,
      lastError: "Lightning mint quote expired before transport",
    });
    expect(
      await db.custodyOperations.get(first.custodyOperationId),
    ).toMatchObject({
      active: 0,
      record: { operation: { state: "aborted", result: { state: "none" } } },
    });

    const replacement = await prepareProofOperation({
      ...ordinaryExternalOperationInput("wallet-mint"),
      operationId: "wallet-mint-operation-002",
    });
    expect(replacement.state).toBe("prepared");
    expect(
      await db.custodyOperations.get(replacement.custodyOperationId),
    ).toMatchObject({ active: 1 });
  });

  it("never aborts an expired mint after transport ownership was claimed", async () => {
    const prepared = await prepareProofOperation(
      ordinaryExternalOperationInput("wallet-mint"),
    );
    await claimPreparedProofOperationMintSubmissionForWallet(
      prepared.walletId,
      prepared.operationId,
    );

    await expect(
      abortPreparedGuiWalletMintForWallet(
        prepared.walletId,
        prepared.operationId,
        {
          kind: "abort-no-transport",
          classification: "all-inputs-unspent",
          reason: "mint-quote-expired",
        },
      ),
    ).rejects.toThrow(/not prepared|safe to abort/);

    expect(await storedOperation(prepared.operationId)).toMatchObject({
      state: "mint-submitted",
    });
    expect(
      await db.custodyOperations.get(prepared.custodyOperationId),
    ).toMatchObject({
      active: 1,
      record: { operation: { state: "transport-attempted" } },
    });
  });

  it("restarts and completes a no-DLEQ external receive without reserving or deleting its inputs", async () => {
    await db.proofs.clear();
    const input = ordinaryExternalOperationInput();
    const prepared = await prepareProofOperation(input);
    expect(await storedRow("11".repeat(32))).toBeUndefined();
    const custodyOperationId = prepared.custodyOperationId;
    if (!custodyOperationId) throw new Error("missing custody operation id");
    expect(
      (await db.custodyOperations.get(custodyOperationId))?.record.operation
        .verification.keysetBindings,
    ).toEqual([
      expect.objectContaining({ keysetId: KEYSET_ID, requireDleq: false }),
    ]);

    db.close();
    await db.open();
    await expect(prepareProofOperation(input)).resolves.toMatchObject({
      operationId: prepared.operationId,
      state: "prepared",
    });
    await markProofOperationMintSubmitted(prepared.operationId);
    await markProofOperationCompleted(
      prepared.operationId,
      ordinaryExternalResultProofs(),
    );

    expect(await storedRow("11".repeat(32))).toBeUndefined();
    const received = await storedRow("55".repeat(32));
    expect(received).toMatchObject({
      mintUrl: "https://mint.example",
      unit: "sat",
    });
    expect(received).not.toHaveProperty("reservedBy");
    expect(await listWalletActivities(currentGuiWalletId())).toEqual([
      expect.objectContaining({
        id: prepared.operationId,
        type: "deposit",
        amountSats: 1,
        baseAsset: "sat",
      }),
    ]);
  });

  it("atomically co-commits and idempotently replays deposit activity", async () => {
    await db.proofs.clear();
    const prepared = await prepareProofOperation(
      ordinaryExternalOperationInput("wallet-mint"),
    );
    await markProofOperationMintSubmitted(prepared.operationId);
    const putActivity = vi
      .spyOn(db.walletActivities, "put")
      .mockRejectedValueOnce(new Error("crash at activity projection"));

    await expect(
      markProofOperationCompleted(
        prepared.operationId,
        ordinaryExternalResultProofs(),
      ),
    ).rejects.toThrow("crash at activity projection");
    expect((await storedOperation(prepared.operationId))?.state).toBe(
      "mint-submitted",
    );
    expect(await storedRow("55".repeat(32))).toBeUndefined();
    expect(await db.walletActivities.count()).toBe(0);

    putActivity.mockRestore();
    await markProofOperationCompleted(
      prepared.operationId,
      ordinaryExternalResultProofs(),
    );
    db.close();
    await db.open();
    await markProofOperationCompleted(
      prepared.operationId,
      ordinaryExternalResultProofs(),
    );

    expect(await db.walletActivities.count()).toBe(1);
    expect(await listWalletActivities(currentGuiWalletId())).toEqual([
      expect.objectContaining({
        id: prepared.operationId,
        amountSats: 1,
        status: "completed",
      }),
    ]);
  });

  it("rejects an external receive that collides with any local proof", async () => {
    const input = ordinaryExternalOperationInput();

    await expect(prepareProofOperation(input)).rejects.toThrow(
      /external GUI operation references a wallet proof/i,
    );

    expect(await db.proofOperations.count()).toBe(0);
    expect(await db.custodyOperations.count()).toBe(0);
    expect(await storedRow("11".repeat(32))).not.toHaveProperty("reservedBy");
  });

  it("does not delete an external input that appears after receive preparation", async () => {
    const collision = await storedRow("11".repeat(32));
    expect(collision).toBeDefined();
    await db.proofs.clear();
    const prepared = await prepareProofOperation(
      ordinaryExternalOperationInput(),
    );
    await db.proofs.put(collision!);
    await markProofOperationMintSubmitted(prepared.operationId);

    await expect(
      markProofOperationCompleted(
        prepared.operationId,
        ordinaryExternalResultProofs(),
      ),
    ).rejects.toThrow(/external GUI operation references a wallet proof/i);

    expect(await storedRow("11".repeat(32))).toEqual(collision);
    expect((await storedOperation(prepared.operationId))?.state).toBe(
      "mint-submitted",
    );
  });

  it("atomically grants one ordinary-wallet mint submission claim", async () => {
    await db.proofs.clear();
    const prepared = await prepareProofOperation(
      ordinaryExternalOperationInput(),
    );
    const walletId = currentGuiWalletId();

    const claims = await Promise.all([
      claimPreparedProofOperationMintSubmissionForWallet(
        walletId,
        prepared.operationId,
      ),
      claimPreparedProofOperationMintSubmissionForWallet(
        walletId,
        prepared.operationId,
      ),
    ]);

    expect(claims.map(({ claimed }) => claimed).sort()).toEqual([false, true]);
    expect(
      claims.every(({ record }) => record.state === "mint-submitted"),
    ).toBe(true);
    await markProofOperationCompleted(
      prepared.operationId,
      ordinaryExternalResultProofs(),
    );
    await expect(
      claimPreparedProofOperationMintSubmissionForWallet(
        walletId,
        prepared.operationId,
      ),
    ).rejects.toThrow(/terminal proof operation/i);
  });

  it("rejects a completed ordinary operation whose canonical result authority changed", async () => {
    await db.proofs.clear();
    const prepared = await prepareProofOperation(
      ordinaryExternalOperationInput(),
    );
    await markProofOperationMintSubmitted(prepared.operationId);
    await markProofOperationCompleted(
      prepared.operationId,
      ordinaryExternalResultProofs(),
    );
    const walletId = currentGuiWalletId();
    await expect(
      requireCompletedGuiWalletProofOperationAuthorityForWallet(
        walletId,
        prepared.operationId,
      ),
    ).resolves.toMatchObject({ state: "completed" });

    const row = await db.custodyOperations.get(prepared.custodyOperationId!);
    expect(row).toBeDefined();
    await db.custodyOperations.put({
      ...row!,
      record: {
        ...row!.record,
        operation: {
          ...row!.record.operation,
          result: {
            ...row!.record.operation.result,
            resultFingerprint: "a".repeat(64),
          },
        },
      },
    });

    await expect(
      requireCompletedGuiWalletProofOperationAuthorityForWallet(
        walletId,
        prepared.operationId,
      ),
    ).rejects.toThrow(/completed result conflicts with canonical custody/i);
  });

  it("rejects completed ordinary authority when its physical result proof is missing", async () => {
    await db.proofs.clear();
    const prepared = await prepareProofOperation(
      ordinaryExternalOperationInput(),
    );
    await markProofOperationMintSubmitted(prepared.operationId);
    await markProofOperationCompleted(
      prepared.operationId,
      ordinaryExternalResultProofs(),
    );
    await db.proofs.clear();

    await expect(
      requireCompletedGuiWalletProofOperationAuthorityForWallet(
        currentGuiWalletId(),
        prepared.operationId,
      ),
    ).rejects.toThrow(/result proof is missing/i);
  });

  it.each([
    { name: "C", conflict: { C: `03${"44".repeat(32)}` } },
    {
      name: "DLEQ",
      conflict: {
        dleq: {
          e: "11".repeat(32),
          s: "22".repeat(32),
          r: "33".repeat(32),
        },
      },
    },
    { name: "P2PK", conflict: { p2pk_e: `02${"44".repeat(32)}` } },
    {
      name: "witness",
      conflict: {
        witness: JSON.stringify({ signatures: ["44".repeat(64)] }),
      },
    },
  ])(
    "rejects completed ordinary authority when its physical $name changed",
    async ({ conflict }) => {
      await db.proofs.clear();
      const prepared = await prepareProofOperation(
        ordinaryExternalOperationInput(),
      );
      await markProofOperationMintSubmitted(prepared.operationId);
      await markProofOperationCompleted(
        prepared.operationId,
        ordinaryExternalResultProofs(),
      );
      const stored = await db.proofs.toCollection().first();
      expect(stored).toBeDefined();
      await db.proofs.put({ ...stored!, ...conflict });

      await expect(
        requireCompletedGuiWalletProofOperationAuthorityForWallet(
          currentGuiWalletId(),
          prepared.operationId,
        ),
      ).rejects.toThrow(/conflicts with existing wallet authority/i);
    },
  );

  it("replays completed CTF redemption with its validated submission overlay", async () => {
    const prepared = await prepareProofOperation({
      ...operationInput(),
      operationId: "ctf-redeem-completed-replay",
      kind: "ctf-redeem",
    });
    await markProofOperationMintSubmitted(prepared.operationId, {
      schemaVersion: 1,
      requestDigest: "a".repeat(64),
    });
    await markProofOperationCompleted(prepared.operationId, resultProofs());

    await expect(
      markProofOperationCompleted(prepared.operationId, resultProofs()),
    ).resolves.toMatchObject({
      operationId: prepared.operationId,
      state: "completed",
    });
  });

  it("resolves mint keys before acquiring the same-wallet Web Lock", async () => {
    const resolutionStarted = deferred<void>();
    const resolution = deferred<ReturnType<typeof mintKeysResponse>>();
    vi.mocked(CashuMint.prototype.getKeys).mockImplementation(async () => {
      resolutionStarted.resolve(undefined);
      return resolution.wait;
    });

    const preparation = prepareProofOperation(operationInput());
    await resolutionStarted.wait;

    const acquired = await navigator.locks.request(
      guiWalletLockName(currentGuiWalletId()),
      { mode: "exclusive", ifAvailable: true },
      (lock) => lock !== null,
    );
    resolution.resolve(mintKeysResponse());
    await expect(preparation).resolves.toMatchObject({
      operationId: operationInput().operationId,
      state: "prepared",
    });
    expect(acquired).toBe(true);
  });

  it("fails with zero writes when the seed changes before the short commit", async () => {
    const resolutionStarted = deferred<void>();
    const resolution = deferred<ReturnType<typeof mintKeysResponse>>();
    vi.mocked(CashuMint.prototype.getKeys).mockImplementation(async () => {
      resolutionStarted.resolve(undefined);
      return resolution.wait;
    });

    const preparation = prepareProofOperation(operationInput());
    await resolutionStarted.wait;
    useWalletStore.setState({ mnemonic: OTHER_MNEMONIC });
    resolution.resolve(mintKeysResponse());

    await expect(preparation).rejects.toThrow(/wallet changed/i);
    expect(await db.proofOperations.count()).toBe(0);
    expect(await db.custodyOperations.count()).toBe(0);
    expect(await db.custodyProofReservations.count()).toBe(0);
    expect((await storedRow("11".repeat(32)))?.reservedBy).toBeUndefined();
  });

  it("revalidates the captured wallet for every proof-operation store method", async () => {
    const walletId = currentGuiWalletId();
    const store = createCapturedGuiWalletProofOperationStore(walletId);
    const prepared = await store.prepareProofOperation(operationInput());
    useWalletStore.setState({ mnemonic: OTHER_MNEMONIC });

    await expect(store.getProofOperation(prepared.operationId)).rejects.toThrow(
      /wallet changed/i,
    );
    await expect(store.prepareProofOperation(operationInput())).rejects.toThrow(
      /wallet changed/i,
    );
    await expect(
      store.markProofOperationMintSubmitted(prepared.operationId),
    ).rejects.toThrow(/wallet changed/i);
    await expect(
      store.markProofOperationCompleted(prepared.operationId, resultProofs()),
    ).rejects.toThrow(/wallet changed/i);
    await expect(
      store.markProofOperationFailed!(
        prepared.operationId,
        "terminal rejection",
        13044,
      ),
    ).rejects.toThrow(/wallet changed/i);

    expect(await db.proofOperations.count()).toBe(1);
    expect(
      (await storedOperationForWallet(walletId, prepared.operationId))?.state,
    ).toBe("prepared");
    expect(await db.custodyOperations.count()).toBe(1);
    expect(await db.custodyProofReservations.count()).toBe(1);
  });

  it.each(["submitted", "completed", "failed"] as const)(
    "revalidates exact native authority before the %s transition",
    async (transition) => {
      const walletId = currentGuiWalletId();
      const store = createCapturedGuiWalletProofOperationStore(walletId);
      const prepared = await store.prepareProofOperation(operationInput());
      await db.proofOperations.update(
        proofOperationPrimaryKey(walletId, prepared.operationId),
        { mintUrl: "https://foreign.example" },
      );

      const attempt =
        transition === "submitted"
          ? store.markProofOperationMintSubmitted(prepared.operationId)
          : transition === "completed"
            ? store.markProofOperationCompleted(
                prepared.operationId,
                resultProofs(),
              )
            : store.markProofOperationFailed!(
                prepared.operationId,
                "terminal rejection",
                13044,
              );
      await expect(attempt).rejects.toThrow(/foreign exact custody authority/);

      expect(
        (await storedOperationForWallet(walletId, prepared.operationId))?.state,
      ).toBe("prepared");
      expect(await db.custodyProofReservations.count()).toBe(1);
    },
  );

  it("applies a persisted result reservation without a post-mint rewrite gap", async () => {
    const reservation = "00000000-0000-4000-8000-000000000001";
    const prepared = await prepareProofOperation({
      ...operationInput(),
      metadata: {
        unit: "sat",
        durableWalletProofTransition: createDurableWalletProofTransition({
          inputSource: "wallet",
          plannedOutputLabels: ["change"],
          resultGroups: {
            change: {
              kind: "wallet",
              asset: "regular",
              reservedBy: reservation,
            },
          },
        }),
      },
    });
    await markProofOperationMintSubmitted(prepared.operationId);

    await markProofOperationCompleted(prepared.operationId, resultProofs());

    expect(await storedRow("55".repeat(32))).toMatchObject({
      reservedBy: reservation,
    });
  });

  it("keeps the Dexie transaction active and rolls back a quota failure after mint response", async () => {
    const prepared = await prepareProofOperation(operationInput());
    await markProofOperationMintSubmitted(prepared.operationId);
    let observedActiveTransaction = false;
    const operationPut = vi
      .spyOn(db.proofOperations, "put")
      .mockImplementation((() => {
        observedActiveTransaction = Dexie.currentTransaction !== null;
        throw new DOMException(
          "injected native write failure",
          "QuotaExceededError",
        );
      }) as never);

    await expect(
      markProofOperationCompleted(prepared.operationId, resultProofs()),
    ).rejects.toMatchObject({ name: "QuotaExceededError" });
    operationPut.mockRestore();

    expect(observedActiveTransaction).toBe(true);
    expect((await storedOperation(prepared.operationId))?.state).toBe(
      "mint-submitted",
    );
    expect(
      (await db.custodyOperations.get(prepared.custodyOperationId!))?.record
        .operation.state,
    ).toBe("transport-attempted");
    expect((await storedRow("11".repeat(32)))?.reservedBy).toBe(
      prepared.operationId,
    );
    expect(await storedRow("55".repeat(32))).toBeUndefined();
  });

  describe("wallet-send custody", () => {
    async function prepareOrdinarySendFixture() {
      const { passthrough, ...input } = ordinarySendOperationInput();
      await db.proofs.put(
        prepareStoredProofForWrite(
          { ...passthrough, mintUrl: input.mintUrl, unit: "sat" },
          2,
          currentGuiWalletId(),
        ),
      );
      return {
        input,
        passthrough,
        prepared: await prepareProofOperation(input),
      };
    }

    async function completeOrdinarySendFixture() {
      const fixture = await prepareOrdinarySendFixture();
      await markProofOperationMintSubmitted(fixture.prepared.operationId);
      await markProofOperationCompleted(
        fixture.prepared.operationId,
        ordinarySendResultProofs(),
        ordinarySendEncodedToken(),
      );
      return fixture;
    }

    async function completeOrdinaryMultiSendFixture() {
      const { passthrough, ...input } = ordinaryMultiSendOperationInput();
      await db.proofs.put(
        prepareStoredProofForWrite(
          { ...passthrough, mintUrl: input.mintUrl, unit: "sat" },
          2,
          currentGuiWalletId(),
        ),
      );
      const prepared = await prepareProofOperation(input);
      await markProofOperationMintSubmitted(prepared.operationId);
      await markProofOperationCompleted(
        prepared.operationId,
        ordinaryMultiSendResultProofs(),
        ordinaryMultiSendEncodedToken(),
      );
      return { input, passthrough, prepared };
    }

    async function completeIndependentOrdinarySend(
      index: number,
      mintUrl: string,
    ) {
      const fixture = independentOrdinarySendFixture(index, mintUrl);
      await db.proofs.bulkPut(
        [fixture.input.inputs[0]!, fixture.passthrough].map((proof) =>
          prepareStoredProofForWrite(
            { ...proof, mintUrl, unit: "sat" },
            2,
            currentGuiWalletId(),
          ),
        ),
      );
      const prepared = await prepareProofOperation(fixture.input);
      await markProofOperationMintSubmitted(prepared.operationId);
      await markProofOperationCompleted(
        prepared.operationId,
        fixture.result,
        fixture.encodedToken,
      );
      return prepared;
    }

    it("atomically advances a durable recipient pre-intent with its exact token", async () => {
      const { passthrough, ...input } = ordinaryRecipientSendOperationInput();
      await db.proofs.put(
        prepareStoredProofForWrite(
          { ...passthrough, mintUrl: input.mintUrl, unit: "sat" },
          2,
          currentGuiWalletId(),
        ),
      );
      const prepared = await prepareProofOperation(input);
      const preparedDelivery = await db.outgoingRecipientDeliveries.get([
        currentGuiWalletId(),
        "00000000-0000-4000-8000-000000000001",
      ]);
      expect(preparedDelivery).toMatchObject({
        operationId: prepared.operationId,
        adapter: { kind: "participation-score" },
        revision: 0,
        active: 1,
        delivery: { kind: "prepared" },
      });

      await markProofOperationMintSubmitted(prepared.operationId);
      await markProofOperationCompleted(
        prepared.operationId,
        ordinarySendResultProofs(),
        ordinarySendEncodedToken(),
      );

      expect(
        await requireGuiWalletSendTokenForWallet(
          currentGuiWalletId(),
          prepared.operationId,
        ),
      ).toBe(ordinarySendEncodedToken());
      expect(
        await db.outgoingRecipientDeliveries.get([
          currentGuiWalletId(),
          "00000000-0000-4000-8000-000000000001",
        ]),
      ).toMatchObject({
        operationId: prepared.operationId,
        adapter: { kind: "participation-score" },
        revision: 1,
        active: 1,
        delivery: {
          kind: "active",
          record: {
            delivery: {
              request: {
                purpose: "participation-score",
                tokenDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
              },
              state: { kind: "pending" },
            },
          },
        },
      });
      expect(await db.bearerSpendDeliveries.count()).toBe(0);

      let submittedRequest:
        | ReturnType<typeof readDurableRecipientSubmissionAuthority>["request"]
        | undefined;
      let statusReads = 0;
      const transport = {
        readStatus: vi.fn(async () => {
          statusReads += 1;
          if (statusReads === 1) return { kind: "not-found" as const };
          if (!submittedRequest) {
            throw new Error("recipient request was not submitted");
          }
          return {
            kind: "credited" as const,
            request: submittedRequest,
            receiptOperationId: `score-receipt/${submittedRequest.deliveryId}`,
            receivedAtMs: 100,
            creditedAmount: submittedRequest.requestedAmount,
            creditVerification: { kind: "exact-amount" as const },
            businessEventId: submittedRequest.deliveryId,
            creditedAtMs: 200,
          };
        }),
        submitExact: vi.fn(
          async (authority: DurableRecipientSubmissionAuthority) => {
            submittedRequest =
              readDurableRecipientSubmissionAuthority(authority).request;
            return { kind: "accepted" as const };
          },
        ),
      };
      await expect(
        advanceGuiOutgoingRecipientDeliveryOnce({
          walletId: currentGuiWalletId(),
          deliveryId: "00000000-0000-4000-8000-000000000001",
          transport,
          nowMs: 300,
        }),
      ).resolves.toMatchObject({ kind: "pending" });
      const payloadDelete = vi
        .spyOn(db.walletSendDeliveryPayloads, "delete")
        .mockRejectedValueOnce(new Error("crash-before-recipient-handoff"));
      await expect(
        advanceGuiOutgoingRecipientDeliveryOnce({
          walletId: currentGuiWalletId(),
          deliveryId: "00000000-0000-4000-8000-000000000001",
          transport,
          nowMs: 400,
        }),
      ).rejects.toThrow("crash-before-recipient-handoff");
      expect(
        await db.outgoingRecipientDeliveries.get([
          currentGuiWalletId(),
          "00000000-0000-4000-8000-000000000001",
        ]),
      ).toMatchObject({
        revision: 3,
        active: 0,
        delivery: {
          kind: "active",
          record: { delivery: { state: { kind: "credited" } } },
        },
      });
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeDefined();
      expect(
        (await db.custodyOperations.get(prepared.custodyOperationId))?.record
          .operation.delivery.state,
      ).toBe("pending");
      payloadDelete.mockRestore();

      db.close();
      await db.open();
      const recoveryTransport = {
        readStatus: vi.fn(async () => {
          throw new Error("credited recovery must not read recipient status");
        }),
        submitExact: vi.fn(async () => {
          throw new Error("credited recovery must not resubmit");
        }),
      };
      await expect(
        advanceGuiOutgoingRecipientDeliveryOnce({
          walletId: currentGuiWalletId(),
          deliveryId: "00000000-0000-4000-8000-000000000001",
          transport: recoveryTransport,
          nowMs: 500,
        }),
      ).resolves.toMatchObject({
        kind: "credited",
        row: { revision: 3, active: 0 },
      });
      expect(transport.submitExact).toHaveBeenCalledTimes(1);
      expect(recoveryTransport.readStatus).not.toHaveBeenCalled();
      expect(recoveryTransport.submitExact).not.toHaveBeenCalled();
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
      expect(
        (await db.custodyOperations.get(prepared.custodyOperationId))?.record
          .operation.delivery.state,
      ).toBe("acknowledged");
    });

    it("restarts the real Score adapter after a lost credited response without resubmitting its token", async () => {
      const { passthrough, ...input } = ordinaryRecipientSendOperationInput();
      await db.proofs.put(
        prepareStoredProofForWrite(
          { ...passthrough, mintUrl: input.mintUrl, unit: "sat" },
          2,
          currentGuiWalletId(),
        ),
      );
      const prepared = await prepareProofOperation(input);
      await markProofOperationMintSubmitted(prepared.operationId);
      await markProofOperationCompleted(
        prepared.operationId,
        ordinarySendResultProofs(),
        ordinarySendEncodedToken(),
      );

      const active = await db.outgoingRecipientDeliveries.get([
        currentGuiWalletId(),
        "00000000-0000-4000-8000-000000000001",
      ]);
      if (!active || active.delivery.kind !== "active") {
        throw new Error("Score delivery fixture is not active");
      }
      const request = active.delivery.record.delivery.request;
      const creditedStatus = {
        schemaVersion: 1,
        paymentId: request.deliveryId,
        status: "credited",
        accountSubject: request.accountSubject,
        recipientKind: request.recipientKind,
        purpose: request.purpose,
        destinationId: request.destinationId,
        mintUrl: request.mintUrl,
        unit: request.unit,
        amountSats: Number(request.requestedAmount),
        tokenDigest: request.tokenDigest,
        encodedTokenBytes: request.encodedTokenBytes,
        receiptOperationId: `score-receipt/${request.deliveryId}`,
        receivedAt: "2026-07-16T00:00:00.000Z",
        creditedScore: Number(request.requestedAmount),
        businessEventId: request.deliveryId,
        creditedAt: "2026-07-16T00:00:01.000Z",
      } as const;
      let remoteStatus: typeof creditedStatus | null = null;
      scoreRemoteMocks.getParticipationScorePayment.mockImplementation(
        async () => remoteStatus,
      );
      scoreRemoteMocks.payParticipationScoreEcash.mockImplementation(
        async () => {
          remoteStatus = creditedStatus;
          throw new Error("lost-response-after-Score-credit");
        },
      );

      await expect(
        advanceGuiParticipationScoreDelivery(
          currentGuiWalletId(),
          request.deliveryId,
        ),
      ).rejects.toThrow("lost-response-after-Score-credit");
      expect(
        scoreRemoteMocks.payParticipationScoreEcash,
      ).toHaveBeenCalledOnce();
      expect(scoreRemoteMocks.payParticipationScoreEcash).toHaveBeenCalledWith(
        request.accountSubject,
        Number(request.requestedAmount),
        ordinarySendEncodedToken(),
        request.deliveryId,
      );
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeDefined();

      db.close();
      await db.open();

      await expect(
        advanceGuiParticipationScoreDelivery(
          currentGuiWalletId(),
          request.deliveryId,
        ),
      ).resolves.toMatchObject({
        kind: "credited",
        row: {
          active: 0,
          delivery: {
            kind: "active",
            record: { delivery: { state: { kind: "credited" } } },
          },
        },
      });
      expect(
        scoreRemoteMocks.payParticipationScoreEcash,
      ).toHaveBeenCalledOnce();
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
      expect(
        (await db.custodyOperations.get(prepared.custodyOperationId))?.record
          .operation.delivery.state,
      ).toBe("acknowledged");
    });

    it("atomically replaces a wallet send while retaining exact passthrough proofs", async () => {
      const { input, passthrough, prepared } =
        await prepareOrdinarySendFixture();
      expect((await storedRow(passthrough.secret))?.reservedBy).toBe(
        prepared.operationId,
      );
      await markProofOperationMintSubmitted(prepared.operationId);
      await markProofOperationCompleted(
        prepared.operationId,
        ordinarySendResultProofs(),
        ordinarySendEncodedToken(),
      );
      expect(
        await db.walletSendDeliveryReservations.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();

      expect(await storedRow(input.inputs[0]!.secret)).toBeUndefined();
      expect(await storedRow("55".repeat(32))).toMatchObject({ amount: 1 });
      const retained = await storedRow(passthrough.secret);
      expect(retained).toMatchObject({ amount: 2 });
      expect(retained?.reservedBy).toBeUndefined();
      expect(await storedRow("77".repeat(32))).toBeUndefined();
      expect(
        (
          await db.walletSendDeliveryPayloads.get([
            currentGuiWalletId(),
            prepared.operationId,
          ])
        )?.encodedToken,
      ).toBe(ordinarySendEncodedToken());

      db.close();
      await db.open();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      const mintBootstrap = vi.fn(async () => {
        throw new Error("delivery-only recovery must not load mint transport");
      });
      useWalletStore.setState({ getWalletForUnit: mintBootstrap as never });
      try {
        await expect(recoverGuiNativeProofOperations()).resolves.toBe("clear");
      } finally {
        useWalletStore.setState({ getWalletForUnit: originalGetWalletForUnit });
        __resetGuiNativeProofOperationRecoverySchedulerForTests();
      }
      expect(mintBootstrap).not.toHaveBeenCalled();
      const canonical = await db.custodyOperations.get(
        prepared.custodyOperationId!,
      );
      if (!canonical) throw new Error("missing canonical wallet-send row");
      await db.custodyOperations.bulkPut(
        Array.from({ length: 256 }, (_, index) => ({
          ...structuredClone(canonical),
          operationId: `unrelated-active-${index}`,
        })),
      );
      const custodyScan = vi.spyOn(db.custodyOperations, "toArray");
      const proofOperationBatchRead = vi.spyOn(db.proofOperations, "bulkGet");
      await expect(
        getPendingGuiWalletSendDeliveryForWallet(currentGuiWalletId()),
      ).resolves.toMatchObject({ operationId: prepared.operationId });
      expect(custodyScan).not.toHaveBeenCalled();
      expect(proofOperationBatchRead).not.toHaveBeenCalled();
      await expect(
        getPendingGuiWalletSendDeliveryForWallet(currentGuiWalletId()),
      ).resolves.toMatchObject({ operationId: prepared.operationId });
      const custodyOperationId = prepared.custodyOperationId;
      if (!custodyOperationId)
        throw new Error("missing wallet-send custody id");
      expect(
        (await db.custodyOperations.get(custodyOperationId))?.record.operation
          .delivery,
      ).toMatchObject({ state: "acknowledged", expiresAtMs: null });
      const bearer = await db.bearerSpendDeliveries
        .where("[walletId+presentable+createdAtMs+deliveryId]")
        .between(
          [currentGuiWalletId(), 1, 0, Dexie.minKey],
          [currentGuiWalletId(), 1, Number.MAX_SAFE_INTEGER, Dexie.maxKey],
        )
        .first();
      expect(bearer?.walletId).toBe(currentGuiWalletId());
      expect(bearer?.parentOperationId).toBe(custodyOperationId);
      expect(bearer?.active).toBe(1);
      expect(bearer?.nextAttemptAtMs).toBe(bearer?.record.createdAtMs);
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toMatchObject({ encodedToken: ordinarySendEncodedToken() });

      const replayPayloadPut = vi.spyOn(db.walletSendDeliveryPayloads, "put");
      await markProofOperationCompleted(
        prepared.operationId,
        ordinarySendResultProofs(),
      );
      await markProofOperationCompleted(
        prepared.operationId,
        ordinarySendResultProofs(),
        ordinarySendEncodedToken(),
      );
      expect(replayPayloadPut).not.toHaveBeenCalled();
      replayPayloadPut.mockRestore();
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toMatchObject({ encodedToken: ordinarySendEncodedToken() });
    });

    it("restarts a mint-submitted wallet-send and completes its exact result", async () => {
      const { prepared } = await prepareOrdinarySendFixture();
      const reservation = await db.walletSendDeliveryReservations.get([
        currentGuiWalletId(),
        prepared.operationId,
      ]);
      if (!reservation) throw new Error("missing wallet-send reservation");
      expect(reservation.custodyOperationId).toBe(prepared.custodyOperationId);
      expect(reservation.reservedBytes).toBe(
        readGuiWalletSendDeliveryMetadata(prepared)?.admission
          .durableStorageBytesRequired,
      );
      expect(reservation.padding.byteLength).toBe(reservation.reservedBytes);
      expect(reservation.paddingDigest).toMatch(/^[0-9a-f]{64}$/);
      await claimPreparedProofOperationMintSubmissionForWallet(
        currentGuiWalletId(),
        prepared.operationId,
      );

      db.close();
      await db.open();
      await markProofOperationCompleted(
        prepared.operationId,
        ordinarySendResultProofs(),
        ordinarySendEncodedToken(),
      );
      expect((await storedOperation(prepared.operationId))?.state).toBe(
        "completed",
      );
      expect(
        await db.walletSendDeliveryReservations.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
    });

    it("rejects cloned handoff authority and substituted bearer post-images", async () => {
      const { prepared } = await prepareOrdinarySendFixture();
      await markProofOperationMintSubmitted(prepared.operationId);
      await withGuiCustodyProfileLock(async (_context, lock) => {
        const authority = await acquireGuiCustodyAuthority(lock);
        try {
          const snapshot = await readGuiCustodyOperationSnapshot(
            prepared.operationId,
            currentGuiWalletId(),
            Object.values(ordinarySendResultProofs()).flat(),
          );
          const operation = snapshot.operation;
          if (!operation) throw new Error("missing wallet-send operation");
          const resultProofs = ordinarySendResultProofs();
          const encodedToken = ordinarySendEncodedToken();
          const resultFingerprint =
            deriveDurableCustodyProofResultFingerprint(resultProofs);
          const custodyPlan = await prepareGuiCustodyTransition(
            authority,
            operation,
            (record, transaction) => {
              const outputPlanFingerprint =
                record.operation.outputPlan.outputPlanFingerprint;
              const resultHandle = `result:${resultFingerprint}`;
              transaction.stageVerifiedResult({
                operationId: record.operation.operationId,
                outputPlanFingerprint,
                resultHandle,
                resultFingerprint,
              });
              transaction.applyVerifiedResult({
                operationId: record.operation.operationId,
                outputPlanFingerprint,
                resultHandle,
                resultFingerprint,
              });
            },
          );
          const walletOperation = decodeDurableWalletOperation(
            operation.metadata.durableWalletOperation,
          );
          const deliveryMetadata = readGuiWalletSendDeliveryMetadata(operation);
          if (
            walletOperation.kind !== "wallet-send" ||
            deliveryMetadata?.mode !== "user-export"
          ) {
            throw new Error("missing exact wallet-send preparation");
          }
          const exactPayload = planDurableWalletSendExactPayload({
            preparation: prepareDurableWalletSendDelivery({
              walletOperation,
              policy: { kind: "user-export" },
              admission: deliveryMetadata.admission,
            }),
            walletOperation,
            resultGroups: resultProofs,
            payloadHandle: `wallet-send:${operation.operationId}`,
            encodedToken,
          });
          custodyPlan.transaction.stageWalletSendExactPayload(
            operation.custodyOperationId,
            exactPayload,
          );
          const pendingRows = custodyPlan.transaction.operationRows();
          if (pendingRows.length !== 1) {
            throw new Error("missing pending custody post-image");
          }
          const nextOperation = {
            ...operation,
            state: "completed" as const,
            resultProofs,
            lastError: null,
            failureCode: undefined,
            updatedAt: Date.now(),
          };
          const payload = createGuiWalletSendDeliveryPayloadRow(
            nextOperation,
            encodedToken,
          );
          const pendingState = {
            scopeState: custodyPlan.transaction.scopeState(),
            operation: pendingRows[0]!.record,
          };
          const delivery = pendingState.operation.operation.delivery;
          if (delivery.deliveryId === null || delivery.payloadHandle === null) {
            throw new Error("missing pending delivery identity");
          }
          const bearerRecord = createDurableBearerSpendDeliveryRecord({
            deliveryId: delivery.deliveryId,
            walletId: operation.walletId,
            parentOperationId: operation.custodyOperationId,
            payloadHandle: delivery.payloadHandle,
            mintUrl: operation.mintUrl,
            unit: "sat",
            encodedToken,
            proofs: resultProofs.send,
            origin: "local",
            createdAtMs: nextOperation.updatedAt,
          });
          const handoffPlan = planDurableBearerSpendCustodyHandoff({
            bearerRecord,
            custodyState: pendingState,
            exactPayload,
            authorization: authority.owner,
          });
          custodyPlan.transaction.adoptBearerSpendCustodyHandoff(handoffPlan);
          const handoff = {
            previousCustodyState: pendingState,
            plan: handoffPlan,
            row: createGuiBearerSpendDeliveryRow(bearerRecord),
          };
          const input = {
            authority,
            plan: custodyPlan,
            snapshot,
            nextOperation,
            nextWalletSendDeliveryPayload: payload,
            nextWalletSendDeliveryReservation: null,
            bearerSpendHandoff: handoff,
          };

          const preparedUnitOfWork = await prepareGuiCustodyUnitOfWork(input);
          await expect(
            prepareGuiCustodyUnitOfWork({
              ...input,
              bearerSpendHandoff: {
                ...handoff,
                plan: structuredClone(handoffPlan),
              },
            }),
          ).rejects.toThrow(/handoff plan is invalid/);
          await expect(
            prepareGuiCustodyUnitOfWork({
              ...input,
              bearerSpendHandoff: {
                ...handoff,
                row: { ...handoff.row, payloadHandle: "wallet-send:foreign" },
              },
            }),
          ).rejects.toThrow(/bearer spend delivery row is invalid/);
          handoff.row.payloadHandle = "wallet-send:post-prepare-substitution";
          await expect(
            db.transaction("rw", guiCustodyUnitOfWorkTables(authority), () =>
              commitPreparedGuiCustodyUnitOfWorkInCurrentTransaction(
                preparedUnitOfWork,
              ),
            ),
          ).rejects.toThrow(/bearer spend delivery row is invalid/);
          expect(await db.bearerSpendDeliveries.count()).toBe(0);
        } finally {
          await releaseGuiCustodyAuthority(lock, authority);
        }
      });
    });

    it.each([
      "reclaim-prepared",
      "reclaim-submitted",
      "recipient-consumed",
      "unknown-consumed",
      "sender-reclaim-consumed",
    ] as const)(
      "restarts and exactly replays %s bearer authority",
      async (kind) => {
        const { prepared } = await prepareOrdinarySendFixture();
        await markProofOperationMintSubmitted(prepared.operationId);
        await markProofOperationCompleted(
          prepared.operationId,
          ordinarySendResultProofs(),
          ordinarySendEncodedToken(),
        );
        const initial = (await storedBearerFor(prepared)).record;
        const proofs = ordinarySendResultProofs().send;
        const observedAtMs = initial.createdAtMs + 1_000;
        const unspent = await observeBearerStates(
          initial,
          proofs,
          [CheckStateEnum.UNSPENT],
          observedAtMs,
        );
        const reclaimIntent = planDurableBearerSpendReclaimIntent(unspent, {
          requestFingerprint: "ab".repeat(32),
          approvedFee: "0",
          approvedReturnAmount: "1",
        });
        const preparedReclaim = reduceDurableBearerSpendReclaimLineage(
          unspent,
          {
            kind: "prepared",
            ...reclaimIntent,
          },
        );
        const rechecked = await observeBearerStates(
          preparedReclaim,
          proofs,
          [CheckStateEnum.UNSPENT],
          observedAtMs + 1_000,
        );
        const submittedReclaim = reduceDurableBearerSpendReclaimLineage(
          rechecked,
          {
            kind: "submitted",
            ...reclaimIntent,
          },
        );
        const recipient = await observeBearerStates(
          initial,
          proofs,
          [CheckStateEnum.SPENT],
          observedAtMs,
        );
        const unknown = await observeBearerStates(
          submittedReclaim,
          proofs,
          [CheckStateEnum.SPENT],
          observedAtMs + 2_000,
        );
        const sender = decodeDurableBearerSpendDeliveryRecord({
          ...recipient,
          reclaim: {
            kind: "completed",
            operationId: reclaimIntent.operationId,
            parentDeliveryId: recipient.deliveryId,
            requestFingerprint: reclaimIntent.requestFingerprint,
            approvedInputFingerprint: reclaimIntent.approvedInputFingerprint,
            approvedInputAmount: reclaimIntent.approvedInputAmount,
            approvedFee: reclaimIntent.approvedFee,
            approvedReturnAmount: reclaimIntent.approvedReturnAmount,
          },
          state: { ...recipient.state, actor: "sender-reclaim" },
        });
        const record = {
          "reclaim-prepared": preparedReclaim,
          "reclaim-submitted": submittedReclaim,
          "recipient-consumed": recipient,
          "unknown-consumed": unknown,
          "sender-reclaim-consumed": sender,
        }[kind];
        const persistedRecord = decodeDurableBearerSpendDeliveryRecord(record);
        const fingerprint = bearerRecordFingerprint(persistedRecord);
        await persistBearerLifecycle(prepared, persistedRecord);

        db.close();
        await db.open();
        await expect(
          requireCompletedGuiWalletProofOperationAuthorityForWallet(
            currentGuiWalletId(),
            prepared.operationId,
          ),
        ).resolves.toMatchObject({ operationId: prepared.operationId });
        await expect(
          getPendingGuiWalletSendDeliveryForWallet(currentGuiWalletId()),
        ).resolves.toBeNull();
        await expect(
          markProofOperationCompleted(
            prepared.operationId,
            ordinarySendResultProofs(),
          ),
        ).resolves.toMatchObject({ state: "completed" });
        await expect(
          markProofOperationCompleted(
            prepared.operationId,
            ordinarySendResultProofs(),
            ordinarySendEncodedToken(),
          ),
        ).resolves.toMatchObject({ state: "completed" });
        const foreignToken = getEncodedTokenV4({
          mint: ordinarySendOperationInput().mintUrl,
          unit: "sat",
          proofs: [
            { ...ordinarySendResultProofs().send[0]!, secret: "aa".repeat(32) },
          ],
        });
        await expect(
          markProofOperationCompleted(
            prepared.operationId,
            ordinarySendResultProofs(),
            foreignToken,
          ),
        ).rejects.toThrow(
          /token is invalid|replay token is foreign|conflicts with its result/,
        );
        expect(
          await db.walletSendDeliveryPayloads.get([
            currentGuiWalletId(),
            prepared.operationId,
          ]),
        ).toBeUndefined();
        expect(
          bearerRecordFingerprint((await storedBearerFor(prepared)).record),
        ).toBe(fingerprint);
        expect(
          (await db.custodyOperations.get(prepared.custodyOperationId!))?.record
            .operation.delivery.state,
        ).toBe("acknowledged");
      },
    );

    it("restarts and replays mixed spent/unspent bearer authority without a payload", async () => {
      const multi = ordinaryMultiSendOperationInput();
      const { passthrough, ...input } = multi;
      await db.proofs.put(
        prepareStoredProofForWrite(
          { ...passthrough, mintUrl: input.mintUrl, unit: "sat" },
          2,
          currentGuiWalletId(),
        ),
      );
      const prepared = await prepareProofOperation(input);
      await markProofOperationMintSubmitted(prepared.operationId);
      await markProofOperationCompleted(
        prepared.operationId,
        ordinaryMultiSendResultProofs(),
        ordinaryMultiSendEncodedToken(),
      );
      const initial = (await storedBearerFor(prepared)).record;
      const mixed = await observeBearerStates(
        initial,
        ordinaryMultiSendResultProofs().send,
        [CheckStateEnum.SPENT, CheckStateEnum.UNSPENT],
        initial.createdAtMs + 1_000,
      );
      await persistBearerLifecycle(prepared, mixed);

      db.close();
      await db.open();
      await expect(
        requireCompletedGuiWalletProofOperationAuthorityForWallet(
          currentGuiWalletId(),
          prepared.operationId,
        ),
      ).resolves.toMatchObject({ operationId: prepared.operationId });
      await expect(
        markProofOperationCompleted(
          prepared.operationId,
          ordinaryMultiSendResultProofs(),
        ),
      ).resolves.toMatchObject({ state: "completed" });
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
      expect((await storedBearerFor(prepared)).record.state).toMatchObject({
        kind: "pending",
        classification: "mixed",
      });
    });

    it("rolls back preparation when the physical reservation cannot be written", async () => {
      const { passthrough, ...input } = ordinarySendOperationInput();
      await db.proofs.put(
        prepareStoredProofForWrite(
          { ...passthrough, mintUrl: input.mintUrl, unit: "sat" },
          2,
          currentGuiWalletId(),
        ),
      );
      const reservationPut = vi
        .spyOn(db.walletSendDeliveryReservations, "put")
        .mockImplementation((() => {
          throw new DOMException(
            "injected reservation quota",
            "QuotaExceededError",
          );
        }) as never);
      await expect(prepareProofOperation(input)).rejects.toMatchObject({
        name: "QuotaExceededError",
      });
      reservationPut.mockRestore();

      expect(await storedOperation(input.operationId)).toBeUndefined();
      expect(await db.custodyOperations.count()).toBe(0);
      expect(
        (await storedRow(input.inputs[0]!.secret))?.reservedBy,
      ).toBeUndefined();
      expect((await storedRow(passthrough.secret))?.reservedBy).toBeUndefined();
    });

    it("prevents mint transport when a prepared reservation is missing", async () => {
      const { prepared } = await prepareOrdinarySendFixture();
      await db.walletSendDeliveryReservations.delete([
        currentGuiWalletId(),
        prepared.operationId,
      ]);

      await expect(
        claimPreparedProofOperationMintSubmissionForWallet(
          currentGuiWalletId(),
          prepared.operationId,
        ),
      ).rejects.toThrow(/physical reservation is missing/);
      expect(
        (await db.custodyOperations.get(prepared.custodyOperationId!))?.record
          .operation.state,
      ).toBe("dispatch-intent");
    });

    it.each(["missing", "corrupt"] as const)(
      "fails closed on a %s mint-submitted reservation after restart",
      async (fault) => {
        const { prepared } = await prepareOrdinarySendFixture();
        await claimPreparedProofOperationMintSubmissionForWallet(
          currentGuiWalletId(),
          prepared.operationId,
        );
        const key: [string, string] = [
          currentGuiWalletId(),
          prepared.operationId,
        ];
        if (fault === "missing") {
          await db.walletSendDeliveryReservations.delete(key);
        } else {
          const reservation = await db.walletSendDeliveryReservations.get(key);
          if (!reservation) throw new Error("missing wallet-send reservation");
          await db.walletSendDeliveryReservations.put({
            ...reservation,
            paddingDigest: "00".repeat(32),
          });
        }

        db.close();
        await db.open();
        await expect(
          markProofOperationCompleted(
            prepared.operationId,
            ordinarySendResultProofs(),
            ordinarySendEncodedToken(),
          ),
        ).rejects.toThrow(/reservation|invalid|corrupt/i);
        expect((await storedOperation(prepared.operationId))?.state).toBe(
          "mint-submitted",
        );
      },
    );

    it("rejects a user-export token that does not encode the exact completed send result", async () => {
      const { input, prepared } = await prepareOrdinarySendFixture();
      await markProofOperationMintSubmitted(prepared.operationId);
      const foreignToken = getEncodedTokenV4({
        mint: input.mintUrl,
        unit: "sat",
        proofs: [
          { ...ordinarySendResultProofs().send[0]!, secret: "99".repeat(32) },
        ],
      });

      await expect(
        markProofOperationCompleted(
          prepared.operationId,
          ordinarySendResultProofs(),
          foreignToken,
        ),
      ).rejects.toThrow(/token conflicts|token is invalid/i);
      expect((await storedOperation(prepared.operationId))?.state).toBe(
        "mint-submitted",
      );
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
    });

    it("blocks a restarted bearer row with a corrupt exact-token fingerprint", async () => {
      const { prepared } = await prepareOrdinarySendFixture();
      await markProofOperationMintSubmitted(prepared.operationId);
      await markProofOperationCompleted(
        prepared.operationId,
        ordinarySendResultProofs(),
        ordinarySendEncodedToken(),
      );
      const custodyOperationId = prepared.custodyOperationId;
      if (!custodyOperationId)
        throw new Error("missing wallet-send custody id");
      const custodyRow = await db.custodyOperations.get(custodyOperationId);
      if (!custodyRow) throw new Error("missing wallet-send custody fixture");
      await db.custodyOperations.put({
        ...custodyRow,
        record: {
          ...custodyRow.record,
          operation: {
            ...custodyRow.record.operation,
            delivery: {
              ...custodyRow.record.operation.delivery,
              payloadFingerprint: "00".repeat(32),
            },
          },
        },
      });
      db.close();
      await db.open();
      await expect(
        getPendingGuiWalletSendDeliveryForWallet(currentGuiWalletId()),
      ).rejects.toThrow(/authority is inconsistent/);
    });

    it("rejects a valid alternate token encoding without mutating durable authority", async () => {
      const { prepared } = await prepareOrdinarySendFixture();
      await markProofOperationMintSubmitted(prepared.operationId);
      await markProofOperationCompleted(
        prepared.operationId,
        ordinarySendResultProofs(),
        ordinarySendEncodedToken(),
      );
      const operation = await storedOperation(prepared.operationId);
      if (!operation)
        throw new Error("missing completed wallet-send operation");
      const alternatePayload = createGuiWalletSendDeliveryPayloadRow(
        operation,
        ordinarySendAlternateEncodedToken(),
      );
      await db.walletSendDeliveryPayloads.put(alternatePayload);
      const bearerBefore = await storedBearerFor(prepared);
      const custodyBefore = await db.custodyOperations.get(
        prepared.custodyOperationId!,
      );

      await expect(
        getPendingGuiWalletSendDeliveryForWallet(currentGuiWalletId()),
      ).rejects.toThrow(/payload conflicts with bearer authority/);
      await expect(
        markProofOperationCompleted(
          prepared.operationId,
          ordinarySendResultProofs(),
        ),
      ).rejects.toThrow(/payload conflicts with bearer authority/);

      expect(await storedOperation(prepared.operationId)).toEqual(operation);
      expect(await storedBearerFor(prepared)).toEqual(bearerBefore);
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toEqual(alternatePayload);
      expect(
        await db.custodyOperations.get(prepared.custodyOperationId!),
      ).toEqual(custodyBefore);
    });

    it("rolls back wallet-send input and passthrough changes on quota failure", async () => {
      const { input, passthrough, prepared } =
        await prepareOrdinarySendFixture();
      await markProofOperationMintSubmitted(prepared.operationId);
      const operationPut = vi
        .spyOn(db.proofOperations, "put")
        .mockImplementation((() => {
          throw new DOMException(
            "injected send write failure",
            "QuotaExceededError",
          );
        }) as never);

      await expect(
        markProofOperationCompleted(
          prepared.operationId,
          ordinarySendResultProofs(),
          ordinarySendEncodedToken(),
        ),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });
      operationPut.mockRestore();

      expect((await storedOperation(prepared.operationId))?.state).toBe(
        "mint-submitted",
      );
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
      expect((await storedRow(input.inputs[0]!.secret))?.reservedBy).toBe(
        prepared.operationId,
      );
      expect((await storedRow(passthrough.secret))?.reservedBy).toBe(
        prepared.operationId,
      );
      expect(await storedRow("55".repeat(32))).toBeUndefined();
      expect(await storedRow("77".repeat(32))).toBeUndefined();
    });

    it("rolls back canonical, native, proof, and token writes when payload insertion fails", async () => {
      const { input, passthrough, prepared } =
        await prepareOrdinarySendFixture();
      await markProofOperationMintSubmitted(prepared.operationId);
      const payloadPut = vi
        .spyOn(db.walletSendDeliveryPayloads, "put")
        .mockImplementation((() => {
          throw new DOMException(
            "injected delivery payload failure",
            "QuotaExceededError",
          );
        }) as never);

      await expect(
        markProofOperationCompleted(
          prepared.operationId,
          ordinarySendResultProofs(),
          ordinarySendEncodedToken(),
        ),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });
      payloadPut.mockRestore();

      expect((await storedOperation(prepared.operationId))?.state).toBe(
        "mint-submitted",
      );
      expect(
        (await db.custodyOperations.get(prepared.custodyOperationId!))?.record
          .operation.state,
      ).toBe("transport-attempted");
      expect((await storedRow(input.inputs[0]!.secret))?.reservedBy).toBe(
        prepared.operationId,
      );
      expect((await storedRow(passthrough.secret))?.reservedBy).toBe(
        prepared.operationId,
      );
      expect(await storedRow("55".repeat(32))).toBeUndefined();
      expect(await storedRow("77".repeat(32))).toBeUndefined();
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
    });

    it("rolls back every completion post-image when bearer-policy insertion fails", async () => {
      const { input, passthrough, prepared } =
        await prepareOrdinarySendFixture();
      await markProofOperationMintSubmitted(prepared.operationId);
      const bearerPut = vi
        .spyOn(db.bearerSpendDeliveries, "put")
        .mockImplementation((() => {
          throw new DOMException(
            "injected bearer-policy failure",
            "QuotaExceededError",
          );
        }) as never);

      await expect(
        markProofOperationCompleted(
          prepared.operationId,
          ordinarySendResultProofs(),
          ordinarySendEncodedToken(),
        ),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });
      bearerPut.mockRestore();

      await expectWalletSendCompletionRolledBack(input, passthrough, prepared);
    });

    it("rolls back bearer and native writes when custody acknowledgement fails", async () => {
      const { input, passthrough, prepared } =
        await prepareOrdinarySendFixture();
      await markProofOperationMintSubmitted(prepared.operationId);
      const custodyPut = vi
        .spyOn(db.custodyOperations, "bulkPut")
        .mockImplementation((() => {
          throw new DOMException(
            "injected custody-transition failure",
            "QuotaExceededError",
          );
        }) as never);

      await expect(
        markProofOperationCompleted(
          prepared.operationId,
          ordinarySendResultProofs(),
          ordinarySendEncodedToken(),
        ),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });
      custodyPut.mockRestore();

      await expectWalletSendCompletionRolledBack(input, passthrough, prepared);
    });

    it("rolls back completion when physical reservation deletion fails", async () => {
      const { prepared } = await prepareOrdinarySendFixture();
      await markProofOperationMintSubmitted(prepared.operationId);
      const reservationDelete = vi
        .spyOn(db.walletSendDeliveryReservations, "delete")
        .mockImplementation((() => {
          throw new DOMException(
            "injected delivery reservation deletion failure",
            "QuotaExceededError",
          );
        }) as never);

      await expect(
        markProofOperationCompleted(
          prepared.operationId,
          ordinarySendResultProofs(),
          ordinarySendEncodedToken(),
        ),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });
      reservationDelete.mockRestore();

      expect((await storedOperation(prepared.operationId))?.state).toBe(
        "mint-submitted",
      );
      expect(
        (await db.custodyOperations.get(prepared.custodyOperationId!))?.record
          .operation.state,
      ).toBe("transport-attempted");
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
      expect(
        await db.walletSendDeliveryReservations.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeDefined();
    });

    it("coalesces indexed recovery and retains an all-unspent token", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const { delays: scheduledDelays } = captureBearerRecoveryWakes();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      let releaseCheck!: () => void;
      const checkGate = new Promise<void>((resolve) => {
        releaseCheck = resolve;
      });
      const checkProofsStates = vi.fn(async (proofs: Proof[]) => {
        expect(Dexie.currentTransaction).toBeNull();
        await checkGate;
        return proofs.map((proof) =>
          bearerProofState(proof, CheckStateEnum.UNSPENT),
        );
      });
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => ({ checkProofsStates })) as never,
      });
      try {
        const first = requestGuiBearerSpendRecovery();
        const duplicate = requestGuiBearerSpendRecovery();
        expect(duplicate).toBe(first);
        releaseCheck();
        await expect(first).resolves.toBe("pending");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      expect(checkProofsStates).toHaveBeenCalledTimes(1);
      expect(scheduledDelays).toHaveLength(1);
      expect(scheduledDelays[0]).toBeGreaterThan(0);
      expect(scheduledDelays[0]).toBeLessThanOrEqual(5_000);
      const bearer = await bearerForOperation(prepared.operationId);
      expect(bearer.record.state).toMatchObject({
        kind: "pending",
        classification: "all-unspent",
        attemptCount: 1,
      });
      expect(bearer.presentable).toBe(1);
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeDefined();
    });

    it("compacts a mixed vector and atomically removes its full token", async () => {
      const { passthrough, ...input } = ordinaryMultiSendOperationInput();
      await db.proofs.put(
        prepareStoredProofForWrite(
          { ...passthrough, mintUrl: input.mintUrl, unit: "sat" },
          2,
          currentGuiWalletId(),
        ),
      );
      const prepared = await prepareProofOperation(input);
      await markProofOperationMintSubmitted(prepared.operationId);
      await markProofOperationCompleted(
        prepared.operationId,
        ordinaryMultiSendResultProofs(),
        ordinaryMultiSendEncodedToken(),
      );
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => ({
          checkProofsStates: async (proofs: Proof[]) =>
            proofs.map((proof, index) =>
              bearerProofState(
                proof,
                index === 0 ? CheckStateEnum.SPENT : CheckStateEnum.UNSPENT,
              ),
            ),
        })) as never,
      });
      try {
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("pending");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      const bearer = await bearerForOperation(prepared.operationId);
      expect(bearer.record.state).toMatchObject({
        kind: "pending",
        classification: "mixed",
      });
      expect(bearer.record.proofEntries.map(({ kind }) => kind)).toEqual([
        "spent",
        "active",
      ]);
      expect(bearer.presentable).toBe(0);
      expect(bearer.active).toBe(1);
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
    });

    it("rolls back an all-spent transition when payload deletion fails", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const { callbacks: scheduledCallbacks, delays: scheduledDelays } =
        captureBearerRecoveryWakes();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => ({
          checkProofsStates: async (proofs: Proof[]) =>
            proofs.map((proof) =>
              bearerProofState(proof, CheckStateEnum.SPENT),
            ),
        })) as never,
      });
      const payloadDelete = vi
        .spyOn(db.walletSendDeliveryPayloads, "delete")
        .mockRejectedValueOnce(
          new DOMException("injected payload deletion", "QuotaExceededError"),
        );
      try {
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("blocked");
        expect((await bearerForOperation(prepared.operationId)).active).toBe(1);
        expect(
          await db.walletSendDeliveryPayloads.get([
            currentGuiWalletId(),
            prepared.operationId,
          ]),
        ).toBeDefined();
        payloadDelete.mockRestore();
        expect(scheduledDelays[0]).toBeGreaterThanOrEqual(1_000);
        scheduledCallbacks[0]!();
        await vi.waitFor(async () => {
          expect((await bearerForOperation(prepared.operationId)).active).toBe(
            0,
          );
        });
      } finally {
        payloadDelete.mockRestore();
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      expect(await bearerForOperation(prepared.operationId)).toMatchObject({
        active: 0,
        presentable: 0,
        record: { state: { kind: "consumed", actor: "recipient" } },
      });
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
    });

    it("bounds a never-settling mint check and releases recovery for retry", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      const checkStarted = deferred<void>();
      let expireMintCheck!: () => void;
      const neverSettles = new Promise<ProofState[]>(() => undefined);
      const checkProofsStates = vi.fn((_proofs: Proof[], _options: unknown) => {
        checkStarted.resolve(undefined);
        return neverSettles;
      });
      __setGuiBearerSpendRecoveryTimerForTests({
        schedule: () => Symbol("bearer-recovery-timeout"),
        cancel: vi.fn(),
      });
      __setGuiBearerSpendRecoveryMintTimeoutForTests({
        schedule: (callback, delayMs) => {
          expect(delayMs).toBe(10_000);
          expireMintCheck = callback;
          return Symbol("mint-check-timeout");
        },
        cancel: vi.fn(),
      });
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => ({ checkProofsStates })) as never,
      });
      try {
        const recovery = requestGuiBearerSpendRecovery();
        await checkStarted.wait;
        expect(checkProofsStates).toHaveBeenCalledWith(
          expect.any(Array),
          expect.objectContaining({
            requestTimeout: 10_000,
            responseBodyBytesLimit: 256 * 1_024,
            signal: expect.any(AbortSignal),
          }),
        );
        expireMintCheck();
        await expect(recovery).resolves.toBe("pending");
        const indeterminate = await bearerForOperation(prepared.operationId);
        expect(indeterminate.record.state).toMatchObject({
          classification: "indeterminate",
          attemptCount: 1,
        });

        checkProofsStates.mockImplementation(async (proofs: Proof[]) =>
          proofs.map((proof) =>
            bearerProofState(proof, CheckStateEnum.UNSPENT),
          ),
        );
        vi.spyOn(Date, "now").mockReturnValue(
          (indeterminate.nextAttemptAtMs ?? 0) + 1,
        );
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("pending");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      expect(checkProofsStates).toHaveBeenCalledTimes(2);
      expect(
        (await bearerForOperation(prepared.operationId)).record.state,
      ).toMatchObject({ classification: "all-unspent", attemptCount: 2 });
    });

    it("bounds a never-settling cold wallet bootstrap", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      const bootstrapStarted = deferred<void>();
      let expireMintBootstrap!: () => void;
      const getWalletForUnit = vi.fn(
        (_mintUrl: string, _unit: string, _options: unknown) => {
          bootstrapStarted.resolve(undefined);
          return new Promise<never>(() => undefined);
        },
      );
      __setGuiBearerSpendRecoveryTimerForTests({
        schedule: () => Symbol("bearer-recovery-bootstrap-timeout"),
        cancel: vi.fn(),
      });
      __setGuiBearerSpendRecoveryMintTimeoutForTests({
        schedule: (callback, delayMs) => {
          expect(delayMs).toBe(10_000);
          expireMintBootstrap = callback;
          return Symbol("mint-bootstrap-timeout");
        },
        cancel: vi.fn(),
      });
      useWalletStore.setState({ getWalletForUnit: getWalletForUnit as never });
      try {
        const recovery = requestGuiBearerSpendRecovery();
        await bootstrapStarted.wait;
        expect(getWalletForUnit).toHaveBeenCalledWith(
          ordinarySendOperationInput().mintUrl,
          "sat",
          expect.objectContaining({
            expectedWalletId: currentGuiWalletId(),
            requestTimeout: 10_000,
            responseBodyBytesLimit: 256 * 1_024,
            signal: expect.any(AbortSignal),
          }),
        );
        expireMintBootstrap();
        await expect(recovery).resolves.toBe("pending");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      expect(
        (await bearerForOperation(prepared.operationId)).record.state,
      ).toMatchObject({ classification: "indeterminate", attemptCount: 1 });
    });

    it("defers without mint transport while another tab owns recovery", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const walletId = currentGuiWalletId();
      const lockStarted = deferred<void>();
      const releaseLock = deferred<void>();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      const checkProofsStates = vi.fn(async (proofs: Proof[]) =>
        proofs.map((proof) => bearerProofState(proof, CheckStateEnum.UNSPENT)),
      );
      __setGuiBearerSpendRecoveryTimerForTests({
        schedule: () => Symbol("bearer-recovery-lock-retry"),
        cancel: vi.fn(),
      });
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => ({ checkProofsStates })) as never,
      });
      const owner = tryWithGuiWalletBearerRecoveryLock(
        walletId,
        currentGuiWalletId,
        async () => {
          lockStarted.resolve(undefined);
          await releaseLock.wait;
        },
      );
      await lockStarted.wait;
      try {
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("pending");
        expect(checkProofsStates).not.toHaveBeenCalled();
        releaseLock.resolve(undefined);
        await owner;
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("pending");
      } finally {
        releaseLock.resolve(undefined);
        await owner;
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      expect(checkProofsStates).toHaveBeenCalledTimes(1);
      expect(
        (await bearerForOperation(prepared.operationId)).record.state,
      ).toMatchObject({ classification: "all-unspent", attemptCount: 1 });
    });

    it("isolates a malformed indexed lookup while reconciling healthy authority", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const healthy = await bearerForOperation(prepared.operationId);
      await db.bearerSpendDeliveries.put({
        ...structuredClone(healthy),
        deliveryId: "corrupt-delivery-001",
        parentOperationId: "corrupt-parent-001",
        payloadHandle: 7,
        nextAttemptAtMs: 0,
      } as never);
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      const checkProofsStates = vi.fn(async (proofs: Proof[]) =>
        proofs.map((proof) => bearerProofState(proof, CheckStateEnum.UNSPENT)),
      );
      __setGuiBearerSpendRecoveryTimerForTests({
        schedule: () => Symbol("bearer-recovery-corrupt-retry"),
        cancel: vi.fn(),
      });
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => ({ checkProofsStates })) as never,
      });
      try {
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("blocked");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      expect(checkProofsStates).toHaveBeenCalledTimes(1);
      expect(
        (await bearerForOperation(prepared.operationId)).record.state,
      ).toMatchObject({ classification: "all-unspent", attemptCount: 1 });
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeDefined();
    });

    it("defers a third mint group and drains it on the scheduled wake", async () => {
      const prepared = await Promise.all(
        [1, 2, 3].map((index) =>
          completeIndependentOrdinarySend(
            index,
            `https://mint-${index}.example`,
          ),
        ),
      );
      const { callbacks: scheduledCallbacks, delays: scheduledDelays } =
        captureBearerRecoveryWakes();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      const getWalletForUnit = vi.fn(async () => ({
        checkProofsStates: async (proofs: Proof[]) =>
          proofs.map((proof) =>
            bearerProofState(proof, CheckStateEnum.UNSPENT),
          ),
      }));
      useWalletStore.setState({ getWalletForUnit: getWalletForUnit as never });
      try {
        const firstCycleStartedAtMs = Date.now();
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("pending");
        expect(getWalletForUnit).toHaveBeenCalledTimes(2);
        expect(
          scheduledDelays[0]! + Date.now() - firstCycleStartedAtMs,
        ).toBeGreaterThanOrEqual(1_000);
        const firstAttempts = await Promise.all(
          prepared.map(
            async ({ operationId }) =>
              (await bearerForOperation(operationId)).record.state,
          ),
        );
        expect(
          firstAttempts.filter(
            (state) => state.kind === "pending" && state.attemptCount === 1,
          ),
        ).toHaveLength(2);

        scheduledCallbacks[0]!();
        await vi.waitFor(async () => {
          const attempts = await Promise.all(
            prepared.map(
              async ({ operationId }) =>
                (await bearerForOperation(operationId)).record.state,
            ),
          );
          expect(
            attempts.every(
              (state) => state.kind === "pending" && state.attemptCount === 1,
            ),
          ).toBe(true);
        });
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      expect(getWalletForUnit).toHaveBeenCalledTimes(3);
    });

    it("stops at one backlog page and resumes from its stable cursor", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const healthy = await bearerForOperation(prepared.operationId);
      await db.bearerSpendDeliveries.bulkPut(
        Array.from({ length: 9 }, (_, index) => {
          const suffix = index.toString().padStart(2, "0");
          return {
            ...structuredClone(healthy),
            deliveryId: `corrupt-backlog-${suffix}`,
            parentOperationId: `corrupt-parent-${suffix}`,
            payloadHandle: `wallet-send:corrupt-operation-${suffix}`,
            nextAttemptAtMs: 0,
          };
        }),
      );
      const { callbacks: scheduledCallbacks, delays: scheduledDelays } =
        captureBearerRecoveryWakes();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      const getWalletForUnit = vi.fn();
      useWalletStore.setState({ getWalletForUnit: getWalletForUnit as never });
      try {
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("blocked");
        expect(getWalletForUnit).not.toHaveBeenCalled();
        expect(scheduledDelays).toHaveLength(1);
        expect(scheduledDelays[0]).toBeGreaterThanOrEqual(1_000);

        getWalletForUnit.mockImplementation(async () => ({
          checkProofsStates: async (proofs: Proof[]) =>
            proofs.map((proof) =>
              bearerProofState(proof, CheckStateEnum.UNSPENT),
            ),
        }));
        scheduledCallbacks[0]!();
        await vi.waitFor(async () => {
          expect(
            (await bearerForOperation(prepared.operationId)).record.state,
          ).toMatchObject({ classification: "all-unspent", attemptCount: 1 });
        });
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      expect(getWalletForUnit).toHaveBeenCalledTimes(1);
      expect(scheduledCallbacks.length).toBeGreaterThanOrEqual(2);
    });

    it("persists transport-indeterminate backoff without deleting authority", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => ({
          checkProofsStates: async () => {
            throw new Error("secret-bearing transport error must not escape");
          },
        })) as never,
      });
      try {
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("pending");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      const bearer = await bearerForOperation(prepared.operationId);
      expect(bearer.record.state).toMatchObject({
        kind: "pending",
        classification: "indeterminate",
        attemptCount: 1,
      });
      expect(bearer.nextAttemptAtMs).toBeGreaterThan(bearer.record.createdAtMs);
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeDefined();
    });

    it("rejects stale NUT-07 evidence with an exact delivery CAS", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      let releaseCheck!: () => void;
      let markCheckStarted!: () => void;
      const checkStarted = new Promise<void>((resolve) => {
        markCheckStarted = resolve;
      });
      const checkGate = new Promise<void>((resolve) => {
        releaseCheck = resolve;
      });
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => ({
          checkProofsStates: async (proofs: Proof[]) => {
            markCheckStarted();
            await checkGate;
            return proofs.map((proof) =>
              bearerProofState(proof, CheckStateEnum.SPENT),
            );
          },
        })) as never,
      });
      try {
        const recovery = requestGuiBearerSpendRecovery();
        await checkStarted;
        const before = await bearerForOperation(prepared.operationId);
        const concurrent = await observeBearerStates(
          before.record,
          ordinarySendResultProofs().send,
          [CheckStateEnum.UNSPENT],
          Math.max(Date.now(), before.record.createdAtMs + 1),
        );
        await persistBearerLifecycle(prepared, concurrent);
        releaseCheck();
        await expect(recovery).resolves.toBe("pending");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      expect(
        (await bearerForOperation(prepared.operationId)).record.state,
      ).toMatchObject({ classification: "all-unspent", attemptCount: 1 });
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeDefined();
    });

    it("does not let a stale wallet cycle cancel the current wallet wake", () => {
      const walletA = currentGuiWalletId();
      useWalletStore.setState({ mnemonic: OTHER_MNEMONIC });
      const walletB = currentGuiWalletId();
      const cancelledTimers: unknown[] = [];
      __setGuiBearerSpendRecoveryTimerForTests({
        schedule: () => Symbol("scheduled-wallet-wake"),
        cancel: (timer) => cancelledTimers.push(timer),
      });
      __scheduleGuiBearerSpendRecoveryWakeForTests(walletB, Date.now() + 5_000);
      __scheduleGuiBearerSpendRecoveryWakeForTests(walletA, null);
      expect(cancelledTimers).toEqual([]);
      useWalletStore.setState({ mnemonic: MNEMONIC });
    });

    it("fails closed on a malformed mint vector without deleting payload authority", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => ({
          checkProofsStates: async () => [],
        })) as never,
      });
      try {
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("pending");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }
      const bearer = await bearerForOperation(prepared.operationId);
      expect(bearer.record.state).toMatchObject({
        kind: "pending",
        classification: "blocked",
        attemptCount: 1,
      });
      expect(bearer.presentable).toBe(1);
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeDefined();
    });

    it("revokes stale token presentation after another writer consumes the bearer proof", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const walletId = currentGuiWalletId();
      expect(
        await readGuiBearerSpendTokenPresentable(
          walletId,
          prepared.operationId,
        ),
      ).toBe(true);

      const initial = (await bearerForOperation(prepared.operationId)).record;
      const consumed = await observeBearerStates(
        initial,
        ordinarySendResultProofs().send,
        [CheckStateEnum.SPENT],
        initial.createdAtMs + 1_000,
      );
      await persistBearerLifecycle(prepared, consumed);

      expect(
        await readGuiBearerSpendTokenPresentable(
          walletId,
          prepared.operationId,
        ),
      ).toBe(false);
      await expect(
        withGuiBearerSpendTokenPresentation(
          walletId,
          prepared.operationId,
          vi.fn(),
        ),
      ).rejects.toThrow(/no longer authorized/);
    });

    it("reclaims an explicit bearer cancellation through one exact linked child", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const returnedProof = bearerReclaimResultProof();
      const wallet = bearerReclaimWallet(returnedProof);
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => wallet) as never,
      });
      try {
        const preview = await inspectGuiBearerSpendCancellation(
          prepared.operationId,
        );
        expect(preview).toMatchObject({
          amount: 1,
          fee: 0,
          returnedAmount: 1,
          proofCount: 1,
          partial: false,
        });

        await expect(
          cancelGuiBearerSpend(prepared.operationId, preview.fingerprint),
        ).resolves.toMatchObject({
          kind: "completed",
          returnedProofs: [returnedProof],
        });
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }

      const bearer = await bearerForOperation(prepared.operationId);
      expect(bearer).toMatchObject({
        active: 0,
        presentable: 0,
        record: {
          reclaim: { kind: "completed" },
          state: { kind: "consumed", actor: "sender-reclaim" },
        },
      });
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
      expect(await storedRow(returnedProof.secret)).toMatchObject({
        selectability: "spendable",
      });
      expect(wallet.completeSwap).toHaveBeenCalledOnce();
    });

    it("rejects changed mint fees before persisting or dispatching the reclaim child", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const returnedProof = bearerReclaimResultProof("af");
      const wallet = bearerReclaimWallet(returnedProof);
      wallet.prepareSwapToReceive.mockImplementationOnce(
        async (token: { proofs: Proof[] }) => ({
          amount: Amount.from(1),
          fees: Amount.from(1),
          keysetId: KEYSET_ID,
          inputs: token.proofs,
          keepOutputs: [
            durableOutputData({
              blindedMessage: {
                amount: 1,
                id: KEYSET_ID,
                B_: PUBLIC_KEY,
              },
              blindingFactor: "44".repeat(32),
              secret: returnedProof.secret,
            }),
          ],
        }),
      );
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => wallet) as never,
      });
      try {
        const preview = await inspectGuiBearerSpendCancellation(
          prepared.operationId,
        );
        await expect(
          cancelGuiBearerSpend(prepared.operationId, preview.fingerprint),
        ).rejects.toThrow(/child plan is invalid/);
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }

      const bearer = await bearerForOperation(prepared.operationId);
      expect(bearer.record.reclaim.kind).toBe("prepared");
      if (bearer.record.reclaim.kind !== "prepared") return;
      expect(
        await db.proofOperations.get(
          proofOperationPrimaryKey(
            currentGuiWalletId(),
            bearer.record.reclaim.operationId,
          ),
        ),
      ).toBeUndefined();
      expect(wallet.completeSwap).not.toHaveBeenCalled();
    });

    it("reclaims only the exact unspent subset after a partial recipient spend", async () => {
      const { prepared } = await completeOrdinaryMultiSendFixture();
      const [spentProof, unspentProof] = ordinaryMultiSendResultProofs().send;
      const returnedProof = bearerReclaimResultProof("ba");
      const wallet = bearerReclaimWallet(returnedProof);
      wallet.checkProofsStates.mockImplementation(async (proofs: Proof[]) =>
        proofs.map((proof) =>
          bearerProofState(
            proof,
            proof.secret === spentProof!.secret
              ? CheckStateEnum.SPENT
              : CheckStateEnum.UNSPENT,
          ),
        ),
      );
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => wallet) as never,
      });
      try {
        const preview = await inspectGuiBearerSpendCancellation(
          prepared.operationId,
        );
        expect(preview).toMatchObject({
          amount: 1,
          returnedAmount: 1,
          proofCount: 1,
          partial: true,
        });
        expect(
          await db.walletSendDeliveryPayloads.get([
            currentGuiWalletId(),
            prepared.operationId,
          ]),
        ).toBeUndefined();

        await expect(
          cancelGuiBearerSpend(prepared.operationId, preview.fingerprint),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }

      expect(wallet.prepareSwapToReceive.mock.calls[0]?.[0].proofs).toEqual([
        unspentProof,
      ]);
      expect(await bearerForOperation(prepared.operationId)).toMatchObject({
        active: 0,
        presentable: 0,
        record: {
          reclaim: { kind: "completed" },
          state: { kind: "consumed", actor: "sender-reclaim" },
        },
      });
      expect(await storedRow(returnedProof.secret)).toBeDefined();
    });

    it("restarts from a journaled reclaim intent without selecting fresh proofs", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const returnedProof = bearerReclaimResultProof("bb");
      const wallet = bearerReclaimWallet(returnedProof);
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => wallet) as never,
      });
      try {
        const preview = await inspectGuiBearerSpendCancellation(
          prepared.operationId,
        );
        const observed = (await bearerForOperation(prepared.operationId))
          .record;
        const intent = planDurableBearerSpendReclaimIntent(observed, {
          requestFingerprint: preview.fingerprint,
          approvedFee: preview.fee.toString(),
          approvedReturnAmount: preview.returnedAmount.toString(),
        });
        await persistBearerLifecycle(
          prepared,
          reduceDurableBearerSpendReclaimLineage(observed, {
            kind: "prepared",
            ...intent,
          }),
        );

        db.close();
        await db.open();
        vi.spyOn(Date, "now").mockReturnValue(
          Math.max(Date.now(), observed.createdAtMs + 60_000),
        );
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("clear");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }

      expect(wallet.prepareSwapToReceive).toHaveBeenCalledOnce();
      expect(wallet.completeSwap).toHaveBeenCalledOnce();
      expect(wallet.prepareSwapToReceive.mock.calls[0]?.[0].proofs).toEqual(
        ordinarySendResultProofs().send,
      );
      expect(await bearerForOperation(prepared.operationId)).toMatchObject({
        active: 0,
        record: {
          reclaim: { kind: "completed" },
          state: { kind: "consumed", actor: "sender-reclaim" },
        },
      });
      expect(await storedRow(returnedProof.secret)).toBeDefined();
    });

    it("lets the recipient win after a prepared intent and before child submission", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const wallet = bearerReclaimWallet(bearerReclaimResultProof("bc"));
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => wallet) as never,
      });
      try {
        const preview = await inspectGuiBearerSpendCancellation(
          prepared.operationId,
        );
        const observed = (await bearerForOperation(prepared.operationId))
          .record;
        const intent = planDurableBearerSpendReclaimIntent(observed, {
          requestFingerprint: preview.fingerprint,
          approvedFee: preview.fee.toString(),
          approvedReturnAmount: preview.returnedAmount.toString(),
        });
        await persistBearerLifecycle(
          prepared,
          reduceDurableBearerSpendReclaimLineage(observed, {
            kind: "prepared",
            ...intent,
          }),
        );
        wallet.checkProofsStates.mockImplementation(async (proofs: Proof[]) =>
          proofs.map((proof) => bearerProofState(proof, CheckStateEnum.SPENT)),
        );

        db.close();
        await db.open();
        vi.spyOn(Date, "now").mockReturnValue(
          Math.max(Date.now(), observed.createdAtMs + 60_000),
        );
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("clear");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }

      expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
      expect(wallet.completeSwap).not.toHaveBeenCalled();
      expect(await bearerForOperation(prepared.operationId)).toMatchObject({
        active: 0,
        presentable: 0,
        record: {
          reclaim: { kind: "prepared" },
          state: { kind: "consumed", actor: "recipient" },
        },
      });
    });

    it("restores changed reclaim terms as explicit restart reapproval", async () => {
      const { prepared } = await completeOrdinaryMultiSendFixture();
      const wallet = bearerReclaimWallet(bearerReclaimResultProof("be"));
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => wallet) as never,
      });
      try {
        const preview = await inspectGuiBearerSpendCancellation(
          prepared.operationId,
        );
        const observed = (await bearerForOperation(prepared.operationId))
          .record;
        const intent = planDurableBearerSpendReclaimIntent(observed, {
          requestFingerprint: preview.fingerprint,
          approvedFee: preview.fee.toString(),
          approvedReturnAmount: preview.returnedAmount.toString(),
        });
        await persistBearerLifecycle(
          prepared,
          reduceDurableBearerSpendReclaimLineage(observed, {
            kind: "prepared",
            ...intent,
          }),
        );
        wallet.getFeesForProofs.mockReturnValue(Amount.from(1));

        db.close();
        await db.open();
        const pending = await findPendingGuiBearerSpendReapproval();

        expect(pending).toMatchObject({
          operationId: prepared.operationId,
          preview: {
            amount: 2,
            fee: 1,
            returnedAmount: 1,
            partial: false,
          },
        });
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }

      expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
      expect(await bearerForOperation(prepared.operationId)).toMatchObject({
        active: 1,
        presentable: 0,
        reclaimPrepared: 1,
        record: { reclaim: { kind: "prepared" } },
      });
    });

    it("rolls back reclaim journaling when payload deletion fails", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const returnedProof = bearerReclaimResultProof("bd");
      const wallet = bearerReclaimWallet(returnedProof);
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => wallet) as never,
      });
      const payloadDelete = vi
        .spyOn(db.walletSendDeliveryPayloads, "delete")
        .mockRejectedValueOnce(
          new DOMException("injected payload deletion", "QuotaExceededError"),
        );
      try {
        const preview = await inspectGuiBearerSpendCancellation(
          prepared.operationId,
        );
        await expect(
          cancelGuiBearerSpend(prepared.operationId, preview.fingerprint),
        ).rejects.toThrow(/injected payload deletion/);
        payloadDelete.mockRestore();

        expect(await bearerForOperation(prepared.operationId)).toMatchObject({
          active: 1,
          presentable: 1,
          record: { reclaim: { kind: "none" } },
        });
        expect(
          await db.walletSendDeliveryPayloads.get([
            currentGuiWalletId(),
            prepared.operationId,
          ]),
        ).toBeDefined();
        expect(await storedRow(returnedProof.secret)).toBeUndefined();
        expect(wallet.completeSwap).not.toHaveBeenCalled();

        await expect(
          cancelGuiBearerSpend(prepared.operationId, preview.fingerprint),
        ).resolves.toMatchObject({ kind: "completed" });
      } finally {
        payloadDelete.mockRestore();
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }

      expect(wallet.completeSwap).toHaveBeenCalledOnce();
      expect(await bearerForOperation(prepared.operationId)).toMatchObject({
        active: 0,
        presentable: 0,
        record: {
          reclaim: { kind: "completed" },
          state: { kind: "consumed", actor: "sender-reclaim" },
        },
      });
      expect(
        await db.walletSendDeliveryPayloads.get([
          currentGuiWalletId(),
          prepared.operationId,
        ]),
      ).toBeUndefined();
    });

    it("finalizes the exact parent after restart when its reclaim child committed first", async () => {
      const { prepared } = await completeOrdinarySendFixture();
      const returnedProof = bearerReclaimResultProof("cc");
      const wallet = bearerReclaimWallet(returnedProof);
      const originalGetWalletForUnit =
        useWalletStore.getState().getWalletForUnit;
      useWalletStore.setState({
        getWalletForUnit: vi.fn(async () => wallet) as never,
      });
      try {
        const preview = await inspectGuiBearerSpendCancellation(
          prepared.operationId,
        );
        const observed = (await bearerForOperation(prepared.operationId))
          .record;
        const intent = planDurableBearerSpendReclaimIntent(observed, {
          requestFingerprint: preview.fingerprint,
          approvedFee: preview.fee.toString(),
          approvedReturnAmount: preview.returnedAmount.toString(),
        });
        const preparedParent = reduceDurableBearerSpendReclaimLineage(
          observed,
          { kind: "prepared", ...intent },
        );
        const recheckedParent = await observeBearerStates(
          preparedParent,
          ordinarySendResultProofs().send,
          [CheckStateEnum.UNSPENT],
          (preparedParent.state.kind === "pending"
            ? (preparedParent.state.lastObservedAtMs ??
              preparedParent.createdAtMs)
            : preparedParent.createdAtMs) + 1,
        );
        await persistBearerLifecycle(prepared, recheckedParent);
        const child = await prepareGuiBearerReclaimOperation({
          expectedWalletId: currentGuiWalletId(),
          record: recheckedParent,
          intent,
          proofs: selectDurableBearerSpendUnspentProofs(observed),
        });
        await persistBearerLifecycle(
          prepared,
          reduceDurableBearerSpendReclaimLineage(recheckedParent, {
            kind: "submitted",
            ...intent,
          }),
        );
        await markProofOperationMintSubmitted(child.operationId);
        await markProofOperationCompleted(child.operationId, {
          receive: [returnedProof],
        });
        expect(
          (await bearerForOperation(prepared.operationId)).record.reclaim.kind,
        ).toBe("submitted");

        db.close();
        await db.open();
        vi.spyOn(Date, "now").mockReturnValue(
          Math.max(
            Date.now(),
            recheckedParent.state.kind === "pending"
              ? recheckedParent.state.nextAttemptAtMs + 1
              : recheckedParent.createdAtMs + 60_000,
          ),
        );
        await expect(requestGuiBearerSpendRecovery()).resolves.toBe("clear");
      } finally {
        useWalletStore.setState({
          getWalletForUnit: originalGetWalletForUnit,
        });
      }

      expect(wallet.completeSwap).not.toHaveBeenCalled();
      expect(await bearerForOperation(prepared.operationId)).toMatchObject({
        active: 0,
        presentable: 0,
        record: {
          reclaim: { kind: "completed" },
          state: { kind: "consumed", actor: "sender-reclaim" },
        },
      });
      expect(await storedRow(returnedProof.secret)).toBeDefined();
    });
  });

  it("rejects native mint results that do not match the persisted output plan", async () => {
    const prepared = await prepareProofOperation(operationInput());
    await markProofOperationMintSubmitted(prepared.operationId);

    await expect(
      markProofOperationCompleted(prepared.operationId, {
        change: [
          {
            ...resultProofs().change[0]!,
            secret: "66".repeat(32),
          },
        ],
      }),
    ).rejects.toThrow(/result proof does not match|planned output/i);
    await expect(
      markProofOperationCompleted(prepared.operationId, {
        foreign: resultProofs().change,
      }),
    ).rejects.toThrow(/result groups|result labels|planned output/i);

    expect((await storedOperation(prepared.operationId))?.state).toBe(
      "mint-submitted",
    );
    expect((await storedRow("11".repeat(32)))?.reservedBy).toBe(
      prepared.operationId,
    );
    expect(await storedRow("66".repeat(32))).toBeUndefined();
  });

  it("atomically releases unspent registration fees after exact mint rejection", async () => {
    const prepared = await prepareProofOperation({
      ...operationInput(),
      operationId: "registration-operation-001",
      kind: "ctf-condition-registration",
    });
    await markProofOperationMintSubmitted(prepared.operationId);
    const error = Object.assign(new Error("registration fee rejected"), {
      code: 13044,
    });

    await markProofOperationFailed(prepared.operationId, error);

    expect((await storedOperation(prepared.operationId))?.state).toBe("Failed");
    expect((await storedRow("11".repeat(32)))?.reservedBy).toBeUndefined();
    expect(await db.custodyProofReservations.count()).toBe(0);
  });

  it("restarts and commits a shorter positive registration-fee change prefix", async () => {
    const input = operationInput();
    const prepared = await prepareProofOperation({
      ...input,
      operationId: "registration-prefix-operation-001",
      kind: "ctf-condition-registration",
      outputs: {
        change: [
          {
            ...input.outputs.change[0]!,
            blindedMessage: {
              ...input.outputs.change[0]!.blindedMessage,
              amount: 0,
            },
          },
          {
            blindedMessage: {
              amount: 0,
              id: KEYSET_ID,
              B_: PUBLIC_KEY,
            },
            blindingFactor: "66".repeat(32),
            secret: "77".repeat(32),
          },
        ],
      },
      metadata: {
        unit: "sat",
        requiredFeeSubunits: 1,
        selectedTotalSubunits: 2,
        durableWalletProofTransition: createDurableWalletProofTransition({
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
      },
    });
    await markProofOperationMintSubmitted(prepared.operationId);

    db.close();
    await db.open();
    await markProofOperationCompleted(prepared.operationId, {
      change: [
        {
          id: KEYSET_ID,
          amount: Amount.from(1),
          secret: "55".repeat(32),
          C: PUBLIC_KEY,
        },
      ],
    });

    expect((await storedOperation(prepared.operationId))?.state).toBe(
      "completed",
    );
    expect(await storedRow("11".repeat(32))).toBeUndefined();
    expect(await storedRow("55".repeat(32))).toMatchObject({ amount: 1 });
    expect(await storedRow("77".repeat(32))).toBeUndefined();
  });

  it("retains a terminal losing CTF proof as non-selectable", async () => {
    const prepared = await prepareProofOperation({
      ...operationInput(),
      operationId: "ctf-redeem-operation-001",
      kind: "ctf-redeem",
    });
    await markProofOperationMintSubmitted(prepared.operationId, {
      schemaVersion: 1,
      requestDigest: "a".repeat(64),
    });
    const error = Object.assign(new Error("outcome lost"), { code: 13015 });

    await markProofOperationFailed(prepared.operationId, error);

    expect((await storedRow("11".repeat(32)))?.reservedBy).toBe(
      prepared.operationId,
    );
    expect(await db.custodyProofReservations.count()).toBe(0);
  });
});

async function releaseHeadroom(): Promise<void> {
  await withGuiCustodyProfileLock(async (_context, walletLock) =>
    withGuiOriginStorageAdmissionLock(
      walletLock,
      currentGuiWalletId,
      (originLock) =>
        db.transaction("rw", guiDurableStorageAdmissionTables(db), () =>
          releaseGuiDurableStorageHeadroomInCurrentTransaction(originLock),
        ),
    ),
  );
}

function durableBlindingFactorHex(value: string): string {
  const hex = BigInt(value).toString(16);
  return hex.length % 2 === 0 ? hex : `0${hex}`;
}

function installWebLocks(): void {
  const tails = new Map<string, Promise<void>>();
  const active = new Set<string>();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async <T>(
        name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => T | PromiseLike<T>,
      ): Promise<T> => {
        if (_options.ifAvailable && active.has(name)) return callback(null);
        const prior = tails.get(name) ?? Promise.resolve();
        const release = deferred<void>();
        tails.set(
          name,
          prior.then(() => release.wait),
        );
        await prior;
        active.add(name);
        try {
          return await callback({ name, mode: "exclusive" } as Lock);
        } finally {
          active.delete(name);
          release.resolve(undefined);
        }
      },
    },
  });
}

function mintKeysResponse() {
  return {
    keysets: [{ id: KEYSET_ID, unit: "sat", keys: { "1": PUBLIC_KEY } }],
  };
}

function captureBearerRecoveryWakes(): {
  callbacks: Array<() => void>;
  delays: number[];
} {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  __setGuiBearerSpendRecoveryTimerForTests({
    schedule: (callback, delayMs) => {
      callbacks.push(callback);
      delays.push(delayMs);
      return Symbol("captured-bearer-recovery-wake");
    },
    cancel: vi.fn(),
  });
  return { callbacks, delays };
}

function deferred<T>(): {
  wait: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const wait = new Promise<T>((done) => {
    resolve = done;
  });
  return { wait, resolve };
}

async function storedRow(secret: string) {
  return (await db.proofs.toArray()).find((proof) => proof.secret === secret);
}

async function storedOperation(operationId: string) {
  return db.proofOperations.get(
    proofOperationPrimaryKey(currentGuiWalletId(), operationId),
  );
}

async function storedOperationForWallet(walletId: string, operationId: string) {
  return db.proofOperations.get(
    proofOperationPrimaryKey(walletId, operationId),
  );
}

async function expectWalletSendCompletionRolledBack(
  input: Omit<ReturnType<typeof ordinarySendOperationInput>, "passthrough">,
  passthrough: ReturnType<typeof ordinarySendOperationInput>["passthrough"],
  prepared: Awaited<ReturnType<typeof prepareProofOperation>>,
): Promise<void> {
  expect((await storedOperation(prepared.operationId))?.state).toBe(
    "mint-submitted",
  );
  expect(
    (await db.custodyOperations.get(prepared.custodyOperationId!))?.record
      .operation.state,
  ).toBe("transport-attempted");
  expect((await storedRow(input.inputs[0]!.secret))?.reservedBy).toBe(
    prepared.operationId,
  );
  expect((await storedRow(passthrough.secret))?.reservedBy).toBe(
    prepared.operationId,
  );
  expect(await storedRow("55".repeat(32))).toBeUndefined();
  expect(await storedRow("77".repeat(32))).toBeUndefined();
  expect(await db.bearerSpendDeliveries.count()).toBe(0);
  expect(
    await db.walletSendDeliveryPayloads.get([
      currentGuiWalletId(),
      prepared.operationId,
    ]),
  ).toBeUndefined();
  expect(
    await db.walletSendDeliveryReservations.get([
      currentGuiWalletId(),
      prepared.operationId,
    ]),
  ).toBeDefined();
}

async function storedBearerFor(
  prepared: Awaited<ReturnType<typeof prepareProofOperation>>,
) {
  const row = await db.bearerSpendDeliveries
    .where("[walletId+parentOperationId]")
    .equals([currentGuiWalletId(), prepared.custodyOperationId])
    .first();
  if (!row) throw new Error("missing bearer lifecycle row");
  return row;
}

function bearerRecordFingerprint(value: unknown): string {
  const record = decodeDurableBearerSpendDeliveryRecord(value);
  const encoded = JSON.stringify(record);
  if (encoded === undefined) throw new Error("missing bearer lifecycle record");
  return deriveDurableCustodyArtifactFingerprint(JSON.parse(encoded));
}

async function persistBearerLifecycle(
  prepared: Awaited<ReturnType<typeof prepareProofOperation>>,
  record: DurableBearerSpendDeliveryRecord,
): Promise<void> {
  const row = createGuiBearerSpendDeliveryRow(record);
  await db.transaction(
    "rw",
    db.bearerSpendDeliveries,
    db.walletSendDeliveryPayloads,
    async () => {
      await db.bearerSpendDeliveries.put(row);
      if (!isDurableBearerSpendTokenPresentable(record)) {
        await db.walletSendDeliveryPayloads.delete([
          currentGuiWalletId(),
          prepared.operationId,
        ]);
      }
    },
  );
}

async function observeBearerStates(
  record: DurableBearerSpendDeliveryRecord,
  proofs: readonly Proof[],
  states: readonly ProofState["state"][],
  observedAtMs: number,
) {
  return reconcileDurableBearerSpendDelivery({
    record,
    observedAtMs,
    checker: {
      async checkProofsStates() {
        return states.map((state, index) =>
          bearerProofState(proofs[index]!, state),
        );
      },
    },
  });
}

async function bearerForOperation(
  operationId: string,
): Promise<ReturnType<typeof createGuiBearerSpendDeliveryRow>> {
  const row = await db.bearerSpendDeliveries
    .where("[walletId+parentOperationId]")
    .equals([
      currentGuiWalletId(),
      (await storedOperation(operationId))?.custodyOperationId ?? "",
    ])
    .first();
  if (!row) throw new Error("missing test bearer delivery");
  return row;
}

function bearerProofState(
  proof: Proof,
  state: ProofState["state"],
): ProofState {
  return {
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state,
    witness: null,
  };
}

function bearerReclaimResultProof(secretByte = "aa"): Proof {
  return {
    id: KEYSET_ID,
    amount: Amount.from(1),
    secret: secretByte.repeat(32),
    C: PUBLIC_KEY,
  };
}

function bearerReclaimWallet(returnedProof: Proof) {
  const prepareSwapToReceive = vi.fn(async (token: { proofs: Proof[] }) => ({
    amount: Amount.from(1),
    fees: Amount.from(0),
    keysetId: KEYSET_ID,
    inputs: token.proofs,
    keepOutputs: [
      durableOutputData({
        blindedMessage: {
          amount: 1,
          id: KEYSET_ID,
          B_: PUBLIC_KEY,
        },
        blindingFactor: "44".repeat(32),
        secret: returnedProof.secret,
      }),
    ],
  }));
  const completeSwap = vi.fn(async () => ({
    keep: [returnedProof],
    send: [],
  }));
  return {
    checkProofsStates: vi.fn(async (proofs: Proof[]) =>
      proofs.map((proof) => bearerProofState(proof, CheckStateEnum.UNSPENT)),
    ),
    getFeesForProofs: vi.fn(() => Amount.from(0)),
    prepareSwapToReceive,
    completeSwap,
  };
}
