import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { ProductMarketDivisibility } from "@/types/market";
import {
  snapshotOraclePublicationRecord,
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
  /**
   * TLV-hex of the kormir DLC oracle_announcement (the kind-88 payload).
   *
   * Recovery durability (P22 B1b): kormir's IndexedDB holds the per-event
   * nonce index needed to re-sign the committed-nonce attestation, but
   * `Kormir.restore(nsec)` wipes that store, so a fresh browser profile cannot
   * resolve a previously-created self-oracle market. The announcement carries
   * the committed nonce point(s) `R`; combined with the (restored) oracle nsec
   * it is sufficient material to re-derive the nonce index (deterministic
   * BIP32 scan) and re-sign. Persisted here — and mirrored through the
   * NIP-78 creator-markets event — so the data survives a device swap.
   *
   * Public protocol artifact (already broadcast as the kind-88 event), so it
   * is NOT Secret-class. The oracle nsec it pairs with is managed by the
   * settings/login path and is never stored here.
   */
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

interface CreatorMarketsState {
  markets: StoredCreatorMarket[];
  /** Insert a market created via the wizard. Deduplicates on `conditionId`. */
  addCreatedMarket: (market: StoredCreatorMarket) => void;
  saveCreatedMarket: (market: StoredCreatorMarket) => Promise<void>;
  /** Remove a market from the local record (e.g. after a user hides it). */
  removeCreatedMarket: (conditionId: string) => void;
  /** Replace the entire set wholesale — used by `useCreatorSync` after a NIP-78 fetch. */
  replace: (markets: StoredCreatorMarket[]) => void;
  /** Clear all entries. Exposed primarily for tests and logout flows. */
  clear: () => void;
  hasOraclePersistence: () => boolean;
  readOraclePublication: (conditionId: string) => Promise<OraclePublicationRecord | null>;
  readOracleExplanationDraft: (conditionId: string) => Promise<string | undefined>;
  saveOraclePublication: (
    conditionId: string,
    publication: OraclePublicationRecord,
  ) => Promise<OraclePublicationRecord>;
  retainOraclePreparation: (
    conditionId: string,
    oracle: StoredCreatorOracleMetadata,
  ) => Promise<void>;
  saveOracleExplanationDraft: (conditionId: string, text: string) => Promise<void>;
  saveOraclePublicationFailures: (
    conditionId: string,
    failures: readonly OraclePublicationFailureStage[],
  ) => void;
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

function assertPublicationReplacement(
  market: StoredCreatorMarket,
  exact: OraclePublicationRecord,
): void {
  const oracle = market.oracle;
  if (
    !oracle ||
    market.conditionId !== exact.binding.conditionId ||
    oracle.eventId !== exact.binding.oracleEventId ||
    JSON.stringify(oracle.outcomes) !== JSON.stringify(exact.binding.outcomes) ||
    oracle.announcementEventJson !== exact.binding.announcementEventJson ||
    (oracle.oraclePubkey && oracle.oraclePubkey !== exact.binding.oraclePubkey)
  )
    throw new Error("Saved oracle binding cannot change.");
  if (oracle.attestedOutcome && oracle.attestedOutcome !== exact.chosenOutcome)
    throw new Error("An already-signed oracle outcome cannot change.");
  const previous = creatorOraclePublication(market);
  if (
    previous !== null &&
    (JSON.stringify(previous.binding) !== JSON.stringify(exact.binding) ||
      previous.chosenOutcome !== exact.chosenOutcome ||
      (previous.attestation !== null &&
        JSON.stringify(previous.attestation) !== JSON.stringify(exact.attestation)) ||
      (previous.explanationEventJson !== null &&
        previous.explanationEventJson !== exact.explanationEventJson) ||
      (previous.relayPublished && !exact.relayPublished) ||
      (previous.engineEvidence !== null &&
        JSON.stringify(previous.engineEvidence) !== JSON.stringify(exact.engineEvidence)) ||
      (previous.explanationRelayPublished && !exact.explanationRelayPublished))
  )
    throw new Error("Immutable oracle publication conflicts with saved state.");
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

/**
 * Local store of markets the user has created. Persists to localStorage under
 * `bitcaster-creator-markets`. When an nsec-backed Nostr identity is
 * available, `useCreatorSync` mirrors the set to a NIP-78 replaceable event
 * so it survives a device swap.
 *
 * The shared coordinator validates signed public events. This store adds no
 * signer or Cashu wallet authority.
 */
export function createCreatorMarketsStore(
  getStorage: () => StateStorage = () => window.localStorage,
) {
  const storage = createJSONStorage<CreatorMarketsState>(getStorage);
  async function durableMarket(conditionId: string) {
    if (storage === undefined) throw new Error("Durable creator storage is unavailable.");
    const saved = await storage.getItem("bitcaster-creator-markets");
    return saved?.state.markets.find((market) => market.conditionId === conditionId) ?? null;
  }
  return create<CreatorMarketsState>()(
    persist(
      (set, get) => ({
        markets: [],
        hasOraclePersistence: () => storage !== undefined,
        saveCreatedMarket: async (market) => {
          if (storage === undefined) throw new Error("Durable creator storage is unavailable.");
          get().addCreatedMarket(market);
          const saved = await durableMarket(market.conditionId);
          if (
            saved === null ||
            saved.oracle?.announcementEventJson !== market.oracle?.announcementEventJson ||
            saved.title !== market.title ||
            saved.thumbnailUrl !== market.thumbnailUrl
          )
            throw new Error("Created market oracle recovery was not saved.");
        },
        readOraclePublication: async (conditionId) => {
          const market = await durableMarket(conditionId);
          return market === null ? null : creatorOraclePublication(market);
        },
        readOracleExplanationDraft: async (conditionId) =>
          (await durableMarket(conditionId))?.oracle?.explanationDraft,
        saveOraclePublication: async (conditionId, publication) => {
          const exact = snapshotOraclePublicationRecord(publication);
          if (storage === undefined) throw new Error("Durable creator storage is unavailable.");
          const market = get().markets.find((market) => market.conditionId === conditionId);
          if (!market?.oracle) throw new Error("Creator oracle record is unavailable.");
          assertPublicationReplacement(market, exact);
          const next = oracleWithPublication(market.oracle, exact);
          set({
            markets: get().markets.map((item) =>
              item.conditionId === conditionId ? { ...item, oracle: next } : item,
            ),
          });
          const saved = await durableMarket(conditionId);
          const retained = saved === null ? null : creatorOraclePublication(saved);
          if (retained === null || JSON.stringify(retained) !== JSON.stringify(exact))
            throw new Error("Exact oracle publication was not saved.");
          return retained;
        },
        retainOraclePreparation: async (conditionId, oracle) => {
          if (storage === undefined) throw new Error("Durable creator storage is unavailable.");
          const current = get().markets.find((item) => item.conditionId === conditionId)?.oracle;
          if (
            !current ||
            current.eventId !== oracle.eventId ||
            JSON.stringify(current.outcomes) !== JSON.stringify(oracle.outcomes) ||
            (current.announcementHex && current.announcementHex !== oracle.announcementHex) ||
            (current.oraclePubkey && current.oraclePubkey !== oracle.oraclePubkey) ||
            (current.announcementEventJson &&
              current.announcementEventJson !== oracle.announcementEventJson) ||
            (current.announcementEventId &&
              current.announcementEventId !== oracle.announcementEventId) ||
            (current.engineBaseUrl && current.engineBaseUrl !== oracle.engineBaseUrl)
          )
            throw new Error("Original oracle preparation conflicts with saved state.");
          set({
            markets: get().markets.map((item) =>
              item.conditionId === conditionId
                ? {
                    ...item,
                    oracle: {
                      ...oracle,
                      ...current,
                      announcementEventJson: oracle.announcementEventJson,
                      oraclePubkey: oracle.oraclePubkey,
                      engineBaseUrl: oracle.engineBaseUrl,
                    },
                  }
                : item,
            ),
          });
          const saved = await durableMarket(conditionId);
          if (saved?.oracle?.announcementEventJson !== oracle.announcementEventJson)
            throw new Error("Original oracle announcement was not saved.");
        },
        saveOracleExplanationDraft: async (conditionId, text) => {
          if (storage === undefined) throw new Error("Durable creator storage is unavailable.");
          const previous = get().markets.find((item) => item.conditionId === conditionId)?.oracle;
          if (
            (previous?.chosenOutcome || previous?.attestedOutcome) &&
            (previous.explanationDraft ?? "") !== text
          )
            throw new Error("The saved oracle explanation draft cannot change.");
          if (new TextEncoder().encode(text).length > ORACLE_EXPLANATION_UTF8_BYTES_MAX)
            throw new Error("Oracle explanation exceeds the shared UTF-8 limit.");
          set({
            markets: get().markets.map((item) =>
              item.conditionId === conditionId && item.oracle
                ? {
                    ...item,
                    oracle: { ...item.oracle, explanationDraft: text },
                  }
                : item,
            ),
          });
          if ((await durableMarket(conditionId))?.oracle?.explanationDraft !== text)
            throw new Error("Explanation draft was not saved.");
        },
        saveOraclePublicationFailures: (conditionId, failures) => {
          set({
            markets: get().markets.map((item) =>
              item.conditionId === conditionId && item.oracle
                ? {
                    ...item,
                    oracle: {
                      ...item.oracle,
                      publicationFailures: [...failures],
                    },
                  }
                : item,
            ),
          });
        },
        addCreatedMarket: (market) => {
          set((state) => {
            const without = state.markets.filter((m) => m.conditionId !== market.conditionId);
            // Newest first so the dashboard's most-recent rows match the user's
            // expectation immediately after the wizard completes.
            const existing = state.markets.find((item) => item.conditionId === market.conditionId);
            return {
              markets: [existing ? mergeCreatorMarket(existing, market) : market, ...without],
            };
          });
        },
        removeCreatedMarket: (conditionId) => {
          set((state) => ({
            markets: state.markets.filter((m) => m.conditionId !== conditionId),
          }));
        },
        replace: (markets) => {
          if (creatorMarketsEqual(get().markets, markets)) return;
          set({ markets: [...markets] });
        },
        clear: () => set({ markets: [] }),
      }),
      { name: "bitcaster-creator-markets", storage },
    ),
  );
}

export const useCreatorMarketsStore = createCreatorMarketsStore();

/** Adapt the existing creator row. The coordinator never owns another browser journal. */
export function creatorOraclePublicationStore(
  store = useCreatorMarketsStore,
): OraclePublicationStore {
  async function update(
    conditionId: string,
    mutate: (record: OraclePublicationRecord) => OraclePublicationRecord,
  ) {
    const record = await store.getState().readOraclePublication(conditionId);
    if (record === null) throw new Error("Saved oracle choice is unavailable.");
    return store.getState().saveOraclePublication(conditionId, mutate(record));
  }
  return {
    read: (conditionId) => store.getState().readOraclePublication(conditionId),
    async saveChoice(binding, outcome) {
      const retained = await store.getState().readOraclePublication(binding.conditionId);
      if (retained !== null) {
        if (
          JSON.stringify(retained.binding) !== JSON.stringify(binding) ||
          retained.chosenOutcome !== outcome
        )
          throw new Error("Saved oracle choice conflicts with this request.");
        return retained;
      }
      return store.getState().saveOraclePublication(binding.conditionId, {
        binding,
        chosenOutcome: outcome,
        attestation: null,
        relayPublished: false,
        engineEvidence: null,
        explanationEventJson: null,
        explanationRelayPublished: false,
      });
    },
    saveAttestation: (conditionId, attestation) =>
      update(conditionId, (record) => ({ ...record, attestation })),
    saveExplanation: (conditionId, explanationEventJson) =>
      update(conditionId, (record) => ({ ...record, explanationEventJson })),
    confirmRelay: (conditionId, eventId) =>
      update(conditionId, (record) => {
        if (
          !record.attestation ||
          readSignedOracleEvent(record.attestation.eventJson, 89).id !== eventId
        )
          throw new Error("Relay confirmation is foreign.");
        return { ...record, relayPublished: true };
      }),
    confirmEngine: (conditionId, engineEvidence) =>
      update(conditionId, (record) => ({ ...record, engineEvidence })),
    confirmExplanationRelay: (conditionId, eventId) =>
      update(conditionId, (record) => {
        if (
          !record.explanationEventJson ||
          readSignedOracleEvent(record.explanationEventJson, 1111).id !== eventId
        )
          throw new Error("Explanation confirmation is foreign.");
        return { ...record, explanationRelayPublished: true };
      }),
  };
}
