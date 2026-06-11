import type { MintQuoteResponse } from '@cashu/cashu-ts'
import { amountToNumber } from '@bitcaster/client-sdk/proofSelection'

export interface MintQuoteRateInfo {
  label: string
  source: 'mint' | 'implied'
  fieldName?: string
}

const RATE_FIELD_CANDIDATES = [
  'rate',
  'quoted_rate',
  'quotedRate',
  'sats_per_cent',
  'satsPerCent',
  'sats_per_usd_cent',
  'satsPerUsdCent',
  'usd_per_btc',
  'usdPerBtc',
] as const

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function findRateField(record: Record<string, unknown>): { fieldName: string; value: number } | null {
  const extra = record.extra_json
  const candidates: Record<string, unknown>[] = [record]
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    candidates.unshift(extra as Record<string, unknown>)
  }

  for (const candidate of candidates) {
    for (const fieldName of RATE_FIELD_CANDIDATES) {
      const value = asNumber(candidate[fieldName])
      if (value != null) return { fieldName, value }
    }
  }
  return null
}

export function parseBolt11AmountSats(invoice: string): number | null {
  // The amount in the human-readable part must be followed by the bech32 `1`
  // separator — without anchoring on it, an amountless invoice like
  // `lnbc1p...` would misparse its separator `1` as a 1-pico-BTC amount.
  const match = invoice.toLowerCase().match(/^ln(?:bc|tb|bcrt)(\d+)([munp]?)1/)
  if (!match) return null
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return null
  const multiplier = match[2]
  if (multiplier === 'm') return amount * 100_000
  if (multiplier === 'u') return amount * 100
  if (multiplier === 'n') return amount / 10
  if (multiplier === 'p') return amount / 10_000
  return amount * 100_000_000
}

export function getMintQuoteRateInfo(
  quote: MintQuoteResponse | null | undefined,
  requestedSubunits: number,
): MintQuoteRateInfo | null {
  if (!quote) return null
  const record = quote as unknown as Record<string, unknown>
  const rateField = findRateField(record)
  if (rateField) {
    return {
      label: rateField.value.toLocaleString(undefined, { maximumFractionDigits: 8 }),
      source: 'mint',
      fieldName: rateField.fieldName,
    }
  }

  const invoiceSats = parseBolt11AmountSats(quote.request)
  const quoteAmount = amountToNumber(quote.amount)
  const requested = requestedSubunits > 0 ? requestedSubunits : quoteAmount
  if (invoiceSats == null || requested <= 0) return null
  return {
    label: `${(invoiceSats / requested).toLocaleString(undefined, {
      maximumFractionDigits: 8,
    })} sat/cent`,
    source: 'implied',
  }
}
