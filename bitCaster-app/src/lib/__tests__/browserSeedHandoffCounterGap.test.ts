// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { BitcasterDB } from "@/stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  BrowserSeedHandoffRefusal,
  browserSeedHandoffCounterGap,
  handoffBrowserSeed,
} from "../browserSeedHandoff";

// Before a seed handoff, the origin browser checks its own counters and
// proofs (ADR-034 recovery index amendment, "Seed handoff"). A GUI restore of
// the old seed stops after 300 unused counters, so a later output is lost to
// it. The browser warns, names the CLI gap, and still permits the handoff.

const SEED = new Uint8Array(64).fill(7);
const SCOPE_ID = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(SEED),
});
const KEYSET = `01${"11".repeat(32)}`;
const OTHER_KEYSET = `01${"22".repeat(32)}`;
const databases: BitcasterDB[] = [];

afterEach(async () => {
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

/** Signed outputs of this browser: proofs with their NUT-13 counters, in any proof state. */
async function signed(database: BitcasterDB, keysetId: string, counters: readonly number[]) {
  await database.walletCounterCursors.put({
    scopeId: SCOPE_ID,
    keysetId,
    next: Math.max(...counters) + 1,
  });
  for (const counter of counters) {
    await database.custodyProofBackupAuthorities.put({
      scopeId: SCOPE_ID,
      proofId: `${keysetId}:${counter}`,
      derivationLocator: { schemaVersion: 1, kind: "nut13", keysetId, counter },
    } as never);
  }
}

function handoff(database: BitcasterDB, acceptCounterGap: boolean, events: string[]) {
  return handoffBrowserSeed({
    database,
    scopeId: SCOPE_ID,
    isCurrentProfile: () => true,
    currentSeedBackupConfirmed: true,
    acceptPartialBackup: false,
    acceptCounterGap,
    prepareRecoveryIndex: async () => ({ kind: "acknowledged", listed: [] }),
    assertNoPendingOrders: () => undefined,
    lockManager: {
      request: async (_name: string, _options: unknown, callback: () => Promise<unknown>) =>
        callback(),
    } as never,
    invalidateOldProfile: () => events.push("invalidate"),
    activateNewProfile: async () => {
      events.push("activate");
    },
    restoreOldProfile: async () => {
      events.push("restore");
    },
  });
}

describe("seed handoff counter gap", () => {
  it("names the CLI gap above the longest run of unused counters before a later output", async () => {
    const database = openDatabase();
    // Runs: 1 (counter 0 to 2), 399 (2 to 402) in one keyset, 299 in the other.
    await signed(database, KEYSET, [0, 2, 402]);
    await signed(database, OTHER_KEYSET, [299]);

    expect(await browserSeedHandoffCounterGap(database, SCOPE_ID)).toEqual({
      longestRun: 399,
      cliGapLimit: 400,
    });
  });

  it("does not warn below 300 unused counters, or for a keyset that is not local", async () => {
    const database = openDatabase();
    await signed(database, KEYSET, [0, 300]);
    // A proof of a keyset without a local cursor.
    await database.custodyProofBackupAuthorities.put({
      scopeId: SCOPE_ID,
      proofId: "foreign",
      derivationLocator: { schemaVersion: 1, kind: "nut13", keysetId: OTHER_KEYSET, counter: 900 },
    } as never);

    expect(await browserSeedHandoffCounterGap(database, SCOPE_ID)).toBeNull();
  });

  it("warns before the commit point, and hands off after the user accepts it", async () => {
    const database = openDatabase();
    await signed(database, KEYSET, [0, 400]);
    const events: string[] = [];

    const refusal = await handoff(database, false, events).catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(BrowserSeedHandoffRefusal);
    expect(refusal).toMatchObject({ code: "counter-gap", cliGapLimit: 400 });
    expect(events).toEqual([]);

    await handoff(openDatabase(), true, events);
    expect(events).toEqual(["invalidate", "activate"]);
  });
});
