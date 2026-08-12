// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { EncryptedWalletBackupEnrollmentDexieStore } from "../encrypted-wallet-backup-enrollment-db";
import { BitcasterDB } from "../proof-db";

const realm = "backup-test";
const walletId = "11".repeat(32);
const requestAuthPublicKey = "33".repeat(32);
const scopeId = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(new Uint8Array(64).fill(7)),
});
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("encrypted wallet backup enrollment Dexie store", () => {
  it("keeps one exact latest receipt across restart and rejects stale or conflicting replacement", async () => {
    const database = openDatabase();
    const store = new EncryptedWalletBackupEnrollmentDexieStore({
      database,
      scopeId,
      realm,
      walletId,
      requestAuthPublicKey,
    });
    const initial = receipt(2, "11");
    const committed = await store.commitAccountOperationResult(initial, (stored) => stored);
    expect(committed).toEqual(initial);
    await expect(store.commitAccountOperationResult(receipt(1, "22"), (x) => x)).rejects.toThrow(
      /stale/,
    );
    await expect(
      store.commitAccountOperationResult({ ...initial, operationId: "22".repeat(16) }, (x) => x),
    ).rejects.toThrow(/conflicts/);
    await expect(
      store.commitAccountOperationResult(
        { ...receipt(3, "33"), requestAuthPublicKey: "44".repeat(32) },
        (x) => x,
      ),
    ).rejects.toThrow(/invalid/);

    database.close();
    const restarted = new BitcasterDB(database.name);
    databases.push(restarted);
    const resumed = new EncryptedWalletBackupEnrollmentDexieStore({
      database: restarted,
      scopeId,
      realm,
      walletId,
      requestAuthPublicKey,
    });
    expect(await resumed.read()).toEqual(initial);
    expect(
      await resumed.commitAccountOperationResult(receipt(3, "22"), (stored) => stored),
    ).toEqual(receipt(3, "22"));
    expect(await resumed.read()).toEqual(receipt(3, "22"));
  });

  it("rolls back when the profile becomes stale before the transaction commits", async () => {
    const database = openDatabase();
    let checks = 0;
    const store = new EncryptedWalletBackupEnrollmentDexieStore({
      database,
      scopeId,
      realm,
      walletId,
      requestAuthPublicKey,
      beforeCommit: () => {
        checks += 1;
        if (checks === 2) throw new Error("profile is stale");
      },
    });

    await expect(store.commitAccountOperationResult(receipt(2, "11"), (x) => x)).rejects.toThrow(
      /profile is stale/,
    );
    expect(await database.encryptedWalletBackupEnrollmentResults.count()).toBe(0);
  });
});

function openDatabase(): BitcasterDB {
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  databases.push(database);
  return database;
}

function receipt(epoch: number, byte: string) {
  return {
    schemaVersion: 1 as const,
    operationId: byte.repeat(16),
    intentDigest: byte.repeat(32),
    action: "enroll" as const,
    realm,
    walletId,
    requestAuthPublicKey,
    expectedEnrollmentEpoch: 0,
    observedEnrollmentEpoch: epoch,
    lifecycle: "active" as const,
    result: "committed" as const,
  };
}
