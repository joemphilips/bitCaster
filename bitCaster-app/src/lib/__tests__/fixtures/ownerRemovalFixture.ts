import { schnorr } from "@noble/curves/secp256k1.js";
import {
  createEncryptedWalletBackupOwnerCurrentHead,
  collectEncryptedWalletBackupOwnerDescriptorPages,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import {
  issueEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";
import { decodeEncryptedWalletBackupOwnerUploadGroup } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerUpload";
import { EncryptedWalletBackupOwnerClient } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerClient";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "@/stores/encrypted-wallet-backup-owner-db";
import type { BrowserEncryptedWalletBackupOwnerWorkerInput } from "@/lib/browserEncryptedWalletBackupOwnerWorker";
import { vi } from "vitest";

/** Real SDK signing/head application with an in-memory remote transport boundary. */
export async function createOwnerRemovalRemote(
  input: Pick<
    BrowserEncryptedWalletBackupOwnerWorkerInput,
    "database" | "scopeId" | "keyHandle" | "owner" | "enrollmentEpoch"
  > & { isCurrent?: () => boolean },
) {
  const context = {
    ownerScopeId: input.owner.ownerScopeId,
    realm: input.keyHandle.realm,
    walletId: input.keyHandle.walletId,
    enrollmentEpoch: input.enrollmentEpoch,
  };
  const current = input.isCurrent ?? (() => true);
  const signingKey = new Uint8Array(32).fill(0x42);
  const signingKeyId = "42".repeat(16);
  const pinnedSigningKeys = [
    {
      keyId: signingKeyId,
      publicKey: Array.from(schnorr.getPublicKey(signingKey), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    },
  ];
  let head = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head: createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: 0,
        bundles: [],
      }),
      bundles: [],
    }),
    context,
  );
  const store = new EncryptedWalletBackupOwnerDexieAuthorityStore({
    database: input.database,
    scopeId: input.scopeId,
    ...context,
    requestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
    isCurrent: current,
  });
  await store.acceptCurrentHead({ expectedHeadVersion: null, evidence: head });
  const receipts = new Map<
    string,
    ReturnType<typeof verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt>
  >();
  const objects = new Map<
    string,
    ReturnType<typeof decodeEncryptedWalletBackupOwnerUploadGroup>["objects"][number]
  >();
  let loseReply = false;
  const mutateHead = vi.fn(
    async (
      request: Parameters<BrowserEncryptedWalletBackupOwnerWorkerInput["remote"]["mutateHead"]>[0],
    ) => {
      const group = decodeEncryptedWalletBackupOwnerUploadGroup({
        bytes: request.canonicalUploadGroup,
        expectedContext: context,
        expectedRequestAuthPublicKey: input.keyHandle.requestAuthPublicKey,
      });
      const replay = receipts.get(group.mutationEvidence.envelope.requestDigest);
      if (replay !== undefined) return replay;
      const mutation = group.mutationEvidence.envelope.mutation;
      if (
        mutation.expectedHeadVersion !== head.head.headVersion ||
        mutation.expectedActiveSetDigest !== head.head.activeSetDigest
      )
        throw new Error("fixture head conflict");
      const bundles = head.bundles.filter(
        (bundle) => !mutation.supersededBundleIds.includes(bundle.bundleId),
      );
      if (mutation.addedBundle !== null) bundles.push(mutation.addedBundle);
      const resultHead = createEncryptedWalletBackupOwnerCurrentHead({
        ...context,
        headVersion: head.head.headVersion + 1,
        bundles,
      });
      const receipt = await issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
        mutationEvidence: group.mutationEvidence,
        expectedContext: context,
        resultHead,
        signingKeyId,
        signingPublicKey: pinnedSigningKeys[0]!.publicKey,
        signDigest: async (digest) =>
          schnorr.sign(digest, signingKey, new Uint8Array(32).fill(0x55)),
      });
      const evidence = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
        receipt,
        mutationEvidence: group.mutationEvidence,
        expectedContext: context,
        pinnedSigningKeys,
      });
      head = collectEncryptedWalletBackupOwnerDescriptorPages(
        enumerateEncryptedWalletBackupOwnerDescriptorPages({ head: resultHead, bundles }),
        context,
      );
      for (const object of group.objects) objects.set(object.objectId, structuredClone(object));
      receipts.set(group.mutationEvidence.envelope.requestDigest, evidence);
      if (loseReply) {
        loseReply = false;
        throw new Error("fixture lost successful reply");
      }
      return evidence;
    },
  );
  const client = new EncryptedWalletBackupOwnerClient({
    origin: "https://backup.example",
    keyHandle: input.keyHandle,
    pinnedReceiptKeys: pinnedSigningKeys,
  });
  return {
    store,
    context,
    client,
    remote: {
      readCurrentHead: async () => head,
      mutateHead,
      readObject: async (
        request: Parameters<EncryptedWalletBackupOwnerClient["readObject"]>[0],
      ) => {
        if (
          request.owner.ownerScopeId !== context.ownerScopeId ||
          request.enrollmentEpoch !== context.enrollmentEpoch ||
          !head.bundles.some((bundle) => bundle.bundleId === request.descriptor.bundleId) ||
          !request.descriptor.objects.some((object) => object.objectId === request.objectId)
        )
          throw new Error("fixture owner object binding is invalid");
        const object = objects.get(request.objectId);
        if (object === undefined) throw new Error("fixture owner object is absent");
        return structuredClone(object);
      },
    },
    loseNextSuccessfulReply() {
      loseReply = true;
    },
    readHead: () => head,
    async loadCurrentOwnerReachabilityEvidence(localAssetKey: string) {
      const snapshot = await store.captureBackupReceiptForLocalAsset(localAssetKey);
      if (snapshot === null) throw new Error("fixture exact owner receipt is absent");
      return {
        backupReceiptSnapshot: snapshot,
        collectedHeadEvidence: head,
        evidence: client.verifyStoredBackupReachability({
          expectedContext: context,
          canonicalSignedMutation: snapshot.receipt.canonicalSignedMutation,
          canonicalSignedReceipt: snapshot.receipt.canonicalSignedReceipt,
          collectedHeadEvidence: head,
        }),
      };
    },
  };
}
