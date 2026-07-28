import { createRequire } from 'node:module'
import {
  normalizeMarketBaseAsset,
  normalizeMarketDivisibility,
} from '@bitcaster-market/client-sdk/marketUnits'
import { signNip98 } from './nostrAuth.ts'
import type { DaemonTradeCreatedPayload } from './state.ts'
import type { TradeJoinResult, TradeRuntimeConnection } from './tradeRuntime.ts'

const require = createRequire(import.meta.url)

interface SignalRModule {
  HubConnectionBuilder: new () => HubConnectionBuilderLike
}

interface HubConnectionBuilderLike {
  withUrl(url: string, options: { accessTokenFactory: () => string }): HubConnectionBuilderLike
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
  onPendingPubkeyRequired?: (
    tradeId: string,
    orderId: string,
    role: string,
    marketId: string,
    deadline: string,
  ) => void | Promise<void>
  onError?: (err: Error) => void
}

export function parseTradeCreatedPayload(
  tradeId: unknown,
  sellerPubkey: unknown,
  buyerPubkey: unknown,
  sellerLocktime: unknown,
  buyerLocktime: unknown,
  marketId: unknown,
  fillAmountSubunits?: unknown,
  outcomeFaceAmountSubunits?: unknown,
  quotePaymentSubunits?: unknown,
  settlementKind?: unknown,
  sellerKeepOutcomeSetId?: unknown,
  sellerLockOutcomeSetId?: unknown,
  baseAsset?: unknown,
  collateralUnit?: unknown,
  divisibility?: unknown,
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
    !marketId.trim() ||
    collateralUnit !== 'msat'
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
    fillAmountSubunits: numberOrUndefined(fillAmountSubunits),
    outcomeFaceAmountSubunits: numberOrUndefined(outcomeFaceAmountSubunits),
    quotePaymentSubunits: numberOrUndefined(quotePaymentSubunits),
    settlementKind: typeof settlementKind === 'string' ? settlementKind : null,
    sellerKeepOutcomeSetId:
      typeof sellerKeepOutcomeSetId === 'string' ? sellerKeepOutcomeSetId : null,
    sellerLockOutcomeSetId:
      typeof sellerLockOutcomeSetId === 'string' ? sellerLockOutcomeSetId : null,
    baseAsset: normalizeMarketBaseAsset(baseAsset),
    collateralUnit,
    divisibility: normalizeMarketDivisibility(divisibility, 'sat'),
  }
}

export class SignalRTradeHubConnection implements TradeRuntimeConnection {
  private readonly hubUrl: string
  private readonly nostrSecretKeyHex: string
  private readonly callbacks: SignalRTradeHubConnectionOptions
  private connection: HubConnectionLike | null = null
  private callbackChain: Promise<void> = Promise.resolve()

  constructor(options: SignalRTradeHubConnectionOptions) {
    this.hubUrl = `${options.engineBaseUrl.replace(/\/+$/, '')}/hubs/trade`
    this.nostrSecretKeyHex = options.nostrSecretKeyHex
    this.callbacks = options
  }

  async start(): Promise<void> {
    if (this.connection) return
    const { HubConnectionBuilder } = require('@microsoft/signalr') as SignalRModule
    const connection = new HubConnectionBuilder()
      .withUrl(this.hubUrl, {
        accessTokenFactory: () =>
          signNip98({ privateKeyHex: this.nostrSecretKeyHex }, this.hubUrl, 'POST').replace(
            /^Nostr\s+/,
            '',
          ),
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

  async joinTrade(tradeId: string): Promise<TradeJoinResult> {
    try {
      await this.requireConnection().invoke('JoinTrade', tradeId)
      return { success: true }
    } catch (err) {
      if (isJoinTradeReplayMiss(err)) {
        return { success: false, error: errorMessage(err) }
      }
      throw err
    }
  }

  async sendSwapMessage(tradeId: string, messageType: string, ciphertext: string): Promise<void> {
    await this.requireConnection().invoke('SendSwapMessage', tradeId, messageType, ciphertext)
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
        fillAmountSubunits?: unknown,
        outcomeFaceAmountSubunits?: unknown,
        quotePaymentSubunits?: unknown,
        settlementKind?: unknown,
        sellerKeepOutcomeSetId?: unknown,
        sellerLockOutcomeSetId?: unknown,
        baseAsset?: unknown,
        collateralUnit?: unknown,
        divisibility?: unknown,
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
              fillAmountSubunits,
              outcomeFaceAmountSubunits,
              quotePaymentSubunits,
              settlementKind,
              sellerKeepOutcomeSetId,
              sellerLockOutcomeSetId,
              baseAsset,
              collateralUnit,
              divisibility,
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
          if (!tradeIdText || typeof messageType !== 'string' || typeof ciphertext !== 'string') {
            throw new Error('SwapMessageReceived payload had unexpected shape')
          }
          await this.callbacks.onSwapMessageReceived?.(tradeIdText, messageType, ciphertext)
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

    connection.on(
      'PendingPubkeyRequired',
      (tradeId: unknown, orderId: unknown, role: unknown, marketId: unknown, deadline: unknown) => {
        void this.invokeCallback(async () => {
          const tradeIdText = stringFromSignalR(tradeId)
          const orderIdText = stringFromSignalR(orderId)
          const marketIdText = stringFromSignalR(marketId)
          if (!tradeIdText || !orderIdText || !marketIdText) {
            throw new Error('PendingPubkeyRequired payload had unexpected shape')
          }
          await this.callbacks.onPendingPubkeyRequired?.(
            tradeIdText,
            orderIdText,
            typeof role === 'string' ? role : '',
            marketIdText,
            deadline instanceof Date
              ? deadline.toISOString()
              : typeof deadline === 'string'
                ? deadline
                : '',
          )
        })
      },
    )
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

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringFromSignalR(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (value instanceof Date) return value.toISOString()
  return null
}

function isJoinTradeReplayMiss(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  const message = err.message.toLowerCase()
  return (
    err.name === 'HubException' ||
    message.includes('hubexception') ||
    message.includes('not authorised') ||
    message.includes('not authorized') ||
    message.includes('not found') ||
    message.includes('does not exist')
  )
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
