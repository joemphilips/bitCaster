// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveDurableCustodyWalletId } from "@bitcaster/client-sdk/durableCustody";
import { deriveConditionalKeysetId, deriveKeysetId } from "@cashu/cashu-ts";
import { mintDenominationKeys } from "../../../../bitcaster-client-sdk/test/support/mintDenominationKeys.ts";
import {
  buildPersistedCtfRangeOrderPreparation,
  counterCtfRangePreparationIdentity,
  createCounterCtfRangePreparation,
  createCtfRangePreparationIntent,
  decodeCounterCtfRangePreparationBytes,
  type CtfRangeOrderRequest,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { browserRangeJournalIdentity, browserWalletScope } from "@/lib/browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import {
  BrowserWalletCounterDexieStore,
  BrowserWalletCounterSource,
  BROWSER_WALLET_COUNTER_ASSOCIATION_MAX,
  BROWSER_WALLET_COUNTER_SNAPSHOT_MAX,
} from "../browser-wallet-counter-db";
import { createBrowserProofBackupAuthorityRow } from "../browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../durable-custody-db";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../browser-encrypted-wallet-backup-v2-desired-asset";
import { createEncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { BitcasterDB } from "../proof-db";
import { insertCtfRangePreparation, readCtfRangePreparationForIntent } from "../ctf-range-order-db";

const scopeId = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: "11".repeat(32) });
const keysetId = `01${"aa".repeat(32)}`;
const v3KeysetId = `02${"aa".repeat(32)}`;
const databases: BitcasterDB[] = [];
const ctfSeed = new Uint8Array(64).fill(31);
const ctfScopeId = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(ctfSeed),
});
const ctfDatabaseName = browserWalletDatabaseName(ctfScopeId);
const ctfMintUrl = "https://mint.example";
const ctfConditionId = "ab".repeat(32);
const ctfOutcome = "YES";
const ctfComplement = "NO";
const ctfPrivateKey = Uint8Array.from([...new Uint8Array(31), 1]);
const ctfInputFeePpk = 100;
const ctfFinalExpiry = 1_000;
const ctfKeys = mintDenominationKeys(
  ctfPrivateKey,
  Array.from({ length: 21 }, (_, index) => (1 << index).toString()),
);
const ctfOutcomeCollectionId = deriveRootCtfOutcomeCollectionId({
  conditionId: ctfConditionId,
  outcomeCollection: ctfOutcome,
});
const ctfComplementCollectionId = deriveRootCtfOutcomeCollectionId({
  conditionId: ctfConditionId,
  outcomeCollection: ctfComplement,
});
const ctfRegularKeysetId = deriveKeysetId(ctfKeys, {
  unit: "msat",
  input_fee_ppk: ctfInputFeePpk,
  expiry: ctfFinalExpiry,
  versionByte: 1,
});
const ctfOutcomeKeysetId = deriveConditionalKeysetId({
  keys: ctfKeys,
  unit: "msat",
  input_fee_ppk: ctfInputFeePpk,
  final_expiry: ctfFinalExpiry,
  conditionId: ctfConditionId,
  outcomeCollectionId: ctfOutcomeCollectionId,
});
const ctfOfferKeysetId = ctfRegularKeysetId;
const ctfReceiveKeysetId = ctfOutcomeKeysetId;
const ctfCoordinatorPublicKey = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

afterEach(async () => {
  await Promise.all(
    databases.splice(0).map(async (database) => {
      const name = database.name;
      database.close();
      await Dexie.delete(name);
    }),
  );
});

function createStore(options: { current?: boolean; name?: string } = {}) {
  const database = new BitcasterDB(options.name ?? browserWalletDatabaseName(scopeId));
  databases.push(database);
  return new BrowserWalletCounterDexieStore({
    database,
    scopeId,
    isCurrentProfile: () => options.current ?? true,
  });
}

function createCtfStore(options: { current?: boolean } = {}) {
  const database = new BitcasterDB(ctfDatabaseName);
  databases.push(database);
  return {
    database,
    counters: new BrowserWalletCounterDexieStore({
      database,
      scopeId: ctfScopeId,
      isCurrentProfile: () => options.current ?? true,
    }),
  };
}

function ctfRequest(clientOrderId = "client-ctf-atomic"): CtfRangeOrderRequest {
  return {
    clientOrderId,
    marketId: `${ctfConditionId}-${ctfOutcome}`,
    conditionId: ctfConditionId,
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
    mintUrl: ctfMintUrl,
  };
}

function ctfBasePreparation(request = ctfRequest(), idPrefix = 0) {
  const outcomeKeysetId = ctfOutcomeKeysetId;
  const complementKeysetId = deriveConditionalKeysetId({
    keys: ctfKeys,
    unit: "msat",
    input_fee_ppk: ctfInputFeePpk,
    final_expiry: ctfFinalExpiry,
    conditionId: ctfConditionId,
    outcomeCollectionId: ctfComplementCollectionId,
  });
  const conditionalKeysets = [
    {
      keysetId: outcomeKeysetId,
      conditionId: ctfConditionId,
      unit: "msat" as const,
      inputFeePpk: ctfInputFeePpk,
      finalExpiry: ctfFinalExpiry,
      outcomeCollection: ctfOutcome,
      outcomeCollectionId: ctfOutcomeCollectionId,
      registeredAt: 10,
      keys: ctfKeys,
    },
    {
      keysetId: complementKeysetId,
      conditionId: ctfConditionId,
      unit: "msat" as const,
      inputFeePpk: ctfInputFeePpk,
      finalExpiry: ctfFinalExpiry,
      outcomeCollection: ctfComplement,
      outcomeCollectionId: ctfComplementCollectionId,
      registeredAt: 10,
      keys: ctfKeys,
    },
  ];
  let id = 0;
  return buildPersistedCtfRangeOrderPreparation({
    request,
    coordinatorPublicKey: ctfCoordinatorPublicKey,
    mintFacts: {
      registration: {
        normalizedMint: ctfMintUrl,
        conditionId: ctfConditionId,
        canonicalParentCollectionId: null,
        unit: "msat",
        eventId: "counter-fixture-event",
        outcomes: [ctfOutcome, ctfComplement],
        threshold: 1,
        oracles: [
          {
            oraclePublicKey: "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
            noncePoint: ctfCoordinatorPublicKey,
            announcementIdentity: "aa".repeat(32),
          },
        ],
      },
      regular: [
        {
          canonicalMintUrl: ctfMintUrl,
          id: ctfRegularKeysetId,
          unit: "msat",
          active: true,
          keys: ctfKeys,
          inputFeePpk: ctfInputFeePpk,
          finalExpiry: ctfFinalExpiry,
        },
      ],
      conditional: conditionalKeysets.map(({ keysetId, ...keyset }) => ({
        ...keyset,
        canonicalMintUrl: ctfMintUrl,
        id: keysetId,
        active: true as const,
      })),
      maxInputs: 64,
      maxPoolEntries: 128,
      observation: {
        canonicalMintUrl: ctfMintUrl,
        freshness: "fresh",
        observedAt: 20,
        maxExpirySeconds: ctfFinalExpiry,
        conditionKeysetIds: [outcomeKeysetId, complementKeysetId],
        conditionalKeysets,
      },
    },
    market: {
      outcomes: [
        { id: "yes-id", label: ctfOutcome },
        { id: "no-id", label: ctfComplement },
      ],
    },
    nowUnixSeconds: 20,
    randomId: () => `00000000-0000-4000-8000-${(idPrefix + id++).toString(16).padStart(12, "0")}`,
  });
}

function ctfIntent(request = ctfRequest(), consolidateProofs = true) {
  return createCtfRangePreparationIntent({
    scopeId: ctfScopeId,
    request,
    feeConsentBytes: null,
    consolidateProofs,
  }).intent;
}

async function markCtfCountersReady(database: BitcasterDB): Promise<void> {
  await database.walletCounterAssociations.bulkPut(
    [ctfOfferKeysetId, ctfReceiveKeysetId].map((keysetId) => ({
      scopeId: ctfScopeId,
      normalizedMint: ctfMintUrl,
      unit: "msat" as const,
      keysetId,
      recoveryComplete: true,
    })),
  );
}

describe("browser wallet counter authority", () => {
  it("atomically commits both CTF ranges with a v3 receipt and replays at exhausted cursors", async () => {
    const { database, counters } = createCtfStore();
    await markCtfCountersReady(database);
    const preparation = ctfBasePreparation();
    const intent = ctfIntent(preparation.request);
    const input = {
      context: { mintUrl: ctfMintUrl, unit: "msat" },
      preparation,
      intent,
      seed: ctfSeed,
      createdAtMs: 100,
    } as const;

    const first = await counters.reserveCtfPreparationInContext(input);
    const decoded = decodeCounterCtfRangePreparationBytes(first.record.preparationBytes);
    expect(first.replayed).toBe(false);
    expect(decoded.version).toBe(3);
    expect(decoded.offerCounterStart).toBe(0);
    expect(decoded.receiveCounterStart).toBe(0);
    expect(await database.walletCounterCursors.get([ctfScopeId, ctfOfferKeysetId])).toMatchObject({
      next: decoded.offerCounterCount,
    });
    expect(await database.walletCounterCursors.get([ctfScopeId, ctfReceiveKeysetId])).toMatchObject(
      { next: decoded.receiveCounterCount },
    );
    expect(await database.ctfRangePreparations.count()).toBe(1);

    await database.walletCounterCursors.bulkPut([
      { scopeId: ctfScopeId, keysetId: ctfOfferKeysetId, next: 2_147_483_648 },
      { scopeId: ctfScopeId, keysetId: ctfReceiveKeysetId, next: 2_147_483_648 },
    ]);
    const replay = await counters.reserveCtfPreparationInContext(input);
    expect(replay).toEqual({ record: first.record, replayed: true });
    expect(await database.walletCounterCursors.get([ctfScopeId, ctfOfferKeysetId])).toMatchObject({
      next: 2_147_483_648,
    });
    expect(await database.walletCounterCursors.get([ctfScopeId, ctfReceiveKeysetId])).toMatchObject(
      {
        next: 2_147_483_648,
      },
    );

    database.close();
    const reopened = new BitcasterDB(ctfDatabaseName);
    await reopened.open();
    expect(await readCtfRangePreparationForIntent(intent, reopened)).toEqual(first.record);
    reopened.close();
  });

  it("serializes identical concurrent CTF submissions to one receipt and one range pair", async () => {
    const { database, counters } = createCtfStore();
    await markCtfCountersReady(database);
    const preparation = ctfBasePreparation();
    const input = {
      context: { mintUrl: ctfMintUrl, unit: "msat" },
      preparation,
      intent: ctfIntent(preparation.request),
      seed: ctfSeed,
      createdAtMs: 100,
    } as const;

    const results = await Promise.all([
      counters.reserveCtfPreparationInContext(input),
      counters.reserveCtfPreparationInContext(input),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0]?.record).toEqual(results[1]?.record);
    expect(await database.ctfRangePreparations.count()).toBe(1);
    expect(await database.walletCounterCursors.get([ctfScopeId, ctfOfferKeysetId])).toMatchObject({
      next: decodeCounterCtfRangePreparationBytes(results[0]!.record.preparationBytes)
        .offerCounterCount,
    });
  });

  it("refuses a foreign seed and intent before returning an existing foreign-scope receipt", async () => {
    const { database, counters } = createCtfStore();
    const foreignSeed = new Uint8Array(64).fill(42);
    const foreignScopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: deriveDurableCustodyWalletId(foreignSeed),
    });
    const request = ctfRequest("client-foreign-scope");
    const intent = createCtfRangePreparationIntent({
      scopeId: foreignScopeId,
      request,
      feeConsentBytes: null,
      consolidateProofs: true,
    }).intent;
    const preparation = ctfBasePreparation(request);
    const receipt = createCounterCtfRangePreparation({
      preparation,
      intent,
      seed: foreignSeed,
      offerCounterStart: 0,
      receiveCounterStart: 0,
    });
    const foreignRecord = await insertCtfRangePreparation(
      counterCtfRangePreparationIdentity(receipt, 100),
      database,
    );

    await expect(
      counters.reserveCtfPreparationInContext({
        context: { mintUrl: ctfMintUrl, unit: "msat" },
        preparation,
        intent,
        seed: foreignSeed,
        createdAtMs: 101,
      }),
    ).rejects.toMatchObject({ code: "foreign_database" });
    expect(await database.ctfRangePreparations.count()).toBe(1);
    expect(await database.ctfRangePreparations.get([foreignScopeId, receipt.operationId])).toEqual(
      foreignRecord,
    );
    expect(await database.walletCounterCursors.count()).toBe(0);
  });

  it("rolls back the receipt and first cursor update if the second CTF cursor write fails", async () => {
    const { database, counters } = createCtfStore();
    await markCtfCountersReady(database);
    await database.walletCounterCursors.bulkPut([
      { scopeId: ctfScopeId, keysetId: ctfOfferKeysetId, next: 0 },
      { scopeId: ctfScopeId, keysetId: ctfReceiveKeysetId, next: 0 },
    ]);
    database.walletCounterCursors.hook("updating", (_mods, _key, row) => {
      if (row.keysetId === ctfReceiveKeysetId) throw new Error("second cursor write failed");
    });
    const preparation = ctfBasePreparation();

    await expect(
      counters.reserveCtfPreparationInContext({
        context: { mintUrl: ctfMintUrl, unit: "msat" },
        preparation,
        intent: ctfIntent(preparation.request),
        seed: ctfSeed,
        createdAtMs: 100,
      }),
    ).rejects.toThrow("second cursor write failed");
    expect(await database.ctfRangePreparations.count()).toBe(0);
    expect(await database.walletCounterCursors.get([ctfScopeId, ctfOfferKeysetId])).toMatchObject({
      next: 0,
    });
    expect(await database.walletCounterCursors.get([ctfScopeId, ctfReceiveKeysetId])).toMatchObject(
      {
        next: 0,
      },
    );
  });

  it("rolls back both cursors when receipt insertion fails before cursor writes", async () => {
    const { database, counters } = createCtfStore();
    await markCtfCountersReady(database);
    await database.walletCounterCursors.bulkPut([
      { scopeId: ctfScopeId, keysetId: ctfOfferKeysetId, next: 0 },
      { scopeId: ctfScopeId, keysetId: ctfReceiveKeysetId, next: 0 },
    ]);
    database.ctfRangePreparations.hook("creating", () => {
      throw new Error("receipt insert failed");
    });
    const preparation = ctfBasePreparation();

    await expect(
      counters.reserveCtfPreparationInContext({
        context: { mintUrl: ctfMintUrl, unit: "msat" },
        preparation,
        intent: ctfIntent(preparation.request),
        seed: ctfSeed,
        createdAtMs: 100,
      }),
    ).rejects.toThrow("receipt insert failed");
    expect(await database.ctfRangePreparations.count()).toBe(0);
    expect(await database.walletCounterCursors.get([ctfScopeId, ctfOfferKeysetId])).toMatchObject({
      next: 0,
    });
    expect(await database.walletCounterCursors.get([ctfScopeId, ctfReceiveKeysetId])).toMatchObject(
      { next: 0 },
    );
  });

  it("rejects changed intent, incomplete recovery, and stale profile without allocating CTF ranges", async () => {
    const { database, counters } = createCtfStore();
    await markCtfCountersReady(database);
    const preparation = ctfBasePreparation();
    const input = {
      context: { mintUrl: ctfMintUrl, unit: "msat" },
      preparation,
      intent: ctfIntent(preparation.request),
      seed: ctfSeed,
      createdAtMs: 100,
    } as const;
    await counters.reserveCtfPreparationInContext(input);
    const changedRequest = { ...preparation.request, amountSubunits: 2_000 };
    await expect(
      counters.reserveCtfPreparationInContext({ ...input, intent: ctfIntent(changedRequest) }),
    ).rejects.toThrow(/conflicts with its retained receipt/);
    await expect(
      counters.reserveCtfPreparationInContext({
        ...input,
        intent: ctfIntent(preparation.request, false),
      }),
    ).rejects.toThrow(/conflicts with its retained receipt/);

    const beforeIncomplete = await database.walletCounterCursors.toArray();
    await database.walletCounterAssociations.update(
      [ctfScopeId, ctfMintUrl, "msat", ctfReceiveKeysetId],
      { recoveryComplete: false },
    );
    await expect(
      counters.reserveCtfPreparationInContext({
        ...input,
        preparation: ctfBasePreparation(ctfRequest("client-incomplete")),
        intent: ctfIntent(ctfRequest("client-incomplete")),
      }),
    ).rejects.toMatchObject({ code: "recovery_incomplete" });
    expect(await database.walletCounterCursors.toArray()).toEqual(beforeIncomplete);
    expect(await database.ctfRangePreparations.count()).toBe(1);

    const stale = new BrowserWalletCounterDexieStore({
      database,
      scopeId: ctfScopeId,
      isCurrentProfile: () => false,
    });
    await expect(
      stale.reserveCtfPreparationInContext({
        ...input,
        preparation: ctfBasePreparation(ctfRequest("client-stale")),
        intent: ctfIntent(ctfRequest("client-stale")),
      }),
    ).rejects.toMatchObject({ code: "stale_profile" });
    expect(await database.walletCounterCursors.toArray()).toEqual(beforeIncomplete);
    expect(await database.ctfRangePreparations.count()).toBe(1);
  });

  it("uses the fixed browser policy for v2 compatibility and refuses ambiguous history", async () => {
    const database = new BitcasterDB(ctfDatabaseName);
    databases.push(database);
    const preparation = ctfBasePreparation();
    const scope = browserWalletScope(ctfSeed);
    const v2 = await insertCtfRangePreparation(
      {
        ...browserRangeJournalIdentity(scope, preparation, 100),
        feeConsentBytes: null,
      },
      database,
    );
    await expect(
      readCtfRangePreparationForIntent(ctfIntent(preparation.request), database),
    ).resolves.toEqual(v2);
    await expect(
      readCtfRangePreparationForIntent(ctfIntent(preparation.request, false), database),
    ).rejects.toThrow(/conflicts with its retained receipt/);

    const second = ctfBasePreparation(preparation.request, 100);
    const secondRecord = {
      ...browserRangeJournalIdentity(scope, second, 101),
      feeConsentBytes: null,
      lifecycleState: "prepared" as const,
      revision: 0,
      capability: null,
      updatedAtMs: 101,
    };
    await database.ctfRangePreparations.add(secondRecord);
    await expect(
      readCtfRangePreparationForIntent(ctfIntent(preparation.request), database),
    ).rejects.toThrow(/history is ambiguous/);

    for (let index = 2; index < 33; index += 1) {
      const extra = ctfBasePreparation(preparation.request, 1_000 + index * 10);
      await database.ctfRangePreparations.add({
        ...browserRangeJournalIdentity(scope, extra, 101 + index),
        feeConsentBytes: null,
        lifecycleState: "prepared",
        revision: 0,
        capability: null,
        updatedAtMs: 101 + index,
      });
    }
    await expect(
      readCtfRangePreparationForIntent(ctfIntent(preparation.request), database),
    ).rejects.toThrow(/history exceeds its limit/);
  });

  it("rejects a V3 keyset before a direct durable counter mutation", async () => {
    const counters = createStore();
    const database = databases.at(-1)!;
    const context = { mintUrl: "https://mint.example", unit: "sat" };

    await expect(counters.reserveInContext(context, v3KeysetId, 1, false)).rejects.toMatchObject({
      code: "invalid_keyset",
    });
    await expect(
      counters.advanceToAtLeastInContext(context, v3KeysetId, 1, false),
    ).rejects.toMatchObject({ code: "invalid_keyset" });
    await expect(
      counters.restoreInContext(context, v3KeysetId, 1, false, () => undefined),
    ).rejects.toMatchObject({ code: "invalid_keyset" });

    expect(await database.walletCounterAssociations.count()).toBe(0);
    expect(await database.walletCounterCursors.count()).toBe(0);
    expect(await counters.snapshot()).toEqual({});
  });

  it("allocates unique concurrent ranges and shares a cursor across mint aliases", async () => {
    const counters = createStore();
    const profile = { database: databases.at(-1)!, scopeId };
    const first = new BrowserWalletCounterSource(profile, {
      mintUrl: "https://mint.example/",
      unit: "sat",
      requireRecoveryComplete: false,
    });
    const alias = new BrowserWalletCounterSource(profile, {
      mintUrl: "https://mint.example",
      unit: "sat",
      requireRecoveryComplete: false,
    });
    const ranges = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        (index % 2 === 0 ? first : alias).reserve(keysetId, 2),
      ),
    );

    expect(ranges.map((range) => range.start).sort((a, b) => a - b)).toEqual([
      0, 2, 4, 6, 8, 10, 12, 14,
    ]);
    expect(await counters.snapshot()).toEqual({ [keysetId]: 16 });
    expect(await profile.database.walletCounterAssociations.count()).toBe(1);
  });

  it("rolls back an association when its allocation cannot commit", async () => {
    const counters = createStore();
    const database = databases.at(-1)!;
    const source = new BrowserWalletCounterSource(
      { database, scopeId },
      { mintUrl: "https://mint.example", unit: "sat", requireRecoveryComplete: false },
    );
    vi.spyOn(database.walletCounterCursors, "put").mockRejectedValueOnce(
      new Error("cursor failed"),
    );

    await expect(source.reserve(keysetId, 1)).rejects.toThrow("cursor failed");
    expect(await database.walletCounterAssociations.count()).toBe(0);
    expect(await counters.snapshot()).toEqual({});
  });

  it("requires a completed exact mint and unit recovery before funded allocation", async () => {
    const counters = createStore();
    const profile = { database: databases.at(-1)!, scopeId };
    const source = new BrowserWalletCounterSource(profile, {
      mintUrl: "https://mint.example",
      unit: "sat",
    });

    await expect(source.reserve(keysetId, 1)).rejects.toMatchObject({
      code: "recovery_incomplete",
    });
    const recoveryFallback = new BrowserWalletCounterSource(profile, {
      mintUrl: "https://mint.example",
      unit: "sat",
      requireRecoveryComplete: false,
    });
    await expect(recoveryFallback.reserve(keysetId, 1)).resolves.toEqual({ start: 0, count: 1 });
    await counters.restoreInContext(
      { mintUrl: "https://mint.example", unit: "sat" },
      keysetId,
      0,
      false,
      () => undefined,
    );
    await expect(source.reserve(keysetId, 1)).resolves.toEqual({ start: 1, count: 1 });
  });

  it("keeps advances monotonic", async () => {
    const counters = createStore();

    expect(
      await counters.advanceToAtLeastInContext(
        { mintUrl: "https://mint.example", unit: "sat" },
        keysetId,
        5,
        false,
      ),
    ).toEqual({ changed: true, next: 5 });
    expect(
      await counters.advanceToAtLeastInContext(
        { mintUrl: "https://mint.example", unit: "sat" },
        keysetId,
        3,
        false,
      ),
    ).toEqual({ changed: false, next: 5 });
    expect(
      await counters.reserveInContext(
        { mintUrl: "https://mint.example", unit: "sat" },
        keysetId,
        0,
        false,
      ),
    ).toEqual({ start: 5, count: 0 });
  });

  it("advances only the active asset intent when a relevant counter moves", async () => {
    const counters = createStore();
    const database = databases.at(-1)!;
    const proof = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: "https://mint.example",
      unit: "sat",
      proof: {
        id: keysetId,
        amount: 1 as never,
        secret: "counter-active-proof",
        C: `02${"22".repeat(32)}`,
      },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    await database.custodyProofs.add(proof);
    await database.custodyProofBackupAuthorities.add(
      createBrowserProofBackupAuthorityRow(
        proof,
        2,
        { schemaVersion: 1, kind: "nut13", keysetId, counter: 0 },
        "receive:counter",
      ),
    );
    await database.encryptedWalletBackupV2DesiredAssets.add(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId,
        asset: createEncryptedWalletBackupV2AssetIdentity({
          mintUrl: "https://mint.example",
          unit: "sat",
          asset: { kind: "ordinary" },
        }),
        custodyRevision: 1n,
        activeProofCount: 1,
      }),
    );
    const fullProofScan = vi.spyOn(database.custodyProofs, "toArray");

    await counters.advanceToAtLeastInContext(
      { mintUrl: "https://mint.example", unit: "sat" },
      keysetId,
      3,
      false,
    );
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      {
        scopeId,
        assetIdentity: "cashu:ordinary",
        custodyRevision: "2",
        activeProofCount: 1,
        desiredAction: "replace",
      },
    ]);
    await counters.advanceToAtLeastInContext(
      { mintUrl: "https://mint.example", unit: "sat" },
      keysetId,
      3,
      false,
    );
    expect(
      (await database.encryptedWalletBackupV2DesiredAssets.toArray())[0]?.custodyRevision,
    ).toBe("2");
    expect(fullProofScan).not.toHaveBeenCalled();
  });

  it("rejects stale profiles and foreign databases", async () => {
    const stale = createStore({ current: false });
    const foreign = new BitcasterDB(`foreign-${crypto.randomUUID()}`);
    databases.push(foreign);

    await expect(
      stale.reserveInContext({ mintUrl: "https://mint.example", unit: "sat" }, keysetId, 1, false),
    ).rejects.toMatchObject({ code: "stale_profile" });
    expect(() => new BrowserWalletCounterDexieStore({ database: foreign, scopeId })).toThrow(
      /database is foreign/,
    );
  });

  it("bounds association and snapshot rows with typed failures", async () => {
    const counters = createStore();
    for (let index = 0; index < BROWSER_WALLET_COUNTER_ASSOCIATION_MAX; index += 1) {
      await counters.reserveInContext(
        { mintUrl: `https://mint-${index}.example`, unit: "sat" },
        keysetId,
        0,
        false,
      );
    }
    await expect(
      counters.reserveInContext(
        { mintUrl: "https://overflow.example", unit: "sat" },
        keysetId,
        0,
        false,
      ),
    ).rejects.toMatchObject({
      code: "association_limit",
    });

    const database = databases.at(-1)!;
    await database.walletCounterCursors.bulkPut(
      Array.from({ length: BROWSER_WALLET_COUNTER_SNAPSHOT_MAX + 1 }, (_, index) => ({
        scopeId,
        keysetId: `snapshot-${index}`,
        next: 0,
      })),
    );
    await expect(counters.snapshot()).rejects.toMatchObject({ code: "snapshot_limit" });
  });

  it("restores max(local, remote) with proof admission and rolls all writes back on failure", async () => {
    const counters = createStore();
    const database = databases.at(-1)!;
    await counters.advanceToAtLeastInContext(
      { mintUrl: "https://mint.example", unit: "sat" },
      keysetId,
      7,
      false,
    );

    await expect(
      counters.restoreInContext(
        { mintUrl: "https://mint.example", unit: "sat" },
        keysetId,
        11,
        true,
        async () => {
          await database.proofs.put({ secret: "rollback" } as never);
          throw new Error("proof admission failed");
        },
      ),
    ).rejects.toThrow("proof admission failed");

    expect(await counters.snapshot()).toEqual({ [keysetId]: 7 });
    expect(await database.proofs.get("rollback")).toBeUndefined();
    expect(
      await counters.restoreInContext(
        { mintUrl: "https://mint.example", unit: "sat" },
        keysetId,
        5,
        false,
        () => undefined,
      ),
    ).toEqual({ changed: true, next: 7 });
    expect(
      await counters.restoreInContext(
        { mintUrl: "https://mint.example", unit: "sat" },
        keysetId,
        5,
        true,
        async () => database.proofs.put({ secret: "admitted" } as never),
      ),
    ).toEqual({ changed: true, next: 7 });
  });

  it("rolls back restored proofs when the profile changes during admission", async () => {
    const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    databases.push(database);
    let current = true;
    const counters = new BrowserWalletCounterDexieStore({
      database,
      scopeId,
      isCurrentProfile: () => current,
    });

    await expect(
      counters.restoreInContext(
        { mintUrl: "https://mint.example", unit: "sat" },
        keysetId,
        4,
        true,
        async () => {
          await database.proofs.put({ secret: "profile-change" } as never);
          current = false;
        },
      ),
    ).rejects.toMatchObject({ code: "stale_profile" });
    expect(await database.proofs.get("profile-change")).toBeUndefined();
    expect(await database.walletCounterCursors.count()).toBe(0);
    expect(await database.walletCounterAssociations.count()).toBe(0);
  });
});
