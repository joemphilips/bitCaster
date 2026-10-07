import {
  deriveDlcConditionId,
  OracleBackupError,
  snapshotOraclePrivateAuthority,
  type OracleBackupValidator,
  type OraclePrivateAuthority,
} from "@bitcaster/client-sdk";
import {
  mergeOraclePublicationRecords,
  snapshotOraclePublicationRecord,
  type OraclePublicationBinding,
  type OraclePublicationRecord,
} from "@bitcaster/client-sdk/oraclePublication";
import type { Kormir } from "./kormir";

export interface BrowserOraclePrivateAuthorityPort {
  exportAuthority(
    eventId: string,
    announcementJson: string,
    publicationJson?: string,
  ): Promise<string>;
  stagedPublication(eventId: string): Promise<string | undefined>;
  acknowledgePublication(eventId: string, exactPublicationJson: string): Promise<void>;
}

export interface BrowserOraclePublicationHandoffStore {
  read(conditionId: string): Promise<OraclePublicationRecord | null>;
  save(conditionId: string, record: OraclePublicationRecord): Promise<OraclePublicationRecord>;
}

export function browserOraclePrivateAuthorityPort(core: Kormir): BrowserOraclePrivateAuthorityPort {
  return {
    exportAuthority: (eventId, announcementJson, publicationJson) =>
      core.export_enum_authority(eventId, announcementJson, publicationJson),
    stagedPublication: (eventId) => core.staged_enum_publication(eventId),
    acknowledgePublication: (eventId, exact) => core.acknowledge_enum_publication(eventId, exact),
  };
}

/** The caller serializes local publication mutations. Core validation and CAS own signing authority. */
export async function reconcileBrowserOraclePublication(input: {
  readonly binding: OraclePublicationBinding;
  readonly core: BrowserOraclePrivateAuthorityPort;
  readonly store: BrowserOraclePublicationHandoffStore;
  readonly validator: OracleBackupValidator;
  readonly incoming?: OraclePublicationRecord;
}): Promise<{ authority: OraclePrivateAuthority; publication: OraclePublicationRecord | null }> {
  try {
    const { binding, core, store, validator } = input;
    async function validatePrivate(privateJson: string) {
      const authority = snapshotOraclePrivateAuthority(JSON.parse(privateJson));
      const summary = await validator.validateAuthority(privateJson, binding.oraclePubkey);
      if (
        authority.announcementEventJson !== binding.announcementEventJson ||
        summary.eventId !== binding.oracleEventId ||
        summary.oraclePubkey !== binding.oraclePubkey ||
        JSON.stringify(summary.outcomes) !== JSON.stringify(binding.outcomes) ||
        deriveDlcConditionId({
          eventId: summary.eventId,
          outcomeCount: summary.outcomes.length,
          oraclePublicKeys: [summary.oraclePubkey],
        }) !== binding.conditionId
      )
        throw new Error();
      return authority;
    }
    const requireBinding = (record: OraclePublicationRecord) => {
      const exact = snapshotOraclePublicationRecord(record);
      if (JSON.stringify(exact.binding) !== JSON.stringify(binding)) throw new Error();
      return exact;
    };
    async function save(record: OraclePublicationRecord) {
      const exact = requireBinding(record);
      const saved = await store.save(binding.conditionId, exact);
      const durable = await store.read(binding.conditionId);
      if (
        durable === null ||
        JSON.stringify(requireBinding(saved)) !== JSON.stringify(exact) ||
        JSON.stringify(requireBinding(durable)) !== JSON.stringify(exact)
      )
        throw new Error();
      return exact;
    }
    async function drainStage() {
      const staged = await core.stagedPublication(binding.oracleEventId);
      if (staged === undefined) return;
      await validatePrivate(
        await core.exportAuthority(binding.oracleEventId, binding.announcementEventJson, staged),
      );
      const candidate = requireBinding(JSON.parse(staged));
      const merged = mergeOraclePublicationRecords(
        await store.read(binding.conditionId),
        candidate,
      )!;
      await save(merged);
      // A failed write or read leaves the exact stage in private storage.
      await core.acknowledgePublication(binding.oracleEventId, staged);
    }
    await drainStage();
    const retained = await store.read(binding.conditionId);
    const requested = mergeOraclePublicationRecords(
      retained,
      input.incoming === undefined ? null : requireBinding(input.incoming),
    );
    function publicationFromAuthority(authority: OraclePrivateAuthority) {
      return authority.publicationRecordJson !== null
        ? requireBinding(JSON.parse(authority.publicationRecordJson))
        : authority.signedOutcome === null
          ? null
          : requireBinding({
              binding,
              chosenOutcome: authority.signedOutcome,
              attestation:
                authority.attestationHex !== null && authority.attestationEventJson !== null
                  ? {
                      attestationHex: authority.attestationHex,
                      eventJson: authority.attestationEventJson,
                    }
                  : null,
              relayPublished: false,
              engineEvidence: null,
              explanationEventJson: null,
              explanationRelayPublished: false,
            });
    }
    // A crash can leave a public choice with no artifact after core signing completed.
    // Merge that retained exact artifact before passing public progress back to the core.
    const privateBefore = await validatePrivate(
      await core.exportAuthority(binding.oracleEventId, binding.announcementEventJson),
    );
    const supplied = mergeOraclePublicationRecords(
      requested,
      publicationFromAuthority(privateBefore),
    );
    const privateJson = await core.exportAuthority(
      binding.oracleEventId,
      binding.announcementEventJson,
      supplied === null ? undefined : JSON.stringify(supplied),
    );
    const authority = await validatePrivate(privateJson);
    const privatePublication = publicationFromAuthority(authority);
    const publication = mergeOraclePublicationRecords(supplied, privatePublication);
    if (publication !== null) await save(publication);
    await drainStage();
    return {
      authority: {
        ...authority,
        publicationRecordJson: publication === null ? null : JSON.stringify(publication),
      },
      publication,
    };
  } catch {
    // Private helper or storage errors must not escape this boundary.
    throw new OracleBackupError("invalid-record");
  }
}
