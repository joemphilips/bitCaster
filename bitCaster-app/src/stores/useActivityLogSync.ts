import { useEffect, useRef, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { resolveNsecIdentity } from "@/lib/identityOps";
import {
  fetchNip78ActivityLog,
  publishNip78ActivityLog,
} from "@/lib/nip78ActivityLog";
import { activityLogsEqual, useActivityLogStore } from "./activity-log";
import { useSettingsStore } from "./settings";
import { currentGuiWalletId } from "./proof-db";
import { useWalletStore } from "./wallet";
import { listWalletActivities } from "./wallet-activity-projection";
import type { ActivityItem } from "@/types/portfolio";

const PUBLISH_DEBOUNCE_MS = 800;
const EMPTY_ACTIVITY: ActivityItem[] = [];
interface ScopedActivity {
  walletId: string | null;
  items: ActivityItem[];
}
const EMPTY_SCOPED_ACTIVITY: ScopedActivity = {
  walletId: null,
  items: EMPTY_ACTIVITY,
};

function mergeActivityLogs(
  primary: readonly ActivityItem[],
  secondary: readonly ActivityItem[],
): ActivityItem[] {
  const byId = new Map<string, ActivityItem>();
  for (const item of [...secondary, ...primary]) byId.set(item.id, item);
  return Array.from(byId.values())
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 500);
}

function activeWalletId(mnemonic: string): string | null {
  if (!mnemonic) return null;
  try {
    return currentGuiWalletId();
  } catch {
    return null;
  }
}

/**
 * Selects one seed-derived activity partition, refreshes its durable deposit
 * projection, and mirrors only that partition to encrypted NIP-78 state.
 */
export function useActivityLogSync(): void {
  const nostrSignerMode = useSettingsStore((state) => state.nostrSignerMode);
  const nsecSecret = useSettingsStore((state) => state.nsecSecret);
  const mnemonic = useWalletStore((state) => state.mnemonic);
  const walletId = activeWalletId(mnemonic);
  const activateWallet = useActivityLogStore((state) => state.activateWallet);
  const replaceForWallet = useActivityLogStore(
    (state) => state.replaceForWallet,
  );
  const items = useActivityLogStore((state) =>
    walletId === null
      ? EMPTY_ACTIVITY
      : (state.itemsByWalletId[walletId] ?? EMPTY_ACTIVITY),
  );
  const projected = useLiveQuery<ScopedActivity, ScopedActivity>(
    () =>
      walletId === null
        ? Promise.resolve(EMPTY_SCOPED_ACTIVITY)
        : listWalletActivities(walletId).then((items) => ({ walletId, items })),
    [walletId],
    EMPTY_SCOPED_ACTIVITY,
  );
  const [initialSyncDone, setInitialSyncDone] = useState(false);
  const lastPublished = useRef<ActivityItem[] | null>(null);
  const keysRef = useRef<{ privateKeyHex: string; publicKey: string } | null>(
    null,
  );

  useEffect(() => activateWallet(walletId), [activateWallet, walletId]);

  useEffect(() => {
    if (
      walletId === null ||
      projected.walletId !== walletId ||
      projected.items.length === 0
    ) {
      return;
    }
    const local =
      useActivityLogStore.getState().itemsByWalletId[walletId] ?? [];
    replaceForWallet(walletId, mergeActivityLogs(projected.items, local));
  }, [projected, replaceForWallet, walletId]);

  useEffect(() => {
    setInitialSyncDone(false);
    lastPublished.current = null;
    keysRef.current = null;
    if (walletId === null || nostrSignerMode !== "nsec") return;

    const keys = resolveNsecIdentity(nsecSecret);
    if (!keys) return;
    keysRef.current = keys;

    let cancelled = false;
    void (async () => {
      const remote = await fetchNip78ActivityLog(
        keys.publicKey,
        keys.privateKeyHex,
        walletId,
      ).catch(() => null);
      if (cancelled) return;

      const local =
        useActivityLogStore.getState().itemsByWalletId[walletId] ?? [];
      if (remote === null) {
        lastPublished.current = null;
        setInitialSyncDone(true);
        return;
      }

      const merged = mergeActivityLogs(local, remote);
      lastPublished.current = remote;
      replaceForWallet(walletId, merged);
      setInitialSyncDone(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [nostrSignerMode, nsecSecret, replaceForWallet, walletId]);

  useEffect(() => {
    if (walletId === null || nostrSignerMode !== "nsec" || !initialSyncDone) {
      return;
    }
    const keys = keysRef.current;
    if (!keys) return;
    if (
      lastPublished.current &&
      activityLogsEqual(lastPublished.current, items)
    ) {
      return;
    }

    const snapshot = [...items];
    const handle = setTimeout(() => {
      lastPublished.current = snapshot;
      publishNip78ActivityLog(keys.privateKeyHex, walletId, snapshot).catch(
        () => {},
      );
    }, PUBLISH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [nostrSignerMode, items, initialSyncDone, walletId]);
}
