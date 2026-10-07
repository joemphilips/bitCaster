import { NDKEvent, type NostrEvent } from "@nostr-dev-kit/ndk";
import {
  assertMarketCreationBinding,
  completeDurableMarketCreation,
  deriveDlcConditionId,
  deriveDurableCustodyWalletId,
  prepareMarketCreationRequest,
  readMarketCreationMintRegistration,
  snapshotMarketCreationPreparation,
  snapshotMarketCreationThumbnail,
  type MarketCreationBinding,
  type MarketCreationRecord,
  type MarketCreationPreparation,
  type MarketCreationInput,
  type MarketThumbnailBytes,
  normalizeMarketCreationInput,
  MAX_MARKET_CREATION_THUMBNAIL_BYTES,
} from "@bitcaster/client-sdk";
import { captureBrowserMintPersistenceContext } from "./cashu";
import { resolveNsecIdentity } from "./identityOps";
import { useSettingsStore } from "@/stores/settings";
import { BrowserMarketCreationStore } from "@/stores/market-creation-db";
import { withBrowserOracleMutation, prepareEnumAnnouncement } from "./kormir";
import {
  preflightBrowserOracleCreation,
  preflightLockedBrowserOracleCreation,
} from "./browserOracleBackup";
import { buildEventId } from "./slug";
import { withTemporaryRelayNdk } from "./nostr";
import { createPreparedMarket, fetchMarketRegistrationForRecovery } from "./markets";
import {
  confirmConditionRegistrationFee,
  deliverPreparedConditionRegistrationFee,
  deriveConditionRegistrationFeeOperationRef,
  prepareConditionRegistrationFee,
  type PreparedConditionRegistrationFee,
  type ConditionRegistrationRequest,
} from "./marketRegistrationFee";

export interface BrowserMarketCreationPointer {
  readonly creationId: string;
  readonly binding: MarketCreationBinding;
  readonly failure?: {
    readonly code: "incomplete" | "payment-pending";
    readonly progress: "prepared" | "mint-confirmed" | "engine-confirmed";
    readonly dismissed: boolean;
  };
}

export async function browserMarketThumbnail(
  file: File | null,
): Promise<MarketThumbnailBytes | undefined> {
  if (file === null) return undefined;
  if (file.size === 0 || file.size > MAX_MARKET_CREATION_THUMBNAIL_BYTES)
    throw new Error("Market thumbnail must contain at most 5 MiB.");
  return {
    data: new Uint8Array(await file.arrayBuffer()),
    filename: file.name,
    contentType: file.type,
  };
}

export function currentBrowserMarketCreationBinding(): MarketCreationBinding {
  const settings = useSettingsStore.getState();
  const identity =
    settings.nostrSignerMode === "nsec" ? resolveNsecIdentity(settings.nsecSecret) : null;
  if (identity === null) throw new Error("You must register a nostr key to become an oracle");
  const context = captureBrowserMintPersistenceContext();
  context.requireCapturedProfile();
  return {
    creatorId: identity.publicKey,
    walletId: deriveDurableCustodyWalletId(context.seed),
    walletScopeId: context.scopeId,
    mintUrl: context.activeMintUrl,
    engineBaseUrl: window.location.origin,
  };
}

export function browserMarketCreationSession(pointer?: BrowserMarketCreationPointer) {
  const binding = currentBrowserMarketCreationBinding();
  if (pointer !== undefined) assertMarketCreationBinding(pointer.binding, binding);
  const context = captureBrowserMintPersistenceContext();
  const requireBinding = () => {
    context.requireCapturedProfile();
    assertMarketCreationBinding(binding, currentBrowserMarketCreationBinding());
  };
  const store = new BrowserMarketCreationStore(context.database, binding, () => {
    requireBinding();
    return binding;
  });
  return { binding, store, requireBinding };
}

export async function prepareBrowserMarketCreation(
  session: ReturnType<typeof browserMarketCreationSession>,
  input: {
    creationId: string;
    market: MarketCreationInput;
    relayUrls: string[];
    feeAmount: number;
    outcomeCollections?: readonly string[];
    thumbnail?: MarketThumbnailBytes;
  },
): Promise<MarketCreationRecord> {
  const normalized = normalizeMarketCreationInput(input.market);
  const thumbnail = snapshotMarketCreationThumbnail(input.thumbnail);
  // The final announcement is validated again before retention and payment.
  await prepareMarketCreationRequest(normalized.metadata, thumbnail ?? undefined);
  if (input.relayUrls.length === 0)
    throw new Error(
      "Add at least one Nostr relay in Settings before publishing an oracle announcement.",
    );
  session.requireBinding();
  const eventId = buildEventId(normalized.metadata.title || "market");
  const preparation = await withBrowserOracleMutation(session.binding.creatorId, async (core) => {
    const artifact = await prepareEnumAnnouncement(
      core,
      eventId,
      normalized.outcomeLabels,
      normalized.maturityEpoch,
      normalized.metadata.title,
      normalized.metadata.description,
    );
    const signed = JSON.parse(artifact.eventJson) as { pubkey: string };
    if (signed.pubkey !== session.binding.creatorId)
      throw new Error("Creation announcement belongs to a different creator.");
    const request: ConditionRegistrationRequest = {
      tags: normalized.mintTags,
      announcementHex: artifact.artifactHex,
      collateral: normalized.collateralUnit,
      outcomeCollections: input.outcomeCollections,
    };
    const preparation = snapshotMarketCreationPreparation({
      ...session.binding,
      creationId: input.creationId,
      eventId,
      relayUrls: input.relayUrls,
      metadata: {
        ...normalized.metadata,
        oracleAnnouncementHex: artifact.artifactHex,
      },
      announcement: {
        conditionId: deriveDlcConditionId({
          eventId,
          outcomeCount: normalized.outcomeLabels.length,
          oraclePublicKeys: [signed.pubkey],
        }),
        announcementTlvHex: artifact.artifactHex,
        announcementNostrEventJson: artifact.eventJson,
      },
      registration: {
        feeAmount: input.feeAmount,
        feeUnit: normalized.collateralUnit,
        feeOperationRef:
          input.feeAmount === 0
            ? null
            : await deriveConditionRegistrationFeeOperationRef(request, input.feeAmount),
        ...(input.outcomeCollections === undefined
          ? {}
          : { outcomeCollections: input.outcomeCollections }),
      },
      thumbnail,
    });
    await prepareMarketCreationRequest(preparation.metadata, preparation.thumbnail ?? undefined);
    await preflightLockedBrowserOracleCreation(preparation, core);
    return preparation;
  });
  session.requireBinding();
  return session.store.reserve(preparation);
}

export async function completeBrowserMarketCreation(
  session: ReturnType<typeof browserMarketCreationSession>,
  preparation: MarketCreationPreparation,
) {
  session.requireBinding();
  const retained = await session.store.read(preparation.creationId);
  if (!retained?.mintConfirmed) {
    await preflightBrowserOracleCreation(preparation);
    session.requireBinding();
  }
  let fee: PreparedConditionRegistrationFee | null = null;
  const feeInput = (record: MarketCreationRecord) => ({
    mintUrl: record.mintUrl,
    requiredFeeSubunits: record.registration.feeAmount,
    operationRef: record.registration.feeOperationRef,
    request: registrationRequest(record),
  });
  return completeDurableMarketCreation(
    {
      store: session.store,
      async prepareFee(record) {
        session.requireBinding();
        fee = await prepareConditionRegistrationFee(feeInput(record));
        session.requireBinding();
        switch (fee.kind) {
          case "fee-free":
          case "prepared":
            return "ready";
          case "already-spent":
            return "already-spent";
        }
      },
      async confirmFee(record) {
        session.requireBinding();
        await confirmConditionRegistrationFee(feeInput(record));
        session.requireBinding();
      },
      async publishAnnouncement(record) {
        session.requireBinding();
        const published = await withTemporaryRelayNdk(
          { relays: record.relayUrls },
          undefined,
          async (ndk) => {
            session.requireBinding();
            const event = new NDKEvent(
              ndk,
              JSON.parse(record.announcement.announcementNostrEventJson) as NostrEvent,
            );
            const accepted = await event.publish();
            if (accepted.size === 0)
              throw new Error("Oracle announcement publication is unavailable.");
            return true;
          },
        );
        session.requireBinding();
        if (published !== true) throw new Error("Oracle announcement publication is unavailable.");
      },
      async lookupMint(record) {
        session.requireBinding();
        const observed = await readMarketCreationMintRegistration(
          record.mintUrl,
          record.announcement.conditionId,
        );
        session.requireBinding();
        return observed;
      },
      async registerMint(record) {
        session.requireBinding();
        if (fee === null) throw new Error("Registration fee preparation is missing.");
        const result = await deliverPreparedConditionRegistrationFee(fee, feeInput(record));
        session.requireBinding();
        return result;
      },
      async lookupEngine(record) {
        session.requireBinding();
        const result = await fetchMarketRegistrationForRecovery(record.announcement.conditionId);
        session.requireBinding();
        return result;
      },
      async createEngine(record, request) {
        session.requireBinding();
        return createPreparedMarket(
          record.announcement.conditionId,
          request,
          session.requireBinding,
        );
      },
    },
    preparation,
    session.binding,
  );
}

function registrationRequest(record: MarketCreationPreparation): ConditionRegistrationRequest {
  return {
    tags: [
      ["title", record.metadata.title],
      ["description", record.metadata.description],
      ...(record.metadata.categoryTags ?? []).map((tag) => ["t", tag]),
    ],
    announcementHex: record.announcement.announcementTlvHex,
    collateral: record.registration.feeUnit,
    outcomeCollections: record.registration.outcomeCollections,
  };
}
