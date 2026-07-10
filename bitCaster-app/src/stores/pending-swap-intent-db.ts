import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  validateDurableTradePendingIntent,
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
  if (!isPrivateKey(record.ephemeralPrivkeyHex)) return null
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
