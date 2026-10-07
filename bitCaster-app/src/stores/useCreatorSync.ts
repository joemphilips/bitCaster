import { useEffect, useRef, useState } from "react";
import {
  fetchNip78CreatorMarkets,
  publishNip78CreatorMarkets,
  publicCreatorMarketsEqual,
} from "@/lib/nip78CreatorMarkets";
import { resolveNsecIdentity } from "@/lib/identityOps";
import { useCreatorMarketsStore, type StoredCreatorMarket } from "./creatorMarkets";
import { useSettingsStore } from "./settings";
import { effectiveRelayUrls } from "@/lib/relayDefaults";

const PUBLISH_DEBOUNCE_MS = 800;

/**
 * Keep the local creator-markets store in sync with the user's NIP-78
 * `creator-markets` event on Nostr relays. Only active while an nsec-backed
 * Nostr identity is configured.
 *
 *  - On mount: fetch the remote set and merge it with the local set (most
 *    recent `createdAt` wins for duplicates). Publish back if the local set
 *    had entries missing from the remote.
 *  - On any subsequent local change: publish the updated set, debounced so
 *    rapid wizard completions collapse into a single relay round-trip.
 *
 * Mount this once at the application root, alongside `useBookmarkSync`.
 */
export function useCreatorSync(): void {
  const nostrSignerMode = useSettingsStore((s) => s.nostrSignerMode);
  const nsecSecret = useSettingsStore((s) => s.nsecSecret);
  const relaySelectionKey = useSettingsStore((s) => JSON.stringify(s.relays.map(({ url }) => url)));
  const relays = effectiveRelayUrls(useSettingsStore.getState().relays);
  const markets = useCreatorMarketsStore((s) => s.markets);
  const mergeRemoteMarkets = useCreatorMarketsStore((s) => s.mergeRemoteMarkets);
  const [initialSyncDone, setInitialSyncDone] = useState(false);
  const lastPublished = useRef<StoredCreatorMarket[] | null>(null);
  const keysRef = useRef<{ privateKeyHex: string; publicKey: string } | null>(null);

  // Initial fetch + merge whenever the active nsec identity changes.
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
    const options = { relays, signal: controller.signal };
    void (async () => {
      const remote = await fetchNip78CreatorMarkets(keys.publicKey, options).catch(() => null);
      if (cancelled) return;

      const local = await mergeRemoteMarkets([]);
      if (cancelled) return;
      if (remote === null) {
        // No remote state — seed the relay with whatever we have locally.
        lastPublished.current = [...local];
        setInitialSyncDone(true);
        if (local.length > 0) {
          await publishNip78CreatorMarkets(keys.privateKeyHex, local, options).catch(() => {});
        }
        return;
      }

      const merged = await mergeRemoteMarkets(remote);
      if (cancelled) return;
      lastPublished.current = merged;
      setInitialSyncDone(true);

      const remoteIds = new Set(remote.map((m) => m.conditionId));
      const remoteHasAll = local.every((m) => remoteIds.has(m.conditionId));
      if (!remoteHasAll || !publicCreatorMarketsEqual(remote, merged)) {
        await publishNip78CreatorMarkets(keys.privateKeyHex, merged, options).catch(() => {});
      }
    })().catch(() => {
      if (!cancelled) setInitialSyncDone(false);
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [nostrSignerMode, nsecSecret, mergeRemoteMarkets, relaySelectionKey]);

  // Publish to relays whenever the local set changes after the initial sync.
  useEffect(() => {
    if (nostrSignerMode !== "nsec" || !initialSyncDone || relays.length === 0) return;
    const keys = keysRef.current;
    if (!keys) return;
    if (lastPublished.current && publicCreatorMarketsEqual(lastPublished.current, markets)) return;

    const snapshot = [...markets];
    const controller = new AbortController();
    const handle = setTimeout(() => {
      lastPublished.current = snapshot;
      publishNip78CreatorMarkets(keys.privateKeyHex, snapshot, {
        relays,
        signal: controller.signal,
      }).catch(() => {});
    }, PUBLISH_DEBOUNCE_MS);
    return () => {
      clearTimeout(handle);
      controller.abort();
    };
  }, [nostrSignerMode, markets, initialSyncDone, relaySelectionKey]);
}
