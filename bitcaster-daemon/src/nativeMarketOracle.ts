import {
  assertMarketCreationMetadataSize,
  deriveDlcConditionId,
  normalizeMarketCreationInput,
  normalizeOracleAnnouncementTags,
  type MarketCreationInput,
} from '@bitcaster-market/client-sdk'
import type { NativeOracleHelper } from './nativeOracleHelper.ts'
import type { NativeOracleCreationStore } from './nativeOracleCreationStore.ts'
import { deriveNostrPublicKey } from './profileSecretProtection.ts'

export class NativeOracleSignerRequiredError extends Error {
  readonly requiredPublicKeyHex: string
  constructor(requiredPublicKeyHex: string) {
    super(`Native oracle creation requires signer ${requiredPublicKeyHex}.`)
    this.requiredPublicKeyHex = requiredPublicKeyHex
  }
}

export interface NativeMarketOracleDependencies {
  readonly store: NativeOracleCreationStore
  readonly helper: NativeOracleHelper
  readonly oracleSecretKeyHex: string
  readonly nonceSeedHex: string
}

export interface NativeMarketCreationInput {
  readonly creationId: string
  readonly eventId: string
  readonly market: MarketCreationInput
  readonly registration: {
    readonly requiredFeeMsat: number
    readonly outcomeCollections?: readonly string[]
  }
  readonly destination: {
    readonly engineBaseUrl: string
    readonly mintUrl: string
    readonly relayUrls: readonly string[]
    readonly thumbnailSha256?: string
    readonly thumbnailFilename?: string
    readonly thumbnailContentType?: string
  }
}

export async function prepareNativeMarketOracle(
  deps: NativeMarketOracleDependencies,
  input: NativeMarketCreationInput,
) {
  const saved = await deps.store.readCreation(input.creationId)
  if (saved !== null) assertNativeOracleCreator(saved.creatorPublicKeyHex, deps.oracleSecretKeyHex)
  const market = normalizeMarketCreationInput(input.market)
  assertMarketCreationMetadataSize(market.metadata)
  if (saved?.announcement == null) {
    deps.helper.assertAvailable()
  }
  const canonicalInput = JSON.stringify({
    market: {
      title: market.metadata.title,
      description: market.metadata.description,
      outcomeType: market.metadata.outcomeType,
      outcomeDetails: market.metadata.outcomes,
      maturityEpoch: market.maturityEpoch,
      categoryTags: market.metadata.categoryTags,
      baseAsset: market.metadata.baseAsset,
    },
    registration: {
      requiredFeeMsat: input.registration.requiredFeeMsat,
      ...(input.registration.outcomeCollections === undefined
        ? {}
        : { outcomeCollections: [...input.registration.outcomeCollections] }),
    },
    destination: {
      engineBaseUrl: input.destination.engineBaseUrl,
      mintUrl: input.destination.mintUrl,
      relayUrls: [...input.destination.relayUrls],
      ...(input.destination.thumbnailSha256 === undefined
        ? {}
        : {
            thumbnailSha256: input.destination.thumbnailSha256,
            thumbnailFilename: input.destination.thumbnailFilename,
            thumbnailContentType: input.destination.thumbnailContentType,
          }),
    },
  })
  let record = await deps.store.reserveCreation(
    {
      creationId: input.creationId,
      eventId: input.eventId,
      canonicalInput,
    },
    deriveNostrPublicKey(deps.oracleSecretKeyHex),
  )
  if (record.announcement === null) {
    const tags = normalizeOracleAnnouncementTags(market.metadata.title, market.metadata.description)
    const artifact = await deps.helper.createEnum({
      oracleSecretKeyHex: deps.oracleSecretKeyHex,
      nonceSeedHex: deps.nonceSeedHex,
      reservedNonceIndex: record.nonceIndex,
      eventId: record.eventId,
      outcomes: market.outcomeLabels,
      eventMaturityEpoch: market.maturityEpoch,
      ...tags,
    })
    assertMarketCreationMetadataSize({
      ...market.metadata,
      oracleAnnouncementHex: artifact.announcementTlvHex,
    })
    record = await deps.store.persistAnnouncement(record.creationId, {
      conditionId: deriveDlcConditionId({
        eventId: record.eventId,
        outcomeCount: market.outcomeLabels.length,
        oraclePublicKeys: [artifact.oraclePublicKeyHex],
      }),
      announcementTlvHex: artifact.announcementTlvHex,
      announcementNostrEventJson: artifact.announcementNostrEventJson,
    })
  }
  return { record, market }
}

export async function signNativeMarketOutcome(
  deps: NativeMarketOracleDependencies,
  conditionId: string,
  outcome: string,
) {
  const current = await deps.store.readByConditionId(conditionId)
  if (current?.announcement == null) throw new Error('Native oracle announcement is missing.')
  assertNativeOracleCreator(current.creatorPublicKeyHex, deps.oracleSecretKeyHex)
  const stored = JSON.parse(current.canonicalInput) as { market: MarketCreationInput }
  const market = normalizeMarketCreationInput(stored.market)
  if (!market.outcomeLabels.includes(outcome)) throw new Error('Outcome is not in this market.')
  if (current.chosenOutcome !== null && current.chosenOutcome !== outcome) {
    throw new Error('This oracle already committed to a different outcome.')
  }
  if (current.attestation !== null) return current
  deps.helper.assertAvailable()
  const chosen = await deps.store.chooseOutcome(conditionId, outcome)
  const artifact = await deps.helper.signEnum({
    oracleSecretKeyHex: deps.oracleSecretKeyHex,
    nonceSeedHex: deps.nonceSeedHex,
    reservedNonceIndex: chosen.nonceIndex,
    eventId: chosen.eventId,
    chosenOutcome: outcome,
    announcementTlvHex: current.announcement.announcementTlvHex,
    announcementNostrEventJson: current.announcement.announcementNostrEventJson,
  })
  return deps.store.persistAttestation(chosen.creationId, outcome, {
    attestationHex: artifact.attestationHex,
    attestationNostrEventJson: artifact.attestationNostrEventJson,
  })
}

export function assertNativeOracleCreator(
  requiredPublicKeyHex: string,
  secretKeyHex: string,
): void {
  if (deriveNostrPublicKey(secretKeyHex) !== requiredPublicKeyHex)
    throw new NativeOracleSignerRequiredError(requiredPublicKeyHex)
}
