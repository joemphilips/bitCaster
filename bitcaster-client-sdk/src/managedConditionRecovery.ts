import {
  decodeDurableCustodyOperationId,
  decodeDurableCustodyScopeId,
  DURABLE_CUSTODY_ARTIFACT_BYTES_MAX,
  DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX,
} from './durableCustody.ts'

export const MANAGED_CONDITION_RECOVERY_PASS_LIMIT = 4 as const
const RECOVERY_HEAD_LIMIT = MANAGED_CONDITION_RECOVERY_PASS_LIMIT + 1

export type ManagedConditionRecoveryOperationKind =
  | 'receive'
  | 'funding'
  | 'range-settlement'
  | 'range-refund'
  | 'condition-linked-consolidation'
  | 'inventory-retirement'

export type ManagedConditionRecoveryClass =
  | 'receive'
  | 'funding'
  | 'range-settlement-or-refund'
  | 'condition-linked-consolidation'
  | 'inventory-retirement'

export interface ManagedConditionRecoveryIndexEntry {
  readonly schemaVersion: 1
  readonly scopeId: string
  readonly operationId: string
  readonly operationRevision: number
  readonly operationKind: string
  /** Complete record and artifact envelope bytes. */
  readonly envelopeByteLength: number
  readonly nextAttemptAtMs: number
}

export interface ManagedConditionRecoveryHead {
  readonly entries: readonly unknown[]
  readonly hasMore: boolean
}

export interface ManagedConditionRecoveryOperation {
  readonly authority: ManagedConditionRecoveryIndexEntry
  readonly exactOperation: unknown
}

export type ManagedConditionRecoveryWake =
  | {
      readonly kind: 'external-signal'
      readonly source: 'mint' | 'engine' | 'local-custody'
      readonly signalId: string
    }
  | { readonly kind: 'operator-action'; readonly code: string }

export type ManagedConditionRecoveryHandlerResult =
  | { readonly kind: 'terminal' }
  | { readonly kind: 'retry-at'; readonly atMs: number }
  | { readonly kind: 'blocked'; readonly wake: ManagedConditionRecoveryWake }

export interface ManagedConditionRecoveryStore {
  readRecoveryHead(input: {
    readonly scopeId: string
    readonly limit: typeof RECOVERY_HEAD_LIMIT
  }): Promise<ManagedConditionRecoveryHead>
  loadExactOperation(
    authority: ManagedConditionRecoveryIndexEntry,
  ): Promise<ManagedConditionRecoveryOperation>
}

export interface ManagedConditionRecoveryHandlers {
  receive(
    operation: ManagedConditionRecoveryOperation,
  ): Promise<ManagedConditionRecoveryHandlerResult>
  funding(
    operation: ManagedConditionRecoveryOperation,
  ): Promise<ManagedConditionRecoveryHandlerResult>
  rangeSettlementOrRefund(
    operation: ManagedConditionRecoveryOperation,
  ): Promise<ManagedConditionRecoveryHandlerResult>
  conditionLinkedConsolidation(
    operation: ManagedConditionRecoveryOperation,
  ): Promise<ManagedConditionRecoveryHandlerResult>
  inventoryRetirement(
    operation: ManagedConditionRecoveryOperation,
  ): Promise<ManagedConditionRecoveryHandlerResult>
}

export type ManagedConditionRecoveryPassResult =
  | {
      readonly kind: 'terminal'
      readonly processedCount: number
      readonly processedBytes: number
      readonly hasMore: boolean
    }
  | {
      readonly kind: 'retry-at'
      readonly processedCount: number
      readonly processedBytes: number
      readonly operationId: string
      readonly recoveryClass: ManagedConditionRecoveryClass
      readonly atMs: number
    }
  | {
      readonly kind: 'blocked'
      readonly processedCount: number
      readonly processedBytes: number
      readonly operationId: string | null
      readonly recoveryClass: ManagedConditionRecoveryClass | null
      readonly reason:
        | 'corrupt-index'
        | 'unknown-operation'
        | 'foreign-operation'
        | 'handler-error'
        | 'handler-blocked'
      readonly wake: ManagedConditionRecoveryWake
    }

export function classifyManagedConditionRecoveryOperation(
  value: unknown,
): ManagedConditionRecoveryClass {
  switch (value) {
    case 'receive':
      return 'receive'
    case 'funding':
      return 'funding'
    case 'range-settlement':
    case 'range-refund':
      return 'range-settlement-or-refund'
    case 'condition-linked-consolidation':
      return 'condition-linked-consolidation'
    case 'inventory-retirement':
      return 'inventory-retirement'
    default:
      throw new Error('managed condition recovery operation is unknown')
  }
}

export async function runManagedConditionRecoveryPass(input: {
  readonly scopeId: string
  readonly nowMs: number
  readonly store: ManagedConditionRecoveryStore
  readonly handlers: ManagedConditionRecoveryHandlers
}): Promise<ManagedConditionRecoveryPassResult> {
  const scopeId = decodeDurableCustodyScopeId(input.scopeId)
  const nowMs = count(input.nowMs, 'managed condition recovery time')
  let head: ReturnType<typeof decodeRecoveryHead>
  try {
    head = decodeRecoveryHead(await input.store.readRecoveryHead({ scopeId, limit: 5 }), scopeId)
  } catch {
    return blocked(0, 0, null, null, 'corrupt-index', 'recovery-index-invalid')
  }
  const classified = classifyHead(head.entries)
  if (classified.kind === 'blocked') return classified.result
  if (!isOrdered(classified.entries)) {
    return blocked(0, 0, null, null, 'corrupt-index', 'recovery-index-order-invalid')
  }
  return runOrderedHead({ ...input, scopeId, nowMs }, classified.entries, head.hasMore)
}

function classifyHead(entries: readonly ManagedConditionRecoveryIndexEntry[]):
  | {
      readonly kind: 'ready'
      readonly entries: readonly ClassifiedRecoveryEntry[]
    }
  | { readonly kind: 'blocked'; readonly result: ManagedConditionRecoveryPassResult } {
  const result: ClassifiedRecoveryEntry[] = []
  for (const entry of entries) {
    try {
      result.push({
        authority: entry,
        recoveryClass: classifyManagedConditionRecoveryOperation(entry.operationKind),
      })
    } catch {
      return {
        kind: 'blocked',
        result: blocked(
          0,
          0,
          entry.operationId,
          null,
          'unknown-operation',
          'recovery-operation-unknown',
        ),
      }
    }
  }
  return { kind: 'ready', entries: result }
}

async function runOrderedHead(
  input: {
    readonly scopeId: string
    readonly nowMs: number
    readonly store: ManagedConditionRecoveryStore
    readonly handlers: ManagedConditionRecoveryHandlers
  },
  entries: readonly ClassifiedRecoveryEntry[],
  storeHasMore: boolean,
): Promise<ManagedConditionRecoveryPassResult> {
  let processedCount = 0
  let processedBytes = 0
  for (const entry of entries.slice(0, MANAGED_CONDITION_RECOVERY_PASS_LIMIT)) {
    const authority = entry.authority
    if (authority.nextAttemptAtMs > input.nowMs) {
      return retryAt(processedCount, processedBytes, entry, authority.nextAttemptAtMs)
    }
    if (!fitsPass(processedCount, processedBytes, authority.envelopeByteLength)) break
    const stop = await recoverOne(input, entry, processedCount, processedBytes)
    if (stop !== null) return stop
    processedCount += 1
    processedBytes += authority.envelopeByteLength
  }
  return {
    kind: 'terminal',
    processedCount,
    processedBytes,
    hasMore: storeHasMore || processedCount < entries.length,
  }
}

async function recoverOne(
  input: {
    readonly store: ManagedConditionRecoveryStore
    readonly handlers: ManagedConditionRecoveryHandlers
    readonly nowMs: number
  },
  entry: ClassifiedRecoveryEntry,
  processedCount: number,
  processedBytes: number,
): Promise<RecoveryStopResult | null> {
  let operation: ManagedConditionRecoveryOperation
  try {
    operation = decodeLoadedOperation(
      await input.store.loadExactOperation(entry.authority),
      entry.authority,
    )
  } catch {
    return blockedFromEntry(
      processedCount,
      processedBytes,
      entry,
      'foreign-operation',
      'recovery-operation-foreign',
    )
  }
  let result: ManagedConditionRecoveryHandlerResult
  try {
    result = decodeHandlerResult(await dispatch(input.handlers, entry, operation))
  } catch {
    return blockedFromEntry(
      processedCount,
      processedBytes,
      entry,
      'handler-error',
      'recovery-handler-error',
    )
  }
  if (result.kind === 'terminal') return null
  if (result.kind === 'retry-at') {
    if (result.atMs <= input.nowMs) {
      return blockedFromEntry(
        processedCount,
        processedBytes,
        entry,
        'handler-error',
        'recovery-handler-retry-invalid',
      )
    }
    return retryAt(processedCount, processedBytes, entry, result.atMs)
  }
  return {
    kind: 'blocked',
    processedCount,
    processedBytes,
    operationId: entry.authority.operationId,
    recoveryClass: entry.recoveryClass,
    reason: 'handler-blocked',
    wake: result.wake,
  }
}

interface ClassifiedRecoveryEntry {
  readonly authority: ManagedConditionRecoveryIndexEntry
  readonly recoveryClass: ManagedConditionRecoveryClass
}

type RecoveryRetryResult = Extract<
  ManagedConditionRecoveryPassResult,
  { readonly kind: 'retry-at' }
>
type RecoveryBlockedResult = Extract<
  ManagedConditionRecoveryPassResult,
  { readonly kind: 'blocked' }
>
type RecoveryStopResult = RecoveryRetryResult | RecoveryBlockedResult

function dispatch(
  handlers: ManagedConditionRecoveryHandlers,
  entry: ClassifiedRecoveryEntry,
  operation: ManagedConditionRecoveryOperation,
): Promise<ManagedConditionRecoveryHandlerResult> {
  switch (entry.recoveryClass) {
    case 'receive':
      return handlers.receive(operation)
    case 'funding':
      return handlers.funding(operation)
    case 'range-settlement-or-refund':
      return handlers.rangeSettlementOrRefund(operation)
    case 'condition-linked-consolidation':
      return handlers.conditionLinkedConsolidation(operation)
    case 'inventory-retirement':
      return handlers.inventoryRetirement(operation)
  }
}

function decodeRecoveryHead(
  value: unknown,
  scopeId: string,
): {
  entries: ManagedConditionRecoveryIndexEntry[]
  hasMore: boolean
} {
  if (!record(value)) throw new Error('managed condition recovery head is invalid')
  exactKeys(value, ['entries', 'hasMore'], 'managed condition recovery head')
  if (!Array.isArray(value.entries) || value.entries.length > RECOVERY_HEAD_LIMIT)
    throw new Error('managed condition recovery head is invalid')
  if (typeof value.hasMore !== 'boolean' || (value.entries.length === 0 && value.hasMore))
    throw new Error('managed condition recovery head is invalid')
  const entries = value.entries.map((entry) => decodeIndexEntry(entry, scopeId))
  if (new Set(entries.map((entry) => entry.operationId)).size !== entries.length)
    throw new Error('managed condition recovery head contains duplicates')
  return { entries, hasMore: value.hasMore }
}

function decodeIndexEntry(value: unknown, scopeId: string): ManagedConditionRecoveryIndexEntry {
  if (!record(value)) throw new Error('managed condition recovery index entry is invalid')
  exactKeys(value, INDEX_KEYS, 'managed condition recovery index entry')
  if (value.schemaVersion !== 1 || value.scopeId !== scopeId)
    throw new Error('managed condition recovery index entry is foreign')
  return {
    schemaVersion: 1,
    scopeId,
    operationId: decodeDurableCustodyOperationId(value.operationId, scopeId),
    operationRevision: count(value.operationRevision, 'managed condition recovery revision'),
    operationKind: text(value.operationKind, 'managed condition recovery operation kind'),
    envelopeByteLength: boundedBytes(value.envelopeByteLength),
    nextAttemptAtMs: count(value.nextAttemptAtMs, 'managed condition recovery retry time'),
  }
}

function decodeLoadedOperation(
  value: unknown,
  expected: ManagedConditionRecoveryIndexEntry,
): ManagedConditionRecoveryOperation {
  if (!record(value)) throw new Error('managed condition recovery operation is invalid')
  exactKeys(value, ['authority', 'exactOperation'], 'managed condition recovery operation')
  const authority = decodeIndexEntry(value.authority, expected.scopeId)
  if (INDEX_KEYS.some((key) => authority[key] !== expected[key]))
    throw new Error('managed condition recovery operation authority is foreign')
  return { authority, exactOperation: value.exactOperation }
}

function decodeHandlerResult(value: unknown): ManagedConditionRecoveryHandlerResult {
  if (!record(value)) throw new Error('managed condition recovery result is invalid')
  if (value.kind === 'terminal') {
    exactKeys(value, ['kind'], 'managed condition recovery result')
    return { kind: 'terminal' }
  }
  if (value.kind === 'retry-at') {
    exactKeys(value, ['kind', 'atMs'], 'managed condition recovery result')
    return { kind: 'retry-at', atMs: count(value.atMs, 'managed condition recovery retry time') }
  }
  if (value.kind === 'blocked') {
    exactKeys(value, ['kind', 'wake'], 'managed condition recovery result')
    return { kind: 'blocked', wake: decodeWake(value.wake) }
  }
  throw new Error('managed condition recovery result is invalid')
}

function decodeWake(value: unknown): ManagedConditionRecoveryWake {
  if (!record(value)) throw new Error('managed condition recovery wake is invalid')
  if (value.kind === 'operator-action') {
    exactKeys(value, ['kind', 'code'], 'managed condition recovery wake')
    return { kind: value.kind, code: text(value.code, 'managed condition recovery wake code') }
  }
  exactKeys(value, ['kind', 'source', 'signalId'], 'managed condition recovery wake')
  if (
    value.kind !== 'external-signal' ||
    (value.source !== 'mint' && value.source !== 'engine' && value.source !== 'local-custody')
  )
    throw new Error('managed condition recovery wake is invalid')
  return {
    kind: value.kind,
    source: value.source,
    signalId: text(value.signalId, 'managed condition recovery signal id'),
  }
}

function isOrdered(entries: readonly ClassifiedRecoveryEntry[]): boolean {
  return entries.every((entry, index) => {
    const previous = entries[index - 1]
    if (previous === undefined) return true
    const rank = recoveryRank(entry.recoveryClass) - recoveryRank(previous.recoveryClass)
    if (rank !== 0) return rank > 0
    if (entry.authority.nextAttemptAtMs !== previous.authority.nextAttemptAtMs)
      return entry.authority.nextAttemptAtMs > previous.authority.nextAttemptAtMs
    return entry.authority.operationId > previous.authority.operationId
  })
}

function recoveryRank(value: ManagedConditionRecoveryClass): number {
  return RECOVERY_CLASSES.indexOf(value)
}

function fitsPass(countValue: number, bytes: number, nextBytes: number): boolean {
  if (countValue === 0) return true
  return bytes + nextBytes <= DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX
}

function retryAt(
  processedCount: number,
  processedBytes: number,
  entry: ClassifiedRecoveryEntry,
  atMs: number,
): RecoveryRetryResult {
  return {
    kind: 'retry-at',
    processedCount,
    processedBytes,
    operationId: entry.authority.operationId,
    recoveryClass: entry.recoveryClass,
    atMs: count(atMs, 'managed condition recovery retry time'),
  }
}

function blockedFromEntry(
  processedCount: number,
  processedBytes: number,
  entry: ClassifiedRecoveryEntry,
  reason: 'foreign-operation' | 'handler-error',
  code: string,
): RecoveryBlockedResult {
  return blocked(
    processedCount,
    processedBytes,
    entry.authority.operationId,
    entry.recoveryClass,
    reason,
    code,
  )
}

function blocked(
  processedCount: number,
  processedBytes: number,
  operationId: string | null,
  recoveryClass: ManagedConditionRecoveryClass | null,
  reason: 'corrupt-index' | 'unknown-operation' | 'foreign-operation' | 'handler-error',
  code: string,
): RecoveryBlockedResult {
  return {
    kind: 'blocked',
    processedCount,
    processedBytes,
    operationId,
    recoveryClass,
    reason,
    wake: { kind: 'operator-action', code },
  }
}

function boundedBytes(value: unknown): number {
  const result = count(value, 'managed condition recovery envelope bytes')
  if (result < 1 || result > DURABLE_CUSTODY_ARTIFACT_BYTES_MAX)
    throw new Error('managed condition recovery envelope byte limit is invalid')
  return result
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`)
  return value as number
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16_384)
    throw new Error(`${label} is invalid`)
  return value
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index]))
    throw new Error(`${label} contains foreign fields`)
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const RECOVERY_CLASSES: readonly ManagedConditionRecoveryClass[] = [
  'receive',
  'funding',
  'range-settlement-or-refund',
  'condition-linked-consolidation',
  'inventory-retirement',
]
const INDEX_KEYS = [
  'schemaVersion',
  'scopeId',
  'operationId',
  'operationRevision',
  'operationKind',
  'envelopeByteLength',
  'nextAttemptAtMs',
] as const
