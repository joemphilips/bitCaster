import type { SdkMarketForTrading, SdkTradeSelection } from './types.ts'

export interface ResolvedOutcomeSets {
  publicOutcomeSetId: string
  tokenSide: 'Outcome' | 'Complement'
  selectedOutcomeSetId: string
  complementOutcomeSetId: string
}

export function outcomeLabels(market: SdkMarketForTrading): string[] {
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

export function outcomeSetIdsForMarketBooks(market: SdkMarketForTrading): string[] {
  const universe = outcomeLabels(market)
  return universe
    .map((outcome) => canonicalizeOutcomeSet([outcome]))
    .filter(Boolean)
}

export function outcomeSetDisplayLabel(
  universe: readonly string[],
  outcomeSetId: string,
): string {
  const members = parseOutcomeSetId(outcomeSetId)
  if (members.length === 0) return outcomeSetId
  if (members.length === 1) return members[0]

  const uniqueUniverse = [...new Set(universe.map((outcome) => outcome.trim()).filter(Boolean))]
  if (uniqueUniverse.length > 2 && members.length === uniqueUniverse.length - 1) {
    const memberSet = new Set(members)
    const missing = uniqueUniverse.filter((outcome) => !memberSet.has(outcome))
    if (missing.length === 1) return `Not ${missing[0]}`
  }

  return members.join(' or ')
}

export function resolveOutcomeSets(
  market: SdkMarketForTrading,
  selection: SdkTradeSelection,
): ResolvedOutcomeSets | null {
  const universe = outcomeLabels(market)
  if (universe.length === 0) return null

  const primitive = selectedPrimitiveOutcome(market, selection, universe)
  if (!primitive) return null

  const primitiveSetId = canonicalizeOutcomeSet([primitive])
  const tokenSide =
    (market.type === 'yesno' || market.type === 'categorical') && selection.side === 'no'
      ? 'Complement'
      : selection.side === 'lo'
        ? 'Complement'
        : 'Outcome'
  const selectedOutcomeSetId =
    tokenSide === 'Complement'
      ? complementOutcomeSetId(universe, primitiveSetId)
      : primitiveSetId
  if (!selectedOutcomeSetId) return null

  const complementOutcomeSetIdValue = complementOutcomeSetId(
    universe,
    selectedOutcomeSetId,
  )
  if (!complementOutcomeSetIdValue) return null

  return {
    publicOutcomeSetId: primitiveSetId,
    tokenSide,
    selectedOutcomeSetId,
    complementOutcomeSetId: complementOutcomeSetIdValue,
  }
}

function selectedPrimitiveOutcome(
  market: SdkMarketForTrading,
  selection: SdkTradeSelection,
  universe: string[],
): string | null {
  if (market.type === 'categorical') {
    const selectedOutcomeId = selection.outcomeId
    if (!selectedOutcomeId) return null
    return (
      (market.outcomes ?? []).find(
        (outcome) =>
          outcome.id === selectedOutcomeId ||
          outcome.label === selectedOutcomeId,
      )?.label ?? null
    )
  }

  if (selection.side === 'yes') {
    return findOutcomeByName(universe, 'yes')
  }

  if (selection.side === 'no') {
    if (market.type === 'yesno') {
      return findOutcomeByName(universe, 'yes') ?? universe[0] ?? null
    }
    return (
      findOutcomeByName(universe, 'no') ??
      universe.find((outcome) => outcome.toLowerCase() !== 'yes') ??
      universe[0] ??
      null
    )
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
