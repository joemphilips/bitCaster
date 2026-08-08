// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import { createBrowserCustodyProofRow } from "../durable-custody-db";
import { advanceBrowserV2DesiredAssetsForProofChanges } from "../browser-encrypted-wallet-backup-v2-desired-asset";
import { BitcasterDB } from "../proof-db";

const MINT = "https://mint.example";
const KEYSET = `01${"33".repeat(32)}`;
const PUBLIC_KEY = `02${"22".repeat(32)}`;
let database: BitcasterDB | null = null;

afterEach(async () => {
  database?.close();
  if (database) await database.delete();
  database = null;
});

describe("browser V2 desired asset eligibility", () => {
  it("tracks only active proofs with a deterministic locator", async () => {
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "71".repeat(32),
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const proof = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: { id: KEYSET, amount: 1 as never, secret: "11".repeat(32), C: PUBLIC_KEY },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    const locked = {
      ...proof,
      selectability: "locked" as const,
      reservationOperationId: "order:1",
    };
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: KEYSET,
      counter: 1,
    };

    await advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
      {
        beforeProof: null,
        beforeLocator: null,
        afterProof: locked,
        afterLocator: null,
        payloadChanged: true,
      },
    ]);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);

    await advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
      {
        beforeProof: locked,
        beforeLocator: null,
        afterProof: locked,
        afterLocator: locator,
        payloadChanged: true,
      },
    ]);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      { custodyRevision: "1", activeProofCount: 1, desiredAction: "replace" },
    ]);

    await advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
      {
        beforeProof: locked,
        beforeLocator: locator,
        afterProof: locked,
        afterLocator: null,
        payloadChanged: true,
      },
    ]);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      { custodyRevision: "2", activeProofCount: 0, desiredAction: "remove" },
    ]);
  });
});
