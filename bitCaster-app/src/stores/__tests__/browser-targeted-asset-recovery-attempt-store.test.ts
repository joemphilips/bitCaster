// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import {
  BROWSER_TARGETED_ASSET_RECOVERY_ATTEMPTS_MAX_PER_SCOPE,
  BrowserTargetedAssetRecoveryAttemptStore,
  decodeBrowserTargetedAssetRecoveryAttemptRow,
} from "../browser-targeted-asset-recovery-attempt-store";
import { BitcasterDB } from "../proof-db";

const scopeA = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: "11".repeat(32) });
const scopeB = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: "22".repeat(32) });
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

function createStore(scopeId = scopeA, completedAtUnixMilliseconds = () => 1) {
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(database);
  return {
    database,
    store: new BrowserTargetedAssetRecoveryAttemptStore({
      database,
      scopeId,
      completedAtUnixMilliseconds,
    }),
  };
}

function key(index = 1, scopeId = scopeA) {
  return {
    scopeId,
    assetLocator: index.toString(16).padStart(64, "0"),
    backupHeadVersion: index,
    monitoringFactVersion: `fact-${index}`,
  };
}

describe("browser targeted asset recovery attempt store", () => {
  it("persists a completed tuple across a database reload", async () => {
    const { database, store } = createStore();
    const attempt = key();
    await store.recordCompletedAttempt(attempt, "persistent-error");
    database.close();

    const reopened = new BitcasterDB(database.name);
    databases.push(reopened);
    const restarted = new BrowserTargetedAssetRecoveryAttemptStore({
      database: reopened,
      scopeId: scopeA,
      completedAtUnixMilliseconds: () => 2,
    });
    await expect(restarted.readCompletedAttempt(attempt)).resolves.toBe("persistent-error");
  });

  it("isolates attempt rows by wallet scope", async () => {
    const { database, store } = createStore(scopeA);
    const attemptA = key(1, scopeA);
    const attemptB = key(1, scopeB);
    await database.targetedAssetRecoveryAttempts.add({
      ...attemptB,
      outcome: "unavailable",
      completedAtUnixMilliseconds: 1,
    });
    await store.recordCompletedAttempt(attemptA, "restored-mint");

    expect(
      await database.targetedAssetRecoveryAttempts.where("scopeId").equals(scopeA).count(),
    ).toBe(1);
    expect(
      await database.targetedAssetRecoveryAttempts.where("scopeId").equals(scopeB).count(),
    ).toBe(1);
  });

  it("keeps exactly 256 rows per scope and evicts the deterministic oldest row", async () => {
    const { database, store } = createStore(scopeA, () => 10);
    await database.targetedAssetRecoveryAttempts.add({
      ...key(1, scopeB),
      outcome: "unavailable",
      completedAtUnixMilliseconds: 0,
    });
    for (
      let index = 0;
      index <= BROWSER_TARGETED_ASSET_RECOVERY_ATTEMPTS_MAX_PER_SCOPE;
      index += 1
    ) {
      await store.recordCompletedAttempt(key(index), "unavailable");
    }

    expect(
      await database.targetedAssetRecoveryAttempts.where("scopeId").equals(scopeA).count(),
    ).toBe(256);
    expect(
      await database.targetedAssetRecoveryAttempts.where("scopeId").equals(scopeB).count(),
    ).toBe(1);
    await expect(store.readCompletedAttempt(key(0))).resolves.toBeNull();
    await expect(store.readCompletedAttempt(key(1))).resolves.toBe("unavailable");
  });

  it("stores no proof or secret material", async () => {
    const { database, store } = createStore();
    await store.recordCompletedAttempt(key(), "restored-mint");
    const row = (await database.targetedAssetRecoveryAttempts.toArray())[0]!;

    expect(Object.keys(row).sort()).toEqual([
      "assetLocator",
      "backupHeadVersion",
      "completedAtUnixMilliseconds",
      "monitoringFactVersion",
      "outcome",
      "scopeId",
    ]);
    expect(row).not.toHaveProperty("secret");
    expect(() =>
      decodeBrowserTargetedAssetRecoveryAttemptRow({ ...row, secret: "never-store" }),
    ).toThrow();
  });
});
