import {
  assertOracleBackupDeliveryOwner,
  buildTerminalOracleBackupRecord,
  deliverOracleBackup,
  OracleBackupDeliveryError,
  prepareOracleBackupDelivery,
  readOracleBackupRelayEvent,
  retryOracleBackupDelivery,
  type OracleBackupDeliveryAdapters,
} from "@bitcaster/client-sdk/oracleBackupDelivery";
import { hexToBytes } from "nostr-tools/utils";
import { OracleBackupError } from "@bitcaster/client-sdk";
import { browserOracleOwnerAuthority, useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";
import { resolveNsecIdentity } from "./identityOps";
import { browserOracleBackupValidator } from "./kormir";
import { exportLockedBrowserOracleBackup } from "./browserOracleBackup";
import { publishRetainedOracleEvent } from "./oracleRelayTransport";

export interface BrowserOracleBackupDeliveryOptions {
  readonly store?: typeof useCreatorMarketsStore;
  readonly nowSeconds?: () => number;
  readonly observedEvents?: readonly unknown[];
  readonly publishRelay?: OracleBackupDeliveryAdapters["publishRelay"];
}

function requireBackupKey(pubkey: string) {
  const settings = useSettingsStore.getState();
  const identity = resolveNsecIdentity(settings.nsecSecret);
  if (settings.nostrSignerMode !== "nsec" || !identity || identity.publicKey !== pubkey)
    throw new OracleBackupDeliveryError("preparation-key-unavailable");
  return hexToBytes(identity.privateKeyHex);
}

/** Local preparation owns the document lock. Saved relay retry never reads the signer. */
export function createBrowserOracleBackupDeliveryAdapters(
  options: BrowserOracleBackupDeliveryOptions = {},
): OracleBackupDeliveryAdapters {
  const owner = options.store ?? useCreatorMarketsStore;
  return {
    store: {
      read: (id) => owner.getState().readOracleBackupDelivery(id),
      async prepare(id) {
        try {
          return await owner.getState().withOracleMutation(async (locked) => {
            const savedOwner = await locked.readOwner(id);
            if (!savedOwner) throw new OracleBackupDeliveryError("invalid-source");
            const { binding, announcementHex, destinations } =
              browserOracleOwnerAuthority(savedOwner);
            if (!destinations) throw new OracleBackupDeliveryError("invalid-source");
            const previous = await locked.readBackupDelivery(id);
            const publication = await locked.read(id);
            const terminalReady = publication?.attestation != null && publication.relayPublished;
            if (
              previous?.current?.mode === "terminal" ||
              (previous?.current?.mode === "initial" && !terminalReady)
            )
              return previous;
            const privateKey = requireBackupKey(binding.oraclePubkey);
            const record = terminalReady
              ? buildTerminalOracleBackupRecord({
                  binding,
                  announcementTlvHex: announcementHex,
                  destinations,
                  publication: publication!,
                })
              : await exportLockedBrowserOracleBackup(id, locked);
            const state = await prepareOracleBackupDelivery({
              record,
              previous,
              privateKey,
              validator: browserOracleBackupValidator,
              nowSeconds: options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
              observedEvents: options.observedEvents,
            });
            requireBackupKey(binding.oraclePubkey);
            const currentOwner = await locked.readOwner(id);
            if (!currentOwner) throw new OracleBackupDeliveryError("invalid-source");
            const current = browserOracleOwnerAuthority(currentOwner);
            assertOracleBackupDeliveryOwner(state, {
              binding: current.binding,
              relayUrls: current.destinations!.relayUrls,
              publication: await locked.read(id),
            });
            await locked.saveBackupPreparation(id, state);
            return (await locked.readBackupDelivery(id))!;
          });
        } catch (error) {
          if (error instanceof OracleBackupDeliveryError) throw error;
          if (error instanceof OracleBackupError && error.reason === "oversized")
            throw new OracleBackupDeliveryError("oversized");
          throw new OracleBackupDeliveryError("invalid-source");
        }
      },
      confirm: (id, ack) => owner.getState().confirmOracleBackupDelivery(id, ack),
      commitTerminal: (id, admission) => owner.getState().commitOracleBackupTerminal(id, admission),
    },
    publishRelay:
      options.publishRelay ??
      (async (relayUrl, eventJson) => {
        readOracleBackupRelayEvent(eventJson);
        return {
          eventId: await publishRetainedOracleEvent([relayUrl], eventJson),
          relayUrl,
        };
      }),
  };
}

export function deliverBrowserOracleBackup(
  conditionId: string,
  options: BrowserOracleBackupDeliveryOptions = {},
) {
  return deliverOracleBackup(createBrowserOracleBackupDeliveryAdapters(options), conditionId);
}

/** Primary creation and resolution do not depend on independent backup delivery. */
export function requestBrowserOracleBackup(
  conditionId: string,
  options: BrowserOracleBackupDeliveryOptions = {},
) {
  void deliverBrowserOracleBackup(conditionId, options).catch(() => undefined);
}

export function retryBrowserOracleBackupDelivery(
  conditionId: string,
  options: BrowserOracleBackupDeliveryOptions = {},
) {
  return retryOracleBackupDelivery(createBrowserOracleBackupDeliveryAdapters(options), conditionId);
}
