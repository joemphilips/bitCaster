import {
  decodeDurableCustodyScopeInput,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { toSeed } from "./bip39";

let activeScopeId: string | null = null;

export function browserWalletScopeIdFromMnemonic(mnemonic: string): string | null {
  const words = mnemonic.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const walletId = deriveDurableCustodyWalletId(toSeed(words));
  return deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId });
}

export function setActiveBrowserWalletProfile(mnemonic: string): void {
  activeScopeId = browserWalletScopeIdFromMnemonic(mnemonic);
}

export function activeBrowserWalletScopeId(): string | null {
  return activeScopeId;
}

export function requireActiveBrowserWalletScopeId(): string {
  if (activeScopeId === null) throw new Error("The wallet profile is unavailable.");
  return activeScopeId;
}

export function browserWalletDatabaseName(scopeId: string): string {
  const scope = decodeDurableCustodyScopeInput(scopeId);
  if (scope.scopeKind !== "wallet") {
    throw new Error("The browser wallet database requires a wallet scope.");
  }
  return `bitcaster-wallet-${scope.walletId}`;
}
