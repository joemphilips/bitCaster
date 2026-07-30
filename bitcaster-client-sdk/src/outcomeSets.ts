import type { SdkMarketForTrading, SdkMarketOutcome, SdkTradeSelection } from './types.ts'

export interface ResolvedOutcomeSets {
  publicOutcomeSetId: string
  tokenSide: 'Outcome' | 'Complement'
  selectedOutcomeSetId: string
  complementOutcomeSetId: string
}

export function parseMarketOutcomes(market: unknown): SdkMarketOutcome[] {
  if (
    !isRecord(market) ||
    !Array.isArray(market.outcomes) ||
    market.outcomes.length < 2 ||
    market.outcomes.length > 64
  ) {
    throw new Error('engine market outcomes are invalid')
  }
  const outcomes = market.outcomes.map((raw, index) => parseMarketOutcome(raw, index))
  if (
    new Set(outcomes.map(({ id }) => id)).size !== outcomes.length ||
    new Set(outcomes.map(({ label }) => label)).size !== outcomes.length
  ) {
    throw new Error('engine market outcomes are not unique')
  }
  return outcomes
}

export function outcomeLabels(market: SdkMarketForTrading): string[] {
  return (market.outcomes ?? []).map((outcome) => outcome.label)
}

function parseMarketOutcome(value: unknown, index: number): SdkMarketOutcome {
  if (typeof value === 'string') {
    const label = requireOutcomeText(value, index)
    return { id: label, label }
  }
  if (!isRecord(value)) throw new Error(`engine market outcome ${index} is invalid`)
  const label = requireOutcomeText(
    typeof value.label === 'string' ? value.label : value.name,
    index,
  )
  const id = requireOutcomeText(value.id ?? label, index)
  return { id, label }
}

function requireOutcomeText(value: unknown, index: number): string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    throw new Error(`engine market outcome ${index} is invalid`)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function canonicalizeOutcomeSet(outcomes: string[]): string {
  return [...new Set(outcomes.map((outcome) => outcome.trim()).filter(Boolean))].sort().join('|')
}

export function parseOutcomeSetId(outcomeSetId: string): string[] {
  return outcomeSetId
    .split('|')
    .map((outcome) => outcome.trim())
    .filter(Boolean)
}

export function complementOutcomeSetId(universe: string[], selectedOutcomeSetId: string): string {
  const selected = new Set(parseOutcomeSetId(selectedOutcomeSetId))
  return canonicalizeOutcomeSet(universe.filter((outcome) => !selected.has(outcome)))
}

export function outcomeSetMarketId(conditionId: string, outcomeSetId: string): string {
  return `${conditionId}-${outcomeSetId}`
}

export function outcomeSetIdsForMarketBooks(market: SdkMarketForTrading): string[] {
  const universe = outcomeLabels(market)
  return universe.map((outcome) => canonicalizeOutcomeSet([outcome])).filter(Boolean)
}

export function outcomeSetDisplayLabel(universe: readonly string[], outcomeSetId: string): string {
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
    tokenSide === 'Complement' ? complementOutcomeSetId(universe, primitiveSetId) : primitiveSetId
  if (!selectedOutcomeSetId) return null

  const complementOutcomeSetIdValue = complementOutcomeSetId(universe, selectedOutcomeSetId)
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
        (outcome) => outcome.id === selectedOutcomeId || outcome.label === selectedOutcomeId,
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
