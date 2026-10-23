// @vitest-environment node
import {
  createEncryptedWalletBackupV2AssetIdentity,
  createEncryptedWalletBackupV2KeyHandle,
  prepareEncryptedWalletBackupV2ProofSetBundle,
  prepareEncryptedWalletBackupV2TransportBundle,
} from "@bitcaster/client-sdk";
import { deserializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import {
  collectEncryptedWalletBackupOwnerDescriptorPages,
  createEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import { prepareEncryptedWalletBackupOwnerBundleSupersessionMutation } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerMutation";
import { encodeEncryptedWalletBackupOwnerUploadGroup } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import { digestEncryptedWalletBackupV2BundleDescriptor } from "@bitcaster/client-sdk/encryptedWalletBackupV2Descriptor";
import { Keyset, OutputData, hashToCurve, type Wallet } from "@cashu/cashu-ts";
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createEncryptedWalletBackupV2DesiredAssetRow } from "../../stores/browser-encrypted-wallet-backup-v2-desired-asset";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../../stores/encrypted-wallet-backup-owner-db";
import { BitcasterDB } from "../../stores/proof-db";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { restoreAndAdmitBrowserEncryptedWalletBackupOwnerTargetedAsset } from "../browserEncryptedWalletBackupV2Restore";
import { browserWalletDatabaseName } from "../browserWalletProfile";
import {
  CONDITION,
  KEYS,
  MINT,
  OUTCOME,
  OUTCOME_ID,
  SEED,
  signOutputs,
} from "./fixtures/browserCtfRedeemFixture";
import { createMixedCtfRemoveFixture } from "./fixtures/browserMixedCtfRemoveFixture";

const databases: BitcasterDB[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) {
    db.close();
    await db.delete();
  }
});
const runtime = webcrypto as unknown as Parameters<
  typeof prepareEncryptedWalletBackupV2ProofSetBundle
>[0]["runtime"];
const locks = {
  request: async (_name: unknown, _options: unknown, action: (lock: unknown) => unknown) =>
    action({}),
} as Pick<LockManager, "request">;

for (const mixed of [false, true])
  it(`refuses a prepared mutation inserted after the early check before ${mixed ? "mixed" : "sealed"} admission`, async () => {
    const source = await createMixedCtfRemoveFixture();
    databases.push(source.database);
    const raw = await source.database.custodyProofBackupAuthorities.get([
      source.scopeId,
      source.managedProof.proofId,
    ]);
    if (
      raw === undefined ||
      !("terminalAuthority" in raw) ||
      raw.terminalAuthority?.kind !== "remote-seal"
    )
      throw new Error("genuine committed seal missing");
    const sealedProof = deserializeDurableCustodyProofArtifact(
      JSON.parse(new TextDecoder().decode(source.managedProof.proofBody)),
    );
    const locator = raw.derivationLocator;
    if (locator === null) throw new Error("committed seal locator missing");
    const keysetId = sealedProof.id;
    const keysetAuthority = await source.database.custodyConditionalKeysets.get([
      source.scopeId,
      MINT,
      "msat",
      keysetId,
    ]);
    if (keysetAuthority === undefined) throw new Error("source keyset absent");
    const seal = source.terminalSeal;
    source.database.close();
    await source.database.delete();
    const scope = browserWalletScope(SEED);
    const database = new BitcasterDB(browserWalletDatabaseName(scope.scopeId));
    databases.push(database);
    await database.open();
    const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
      seed: SEED,
      realm: "backup.example",
      runtime,
    });
    const owner = {
      ownerScopeId: "ab".repeat(32),
      authorizationScheme: "test",
      ownerSubject: "owner",
      enrollmentEpoch: 1,
    };
    const context = {
      ownerScopeId: owner.ownerScopeId,
      realm: keyHandle.realm,
      walletId: keyHandle.walletId,
      enrollmentEpoch: 1,
    };
    const assetFields = {
      kind: "ctf" as const,
      conditionId: CONDITION,
      outcomeLabel: OUTCOME,
      outcomeCollectionId: OUTCOME_ID,
      registeredAt: 0,
      finalExpiry: null,
    };
    const asset = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: MINT,
      unit: "msat",
      asset: assetFields,
    });
    const live = signOutputs([OutputData.createSingleDeterministicData(1, SEED, 20, keysetId)])[0]!;
    const bundle = await prepareEncryptedWalletBackupV2ProofSetBundle({
      keyHandle,
      seed: SEED,
      asset,
      custodyRevision: 1n,
      counterHighWaterMarks: [{ mintUrl: MINT, unit: "msat", keysetId, nextCounter: 21 }],
      proofs: [
        {
          mintUrl: MINT,
          unit: "msat",
          asset: assetFields,
          proof: sealedProof,
          locator,
          terminalSeal: seal,
        },
        ...(mixed
          ? [
              {
                mintUrl: MINT,
                unit: "msat" as const,
                asset: assetFields,
                proof: live,
                locator: {
                  schemaVersion: 1 as const,
                  kind: "nut13" as const,
                  keysetId,
                  counter: 20,
                },
              },
            ]
          : []),
      ],
      runtime,
    });
    const head = createEncryptedWalletBackupOwnerCurrentHead({
      ...context,
      headVersion: 1,
      bundles: [bundle.descriptor],
    });
    const collected = collectEncryptedWalletBackupOwnerDescriptorPages(
      enumerateEncryptedWalletBackupOwnerDescriptorPages({ head, bundles: [bundle.descriptor] }),
      context,
    );
    const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
      database,
      scopeId: scope.scopeId,
      ...context,
      requestAuthPublicKey: keyHandle.requestAuthPublicKey,
      isCurrent: () => true,
    });
    const empty = createEncryptedWalletBackupOwnerCurrentHead({
      ...context,
      headVersion: 0,
      bundles: [],
    });
    await store.acceptCurrentHead({
      expectedHeadVersion: null,
      evidence: collectEncryptedWalletBackupOwnerDescriptorPages(
        enumerateEncryptedWalletBackupOwnerDescriptorPages({ head: empty, bundles: [] }),
        context,
      ),
    });
    await store.acceptCurrentHead({ expectedHeadVersion: 0, evidence: collected });
    const other = createEncryptedWalletBackupV2AssetIdentity({
      mintUrl: MINT,
      unit: "msat",
      asset: { kind: "ordinary" },
    });
    const pendingBundle = await prepareEncryptedWalletBackupV2TransportBundle({
      keyHandle,
      asset: other,
      declaredAmount: 1n,
      custodyRevision: 1n,
      canonicalPayload: Uint8Array.of(1),
      runtime,
    });
    const desired = createEncryptedWalletBackupV2DesiredAssetRow({
      scopeId: scope.scopeId,
      asset: other,
      custodyRevision: 1n,
      activeProofCount: 1,
    });
    await database.encryptedWalletBackupV2DesiredAssets.put(desired);
    const envelope = await prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
      keyHandle,
      expectedContext: context,
      expectedHeadEvidence: collected,
      addedBundle: pendingBundle.descriptor,
      supersededBundleIds: [],
      runtime,
    });
    const binding = {
      localAssetKey: desired.localAssetKey,
      assetLocator: pendingBundle.descriptor.assetLocator,
      custodyRevision: "1",
      desiredAction: "replace" as const,
      activeProofCount: 1,
    };
    let inserted = false;
    const client = {
      readCurrentHead: async () => collected,
      readCurrentInventory: vi.fn(),
      readObject: async ({ objectId }: { objectId: string }) => {
        if (!inserted) {
          inserted = true;
          expect(
            await store.insertPreparedMutationForDesired({
              desired: binding,
              prepared: {
                ...binding,
                mutationId: envelope.mutation.mutationId,
                requestDigest: envelope.requestDigest,
                canonicalUploadGroup: encodeEncryptedWalletBackupOwnerUploadGroup({
                  envelope,
                  objects: pendingBundle.objects,
                }),
                createdAtUnixMilliseconds: 1,
              },
            }),
          ).toBe("inserted");
        }
        return bundle.objects.find((o) => o.objectId === objectId)!;
      },
    };
    const keyset = new Keyset(
      keysetId,
      "msat",
      true,
      keysetAuthority.inputFeePpk,
      keysetAuthority.finalExpiryUnixSeconds ?? undefined,
      {
        conditionId: CONDITION,
        outcomeCollection: OUTCOME,
        outcomeCollectionId: OUTCOME_ID,
        registeredAt: 0,
      },
    );
    keyset.keys = KEYS;
    const wallet = {
      mint: { mintUrl: MINT },
      keyChain: { loadConditionalKeyset: async () => keyset },
      getKeyset: () => keyset,
      checkProofsStates: async (proofs: readonly { secret: string }[]) =>
        proofs.map((p) => ({
          Y: hashToCurve(new TextEncoder().encode(p.secret)).toHex(true),
          state: "UNSPENT",
          witness: null,
        })),
    } as unknown as Wallet;
    await expect(
      restoreAndAdmitBrowserEncryptedWalletBackupOwnerTargetedAsset({
        database,
        scopeId: scope.scopeId,
        seed: SEED,
        keyHandle,
        asset,
        owner,
        ownerContext: context,
        ownerClient: client as never,
        ownerStore: store,
        inventory: {
          ...context,
          headVersion: 1,
          activeSetDigest: head.activeSetDigest,
          entries: [
            {
              assetLocator: bundle.descriptor.assetLocator,
              bundleId: bundle.descriptor.bundleId,
              descriptorDigest: digestEncryptedWalletBackupV2BundleDescriptor(bundle.descriptor),
              declaredAmount: bundle.descriptor.declaredAmount,
              custodyRevision: 1n,
            },
          ],
        },
        minimumAvailableAmount: 1n,
        loadWallet: async () => wallet,
        runtime,
        signal: new AbortController().signal,
        isCurrentProfile: () => true,
        lockManager: locks,
      }),
    ).rejects.toThrow(/pending mutation/);
    expect(inserted).toBe(true);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.walletCounterCursors.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.toArray()).toEqual([desired]);
  });
