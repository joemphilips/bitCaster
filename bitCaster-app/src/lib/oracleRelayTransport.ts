import { NDKEvent, type NostrEvent } from "@nostr-dev-kit/ndk";
import { withTemporaryRelayNdk } from "./nostr";

export async function boundedOracleRelay<T>(
  relays: string[],
  action: Parameters<typeof withTemporaryRelayNdk<T>>[2],
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await withTemporaryRelayNdk({ relays, signal: controller.signal }, undefined, action);
  } finally {
    clearTimeout(timer);
  }
}

/** Transport for an exact public artifact already validated by its owning coordinator. */
export async function publishRetainedOracleEvent(
  relays: string[],
  eventJson: string,
): Promise<string> {
  const signed = JSON.parse(eventJson) as NostrEvent;
  const acknowledged = await boundedOracleRelay(relays, async (ndk) => {
    const event = new NDKEvent(ndk, signed);
    const relays = await event.publish();
    if (event.id !== signed.id || relays.size === 0)
      throw new Error("Oracle relay delivery is unconfirmed.");
    return signed.id;
  });
  if (!acknowledged) throw new Error("Oracle relay delivery is unavailable.");
  return acknowledged;
}
