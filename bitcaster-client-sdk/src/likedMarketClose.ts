import type { components } from './generated/api.ts'

export type ObservedMarketState = components['schemas']['MarketCatalogueEntry']['state']

export function parseObservedMarketState(value: unknown): ObservedMarketState {
  switch (value) {
    case 'open':
      return 'open'
    case 'closed':
      return 'closed'
    default:
      throw new Error('Market lifecycle state is invalid.')
  }
}

/** A first closed observation is silent. Only an observed open-to-closed transition notifies. */
export function didMarketTransitionToClosed(
  previous: ObservedMarketState | null | undefined,
  current: ObservedMarketState,
): boolean {
  if (previous == null) return false
  switch (previous) {
    case 'open':
      switch (current) {
        case 'open':
          return false
        case 'closed':
          return true
        default:
          return unexpectedState(current)
      }
    case 'closed':
      return false
    default:
      return unexpectedState(previous)
  }
}

function unexpectedState(_value: never): never {
  throw new Error('Market lifecycle state is invalid.')
}
