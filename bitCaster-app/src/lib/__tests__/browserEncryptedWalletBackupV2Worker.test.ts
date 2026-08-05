// @vitest-environment node
import "fake-indexeddb/auto";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  decodeEncryptedWalletBackupV2UploadGroup,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  issueEncryptedWalletBackupV2BundleSupersessionReceipt,
  prepareEncryptedWalletBackupV2TransportBundle,
  type EncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleSupersessionReceipt,
  type EncryptedWalletBackupV2DescriptorPage,
  type EncryptedWalletBackupV2RemotePort,
  type EncryptedWalletBackupV2RequestProof,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { EncryptedWalletBackupV2HttpTransportError } from "@bitcaster/client-sdk/encryptedWalletBackupV2HttpAdapter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../../stores/encrypted-wallet-backup-v2-db";
import { BitcasterDB } from "../../stores/proof-db";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  runBrowserEncryptedWalletBackupV2WorkerCycle,
  type BrowserEncryptedWalletBackupV2WorkerInput,
} from "../browserEncryptedWalletBackupV2Worker";

const REALM = "backup.example";
const SIGNING_KEY_ID = "55".repeat(16);
const SIGNING_PRIVATE_KEY = fromHex("03".repeat(32));
const SIGNING_PUBLIC_KEY = toHex(schnorr.getPublicKey(SIGNING_PRIVATE_KEY));
const openDatabases: BitcasterDB[] = [];
let sequence = 0;

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser V2 backup worker", () => {
  it("skips an acknowledged first asset and processes later assets one per cycle", async () => {
    const fixture = await workerFixture(2);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations).toHaveLength(1);
    expect(await fixture.database.encryptedWalletBackupV2AssetReceipts.count()).toBe(1);
    expect(
      (await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray()).map(
        ({ syncState }) => syncState,
      ),
    ).toEqual(["acknowledged", "pending"]);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations).toHaveLength(2);
    expect(await fixture.database.encryptedWalletBackupV2AssetReceipts.count()).toBe(2);
    expect(
      (await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray()).map(
        ({ syncState }) => syncState,
      ),
    ).toEqual(["acknowledged", "acknowledged"]);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "idle",
    });
    expect(fixture.remote.mutations).toHaveLength(2);
  });

  it("retries byte-identical prepared upload data with a fresh request proof", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failures.push("transport-failure");

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "retry-pending",
    });
    const persisted = await fixture.store.readPreparedMutation();
    expect(persisted).not.toBeNull();

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations[0]?.bytes).toEqual(fixture.remote.mutations[1]?.bytes);
    expect(fixture.remote.mutations[0]?.replayNonce).not.toBe(
      fixture.remote.mutations[1]?.replayNonce,
    );
    expect(await fixture.store.readPreparedMutation()).toBeNull();
  });

  it("retries the exact prepared upload after the IndexedDB handle reopens", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failures.push("transport-failure");
    await runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input);
    const firstBytes = fixture.remote.mutations[0]!.bytes;
    fixture.database.close();
    const reopened = new BitcasterDB(browserWalletDatabaseName(fixture.scopeId));
    openDatabases.push(reopened);
    const input = { ...fixture.input, database: reopened };

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations[1]?.bytes).toEqual(firstBytes);
    expect(await reopened.encryptedWalletBackupV2PreparedMutations.count()).toBe(0);
  });

  it("continues with the next pending asset after the IndexedDB handle reopens", async () => {
    const fixture = await workerFixture(2);
    await runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input);
    fixture.database.close();
    const reopened = new BitcasterDB(browserWalletDatabaseName(fixture.scopeId));
    openDatabases.push(reopened);
    const source = fixture.input.assetSource!;
    const input = {
      ...fixture.input,
      database: reopened,
      assetSource: {
        prepare: source.prepare,
        read: async ({ localAssetKey }: { readonly localAssetKey: string }) => {
          const desired = await reopened.encryptedWalletBackupV2DesiredAssets.get([
            fixture.scopeId,
            localAssetKey,
          ]);
          const asset = fixture.assets.get(localAssetKey);
          if (!desired || !asset) throw new Error("test asset is absent");
          return { desired, asset, proofs: [], counterHighWaterMarks: [] };
        },
      },
    };

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations).toHaveLength(2);
    expect(
      (await reopened.encryptedWalletBackupV2DesiredAssets.toArray()).map(
        ({ syncState }) => syncState,
      ),
    ).toEqual(["acknowledged", "acknowledged"]);
  });

  it("makes no service mutation on local quota failure and requeues definite service refusal", async () => {
    const local = await workerFixture(1);
    vi.spyOn(local.database.encryptedWalletBackupV2PreparedMutations, "add").mockRejectedValueOnce(
      new DOMException("quota", "QuotaExceededError"),
    );
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(local.input)).rejects.toThrow(
      /quota/,
    );
    expect(local.remote.mutations).toHaveLength(0);
    expect(await local.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);

    const service = await workerFixture(1);
    service.remote.failures.push("quota-exceeded");
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(service.input)).resolves.toEqual({
      kind: "service-quota-pending",
    });
    expect(await service.store.readPreparedMutation()).toBeNull();
    expect(await service.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);
    expect(
      await service.database.encryptedWalletBackupV2DesiredAssets.get([
        service.scopeId,
        service.desired[0]!.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "pending" });
  });

  it("replays a remotely committed mutation after local commit rollback", async () => {
    const fixture = await workerFixture(1);
    await runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input);
    const predecessor = (await fixture.store.listActiveDescriptors())[0]!;
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired[0]!,
      custodyRevision: "2",
      syncState: "pending",
    });
    vi.spyOn(
      fixture.database.encryptedWalletBackupV2ActiveDescriptors,
      "put",
    ).mockRejectedValueOnce(new Error("commit fault"));

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).rejects.toThrow(
      /commit fault/,
    );
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
    expect(await fixture.database.encryptedWalletBackupV2AssetReceipts.count()).toBe(1);
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(1);
    expect((await fixture.store.listActiveDescriptors())[0]?.bundleId).toBe(predecessor.bundleId);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.mutations).toHaveLength(3);
    expect(fixture.remote.mutations[1]?.bytes).toEqual(fixture.remote.mutations[2]?.bytes);
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(2);
    expect((await fixture.store.listActiveDescriptors())[0]?.bundleId).not.toBe(
      predecessor.bundleId,
    );
  });

  it("replays an uncertain post-commit response without creating a second remote mutation", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failAfterCommit = true;

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "retry-pending",
    });
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(fixture.remote.appliedMutations).toBe(1);
    expect(fixture.remote.mutations).toHaveLength(2);
    expect(fixture.remote.mutations[0]?.bytes).toEqual(fixture.remote.mutations[1]?.bytes);
  });

  it("retains the prepared mutation when receipt signature verification fails", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.tamperNextReceipt = true;

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).rejects.toThrow(
      /receipt signature is invalid/,
    );
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
    expect(await fixture.database.encryptedWalletBackupV2AssetReceipts.count()).toBe(0);
  });

  it("accepts a complete conflict head and keeps the desired asset pending", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failures.push("conflict");

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "conflict-recovered",
    });
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(1);
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);
  });

  it("retains a newer desired revision that arrives during service I/O", async () => {
    const fixture = await workerFixture(1);
    const current = fixture.desired[0]!;
    fixture.remote.afterCommit = async () => {
      await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
        ...current,
        custodyRevision: "2",
      });
    };

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(
      (
        await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
          fixture.scopeId,
          current.localAssetKey,
        ])
      )?.custodyRevision,
    ).toBe("2");
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        current.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "pending" });
    expect((await fixture.store.readAssetReceipt(current.localAssetKey))?.custodyRevision).toBe(
      "1",
    );
  });

  it("fails on a stale profile before persistence or after service success", async () => {
    const before = await workerFixture(1);
    const originalPrepare = before.input.assetSource!.prepare;
    const staleBeforePersistence = {
      ...before.input,
      assetSource: {
        ...before.input.assetSource!,
        prepare: async (input: Parameters<typeof originalPrepare>[0]) => {
          const bundle = await originalPrepare(input);
          before.current = false;
          return bundle;
        },
      },
    };
    await expect(
      runBrowserEncryptedWalletBackupV2WorkerCycle(staleBeforePersistence),
    ).rejects.toThrow(/profile is stale/);
    expect(before.remote.mutations).toHaveLength(0);
    expect(await before.store.readPreparedMutation()).toBeNull();

    const after = await workerFixture(1);
    after.remote.afterCommit = () => {
      after.current = false;
    };
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(after.input)).rejects.toThrow(
      /profile is stale/,
    );
    expect(await after.store.readPreparedMutation()).not.toBeNull();
    expect(await after.database.encryptedWalletBackupV2AssetReceipts.count()).toBe(0);
  });

  it("does not call the service when the profile changes during request proof creation", async () => {
    const fixture = await workerFixture(1);
    fixture.remote.failures.push("transport-failure");
    await runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input);

    let checks = 0;
    const input = {
      ...fixture.input,
      isCurrentProfile: () => {
        checks += 1;
        return checks < 4;
      },
    };
    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(input)).rejects.toThrow(
      /profile is stale/,
    );
    expect(fixture.remote.mutations).toHaveLength(1);
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
  });

  it("cleans an already-absent removal locally without service mutation", async () => {
    const fixture = await workerFixture(0);
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: "https://removed.example",
      unit: "sat",
      asset: { kind: "ordinary" },
    });
    const removal = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset,
      custodyRevision: 4n,
      activeProofCount: 0,
    });
    fixture.assets.set(removal.localAssetKey, asset);
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(removal);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
    expect(fixture.remote.mutations).toHaveLength(0);
  });

  it("does not inspect receipts for 256 acknowledged assets", async () => {
    const fixture = await workerFixture(0);
    const rows = Array.from({ length: 256 }, (_value, index) => {
      const asset = createEncryptedWalletBackupV2AssetIdentity({
        mintUrl: `https://acknowledged-${index}.example`,
        unit: "sat",
        asset: { kind: "ordinary" },
      });
      return {
        ...createEncryptedWalletBackupV2DesiredAssetRow({
          scopeId: fixture.scopeId,
          asset,
          custodyRevision: 1n,
          activeProofCount: 1,
        }),
        syncState: "acknowledged" as const,
      };
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.bulkPut(rows);
    const receiptRead = vi.spyOn(fixture.database.encryptedWalletBackupV2AssetReceipts, "get");

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "idle",
    });
    expect(receiptRead).not.toHaveBeenCalled();
    expect(fixture.remote.mutations).toHaveLength(0);
  });

  it("removes a current bundle before an earlier-sorting add at the full head limit", async () => {
    const fixture = await workerFixture(0);
    const removalAsset = ordinaryAsset("https://z-removal.example");
    const addAsset = ordinaryAsset("https://a-add.example");
    const removalDescriptor = await descriptorForAsset(fixture, removalAsset);
    fixture.remote.replaceHead(fullHead(removalDescriptor));
    await acceptRemoteHead(fixture);
    const removal = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: removalAsset,
      custodyRevision: 1n,
      activeProofCount: 0,
    });
    const add = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: addAsset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    expect(add.localAssetKey < removal.localAssetKey).toBe(true);
    fixture.assets.set(add.localAssetKey, addAsset);
    await fixture.database.encryptedWalletBackupV2DesiredAssets.bulkPut([add, removal]);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });

    const mutation = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: fixture.remote.mutations[0]!.bytes,
      expectedRequestAuthPublicKey: fixture.input.keyHandle.requestAuthPublicKey,
      expectedContext: {
        realm: REALM,
        vaultId: fixture.input.keyHandle.vaultId,
        enrollmentEpoch: 1,
      },
    }).mutationEvidence.envelope.mutation;
    expect(mutation.addedBundle).toBeNull();
    expect(mutation.supersededBundleIds).toEqual([removalDescriptor.bundleId]);
  });

  it("lets a later removal pass a definitely quota-rejected prepared add", async () => {
    const fixture = await workerFixture(0);
    const removalAsset = ordinaryAsset("https://z-later-removal.example");
    const addAsset = ordinaryAsset("https://a-quota-add.example");
    const removalDescriptor = await descriptorForAsset(fixture, removalAsset);
    fixture.remote.replaceHead([removalDescriptor]);
    await acceptRemoteHead(fixture);
    const add = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: addAsset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    fixture.assets.set(add.localAssetKey, addAsset);
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(add);
    fixture.remote.failures.push("quota-exceeded");

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "service-quota-pending",
    });
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    const removal = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: removalAsset,
      custodyRevision: 1n,
      activeProofCount: 0,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(removal);

    await expect(runBrowserEncryptedWalletBackupV2WorkerCycle(fixture.input)).resolves.toEqual({
      kind: "committed",
    });
    const second = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: fixture.remote.mutations[1]!.bytes,
      expectedRequestAuthPublicKey: fixture.input.keyHandle.requestAuthPublicKey,
      expectedContext: {
        realm: REALM,
        vaultId: fixture.input.keyHandle.vaultId,
        enrollmentEpoch: 1,
      },
    }).mutationEvidence.envelope.mutation;
    expect(second.addedBundle).toBeNull();
    expect(second.supersededBundleIds).toEqual([removalDescriptor.bundleId]);
  });
});

async function workerFixture(assetCount: number) {
  sequence += 1;
  const seed = new Uint8Array(64).fill(sequence);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: sequence.toString(16).padStart(64, "6"),
  });
  const database = new BitcasterDB(browserWalletDatabaseName(scopeId));
  openDatabases.push(database);
  const store = new EncryptedWalletBackupV2DexieAuthorityStore({
    database,
    scopeId,
    realm: REALM,
    vaultId: keyHandle.vaultId,
    enrollmentEpoch: 1,
    requestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const remote = new FakeRemote(keyHandle.vaultId, keyHandle.requestAuthPublicKey);
  await store.acceptCompetingHead({
    collectedHeadEvidence: remote.evidence(),
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });
  const assets = new Map<string, ReturnType<typeof createEncryptedWalletBackupV2AssetIdentity>>();
  const desired = Array.from({ length: assetCount }, (_value, index) => {
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: `https://mint-${sequence}-${index}.example`,
      unit: "sat",
      asset: { kind: "ordinary" },
    });
    const row = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    assets.set(row.localAssetKey, asset);
    return row;
  });
  await database.encryptedWalletBackupV2DesiredAssets.bulkPut(desired);
  let current = true;
  const assetSource: NonNullable<BrowserEncryptedWalletBackupV2WorkerInput["assetSource"]> = {
    read: async ({ localAssetKey }) => {
      const row = await database.encryptedWalletBackupV2DesiredAssets.get([scopeId, localAssetKey]);
      const asset = assets.get(localAssetKey);
      if (!row || !asset) throw new Error("test asset is absent");
      return { desired: row, asset, proofs: [], counterHighWaterMarks: [] };
    },
    prepare: async ({ snapshot, keyHandle: handle }) =>
      prepareEncryptedWalletBackupV2TransportBundle({
        keyHandle: handle,
        asset: snapshot.asset,
        declaredAmount: 1n,
        custodyRevision: BigInt(snapshot.desired.custodyRevision),
        canonicalPayload: encodeCanonicalBackupCbor([snapshot.desired.localAssetKey]),
        runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
      }),
  };
  const input: BrowserEncryptedWalletBackupV2WorkerInput = {
    database,
    scopeId,
    seed,
    keyHandle,
    enrollmentEpoch: 1,
    pinnedReceiptKeys: [{ keyId: SIGNING_KEY_ID, publicKey: SIGNING_PUBLIC_KEY }],
    remote,
    requestUrl: (kind, cursor) =>
      `https://backup.example/v2/${kind}${cursor === null ? "" : `?after=${cursor}`}`,
    nowUnixSeconds: () => 1_000,
    runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
    signal: new AbortController().signal,
    isCurrentProfile: () => current,
    assetSource,
  };
  return {
    database,
    store,
    scopeId,
    remote,
    desired,
    assets,
    input,
    get current() {
      return current;
    },
    set current(value: boolean) {
      current = value;
    },
  };
}

function ordinaryAsset(mintUrl: string) {
  return createEncryptedWalletBackupV2AssetIdentity({
    mintUrl,
    unit: "sat",
    asset: { kind: "ordinary" },
  });
}

async function descriptorForAsset(
  fixture: Awaited<ReturnType<typeof workerFixture>>,
  asset: ReturnType<typeof ordinaryAsset>,
) {
  return (
    await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle: fixture.input.keyHandle,
      asset,
      declaredAmount: 1n,
      custodyRevision: 1n,
      canonicalPayload: encodeCanonicalBackupCbor(["head"]),
      runtime: { subtle: crypto.subtle, getRandomValues: randomValues },
    })
  ).descriptor;
}

function fullHead(removal: EncryptedWalletBackupV2BundleDescriptor) {
  const bundles: EncryptedWalletBackupV2BundleDescriptor[] = [removal];
  for (let candidate = 1; bundles.length < 256; candidate += 1) {
    const bundleId = fixedHex(candidate, 16);
    const assetLocator = fixedHex(candidate, 32);
    const objectId = fixedHex(candidate * 16, 16);
    if (
      bundleId === removal.bundleId ||
      assetLocator === removal.assetLocator ||
      removal.objects.some((object) => object.objectId === objectId)
    )
      continue;
    bundles.push({
      ...removal,
      bundleId,
      assetLocator,
      objects: removal.objects.map((object, index) => ({
        ...object,
        objectId: fixedHex(candidate * 16 + index, 16),
      })),
    });
  }
  return bundles;
}

async function acceptRemoteHead(fixture: Awaited<ReturnType<typeof workerFixture>>): Promise<void> {
  await fixture.store.acceptCompetingHead({
    collectedHeadEvidence: fixture.remote.evidence(),
    stalePreparedMutation: {
      mutationId: "00".repeat(16),
      requestDigest: "00".repeat(32),
    },
  });
}

class FakeRemote implements EncryptedWalletBackupV2RemotePort {
  readonly failures: Array<"transport-failure" | "quota-exceeded" | "conflict"> = [];
  readonly mutations: Array<{ bytes: Uint8Array; replayNonce: string }> = [];
  afterCommit: (() => void | Promise<void>) | null = null;
  failAfterCommit = false;
  tamperNextReceipt = false;
  appliedMutations = 0;
  #head;
  #bundles: EncryptedWalletBackupV2BundleDescriptor[] = [];
  readonly #receipts = new Map<string, EncryptedWalletBackupV2BundleSupersessionReceipt>();
  readonly #requestAuthPublicKey: string;

  constructor(vaultId: string, requestAuthPublicKey: string) {
    this.#requestAuthPublicKey = requestAuthPublicKey;
    this.#head = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      vaultId,
      enrollmentEpoch: 1,
      headVersion: 0,
      bundles: [],
    });
  }

  evidence() {
    return collectEncryptedWalletBackupV2DescriptorPages(
      enumerateEncryptedWalletBackupV2DescriptorPages({
        head: this.#head,
        bundles: this.#bundles,
      }),
    );
  }

  replaceHead(bundles: readonly EncryptedWalletBackupV2BundleDescriptor[]): void {
    this.#bundles = [...bundles].sort((left, right) => left.bundleId.localeCompare(right.bundleId));
    this.#head = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      vaultId: this.#head.vaultId,
      enrollmentEpoch: 1,
      headVersion: this.#head.headVersion + 1,
      bundles: this.#bundles,
    });
  }

  async readDescriptorPage(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof;
    readonly afterBundleId: string | null;
  }): Promise<EncryptedWalletBackupV2DescriptorPage> {
    const page = enumerateEncryptedWalletBackupV2DescriptorPages({
      head: this.#head,
      bundles: this.#bundles,
    }).find(({ afterBundleId }) => afterBundleId === input.afterBundleId);
    if (!page) throw new Error("test page is absent");
    return page;
  }

  async mutateHeadOnce(input: {
    readonly requestProof: EncryptedWalletBackupV2RequestProof;
    readonly canonicalUploadGroup: Uint8Array;
  }): Promise<EncryptedWalletBackupV2BundleSupersessionReceipt> {
    this.mutations.push({
      bytes: input.canonicalUploadGroup.slice(),
      replayNonce: input.requestProof.replayNonce,
    });
    const failure = this.failures.shift();
    if (failure === "conflict") {
      this.#head = createEncryptedWalletBackupV2CurrentHead({
        realm: REALM,
        vaultId: this.#head.vaultId,
        enrollmentEpoch: 1,
        headVersion: this.#head.headVersion + 1,
        bundles: this.#bundles,
      });
      throw new EncryptedWalletBackupV2HttpTransportError("conflict");
    }
    if (failure) throw new EncryptedWalletBackupV2HttpTransportError(failure);
    const group = decodeEncryptedWalletBackupV2UploadGroup({
      bytes: input.canonicalUploadGroup,
      expectedRequestAuthPublicKey: this.#requestAuthPublicKey,
      expectedContext: { realm: REALM, vaultId: this.#head.vaultId, enrollmentEpoch: 1 },
    });
    const digest = group.mutationEvidence.envelope.requestDigest;
    const replay = this.#receipts.get(digest);
    if (replay) return replay;
    const mutation = group.mutationEvidence.envelope.mutation;
    const superseded = new Set(mutation.supersededBundleIds);
    this.#bundles = this.#bundles.filter(({ bundleId }) => !superseded.has(bundleId));
    if (mutation.addedBundle) this.#bundles.push(mutation.addedBundle);
    this.#bundles.sort((left, right) => left.bundleId.localeCompare(right.bundleId));
    this.#head = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      vaultId: this.#head.vaultId,
      enrollmentEpoch: 1,
      headVersion: this.#head.headVersion + 1,
      bundles: this.#bundles,
    });
    const receipt = await issueEncryptedWalletBackupV2BundleSupersessionReceipt({
      mutationEvidence: group.mutationEvidence,
      resultHead: this.#head,
      signingKeyId: SIGNING_KEY_ID,
      signingPublicKey: SIGNING_PUBLIC_KEY,
      signDigest: (value) => schnorr.sign(value, SIGNING_PRIVATE_KEY),
    });
    this.appliedMutations += 1;
    this.#receipts.set(digest, receipt);
    await this.afterCommit?.();
    if (this.failAfterCommit) {
      this.failAfterCommit = false;
      throw new EncryptedWalletBackupV2HttpTransportError("transport-failure");
    }
    if (this.tamperNextReceipt) {
      this.tamperNextReceipt = false;
      return { ...receipt, signature: "00".repeat(64) };
    }
    return receipt;
  }

  async discoverEnrollmentEpoch(): Promise<never> {
    throw new Error("not used");
  }

  async readObject(): Promise<never> {
    throw new Error("not used");
  }
}

function randomValues(target: Uint8Array): Uint8Array {
  return crypto.getRandomValues(target);
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_item, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, "0")).join("");
}

function fixedHex(value: number, bytes: number): string {
  return value.toString(16).padStart(bytes * 2, "0");
}
