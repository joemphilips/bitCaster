import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveConditionalKeysetId, deriveKeysetId } from '@cashu/cashu-ts'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { deriveRootCtfOutcomeCollectionId } from '../src/durableCtfRangeOperation.ts'
import type { RecoveryIndexEntry } from '../src/recoveryIndexDocument.ts'
import {
  listSeedRestoreConditionKeysets,
  resolveSeedRestoreKeyset,
  type SeedRestoreKeysetMint,
} from '../src/seedPositionRestore.ts'

// The GUI restore of ADR-039 ("Restore order") scans only the listed, the
// regular and the hinted keysets. Each target needs its mint authority. A
// conditional target also needs its outcome collection, which only the mint
// listing of its condition names (the index holds the outcome collection id).

const MINT = 'https://mint.example'
const CONDITION = 'ab'.repeat(32)

function keys(salt: number): Record<string, string> {
  return Object.fromEntries(
    [1, 2, 4].map((amount) => {
      const secret = Uint8Array.from(
        { length: 32 },
        (_, index) => ((index + amount + salt) % 250) + 1,
      )
      return [String(amount), bytesToHex(secp256k1.getPublicKey(secret, true))]
    }),
  )
}

const REGULAR_KEYS = keys(1)
const REGULAR_ID = deriveKeysetId(REGULAR_KEYS, { unit: 'msat', versionByte: 1 })

function conditional(outcomeCollection: string, salt: number) {
  const outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId: CONDITION,
    outcomeCollection,
  })
  const keyset = keys(salt)
  const id = deriveConditionalKeysetId({
    keys: keyset,
    unit: 'msat',
    conditionId: CONDITION,
    outcomeCollectionId,
  })
  return {
    keys: keyset,
    descriptor: {
      id,
      unit: 'msat',
      active: true,
      condition_id: CONDITION,
      outcome_collection: outcomeCollection,
      outcome_collection_id: outcomeCollectionId,
      registered_at: 1_700_000_000,
    },
  }
}

const YES = conditional('YES', 2)
const NO = conditional('NO', 3)

function fakeMint(input: { listed?: readonly (typeof YES)[]; keysUnit?: string } = {}) {
  const listed = input.listed ?? [YES, NO]
  const calls: string[] = []
  const all = [
    { id: REGULAR_ID, unit: input.keysUnit ?? 'msat', keys: REGULAR_KEYS },
    ...[YES, NO].map(({ keys: value, descriptor }) => ({
      id: descriptor.id,
      unit: 'msat',
      keys: value,
    })),
  ]
  const mint: SeedRestoreKeysetMint = {
    async getKeys(keysetId: string) {
      calls.push(`keys ${keysetId}`)
      const keyset = all.find(({ id }) => id === keysetId)
      if (keyset === undefined) throw new Error('unknown keyset')
      return { keysets: [{ ...keyset, active: true, input_fee_ppk: 0 }] }
    },
    async getConditionalKeysets(query) {
      calls.push(`listing ${query.condition_id ?? 'all'}`)
      return { keysets: listed.map(({ descriptor }) => descriptor), next_cursor: null }
    },
  }
  return { mint, calls }
}

function lister(mint: SeedRestoreKeysetMint) {
  return (conditionId: string) =>
    listSeedRestoreConditionKeysets({ conditionId, outcomes: null, mint })
}

function conditionalEntry(keyset: typeof YES): RecoveryIndexEntry {
  return {
    kind: 'conditional',
    mintUrl: MINT,
    keysetId: keyset.descriptor.id,
    conditionId: CONDITION,
    outcomeCollectionId: keyset.descriptor.outcome_collection_id,
  }
}

test('resolves a regular keyset from the mint keys', async () => {
  const { mint } = fakeMint()
  const resolved = await resolveSeedRestoreKeyset({
    entry: { kind: 'regular', mintUrl: MINT, keysetId: REGULAR_ID },
    mint,
    conditionKeysets: lister(mint),
  })
  assert.equal(resolved.status, 'resolved')
  assert.ok(resolved.status === 'resolved')
  assert.equal(resolved.conditional, null)
  assert.deepEqual(resolved.keyset, {
    id: REGULAR_ID,
    unit: 'msat',
    keys: REGULAR_KEYS,
    inputFeePpk: 0,
    finalExpiry: null,
  })
})

test('a regular keyset of another unit is unverifiable', async () => {
  const { mint } = fakeMint({ keysUnit: 'sat' })
  const resolved = await resolveSeedRestoreKeyset({
    entry: { kind: 'regular', mintUrl: MINT, keysetId: REGULAR_ID },
    mint,
    conditionKeysets: lister(mint),
  })
  assert.deepEqual(resolved, { status: 'unverifiable' })
})

test('resolves a listed conditional keyset with the outcome collection of its condition listing', async () => {
  const { mint, calls } = fakeMint()
  const resolved = await resolveSeedRestoreKeyset({
    entry: conditionalEntry(YES),
    mint,
    conditionKeysets: lister(mint),
  })
  assert.ok(resolved.status === 'resolved')
  assert.equal(resolved.conditional?.outcomeCollection, 'YES')
  assert.equal(resolved.conditional?.conditionId, CONDITION)
  assert.equal(resolved.keyset.id, YES.descriptor.id)
  // Only the listing of the entry's condition: never the whole mint listing.
  assert.deepEqual(calls, [`keys ${YES.descriptor.id}`, `listing ${CONDITION}`])
})

test('a conditional keyset that its condition listing does not name is unverifiable', async () => {
  const { mint } = fakeMint({ listed: [NO] })
  const resolved = await resolveSeedRestoreKeyset({
    entry: conditionalEntry(YES),
    mint,
    conditionKeysets: lister(mint),
  })
  assert.deepEqual(resolved, { status: 'unverifiable' })
})

test('a conditional entry with another outcome collection id is unverifiable', async () => {
  const { mint } = fakeMint()
  const resolved = await resolveSeedRestoreKeyset({
    entry: { ...conditionalEntry(YES), outcomeCollectionId: NO.descriptor.outcome_collection_id },
    mint,
    conditionKeysets: lister(mint),
  })
  assert.deepEqual(resolved, { status: 'unverifiable' })
})

test('a keyset that the mint does not know is unverifiable', async () => {
  const { mint } = fakeMint()
  const unknown = Object.assign(new Error('Keyset is not known'), {
    name: 'MintOperationError',
    code: 12001,
  })
  const resolved = await resolveSeedRestoreKeyset({
    entry: { kind: 'regular', mintUrl: MINT, keysetId: `01${'99'.repeat(32)}` },
    mint: { ...mint, getKeys: async () => Promise.reject(unknown) },
    conditionKeysets: lister(mint),
  })
  assert.deepEqual(resolved, { status: 'unverifiable' })
})

test('a failed mint request rejects, so the caller keeps the target', async () => {
  const { mint } = fakeMint()
  await assert.rejects(
    resolveSeedRestoreKeyset({
      entry: { kind: 'regular', mintUrl: MINT, keysetId: `01${'99'.repeat(32)}` },
      mint,
      conditionKeysets: lister(mint),
    }),
    /unknown keyset/,
  )
})

test('maps the keysets of a hinted condition to restore entries', async () => {
  const { mint } = fakeMint()
  const listing = await lister(mint)(CONDITION)
  const { seedRestoreHintEntries } = await import('../src/seedPositionRestore.ts')
  assert.deepEqual(seedRestoreHintEntries(MINT, listing), [
    conditionalEntry(YES),
    conditionalEntry(NO),
  ])
})
