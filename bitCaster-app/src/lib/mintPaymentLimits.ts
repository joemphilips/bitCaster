import { readPublicMintInfo } from "@bitcaster/client-sdk/mintMetadata";
import {
  parseMintPaymentLimits,
  type MintPaymentLimits,
  type MintPaymentSelection,
} from "@bitcaster/client-sdk/mintPaymentLimits";
import { normalizeUrl } from "@/lib/url";

/** A mint can change its limits, so an open tab reads them again after this age. */
const MINT_INFO_MAX_AGE_MS = 5 * 60 * 1000;

/** One public mint info read per mint URL serves the deposit and withdrawal limits. */
const mintInfoByUrl = new Map<string, { read: Promise<unknown>; readAt: number }>();

function readCachedMintInfo(mintUrl: string): Promise<unknown> {
  const cached = mintInfoByUrl.get(mintUrl);
  if (cached !== undefined && Date.now() - cached.readAt < MINT_INFO_MAX_AGE_MS) return cached.read;
  const read = readPublicMintInfo(mintUrl);
  mintInfoByUrl.set(mintUrl, { read, readAt: Date.now() });
  // A failed read is not cached, so the next payment screen asks the mint again.
  read.catch(() => {
    if (mintInfoByUrl.get(mintUrl)?.read === read) mintInfoByUrl.delete(mintUrl);
  });
  return read;
}

/**
 * Read the payment limits of one mint. Resolves to null when the limits are
 * unavailable; the mint then enforces its limits alone.
 */
export async function readBrowserMintPaymentLimits(
  mintUrl: string,
  selection: MintPaymentSelection,
): Promise<MintPaymentLimits | null> {
  try {
    return parseMintPaymentLimits(await readCachedMintInfo(normalizeUrl(mintUrl)), selection);
  } catch {
    return null;
  }
}

/** Forget the cached mint info, so that the next read asks the mint again. */
export function forgetBrowserMintPaymentLimits(mintUrl: string): void {
  mintInfoByUrl.delete(normalizeUrl(mintUrl));
}
