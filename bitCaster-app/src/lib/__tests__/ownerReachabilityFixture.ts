import { schnorr } from "@noble/curves/secp256k1.js";
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
  issueEncryptedWalletBackupOwnerBackupReachabilityEvidence,
  issueEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerReceipt";
import {
  encodeEncryptedWalletBackupOwnerBundleSupersessionReceipt,
  encodeEncryptedWalletBackupOwnerSignedMutation,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerServiceCodec";
import type { EncryptedWalletBackupV2BundleDescriptor } from "@bitcaster/client-sdk/encryptedWalletBackupV2Descriptor";
import type { EncryptedWalletBackupV2KeyHandle } from "@bitcaster/client-sdk/encryptedWalletBackupV2Keys";

const OWNER_SIGNING_KEY_ID = "93".repeat(16);
const OWNER_SIGNING_PRIVATE_KEY = new Uint8Array(32).fill(0x35);
const OWNER_SIGNING_PUBLIC_KEY = Buffer.from(
  schnorr.getPublicKey(OWNER_SIGNING_PRIVATE_KEY),
).toString("hex");

export async function ownerReachabilitySnapshot(input: {
  readonly ownerScopeId: string;
  readonly descriptor: EncryptedWalletBackupV2BundleDescriptor;
  readonly enrollmentEpoch: number;
  readonly keyHandle?: EncryptedWalletBackupV2KeyHandle;
}) {
  const keyHandle =
    input.keyHandle ??
    (await createEncryptedWalletBackupV2KeyHandle({
      seed: new Uint8Array(64).fill(0x17),
      realm: input.descriptor.realm,
      runtime: { subtle: crypto.subtle },
    }));
  if (keyHandle.walletId !== input.descriptor.walletId)
    throw new Error("test descriptor wallet does not match owner key handle");
  const context = {
    ownerScopeId: input.ownerScopeId,
    realm: input.descriptor.realm,
    walletId: input.descriptor.walletId,
    enrollmentEpoch: input.enrollmentEpoch,
  };
  const emptyHead = createEncryptedWalletBackupOwnerCurrentHead({
    ...context,
    headVersion: 0,
    bundles: [],
  });
  const emptyEvidence = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({ head: emptyHead, bundles: [] }),
    context,
  );
  const envelope = await prepareEncryptedWalletBackupOwnerBundleSupersessionMutation({
    keyHandle,
    expectedContext: context,
    expectedHeadEvidence: emptyEvidence,
    addedBundle: input.descriptor,
    supersededBundleIds: [],
    runtime: { getRandomValues: (target) => (target.fill(1), target) },
  });
  const mutationEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionMutation({
    envelope,
    expectedContext: context,
    expectedRequestAuthPublicKey: keyHandle.requestAuthPublicKey,
  });
  const head = createEncryptedWalletBackupOwnerCurrentHead({
    ...context,
    headVersion: 1,
    bundles: [input.descriptor],
  });
  const collectedHeadEvidence = collectEncryptedWalletBackupOwnerDescriptorPages(
    enumerateEncryptedWalletBackupOwnerDescriptorPages({
      head,
      bundles: [input.descriptor],
    }),
    context,
  );
  const receipt = await issueEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    mutationEvidence,
    expectedContext: context,
    resultHead: head,
    signingKeyId: OWNER_SIGNING_KEY_ID,
    signingPublicKey: OWNER_SIGNING_PUBLIC_KEY,
    signDigest: (digest) => schnorr.sign(digest, OWNER_SIGNING_PRIVATE_KEY),
  });
  const receiptEvidence = verifyEncryptedWalletBackupOwnerBundleSupersessionReceipt({
    receipt,
    mutationEvidence,
    expectedContext: context,
    pinnedSigningKeys: [{ keyId: OWNER_SIGNING_KEY_ID, publicKey: OWNER_SIGNING_PUBLIC_KEY }],
  });
  const evidence = issueEncryptedWalletBackupOwnerBackupReachabilityEvidence({
    receiptEvidence,
    expectedContext: context,
    collectedHeadEvidence,
  });
  return {
    evidence,
    collectedHeadEvidence,
    pinnedSigningKey: { keyId: OWNER_SIGNING_KEY_ID, publicKey: OWNER_SIGNING_PUBLIC_KEY },
    receipt,
    canonicalSignedReceipt: encodeEncryptedWalletBackupOwnerBundleSupersessionReceipt(receipt),
    canonicalSignedMutation: encodeEncryptedWalletBackupOwnerSignedMutation(envelope),
  };
}
