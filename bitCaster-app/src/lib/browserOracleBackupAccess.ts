import {
  listOracleBackups,
  oracleBackupStatus,
  type OracleBackupScanCursor,
} from "@bitcaster/client-sdk/oracleBackupAccess";
import { normalizeNostrRelayUrl } from "@bitcaster/client-sdk/nostrRelays";
import { hexToBytes } from "nostr-tools/utils";
import { useSettingsStore } from "@/stores/settings";
import {
  browserOracleOwnerAuthority,
  creatorOraclePublication,
  useCreatorMarketsStore,
} from "@/stores/creatorMarkets";
import { assertNever } from "./enumDiscipline";
import { resolveNsecIdentity } from "./identityOps";
import { effectiveRelayUrls } from "./relayDefaults";
import { browserOracleBackupValidator } from "./kormir";
import { importBrowserOracleBackupEnvelope } from "./browserOracleBackup";

type QueryRelay = Parameters<typeof listOracleBackups>[0]["queryRelay"];
export type BrowserOracleBackupList = Awaited<ReturnType<typeof listOracleBackups>>;
export type BrowserOracleBackupStatus = ReturnType<typeof oracleBackupStatus>;

export interface BrowserOracleBackupAccessOptions {
  store?: typeof useCreatorMarketsStore;
  queryRelay?: QueryRelay;
  relayUrls?: readonly string[];
  localOffset?: number;
}

function selectedBackupIdentity() {
  const settings = useSettingsStore.getState();
  const identity = resolveNsecIdentity(settings.nsecSecret);
  if (settings.nostrSignerMode !== "nsec" || !identity)
    throw new Error("Use the original local oracle key to list or restore private backups.");
  return identity;
}

/** Count raw frames before protocol validation. Every request owns and closes its socket. */
export const queryBrowserOracleBackupRelay: QueryRelay = ({
  relayUrl,
  filter,
  signal,
  maxEvents,
  maxBytes,
}) =>
  new Promise((resolve, reject) => {
    const events: unknown[] = [];
    const subscription = "oracle-backup-" + crypto.randomUUID();
    let socket: WebSocket;
    let settled = false;
    let rawBytes = 0;
    let frames = 0;
    const finish = (complete: boolean, failure = false) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      try {
        if (socket?.readyState === WebSocket.OPEN)
          socket.send(JSON.stringify(["CLOSE", subscription]));
        socket?.close();
      } catch {
        // A closing socket cannot prevent the owned query from reaching its terminal result.
      }
      if (failure) reject(new Error("Oracle backup relay query is unavailable."));
      else resolve({ events, complete });
    };
    const abort = () => finish(false);
    if (signal.aborted) {
      resolve({ events, complete: false });
      return;
    }
    try {
      socket = new WebSocket(normalizeNostrRelayUrl(relayUrl));
    } catch {
      reject(new Error("Oracle backup relay query is unavailable."));
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    socket.onopen = () => {
      if (!settled) socket.send(JSON.stringify(["REQ", subscription, filter]));
    };
    socket.onerror = () => finish(false, true);
    socket.onclose = () => finish(false);
    socket.onmessage = (message) => {
      if (settled) return;
      if (typeof message.data !== "string" || message.data.length > 128 * 1024) {
        finish(false);
        return;
      }
      const bytes = new TextEncoder().encode(message.data).byteLength;
      rawBytes += bytes;
      frames += 1;
      if (bytes > 128 * 1024 || rawBytes > maxBytes || frames > maxEvents + 16) {
        finish(false);
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(message.data);
      } catch {
        finish(false);
        return;
      }
      if (!Array.isArray(frame) || frame[1] !== subscription) return;
      switch (frame[0]) {
        case "EVENT":
          if (frame.length !== 3 || events.length >= maxEvents) {
            finish(false);
            return;
          }
          events.push(frame[2]);
          break;
        case "EOSE":
          finish(frame.length === 2);
          break;
        case "CLOSED":
          finish(false);
          break;
      }
    };
  });

export function listBrowserOracleBackups(
  cursor?: OracleBackupScanCursor | null,
  options: BrowserOracleBackupAccessOptions = {},
) {
  const identity = selectedBackupIdentity();
  return listOracleBackups({
    privateKey: hexToBytes(identity.privateKeyHex),
    validator: browserOracleBackupValidator,
    relayUrls: options.relayUrls ?? effectiveRelayUrls(useSettingsStore.getState().relays),
    cursor,
    queryRelay: options.queryRelay ?? queryBrowserOracleBackupRelay,
  });
}

/** A list row never supplies authority. Fetch and validate its selected exact ID again. */
export async function restoreBrowserOracleBackup(
  eventId: string,
  sourceRelay: string,
  options: BrowserOracleBackupAccessOptions = {},
) {
  if (!/^[0-9a-f]{64}$/.test(eventId)) throw new Error("Oracle backup event ID is invalid.");
  const identity = selectedBackupIdentity();
  const relayUrl = normalizeNostrRelayUrl(sourceRelay);
  const result = await (options.queryRelay ?? queryBrowserOracleBackupRelay)({
    relayUrl,
    filter: {
      ids: [eventId],
      kinds: [30078],
      authors: [identity.publicKey],
      "#v": ["1"],
      limit: 2,
    },
    signal: AbortSignal.timeout(8_000),
    maxEvents: 2,
    maxBytes: 256 * 1024,
  });
  if (!result.complete) throw new Error("Oracle backup relay query is incomplete.");
  const selected = result.events.find(
    (event) => typeof event === "object" && event !== null && "id" in event && event.id === eventId,
  );
  if (!selected) throw new Error("The selected oracle backup is unavailable on this relay.");
  return importBrowserOracleBackupEnvelope(
    selected,
    relayUrl,
    options.store ?? useCreatorMarketsStore,
  );
}

export async function localBrowserOracleBackupStatuses(
  options: BrowserOracleBackupAccessOptions = {},
) {
  const store = options.store ?? useCreatorMarketsStore;
  const offset = options.localOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Oracle backup status page is invalid.");
  const owners = await store.getState().readOracleOwners();
  const rows = owners.slice(offset, offset + 20).map((owner) => {
    let authority: ReturnType<typeof browserOracleOwnerAuthority>;
    try {
      authority = browserOracleOwnerAuthority(owner);
    } catch {
      switch (owner.kind) {
        case "created":
          return { conditionId: owner.market.conditionId, available: false as const };
        case "imported":
          return { conditionId: owner.oracle.binding.conditionId, available: false as const };
        default:
          return assertNever(owner);
      }
    }
    const { binding, destinations } = authority;
    if (!destinations) return { conditionId: binding.conditionId, available: false as const };
    let title: string;
    let oracle;
    let publication;
    switch (owner.kind) {
      case "created":
        title = owner.market.title;
        oracle = owner.market.oracle!;
        publication = creatorOraclePublication(owner.market);
        break;
      case "imported":
        title = binding.oracleEventId;
        oracle = owner.oracle;
        publication = oracle.publication;
        break;
      default:
        return assertNever(owner);
    }
    return {
      conditionId: binding.conditionId,
      available: true as const,
      title,
      kind: owner.kind,
      outcomes: binding.outcomes,
      chosenOutcome: publication?.chosenOutcome ?? null,
      status: oracleBackupStatus({
        binding,
        destinations,
        publication,
        importComplete: oracle.importComplete !== false,
        delivery: oracle.backupDelivery ?? null,
      }),
    };
  });
  return {
    rows,
    nextOffset: offset + 20 < owners.length ? offset + 20 : null,
  };
}
