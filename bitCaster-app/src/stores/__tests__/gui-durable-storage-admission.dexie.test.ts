import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
  applyDurablePreTradeStorageAdmissionBatch,
  createDurablePreTradeStorageAdmissionBatchPlan,
  createDurablePreTradeStorageCapacityProfile,
  createDurablePreTradeStorageReservationPlan,
  type DurablePreTradeStorageCapacityProfile,
} from "@bitcaster/client-sdk/durableStorageAdmission";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import {
  commitGuiPreTradeStorageAdmissionInCurrentTransaction,
  guiDurableStorageAdmissionTables,
  initializeGuiDurableStorageAdmission,
  markGuiPreTradePubkeyAttemptInCurrentTransaction,
  releaseGuiDurableStorageHeadroomInCurrentTransaction,
  restoreGuiDurableStorageHeadroomInCurrentTransaction,
} from "../gui-durable-storage-admission-dexie";
import {
  decodeDurableStorageHeadroomRow,
  createGuiPreTradeStorageCapacityProfile,
  GUI_DURABLE_STORAGE_ACCOUNTING_LIMIT_BYTES,
  GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
  GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID,
} from "../gui-durable-storage-admission-model";
import {
  GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS,
  createGuiDurableStorageRowArtifact,
} from "../gui-durable-storage-artifacts";
import {
  withGuiOriginStorageAdmissionLock,
  type GuiOriginStorageAdmissionLockContext,
} from "../gui-origin-storage-admission-lock";
import { withGuiWalletLock } from "../gui-wallet-lock";
import { db, type SwapIntentRecord } from "../proof-db";
import type { PendingTradeRecord } from "../pendingTrades";

const WALLET_ID = "aa".repeat(32);
const FOREIGN_WALLET_ID = "bb".repeat(32);
const PUBLIC_KEY_ONE =
  "031b84c5567b126440995d3ed5aaba0565d71e1834604819ff9c17f5e9d5dd078f";

describe("GUI durable-storage Dexie admission", () => {
  const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

  beforeEach(async () => {
    installImmediateWebLocks();
    db.close();
    await db.delete();
    await db.open();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    restoreWebLocks(originalLocks);
    db.close();
    await db.delete();
  });

  it("creates and validates one random emergency-headroom authority", async () => {
    await withAdmissionLock(async (originLock) => {
      const first = await initializeGuiDurableStorageAdmission(originLock);
      const headroom = decodeDurableStorageHeadroomRow(
        await db.durableStorageHeadroom.get(
          GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID,
        ),
      );
      expect(first.revision).toBe(0);
      expect(first.accountingLimitBytes).toBe(
        GUI_DURABLE_STORAGE_ACCOUNTING_LIMIT_BYTES,
      );
      expect(await db.durableStorageAccounting.count()).toBe(1);
      expect(await db.durableStorageHeadroom.count()).toBe(1);
      expect(headroom.payload.some((value) => value !== 0)).toBe(true);
      expect(
        (await initializeGuiDurableStorageAdmission(originLock)).revision,
      ).toBe(0);
    });
  });

  it("fails closed for corrupt, unpaired, rogue, or unaccounted trade rows", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      const headroom = await db.durableStorageHeadroom.get(
        GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID,
      );
      if (!headroom) throw new Error("headroom fixture is missing");
      headroom.payload[0] ^= 1;
      await db.durableStorageHeadroom.put(headroom);
      await expect(
        initializeGuiDurableStorageAdmission(originLock),
      ).rejects.toThrow("headroom row is invalid");

      await db.durableStorageHeadroom.put({
        ...headroom,
        payload: new Uint8Array(headroom.payload),
        sha256: headroom.sha256,
      });
      await db.durableStorageAccounting.put({
        recordId: "rogue-accounting" as never,
        state: (await db.durableStorageAccounting.get(
          GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
        ))!.state,
      });
      await expect(
        initializeGuiDurableStorageAdmission(originLock),
      ).rejects.toThrow("singleton rows are corrupt");

      await db.durableStorageAccounting.clear();
      await db.durableStorageHeadroom.clear();
      await db.swapSessions.put({ tradeId: "unaccounted" } as never);
      await expect(
        initializeGuiDurableStorageAdmission(originLock),
      ).rejects.toThrow("cannot adopt existing custody");

      await db.swapSessions.clear();
      await db.proofOperations.put({
        walletId: WALLET_ID,
        operationId: "orphan-trade-operation",
        durableTradeId: "orphan-trade",
      } as never);
      await expect(
        initializeGuiDurableStorageAdmission(originLock),
      ).rejects.toThrow("cannot adopt existing custody");

      await db.proofOperations.clear();
      await db.custodyOperations.put({
        operationId: "orphan-canonical-trade-operation",
        scopeId: deriveDurableCustodyScopeId({
          scopeKind: "wallet",
          walletId: WALLET_ID,
        }),
        active: 1,
        bindingKind: "trade",
        record: {},
      } as never);
      await expect(
        initializeGuiDurableStorageAdmission(originLock),
      ).rejects.toThrow("cannot adopt existing custody");
    });
  });

  it("enforces the exact GUI limit, singleton cardinality, and full-span headroom", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      const accounting = await db.durableStorageAccounting.get(
        GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
      );
      const headroom = await db.durableStorageHeadroom.get(
        GUI_DURABLE_STORAGE_HEADROOM_RECORD_ID,
      );
      if (!accounting || !headroom)
        throw new Error("admission fixture is missing");

      await db.durableStorageAccounting.put({
        ...accounting,
        state: {
          ...accounting.state,
          accountingLimitBytes: accounting.state.accountingLimitBytes + 1,
        },
      });
      await expect(
        initializeGuiDurableStorageAdmission(originLock),
      ).rejects.toThrow("accounting limit is invalid");
      await db.durableStorageAccounting.put(accounting);

      await db.durableStorageHeadroom.put({
        ...headroom,
        recordId: "rogue-headroom" as never,
      });
      await expect(
        initializeGuiDurableStorageAdmission(originLock),
      ).rejects.toThrow("singleton rows are corrupt");
      await db.durableStorageHeadroom.delete("rogue-headroom");

      const backing = new ArrayBuffer(headroom.payload.byteLength + 1);
      const hidden = new Uint8Array(backing, 1, headroom.payload.byteLength);
      hidden.set(headroom.payload);
      await db.durableStorageHeadroom.put({ ...headroom, payload: hidden });
      await expect(
        initializeGuiDurableStorageAdmission(originLock),
      ).rejects.toThrow("headroom row is invalid");
    });
  });

  it("derives the fixed profile from enforced physical row maxima", () => {
    const profile = createGuiPreTradeStorageCapacityProfile();
    expect(profile.tradeIntent.bytes).toBe(
      GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.swapIntents,
    );
    expect(profile.session.bytes).toBe(
      GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.swapSessions,
    );
    expect(profile.exactOperations).toEqual({
      artifactCount: 8,
      bytes: 8 * GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.proofOperations,
    });
    expect(profile.proofReferences).toEqual({
      artifactCount: 256,
      bytes: 256 * GUI_DURABLE_STORAGE_ARTIFACT_BYTES_LIMITS.proofs,
    });
    expect(
      profile.totalBytes * 8 + DURABLE_STORAGE_EMERGENCY_HEADROOM_TARGET_BYTES,
    ).toBeLessThanOrEqual(GUI_DURABLE_STORAGE_ACCOUNTING_LIMIT_BYTES);
  });

  it("rejects a self-consistent persisted non-GUI capacity profile", async () => {
    await withAdmissionLock(async (originLock) => {
      const initial = await initializeGuiDurableStorageAdmission(originLock);
      const approved = createGuiPreTradeStorageCapacityProfile();
      const wrongProfile = createDurablePreTradeStorageCapacityProfile({
        profileId: "gui-pre-trade-foreign",
        tradeIntent: approved.tradeIntent,
        session: approved.session,
        exactOperations: approved.exactOperations,
        proofReferences: approved.proofReferences,
        privateMaterial: approved.privateMaterial,
        ciphers: approved.ciphers,
        transitionOverhead: approved.transitionOverhead,
      });
      const fixture = preTradeFixture(WALLET_ID, 1, {
        profile: wrongProfile,
      });
      const artifacts = [
        createGuiDurableStorageRowArtifact({
          table: "swapIntents",
          key: fixture.intents[0]!.tradeId,
          artifactRole: "trade-intent",
          row: fixture.intents[0],
        }),
        createGuiDurableStorageRowArtifact({
          table: "pendingTrades",
          key: [WALLET_ID, fixture.pendingTrade.orderId],
          artifactRole: "transaction-only-retained",
          row: fixture.pendingTrade,
        }),
      ];
      const corrupted = applyDurablePreTradeStorageAdmissionBatch({
        state: initial,
        batch: fixture.batch,
        artifacts,
      });
      await db.durableStorageAccounting.put({
        recordId: GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
        state: corrupted,
      });
      await expect(
        initializeGuiDurableStorageAdmission(originLock),
      ).rejects.toThrow("capacity profile is invalid");
    });
  });

  it("commits every fill intent and one accounting revision after an exact pending-row CAS", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      const fixture = preTradeFixture(WALLET_ID, 2);
      await db.pendingTrades.put(fixture.pendingTrade);
      const next = await commitFixture(originLock, fixture);

      expect(next.revision).toBe(1);
      expect(next.preTradeReservations).toHaveLength(2);
      expect(next.accountedBytes).toBe(
        fixture.batch.reservations.reduce(
          (total, reservation) => total + reservation.reservedBytes,
          0,
        ),
      );
      expect(await db.swapIntents.toArray()).toEqual(fixture.intents);
      expect(
        await db.pendingTrades.get([WALLET_ID, fixture.pendingTrade.orderId]),
      ).toEqual(fixture.pendingTrade);
    });
  });

  it("classifies an exact full-batch replay and rejects a physically partial replay", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      const fixture = preTradeFixture(WALLET_ID, 2);
      await db.pendingTrades.put(fixture.pendingTrade);
      const committed = await commitFixture(originLock, fixture);
      const replayed = await commitFixture(originLock, fixture);
      expect(replayed.revision).toBe(committed.revision);
      expect(await db.swapIntents.count()).toBe(2);

      await db.swapIntents.delete(fixture.intents[0]!.tradeId);
      await expect(commitFixture(originLock, fixture)).rejects.toThrow(
        "replay is physically partial",
      );
      expect(await db.swapIntents.count()).toBe(1);
      expect(
        (
          await db.durableStorageAccounting.get(
            GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
          )
        )?.state.revision,
      ).toBe(committed.revision);
    });
  });

  it("rejects an exact replay when the active wallet changes during physical validation", async () => {
    let currentWalletId = WALLET_ID;
    await withMutableAdmissionLock(
      () => currentWalletId,
      async (originLock) => {
        await initializeGuiDurableStorageAdmission(originLock);
        const fixture = preTradeFixture(WALLET_ID, 2);
        await db.pendingTrades.put(fixture.pendingTrade);
        await commitFixture(originLock, fixture);
        const getIntent = db.swapIntents.get.bind(db.swapIntents);
        let reads = 0;
        vi.spyOn(db.swapIntents, "get").mockImplementation((key) =>
          getIntent(key).then((value) => {
            reads += 1;
            if (reads === fixture.intents.length) {
              currentWalletId = FOREIGN_WALLET_ID;
            }
            return value;
          }),
        );

        await expect(commitFixture(originLock, fixture)).rejects.toThrow(
          "wallet ownership changed",
        );
        currentWalletId = WALLET_ID;
        expect(await db.swapIntents.toArray()).toEqual(fixture.intents);
      },
    );
  });

  it("marks the exact post-response pubkey state and replays it idempotently", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      const fixture = preTradeFixture(WALLET_ID, 1);
      await db.pendingTrades.put(fixture.pendingTrade);
      const admitted = await commitFixture(originLock, fixture);
      const prepared = fixture.intents[0]!;
      const attempted = { ...prepared, submitted: true, updatedAt: 2 };
      const marked = await markAttempt(originLock, prepared, attempted).catch(
        (error: unknown) => {
          throw new Error("first pubkey-attempt commit failed", {
            cause: error,
          });
        },
      );
      expect(marked.revision).toBe(admitted.revision + 1);
      expect(marked.preTradeReservations[0]!.stage).toBe("pubkey-attempted");
      expect(await db.swapIntents.get(prepared.tradeId)).toEqual(attempted);

      const replayed = await markAttempt(
        originLock,
        attempted,
        attempted,
      ).catch((error: unknown) => {
        throw new Error("pubkey-attempt replay failed", { cause: error });
      });
      expect(replayed.revision).toBe(marked.revision);
      expect(await db.swapIntents.get(prepared.tradeId)).toEqual(attempted);
    });
  });

  it("rolls back attempted-state writes and rejects stale or mutable transitions", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      const fixture = preTradeFixture(WALLET_ID, 1);
      await db.pendingTrades.put(fixture.pendingTrade);
      const admitted = await commitFixture(originLock, fixture);
      const prepared = fixture.intents[0]!;
      const attempted = { ...prepared, submitted: true, updatedAt: 2 };

      await expect(
        db.transaction("rw", transactionTables(), async () => {
          await markGuiPreTradePubkeyAttemptInCurrentTransaction({
            originLock,
            tradeId: prepared.tradeId,
            expectedIntent: prepared,
            nextIntent: attempted,
          });
          throw new DOMException(
            "injected quota failure",
            "QuotaExceededError",
          );
        }),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });
      expect(await db.swapIntents.get(prepared.tradeId)).toEqual(prepared);
      expect(
        (
          await db.durableStorageAccounting.get(
            GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
          )
        )?.state.revision,
      ).toBe(admitted.revision);

      await expect(
        markAttempt(originLock, { ...prepared, updatedAt: 0 }, attempted),
      ).rejects.toThrow("changed before pubkey attempt");
      await expect(
        markAttempt(originLock, prepared, {
          ...attempted,
          intent: {
            ...attempted.intent,
            orderId: "order-admission-002",
          },
        }),
      ).rejects.toThrow("transition is invalid");
      expect(await db.swapIntents.get(prepared.tradeId)).toEqual(prepared);
    });
  });

  it("rolls back all fill intents and accounting on a later quota fault", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      const fixture = preTradeFixture(WALLET_ID, 2);
      await db.pendingTrades.put(fixture.pendingTrade);
      await expect(
        commitFixture(originLock, fixture, () => {
          throw new DOMException(
            "injected quota failure",
            "QuotaExceededError",
          );
        }),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });
      expect(await db.swapIntents.count()).toBe(0);
      expect(
        (
          await db.durableStorageAccounting.get(
            GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
          )
        )?.state.revision,
      ).toBe(0);
    });
  });

  it("rolls back when the active wallet changes during a physical write", async () => {
    let currentWalletId = WALLET_ID;
    await withMutableAdmissionLock(
      () => currentWalletId,
      async (originLock) => {
        await initializeGuiDurableStorageAdmission(originLock);
        const fixture = preTradeFixture(WALLET_ID, 2);
        await db.pendingTrades.put(fixture.pendingTrade);
        const bulkPut = db.swapIntents.bulkPut.bind(db.swapIntents);
        vi.spyOn(db.swapIntents, "bulkPut").mockImplementation((rows) =>
          bulkPut(rows).then((result) => {
            currentWalletId = FOREIGN_WALLET_ID;
            return result;
          }),
        );
        await expect(commitFixture(originLock, fixture)).rejects.toThrow(
          "wallet ownership changed",
        );
        currentWalletId = WALLET_ID;
        expect(await db.swapIntents.count()).toBe(0);
        expect(
          (
            await db.durableStorageAccounting.get(
              GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
            )
          )?.state.revision,
        ).toBe(0);
      },
    );
  });

  it("rejects missing or changed CAS rows, foreign wallets, and calls outside a write transaction", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      const fixture = preTradeFixture(WALLET_ID, 1);
      await expect(commitFixture(originLock, fixture)).rejects.toThrow(
        "requires an existing pending trade",
      );

      await db.pendingTrades.put({
        ...fixture.pendingTrade,
        recoveryAttempt: 1,
      });
      await expect(commitFixture(originLock, fixture)).rejects.toThrow(
        "changed before pre-trade admission",
      );

      const foreign = preTradeFixture(FOREIGN_WALLET_ID, 1);
      await expect(commitFixture(originLock, foreign)).rejects.toThrow(
        "scope is foreign",
      );

      await expect(
        commitGuiPreTradeStorageAdmissionInCurrentTransaction({
          originLock,
          batch: fixture.batch,
          pendingTradeKey: [WALLET_ID, fixture.pendingTrade.orderId],
          expectedPendingTrade: fixture.pendingTrade,
          intents: fixture.intents,
        }),
      ).rejects.toThrow("active Dexie write transaction");
    });
  });

  it("rejects omitted, extra, substituted, pre-existing, and misbound physical rows", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      const fixture = preTradeFixture(WALLET_ID, 2);
      await db.pendingTrades.put(fixture.pendingTrade);
      await expect(
        commitFixtureRows(originLock, fixture, fixture.intents.slice(0, 1)),
      ).rejects.toThrow("intent count is invalid");
      await expect(
        commitFixtureRows(originLock, fixture, [
          ...fixture.intents,
          swapIntent(
            WALLET_ID,
            "trade-extra",
            fixture.pendingTrade.orderId,
            fixture.pendingTrade.marketId,
          ),
        ]),
      ).rejects.toThrow("intent count is invalid");

      const substituted = fixture.intents.map((intent, index) =>
        index === 0 ? { ...intent, updatedAt: intent.updatedAt + 1 } : intent,
      );
      await expect(
        commitFixtureRows(originLock, fixture, substituted),
      ).rejects.toThrow("do not match the committed plan");

      await db.swapIntents.put(substituted[0]!);
      await expect(commitFixture(originLock, fixture)).rejects.toThrow(
        "conflicts with existing authority",
      );
      expect(await db.swapIntents.toArray()).toEqual([substituted[0]]);
      await db.swapIntents.clear();

      const wrongIdentity = preTradeFixture(WALLET_ID, 1, {
        reservationDeadlineMs:
          Date.parse(fixture.intents[0]!.intent.deadline) + 1,
      });
      await expect(commitFixture(originLock, wrongIdentity)).rejects.toThrow(
        "reservation identity is invalid",
      );

      const approved = createGuiPreTradeStorageCapacityProfile();
      const wrongProfile = createDurablePreTradeStorageCapacityProfile({
        profileId: "gui-pre-trade-foreign",
        tradeIntent: approved.tradeIntent,
        session: approved.session,
        exactOperations: approved.exactOperations,
        proofReferences: approved.proofReferences,
        privateMaterial: approved.privateMaterial,
        ciphers: approved.ciphers,
        transitionOverhead: approved.transitionOverhead,
      });
      const wrongCapacity = preTradeFixture(WALLET_ID, 1, {
        profile: wrongProfile,
      });
      await expect(commitFixture(originLock, wrongCapacity)).rejects.toThrow(
        "capacity profile is invalid",
      );
      expect(await db.swapIntents.count()).toBe(0);
      expect(
        (
          await db.durableStorageAccounting.get(
            GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
          )
        )?.state.revision,
      ).toBe(0);
    });
  });

  it("releases and restores physical headroom with the accounting revision", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      await expect(
        db.transaction("rw", guiDurableStorageAdmissionTables(db), async () => {
          await releaseGuiDurableStorageHeadroomInCurrentTransaction(
            originLock,
          );
          throw new DOMException(
            "injected quota failure",
            "QuotaExceededError",
          );
        }),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });
      expect(await db.durableStorageHeadroom.count()).toBe(1);
      expect(
        (
          await db.durableStorageAccounting.get(
            GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
          )
        )?.state.revision,
      ).toBe(0);

      const released = await db.transaction(
        "rw",
        guiDurableStorageAdmissionTables(db),
        () => releaseGuiDurableStorageHeadroomInCurrentTransaction(originLock),
      );
      expect(released.revision).toBe(1);
      expect(await db.durableStorageHeadroom.count()).toBe(0);

      await expect(
        db.transaction("rw", guiDurableStorageAdmissionTables(db), async () => {
          await restoreGuiDurableStorageHeadroomInCurrentTransaction(
            originLock,
          );
          throw new DOMException(
            "injected quota failure",
            "QuotaExceededError",
          );
        }),
      ).rejects.toMatchObject({ name: "QuotaExceededError" });
      expect(await db.durableStorageHeadroom.count()).toBe(0);

      const restored = await db.transaction(
        "rw",
        guiDurableStorageAdmissionTables(db),
        () => restoreGuiDurableStorageHeadroomInCurrentTransaction(originLock),
      );
      expect(restored.revision).toBe(2);
      expect(await db.durableStorageHeadroom.count()).toBe(1);
    });
  });

  it("rolls back headroom release when the Dexie transaction zone is lost", async () => {
    await withAdmissionLock(async (originLock) => {
      await initializeGuiDurableStorageAdmission(originLock);
      const currentTransaction = Object.getOwnPropertyDescriptor(
        Dexie,
        "currentTransaction",
      )?.get;
      if (!currentTransaction) {
        throw new Error("Dexie current-transaction getter is unavailable");
      }
      let transactionLost = false;
      const transactionSpy = vi
        .spyOn(Dexie, "currentTransaction", "get")
        .mockImplementation(() =>
          transactionLost ? null : currentTransaction.call(Dexie),
        );
      const removeHeadroom = db.durableStorageHeadroom.delete.bind(
        db.durableStorageHeadroom,
      );
      vi.spyOn(db.durableStorageHeadroom, "delete").mockImplementation((key) =>
        removeHeadroom(key).then((result) => {
          transactionLost = true;
          return result;
        }),
      );

      try {
        await expect(
          db.transaction("rw", guiDurableStorageAdmissionTables(db), () =>
            releaseGuiDurableStorageHeadroomInCurrentTransaction(originLock),
          ),
        ).rejects.toThrow("active Dexie write transaction");
      } finally {
        transactionLost = false;
        transactionSpy.mockRestore();
      }

      expect(await db.durableStorageHeadroom.count()).toBe(1);
      expect(
        (
          await db.durableStorageAccounting.get(
            GUI_DURABLE_STORAGE_ACCOUNTING_RECORD_ID,
          )
        )?.state.revision,
      ).toBe(0);
    });
  });
});

function preTradeFixture(
  walletId: string,
  fillCount: number,
  options: {
    profile?: DurablePreTradeStorageCapacityProfile;
    reservationOrderId?: string;
    reservationMarketId?: string;
    reservationDeadlineMs?: number;
  } = {},
) {
  const orderId = "order-admission-001";
  const marketId = "condition-001-YES";
  const pendingTrade: PendingTradeRecord = {
    walletId,
    orderId,
    marketId,
    clientOrderId: "client-order-admission-001",
    submittedAt: 1,
    baseAsset: "sat",
    divisibility: 10_000,
    side: "Buy",
    tokenSide: "Outcome",
    priceSubunits: 5_000,
    amountSubunits: 10,
    timeInForce: "FAK",
    recoveryAttempt: 0,
  };
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId,
  });
  const profile = options.profile ?? createGuiPreTradeStorageCapacityProfile();
  const intents = Array.from({ length: fillCount }, (_, index) =>
    swapIntent(walletId, `trade-admission-${index + 1}`, orderId, marketId),
  );
  const reservations = intents.map((row) =>
    createDurablePreTradeStorageReservationPlan({
      scopeId,
      reservationId: `reservation-admission-${row.tradeId}`,
      swapId: row.tradeId,
      orderId: options.reservationOrderId ?? orderId,
      marketId: options.reservationMarketId ?? marketId,
      deadlineMs:
        options.reservationDeadlineMs ?? Date.parse(row.intent.deadline),
      intent: createGuiDurableStorageRowArtifact({
        table: "swapIntents",
        key: row.tradeId,
        artifactRole: "trade-intent",
        row,
      }),
      capacityProfile: profile,
    }),
  );
  const pendingArtifact = createGuiDurableStorageRowArtifact({
    table: "pendingTrades",
    key: [walletId, orderId],
    artifactRole: "transaction-only-retained",
    row: pendingTrade,
  });
  return {
    pendingTrade,
    intents,
    batch: createDurablePreTradeStorageAdmissionBatchPlan({
      batchId: `batch-admission-${walletId}`,
      reservations,
      transactionOnlyArtifacts: [pendingArtifact],
    }),
  };
}

function swapIntent(
  walletId: string,
  tradeId: string,
  orderId: string,
  marketId: string,
): SwapIntentRecord {
  return {
    walletId,
    tradeId,
    intent: {
      schemaVersion: 2,
      tradeId,
      orderId,
      marketId,
      localProtocolPubkey: PUBLIC_KEY_ONE,
      deadline: "2099-01-01T00:00:00.000Z",
    },
    ephemeralPrivkeyHex: "01".repeat(32),
    submitted: false,
    updatedAt: 1,
  };
}

async function commitFixture(
  originLock: GuiOriginStorageAdmissionLockContext,
  fixture: ReturnType<typeof preTradeFixture>,
  afterAdmission: () => void = () => undefined,
) {
  return db.transaction("rw", transactionTables(), async () => {
    const next = await commitGuiPreTradeStorageAdmissionInCurrentTransaction({
      originLock,
      batch: fixture.batch,
      pendingTradeKey: [
        fixture.pendingTrade.walletId,
        fixture.pendingTrade.orderId,
      ],
      expectedPendingTrade: fixture.pendingTrade,
      intents: fixture.intents,
    });
    afterAdmission();
    return next;
  });
}

function commitFixtureRows(
  originLock: GuiOriginStorageAdmissionLockContext,
  fixture: ReturnType<typeof preTradeFixture>,
  intents: readonly SwapIntentRecord[],
) {
  return db.transaction("rw", transactionTables(), () =>
    commitGuiPreTradeStorageAdmissionInCurrentTransaction({
      originLock,
      batch: fixture.batch,
      pendingTradeKey: [
        fixture.pendingTrade.walletId,
        fixture.pendingTrade.orderId,
      ],
      expectedPendingTrade: fixture.pendingTrade,
      intents,
    }),
  );
}

function markAttempt(
  originLock: GuiOriginStorageAdmissionLockContext,
  expectedIntent: SwapIntentRecord,
  nextIntent: SwapIntentRecord,
) {
  return db.transaction("rw", transactionTables(), () =>
    markGuiPreTradePubkeyAttemptInCurrentTransaction({
      originLock,
      tradeId: expectedIntent.tradeId,
      expectedIntent,
      nextIntent,
    }),
  );
}

function transactionTables() {
  return [
    ...guiDurableStorageAdmissionTables(db),
    db.pendingTrades,
    db.swapIntents,
  ];
}

function withAdmissionLock<T>(
  action: (originLock: GuiOriginStorageAdmissionLockContext) => Promise<T>,
): Promise<T> {
  return withGuiWalletLock(
    WALLET_ID,
    () => WALLET_ID,
    (walletLock) =>
      withGuiOriginStorageAdmissionLock(walletLock, () => WALLET_ID, action),
  );
}

function withMutableAdmissionLock<T>(
  currentWalletId: () => string,
  action: (originLock: GuiOriginStorageAdmissionLockContext) => Promise<T>,
): Promise<T> {
  return withGuiWalletLock(WALLET_ID, currentWalletId, (walletLock) =>
    withGuiOriginStorageAdmissionLock(walletLock, currentWalletId, action),
  );
}

function installImmediateWebLocks(): void {
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: async <T>(
        name: string,
        _options: LockOptions,
        callback: (lock: Lock) => Promise<T>,
      ): Promise<T> => callback({ name, mode: "exclusive" } as Lock),
    } as LockManager,
  });
}

function restoreWebLocks(descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) {
    Object.defineProperty(navigator, "locks", descriptor);
  } else {
    delete (navigator as { locks?: LockManager }).locks;
  }
}
