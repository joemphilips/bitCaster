import { useEffect, useState } from "react";
import { fetchPublicNostrProfile, type PublicNostrProfile } from "./nostr";
import { useSettingsStore } from "@/stores/settings";

const listeners = new Set<
  (author: string, profile: PublicNostrProfile | null, relays: string) => void
>();

/** Optional enrichment starts after rendering. Failures leave the public-key fallback. */
export function usePublicCommentProfiles(authors: readonly string[]) {
  const key = JSON.stringify(
    [...new Set(authors)].filter((author) => /^[0-9a-f]{64}$/.test(author)),
  );
  const relayKey = useSettingsStore((state) => JSON.stringify(state.relays));
  const [state, setState] = useState<{
    key: string;
    relays: string;
    profiles: Map<string, PublicNostrProfile | null>;
  }>();
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const profiles = new Map<string, PublicNostrProfile | null>();
    const selected = new Set(JSON.parse(key) as string[]);
    const receive = (author: string, profile: PublicNostrProfile | null, relays: string) => {
      if (!active || relays !== relayKey || !selected.has(author)) return;
      profiles.set(author, profile);
      setState({ key, relays: relayKey, profiles: new Map(profiles) });
    };
    listeners.add(receive);
    for (const author of selected) {
      void fetchPublicNostrProfile(author, controller.signal)
        .catch(() => null)
        .then((profile) => {
          if (!active) return;
          for (const listener of listeners) listener(author, profile, relayKey);
        });
    }
    return () => {
      active = false;
      listeners.delete(receive);
      controller.abort();
    };
  }, [key, relayKey]);
  return state?.key === key && state.relays === relayKey
    ? state.profiles
    : new Map<string, PublicNostrProfile | null>();
}
