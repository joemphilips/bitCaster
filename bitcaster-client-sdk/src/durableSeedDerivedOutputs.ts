import {
  Amount,
  OutputData,
  type CounterSource,
  type HasKeysetKeys,
  type SerializedOutputData,
} from '@cashu/cashu-ts'
import {
  DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX,
  DURABLE_CUSTODY_RECORD_BYTES_MAX,
  encodeBoundedDurableArtifact,
} from './durableCustody.ts'
import {
  fitsDurableSeedDerivedCounterRange,
  isCanonicalModernNut02KeysetId,
  isDurableSeedDerivedCounter,
  isDurableSeedDerivedCount,
  isNonArrayRecord,
} from './durableSeedDerivedPolicy.ts'

const DURABLE_SEED_DERIVED_OUTPUT_SCHEMA_VERSION = 1 as const

export { DURABLE_SEED_DERIVED_OUTPUT_SCHEMA_VERSION }

export interface DurableSeedDerivedOutputKeyset {
  readonly id: string
  readonly keys: Readonly<Record<string, string>>
}

export interface DurableSeedDerivedOutputPlan {
  readonly schemaVersion: typeof DURABLE_SEED_DERIVED_OUTPUT_SCHEMA_VERSION
  readonly keysetId: string
  readonly counterStart: number
  readonly counterCount: number
  readonly outputs: readonly SerializedOutputData[]
}

export interface ReserveDurableSeedDerivedOutputsInput {
  readonly seed: Uint8Array
  readonly counterSource: CounterSource
  readonly keyset: DurableSeedDerivedOutputKeyset
  readonly amounts: readonly number[]
}

export interface ReconstructDurableSeedDerivedOutputsInput {
  readonly seed: Uint8Array
  readonly keyset: DurableSeedDerivedOutputKeyset
  readonly amounts: readonly number[]
  readonly plan: unknown
}

export interface ReconstructedDurableSeedDerivedOutputs {
  readonly plan: DurableSeedDerivedOutputPlan
  readonly outputData: readonly OutputData[]
}

export async function reserveDurableSeedDerivedOutputs(
  input: ReserveDurableSeedDerivedOutputsInput,
): Promise<DurableSeedDerivedOutputPlan> {
  return (await reserveAndConstructDurableSeedDerivedOutputs(input)).plan
}

export async function reserveAndConstructDurableSeedDerivedOutputs(
  input: ReserveDurableSeedDerivedOutputsInput,
): Promise<ReconstructedDurableSeedDerivedOutputs> {
  const validated = validateAllocationInput(input, true)
  if (validated === null) throw new Error('durable seed-derived output input is invalid')

  let reservation: unknown
  try {
    reservation = await validated.counterSource!.reserve(
      validated.keyset.id,
      validated.amounts.length,
    )
  } catch {
    throw new Error('durable seed-derived output reservation failed')
  }
  if (!isExactReservation(reservation, validated.amounts.length)) {
    throw new Error('durable seed-derived output reservation is invalid')
  }

  const outputs = createOutputs(validated, reservation.start)
  if (outputs === null) throw new Error('durable seed-derived output construction failed')
  return {
    plan: createPlan(validated.keyset.id, reservation.start, outputs),
    outputData: outputs,
  }
}

export function reconstructDurableSeedDerivedOutputs(
  input: ReconstructDurableSeedDerivedOutputsInput,
): ReconstructedDurableSeedDerivedOutputs {
  const validated = validateAllocationInput(input, false)
  if (validated === null) throw new Error('durable seed-derived output input is invalid')
  const plan = decodePlan(input.plan)
  if (plan.keysetId !== validated.keyset.id) {
    throw new Error('durable seed-derived output keyset is foreign')
  }
  if (plan.counterCount !== validated.amounts.length) {
    throw new Error('durable seed-derived output count does not match')
  }

  const outputData = createOutputs(validated, plan.counterStart)
  if (outputData === null || !serializedOutputsMatch(plan.outputs, outputData)) {
    throw new Error('durable seed-derived output plan does not match deterministic derivation')
  }
  return { plan, outputData }
}

/** Decode one persisted output plan before it becomes wallet authority. */
export function decodeDurableSeedDerivedOutputPlan(value: unknown): DurableSeedDerivedOutputPlan {
  return decodePlan(value)
}

interface ValidatedAllocationInput {
  readonly seed: Uint8Array
  readonly counterSource: CounterSource | null
  readonly keyset: HasKeysetKeys
  readonly amounts: readonly number[]
  readonly total: number
}

function validateAllocationInput(
  input: {
    readonly seed: Uint8Array
    readonly counterSource?: unknown
    readonly keyset: DurableSeedDerivedOutputKeyset
    readonly amounts: readonly number[]
  },
  requireCounterSource: boolean,
): ValidatedAllocationInput | null {
  if (
    !isNonArrayRecord(input) ||
    !(input.seed instanceof Uint8Array) ||
    input.seed.byteLength !== 64
  ) {
    return null
  }
  if (
    requireCounterSource &&
    (!isNonArrayRecord(input.counterSource) || typeof input.counterSource.reserve !== 'function')
  ) {
    return null
  }
  if (!Array.isArray(input.amounts) || !isDurableSeedDerivedCount(input.amounts.length)) {
    return null
  }

  const keyset = validateKeyset(input.keyset, input.amounts)
  if (keyset === null) return null
  let total = 0
  for (const amount of input.amounts) {
    if (!Number.isSafeInteger(amount) || amount <= 0) return null
    total += amount
    if (!Number.isSafeInteger(total)) return null
  }
  return {
    seed: input.seed.slice(),
    counterSource:
      isNonArrayRecord(input.counterSource) && typeof input.counterSource.reserve === 'function'
        ? (input.counterSource as unknown as CounterSource)
        : null,
    keyset,
    amounts: [...input.amounts],
    total,
  }
}

function validateKeyset(value: unknown, amounts: readonly number[]): HasKeysetKeys | null {
  if (!isNonArrayRecord(value) || !isNonArrayRecord(value.keys)) return null
  if (!isCanonicalModernNut02KeysetId(value.id)) return null
  const id = value.id
  const entries = Object.entries(value.keys)
  if (entries.length === 0 || entries.length > DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX) {
    return null
  }
  const keys: Record<string, string> = {}
  for (const [amount, key] of entries) {
    if (!isPositiveSafeIntegerText(amount) || !isText(key)) return null
    keys[amount] = key
  }
  if (amounts.some((amount) => !Object.hasOwn(keys, String(amount)))) return null
  if (!fitsDurableArtifact({ id, keys }, DURABLE_CUSTODY_RECORD_BYTES_MAX)) return null
  return { id, keys }
}

function isExactReservation(
  value: unknown,
  expectedCount: number,
): value is { start: number; count: number } {
  return (
    isNonArrayRecord(value) &&
    value.count === expectedCount &&
    isDurableSeedDerivedCounter(value.start) &&
    fitsDurableSeedDerivedCounterRange(value.start, expectedCount)
  )
}

function createOutputs(input: ValidatedAllocationInput, counterStart: number): OutputData[] | null {
  try {
    const outputs = OutputData.createDeterministicData(
      Amount.from(input.total),
      input.seed,
      counterStart,
      input.keyset,
      [...input.amounts],
    )
    if (
      outputs.length !== input.amounts.length ||
      outputs.some(
        (output, index) =>
          output.blindedMessage.id !== input.keyset.id ||
          output.blindedMessage.amount.toString() !== String(input.amounts[index]),
      )
    ) {
      return null
    }
    return outputs
  } catch {
    return null
  }
}

function createPlan(
  keysetId: string,
  counterStart: number,
  outputData: readonly OutputData[],
): DurableSeedDerivedOutputPlan {
  const plan: DurableSeedDerivedOutputPlan = {
    schemaVersion: DURABLE_SEED_DERIVED_OUTPUT_SCHEMA_VERSION,
    keysetId,
    counterStart,
    counterCount: outputData.length,
    outputs: outputData.map((output) => cloneSerializedOutput(OutputData.serialize(output))),
  }
  if (!fitsDurableArtifact(plan, DURABLE_CUSTODY_ARTIFACT_BYTES_MAX)) {
    throw new Error('durable seed-derived output plan is invalid')
  }
  return plan
}

function decodePlan(value: unknown): DurableSeedDerivedOutputPlan {
  if (!isNonArrayRecord(value)) throw new Error('durable seed-derived output plan is invalid')
  requireExactKeys(value, ['schemaVersion', 'keysetId', 'counterStart', 'counterCount', 'outputs'])
  if (
    value.schemaVersion !== DURABLE_SEED_DERIVED_OUTPUT_SCHEMA_VERSION ||
    !isCanonicalModernNut02KeysetId(value.keysetId)
  ) {
    throw new Error('durable seed-derived output plan is invalid')
  }
  if (
    !isDurableSeedDerivedCounter(value.counterStart) ||
    !isDurableSeedDerivedCount(value.counterCount) ||
    !Array.isArray(value.outputs)
  ) {
    throw new Error('durable seed-derived output plan is invalid')
  }
  if (
    value.outputs.length !== value.counterCount ||
    !fitsDurableSeedDerivedCounterRange(value.counterStart, value.counterCount)
  ) {
    throw new Error('durable seed-derived output plan is invalid')
  }
  const plan: DurableSeedDerivedOutputPlan = {
    schemaVersion: DURABLE_SEED_DERIVED_OUTPUT_SCHEMA_VERSION,
    keysetId: value.keysetId,
    counterStart: value.counterStart,
    counterCount: value.counterCount,
    outputs: value.outputs.map(decodeSerializedOutput),
  }
  if (!fitsDurableArtifact(plan, DURABLE_CUSTODY_ARTIFACT_BYTES_MAX)) {
    throw new Error('durable seed-derived output plan is invalid')
  }
  return plan
}

function decodeSerializedOutput(value: unknown): SerializedOutputData {
  if (!isNonArrayRecord(value)) throw new Error('durable seed-derived output plan is invalid')
  requireExactKeys(value, ['blindedMessage', 'blindingFactor', 'secret', 'ephemeralE'], true)
  if (!isNonArrayRecord(value.blindedMessage))
    throw new Error('durable seed-derived output plan is invalid')
  requireExactKeys(value.blindedMessage, ['amount', 'id', 'B_'])
  if (
    !isText(value.blindedMessage.amount) ||
    !isText(value.blindedMessage.id) ||
    !isText(value.blindedMessage.B_) ||
    !isText(value.blindingFactor) ||
    !isText(value.secret) ||
    (value.ephemeralE !== undefined && !isText(value.ephemeralE))
  ) {
    throw new Error('durable seed-derived output plan is invalid')
  }
  const output: SerializedOutputData = {
    blindedMessage: {
      amount: value.blindedMessage.amount,
      id: value.blindedMessage.id,
      B_: value.blindedMessage.B_,
    },
    blindingFactor: value.blindingFactor,
    secret: value.secret,
    ...(value.ephemeralE === undefined ? {} : { ephemeralE: value.ephemeralE }),
  }
  if (!fitsDurableArtifact(output, DURABLE_CUSTODY_RECORD_BYTES_MAX)) {
    throw new Error('durable seed-derived output plan is invalid')
  }
  try {
    const canonical = OutputData.serialize(OutputData.deserialize(output))
    if (!serializedOutputMatches(output, canonical)) {
      throw new Error('serialized output is not canonical')
    }
    return canonical
  } catch {
    throw new Error('durable seed-derived output plan is invalid')
  }
}

function serializedOutputsMatch(
  actual: readonly SerializedOutputData[],
  expected: readonly OutputData[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((output, index) =>
      serializedOutputMatches(output, OutputData.serialize(expected[index]!)),
    )
  )
}

function serializedOutputMatches(left: SerializedOutputData, right: SerializedOutputData): boolean {
  return (
    left.blindedMessage.amount === right.blindedMessage.amount &&
    left.blindedMessage.id === right.blindedMessage.id &&
    left.blindedMessage.B_ === right.blindedMessage.B_ &&
    left.blindingFactor === right.blindingFactor &&
    left.secret === right.secret &&
    left.ephemeralE === right.ephemeralE
  )
}

function cloneSerializedOutput(value: SerializedOutputData): SerializedOutputData {
  return {
    blindedMessage: {
      amount: value.blindedMessage.amount,
      id: value.blindedMessage.id,
      B_: value.blindedMessage.B_,
    },
    blindingFactor: value.blindingFactor,
    secret: value.secret,
    ...(value.ephemeralE === undefined ? {} : { ephemeralE: value.ephemeralE }),
  }
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPositiveSafeIntegerText(value: string): boolean {
  if (!/^[1-9]\d*$/.test(value)) return false
  const amount = Number(value)
  return Number.isSafeInteger(amount)
}

function fitsDurableArtifact(value: unknown, maximumBytes: number): boolean {
  try {
    encodeBoundedDurableArtifact(value, maximumBytes)
    return true
  } catch {
    return false
  }
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): void {
  const present = Object.keys(value)
  if (present.some((key) => !keys.includes(key))) {
    throw new Error('durable seed-derived output plan is invalid')
  }
  const required = optional ? keys.filter((key) => key !== 'ephemeralE') : keys
  if (required.some((key) => !Object.hasOwn(value, key))) {
    throw new Error('durable seed-derived output plan is invalid')
  }
}
