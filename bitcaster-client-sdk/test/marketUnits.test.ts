import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_MARKET_DIVISIBILITY,
  formatMarketSubunits,
  formatPricePercent,
  isValidMarketDivisibility,
  formatWholeShareFaceValue,
  isSupportedMarketDivisibility,
  marketSubunitLabel,
  marketUnitLabel,
  normalizeMarketBaseAsset,
  normalizeMarketCreationLiquiditySats,
  normalizeMarketDivisibility,
  quotePaymentSubunits,
  validatePriceNumerator,
  validateWholeShareFaceAmount,
} from '../src/marketUnits.ts'

test('normalizes market unit defaults', () => {
  assert.equal(normalizeMarketBaseAsset(undefined), 'sat')
  assert.equal(normalizeMarketBaseAsset('USD'), 'usd')
  assert.equal(normalizeMarketBaseAsset('bogus'), 'sat')
  assert.equal(normalizeMarketDivisibility(undefined), DEFAULT_MARKET_DIVISIBILITY)
  assert.equal(normalizeMarketDivisibility(1_000), 1_000)
  assert.equal(normalizeMarketDivisibility(250), 250)
  assert.equal(normalizeMarketDivisibility(99), DEFAULT_MARKET_DIVISIBILITY)
  assert.equal(normalizeMarketDivisibility(1_000_001), DEFAULT_MARKET_DIVISIBILITY)
  assert.equal(marketUnitLabel('usd'), 'USD')
  assert.equal(marketUnitLabel('sat'), 'sats')
  assert.equal(isValidMarketDivisibility(250), true)
  assert.equal(isValidMarketDivisibility(99), false)
  assert.equal(isSupportedMarketDivisibility(1_000), true)
  assert.equal(isSupportedMarketDivisibility(123), false)
})

test('normalizes initial AMM liquidity to sat markets only', () => {
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: 10_000 }), 10_000)
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'usd', liquiditySats: 10_000 }), 0)
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: -1 }), 0)
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: 1.5 }), 0)
})

test('formats market subunits without confusing cents for dollars', () => {
  assert.equal(formatMarketSubunits(50, 'sat'), '50 sats')
  assert.equal(formatMarketSubunits(-50, 'sat'), '-50 sats')
  assert.equal(formatMarketSubunits(50, 'usd'), '$0.50')
  assert.equal(formatMarketSubunits(-50, 'usd'), '-$0.50')
  assert.equal(formatMarketSubunits(100, 'usd'), '$1.00')
  assert.equal(marketSubunitLabel('usd'), 'cents')
  assert.equal(formatWholeShareFaceValue({ baseAsset: 'usd', divisibility: 100 }), '$1.00')
  assert.equal(formatPricePercent(50, 100), '50.0%')
  assert.equal(formatPricePercent(50, 1_000), '5.0%')
  assert.equal(formatPricePercent(1, 10_000), '0.01%')
})

test('validates price numerator and whole-share face amount', () => {
  assert.equal(validatePriceNumerator(1, 1_000), true)
  assert.equal(validatePriceNumerator(999, 1_000), true)
  assert.equal(validatePriceNumerator(1_000, 1_000), false)
  assert.equal(validateWholeShareFaceAmount(2_000, 1_000), true)
  assert.equal(validateWholeShareFaceAmount(1_500, 1_000), false)
})

test('computes quote payment by dividing into whole shares first', () => {
  assert.equal(
    quotePaymentSubunits({
      faceAmountSubunits: 3_000,
      priceNumerator: 333,
      divisibility: 1_000,
    }),
    999,
  )
  assert.throws(
    () =>
      quotePaymentSubunits({
        faceAmountSubunits: 1_500,
        priceNumerator: 333,
        divisibility: 1_000,
      }),
    /whole-share/,
  )
})
