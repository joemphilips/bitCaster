import {
  decodeDurableCustodyScopeInput,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { toSeed } from "./bip39";

/**
 * One activation of a wallet profile in this page. Each
 * `setActiveBrowserWalletProfile` call starts a new epoch, also for the same
 * wallet and for the empty invalidation of a handoff. So a late result of an
 * earlier activation of the same wallet (A -> B -> A) cannot pass as current.
 * The epoch lives in page memory only: a reload starts again at epoch 0.
 */
export interface BrowserWalletActivation {
  readonly scopeId: string | null;
  readonly epoch: number;
}

let activation: BrowserWalletActivation = Object.freeze({ scopeId: null, epoch: 0 });
const activationListeners = new Set<() => void>();

export function browserWalletScopeIdFromMnemonic(mnemonic: string): string | null {
  const walletId = browserWalletIdFromMnemonic(mnemonic);
  return walletId === null ? null : deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId });
}

export function browserWalletIdFromMnemonic(mnemonic: string): string | null {
  const words = mnemonic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  return deriveDurableCustodyWalletId(toSeed(words));
}

export function browserWalletScopeIdFromSeed(seed: Uint8Array): string {
  const walletId = deriveDurableCustodyWalletId(seed);
  return deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId });
}

export function setActiveBrowserWalletProfile(mnemonic: string): void {
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  activation = Object.freeze({ scopeId, epoch: activation.epoch + 1 });
  for (const listener of [...activationListeners]) listener();
}

export function activeBrowserWalletScopeId(): string | null {
  return activation.scopeId;
}

/** The current activation. The value stays the same object until the next activation. */
export function activeBrowserWalletActivation(): BrowserWalletActivation {
  return activation;
}

/** Calls the listener after each activation. Returns the unsubscribe function. */
export function subscribeBrowserWalletActivation(listener: () => void): () => void {
  activationListeners.add(listener);
  return () => {
    activationListeners.delete(listener);
  };
}

/** Check a live wallet value against the module's currently active profile. */
export function isActiveBrowserWalletId(walletId: string, mnemonic: string): boolean {
  const currentWalletId = browserWalletIdFromMnemonic(mnemonic);
  const currentScopeId =
    currentWalletId === null
      ? null
      : deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: currentWalletId });
  return (
    currentWalletId === walletId && currentScopeId !== null && activation.scopeId === currentScopeId
  );
}

export function requireActiveBrowserWalletScopeId(): string {
  const { scopeId } = activation;
  if (scopeId === null) throw new Error("The wallet profile is unavailable.");
  return scopeId;
}

export function browserWalletDatabaseName(scopeId: string): string {
  const scope = decodeDurableCustodyScopeInput(scopeId);
  if (scope.scopeKind !== "wallet") {
    throw new Error("The browser wallet database requires a wallet scope.");
  }
  return `bitcaster-wallet-${scope.walletId}`;
}
