import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadCtfRangeMintKeys,
  loadCtfRangeMintMetadata,
  type CtfRangeMintMetadataClient,
} from '../src/ctfRangeMintMetadata.ts'

const MINT_URL = 'https://mint.example'
const CONDITION_ID = 'condition-1'
const REGULAR_KEYSET_ID = '0011223344556677'
const CONDITIONAL_KEYSET_ID = '8899aabbccddeeff'
const PUBLIC_KEY = `02${'11'.repeat(32)}`

test('loads one bounded exact range-settlement authority for every client', async () => {
  const metadata = await loadCtfRangeMintMetadata({
    mint: mint(),
    mintUrl: MINT_URL,
    conditionId: CONDITION_ID,
    observedAt: 1_000,
    allowInsecureLoopbackHttp: false,
  })

  assert.equal(metadata.regular[0]?.id, REGULAR_KEYSET_ID)
  assert.equal(metadata.conditional[0]?.id, CONDITIONAL_KEYSET_ID)
  assert.equal(metadata.conditional[0]?.conditionId, CONDITION_ID)
  assert.equal(metadata.maxInputs, 64)
  assert.equal(metadata.maxOutputs, 256)
  assert.equal(metadata.maxRequestBytes, 2_097_152)
  assert.equal(metadata.maxPoolEntries, 128)
  assert.deepEqual(metadata.observation.conditionKeysetIds, [CONDITIONAL_KEYSET_ID])
})

test('clamps mint limits to durable output and artifact authority bounds', async () => {
  const client = mint()
  client.getInfo = async () =>
    ({
      nuts: {
        'CTF-split-merge': {
          supported: true,
          partial_fill: true,
          max_inputs: 64,
          max_outputs: 512,
          max_request_bytes: 32 * 1_024 * 1_024,
          max_pool_entries: 128,
          max_expiry_seconds: 3_600,
        },
      },
    }) as never
  const metadata = await loadCtfRangeMintMetadata({
    mint: client,
    mintUrl: MINT_URL,
    conditionId: CONDITION_ID,
    observedAt: 1_000,
    allowInsecureLoopbackHttp: false,
  })
  assert.equal(metadata.maxOutputs, 256)
  assert.equal(metadata.maxRequestBytes, 16 * 1_024 * 1_024)
})

test('rejects foreign conditions and missing exact key responses', async () => {
  const foreign = mint()
  foreign.getCtfCondition = async () => ({
    condition_id: 'foreign',
    keysets: { YES: CONDITIONAL_KEYSET_ID },
  })
  await assert.rejects(
    loadCtfRangeMintMetadata({
      mint: foreign,
      mintUrl: MINT_URL,
      conditionId: CONDITION_ID,
      observedAt: 1_000,
      allowInsecureLoopbackHttp: false,
    }),
    /foreign CTF condition/,
  )

  await assert.rejects(
    loadCtfRangeMintKeys({ getKeys: async () => ({ keysets: [] }) }, [REGULAR_KEYSET_ID]),
    /omitted keys/,
  )
})

test('rejects missing or unsafe authenticated settlement limits', async () => {
  for (const value of [undefined, 0, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = mint()
    invalid.getInfo = async () =>
      ({
        nuts: {
          'CTF-split-merge': {
            supported: true,
            partial_fill: true,
            max_inputs: 64,
            max_outputs: 256,
            max_request_bytes: value,
            max_pool_entries: 128,
            max_expiry_seconds: 3_600,
          },
        },
      }) as never
    await assert.rejects(
      loadCtfRangeMintMetadata({
        mint: invalid,
        mintUrl: MINT_URL,
        conditionId: CONDITION_ID,
        observedAt: 1_000,
        allowInsecureLoopbackHttp: false,
      }),
      /request byte limit is invalid/i,
    )
  }
})

function mint(): CtfRangeMintMetadataClient {
  return {
    getInfo: async () =>
      ({
        nuts: {
          'CTF-split-merge': {
            supported: true,
            partial_fill: true,
            max_inputs: 96,
            max_outputs: 512,
            max_request_bytes: 2_097_152,
            max_pool_entries: 256,
            max_expiry_seconds: 3_600,
          },
        },
      }) as never,
    getKeySets: async () => ({
      keysets: [
        {
          id: REGULAR_KEYSET_ID,
          unit: 'msat',
          active: true,
          input_fee_ppk: 100,
        },
      ],
    }),
    getConditionalKeysets: async () => ({
      keysets: [
        {
          id: CONDITIONAL_KEYSET_ID,
          unit: 'msat',
          active: true,
          input_fee_ppk: 100,
          condition_id: CONDITION_ID,
          outcome_collection: 'YES',
          outcome_collection_id: 'collection-yes',
        },
      ],
    }),
    getCtfCondition: async () => ({
      condition_id: CONDITION_ID,
      keysets: { YES: CONDITIONAL_KEYSET_ID },
    }),
    getKeys: async (keysetId?: string) => ({
      keysets: [
        {
          id: keysetId ?? REGULAR_KEYSET_ID,
          unit: 'msat',
          keys: { 1: PUBLIC_KEY },
        },
      ],
    }),
  }
}
