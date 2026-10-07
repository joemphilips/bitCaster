import { afterEach, expect, it, vi } from "vitest";
import { reimportFixture, evictReimportProofs } from "./fixtures/browserReimportFixture";
import { admitBrowserEncryptedWalletBackupV2Asset } from "../browserEncryptedWalletBackupV2Admission";
import { readBrowserEncryptedWalletBackupV2AssetSnapshot } from "../../stores/browser-encrypted-wallet-backup-v2-asset-source";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import type { BitcasterDB } from "../../stores/proof-db";

let database: BitcasterDB | undefined;
afterEach(async () => {
  await database?.delete();
  vi.unstubAllGlobals();
});

it("retires exact reimport pages while preserving remote proof authority after IndexedDB reload", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected network request");
    }),
  );
  const input = await reimportFixture(33);
  database = input.database;
  await admitBrowserEncryptedWalletBackupV2Asset(input);
  const operationCount = await database.custodyOperations.count();
  const artifactCount = await database.custodyArtifacts.count();
  const counters = JSON.stringify(await database.walletCounterCursors.toArray());
  const desired = JSON.stringify(await database.encryptedWalletBackupV2DesiredAssets.toArray());
  for (const cycle of ["one", "two"]) {
    await evictReimportProofs(database);
    await admitBrowserEncryptedWalletBackupV2Asset({ ...input, randomId: () => cycle });
    database.close();
    await database.open();
    expect(await database.custodyOperations.count()).toBe(operationCount);
    expect(await database.custodyArtifacts.count()).toBe(artifactCount);
    const desiredRow = (await database.encryptedWalletBackupV2DesiredAssets.toArray())[0]!;
    const snapshot = await readBrowserEncryptedWalletBackupV2AssetSnapshot({
      database,
      scopeId: input.scopeId,
      localAssetKey: desiredRow.localAssetKey,
    });
    const expected = new Map(
      input.verified.proofs.map(({ proof }) => [
        proof.secret,
        deriveDurableCustodyArtifactFingerprint(serializeDurableCustodyProofArtifact(proof)),
      ]),
    );
    expect(snapshot.proofs.length).toBe(33);
    expect(
      snapshot.proofs.every(
        ({ proof }) =>
          expected.get(proof.secret) ===
          deriveDurableCustodyArtifactFingerprint(serializeDurableCustodyProofArtifact(proof)),
      ),
    ).toBe(true);
    expect(JSON.stringify(await database.walletCounterCursors.toArray())).toBe(counters);
    expect(await database.custodyProofs.count()).toBe(33);
    expect(await database.proofs.count()).toBe(33);
    const authorities = await database.custodyProofBackupAuthorities.toArray();
    expect(authorities.length).toBe(33);
    expect(
      authorities.every(
        (row) =>
          "backupState" in row &&
          row.backupState === "remote-backed" &&
          row.admissionOperationId === null,
      ),
    ).toBe(true);
    expect(JSON.stringify(await database.encryptedWalletBackupV2DesiredAssets.toArray())).toBe(
      desired,
    );
  }
});

it("rolls back reimport retirement, proofs, authority, and desired state before IndexedDB commit", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("unexpected network request");
    }),
  );
  const input = await reimportFixture();
  database = input.database;
  await admitBrowserEncryptedWalletBackupV2Asset(input);
  await evictReimportProofs(database);
  const operationCount = await database.custodyOperations.count();
  const artifactCount = await database.custodyArtifacts.count();
  const counters = JSON.stringify(await database.walletCounterCursors.toArray());
  const desired = JSON.stringify(await database.encryptedWalletBackupV2DesiredAssets.toArray());
  await expect(
    admitBrowserEncryptedWalletBackupV2Asset({
      ...input,
      randomId: () => "rollback",
      fault: "before-commit",
    }),
  ).rejects.toThrow("injected commit fault");
  database.close();
  await database.open();
  expect(await database.custodyOperations.count()).toBe(operationCount);
  expect(await database.custodyArtifacts.count()).toBe(artifactCount);
  expect(JSON.stringify(await database.walletCounterCursors.toArray())).toBe(counters);
  expect(await database.custodyProofs.count()).toBe(0);
  expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
  expect(await database.proofs.count()).toBe(0);
  expect(JSON.stringify(await database.encryptedWalletBackupV2DesiredAssets.toArray())).toBe(
    desired,
  );
  await admitBrowserEncryptedWalletBackupV2Asset({ ...input, randomId: () => "rollback" });
  expect(await database.custodyOperations.count()).toBe(operationCount);
  expect(await database.custodyArtifacts.count()).toBe(artifactCount);
  expect(await database.custodyProofs.count()).toBe(1);
});
