import {
  assertOracleBackupDeliveryOwner,
  buildTerminalOracleBackupRecord,
  deliverOracleBackup,
  OracleBackupDeliveryError,
  prepareOracleBackupDelivery,
  readOracleBackupRelayEvent,
  retryOracleBackupDelivery,
  type OracleBackupDeliveryAdapters,
  type OracleBackupDeliveryState,
} from "@bitcaster/client-sdk/oracleBackupDelivery";
import { OracleBackupError } from "@bitcaster/client-sdk";
import { browserOracleOwnerAuthority, useCreatorMarketsStore } from "@/stores/creatorMarkets";
import {
  browserOracleBackupValidator,
  prepareBrowserOracleMutation,
  type BrowserOracleMutation,
} from "./kormir";
import { exportLockedBrowserOracleBackup } from "./browserOracleBackup";
import { publishRetainedOracleEvent } from "./oracleRelayTransport";

export interface BrowserOracleBackupDeliveryOptions {
  readonly store?: typeof useCreatorMarketsStore;
  readonly nowSeconds?: () => number;
  readonly observedEvents?: readonly unknown[];
  readonly requireCurrent?: () => void;
  readonly publishRelay?: OracleBackupDeliveryAdapters["publishRelay"];
}

function retainedDelivery(previous: OracleBackupDeliveryState | null, terminalReady: boolean) {
  return (
    previous?.current?.mode === "terminal" ||
    (previous?.current?.mode === "initial" && !terminalReady)
  );
}

/** Local preparation owns the document lock. Saved relay retry never reads the signer. */
export function createBrowserOracleBackupDeliveryAdapters(
  options: BrowserOracleBackupDeliveryOptions = {},
): OracleBackupDeliveryAdapters {
  const owner = options.store ?? useCreatorMarketsStore;
  let preparationAdmission: BrowserOracleMutation | undefined;
  return {
    store: {
      read: (id) => owner.getState().readOracleBackupDelivery(id),
      async prepare(id) {
        options.requireCurrent?.();
        try {
          const retained = await owner.getState().withOracleMutation(async (locked) => {
            const previous = await locked.readBackupDelivery(id);
            const publication = await locked.read(id);
            return retainedDelivery(
              previous,
              publication?.attestation != null && publication.relayPublished,
            )
              ? previous
              : null;
          });
          if (retained) return retained;
          options.requireCurrent?.();
          const savedOwner = await owner.getState().readOracleOwner(id);
          if (!savedOwner) throw new OracleBackupDeliveryError("invalid-source");
          const admission = await prepareBrowserOracleMutation(
            browserOracleOwnerAuthority(savedOwner).binding.oraclePubkey,
          );
          preparationAdmission = admission;
          const result = await owner.getState().withOracleMutation((locked) => {
            options.requireCurrent?.();
            return admission.withCoreLocked(async (core, privateKey) => {
              const savedOwner = await locked.readOwner(id);
              if (!savedOwner) throw new OracleBackupDeliveryError("invalid-source");
              const { binding, announcementHex, destinations } =
                browserOracleOwnerAuthority(savedOwner);
              if (!destinations) throw new OracleBackupDeliveryError("invalid-source");
              const previous = await locked.readBackupDelivery(id);
              const publication = await locked.read(id);
              const terminalReady = publication?.attestation != null && publication.relayPublished;
              if (binding.oraclePubkey !== admission.publicKey)
                throw new OracleBackupDeliveryError("invalid-source");
              if (retainedDelivery(previous, terminalReady)) return previous!;
              const record = terminalReady
                ? buildTerminalOracleBackupRecord({
                    binding,
                    announcementTlvHex: announcementHex,
                    destinations,
                    publication: publication!,
                  })
                : await exportLockedBrowserOracleBackup(id, locked, core);
              const state = await prepareOracleBackupDelivery({
                record,
                previous,
                privateKey,
                validator: browserOracleBackupValidator,
                nowSeconds: options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
                observedEvents: options.observedEvents,
              });
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
          });
          admission.requireCurrent();
          options.requireCurrent?.();
          return result;
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
    publishRelay: async (relayUrl, eventJson) => {
      options.requireCurrent?.();
      preparationAdmission?.requireCurrent();
      if (options.publishRelay) return options.publishRelay(relayUrl, eventJson);
      readOracleBackupRelayEvent(eventJson);
      return { eventId: await publishRetainedOracleEvent([relayUrl], eventJson), relayUrl };
    },
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
