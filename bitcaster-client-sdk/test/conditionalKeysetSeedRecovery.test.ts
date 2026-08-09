import assert from 'node:assert/strict'
import test from 'node:test'
import { Amount, deriveConditionalKeysetId } from '@cashu/cashu-ts'
import {
  CONDITIONAL_KEYSET_DISCOVERY_PREFIX_COUNTERS,
  bindConditionalKeysetSeedRecoveryResponse,
  planConditionalKeysetSeedRecoveryPage,
  validateConditionalKeysetSeedRecoveryAuthority,
  type ConditionalKeysetSeedRecoveryCandidate,
} from '../src/conditionalKeysetSeedRecovery.ts'
import { deriveRootCtfOutcomeCollectionId } from '../src/durableCtfRangeOperation.ts'

const SEED = new Uint8Array(64).fill(7)
const PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const CONDITION_ID = 'ab'.repeat(32)
const KEYS = { '1': PUBLIC_KEY, '2': PUBLIC_KEY }

test('validates conditional keyset authority from clean product syntax and key material', () => {
  const value = authority()
  assert.equal(validateConditionalKeysetSeedRecoveryAuthority(value).id, value.id)
  assert.throws(
    () => validateConditionalKeysetSeedRecoveryAuthority({ ...value, keys: { '1': PUBLIC_KEY } }),
    /identity is inconsistent/,
  )
  assert.throws(
    () =>
      validateConditionalKeysetSeedRecoveryAuthority({
        ...value,
        outcome_collection_id: 'cd'.repeat(32),
      }),
    /outcome collection is inconsistent/,
  )
})

test('requires bounded outcome syntax and NUT-02 V2 authority', () => {
  const value = authority()
  assert.throws(
    () =>
      validateConditionalKeysetSeedRecoveryAuthority({ ...value, outcome_collection: 'NO| NO' }),
    /outcome collection syntax/,
  )
  assert.throws(
    () => validateConditionalKeysetSeedRecoveryAuthority({ ...value, outcome_collection: 'NO|NO' }),
    /outcome collection syntax/,
  )
  assert.throws(
    () =>
      validateConditionalKeysetSeedRecoveryAuthority({ ...value, id: `02${value.id.slice(2)}` }),
    /keyset id is invalid/,
  )
  assert.throws(
    () =>
      validateConditionalKeysetSeedRecoveryAuthority({ ...value, id: `00${value.id.slice(2)}` }),
    /keyset id is invalid/,
  )
})

test('accepts null optional fees and returns detached immutable authority', () => {
  const raw = authorityWithoutOptionalFees()
  const omitted = validateConditionalKeysetSeedRecoveryAuthority(raw)
  const validated = validateConditionalKeysetSeedRecoveryAuthority({
    ...raw,
    input_fee_ppk: null,
    final_expiry: null,
  })
  assert.equal(omitted.inputFeePpk, 0)
  assert.equal(omitted.finalExpiry, null)
  assert.equal(omitted.id, raw.id)
  assert.equal(validated.inputFeePpk, 0)
  assert.equal(validated.finalExpiry, null)
  assert.equal(validated.id, raw.id)
  raw.keys['2'] = '03' + '00'.repeat(32)
  assert.equal(validated.keys['2'], PUBLIC_KEY)
  assert.equal(Object.isFrozen(validated), true)
  assert.equal(Object.isFrozen(validated.keys), true)
  assert.throws(() => {
    ;(validated.keys as Record<string, string>)['4'] = PUBLIC_KEY
  })

  const candidate = planConditionalKeysetSeedRecoveryPage({
    seed: SEED,
    keysets: [validated],
    maxOutputs: 1,
  }).candidates[0]!
  assert.equal(Object.isFrozen(candidate), true)
  assert.equal(Object.isFrozen(candidate.keyset), true)
  assert.equal(Object.isFrozen(candidate.asset), true)
  assert.equal(candidate.keyset.keys['2'], PUBLIC_KEY)
  assert.equal(
    bindConditionalKeysetSeedRecoveryResponse({
      candidates: [candidate],
      response: { outputs: [restoreOutput(candidate)], signatures: [signatureFor(candidate)] },
    }).matches.length,
    1,
  )
})

test('pages the exact 300-counter prefix across sorted conditional keysets', () => {
  const first = authority({ conditionId: 'cd'.repeat(32) })
  const second = authority({ conditionId: CONDITION_ID })
  const page = plan({ keysets: [second, first], maxOutputs: 299 })
  assert.equal(page.candidates.length, 299)
  assert.equal(page.candidates[0]?.counter, 0)
  assert.equal(page.candidates.at(-1)?.counter, 298)
  assert.deepEqual(page.nextCursor, { nextKeysetIndex: 0, nextCounter: 299 })

  const boundary = plan({ keysets: [second, first], maxOutputs: 2, cursor: page.nextCursor })
  assert.deepEqual(
    boundary.candidates.map(({ keysetId, counter }) => ({ keysetId, counter })),
    [
      { keysetId: first.id, counter: 299 },
      { keysetId: second.id, counter: 0 },
    ],
  )
  assert.deepEqual(boundary.nextCursor, { nextKeysetIndex: 1, nextCounter: 1 })
})

test('covers every prefix counter for multiple conditional keysets', () => {
  const first = authority({ conditionId: 'cd'.repeat(32) })
  const second = authority({ conditionId: CONDITION_ID })
  const page = plan({ keysets: [first, second], maxOutputs: 600 })
  assert.equal(page.candidates.length, CONDITIONAL_KEYSET_DISCOVERY_PREFIX_COUNTERS * 2)
  assert.equal(page.nextCursor, null)
  for (const keyset of [first, second]) {
    const counters = page.candidates
      .filter((candidate) => candidate.keysetId === keyset.id)
      .map(({ counter }) => counter)
    assert.deepEqual(
      counters,
      Array.from({ length: 300 }, (_, counter) => counter),
    )
  }
})

test('binds a reordered NUT-09 subset by exact blinded output identity', () => {
  const candidates = plan({ maxOutputs: 5 }).candidates
  const late = candidates[3]!
  const early = candidates[0]!
  const response = bindConditionalKeysetSeedRecoveryResponse({
    candidates,
    response: {
      outputs: [restoreOutput(late), restoreOutput(early)],
      signatures: [signatureFor(late), signatureFor(early)],
    },
  })
  assert.deepEqual(
    response.matches.map(({ candidate }) => candidate.counter),
    [3, 0],
  )
  assert.deepEqual([...response.discoveredKeysetIds], [late.keysetId])
})

test('rejects unknown, duplicate, and mismatched NUT-09 response rows', () => {
  const candidates = plan({ maxOutputs: 3 }).candidates
  const first = candidates[0]!
  assert.throws(
    () =>
      bindConditionalKeysetSeedRecoveryResponse({
        candidates: [first, first],
        response: { outputs: [], signatures: [] },
      }),
    /candidates are duplicated/,
  )
  assert.throws(
    () =>
      bindConditionalKeysetSeedRecoveryResponse({
        candidates,
        response: {
          outputs: [{ ...restoreOutput(first), B_: '02' + '00'.repeat(32) }],
          signatures: [signatureFor(first)],
        },
      }),
    /output is foreign/,
  )
  assert.throws(
    () =>
      bindConditionalKeysetSeedRecoveryResponse({
        candidates,
        response: {
          outputs: [restoreOutput(first), restoreOutput(first)],
          signatures: [signatureFor(first), signatureFor(first)],
        },
      }),
    /output is duplicated/,
  )
  assert.throws(
    () =>
      bindConditionalKeysetSeedRecoveryResponse({
        candidates,
        response: {
          outputs: [restoreOutput(first)],
          signatures: [
            { ...signatureFor(first), id: authority({ conditionId: 'cd'.repeat(32) }).id },
          ],
        },
      }),
    /does not match/,
  )
  assert.throws(
    () =>
      bindConditionalKeysetSeedRecoveryResponse({
        candidates,
        response: {
          outputs: [{ ...restoreOutput(first), amount: Amount.from(2) }],
          signatures: [signatureFor(first)],
        },
      }),
    /does not match/,
  )
  assert.throws(
    () =>
      bindConditionalKeysetSeedRecoveryResponse({
        candidates,
        response: {
          outputs: [restoreOutput(first)],
          signatures: [{ ...signatureFor(first), amount: Amount.from(4) }],
        },
      }),
    /does not match/,
  )
  assert.throws(
    () =>
      bindConditionalKeysetSeedRecoveryResponse({
        candidates,
        response: { outputs: [restoreOutput(first)], signatures: [] },
      }),
    /response is invalid/,
  )
})

test('has deterministic page material and bounded page properties', () => {
  const keysets = [authority(), authority({ conditionId: 'cd'.repeat(32) })]
  const first = plan({ keysets, maxOutputs: 23 })
  const repeated = plan({ keysets, maxOutputs: 23 })
  assert.deepEqual(
    first.candidates.map(({ keysetId, counter, blindedOutput }) => [
      keysetId,
      counter,
      blindedOutput.B_,
    ]),
    repeated.candidates.map(({ keysetId, counter, blindedOutput }) => [
      keysetId,
      counter,
      blindedOutput.B_,
    ]),
  )
  for (const maxOutputs of boundedIntegers()) {
    const candidates = collectPages(keysets, maxOutputs)
    assert.equal(candidates.length, 600)
    assert.equal(new Set(candidates.map(({ blindedOutput }) => blindedOutput.B_)).size, 600)
  }
})

function authority(input: { conditionId?: string; outcomeCollection?: string } = {}) {
  const conditionId = input.conditionId ?? CONDITION_ID
  const outcomeCollection = input.outcomeCollection ?? 'NO|YES'
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({ conditionId, outcomeCollection })
  return {
    id: deriveConditionalKeysetId({
      keys: KEYS,
      unit: 'msat',
      input_fee_ppk: 100,
      final_expiry: 100,
      conditionId,
      outcomeCollectionId,
    }),
    unit: 'msat',
    active: false,
    input_fee_ppk: 100,
    final_expiry: 100,
    condition_id: conditionId,
    outcome_collection: outcomeCollection,
    outcome_collection_id: outcomeCollectionId,
    registered_at: 1,
    keys: KEYS,
  }
}

function authorityWithoutOptionalFees() {
  const outcomeCollection = 'NO|YES'
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId: CONDITION_ID,
    outcomeCollection,
  })
  return {
    id: deriveConditionalKeysetId({
      keys: KEYS,
      unit: 'msat',
      conditionId: CONDITION_ID,
      outcomeCollectionId,
    }),
    unit: 'msat',
    active: false,
    condition_id: CONDITION_ID,
    outcome_collection: outcomeCollection,
    outcome_collection_id: outcomeCollectionId,
    registered_at: 1,
    keys: { ...KEYS },
  }
}

function plan(input: {
  keysets?: readonly ReturnType<typeof authority>[]
  maxOutputs: number
  cursor?: unknown
}) {
  return planConditionalKeysetSeedRecoveryPage({
    seed: SEED,
    keysets: (input.keysets ?? [authority()]).map(validateConditionalKeysetSeedRecoveryAuthority),
    maxOutputs: input.maxOutputs,
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
  })
}

function restoreOutput(candidate: ConditionalKeysetSeedRecoveryCandidate) {
  return { ...candidate.blindedOutput, amount: Amount.from(0) }
}

function signatureFor(candidate: ConditionalKeysetSeedRecoveryCandidate) {
  return { id: candidate.keysetId, amount: Amount.from(2), C_: PUBLIC_KEY }
}

function collectPages(
  keysets: readonly ReturnType<typeof authority>[],
  maxOutputs: number,
): ConditionalKeysetSeedRecoveryCandidate[] {
  const candidates: ConditionalKeysetSeedRecoveryCandidate[] = []
  let cursor: unknown = undefined
  do {
    const page = plan({ keysets, maxOutputs, cursor })
    candidates.push(...page.candidates)
    cursor = page.nextCursor
  } while (cursor !== null)
  return candidates
}

function* boundedIntegers(): Iterable<number> {
  let state = 17
  for (let index = 0; index < 12; index += 1) {
    state = (state * 1_103_515_245 + 12_345) >>> 0
    yield 1 + (state % 257)
  }
}
