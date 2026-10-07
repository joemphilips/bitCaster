import type { components } from './generated/api.ts'
import {
  defaultCollateralUnit,
  normalizeMarketBaseAsset,
  type CtfCollateralUnit,
  type MarketBaseAsset,
} from './marketUnits.ts'

export const MAX_MARKET_CREATION_OUTCOMES = 8
export const MAX_MARKET_CREATION_MATURITY_EPOCH = 0xffff_ffff
export const MAX_MARKET_CREATION_METADATA_JSON_CODE_UNITS = 65_536

export type MarketCreationOutcomeType = NonNullable<
  components['schemas']['CreateMarketRequest']['outcomeType']
>
export type SupportedMarketCreationOutcomeType = Exclude<MarketCreationOutcomeType, 'numeric'>

export interface MarketCreationOutcomeInput {
  name: string
  color?: string | null
}

export interface MarketCreationInput {
  title: string
  description: string
  outcomeType: MarketCreationOutcomeType
  outcomeDetails: readonly MarketCreationOutcomeInput[]
  maturityEpoch: number
  categoryTags: readonly string[]
  baseAsset: unknown
}

export type MarketCreationMetadata = Omit<
  components['schemas']['CreateMarketRequest'],
  'oracleAnnouncementHex' | 'outcomeType'
> & {
  outcomeType: SupportedMarketCreationOutcomeType
  baseAsset: MarketBaseAsset
  categoryTags: string[]
}

export interface NormalizedMarketCreationInput {
  metadata: MarketCreationMetadata
  outcomeLabels: string[]
  mintTags: string[][]
  maturityEpoch: number
  collateralUnit: CtfCollateralUnit
}

/** Normalize metadata shared by CLI and browser market creation. */
export function normalizeMarketCreationInput(
  input: MarketCreationInput,
): NormalizedMarketCreationInput {
  if (!input || typeof input !== 'object') {
    throw new Error('Market creation input is required.')
  }
  if (typeof input.title !== 'string' || input.title.trim().length === 0) {
    throw new Error('A market title is required.')
  }
  if (typeof input.description !== 'string' || input.description.trim().length === 0) {
    throw new Error('A market description is required.')
  }
  if (input.outcomeType === 'numeric') {
    throw new Error('Numeric oracle events are not yet supported.')
  }
  if (input.outcomeType !== 'yesno' && input.outcomeType !== 'categorical') {
    throw new Error('A supported market outcome type is required.')
  }
  if (
    !Number.isSafeInteger(input.maturityEpoch) ||
    input.maturityEpoch <= 0 ||
    input.maturityEpoch > MAX_MARKET_CREATION_MATURITY_EPOCH
  ) {
    throw new Error('Maturity epoch must be a positive U32 integer.')
  }
  if (!Array.isArray(input.outcomeDetails)) {
    throw new Error('Market outcomes are required.')
  }
  if (input.outcomeDetails.length < 2) {
    throw new Error('At least two outcomes are required to create an oracle event.')
  }
  if (input.outcomeDetails.length > MAX_MARKET_CREATION_OUTCOMES) {
    throw new Error(`At most ${MAX_MARKET_CREATION_OUTCOMES} outcomes are supported.`)
  }
  if (
    !Array.isArray(input.categoryTags) ||
    !input.categoryTags.every((tag) => typeof tag === 'string')
  ) {
    throw new Error('Category tags must be strings.')
  }

  const baseAsset = normalizeMarketBaseAsset(input.baseAsset)
  const seenLabels = new Set<string>()
  const outcomeLabels = input.outcomeDetails.map((outcome) => {
    if (!outcome || typeof outcome !== 'object' || typeof outcome.name !== 'string') {
      throw new Error('Every market outcome must have a label.')
    }
    if (!/^[A-Za-z0-9]{1,191}$/.test(outcome.name)) {
      throw new Error('Outcome labels must be 1 to 191 ASCII letters or digits.')
    }
    if (seenLabels.has(outcome.name)) {
      throw new Error('Outcome labels must be unique.')
    }
    seenLabels.add(outcome.name)
    return outcome.name
  })
  if (
    input.outcomeType === 'yesno' &&
    (outcomeLabels.length !== 2 || outcomeLabels[0] !== 'Yes' || outcomeLabels[1] !== 'No')
  ) {
    throw new Error('Binary outcomes must be exactly Yes followed by No.')
  }

  const outcomes = input.outcomeDetails.map((outcome) => {
    const color =
      input.outcomeType === 'categorical' &&
      typeof outcome.color === 'string' &&
      /^#[0-9A-Fa-f]{6}$/.test(outcome.color)
        ? outcome.color
        : undefined
    return { name: outcome.name, ...(color ? { color } : {}) }
  })
  const categoryTags = [...input.categoryTags]
  const metadata: MarketCreationMetadata = {
    title: input.title,
    description: input.description,
    outcomes,
    outcomeType: input.outcomeType,
    baseAsset,
    categoryTags,
  }

  return {
    metadata,
    outcomeLabels,
    mintTags: [
      ['title', input.title],
      ['description', input.description],
      ...categoryTags.map((tag) => ['t', tag]),
    ],
    maturityEpoch: input.maturityEpoch,
    collateralUnit: defaultCollateralUnit(baseAsset),
  }
}

/** Check the same serialized JSON code-unit limit enforced by the engine. */
export function assertMarketCreationMetadataSize(
  metadata: components['schemas']['CreateMarketRequest'],
): void {
  const serialized = JSON.stringify(metadata)
  if (serialized === undefined) {
    throw new Error('Market metadata could not be serialized.')
  }
  if (serialized.length > MAX_MARKET_CREATION_METADATA_JSON_CODE_UNITS) {
    throw new Error('Market metadata exceeds the 64 KB engine limit.')
  }
}
