// @vitest-environment node
import { schnorr } from "@noble/curves/secp256k1.js";
import { expect, it } from "vitest";
import { createEncryptedWalletBackupV2KeyHandle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Keys";
import {
  collectEncryptedWalletBackupOwnerDescriptorPages,
  createEncryptedWalletBackupOwnerCurrentHead,
  enumerateEncryptedWalletBackupOwnerDescriptorPages,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import {
  prepareEncryptedWalletBackupOwnerBundleSupersessionMutation,
  verifyEncryptedWalletBackupOwnerBundleSupersessionMutation,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerMutation";
import {
  issueEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  issueEncryptedWalletBackupOwnerBackupReachabilityEvidence,
  verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";
import { requireBrowserEncryptedWalletBackupOwnerReachability } from "../browserEncryptedWalletBackupOwnerDeletion";

const OWNER = "aa".repeat(32);
const REALM = "backup.example";
const ASSET = "11".repeat(32);
const BUNDLE = "22".repeat(16);
const SIGNING_KEY_ID = "33".repeat(16);
const SIGNING_PRIVATE_KEY = new Uint8Array(32).fill(0x35);
const SIGNING_PUBLIC_KEY = Buffer.from(schnorr.getPublicKey(SIGNING_PRIVATE_KEY)).toString("hex");
const signDigest = (digest: Uint8Array) => schnorr.sign(digest, SIGNING_PRIVATE_KEY);
const descriptor = {
  formatVersion: 2 as const,
  realm: REALM,
  walletId: "bb".repeat(32),
  bundleId: BUNDLE,
  assetLocator: ASSET,
  declaredAmount: 1n,
  custodyRevision: 7n,
  payloadCommitment: "44".repeat(32),
  objects: [{ objectId: "55".repeat(16), digest: "66".repeat(32) }],
};

it("requires SDK-issued owner evidence bound to the selected owner and exact local asset", async () => {
  const keyHandle = await createEncryptedWalletBackupV2KeyHandle({
    seed: new Uint8Array(64).fill(0x17),
    realm: REALM,
    runtime: { subtle: crypto.subtle },
  });
  descriptor.walletId = keyHandle.walletId;
  const context = {
    ownerScopeId: OWNER,
    realm: REALM,
    walletId: keyHandle.walletId,
    enrollmentEpoch: 1,
  };
  const beforeHead = createEncryptedWalletBackupOwnerCurrentHead({
    ...context,
    bundles: [],
    headVersion: 0,
  });
  const before = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head: beforeHead, bundles: [] }),
    context,
  );
  const envelope = await prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
    keyHandle,
    expectedContext: context,
    expectedHeadEvidence: before,
    addedBundle: descriptor,
    supersededBundleIds: [],
    runtime: { getRandomValues: (target) => (target.fill(1), target) },
  });
  const mutationEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionMutation({
    envelope,
    expectedContext: context,
    expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const resultHead = createEncryptedWalletBackupOwnerCurrentHead({
    ...context,
    bundles: [descriptor],
    headVersion: 1,
  });
  const result = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head: resultHead, bundles: [descriptor] }),
    context,
  );
  const receipt = await issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    mutationEvidence,
    expectedContext: context,
    resultHead,
    signingKeyId: SIGNING_KEY_ID,
    signingPublicKey: SIGNING_PUBLIC_KEY,
    signDigest,
  });
  const verifiedReceipt = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    receipt,
    mutationEvidence,
    expectedContext: context,
    pinnedSigningKeys: [{ keyId: SIGNING_KEY_ID, publicKey: SIGNING_PUBLIC_KEY }],
  });
  const evidence = issueEncryptedWalletBackupOwnerBackupReachabilityEvidence({
    receiptEvidence: verifiedReceipt,
    expectedContext: context,
    collectedHeadEvidence: result,
  });
  const input = {
    ownerScopeId: OWNER,
    evidence,
    collectedHeadEvidence: result,
    context: { realm: REALM, walletId: keyHandle.walletId, enrollmentEpoch: 1 },
    expectedBundleId: BUNDLE,
    expectedAssetLocator: ASSET,
    expectedCustodyRevision: "7",
    expectedBundleDescriptor: descriptor,
  };
  expect(() => requireBrowserEncryptedWalletBackupOwnerReachability(input)).not.toThrow();
  expect(() =>
    requireBrowserEncryptedWalletBackupOwnerReachability({
      ...input,
      ownerScopeId: "cc".repeat(32),
    }),
  ).toThrow(/context is invalid/);
  expect(() =>
    requireBrowserEncryptedWalletBackupOwnerReachability({
      ...input,
      expectedAssetLocator: "77".repeat(32),
    }),
  ).toThrow(/does not match/);
  expect(() =>
    requireBrowserEncryptedWalletBackupOwnerReachability({
      ...input,
      expectedCustodyRevision: "8",
    }),
  ).toThrow(/does not match/);
  expect(() =>
    requireBrowserEncryptedWalletBackupOwnerReachability({
      ...input,
      expectedBundleId: "88".repeat(16),
    }),
  ).toThrow(/does not match/);
});

it("rejects absent and lookalike owner reachability evidence", () => {
  expect(() =>
    requireBrowserEncryptedWalletBackupOwnerReachability({
      ownerScopeId: null,
      evidence: {},
      collectedHeadEvidence: {},
      context: { realm: REALM, walletId: descriptor.walletId, enrollmentEpoch: 1 },
      expectedBundleId: BUNDLE,
      expectedAssetLocator: ASSET,
      expectedCustodyRevision: "7",
      expectedBundleDescriptor: descriptor,
    }),
  ).toThrow(/unavailable/);
  expect(() =>
    requireBrowserEncryptedWalletBackupOwnerReachability({
      ownerScopeId: OWNER,
      evidence: { context: { ownerScopeId: OWNER }, bundle: descriptor },
      collectedHeadEvidence: {},
      context: { realm: REALM, walletId: descriptor.walletId, enrollmentEpoch: 1 },
      expectedBundleId: BUNDLE,
      expectedAssetLocator: ASSET,
      expectedCustodyRevision: "7",
      expectedBundleDescriptor: descriptor,
    }),
  ).toThrow(/reachability evidence is invalid/);
});
