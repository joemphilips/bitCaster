import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeGuiLocalWalletPayment,
  observeGuiEcashDeposit,
  recoverGuiEcashDepositSplit,
  reconcileGuiEcashDeposits,
  retryGuiEcashDeposit,
  type GuiEcashDepositState,
  type GuiEcashDepositStatusSnapshot,
  type GuiEcashDepositStatusRequest,
  type GuiEcashDepositSubmission,
  type GuiEcashDepositRemote,
} from "../guiLocalWalletPayment";

const ensureImplicitWallet = vi.fn();
const getBoundedUnitProofsForAmountUnderLock = vi.fn();
const getWalletForUnit = vi.fn();
const encodeToken = vi.fn();
const splitRegularProofsWithOperation = vi.fn();
const restoreOutputGroups = vi.fn();
const createCapturedGuiWalletProofOperationStore = vi.fn();
const getProofOperation = vi.fn();
const createPreIntentUnderLock = vi.fn();
const recordSplitUnderLock = vi.fn();
const recordRemoteStateUnderLock = vi.fn();
const recordErrorUnderLock = vi.fn();
const deferRetryUnderLock = vi.fn();
const completeCreditedUnderLock = vi.fn();
const listPendingUnderLock = vi.fn();
const getPendingUnderLock = vi.fn();
const findPendingBySplitOperationUnderLock = vi.fn();
const requireRemoteAuthorityUnderLock = vi.fn();
const blockPendingUnderLock = vi.fn();
const getRecoverySummaryUnderLock = vi.fn();
const releaseAuthority = vi.fn();
const walletLock = { kind: "held-wallet-lock" };
const operationStore = { getProofOperation };
const DEPOSIT_ID = "00000000-0000-4000-8000-000000000001";
const WALLET_A = "aa".repeat(32);
const WALLET_B = "bb".repeat(32);
let activeWalletId = WALLET_A;
let walletLockDepth = 0;
let durablePayment:
  | ReturnType<typeof preparedRow>
  | ReturnType<typeof reservedRow>;

vi.mock("@/stores/wallet", () => ({
  useWalletStore: {
    getState: () => ({ ensureImplicitWallet }),
  },
}));

vi.mock("@/stores/gui-custody-authority", () => ({
  withGuiCustodyProfileLockForWallet: async (
    expectedWalletId: string,
    action: (...args: unknown[]) => unknown,
  ) => {
    if (expectedWalletId !== activeWalletId) {
      throw new Error("Pending ecash deposit wallet seed changed");
    }
    walletLockDepth += 1;
    try {
      return await action(
        { walletId: expectedWalletId, scope: {} },
        walletLock,
      );
    } finally {
      walletLockDepth -= 1;
    }
  },
  releaseGuiCustodyAuthority: (...args: unknown[]) => releaseAuthority(...args),
}));

vi.mock("@/stores/proof-db", () => ({
  currentGuiWalletId: () => activeWalletId,
  getBoundedUnitProofsForAmountUnderLock: (...args: unknown[]) =>
    getBoundedUnitProofsForAmountUnderLock(...args),
}));

vi.mock("@/stores/gui-wallet-proof-operation-store", () => ({
  createCapturedGuiWalletProofOperationStore: (...args: unknown[]) =>
    createCapturedGuiWalletProofOperationStore(...args),
}));

vi.mock("@/lib/cashu", () => ({
  getWalletForUnit: (...args: unknown[]) => getWalletForUnit(...args),
  encodeToken: (...args: unknown[]) => encodeToken(...args),
}));

vi.mock("@bitcaster/client-sdk/ctfSplit", () => ({
  splitRegularProofsWithOperation: (...args: unknown[]) =>
    splitRegularProofsWithOperation(...args),
  restoreOutputGroups: (...args: unknown[]) => restoreOutputGroups(...args),
}));

vi.mock("@/lib/pendingLocalWalletPayments", () => ({
  depositSplitOperationId: (depositId: string) =>
    `ecash-deposit-split:${depositId}`,
  createPendingEcashDepositUnderLock: (...args: unknown[]) =>
    createPreIntentUnderLock(...args),
  recordPendingEcashDepositSplitUnderLock: (...args: unknown[]) =>
    recordSplitUnderLock(...args),
  recordPendingEcashDepositRemoteStateUnderLock: (...args: unknown[]) =>
    recordRemoteStateUnderLock(...args),
  recordPendingEcashDepositErrorUnderLock: (...args: unknown[]) =>
    recordErrorUnderLock(...args),
  deferPendingEcashDepositRetryUnderLock: (...args: unknown[]) =>
    deferRetryUnderLock(...args),
  completeCreditedEcashDepositUnderLock: (...args: unknown[]) =>
    completeCreditedUnderLock(...args),
  listPendingEcashDepositsUnderLock: (...args: unknown[]) =>
    listPendingUnderLock(...args),
  getPendingEcashDepositUnderLock: (...args: unknown[]) =>
    getPendingUnderLock(...args),
  findPendingEcashDepositBySplitOperationUnderLock: (...args: unknown[]) =>
    findPendingBySplitOperationUnderLock(...args),
  requirePendingEcashDepositRemoteAuthorityUnderLock: (...args: unknown[]) =>
    requireRemoteAuthorityUnderLock(...args),
  blockPendingEcashDepositUnderLock: (...args: unknown[]) =>
    blockPendingUnderLock(...args),
  getPendingEcashDepositRecoverySummaryUnderLock: (...args: unknown[]) =>
    getRecoverySummaryUnderLock(...args),
}));

describe("GUI ecash deposit coordinator", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    activeWalletId = WALLET_A;
    walletLockDepth = 0;
    durablePayment = reservedRow();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(DEPOSIT_ID);
    ensureImplicitWallet.mockResolvedValue(undefined);
    getBoundedUnitProofsForAmountUnderLock.mockResolvedValue([
      proof("input", 150),
    ]);
    getWalletForUnit.mockResolvedValue({ kind: "cashu-wallet" });
    splitRegularProofsWithOperation.mockResolvedValue({
      spent: [proof("input", 150)],
      send: [proof("send", 100)],
      keep: [proof("keep", 50)],
    });
    createCapturedGuiWalletProofOperationStore.mockReturnValue(operationStore);
    getProofOperation.mockResolvedValue(null);
    encodeToken.mockReturnValue("cashuBtoken");
    createPreIntentUnderLock.mockImplementation((_lock, row) => {
      durablePayment = row;
      return row;
    });
    recordSplitUnderLock.mockImplementation(
      (_lock, _depositId, sendProofs, serializedToken) => {
        durablePayment = {
          ...durablePayment,
          phase: "reserved",
          sendProofs,
          serializedToken,
        } as ReturnType<typeof reservedRow>;
        return durablePayment;
      },
    );
    recordRemoteStateUnderLock.mockResolvedValue(undefined);
    recordErrorUnderLock.mockResolvedValue(undefined);
    deferRetryUnderLock.mockResolvedValue(undefined);
    completeCreditedUnderLock.mockResolvedValue(undefined);
    listPendingUnderLock.mockResolvedValue(recoveryPage([]));
    getPendingUnderLock.mockImplementation(async () => durablePayment);
    findPendingBySplitOperationUnderLock.mockImplementation(
      async () => durablePayment,
    );
    requireRemoteAuthorityUnderLock.mockImplementation(
      async () => durablePayment,
    );
    blockPendingUnderLock.mockResolvedValue(undefined);
    getRecoverySummaryUnderLock.mockResolvedValue({
      nextAttemptAt: null,
      blocked: [],
    });
    restoreOutputGroups.mockResolvedValue({
      send: [proof("send", 100)],
      keep: [proof("keep", 50)],
    });
    releaseAuthority.mockResolvedValue(undefined);
  });

  it("persists the exact deposit pre-intent before preparing the regular split", async () => {
    const journal = deferred();
    createPreIntentUnderLock.mockReturnValueOnce(journal.promise);
    const remote = depositRemote("credited");
    const running = executeGuiLocalWalletPayment(input(remote));

    await vi.waitFor(() =>
      expect(createPreIntentUnderLock).toHaveBeenCalledOnce(),
    );
    expect(splitRegularProofsWithOperation).not.toHaveBeenCalled();
    expect(remote.submit).not.toHaveBeenCalled();
    expect(createPreIntentUnderLock).toHaveBeenCalledWith(
      walletLock,
      expect.objectContaining({
        depositId: DEPOSIT_ID,
        splitOperationId: `ecash-deposit-split:${DEPOSIT_ID}`,
        phase: "prepared",
        request: expect.objectContaining({
          conditionId: "condition-a",
          amountSubunits: 100,
          divisibility: 10_000,
          fundAmm: true,
          fundingIdentity: "funder-a",
        }),
      }),
    );
    expect(getBoundedUnitProofsForAmountUnderLock).toHaveBeenCalledWith(
      walletLock,
      "https://mint.example",
      { unit: "sat", minimumAmount: 100 },
    );

    journal.resolve(preparedRow());
    await expect(running).resolves.toEqual({
      status: "completed",
      depositId: DEPOSIT_ID,
    });

    const splitInput = splitRegularProofsWithOperation.mock.calls[0]![0];
    expect(splitInput.operationId).toBe(`ecash-deposit-split:${DEPOSIT_ID}`);
    expect(splitInput.resultDispositions).toEqual({
      send: { kind: "wallet", asset: "regular", reservedBy: DEPOSIT_ID },
      keep: { kind: "wallet", asset: "regular", reservedBy: null },
    });
    expect(remote.submit).toHaveBeenCalledWith(
      expect.objectContaining({ depositId: DEPOSIT_ID, token: "cashuBtoken" }),
    );
    expect(completeCreditedUnderLock).toHaveBeenCalledWith(
      walletLock,
      DEPOSIT_ID,
    );
  });

  it.each(["requested", "paid", "failed"] as const)(
    "retains exact send-proof authority when POST returns %s",
    async (state) => {
      const remote = depositRemote(state);

      await expect(
        executeGuiLocalWalletPayment(input(remote)),
      ).resolves.toEqual({
        status: "pending",
        depositId: DEPOSIT_ID,
        remoteState: state,
      });

      expect(deferRetryUnderLock).toHaveBeenCalledWith(walletLock, DEPOSIT_ID, {
        remoteState: state,
      });
      expect(completeCreditedUnderLock).not.toHaveBeenCalled();
    },
  );

  it("retains the reservation on a 409 or ambiguous transport failure", async () => {
    const remote = depositRemote("requested");
    remote.submit.mockRejectedValueOnce(
      new Error("deposit request failed (409)"),
    );

    await expect(executeGuiLocalWalletPayment(input(remote))).resolves.toEqual({
      status: "transport-ambiguous",
      depositId: DEPOSIT_ID,
      error: "deposit request failed (409)",
    });

    expect(deferRetryUnderLock).toHaveBeenCalledWith(walletLock, DEPOSIT_ID, {
      error: expect.any(Error),
    });
    expect(completeCreditedUnderLock).not.toHaveBeenCalled();
  });

  it("resumes an exact persisted split without supplying fresh proof authority", async () => {
    durablePayment = preparedRow();
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([preparedRow()]));
    getProofOperation.mockResolvedValueOnce({ state: "mint-submitted" });
    const remote = depositRemote("requested");
    remote.getStatus.mockResolvedValueOnce(null);

    await reconcileGuiEcashDeposits(remote);

    expect(splitRegularProofsWithOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: `ecash-deposit-split:${DEPOSIT_ID}`,
        proofs: [],
        resumeInputAuthority: "persisted-operation",
      }),
    );
    expect(createCapturedGuiWalletProofOperationStore).toHaveBeenCalledWith(
      WALLET_A,
    );
    expect(remote.submit).toHaveBeenCalledWith(
      expect.objectContaining({ depositId: DEPOSIT_ID, token: "cashuBtoken" }),
    );
  });

  it("preserves recovery cursor and has-more authority for the caller", async () => {
    const cursor = {
      eligibleBefore: 10,
      nextAttemptAt: 1,
      createdAt: 1,
      depositId: DEPOSIT_ID,
    };
    listPendingUnderLock.mockResolvedValueOnce({
      records: [],
      hasMore: true,
      nextCursor: cursor,
    });

    await expect(
      reconcileGuiEcashDeposits(depositRemote("requested"), cursor),
    ).resolves.toEqual({
      remaining: [],
      hasMore: true,
      nextCursor: cursor,
      nextAttemptAt: null,
      blocked: [],
    });
    expect(listPendingUnderLock).toHaveBeenCalledWith(walletLock, cursor);
  });

  it("continues a durable pre-intent that crashed before split preparation", async () => {
    durablePayment = preparedRow();
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([preparedRow()]));
    const remote = depositRemote("requested");
    remote.getStatus.mockResolvedValueOnce(null);

    await reconcileGuiEcashDeposits(remote);

    expect(splitRegularProofsWithOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: `ecash-deposit-split:${DEPOSIT_ID}`,
        proofs: [expect.objectContaining({ secret: "input" })],
      }),
    );
    expect(
      splitRegularProofsWithOperation.mock.calls[0]![0],
    ).not.toHaveProperty("resumeInputAuthority");
  });

  it("resumes deposit-owned splits through the unlocked recovery entry", async () => {
    durablePayment = preparedRow();
    getProofOperation.mockResolvedValueOnce({ state: "mint-submitted" });
    splitRegularProofsWithOperation.mockImplementationOnce(async () => {
      expect(competingWalletLockAvailable()).toBe(true);
      return {
        spent: [proof("input", 150)],
        send: [proof("send", 100)],
        keep: [proof("keep", 50)],
      };
    });

    await recoverGuiEcashDepositSplit(
      WALLET_A,
      `ecash-deposit-split:${DEPOSIT_ID}`,
    );

    expect(splitRegularProofsWithOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        proofs: [],
        resumeInputAuthority: "persisted-operation",
      }),
    );
    expect(recordSplitUnderLock).toHaveBeenCalledOnce();
  });

  it.each([null, "requested", "paid", "failed"] as const)(
    "retries the exact POST after bounded reconciliation observes %s",
    async (state) => {
      listPendingUnderLock.mockResolvedValueOnce(recoveryPage([reservedRow()]));
      const remote = depositRemote("requested");
      remote.getStatus.mockResolvedValueOnce(
        state === null ? null : depositStatus(state),
      );

      await reconcileGuiEcashDeposits(remote);

      expect(remote.submit).toHaveBeenCalledWith(
        expect.objectContaining({
          depositId: DEPOSIT_ID,
          token: "cashuBtoken",
        }),
      );
      expect(completeCreditedUnderLock).not.toHaveBeenCalled();
    },
  );

  it("deletes reserved proofs only after GET or POST proves credited", async () => {
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([reservedRow()]));
    const remote = depositRemote("requested");
    remote.getStatus.mockResolvedValueOnce(depositStatus("credited"));

    await reconcileGuiEcashDeposits(remote);

    expect(remote.submit).not.toHaveBeenCalled();
    expect(completeCreditedUnderLock).toHaveBeenCalledWith(
      walletLock,
      DEPOSIT_ID,
    );
  });

  it("requires an exact GET confirmation before deleting after a credited POST", async () => {
    const remote = depositRemote("credited");
    remote.getStatus.mockResolvedValueOnce(depositStatus("requested"));

    const result = await executeGuiLocalWalletPayment(input(remote));

    expect(result).toMatchObject({ status: "transport-ambiguous" });
    expect(completeCreditedUnderLock).not.toHaveBeenCalled();
    expect(deferRetryUnderLock).toHaveBeenCalledWith(walletLock, DEPOSIT_ID, {
      error: expect.any(Error),
    });
  });

  it("rejects a conflicting POST deposit id without deleting proofs", async () => {
    const remote = depositRemote("credited");
    remote.submit.mockResolvedValueOnce({
      depositId: "00000000-0000-4000-8000-000000000002",
      state: "credited",
    });

    const result = await executeGuiLocalWalletPayment(input(remote));

    expect(result).toMatchObject({ status: "transport-ambiguous" });
    expect(remote.getStatus).not.toHaveBeenCalled();
    expect(completeCreditedUnderLock).not.toHaveBeenCalled();
  });

  it("rejects an unknown POST state without deleting proofs", async () => {
    const remote = depositRemote("requested");
    remote.submit.mockResolvedValueOnce({
      depositId: DEPOSIT_ID,
      state: "accepted",
    });

    const result = await executeGuiLocalWalletPayment(input(remote));

    expect(result).toMatchObject({ status: "transport-ambiguous" });
    expect(completeCreditedUnderLock).not.toHaveBeenCalled();
  });

  it("accepts credited GET authority only when its immutable binding is exact", async () => {
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([reservedRow()]));
    const remote = depositRemote("requested");
    remote.getStatus.mockResolvedValueOnce(depositStatus("credited") as never);

    await reconcileGuiEcashDeposits(remote);

    expect(remote.submit).not.toHaveBeenCalled();
    expect(completeCreditedUnderLock).toHaveBeenCalledWith(
      walletLock,
      DEPOSIT_ID,
    );
  });

  it("rejects a credited GET response with a conflicting immutable binding", async () => {
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([reservedRow()]));
    const remote = depositRemote("requested");
    remote.getStatus.mockResolvedValueOnce({
      ...depositStatus("credited"),
      amountSubunits: 101,
    } as never);

    const remaining = await reconcileGuiEcashDeposits(remote);

    expect(remaining.remaining).toHaveLength(1);
    expect(remote.submit).not.toHaveBeenCalled();
    expect(completeCreditedUnderLock).not.toHaveBeenCalled();
    expect(deferRetryUnderLock).toHaveBeenCalledWith(walletLock, DEPOSIT_ID, {
      error: expect.any(Error),
    });
  });

  it("can observe and finish exact credited cleanup without the original signer", async () => {
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([reservedRow()]));
    const remote = depositRemote("requested");
    remote.currentFundingIdentity.mockImplementation(() => {
      throw new Error("signer unavailable");
    });
    remote.getStatus.mockResolvedValueOnce(depositStatus("credited") as never);

    await reconcileGuiEcashDeposits(remote);

    expect(remote.getStatus).toHaveBeenCalledOnce();
    expect(remote.submit).not.toHaveBeenCalled();
    expect(completeCreditedUnderLock).toHaveBeenCalledWith(
      walletLock,
      DEPOSIT_ID,
    );
  });

  it("fences the exact POST after an unauthenticated nonterminal GET", async () => {
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([reservedRow()]));
    const remote = depositRemote("requested");
    remote.currentFundingIdentity.mockReturnValue("other-funder");
    remote.getStatus.mockResolvedValueOnce(depositStatus("requested") as never);

    const remaining = await reconcileGuiEcashDeposits(remote);

    expect(remaining.remaining).toHaveLength(1);
    expect(remote.getStatus).toHaveBeenCalledOnce();
    expect(remote.submit).not.toHaveBeenCalled();
  });

  it("observes one pinned deposit and commits credited cleanup without a submitter", async () => {
    const getStatus = vi.fn().mockResolvedValue(depositStatus("credited"));

    await expect(
      observeGuiEcashDeposit(DEPOSIT_ID, { getStatus }),
    ).resolves.toEqual({ status: "completed", depositId: DEPOSIT_ID });

    expect(getPendingUnderLock).toHaveBeenCalledWith(walletLock, DEPOSIT_ID);
    expect(completeCreditedUnderLock).toHaveBeenCalledWith(
      walletLock,
      DEPOSIT_ID,
    );
  });

  it("retries one pinned deposit instead of opening fresh proof authority", async () => {
    const remote = depositRemote("credited");
    remote.getStatus.mockResolvedValueOnce(depositStatus("failed"));

    await expect(retryGuiEcashDeposit(DEPOSIT_ID, remote)).resolves.toEqual({
      status: "completed",
      depositId: DEPOSIT_ID,
    });

    expect(createPreIntentUnderLock).not.toHaveBeenCalled();
    expect(getBoundedUnitProofsForAmountUnderLock).not.toHaveBeenCalled();
    expect(remote.submit).toHaveBeenCalledWith(
      expect.objectContaining({ depositId: DEPOSIT_ID, token: "cashuBtoken" }),
    );
  });

  it("replays the exact persisted token bytes after the encoder changes", async () => {
    encodeToken
      .mockReturnValueOnce("cashuBoriginal-token")
      .mockReturnValue("cashuBdrifted-token");
    const initialRemote = depositRemote("requested");
    await executeGuiLocalWalletPayment(input(initialRemote));

    initialRemote.submit.mockClear();
    const retryRemote = depositRemote("requested");
    retryRemote.getStatus.mockResolvedValueOnce(null);
    await retryGuiEcashDeposit(DEPOSIT_ID, retryRemote);

    expect(retryRemote.submit).toHaveBeenCalledWith(
      expect.objectContaining({ token: "cashuBoriginal-token" }),
    );
    expect(encodeToken).toHaveBeenCalledOnce();
  });

  it("blocks corrupt reserved authority before any remote GET or POST", async () => {
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([reservedRow()]));
    requireRemoteAuthorityUnderLock.mockRejectedValueOnce(
      Object.assign(new Error("canonical split is missing"), {
        name: "PendingEcashDepositAuthorityError",
      }),
    );
    const remote = depositRemote("requested");

    const result = await reconcileGuiEcashDeposits(remote);

    expect(remote.getStatus).not.toHaveBeenCalled();
    expect(remote.submit).not.toHaveBeenCalled();
    expect(blockPendingUnderLock).toHaveBeenCalledWith(
      walletLock,
      DEPOSIT_ID,
      expect.any(Error),
    );
    expect(result.blocked).toEqual([
      expect.objectContaining({ depositId: DEPOSIT_ID }),
    ]);
  });

  it("backs off a retryable split failure and continues the recovery page", async () => {
    const laterDepositId = "00000000-0000-4000-8000-000000000002";
    const first = preparedRow();
    const later = reservedRow(laterDepositId);
    const rows = new Map<
      string,
      ReturnType<typeof preparedRow> | ReturnType<typeof reservedRow>
    >([
      [first.depositId, first],
      [later.depositId, later],
    ]);
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([first, later]));
    getPendingUnderLock.mockImplementation(async (_lock, depositId) =>
      rows.get(depositId),
    );
    requireRemoteAuthorityUnderLock.mockImplementation(
      async (_lock, expected) => rows.get(expected.depositId),
    );
    splitRegularProofsWithOperation.mockRejectedValueOnce(
      new Error("mint recovery unavailable"),
    );
    const remote = depositRemote("requested", laterDepositId);
    remote.getStatus.mockResolvedValueOnce(null);

    const result = await reconcileGuiEcashDeposits(remote);

    expect(deferRetryUnderLock).toHaveBeenCalledWith(walletLock, DEPOSIT_ID, {
      error: expect.any(Error),
    });
    expect(remote.submit).toHaveBeenCalledWith(
      expect.objectContaining({ depositId: laterDepositId }),
    );
    expect(result.remaining.map(({ depositId }) => depositId)).toContain(
      DEPOSIT_ID,
    );
  });

  it("does not submit a deposit under a different authenticated identity", async () => {
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([reservedRow()]));
    const remote = depositRemote("requested");
    remote.currentFundingIdentity.mockReturnValue("other-funder");
    remote.getStatus.mockResolvedValueOnce(depositStatus("requested"));

    const remaining = await reconcileGuiEcashDeposits(remote);

    expect(remaining.remaining).toHaveLength(1);
    expect(remote.getStatus).toHaveBeenCalledOnce();
    expect(remote.submit).not.toHaveBeenCalled();
    expect(deferRetryUnderLock).toHaveBeenCalledWith(walletLock, DEPOSIT_ID, {
      error: expect.any(Error),
    });
  });

  it("releases the wallet Web Lock around exact remote GET and POST calls", async () => {
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([reservedRow()]));
    const remote = depositRemote("requested");
    remote.getStatus.mockImplementationOnce(async () => {
      expect(walletLockDepth).toBe(0);
      return null;
    });
    remote.submit.mockImplementationOnce(async () => {
      expect(walletLockDepth).toBe(0);
      return { depositId: DEPOSIT_ID, state: "requested" };
    });

    await reconcileGuiEcashDeposits(remote);

    expect(remote.getStatus).toHaveBeenCalledOnce();
    expect(remote.submit).toHaveBeenCalledOnce();
  });

  it("allows a competing same-wallet lock during wallet and mint split I/O", async () => {
    getWalletForUnit.mockImplementationOnce(async () => {
      expect(competingWalletLockAvailable()).toBe(true);
      return { kind: "cashu-wallet" };
    });
    splitRegularProofsWithOperation.mockImplementationOnce(async () => {
      expect(competingWalletLockAvailable()).toBe(true);
      return {
        spent: [proof("input", 150)],
        send: [proof("send", 100)],
        keep: [proof("keep", 50)],
      };
    });

    await executeGuiLocalWalletPayment(input(depositRemote("credited")));

    expect(getWalletForUnit).toHaveBeenCalledOnce();
    expect(splitRegularProofsWithOperation).toHaveBeenCalledOnce();
  });

  it("does not dispatch a split or write another wallet after the seed changes during wallet I/O", async () => {
    getWalletForUnit.mockImplementationOnce(async () => {
      expect(competingWalletLockAvailable()).toBe(true);
      activeWalletId = WALLET_B;
      return { kind: "cashu-wallet" };
    });

    await expect(
      executeGuiLocalWalletPayment(input(depositRemote("credited"))),
    ).rejects.toThrow("wallet seed changed");

    expect(splitRegularProofsWithOperation).not.toHaveBeenCalled();
    expect(recordSplitUnderLock).not.toHaveBeenCalled();
    expect(createCapturedGuiWalletProofOperationStore).toHaveBeenCalledWith(
      WALLET_A,
    );
  });

  it("fences NUT-07 on both sides so a seed switch cannot start restore", async () => {
    durablePayment = preparedRow();
    getProofOperation.mockResolvedValueOnce({ state: "mint-submitted" });
    getWalletForUnit.mockResolvedValueOnce({
      checkProofsStates: async () => {
        activeWalletId = WALLET_B;
        return [{ state: "SPENT" }];
      },
    });
    splitRegularProofsWithOperation.mockImplementationOnce(async (options) => {
      await options.wallet.checkProofsStates([]);
      await options.restoreOutputGroups("https://mint.example", {
        send: [],
        keep: [],
      });
      throw new Error("unreachable");
    });

    await expect(
      recoverGuiEcashDepositSplit(
        WALLET_A,
        `ecash-deposit-split:${DEPOSIT_ID}`,
      ),
    ).rejects.toThrow("wallet seed changed");

    expect(restoreOutputGroups).not.toHaveBeenCalled();
    expect(recordSplitUnderLock).not.toHaveBeenCalled();
  });

  it("fails closed when the wallet seed changes during remote I/O", async () => {
    listPendingUnderLock.mockResolvedValueOnce(recoveryPage([reservedRow()]));
    const remote = depositRemote("requested");
    remote.getStatus.mockImplementationOnce(async () => {
      activeWalletId = WALLET_B;
      return depositStatus("credited");
    });

    await expect(reconcileGuiEcashDeposits(remote)).rejects.toThrow(
      "wallet seed changed",
    );
    expect(completeCreditedUnderLock).not.toHaveBeenCalled();
  });

  it("surfaces retry persistence failure instead of returning ambiguity", async () => {
    const remote = depositRemote("requested");
    remote.submit.mockRejectedValueOnce(new Error("response lost"));
    deferRetryUnderLock.mockRejectedValueOnce(
      new DOMException("quota exhausted", "QuotaExceededError"),
    );

    await expect(executeGuiLocalWalletPayment(input(remote))).rejects.toThrow(
      "quota exhausted",
    );
  });

  it("surfaces credited cleanup persistence failure", async () => {
    completeCreditedUnderLock.mockRejectedValueOnce(
      new DOMException("quota exhausted", "QuotaExceededError"),
    );

    await expect(
      executeGuiLocalWalletPayment(input(depositRemote("credited"))),
    ).rejects.toThrow("quota exhausted");
    expect(deferRetryUnderLock).not.toHaveBeenCalled();
  });

  it("re-reads and rejects changed durable authority before remote I/O", async () => {
    getPendingUnderLock
      .mockResolvedValueOnce(reservedRow())
      .mockResolvedValueOnce({
        ...reservedRow(),
        request: { ...reservedRow().request, amountSubunits: 101 },
      });
    const remote = depositRemote("requested");

    await expect(retryGuiEcashDeposit(DEPOSIT_ID, remote)).rejects.toThrow(
      "durable authority changed",
    );
    expect(remote.getStatus).not.toHaveBeenCalled();
    expect(remote.submit).not.toHaveBeenCalled();
  });
});

function input(remote: GuiEcashDepositRemote) {
  return {
    mintUrl: "https://mint.example",
    amountSubunits: 100,
    baseAsset: "sat",
    unit: "sat" as const,
    request: {
      conditionId: "condition-a",
      divisibility: 10_000,
      fundAmm: true,
      creatorPubkey: "funder-a",
      fundingIdentity: "funder-a",
    },
    remote,
  };
}

function depositRemote(
  result: "requested" | "paid" | "credited" | "failed",
  depositId = DEPOSIT_ID,
) {
  const currentFundingIdentity = vi.fn<() => string>(() => "funder-a");
  const getStatus =
    vi.fn<
      (
        input: GuiEcashDepositStatusRequest,
      ) => Promise<GuiEcashDepositStatusSnapshot | null>
    >();
  const submit = vi
    .fn<
      (input: GuiEcashDepositSubmission) => Promise<{
        depositId: string;
        state: string;
      }>
    >()
    .mockResolvedValue({ depositId, state: result });
  if (result === "credited") {
    getStatus.mockResolvedValue(depositStatus("credited"));
  }
  return {
    currentFundingIdentity,
    getStatus,
    submit,
  } satisfies GuiEcashDepositRemote;
}

function preparedRow(depositId = DEPOSIT_ID) {
  return {
    walletId: WALLET_A,
    depositId,
    splitOperationId: `ecash-deposit-split:${depositId}`,
    phase: "prepared" as const,
    request: {
      conditionId: "condition-a",
      mintUrl: "https://mint.example",
      amountSubunits: 100,
      baseAsset: "sat",
      unit: "sat" as const,
      divisibility: 10_000,
      fundAmm: true,
      creatorPubkey: "funder-a",
      fundingIdentity: "funder-a",
    },
    remoteState: null,
    createdAt: 1,
    updatedAt: 1,
    retryCount: 0,
    nextAttemptAt: 1,
    lastError: null,
    recoveryState: "active" as const,
  };
}

function reservedRow(depositId = DEPOSIT_ID) {
  return {
    ...preparedRow(depositId),
    phase: "reserved" as const,
    sendProofs: [proof("send", 100)],
    serializedToken: serializedToken("cashuBtoken"),
  };
}

function recoveryPage(
  records: Array<
    ReturnType<typeof preparedRow> | ReturnType<typeof reservedRow>
  >,
  hasMore = false,
) {
  const last = records.at(-1);
  return {
    records,
    hasMore,
    nextCursor:
      hasMore && last
        ? {
            eligibleBefore: 10,
            nextAttemptAt: last.nextAttemptAt,
            createdAt: last.createdAt,
            depositId: last.depositId,
          }
        : null,
  };
}

function depositStatus(state: GuiEcashDepositState) {
  return {
    depositId: DEPOSIT_ID,
    conditionId: "condition-a",
    amountSubunits: 100,
    method: "ecash",
    state,
  };
}

function proof(secret: string, amount: number) {
  return {
    id: "keyset-sat",
    amount,
    secret,
    C: `C-${secret}`,
    mintUrl: "https://mint.example",
    baseAsset: "sat",
    unit: "sat",
  };
}

function serializedToken(token: string) {
  return {
    schemaVersion: 1 as const,
    encoding: "utf-8" as const,
    bytes: new TextEncoder().encode(token),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function competingWalletLockAvailable(): boolean {
  return walletLockDepth === 0;
}
