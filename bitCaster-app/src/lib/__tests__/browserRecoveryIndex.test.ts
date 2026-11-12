// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  deriveRecoveryIndexKeys,
  openRecoveryIndexDocument,
  sealRecoveryIndexDocument,
  type RecoveryIndexEntry,
} from "@bitcaster/client-sdk/recoveryIndexDocument";
import { RECOVERY_INDEX_REALMS } from "@bitcaster/client-sdk/recoveryIndexEngine";
import {
  problem,
  RecoveryIndexFakeEngine,
} from "../../../../bitcaster-client-sdk/test/support/recoveryIndexFakeEngine";
import { subscribeToLocalKeysetChanges } from "@/hooks/useBrowserRecoveryIndex";
import { BrowserWalletCounterDexieStore } from "@/stores/browser-wallet-counter-db";
import { BitcasterDB } from "@/stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  BrowserRecoveryIndex,
  browserRecoveryIndexListsEveryLocalKeyset,
  browserRecoveryIndexRealm,
  readBrowserRecoveryIndexAfterMintRefusal,
  readBrowserRecoveryIndexLocalEntries,
  registerBrowserRecoveryIndex,
} from "../browserRecoveryIndex";

const SEED = new Uint8Array(64).fill(5);
const REALM = RECOVERY_INDEX_REALMS.local;
const KEYS = deriveRecoveryIndexKeys(SEED, REALM);
const SCOPE_ID = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(SEED),
});
const MINT = "https://mint.example";
const NOW_MS = 1_800_000_000_000;
const REGULAR = `01${"11".repeat(32)}`;
const OTHER_REGULAR = `01${"22".repeat(32)}`;
const CONDITIONAL = `01${"33".repeat(32)}`;
const CONDITION_ID = "ab".repeat(32);
const CONDITIONAL_ENTRY: RecoveryIndexEntry = {
  kind: "conditional",
  mintUrl: MINT,
  keysetId: CONDITIONAL,
  conditionId: CONDITION_ID,
  outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
    conditionId: CONDITION_ID,
    outcomeCollection: "YES",
  }),
};
const CONDITIONAL_CONTEXT = {
  mintUrl: MINT,
  unit: "msat",
  conditional: { conditionId: CONDITION_ID, outcomeCollection: "YES" },
} as const;
const databases: BitcasterDB[] = [];
const runtimes: BrowserRecoveryIndex[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.stop();
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

function openDatabase(): BitcasterDB {
  const database = new BitcasterDB(browserWalletDatabaseName(SCOPE_ID));
  databases.push(database);
  return database;
}

/** A tab or a browser of the seed. Each browser has its own database name. */
function runtime(
  engine: RecoveryIndexFakeEngine,
  database: BitcasterDB,
  options: {
    readonly lockManager?: Pick<LockManager, "request"> | null;
    readonly timers?: Array<{ callback: () => void; delayMs: number }>;
    readonly clock?: { nowMs: number };
  } = {},
) {
  const clock = options.clock ?? { nowMs: NOW_MS };
  const index = new BrowserRecoveryIndex({
    database,
    scopeId: SCOPE_ID,
    seed: SEED,
    realm: REALM,
    walletMints: () => [MINT],
    regularKeysetAuthority: () => null,
    fetchImpl: engine.fetch,
    engineBaseUrl: engine.baseUrl,
    lockManager: options.lockManager ?? null,
    nowMs: () => clock.nowMs,
    random: () => 0,
    setTimer: (callback, delayMs) => {
      options.timers?.push({ callback, delayMs });
      return options.timers?.length ?? 0;
    },
    clearTimer: () => undefined,
  });
  runtimes.push(index);
  return index;
}

function counters(database: BitcasterDB) {
  return new BrowserWalletCounterDexieStore({ database, scopeId: SCOPE_ID });
}

function storedEntries(engine: RecoveryIndexFakeEngine): readonly RecoveryIndexEntry[] {
  const row = engine.rows.get(KEYS.locatorPublicKey);
  if (row?.document == null) return [];
  return openRecoveryIndexDocument({
    keys: KEYS,
    document: row.document,
    storeVersion: row.version,
  });
}

function keysetIds(entries: readonly RecoveryIndexEntry[]): string[] {
  return entries.map(({ keysetId }) => keysetId).sort();
}

/** An exclusive in-process lock manager that records how many holders overlap. */
function sharedLockManager() {
  const tails = new Map<string, Promise<unknown>>();
  const state = { held: 0, maxHeld: 0 };
  const manager = {
    request: (async (
      name: string,
      _options: LockOptions,
      callback: LockGrantedCallback<unknown>,
    ) => {
      const previous = tails.get(name) ?? Promise.resolve();
      let release!: () => void;
      const done = new Promise<void>((resolve) => (release = resolve));
      tails.set(
        name,
        previous.then(() => done),
      );
      await previous;
      state.held += 1;
      state.maxHeld = Math.max(state.maxHeld, state.held);
      try {
        return await callback(null);
      } finally {
        state.held -= 1;
        release();
      }
    }) as LockManager["request"],
  };
  return { manager, state };
}

describe("browser recovery index", () => {
  it("lists each keyset with a counter cursor in the form of its index entry", async () => {
    const database = openDatabase();
    await counters(database).reserveInContext({ mintUrl: MINT, unit: "msat" }, REGULAR, 2, false);
    await counters(database).reserveInContext(
      { mintUrl: MINT, unit: "msat" },
      CONDITIONAL,
      1,
      false,
    );
    // An order records the NUT-CTF identity of its keysets.
    const association = await database.walletCounterAssociations.get([
      SCOPE_ID,
      MINT,
      "msat",
      CONDITIONAL,
    ]);
    await database.walletCounterAssociations.put({
      ...association!,
      conditional: { conditionId: CONDITION_ID, outcomeCollection: "YES" },
    });
    // An association without a cursor holds no output of this browser.
    await counters(database).restoreInContext(
      { mintUrl: MINT, unit: "msat" },
      OTHER_REGULAR,
      0,
      false,
      () => undefined,
    );

    expect(await readBrowserRecoveryIndexLocalEntries(database, SCOPE_ID)).toEqual([
      { kind: "regular", mintUrl: MINT, keysetId: REGULAR },
      {
        kind: "conditional",
        mintUrl: MINT,
        keysetId: CONDITIONAL,
        conditionId: CONDITION_ID,
        outcomeCollectionId: deriveRootCtfOutcomeCollectionId({
          conditionId: CONDITION_ID,
          outcomeCollection: "YES",
        }),
      },
    ]);
  });

  it("reserves counters while the engine is down and uploads at the retry the SDK schedules", async () => {
    const engine = new RecoveryIndexFakeEngine(REALM);
    engine.nowSeconds = NOW_MS / 1000;
    const database = openDatabase();
    const timers: Array<{ callback: () => void; delayMs: number }> = [];
    const clock = { nowMs: NOW_MS };
    const index = runtime(engine, database, { timers, clock });
    const stop = subscribeToLocalKeysetChanges(database, () => index.requestUpload());
    try {
      engine.interruptions.push(() => Promise.reject(new TypeError("engine down")));

      // A funded operation: the first reservation of a keyset makes it pending.
      await expect(
        counters(database).reserveInContext({ mintUrl: MINT, unit: "msat" }, REGULAR, 3, false),
      ).resolves.toEqual({ start: 0, count: 3 });
      // The commit asks for the upload. Nothing awaited it.
      await expect.poll(() => index.status.kind).toBe("pending");
      await index.settled();
      expect(engine.count("PUT")).toBe(0);
      // The ADR-034 schedule: a 5-second base for the first failure.
      expect(timers.map(({ delayMs }) => delayMs)).toEqual([5_000]);
      expect(await database.walletCounterCursors.get([SCOPE_ID, REGULAR])).toMatchObject({
        next: 3,
      });

      clock.nowMs += timers[0]!.delayMs;
      timers[0]!.callback();
      await index.settled();
      expect(index.status).toEqual({ kind: "current" });
      expect(keysetIds(storedEntries(engine))).toEqual([REGULAR]);
    } finally {
      stop();
    }
  });

  it("writes nothing for a later reservation in a listed keyset", async () => {
    const engine = new RecoveryIndexFakeEngine(REALM);
    engine.nowSeconds = NOW_MS / 1000;
    const database = openDatabase();
    const index = runtime(engine, database);
    const stop = subscribeToLocalKeysetChanges(database, () => index.requestUpload());
    try {
      await counters(database).reserveInContext({ mintUrl: MINT, unit: "msat" }, REGULAR, 1, false);
      await expect.poll(() => index.status.kind).toBe("current");
      expect(engine.count("PUT")).toBe(1);

      await counters(database).reserveInContext({ mintUrl: MINT, unit: "msat" }, REGULAR, 5, false);
      index.requestUpload();
      await index.settled();
      expect(engine.count("PUT")).toBe(1);
    } finally {
      stop();
    }
  });

  it("converges two tabs on one index with at most one upload in flight", async () => {
    const engine = new RecoveryIndexFakeEngine(REALM);
    engine.nowSeconds = NOW_MS / 1000;
    const { manager, state } = sharedLockManager();
    const database = openDatabase();
    const firstTab = runtime(engine, database, { lockManager: manager });
    const secondTab = runtime(engine, openDatabase(), { lockManager: manager });
    await counters(database).reserveInContext({ mintUrl: MINT, unit: "msat" }, REGULAR, 1, false);
    await counters(database).reserveInContext(
      { mintUrl: MINT, unit: "msat" },
      OTHER_REGULAR,
      1,
      false,
    );

    firstTab.requestUpload();
    secondTab.requestUpload();
    await Promise.all([firstTab.settled(), secondTab.settled()]);

    expect(state.maxHeld).toBe(1);
    expect(keysetIds(storedEntries(engine))).toEqual([REGULAR, OTHER_REGULAR].sort());
    // The second tab read the acknowledged index and had nothing to write.
    expect(engine.count("PUT")).toBe(1);
    expect(firstTab.status).toEqual({ kind: "current" });
    expect(secondTab.status).toEqual({ kind: "current" });
  });

  it("merges the keysets of two browsers of one seed", async () => {
    const engine = new RecoveryIndexFakeEngine(REALM);
    engine.nowSeconds = NOW_MS / 1000;
    const first = new BitcasterDB(`${browserWalletDatabaseName(SCOPE_ID)}-browser-a`);
    const second = new BitcasterDB(`${browserWalletDatabaseName(SCOPE_ID)}-browser-b`);
    databases.push(first, second);
    await first.walletCounterCursors.put({ scopeId: SCOPE_ID, keysetId: REGULAR, next: 1 });
    await first.walletCounterAssociations.put({
      scopeId: SCOPE_ID,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: REGULAR,
      recoveryComplete: true,
    });
    await second.walletCounterCursors.put({ scopeId: SCOPE_ID, keysetId: OTHER_REGULAR, next: 1 });
    await second.walletCounterAssociations.put({
      scopeId: SCOPE_ID,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: OTHER_REGULAR,
      recoveryComplete: true,
    });

    const browserA = runtime(engine, first);
    const browserB = runtime(engine, second);
    browserA.requestUpload();
    await browserA.settled();
    browserB.requestUpload();
    await browserB.settled();

    expect(keysetIds(storedEntries(engine))).toEqual([REGULAR, OTHER_REGULAR].sort());
  });

  it("reads the index again after a mint refusal that shows another client", async () => {
    const engine = new RecoveryIndexFakeEngine(REALM);
    engine.nowSeconds = NOW_MS / 1000;
    const index = runtime(engine, openDatabase());
    const unregister = registerBrowserRecoveryIndex(SCOPE_ID, index);
    try {
      await index.read("wallet-open");
      await index.settled();
      const reads = engine.count("GET");

      readBrowserRecoveryIndexAfterMintRefusal(SCOPE_ID, 12002);
      await index.settled();
      expect(engine.count("GET")).toBe(reads);

      readBrowserRecoveryIndexAfterMintRefusal(SCOPE_ID, 11008);
      await expect.poll(() => engine.count("GET")).toBe(reads + 1);
    } finally {
      unregister();
    }
  });

  it.each([
    {
      label: "acknowledged",
      setUp: () => undefined,
      expected: "acknowledged",
    },
    {
      label: "refused as a limited growing write",
      setUp: (engine: RecoveryIndexFakeEngine) =>
        engine.interruptions.push(
          // The read of the handoff, then the refused write.
          () => problem(404, "recovery-index-not-found", { currentVersion: 0 }),
          () =>
            problem(
              429,
              "recovery-index-limited",
              { limitCode: "stored-bytes" },
              {
                "Retry-After": "60",
              },
            ),
        ),
      expected: "growing-write-refused",
    },
    {
      label: "unavailable",
      setUp: (engine: RecoveryIndexFakeEngine) =>
        engine.interruptions.push(() => Promise.reject(new TypeError("engine down"))),
      expected: "unavailable",
    },
  ])("reports the seed handoff gate as $label", async ({ setUp, expected }) => {
    const engine = new RecoveryIndexFakeEngine(REALM);
    engine.nowSeconds = NOW_MS / 1000;
    const database = openDatabase();
    await counters(database).reserveInContext({ mintUrl: MINT, unit: "msat" }, REGULAR, 1, false);
    const index = runtime(engine, database);
    setUp(engine);

    const gate = await index.prepareSeedHandoff();

    expect(gate.kind).toBe(expected);
    if (gate.kind === "acknowledged") {
      expect(keysetIds(gate.listed)).toEqual([REGULAR]);
      expect(await browserRecoveryIndexListsEveryLocalKeyset(database, SCOPE_ID, gate.listed)).toBe(
        true,
      );
      // A keyset that a later operation added is pending again.
      await counters(database).reserveInContext(
        { mintUrl: MINT, unit: "msat" },
        OTHER_REGULAR,
        1,
        false,
      );
      expect(await browserRecoveryIndexListsEveryLocalKeyset(database, SCOPE_ID, gate.listed)).toBe(
        false,
      );
    }
  });

  it("writes a conditional receive into a new keyset in the conditional form before custody admits a proof", async () => {
    const engine = new RecoveryIndexFakeEngine(REALM);
    engine.nowSeconds = NOW_MS / 1000;
    const database = openDatabase();
    const index = runtime(engine, database);
    const stop = subscribeToLocalKeysetChanges(database, () => index.requestUpload());
    try {
      // The counter recovery of the keyset found no output: an association, no cursor.
      await counters(database).restoreInContext(
        { mintUrl: MINT, unit: "msat" },
        CONDITIONAL,
        0,
        false,
        () => undefined,
      );
      // The receive commits its counter with the swap. The custody table has
      // no row for the keyset yet.
      await database.transaction(
        "rw",
        [database.walletCounterAssociations, database.walletCounterCursors],
        () =>
          counters(database).compareAndAdvanceInCurrentTransaction(
            Dexie.currentTransaction!,
            CONDITIONAL_CONTEXT,
            { keysetId: CONDITIONAL, expectedNextCounter: null, nextCounter: 2 },
          ),
      );
      await index.settled();

      expect(await database.custodyConditionalKeysets.count()).toBe(0);
      expect(storedEntries(engine)).toEqual([CONDITIONAL_ENTRY]);
      expect(index.status).toEqual({ kind: "current" });
    } finally {
      stop();
    }
  });

  it("corrects a stored regular-form entry of a conditional keyset at the next write", async () => {
    const engine = new RecoveryIndexFakeEngine(REALM);
    engine.nowSeconds = NOW_MS / 1000;
    // A faulty writer listed the conditional keyset in the regular form.
    engine.rows.set(KEYS.locatorPublicKey, {
      version: 1,
      document: sealRecoveryIndexDocument({
        keys: KEYS,
        entries: [{ kind: "regular", mintUrl: MINT, keysetId: CONDITIONAL }],
        writtenVersion: 1,
      }),
    });
    const database = openDatabase();
    await counters(database).reserveInContext(CONDITIONAL_CONTEXT, CONDITIONAL, 1, false);
    const index = runtime(engine, database);

    index.requestUpload();
    await index.settled();

    expect(storedEntries(engine)).toEqual([CONDITIONAL_ENTRY]);
    expect(engine.rows.get(KEYS.locatorPublicKey)?.version).toBe(2);
  });

  it("lets a seed handoff pass when the index lists a keyset in a form this browser cannot check", async () => {
    const database = openDatabase();
    // The association of this browser lacks the NUT-CTF identity of the keyset.
    await counters(database).reserveInContext(
      { mintUrl: MINT, unit: "msat" },
      CONDITIONAL,
      1,
      false,
    );

    // Another browser listed it with its identity, so a restore scans it.
    expect(
      await browserRecoveryIndexListsEveryLocalKeyset(database, SCOPE_ID, [CONDITIONAL_ENTRY]),
    ).toBe(true);
  });

  it("shows a persistent error and writes nothing over a document it cannot decode", async () => {
    const engine = new RecoveryIndexFakeEngine(REALM);
    engine.nowSeconds = NOW_MS / 1000;
    const otherKeys = deriveRecoveryIndexKeys(new Uint8Array(64).fill(6), REALM);
    const { sealRecoveryIndexDocument } =
      await import("@bitcaster/client-sdk/recoveryIndexDocument");
    // A document under the same locator that this seed's key cannot open.
    engine.rows.set(KEYS.locatorPublicKey, {
      version: 1,
      document: sealRecoveryIndexDocument({
        keys: otherKeys,
        entries: [{ kind: "regular", mintUrl: MINT, keysetId: OTHER_REGULAR }],
        writtenVersion: 1,
      }),
    });
    const database = openDatabase();
    await counters(database).reserveInContext({ mintUrl: MINT, unit: "msat" }, REGULAR, 1, false);
    const index = runtime(engine, database);

    await index.read("wallet-open");
    await index.settled();

    expect(index.status).toEqual({ kind: "blocked", reason: "undecodable" });
    expect(engine.count("PUT")).toBe(0);
  });

  it("uses the realm of the build, and the local realm only in development", () => {
    expect(browserRecoveryIndexRealm({ VITE_RECOVERY_INDEX_REALM: "bitcaster-production" })).toBe(
      "bitcaster-production",
    );
    expect(browserRecoveryIndexRealm({ DEV: true })).toBe("bitcaster-local");
    expect(browserRecoveryIndexRealm({ DEV: false })).toBeNull();
    expect(browserRecoveryIndexRealm({ VITE_RECOVERY_INDEX_REALM: "bitcaster.local" })).toBeNull();
  });
});
