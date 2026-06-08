import { create } from "zustand";
import { persist } from "zustand/middleware";

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
  /** ISO-8601 timestamp recorded after kormir publishes the kind-89 attestation. */
  attestedAt?: string;
}

interface CreatorMarketsState {
  markets: StoredCreatorMarket[];
  /** Insert a market created via the wizard. Deduplicates on `conditionId`. */
  addCreatedMarket: (market: StoredCreatorMarket) => void;
  /** Mark a creator-owned oracle market as attested after publishing kind-89. */
  markOracleAttested: (
    conditionId: string,
    attestation: {
      outcome: string;
      attestationHex: string;
      attestedAt: string;
    },
  ) => void;
  /** Remove a market from the local record (e.g. after a user hides it). */
  removeCreatedMarket: (conditionId: string) => void;
  /** Replace the entire set wholesale — used by `useCreatorSync` after a NIP-78 fetch. */
  replace: (markets: StoredCreatorMarket[]) => void;
  /** Clear all entries. Exposed primarily for tests and logout flows. */
  clear: () => void;
}

function creatorOracleEqual(
  a: StoredCreatorOracleMetadata | undefined,
  b: StoredCreatorOracleMetadata | undefined,
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.type === b.type &&
    a.eventId === b.eventId &&
    a.announcementHex === b.announcementHex &&
    a.announcementEventId === b.announcementEventId &&
    a.attestationHex === b.attestationHex &&
    a.attestedOutcome === b.attestedOutcome &&
    a.attestedAt === b.attestedAt &&
    a.outcomes.length === b.outcomes.length &&
    a.outcomes.every((outcome, i) => outcome === b.outcomes[i])
  );
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
 * This module intentionally has no Nostr or Cashu imports so it is cheap to
 * pull into component tests.
 */
export const useCreatorMarketsStore = create<CreatorMarketsState>()(
  persist(
    (set, get) => ({
      markets: [],
      addCreatedMarket: (market) => {
        set((state) => {
          const without = state.markets.filter(
            (m) => m.conditionId !== market.conditionId,
          );
          // Newest first so the dashboard's most-recent rows match the user's
          // expectation immediately after the wizard completes.
          return { markets: [market, ...without] };
        });
      },
      markOracleAttested: (conditionId, attestation) => {
        set((state) => ({
          markets: state.markets.map((market) => {
            if (market.conditionId !== conditionId || !market.oracle)
              return market;
            return {
              ...market,
              oracle: {
                ...market.oracle,
                attestationHex: attestation.attestationHex,
                attestedOutcome: attestation.outcome,
                attestedAt: attestation.attestedAt,
              },
            };
          }),
        }));
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
    { name: "bitcaster-creator-markets" },
  ),
);
