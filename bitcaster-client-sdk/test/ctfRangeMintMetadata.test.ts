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
  assert.equal(metadata.maxPoolEntries, 128)
  assert.deepEqual(metadata.observation.conditionKeysetIds, [CONDITIONAL_KEYSET_ID])
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

function mint(): CtfRangeMintMetadataClient {
  return {
    getInfo: async () =>
      ({
        nuts: {
          'CTF-split-merge': {
            supported: true,
            partial_fill: true,
            max_inputs: 96,
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
