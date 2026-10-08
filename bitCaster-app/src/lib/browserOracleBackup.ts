import {
  encodeOracleBackup,
  readOracleBackupEnvelope,
  OracleBackupError,
  type OracleBackupRecord,
  type MarketCreationPreparation,
} from "@bitcaster/client-sdk";
import type {
  OraclePublicationBinding,
  OraclePublicationRecord,
} from "@bitcaster/client-sdk/oraclePublication";
import {
  buildTerminalOracleBackupRecord,
  OracleBackupDeliveryError,
} from "@bitcaster/client-sdk/oracleBackupDelivery";
import { restoreOracleBackupEnvelope } from "@bitcaster/client-sdk/oracleBackupAccess";
import { readSignedOracleEvent } from "@bitcaster/client-sdk/oracleResolutionExplanation";
import { hexToBytes } from "nostr-tools/utils";
import {
  useCreatorMarketsStore,
  type BrowserOracleLockedPort,
  browserOracleOwnerAuthority,
} from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";
import { assertNever } from "./enumDiscipline";
import { resolveNsecIdentity } from "./identityOps";
import {
  browserOracleBackupValidator,
  BrowserOracleMutationError,
  prepareBrowserOracleMutation,
  withBrowserOracleMutation,
  type BrowserOracleMutation,
  type Kormir,
} from "./kormir";
import {
  browserOraclePrivateAuthorityPort,
  reconcileBrowserOraclePublication,
} from "./browserOraclePublicationHandoff";

type CreatorStore = typeof useCreatorMarketsStore;

/** Fresh and resumed unpaid creation must fit the complete private envelope before payment. */
export async function preflightBrowserOracleCreation(preparation: MarketCreationPreparation) {
  try {
    await withBrowserOracleMutation(preparation.creatorId, (core) =>
      preflightLockedBrowserOracleCreation(preparation, core),
    );
  } catch (error) {
    if (error instanceof BrowserOracleMutationError && error.reason !== "authority-unavailable")
      throw error;
    if (error instanceof OracleBackupError && error.reason === "oversized") throw error;
    throw new OracleBackupError("invalid-record");
  }
}

/** The caller already owns local oracle admission. */
export async function preflightLockedBrowserOracleCreation(
  preparation: MarketCreationPreparation,
  core: Kormir,
) {
  await core.import_enum_event(preparation.announcement.announcementTlvHex);
  const authority = JSON.parse(
    await core.export_enum_authority(
      preparation.eventId,
      preparation.announcement.announcementNostrEventJson,
    ),
  ) as OracleBackupRecord["authority"];
  await encodeOracleBackup(
    {
      schemaVersion: 1,
      conditionId: preparation.announcement.conditionId,
      oraclePubkey: preparation.creatorId,
      oracleEventId: preparation.eventId,
      authority,
      destinations: {
        mintUrl: preparation.mintUrl,
        engineUrl: preparation.engineBaseUrl,
        relayUrls: preparation.relayUrls,
      },
    },
    browserOracleBackupValidator,
  );
}

export { browserOracleOwnerAuthority } from "@/stores/creatorMarkets";

export async function reconcileLockedBrowserOracle(
  locked: BrowserOracleLockedPort,
  binding: OraclePublicationBinding,
  announcementHex: string,
  core: Kormir,
  incoming?: OraclePublicationRecord,
) {
  const owner = await locked.readOwner(binding.conditionId);
  if (!owner) throw new OracleBackupError("invalid-record");
  if (
    owner.kind === "imported"
      ? !owner.oracle.importComplete
      : owner.market.oracle?.importComplete === false
  )
    throw new BrowserOracleMutationError("import-incomplete");
  // This preserves the bounded deterministic recovery path for old announcements.
  await core.import_enum_event(announcementHex);
  return reconcileBrowserOraclePublication({
    binding,
    core: browserOraclePrivateAuthorityPort(core),
    store: locked,
    validator: browserOracleBackupValidator,
    incoming,
  });
}

/** Retain public metadata before the private transaction, then acknowledge its exact stage. */
export async function importBrowserOracleBackup(
  input: unknown,
  store: CreatorStore = useCreatorMarketsStore,
) {
  return importBrowserOracleBackupRecord(input, store);
}

/** The receiver derives provenance from the same fully authenticated envelope as authority. */
export async function importBrowserOracleBackupEnvelope(
  event: unknown,
  sourceRelay: string,
  store: CreatorStore = useCreatorMarketsStore,
  capturedAdmission?: BrowserOracleMutation,
  requireCurrent?: () => void,
) {
  const settings = useSettingsStore.getState();
  const identity = resolveNsecIdentity(settings.nsecSecret);
  if (settings.nostrSignerMode !== "nsec" || !identity)
    throw new OracleBackupError("invalid-record");
  const admission = capturedAdmission ?? (await prepareBrowserOracleMutation(identity.publicKey));
  admission.requireCurrent();
  const envelope = readOracleBackupEnvelope(event, identity.publicKey);
  const restored = await restoreOracleBackupEnvelope({
    event: envelope,
    sourceRelay,
    privateKey: hexToBytes(identity.privateKeyHex),
    validator: browserOracleBackupValidator,
  });
  await importBrowserOracleBackupRecord(
    restored.record,
    store,
    {
      record: restored.record,
      event: envelope,
      sourceRelay: restored.source.sourceRelay,
    },
    admission,
    requireCurrent,
  );
  admission.requireCurrent();
  requireCurrent?.();
  return restored.descriptor;
}

async function importBrowserOracleBackupRecord(
  input: unknown,
  store: CreatorStore,
  authenticatedEnvelope?: {
    record: OracleBackupRecord;
    event: unknown;
    sourceRelay: string;
  },
  capturedAdmission?: BrowserOracleMutation,
  requireCurrent?: () => void,
) {
  try {
    const admission = capturedAdmission ?? (await prepareBrowserOracleMutation());
    const encoded = await encodeOracleBackup(input, browserOracleBackupValidator);
    const record = JSON.parse(encoded) as OracleBackupRecord;
    const summary = await browserOracleBackupValidator.validateAuthority(
      JSON.stringify(record.authority),
      record.oraclePubkey,
    );
    const binding: OraclePublicationBinding = {
      conditionId: record.conditionId,
      oracleEventId: record.oracleEventId,
      oraclePubkey: record.oraclePubkey,
      outcomes: summary.outcomes,
      announcementEventJson: record.authority.announcementEventJson,
    };
    if (admission.publicKey !== record.oraclePubkey) throw new OracleBackupError("invalid-record");
    const result = await store.getState().withOracleMutation((locked) => {
      requireCurrent?.();
      return admission.withCoreLocked(async (core) => {
        await locked.retainImportMetadata(
          {
            binding,
            announcementHex: record.authority.announcementTlvHex,
            destinations: record.destinations,
          },
          authenticatedEnvelope,
        );
        await core.import_enum_authority(JSON.stringify(record.authority));
        await reconcileBrowserOraclePublication({
          binding,
          core: browserOraclePrivateAuthorityPort(core),
          store: locked,
          validator: browserOracleBackupValidator,
        });
        await locked.markImportComplete(record.conditionId);
        const owner = await locked.readOwner(record.conditionId);
        if (!owner) throw new OracleBackupError("invalid-record");
        return owner;
      });
    });
    admission.requireCurrent();
    requireCurrent?.();
    return result;
  } catch (error) {
    if (error instanceof BrowserOracleMutationError && error.reason !== "authority-unavailable")
      throw error;
    if (error instanceof OracleBackupDeliveryError) throw error;
    if (error instanceof OracleBackupError && error.reason === "oversized") throw error;
    throw new OracleBackupError("invalid-record");
  }
}

/** Return portable authority only through this private boundary; never persist it in the creator document. */
export async function exportLockedBrowserOracleBackup(
  conditionId: string,
  locked: BrowserOracleLockedPort,
  core?: Kormir,
): Promise<OracleBackupRecord> {
  const owner = await locked.readOwner(conditionId);
  if (!owner) throw new OracleBackupError("invalid-record");
  const { binding, announcementHex, destinations } = browserOracleOwnerAuthority(owner);
  if (!destinations) throw new OracleBackupError("invalid-record");
  const delivery = await locked.readBackupDelivery(conditionId);
  const publication = await locked.read(conditionId);
  let record: OracleBackupRecord;
  if (delivery?.terminalAdmission && !delivery.terminalCommitPending && publication) {
    record = buildTerminalOracleBackupRecord({
      binding,
      announcementTlvHex: announcementHex,
      destinations,
      publication,
    });
  } else {
    if (!core) throw new OracleBackupError("invalid-record");
    const result = await reconcileLockedBrowserOracle(locked, binding, announcementHex, core);
    record = {
      schemaVersion: 1,
      conditionId,
      oraclePubkey: binding.oraclePubkey,
      oracleEventId: binding.oracleEventId,
      authority: result.authority,
      destinations,
    };
  }
  return JSON.parse(
    await encodeOracleBackup(record, browserOracleBackupValidator),
  ) as OracleBackupRecord;
}

/** Terminal public authority needs neither a private core nor a connected signer. */
async function readLockedTerminalBackup(
  conditionId: string,
  locked: BrowserOracleLockedPort,
): Promise<OracleBackupRecord | null> {
  const owner = await locked.readOwner(conditionId);
  if (!owner) throw new OracleBackupError("invalid-record");
  const { binding, announcementHex, destinations } = browserOracleOwnerAuthority(owner);
  if (!destinations) throw new OracleBackupError("invalid-record");
  const delivery = await locked.readBackupDelivery(conditionId);
  const publication = await locked.read(conditionId);
  if (!delivery?.terminalAdmission || delivery.terminalCommitPending || !publication) return null;
  return buildTerminalOracleBackupRecord({
    binding,
    announcementTlvHex: announcementHex,
    destinations,
    publication,
  });
}

export async function exportBrowserOracleBackup(
  conditionId: string,
  store: CreatorStore = useCreatorMarketsStore,
): Promise<OracleBackupRecord> {
  try {
    const terminal = await store
      .getState()
      .withOracleMutation((locked) => readLockedTerminalBackup(conditionId, locked));
    if (terminal)
      return JSON.parse(
        await encodeOracleBackup(terminal, browserOracleBackupValidator),
      ) as OracleBackupRecord;
    const owner = await store.getState().readOracleOwner(conditionId);
    if (!owner) throw new OracleBackupError("invalid-record");
    const admission = await prepareBrowserOracleMutation(
      browserOracleOwnerAuthority(owner).binding.oraclePubkey,
    );
    const result = await store
      .getState()
      .withOracleMutation((locked) =>
        admission.withCoreLocked((core) =>
          exportLockedBrowserOracleBackup(conditionId, locked, core),
        ),
      );
    admission.requireCurrent();
    return result;
  } catch (error) {
    if (
      error instanceof BrowserOracleMutationError &&
      error.reason !== "authority-unavailable" &&
      error.reason !== "import-incomplete"
    )
      throw error;
    if (error instanceof OracleBackupError && error.reason === "oversized") throw error;
    throw new OracleBackupError("invalid-record");
  }
}

/** Private DTOs stay within this adapter. A metadata flag is never signing authority. */
export type BrowserOracleAuthorityReadiness = "ready" | "needs-restore" | "unavailable";
export async function browserOracleAuthorityReadiness(
  conditionId: string,
  store: CreatorStore = useCreatorMarketsStore,
  requireCurrent?: () => void,
): Promise<BrowserOracleAuthorityReadiness> {
  try {
    const admission = await prepareBrowserOracleMutation();
    const readiness = await store.getState().withOracleMutation((locked) => {
      requireCurrent?.();
      return admission.withCoreLocked(async (core): Promise<BrowserOracleAuthorityReadiness> => {
        const owner = await locked.readOwner(conditionId);
        if (!owner) return "needs-restore";
        let ownerAuthority: ReturnType<typeof browserOracleOwnerAuthority>;
        if (
          owner.kind === "created" &&
          (!owner.market.oracle?.oraclePubkey || !owner.market.oracle?.destinations)
        ) {
          const oracle = owner.market.oracle;
          if (!oracle?.announcementEventJson || !oracle.announcementHex) return "unavailable";
          const event = readSignedOracleEvent(oracle.announcementEventJson, 88);
          const binding = {
            conditionId: owner.market.conditionId,
            oracleEventId: oracle.eventId,
            oraclePubkey: oracle.oraclePubkey ?? event.pubkey,
            outcomes: oracle.outcomes,
            announcementEventJson: oracle.announcementEventJson,
          };
          // Load the shared verifier after module initialization; publication also uses this adapter.
          const { retainedOracleAuthority } = await import("./oracleAttestation");
          // This supplies only a verified public binding, never private signing authority.
          const verified = await retainedOracleAuthority(binding, {
            announcementTlvHex: oracle.announcementHex,
          });
          if (
            oracle.announcementEventId !== undefined &&
            oracle.announcementEventId !== verified.announcementEventId
          )
            return "unavailable";
          ownerAuthority = {
            binding,
            announcementHex: oracle.announcementHex,
            destinations: oracle.destinations,
          };
        } else ownerAuthority = browserOracleOwnerAuthority(owner);
        admission.requireCurrent();
        requireCurrent?.();
        const { binding, announcementHex, destinations } = ownerAuthority;
        if (binding.oraclePubkey !== admission.publicKey) return "unavailable";
        // This exact event lookup distinguishes absence from a corrupt nonce or invalid export.
        // JsError.NotFound (2) here means the event is absent, not a validation failure.
        try {
          await core.staged_enum_publication(binding.oracleEventId);
        } catch (error) {
          return error === 2 ? "needs-restore" : "unavailable";
        }
        if (!destinations) return "unavailable";
        const publication = await locked.read(conditionId);
        const dto = await core.export_enum_authority(
          binding.oracleEventId,
          binding.announcementEventJson,
          publication ? JSON.stringify(publication) : undefined,
        );
        const authority = JSON.parse(dto);
        await encodeOracleBackup(
          {
            schemaVersion: 1,
            conditionId,
            oraclePubkey: binding.oraclePubkey,
            oracleEventId: binding.oracleEventId,
            authority,
            destinations,
          },
          browserOracleBackupValidator,
        );
        const summary = await browserOracleBackupValidator.validateAuthority(
          dto,
          binding.oraclePubkey,
        );
        if (
          authority.announcementTlvHex !== announcementHex ||
          summary.outcomes.length !== binding.outcomes.length ||
          summary.outcomes.some((value, index) => value !== binding.outcomes[index])
        )
          return "unavailable";
        switch (owner.kind) {
          case "imported":
            return owner.oracle.importComplete ? "ready" : "needs-restore";
          case "created":
            return owner.market.oracle?.importComplete === false ? "needs-restore" : "ready";
          default:
            return assertNever(owner);
        }
      });
    });
    admission.requireCurrent();
    requireCurrent?.();
    return readiness;
  } catch {
    return "unavailable";
  }
}
