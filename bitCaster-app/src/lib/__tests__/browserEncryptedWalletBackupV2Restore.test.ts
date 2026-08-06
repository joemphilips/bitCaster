// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount, type Wallet as CashuWallet } from "@cashu/cashu-ts";
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  type EncryptedWalletBackupV2RemotePort,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveDurableWalletProofSecret } from "@bitcaster/client-sdk/durableWalletProofDerivationLocator";
import { afterEach, expect, it, vi } from "vitest";
import { BitcasterDB } from "../../stores/proof-db";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset,
  restoreBrowserEncryptedWalletBackupV2TargetedAsset,
} from "../browserEncryptedWalletBackupV2Restore";

const SEED = new Uint8Array(64).fill(7);
const KEYSET = `01${"22".repeat(32)}`;
const openDatabases: BitcasterDB[] = [];
let fixtureSequence = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

it("restores one current bundle with fresh sequential object proofs", async () => {
  const fixture = await backupFixture();
  const result = await restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input);
  expect(result).toMatchObject({
    kind: "backup",
    assetLocator: fixture.bundle.descriptor.assetLocator,
    bundleId: fixture.bundle.descriptor.bundleId,
    custodyRevision: 1n,
    headVersion: 1,
  });
  expect(fixture.remote.readObject).toHaveBeenCalledTimes(fixture.bundle.descriptor.objects.length);
  expect(fixture.remote.readObject.mock.calls.map(([call]) => call.objectId)).toEqual(
    fixture.bundle.descriptor.objects.map(({ objectId }) => objectId),
  );
  const proofs = [
    ...fixture.remote.readDescriptorPage.mock.calls.map(([call]) => call.requestProof.replayNonce),
    ...fixture.remote.readObject.mock.calls.map(([call]) => call.requestProof.replayNonce),
  ];
  expect(new Set(proofs).size).toBe(proofs.length);
});

it("uses complete current local custody without backup network I/O", async () => {
  const fixture = await backupFixture();
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: KEYSET,
    counter: 4,
  };
  const selectableProof = createBrowserCustodyProofRow({
    scopeId: fixture.input.scopeId,
    normalizedMint: fixture.input.asset.mintUrl,
    unit: "sat",
    proof: {
      id: KEYSET,
      amount: Amount.from(1),
      secret: deriveDurableWalletProofSecret({
        seed: SEED,
        locator,
        proofKeysetId: KEYSET,
        proofAmount: 1,
      }),
      C: `02${"44".repeat(32)}`,
    },
    asset: { kind: "regular" },
    receivedAtMs: 1,
  });
  const proof = {
    ...selectableProof,
    selectability: "locked" as const,
    reservationOperationId: "pending-operation",
  };
  await fixture.input.database.custodyProofs.put(proof);
  await fixture.input.database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(proof, 1, locator, "local"),
  );
  await fixture.input.database.walletCounterAssociations.put({
    scopeId: fixture.input.scopeId,
    normalizedMint: fixture.input.asset.mintUrl,
    unit: "sat",
    keysetId: KEYSET,
    recoveryComplete: true,
  });
  await fixture.input.database.walletCounterCursors.put({
    scopeId: fixture.input.scopeId,
    keysetId: KEYSET,
    next: 5,
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: fixture.input.scopeId,
    asset: fixture.input.asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await fixture.input.database.encryptedWalletBackupV2DesiredAssets.put({
    ...desired,
    syncState: "acknowledged",
  });
  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      wallet: {} as CashuWallet,
      lockManager: immediateLockManager(),
    }),
  ).resolves.toEqual({ kind: "local-custody" });
  expect((await fixture.input.database.proofs.toArray())[0]).toMatchObject({
    reservedBy: "pending-operation",
  });
  expect(fixture.remote.readDescriptorPage).not.toHaveBeenCalled();
  expect(fixture.remote.readObject).not.toHaveBeenCalled();
  await fixture.input.database.encryptedWalletBackupV2DesiredAssets.put({
    ...desired,
    syncState: "acknowledged",
    activeProofCount: 2,
  });
  await expect(restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input)).rejects.toThrow(
    /local custody asset is partial/,
  );
  expect(fixture.remote.readDescriptorPage).not.toHaveBeenCalled();
});

it("falls through from an acknowledged evicted cache to its current bundle", async () => {
  const fixture = await backupFixture();
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId: fixture.input.scopeId,
    asset: fixture.input.asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await fixture.input.database.encryptedWalletBackupV2DesiredAssets.put({
    ...desired,
    syncState: "acknowledged",
  });
  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input),
  ).resolves.toMatchObject({
    kind: "backup",
  });
});

it("rejects a corrupt object before returning material", async () => {
  const fixture = await backupFixture();
  const object = fixture.bundle.objects[0]!;
  fixture.remote.readObject.mockResolvedValueOnce({
    ...object,
    body: object.body.slice().reverse(),
  });
  await expect(restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input)).rejects.toThrow(
    /corrupt encrypted wallet backup v2 bundle|encrypted backup bundle object|encrypted backup V2|authentication/i,
  );
});

it("rejects a foreign current head", async () => {
  const fixture = await backupFixture();
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head: createEncryptedWalletBackupV2CurrentHead({
      realm: fixture.input.keyHandle.realm,
      walletId: fixture.input.keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 1,
      bundles: [fixture.bundle.descriptor],
    }),
    bundles: [fixture.bundle.descriptor],
  });
  fixture.remote.readDescriptorPage.mockImplementation(async ({ afterBundleId }) => {
    const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId);
    if (!page) throw new Error("test head page is absent");
    return { ...page, head: { ...page.head, realm: "foreign.example" } };
  });
  await expect(restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input)).rejects.toThrow(
    /descriptor is foreign|current head is foreign/,
  );
});

it("rejects a descriptor whose custody revision does not authenticate its objects", async () => {
  const fixture = await backupFixture();
  const descriptor = { ...fixture.bundle.descriptor, custodyRevision: 2n };
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: fixture.input.keyHandle.realm,
    walletId: fixture.input.keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 2,
    bundles: [descriptor],
  });
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles: [descriptor] });
  fixture.remote.readDescriptorPage.mockImplementation(async ({ afterBundleId }) => {
    const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId);
    if (!page) throw new Error("test head page is absent");
    return page;
  });
  await expect(restoreBrowserEncryptedWalletBackupV2TargetedAsset(fixture.input)).rejects.toThrow(
    /corrupt encrypted wallet backup v2 bundle|custody metadata is foreign/,
  );
});

it("does not let another asset at the same mint and unit block a CTF request", async () => {
  const fixture = await backupFixture();
  await fixture.input.database.custodyProofs.put(
    createBrowserCustodyProofRow({
      scopeId: fixture.input.scopeId,
      normalizedMint: fixture.input.asset.mintUrl,
      unit: "sat",
      proof: {
        id: KEYSET,
        amount: Amount.from(1),
        secret: "55".repeat(32),
        C: `02${"66".repeat(32)}`,
      },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    }),
  );
  const ctf = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: fixture.input.asset.mintUrl,
    unit: "sat",
    asset: {
      kind: "ctf",
      conditionId: "aa".repeat(32),
      outcomeCollectionId: "bb".repeat(32),
      outcomeLabel: "YES",
      registeredAt: 1,
      finalExpiry: 2,
    },
  });
  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset({ ...fixture.input, asset: ctf }),
  ).rejects.toThrow(/current asset is absent/);
});

it("rejects a stale profile after decrypting the current bundle", async () => {
  const fixture = await backupFixture();
  let current = true;
  fixture.remote.readObject.mockImplementationOnce(async (request) => {
    current = false;
    return fixture.objects.get(request.objectId)!;
  });
  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      isCurrentProfile: () => current,
    }),
  ).rejects.toThrow(/profile is stale/);
});

it("fails closed for an absent asset without broad mint recovery", async () => {
  const fixture = await backupFixture();
  const absent = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://absent.example",
    unit: "sat",
    asset: { kind: "ordinary" },
  });
  await expect(
    restoreBrowserEncryptedWalletBackupV2TargetedAsset({ ...fixture.input, asset: absent }),
  ).rejects.toThrow(/current asset is absent/);
  expect(fixture.remote.readObject).not.toHaveBeenCalled();
});

it("does not admit a decrypted bundle before mint proof verification", async () => {
  const fixture = await backupFixture();
  const checkProofsStates = vi.fn();
  const wallet = {
    getKeyset: () => ({
      id: KEYSET,
      unit: "sat",
      keys: { 1: `02${"44".repeat(32)}` },
      verify: () => true,
    }),
    checkProofsStates,
  } as unknown as CashuWallet;

  await expect(
    restoreAndAdmitBrowserEncryptedWalletBackupV2TargetedAsset({
      ...fixture.input,
      wallet,
      lockManager: immediateLockManager(),
    }),
  ).rejects.toThrow(/DLEQ|proof|signature/i);
  expect(checkProofsStates).not.toHaveBeenCalled();
  expect(await fixture.input.database.custodyProofs.count()).toBe(0);
  expect(await fixture.input.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
});

async function backupFixture() {
  fixtureSequence += 1;
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: fixtureSequence.toString(16).padStart(64, "0"),
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  openDatabases.push(database);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: SEED,
    realm: "backup.example",
    runtime: { subtle: crypto.subtle },
  });
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "sat",
    asset: { kind: "ordinary" },
  });
  const locator = {
    schemaVersion: 1 as const,
    kind: "nut13" as const,
    keysetId: KEYSET,
    counter: 0,
  };
  const bundle = await prepareEncryptedWalletBackupV2ProofSetBundle({
    keyHandle,
    seed: SEED,
    asset,
    custodyRevision: 1n,
    counterHighWaterMarks: [
      { mintUrl: asset.mintUrl, unit: "sat", keysetId: KEYSET, nextCounter: 1 },
    ],
    proofs: [
      {
        mintUrl: asset.mintUrl,
        unit: "sat",
        asset: { kind: "ordinary" },
        locator,
        proof: {
          id: KEYSET,
          amount: Amount.from(1),
          secret: deriveDurableWalletProofSecret({
            seed: SEED,
            locator,
            proofKeysetId: KEYSET,
            proofAmount: 1,
          }),
          C: `02${"33".repeat(32)}`,
        },
      },
    ],
    runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
  });
  const head = createEncryptedWalletBackupV2CurrentHead({
    realm: keyHandle.realm,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [bundle.descriptor],
  });
  const pages = enumerateEncryptedWalletBackupV2DescriptorPages({
    head,
    bundles: [bundle.descriptor],
  });
  const objects = new Map(bundle.objects.map((object) => [object.objectId, object]));
  const remote = {
    discoverEnrollmentEpoch: vi.fn(),
    mutateHeadOnce: vi.fn(),
    readDescriptorPage: vi.fn(async ({ afterBundleId }) => {
      const page = pages.find((candidate) => candidate.afterBundleId === afterBundleId);
      if (!page) throw new Error("test head page is absent");
      return page;
    }),
    readObject: vi.fn(async ({ objectId }) => {
      const object = objects.get(objectId);
      if (!object) throw new Error("test object is absent");
      return object;
    }),
  } satisfies EncryptedWalletBackupV2RemotePort;
  return {
    bundle,
    objects,
    remote,
    input: {
      database,
      scopeId,
      seed: SEED,
      keyHandle,
      enrollmentEpoch: 1,
      asset,
      remote,
      requestUrl: (kind: "head" | "object", value: string | null) =>
        `https://backup.example/${kind}/${value ?? "current"}`,
      nowUnixSeconds: () => 1_000,
      runtime: { subtle: crypto.subtle, getRandomValues: crypto.getRandomValues.bind(crypto) },
      signal: new AbortController().signal,
      isCurrentProfile: () => true,
    },
  };
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: async <T>(_name: string, _options: LockOptions, callback: LockGrantedCallback<T>) =>
      callback(null),
  } as Pick<LockManager, "request">;
}
