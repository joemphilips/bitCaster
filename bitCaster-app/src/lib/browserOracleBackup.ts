import {
  encodeOracleBackup,
  OracleBackupError,
  type OracleBackupRecord,
  type MarketCreationPreparation,
} from "@bitcaster/client-sdk";
import type {
  OraclePublicationBinding,
  OraclePublicationRecord,
} from "@bitcaster/client-sdk/oraclePublication";
import { buildTerminalOracleBackupRecord } from "@bitcaster/client-sdk/oracleBackupDelivery";
import {
  useCreatorMarketsStore,
  type BrowserOracleLockedPort,
  browserOracleOwnerAuthority,
} from "@/stores/creatorMarkets";
import { useSettingsStore } from "@/stores/settings";
import { resolveNsecIdentity } from "./identityOps";
import {
  browserOracleBackupValidator,
  ensureKormirNsec,
  getKormir,
  importEnumAnnouncement,
} from "./kormir";
import {
  browserOraclePrivateAuthorityPort,
  reconcileBrowserOraclePublication,
} from "./browserOraclePublicationHandoff";

type CreatorStore = typeof useCreatorMarketsStore;

/** Fresh and resumed unpaid creation must fit the complete private envelope before payment. */
export async function preflightBrowserOracleCreation(preparation: MarketCreationPreparation) {
  try {
    const core = await requireOracleCore(preparation.creatorId);
    await importEnumAnnouncement([], preparation.announcement.announcementTlvHex);
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
  } catch (error) {
    if (error instanceof OracleBackupError && error.reason === "oversized") throw error;
    throw new OracleBackupError("invalid-record");
  }
}

export { browserOracleOwnerAuthority } from "@/stores/creatorMarkets";

async function requireOracleCore(expectedPubkey: string) {
  const settings = useSettingsStore.getState();
  const identity = resolveNsecIdentity(settings.nsecSecret);
  if (settings.nostrSignerMode !== "nsec" || !identity || identity.publicKey !== expectedPubkey)
    throw new OracleBackupError("invalid-record");
  await ensureKormirNsec([], settings.nsecSecret!);
  const current = useSettingsStore.getState();
  if (
    current.nostrSignerMode !== "nsec" ||
    resolveNsecIdentity(current.nsecSecret)?.publicKey !== expectedPubkey
  )
    throw new OracleBackupError("invalid-record");
  return getKormir([]);
}

export async function reconcileLockedBrowserOracle(
  locked: BrowserOracleLockedPort,
  binding: OraclePublicationBinding,
  announcementHex: string,
  incoming?: OraclePublicationRecord,
) {
  const owner = await locked.readOwner(binding.conditionId);
  if (!owner) throw new OracleBackupError("invalid-record");
  if (
    owner.kind === "imported"
      ? !owner.oracle.importComplete
      : owner.market.oracle?.importComplete === false
  )
    throw new Error("Complete the oracle backup import before signing.");
  const core = await requireOracleCore(binding.oraclePubkey);
  // This preserves the bounded deterministic recovery path for old announcements.
  await importEnumAnnouncement([], announcementHex);
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
  try {
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
    const core = await requireOracleCore(record.oraclePubkey);
    return await store.getState().withOracleMutation(async (locked) => {
      await locked.retainImportMetadata({
        binding,
        announcementHex: record.authority.announcementTlvHex,
        destinations: record.destinations,
      });
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
  } catch (error) {
    if (error instanceof OracleBackupError && error.reason === "oversized") throw error;
    throw new OracleBackupError("invalid-record");
  }
}

/** Return portable authority only through this private boundary; never persist it in the creator document. */
export async function exportLockedBrowserOracleBackup(
  conditionId: string,
  locked: BrowserOracleLockedPort,
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
    const result = await reconcileLockedBrowserOracle(locked, binding, announcementHex);
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

export async function exportBrowserOracleBackup(
  conditionId: string,
  store: CreatorStore = useCreatorMarketsStore,
): Promise<OracleBackupRecord> {
  try {
    return await store
      .getState()
      .withOracleMutation((locked) => exportLockedBrowserOracleBackup(conditionId, locked));
  } catch (error) {
    if (error instanceof OracleBackupError && error.reason === "oversized") throw error;
    throw new OracleBackupError("invalid-record");
  }
}
