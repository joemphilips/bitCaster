import { createRequire } from 'node:module'
import { submitEphemeralPubkey as submitEphemeralPubkeyRequest } from '@bitcaster-market/client-sdk/engineClient'
import { generateOrderEphemeralKeypair, type OrderEphemeralKeypair } from './ephemeralKey.ts'
import { signNip98 } from './nostrAuth.ts'
import { readSecrets, updateSecrets } from './secrets.ts'

const require = createRequire(import.meta.url)

interface SignalRModule {
  HubConnectionBuilder: new () => HubConnectionBuilderLike
}

interface HubConnectionBuilderLike {
  withUrl(
    url: string,
    options: { accessTokenFactory: () => string },
  ): HubConnectionBuilderLike
  withAutomaticReconnect(retryDelays: number[]): HubConnectionBuilderLike
  build(): HubConnectionLike
}

interface HubConnectionLike {
  start(): Promise<void>
  stop(): Promise<void>
  on(methodName: string, callback: (...args: unknown[]) => void): void
  invoke(methodName: string, ...args: unknown[]): Promise<unknown>
}

export interface MarketMatchedDelta {
  marketId: string
  tradeId: string
  makerOrderId: string
  takerOrderId: string
  deadline?: string
}

export interface SignalRMarketHubConnectionOptions {
  engineBaseUrl: string
  nostrSecretKeyHex: string
  onError?: (err: Error) => void
}

export class SignalRMarketHubConnection {
  private readonly hubUrl: string
  private readonly engineBaseUrl: string
  private readonly nostrSecretKeyHex: string
  private readonly callbacks: SignalRMarketHubConnectionOptions
  private connection: HubConnectionLike | null = null
  private callbackChain: Promise<void> = Promise.resolve()
  private readonly knownOrderIds = new Set<string>()
  private readonly joinedMarkets = new Set<string>()
  private readonly processedTradeIds = new Set<string>()

  constructor(options: SignalRMarketHubConnectionOptions) {
    this.engineBaseUrl = options.engineBaseUrl.replace(/\/+$/, '')
    this.hubUrl = `${this.engineBaseUrl}/hubs/market`
    this.nostrSecretKeyHex = options.nostrSecretKeyHex
    this.callbacks = options
  }

  async start(): Promise<void> {
    if (this.connection) return
    const { HubConnectionBuilder } = require(
      '@microsoft/signalr',
    ) as SignalRModule
    const connection = new HubConnectionBuilder()
      .withUrl(this.hubUrl, {
        accessTokenFactory: () =>
          signNip98(
            { privateKeyHex: this.nostrSecretKeyHex },
            this.hubUrl,
            'POST',
          ).replace(/^Nostr\s+/, ''),
      })
      .withAutomaticReconnect([0, 2_000, 5_000, 10_000, 30_000])
      .build()
    this.registerHandlers(connection)
    await connection.start()
    this.connection = connection
    for (const marketId of this.joinedMarkets) {
      await connection.invoke('JoinMarket', marketId)
    }
  }

  async stop(): Promise<void> {
    const connection = this.connection
    this.connection = null
    await connection?.stop()
  }

  async trackOrder(marketId: string, orderId: string): Promise<void> {
    this.knownOrderIds.add(orderId)
    this.joinedMarkets.add(marketId)
    await this.connection?.invoke('JoinMarket', marketId)
  }

  private registerHandlers(connection: HubConnectionLike): void {
    connection.on('Matched', (delta: unknown) => {
      void this.invokeCallback(async () => {
        await handleMatchedForMaker({
          delta: parseMatchedDelta(delta),
          processedTradeIds: this.processedTradeIds,
          knownOrderIds: this.knownOrderIds,
          getOrCreateEphemeralKeypair: (tradeId) =>
            getOrCreateStoredEphemeralKeypair({
              tradeId,
              orderId: parseMatchedDelta(delta).makerOrderId,
              marketId: parseMatchedDelta(delta).marketId,
            }),
          submitEphemeralPubkey: async (tradeId, pubkey, conditionId) => {
            await submitEphemeralPubkeyRequest(
              this.engineBaseUrl,
              tradeId,
              pubkey,
              null,
              fetch,
              async ({ url, method, bodyText }) =>
                signNip98(
                  { privateKeyHex: this.nostrSecretKeyHex },
                  url,
                  method,
                  bodyText,
                ),
              conditionId,
            )
          },
        })
      })
    })
  }

  private invokeCallback(callback: () => Promise<void>): Promise<void> {
    const run = this.callbackChain.then(async () => {
      try {
        await callback()
      } catch (err) {
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
      }
    })
    this.callbackChain = run.catch(() => {})
    return run
  }
}

export async function handleMatchedForMaker(input: {
  delta: MarketMatchedDelta
  processedTradeIds: Set<string>
  knownOrderIds: Set<string>
  getOrCreateEphemeralKeypair: (tradeId: string) => Promise<OrderEphemeralKeypair>
  submitEphemeralPubkey: (
    tradeId: string,
    pubkey: string,
    conditionId?: string,
  ) => Promise<void>
}): Promise<void> {
  if (input.processedTradeIds.has(input.delta.tradeId)) return
  if (!input.knownOrderIds.has(input.delta.makerOrderId)) return

  input.processedTradeIds.add(input.delta.tradeId)
  const key = await input.getOrCreateEphemeralKeypair(input.delta.tradeId)
  await input.submitEphemeralPubkey(
    input.delta.tradeId,
    key.publicKeyHex,
    conditionIdFromMarketId(input.delta.marketId),
  )
}

async function getOrCreateStoredEphemeralKeypair(input: {
  tradeId: string
  orderId: string
  marketId: string
}): Promise<OrderEphemeralKeypair> {
  const existing = (await readSecrets())?.orderEphemeralKeys[input.tradeId]
  if (existing) {
    return {
      privateKeyHex: existing.privateKeyHex,
      publicKeyHex: existing.publicKeyHex,
    }
  }

  const created = generateOrderEphemeralKeypair()
  await updateSecrets((current, now) => {
    current.orderEphemeralKeys[input.tradeId] = {
      orderId: input.orderId,
      tradeId: input.tradeId,
      marketId: input.marketId,
      privateKeyHex: created.privateKeyHex,
      publicKeyHex: created.publicKeyHex,
      createdAt: now,
    }
  })
  return created
}

function parseMatchedDelta(value: unknown): MarketMatchedDelta {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Matched payload had unexpected shape')
  }
  const record = value as Record<string, unknown>
  const delta = {
    marketId: stringField(record, 'marketId') ?? stringField(record, 'MarketId'),
    tradeId: stringField(record, 'tradeId') ?? stringField(record, 'TradeId'),
    makerOrderId:
      stringField(record, 'makerOrderId') ?? stringField(record, 'MakerOrderId'),
    takerOrderId:
      stringField(record, 'takerOrderId') ?? stringField(record, 'TakerOrderId'),
    deadline: stringField(record, 'deadline') ?? stringField(record, 'Deadline'),
  }
  if (!delta.marketId || !delta.tradeId || !delta.makerOrderId || !delta.takerOrderId) {
    throw new Error('Matched payload had unexpected shape')
  }
  return delta as MarketMatchedDelta
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function conditionIdFromMarketId(marketId: string): string | undefined {
  const index = marketId.lastIndexOf('-')
  return index > 0 ? marketId.substring(0, index) : undefined
}
