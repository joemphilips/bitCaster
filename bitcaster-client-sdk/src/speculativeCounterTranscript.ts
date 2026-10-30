import type { CounterRange, CounterSource } from '@cashu/cashu-ts'
import {
  DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX,
  DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX,
} from './durableCustody.ts'
import {
  DURABLE_SEED_DERIVED_COUNTER_MAX,
  isDurableSeedDerivedCounter,
  isCanonicalNut02V2KeysetId,
} from './durableSeedDerivedPolicy.ts'

const MAX_NEXT_COUNTER = DURABLE_SEED_DERIVED_COUNTER_MAX + 1
const MAX_TRANSCRIPT_ALLOCATIONS = 256

export interface SpeculativeCounterSnapshot {
  readonly keysetId: string
  /** `null` records that the provider row was absent; zero is an existing row. */
  readonly nextCounter: number | null
}

export interface SpeculativeCounterAllocation {
  readonly ordinal: number
  readonly keysetId: string
  readonly start: number
  readonly count: number
}

export interface SpeculativeCounterChange {
  readonly keysetId: string
  readonly expectedNextCounter: number | null
  readonly nextCounter: number
}

/**
 * A private, uncommitted CounterSource for building an operation draft.
 * Its allocations become authoritative only after the provider commits the
 * matching snapshot changes and exact operation bytes in one transaction.
 */
export interface SpeculativeCounterTranscript {
  readonly kind: 'private-speculative-counter-transcript'
  readonly counterSource: CounterSource
  snapshots(): readonly SpeculativeCounterSnapshot[]
  allocations(): readonly SpeculativeCounterAllocation[]
  changes(): readonly SpeculativeCounterChange[]
}

/**
 * Create a deterministic local counter source from a bounded provider snapshot.
 * This object never writes to the provider and must not be used for submission.
 */
export function createSpeculativeCounterTranscript(
  input: readonly SpeculativeCounterSnapshot[],
): SpeculativeCounterTranscript {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > DURABLE_CUSTODY_KEYSET_BINDING_LIMIT_MAX
  ) {
    throw new Error('speculative counter snapshot is invalid')
  }

  const initial = new Map<string, number | null>()
  const next = new Map<string, number>()
  for (const snapshot of input) {
    if (snapshot === null || typeof snapshot !== 'object') {
      throw new Error('speculative counter snapshot is invalid')
    }
    const keysetId = snapshot.keysetId
    const nextCounter = snapshot.nextCounter
    if (
      !isCanonicalNut02V2KeysetId(keysetId) ||
      initial.has(keysetId) ||
      !isValidSnapshotNext(nextCounter)
    ) {
      throw new Error('speculative counter snapshot is invalid')
    }
    initial.set(keysetId, nextCounter)
    next.set(keysetId, nextCounter ?? 0)
  }

  const frozenSnapshots = Object.freeze(
    [...initial].map(([keysetId, nextCounter]) => Object.freeze({ keysetId, nextCounter })),
  )
  const allocations: SpeculativeCounterAllocation[] = []

  const requireCursor = (keysetId: string): number => {
    const cursor = next.get(keysetId)
    if (cursor === undefined) throw new Error('speculative counter keyset was not declared')
    return cursor
  }

  const counterSource: CounterSource = Object.freeze({
    async reserve(keysetId: string, count: number): Promise<CounterRange> {
      const start = requireCursor(keysetId)
      if (
        !Number.isSafeInteger(count) ||
        count < 0 ||
        count > DURABLE_CUSTODY_BLINDED_OUTPUT_LIMIT_MAX
      ) {
        throw new Error('speculative counter allocation is invalid')
      }
      if (count === 0) return Object.freeze({ start, count })
      if (
        allocations.length >= MAX_TRANSCRIPT_ALLOCATIONS ||
        !isDurableSeedDerivedCounter(start) ||
        start + count > MAX_NEXT_COUNTER
      ) {
        throw new Error('speculative counter range is exhausted')
      }

      allocations.push(Object.freeze({ ordinal: allocations.length, keysetId, start, count }))
      next.set(keysetId, start + count)
      return Object.freeze({ start, count })
    },
    async advanceToAtLeast(keysetId: string, minNext: number): Promise<void> {
      const cursor = requireCursor(keysetId)
      if (!Number.isSafeInteger(minNext) || minNext < 0 || minNext > MAX_NEXT_COUNTER) {
        throw new Error('speculative counter cannot advance outside its allocated ranges')
      }
      if (minNext > cursor) {
        throw new Error('speculative counter cannot create an unallocated gap')
      }
    },
  })

  return Object.freeze({
    kind: 'private-speculative-counter-transcript' as const,
    counterSource,
    snapshots: () => frozenSnapshots,
    allocations: () => Object.freeze([...allocations]),
    changes: () =>
      Object.freeze(
        frozenSnapshots.flatMap(({ keysetId, nextCounter }) => {
          const nextValue = next.get(keysetId)!
          return nextValue === (nextCounter ?? 0)
            ? []
            : [
                Object.freeze({
                  keysetId,
                  expectedNextCounter: nextCounter,
                  nextCounter: nextValue,
                }),
              ]
        }),
      ),
  })
}

function isValidSnapshotNext(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= MAX_NEXT_COUNTER)
  )
}
