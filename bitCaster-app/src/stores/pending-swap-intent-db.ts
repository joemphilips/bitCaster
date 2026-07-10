import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  validateDurableTradePendingIntent,
  validateDurableTradePrivateKeyBinding,
  type DurableTradePendingIntent,
} from '@bitcaster/client-sdk/durableTradeRecovery'
import {
  db,
  ensureDurableSwapStorage,
  type SwapIntentRecord,
} from './proof-db'

export interface GuiPendingSwapIntent {
  tradeId: string
  orderId: string
  marketId: string
  pubkey: string
  privkey: string
  deadline: string
  submitted: boolean
}

const pendingIntentCreations = new Map<string, Promise<GuiPendingSwapIntent>>()

/**
 * Writes the pre-TradeCreated private key binding before the client submits
 * its public key. Zustand consumes a hydrated projection of these records.
 */
export async function persistGuiPendingSwapIntent(
  input: GuiPendingSwapIntent,
): Promise<void> {
  const intent = durableIntentFromGui(input)
  const validationError = validateDurableTradePendingIntent(intent)
  if (validationError) throw new Error(validationError)
  if (!isPrivateKey(input.privkey)) {
    throw new Error('durable pending swap intent private key is invalid')
  }
  const keyBindingError = validateDurableTradePrivateKeyBinding(input.privkey, input.pubkey)
  if (keyBindingError) {
    throw new Error(`durable pending swap intent ${keyBindingError}`)
  }
  await ensureDurableSwapStorage()
  await db.swapIntents.put({
    tradeId: input.tradeId,
    intent,
    ephemeralPrivkeyHex: input.privkey.toLowerCase(),
    submitted: input.submitted,
    updatedAt: Date.now(),
  } satisfies SwapIntentRecord)
}

export async function loadGuiPendingSwapIntents(): Promise<GuiPendingSwapIntent[]> {
  await ensureDurableSwapStorage()
  const rows = await db.swapIntents.toArray()
  const now = Date.now()
  const active: GuiPendingSwapIntent[] = []
  for (const row of rows) {
    const entry = guiIntentFromRecord(row)
    if (!entry || Date.parse(entry.deadline) < now) {
      await db.swapIntents.delete(row.tradeId)
      continue
    }
    active.push(entry)
  }
  return active
}

export async function getGuiPendingSwapIntent(
  tradeId: string,
): Promise<GuiPendingSwapIntent | null> {
  await ensureDurableSwapStorage()
  const row = await db.swapIntents.get(tradeId)
  const entry = row ? guiIntentFromRecord(row) : null
  if (!entry || Date.parse(entry.deadline) < Date.now()) return null
  return entry
}

/**
 * Serializes creation in this browser context so concurrent market/order
 * callbacks bind a trade to one key before either can submit it to the engine.
 */
export function getOrCreateGuiPendingSwapIntent(input: {
  tradeId: string
  orderId: string
  marketId: string
  deadline: string
  create: () => GuiPendingSwapIntent
}): Promise<GuiPendingSwapIntent> {
  const prior = pendingIntentCreations.get(input.tradeId) ?? Promise.resolve()
  const next = prior.then(async () => {
    const existing = await getGuiPendingSwapIntent(input.tradeId)
    if (existing) {
      if (
        existing.orderId !== input.orderId ||
        existing.marketId !== input.marketId ||
        existing.deadline !== input.deadline
      ) {
        throw new Error('durable pending swap intent conflicts with the existing trade binding')
      }
      return existing
    }
    const created = input.create()
    if (
      created.tradeId !== input.tradeId ||
      created.orderId !== input.orderId ||
      created.marketId !== input.marketId ||
      created.deadline !== input.deadline
    ) {
      throw new Error('durable pending swap intent creation returned a mismatched binding')
    }
    await persistGuiPendingSwapIntent(created)
    return created
  })
  pendingIntentCreations.set(input.tradeId, next)
  void next.finally(() => {
    if (pendingIntentCreations.get(input.tradeId) === next) {
      pendingIntentCreations.delete(input.tradeId)
    }
  }).catch(() => {})
  return next
}

export async function markGuiPendingSwapIntentSubmitted(tradeId: string): Promise<void> {
  await ensureDurableSwapStorage()
  await db.transaction('rw', db.swapIntents, async () => {
    const current = await db.swapIntents.get(tradeId)
    if (!current) return
    await db.swapIntents.put({ ...current, submitted: true, updatedAt: Date.now() })
  })
}

export async function removeGuiPendingSwapIntent(tradeId: string): Promise<void> {
  await ensureDurableSwapStorage()
  await db.swapIntents.delete(tradeId)
}

/** Parses the pre-ADR local-storage shape without treating it as authoritative. */
export function parseLegacyPendingSwapIntents(serialized: string): GuiPendingSwapIntent[] {
  try {
    const parsed = JSON.parse(serialized) as { state?: { byTradeId?: unknown } }
    const entries = parsed.state?.byTradeId
    if (!entries || typeof entries !== 'object') return []
    return Object.values(entries).flatMap((entry) => {
      const candidate = entry as Partial<GuiPendingSwapIntent>
      if (
        typeof candidate.tradeId !== 'string' ||
        typeof candidate.orderId !== 'string' ||
        typeof candidate.marketId !== 'string' ||
        typeof candidate.pubkey !== 'string' ||
        typeof candidate.privkey !== 'string' ||
        typeof candidate.deadline !== 'string' ||
        typeof candidate.submitted !== 'boolean'
      ) return []
      const intent: GuiPendingSwapIntent = {
        tradeId: candidate.tradeId,
        orderId: candidate.orderId,
        marketId: candidate.marketId,
        pubkey: candidate.pubkey,
        privkey: candidate.privkey,
        deadline: candidate.deadline,
        submitted: candidate.submitted,
      }
      return validateLegacyGuiIntent(intent) ? [intent] : []
    })
  } catch {
    return []
  }
}

/**
 * Moves the legacy Zustand payload into IndexedDB before any caller creates a
 * replacement key. It is idempotent so the root recovery hook and an order
 * recovery callback may safely race during application startup.
 */
export async function migrateLegacyGuiPendingSwapIntents(): Promise<GuiPendingSwapIntent[]> {
  if (typeof window === 'undefined') return []
  const serialized = window.localStorage.getItem('bitcaster-pending-pubkeys')
  if (!serialized) return []
  const intents = parseLegacyPendingSwapIntents(serialized)
  for (const intent of intents) {
    if (!await getGuiPendingSwapIntent(intent.tradeId)) {
      await persistGuiPendingSwapIntent(intent)
    }
  }
  window.localStorage.removeItem('bitcaster-pending-pubkeys')
  return intents
}

function durableIntentFromGui(input: GuiPendingSwapIntent): DurableTradePendingIntent {
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    tradeId: input.tradeId,
    orderId: input.orderId,
    marketId: input.marketId,
    localProtocolPubkey: input.pubkey.toLowerCase(),
    deadline: input.deadline,
  }
}

function guiIntentFromRecord(record: SwapIntentRecord): GuiPendingSwapIntent | null {
  if (validateDurableTradePendingIntent(record.intent) !== null) return null
  if (validateDurableTradePrivateKeyBinding(
    record.ephemeralPrivkeyHex,
    record.intent.localProtocolPubkey,
  ) !== null) return null
  return {
    tradeId: record.intent.tradeId,
    orderId: record.intent.orderId,
    marketId: record.intent.marketId,
    pubkey: record.intent.localProtocolPubkey,
    privkey: record.ephemeralPrivkeyHex,
    deadline: record.intent.deadline,
    submitted: record.submitted,
  }
}

function isPrivateKey(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

function validateLegacyGuiIntent(input: GuiPendingSwapIntent): boolean {
  return validateDurableTradePrivateKeyBinding(input.privkey, input.pubkey) === null &&
    validateDurableTradePendingIntent(durableIntentFromGui(input)) === null
}
