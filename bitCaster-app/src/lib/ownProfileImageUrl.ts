import { safeNostrDataImageUrl } from "@bitcaster/client-sdk/nostrProfilePage";

/**
 * The image URL of the user's own profile, or undefined.
 *
 * Only the key owner signs that profile, so any absolute http or https URL is
 * accepted, also a local or private host. A `data:` image URI follows the SDK
 * rule for every profile picture. Other schemes and URLs with credentials are
 * refused. Use `safeNostrProfilePictureUrl` for another user's profile.
 */
export function ownProfileImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const input = value.trim();
  if (!/^https?:\/\//i.test(input)) return safeNostrDataImageUrl(input) ?? undefined;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
