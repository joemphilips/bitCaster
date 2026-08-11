import type { GetInfoResponse, MintKeys, MintKeyset } from '@cashu/cashu-ts'
import type { ActiveCtfRangeMintKeyset } from './ctfRangeOrderPreparation.ts'
import {
  assertCanonicalNut02V2KeysetId,
  isCanonicalNut02V2KeysetId,
} from './durableSeedDerivedPolicy.ts'
import {
  CTF_RANGE_BATCH_INPUT_LIMIT_MAX,
  CTF_RANGE_BATCH_POOL_ENTRY_LIMIT_MAX,
} from './ctfRangeCapabilityBatchPlan.ts'
import {
  DURABLE_ARTIFACT_BYTES_LIMIT_MAX,
  DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
} from './durableCustody.ts'
import type { CtfRangeReviewedMintFacts } from './ctfRangeOrderProtocol.ts'
import type {
  DurableCtfRangeExpiryObservation,
  DurableCtfRangeMintKeyset,
} from './durableCtfRangeOperation.ts'
import { canonicalizeTokenImportMintUrl } from './tokenImportValidation.ts'

const MINT_KEYSET_CANDIDATE_LIMIT = 256

export interface CtfRangeMintMetadataClient {
  getInfo(): Promise<GetInfoResponse>
  getKeySets(): Promise<{ keysets: MintKeyset[] }>
  getConditionalKeysets(query?: { since?: number; limit?: number; active?: boolean }): Promise<{
    keysets: CtfRangeConditionalKeysetMetadata[]
  }>
  getCtfCondition(conditionId: string): Promise<{
    condition_id: string
    registered_at?: number
    keysets: Record<string, string>
  }>
  getKeys(keysetId?: string): Promise<{ keysets: MintKeys[] }>
}

export interface CtfRangeConditionalKeysetMetadata {
  readonly id: string
  readonly unit: string
  readonly active: boolean
  readonly input_fee_ppk?: number
  readonly final_expiry?: number
  readonly registered_at?: number
  readonly condition_id: string
  readonly outcome_collection: string
  readonly outcome_collection_id: string
}

export interface CtfRangeMintMetadata extends CtfRangeReviewedMintFacts {
  readonly regular: ActiveCtfRangeMintKeyset[]
  readonly conditional: Array<
    ActiveCtfRangeMintKeyset & {
      readonly conditionId: string
      readonly outcomeCollection: string
      readonly outcomeCollectionId: string
      readonly registeredAt: number
    }
  >
  readonly conditionKeysetIds: string[]
  readonly maxInputs: number
  readonly maxOutputs: number
  readonly maxRequestBytes: number
  readonly maxPoolEntries: number
  readonly maxExpirySeconds: number
  readonly observation: DurableCtfRangeExpiryObservation
}

export async function loadCtfRangeMintMetadata(input: {
  readonly mint: CtfRangeMintMetadataClient
  readonly mintUrl: string
  readonly conditionId: string
  readonly observedAt: number
  readonly allowInsecureLoopbackHttp: boolean
}): Promise<CtfRangeMintMetadata> {
  const [info, regularResponse, condition] = await Promise.all([
    input.mint.getInfo(),
    input.mint.getKeySets(),
    input.mint.getCtfCondition(input.conditionId),
  ])
  if (condition.condition_id !== input.conditionId) {
    throw new Error('mint returned a foreign CTF condition')
  }
  const conditionRegisteredAt = nonNegativeSafeInteger(
    condition.registered_at,
    'mint CTF condition registration time',
  )
  const conditionKeysetIds = [...new Set(Object.values(condition.keysets))].sort()
  assertCandidateCount(conditionKeysetIds, 'mint CTF condition keyset')
  conditionKeysetIds.forEach((id) =>
    assertCanonicalNut02V2KeysetId(id, 'mint CTF condition keyset id'),
  )
  const regularKeysets = regularResponse.keysets.filter(
    (keyset) => keyset.active && keyset.unit === 'msat' && isCanonicalNut02V2KeysetId(keyset.id),
  )
  const conditionEntries = await loadConditionKeysets(
    input.mint,
    conditionKeysetIds,
    conditionRegisteredAt,
  )
  const keyIds = [...new Set([...regularKeysets.map(({ id }) => id), ...conditionKeysetIds])]
  assertCandidateCount(keyIds, 'mint keyset authority')
  const keys = await loadCtfRangeMintKeys(input.mint, keyIds)
  const limits = settlementLimits(info)
  return buildLoadedMintMetadata({
    canonicalMintUrl: canonicalizeTokenImportMintUrl(
      input.mintUrl,
      input.allowInsecureLoopbackHttp,
    ),
    regularResponse: regularKeysets,
    conditionEntries,
    conditionKeysetIds,
    keys,
    limits,
    observedAt: input.observedAt,
  })
}

export async function loadCtfRangeMintKeys(
  mint: Pick<CtfRangeMintMetadataClient, 'getKeys'>,
  keysetIds: readonly string[],
): Promise<ReadonlyMap<string, MintKeys>> {
  const keys = new Map<string, MintKeys>()
  for (let offset = 0; offset < keysetIds.length; offset += 8) {
    const page = keysetIds.slice(offset, offset + 8)
    const responses = await Promise.all(page.map((keysetId) => mint.getKeys(keysetId)))
    responses.forEach((response, index) => {
      const expectedId = page[index]!
      const keyset = response.keysets.find(({ id }) => id === expectedId)
      if (keyset === undefined) throw new Error(`mint omitted keys for keyset ${expectedId}`)
      keys.set(expectedId, keyset)
    })
  }
  return keys
}

async function loadConditionKeysets(
  mint: CtfRangeMintMetadataClient,
  conditionKeysetIds: readonly string[],
  conditionRegisteredAt: number,
): Promise<CtfRangeConditionalKeysetMetadata[]> {
  const targets = new Set(conditionKeysetIds)
  const found = new Map<string, CtfRangeConditionalKeysetMetadata>()
  let since = conditionRegisteredAt
  let priorPage = ''
  for (let pageNumber = 0; pageNumber < 16; pageNumber += 1) {
    const response = await mint.getConditionalKeysets({
      limit: MINT_KEYSET_CANDIDATE_LIMIT,
      since,
    })
    if (response.keysets.length > MINT_KEYSET_CANDIDATE_LIMIT) {
      throw new Error('mint exceeded the conditional keyset page limit')
    }
    for (const keyset of response.keysets) {
      if (targets.has(keyset.id)) found.set(keyset.id, keyset)
    }
    if (found.size === targets.size) {
      return [...found.values()].sort((left, right) => left.id.localeCompare(right.id))
    }
    if (response.keysets.length === 0) break
    const page = response.keysets.map(({ id }) => id).join('\0')
    const registeredAt = response.keysets.at(-1)?.registered_at
    if (
      page === priorPage ||
      !Number.isSafeInteger(registeredAt) ||
      (registeredAt as number) < since
    ) {
      throw new Error('mint conditional keyset pagination did not advance')
    }
    priorPage = page
    since = registeredAt as number
  }
  throw new Error('mint CTF condition keyset authority is incomplete')
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`)
  }
  return value as number
}

function buildLoadedMintMetadata(input: {
  readonly canonicalMintUrl: string
  readonly regularResponse: MintKeyset[]
  readonly conditionEntries: CtfRangeConditionalKeysetMetadata[]
  readonly conditionKeysetIds: string[]
  readonly keys: ReadonlyMap<string, MintKeys>
  readonly limits: ReturnType<typeof settlementLimits>
  readonly observedAt: number
}): CtfRangeMintMetadata {
  const regular = input.regularResponse
    .filter((keyset) => keyset.active && keyset.unit === 'msat')
    .map((keyset) => activeKeyset(input.canonicalMintUrl, keyset, input.keys))
  const allConditional = input.conditionEntries.map((keyset) => {
    const registeredAt = keyset.registered_at
    if (!Number.isSafeInteger(registeredAt) || (registeredAt as number) < 0) {
      throw new Error('conditional keyset registration time is invalid')
    }
    const exactRegisteredAt = registeredAt as number
    return {
      ...resolvedKeyset(input.canonicalMintUrl, keyset, input.keys),
      active: keyset.active,
      conditionId: keyset.condition_id,
      outcomeCollection: keyset.outcome_collection,
      outcomeCollectionId: keyset.outcome_collection_id,
      registeredAt: exactRegisteredAt,
    }
  })
  const conditional = allConditional
    .filter((keyset) => keyset.active)
    .map((keyset) => ({ ...keyset, active: true as const }))
  if (regular.length === 0 || conditional.length === 0) {
    throw new Error('mint has no active msat range-order keyset authority')
  }
  return {
    regular,
    conditional,
    conditionKeysetIds: input.conditionKeysetIds,
    ...input.limits,
    observation: loadedExpiryObservation(input, allConditional),
  }
}

function loadedExpiryObservation(
  input: Parameters<typeof buildLoadedMintMetadata>[0],
  conditional: Array<
    DurableCtfRangeMintKeyset & {
      readonly conditionId: string
      readonly outcomeCollection: string
      readonly outcomeCollectionId: string
      readonly registeredAt: number
    }
  >,
): DurableCtfRangeExpiryObservation {
  return {
    canonicalMintUrl: input.canonicalMintUrl,
    freshness: 'fresh',
    observedAt: input.observedAt,
    maxExpirySeconds: input.limits.maxExpirySeconds,
    conditionKeysetIds: input.conditionKeysetIds,
    conditionalKeysets: conditional.map((keyset) => ({
      keysetId: keyset.id,
      conditionId: keyset.conditionId,
      unit: keyset.unit,
      inputFeePpk: keyset.inputFeePpk,
      ...(keyset.finalExpiry === null ? {} : { finalExpiry: keyset.finalExpiry }),
      outcomeCollectionId: keyset.outcomeCollectionId,
      outcomeCollection: keyset.outcomeCollection,
      registeredAt: keyset.registeredAt,
      keys: { ...keyset.keys },
    })),
  }
}

function activeKeyset(
  canonicalMintUrl: string,
  metadata: MintKeyset,
  keys: ReadonlyMap<string, MintKeys>,
): ActiveCtfRangeMintKeyset {
  if (!metadata.active) throw new Error(`mint keyset ${metadata.id} is inactive`)
  return { ...resolvedKeyset(canonicalMintUrl, metadata, keys), active: true }
}

function resolvedKeyset(
  canonicalMintUrl: string,
  metadata: {
    readonly id: string
    readonly unit: string
    readonly input_fee_ppk?: number
    readonly final_expiry?: number
  },
  keys: ReadonlyMap<string, MintKeys>,
): DurableCtfRangeMintKeyset {
  assertCanonicalNut02V2KeysetId(metadata.id, 'mint keyset id')
  const resolved = keys.get(metadata.id)
  if (
    resolved === undefined ||
    resolved.id !== metadata.id ||
    resolved.unit !== 'msat' ||
    metadata.unit !== 'msat'
  ) {
    throw new Error(`mint keyset ${metadata.id} is foreign`)
  }
  return {
    canonicalMintUrl,
    id: metadata.id,
    unit: 'msat',
    keys: Object.fromEntries(
      Object.entries(resolved.keys).map(([amount, publicKey]) => [amount, publicKey]),
    ),
    inputFeePpk: positiveInteger(metadata.input_fee_ppk, 'mint input fee'),
    finalExpiry:
      metadata.final_expiry === undefined
        ? null
        : positiveInteger(metadata.final_expiry, 'mint keyset final expiry'),
  }
}

function settlementLimits(info: GetInfoResponse): {
  readonly maxInputs: number
  readonly maxOutputs: number
  readonly maxRequestBytes: number
  readonly maxPoolEntries: number
  readonly maxExpirySeconds: number
} {
  const nuts = info.nuts as unknown as Record<string, unknown>
  const setting = requireRecord(nuts['CTF-split-merge'], 'mint CTF settlement setting')
  if (setting.supported !== true || setting.partial_fill !== true) {
    throw new Error('mint does not support CTF range settlement')
  }
  return {
    maxInputs: Math.min(
      positiveInteger(setting.max_inputs, 'mint settlement input limit'),
      CTF_RANGE_BATCH_INPUT_LIMIT_MAX,
    ),
    maxOutputs: Math.min(
      positiveInteger(setting.max_outputs, 'mint settlement output limit'),
      DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
    ),
    maxRequestBytes: Math.min(
      positiveInteger(setting.max_request_bytes, 'mint settlement request byte limit'),
      DURABLE_ARTIFACT_BYTES_LIMIT_MAX,
    ),
    maxPoolEntries: Math.min(
      positiveInteger(setting.max_pool_entries, 'mint settlement pool limit'),
      CTF_RANGE_BATCH_POOL_ENTRY_LIMIT_MAX,
    ),
    maxExpirySeconds: positiveInteger(setting.max_expiry_seconds, 'mint settlement expiry limit'),
  }
}

function assertCandidateCount(values: readonly string[], label: string): void {
  if (values.length === 0 || values.length > MINT_KEYSET_CANDIDATE_LIMIT) {
    throw new Error(`${label} count is unsupported`)
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value as Record<string, unknown>
}
