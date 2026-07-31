export interface OrderRouteIdentity {
  readonly conditionId: string
  readonly outcomeId: string
}

export function parseOrderRouteId(value: unknown): OrderRouteIdentity | null {
  if (typeof value !== 'string' || value.trim() !== value || value.includes('|')) return null
  const boundary = value.lastIndexOf('-')
  if (boundary <= 0 || boundary >= value.length - 1) return null
  return {
    conditionId: value.slice(0, boundary),
    outcomeId: value.slice(boundary + 1),
  }
}

export function assertOrderRouteBelongsToCondition(
  orderRouteId: unknown,
  conditionId: unknown,
): OrderRouteIdentity {
  if (typeof conditionId !== 'string' || conditionId.trim() !== conditionId || !conditionId) {
    throw new Error('order route condition is invalid')
  }
  const parsed = parseOrderRouteId(orderRouteId)
  if (parsed === null || parsed.conditionId !== conditionId) {
    throw new Error('order route belongs to a foreign condition')
  }
  return parsed
}
