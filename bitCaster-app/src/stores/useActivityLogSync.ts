import { useEffect, useRef, useState } from "react";
import { resolveNsecIdentity } from "@/lib/identityOps";
import { fetchNip78ActivityLog, publishNip78ActivityLog } from "@/lib/nip78ActivityLog";
import { activityLogsEqual, mergeActivityLogs } from "@bitcaster/client-sdk/activityLog";
import { useActivityLogStore } from "./activity-log";
import { useSettingsStore } from "./settings";
import type { ActivityItem } from "@/types/portfolio";
import { effectiveRelayUrls } from "@/lib/relayDefaults";

const PUBLISH_DEBOUNCE_MS = 800;

/**
 * Mirrors portfolio activity to the user's encrypted NIP-78 state. The local
 * store is still the fast path; Nostr relays are the cross-browser recovery
 * path when localStorage is empty.
 */
export function useActivityLogSync(): void {
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode);
  const nsecSecret = useSettingsStore((s) => s.nsecSecret);
  const relaySelectionKey = useSettingsStore((s) => JSON.stringify(s.relays.map(({ url }) => url)));
  const relays = effectiveRelayUrls(useSettingsStore.getState().relays);
  const items = useActivityLogStore((s) => s.items);
  const replace = useActivityLogStore((s) => s.replace);
  const [initialSyncDone, setInitialSyncDone] = useState(false);
  const lastPublished = useRef<ActivityItem[] | null>(null);
  const keysRef = useRef<{ privateKeyHex: string; publicKey: string } | null>(null);

  useEffect(() => {
    setInitialSyncDone(false);
    lastPublished.current = null;
    keysRef.current = null;
    if (nostrSignerMode !== "nsec" || relays.length === 0) return;

    const keys = resolveNsecIdentity(nsecSecret);
    if (!keys) return;
    keysRef.current = keys;

    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      const remote = await fetchNip78ActivityLog(keys.publicKey, keys.privateKeyHex, {
        relays,
        signal: controller.signal,
      }).catch(() => null);
      if (cancelled) return;

      const local = useActivityLogStore.getState().items;
      if (remote === null) {
        lastPublished.current = null;
        setInitialSyncDone(true);
        return;
      }

      const merged = mergeActivityLogs(local, remote).slice(0, 500);
      lastPublished.current = remote;
      replace(merged);
      setInitialSyncDone(true);
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [nostrSignerMode, nsecSecret, replace, relaySelectionKey]);

  useEffect(() => {
    if (nostrSignerMode !== "nsec" || !initialSyncDone || relays.length === 0) return;
    const keys = keysRef.current;
    if (!keys) return;
    if (lastPublished.current && activityLogsEqual(lastPublished.current, items)) {
      return;
    }

    const snapshot = [...items];
    const controller = new AbortController();
    const handle = setTimeout(() => {
      lastPublished.current = snapshot;
      publishNip78ActivityLog(keys.privateKeyHex, snapshot, {
        relays,
        signal: controller.signal,
      }).catch(() => {});
    }, PUBLISH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [nostrSignerMode, items, initialSyncDone, relaySelectionKey]);
}
