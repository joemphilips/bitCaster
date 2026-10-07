import assert from 'node:assert/strict'
import test from 'node:test'
import type { components } from '../src/generated/api.ts'
import {
  MAX_MARKET_CREATION_METADATA_JSON_CODE_UNITS,
  MAX_MARKET_CREATION_MATURITY_EPOCH,
  assertMarketCreationMetadataSize,
  normalizeMarketCreationInput,
  type MarketCreationInput,
} from '../src/marketCreationInput.ts'

function validInput(overrides: Partial<MarketCreationInput> = {}): MarketCreationInput {
  return {
    title: 'Test market',
    description: 'Test description',
    outcomeType: 'yesno',
    outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
    maturityEpoch: 1_800_000_000,
    categoryTags: ['politics'],
    baseAsset: 'sat',
    ...overrides,
  }
}

test('normalizes exact binary labels and preserves metadata and mint-tag order', () => {
  const result = normalizeMarketCreationInput(validInput())

  assert.deepEqual(result.outcomeLabels, ['Yes', 'No'])
  assert.deepEqual(result.metadata, {
    title: 'Test market',
    description: 'Test description',
    outcomes: [{ name: 'Yes' }, { name: 'No' }],
    outcomeType: 'yesno',
    baseAsset: 'sat',
    categoryTags: ['politics'],
  })
  assert.deepEqual(result.mintTags, [
    ['title', 'Test market'],
    ['description', 'Test description'],
    ['t', 'politics'],
  ])
  assert.equal(result.maturityEpoch, 1_800_000_000)
  assert.equal(result.collateralUnit, 'msat')
  assert.equal('oracleAnnouncementHex' in result.metadata, false)
})

test('preserves categorical label order and includes only valid categorical colors', () => {
  const result = normalizeMarketCreationInput(
    validInput({
      outcomeType: 'categorical',
      outcomeDetails: [
        { name: 'Alpha', color: '#aBc123' },
        { name: 'Beta', color: 'red' },
        { name: 'Gamma', color: '#ABCDEF' },
      ],
    }),
  )

  assert.deepEqual(result.outcomeLabels, ['Alpha', 'Beta', 'Gamma'])
  assert.deepEqual(result.metadata.outcomes, [
    { name: 'Alpha', color: '#aBc123' },
    { name: 'Beta' },
    { name: 'Gamma', color: '#ABCDEF' },
  ])
})

test('omits categorical colors for binary metadata', () => {
  const result = normalizeMarketCreationInput(
    validInput({ outcomeDetails: [{ name: 'Yes', color: '#aabbcc' }, { name: 'No' }] }),
  )

  assert.deepEqual(result.metadata.outcomes, [{ name: 'Yes' }, { name: 'No' }])
})

test('refuses binary labels that differ from the exact canonical Yes/No identity', () => {
  assert.throws(
    () =>
      normalizeMarketCreationInput(
        validInput({ outcomeDetails: [{ name: 'YES' }, { name: 'NO' }] }),
      ),
    /exactly Yes followed by No/,
  )
  assert.throws(
    () =>
      normalizeMarketCreationInput(
        validInput({ outcomeDetails: [{ name: 'No' }, { name: 'Yes' }] }),
      ),
    /exactly Yes followed by No/,
  )
})

test('rejects unsupported, malformed, or out-of-range creation inputs', () => {
  const invalidInputs: Array<[string, Partial<MarketCreationInput>]> = [
    ['blank title', { title: '   ' }],
    ['blank description', { description: '\n  ' }],
    ['numeric outcomes', { outcomeType: 'numeric' }],
    ['unsupported outcome type', { outcomeType: 'other' as MarketCreationInput['outcomeType'] }],
    ['one outcome', { outcomeDetails: [{ name: 'Yes' }] }],
    ['nine outcomes', { outcomeDetails: Array.from({ length: 9 }, (_, i) => ({ name: `O${i}` })) }],
    ['duplicate labels', { outcomeDetails: [{ name: 'Alpha' }, { name: 'Alpha' }] }],
    ['non-ASCII label', { outcomeDetails: [{ name: 'Å' }, { name: 'No' }] }],
    ['punctuation in label', { outcomeDetails: [{ name: 'New-York' }, { name: 'No' }] }],
    ['overlong label', { outcomeDetails: [{ name: 'A'.repeat(192) }, { name: 'No' }] }],
    ['zero maturity', { maturityEpoch: 0 }],
    ['fractional maturity', { maturityEpoch: 1.5 }],
    ['unsafe maturity', { maturityEpoch: Number.MAX_SAFE_INTEGER + 1 }],
    ['maturity above U32', { maturityEpoch: MAX_MARKET_CREATION_MATURITY_EPOCH + 1 }],
    ['unsupported base asset', { baseAsset: 'msat' }],
    ['non-string category tag', { categoryTags: ['politics', 1] as unknown as string[] }],
  ]

  for (const [label, overrides] of invalidInputs) {
    assert.throws(() => normalizeMarketCreationInput(validInput(overrides)), undefined, label)
  }
})

test('metadata size uses the engine JSON UTF-16 code-unit boundary', () => {
  const metadata: components['schemas']['CreateMarketRequest'] = {
    title: '',
    description: 'Description',
    outcomes: [{ name: 'Yes' }, { name: 'No' }],
    outcomeType: 'yesno',
    baseAsset: 'sat',
    oracleAnnouncementHex: 'abcd',
  }
  const paddingLength =
    MAX_MARKET_CREATION_METADATA_JSON_CODE_UNITS - JSON.stringify(metadata).length
  const exact = { ...metadata, title: 'é'.repeat(paddingLength) }
  assert.equal(JSON.stringify(exact).length, MAX_MARKET_CREATION_METADATA_JSON_CODE_UNITS)
  assert.doesNotThrow(() => assertMarketCreationMetadataSize(exact))
  assert.throws(
    () => assertMarketCreationMetadataSize({ ...exact, title: `${exact.title}é` }),
    /64 KB engine limit/,
  )
})
