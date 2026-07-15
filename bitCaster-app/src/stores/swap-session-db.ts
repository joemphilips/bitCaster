import type { ActiveSwap } from "./activeSwaps";
import {
  acquireGuiCustodyAuthority,
  guiWalletContextFromHeldLock,
  releaseGuiCustodyAuthority,
  withGuiCustodyProfileLock,
  withGuiCustodyProfileLockForWallet,
} from "./gui-custody-authority";
import {
  createGuiSwapSessionRecord,
  durableSessionFromActiveSwap,
  MAX_ACTIVE_GUI_SWAP_SESSIONS,
} from "./gui-swap-session-record";
import {
  commitGuiCustodyUnitOfWork,
  readGuiCustodyNativeSnapshot,
} from "./gui-custody-unit-of-work";
import { ensureDurableSwapStorage } from "./proof-db";
import type { GuiWalletLockContext } from "./gui-wallet-lock";

export {
  completeGuiProofOperationWithSessionUnderLock,
  markGuiProofOperationMintSubmittedWithSessionUnderLock,
  prepareGuiProofOperationWithSessionUnderLock,
  resolveGuiProofOperationPreparation,
} from "./gui-proof-operation-custody";
export {
  loadRecoverableGuiSwapSessions,
  loadRecoverableGuiTradeOperationPage,
  loadGuiSwapSessionStateUnderLock,
  loadGuiDurableTradeSessionUnderLock,
  recordGuiRecoveredProofOperationOutputsUnderLock,
  recoverGuiDurableTradeSession,
  removeGuiSwapSessionUnderLock,
  type GuiDurableRecoveryDatabase,
  type GuiDurableTradeRecoveryInput,
} from "./gui-durable-trade-recovery";
export {
  MAX_ACTIVE_GUI_SWAP_SESSIONS,
  type GuiSwapSessionRecord,
} from "./gui-swap-session-record";

/**
 * Persists the GUI protocol payload with the shared SDK envelope during one
 * short profile-locked commit phase. External effects must run before or after
 * this function and revalidate through a later locked CAS.
 */
export async function persistGuiSwapSessionUnderLock(
  lock: GuiWalletLockContext,
  swap: ActiveSwap,
  mintUrl: string,
): Promise<void> {
  const context = guiWalletContextFromHeldLock(lock);
  const session = await durableSessionFromActiveSwap(swap, mintUrl);
  if (!session) {
    throw new Error(
      "Cannot persist a swap session before trade role and locktimes are known",
    );
  }
  await ensureDurableSwapStorage(context.walletId);
  const authority = await acquireGuiCustodyAuthority(lock);
  const snapshot = await readGuiCustodyNativeSnapshot(
    null,
    swap.tradeId,
    context.walletId,
  );
  const plan = await authority.store.prepareTransaction(
    { scope: authority.scope, owner: authority.owner, operationIds: [] },
    () => undefined,
  );
  await commitGuiCustodyUnitOfWork({
    authority,
    plan,
    snapshot,
    nextSession: createGuiSwapSessionRecord(
      swap,
      session,
      context.walletId,
      snapshot.session,
    ),
    activeSessionLimit: MAX_ACTIVE_GUI_SWAP_SESSIONS,
  });
}

/** Serializes all custody work for one seed-derived wallet profile. */
export async function withGuiSwapSessionOwnership<T>(
  _tradeId: string,
  action: (lock: GuiWalletLockContext) => Promise<T>,
  expectedWalletId?: string,
): Promise<T> {
  const run = async (
    context: Parameters<Parameters<typeof withGuiCustodyProfileLock>[0]>[0],
    lock: GuiWalletLockContext,
  ) => {
    try {
      return await action(lock);
    } finally {
      await releaseGuiCustodyAuthority(lock, context.scope);
    }
  };
  return expectedWalletId
    ? withGuiCustodyProfileLockForWallet(expectedWalletId, run)
    : withGuiCustodyProfileLock(run);
}
