import { nip19 } from "nostr-tools";

/** The wire author key is lowercase hex. Any other value gets no profile link or copy control. */
export function commentAuthorNpub(userId: string): string | null {
  return /^[0-9a-f]{64}$/.test(userId) ? nip19.npubEncode(userId) : null;
}
