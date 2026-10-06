import { create } from "zustand";
import type { StateStorage } from "zustand/middleware";
import {
  OracleBackupError,
  readOracleBackupEnvelope,
  type OracleBackupRecord,
} from "@bitcaster/client-sdk";
import {
  assertOracleBackupDeliveryOwner,
  snapshotOracleBackupDeliveryState,
  confirmOracleBackupDelivery,
  commitOracleBackupDelivery,
  admitOracleBackupSource,
  type OracleBackupDeliveryState,
  type OracleBackupDeliveryAcknowledgment,
  type OracleBackupTerminalAdmission,
} from "@bitcaster/client-sdk/oracleBackupDelivery";
import { announcementContentFromTlv } from "@bitcaster/client-sdk/oracleAnnouncementEncoding";
import type { ProductMarketDivisibility } from "@/types/market";
import {
  snapshotOraclePublicationRecord,
  mergeOraclePublicationRecords,
  type OraclePublicationBinding,
  type OraclePublicationRecord,
  type OraclePublicationFailureStage,
  type OraclePublicationStore,
  type VerifiedOraclePublicationEvidence,
} from "@bitcaster/client-sdk/oraclePublication";
import {
  readSignedOracleEvent,
  ORACLE_EXPLANATION_UTF8_BYTES_MAX,
} from "@bitcaster/client-sdk/oracleResolutionExplanation";

/**
 * Client-side record of a market the user has created via the wizard.
 *
 * Creator-market discovery is public enough to index server-side, but this
 * local store remains the immediate UX source after the wizard completes. The
 * dashboard enriches each entry with live volume data pulled from
 * `GET /api/v1/creators/{pubkey}/markets`.
 */
export interface StoredCreatorMarket {
  /** Condition ID the market was registered under. Stable, primary key. */
  conditionId: string;
  /** Human-readable title (echoed so the dashboard can render before the mint is reachable). */
  title: string;
  /** Thumbnail URL returned by the matching engine, or `null` when the user skipped the upload. */
  thumbnailUrl: string | null;
  /** ISO-8601 timestamp recorded when the wizard reported a successful submission. */
  createdAt: string;
  /** Explicit product base asset captured at creation. */
  baseAsset: "sat";
  /** Immutable market price denominator selected at creation. */
  divisibility: ProductMarketDivisibility;
  /**
   * Percentage fee (0.0-1.0 scale matching `CreatedMarket.creatorFeePercent`)
   * the user chose at wizard step 5. Kept client-side because fee accrual is
   * stubbed for v1 and not tracked by the engine.
   */
  creatorFeePercent: number;
  /** Oracle metadata captured when the creator used their own nsec-backed DLC oracle. */
  oracle?: StoredCreatorOracleMetadata;
}

export interface StoredCreatorOracleMetadata {
  type: "self";
  /** Exact encrypted transport state remains local. Public mirrors use an allowlist. */
  backupDelivery?: OracleBackupDeliveryState;
  destinations?: BrowserOracleDestinations;
  importComplete?: boolean;
  /** DLC oracle event_id passed to kormir when the announcement was created. */
  eventId: string;
  /** Nostr kind-88 event id for the announcement, used by NIP-88 kind-89 e-tags. */
  announcementEventId?: string;
  /** Exact original signed kind-88 envelope. Never create a replacement during recovery. */
  announcementEventJson?: string;
  oraclePubkey?: string;
  engineBaseUrl?: string;
  /** Enum outcomes the oracle can attest. Numeric self-oracle markets are not supported yet. */
  outcomes: string[];
  /** Exact public announcement bytes. Private per-event authority remains in Kormir. */
  announcementHex?: string;
  /** Hex-encoded oracle_attestation returned by kormir after resolution signing. */
  attestationHex?: string;
  /** Outcome the creator attested. */
  attestedOutcome?: string;
  /** Time at which the exact signed attestation was retained. */
  attestedAt?: string;
  chosenOutcome?: string;
  chosenAt?: string;
  attestationEventJson?: string;
  explanationDraft?: string;
  explanationEventJson?: string;
  relayPublished?: boolean;
  engineEvidence?: VerifiedOraclePublicationEvidence;
  explanationRelayPublished?: boolean;
  publicationFailures?: OraclePublicationFailureStage[];
}

export type BrowserOracleDestinations = OracleBackupRecord["destinations"];
export interface StoredImportedOracleMetadata {
  binding: OraclePublicationBinding;
  announcementHex: string;
  destinations: BrowserOracleDestinations;
  publication: OraclePublicationRecord | null;
  importComplete: boolean;
  backupDelivery?: OracleBackupDeliveryState;
  explanationDraft?: string;
  publicationFailures?: OraclePublicationFailureStage[];
}
export type BrowserOracleOwner =
  | { kind: "created"; market: StoredCreatorMarket }
  | { kind: "imported"; oracle: StoredImportedOracleMetadata };
export interface BrowserOracleImportMetadata {
  binding: OraclePublicationBinding;
  announcementHex: string;
  destinations: BrowserOracleDestinations;
}
interface BrowserOracleImportEnvelope {
  record: OracleBackupRecord;
  event: unknown;
  sourceRelay: string;
}
export interface BrowserOracleLockedPort {
  readOwner(conditionId: string): Promise<BrowserOracleOwner | null>;
  read(conditionId: string): Promise<OraclePublicationRecord | null>;
  save(conditionId: string, publication: OraclePublicationRecord): Promise<OraclePublicationRecord>;
  readDraft(conditionId: string): Promise<string | undefined>;
  saveDraft(conditionId: string, text: string): Promise<void>;
  retainImportMetadata(
    input: BrowserOracleImportMetadata,
    authenticatedEnvelope?: BrowserOracleImportEnvelope,
  ): Promise<BrowserOracleOwner>;
  markImportComplete(conditionId: string): Promise<void>;
  retainPreparation(conditionId: string, oracle: StoredCreatorOracleMetadata): Promise<void>;
  readBackupDelivery(conditionId: string): Promise<OracleBackupDeliveryState | null>;
  saveBackupPreparation(conditionId: string, state: OracleBackupDeliveryState): Promise<void>;
  confirmBackupDelivery(
    conditionId: string,
    ack: OracleBackupDeliveryAcknowledgment,
  ): Promise<OracleBackupDeliveryState>;
  commitBackupTerminal(
    conditionId: string,
    admission: OracleBackupTerminalAdmission,
  ): Promise<OracleBackupDeliveryState>;
}
export interface CreatorDocument {
  markets: StoredCreatorMarket[];
  importedOracles: StoredImportedOracleMetadata[];
}
export interface CreatorDocumentLocks {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}
interface CreatorMarketsState extends CreatorDocument {
  addCreatedMarket(market: StoredCreatorMarket): Promise<void>;
  saveCreatedMarket(market: StoredCreatorMarket): Promise<void>;
  removeCreatedMarket(conditionId: string): Promise<void>;
  replace(markets: StoredCreatorMarket[]): Promise<void>;
  mergeRemoteMarkets(markets: StoredCreatorMarket[]): Promise<StoredCreatorMarket[]>;
  clear(): Promise<void>;
  hasOraclePersistence(): boolean;
  readOracleOwner(conditionId: string): Promise<BrowserOracleOwner | null>;
  readOracleOwners(): Promise<BrowserOracleOwner[]>;
  readOraclePublication(conditionId: string): Promise<OraclePublicationRecord | null>;
  readOracleExplanationDraft(conditionId: string): Promise<string | undefined>;
  saveOraclePublication(
    conditionId: string,
    publication: OraclePublicationRecord,
  ): Promise<OraclePublicationRecord>;
  retainImportedOracleMetadata(input: BrowserOracleImportMetadata): Promise<BrowserOracleOwner>;
  markOracleImportComplete(conditionId: string): Promise<void>;
  retainOraclePreparation(conditionId: string, oracle: StoredCreatorOracleMetadata): Promise<void>;
  saveOracleExplanationDraft(conditionId: string, text: string): Promise<void>;
  saveOraclePublicationFailures(
    conditionId: string,
    failures: readonly OraclePublicationFailureStage[],
  ): Promise<void>;
  withOracleMutation<T>(action: (locked: BrowserOracleLockedPort) => Promise<T>): Promise<T>;
  readOracleBackupDelivery(conditionId: string): Promise<OracleBackupDeliveryState | null>;
  confirmOracleBackupDelivery(
    conditionId: string,
    ack: OracleBackupDeliveryAcknowledgment,
  ): Promise<OracleBackupDeliveryState>;
  commitOracleBackupTerminal(
    conditionId: string,
    admission: OracleBackupTerminalAdmission,
  ): Promise<OracleBackupDeliveryState>;
}

function creatorOracleEqual(
  a: StoredCreatorOracleMetadata | undefined,
  b: StoredCreatorOracleMetadata | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

export function creatorOraclePublication(
  market: StoredCreatorMarket,
): OraclePublicationRecord | null {
  const oracle = market.oracle;
  if (!oracle?.chosenOutcome) return null;
  if (Boolean(oracle.attestationHex) !== Boolean(oracle.attestationEventJson))
    throw new Error("Exact signed oracle attestation recovery is incomplete.");
  if (!oracle.oraclePubkey || !oracle.announcementEventJson)
    throw new Error("Original oracle announcement recovery is incomplete.");
  return snapshotOraclePublicationRecord({
    binding: {
      conditionId: market.conditionId,
      oracleEventId: oracle.eventId,
      oraclePubkey: oracle.oraclePubkey,
      outcomes: oracle.outcomes,
      announcementEventJson: oracle.announcementEventJson,
    },
    chosenOutcome: oracle.chosenOutcome,
    attestation:
      oracle.attestationEventJson && oracle.attestationHex
        ? {
            attestationHex: oracle.attestationHex,
            eventJson: oracle.attestationEventJson,
          }
        : null,
    relayPublished: oracle.relayPublished ?? false,
    engineEvidence: oracle.engineEvidence ?? null,
    explanationEventJson: oracle.explanationEventJson ?? null,
    explanationRelayPublished: oracle.explanationRelayPublished ?? false,
  });
}

function oracleWithPublication(
  oracle: StoredCreatorOracleMetadata,
  exact: OraclePublicationRecord,
): StoredCreatorOracleMetadata {
  return {
    ...oracle,
    oraclePubkey: exact.binding.oraclePubkey,
    announcementEventJson: exact.binding.announcementEventJson,
    chosenOutcome: exact.chosenOutcome,
    chosenAt: oracle.chosenAt ?? new Date().toISOString(),
    ...(exact.attestation === null
      ? {}
      : {
          attestationHex: exact.attestation.attestationHex,
          attestationEventJson: exact.attestation.eventJson,
          attestedOutcome: exact.chosenOutcome,
          attestedAt: oracle.attestedAt ?? new Date().toISOString(),
        }),
    relayPublished: exact.relayPublished,
    engineEvidence: exact.engineEvidence ?? undefined,
    explanationEventJson: exact.explanationEventJson ?? undefined,
    explanationRelayPublished: exact.explanationRelayPublished,
  };
}

/** A public mirror cannot erase or replace a locally retained oracle choice or event. */
export function mergeCreatorMarket(
  local: StoredCreatorMarket,
  remote: StoredCreatorMarket,
): StoredCreatorMarket {
  const next = local.createdAt <= remote.createdAt ? remote : local;
  if (!local.oracle) return next;
  if (
    local.oracle.chosenOutcome ||
    local.oracle.attestationEventJson ||
    (remote.oracle &&
      (local.oracle.eventId !== remote.oracle.eventId ||
        (local.oracle.announcementEventId &&
          local.oracle.announcementEventId !== remote.oracle.announcementEventId) ||
        JSON.stringify(local.oracle.outcomes) !== JSON.stringify(remote.oracle.outcomes)))
  )
    return { ...next, oracle: local.oracle };
  return { ...next, oracle: { ...remote.oracle, ...local.oracle } };
}

/** Stable equality check used by the NIP-78 sync hook to skip no-op publishes. */
export function creatorMarketsEqual(
  a: readonly StoredCreatorMarket[],
  b: readonly StoredCreatorMarket[],
): boolean {
  if (a.length !== b.length) return false;
  const byId = new Map(a.map((m) => [m.conditionId, m] as const));
  for (const m of b) {
    const other = byId.get(m.conditionId);
    if (!other) return false;
    if (
      other.title !== m.title ||
      other.thumbnailUrl !== m.thumbnailUrl ||
      other.createdAt !== m.createdAt ||
      other.baseAsset !== m.baseAsset ||
      other.divisibility !== m.divisibility ||
      other.creatorFeePercent !== m.creatorFeePercent ||
      !creatorOracleEqual(other.oracle, m.oracle)
    ) {
      return false;
    }
  }
  return true;
}

const STORAGE_KEY = "bitcaster-creator-markets";
const DOCUMENT_LOCK = "bitcaster-creator-markets";

function ownerIn(document: CreatorDocument, conditionId: string): BrowserOracleOwner | null {
  const market = document.markets.find((item) => item.conditionId === conditionId);
  const oracle = document.importedOracles.find((item) => item.binding.conditionId === conditionId);
  if (market && oracle) throw new Error("Duplicate oracle owner.");
  return market ? { kind: "created", market } : oracle ? { kind: "imported", oracle } : null;
}
function publicationIn(owner: BrowserOracleOwner | null): OraclePublicationRecord | null {
  return owner === null
    ? null
    : owner.kind === "created"
      ? creatorOraclePublication(owner.market)
      : owner.oracle.publication;
}
function requireOwner(document: CreatorDocument, conditionId: string): BrowserOracleOwner {
  const owner = ownerIn(document, conditionId);
  if (!owner || (owner.kind === "created" && !owner.market.oracle))
    throw new Error("Creator oracle record is unavailable.");
  return owner;
}
function oracleIn(owner: BrowserOracleOwner) {
  return owner.kind === "created" ? owner.market.oracle! : owner.oracle;
}
export function browserOracleOwnerAuthority(owner: BrowserOracleOwner) {
  switch (owner.kind) {
    case "imported":
      return {
        binding: owner.oracle.binding,
        announcementHex: owner.oracle.announcementHex,
        destinations: owner.oracle.destinations,
      };
    case "created": {
      const oracle = owner.market.oracle;
      if (!oracle?.announcementEventJson || !oracle.announcementHex || !oracle.oraclePubkey)
        throw new OracleBackupError("invalid-record");
      return {
        binding: {
          conditionId: owner.market.conditionId,
          oracleEventId: oracle.eventId,
          oraclePubkey: oracle.oraclePubkey,
          outcomes: oracle.outcomes,
          announcementEventJson: oracle.announcementEventJson,
        },
        announcementHex: oracle.announcementHex,
        destinations: oracle.destinations,
      };
    }
  }
}
function backupDeliveryIn(owner: BrowserOracleOwner): OracleBackupDeliveryState | null {
  const input = oracleIn(owner)?.backupDelivery;
  if (input === undefined) return null;
  const state = snapshotOracleBackupDeliveryState(input);
  const { binding, destinations } = browserOracleOwnerAuthority(owner);
  if (!destinations) throw new Error("Original oracle destinations are unavailable.");
  assertOracleBackupDeliveryOwner(state, {
    binding,
    relayUrls: destinations.relayUrls,
    publication: publicationIn(owner),
  });
  return state;
}
function snapshotImport(input: BrowserOracleImportMetadata): BrowserOracleImportMetadata {
  const binding = snapshotOraclePublicationRecord({
    binding: input.binding,
    chosenOutcome: input.binding.outcomes[0]!,
    attestation: null,
    relayPublished: false,
    engineEvidence: null,
    explanationEventJson: null,
    explanationRelayPublished: false,
  }).binding;
  if (
    announcementContentFromTlv(input.announcementHex) !==
    readSignedOracleEvent(binding.announcementEventJson, 88).content
  )
    throw new Error("Original announcement bytes conflict with saved state.");
  const destinations = input.destinations;
  if (
    !destinations ||
    !Array.isArray(destinations.relayUrls) ||
    typeof destinations.mintUrl !== "string" ||
    typeof destinations.engineUrl !== "string" ||
    !destinations.relayUrls.every((url) => typeof url === "string")
  )
    throw new Error("Original oracle destinations are unavailable.");
  return {
    binding,
    announcementHex: input.announcementHex,
    destinations: {
      mintUrl: destinations.mintUrl,
      engineUrl: destinations.engineUrl,
      relayUrls: [...destinations.relayUrls],
    },
  };
}
function snapshotImportedOracle(
  record: StoredImportedOracleMetadata,
): StoredImportedOracleMetadata {
  const metadata = snapshotImport(record);
  const publication =
    record.publication === null ? null : snapshotOraclePublicationRecord(record.publication);
  if (
    (record.importComplete !== true && record.importComplete !== false) ||
    (publication !== null &&
      JSON.stringify(publication.binding) !== JSON.stringify(metadata.binding)) ||
    (record.explanationDraft !== undefined &&
      (typeof record.explanationDraft !== "string" ||
        new TextEncoder().encode(record.explanationDraft).length >
          ORACLE_EXPLANATION_UTF8_BYTES_MAX))
  )
    throw new Error("Durable imported oracle metadata is invalid.");
  if (
    record.publicationFailures !== undefined &&
    (!Array.isArray(record.publicationFailures) ||
      record.publicationFailures.some(
        (stage) =>
          stage !== "explanation-preparation" &&
          stage !== "relay" &&
          stage !== "engine" &&
          stage !== "explanation-relay",
      ))
  )
    throw new Error("Durable imported oracle failure state is invalid.");
  return {
    ...metadata,
    publication,
    importComplete: record.importComplete,
    ...(record.explanationDraft === undefined ? {} : { explanationDraft: record.explanationDraft }),
    ...(record.publicationFailures === undefined
      ? {}
      : { publicationFailures: [...record.publicationFailures] }),
    ...(record.backupDelivery === undefined
      ? {}
      : {
          backupDelivery: snapshotOracleBackupDeliveryState(record.backupDelivery),
        }),
  };
}
function assertPreparation(
  current: StoredCreatorOracleMetadata,
  incoming: StoredCreatorOracleMetadata,
) {
  if (
    current.eventId !== incoming.eventId ||
    JSON.stringify(current.outcomes) !== JSON.stringify(incoming.outcomes)
  )
    throw new Error("Original oracle preparation conflicts with saved state.");
  for (const field of [
    "announcementHex",
    "oraclePubkey",
    "announcementEventJson",
    "announcementEventId",
    "engineBaseUrl",
    "destinations",
  ] as const)
    if (
      current[field] !== undefined &&
      JSON.stringify(current[field]) !== JSON.stringify(incoming[field])
    )
      throw new Error("Original oracle preparation conflicts with saved state.");
}

/** The cache has no persistence writer. Every durable write owns the complete document lock. */
export function createCreatorMarketsStore(
  getStorage: () => StateStorage = () => window.localStorage,
  getLockManager: () => CreatorDocumentLocks | undefined = () => globalThis.navigator?.locks,
) {
  let storage: StateStorage | undefined;
  try {
    storage = getStorage();
  } catch {
    /* Durable operations refuse unavailable storage. */
  }
  const empty = (): CreatorDocument => ({ markets: [], importedOracles: [] });
  function decode(raw: string | null): CreatorDocument {
    if (raw === null) return empty();
    const saved = JSON.parse(raw).state as Partial<CreatorDocument>;
    if (
      !saved ||
      !Array.isArray(saved.markets) ||
      (saved.importedOracles !== undefined && !Array.isArray(saved.importedOracles))
    )
      throw new Error("Durable creator document is invalid.");
    const document = {
      markets: saved.markets,
      importedOracles: (saved.importedOracles ?? []).map(snapshotImportedOracle),
    };
    const ids = [
      ...document.markets.map((market) => market.conditionId),
      ...document.importedOracles.map((oracle) => oracle.binding.conditionId),
    ];
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate oracle owner.");
    for (const id of ids) backupDeliveryIn(ownerIn(document, id)!);
    return document;
  }
  async function readDocument() {
    if (!storage) throw new Error("Durable creator storage is unavailable.");
    return decode(await storage.getItem(STORAGE_KEY));
  }
  let revision = 0;
  let hydrated = false;
  const store = create<CreatorMarketsState>()((set) => {
    async function write(document: CreatorDocument) {
      if (!storage) throw new Error("Durable creator storage is unavailable.");
      const encoded = JSON.stringify({ state: document, version: 0 });
      await storage.setItem(STORAGE_KEY, encoded);
      const savedBytes = await storage.getItem(STORAGE_KEY);
      if (savedBytes !== encoded) throw new Error("Creator document was not saved.");
      const saved = decode(savedBytes);
      revision++;
      set((cached) => ({
        markets: creatorMarketsEqual(cached.markets, saved.markets)
          ? cached.markets
          : saved.markets,
        importedOracles:
          JSON.stringify(cached.importedOracles) === JSON.stringify(saved.importedOracles)
            ? cached.importedOracles
            : saved.importedOracles,
      }));
    }
    async function lock<T>(action: () => Promise<T>): Promise<T> {
      if (!storage) throw new Error("Durable creator storage is unavailable.");
      const locks = getLockManager();
      if (!locks) throw new Error("Cross-tab creator locking is unavailable.");
      return locks.request(DOCUMENT_LOCK, action);
    }
    async function withOracleMutation<T>(action: (port: BrowserOracleLockedPort) => Promise<T>) {
      return lock(async () => {
        let active = true;
        const document = async () => {
          if (!active) throw new Error("Creator mutation port has expired.");
          return readDocument();
        };
        const port: BrowserOracleLockedPort = {
          readOwner: async (id) => ownerIn(await document(), id),
          read: async (id) => publicationIn(ownerIn(await document(), id)),
          readBackupDelivery: async (id) => backupDeliveryIn(requireOwner(await document(), id)),
          saveBackupPreparation: async (id, input) => {
            const doc = await document();
            const owner = requireOwner(doc, id);
            const previous = backupDeliveryIn(owner);
            const next = snapshotOracleBackupDeliveryState(input);
            const { binding, destinations } = browserOracleOwnerAuthority(owner);
            if (!destinations) throw new Error("Original oracle destinations are unavailable.");
            assertOracleBackupDeliveryOwner(next, {
              binding,
              relayUrls: destinations.relayUrls,
              publication: publicationIn(owner),
            });
            if (
              previous?.current?.mode === "terminal" &&
              JSON.stringify(previous) !== JSON.stringify(next)
            )
              throw new Error("The saved terminal backup cannot change.");
            if (
              previous?.current &&
              next.current?.mode === "initial" &&
              JSON.stringify(previous) !== JSON.stringify(next)
            )
              throw new Error("Retry the exact saved oracle backup.");
            oracleIn(owner).backupDelivery = next;
            await write(doc);
          },
          confirmBackupDelivery: async (id, ack) => {
            const doc = await document();
            const owner = requireOwner(doc, id);
            const current = backupDeliveryIn(owner);
            if (!current) throw new Error("Oracle backup preparation is unavailable.");
            const next = confirmOracleBackupDelivery(current, ack);
            oracleIn(owner).backupDelivery = next;
            await write(doc);
            return backupDeliveryIn(requireOwner(await document(), id))!;
          },
          commitBackupTerminal: async (id, admission) => {
            const doc = await document();
            const owner = requireOwner(doc, id);
            const current = backupDeliveryIn(owner);
            const publication = publicationIn(owner);
            if (!current || !publication) throw new Error("Terminal oracle backup is unavailable.");
            const next = commitOracleBackupDelivery(current, admission, publication);
            oracleIn(owner).backupDelivery = next;
            await write(doc);
            return backupDeliveryIn(requireOwner(await document(), id))!;
          },
          readDraft: async (id) => {
            const owner = ownerIn(await document(), id);
            return owner ? oracleIn(owner)?.explanationDraft : undefined;
          },
          save: async (id, input) => {
            const doc = await document();
            const owner = requireOwner(doc, id);
            const exact = snapshotOraclePublicationRecord(input);
            if (id !== exact.binding.conditionId)
              throw new Error("Saved oracle binding cannot change.");
            if (owner.kind === "created") {
              const oracle = owner.market.oracle!;
              if (
                oracle.eventId !== exact.binding.oracleEventId ||
                JSON.stringify(oracle.outcomes) !== JSON.stringify(exact.binding.outcomes) ||
                oracle.announcementEventJson !== exact.binding.announcementEventJson ||
                (oracle.oraclePubkey && oracle.oraclePubkey !== exact.binding.oraclePubkey) ||
                (oracle.attestedOutcome && oracle.attestedOutcome !== exact.chosenOutcome)
              )
                throw new Error("Saved oracle binding cannot change.");
            } else if (JSON.stringify(owner.oracle.binding) !== JSON.stringify(exact.binding))
              throw new Error("Saved oracle binding cannot change.");
            const merged = mergeOraclePublicationRecords(publicationIn(owner), exact)!;
            if (owner.kind === "created")
              owner.market.oracle = oracleWithPublication(owner.market.oracle!, merged);
            else owner.oracle.publication = merged;
            await write(doc);
            return publicationIn(ownerIn(await document(), id))!;
          },
          saveDraft: async (id, text) => {
            const doc = await document();
            const owner = requireOwner(doc, id);
            const oracle = oracleIn(owner);
            if (
              publicationIn(owner) !== null ||
              (owner.kind === "created" && owner.market.oracle?.attestedOutcome)
            ) {
              if ((oracle.explanationDraft ?? "") !== text)
                throw new Error("The saved oracle explanation draft cannot change.");
            }
            if (new TextEncoder().encode(text).length > ORACLE_EXPLANATION_UTF8_BYTES_MAX)
              throw new Error("Oracle explanation exceeds the shared UTF-8 limit.");
            oracle.explanationDraft = text;
            await write(doc);
          },
          retainImportMetadata: async (input, authenticatedEnvelope) => {
            const exact = snapshotImport(input);
            const doc = await document();
            const owner = ownerIn(doc, exact.binding.conditionId);
            // Admit the raw authenticated source before changing completion or private authority.
            // This port is used only after full decryption and core validation by the import adapter.
            let sourceDelivery: OracleBackupDeliveryState | undefined;
            if (authenticatedEnvelope) {
              const envelope = readOracleBackupEnvelope(
                authenticatedEnvelope.event,
                exact.binding.oraclePubkey,
              );
              if (
                authenticatedEnvelope.record.conditionId !== exact.binding.conditionId ||
                authenticatedEnvelope.record.oracleEventId !== exact.binding.oracleEventId ||
                authenticatedEnvelope.record.authority.announcementEventJson !==
                  exact.binding.announcementEventJson ||
                JSON.stringify(authenticatedEnvelope.record.destinations) !==
                  JSON.stringify(exact.destinations)
              )
                throw new OracleBackupError("invalid-record");
              sourceDelivery = admitOracleBackupSource({
                record: authenticatedEnvelope.record,
                source: {
                  eventId: envelope.id,
                  createdAt: envelope.created_at,
                  sourceRelay: authenticatedEnvelope.sourceRelay,
                },
                previous: owner ? backupDeliveryIn(owner) : null,
              });
              assertOracleBackupDeliveryOwner(sourceDelivery, {
                binding: exact.binding,
                relayUrls: exact.destinations.relayUrls,
                publication: owner ? publicationIn(owner) : null,
              });
            }
            // A previous completion cannot authorize signing after this private import fails.
            if (owner?.kind === "created") {
              const current = owner.market.oracle;
              if (!current) throw new Error("Creator oracle record is unavailable.");
              const incoming: StoredCreatorOracleMetadata = {
                ...current,
                type: "self",
                eventId: exact.binding.oracleEventId,
                outcomes: [...exact.binding.outcomes],
                announcementHex: exact.announcementHex,
                announcementEventJson: exact.binding.announcementEventJson,
                announcementEventId: readSignedOracleEvent(exact.binding.announcementEventJson, 88)
                  .id,
                oraclePubkey: exact.binding.oraclePubkey,
                destinations: exact.destinations,
                engineBaseUrl: exact.destinations.engineUrl,
              };
              // Missing legacy fields can be filled, but retained creation facts are immutable.
              assertPreparation(current, incoming);
              owner.market.oracle = {
                ...incoming,
                importComplete: false,
              };
            } else if (owner) {
              if (JSON.stringify(snapshotImport(owner.oracle)) !== JSON.stringify(exact))
                throw new Error("Original oracle import metadata conflicts with saved state.");
              owner.oracle.importComplete = false;
            } else doc.importedOracles.push({ ...exact, publication: null, importComplete: false });
            if (sourceDelivery)
              oracleIn(requireOwner(doc, exact.binding.conditionId)).backupDelivery =
                sourceDelivery;
            await write(doc);
            return ownerIn(await document(), exact.binding.conditionId)!;
          },
          markImportComplete: async (id) => {
            const doc = await document();
            const owner = requireOwner(doc, id);
            oracleIn(owner).importComplete = true;
            await write(doc);
          },
          retainPreparation: async (id, oracle) => {
            const doc = await document();
            const owner = requireOwner(doc, id);
            if (owner.kind !== "created")
              throw new Error("Imported oracle preparation is immutable.");
            const current = owner.market.oracle!;
            assertPreparation(current, oracle);
            owner.market.oracle = {
              ...oracle,
              ...current,
              announcementEventJson: oracle.announcementEventJson,
              oraclePubkey: oracle.oraclePubkey,
              engineBaseUrl: oracle.engineBaseUrl,
              destinations: oracle.destinations ?? current.destinations,
            };
            await write(doc);
          },
        };
        try {
          return await action(port);
        } finally {
          active = false;
        }
      });
    }
    async function mutate(action: (document: CreatorDocument) => void) {
      return lock(async () => {
        const document = await readDocument();
        action(document);
        await write(document);
      });
    }
    async function saveCreatedMarket(market: StoredCreatorMarket) {
      await mutate((document) => {
        if (
          document.importedOracles.some(
            (oracle) => oracle.binding.conditionId === market.conditionId,
          )
        )
          throw new Error("Condition already has an imported oracle owner.");
        const existing = document.markets.find((item) => item.conditionId === market.conditionId);
        document.markets = [
          existing
            ? mergeCreatorMarket(existing, structuredClone(market))
            : structuredClone(market),
          ...document.markets.filter((item) => item.conditionId !== market.conditionId),
        ];
      });
    }
    async function mergeRemoteMarkets(remote: StoredCreatorMarket[]) {
      return lock(async () => {
        const document = await readDocument();
        const byId = new Map(document.markets.map((market) => [market.conditionId, market]));
        for (const incoming of remote) {
          if (
            document.importedOracles.some(
              (oracle) => oracle.binding.conditionId === incoming.conditionId,
            )
          )
            continue;
          const local = byId.get(incoming.conditionId);
          byId.set(
            incoming.conditionId,
            local ? mergeCreatorMarket(local, incoming) : structuredClone(incoming),
          );
        }
        document.markets = [...byId.values()].sort((a, b) =>
          b.createdAt.localeCompare(a.createdAt),
        );
        await write(document);
        return document.markets;
      });
    }
    return {
      ...empty(),
      withOracleMutation,
      readOracleBackupDelivery: async (id) =>
        backupDeliveryIn(requireOwner(await readDocument(), id)),
      confirmOracleBackupDelivery: (id, ack) =>
        withOracleMutation((port) => port.confirmBackupDelivery(id, ack)),
      commitOracleBackupTerminal: (id, admission) =>
        withOracleMutation((port) => port.commitBackupTerminal(id, admission)),
      hasOraclePersistence: () => storage !== undefined && getLockManager() !== undefined,
      readOracleOwner: async (id) => ownerIn(await readDocument(), id),
      readOracleOwners: async () => {
        const saved = await readDocument();
        return [
          ...saved.markets
            .filter((market) => market.oracle?.type === "self")
            .map((market): BrowserOracleOwner => ({ kind: "created", market })),
          ...saved.importedOracles.map(
            (oracle): BrowserOracleOwner => ({ kind: "imported", oracle }),
          ),
        ];
      },
      readOraclePublication: async (id) => publicationIn(ownerIn(await readDocument(), id)),
      readOracleExplanationDraft: async (id) => {
        const owner = ownerIn(await readDocument(), id);
        return owner ? oracleIn(owner)?.explanationDraft : undefined;
      },
      saveOraclePublication: (id, record) => withOracleMutation((port) => port.save(id, record)),
      retainImportedOracleMetadata: (input) =>
        withOracleMutation((port) => port.retainImportMetadata(input)),
      markOracleImportComplete: (id) => withOracleMutation((port) => port.markImportComplete(id)),
      retainOraclePreparation: (id, oracle) =>
        withOracleMutation((port) => port.retainPreparation(id, oracle)),
      saveOracleExplanationDraft: (id, text) =>
        withOracleMutation((port) => port.saveDraft(id, text)),
      saveOraclePublicationFailures: (id, failures) =>
        mutate((doc) => {
          oracleIn(requireOwner(doc, id)).publicationFailures = [...failures];
        }),
      addCreatedMarket: saveCreatedMarket,
      saveCreatedMarket,
      removeCreatedMarket: (id) =>
        mutate((doc) => {
          doc.markets = doc.markets.filter((market) => market.conditionId !== id);
        }),
      replace: (markets) => mergeRemoteMarkets(markets).then(() => undefined),
      mergeRemoteMarkets,
      clear: () =>
        mutate((doc) => {
          doc.markets = [];
          doc.importedOracles = [];
        }),
    };
  });
  async function rehydrate() {
    const observed = revision;
    try {
      const document = await readDocument();
      if (revision === observed) store.setState(document);
    } finally {
      hydrated = true;
    }
  }
  // Hydration is read-only. setState is a cache operation, including in test fixtures.
  if (storage) {
    try {
      const initial = storage.getItem(STORAGE_KEY);
      if (typeof initial === "string" || initial === null) {
        store.setState(decode(initial));
        hydrated = true;
      } else void rehydrate().catch(() => {});
    } catch {
      hydrated = true;
    }
  } else hydrated = true;
  return Object.assign(store, { persist: { rehydrate, hasHydrated: () => hydrated } });
}

export const useCreatorMarketsStore = createCreatorMarketsStore();

/** Progress mutations read and merge the latest durable publication under the document lock. */
export function creatorOraclePublicationStore(
  store = useCreatorMarketsStore,
): OraclePublicationStore {
  async function update(
    id: string,
    mutate: (record: OraclePublicationRecord) => OraclePublicationRecord,
  ) {
    return store.getState().withOracleMutation(async (port) => {
      const record = await port.read(id);
      if (!record) throw new Error("Saved oracle choice is unavailable.");
      return port.save(id, mutate(record));
    });
  }
  return {
    read: (id) => store.getState().readOraclePublication(id),
    saveChoice: (binding, chosenOutcome) =>
      store.getState().withOracleMutation((port) =>
        port.save(binding.conditionId, {
          binding,
          chosenOutcome,
          attestation: null,
          relayPublished: false,
          engineEvidence: null,
          explanationEventJson: null,
          explanationRelayPublished: false,
        }),
      ),
    saveAttestation: (id, attestation) => update(id, (record) => ({ ...record, attestation })),
    saveExplanation: (id, explanationEventJson) =>
      update(id, (record) => ({ ...record, explanationEventJson })),
    confirmRelay: (id, eventId) =>
      update(id, (record) => {
        if (
          !record.attestation ||
          readSignedOracleEvent(record.attestation.eventJson, 89).id !== eventId
        )
          throw new Error("Relay confirmation is foreign.");
        return { ...record, relayPublished: true };
      }),
    confirmEngine: (id, engineEvidence) => update(id, (record) => ({ ...record, engineEvidence })),
    confirmExplanationRelay: (id, eventId) =>
      update(id, (record) => {
        if (
          !record.explanationEventJson ||
          readSignedOracleEvent(record.explanationEventJson, 1111).id !== eventId
        )
          throw new Error("Explanation confirmation is foreign.");
        return { ...record, explanationRelayPublished: true };
      }),
  };
}
