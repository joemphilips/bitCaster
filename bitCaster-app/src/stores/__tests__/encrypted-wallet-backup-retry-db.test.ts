// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearEncryptedWalletBackupRetryScheduler,
  readEncryptedWalletBackupRetryScheduler,
  scheduleEncryptedWalletBackupRetry,
} from "../encrypted-wallet-backup-retry-db";
import { BitcasterDB } from "../proof-db";

const databases: BitcasterDB[] = [];
const identity = {
  scopeId: "wallet-scope",
  realm: "backup.example.test",
  vaultId: "11".repeat(32),
};

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("encrypted wallet backup retry database", () => {
  it("keeps one strict durable retry schedule for each wallet vault", async () => {
    const database = databaseFor();
    await scheduleEncryptedWalletBackupRetry(database, {
      ...identity,
      attemptId: "77".repeat(16),
      minimumDelayMilliseconds: 5_000,
    });
    await scheduleEncryptedWalletBackupRetry(database, {
      ...identity,
      attemptId: "88".repeat(16),
      minimumDelayMilliseconds: 5_000,
    });

    await expect(readEncryptedWalletBackupRetryScheduler(database, identity)).resolves.toEqual({
      ...identity,
      attemptId: "88".repeat(16),
      retryStreak: 1,
      retryNotBeforeUnixMilliseconds: expect.any(Number),
    });
    expect(await database.encryptedWalletBackupRetrySchedulers.count()).toBe(1);

    await clearEncryptedWalletBackupRetryScheduler(database, {
      ...identity,
      attemptId: "88".repeat(16),
    });
    await expect(readEncryptedWalletBackupRetryScheduler(database, identity)).resolves.toBeNull();
  });
});

function databaseFor(): BitcasterDB {
  const database = new BitcasterDB(`encrypted-wallet-backup-retry-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}
