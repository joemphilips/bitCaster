import type { Event } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import {
  decodeNostrProfileAcknowledgment,
  MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
  MAX_NOSTR_PROFILE_RELAY_FRAMES,
  NostrRelayFrameTooLargeError,
} from "@bitcaster/client-sdk/nostrProfile";
import { normalizeNostrRelayUrl } from "@bitcaster/client-sdk/nostrRelays";

interface ProfileTransportOptions {
  readonly requireCurrent: () => void;
  readonly signal?: AbortSignal;
  readonly websocketImplementation?: typeof WebSocket;
  readonly timeoutMs?: number;
  /** Profile reads use the kind-0 bounds unless the SDK reader supplies others. */
  readonly maxFrameBytes?: number;
  readonly maxFrames?: number;
  /** The bound for the bytes of all frames together. Absent means no total bound. */
  readonly maxTotalBytes?: number;
}

/** Parse a text frame. A frame above the byte bound throws `NostrRelayFrameTooLargeError`. */
function boundedFrame(
  message: MessageEvent,
  maxBytes = MAX_NOSTR_PROFILE_TRANSPORT_BYTES,
): { readonly frame: unknown; readonly bytes: number } {
  if (typeof message.data !== "string") throw new Error("Nostr profile relay frame is invalid.");
  if (message.data.length > maxBytes) throw new NostrRelayFrameTooLargeError();
  const bytes = new TextEncoder().encode(message.data).byteLength;
  if (bytes > maxBytes) throw new NostrRelayFrameTooLargeError();
  return { frame: JSON.parse(message.data), bytes };
}

export function queryBrowserProfileRelay(
  url: string,
  filter: Filter,
  onEvent: (event: Event) => void,
  options: ProfileTransportOptions,
): Promise<void> {
  return queryBrowserProfileRelayFilters(url, [filter], onEvent, options);
}

/** Send one REQ with every filter. A throw from `onEvent` rejects the read. */
export function queryBrowserProfileRelayFilters(
  url: string,
  filters: readonly Filter[],
  onEvent: (event: Event) => void,
  options: ProfileTransportOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let socket: WebSocket | undefined;
    let settled = false,
      frames = 0,
      totalBytes = 0;
    const subscription = crypto.randomUUID();
    const finish = (completed: boolean, error?: Error) => {
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
      else reject(error ?? new Error("Nostr profile relay read is incomplete."));
    };
    const abort = () => finish(false);
    const timer = setTimeout(abort, options.timeoutMs ?? 8_000);
    try {
      options.signal?.throwIfAborted();
      options.requireCurrent();
      if (filters.length === 0) throw new Error("Nostr profile relay read needs a filter.");
      socket = new (options.websocketImplementation ?? WebSocket)(normalizeNostrRelayUrl(url));
      options.signal?.addEventListener("abort", abort, { once: true });
      socket.onopen = () => {
        try {
          options.requireCurrent();
          socket!.send(JSON.stringify(["REQ", subscription, ...filters]));
        } catch {
          finish(false);
        }
      };
      socket.onerror = socket.onclose = abort;
      socket.onmessage = (message) => {
        if (settled) return;
        try {
          if (++frames > (options.maxFrames ?? MAX_NOSTR_PROFILE_RELAY_FRAMES)) throw new Error();
          const { frame, bytes } = boundedFrame(message, options.maxFrameBytes);
          totalBytes += bytes;
          if (options.maxTotalBytes !== undefined && totalBytes > options.maxTotalBytes)
            throw new Error();
          if (!Array.isArray(frame) || frame[1] !== subscription) return;
          if (frame[0] === "EVENT" && frame.length === 3) onEvent(frame[2]);
          else if (frame[0] === "EOSE" && frame.length === 2) finish(true);
          else if (frame[0] === "CLOSED" || frame[0] === "EVENT" || frame[0] === "EOSE")
            finish(false);
        } catch (error) {
          // Only the oversize error is a typed result: the SDK reader treats it as a hidden event.
          finish(false, error instanceof NostrRelayFrameTooLargeError ? error : undefined);
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
          const ack = decodeNostrProfileAcknowledgment(boundedFrame(message).frame, event.id);
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
