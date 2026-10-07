import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { verifyEvent } from 'nostr-tools/pure'
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyScopeId,
} from './durableCustody.ts'
import { MAX_CONDITION_REGISTRATION_FEE_SUBUNITS } from './ctfRegistration.ts'
import { assertMarketCreationMetadataSize } from './marketCreationInput.ts'
import { snapshotMarketCreationThumbnail } from './marketCreationRequest.ts'
import type { CreateMarketRequest, CreateMarketResponse } from './marketLifecycle.ts'
import type { CtfCollateralUnit } from './marketUnits.ts'

export interface MarketCreationBinding {
  readonly creatorId: string
  readonly walletId: string
  readonly walletScopeId: string
  readonly mintUrl: string
  readonly engineBaseUrl: string
}

export interface MarketCreationPreparation extends MarketCreationBinding {
  readonly creationId: string
  readonly eventId: string
  readonly relayUrls: readonly string[]
  readonly metadata: CreateMarketRequest
  readonly announcement: {
    readonly conditionId: string
    readonly announcementTlvHex: string
    readonly announcementNostrEventJson: string
  }
  readonly registration: {
    readonly feeOperationRef: string | null
    readonly feeAmount: number
    readonly feeUnit: CtfCollateralUnit
    readonly outcomeCollections?: readonly string[]
  }
  readonly thumbnail: {
    readonly data: Uint8Array
    readonly filename: string
    readonly contentType: string
  } | null
}

export interface MarketCreationRecord extends MarketCreationPreparation {
  readonly mintConfirmed: boolean
  readonly engineResult: CreateMarketResponse | null
}

export interface MarketCreationStore {
  read(creationId: string): Promise<MarketCreationRecord | null>
  reserve(preparation: MarketCreationPreparation): Promise<MarketCreationRecord>
  confirmMint(creationId: string): Promise<MarketCreationRecord>
  confirmEngine(creationId: string, result: CreateMarketResponse): Promise<MarketCreationRecord>
}

/** Detach caller-owned buffers before durable preparation or any external effect. */
export function snapshotMarketCreationPreparation(
  input: MarketCreationPreparation,
): MarketCreationPreparation {
  exactText(input.creationId, 128)
  exactText(input.eventId, 512)
  exactText(input.creatorId, 128)
  if (!/^[0-9a-f]{64}$/.test(input.walletId)) throw new Error('Creation wallet is invalid.')
  if (
    input.walletScopeId !==
    deriveDurableCustodyScopeId({ scopeKind: 'wallet', walletId: input.walletId })
  )
    throw new Error('Creation wallet scope is invalid.')
  exactText(input.mintUrl, 2048)
  exactText(input.engineBaseUrl, 2048)
  if (!Array.isArray(input.relayUrls) || input.relayUrls.length > 64)
    throw new Error('Creation relays are invalid.')
  input.relayUrls.forEach((url) => exactText(url, 2048))
  assertMarketCreationMetadataSize(input.metadata)
  const { feeAmount, feeUnit, feeOperationRef } = input.registration
  if (
    !Number.isSafeInteger(feeAmount) ||
    feeAmount < 0 ||
    feeAmount > MAX_CONDITION_REGISTRATION_FEE_SUBUNITS ||
    feeUnit !== 'msat'
  )
    throw new Error('Creation fee is invalid.')
  if (feeAmount === 0) {
    if (feeOperationRef !== null) throw new Error('Fee-free creation has a fee operation.')
  } else {
    exactText(feeOperationRef, 256)
  }
  validateAnnouncement(input)
  return {
    ...structuredClone(input),
    thumbnail: input.thumbnail === null ? null : snapshotMarketCreationThumbnail(input.thumbnail),
  }
}

export function assertMarketCreationBinding(
  stored: MarketCreationBinding,
  active: MarketCreationBinding,
): void {
  for (const field of [
    'creatorId',
    'walletId',
    'walletScopeId',
    'mintUrl',
    'engineBaseUrl',
  ] as const) {
    if (stored[field] !== active[field])
      throw new Error('Resume requires the original creator, wallet, mint, and engine.')
  }
}

export function assertMarketCreationPreparationEqual(
  stored: MarketCreationPreparation,
  requested: MarketCreationPreparation,
): void {
  if (creationFingerprint(stored) !== creationFingerprint(requested))
    throw new Error('Creation facts cannot change after durable preparation.')
}

function creationFingerprint(input: MarketCreationPreparation): string {
  const { thumbnail } = input
  return deriveDurableCustodyArtifactFingerprint({
    creationId: input.creationId,
    eventId: input.eventId,
    creatorId: input.creatorId,
    walletId: input.walletId,
    walletScopeId: input.walletScopeId,
    mintUrl: input.mintUrl,
    engineBaseUrl: input.engineBaseUrl,
    relayUrls: input.relayUrls,
    metadata: input.metadata,
    announcement: input.announcement,
    registration: input.registration,
    thumbnail:
      thumbnail === null
        ? null
        : {
            filename: thumbnail.filename,
            contentType: thumbnail.contentType,
            bytes: thumbnail.data.byteLength,
            sha256: bytesToHex(sha256(thumbnail.data)),
          },
  })
}

function validateAnnouncement(input: MarketCreationPreparation): void {
  const artifact = input.announcement
  if (
    !/^[0-9a-f]{64}$/.test(artifact.conditionId) ||
    !/^(?:[0-9a-f]{2})+$/.test(artifact.announcementTlvHex) ||
    artifact.announcementTlvHex.length > 48 * 1024 ||
    input.metadata.oracleAnnouncementHex !== artifact.announcementTlvHex
  )
    throw new Error('Creation announcement is invalid.')
  exactText(artifact.announcementNostrEventJson, 256 * 1024)
  let event: unknown
  try {
    event = JSON.parse(artifact.announcementNostrEventJson)
    if (
      typeof event !== 'object' ||
      event === null ||
      (event as { kind?: unknown }).kind !== 88 ||
      !verifyEvent(event as Parameters<typeof verifyEvent>[0])
    )
      throw new Error('Invalid announcement')
  } catch {
    throw new Error('Creation requires the exact signed kind-88 announcement.')
  }
}

function exactText(value: unknown, maximumBytes: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    new TextEncoder().encode(value).byteLength > maximumBytes
  )
    throw new Error('Creation record field is invalid.')
}
