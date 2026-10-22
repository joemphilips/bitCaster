import {
  deriveEncryptedWalletBackupOwnerScope,
  type EncryptedWalletBackupOwnerScope,
} from "@bitcaster/client-sdk/encryptedWalletBackupEnrollment";
import { ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE } from "@bitcaster/client-sdk/encryptedWalletBackupNip98AccountAuthorization";
import { getNdk } from "./nostr";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "./nostrSignerRevision";

export class BrowserEncryptedWalletBackupOwnerSessionError extends Error {
  constructor(readonly code: "cancelled" | "selection-changed" | "lifecycle-owner-mismatch") {
    super("The encrypted wallet backup session is no longer current.");
    this.name = "BrowserEncryptedWalletBackupOwnerSessionError";
  }
}

export interface BrowserEncryptedWalletBackupOwnerSession {
  readonly selectedOwnerScope: EncryptedWalletBackupOwnerScope | null;
  readonly authenticatedOwnerScope: EncryptedWalletBackupOwnerScope | null;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  requireCurrent(): void;
  requireLifecycleOwner(owner: unknown): EncryptedWalletBackupOwnerScope;
  dispose(): void;
}

interface BrowserEncryptedWalletBackupOwnerSessionOptions {
  readonly isCurrentProfile: () => boolean;
  readonly signal?: AbortSignal;
  readonly selectedOwnerScope?: EncryptedWalletBackupOwnerScope | null;
  readonly readAuthenticatedOwner?: () => EncryptedWalletBackupOwnerScope | null;
  readonly readSignerRevision?: typeof getNostrSignerRevision;
  readonly subscribeSignerRevision?: typeof subscribeToNostrSignerRevision;
}

/**
 * Captures browser liveness independently from backup-owner selection.
 * Content recovery may select a discovered owner while another account is
 * active. Lifecycle authorization must still match the active signer.
 */
export function captureBrowserEncryptedWalletBackupOwnerSession(
  options: BrowserEncryptedWalletBackupOwnerSessionOptions,
): BrowserEncryptedWalletBackupOwnerSession {
  const readRevision = options.readSignerRevision ?? getNostrSignerRevision;
  const subscribeRevision = options.subscribeSignerRevision ?? subscribeToNostrSignerRevision;
  const revision = readRevision();
  const readAuthenticatedOwner = options.readAuthenticatedOwner ?? readActiveNostrOwner;
  const authenticatedOwnerScope = readAuthenticatedOwner();
  const rawSelectedOwnerScope =
    options.selectedOwnerScope === undefined ? authenticatedOwnerScope : options.selectedOwnerScope;
  const selectedOwnerScope =
    rawSelectedOwnerScope === null ? null : requireOwnerScope(rawSelectedOwnerScope);
  const controller = new AbortController();
  const abortForParent = () => controller.abort();
  options.signal?.addEventListener("abort", abortForParent, { once: true });
  if (options.signal?.aborted) controller.abort();
  const unsubscribe = subscribeRevision(abortForParent);

  const isCurrent = () =>
    !controller.signal.aborted &&
    options.signal?.aborted !== true &&
    readRevision() === revision &&
    options.isCurrentProfile() &&
    sameOwner(authenticatedOwnerScope, readAuthenticatedOwner());
  const requireCurrent = () => {
    if (controller.signal.aborted || options.signal?.aborted === true)
      throw new BrowserEncryptedWalletBackupOwnerSessionError("cancelled");
    if (
      readRevision() !== revision ||
      !options.isCurrentProfile() ||
      !sameOwner(authenticatedOwnerScope, readAuthenticatedOwner())
    )
      throw new BrowserEncryptedWalletBackupOwnerSessionError("selection-changed");
  };
  return Object.freeze({
    selectedOwnerScope,
    authenticatedOwnerScope,
    signal: controller.signal,
    isCurrent,
    requireCurrent,
    requireLifecycleOwner(owner: unknown) {
      requireCurrent();
      if (authenticatedOwnerScope === null || typeof owner !== "object" || owner === null) {
        throw new BrowserEncryptedWalletBackupOwnerSessionError("lifecycle-owner-mismatch");
      }
      let verified: EncryptedWalletBackupOwnerScope;
      try {
        const candidate = owner as EncryptedWalletBackupOwnerScope;
        verified = deriveEncryptedWalletBackupOwnerScope(candidate);
        if (candidate.ownerScopeId !== verified.ownerScopeId)
          throw new Error("backup owner identifier mismatch");
      } catch {
        throw new BrowserEncryptedWalletBackupOwnerSessionError("lifecycle-owner-mismatch");
      }
      if (
        verified.ownerScopeId !== authenticatedOwnerScope.ownerScopeId ||
        verified.authorizationScheme !== authenticatedOwnerScope.authorizationScheme ||
        verified.ownerSubject !== authenticatedOwnerScope.ownerSubject ||
        (selectedOwnerScope !== null &&
          (verified.ownerScopeId !== selectedOwnerScope.ownerScopeId ||
            verified.authorizationScheme !== selectedOwnerScope.authorizationScheme ||
            verified.ownerSubject !== selectedOwnerScope.ownerSubject))
      )
        throw new BrowserEncryptedWalletBackupOwnerSessionError("lifecycle-owner-mismatch");
      return verified;
    },
    dispose() {
      unsubscribe();
      options.signal?.removeEventListener("abort", abortForParent);
      controller.abort();
    },
  });
}

function readActiveNostrOwner(): EncryptedWalletBackupOwnerScope | null {
  const ndk = getNdk();
  const user = ndk.activeUser;
  if (ndk.signer === undefined || user === undefined) return null;
  return deriveEncryptedWalletBackupOwnerScope({
    authorizationScheme: ENCRYPTED_WALLET_BACKUP_NIP98_ACCOUNT_PROFILE,
    ownerSubject: user.pubkey,
  });
}

function requireOwnerScope(
  value: EncryptedWalletBackupOwnerScope,
): EncryptedWalletBackupOwnerScope {
  const derived = deriveEncryptedWalletBackupOwnerScope(value);
  if (value.ownerScopeId !== derived.ownerScopeId)
    throw new Error("The encrypted wallet backup owner is invalid.");
  return derived;
}

function sameOwner(
  left: EncryptedWalletBackupOwnerScope | null,
  right: EncryptedWalletBackupOwnerScope | null,
): boolean {
  return left === null
    ? right === null
    : right !== null &&
        left.ownerScopeId === right.ownerScopeId &&
        left.authorizationScheme === right.authorizationScheme &&
        left.ownerSubject === right.ownerSubject;
}
