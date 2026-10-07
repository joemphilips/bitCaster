import type { Event } from "nostr-tools/pure";
import {
  compareNostrProfileEvents,
  decodeNostrProfileEditEvent,
  MAX_NOSTR_PROFILE_EVENT_BYTES,
} from "@bitcaster/client-sdk/nostrProfile";

export interface BrowserProfileEditSession {
  read(): Event | null;
  retain(event: Event): void;
}

/** The raw signed record stays separate from stale whole-Settings documents. */
export async function withBrowserProfileEditSession<T>(
  publicKey: string,
  action: (session: BrowserProfileEditSession) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(publicKey)) throw new Error("Nostr profile public key is invalid.");
  if (!navigator.locks) throw new Error("This browser cannot coordinate profile edits safely.");
  const key = `bitcaster-nostr-profile:${publicKey}`;
  const read = (): Event | null => {
    const serialized = localStorage.getItem(key);
    if (serialized === null) return null;
    if (new TextEncoder().encode(serialized).byteLength > MAX_NOSTR_PROFILE_EVENT_BYTES)
      throw new Error("Retained Nostr profile is too large.");
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new Error("Retained Nostr profile is invalid.");
    }
    const event = decodeNostrProfileEditEvent(value, publicKey);
    if (!event) throw new Error("Retained Nostr profile is invalid.");
    return event;
  };
  const lockSignal = AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
  return navigator.locks.request(
    `bitcaster:nostr-profile:${publicKey}`,
    { signal: lockSignal },
    async () => {
      signal?.throwIfAborted();
      return action({
        read,
        retain(value) {
          const event = decodeNostrProfileEditEvent(value, publicKey);
          if (!event) throw new Error("Nostr profile to retain is invalid.");
          const prior = read();
          if (prior && compareNostrProfileEvents(prior, event) >= 0) return;
          // Storage errors after an ACK must reach the caller as retention failures.
          localStorage.setItem(key, JSON.stringify(event));
        },
      });
    },
  );
}
