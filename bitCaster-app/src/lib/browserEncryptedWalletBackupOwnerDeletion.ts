import {
  digestEncryptedWalletBackupV2BundleDescriptor,
  type EncryptedWalletBackupV2BundleDescriptor,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2Descriptor";
import {
  requireEncryptedWalletBackupOwnerCollectedHeadEvidence,
  requireEncryptedWalletBackupOwnerContext,
  type EncryptedWalletBackupOwnerContext,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerDeletionAuthority";
import {
  requireEncryptedWalletBackupOwnerBackupReachabilityEvidence,
  type EncryptedWalletBackupOwnerBackupReachabilityEvidence,
} from "@bitcaster/client-sdk/encryptedWalletBackupOwnerDeletionAuthority";

export interface BrowserEncryptedWalletBackupOwnerReachabilityInput {
  readonly ownerScopeId: string | null;
  readonly evidence: unknown;
  readonly collectedHeadEvidence: unknown;
  readonly context: Omit<EncryptedWalletBackupOwnerContext, "ownerScopeId">;
  readonly expectedBundleId: string;
  readonly expectedAssetLocator: string;
  readonly expectedCustodyRevision: string;
  readonly expectedBundleDescriptor: EncryptedWalletBackupV2BundleDescriptor;
}

/** A fresh owner head collection captured by the adapter for one locked deletion attempt. */
export interface BrowserEncryptedWalletBackupOwnerReachabilitySnapshot {
  readonly evidence: unknown;
  readonly collectedHeadEvidence: unknown;
}

/** Validate SDK-issued evidence against one exact local backup asset. */
export function requireBrowserEncryptedWalletBackupOwnerReachability(
  input: BrowserEncryptedWalletBackupOwnerReachabilityInput,
): EncryptedWalletBackupOwnerBackupReachabilityEvidence {
  if (input.ownerScopeId === null) throw new Error("backup owner evidence is unavailable");
  const context: EncryptedWalletBackupOwnerContext = {
    ...input.context,
    ownerScopeId: input.ownerScopeId,
  };
  const evidence = requireEncryptedWalletBackupOwnerBackupReachabilityEvidence(
    input.evidence,
    context,
  );
  const collected = requireEncryptedWalletBackupOwnerCollectedHeadEvidence(
    input.collectedHeadEvidence,
    context,
  );
  requireEncryptedWalletBackupOwnerContext(evidence.context, context);
  if (
    evidence.bundle.bundleId !== input.expectedBundleId ||
    evidence.bundle.assetLocator !== input.expectedAssetLocator ||
    evidence.bundle.custodyRevision.toString() !== input.expectedCustodyRevision.toString() ||
    digestEncryptedWalletBackupV2BundleDescriptor(evidence.bundle) !==
      digestEncryptedWalletBackupV2BundleDescriptor(input.expectedBundleDescriptor) ||
    !collected.bundles.some(
      (bundle) =>
        bundle.bundleId === input.expectedBundleId &&
        bundle.assetLocator === input.expectedAssetLocator &&
        bundle.custodyRevision.toString() === input.expectedCustodyRevision.toString() &&
        digestEncryptedWalletBackupV2BundleDescriptor(bundle) ===
          digestEncryptedWalletBackupV2BundleDescriptor(input.expectedBundleDescriptor),
    )
  ) {
    throw new Error("backup owner reachability does not match the local asset");
  }
  return evidence;
}
