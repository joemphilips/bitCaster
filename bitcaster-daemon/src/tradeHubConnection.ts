import { createRequire } from 'node:module'
import { signNip98 } from './nostrAuth.ts'
import type { DaemonTradeCreatedPayload } from './state.ts'
import type { TradeRuntimeConnection } from './tradeRuntime.ts'

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

export interface SignalRTradeHubConnectionOptions {
  engineBaseUrl: string
  nostrSecretKeyHex: string
  onTradeCreated?: (payload: DaemonTradeCreatedPayload) => void | Promise<void>
  onSwapMessageReceived?: (
    tradeId: string,
    messageType: string,
    ciphertext: string,
  ) => void | Promise<void>
  onTradeStateChanged?: (tradeId: string, newState: string) => void | Promise<void>
  onError?: (err: Error) => void
}

export function parseTradeCreatedPayload(
  tradeId: unknown,
  sellerPubkey: unknown,
  buyerPubkey: unknown,
  sellerLocktime: unknown,
  buyerLocktime: unknown,
  marketId: unknown,
  fillAmountSats?: unknown,
  outcomeFaceAmountSats?: unknown,
  quotePaymentSats?: unknown,
  settlementKind?: unknown,
  sellerKeepOutcomeSetId?: unknown,
  sellerLockOutcomeSetId?: unknown,
): DaemonTradeCreatedPayload {
  const tradeIdText = stringFromSignalR(tradeId)
  const sellerPubkeyText = stringFromSignalR(sellerPubkey)
  const buyerPubkeyText = stringFromSignalR(buyerPubkey)
  const sellerLocktimeText = stringFromSignalR(sellerLocktime)
  const buyerLocktimeText = stringFromSignalR(buyerLocktime)
  if (
    !tradeIdText ||
    !sellerPubkeyText ||
    !buyerPubkeyText ||
    !sellerLocktimeText ||
    !buyerLocktimeText ||
    typeof marketId !== 'string' ||
    !marketId.trim()
  ) {
    throw new Error('TradeCreated payload had unexpected shape')
  }

  return {
    tradeId: tradeIdText,
    sellerPubkey: sellerPubkeyText,
    buyerPubkey: buyerPubkeyText,
    sellerLocktime: sellerLocktimeText,
    buyerLocktime: buyerLocktimeText,
    marketId,
    fillAmountSats: numberOrUndefined(fillAmountSats),
    outcomeFaceAmountSats: numberOrUndefined(outcomeFaceAmountSats),
    quotePaymentSats: numberOrUndefined(quotePaymentSats),
    settlementKind:
      typeof settlementKind === 'string' ? settlementKind : null,
    sellerKeepOutcomeSetId:
      typeof sellerKeepOutcomeSetId === 'string'
        ? sellerKeepOutcomeSetId
        : null,
    sellerLockOutcomeSetId:
      typeof sellerLockOutcomeSetId === 'string'
        ? sellerLockOutcomeSetId
        : null,
  }
}

export class SignalRTradeHubConnection implements TradeRuntimeConnection {
  private readonly hubUrl: string
  private readonly nostrSecretKeyHex: string
  private readonly callbacks: SignalRTradeHubConnectionOptions
  private connection: HubConnectionLike | null = null

  constructor(options: SignalRTradeHubConnectionOptions) {
    this.hubUrl = `${options.engineBaseUrl.replace(/\/+$/, '')}/hubs/trade`
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
  }

  async stop(): Promise<void> {
    const connection = this.connection
    this.connection = null
    await connection?.stop()
  }

  async joinOrder(marketId: string, orderId: string): Promise<void> {
    await this.requireConnection().invoke('JoinOrder', marketId, orderId)
  }

  async joinTrade(tradeId: string): Promise<void> {
    await this.requireConnection().invoke('JoinTrade', tradeId)
  }

  async sendSwapMessage(
    tradeId: string,
    messageType: string,
    ciphertext: string,
  ): Promise<void> {
    await this.requireConnection().invoke(
      'SendSwapMessage',
      tradeId,
      messageType,
      ciphertext,
    )
  }

  private requireConnection(): HubConnectionLike {
    if (!this.connection) throw new Error('TradeHub connection is not started')
    return this.connection
  }

  private registerHandlers(connection: HubConnectionLike): void {
    connection.on(
      'TradeCreated',
      (
        tradeId: unknown,
        sellerPubkey: unknown,
        buyerPubkey: unknown,
        sellerLocktime: unknown,
        buyerLocktime: unknown,
        marketId?: unknown,
        fillAmountSats?: unknown,
        outcomeFaceAmountSats?: unknown,
        quotePaymentSats?: unknown,
        settlementKind?: unknown,
        sellerKeepOutcomeSetId?: unknown,
        sellerLockOutcomeSetId?: unknown,
      ) => {
        void this.invokeCallback(async () => {
          await this.callbacks.onTradeCreated?.(
            parseTradeCreatedPayload(
              tradeId,
              sellerPubkey,
              buyerPubkey,
              sellerLocktime,
              buyerLocktime,
              marketId,
              fillAmountSats,
              outcomeFaceAmountSats,
              quotePaymentSats,
              settlementKind,
              sellerKeepOutcomeSetId,
              sellerLockOutcomeSetId,
            ),
          )
        })
      },
    )

    connection.on(
      'SwapMessageReceived',
      (tradeId: unknown, messageType: unknown, ciphertext: unknown) => {
        void this.invokeCallback(async () => {
          const tradeIdText = stringFromSignalR(tradeId)
          if (
            !tradeIdText ||
            typeof messageType !== 'string' ||
            typeof ciphertext !== 'string'
          ) {
            throw new Error('SwapMessageReceived payload had unexpected shape')
          }
          await this.callbacks.onSwapMessageReceived?.(
            tradeIdText,
            messageType,
            ciphertext,
          )
        })
      },
    )

    connection.on('TradeStateChanged', (tradeId: unknown, newState: unknown) => {
      void this.invokeCallback(async () => {
        const tradeIdText = stringFromSignalR(tradeId)
        if (!tradeIdText || typeof newState !== 'string') {
          throw new Error('TradeStateChanged payload had unexpected shape')
        }
        await this.callbacks.onTradeStateChanged?.(tradeIdText, newState)
      })
    })
  }

  private async invokeCallback(callback: () => Promise<void>): Promise<void> {
    try {
      await callback()
    } catch (err) {
      this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringFromSignalR(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value instanceof Date) return value.toISOString()
  return null
}
