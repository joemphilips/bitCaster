import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACTIVE_MARKET_CREATION_TEXT_POLICY,
  CURRENT_MARKET_CREATION_TEXT_POLICY,
  COMPACT_MARKET_CREATION_TEXT_POLICY,
  assertNewMarketCreationInput,
  inspectNewMarketCreationText,
} from '../src/marketCreationLimits.ts'
import {
  normalizeMarketCreationInput,
  MAX_MARKET_CREATION_MATURITY_EPOCH,
  type MarketCreationInput,
} from '../src/marketCreationInput.ts'
import { normalizeOracleAnnouncementTags } from '../src/oracleAnnouncementTags.ts'

const valid: MarketCreationInput = {
  title: 'Question?',
  description: 'Resolution criteria',
  categoryTags: [],
  outcomeType: 'yesno',
  outcomeDetails: [{ name: 'Yes' }, { name: 'No' }],
  maturityEpoch: 1_800_000_000,
  baseAsset: 'sat',
}

test('compatibility release keeps current new-writer limits despite compact-reader support', () => {
  assert.equal(ACTIVE_MARKET_CREATION_TEXT_POLICY, CURRENT_MARKET_CREATION_TEXT_POLICY)
  assert.deepEqual(CURRENT_MARKET_CREATION_TEXT_POLICY, {
    titleCharacters: 100,
    titleUtf8Bytes: 400,
    descriptionCharacters: 1024,
    descriptionUtf8Bytes: 1024,
    mintTagsJsonBytes: 4096,
  })
  assert.deepEqual(COMPACT_MARKET_CREATION_TEXT_POLICY, {
    titleCharacters: 200,
    titleUtf8Bytes: 800,
    descriptionCharacters: 2000,
    descriptionUtf8Bytes: 8192,
    mintTagsJsonBytes: 16384,
  })
  assert.throws(() => assertNewMarketCreationInput({ ...valid, title: 'x'.repeat(101) }), /title/)
  assert.throws(
    () => assertNewMarketCreationInput({ ...valid, description: '界'.repeat(342) }),
    /description/,
  )
})

for (const [name, policy] of [
  ['current', CURRENT_MARKET_CREATION_TEXT_POLICY],
  ['compact', COMPACT_MARKET_CREATION_TEXT_POLICY],
] as const) {
  test(`${name}: new admission accepts exact U32 maturity maximum and refuses one more`, () => {
    assert.equal(
      assertNewMarketCreationInput(
        { ...valid, maturityEpoch: MAX_MARKET_CREATION_MATURITY_EPOCH },
        policy,
      ).maturityEpoch,
      0xffff_ffff,
    )
    assert.throws(
      () =>
        assertNewMarketCreationInput(
          { ...valid, maturityEpoch: MAX_MARKET_CREATION_MATURITY_EPOCH + 1 },
          policy,
        ),
      /U32/,
    )
  })

  test(`${name}: full Unicode title survives at the boundary; one extra is rejected`, () => {
    const title = '🌦'.repeat(policy.titleCharacters)
    const inspected = inspectNewMarketCreationText({ ...valid, title }, policy)
    assert.deepEqual(inspected.title, {
      characters: policy.titleCharacters,
      utf8Bytes: policy.titleUtf8Bytes,
      issue: null,
    })
    const normalized = assertNewMarketCreationInput({ ...valid, title }, policy)
    assert.equal(normalized.metadata.title, title)
    assert.equal(normalizeOracleAnnouncementTags(title, valid.description).title, title)
    assert.throws(
      () => assertNewMarketCreationInput({ ...valid, title: title + 'a' }, policy),
      /title/,
    )
  })

  test(`${name}: serialized category total includes escaping, exactly at and over its mint bound`, () => {
    const categoryTags = ['"\\\n'.repeat(10), '']
    const initial = inspectNewMarketCreationText({ ...valid, categoryTags }, policy)
    categoryTags[1] = 'x'.repeat(policy.mintTagsJsonBytes - initial.mintTagsJsonBytes)
    const input = { ...valid, categoryTags }
    const at = inspectNewMarketCreationText(input, policy)
    assert.equal(at.mintTagsJsonBytes, policy.mintTagsJsonBytes)
    assert.equal(at.mintTagsIssue, null)
    const normalized = assertNewMarketCreationInput(input, policy)
    assert.equal(
      new TextEncoder().encode(JSON.stringify(normalized.mintTags)).length,
      policy.mintTagsJsonBytes,
    )
    categoryTags[1] += 'x'
    assert.equal(inspectNewMarketCreationText(input, policy).mintTagsIssue, 'too-large')
    assert.throws(() => assertNewMarketCreationInput(input, policy), /serialized/)
  })

  test(`${name}: malformed Unicode fails before transport replacement`, () => {
    for (const value of ['\ud800', '\udc00', 'x\ud800y', '\ud800\ud800']) {
      assert.equal(
        inspectNewMarketCreationText({ ...valid, title: value }, policy).title.issue,
        'invalid-unicode',
      )
      assert.equal(
        inspectNewMarketCreationText({ ...valid, description: value }, policy).description.issue,
        'invalid-unicode',
      )
      assert.equal(
        inspectNewMarketCreationText({ ...valid, categoryTags: [value] }, policy).mintTagsIssue,
        'invalid-unicode',
      )
      assert.throws(
        () => assertNewMarketCreationInput({ ...valid, title: value }, policy),
        /Unicode/,
      )
      assert.throws(
        () => assertNewMarketCreationInput({ ...valid, description: value }, policy),
        /Unicode/,
      )
      assert.throws(
        () => assertNewMarketCreationInput({ ...valid, categoryTags: [value] }, policy),
        /Unicode/,
      )
    }
    assert.equal(
      inspectNewMarketCreationText({ ...valid, title: 'e\u0301🌦' }, policy).title.characters,
      3,
    )
  })
}

test('current description byte boundary measures Japanese text rather than UTF-16 length', () => {
  const description = '界'.repeat(341) + 'a'
  assert.equal(inspectNewMarketCreationText({ ...valid, description }).description.utf8Bytes, 1024)
  assert.doesNotThrow(() => assertNewMarketCreationInput({ ...valid, description }))
  assert.equal(
    inspectNewMarketCreationText({ ...valid, description: description + 'a' }).description.issue,
    'too-many-bytes',
  )
})

test('compact profile supports full Japanese and emoji descriptions without enabling them by default', () => {
  for (const description of [
    '界'.repeat(2000),
    '🌦'.repeat(2000),
    '\u0001'.repeat(2000),
    '"\\'.repeat(1000),
  ]) {
    assert.doesNotThrow(() =>
      assertNewMarketCreationInput({ ...valid, description }, COMPACT_MARKET_CREATION_TEXT_POLICY),
    )
    assert.throws(() => assertNewMarketCreationInput({ ...valid, description }), /description/)
    assert.throws(
      () =>
        assertNewMarketCreationInput(
          { ...valid, description: description + 'a' },
          COMPACT_MARKET_CREATION_TEXT_POLICY,
        ),
      /description/,
    )
  }
})

test('retained input normalization remains independent of new-writer limits', () => {
  const retained = { ...valid, title: 'x'.repeat(500), description: '界'.repeat(3000) }
  assert.equal(normalizeMarketCreationInput(retained).metadata.description, retained.description)
  assert.throws(() => assertNewMarketCreationInput(retained), /title/)
})
