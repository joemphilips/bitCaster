import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Amount, Mint as CashuMint } from "@cashu/cashu-ts";
import Dexie from "dexie";
import { createDurableWalletProofTransition } from "@bitcaster/client-sdk/durableWalletProofTransition";
import {
  abortPreparedGuiWalletMintForWallet,
  claimPreparedProofOperationMintSubmissionForWallet,
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
    expect(
      (await db.custodyOperations.get(prepared.custodyOperationId!))?.record
        .operation.verification.keysetBindings,
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

  it("keeps the Dexie transaction active through snapshot validation and rolls back a native write fault", async () => {
    const prepared = await prepareProofOperation(operationInput());
    await markProofOperationMintSubmitted(prepared.operationId);
    let observedActiveTransaction = false;
    const operationPut = vi
      .spyOn(db.proofOperations, "put")
      .mockImplementation((() => {
        observedActiveTransaction = Dexie.currentTransaction !== null;
        throw new Error("injected native write failure");
      }) as never);

    await expect(
      markProofOperationCompleted(prepared.operationId, resultProofs()),
    ).rejects.toThrow(/injected native write failure/);
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
