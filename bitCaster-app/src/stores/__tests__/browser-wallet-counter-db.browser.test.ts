import {
  BrowserCtfRangeOrderCoordinator,
  type BrowserCtfRangeOrderCoordinatorDependencies,
} from "@/lib/browserCtfRangeOrderCoordinator";
import { planPersistedCtfRangeOrderAuthorization } from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import { composeCtfRangeOrderFeeFacts } from "@bitcaster/client-sdk/ctfRangeOrderFeeComposition";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Amount, deriveConditionalKeysetId, deriveKeysetId } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import {
  buildPersistedCtfRangeOrderPreparation,
  createCtfRangePreparationIntent,
  decodeCtfRangeOrderPreparationFromRecord,
  decodeCounterCtfRangePreparationBytes,
  type CtfRangeOrderRequest,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { mintDenominationKeys } from "../../../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts";
import { browserRangeJournalIdentity, browserWalletScope } from "@/lib/browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { BrowserWalletCounterDexieStore } from "../browser-wallet-counter-db";
import { insertCtfRangePreparation, readCtfRangePreparationForIntent } from "../ctf-range-order-db";
import { BitcasterDB } from "../proof-db";

const seed = new Uint8Array(64).fill(31);
const scopeId = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(seed),
});
const databaseName = browserWalletDatabaseName(scopeId);
const mintUrl = "https://mint.example";
const conditionId = "ab".repeat(32);
const outcome = "YES";
const complement = "NO";
const mintPrivateKey = Uint8Array.from([...new Uint8Array(31), 1]);
const inputFeePpk = 100;
const finalExpiry = 1_000;
const mintKeys = mintDenominationKeys(
  mintPrivateKey,
  Array.from({ length: 21 }, (_, index) => (1 << index).toString()),
);
const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
  conditionId,
  outcomeCollection: outcome,
});
const complementCollectionId = deriveRootCtfOutcomeCollectionId({
  conditionId,
  outcomeCollection: complement,
});
const regularKeysetId = deriveKeysetId(mintKeys, {
  unit: "msat",
  input_fee_ppk: inputFeePpk,
  expiry: finalExpiry,
  versionByte: 1,
});
const offerKeysetId = regularKeysetId;
const receiveKeysetId = deriveConditionalKeysetId({
  keys: mintKeys,
  unit: "msat",
  input_fee_ppk: inputFeePpk,
  final_expiry: finalExpiry,
  conditionId,
  outcomeCollectionId,
});
const coordinatorPublicKey = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const databases: BitcasterDB[] = [];

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      const name = database.name;
      database.close();
      await Dexie.delete(name);
    }),
  );
});

function openDatabase(): BitcasterDB {
  const database = new BitcasterDB(databaseName);
  databases.push(database);
  return database;
}

function openCounters(database: BitcasterDB): BrowserWalletCounterDexieStore {
  return new BrowserWalletCounterDexieStore({ database, scopeId });
}

async function markCountersReady(database: BitcasterDB): Promise<void> {
  await database.walletCounterAssociations.bulkPut(
    [offerKeysetId, receiveKeysetId].map((keysetId) => ({
      scopeId,
      normalizedMint: mintUrl,
      unit: "msat" as const,
      keysetId,
      recoveryComplete: true,
    })),
  );
}

function request(clientOrderId = "browser-native-ctf-retry"): CtfRangeOrderRequest {
  return {
    clientOrderId,
    marketId: `${conditionId}-${outcome}`,
    conditionId,
    outcomeId: "yes-id",
    tokenSide: "Outcome",
    side: "Buy",
    price: 2,
    maxQuotePaymentSubunits: 2,
    minQuotePaymentSubunits: null,
    amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000,
    baseAsset: "sat",
    collateralUnit: "msat",
    divisibility: 1_000,
    timeInForce: "FOK",
    expiresAt: null,
    mintUrl,
  };
}

function preparation(requestValue = request(), idPrefix = 0) {
  const conditionalKeysets = [
    {
      keysetId: receiveKeysetId,
      conditionId,
      unit: "msat" as const,
      inputFeePpk,
      finalExpiry,
      outcomeCollection: outcome,
      outcomeCollectionId,
      registeredAt: 10,
      keys: mintKeys,
    },
    {
      keysetId: deriveConditionalKeysetId({
        keys: mintKeys,
        unit: "msat",
        input_fee_ppk: inputFeePpk,
        final_expiry: finalExpiry,
        conditionId,
        outcomeCollectionId: complementCollectionId,
      }),
      conditionId,
      unit: "msat" as const,
      inputFeePpk,
      finalExpiry,
      outcomeCollection: complement,
      outcomeCollectionId: complementCollectionId,
      registeredAt: 10,
      keys: mintKeys,
    },
  ];
  let generatedId = 0;
  return buildPersistedCtfRangeOrderPreparation({
    request: requestValue,
    coordinatorPublicKey,
    mintFacts: {
      registration: {
        normalizedMint: mintUrl,
        conditionId,
        canonicalParentCollectionId: null,
        unit: "msat",
        eventId: "browser-indexeddb-fixture",
        outcomes: [outcome, complement],
        threshold: 1,
        oracles: [
          {
            oraclePublicKey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            noncePoint: coordinatorPublicKey,
            announcementIdentity: "aa".repeat(32),
          },
        ],
      },
      regular: [
        {
          canonicalMintUrl: mintUrl,
          id: regularKeysetId,
          unit: "msat",
          active: true,
          keys: mintKeys,
          inputFeePpk,
          finalExpiry,
        },
      ],
      conditional: conditionalKeysets.map(({ keysetId, ...keyset }) => ({
        ...keyset,
        canonicalMintUrl: mintUrl,
        id: keysetId,
        active: true as const,
      })),
      maxInputs: 64,
      maxPoolEntries: 128,
      observation: {
        canonicalMintUrl: mintUrl,
        freshness: "fresh",
        observedAt: 20,
        maxExpirySeconds: finalExpiry,
        conditionKeysetIds: [receiveKeysetId, conditionalKeysets[1]!.keysetId],
        conditionalKeysets,
      },
    },
    market: {
      outcomes: [
        { id: "yes-id", label: outcome },
        { id: "no-id", label: complement },
      ],
    },
    nowUnixSeconds: 20,
    randomId: () =>
      `00000000-0000-4000-8000-${(idPrefix + generatedId++).toString(16).padStart(12, "0")}`,
  });
}

function intent(requestValue = request()) {
  return createCtfRangePreparationIntent({
    scopeId,
    request: requestValue,
    feeConsentBytes: null,
    consolidateProofs: true,
  }).intent;
}

function reservationInput(requestValue = request()) {
  const selectedPreparation = preparation(requestValue);
  return {
    context: { mintUrl, unit: "msat" },
    preparation: selectedPreparation,
    intent: intent(requestValue),
    seed,
    createdAtMs: 100,
  } as const;
}

describe("browser CTF counter reservation in Chromium IndexedDB", () => {
  it("uses the browser IndexedDB provider rather than fake-indexeddb", () => {
    expect(window.indexedDB).toBeDefined();
    expect(Dexie.dependencies.indexedDB).toBe(window.indexedDB);
    expect(window.indexedDB.constructor.name).toBe("IDBFactory");
  });

  it("rolls back the receipt and first cursor when the second cursor write fails", async () => {
    const database = openDatabase();
    await markCountersReady(database);
    await database.walletCounterCursors.bulkPut([
      { scopeId, keysetId: offerKeysetId, next: 0 },
      { scopeId, keysetId: receiveKeysetId, next: 0 },
    ]);
    database.walletCounterCursors.hook("updating", (_mods, _key, row) => {
      if (row.keysetId === receiveKeysetId) throw new Error("second cursor write failed");
    });

    await expect(
      openCounters(database).reserveCtfPreparationInContext(reservationInput()),
    ).rejects.toThrow("second cursor write failed");
    expect(await database.ctfRangePreparations.count()).toBe(0);
    expect(await database.walletCounterCursors.get([scopeId, offerKeysetId])).toMatchObject({
      next: 0,
    });
    expect(await database.walletCounterCursors.get([scopeId, receiveKeysetId])).toMatchObject({
      next: 0,
    });

    database.close();
    const reopened = openDatabase();
    await reopened.open();
    expect(await reopened.ctfRangePreparations.count()).toBe(0);
    expect(await reopened.walletCounterCursors.get([scopeId, offerKeysetId])).toMatchObject({
      next: 0,
    });
  });

  it("rolls back both ranges when receipt insertion fails", async () => {
    const database = openDatabase();
    await markCountersReady(database);
    await database.walletCounterCursors.bulkPut([
      { scopeId, keysetId: offerKeysetId, next: 0 },
      { scopeId, keysetId: receiveKeysetId, next: 0 },
    ]);
    database.ctfRangePreparations.hook("creating", () => {
      throw new Error("receipt insert failed");
    });

    await expect(
      openCounters(database).reserveCtfPreparationInContext(reservationInput()),
    ).rejects.toThrow("receipt insert failed");
    expect(await database.ctfRangePreparations.count()).toBe(0);
    expect(await database.walletCounterCursors.get([scopeId, offerKeysetId])).toMatchObject({
      next: 0,
    });
    expect(await database.walletCounterCursors.get([scopeId, receiveKeysetId])).toMatchObject({
      next: 0,
    });
  });

  it("replays the exact receipt after closing and reopening the real database", async () => {
    const database = openDatabase();
    await markCountersReady(database);
    const counters = openCounters(database);
    const input = reservationInput();
    const first = await counters.reserveCtfPreparationInContext(input);
    const decoded = decodeCounterCtfRangePreparationBytes(first.record.preparationBytes);
    expect(first.replayed).toBe(false);
    expect(decoded.version).toBe(3);
    expect(await database.walletCounterCursors.get([scopeId, offerKeysetId])).toMatchObject({
      next: decoded.offerCounterCount,
    });
    expect(await database.walletCounterCursors.get([scopeId, receiveKeysetId])).toMatchObject({
      next: decoded.receiveCounterCount,
    });

    database.close();
    const reopened = openDatabase();
    await reopened.open();
    const replay = await openCounters(reopened).reserveCtfPreparationInContext(input);
    expect(replay).toEqual({ record: first.record, replayed: true });
    expect(await reopened.ctfRangePreparations.count()).toBe(1);
    expect(await reopened.walletCounterCursors.get([scopeId, offerKeysetId])).toMatchObject({
      next: decoded.offerCounterCount,
    });
    expect(await reopened.walletCounterCursors.get([scopeId, receiveKeysetId])).toMatchObject({
      next: decoded.receiveCounterCount,
    });
  });

  it("serializes concurrent identical submissions to one receipt and one pair of ranges", async () => {
    const database = openDatabase();
    await markCountersReady(database);
    const counters = openCounters(database);
    const input = reservationInput();
    const results = await Promise.all([
      counters.reserveCtfPreparationInContext(input),
      counters.reserveCtfPreparationInContext(input),
    ]);
    expect(results.map(({ replayed }) => replayed).sort()).toEqual([false, true]);
    expect(results[0]!.record).toEqual(results[1]!.record);
    expect(await database.ctfRangePreparations.count()).toBe(1);
    const decoded = decodeCounterCtfRangePreparationBytes(results[0]!.record.preparationBytes);
    expect(await database.walletCounterCursors.get([scopeId, offerKeysetId])).toMatchObject({
      next: decoded.offerCounterCount,
    });
    expect(await database.walletCounterCursors.get([scopeId, receiveKeysetId])).toMatchObject({
      next: decoded.receiveCounterCount,
    });
  });

  it("retains v2 rows in the current database and refuses ambiguous nonunique history after reopen", async () => {
    const oldProfile = openDatabase();
    const configuredVersion = oldProfile.verno;
    await oldProfile.open();
    expect(oldProfile.verno).toBe(configuredVersion);
    const order = request("browser-current-duplicate-history");
    const orderIntent = intent(order);
    const firstV2 = preparation(order);
    expect(firstV2.version).toBe(2);
    const retained = await insertCtfRangePreparation(
      browserRangeJournalIdentity(browserWalletScope(seed), firstV2, 100),
      oldProfile,
    );
    oldProfile.close();

    const reopened = openDatabase();
    await reopened.open();
    expect(reopened.verno).toBe(configuredVersion);
    const rowsAfterReopen = await reopened.ctfRangePreparations.toArray();
    expect(rowsAfterReopen).toEqual([retained]);
    expect(decodeCtfRangeOrderPreparationFromRecord(rowsAfterReopen[0]!).version).toBe(2);
    await expect(readCtfRangePreparationForIntent(orderIntent, reopened)).resolves.toEqual(
      retained,
    );

    const secondV2 = preparation(order, 1);
    expect(secondV2.version).toBe(2);
    const duplicate = await insertCtfRangePreparation(
      browserRangeJournalIdentity(browserWalletScope(seed), secondV2, 101),
      reopened,
    );
    expect(await reopened.ctfRangePreparations.toArray()).toEqual([retained, duplicate]);
    await expect(readCtfRangePreparationForIntent(orderIntent, reopened)).rejects.toThrow(
      "CTF preparation history is ambiguous",
    );
  });
});

it("native IndexedDB co-commits scoped speculative counter and caller journal, reopens and refuses stale CAS", async () => {
  const database = openDatabase();
  const counters = openCounters(database);
  const context = { mintUrl, unit: "msat" };
  await counters.restoreInContext(context, offerKeysetId, 11, false, () => undefined);
  const snapshot = await counters.readSnapshotInContext(context, offerKeysetId);
  expect(snapshot).toEqual({ keysetId: offerKeysetId, nextCounter: 11 });
  const candidate = preparation(request("native-speculative-journal"));
  const identity = browserRangeJournalIdentity(browserWalletScope(seed), candidate, 101);
  const tables = [
    database.walletCounterAssociations,
    database.walletCounterCursors,
    database.custodyProofs,
    database.custodyProofBackupAuthorities,
    database.custodyConditionalKeysets,
    database.encryptedWalletBackupV2DesiredAssets,
    database.ctfRangePreparations,
  ];
  await expect(
    database.transaction("rw", tables, async (tx) => {
      await counters.compareAndAdvanceInCurrentTransaction(tx, context, {
        keysetId: offerKeysetId,
        expectedNextCounter: 11,
        nextCounter: 13,
      });
      await insertCtfRangePreparation(identity, database);
      throw new Error("native joint abort");
    }),
  ).rejects.toThrow("native joint abort");
  expect(await counters.readSnapshotInContext(context, offerKeysetId)).toEqual(snapshot);
  expect(await database.ctfRangePreparations.count()).toBe(0);
  await database.transaction("rw", tables, async (tx) => {
    await counters.compareAndAdvanceInCurrentTransaction(tx, context, {
      keysetId: offerKeysetId,
      expectedNextCounter: 11,
      nextCounter: 13,
    });
    await insertCtfRangePreparation(identity, database);
  });
  database.close();
  const reopened = openDatabase();
  await reopened.open();
  expect(await openCounters(reopened).readSnapshotInContext(context, offerKeysetId)).toEqual({
    keysetId: offerKeysetId,
    nextCounter: 13,
  });
  expect(await reopened.ctfRangePreparations.count()).toBe(1);
  const competitor = openDatabase();
  await competitor.open();
  await openCounters(competitor).reserveInContext(context, offerKeysetId, 1, true);
  const currentTables = tables.map((table) => reopened.table(table.name));
  await expect(
    reopened.transaction("rw", currentTables, (tx) =>
      openCounters(reopened).compareAndAdvanceInCurrentTransaction(tx, context, {
        keysetId: offerKeysetId,
        expectedNextCounter: 13,
        nextCounter: 15,
      }),
    ),
  ).rejects.toThrow("snapshot changed");
  expect(await openCounters(reopened).readSnapshotInContext(context, offerKeysetId)).toEqual({
    keysetId: offerKeysetId,
    nextCounter: 14,
  });
  expect(await reopened.ctfRangePreparations.count()).toBe(1);
});

vi.mock("@/lib/browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: async () => undefined,
}));

it("native source consolidation commits counters and exact custody only together", async () => {
  const database = openDatabase();
  await markCountersReady(database);
  const candidate = preparation(request("native-source-consolidation"));
  const inputs = ["a", "b", "c"].map((secret) => ({
    id: offerKeysetId,
    amount: Amount.from(2),
    secret,
    C: mintKeys["2"]!,
  }));
  await database.proofs.bulkPut(
    inputs.map((proof) => ({
      ...proof,
      amount: 2,
      scopeId,
      mintUrl,
      baseAsset: "sat" as const,
      unit: "msat",
      receivedAt: 1,
    })),
  );
  let phase: "counter-written" | "journal-bound" | undefined = "counter-written";
  let mintCalls = 0;
  let now = 20000;
  const wallet: Exclude<
    BrowserCtfRangeOrderCoordinatorDependencies["wallet"],
    (...args: never[]) => unknown
  > = {
    async prepareSwapToSend(amount, proofs, config, outputs) {
      if (outputs.send.type !== "custom" || outputs.keep.type !== "custom")
        throw new Error("unexpected random outputs");
      return {
        amount: Amount.from(amount),
        fees: Amount.from(1),
        keysetId: config.keysetId,
        inputs: proofs,
        sendOutputs: outputs.send.data,
        keepOutputs: outputs.keep.data,
        unselectedProofs: [],
      };
    },
    async completeSwap() {
      mintCalls++;
      throw new Error("controlled mint transport boundary");
    },
    async prepareConditionalSwap() {
      throw new Error("unexpected conditional call");
    },
    async completeConditionalSwap() {
      throw new Error("unexpected conditional call");
    },
    async checkProofsStates() {
      throw new Error("unexpected state call");
    },
  };
  const unexpected = async (): Promise<never> => {
    throw new Error("unexpected engine call");
  };
  const coordinator = new BrowserCtfRangeOrderCoordinator({
    database,
    wallet,
    engine: {
      createSettlementCapability: unexpected,
      submitOrder: unexpected,
      getOrderStatus: unexpected,
      getSettlementCapabilityResultByOperation: unexpected,
      acknowledgeSettlementCapabilityResult: unexpected,
    },
    now: () => now++,
    injectSourcePreparationFault: (current) => {
      if (current === phase) throw new Error("native preparation abort");
    },
  });
  const feeFacts = composeCtfRangeOrderFeeFacts({
    authorizationPlan: planPersistedCtfRangeOrderAuthorization(candidate),
    sourcePlan: {
      kind: "same-keyset-swap",
      inputs: [],
      authorizationAmounts: [],
      changeAmount: 0,
      inputFee: 1,
    },
    sourceMode: "wallet-send",
    consolidationFeeSubunits: "0",
    settlementAsset: { kind: "regular", unit: "msat" },
    sourcePreparationAsset: { kind: "regular", unit: "msat" },
    consolidationAsset: { kind: "regular", unit: "msat" },
  });
  const perform = () =>
    coordinator.consolidateRound({
      seed,
      preparation: candidate,
      round: 0,
      inputs,
      plannedRound: { inputs: ["2", "2", "2"], outputs: ["4", "1"], fee: "1" },
      consentedFeeFacts: feeFacts,
    });
  for (const fault of ["counter-written", "journal-bound"] as const) {
    phase = fault;
    await expect(perform()).rejects.toMatchObject({ code: "custody-commit-failed" });
    expect(await database.walletCounterCursors.get([scopeId, offerKeysetId])).toBeUndefined();
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.ctfRangePreparations.count()).toBe(0);
    expect(mintCalls).toBe(0);
  }
  phase = undefined;
  await expect(perform()).rejects.toMatchObject({ code: "mint-source-uncertain" });
  expect(mintCalls).toBe(1);
  database.close();
  const reopened = openDatabase();
  expect((await reopened.walletCounterCursors.get([scopeId, offerKeysetId]))?.next).toBe(2);
  expect(await reopened.custodyOperations.count()).toBe(1);
  expect(await reopened.ctfRangePreparations.count()).toBe(1);
  expect(await reopened.ctfRangePreparationConsolidations.count()).toBe(1);
  expect((await reopened.custodyArtifacts.toArray()).length).toBeGreaterThan(0);
});
