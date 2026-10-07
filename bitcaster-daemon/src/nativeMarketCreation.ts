import { createHash } from 'node:crypto'
import {
  assertMarketCreationBinding,
  completeDurableMarketCreation,
  createPreparedMarketViaEngine,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  readMarketCreationMintRegistration,
  registerCtfCondition,
  snapshotMarketCreationPreparation,
  snapshotMarketCreationThumbnail,
  type BitcasterEngineClient,
  type MarketCreationRecord,
  type MarketCreationStore,
  type MarketThumbnailBytes,
} from '@bitcaster-market/client-sdk'
import {
  prepareNativeMarketOracle,
  NativeOracleSignerRequiredError,
  type NativeMarketCreationInput,
  type NativeMarketOracleDependencies,
} from './nativeMarketOracle.ts'
import {
  deriveNativeConditionRegistrationFeeTransferId,
  prepareNativeConditionRegistrationFee,
  type NativeConditionRegistrationFeeResult,
} from './nativeConditionRegistrationFee.ts'
import { publishNativeOracleEvent } from './nativeOraclePublication.ts'
import type { DaemonDurableOutgoingCashuCoordinator } from './durableOutgoingCashuCoordinator.ts'
import type { CashuWalletLike } from './walletOps.ts'
import { deriveNostrPublicKey } from './profileSecretProtection.ts'

export interface NativeMarketCreationDependencies {
  readonly oracle: NativeMarketOracleDependencies
  readonly coordinator: DaemonDurableOutgoingCashuCoordinator
  readonly wallet?: CashuWalletLike
  readonly seed: Uint8Array
  readonly engine: BitcasterEngineClient
  readonly creatorPubkey: string
  readonly publish?: typeof publishNativeOracleEvent
  readonly fetch?: typeof globalThis.fetch
}

export async function completeNativeMarketCreation(
  deps: NativeMarketCreationDependencies,
  input: NativeMarketCreationInput,
  options: { maxWalletDebitMsat?: number; thumbnail?: MarketThumbnailBytes } = {},
) {
  const saved = await deps.oracle.store.readCreation(input.creationId)
  const requiredPublicKey =
    saved?.creatorPublicKeyHex ?? deriveNostrPublicKey(deps.oracle.oracleSecretKeyHex)
  if (deps.creatorPubkey !== requiredPublicKey)
    throw new NativeOracleSignerRequiredError(requiredPublicKey)
  const walletId = deriveDurableCustodyWalletId(deps.seed)
  const walletScopeId = deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId })
  const selected = await deps.oracle.store.readWalletBinding()
  if (
    selected.walletId !== walletId ||
    selected.walletScopeId !== walletScopeId ||
    (saved !== null && (saved.walletId !== walletId || saved.walletScopeId !== walletScopeId))
  )
    throw new Error('Resume requires the original wallet.')
  const engineUrl = (deps.engine as unknown as { baseUrl: string }).baseUrl
  if (engineUrl !== input.destination.engineBaseUrl.replace(/\/+$/, ''))
    throw new Error('Resume requires the original engine.')
  const active = {
    creatorId: deps.creatorPubkey,
    walletId,
    walletScopeId,
    mintUrl: input.destination.mintUrl,
    engineBaseUrl: input.destination.engineBaseUrl,
  }
  if (saved?.marketCreation != null) assertMarketCreationBinding(saved.marketCreation, active)
  const thumbnail = snapshotMarketCreationThumbnail(
    options.thumbnail ?? saved?.marketCreation?.thumbnail ?? undefined,
  )
  assertOriginalThumbnail(input, thumbnail)
  const { record, market } = await prepareNativeMarketOracle(deps.oracle, input)
  if (record.announcement === null) throw new Error('Native oracle announcement is missing.')
  const preparation = snapshotMarketCreationPreparation({
    ...active,
    creationId: record.creationId,
    eventId: record.eventId,
    relayUrls: input.destination.relayUrls,
    metadata: { ...market.metadata, oracleAnnouncementHex: record.announcement.announcementTlvHex },
    announcement: record.announcement,
    registration: {
      feeOperationRef:
        input.registration.requiredFeeMsat === 0
          ? null
          : deriveNativeConditionRegistrationFeeTransferId(record.creationId),
      feeAmount: input.registration.requiredFeeMsat,
      feeUnit: market.collateralUnit,
      ...(input.registration.outcomeCollections === undefined
        ? {}
        : {
            outcomeCollections: input.registration.outcomeCollections,
          }),
    },
    thumbnail,
  })
  return completeDurableMarketCreation(
    nativeCreationAdapters(deps, options, market.mintTags),
    preparation,
    active,
  )
}

function nativeCreationAdapters(
  deps: NativeMarketCreationDependencies,
  options: { maxWalletDebitMsat?: number },
  mintTags: string[][],
) {
  let fee: NativeConditionRegistrationFeeResult | null = null
  const prepareFee = async (record: MarketCreationRecord) => {
    fee = await prepareNativeConditionRegistrationFee(deps, {
      creationId: record.creationId,
      mintUrl: record.mintUrl,
      seed: deps.seed,
      requiredFeeMsat: record.registration.feeAmount,
      ...(record.registration.feeAmount === 0 ? {} : { wallet: deps.wallet }),
      maxWalletDebitMsat: options.maxWalletDebitMsat,
    })
    switch (fee.kind) {
      case 'fee-free':
      case 'prepared':
        return 'ready' as const
      case 'pending':
        return 'pending' as const
      case 'already-spent':
        return 'already-spent' as const
    }
  }
  return {
    store: nativeCreationStoreAdapter(deps.oracle.store),
    prepareFee,
    async confirmFee(record: MarketCreationRecord) {
      if (record.registration.feeAmount === 0) return
      const transferId = record.registration.feeOperationRef!
      const existing = await deps.coordinator.loadTransfer(transferId)
      if (existing === null) return
      if (!deps.wallet) throw new Error('Registration fee requires the original wallet.')
      await deps.coordinator.classifyBearerTransfer({ transferId, wallet: deps.wallet })
    },
    async publishAnnouncement(record: MarketCreationRecord) {
      await (deps.publish ?? publishNativeOracleEvent)(
        record.relayUrls,
        record.announcement.announcementNostrEventJson,
      )
    },
    lookupMint: (record: MarketCreationRecord) =>
      readMarketCreationMintRegistration(
        record.mintUrl,
        record.announcement.conditionId,
        deps.fetch,
      ),
    async registerMint(record: MarketCreationRecord) {
      if (fee === null) throw new Error('Registration fee preparation is missing.')
      return registerCtfCondition(
        {
          tags: mintTags,
          announcementHex: record.announcement.announcementTlvHex,
          collateral: record.registration.feeUnit,
          outcomeCollections: record.registration.outcomeCollections,
          ...(fee.kind === 'prepared' ? { fee: fee.feeProofs } : {}),
        },
        { endpoint: `${record.mintUrl.replace(/\/+$/, '')}/v1/conditions`, fetch: deps.fetch },
      )
    },
    lookupEngine: (record: MarketCreationRecord) =>
      deps.engine.getMarketRegistration(record.announcement.conditionId),
    createEngine: (
      record: MarketCreationRecord,
      request: Parameters<typeof createPreparedMarketViaEngine>[2],
    ) => createPreparedMarketViaEngine(deps.engine, record.announcement.conditionId, request),
  }
}

export function nativeCreationStoreAdapter(
  store: NativeMarketOracleDependencies['store'],
): MarketCreationStore {
  return {
    async read(creationId) {
      return (await store.readCreation(creationId))?.marketCreation ?? null
    },
    reserve: (preparation) => store.reserveMarketCreation(preparation),
    confirmMint: (creationId) => store.confirmMarketCreationMint(creationId),
    confirmEngine: (creationId, result) => store.confirmMarketCreationEngine(creationId, result),
  }
}

function assertOriginalThumbnail(
  input: NativeMarketCreationInput,
  thumbnail: ReturnType<typeof snapshotMarketCreationThumbnail>,
): void {
  const hash =
    thumbnail === null ? undefined : createHash('sha256').update(thumbnail.data).digest('hex')
  if (
    hash !== input.destination.thumbnailSha256 ||
    thumbnail?.filename !== input.destination.thumbnailFilename ||
    thumbnail?.contentType !==
      (input.destination.thumbnailSha256 === undefined
        ? undefined
        : (input.destination.thumbnailContentType ?? 'application/octet-stream'))
  )
    throw new Error('Resume requires the original thumbnail bytes.')
}
