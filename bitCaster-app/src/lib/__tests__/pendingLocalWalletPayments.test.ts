import "fake-indexeddb/auto";
import {
  Amount,
  getEncodedTokenV4,
  Mint as CashuMint,
  type Proof,
} from "@cashu/cashu-ts";
import {
  addDurableWalletProofTransitionMetadata,
  createDurableWalletProofTransition,
} from "@bitcaster/client-sdk/durableWalletProofTransition";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blockPendingEcashDepositUnderLock,
  completeCreditedEcashDepositUnderLock,
  createPendingEcashDepositUnderLock,
  deferPendingEcashDepositRetryUnderLock,
  getPendingEcashDepositRecoverySummaryUnderLock,
  listPendingEcashDepositsUnderLock,
  PENDING_ECASH_DEPOSIT_RECOVERY_LIMIT,
  recordPendingEcashDepositErrorUnderLock,
  recordPendingEcashDepositRemoteStateUnderLock,
  recordPendingEcashDepositSplitUnderLock,
  requirePendingEcashDepositRemoteAuthorityUnderLock,
} from "../pendingLocalWalletPayments";
import { withGuiCustodyProfileLock } from "@/stores/gui-custody-authority";
import type { GuiWalletLockContext } from "@/stores/gui-wallet-lock";
import {
  configureGuiWalletIdProvider,
  db,
  prepareStoredProofForWrite,
  proofOperationPrimaryKey,
} from "@/stores/proof-db";
import { createCapturedGuiWalletProofOperationStore } from "@/stores/gui-wallet-proof-operation-store";
import {
  PendingEcashDepositAuthorityError,
  serializePendingEcashDepositToken,
} from "@/stores/pending-local-wallet-payment-model";

const WALLET_A = "aa".repeat(32);
const WALLET_B = "bb".repeat(32);
const KEYSET_ID = `00${"22".repeat(7)}`;
const PUBLIC_KEY = `02${"33".repeat(32)}`;
const DEPOSIT_ID = "00000000-0000-4000-8000-000000000001";
const SPLIT_OPERATION_ID = `ecash-deposit-split:${DEPOSIT_ID}`;
const ORIGINAL_LOCKS = Object.getOwnPropertyDescriptor(navigator, "locks");

describe("pending GUI ecash deposit custody", () => {
  let activeWalletId = WALLET_A;

  beforeEach(async () => {
    activeWalletId = WALLET_A;
    configureGuiWalletIdProvider(() => activeWalletId);
    vi.spyOn(CashuMint.prototype, "getKeys").mockResolvedValue({
      keysets: [{ id: KEYSET_ID, unit: "sat", keys: { "1": PUBLIC_KEY } }],
    });
    installWebLocks();
    db.close();
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreWebLocks();
    db.close();
    await db.delete();
  });

  it("persists a strict exact pre-intent before any split operation exists", async () => {
    const row = await withLock((lock) =>
      createPendingEcashDepositUnderLock(lock, prepared()),
    );

    expect(row).toMatchObject({
      walletId: WALLET_A,
      depositId: DEPOSIT_ID,
      splitOperationId: SPLIT_OPERATION_ID,
      phase: "prepared",
      request: {
        conditionId: "condition-a",
        amountSubunits: 100,
        fundingIdentity: "funder-a",
      },
    });
    expect(
      await db.proofOperations.get(
        proofOperationPrimaryKey(WALLET_A, SPLIT_OPERATION_ID),
      ),
    ).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("cashuB");
  });

  it.each(["bitcoin", "SAT", "msat"])(
    "rejects a persisted row with non-canonical base asset %s",
    async (baseAsset) => {
      const row = await withLock((lock) =>
        createPendingEcashDepositUnderLock(lock, prepared()),
      );
      await db.pendingLocalWalletPayments.put({
        ...row,
        request: { ...row.request, baseAsset },
      } as never);

      await expect(withLock(listPendingEcashDepositsUnderLock)).rejects.toThrow(
        "base asset is invalid",
      );
    },
  );

  it("rejects a persisted row missing a required field", async () => {
    const row = await withLock((lock) =>
      createPendingEcashDepositUnderLock(lock, prepared()),
    );
    const malformed = { ...row } as Partial<typeof row>;
    delete malformed.lastError;
    await db.pendingLocalWalletPayments.put(malformed as never);

    await expect(withLock(listPendingEcashDepositsUnderLock)).rejects.toThrow(
      /invalid/i,
    );
  });

  it("rejects a persisted row with a present-but-undefined last error", async () => {
    const row = await withLock((lock) =>
      createPendingEcashDepositUnderLock(lock, prepared()),
    );
    await db.pendingLocalWalletPayments.put({
      ...row,
      lastError: undefined,
    } as never);

    await expect(withLock(listPendingEcashDepositsUnderLock)).rejects.toThrow(
      /error is invalid/i,
    );
  });

  it("rejects a conflicting replay of the same deposit id", async () => {
    await withLock((lock) =>
      createPendingEcashDepositUnderLock(lock, prepared()),
    );

    await expect(
      withLock((lock) =>
        createPendingEcashDepositUnderLock(lock, {
          ...prepared(),
          request: { ...prepared().request, amountSubunits: 101 },
        }),
      ),
    ).rejects.toThrow(/conflicts/);
  });

  it("enforces one split-operation authority per wallet in the database", async () => {
    const first = await withLock((lock) =>
      createPendingEcashDepositUnderLock(lock, prepared()),
    );
    const secondDepositId = depositIdFor(2);

    await expect(
      db.pendingLocalWalletPayments.put({
        ...first,
        depositId: secondDepositId,
      }),
    ).rejects.toThrow();
    const index = db.pendingLocalWalletPayments.schema.indexes.find(
      ({ name }) => name === "[walletId+splitOperationId]",
    );
    expect(index?.unique).toBe(true);
  });

  it("keeps a fixed eligibility bound while attempted rows enter persisted backoff", async () => {
    const count = PENDING_ECASH_DEPOSIT_RECOVERY_LIMIT + 2;
    await withLock(async (lock) => {
      for (let index = 1; index <= count; index += 1) {
        await createPendingEcashDepositUnderLock(lock, preparedFor(index));
      }
    });

    const first = await withLock((lock) =>
      listPendingEcashDepositsUnderLock(lock, null, 100),
    );
    expect(
      db.pendingLocalWalletPayments.schema.indexes.map(({ name }) => name),
    ).toContain("[walletId+nextAttemptAt+createdAt+depositId]");
    expect(first.records).toHaveLength(PENDING_ECASH_DEPOSIT_RECOVERY_LIMIT);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    await withLock(async (lock) => {
      for (const row of first.records) {
        await deferPendingEcashDepositRetryUnderLock(
          lock,
          row.depositId,
          { error: new Error("retry later") },
          100,
        );
      }
    });
    const second = await withLock((lock) =>
      listPendingEcashDepositsUnderLock(lock, first.nextCursor),
    );
    expect(second.records.map(({ depositId }) => depositId)).toEqual([
      depositIdFor(count - 1),
      depositIdFor(count),
    ]);
    expect(second.hasMore).toBe(false);

    const sameCycle = await withLock((lock) =>
      listPendingEcashDepositsUnderLock(lock, null, 100),
    );
    expect(sameCycle.records.map(({ depositId }) => depositId)).toEqual([
      depositIdFor(count - 1),
      depositIdFor(count),
    ]);
    expect(
      await db.pendingLocalWalletPayments.get([WALLET_A, depositIdFor(1)]),
    ).toMatchObject({
      retryCount: 1,
      nextAttemptAt: 1_100,
      lastError: "retry later",
    });
  });

  it("recovers the crash boundary after split completion and preserves exact reservation", async () => {
    await withLock((lock) =>
      createPendingEcashDepositUnderLock(lock, prepared()),
    );
    await putCompletedSplit({ reserveSend: true });

    const row = await withLock((lock) =>
      recordPendingEcashDepositSplitUnderLock(
        lock,
        DEPOSIT_ID,
        [proof("send", 100)],
        token(),
      ),
    );

    expect(row).toMatchObject({ phase: "reserved" });
    expect(await db.proofs.get(proofKey("send", 100))).toMatchObject({
      reservedBy: DEPOSIT_ID,
    });
    expect(
      (await db.proofs.get(proofKey("keep", 50)))?.reservedBy,
    ).toBeUndefined();
    expect(row.serializedToken).toEqual(token());

    await expect(
      withLock((lock) =>
        recordPendingEcashDepositSplitUnderLock(
          lock,
          DEPOSIT_ID,
          [proof("send", 100)],
          token([proof("different-send", 100)]),
        ),
      ),
    ).rejects.toThrow(/serialized token does not match its proofs/);
  });

  it.each([
    {
      name: "mint",
      artifact: () => tokenFor({ mint: "https://other-mint.example" }),
    },
    { name: "unit", artifact: () => tokenFor({ unit: "usd" }) },
    {
      name: "optional proof fields",
      artifact: () =>
        tokenFor({
          proofs: [
            {
              ...proof("send", 100),
              dleq: {
                e: "11".repeat(32),
                s: "22".repeat(32),
                r: "33".repeat(32),
              },
            },
          ],
        }),
    },
  ])(
    "rejects a serialized token with conflicting $name authority",
    async ({ artifact }) => {
      await withLock((lock) =>
        createPendingEcashDepositUnderLock(lock, prepared()),
      );
      await putCompletedSplit({ reserveSend: true });

      await expect(
        withLock((lock) =>
          recordPendingEcashDepositSplitUnderLock(
            lock,
            DEPOSIT_ID,
            [proof("send", 100)],
            artifact(),
          ),
        ),
      ).rejects.toThrow(/serialized token does not match its proofs/);
    },
  );

  it.each([
    {
      name: "missing native operation",
      mutate: async () => {
        await db.proofOperations.delete(
          proofOperationPrimaryKey(WALLET_A, SPLIT_OPERATION_ID),
        );
      },
    },
    {
      name: "non-completed native operation",
      mutate: async () => {
        const key = proofOperationPrimaryKey(WALLET_A, SPLIT_OPERATION_ID);
        const row = await db.proofOperations.get(key);
        await db.proofOperations.put({ ...row!, state: "mint-submitted" });
      },
    },
    {
      name: "changed native result",
      mutate: async () => {
        const key = proofOperationPrimaryKey(WALLET_A, SPLIT_OPERATION_ID);
        const row = await db.proofOperations.get(key);
        await db.proofOperations.put({
          ...row!,
          resultProofs: {
            ...row!.resultProofs!,
            send: [proof("changed-send", 100)],
          },
        });
      },
    },
    {
      name: "missing stored send proof",
      mutate: async () => {
        await db.proofs.delete(proofKey("send", 100));
      },
    },
    {
      name: "foreign send reservation",
      mutate: async () => {
        const row = await db.proofs.get(proofKey("send", 100));
        await db.proofs.put({ ...row!, reservedBy: "other-deposit" });
      },
    },
    {
      name: "missing canonical operation",
      mutate: async () => {
        const row = await db.proofOperations.get(
          proofOperationPrimaryKey(WALLET_A, SPLIT_OPERATION_ID),
        );
        await db.custodyOperations.delete(row!.custodyOperationId!);
      },
    },
  ])("fails remote authority closed for $name", async ({ mutate }) => {
    const expected = await prepareReservedDeposit();
    await mutate();

    await expect(
      withLock((lock) =>
        requirePendingEcashDepositRemoteAuthorityUnderLock(lock, expected),
      ),
    ).rejects.toBeInstanceOf(PendingEcashDepositAuthorityError);
  });

  it("durably blocks corrupt recovery without scheduling it again", async () => {
    await prepareReservedDeposit();

    await withLock((lock) =>
      blockPendingEcashDepositUnderLock(
        lock,
        DEPOSIT_ID,
        new PendingEcashDepositAuthorityError("canonical authority missing"),
      ),
    );

    expect(
      await withLock(getPendingEcashDepositRecoverySummaryUnderLock),
    ).toEqual({
      nextAttemptAt: null,
      blocked: [
        { depositId: DEPOSIT_ID, error: "canonical authority missing" },
      ],
    });
    expect((await withLock(listPendingEcashDepositsUnderLock)).records).toEqual(
      [],
    );
  });

  it("fails closed when a completed split did not reserve send proofs by deposit id", async () => {
    await withLock((lock) =>
      createPendingEcashDepositUnderLock(lock, prepared()),
    );
    await putCompletedSplit({ reserveSend: false });

    await expect(
      withLock((lock) =>
        recordPendingEcashDepositSplitUnderLock(
          lock,
          DEPOSIT_ID,
          [proof("send", 100)],
          token(),
        ),
      ),
    ).rejects.toThrow(/reservation plan/);

    expect(
      await db.pendingLocalWalletPayments.get([WALLET_A, DEPOSIT_ID]),
    ).toMatchObject({ phase: "prepared" });
  });

  it.each(["requested", "paid", "failed"] as const)(
    "retains reserved proofs when the remote lifecycle is %s",
    async (state) => {
      await prepareReservedDeposit();

      await withLock((lock) =>
        recordPendingEcashDepositRemoteStateUnderLock(lock, DEPOSIT_ID, state),
      );

      expect(await db.proofs.get(proofKey("send", 100))).toMatchObject({
        reservedBy: DEPOSIT_ID,
      });
      expect(
        await db.pendingLocalWalletPayments.get([WALLET_A, DEPOSIT_ID]),
      ).toMatchObject({ phase: "reserved", remoteState: state });
    },
  );

  it("atomically deletes only reserved send proofs after credited", async () => {
    await prepareReservedDeposit();

    await withLock((lock) =>
      completeCreditedEcashDepositUnderLock(lock, DEPOSIT_ID),
    );

    expect(await db.pendingLocalWalletPayments.count()).toBe(0);
    expect(await db.proofs.get(proofKey("send", 100))).toBeUndefined();
    expect(await db.proofs.get(proofKey("keep", 50))).toBeDefined();
  });

  it("bounds and redacts a transport error without releasing proof authority", async () => {
    await prepareReservedDeposit();

    await withLock((lock) =>
      recordPendingEcashDepositErrorUnderLock(
        lock,
        DEPOSIT_ID,
        new Error("502 echoed cashuBsecret-token"),
      ),
    );

    const row = await db.pendingLocalWalletPayments.get([WALLET_A, DEPOSIT_ID]);
    expect(row?.lastError).toBe("502 echoed [redacted ecash token]");
    expect(row?.lastError).not.toContain("cashuBsecret-token");
    expect(await db.proofs.get(proofKey("send", 100))).toMatchObject({
      reservedBy: DEPOSIT_ID,
    });
  });

  it("persists exponential retry state with a bounded maximum delay", async () => {
    await withLock((lock) =>
      createPendingEcashDepositUnderLock(lock, prepared()),
    );
    await withLock(async (lock) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await deferPendingEcashDepositRetryUnderLock(
          lock,
          DEPOSIT_ID,
          { error: new Error("retry later") },
          100,
        );
      }
    });

    expect(
      await db.pendingLocalWalletPayments.get([WALLET_A, DEPOSIT_ID]),
    ).toMatchObject({ retryCount: 16, nextAttemptAt: 60_100 });
  });

  it("keeps rows and credited authority isolated by wallet seed", async () => {
    await prepareReservedDeposit();
    activeWalletId = WALLET_B;

    await expect(
      withLock((lock) =>
        completeCreditedEcashDepositUnderLock(lock, DEPOSIT_ID),
      ),
    ).rejects.toThrow(/missing/);
    expect((await withLock(listPendingEcashDepositsUnderLock)).records).toEqual(
      [],
    );

    activeWalletId = WALLET_A;
    expect(
      (await withLock(listPendingEcashDepositsUnderLock)).records,
    ).toHaveLength(1);
    expect(await db.proofs.get(proofKey("send", 100))).toBeDefined();
  });

  async function prepareReservedDeposit() {
    await withLock((lock) =>
      createPendingEcashDepositUnderLock(lock, prepared()),
    );
    await putCompletedSplit({ reserveSend: true });
    return withLock((lock) =>
      recordPendingEcashDepositSplitUnderLock(
        lock,
        DEPOSIT_ID,
        [proof("send", 100)],
        token(),
      ),
    );
  }
});

function prepared() {
  return {
    depositId: DEPOSIT_ID,
    splitOperationId: SPLIT_OPERATION_ID,
    phase: "prepared" as const,
    request: {
      conditionId: "condition-a",
      mintUrl: "https://mint.example",
      amountSubunits: 100,
      baseAsset: "sat" as const,
      unit: "sat" as const,
      divisibility: 10_000,
      fundAmm: true,
      creatorPubkey: "funder-a",
      fundingIdentity: "funder-a",
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function preparedFor(index: number) {
  const depositId = depositIdFor(index);
  return {
    ...prepared(),
    depositId,
    splitOperationId: `ecash-deposit-split:${depositId}`,
  };
}

function depositIdFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function putCompletedSplit(options: {
  reserveSend: boolean;
}): Promise<void> {
  const policy = createDurableWalletProofTransition({
    inputSource: "wallet",
    plannedOutputLabels: ["send", "keep"],
    resultGroups: {
      send: {
        kind: "wallet",
        asset: "regular",
        reservedBy: options.reserveSend ? DEPOSIT_ID : null,
      },
      keep: { kind: "wallet", asset: "regular", reservedBy: null },
    },
  });
  await db.proofs.put(storedProof("spent", 150));
  const store = createCapturedGuiWalletProofOperationStore(WALLET_A);
  await store.prepareProofOperation({
    operationId: SPLIT_OPERATION_ID,
    kind: "regular-split",
    mintUrl: "https://mint.example",
    inputs: [proof("spent", 150)],
    outputs: {
      send: [output("send", 100)],
      keep: [output("keep", 50)],
    },
    metadata: addDurableWalletProofTransitionMetadata(
      { amount: 100, baseAsset: "sat", unit: "sat" },
      policy,
    ),
  });
  await store.markProofOperationMintSubmitted(SPLIT_OPERATION_ID);
  await store.markProofOperationCompleted(SPLIT_OPERATION_ID, {
    send: [proof("send", 100)],
    keep: [proof("keep", 50)],
  });
}

function output(label: string, amount: number) {
  return {
    blindedMessage: { amount, id: KEYSET_ID, B_: PUBLIC_KEY },
    blindingFactor: fixtureHex(`${label}-blinding-factor`),
    secret: fixtureSecret(label),
  };
}

function storedProof(secret: string, amount: number, reservedBy?: string) {
  return prepareStoredProofForWrite(
    {
      ...proof(secret, amount),
      mintUrl: "https://mint.example",
      baseAsset: "sat",
      unit: "sat" as const,
      ...(reservedBy ? { reservedBy } : {}),
    },
    1,
    WALLET_A,
  );
}

function proofKey(secret: string, amount: number): string {
  return storedProof(secret, amount).proofId;
}

function proof(secret: string, amount: number) {
  return {
    id: KEYSET_ID,
    amount: Amount.from(amount),
    secret: fixtureSecret(secret),
    C: PUBLIC_KEY,
  };
}

function fixtureSecret(label: string): string {
  return fixtureHex(`proof-${label}`);
}

function fixtureHex(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function token(proofs = [proof("send", 100)]) {
  return tokenFor({ proofs });
}

function tokenFor(input: { mint?: string; unit?: string; proofs?: Proof[] }) {
  return serializePendingEcashDepositToken(
    getEncodedTokenV4({
      mint: input.mint ?? "https://mint.example",
      unit: input.unit ?? "sat",
      proofs: input.proofs ?? [proof("send", 100)],
    }),
  );
}

async function withLock<T>(
  action: (lock: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  return withGuiCustodyProfileLock((_context, lock) => action(lock));
}

function installWebLocks(): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async <T>(
        _name: string,
        _options: LockOptions,
        callback: () => Promise<T>,
      ) => callback(),
    },
  });
}

function restoreWebLocks(): void {
  if (ORIGINAL_LOCKS) {
    Object.defineProperty(navigator, "locks", ORIGINAL_LOCKS);
    return;
  }
  delete (navigator as { locks?: LockManager }).locks;
}
