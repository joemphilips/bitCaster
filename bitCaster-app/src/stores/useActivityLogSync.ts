import { useEffect, useRef, useState } from "react";
import { resolveNsecIdentity } from "@/lib/identityOps";
import {
  fetchNip78ActivityLog,
  publishNip78ActivityLog,
} from "@/lib/nip78ActivityLog";
import { activityLogsEqual, useActivityLogStore } from "./activity-log";
import { useSettingsStore } from "./settings";
import type { ActivityItem } from "@/types/portfolio";

const PUBLISH_DEBOUNCE_MS = 800;

function mergeActivityLogs(
  local: readonly ActivityItem[],
  remote: readonly ActivityItem[],
): ActivityItem[] {
  const byId = new Map<string, ActivityItem>();
  for (const item of [...remote, ...local]) {
    byId.set(item.id, item);
  }
  return Array.from(byId.values())
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 500);
}

/**
 * Mirrors portfolio activity to the user's encrypted NIP-78 state. The local
 * store is still the fast path; Nostr relays are the cross-browser recovery
 * path when localStorage is empty.
 */
export function useActivityLogSync(): void {
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode);
  const nsecSecret = useSettingsStore((s) => s.nsecSecret);
  const items = useActivityLogStore((s) => s.items);
  const replace = useActivityLogStore((s) => s.replace);
  const [initialSyncDone, setInitialSyncDone] = useState(false);
  const lastPublished = useRef<ActivityItem[] | null>(null);
  const keysRef = useRef<{ privateKeyHex: string; publicKey: string } | null>(
    null,
  );

  useEffect(() => {
    setInitialSyncDone(false);
    lastPublished.current = null;
    keysRef.current = null;
    if (nostrSignerMode !== "nsec") return;

    const keys = resolveNsecIdentity(nsecSecret);
    if (!keys) return;
    keysRef.current = keys;

    let cancelled = false;
    void (async () => {
      const remote = await fetchNip78ActivityLog(
        keys.publicKey,
        keys.privateKeyHex,
      ).catch(() => null);
      if (cancelled) return;

      const local = useActivityLogStore.getState().items;
      if (remote === null) {
        lastPublished.current = null;
        setInitialSyncDone(true);
        return;
      }

      const merged = mergeActivityLogs(local, remote);
      lastPublished.current = remote;
      replace(merged);
      setInitialSyncDone(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [nostrSignerMode, nsecSecret, replace]);

  useEffect(() => {
    if (nostrSignerMode !== "nsec" || !initialSyncDone) return;
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
      publishNip78ActivityLog(keys.privateKeyHex, snapshot).catch(() => {});
    }, PUBLISH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [nostrSignerMode, items, initialSyncDone]);
}
