import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  MARKET_CATALOGUE_PAGE_IDS_MAX,
  marketCatalogueIdBatches,
} from '../src/marketCatalogueBatches.ts'

describe('marketCatalogueIdBatches', () => {
  test('one batch holds at most the 50 rows of one catalogue page', () => {
    assert.equal(MARKET_CATALOGUE_PAGE_IDS_MAX, 50)
  })

  test('splits distinct IDs into consecutive batches of at most 50', () => {
    const ids = Array.from({ length: 120 }, (_, index) => `condition-${index}`)

    const batches = marketCatalogueIdBatches(ids)

    assert.deepEqual(
      batches.map((batch) => batch.length),
      [50, 50, 20],
    )
    assert.deepEqual(batches.flat(), ids)
  })

  test('sends a repeated ID once and sends nothing for no IDs', () => {
    assert.deepEqual(marketCatalogueIdBatches(['b', 'a', 'b', 'a']), [['b', 'a']])
    assert.deepEqual(marketCatalogueIdBatches([]), [])
  })
})
