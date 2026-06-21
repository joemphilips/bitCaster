import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_MARKET_DIVISIBILITY,
  SYSTEM_DIVISIBILITY,
  defaultCollateralUnit,
  formatPricePercentage,
  formatMarketSubunits,
  formatPricePercent,
  formatShareFace,
  formatWholeShareFaceValue,
  marketSubunitLabel,
  marketUnitLabel,
  normalizeMarketBaseAsset,
  normalizeMarketCreationLiquiditySats,
  normalizeMarketDivisibility,
  quotePaymentSubunits,
  shareFaceSubunits,
  validatePriceNumerator,
  validateWholeShareFaceAmount,
} from '../src/marketUnits.ts'

test('normalizes market unit defaults', () => {
  assert.equal(normalizeMarketBaseAsset(undefined), 'sat')
  assert.equal(normalizeMarketBaseAsset('USD'), 'usd')
  assert.equal(normalizeMarketBaseAsset('bogus'), 'sat')
  assert.equal(normalizeMarketDivisibility(undefined), DEFAULT_MARKET_DIVISIBILITY)
  assert.equal(DEFAULT_MARKET_DIVISIBILITY, 10_000)
  assert.equal(SYSTEM_DIVISIBILITY, 10_000)
  assert.equal(normalizeMarketDivisibility(100), 100)
  assert.equal(normalizeMarketDivisibility(1_000), 1_000)
  assert.equal(normalizeMarketDivisibility(250), 250)
  assert.equal(normalizeMarketDivisibility(99), 99)
  assert.equal(normalizeMarketDivisibility(10_000), 10_000)
  assert.equal(normalizeMarketDivisibility(1_000_001), 1_000_001)
  assert.equal(normalizeMarketDivisibility(0), DEFAULT_MARKET_DIVISIBILITY)
  assert.equal(normalizeMarketDivisibility(1.5), DEFAULT_MARKET_DIVISIBILITY)
  assert.equal(marketUnitLabel('usd'), 'USD')
  assert.equal(marketUnitLabel('sat'), 'sats')
})

test('formats system market display units', () => {
  assert.equal(defaultCollateralUnit('sat'), 'msat')
  assert.equal(defaultCollateralUnit('usd'), 'milli-cent')
  assert.equal(defaultCollateralUnit(null), 'msat')
  assert.equal(defaultCollateralUnit('jpy'), 'msat')
  assert.equal(formatPricePercentage(500, 1_000), '50.00%')
  assert.equal(formatPricePercentage(532, 1_000), '53.20%')
  assert.equal(formatPricePercentage(1, 1_000), '0.10%')
  assert.equal(shareFaceSubunits('sat'), 1_000_000)
  assert.equal(shareFaceSubunits('usd'), 100_000)
  assert.equal(formatShareFace('sat'), '1000 sats')
  assert.equal(formatShareFace('usd'), '$1.00')
})

test('normalizes initial AMM liquidity to sat markets only', () => {
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: 10_000 }), 10_000)
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'usd', liquiditySats: 10_000 }), 0)
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: -1 }), 0)
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: 1.5 }), 0)
})

test('formats market subunits without confusing cents for dollars', () => {
  assert.equal(formatMarketSubunits(50_000, 'sat'), '50 sats')
  assert.equal(formatMarketSubunits(-50_000, 'sat'), '-50 sats')
  assert.equal(formatMarketSubunits(50_000, 'usd'), '$0.50')
  assert.equal(formatMarketSubunits(-50_000, 'usd'), '-$0.50')
  assert.equal(formatMarketSubunits(100_000, 'usd'), '$1.00')
  assert.equal(marketSubunitLabel('usd'), 'milli-cents')
  assert.equal(marketSubunitLabel('sat'), 'msat')
  assert.equal(formatWholeShareFaceValue({ baseAsset: 'usd', divisibility: 1_000 }), '$1.00')
  assert.equal(formatPricePercent(500, 1_000), '50.00%')
  assert.equal(formatPricePercent(50, 1_000), '5.00%')
  assert.equal(formatPricePercent(1, 1_000), '0.10%')
})

test('validates price numerator and whole-share face amount', () => {
  assert.equal(validatePriceNumerator(1, 1_000), true)
  assert.equal(validatePriceNumerator(999, 1_000), true)
  assert.equal(validatePriceNumerator(1_000, 1_000), false)
  assert.equal(validatePriceNumerator(5_000, 10_000), true)
  assert.equal(validatePriceNumerator(10_000, 10_000), false)
  assert.equal(validateWholeShareFaceAmount(2_000_000, 1_000_000), true)
  assert.equal(validateWholeShareFaceAmount(1_500_000, 1_000_000), false)
  assert.equal(validateWholeShareFaceAmount(100_000, 100_000), true)
  assert.equal(validateWholeShareFaceAmount(50_000, 100_000), false)
  assert.equal(validateWholeShareFaceAmount(10_000, 1_000_000), false)
})

test('computes quote payment by dividing into whole shares first', () => {
  assert.equal(
      quotePaymentSubunits({
        faceAmountSubunits: 3_000_000,
        priceNumerator: 333,
        divisibility: 1_000,
        shareFaceSubunits: 1_000_000,
      }),
    999_000,
  )
  assert.throws(
    () =>
      quotePaymentSubunits({
        faceAmountSubunits: 1_500_000,
        priceNumerator: 333,
        divisibility: 1_000,
        shareFaceSubunits: 1_000_000,
      }),
    /whole-share/,
  )
  assert.equal(
      quotePaymentSubunits({
        faceAmountSubunits: 1_000_000,
        priceNumerator: 500,
        divisibility: 1_000,
        shareFaceSubunits: 1_000_000,
      }),
    500_000,
  )
})

test('matches shared market-unit settlement vectors', () => {
  for (const vector of sharedMarketUnitSettlementVectors()) {
    assert.equal(
      quotePaymentSubunits({
        faceAmountSubunits: vector.faceAmountSubunits,
        priceNumerator: vector.priceSubunits,
        divisibility: vector.divisibility,
        shareFaceSubunits: shareFaceSubunits(vector.baseAsset),
      }),
      vector.quotePaymentSubunits,
      vector.name,
    )
    assert.equal(
      quotePaymentSubunits({
        faceAmountSubunits: vector.faceAmountSubunits,
        priceNumerator: vector.divisibility - vector.priceSubunits,
        divisibility: vector.divisibility,
        shareFaceSubunits: shareFaceSubunits(vector.baseAsset),
      }),
      vector.complementQuotePaymentSubunits,
      `${vector.name} complement`,
    )
  }
})

interface MarketUnitSettlementVector {
  name: string
  baseAsset: string
  divisibility: number
  faceAmountSubunits: number
  priceSubunits: number
  quotePaymentSubunits: number
  complementQuotePaymentSubunits: number
}

function sharedMarketUnitSettlementVectors(): MarketUnitSettlementVector[] {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../../test-vectors/market-unit-settlement.json', import.meta.url),
      'utf8',
    ),
  ) as { vectors: MarketUnitSettlementVector[] }
  return fixture.vectors
}
