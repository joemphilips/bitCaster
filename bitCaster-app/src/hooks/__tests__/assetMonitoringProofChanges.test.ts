// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { subscribeToCommittedProofChanges } from "../useAssetMonitoringReporter";
import { BitcasterDB } from "@/stores/proof-db";

const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

it("reports committed proof writes once per transaction and ignores aborts", async () => {
  const database = createDatabase();
  const callback = vi.fn();
  const unsubscribe = subscribeToCommittedProofChanges(database, callback);

  await database.proofs.add(proof("one"));
  await database.proofs.update("one", { mintUrl: "https://mint.changed.example" });
  await database.proofs.delete("one");
  await database.transaction("rw", database.proofs, async () => {
    await database.proofs.add(proof("two"));
    await database.proofs.add(proof("three"));
  });
  expect(callback).toHaveBeenCalledTimes(4);

  await expect(
    database.transaction("rw", database.proofs, async () => {
      await database.proofs.add(proof("aborted"));
      throw new Error("abort test transaction");
    }),
  ).rejects.toThrow("abort test transaction");
  expect(callback).toHaveBeenCalledTimes(4);

  unsubscribe();
  await database.proofs.add(proof("after-unsubscribe"));
  expect(callback).toHaveBeenCalledTimes(4);
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`asset-monitoring-proof-changes-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

function proof(secret: string) {
  return {
    secret,
    C: `C-${secret}`,
    id: "keyset",
    amount: 1,
    mintUrl: "https://mint.example",
  };
}
