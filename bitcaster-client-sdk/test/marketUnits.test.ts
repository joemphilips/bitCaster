import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  CTF_COLLATERAL_UNIT,
  DEFAULT_SAT_MARKET_DIVISIBILITY,
  NUMERIC_MARKET_DIVISIBILITY,
  bufferSubunits,
  cashuAmountToMarketSubunits,
  collateralScaleForUnit,
  defaultCollateralUnit,
  defaultMarketDivisibility,
  estimatedSettlementFeeSubunits,
  formatAmount,
  formatMarketSubunits,
  formatPricePercent,
  formatPricePercentage,
  formatShareFace,
  formatWholeShareFaceValue,
  isCollateralUnitOf,
  marketSubunitLabel,
  marketUnitLabel,
  normalizeMarketBaseAsset,
  normalizeMarketCreationLiquiditySats,
  normalizeMarketDivisibility,
  parseCashuProofUnit,
  parseMarketBaseAsset,
  parseMarketDivisibility,
  quotePaymentSubunits,
  validatePriceNumerator,
  validateWholeShareFaceAmount,
} from '../src/marketUnits.ts'

test('accepts only the exact sat product base asset', () => {
  assert.equal(parseMarketBaseAsset('sat'), 'sat')
  for (const value of [undefined, null, '', 'SAT', ' sat', 'sat ', 'msat', 'usd', 'jpy']) {
    assert.equal(parseMarketBaseAsset(value), null)
    assert.throws(() => normalizeMarketBaseAsset(value), /unsupported base asset/)
  }
})

test('accepts only exact sat and msat proof units', () => {
  assert.equal(parseCashuProofUnit('sat'), 'sat')
  assert.equal(parseCashuProofUnit('msat'), 'msat')
  for (const value of [undefined, null, '', 'SAT', 'MSAT', ' msat', 'usd', 'jpy']) {
    assert.equal(parseCashuProofUnit(value), null)
  }

  assert.equal(isCollateralUnitOf('sat', 'sat'), true)
  assert.equal(isCollateralUnitOf('msat', 'sat'), true)
  assert.equal(isCollateralUnitOf('usd', 'sat'), false)
  assert.equal(isCollateralUnitOf('msat', 'usd'), false)
})

test('uses msat as the explicit CTF collateral unit', () => {
  assert.equal(CTF_COLLATERAL_UNIT, 'msat')
  assert.equal(defaultCollateralUnit('sat'), 'msat')
  assert.equal(collateralScaleForUnit('sat'), 1)
  assert.equal(collateralScaleForUnit('msat'), 1_000)
  assert.throws(() => defaultCollateralUnit(undefined), /unsupported base asset/)
  assert.throws(() => collateralScaleForUnit('usd'), /unsupported Cashu proof unit/)
})

test('converts sat and msat proofs into market subunits without unit coercion', () => {
  assert.equal(cashuAmountToMarketSubunits(21, 'sat'), 21_000)
  assert.equal(cashuAmountToMarketSubunits(21_000, 'msat'), 21_000)
  assert.throws(() => cashuAmountToMarketSubunits(1, 'SAT'), /unsupported Cashu proof unit/)
  assert.throws(() => cashuAmountToMarketSubunits(1, 'usd'), /unsupported Cashu proof unit/)
  assert.throws(() => cashuAmountToMarketSubunits(-1, 'sat'), /non-negative safe integer/)
  assert.throws(
    () => cashuAmountToMarketSubunits(Number.MAX_SAFE_INTEGER, 'sat'),
    /safe market subunit range/,
  )
})

test('accepts only the two product market divisibilities', () => {
  assert.equal(defaultMarketDivisibility('sat'), DEFAULT_SAT_MARKET_DIVISIBILITY)
  assert.equal(parseMarketDivisibility(DEFAULT_SAT_MARKET_DIVISIBILITY), 10_000)
  assert.equal(parseMarketDivisibility(NUMERIC_MARKET_DIVISIBILITY), 1_000_000)
  assert.equal(normalizeMarketDivisibility(10_000, 'sat'), 10_000)
  assert.equal(normalizeMarketDivisibility(1_000_000, 'sat'), 1_000_000)
  for (const value of [undefined, null, 0, 100, 1_000, 1.5, 1_000_001]) {
    assert.equal(parseMarketDivisibility(value), null)
    assert.throws(
      () => normalizeMarketDivisibility(value, 'sat'),
      /unsupported market divisibility/,
    )
  }
  assert.throws(() => normalizeMarketDivisibility(10_000, undefined), /unsupported base asset/)
})

test('formats sat-only product amounts', () => {
  assert.equal(marketUnitLabel('sat'), 'sats')
  assert.equal(marketSubunitLabel('sat'), 'sats')
  assert.equal(formatAmount(50_000, 'sat'), '50 sats')
  assert.equal(formatMarketSubunits(-1_234, 'sat'), '-1.234 sats')
  assert.equal(formatShareFace('sat', 10_000), '10 sats')
  assert.equal(
    formatWholeShareFaceValue({ baseAsset: 'sat', divisibility: 1_000_000 }),
    '1,000 sats',
  )
  assert.equal(formatPricePercentage(5_000, 10_000), '50.00%')
  assert.equal(formatPricePercent(1, 10_000), '0.01%')
  assert.throws(() => formatMarketSubunits(1_000, 'usd'), /unsupported base asset/)
  assert.throws(() => formatShareFace('sat', 1_000), /unsupported market divisibility/)
})

test('computes sat-only buffer, fee estimate, and creation liquidity', () => {
  assert.equal(bufferSubunits('sat', 0), 0)
  assert.equal(bufferSubunits('sat', 10_000), 10_000)
  assert.equal(bufferSubunits('sat', 100_000), 20_000)
  assert.equal(estimatedSettlementFeeSubunits('sat'), 10_000)
  assert.equal(
    normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: 10_000 }),
    10_000,
  )
  assert.equal(normalizeMarketCreationLiquiditySats({ baseAsset: 'sat' }), 0)
  assert.throws(() => bufferSubunits('usd', 10_000), /unsupported base asset/)
  assert.throws(() => estimatedSettlementFeeSubunits(undefined), /unsupported base asset/)
  assert.throws(
    () => normalizeMarketCreationLiquiditySats({ baseAsset: 'sat', liquiditySats: -1 }),
    /non-negative safe integer/,
  )
})

test('validates product price and whole-share amounts', () => {
  assert.equal(validatePriceNumerator(1, 10_000), true)
  assert.equal(validatePriceNumerator(9_999, 10_000), true)
  assert.equal(validatePriceNumerator(10_000, 10_000), false)
  assert.equal(validateWholeShareFaceAmount(20_000, 10_000), true)
  assert.equal(validateWholeShareFaceAmount(15_000, 10_000), false)
})

test('computes product quote payment in whole shares', () => {
  assert.equal(
    quotePaymentSubunits({
      faceAmountSubunits: 30_000,
      priceNumerator: 3_333,
      divisibility: 10_000,
    }),
    9_999,
  )
  assert.throws(
    () =>
      quotePaymentSubunits({
        faceAmountSubunits: 15_001,
        priceNumerator: 3_333,
        divisibility: 10_000,
      }),
    /whole-share/,
  )
  assert.throws(
    () =>
      quotePaymentSubunits({
        faceAmountSubunits: 1_000,
        priceNumerator: 333,
        divisibility: 1_000,
      }),
    /unsupported market divisibility/,
  )
})

test('accepts only sat vectors from the shared legacy fixture', () => {
  for (const vector of sharedMarketUnitSettlementVectors()) {
    const baseAsset = parseMarketBaseAsset(vector.baseAsset)
    if (baseAsset === null) {
      assert.equal(vector.baseAsset, 'usd')
      continue
    }
    assert.equal(
      quotePaymentSubunits({
        faceAmountSubunits: vector.faceAmountSubunits,
        priceNumerator: vector.priceSubunits,
        divisibility: vector.divisibility,
      }),
      vector.quotePaymentSubunits,
      vector.name,
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
