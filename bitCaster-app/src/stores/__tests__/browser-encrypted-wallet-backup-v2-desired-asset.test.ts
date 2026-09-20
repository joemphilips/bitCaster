// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import { createBrowserCustodyProofRow } from "../durable-custody-db";
import {
  advanceBrowserV2DesiredAssetsForCounter,
  advanceBrowserV2DesiredAssetsForProofChanges,
} from "../browser-encrypted-wallet-backup-v2-desired-asset";
import {
  classifyBrowserProofBackupAuthorityVerifiedLosing,
  createBrowserProofBackupAuthorityRow,
} from "../browser-proof-backup-authority";
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
  it("retains locator-backed verified-losing proof material in the current asset", async () => {
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "72".repeat(32),
    });
    database = new BitcasterDB(browserWalletDatabaseName(scopeId));
    await database.open();
    const active = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      proof: { id: KEYSET, amount: 1 as never, secret: "22".repeat(32), C: PUBLIC_KEY },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    const locator = {
      schemaVersion: 1 as const,
      kind: "nut13" as const,
      keysetId: KEYSET,
      counter: 1,
    };
    const losing = {
      ...active,
      assetKind: "conditional" as const,
      conditionId: "aa".repeat(32),
      outcomeCollection: "YES",
      selectability: "verified-losing" as const,
      revision: 1,
    };
    // The test supplies the exact conditional keyset fact required by the desired-asset reducer.
    await database.custodyConditionalKeysets.put({
      schemaVersion: 1,
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: KEYSET,
      denominationPublicKeys: { "1": PUBLIC_KEY },
      inputFeePpk: 0,
      conditionId: "aa".repeat(32),
      outcomeCollection: "YES",
      outcomeCollectionId: "bb".repeat(32),
      registeredAtUnixSeconds: 1,
      finalExpiryUnixSeconds: 2,
      curve: "secp256k1",
    });
    await advanceBrowserV2DesiredAssetsForProofChanges(database, scopeId, [
      {
        beforeProof: null,
        beforeLocator: null,
        afterProof: losing,
        afterLocator: locator,
        payloadChanged: true,
      },
    ]);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      { custodyRevision: "1", activeProofCount: 1, desiredAction: "replace" },
    ]);
    const locked = {
      ...losing,
      selectability: "locked" as const,
      reservationOperationId: "redeem",
      revision: 0,
    };
    await database.custodyProofs.put(losing);
    await database.custodyProofBackupAuthorities.put(
      classifyBrowserProofBackupAuthorityVerifiedLosing(
        createBrowserProofBackupAuthorityRow(locked, 1, locator, "admission"),
        losing,
        "redeem",
        2,
      ),
    );
    await advanceBrowserV2DesiredAssetsForCounter({
      database,
      scopeId,
      normalizedMint: MINT,
      unit: "msat",
      keysetId: KEYSET,
    });
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toMatchObject([
      { custodyRevision: "2", activeProofCount: 1, desiredAction: "replace" },
    ]);
  });
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
