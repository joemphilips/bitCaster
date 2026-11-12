// @vitest-environment node
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeDurableCustodyScopeInput,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { decodeBrowserProofBackupAuthorityTableRow } from "../browser-proof-backup-authority";
import { BrowserWalletCounterDexieStore } from "../browser-wallet-counter-db";
import { BrowserDurableCustodyAdapter } from "../durable-custody-db";
import { decodeBrowserCustodyConditionalKeysetRow } from "../durable-custody-types";
import { MarketDraftImageStore } from "../marketDraftImage";
import {
  activateBrowserWalletDatabase,
  BitcasterDB,
  db,
  getCanonicalCurrentProofs,
  getProofOperation,
  getProofs,
} from "../proof-db";
import {
  deleteSeedRestoreDatabase,
  isBrowserSeedGeneratedHere,
  SeedRestoreDB,
  seedRestoreDatabaseName,
} from "../seed-restore-db";

// Production browser state is permanent (ADR-049). The fixture holds the
// browser databases that release 4 (bitCaster 52d412a1, the tree of the CLI
// release cli-v0.1.0-afaa6cc6aa6b) shipped: each database name, its Dexie
// version, the schema of each table, and its rows. Every shipped table holds
// at least one row. A generator in a git archive export of 52d412a1 wrote the
// custody, backup desired-asset, counter, legacy proof, proof operation, draft
// image, and most seed restore rows with the shipped writers. It wrote the
// other rows as shape rows of the shipped row interfaces, so that a clearing
// upgrade or a changed key of any table fails. The "writer" field of each
// table names its source. Do not regenerate the fixture: it fixes the
// deployed form.

interface ShippedTable {
  readonly name: string;
  readonly schema: string;
  readonly writer: string;
  readonly rows: readonly Record<string, unknown>[];
}

interface ShippedDatabase {
  readonly name: string;
  readonly version: number;
  readonly tables: readonly ShippedTable[];
}

interface ShippedFixture {
  readonly scopeId: string;
  readonly databases: readonly ShippedDatabase[];
}

const MINT = "https://mint.example";
const KEYSET = `01${"33".repeat(32)}`;
const shipped = decode(
  JSON.parse(
    readFileSync(new URL("./fixtures/release4-wallet-databases.json", import.meta.url), "utf8"),
  ),
) as ShippedFixture;
const [wallet, seedRestore, draftImages] = shipped.databases as [
  ShippedDatabase,
  ShippedDatabase,
  ShippedDatabase,
];
const scope: DurableCustodyScope = {
  ...(decodeDurableCustodyScopeInput(shipped.scopeId) as { scopeKind: "wallet"; walletId: string }),
  scopeId: shipped.scopeId,
};

/** The fixture encodes the structured-clone values that JSON cannot hold. */
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.$undefined === true) return undefined;
    if (typeof record.$uint8array === "string")
      return new Uint8Array(Buffer.from(record.$uint8array, "base64"));
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decode(item)]));
  }
  return value;
}

function table(database: ShippedDatabase, name: string): ShippedTable {
  const found = database.tables.find((item) => item.name === name);
  if (!found) throw new Error(`the shipped database has no ${name} table`);
  return found;
}

/** Creates one database exactly as release 4 left it, without the current code. */
async function createShipped(database: ShippedDatabase): Promise<void> {
  const legacy = new Dexie(database.name);
  legacy
    .version(database.version)
    .stores(Object.fromEntries(database.tables.map((item) => [item.name, item.schema])));
  await legacy.open();
  await legacy.transaction("rw", legacy.tables, async () => {
    for (const item of database.tables) await legacy.table(item.name).bulkAdd([...item.rows]);
  });
  legacy.close();
}

/**
 * The tables of the encrypted proof backup and its targeted recovery. Release
 * 5b drops them in one forward-only version (ADR-034 recovery index
 * amendment, "No data migration"). No deployed build had a backup
 * configuration, so they hold no user data.
 */
const DROPPED_WALLET_TABLES = new Set([
  "encryptedWalletBackupV2DesiredAssets",
  "encryptedWalletBackupWalletEnrollmentResults",
  "encryptedWalletBackupWalletRetrySchedulers",
  "encryptedWalletBackupV2WalletPreparedMutations",
  "encryptedWalletBackupV2WalletAcceptedHeads",
  "encryptedWalletBackupV2WalletAssetReceipts",
  "encryptedWalletBackupV2WalletActiveDescriptors",
  "targetedAssetRecoveryAttempts",
  "encryptedWalletBackupOwnerEnrollmentResults",
  "encryptedWalletBackupOwnerRetrySchedulers",
  "encryptedWalletBackupOwnerPreparedMutations",
  "encryptedWalletBackupOwnerAcceptedHeads",
  "encryptedWalletBackupOwnerAssetReceipts",
  "encryptedWalletBackupOwnerActiveDescriptors",
  "encryptedWalletBackupOwnerDesiredAssets",
  "encryptedWalletBackupOwnerProofCoverage",
]);

/**
 * Every kept shipped table still exists in the current schema and holds
 * exactly its shipped rows. Each dropped table is gone.
 */
async function expectEveryShippedRow(
  current: Dexie,
  database: ShippedDatabase,
  dropped: ReadonlySet<string> = new Set(),
): Promise<void> {
  expect(current.verno).toBeGreaterThanOrEqual(database.version);
  const kept = database.tables.filter(({ name }) => !dropped.has(name));
  expect(kept.length + dropped.size).toBe(database.tables.length);
  const currentNames = current.tables.map(({ name }) => name);
  expect(currentNames).toEqual(expect.arrayContaining(kept.map(({ name }) => name)));
  for (const name of dropped) expect(currentNames, name).not.toContain(name);
  for (const item of kept) {
    expect(item.rows.length, item.name).toBeGreaterThan(0);
    expect(await current.table(item.name).toArray(), item.name).toEqual(item.rows);
  }
}

afterEach(async () => {
  db.close();
  await deleteSeedRestoreDatabase(scope.scopeId);
  await Promise.all(shipped.databases.map(({ name }) => Dexie.delete(name)));
});

describe("release 4 browser databases", () => {
  it("opens the shipped wallet database, drops the backup tables, and reads every kept row", async () => {
    expect(wallet.version).toBe(21);
    expect(browserWalletDatabaseName(scope.scopeId)).toBe(wallet.name);
    await createShipped(wallet);

    const current = new BitcasterDB(wallet.name);
    try {
      await current.open();
      expect(current.verno).toBe(22);
      await expectEveryShippedRow(current, wallet, DROPPED_WALLET_TABLES);

      // The canonical custody proofs: one regular and one outcome proof.
      const proofs = await getCanonicalCurrentProofs(scope.scopeId, current);
      expect(
        proofs
          ?.map((proof) => ({
            secret: proof.secret,
            amount: amountToNumber(proof.amount),
            unit: proof.unit,
            conditionId: proof.conditionId,
            outcomeCollection: proof.outcomeCollection,
          }))
          .sort((left, right) => left.secret.localeCompare(right.secret)),
      ).toEqual([
        {
          secret: "release4-conditional-proof",
          amount: 1,
          unit: "msat",
          conditionId: "aa".repeat(32),
          outcomeCollection: "YES",
        },
        {
          secret: "release4-regular-proof",
          amount: 8,
          unit: "sat",
          conditionId: undefined,
          outcomeCollection: undefined,
        },
      ]);

      // Each proof body still binds its backup authority, and each operation its artifacts.
      const adapter = new BrowserDurableCustodyAdapter(current);
      for (const row of table(wallet, "custodyProofs").rows) {
        const proof = await adapter.readProof(scope.scopeId, row.proofId as string);
        expect(proof?.proofFingerprint).toBe(row.proofFingerprint);
      }
      for (const row of table(wallet, "custodyProofBackupAuthorities").rows) {
        expect(() => decodeBrowserProofBackupAuthorityTableRow(row)).not.toThrow();
      }
      for (const row of table(wallet, "custodyConditionalKeysets").rows) {
        expect(() => decodeBrowserCustodyConditionalKeysetRow(row)).not.toThrow();
      }
      for (const row of table(wallet, "custodyOperations").rows) {
        const snapshot = await adapter.readOperationSnapshot(scope, row.operationId as string);
        expect(snapshot?.record.operation.operationId).toBe(row.operationId);
      }

      // The NUT-13 cursor keeps its next counter, so no output is derived twice.
      const counters = new BrowserWalletCounterDexieStore({
        database: current,
        scopeId: scope.scopeId,
      });
      expect(await counters.snapshot()).toEqual({ [KEYSET]: 8 });
      expect(await counters.isRecoveryComplete({ mintUrl: MINT, unit: "sat" }, KEYSET)).toBe(false);

      expect((await getProofOperation("release4-send-operation", current))?.state).toBe("prepared");
    } finally {
      current.close();
    }

    // The active wallet database reads the legacy proofs cache.
    activateBrowserWalletDatabase(scope.scopeId);
    expect(
      (await getProofs(MINT)).map((proof) => ({
        secret: proof.secret,
        amount: amountToNumber(proof.amount),
      })),
    ).toEqual([{ secret: "release4-legacy-proof", amount: 4 }]);
  });

  it("opens the shipped seed restore database with every row", async () => {
    expect(seedRestore.version).toBe(2);
    expect(seedRestoreDatabaseName(scope.scopeId)).toBe(seedRestore.name);
    await createShipped(seedRestore);

    const current = new SeedRestoreDB(seedRestore.name);
    try {
      await current.open();
      await expectEveryShippedRow(current, seedRestore);
    } finally {
      current.close();
    }
    // A lost "generated" origin would start a restore scan of this seed.
    expect(await isBrowserSeedGeneratedHere(scope.scopeId)).toBe(true);
  });

  it("opens the shipped market draft image database with its thumbnail", async () => {
    expect(draftImages.version).toBe(1);
    await createShipped(draftImages);

    const current = new MarketDraftImageStore();
    try {
      expect(current.name).toBe(draftImages.name);
      await current.open();
      await expectEveryShippedRow(current, draftImages);
      const thumbnail = await current.read("release4-selection");
      expect(thumbnail.filename).toBe("thumb.png");
      expect(thumbnail.contentType).toBe("image/png");
      expect([...thumbnail.data]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    } finally {
      current.close();
    }
  });
});
