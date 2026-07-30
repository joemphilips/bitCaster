import {
  OutputData,
  createCtfAuthorizationOutputs,
  createCtfRangeManifest,
  deriveCtfRangeRefundKey,
  type CtfRangeManifestMaterial,
  type Proof,
} from '@cashu/cashu-ts'
import {
  createDurableCtfRangeOperation,
  type DurableCtfRangeExpiryObservation,
  type DurableCtfRangeMintKeyset,
  type DurableCtfRangeOperation,
} from './durableCtfRangeOperation.ts'
import type { TokenImportKeysetLookup } from './tokenImportValidation.ts'
import {
  planCtfRangeOrderAuthorization,
  type CtfRangeOrderAuthorizationPlan,
} from './ctfRangeOrderAuthorization.ts'

const ROOT_PARENT_COLLECTION_ID = '0'.repeat(64)

export interface ActiveCtfRangeMintKeyset extends DurableCtfRangeMintKeyset {
  active: true
}

export interface CtfRangeOrderPreparation {
  operationId: string
  sourceOperationId: string
  authorizationId: string
  mintUrl: string
  conditionId: string
  coordinatorPublicKey: string
  offerKeysetId: string
  receiveKeysetId: string
  expiry: number
  plan: CtfRangeOrderAuthorizationPlan
  refundKey: { privateKey: string; publicKey: string }
  authorizationOutputs: OutputData[]
  manifest: CtfRangeManifestMaterial
}

export function prepareCtfRangeOrderAuthorization(input: {
  seed: Uint8Array
  operationId: string
  sourceOperationId: string
  authorizationId: string
  mintUrl: string
  conditionId: string
  coordinatorPublicKey: string
  side: 'Buy' | 'Sell'
  priceNumerator: number
  amountSubunits: number
  divisibility: number
  offerKeyset: ActiveCtfRangeMintKeyset
  receiveKeyset: ActiveCtfRangeMintKeyset
  expiryObservation: DurableCtfRangeExpiryObservation
  expiry: number
  maxPoolEntries: number
  maxInputs?: number
}): CtfRangeOrderPreparation {
  assertPreparationAuthority(input)
  const plan = planCtfRangeOrderAuthorization({
    side: input.side,
    priceNumerator: input.priceNumerator,
    amountSubunits: input.amountSubunits,
    divisibility: input.divisibility,
    inputFeePpk: input.offerKeyset.inputFeePpk,
    offerKeysetKeys: input.offerKeyset.keys,
    maxPoolEntries: input.maxPoolEntries,
    ...(input.maxInputs === undefined ? {} : { maxInputs: input.maxInputs }),
  })
  const manifest = createCtfRangeManifest({
    seed: input.seed,
    operationId: input.operationId,
    receiveKeyset: input.receiveKeyset,
    offerKeyset: input.offerKeyset,
    maxReceive: plan.manifest.maxReceive,
    maxChange: plan.manifest.maxChange,
    maxEntries: input.maxPoolEntries,
  })
  const refundKey = deriveCtfRangeRefundKey(input.seed, input.operationId)
  const authorizationOutputs = createCtfAuthorizationOutputs({
    seed: input.seed,
    operationId: input.operationId,
    offerKeysetId: input.offerKeyset.id,
    amounts: plan.authorizationAmounts,
    commitment: manifest.commitment,
    expiry: input.expiry,
    expiryContext: expiryContext(input.conditionId, input.expiryObservation),
    refund: refundKey.publicKey,
    coordinatorPublicKey: input.coordinatorPublicKey,
    poolPolicy: plan.policy,
  })
  return {
    operationId: input.operationId,
    sourceOperationId: input.sourceOperationId,
    authorizationId: input.authorizationId,
    mintUrl: input.mintUrl,
    conditionId: input.conditionId,
    coordinatorPublicKey: input.coordinatorPublicKey,
    offerKeysetId: input.offerKeyset.id,
    receiveKeysetId: input.receiveKeyset.id,
    expiry: input.expiry,
    plan,
    refundKey,
    authorizationOutputs,
    manifest,
  }
}

export function completeCtfRangeOrderAuthorization(input: {
  preparation: CtfRangeOrderPreparation
  inputs: readonly Proof[]
  keysetLookup: TokenImportKeysetLookup
  expiryObservation: DurableCtfRangeExpiryObservation
  allowInsecureLoopbackHttp: boolean
}): DurableCtfRangeOperation {
  const prepared = input.preparation
  return createDurableCtfRangeOperation({
    operationId: prepared.operationId,
    sourceOperationId: prepared.sourceOperationId,
    authorizationId: prepared.authorizationId,
    mintUrl: prepared.mintUrl,
    unit: 'msat',
    conditionId: prepared.conditionId,
    parentCollectionId: ROOT_PARENT_COLLECTION_ID,
    coordinatorPublicKey: prepared.coordinatorPublicKey,
    offerKeysetId: prepared.offerKeysetId,
    receiveKeysetId: prepared.receiveKeysetId,
    keysetLookup: input.keysetLookup,
    expiryObservation: input.expiryObservation,
    allowInsecureLoopbackHttp: input.allowInsecureLoopbackHttp,
    expiry: prepared.expiry,
    policy: prepared.plan.policy,
    refundKey: prepared.refundKey,
    inputFeePpkByKeyset: {
      [prepared.offerKeysetId]: inputFeePpk(input.keysetLookup, prepared.offerKeysetId),
    },
    inputs: input.inputs,
    manifest: prepared.manifest,
  })
}

function assertPreparationAuthority(input: {
  mintUrl: string
  offerKeyset: ActiveCtfRangeMintKeyset
  receiveKeyset: ActiveCtfRangeMintKeyset
  expiryObservation: DurableCtfRangeExpiryObservation
}): void {
  for (const keyset of [input.offerKeyset, input.receiveKeyset]) {
    if (keyset.canonicalMintUrl !== input.mintUrl || keyset.unit !== 'msat') {
      throw new Error('CTF range preparation keyset is from a foreign asset context')
    }
  }
  if (input.offerKeyset.id === input.receiveKeyset.id) {
    throw new Error('CTF range preparation keysets must differ')
  }
  if (
    input.expiryObservation.freshness !== 'fresh' ||
    input.expiryObservation.canonicalMintUrl !== input.mintUrl
  ) {
    throw new Error('CTF range preparation expiry authority is stale or foreign')
  }
}

function expiryContext(
  conditionId: string,
  observation: DurableCtfRangeExpiryObservation,
): Parameters<typeof createCtfAuthorizationOutputs>[0]['expiryContext'] {
  return {
    now: observation.observedAt,
    maxExpirySeconds: observation.maxExpirySeconds,
    condition: {
      condition_id: conditionId,
      keysets: Object.fromEntries(
        observation.conditionKeysetIds.map((keysetId, index) => [String(index), keysetId]),
      ),
    },
    conditionalKeysets: observation.conditionalKeysets.map((keyset) => {
      const finalExpiry = optionalPositiveSafeInteger(
        keyset.finalExpiry,
        'CTF range conditional keyset expiry',
      )
      return {
        id: keyset.keysetId,
        condition_id: keyset.conditionId,
        ...(finalExpiry === undefined ? {} : { final_expiry: finalExpiry }),
      }
    }),
  }
}

function inputFeePpk(lookup: TokenImportKeysetLookup, keysetId: string): number {
  const candidates = [...lookup.regularKeysets, ...lookup.conditionalKeysets]
  const keyset = candidates.find((candidate) => candidate.keysetId === keysetId)
  if (keyset === undefined) throw new Error('CTF range offer keyset authority is missing')
  const value = keyset.inputFeePpk
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error('CTF range offer input fee authority is invalid')
  }
  return value
}

function optionalPositiveSafeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} is invalid`)
  }
  return value
}
