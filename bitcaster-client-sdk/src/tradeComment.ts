import type { NostrKind1Event } from './engineClient.ts'

/** The largest trade comment, in UTF-16 code units (JavaScript string length). */
export const TRADE_COMMENT_MAX_LENGTH = 280

export interface TradeCommentTemplate {
  kind: 1
  created_at: number
  tags: string[][]
  content: string
}

export function createTradeCommentTemplate(input: {
  conditionId: string
  marketUrl: string
  content: string
  createdAt: number
}): TradeCommentTemplate {
  const url = new URL(input.marketUrl)
  // The engine URL does not identify the public frontend's canonical origin.
  if (
    !input.conditionId ||
    !['http:', 'https:'].includes(url.protocol) ||
    input.marketUrl !== `${url.origin}/markets/${encodeURIComponent(input.conditionId)}`
  ) {
    throw new Error('Trade comment requires the canonical market page URL')
  }
  if (input.content.length > TRADE_COMMENT_MAX_LENGTH) {
    throw new Error(`Trade comment must be at most ${TRADE_COMMENT_MAX_LENGTH} characters`)
  }
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    throw new Error('Trade comment timestamp is invalid')
  }
  return {
    kind: 1,
    created_at: input.createdAt,
    tags: [['r', input.marketUrl]],
    content: input.content,
  }
}

export function tradeCommentToWire(
  event: TradeCommentTemplate & { id: string; pubkey: string; sig: string },
): NostrKind1Event {
  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    kind: event.kind,
    tags: event.tags,
    content: event.content,
    sig: event.sig,
  }
}
