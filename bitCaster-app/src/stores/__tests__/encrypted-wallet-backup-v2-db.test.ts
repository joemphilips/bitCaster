// @vitest-environment node
import "fake-indexeddb/auto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectEncryptedWalletBackupV2DescriptorPages,
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2CurrentHead,
  createEncryptedWalletBackupV2KeyHandle,
  decodeEncryptedWalletBackupV2UploadGroup,
  encodeEncryptedWalletBackupV2BundleSupersessionReceipt,
  encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire,
  encodeEncryptedWalletBackupV2UploadGroup,
  enumerateEncryptedWalletBackupV2DescriptorPages,
  issueEncryptedWalletBackupV2BundleSupersessionReceipt,
  prepareEncryptedWalletBackupV2BundleSupersessionMutation,
  prepareEncryptedWalletBackupV2TransportBundle,
  verifyEncryptedWalletBackupV2BundleSupersessionReceipt,
} from "@bitcaster/client-sdk";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { encodeCanonicalBackupCbor } from "@bitcaster/client-sdk/encryptedWalletBackupCbor";
import { browserWalletDatabaseName } from "../../lib/browserWalletProfile";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../browser-encrypted-wallet-backup-v2-desired-asset";
import { EncryptedWalletBackupV2DexieAuthorityStore } from "../encrypted-wallet-backup-v2-db";
import { BitcasterDB } from "../proof-db";

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

describe("encrypted wallet backup V2 Dexie authority", () => {
  it("persists one exact prepared mutation only while desired state and head match", async () => {
    const fixture = await preparedFixture();
    await expect(
      fixture.store.insertPreparedMutationForDesired({
        prepared: { ...fixture.insert.prepared, assetLocator: "ff".repeat(32) },
        desired: { ...fixture.insert.desired, assetLocator: "ff".repeat(32) },
      }),
    ).rejects.toThrow(/prepared asset binding is invalid/);
    await expect(fixture.store.insertPreparedMutationForDesired(fixture.insert)).resolves.toBe(
      "inserted",
    );
    await expect(fixture.store.insertPreparedMutationForDesired(fixture.insert)).resolves.toBe(
      "existing",
    );

    await fixture.database.encryptedWalletBackupV2DesiredAssets.put({
      ...fixture.desired,
      custodyRevision: "2",
    });
    await expect(fixture.store.insertPreparedMutationForDesired(fixture.insert)).rejects.toThrow(
      /desired asset is stale/,
    );
    expect((await fixture.store.readPreparedMutation())?.canonicalUploadGroup).toEqual(
      fixture.group,
    );
  });

  it("accepts a complete competing head and deletes only the exact stale prepared row", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);

    await expect(
      fixture.store.acceptCompetingHead({
        collectedHeadEvidence: fixture.resultEvidence,
        stalePreparedMutation: {
          mutationId: fixture.insert.prepared.mutationId,
          requestDigest: "aa".repeat(32),
        },
      }),
    ).resolves.toEqual({ deletedStalePreparedMutation: false });
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();

    await expect(
      fixture.store.acceptCompetingHead({
        collectedHeadEvidence: fixture.resultEvidence,
        stalePreparedMutation: fixture.insert.prepared,
      }),
    ).resolves.toEqual({ deletedStalePreparedMutation: true });
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect((await fixture.store.listActiveDescriptors()).map(({ bundleId }) => bundleId)).toEqual([
      fixture.bundle.descriptor.bundleId,
    ]);
  });

  it("commits the exact per-asset receipt and rolls every authority row back on failure", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    const receipt = await receiptFixture(fixture);
    await expect(
      fixture.store.commitVerifiedAssetReceipt({
        ...receipt,
        binding: { ...receipt.binding, custodyRevision: "2" },
      }),
    ).rejects.toThrow(/prepared receipt binding is invalid/);
    vi.spyOn(
      fixture.database.encryptedWalletBackupV2ActiveDescriptors,
      "put",
    ).mockRejectedValueOnce(new Error("local quota"));

    await expect(fixture.store.commitVerifiedAssetReceipt(receipt)).rejects.toThrow(/local quota/);
    expect(await fixture.store.readPreparedMutation()).not.toBeNull();
    expect(await fixture.store.readAssetReceipt(fixture.desired.localAssetKey)).toBeNull();
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(0);

    await fixture.store.commitVerifiedAssetReceipt(receipt);
    const stored = await fixture.store.readAssetReceipt(fixture.desired.localAssetKey);
    expect(stored?.custodyRevision).toBe("1");
    expect(stored?.bundleId).toBe(fixture.bundle.descriptor.bundleId);
    expect(await fixture.store.readPreparedMutation()).toBeNull();
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(1);
    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "acknowledged" });
  });

  it("removes an already-absent asset intent and its obsolete receipt atomically", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    await fixture.store.commitVerifiedAssetReceipt(await receiptFixture(fixture));
    const removal = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: fixture.scopeId,
      asset: fixture.asset,
      custodyRevision: 2n,
      activeProofCount: 0,
    });
    await fixture.database.encryptedWalletBackupV2DesiredAssets.put(removal);

    await fixture.store.acknowledgeAbsentRemoval({
      localAssetKey: removal.localAssetKey,
      assetLocator: fixture.bundle.descriptor.assetLocator,
      custodyRevision: removal.custodyRevision,
      desiredAction: "remove",
      activeProofCount: 0,
    });

    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        removal.localAssetKey,
      ]),
    ).toBeUndefined();
    expect(await fixture.store.readAssetReceipt(removal.localAssetKey)).toBeNull();
  });

  it("requeues acknowledged assets after accepting a competing head", async () => {
    const fixture = await preparedFixture();
    await fixture.store.insertPreparedMutationForDesired(fixture.insert);
    await fixture.store.commitVerifiedAssetReceipt(await receiptFixture(fixture));
    const competingHead = createEncryptedWalletBackupV2CurrentHead({
      realm: REALM,
      vaultId: fixture.keyHandle.vaultId,
      enrollmentEpoch: 1,
      headVersion: 2,
      bundles: [],
    });

    await fixture.store.acceptCompetingHead({
      collectedHeadEvidence: evidence(competingHead, []),
      stalePreparedMutation: {
        mutationId: "00".repeat(16),
        requestDigest: "00".repeat(32),
      },
    });

    expect(
      await fixture.database.encryptedWalletBackupV2DesiredAssets.get([
        fixture.scopeId,
        fixture.desired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "pending", custodyRevision: "1" });
    expect(await fixture.store.listActiveDescriptors()).toEqual([]);
    expect((await fixture.store.readAcceptedHead())?.headVersion).toBe(2);
  });
});

async function preparedFixture() {
  sequence += 1;
  const seed = new Uint8Array(64).fill(sequence);
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed,
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  const scopeId = deriveDurableCustodyScopeId({
    scopeKind: "wallet",
    walletId: sequence.toString(16).padStart(64, "8"),
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
  const asset = createEncryptedWalletBackupV2AssetIdentity({
    mintUrl: "https://mint.example",
    unit: "sat",
    asset: { kind: "ordinary" },
  });
  const desired = createEncryptedWalletBackupV2DesiredAssetRow({
    scopeId,
    asset,
    custodyRevision: 1n,
    activeProofCount: 1,
  });
  await database.encryptedWalletBackupV2DesiredAssets.put(desired);
  const emptyHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: keyHandle.vaultId,
    enrollmentEpoch: 1,
    headVersion: 0,
    bundles: [],
  });
  await store.acceptCompetingHead({
    collectedHeadEvidence: evidence(emptyHead, []),
    stalePreparedMutation: { mutationId: "00".repeat(16), requestDigest: "00".repeat(32) },
  });
  const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
    keyHandle,
    asset,
    declaredAmount: 1n,
    custodyRevision: 1n,
    canonicalPayload: encodeCanonicalBackupCbor(["proof"]),
    runtime: {
      subtle: crypto.subtle,
      getRandomValues: queuedRandom([hex(10 + sequence, 16), hex(20 + sequence, 12)]),
    },
  });
  const envelope = await prepareEncryptedWalletBackupV2BundleSupersessionMutation({
    keyHandle,
    expectedHeadEvidence: evidence(emptyHead, []),
    addedBundle: bundle.descriptor,
    supersededBundleIds: [],
    runtime: { getRandomValues: queuedRandom([hex(30 + sequence, 16), hex(40 + sequence, 32)]) },
  });
  const group = encodeEncryptedWalletBackupV2UploadGroup({
    envelope,
    objects: bundle.objects,
  });
  const resultHead = createEncryptedWalletBackupV2CurrentHead({
    realm: REALM,
    vaultId: keyHandle.vaultId,
    enrollmentEpoch: 1,
    headVersion: 1,
    bundles: [bundle.descriptor],
  });
  const binding = {
    localAssetKey: desired.localAssetKey,
    assetLocator: bundle.descriptor.assetLocator,
    custodyRevision: desired.custodyRevision,
    desiredAction: "replace" as const,
    activeProofCount: 1,
  };
  return {
    database,
    store,
    scopeId,
    keyHandle,
    asset,
    desired,
    bundle,
    envelope,
    group,
    resultHead,
    resultEvidence: evidence(resultHead, [bundle.descriptor]),
    insert: {
      prepared: {
        mutationId: envelope.mutation.mutationId,
        requestDigest: envelope.requestDigest,
        canonicalUploadGroup: group,
        createdAtUnixMilliseconds: 1,
        ...binding,
      },
      desired: binding,
    },
  };
}

async function receiptFixture(fixture: Awaited<ReturnType<typeof preparedFixture>>) {
  const mutationEvidence = decodeEncryptedWalletBackupV2UploadGroup({
    bytes: fixture.group,
    expectedRequestAuthPublicKey: fixture.keyHandle.requestAuthPublicKey,
    expectedContext: {
      realm: REALM,
      vaultId: fixture.keyHandle.vaultId,
      enrollmentEpoch: 1,
    },
  }).mutationEvidence;
  const receipt = await issueEncryptedWalletBackupV2BundleSupersessionReceipt({
    mutationEvidence,
    resultHead: fixture.resultHead,
    signingKeyId: SIGNING_KEY_ID,
    signingPublicKey: SIGNING_PUBLIC_KEY,
    signDigest: (digest) => schnorr.sign(digest, SIGNING_PRIVATE_KEY),
  });
  return {
    binding: {
      ...fixture.insert.desired,
      bundleId: fixture.bundle.descriptor.bundleId,
      bundleDescriptorDigest: receipt.bundleDescriptorDigest,
    },
    canonicalSignedMutation: encodeEncryptedWalletBackupV2SignedBundleSupersessionMutationWire(
      fixture.envelope,
    ),
    canonicalSignedReceipt: encodeEncryptedWalletBackupV2BundleSupersessionReceipt(receipt),
    verifiedReceipt: verifyEncryptedWalletBackupV2BundleSupersessionReceipt({
      receipt,
      mutationEvidence,
      pinnedSigningKeys: [{ keyId: SIGNING_KEY_ID, publicKey: SIGNING_PUBLIC_KEY }],
    }),
    collectedHeadEvidence: fixture.resultEvidence,
    preparedMutation: fixture.insert.prepared,
  };
}

function evidence(
  head: ReturnType<typeof createEncryptedWalletBackupV2CurrentHead>,
  bundles: Parameters<typeof enumerateEncryptedWalletBackupV2DescriptorPages>[0]["bundles"],
) {
  return collectEncryptedWalletBackupV2DescriptorPages(
    enumerateEncryptedWalletBackupV2DescriptorPages({ head, bundles }),
  );
}

function queuedRandom(values: readonly string[]) {
  const queue = values.map(fromHex);
  return (target: Uint8Array): Uint8Array => {
    const next = queue.shift();
    if (next === undefined || next.byteLength !== target.byteLength) throw new Error("test random");
    target.set(next);
    return target;
  };
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from({ length: value.length / 2 }, (_item, index) =>
    Number.parseInt(value.slice(index * 2, index * 2 + 2), 16),
  );
}

function toHex(value: Uint8Array): string {
  return Array.from(value, (item) => item.toString(16).padStart(2, "0")).join("");
}

function hex(value: number, bytes: number): string {
  return value.toString(16).padStart(2, "0").repeat(bytes);
}
