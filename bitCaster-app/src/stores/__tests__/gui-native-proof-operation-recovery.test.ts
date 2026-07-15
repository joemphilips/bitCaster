import "fake-indexeddb/auto";
import { Amount, Mint as CashuMint } from "@cashu/cashu-ts";
import { createDurableWalletProofTransition } from "@bitcaster/client-sdk/durableWalletProofTransition";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DexieDurableCustodyStore } from "../durable-custody-dexie";
import {
  __resetGuiNativeProofOperationRecoverySchedulerForTests,
  __setGuiNativeProofOperationRecoveryPageSizeForTests,
  __setGuiNativeProofOperationRecoveryTimerForTests,
  GUI_NATIVE_PROOF_RECOVERY_PAGE_SIZE,
  recoverGuiNativeProofOperations,
  requestGuiNativeProofOperationRecovery,
} from "../gui-native-proof-operation-recovery";
import {
  abortPreparedGuiWalletMintForWallet,
  markProofOperationCompletedForWallet,
  markProofOperationFailed,
  markProofOperationMintSubmitted,
  markProofOperationMintSubmittedForWallet,
  prepareProofOperation,
} from "../gui-wallet-proof-operation-custody";
import { guiWalletLockName } from "../gui-wallet-lock";
import type { ProofOperationRecord } from "../proof-db";
import {
  currentGuiWalletId,
  db,
  prepareStoredProofForWrite,
  proofOperationPrimaryKey,
} from "../proof-db";
import { useWalletStore } from "../wallet";

const recoveryMocks = vi.hoisted(() => ({
  ctfRedeem: vi.fn(),
  conditionRegistration: vi.fn(),
  ecashDepositSplit: vi.fn(),
  ordinaryWallet: vi.fn(),
}));

vi.mock("../gui-ordinary-wallet-operation", async () => {
  const actual = await vi.importActual<
    typeof import("../gui-ordinary-wallet-operation")
  >("../gui-ordinary-wallet-operation");
  return {
    ...actual,
    recoverGuiOrdinaryWalletOperation: recoveryMocks.ordinaryWallet,
  };
});

vi.mock("@/lib/cashu", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/cashu")>("@/lib/cashu");
  return {
    ...actual,
    recoverGuiCtfRedeemOperation: recoveryMocks.ctfRedeem,
  };
});

vi.mock("@/lib/marketRegistrationFee", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/marketRegistrationFee")
  >("@/lib/marketRegistrationFee");
  return {
    ...actual,
    recoverGuiConditionRegistrationOperation:
      recoveryMocks.conditionRegistration,
  };
});

vi.mock("@/lib/guiLocalWalletPayment", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/guiLocalWalletPayment")
  >("@/lib/guiLocalWalletPayment");
  return {
    ...actual,
    recoverGuiEcashDepositSplit: recoveryMocks.ecashDepositSplit,
  };
});

const KEYSET_ID = `00${"22".repeat(7)}`;
const PUBLIC_KEY = `02${"33".repeat(32)}`;
const MNEMONIC = `${"abandon ".repeat(11)}about`;
const OTHER_MNEMONIC =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";

describe("GUI native proof-operation startup recovery", () => {
  let locks: NonWaitingWebLocks;

  beforeEach(async () => {
    recoveryMocks.ctfRedeem
      .mockReset()
      .mockImplementation(completeOperationUnlocked);
    recoveryMocks.conditionRegistration
      .mockReset()
      .mockImplementation(completeOperationUnlocked);
    recoveryMocks.ecashDepositSplit
      .mockReset()
      .mockImplementation(async (walletId: string, operationId: string) => {
        await requireWalletLockAvailable(walletId);
        const operation = await db.proofOperations.get(
          proofOperationPrimaryKey(walletId, operationId),
        );
        if (!operation) throw new Error("missing regular split fixture");
        await completeOperationUnlocked(operation);
      });
    recoveryMocks.ordinaryWallet
      .mockReset()
      .mockImplementation(async (operation: ProofOperationRecord) => {
        await completeOperationUnlocked(operation);
        return { kind: "settled" };
      });
    useWalletStore.setState({ mnemonic: MNEMONIC });
    vi.spyOn(CashuMint.prototype, "getKeys").mockResolvedValue({
      keysets: [{ id: KEYSET_ID, unit: "sat", keys: { "1": PUBLIC_KEY } }],
    });
    locks = new NonWaitingWebLocks();
    installWebLocks(locks);
    db.close();
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    __resetGuiNativeProofOperationRecoverySchedulerForTests();
    vi.restoreAllMocks();
    delete (navigator as { locks?: LockManager }).locks;
    db.close();
    await db.delete();
  });

  it("treats a wallet with no custody scope as clear", async () => {
    await expect(recoverGuiNativeProofOperations()).resolves.toBe("clear");
    expect(recoveryMocks.ctfRedeem).not.toHaveBeenCalled();
  });

  it("pages canonical active work in bounded groups of sixteen", async () => {
    expect(GUI_NATIVE_PROOF_RECOVERY_PAGE_SIZE).toBe(16);
    __setGuiNativeProofOperationRecoveryPageSizeForTests(1);
    for (let index = 0; index < 2; index += 1) {
      await prepareNativeOperation("ctf-redeem", index);
    }
    const listPage = vi.spyOn(
      DexieDurableCustodyStore.prototype,
      "listRecoverablePage",
    );

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("clear");

    expect(recoveryMocks.ctfRedeem).toHaveBeenCalledTimes(2);
    expect(listPage).toHaveBeenCalledTimes(2);
    expect(listPage.mock.calls[0]![0]).toMatchObject({
      cursor: null,
      limit: 1,
    });
    expect(listPage.mock.calls[1]![0]).toMatchObject({ limit: 1 });
    expect(listPage.mock.calls[1]![0].cursor).not.toBeNull();
  });

  it("coalesces duplicate startup triggers into one dispatch", async () => {
    await prepareNativeOperation("ctf-redeem", 1);
    let finish!: () => void;
    recoveryMocks.ctfRedeem.mockImplementation(
      async (operation: ProofOperationRecord) => {
        await requireWalletLockAvailable(operation.walletId);
        await new Promise<void>((resolve) => (finish = resolve));
        await completeOperationUnlocked(operation);
      },
    );

    const first = requestGuiNativeProofOperationRecovery();
    const second = requestGuiNativeProofOperationRecovery();
    await vi.waitFor(() =>
      expect(recoveryMocks.ctfRedeem).toHaveBeenCalledOnce(),
    );

    expect(first).toBe(second);
    finish();
    await expect(first).resolves.toBe("clear");
  });

  it("keeps an operation pending when a handler returns without committing", async () => {
    await prepareNativeOperation("ctf-redeem", 7);
    recoveryMocks.ctfRedeem.mockResolvedValueOnce(undefined);

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("pending");

    expect(await db.custodyOperations.where("active").equals(1).count()).toBe(
      1,
    );
  });

  it("persists bounded transient-evidence retry authority and wakes without browser events", async () => {
    const clock = installFakeRecoveryClock(10_000);
    const operation = await prepareOrdinaryOperation("wallet-mint", 20);
    recoveryMocks.ordinaryWallet
      .mockResolvedValueOnce({
        kind: "retry-later",
        reason: "mint-response-unknown",
      })
      .mockImplementationOnce(async (current: ProofOperationRecord) => {
        await completeOperationUnlocked(current);
        return { kind: "settled" };
      });

    await expect(requestGuiNativeProofOperationRecovery()).resolves.toBe(
      "pending",
    );

    expect(recoveryMocks.ordinaryWallet).toHaveBeenCalledOnce();
    expect(await retryAuthority(operation)).toEqual({
      attempt: 1,
      nextAttemptAtMs: 11_000,
      reason: "mint-response-unknown",
    });

    clock.advanceBy(999);
    expect(recoveryMocks.ordinaryWallet).toHaveBeenCalledOnce();
    clock.advanceBy(1);
    await requestGuiNativeProofOperationRecovery();

    expect(recoveryMocks.ordinaryWallet).toHaveBeenCalledTimes(2);
    expect(await db.custodyOperations.where("active").equals(1).count()).toBe(
      0,
    );
  });

  it("retries the same submitted operation on the exact persisted timer after startup reissue response loss", async () => {
    const clock = installFakeRecoveryClock(15_000);
    const operation = await prepareOrdinaryOperation("wallet-mint", 26);
    await markProofOperationMintSubmitted(operation.operationId);
    recoveryMocks.ordinaryWallet
      .mockImplementationOnce(async (current: ProofOperationRecord) => {
        expect(current).toMatchObject({
          operationId: operation.operationId,
          state: "mint-submitted",
        });
        return {
          kind: "retry-later",
          reason: "mint-response-unknown",
        };
      })
      .mockImplementationOnce(async (current: ProofOperationRecord) => {
        expect(current).toMatchObject({
          operationId: operation.operationId,
          state: "mint-submitted",
        });
        await completeOperationUnlocked(current);
        return { kind: "settled" };
      });

    await expect(requestGuiNativeProofOperationRecovery()).resolves.toBe(
      "pending",
    );
    expect(await retryAuthority(operation)).toEqual({
      attempt: 1,
      nextAttemptAtMs: 16_000,
      reason: "mint-response-unknown",
    });

    clock.advanceBy(1_000);
    await requestGuiNativeProofOperationRecovery();

    expect(recoveryMocks.ordinaryWallet).toHaveBeenCalledTimes(2);
    expect(await db.custodyOperations.where("active").equals(1).count()).toBe(
      0,
    );
  });

  it("clears an atomically aborted expired mint without polling it again", async () => {
    const operation = await prepareOrdinaryOperation("wallet-mint", 25);
    recoveryMocks.ordinaryWallet.mockImplementationOnce(async () => {
      await abortPreparedGuiWalletMintForWallet(
        operation.walletId,
        operation.operationId,
        {
          kind: "abort-no-transport",
          classification: "all-inputs-unspent",
          reason: "mint-quote-expired",
        },
      );
      return { kind: "settled" };
    });

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("clear");

    expect(recoveryMocks.ordinaryWallet).toHaveBeenCalledOnce();
    expect(
      await db.custodyOperations.get(operation.custodyOperationId),
    ).toMatchObject({ active: 0, record: { operation: { state: "aborted" } } });
    expect(
      await db.proofOperations.get(
        proofOperationPrimaryKey(operation.walletId, operation.operationId),
      ),
    ).toMatchObject({ state: "Failed", failureCode: 408 });
  });

  it("rebuilds a transient-evidence wake-up from persisted authority after reload", async () => {
    const clock = installFakeRecoveryClock(20_000);
    const operation = await prepareOrdinaryOperation("wallet-receive", 21);
    await markProofOperationMintSubmitted(operation.operationId);
    recoveryMocks.ordinaryWallet
      .mockResolvedValueOnce({
        kind: "retry-later",
        reason: "mint-response-unknown",
      })
      .mockImplementationOnce(async (current: ProofOperationRecord) => {
        await completeOperationUnlocked(current);
        return { kind: "settled" };
      });

    await expect(requestGuiNativeProofOperationRecovery()).resolves.toBe(
      "pending",
    );
    expect(await retryAuthority(operation)).toEqual({
      attempt: 1,
      nextAttemptAtMs: 21_000,
      reason: "mint-response-unknown",
    });

    __resetGuiNativeProofOperationRecoverySchedulerForTests();
    clock.install();
    clock.advanceBy(400);
    await expect(requestGuiNativeProofOperationRecovery()).resolves.toBe(
      "pending",
    );
    expect(recoveryMocks.ordinaryWallet).toHaveBeenCalledOnce();

    clock.advanceBy(599);
    expect(recoveryMocks.ordinaryWallet).toHaveBeenCalledOnce();
    clock.advanceBy(1);
    await requestGuiNativeProofOperationRecovery();

    expect(recoveryMocks.ordinaryWallet).toHaveBeenCalledTimes(2);
    expect(await db.custodyOperations.where("active").equals(1).count()).toBe(
      0,
    );
  });

  it("does not turn an unexpected ordinary-wallet fault into an infinite retry", async () => {
    const clock = installFakeRecoveryClock(30_000);
    const operation = await prepareOrdinaryOperation("wallet-mint", 22);
    recoveryMocks.ordinaryWallet.mockRejectedValueOnce(
      new Error("deterministic local validation failed"),
    );

    await expect(requestGuiNativeProofOperationRecovery()).resolves.toBe(
      "blocked",
    );
    expect(await retryAuthority(operation)).toEqual({
      attempt: 0,
      nextAttemptAtMs: null,
      reason: "none",
    });

    clock.advanceBy(60_000);
    expect(recoveryMocks.ordinaryWallet).toHaveBeenCalledOnce();
  });

  it("blocks corrupt ordinary-wallet authority without scheduling or dispatch", async () => {
    const clock = installFakeRecoveryClock(35_000);
    const operation = await prepareOrdinaryOperation("wallet-receive", 27);
    await db.proofOperations.update(operationKey(operation.operationId), {
      metadata: {
        ...operation.metadata,
        unit: "msat",
      },
    });

    await expect(requestGuiNativeProofOperationRecovery()).resolves.toBe(
      "blocked",
    );

    expect(recoveryMocks.ordinaryWallet).not.toHaveBeenCalled();
    expect(await retryAuthority(operation)).toEqual({
      attempt: 0,
      nextAttemptAtMs: null,
      reason: "none",
    });
    clock.advanceBy(60_000);
    expect(recoveryMocks.ordinaryWallet).not.toHaveBeenCalled();
  });

  it("does not let a stale wallet completion cancel the current wallet wake", async () => {
    const clock = installFakeRecoveryClock(40_000);
    const oldWalletId = currentGuiWalletId();
    await prepareOrdinaryOperation("wallet-mint", 23);
    let startOld!: () => void;
    let finishOld!: () => void;
    const oldStarted = new Promise<void>((resolve) => (startOld = resolve));
    const oldFinished = new Promise<void>((resolve) => (finishOld = resolve));
    let newWalletId = "";
    let newAttempts = 0;
    recoveryMocks.ordinaryWallet.mockImplementation(async (operation) => {
      if (operation.walletId === oldWalletId) {
        startOld();
        await oldFinished;
        return { kind: "retry-later", reason: "pending-or-mixed" };
      }
      if (operation.walletId !== newWalletId) {
        throw new Error("unexpected wallet recovery fixture");
      }
      newAttempts += 1;
      if (newAttempts === 1) {
        return { kind: "retry-later", reason: "pending-or-mixed" };
      }
      await completeOperationUnlocked(operation);
      return { kind: "settled" };
    });

    const oldRecovery = requestGuiNativeProofOperationRecovery();
    await oldStarted;
    useWalletStore.setState({ mnemonic: OTHER_MNEMONIC });
    newWalletId = currentGuiWalletId();
    const newOperation = await prepareOrdinaryOperation("wallet-mint", 24);
    await expect(requestGuiNativeProofOperationRecovery()).resolves.toBe(
      "pending",
    );

    finishOld();
    await expect(oldRecovery).resolves.toBe("blocked");
    clock.advanceBy(1_000);
    await requestGuiNativeProofOperationRecovery();

    expect(newAttempts).toBe(2);
    if (!newOperation.custodyOperationId) {
      throw new Error("new wallet operation has no custody authority");
    }
    expect(
      await db.custodyOperations.get(newOperation.custodyOperationId),
    ).toMatchObject({ active: 0 });
  });

  it("does not queue background recovery behind a held profile lock", async () => {
    await prepareNativeOperation("ctf-redeem", 2);
    const release = locks.holdNextExclusiveRequest();
    const holder = navigator.locks.request(
      `bitcaster-custody:${currentGuiWalletId()}`,
      { mode: "exclusive" },
      async () => release.wait,
    );
    await release.acquired;

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("pending");
    expect(recoveryMocks.ctfRedeem).not.toHaveBeenCalled();

    release.finish();
    await holder;
  });

  it("dispatches condition registration from the exact persisted row", async () => {
    const prepared = await prepareNativeOperation(
      "ctf-condition-registration",
      3,
    );

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("clear");

    expect(recoveryMocks.conditionRegistration).toHaveBeenCalledOnce();
    expect(recoveryMocks.conditionRegistration.mock.calls[0]![0]).toMatchObject(
      {
        operationId: prepared.operationId,
        custodyOperationId: prepared.custodyOperationId,
        walletId: currentGuiWalletId(),
      },
    );
  });

  it.each([
    [
      "foreign custody link",
      async (operationId: string) => {
        await db.proofOperations.update(operationKey(operationId), {
          custodyOperationId: "foreign-custody-operation",
        });
      },
    ],
    [
      "foreign wallet",
      async (operationId: string) => {
        const key = operationKey(operationId);
        const operation = await db.proofOperations.get(key);
        if (!operation) throw new Error("missing native operation fixture");
        await db.proofOperations.delete(key);
        await db.proofOperations.put({
          ...operation,
          walletId: "ff".repeat(32),
        });
      },
    ],
    [
      "substituted request authority",
      async (operationId: string) => {
        await db.proofOperations.update(operationKey(operationId), {
          metadata: {
            unit: "msat",
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
        });
      },
    ],
  ])(
    "blocks %s without dispatch or reservation release",
    async (_name, corrupt) => {
      const prepared = await prepareNativeOperation("ctf-redeem", 4);
      await corrupt(prepared.operationId);

      await expect(recoverGuiNativeProofOperations()).resolves.toBe("blocked");

      expect(recoveryMocks.ctfRedeem).not.toHaveBeenCalled();
      expect(await db.custodyProofReservations.count()).toBe(1);
      expect((await storedRow(prepared.inputs[0]!.secret))?.reservedBy).toBe(
        prepared.operationId,
      );
    },
  );

  it("delegates deposit-owned regular splits to exact pending-deposit recovery", async () => {
    const prepared = await prepareNativeOperation("regular-split", 5);

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("clear");

    expect(recoveryMocks.ctfRedeem).not.toHaveBeenCalled();
    expect(recoveryMocks.conditionRegistration).not.toHaveBeenCalled();
    expect(recoveryMocks.ecashDepositSplit).toHaveBeenCalledWith(
      currentGuiWalletId(),
      prepared.operationId,
    );
    expect(
      await db.proofOperations.get(operationKey(prepared.operationId)),
    ).toMatchObject({
      state: "completed",
      custodyOperationId: prepared.custodyOperationId,
    });
    expect(await db.custodyProofReservations.count()).toBe(0);
  });

  it("does not return terminal rows from the canonical active index", async () => {
    const prepared = await prepareNativeOperation("ctf-redeem", 6);
    await markProofOperationMintSubmitted(prepared.operationId, {
      schemaVersion: 1,
      requestDigest: "a".repeat(64),
    });
    await markProofOperationFailed(
      prepared.operationId,
      Object.assign(new Error("terminal"), { code: 13015 }),
    );

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("clear");
    expect(recoveryMocks.ctfRedeem).not.toHaveBeenCalled();
    expect(await db.custodyOperations.where("active").equals(1).count()).toBe(
      0,
    );
  });

  it("runs external recovery with the same-wallet lock available", async () => {
    await prepareNativeOperation("ctf-redeem", 8);

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("clear");

    expect(recoveryMocks.ctfRedeem).toHaveBeenCalledOnce();
  });

  it("isolates the captured authority from mutations by an external handler", async () => {
    const prepared = await prepareNativeOperation("ctf-redeem", 11);
    recoveryMocks.ctfRedeem.mockImplementationOnce(async (operation) => {
      operation.custodyOperationId = "mutated-handler-argument";
      operation.metadata.unit = "msat";
    });

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("pending");

    expect(
      await db.proofOperations.get(operationKey(prepared.operationId)),
    ).toMatchObject({
      state: "prepared",
      custodyOperationId: prepared.custodyOperationId,
      metadata: { unit: "sat" },
    });
  });

  it("blocks after a seed switch without writing either wallet", async () => {
    const prepared = await prepareNativeOperation("ctf-redeem", 9);
    const originalWalletId = currentGuiWalletId();
    const replacementMnemonic = `${"legal winner thank year wave sausage worth useful ".repeat(1)}legal winner thank yellow`;
    recoveryMocks.ctfRedeem.mockImplementationOnce(async () => {
      useWalletStore.setState({ mnemonic: replacementMnemonic });
    });

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("blocked");

    const replacementWalletId = currentGuiWalletId();
    expect(replacementWalletId).not.toBe(originalWalletId);
    expect(
      await db.proofOperations.get(
        proofOperationPrimaryKey(originalWalletId, prepared.operationId),
      ),
    ).toMatchObject({ state: "prepared", walletId: originalWalletId });
    expect(
      await db.proofOperations
        .where("walletId")
        .equals(replacementWalletId)
        .count(),
    ).toBe(0);
    expect(await db.custodyProofReservations.count()).toBe(1);
  });

  it("revalidates the exact custody link after unlocked dispatch", async () => {
    const prepared = await prepareNativeOperation("ctf-redeem", 10);
    recoveryMocks.ctfRedeem.mockImplementationOnce(async (operation) => {
      await db.proofOperations.update(
        proofOperationPrimaryKey(operation.walletId, operation.operationId),
        { custodyOperationId: "substituted-custody-operation" },
      );
    });

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("blocked");

    expect(recoveryMocks.ctfRedeem).toHaveBeenCalledOnce();
    expect(await db.custodyProofReservations.count()).toBe(1);
    expect((await storedRow(prepared.inputs[0]!.secret))?.reservedBy).toBe(
      prepared.operationId,
    );
  });

  it("blocks a completed inactive pair whose native result proofs are missing", async () => {
    await prepareNativeOperation("ctf-redeem", 12);
    recoveryMocks.ctfRedeem.mockImplementationOnce(async (operation) => {
      await completeOperationUnlocked(operation);
      await db.proofOperations.update(
        proofOperationPrimaryKey(operation.walletId, operation.operationId),
        { resultProofs: undefined },
      );
    });

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("blocked");

    expect(recoveryMocks.ctfRedeem).toHaveBeenCalledOnce();
    expect(await db.custodyOperations.where("active").equals(1).count()).toBe(
      0,
    );
  });

  it("blocks a completed inactive pair whose physical result proof is missing", async () => {
    await prepareNativeOperation("ctf-redeem", 12);
    recoveryMocks.ctfRedeem.mockImplementationOnce(async (operation) => {
      await completeOperationUnlocked(operation);
      const completed = await db.proofOperations.get(
        proofOperationPrimaryKey(operation.walletId, operation.operationId),
      );
      const secret = completed?.resultProofs?.change?.[0]?.secret;
      if (!secret) throw new Error("missing completed result fixture");
      const physical = (await db.proofs.toArray()).find(
        (proof) => proof.secret === secret,
      );
      if (!physical) throw new Error("missing physical result fixture");
      await db.proofs.delete(physical.proofId);
      expect(await db.proofs.get(physical.proofId)).toBeUndefined();
    });

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("blocked");

    expect(recoveryMocks.ctfRedeem).toHaveBeenCalledOnce();
    expect(await db.custodyOperations.where("active").equals(1).count()).toBe(
      0,
    );
  });

  it.each([
    [
      "malformed native result proof",
      async (operation: ProofOperationRecord) => {
        const row = await db.proofOperations.get(
          proofOperationPrimaryKey(operation.walletId, operation.operationId),
        );
        const proof = row?.resultProofs?.change?.[0];
        if (!proof) throw new Error("missing completed result fixture");
        await db.proofOperations.update(
          proofOperationPrimaryKey(operation.walletId, operation.operationId),
          { resultProofs: { change: [{ ...proof, C: "" }] } },
        );
      },
    ],
    [
      "mismatched native result fingerprint",
      async (operation: ProofOperationRecord) => {
        const row = await db.proofOperations.get(
          proofOperationPrimaryKey(operation.walletId, operation.operationId),
        );
        const proof = row?.resultProofs?.change?.[0];
        if (!proof) throw new Error("missing completed result fixture");
        await db.proofOperations.update(
          proofOperationPrimaryKey(operation.walletId, operation.operationId),
          {
            resultProofs: {
              change: [{ ...proof, secret: "ff".repeat(32) }],
            },
          },
        );
      },
    ],
    [
      "mismatched canonical result fingerprint",
      async (operation: ProofOperationRecord) => {
        await replaceCanonicalResultFingerprint(operation, {
          resultFingerprint: "f".repeat(64),
        });
      },
    ],
    [
      "mismatched canonical output-plan fingerprint",
      async (operation: ProofOperationRecord) => {
        await replaceCanonicalResultFingerprint(operation, {
          outputPlanFingerprint: "e".repeat(64),
        });
      },
    ],
  ])("blocks a completed inactive pair with %s", async (_name, corrupt) => {
    await prepareNativeOperation("ctf-redeem", 13);
    recoveryMocks.ctfRedeem.mockImplementationOnce(async (operation) => {
      await completeOperationUnlocked(operation);
      await corrupt(operation);
    });

    await expect(recoverGuiNativeProofOperations()).resolves.toBe("blocked");

    expect(recoveryMocks.ctfRedeem).toHaveBeenCalledOnce();
  });
});

function operationKey(operationId: string) {
  return proofOperationPrimaryKey(currentGuiWalletId(), operationId);
}

async function prepareNativeOperation(
  kind: "ctf-redeem" | "ctf-condition-registration" | "regular-split",
  index: number,
) {
  const suffix = index.toString(16).padStart(2, "0");
  const secret = suffix.repeat(32);
  const outputSecret = `${(index + 64).toString(16).padStart(2, "0")}`.repeat(
    32,
  );
  const operationId = `${kind}:${index.toString().padStart(4, "0")}`;
  const input = {
    id: KEYSET_ID,
    amount: Amount.from(2),
    secret,
    C: PUBLIC_KEY,
  };
  await db.proofs.put(
    prepareStoredProofForWrite(
      { ...input, mintUrl: "https://mint.example", unit: "sat" },
      1,
      currentGuiWalletId(),
    ),
  );
  return prepareProofOperation({
    operationId,
    kind,
    mintUrl: "https://mint.example",
    inputs: [input],
    outputs: {
      change: [
        {
          blindedMessage: { amount: 1, id: KEYSET_ID, B_: PUBLIC_KEY },
          blindingFactor: "44".repeat(32),
          secret: outputSecret,
        },
      ],
    },
    metadata: {
      unit: "sat",
      durableWalletProofTransition: createDurableWalletProofTransition({
        inputSource: "wallet",
        plannedOutputLabels: ["change"],
        resultGroups: {
          change: { kind: "wallet", asset: "regular", reservedBy: null },
        },
      }),
    },
  });
}

async function prepareOrdinaryOperation(
  kind: "wallet-mint" | "wallet-receive",
  index: number,
) {
  const suffix = index.toString(16).padStart(2, "0");
  const outputSecret = `${(index + 64).toString(16).padStart(2, "0")}`.repeat(
    32,
  );
  const operationId = `${kind}:${index.toString().padStart(4, "0")}`;
  return prepareProofOperation({
    operationId,
    kind,
    mintUrl: "https://mint.example",
    inputs:
      kind === "wallet-receive"
        ? [
            {
              id: KEYSET_ID,
              amount: Amount.from(2),
              secret: suffix.repeat(32),
              C: PUBLIC_KEY,
            },
          ]
        : [],
    outputs: {
      receive: [
        {
          blindedMessage: { amount: 2, id: KEYSET_ID, B_: PUBLIC_KEY },
          blindingFactor: "44".repeat(32),
          secret: outputSecret,
        },
      ],
    },
    metadata: {
      unit: "sat",
      durableWalletProofTransition: createDurableWalletProofTransition({
        inputSource: "external",
        plannedOutputLabels: ["receive"],
        resultGroups: {
          receive: { kind: "wallet", asset: "regular", reservedBy: null },
        },
      }),
    },
  });
}

async function retryAuthority(operation: ProofOperationRecord) {
  if (!operation.custodyOperationId) {
    throw new Error("ordinary operation has no custody authority");
  }
  const row = await db.custodyOperations.get(operation.custodyOperationId);
  if (!row) throw new Error("ordinary custody operation is missing");
  return row.record.operation.retry;
}

function installFakeRecoveryClock(initialNowMs: number): FakeRecoveryClock {
  const clock = new FakeRecoveryClock(initialNowMs);
  vi.spyOn(Date, "now").mockImplementation(() => clock.nowMs);
  clock.install();
  return clock;
}

class FakeRecoveryClock {
  readonly #tasks = new Map<
    symbol,
    { dueAtMs: number; callback: () => void }
  >();

  constructor(public nowMs: number) {}

  install(): void {
    __setGuiNativeProofOperationRecoveryTimerForTests({
      schedule: (callback, delayMs) => {
        const id = Symbol("native-recovery-timer");
        this.#tasks.set(id, {
          dueAtMs: this.nowMs + delayMs,
          callback,
        });
        return id;
      },
      cancel: (timer) => {
        this.#tasks.delete(timer as symbol);
      },
    });
  }

  advanceBy(durationMs: number): void {
    this.nowMs += durationMs;
    const due = [...this.#tasks.entries()]
      .filter(([, task]) => task.dueAtMs <= this.nowMs)
      .sort((left, right) => left[1].dueAtMs - right[1].dueAtMs);
    for (const [id, task] of due) {
      if (!this.#tasks.delete(id)) continue;
      task.callback();
    }
  }
}

class NonWaitingWebLocks {
  readonly #busy = new Set<string>();
  #hold?: ReturnType<NonWaitingWebLocks["holdNextExclusiveRequest"]>;

  holdNextExclusiveRequest() {
    let markAcquired!: () => void;
    let finish!: () => void;
    const acquired = new Promise<void>((resolve) => (markAcquired = resolve));
    const wait = new Promise<void>((resolve) => (finish = resolve));
    const hold = { acquired, wait, finish, markAcquired };
    this.#hold = hold;
    return hold;
  }

  async request<T>(
    name: string,
    options: LockOptions,
    callback: (lock: Lock | null) => Promise<T>,
  ): Promise<T> {
    if (options.ifAvailable && this.#busy.has(name)) return callback(null);
    while (this.#busy.has(name)) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    this.#busy.add(name);
    this.#hold?.markAcquired();
    try {
      return await callback({ name, mode: "exclusive" } as Lock);
    } finally {
      this.#busy.delete(name);
      this.#hold = undefined;
    }
  }
}

function installWebLocks(locks: NonWaitingWebLocks): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: locks,
  });
}

async function completeOperationUnlocked(
  operation: ProofOperationRecord,
): Promise<void> {
  await requireWalletLockAvailable(operation.walletId);
  const output =
    operation.outputs.change?.[0] ?? operation.outputs.receive?.[0];
  if (!output) throw new Error("test operation has no output");
  const label = operation.outputs.change?.[0] ? "change" : "receive";
  if (operation.state === "prepared") {
    await markProofOperationMintSubmittedForWallet(
      operation.walletId,
      operation.operationId,
    );
  }
  await markProofOperationCompletedForWallet(
    operation.walletId,
    operation.operationId,
    {
      [label]: [
        {
          id: output.blindedMessage.id,
          amount: Amount.from(output.blindedMessage.amount),
          secret: output.secret,
          C: PUBLIC_KEY,
        },
      ],
    },
  );
}

async function requireWalletLockAvailable(walletId: string): Promise<void> {
  const available = await navigator.locks.request(
    guiWalletLockName(walletId),
    { mode: "exclusive", ifAvailable: true },
    async (lock) => lock !== null,
  );
  if (!available) {
    throw new Error("external recovery ran while the wallet lock was held");
  }
}

async function storedRow(secret: string) {
  return (await db.proofs.toArray()).find((proof) => proof.secret === secret);
}

async function replaceCanonicalResultFingerprint(
  operation: ProofOperationRecord,
  replacement: {
    resultFingerprint?: string;
    outputPlanFingerprint?: string;
  },
): Promise<void> {
  if (!operation.custodyOperationId) {
    throw new Error("missing canonical operation fixture");
  }
  const row = await db.custodyOperations.get(operation.custodyOperationId);
  if (!row) throw new Error("missing canonical result fixture");
  await db.custodyOperations.put({
    ...row,
    record: {
      ...row.record,
      operation: {
        ...row.record.operation,
        result: { ...row.record.operation.result, ...replacement },
      },
    },
  });
}
