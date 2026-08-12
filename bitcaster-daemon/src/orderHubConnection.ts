import { createRequire } from 'node:module'
import {
  decodeOrderLifecycleChangedDelta,
  decodeSettlementGroupStateChangedDelta,
} from '@bitcaster-market/client-sdk/engineClient'
import { signNip98 } from './nostrAuth.ts'

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
  onreconnected?(callback: () => void): void
  onclose?(callback: (error?: Error) => void): void
  invoke(methodName: string, ...args: unknown[]): Promise<unknown>
}

export interface OrderLifecycleDelta {
  readonly orderId: string
  readonly marketId: string
}

export interface SignalROrderLifecycleConnectionOptions {
  engineBaseUrl: string
  nostrSecretKeyHex: string
  onOrderLifecycleChanged?: (delta: OrderLifecycleDelta) => void | Promise<void>
  onSettlementGroupStateChanged?: (delta: OrderLifecycleDelta) => void | Promise<void>
  onReconnected?: () => void | Promise<void>
  onError?: (err: Error) => void
}

export function parseOrderLifecycleChanged(value: unknown): OrderLifecycleDelta {
  const delta = decodeOrderLifecycleChangedDelta(value)
  return { orderId: delta.orderId, marketId: delta.marketId }
}

export function parseSettlementGroupStateChanged(value: unknown): OrderLifecycleDelta {
  const delta = decodeSettlementGroupStateChangedDelta(value)
  return { orderId: delta.orderId, marketId: delta.marketId }
}

/**
 * This client connects to OrderHub and uses retained order lifecycle callbacks.
 */
export class SignalROrderLifecycleConnection {
  private readonly hubUrl: string
  private readonly nostrSecretKeyHex: string
  private readonly callbacks: SignalROrderLifecycleConnectionOptions
  private connection: HubConnectionLike | null = null
  private callbackChain: Promise<void> = Promise.resolve()
  private readonly joinedOrders = new Map<string, string>()
  private stopped = true

  constructor(options: SignalROrderLifecycleConnectionOptions) {
    this.hubUrl = `${options.engineBaseUrl.replace(/\/+$/, '')}/hubs/order`
    this.nostrSecretKeyHex = options.nostrSecretKeyHex
    this.callbacks = options
  }

  async start(): Promise<void> {
    if (this.connection) return
    this.stopped = false
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
    connection.onreconnected?.(() => {
      void this.invokeCallback(async () => {
        await this.joinTrackedOrders(connection)
        await this.callbacks.onReconnected?.()
      })
    })
    connection.onclose?.((error) => {
      if (error) this.callbacks.onError?.(error)
      if (!this.stopped) void this.restartAfterClose(connection)
    })
    try {
      await connection.start()
    } catch (error) {
      this.stopped = true
      throw error
    }
    if (this.stopped) {
      await connection.stop()
      return
    }
    this.connection = connection
    await this.joinTrackedOrders(connection)
  }

  async stop(): Promise<void> {
    this.stopped = true
    const connection = this.connection
    this.connection = null
    await connection?.stop()
  }

  async trackOrder(marketId: string, orderId: string): Promise<void> {
    this.joinedOrders.set(orderId, marketId)
    await this.connection?.invoke('JoinOrder', marketId, orderId)
  }

  private registerHandlers(connection: HubConnectionLike): void {
    connection.on('OrderLifecycleChanged', (value: unknown) => {
      void this.invokeCallback(async () => {
        await this.callbacks.onOrderLifecycleChanged?.(parseOrderLifecycleChanged(value))
      })
    })
    connection.on('SettlementGroupStateChanged', (value: unknown) => {
      void this.invokeCallback(async () => {
        await this.callbacks.onSettlementGroupStateChanged?.(
          parseSettlementGroupStateChanged(value),
        )
      })
    })
  }

  private async restartAfterClose(connection: HubConnectionLike): Promise<void> {
    const retryDelays = [0, 2_000, 5_000, 10_000, 30_000]
    let attempt = 0
    while (!this.stopped) {
      const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)]
      attempt += 1
      if (delay > 0) await sleep(delay)
      if (this.stopped) return
      try {
        await connection.start()
      } catch (error) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))
        continue
      }
      if (this.stopped) {
        await connection.stop()
        return
      }
      this.connection = connection
      await this.joinTrackedOrders(connection)
      await this.invokeCallback(async () => {
        await this.callbacks.onReconnected?.()
      })
      return
    }
  }

  private async joinTrackedOrders(connection: HubConnectionLike): Promise<void> {
    for (const [orderId, marketId] of this.joinedOrders) {
      try {
        await connection.invoke('JoinOrder', marketId, orderId)
      } catch (error) {
        this.callbacks.onError?.(error instanceof Error ? error : new Error(String(error)))
      }
    }
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

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
