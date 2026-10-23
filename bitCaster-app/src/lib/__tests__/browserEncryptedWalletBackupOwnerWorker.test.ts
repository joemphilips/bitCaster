// @vitest-environment node
import "fake-indexeddb/auto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { prepareEncryptedWalletBackupV2TransportBundle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Bundle";
import {
  createEncryptedWalletBackupV2KeyHandle,
  deriveEncryptedWalletBackupV2AssetLocator,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2Keys";
import {
  createEncryptedWalletBackupOwnerCurrentHead,
  collectEncryptedWalletBackupOwnerDescriptorPages,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import { deriveEncryptedWalletBackupOwnerScope } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerScope";
import {
  issueEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";
import { decodeEncryptedWalletBackupOwnerUploadGroup } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import {
  createEncryptedWalletBackupV2DesiredAssetRow,
  decodeEncryptedWalletBackupV2DesiredAssetRow,
} from "@/stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { browserWalletDatabaseName } from "@/lib/browserWalletProfile";
import { runBrowserEncryptedWalletBackupOwnerWorkerCycle } from "../browserEncryptedWalletBackupOwnerWorker";
import type { BrowserEncryptedWalletBackupOwnerWorkerInput } from "../browserEncryptedWalletBackupOwnerWorker";
import { BitcasterDB } from "@/stores/proof-db";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "@/stores/encrypted-wallet-backup-owner-db";
import { BrowserWalletCounterDexieStore } from "@/stores/browser-wallet-counter-db";
import { createBrowserCustodyProofRow } from "@/stores/durable-custody-db";
import { createBrowserProofBackupAuthorityRow } from "@/stores/browser-proof-backup-authority";
import { webcrypto } from "node:crypto";
import Dexie from "dexie";
import { afterEach, describe, expect, it, vi } from "vitest";

const realm = "mainnet";
const ownerA = {
  ...deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: "test",
    ownerSubject: "owner-a",
  }),
  enrollmentEpoch: 1,
};
const ownerB = {
  ...deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: "test",
    ownerSubject: "owner-b",
  }),
  enrollmentEpoch: 1,
};
let database: BitcasterDB | undefined;
let databaseName: string | undefined;

afterEach(async () => {
  database?.close();
  database = undefined;
  if (databaseName !== undefined) await Dexie.delete(databaseName);
  databaseName = undefined;
});

describe("selected-owner backup worker", () => {
  it("durably refuses a nonempty first owner head before any upload", async () => {
    const runtime = {
      subtle: webcrypto.subtle as unknown as Pick<
        SubtleCrypto,
        "deriveBits" | "importKey" | "encrypt" | "decrypt"
      >,
      getRandomValues(target: Uint8Array) {
        return target.fill(9);
      },
    };
    const seed = Uint8Array.from({ length: 64 }, (_, index) => index + 1);
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({ seed, realm, runtime });
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    databaseName = browserWalletDatabaseName(scopeId);
    database = new BitcasterDB(databaseName);
    await database.open();
    const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      asset: {
        mintUrl: "https://mint.example",
        unit: "sat",
        assetIdentity: "cashu:competing-first-head",
      },
      declaredAmount: 1n,
      custodyRevision: 1n,
      canonicalPayload: Uint8Array.of(1),
      runtime,
    });
    const head = createEncryptedWalletBackupOwnerCurrentHead({
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 1,
      bundles: [bundle.descriptor],
    });
    const evidence = collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles: [bundle.descriptor] }),
      {
        ownerScopeId: ownerB.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    );
    const mutateHead = vi.fn();
    const result = await runBrowserEncryptedWalletBackupOwnerWorkerCycle({
      database,
      scopeId,
      seed,
      keyHandle,
      owner: ownerB,
      enrollmentEpoch: 1,
      remote: {
        readCurrentHead: async () => evidence,
        mutateHead,
      },
      runtime,
      signal: new AbortController().signal,
      isCurrentProfile: () => true,
    });
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      requestAuthPublicKey: keyHandle.requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });

    expect(result).toEqual({ kind: "recovery-required" });
    expect(await store.readNewWritePermission()).toMatchObject({
      localRecoveryStatus: "recovery-required",
      canWrite: false,
    });
    expect(mutateHead).not.toHaveBeenCalled();
  });

  it("uploads for owner B after switching from owner A despite the seed-scoped acknowledged flag", async () => {
    let random = 0;
    const runtime = {
      subtle: webcrypto.subtle as unknown as Pick<
        SubtleCrypto,
        "deriveBits" | "importKey" | "encrypt" | "decrypt"
      >,
      getRandomValues(target: Uint8Array) {
        random += 1;
        return target.fill(random);
      },
    };
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
      seed: Uint8Array.from({ length: 64 }, (_, index) => index + 1),
      realm,
      runtime,
    });
    const scopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: keyHandle.walletId,
    });
    databaseName = browserWalletDatabaseName(scopeId);
    database = new BitcasterDB(databaseName);
    await database.open();

    const asset = {
      mintUrl: "https://zzz.example",
      unit: "sat",
      assetIdentity: "cashu:ordinary",
    } as const;
    const removedAsset = {
      mintUrl: "https://aaa.example",
      unit: "sat",
      assetIdentity: "cashu:ordinary",
    } as const;
    const localDesired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    await database.encryptedWalletBackupV2DesiredAssets.put({
      ...localDesired,
      syncState: "acknowledged",
    });
    const counterKeysetId = `01${"33".repeat(32)}`;
    const counterProof = createBrowserCustodyProofRow({
      scopeId,
      normalizedMint: asset.mintUrl,
      unit: asset.unit,
      proof: {
        id: counterKeysetId,
        amount: 1 as never,
        secret: "counter-advances-owner-desired",
        C: `02${"22".repeat(32)}`,
      },
      asset: { kind: "regular" },
      receivedAtMs: 1,
    });
    await database.custodyProofs.add(counterProof);
    await database.custodyProofBackupAuthorities.add(
      createBrowserProofBackupAuthorityRow(
        counterProof,
        2,
        { schemaVersion: 1, kind: "nut13", keysetId: counterKeysetId, counter: 0 },
        "receive:counter-race",
      ),
    );
    const alreadyRemovedDesired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId,
      asset: removedAsset,
      custodyRevision: 1n,
      activeProofCount: 0,
    });
    await database.encryptedWalletBackupV2DesiredAssets.put(alreadyRemovedDesired);
    const foreignScopeId = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: "ab".repeat(32),
    });
    await database.encryptedWalletBackupV2DesiredAssets.put(
      createEncryptedWalletBackupV2DesiredAssetRow({
        scopeId: foreignScopeId,
        asset: { ...asset, mintUrl: "https://foreign.example" },
        custodyRevision: 1n,
        activeProofCount: 0,
      }),
    );
    const bundle = await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      asset,
      declaredAmount: 1n,
      custodyRevision: 1n,
      canonicalPayload: Uint8Array.of(0x2a),
      runtime,
    });
    const nextBundle = await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      asset,
      declaredAmount: 1n,
      custodyRevision: 2n,
      canonicalPayload: Uint8Array.of(0x2b),
      runtime,
    });
    const binding = {
      localAssetKey: localDesired.localAssetKey,
      assetLocator: bundle.descriptor.assetLocator,
      custodyRevision: "1",
      desiredAction: "replace" as const,
      activeProofCount: 1,
    };

    const storeA = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      requestAuthPublicKey: keyHandle.requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const ownerAEmptyHead = createEncryptedWalletBackupOwnerCurrentHead({
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 0,
      bundles: [],
    });
    const ownerAEmptyEvidence = collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({
        head: ownerAEmptyHead,
        bundles: [],
      }),
      {
        ownerScopeId: ownerA.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    );
    await storeA.acceptCurrentHead({ expectedHeadVersion: null, evidence: ownerAEmptyEvidence });
    const ownerAHead = createEncryptedWalletBackupOwnerCurrentHead({
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 1,
      bundles: [bundle.descriptor],
    });
    const ownerAEvidence = collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({
        head: ownerAHead,
        bundles: [bundle.descriptor],
      }),
      {
        ownerScopeId: ownerA.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    );
    await storeA.acceptCurrentHead({ expectedHeadVersion: 0, evidence: ownerAEvidence });
    await database.encryptedWalletBackupOwnerDesiredAssets.put({
      scopeId,
      ownerScopeId: ownerA.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
      ...binding,
      syncState: "acknowledged",
      lastObservedHeadVersion: 1,
      receiptDigest: "bb".repeat(32),
    });
    expect(await storeA.isDesiredAssetSynchronized(binding)).toBe(true);

    const ownerBHead = createEncryptedWalletBackupOwnerCurrentHead({
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
      headVersion: 0,
      bundles: [],
    });
    let remoteHead = collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({ head: ownerBHead, bundles: [] }),
      {
        ownerScopeId: ownerB.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
      },
    );
    const signingKey = new Uint8Array(32).fill(0x44);
    const signingKeyId = "cc".repeat(16);
    const pinnedSigningKeys = [
      {
        keyId: signingKeyId,
        publicKey: Buffer.from(schnorr.getPublicKey(signingKey)).toString("hex"),
      },
    ];
    const mutateHead = vi.fn(async (input: { readonly canonicalUploadGroup: Uint8Array }) => {
      const group = decodeEncryptedWalletBackupOwnerUploadGroup({
        bytes: input.canonicalUploadGroup,
        expectedContext: {
          ownerScopeId: ownerB.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
      });
      if (mutateHead.mock.calls.length === 1) {
        await new BrowserWalletCounterDexieStore({
          database: database!,
          scopeId,
        }).advanceToAtLeastInContext(
          { mintUrl: asset.mintUrl, unit: asset.unit },
          counterKeysetId,
          3,
          false,
        );
      }
      const mutation = group.mutationEvidence.envelope.mutation;
      const nextBundles = remoteHead.bundles.filter(
        (active) => !mutation.supersededBundleIds.includes(active.bundleId),
      );
      if (mutation.addedBundle !== null) nextBundles.push(mutation.addedBundle);
      const resultHead = createEncryptedWalletBackupOwnerCurrentHead({
        ownerScopeId: ownerB.ownerScopeId,
        realm,
        walletId: keyHandle.walletId,
        enrollmentEpoch: 1,
        headVersion: remoteHead.head.headVersion + 1,
        bundles: nextBundles,
      });
      const receipt = await issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
        mutationEvidence: group.mutationEvidence,
        expectedContext: {
          ownerScopeId: ownerB.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        resultHead,
        signingKeyId,
        signingPublicKey: pinnedSigningKeys[0]!.publicKey,
        signDigest: async (digest) =>
          schnorr.sign(digest, signingKey, new Uint8Array(32).fill(0x55)),
      });
      const evidence = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
        receipt,
        mutationEvidence: group.mutationEvidence,
        expectedContext: {
          ownerScopeId: ownerB.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
        pinnedSigningKeys,
      });
      remoteHead = collectEncryptedWalletBackupOwnerDescriptorPages(
        enumerateEncryptedWalletBackupOwnerDescriptorPages({
          head: resultHead,
          bundles: nextBundles,
        }),
        {
          ownerScopeId: ownerB.ownerScopeId,
          realm,
          walletId: keyHandle.walletId,
          enrollmentEpoch: 1,
        },
      );
      return evidence;
    });
    const remote = {
      readCurrentHead: async () => remoteHead,
      mutateHead,
    };
    const controller = new AbortController();
    const workerInput: BrowserEncryptedWalletBackupOwnerWorkerInput = {
      database,
      scopeId,
      seed: Uint8Array.from({ length: 64 }, (_, index) => index + 1),
      keyHandle,
      owner: ownerB,
      enrollmentEpoch: 1,
      remote,
      runtime,
      signal: controller.signal,
      isCurrentProfile: () => true,
      desiredAssetScanPageSize: 1,
      assetSource: {
        read: async ({ localAssetKey }) => {
          const raw = await database!.encryptedWalletBackupV2DesiredAssets.get([
            scopeId,
            localAssetKey,
          ]);
          if (raw === undefined) throw new Error("desired asset disappeared");
          const desired = decodeEncryptedWalletBackupV2DesiredAssetRow(raw);
          return {
            desired,
            asset: {
              mintUrl: desired.mintUrl,
              unit: desired.unit,
              assetIdentity: desired.assetIdentity,
            },
            proofs: [],
            losingProofs: [],
            refusalHistories: [],
            counterHighWaterMarks: [],
          };
        },
        prepare: async (snapshot) =>
          snapshot.desired.custodyRevision === "1" ? bundle : nextBundle,
      },
    };
    expect(await runBrowserEncryptedWalletBackupOwnerWorkerCycle(workerInput)).toEqual({
      kind: "head-accepted",
    });
    let cursorAdvances = 0;
    const result = await runWorkerUntilPageComplete(workerInput, () => {
      cursorAdvances += 1;
    });

    expect(result).toEqual({ kind: "stale-desired" });
    expect(cursorAdvances).toBe(1);
    expect(mutateHead).toHaveBeenCalledTimes(1);
    expect(
      await database.encryptedWalletBackupOwnerDesiredAssets.get([
        scopeId,
        ownerB.ownerScopeId,
        localDesired.localAssetKey,
      ]),
    ).toMatchObject({ syncState: "acknowledged", custodyRevision: "1" });
    expect(
      await database.encryptedWalletBackupV2DesiredAssets.get([
        scopeId,
        localDesired.localAssetKey,
      ]),
    ).toMatchObject({ custodyRevision: "2", syncState: "pending" });
    const storeB = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId,
      ownerScopeId: ownerB.ownerScopeId,
      realm,
      walletId: keyHandle.walletId,
      requestAuthPublicKey: keyHandle.requestAuthPublicKey,
      enrollmentEpoch: 1,
      isCurrent: () => true,
    });
    const nextBinding = { ...binding, custodyRevision: "2" };
    expect(await storeB.isDesiredAssetSynchronized(nextBinding)).toBe(false);
    expect(await storeB.readPreparedMutation()).toBeNull();
    expect(await runWorkerUntilPageComplete(workerInput)).toEqual({ kind: "committed" });
    expect(mutateHead).toHaveBeenCalledTimes(2);
    expect(await storeB.isDesiredAssetSynchronized(nextBinding)).toBe(true);
    const removedAssetLocator = await deriveEncryptedWalletBackupV2AssetLocator({
      keyHandle,
      mintUrl: removedAsset.mintUrl,
      unit: removedAsset.unit,
      assetIdentity: removedAsset.assetIdentity,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const recorded = await database.encryptedWalletBackupOwnerDesiredAssets.get([
        scopeId,
        ownerB.ownerScopeId,
        alreadyRemovedDesired.localAssetKey,
      ]);
      if (recorded !== undefined) break;
      await runWorkerUntilPageComplete(workerInput);
    }
    expect(
      await database.encryptedWalletBackupOwnerDesiredAssets.get([
        scopeId,
        ownerB.ownerScopeId,
        alreadyRemovedDesired.localAssetKey,
      ]),
    ).toMatchObject({
      assetLocator: removedAssetLocator,
      desiredAction: "remove",
      syncState: "acknowledged",
      receiptDigest: null,
    });
    expect(
      await database.encryptedWalletBackupOwnerDesiredAssets.get([
        scopeId,
        ownerB.ownerScopeId,
        createEncryptedWalletBackupV2DesiredAssetRow({
          scopeId: foreignScopeId,
          asset: { ...asset, mintUrl: "https://foreign.example" },
          custodyRevision: 1n,
          activeProofCount: 0,
        }).localAssetKey,
      ]),
    ).toBeUndefined();
  });
});

async function runWorkerUntilPageComplete(
  input: BrowserEncryptedWalletBackupOwnerWorkerInput,
  onCursorAdvance: () => void = () => undefined,
): Promise<Awaited<ReturnType<typeof runBrowserEncryptedWalletBackupOwnerWorkerCycle>>> {
  let nextInput = input;
  for (let page = 0; page < 256; page += 1) {
    const result = await runBrowserEncryptedWalletBackupOwnerWorkerCycle(nextInput);
    if (result.kind !== "scan-more") return result;
    onCursorAdvance();
    nextInput = { ...input, afterLocalAssetKey: result.afterLocalAssetKey };
  }
  throw new Error("owner desired asset test scan exceeded its page bound");
}
