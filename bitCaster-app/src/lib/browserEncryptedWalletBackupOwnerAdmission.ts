import type { EncryptedWalletBackupOwnerContext } from "@bitcaster/client-sdk/encryptedWalletBackupOwnerHead";
import {
  requireEncryptedWalletBackupOwnerVerifiedProofSet,
  createEncryptedWalletBackupV2AssetIdentity,
} from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import type { EncryptedWalletBackupOwnerVerifiedProofSet } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import type { Wallet as CashuWallet } from "@cashu/cashu-ts";
import type { EncryptedWalletBackupV2AssetIdentity } from "@bitcaster/client-sdk";
import type { BitcasterDB } from "../stores/proof-db";
import { EncryptedWalletBackupOwnerDexieAuthorityStore } from "../stores/encrypted-wallet-backup-owner-db";
import { encryptedWalletBackupV2LocalAssetKey } from "@bitcaster/client-sdk/encryptedWalletBackupV2ProofSet";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import {
  admitBrowserEncryptedWalletBackupV2Asset,
  admitBrowserEncryptedWalletBackupV2MixedAsset,
  admitBrowserEncryptedWalletBackupV2SealedAsset,
} from "./browserEncryptedWalletBackupV2Admission";

export interface BrowserEncryptedWalletBackupOwnerAdmissionInput {
  readonly seed: Uint8Array;
  readonly verified: EncryptedWalletBackupOwnerVerifiedProofSet;
  readonly collectedHeadEvidence: unknown;
  readonly ownerContext: EncryptedWalletBackupOwnerContext;
  readonly ownerAuthorityStore: EncryptedWalletBackupOwnerDexieAuthorityStore;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly database: BitcasterDB;
  readonly wallet?: CashuWallet;
  readonly sourceOperationId: string;
  readonly isCurrentProfile: () => boolean;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly lockManager?: Pick<LockManager, "request">;
}

/** Admit owner-bound proofs after rechecking the exact owner head in the custody commit. */
export async function admitBrowserEncryptedWalletBackupOwnerAsset(
  input: BrowserEncryptedWalletBackupOwnerAdmissionInput,
): Promise<void> {
  if (input.asset.unit !== "msat") throw new Error("browser owner restore requires msat");
  const verified = requireEncryptedWalletBackupOwnerVerifiedProofSet(
    input.verified,
    input.ownerContext,
  );
  if (browserWalletScope(input.seed).walletId !== input.ownerContext.walletId) {
    throw new Error("browser owner restore seed is foreign");
  }
  const proofSet = verified.proofSet;
  if (proofSet.proofs.length === 0) throw new Error("browser owner restore proof set is empty");
  if (
    proofSet.proofs.some(
      ({ mintUrl, unit }) => mintUrl !== input.asset.mintUrl || unit !== input.asset.unit,
    )
  ) {
    throw new Error("browser owner restore asset binding is foreign");
  }
  if (
    proofSet.proofs.some(
      ({ asset }) =>
        createEncryptedWalletBackupV2AssetIdentity({
          mintUrl: input.asset.mintUrl,
          unit: input.asset.unit,
          asset,
        }).assetIdentity !== input.asset.assetIdentity,
    )
  ) {
    throw new Error("browser owner restore asset identity is foreign");
  }
  const validateOwner = async () => {
    if ((await input.ownerAuthorityStore.readPreparedMutation()) !== null)
      throw new Error("browser owner restore has a pending mutation");
    await input.ownerAuthorityStore.assertCurrentRestoreAuthority({
      database: input.database,
      collectedHeadEvidence: input.collectedHeadEvidence,
      verified,
    });
  };
  if (proofSet.proofs.some(({ selectionAuthority }) => selectionAuthority !== "live-verified")) {
    if (
      proofSet.proofs.some(
        ({ selectionAuthority }) => selectionAuthority === "terminal-refusal-history",
      )
    ) {
      throw new Error("browser owner refusal history requires mutation receipt authority");
    }
    const ownerRestoreAuthority = {
      validate: validateOwner,
      afterPersist: () =>
        input.ownerAuthorityStore.assertCurrentRestoreAuthority({
          database: input.database,
          collectedHeadEvidence: input.collectedHeadEvidence,
          verified,
          proofIds: proofSet.proofs.map(({ proofId }) => proofId),
          localAssetKey: encryptedWalletBackupV2LocalAssetKey(input.asset),
        }),
    };
    const admissionInput = {
      seed: input.seed,
      verified: proofSet,
      asset: {
        mintUrl: input.asset.mintUrl,
        unit: input.asset.unit,
        assetIdentity: input.asset.assetIdentity,
      },
      custodyRevision: verified.source.custodyRevision,
      sourceOperationId: input.sourceOperationId,
      database: input.database,
      scopeId: browserWalletScope(input.seed).scopeId,
      isCurrentProfile: input.isCurrentProfile,
      lockManager: input.lockManager,
      ownerRestoreAuthority,
    };
    if (proofSet.proofs.some(({ selectionAuthority }) => selectionAuthority === "live-verified")) {
      if (input.wallet === undefined) throw new Error("browser owner mixed restore needs a wallet");
      await admitBrowserEncryptedWalletBackupV2MixedAsset({
        ...admissionInput,
        wallet: input.wallet,
      });
    } else {
      await admitBrowserEncryptedWalletBackupV2SealedAsset(admissionInput);
    }
    return;
  }
  await admitBrowserEncryptedWalletBackupV2Asset({
    seed: input.seed,
    verified: proofSet,
    asset: input.asset,
    custodyRevision: verified.source.custodyRevision,
    sourceOperationId: input.sourceOperationId,
    wallet: requireOwnerAdmissionWallet(input.wallet),
    database: input.database,
    scopeId: browserWalletScope(input.seed).scopeId,
    isCurrentProfile: input.isCurrentProfile,
    lockManager: input.lockManager,
    randomId: input.randomId,
    ownerRestoreAuthority: {
      validate: validateOwner,
      isDesiredAcknowledged: (desired, evicted) =>
        input.ownerAuthorityStore.isRestoreDesiredAcknowledged(
          {
            localAssetKey: desired.localAssetKey,
            assetLocator: verified.source.assetLocator,
            custodyRevision: desired.custodyRevision,
            desiredAction: desired.desiredAction,
            activeProofCount: desired.activeProofCount,
          },
          evicted,
        ),
      afterPersist: () =>
        input.ownerAuthorityStore.assertCurrentRestoreAuthority({
          database: input.database,
          collectedHeadEvidence: input.collectedHeadEvidence,
          verified,
          proofIds: proofSet.proofs.map(({ proofId }) => proofId),
          localAssetKey: encryptedWalletBackupV2LocalAssetKey(input.asset),
          requireExistingProofs: true,
        }),
    },
  });
}

function requireOwnerAdmissionWallet(wallet: CashuWallet | undefined): CashuWallet {
  if (wallet === undefined) throw new Error("browser owner restore needs a wallet");
  return wallet;
}
