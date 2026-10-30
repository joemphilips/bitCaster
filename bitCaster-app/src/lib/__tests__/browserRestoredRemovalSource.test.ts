// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, expect, it, vi } from "vitest";
import { restoredRemovalSourceFixture } from "./fixtures/restoredRemovalSourceFixture";
import { decodeEncryptedWalletBackupOwnerUploadGroup } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import { decryptEncryptedWalletBackupV2ProofSetBundle } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { removalSeed } from "./fixtures/ownerCtfRemovalProofs";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([1, 2])(
  "fresh empty-origin already-losing restore removes %s exact targets through actual driver without old receipt or republish",
  async (count) => {
    const f = await restoredRemovalSourceFixture(2);
    try {
      const survivor = await f.database.custodyProofBackupAuthorities.get([
        f.scopeId,
        f.proofs[1]!.proofId,
      ]);
      const result = await f.driver.removeManagedProofs({
        asset: f.asset,
        targets: f.targets(f.proofs.slice(0, count)),
      });
      expect(result.kind).toBe("completed");
      expect(f.errors).toEqual([]);
      expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(2);
      expect(await f.database.custodyProofs.count()).toBe(2 - count);
      expect(await f.database.custodyOperations.count()).toBe(0);
      expect(await f.database.encryptedWalletBackupV2AcceptedHeads.count()).toBe(0);
      const call = f.remote.remote.mutateHead.mock.calls.at(-1)![0];
      const group = decodeEncryptedWalletBackupOwnerUploadGroup({
        bytes: call.canonicalUploadGroup,
        expectedContext: f.remote.context,
        expectedRequestAuthPublicKey: f.keyHandle.requestAuthPublicKey,
      });
      const descriptor = group.mutationEvidence.envelope.mutation.addedBundle;
      if (count === 2) expect(descriptor).toBeNull();
      else {
        if (descriptor === null) throw new Error("replacement missing");
        const decrypted = await decryptEncryptedWalletBackupV2ProofSetBundle({
          keyHandle: f.keyHandle,
          seed: removalSeed,
          expectedAsset: f.asset,
          custodyRevision: 2n,
          descriptor,
          objects: group.objects,
          runtime: crypto,
        });
        expect(decrypted.proofs.map((row) => row.proofId)).toEqual([f.proofs[1]!.proofId]);
        expect(
          await f.database.custodyProofBackupAuthorities.get([f.scopeId, f.proofs[1]!.proofId]),
        ).toEqual(survivor);
      }
    } finally {
      await f.close();
    }
  },
);

it("unavailable authenticated object retains all restored proofs before intent or publication", async () => {
  const f = await restoredRemovalSourceFixture();
  try {
    vi.mocked(f.client.readObject).mockRejectedValue(new Error("controlled object unavailable"));
    await expect(
      f.driver.removeManagedProofs({ asset: f.asset, targets: f.targets() }),
    ).rejects.toThrow("controlled object unavailable");
    expect(await f.database.custodyProofs.count()).toBe(2);
    expect(await f.store.readPreparedMutation()).toBeNull();
    expect(
      (await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]?.removalIntent,
    ).toBeNull();
    expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("session loss during actual restored-source object read creates no intent or mutation", async () => {
  const f = await restoredRemovalSourceFixture();
  let release!: () => void;
  try {
    let announce!: () => void;
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.client.readObject).mockImplementation(async (request) => {
      announce();
      await held;
      return f.remote.remote.readObject(request);
    });
    const operation = f.driver.removeManagedProofs({ asset: f.asset, targets: f.targets() });
    const refused = expect(operation).rejects.toThrow("Owner changed");
    await entered;
    f.loseSession();
    release();
    await refused;
    expect(await f.database.custodyProofs.count()).toBe(2);
    expect(
      (await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]?.removalIntent,
    ).toBeNull();
    expect(await f.database.encryptedWalletBackupOwnerPreparedMutations.count()).toBe(0);
    expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
  } finally {
    release?.();
    await f.close();
  }
});

it("lost removal reply survives reopen and replays exact prepared bytes without refetching restored source", async () => {
  const f = await restoredRemovalSourceFixture();
  let reopened: import("@/stores/proof-db").BitcasterDB | undefined;
  try {
    f.remote.loseNextSuccessfulReply();
    const result = await f.driver.removeManagedProofs({ asset: f.asset, targets: f.targets() });
    expect(result.kind).toBe("started");
    const prepared = await f.store.readPreparedMutation();
    expect(prepared).not.toBeNull();
    expect(await f.database.custodyProofs.count()).toBe(2);
    await f.stop();
    f.database.close();
    const { BitcasterDB } = await import("@/stores/proof-db");
    const { runBrowserEncryptedWalletBackupOwnerWorkerCycle } =
      await import("../browserEncryptedWalletBackupOwnerWorker");
    const { finalizeBrowserCtfRemove, readBrowserCtfRemoveCompletion } =
      await import("../browserCtfRemoveCoordinator");
    reopened = new BitcasterDB(f.database.name);
    await reopened.open();
    const read = vi
      .spyOn(f.remote.remote, "readObject")
      .mockRejectedValue(new Error("must not refetch"));
    expect(
      (
        await runBrowserEncryptedWalletBackupOwnerWorkerCycle({
          database: reopened,
          scopeId: f.scopeId,
          keyHandle: f.keyHandle,
          owner: f.owner,
          enrollmentEpoch: 1,
          seed: removalSeed,
          remote: f.remote.remote,
          runtime: crypto,
          signal: new AbortController().signal,
          isCurrentProfile: () => true,
        })
      ).kind,
    ).toBe("committed");
    expect(read).not.toHaveBeenCalled();
    expect(f.remote.remote.mutateHead.mock.calls.at(-1)![0].canonicalUploadGroup).toEqual(
      prepared!.canonicalUploadGroup,
    );
    reopened.close();
    reopened = new BitcasterDB(f.database.name);
    await reopened.open();
    expect((await finalizeBrowserCtfRemove({ ...f.final(), database: reopened })).kind).toBe(
      "completed",
    );
    if (result.kind !== "started") throw new Error("expected pending original intent");
    expect(
      await readBrowserCtfRemoveCompletion({
        ...f.input(),
        database: reopened,
        intentId: result.intentId,
      }),
    ).toBe(true);
    expect(await reopened.custodyProofs.count()).toBe(0);
    expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(3);
  } finally {
    reopened?.close();
    await f.close();
  }
});

it("changed actual current head on final source recheck refuses before intent", async () => {
  const f = await restoredRemovalSourceFixture();
  try {
    const {
      createEncryptedWalletBackupOwnerCurrentHead,
      enumerateEncryptedWalletBackupOwnerDescriptorPages,
      collectEncryptedWalletBackupOwnerDescriptorPages,
    } = await import("@bitcaster/client-sdk/encryptedWalletBackupOwnerHead");
    const initial = f.remote.readHead();
    const changed = collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({
        head: createEncryptedWalletBackupOwnerCurrentHead({
          ...f.remote.context,
          headVersion: initial.head.headVersion + 1,
          bundles: initial.bundles,
        }),
        bundles: initial.bundles,
      }),
      f.remote.context,
    );
    vi.mocked(f.client.readCurrentHead)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed);
    await expect(
      f.driver.removeManagedProofs({ asset: f.asset, targets: f.targets() }),
    ).rejects.toThrow("head changed");
    expect(
      (await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]?.removalIntent,
    ).toBeNull();
    expect(await f.database.custodyProofs.count()).toBe(2);
    expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("same-ID body mutation during object read refuses the captured local tuples before intent", async () => {
  const f = await restoredRemovalSourceFixture();
  try {
    const { deserializeDurableCustodyProofArtifact } =
      await import("@bitcaster/client-sdk/durableCustodyProofMaterial");
    const { createBrowserCustodyProofRow } = await import("@/stores/durable-custody-db");
    let changed = false;
    vi.mocked(f.client.readObject).mockImplementation(async (request) => {
      if (!changed) {
        changed = true;
        const old = f.proofs[0]!;
        const proof = deserializeDurableCustodyProofArtifact(
          JSON.parse(new TextDecoder().decode(old.proofBody)),
        );
        const replacement = createBrowserCustodyProofRow({
          scopeId: f.scopeId,
          normalizedMint: old.normalizedMint,
          unit: "msat",
          proof: { ...proof, C: "03" + "22".repeat(32) } as never,
          asset: {
            kind: "conditional",
            conditionId: old.conditionId!,
            outcomeCollection: old.outcomeCollection!,
          },
          receivedAtMs: old.receivedAtMs,
        });
        await f.database.custodyProofs.put({
          ...old,
          proofBody: replacement.proofBody,
          proofFingerprint: replacement.proofFingerprint,
        });
      }
      return f.remote.remote.readObject(request);
    });
    await expect(
      f.driver.removeManagedProofs({ asset: f.asset, targets: f.targets() }),
    ).rejects.toThrow();
    expect(
      (await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]?.removalIntent,
    ).toBeNull();
    expect(await f.database.custodyProofs.count()).toBe(2);
    expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("existing valid value receipt keeps its source path and never reads restored source", async () => {
  const { ownerCtfRemovalFixture } = await import("./fixtures/ownerCtfRemovalProofs");
  const { startBrowserCtfRemove } = await import("../browserCtfRemoveCoordinator");
  const f = await ownerCtfRemovalFixture(2, true);
  try {
    const fallback = vi.fn(async () => {
      throw new Error("must not load restored source");
    });
    expect(
      (
        await startBrowserCtfRemove({
          ...f.input(),
          loadCurrentOwnerRestoredRemovalSource: fallback,
        })
      ).kind,
    ).toBe("started");
    expect(fallback).not.toHaveBeenCalled();
    expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
  } finally {
    f.database.close();
    await f.database.delete();
  }
});

it("present stale value receipt cannot fall back to restored source even when capture is unavailable", async () => {
  const { ownerCtfRemovalFixture } = await import("./fixtures/ownerCtfRemovalProofs");
  const { startBrowserCtfRemove } = await import("../browserCtfRemoveCoordinator");
  const f = await ownerCtfRemovalFixture(2, true);
  try {
    const row = (await f.database.encryptedWalletBackupOwnerAssetReceipts.toArray())[0]!;
    await f.database.encryptedWalletBackupOwnerAssetReceipts.put({
      ...row,
      bundleDescriptorDigest: "ff".repeat(32),
    });
    expect(
      await f.remote.store.captureBackupReceiptForLocalAsset(f.desired.localAssetKey),
    ).toBeNull();
    const fallback = vi.fn(async () => {
      throw new Error("must not load restored source");
    });
    expect(
      await startBrowserCtfRemove({
        ...f.input(),
        loadCurrentOwnerRestoredRemovalSource: fallback,
      }),
    ).toMatchObject({ kind: "pending", reason: "backup-not-ready" });
    expect(fallback).not.toHaveBeenCalled();
    expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
    expect(
      (await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]?.removalIntent,
    ).toBeNull();
  } finally {
    f.database.close();
    await f.database.delete();
  }
});

it("incomplete value-receipt callback keeps original pending result and never selects restored source", async () => {
  const { ownerCtfRemovalFixture } = await import("./fixtures/ownerCtfRemovalProofs");
  const { startBrowserCtfRemove } = await import("../browserCtfRemoveCoordinator");
  const f = await ownerCtfRemovalFixture(2, true);
  try {
    const fallback = vi.fn(async () => {
      throw new Error("must not load restored source");
    });
    const load = async (localAssetKey: string) => ({
      ...(await f.remote.loadCurrentOwnerReachabilityEvidence(localAssetKey)),
      backupReceiptSnapshot: undefined,
    });
    expect(
      await startBrowserCtfRemove({
        ...f.input(),
        loadCurrentOwnerReachabilityEvidence: load,
        loadCurrentOwnerRestoredRemovalSource: fallback,
      }),
    ).toMatchObject({ kind: "pending", reason: "backup-not-ready" });
    expect(fallback).not.toHaveBeenCalled();
    expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
    expect(
      (await f.database.encryptedWalletBackupV2DesiredAssets.toArray())[0]?.removalIntent,
    ).toBeNull();
  } finally {
    f.database.close();
    await f.database.delete();
  }
});
