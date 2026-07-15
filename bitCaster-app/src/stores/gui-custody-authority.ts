import { Mint as CashuMint, type MintKeys } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyScopeId,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyScope,
  type DurableCustodyScopeState,
} from "@bitcaster/client-sdk/durableCustody";
import type { DurableCustodyMintKeyResolver } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import { DexieDurableCustodyStore } from "./durable-custody-dexie";
import { currentGuiWalletId, db, type BitcasterDB } from "./proof-db";
import {
  tryWithGuiWalletLock,
  walletIdFromHeldGuiWalletLock,
  withGuiWalletLock,
  type GuiWalletLockAttempt,
  type GuiWalletLockContext,
} from "./gui-wallet-lock";

const GUI_CUSTODY_LEASE_MS = 60_000;
const GUI_CUSTODY_INCARNATION_ID = crypto.randomUUID();

export interface GuiCustodyAuthority {
  scope: GuiCustodyScope;
  owner: DurableCustodyOwnerAuthorization;
  store: DexieDurableCustodyStore;
}

export type GuiCustodyScope = Extract<
  DurableCustodyScope,
  { scopeKind: "wallet" }
>;

export interface GuiWalletContext {
  walletId: string;
  scope: GuiCustodyScope;
}

export function currentGuiWalletContext(): GuiWalletContext {
  return guiWalletContextForWallet(currentGuiWalletId());
}

export function guiWalletContextFromHeldLock(
  lock: GuiWalletLockContext,
): GuiWalletContext {
  return guiWalletContextForWallet(walletIdFromHeldGuiWalletLock(lock));
}

export function guiWalletContextForWallet(walletId: string): GuiWalletContext {
  const input = { scopeKind: "wallet" as const, walletId };
  return {
    walletId,
    scope: { ...input, scopeId: deriveDurableCustodyScopeId(input) },
  };
}

export async function withGuiCustodyProfileLock<T>(
  action: (context: GuiWalletContext, lock: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  return withGuiCustodyProfileLockForWallet(currentGuiWalletId(), action);
}

export async function withGuiCustodyProfileLockForWallet<T>(
  expectedWalletId: string,
  action: (context: GuiWalletContext, lock: GuiWalletLockContext) => Promise<T>,
): Promise<T> {
  const context = guiWalletContextForWallet(expectedWalletId);
  return withGuiWalletLock(context.walletId, currentGuiWalletId, (lock) =>
    action(context, lock),
  );
}

export async function tryWithGuiCustodyProfileLock<T>(
  action: (context: GuiWalletContext, lock: GuiWalletLockContext) => Promise<T>,
  expectedWalletId: string = currentGuiWalletId(),
): Promise<GuiWalletLockAttempt<T>> {
  const context = guiWalletContextForWallet(expectedWalletId);
  return tryWithGuiWalletLock(
    context.walletId,
    currentGuiWalletId,
    async (lock) => action(context, lock),
  );
}

export async function acquireGuiCustodyAuthority(
  lock: GuiWalletLockContext,
  database: BitcasterDB = db,
): Promise<GuiCustodyAuthority> {
  const { scope } = guiWalletContextFromHeldLock(lock);
  const store = new DexieDurableCustodyStore(database);
  const observedAtMs = Date.now();
  const state = await acquireGuiCustodyOwner(
    store,
    scope,
    observedAtMs,
    await store.registerScope(scope),
  );
  return {
    scope,
    store,
    owner: {
      incarnationId: GUI_CUSTODY_INCARNATION_ID,
      fencingEpoch: state.fencingEpoch,
      observedAtMs,
    },
  };
}

async function acquireGuiCustodyOwner(
  store: DexieDurableCustodyStore,
  scope: GuiCustodyScope,
  observedAtMs: number,
  state: DurableCustodyScopeState,
): Promise<DurableCustodyScopeState> {
  if (state.owner === null || observedAtMs >= state.owner.leaseExpiresAtMs) {
    return store.claimScope({
      scope,
      incarnationId: GUI_CUSTODY_INCARNATION_ID,
      observedAtMs,
      leaseExpiresAtMs: observedAtMs + GUI_CUSTODY_LEASE_MS,
    });
  }
  if (state.owner.incarnationId === GUI_CUSTODY_INCARNATION_ID) {
    return store.renewScope({
      scope,
      incarnationId: GUI_CUSTODY_INCARNATION_ID,
      fencingEpoch: state.fencingEpoch,
      observedAtMs,
      leaseExpiresAtMs: Math.max(
        observedAtMs + GUI_CUSTODY_LEASE_MS,
        state.owner.leaseExpiresAtMs + 1,
      ),
    });
  }
  throw new Error("GUI custody is owned by another live browser context");
}

export class GuiCustodyMintKeysUnavailable extends Error {}

export const resolveGuiCustodyMintKeys: DurableCustodyMintKeyResolver = async (
  mintUrl,
  keysetIds,
) => {
  const mint = new CashuMint(mintUrl);
  const result = new Map<string, MintKeys>();
  for (const keysetId of keysetIds) {
    let response: Awaited<ReturnType<CashuMint["getKeys"]>>;
    try {
      response = await mint.getKeys(keysetId);
    } catch (cause) {
      throw new GuiCustodyMintKeysUnavailable(
        "GUI custody mint keys are unavailable",
        { cause },
      );
    }
    const keyset = response.keysets.find(
      (candidate) => candidate.id === keysetId,
    );
    if (!keyset) throw new Error("Mint did not return an exact custody keyset");
    result.set(keysetId, keyset);
  }
  return result;
};

export async function releaseGuiCustodyAuthority(
  lock: GuiWalletLockContext,
  authorityOrScope: GuiCustodyAuthority | DurableCustodyScope,
): Promise<void> {
  const scope =
    "store" in authorityOrScope ? authorityOrScope.scope : authorityOrScope;
  const context = guiWalletContextFromHeldLock(lock);
  if (scope.scopeKind !== "wallet" || scope.walletId !== context.walletId) {
    throw new Error("GUI custody release does not match the held wallet lock");
  }
  const store =
    "store" in authorityOrScope
      ? authorityOrScope.store
      : new DexieDurableCustodyStore(db);
  const state = await store.readScope(scope);
  if (state?.owner?.incarnationId !== GUI_CUSTODY_INCARNATION_ID) return;
  await store.releaseScope({
    scope,
    incarnationId: GUI_CUSTODY_INCARNATION_ID,
    fencingEpoch: state.fencingEpoch,
    observedAtMs: Date.now(),
  });
}
