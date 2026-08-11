// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
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

const scopeId = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: "11".repeat(32) });
const keysetId = `01${"aa".repeat(32)}`;
const v3KeysetId = `02${"aa".repeat(32)}`;
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

function createStore(options: { current?: boolean; name?: string } = {}) {
  const database = new BitcasterDB(options.name ?? browserWalletDatabaseName(scopeId));
  databases.push(database);
  return new BrowserWalletCounterDexieStore({
    database,
    scopeId,
    isCurrentProfile: () => options.current ?? true,
  });
}

describe("browser wallet counter authority", () => {
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
