import {
  DURABLE_TRADE_SESSION_SCHEMA_VERSION,
  validateDurableTradePendingIntent,
  validateDurableTradePrivateKeyBinding,
  type DurableTradePendingIntent,
} from '@bitcaster/client-sdk/durableTradeRecovery'
import {
  db,
  currentGuiWalletId,
  ensureDurableSwapStorage,
  type SwapIntentRecord,
} from './proof-db'
import {
  withGuiCustodyProfileLock,
  type GuiWalletContext,
} from './gui-custody-authority'

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
  await withRequiredPendingIntentLock(({ walletId }) =>
    persistGuiPendingSwapIntentForWallet(input, walletId),
  )
}

async function persistGuiPendingSwapIntentForWallet(
  input: GuiPendingSwapIntent,
  walletId: string,
): Promise<void> {
  const next = createGuiPendingSwapIntentRecord(input, walletId, Date.now())
  await ensureDurableSwapStorage(walletId)
  await db.transaction('rw', db.swapIntents, async () => {
    const current = await db.swapIntents.get(input.tradeId)
    if (!current) {
      await db.swapIntents.put(next)
      return
    }
    const existing = guiIntentFromRecord(current, walletId, input.tradeId)
    assertExactImmutableIntentBinding(existing, input)
    if (!existing.submitted && input.submitted) {
      await db.swapIntents.put({
        ...current,
        submitted: true,
        updatedAt: next.updatedAt,
      })
    }
  })
}

export async function loadGuiPendingSwapIntents(): Promise<
  GuiPendingSwapIntent[]
> {
  return withRequiredPendingIntentLock(({ walletId }) =>
    loadGuiPendingSwapIntentsForWallet(walletId),
  )
}

async function loadGuiPendingSwapIntentsForWallet(
  walletId: string,
): Promise<GuiPendingSwapIntent[]> {
  await ensureDurableSwapStorage(walletId)
  const rows = await db.swapIntents.where('walletId').equals(walletId).toArray()
  return rows.map((row) => guiIntentFromRecord(row, walletId, row.tradeId))
}

export async function getGuiPendingSwapIntent(
  tradeId: string,
): Promise<GuiPendingSwapIntent | null> {
  return getGuiPendingSwapIntentForWallet(tradeId, currentGuiWalletId())
}

async function getGuiPendingSwapIntentForWallet(
  tradeId: string,
  walletId: string,
): Promise<GuiPendingSwapIntent | null> {
  await ensureDurableSwapStorage(walletId)
  const row = await db.swapIntents.get(tradeId)
  if (!row) return null
  return guiIntentFromRecord(row, walletId, tradeId)
}

export async function getOrCreateGuiPendingSwapIntent(input: {
  tradeId: string
  orderId: string
  marketId: string
  deadline: string
  create: () => GuiPendingSwapIntent
}): Promise<GuiPendingSwapIntent> {
  return withRequiredPendingIntentLock(async ({ walletId }) => {
    const existing = await getGuiPendingSwapIntentForWallet(
      input.tradeId,
      walletId,
    )
    if (existing) {
      assertMatchingIntentBinding(existing, input)
      return existing
    }
    const created = input.create()
    assertCreatedIntentBinding(created, input)
    await persistGuiPendingSwapIntentForWallet(created, walletId)
    return created
  })
}

export async function markGuiPendingSwapIntentSubmitted(
  tradeId: string,
): Promise<void> {
  await withRequiredPendingIntentLock(async ({ walletId }) => {
    await ensureDurableSwapStorage(walletId)
    await db.transaction('rw', db.swapIntents, async () => {
      const current = await db.swapIntents.get(tradeId)
      if (!current) {
        throw new Error('durable pending swap intent is missing')
      }
      guiIntentFromRecord(current, walletId, tradeId)
      await db.swapIntents.put({
        ...current,
        submitted: true,
        updatedAt: Date.now(),
      })
    })
  })
}

export async function removeGuiPendingSwapIntent(
  tradeId: string,
): Promise<void> {
  await withRequiredPendingIntentLock(async ({ walletId }) => {
    await ensureDurableSwapStorage(walletId)
    await db.transaction('rw', db.swapIntents, async () => {
      const current = await db.swapIntents.get(tradeId)
      if (!current) return
      guiIntentFromRecord(current, walletId, tradeId)
      await db.swapIntents.delete(tradeId)
    })
  })
}

/** Parses the pre-ADR local-storage shape without treating it as authoritative. */
export function parseLegacyPendingSwapIntents(
  serialized: string,
): GuiPendingSwapIntent[] {
  try {
    const parsed = JSON.parse(serialized) as {
      state?: { byTradeId?: unknown }
    }
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
      )
        return []
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
export async function migrateLegacyGuiPendingSwapIntents(): Promise<
  GuiPendingSwapIntent[]
> {
  if (typeof window === 'undefined') return []
  return withRequiredPendingIntentLock(async ({ walletId }) => {
    const serialized = window.localStorage.getItem('bitcaster-pending-pubkeys')
    if (!serialized) return []
    const intents = parseLegacyPendingSwapIntents(serialized)
    for (const intent of intents) {
      if (!(await getGuiPendingSwapIntentForWallet(intent.tradeId, walletId))) {
        await persistGuiPendingSwapIntentForWallet(intent, walletId)
      }
    }
    window.localStorage.removeItem('bitcaster-pending-pubkeys')
    return intents
  })
}

function assertMatchingIntentBinding(
  existing: GuiPendingSwapIntent,
  input: Pick<
    GuiPendingSwapIntent,
    'tradeId' | 'orderId' | 'marketId' | 'deadline'
  >,
): void {
  if (
    existing.tradeId !== input.tradeId ||
    existing.orderId !== input.orderId ||
    existing.marketId !== input.marketId ||
    existing.deadline !== input.deadline
  ) {
    throw new Error(
      'durable pending swap intent conflicts with the existing trade binding',
    )
  }
}

function assertCreatedIntentBinding(
  created: GuiPendingSwapIntent,
  input: Pick<
    GuiPendingSwapIntent,
    'tradeId' | 'orderId' | 'marketId' | 'deadline'
  >,
): void {
  if (
    created.tradeId !== input.tradeId ||
    created.orderId !== input.orderId ||
    created.marketId !== input.marketId ||
    created.deadline !== input.deadline
  ) {
    throw new Error(
      'durable pending swap intent creation returned a mismatched binding',
    )
  }
}

function assertExactImmutableIntentBinding(
  existing: GuiPendingSwapIntent,
  input: GuiPendingSwapIntent,
): void {
  if (
    existing.tradeId !== input.tradeId ||
    existing.orderId !== input.orderId ||
    existing.marketId !== input.marketId ||
    existing.pubkey !== input.pubkey.toLowerCase() ||
    existing.privkey !== input.privkey.toLowerCase() ||
    existing.deadline !== input.deadline
  ) {
    throw new Error(
      'durable pending swap intent conflicts with the existing trade binding',
    )
  }
}

async function withRequiredPendingIntentLock<T>(
  action: (context: GuiWalletContext) => Promise<T>,
): Promise<T> {
  return withGuiCustodyProfileLock(action)
}

function durableIntentFromGui(
  input: GuiPendingSwapIntent,
): DurableTradePendingIntent {
  return {
    schemaVersion: DURABLE_TRADE_SESSION_SCHEMA_VERSION,
    tradeId: input.tradeId,
    orderId: input.orderId,
    marketId: input.marketId,
    localProtocolPubkey: input.pubkey.toLowerCase(),
    deadline: input.deadline,
  }
}

const SWAP_INTENT_RECORD_FIELDS = [
  'walletId',
  'tradeId',
  'intent',
  'ephemeralPrivkeyHex',
  'submitted',
  'updatedAt',
] as const

const DURABLE_INTENT_FIELDS = [
  'schemaVersion',
  'tradeId',
  'orderId',
  'marketId',
  'localProtocolPubkey',
  'deadline',
] as const

function guiIntentFromRecord(
  record: unknown,
  walletId: string,
  expectedTradeId: string,
): GuiPendingSwapIntent {
  const stored = validatedSwapIntentRecord(record, walletId, expectedTradeId)
  return {
    tradeId: stored.intent.tradeId,
    orderId: stored.intent.orderId,
    marketId: stored.intent.marketId,
    pubkey: stored.intent.localProtocolPubkey,
    privkey: stored.ephemeralPrivkeyHex,
    deadline: stored.intent.deadline,
    submitted: stored.submitted,
  }
}

export function decodeGuiPendingSwapIntent(
  record: unknown,
  walletId: string,
  expectedTradeId: string,
): GuiPendingSwapIntent {
  return guiIntentFromRecord(record, walletId, expectedTradeId)
}

export function createGuiPendingSwapIntentRecord(
  input: GuiPendingSwapIntent,
  walletId: string,
  updatedAt: number,
): SwapIntentRecord {
  const intent = durableIntentFromGui(input)
  const validationError = validateDurableTradePendingIntent(intent)
  if (validationError) throw new Error(validationError)
  if (!isPrivateKey(input.privkey)) {
    throw new Error('durable pending swap intent private key is invalid')
  }
  const keyBindingError = validateDurableTradePrivateKeyBinding(
    input.privkey,
    input.pubkey,
  )
  if (keyBindingError) {
    throw new Error(`durable pending swap intent ${keyBindingError}`)
  }
  return decodeGuiPendingSwapIntentRecord(
    {
      walletId,
      tradeId: input.tradeId,
      intent,
      ephemeralPrivkeyHex: input.privkey.toLowerCase(),
      submitted: input.submitted,
      updatedAt,
    },
    walletId,
    input.tradeId,
  )
}

function validatedSwapIntentRecord(
  record: unknown,
  walletId: string,
  expectedTradeId: string,
): SwapIntentRecord {
  if (
    typeof record === 'object' &&
    record !== null &&
    'walletId' in record &&
    typeof record.walletId === 'string' &&
    /^[a-f0-9]{64}$/.test(record.walletId) &&
    record.walletId !== walletId
  ) {
    throw new Error('Pending swap intent belongs to another wallet scope')
  }
  if (!hasExactFields(record, SWAP_INTENT_RECORD_FIELDS)) {
    throw corruptPendingIntent('record fields are invalid')
  }
  if (
    typeof record.walletId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.walletId)
  ) {
    throw corruptPendingIntent('wallet id is invalid')
  }
  if (record.walletId !== walletId) {
    throw new Error('Pending swap intent belongs to another wallet scope')
  }
  if (
    typeof record.tradeId !== 'string' ||
    record.tradeId !== expectedTradeId
  ) {
    throw corruptPendingIntent('physical trade id mismatch')
  }
  if (!hasExactFields(record.intent, DURABLE_INTENT_FIELDS)) {
    throw corruptPendingIntent('intent fields are invalid')
  }
  const intent = record.intent as unknown as DurableTradePendingIntent
  const intentError = validateDurableTradePendingIntent(intent)
  if (intentError) throw corruptPendingIntent(intentError)
  if (record.tradeId !== intent.tradeId) {
    throw corruptPendingIntent('physical and internal trade id mismatch')
  }
  if (
    typeof record.ephemeralPrivkeyHex !== 'string' ||
    !/^[a-f0-9]{64}$/.test(record.ephemeralPrivkeyHex)
  ) {
    throw corruptPendingIntent('private key is invalid')
  }
  const keyBindingError = validateDurableTradePrivateKeyBinding(
    record.ephemeralPrivkeyHex,
    intent.localProtocolPubkey,
  )
  if (keyBindingError) throw corruptPendingIntent(keyBindingError)
  if (typeof record.submitted !== 'boolean') {
    throw corruptPendingIntent('submitted state is invalid')
  }
  if (
    typeof record.updatedAt !== 'number' ||
    !Number.isSafeInteger(record.updatedAt) ||
    record.updatedAt < 0
  ) {
    throw corruptPendingIntent('updated timestamp is invalid')
  }
  return record as unknown as SwapIntentRecord
}

export function decodeGuiPendingSwapIntentRecord(
  value: unknown,
  walletId: string,
  expectedTradeId: string,
): SwapIntentRecord {
  return structuredClone(
    validatedSwapIntentRecord(value, walletId, expectedTradeId),
  )
}

function hasExactFields<const TFields extends readonly string[]>(
  value: unknown,
  fields: TFields,
): value is Record<TFields[number], unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const actual = Object.keys(value)
  return (
    actual.length === fields.length &&
    fields.every((field) => actual.includes(field))
  )
}

function corruptPendingIntent(reason: string): Error {
  return new Error(`corrupt durable pending swap intent: ${reason}`)
}

function isPrivateKey(value: string): boolean {
  return /^[a-f0-9]{64}$/i.test(value)
}

function validateLegacyGuiIntent(input: GuiPendingSwapIntent): boolean {
  return (
    validateDurableTradePrivateKeyBinding(input.privkey, input.pubkey) ===
      null &&
    validateDurableTradePendingIntent(durableIntentFromGui(input)) === null
  )
}
