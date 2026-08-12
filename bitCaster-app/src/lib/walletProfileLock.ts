import { decodeDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";

type WalletLockManager = Pick<LockManager, "request">;

export async function withWalletProfileLock<T>(
  scopeId: string,
  action: () => Promise<T>,
  lockManager: WalletLockManager | undefined = globalThis.navigator?.locks,
): Promise<T> {
  decodeDurableCustodyScopeId(scopeId);
  if (!lockManager) {
    throw new Error("This browser cannot safely lock the wallet profile");
  }
  return lockManager.request(`bitcaster:wallet-profile:${scopeId}`, { mode: "exclusive" }, action);
}
