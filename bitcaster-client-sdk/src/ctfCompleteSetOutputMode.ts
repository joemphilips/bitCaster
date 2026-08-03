import { OutputData, splitAmount, type CounterSource, type MintKeys } from '@cashu/cashu-ts'
import { amountToNumber } from './proofSelection.ts'
import {
  reserveAndConstructDurableSeedDerivedOutputs,
  type DurableSeedDerivedOutputPlan,
} from './durableSeedDerivedOutputs.ts'
import {
  DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX,
} from './durableCustody.ts'
import {
  fitsDurableSeedDerivedCounterRange,
  isCanonicalModernNut02KeysetId,
  isDurableSeedDerivedCount,
  isDurableSeedDerivedCounter,
  isNonArrayRecord,
} from './durableSeedDerivedPolicy.ts'

const COMPLETE_SET_OUTPUT_DESCRIPTOR_SCHEMA_VERSION = 1 as const
const CONSERVATIVE_COUNTER_START = 2_147_483_392

export interface SeedDerivedCompleteSetOutputMode {
  readonly kind: 'seed-derived'
  readonly seed: Uint8Array
  readonly counterSource: CounterSource
}

export type CompleteSetOutputMode<TMakeOutputs> =
  | { readonly kind: 'custom'; readonly makeOutputs: TMakeOutputs }
  | SeedDerivedCompleteSetOutputMode

export interface CompleteSetOutputDescriptor {
  readonly schemaVersion: typeof COMPLETE_SET_OUTPUT_DESCRIPTOR_SCHEMA_VERSION
  readonly keysetId: string
  readonly counterStart: number
  readonly counterCount: number
}

export interface PersistedCompleteSetOutput {
  readonly blindedMessage: { readonly amount: number; readonly id: string; readonly B_: string }
  readonly blindingFactor: string
  readonly secret: string
}

export interface PreparedSeedDerivedOutputGroup {
  readonly descriptor: CompleteSetOutputDescriptor
  readonly outputData: readonly OutputData[]
  readonly keyset: MintKeys
}

export interface PlannedSeedDerivedOutputGroup {
  readonly keyset: MintKeys
  readonly amounts: readonly number[]
}

export function resolveCompleteSetOutputMode<TMakeOutputs>(input: {
  readonly outputMode?: CompleteSetOutputMode<TMakeOutputs>
  readonly legacyMakeOutputs?: TMakeOutputs
  readonly operation: 'split' | 'merge'
}): CompleteSetOutputMode<TMakeOutputs> | null {
  if (input.outputMode !== undefined && input.legacyMakeOutputs !== undefined) {
    throw new Error(`CTF ${input.operation} output mode and legacy output callback conflict`)
  }
  const mode =
    input.outputMode ??
    (input.legacyMakeOutputs === undefined
      ? null
      : { kind: 'custom', makeOutputs: input.legacyMakeOutputs })
  return mode === null ? null : validateCompleteSetOutputMode(mode)
}

function validateCompleteSetOutputMode<TMakeOutputs>(
  mode: unknown,
): CompleteSetOutputMode<TMakeOutputs> {
  if (!isNonArrayRecord(mode)) {
    throw new Error('CTF output mode is invalid')
  }
  switch (mode.kind) {
    case 'custom':
      if (typeof mode.makeOutputs !== 'function') throw new Error('CTF output mode is invalid')
      return mode as CompleteSetOutputMode<TMakeOutputs>
    case 'seed-derived':
      if (
        !(mode.seed instanceof Uint8Array) ||
        mode.seed.byteLength !== 64 ||
        !isNonArrayRecord(mode.counterSource) ||
        typeof mode.counterSource.reserve !== 'function'
      ) {
        throw new Error('CTF output mode is invalid')
      }
      return mode as CompleteSetOutputMode<TMakeOutputs>
    default:
      throw new Error('CTF output mode is invalid')
  }
}

export async function planSeedDerivedCompleteSetSplitOutputs(input: {
  readonly amountSubunits: number
  readonly outcomeCollectionKeysets: Record<string, string>
  readonly getKeys: (keysetId: string) => Promise<MintKeys>
}): Promise<Record<string, PlannedSeedDerivedOutputGroup>> {
  const groups: Record<string, PlannedSeedDerivedOutputGroup> = {}
  const keysetsById = new Map<string, MintKeys>()
  for (const [collection, keysetId] of Object.entries(input.outcomeCollectionKeysets).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    const keyset = keysetsById.get(keysetId) ?? (await input.getKeys(keysetId))
    keysetsById.set(keysetId, keyset)
    requireSeedDerivedCompleteSetKeyset(keyset, keysetId)
    groups[collection] = {
      keyset,
      amounts: standardDenominationAmounts(input.amountSubunits, keyset),
    }
  }
  const outputCount = Object.values(groups).reduce((sum, group) => sum + group.amounts.length, 0)
  if (outputCount > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX) {
    throw new Error('CTF split cumulative blinded output limit exceeded')
  }
  return groups
}

export async function reserveSeedDerivedCompleteSetSplitOutputs(input: {
  readonly mode: SeedDerivedCompleteSetOutputMode
  readonly groups: Record<string, PlannedSeedDerivedOutputGroup>
}): Promise<Record<string, PreparedSeedDerivedOutputGroup>> {
  const groups: Record<string, PreparedSeedDerivedOutputGroup> = {}
  for (const label of Object.keys(input.groups).sort(compareText)) {
    const group = input.groups[label]!
    const planned = await reserveAndConstructDurableSeedDerivedOutputs({
      seed: input.mode.seed,
      counterSource: input.mode.counterSource,
      keyset: group.keyset,
      amounts: group.amounts,
    })
    groups[label] = {
      descriptor: descriptorFromPlan(planned.plan),
      outputData: planned.outputData,
      keyset: group.keyset,
    }
  }
  return groups
}

export function seedDerivedOutputDescriptorsFromPlans(
  groups: Record<string, PlannedSeedDerivedOutputGroup>,
): Record<string, CompleteSetOutputDescriptor> {
  return Object.fromEntries(
    Object.entries(groups).map(([label, group]) => [
      label,
      {
        schemaVersion: COMPLETE_SET_OUTPUT_DESCRIPTOR_SCHEMA_VERSION,
        keysetId: group.keyset.id,
        counterStart: CONSERVATIVE_COUNTER_START,
        counterCount: group.amounts.length,
      },
    ]),
  )
}

export function planSeedDerivedCompleteSetMergeOutputs(input: {
  readonly amountSubunits: number
  readonly keyset: MintKeys
}): PlannedSeedDerivedOutputGroup {
  requireSeedDerivedCompleteSetKeyset(input.keyset, input.keyset.id)
  return {
    keyset: input.keyset,
    amounts: standardDenominationAmounts(input.amountSubunits, input.keyset),
  }
}

export async function reserveSeedDerivedCompleteSetMergeOutputs(input: {
  readonly mode: SeedDerivedCompleteSetOutputMode
  readonly group: PlannedSeedDerivedOutputGroup
}): Promise<PreparedSeedDerivedOutputGroup> {
  const planned = await reserveAndConstructDurableSeedDerivedOutputs({
    seed: input.mode.seed,
    counterSource: input.mode.counterSource,
    keyset: input.group.keyset,
    amounts: input.group.amounts,
  })
  return {
    descriptor: descriptorFromPlan(planned.plan),
    outputData: planned.outputData,
    keyset: input.group.keyset,
  }
}

export function persistedCompleteSetOutputModeMetadata<TMakeOutputs>(
  mode: CompleteSetOutputMode<TMakeOutputs> | null,
  groups: Record<string, PreparedSeedDerivedOutputGroup>,
): Record<string, unknown> {
  if (mode?.kind !== 'seed-derived') return { outputMode: 'custom' }
  return {
    outputMode: 'seed-derived',
    outputDescriptors: Object.fromEntries(
      Object.entries(groups).map(([label, group]) => [label, group.descriptor]),
    ),
  }
}

export function validatePersistedCompleteSetOutputAuthority<TMakeOutputs>(input: {
  readonly metadata: Record<string, unknown>
  readonly outputGroups: Record<string, readonly PersistedCompleteSetOutput[]>
  readonly labels: readonly string[]
  readonly requestedMode: CompleteSetOutputMode<TMakeOutputs> | null
}): Record<string, CompleteSetOutputDescriptor> | null {
  const descriptors = declaredSeedDerivedDescriptors(input.metadata, input.requestedMode)
  if (descriptors === null) return null
  validateDescriptorGroups(descriptors, input.labels, input.outputGroups)
  return descriptors
}

function declaredSeedDerivedDescriptors<TMakeOutputs>(
  metadata: Record<string, unknown>,
  requestedMode: CompleteSetOutputMode<TMakeOutputs> | null,
): Record<string, CompleteSetOutputDescriptor> | null {
  const declared = metadata.outputMode
  if (declared === undefined) {
    if (metadata.outputDescriptors !== undefined || requestedMode?.kind === 'seed-derived') {
      throw new Error('CTF operation output authority differs from the current request')
    }
    return null
  }
  if (declared === 'custom') {
    if (metadata.outputDescriptors !== undefined || requestedMode?.kind === 'seed-derived') {
      throw new Error('CTF operation output authority differs from the current request')
    }
    return null
  }
  if (declared !== 'seed-derived' || requestedMode?.kind !== 'seed-derived') {
    throw new Error('CTF operation output authority differs from the current request')
  }
  if (!isNonArrayRecord(metadata.outputDescriptors)) {
    throw new Error('CTF operation seed-derived output descriptors are invalid')
  }
  return Object.fromEntries(
    Object.entries(metadata.outputDescriptors).map(([label, value]) => [
      label,
      decodeCompleteSetOutputDescriptor(value),
    ]),
  )
}

function validateDescriptorGroups(
  descriptors: Record<string, CompleteSetOutputDescriptor>,
  labels: readonly string[],
  outputGroups: Record<string, readonly PersistedCompleteSetOutput[]>,
): void {
  const expected = [...labels].sort()
  const actual = Object.keys(descriptors).sort()
  if (
    actual.length !== expected.length ||
    actual.some((label, index) => label !== expected[index])
  ) {
    throw new Error('CTF operation seed-derived output descriptors do not match output groups')
  }
  for (const label of expected) {
    const descriptor = descriptors[label]
    const outputs = outputGroups[label]
    if (
      descriptor === undefined ||
      outputs === undefined ||
      outputs.length !== descriptor.counterCount
    ) {
      throw new Error('CTF operation seed-derived output descriptors do not match output groups')
    }
    if (outputs.some((output) => output.blindedMessage.id !== descriptor.keysetId)) {
      throw new Error('CTF operation seed-derived output keyset is invalid')
    }
  }
}

export function validateSeedDerivedCompleteSetReplay<TMakeOutputs>(input: {
  readonly metadata: Record<string, unknown>
  readonly outputGroups: Record<string, readonly PersistedCompleteSetOutput[]>
  readonly labels: readonly string[]
  readonly requestedMode: CompleteSetOutputMode<TMakeOutputs> | null
}): void {
  const descriptors = validatePersistedCompleteSetOutputAuthority(input)
  if (descriptors === null || input.requestedMode?.kind !== 'seed-derived') return
  for (const label of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[label]!
    const outputs = input.outputGroups[label]!
    for (const [index, output] of outputs.entries()) {
      const derived = OutputData.createSingleDeterministicData(
        output.blindedMessage.amount,
        input.requestedMode.seed,
        descriptor.counterStart + index,
        descriptor.keysetId,
      )
      if (!samePersistedOutput(output, derived)) {
        throw new Error('CTF operation deterministic output derivation does not match')
      }
    }
  }
}

export function decodeCompleteSetOutputDescriptor(value: unknown): CompleteSetOutputDescriptor {
  if (!isNonArrayRecord(value))
    throw new Error('CTF operation seed-derived output descriptor is invalid')
  const keys = Object.keys(value).sort()
  if (
    keys.join(',') !== 'counterCount,counterStart,keysetId,schemaVersion' ||
    value.schemaVersion !== COMPLETE_SET_OUTPUT_DESCRIPTOR_SCHEMA_VERSION ||
    !isCanonicalModernNut02KeysetId(value.keysetId) ||
    !isDurableSeedDerivedCounter(value.counterStart) ||
    !isDurableSeedDerivedCount(value.counterCount) ||
    !fitsDurableSeedDerivedCounterRange(value.counterStart, value.counterCount)
  ) {
    throw new Error('CTF operation seed-derived output descriptor is invalid')
  }
  return {
    schemaVersion: COMPLETE_SET_OUTPUT_DESCRIPTOR_SCHEMA_VERSION,
    keysetId: value.keysetId,
    counterStart: value.counterStart,
    counterCount: value.counterCount,
  }
}

function descriptorFromPlan(plan: DurableSeedDerivedOutputPlan): CompleteSetOutputDescriptor {
  return {
    schemaVersion: COMPLETE_SET_OUTPUT_DESCRIPTOR_SCHEMA_VERSION,
    keysetId: plan.keysetId,
    counterStart: plan.counterStart,
    counterCount: plan.counterCount,
  }
}

function requireSeedDerivedCompleteSetKeyset(keyset: MintKeys, expectedId: string): void {
  if (keyset.id !== expectedId || !isCanonicalModernNut02KeysetId(keyset.id)) {
    throw new Error(`CTF output keyset ${expectedId} was not returned exactly`)
  }
  if (keyset.unit !== 'msat') {
    throw new Error(`CTF output keyset ${expectedId} unit must be exactly msat`)
  }
  if (!isNonArrayRecord(keyset.keys)) {
    throw new Error(`CTF output keyset ${expectedId} keys are invalid`)
  }
  const entries = Object.entries(keyset.keys)
  if (entries.length === 0 || entries.length > DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX) {
    throw new Error(`CTF output keyset ${expectedId} keys are invalid`)
  }
  for (const [denomination, publicKey] of entries) {
    const amount = Number(denomination)
    if (
      !Number.isSafeInteger(amount) ||
      amount <= 0 ||
      String(amount) !== denomination ||
      !Number.isInteger(Math.log2(amount)) ||
      typeof publicKey !== 'string' ||
      publicKey.length === 0
    ) {
      throw new Error(`CTF output keyset ${expectedId} denominations are invalid`)
    }
  }
}

function standardDenominationAmounts(amountSubunits: number, keyset: MintKeys): number[] {
  const amounts = splitAmount(BigInt(amountSubunits), { ...keyset.keys }).map(amountToNumber)
  if (amounts.length === 0 || amounts.reduce((sum, amount) => sum + amount, 0) !== amountSubunits) {
    throw new Error('CTF output amount cannot use the output keyset denominations')
  }
  return amounts
}

function samePersistedOutput(output: PersistedCompleteSetOutput, derived: OutputData): boolean {
  return (
    output.blindedMessage.id === derived.blindedMessage.id &&
    output.blindedMessage.amount === amountToNumber(derived.blindedMessage.amount) &&
    output.blindedMessage.B_ === derived.blindedMessage.B_ &&
    output.blindingFactor === derived.blindingFactor.toString(16) &&
    output.secret === bytesToHex(derived.secret)
  )
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
