import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  DEFAULT_SAT_MARKET_DIVISIBILITY,
  DEFAULT_USD_MARKET_DIVISIBILITY,
  collateralScaleForUnit,
  defaultMarketDivisibility,
  defaultCollateralUnit,
  formatPricePercentage,
  formatAmount,
  formatMarketSubunits,
  formatPricePercent,
  formatShareFace,
  formatWholeShareFaceValue,
  marketSubunitLabel,
  marketUnitLabel,
  normalizeMarketBaseAsset,
  normalizeMarketCreationLiquiditySats,
  normalizeMarketDivisibility,
  isCollateralUnitOf,
  parseMarketBaseAsset,
  quotePaymentSubunits,
  validatePriceNumerator,
  validateWholeShareFaceAmount,
} from '../src/marketUnits.ts'

test('normalizes market unit defaults', () => {
  assert.equal(normalizeMarketBaseAsset(undefined), 'sat')
  assert.equal(normalizeMarketBaseAsset('USD'), 'usd')
  assert.equal(normalizeMarketBaseAsset('bogus'), 'sat')
  assert.equal(normalizeMarketDivisibility(undefined), DEFAULT_SAT_MARKET_DIVISIBILITY)
  assert.equal(DEFAULT_SAT_MARKET_DIVISIBILITY, 10_000)
  assert.equal(DEFAULT_USD_MARKET_DIVISIBILITY, 1_000)
  assert.equal(defaultMarketDivisibility('sat'), 10_000)
  assert.equal(defaultMarketDivisibility('usd'), 1_000)
  assert.equal(normalizeMarketDivisibility(100), 100)
  assert.equal(normalizeMarketDivisibility(1_000), 1_000)
  assert.equal(normalizeMarketDivisibility(250), 250)
  assert.equal(normalizeMarketDivisibility(99), 99)
  assert.equal(normalizeMarketDivisibility(10_000), 10_000)
  assert.equal(normalizeMarketDivisibility(1_000_001), 1_000_001)
  assert.equal(normalizeMarketDivisibility(0), DEFAULT_SAT_MARKET_DIVISIBILITY)
  assert.equal(normalizeMarketDivisibility(0, 'usd'), DEFAULT_USD_MARKET_DIVISIBILITY)
  assert.equal(normalizeMarketDivisibility(1.5), DEFAULT_SAT_MARKET_DIVISIBILITY)
  assert.equal(marketUnitLabel('usd'), 'USD')
  assert.equal(marketUnitLabel('sat'), 'sats')
})

test('parses collateral units as market base assets', () => {
  assert.equal(parseMarketBaseAsset('msat'), 'sat')
  assert.equal(parseMarketBaseAsset('MSAT'), 'sat')
  assert.equal(parseMarketBaseAsset('Milli-Cent'), null)
  assert.equal(parseMarketBaseAsset('btc'), null)
})

test('checks collateral unit compatibility and scale', () => {
  assert.equal(isCollateralUnitOf('msat', 'sat'), true)
  assert.equal(isCollateralUnitOf('usd', 'usd'), true)
  assert.equal(isCollateralUnitOf('milli-cent', 'usd'), false)
  assert.equal(isCollateralUnitOf('sat', 'usd'), false)
  assert.equal(isCollateralUnitOf(null, 'sat'), false)

  assert.equal(collateralScaleForUnit('sat'), 1)
  assert.equal(collateralScaleForUnit('msat'), 1_000)
  assert.equal(collateralScaleForUnit('usd'), 1)
  assert.throws(() => collateralScaleForUnit('milli-cent'))
  assert.throws(() => collateralScaleForUnit('unknown'))
  assert.throws(() => collateralScaleForUnit(null))
  assert.throws(() => collateralScaleForUnit(undefined))
})

test('formats system market display units', () => {
  assert.equal(defaultCollateralUnit('sat'), 'msat')
  assert.equal(defaultCollateralUnit('usd'), 'usd')
  assert.equal(defaultCollateralUnit(null), 'msat')
  assert.equal(defaultCollateralUnit('jpy'), 'msat')
  assert.equal(formatPricePercentage(500, 1_000), '50.00%')
  assert.equal(formatPricePercentage(532, 1_000), '53.20%')
  assert.equal(formatPricePercentage(1, 1_000), '0.10%')
  assert.equal(formatShareFace('sat', 10_000), '10 sats')
  assert.equal(formatShareFace('sat', 100), '0.1 sats')
  assert.equal(formatShareFace('usd', 1_000), '$10.00')
})

test('normalizes initial AMM liquidity to sat markets only', () => {
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: 10_000 }), 10_000)
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'usd', liquiditySats: 10_000 }), 0)
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: -1 }), 0)
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: 1.5 }), 0)
})

test('formats market subunits without confusing cents for dollars', () => {
  assert.equal(formatAmount(50_000, 'sat'), '50 sats')
  assert.equal(formatAmount(50, 'usd'), '$0.50')
  assert.equal(formatAmount(15_000, 'usd'), '$150.00')
  assert.equal(formatAmount(1_234, 'sat'), '1.234 sats')
  assert.equal(formatMarketSubunits(50_000, 'sat'), '50 sats')
  assert.equal(formatMarketSubunits(-50_000, 'sat'), '-50 sats')
  assert.equal(formatMarketSubunits(10_000, 'sat'), '10 sats')
  assert.equal(formatMarketSubunits(1_500, 'usd'), '$15.00')
  assert.equal(formatMarketSubunits(50, 'usd'), '$0.50')
  assert.equal(formatMarketSubunits(-50, 'usd'), '-$0.50')
  assert.equal(formatMarketSubunits(100, 'usd'), '$1.00')
  assert.equal(marketSubunitLabel('usd'), 'cents')
  assert.equal(marketSubunitLabel('sat'), 'sats')
  assert.equal(formatWholeShareFaceValue({ baseAsset: 'usd', divisibility: 1_000 }), '$10.00')
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
      }),
    999_000,
  )
  assert.throws(
    () =>
      quotePaymentSubunits({
        faceAmountSubunits: 1_500_001,
        priceNumerator: 333,
        divisibility: 1_000,
      }),
    /whole-share/,
  )
  assert.equal(
      quotePaymentSubunits({
        faceAmountSubunits: 1_000_000,
        priceNumerator: 500,
        divisibility: 1_000,
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
      }),
      vector.quotePaymentSubunits,
      vector.name,
    )
    assert.equal(
      quotePaymentSubunits({
        faceAmountSubunits: vector.faceAmountSubunits,
        priceNumerator: vector.divisibility - vector.priceSubunits,
        divisibility: vector.divisibility,
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
