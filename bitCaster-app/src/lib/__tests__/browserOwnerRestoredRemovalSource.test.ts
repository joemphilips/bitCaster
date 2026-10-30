// @vitest-environment node
import "fake-indexeddb/auto";
import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import {
  authorizeEncryptedWalletBackupOwnerRemoteTerminalSealReuse,
  bindEncryptedWalletBackupOwnerDecryptedProofSet,
  decryptEncryptedWalletBackupV2ProofSetBundle,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import {
  createDurableCustodyProofMaterialRecord,
  decodeDurableCustodyProofMaterialRecord,
} from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { decodeEncryptedWalletBackupOwnerUploadGroup } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "@/stores/encrypted-wallet-backup-owner-db";
import { ownerCtfRemovalFixture, removalSeed } from "./fixtures/ownerCtfRemovalProofs";

async function fixture() {
  const f = await ownerCtfRemovalFixture(2, true);
  let current = true;
  const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database: f.database,
    scopeId: f.scopeId,
    ...f.remote.context,
    requestAuthPublicKey: f.keyHandle.requestAuthPublicKey,
    isCurrent: () => current,
  });
  const group = decodeEncryptedWalletBackupOwnerUploadGroup({
    bytes: f.remote.remote.mutateHead.mock.calls[0]![0].canonicalUploadGroup,
    expectedContext: f.remote.context,
    expectedRequestAuthPublicKey: f.keyHandle.requestAuthPublicKey,
  });
  const descriptor = group.mutationEvidence.envelope.mutation.addedBundle!;
  const head = f.remote.readHead();
  const decrypted = await decryptEncryptedWalletBackupV2ProofSetBundle({
    keyHandle: f.keyHandle,
    seed: removalSeed,
    expectedAsset: f.asset,
    custodyRevision: descriptor.custodyRevision,
    descriptor,
    objects: group.objects,
    runtime: crypto,
  });
  const source = await authorizeEncryptedWalletBackupOwnerRemoteTerminalSealReuse({
    keyHandle: f.keyHandle,
    seed: removalSeed,
    expectedAsset: f.asset,
    expectedContext: f.remote.context,
    collectedHeadEvidence: head,
    decryptedEvidence: bindEncryptedWalletBackupOwnerDecryptedProofSet({
      proofSet: decrypted,
      expectedContext: f.remote.context,
      collectedHeadEvidence: head,
    }),
  });
  const receipt = (await f.database.encryptedWalletBackupOwnerAssetReceipts.toArray())[0]!;
  await f.database.encryptedWalletBackupOwnerAssetReceipts.clear();
  const desired = {
    localAssetKey: f.desired.localAssetKey,
    assetLocator: f.assetLocator,
    custodyRevision: f.desired.custodyRevision,
    desiredAction: f.desired.desiredAction,
    activeProofCount: f.desired.activeProofCount,
  };
  const input = {
    source,
    desired,
    targets: f.proofs.map((proof) => ({
      proofId: proof.proofId,
      proofFingerprint: proof.proofFingerprint,
      proofRevision: proof.revision,
    })),
  };
  const check = (override: Partial<typeof input> = {}) =>
    f.database.transaction("rw", f.database.tables, () =>
      store.assertCurrentRestoredRemovalSourceInTransaction({ ...input, ...override }),
    );
  return {
    ...f,
    store,
    source,
    receipt,
    input,
    check,
    loseSession: () => {
      current = false;
    },
    close: async () => {
      f.database.close();
      await f.database.delete();
    },
  };
}

it("authenticates all restored source material without a value receipt and writes no authority", async () => {
  const f = await fixture();
  try {
    const before = await Promise.all(f.database.tables.map((table) => table.toArray()));
    expect(await f.store.hasBackupReceiptForLocalAsset(f.desired.localAssetKey)).toBe(false);
    await f.check();
    await f.check({ targets: [f.input.targets[0]!] });
    expect(
      isDeepStrictEqual(
        await Promise.all(f.database.tables.map((table) => table.toArray())),
        before,
      ),
    ).toBe(true);
    expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("a present but stale receipt blocks restored fallback even when capture returns null", async () => {
  const f = await fixture();
  try {
    await f.database.encryptedWalletBackupOwnerAssetReceipts.put({
      ...f.receipt,
      bundleDescriptorDigest: "ff".repeat(32),
    });
    expect(
      (await f.store.captureBackupReceiptForLocalAsset(f.desired.localAssetKey)) === null,
    ).toBe(true);
    expect(await f.store.hasBackupReceiptForLocalAsset(f.desired.localAssetKey)).toBe(true);
    await expect(f.check()).rejects.toThrow(/cannot replace a value receipt/);
  } finally {
    await f.close();
  }
});

it("refuses copied aggregate, target revision, missing target, duplicate target and foreign asset", async () => {
  const f = await fixture();
  try {
    await expect(f.check({ source: { ...f.source } })).rejects.toThrow(/result is invalid/);
    await expect(
      f.check({ targets: [{ ...f.input.targets[0]!, proofRevision: 999 }] }),
    ).rejects.toThrow(/proof set changed/);
    await expect(
      f.check({ targets: [{ ...f.input.targets[0]!, proofId: "ff".repeat(32) }] }),
    ).rejects.toThrow(/proof set changed/);
    await expect(f.check({ targets: [f.input.targets[0]!, f.input.targets[0]!] })).rejects.toThrow(
      /proof set changed/,
    );
    await expect(
      f.check({ desired: { ...f.input.desired, assetLocator: "ff".repeat(32) } }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("rechecks recovery permission with the same accepted signed head", async () => {
  const f = await fixture();
  try {
    await f.store.markCompetingHeadRecoveryRequired({ evidence: f.remote.readHead() });
    await expect(f.check()).rejects.toThrow(/source changed/);
    expect(await f.database.custodyProofs.count()).toBe(2);
  } finally {
    await f.close();
  }
});

it("rejects a local-operation losing origin and exact locator drift", async () => {
  const f = await fixture();
  try {
    const key = [f.scopeId, f.proofs[0]!.proofId];
    const authority = (await f.database.custodyProofBackupAuthorities.get(key))!;
    await f.database.custodyProofBackupAuthorities.put({
      ...authority,
      terminalAuthority: { kind: "local-operation", operationId: "foreign-operation" },
      terminalOperationId: "foreign-operation",
    } as typeof authority);
    await expect(f.check()).rejects.toThrow();
    await f.database.custodyProofBackupAuthorities.put({
      ...authority,
      derivationLocator: null,
    } as typeof authority);
    await expect(f.check()).rejects.toThrow(/material changed/);
  } finally {
    await f.close();
  }
});

it("refuses changed survivor body, stale desired count, and lost selected session", async () => {
  const f = await fixture();
  try {
    const proof = f.proofs[1]!;
    await f.database.custodyProofs.put({ ...proof, amount: proof.amount + 1 });
    await expect(f.check({ targets: [f.input.targets[0]!] })).rejects.toThrow();
    await f.database.custodyProofs.put(proof);
    await expect(f.check({ desired: { ...f.input.desired, activeProofCount: 1 } })).rejects.toThrow(
      /source changed/,
    );
    f.loseSession();
    await expect(f.check()).rejects.toThrow();
  } finally {
    await f.close();
  }
});

it("rejects exact-ID changed valid survivor material before any intent write", async () => {
  const f = await fixture();
  try {
    const proof = f.proofs[1]!;
    const body = decodeDurableCustodyProofMaterialRecord(proof).proof;
    const material = createDurableCustodyProofMaterialRecord({
      scopeId: f.scopeId,
      normalizedMint: proof.normalizedMint,
      unit: proof.unit,
      proof: { ...body, amount: proof.amount + 1 },
    });
    expect(material.proofId).toBe(proof.proofId);
    await f.database.custodyProofs.put({ ...proof, ...material });
    const key = [f.scopeId, proof.proofId];
    const authority = (await f.database.custodyProofBackupAuthorities.get(key))!;
    await f.database.custodyProofBackupAuthorities.put({
      ...authority,
      proofFingerprint: material.proofFingerprint,
    });
    await expect(f.check({ targets: [f.input.targets[0]!] })).rejects.toThrow(/material changed/);
    expect(
      (
        await f.database.encryptedWalletBackupV2DesiredAssets.get([
          f.scopeId,
          f.desired.localAssetKey,
        ])
      )?.removalIntent === null,
    ).toBe(true);
    expect(f.remote.remote.mutateHead).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("rejects missing survivor and malformed present receipt without treating either as absent", async () => {
  const f = await fixture();
  try {
    await f.database.custodyProofs.delete([f.scopeId, f.proofs[1]!.proofId]);
    await expect(f.check({ targets: [f.input.targets[0]!] })).rejects.toThrow(/proof set changed/);
    await f.database.custodyProofs.put(f.proofs[1]!);
    await f.database.encryptedWalletBackupOwnerAssetReceipts.put({
      ...f.receipt,
      canonicalSignedReceipt: new Uint8Array(),
    });
    expect(await f.store.hasBackupReceiptForLocalAsset(f.desired.localAssetKey)).toBe(true);
    await expect(f.check()).rejects.toThrow(/cannot replace a value receipt/);
  } finally {
    await f.close();
  }
});
