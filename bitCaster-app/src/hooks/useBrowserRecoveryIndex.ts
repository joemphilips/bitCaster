import { useCallback, useEffect, useSyncExternalStore } from "react";
import Dexie, { type Transaction } from "dexie";
import type { RecoveryIndexKeysetAuthority } from "@bitcaster/client-sdk/recoveryIndexDocument";
import { canonicalizeMintIdentityUrl } from "@bitcaster/client-sdk/tokenImportValidation";
import { toSeed } from "@/lib/bip39";
import {
  activeBrowserRecoveryIndex,
  BrowserRecoveryIndex,
  browserRecoveryIndexRealm,
  registerBrowserRecoveryIndex,
  subscribeBrowserRecoveryIndexRegistry,
  type BrowserRecoveryIndexStatus,
} from "@/lib/browserRecoveryIndex";
import {
  activeBrowserWalletActivation,
  browserWalletDatabaseName,
  browserWalletScopeIdFromMnemonic,
  subscribeBrowserWalletActivation,
} from "@/lib/browserWalletProfile";
import { publishBrowserCtfRangeRecoveryWake } from "@/lib/browserCtfRangeOrderRecoveryWake";
import { recordBrowserRecoveryIndexRead } from "@/lib/browserSeedPositionRestore";
import { normalizeUrl } from "@/lib/url";
import { db, type BitcasterDB } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";

const activationEpoch = () => activeBrowserWalletActivation().epoch;

/**
 * Keep the recovery index of the active wallet (ADR-051, ADR-034). It needs
 * no account: the seed derives its keys. It reads the index at wallet open,
 * and it asks for an upload after each commit that adds a local keyset.
 */
export function useBrowserRecoveryIndex(walletMnemonic: string): void {
  const epoch = useSyncExternalStore(
    subscribeBrowserWalletActivation,
    activationEpoch,
    activationEpoch,
  );
  useEffect(() => {
    if (!walletMnemonic) return;
    const scopeId = browserWalletScopeIdFromMnemonic(walletMnemonic);
    const realm = browserRecoveryIndexRealm();
    const activation = activeBrowserWalletActivation();
    if (scopeId === null || realm === null || activation.scopeId !== scopeId) return;
    const database = db;
    if (database.name !== browserWalletDatabaseName(scopeId)) return;
    const runtime = new BrowserRecoveryIndex({
      database,
      scopeId,
      seed: toSeed(walletMnemonic.trim().split(/\s+/)),
      realm,
      walletMints: walletMintUrls,
      regularKeysetAuthority,
      // ADR-033: after a read, scan each listed keyset with no local cursor.
      onIndexRead: async (read) => {
        const mints = useWalletStore.getState().mints.map(({ url }) => normalizeUrl(url));
        if (await recordBrowserRecoveryIndexRead(scopeId, read, mints)) {
          publishBrowserCtfRangeRecoveryWake({ scopeId });
        }
      },
    });
    const unregister = registerBrowserRecoveryIndex(scopeId, runtime);
    const unsubscribe = subscribeToLocalKeysetChanges(database, () => runtime.requestUpload());
    // ADR-033: the wallet open reads the index.
    void runtime.read("wallet-open").catch(() => undefined);
    return () => {
      unsubscribe();
      unregister();
      runtime.stop();
    };
  }, [epoch, walletMnemonic]);
}

/** The status of the active wallet's recovery index, for a persistent error. */
export function useBrowserRecoveryIndexStatus(): BrowserRecoveryIndexStatus | null {
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic);
  const subscribe = useCallback(
    (listener: () => void) => {
      let unsubscribeRuntime = () => {};
      const attach = () => {
        unsubscribeRuntime();
        unsubscribeRuntime =
          scopeId === null
            ? () => {}
            : (activeBrowserRecoveryIndex(scopeId)?.subscribe(listener) ?? (() => {}));
        listener();
      };
      const unsubscribeRegistry = subscribeBrowserRecoveryIndexRegistry(attach);
      attach();
      return () => {
        unsubscribeRegistry();
        unsubscribeRuntime();
      };
    },
    [scopeId],
  );
  const snapshot = () =>
    scopeId === null ? null : (activeBrowserRecoveryIndex(scopeId)?.status ?? null);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

function walletMintUrls(): readonly string[] {
  return useWalletStore.getState().mints.flatMap(({ url }) => {
    try {
      return [canonicalizeMintIdentityUrl(url)];
    } catch {
      return [];
    }
  });
}

/** The keys of a regular keyset from the mint metadata that the wallet holds. */
function regularKeysetAuthority(
  mintUrl: string,
  keysetId: string,
): RecoveryIndexKeysetAuthority | null {
  for (const mint of useWalletStore.getState().mints) {
    let canonical: string;
    try {
      canonical = canonicalizeMintIdentityUrl(mint.url);
    } catch {
      continue;
    }
    if (canonical !== mintUrl || mint.keys?.id !== keysetId) continue;
    const keyset = mint.keysets?.find(({ id }) => id === keysetId);
    if (keyset === undefined) return null;
    return {
      id: keysetId,
      unit: keyset.unit,
      keys: mint.keys.keys as Readonly<Record<string, string>>,
      inputFeePpk: keyset.input_fee_ppk ?? 0,
      finalExpiry: keyset.final_expiry ?? null,
    };
  }
  return null;
}

/**
 * Call the callback once after each committed transaction that adds a counter
 * cursor or records a keyset identity. A new cursor makes a keyset pending
 * (ADR-051 "Upload").
 */
export function subscribeToLocalKeysetChanges(
  database: BitcasterDB,
  callback: () => void,
): () => void {
  const observed = new WeakSet<Transaction>();
  let active = true;
  const afterCommit = (transaction: Transaction) => {
    // A nested transaction "completes" at the end of its scope, inside its
    // parent. Wait for the commit of the outermost transaction.
    let root = transaction;
    while (root.parent !== undefined && root.parent !== null) root = root.parent;
    if (observed.has(root)) return;
    observed.add(root);
    root.on("complete", () => {
      // Leave the transaction zone: the upload opens its own transactions.
      if (active) Dexie.ignoreTransaction(callback);
    });
  };
  const created = (_key: unknown, _value: unknown, transaction: Transaction) =>
    afterCommit(transaction);
  const updated = (_changes: object, _key: unknown, _value: unknown, transaction: Transaction) =>
    afterCommit(transaction);
  database.walletCounterCursors.hook("creating", created);
  database.walletCounterAssociations.hook("updating", updated);
  database.custodyConditionalKeysets.hook("creating", created);
  return () => {
    active = false;
    database.walletCounterCursors.hook("creating").unsubscribe(created);
    database.walletCounterAssociations.hook("updating").unsubscribe(updated);
    database.custodyConditionalKeysets.hook("creating").unsubscribe(created);
  };
}
