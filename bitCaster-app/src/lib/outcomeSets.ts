import type { MarketDetail, TradeSelection } from '@/types/market-detail'

export interface ResolvedOutcomeSets {
  selectedOutcomeSetId: string
  complementOutcomeSetId: string
}

export function outcomeLabels(market: MarketDetail): string[] {
  return (market.outcomes ?? []).map((outcome) => outcome.label)
}

export function canonicalizeOutcomeSet(outcomes: string[]): string {
  return [...new Set(outcomes.map((outcome) => outcome.trim()).filter(Boolean))]
    .sort()
    .join('|')
}

export function parseOutcomeSetId(outcomeSetId: string): string[] {
  return outcomeSetId
    .split('|')
    .map((outcome) => outcome.trim())
    .filter(Boolean)
}

export function complementOutcomeSetId(
  universe: string[],
  selectedOutcomeSetId: string,
): string {
  const selected = new Set(parseOutcomeSetId(selectedOutcomeSetId))
  return canonicalizeOutcomeSet(
    universe.filter((outcome) => !selected.has(outcome)),
  )
}

export function outcomeSetMarketId(
  conditionId: string,
  outcomeSetId: string,
): string {
  return `${conditionId}-${outcomeSetId}`
}

export function outcomeSetIdsForMarketBooks(market: MarketDetail): string[] {
  const universe = outcomeLabels(market)
  const ids = new Set<string>()
  for (const outcome of universe) {
    const selected = canonicalizeOutcomeSet([outcome])
    if (selected) ids.add(selected)
    const complement = complementOutcomeSetId(universe, selected)
    if (complement) ids.add(complement)
  }
  return [...ids]
}

export function resolveOutcomeSets(
  market: MarketDetail,
  selection: TradeSelection,
): ResolvedOutcomeSets | null {
  const universe = outcomeLabels(market)
  if (universe.length === 0) return null

  const primitive = selectedPrimitiveOutcome(market, selection, universe)
  if (!primitive) return null

  const primitiveSetId = canonicalizeOutcomeSet([primitive])
  const selectedOutcomeSetId =
    market.type === 'categorical' && selection.side === 'no'
      ? complementOutcomeSetId(universe, primitiveSetId)
      : primitiveSetId
  if (!selectedOutcomeSetId) return null

  const complementOutcomeSetIdValue = complementOutcomeSetId(
    universe,
    selectedOutcomeSetId,
  )
  if (!complementOutcomeSetIdValue) return null

  return {
    selectedOutcomeSetId,
    complementOutcomeSetId: complementOutcomeSetIdValue,
  }
}

function selectedPrimitiveOutcome(
  market: MarketDetail,
  selection: TradeSelection,
  universe: string[],
): string | null {
  if (market.type === 'categorical') {
    return (
      market.outcomes.find((outcome) => outcome.id === selection.outcomeId)
        ?.label ?? null
    )
  }

  if (selection.side === 'yes' || selection.side === 'no') {
    return findOutcomeByName(universe, selection.side)
  }

  if (selection.side === 'hi' || selection.side === 'lo') {
    return findOutcomeByName(universe, selection.side)
  }

  return null
}

function findOutcomeByName(universe: string[], name: string): string | null {
  const lower = name.toLowerCase()
  return universe.find((outcome) => outcome.toLowerCase() === lower) ?? null
}
