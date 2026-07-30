import { splitAmount } from '@cashu/cashu-ts'
import {
  parseMarketDivisibility,
  validatePriceNumerator,
  validateWholeShareFaceAmount,
} from './marketUnits.ts'
import {
  SETTLEMENT_CAPABILITY_INPUTS_MAX,
  SETTLEMENT_CAPABILITY_MANIFEST_ENTRIES_MAX,
} from './settlementCapabilityArtifact.ts'

export interface CtfRangeOrderAuthorizationPlan {
  inputAmount: string
  authorizationAmounts: string[]
  /**
   * Maximum settlement fee units that the engine's largest-remainder allocation
   * may assign to this participant's authorization.
   */
  participantFeeAllocationUpperBound: string
  reservedFeeHeadroom: string
  manifest: {
    maxReceive: string
    maxChange: string
  }
  policy: {
    rateN: string
    rateD: string
    minReceive: string
    maxDebit: string
  }
}

export function planCtfRangeOrderAuthorization(input: {
  side: 'Buy' | 'Sell'
  priceNumerator: number
  amountSubunits: number
  divisibility: number
  inputFeePpk: number
  offerKeysetKeys: Readonly<Record<string, string>>
  maxPoolEntries: number
  maxInputs?: number
}): CtfRangeOrderAuthorizationPlan {
  const side = requireOrderSide(input.side)
  const divisibility = parseMarketDivisibility(input.divisibility)
  if (divisibility === null) throw new Error('CTF range market divisibility is unsupported')
  validateOrderAmount(input.amountSubunits, input.priceNumerator, divisibility)
  const inputFeePpk = requirePositiveSafeInteger(input.inputFeePpk, 'input fee ppk')
  const maxInputs = requireInputLimit(input.maxInputs)
  const maxPoolEntries = requireManifestEntryLimit(input.maxPoolEntries)
  const offerKeysetKeys = requireBinaryKeysetKeys(input.offerKeysetKeys)
  const faceAmount = BigInt(input.amountSubunits)
  const quoteAmount = (faceAmount / BigInt(divisibility)) * BigInt(input.priceNumerator)
  const prepared = prepareInputs(
    side,
    faceAmount,
    quoteAmount,
    inputFeePpk,
    offerKeysetKeys,
    maxInputs,
  )
  requireManifestLimit(faceAmount, prepared.inputAmount, maxPoolEntries)
  const policy = createOrderPolicy({
    side,
    priceNumerator: BigInt(input.priceNumerator),
    divisibility: BigInt(divisibility),
    faceAmount,
    quoteAmount,
    feeUpperBound: prepared.feeUpperBound,
  })
  return {
    inputAmount: prepared.inputAmount.toString(),
    authorizationAmounts: prepared.amounts,
    participantFeeAllocationUpperBound: prepared.feeUpperBound.toString(),
    reservedFeeHeadroom: prepared.reservedHeadroom.toString(),
    manifest: { maxReceive: faceAmount.toString(), maxChange: prepared.inputAmount.toString() },
    policy,
  }
}

type CtfRangeOrderSide = 'Buy' | 'Sell'

interface ValidatedBinaryKeyset {
  keys: Readonly<Record<string, string>>
  largestDenomination: bigint
}

function prepareInputs(
  side: CtfRangeOrderSide,
  faceAmount: bigint,
  quoteAmount: bigint,
  inputFeePpk: number,
  keyset: ValidatedBinaryKeyset,
  maxInputs: number,
) {
  switch (side) {
    case 'Buy':
      return prepareBuyInputs(quoteAmount, inputFeePpk, keyset, maxInputs)
    case 'Sell':
      return prepareSellInputs(faceAmount, inputFeePpk, keyset, maxInputs)
    default:
      return assertNever(side)
  }
}

function prepareBuyInputs(
  quoteAmount: bigint,
  inputFeePpk: number,
  keyset: ValidatedBinaryKeyset,
  maxInputs: number,
) {
  let best: ReturnType<typeof prepareBuyCandidate> | null = null
  const maximumReserve = feeForInputCount(inputFeePpk, maxInputs)
  for (let inputCount = 1; inputCount <= maxInputs; inputCount += 1) {
    const minimum = quoteAmount + feeForInputCount(inputFeePpk, inputCount)
    const inputAmount = smallestAmountWithAtMostBinaryParts(minimum, inputCount)
    if (inputAmount - quoteAmount > maximumReserve) continue
    const amounts = trySplitInputAmount(inputAmount, keyset, maxInputs)
    if (amounts === null || amounts.length > inputCount) continue
    const feeUpperBound = feeForInputCount(inputFeePpk, amounts.length)
    const candidate = prepareBuyCandidate(quoteAmount, inputAmount, amounts, feeUpperBound)
    if (candidate !== null && (best === null || candidate.inputAmount < best.inputAmount)) {
      best = candidate
    }
  }
  if (best !== null) return best
  throw new Error('CTF range buy fee reservation exceeds the mint input limit')
}

function prepareBuyCandidate(
  quoteAmount: bigint,
  inputAmount: bigint,
  amounts: string[],
  feeUpperBound: bigint,
) {
  const reservedFee = inputAmount - quoteAmount
  if (feeUpperBound > reservedFee) return null
  return {
    inputAmount,
    amounts,
    feeUpperBound,
    reservedHeadroom: reservedFee - feeUpperBound,
  }
}

function prepareSellInputs(
  faceAmount: bigint,
  inputFeePpk: number,
  keyset: ValidatedBinaryKeyset,
  maxInputs: number,
) {
  const amounts = splitInputAmount(faceAmount, keyset, maxInputs)
  return {
    inputAmount: faceAmount,
    amounts,
    feeUpperBound: feeForInputCount(inputFeePpk, amounts.length),
    reservedHeadroom: 0n,
  }
}

function createOrderPolicy(input: {
  side: 'Buy' | 'Sell'
  priceNumerator: bigint
  divisibility: bigint
  faceAmount: bigint
  quoteAmount: bigint
  feeUpperBound: bigint
}) {
  switch (input.side) {
    case 'Buy': {
      const worstDebit = input.priceNumerator + input.feeUpperBound
      const divisor = greatestCommonDivisor(input.divisibility, worstDebit)
      return {
        rateN: (input.divisibility / divisor).toString(),
        rateD: (worstDebit / divisor).toString(),
        minReceive: input.divisibility.toString(),
        maxDebit: (input.quoteAmount + input.feeUpperBound).toString(),
      }
    }
    case 'Sell': {
      const worstReceive = input.priceNumerator - input.feeUpperBound
      if (worstReceive <= 0n) {
        throw new Error('CTF range sell fee exceeds the minimum whole-share receive amount')
      }
      const divisor = greatestCommonDivisor(worstReceive, input.divisibility)
      return {
        rateN: (worstReceive / divisor).toString(),
        rateD: (input.divisibility / divisor).toString(),
        minReceive: worstReceive.toString(),
        maxDebit: input.faceAmount.toString(),
      }
    }
    default:
      return assertNever(input.side)
  }
}

function splitInputAmount(
  amount: bigint,
  keyset: ValidatedBinaryKeyset,
  maxInputs: number,
): string[] {
  if (!binaryInputCountFits(amount, keyset.largestDenomination, maxInputs)) {
    throw new Error('CTF range authorization exceeds the mint input limit')
  }
  const amounts = splitAmount(amount, { ...keyset.keys }).map((part) => part.toString())
  if (amounts.length < 1 || amounts.length > maxInputs) {
    throw new Error('CTF range authorization decomposition is inconsistent')
  }
  return amounts
}

function trySplitInputAmount(
  amount: bigint,
  keyset: ValidatedBinaryKeyset,
  maxInputs: number,
): string[] | null {
  if (!binaryInputCountFits(amount, keyset.largestDenomination, maxInputs)) return null
  const amounts = splitAmount(amount, { ...keyset.keys }).map((part) => part.toString())
  if (amounts.length < 1 || amounts.length > maxInputs) {
    throw new Error('CTF range authorization decomposition is inconsistent')
  }
  return amounts
}

function binaryInputCountFits(
  amount: bigint,
  largestDenomination: bigint,
  maxInputs: number,
): boolean {
  const largestCount = amount / largestDenomination
  if (largestCount > BigInt(maxInputs)) return false

  let count = Number(largestCount)
  let remainder = amount % largestDenomination
  while (remainder > 0n) {
    remainder &= remainder - 1n
    count += 1
    if (count > maxInputs) return false
  }
  return count >= 1
}

function feeForInputCount(inputFeePpk: number, inputCount: number): bigint {
  const weight = BigInt(inputFeePpk) * BigInt(inputCount)
  return (weight + 999n) / 1_000n
}

function validateOrderAmount(amount: number, price: number, divisibility: number): void {
  if (!validateWholeShareFaceAmount(amount, divisibility)) {
    throw new Error('CTF range amount must be a positive whole-share amount')
  }
  if (!validatePriceNumerator(price, divisibility)) {
    throw new Error('CTF range price is outside the market divisibility')
  }
}

function requirePositiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} is invalid`)
  return value
}

function requireInputLimit(value: number | undefined): number {
  const limit = value ?? SETTLEMENT_CAPABILITY_INPUTS_MAX
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > SETTLEMENT_CAPABILITY_INPUTS_MAX) {
    throw new Error('CTF range input limit is invalid')
  }
  return limit
}

function requireManifestEntryLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 2 ||
    value > SETTLEMENT_CAPABILITY_MANIFEST_ENTRIES_MAX
  ) {
    throw new Error('CTF range manifest entry limit is invalid')
  }
  return value
}

function requireOrderSide(value: unknown): CtfRangeOrderSide {
  switch (value) {
    case 'Buy':
      return value
    case 'Sell':
      return value
    default:
      throw new Error('CTF range order side is invalid')
  }
}

function requireBinaryKeysetKeys(value: Readonly<Record<string, string>>): ValidatedBinaryKeyset {
  const entries = Object.entries(value)
    .map(([amount, key]) => {
      if (!/^[1-9]\d*$/.test(amount) || typeof key !== 'string' || key.length === 0) {
        throw new Error('CTF range offer keyset is invalid')
      }
      return [BigInt(amount), amount, key] as const
    })
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  if (entries.length === 0 || entries[0]![0] !== 1n) {
    throw new Error('CTF range offer keyset must publish binary denominations')
  }
  entries.forEach(([amount], index) => {
    if (amount !== 1n << BigInt(index)) {
      throw new Error('CTF range offer keyset must publish contiguous binary denominations')
    }
  })
  return {
    keys: Object.fromEntries(entries.map(([, amount, key]) => [amount, key])),
    largestDenomination: entries.at(-1)![0],
  }
}

function smallestAmountWithAtMostBinaryParts(minimum: bigint, maximumParts: number): bigint {
  if (binaryPartCount(minimum) <= maximumParts) return minimum
  for (let modulus = 2n; ; modulus <<= 1n) {
    const rounded = ((minimum + modulus - 1n) / modulus) * modulus
    if (binaryPartCount(rounded) <= maximumParts) return rounded
  }
}

function binaryPartCount(value: bigint): number {
  let count = 0
  while (value > 0n) {
    value &= value - 1n
    count += 1
  }
  return count
}

function requireManifestLimit(
  maxReceive: bigint,
  maxChange: bigint,
  advertisedLimit: number,
): void {
  if (binaryRangeEntryCount(maxReceive) + binaryRangeEntryCount(maxChange) > advertisedLimit) {
    throw new Error('CTF range authorization exceeds the mint manifest entry limit')
  }
}

function binaryRangeEntryCount(maximum: bigint): number {
  let count = 0
  for (let value = maximum; value > 0n; value >>= 1n) count += 1
  return count
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  while (right !== 0n) {
    const remainder = left % right
    left = right
    right = remainder
  }
  return left
}

function assertNever(value: never): never {
  throw new Error(`Unhandled CTF range order side: ${String(value)}`)
}
