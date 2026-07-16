import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Amount,
  CheckStateEnum,
  getEncodedTokenV4,
  hashToCurve,
  Mint as CashuMint,
  type Proof,
  type ProofState,
} from "@cashu/cashu-ts";
import Dexie from "dexie";
import { createDurableWalletProofTransition } from "@bitcaster/client-sdk/durableWalletProofTransition";
import { deriveDurableCustodyProofResultFingerprint } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import {
  createDurableBearerSpendDeliveryRecord,
  decodeDurableBearerSpendDeliveryRecord,
  isDurableBearerSpendTokenPresentable,
  planDurableBearerSpendCustodyHandoff,
  reconcileDurableBearerSpendDelivery,
  reduceDurableBearerSpendReclaimLineage,
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
} from "../gui-wallet-proof-operation-custody";
import {
  currentGuiWalletId,
  db,
  prepareStoredProofForWrite,
  proofOperationPrimaryKey,
} from "../proof-db";
import { useWalletStore } from "../wallet";
import { guiWalletLockName } from "../gui-wallet-lock";
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
  guiWalletSendTokenFingerprint,
  readGuiWalletSendDeliveryMetadata,
} from "../gui-wallet-send-delivery";
import { createGuiBearerSpendDeliveryRow } from "../gui-bearer-spend-delivery";

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
      guiWalletSendDelivery: guiWalletSendDeliveryMetadata({
        mintUrl: input.mintUrl,
        unit: "sat",
        sendOutputs,
        keepOutputs: input.outputs.change,
        passthroughProofs: [passthrough],
      }),
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
  return {
    ...single,
    operationId: "wallet-multi-send-operation-001",
    outputs: { ...single.outputs, send: sendOutputs },
    metadata: {
      ...single.metadata,
      guiWalletSendDelivery: guiWalletSendDeliveryMetadata({
        mintUrl: single.mintUrl,
        unit: "sat",
        sendOutputs,
        keepOutputs: single.outputs.keep,
        passthroughProofs: [single.passthrough],
      }),
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
              transaction.putDelivery({
                operationId: record.operation.operationId,
                deliveryKind: "wallet-send",
                payloadHandle: `wallet-send:${operation.operationId}`,
                payloadFingerprint: guiWalletSendTokenFingerprint(encodedToken),
                expiresAtMs: null,
                state: "pending",
              });
            },
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
        const preparedReclaim = reduceDurableBearerSpendReclaimLineage(
          unspent,
          {
            kind: "prepared",
            operationId: "reclaim-operation-001",
            requestFingerprint: "ab".repeat(32),
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
            operationId: "reclaim-operation-001",
            requestFingerprint: "ab".repeat(32),
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
            operationId: "reclaim-operation-001",
            parentDeliveryId: recipient.deliveryId,
            requestFingerprint: "ab".repeat(32),
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
