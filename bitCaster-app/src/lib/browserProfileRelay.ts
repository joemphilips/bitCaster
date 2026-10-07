import type { Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import {
  decodeNostrProfileAcknowledgment,
  MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  MAX_NOSTR_PROFILE_RELAY_FRAMES,
} from "@bitcaster/client-sdk/nostrProfile";
import { normalizeNostrRelayUrl } from "@bitcaster/client-sdk/nostrRelays";

interface ProfileTransportOptions {
  readonly requireCurrent: () => void;
  readonly signal?: AbortSignal;
  readonly websocketImplementation?: typeof WebSocket;
  readonly timeoutMs?: number;
}

function boundedFrame(message: MessageEvent): unknown {
  if (
    typeof message.data !== "string" ||
    message.data.length > MAX_NOSTR_PROFILE_TRANSPORT_BYTES ||
    new TextEncoder().encode(message.data).byteLength > MAX_NOSTR_PROFILE_TRANSPORT_BYTES
  )
    throw new Error("Nostr profile relay frame is invalid.");
  return JSON.parse(message.data);
}

export function queryBrowserProfileRelay(
  url: string,
  filter: Filter,
  onEvent: (event: Event) => void,
  options: ProfileTransportOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined;
    let settled = false,
      frames = 0;
    const subscription = crypto.randomUUID();
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (socket) {
        socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
        try {
          if (socket.readyState === 1) socket.send(JSON.stringify(["CLOSE", subscription]));
          socket.close();
        } catch {
          /* The owned query must still settle. */
        }
      }
      if (completed) resolve();
      else reject(new Error("Nostr profile relay read is incomplete."));
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, options.timeoutMs ?? 8_000);
    try {
      options.requireCurrent();
      socket = new (options.websocketImplementation ?? WebSocket)(normalizeNostrRelayUrl(url));
      options.signal?.addEventListener("abort", abort, { once: true });
      socket.onopen = () => {
        try {
          options.requireCurrent();
          socket!.send(JSON.stringify(["REQ", subscription, filter]));
        } catch {
          finish(false);
        }
      };
      socket.onerror = socket.onclose = abort;
      socket.onmessage = (message) => {
        if (settled) return;
        try {
          if (++frames > MAX_NOSTR_PROFILE_RELAY_FRAMES) throw new Error();
          const frame = boundedFrame(message);
          if (!Array.isArray(frame) || frame[1] !== subscription) return;
          if (frame[0] === "EVENT" && frame.length === 3) onEvent(frame[2]);
          else if (frame[0] === "EOSE" && frame.length === 2) finish(true);
          else if (frame[0] === "CLOSED" || frame[0] === "EVENT" || frame[0] === "EOSE")
            finish(false);
        } catch {
          finish(false);
        }
      };
    } catch {
      finish(false);
    }
  });
}

export type BrowserProfileRelayDelivery = "accepted" | "rejected" | "unacknowledged" | "unsent";

/** Cancellation fences new sends. An issued send can still receive its exact ACK. */
export function publishBrowserProfileRelay(
  url: string,
  event: Event,
  options: ProfileTransportOptions,
): Promise<BrowserProfileRelayDelivery> {
  return new Promise((resolve) => {
    let socket: WebSocket | undefined;
    let settled = false,
      sent = false,
      frames = 0;
    const finish = (ack?: "accepted" | "rejected") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (socket) {
        socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
        try {
          socket.close();
        } catch {
          /* Delivery remains uncertain without an ACK. */
        }
      }
      resolve(ack ?? (sent ? "unacknowledged" : "unsent"));
    };
    const abort = () => {
      if (!sent) finish();
    };
    const timer = setTimeout(() => finish(), options.timeoutMs ?? 5_000);
    try {
      options.requireCurrent();
      socket = new (options.websocketImplementation ?? WebSocket)(normalizeNostrRelayUrl(url));
      options.signal?.addEventListener("abort", abort, { once: true });
      socket.onopen = () => {
        try {
          options.requireCurrent();
          sent = true;
          socket!.send(JSON.stringify(["EVENT", event]));
        } catch {
          finish();
        }
      };
      socket.onerror = socket.onclose = () => finish();
      socket.onmessage = (message) => {
        if (settled || !sent) return;
        try {
          if (++frames > MAX_NOSTR_PROFILE_RELAY_FRAMES) throw new Error();
          const ack = decodeNostrProfileAcknowledgment(boundedFrame(message), event.id);
          if (ack) finish(ack);
        } catch {
          finish();
        }
      };
    } catch {
      finish();
    }
  });
}
