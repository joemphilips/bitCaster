import { createRequire } from 'node:module'
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
  invoke(methodName: string, ...args: unknown[]): Promise<unknown>
  onreconnected?(callback: () => void): void
}

export interface SignalRMarketHubConnectionOptions {
  engineBaseUrl: string
  nostrSecretKeyHex: string
  onMarketStatusChanged?: (status: MarketStatusChanged) => Promise<void>
  onReconnected?: () => Promise<void>
  onError?: (err: Error) => void
}

export interface MarketStatusChanged {
  readonly conditionId: string
  readonly state: 'open' | 'closed'
  readonly closedAt: string | null
  readonly finalOutcome: string | null
}

export class SignalRMarketHubConnection {
  private readonly hubUrl: string
  private readonly engineBaseUrl: string
  private readonly nostrSecretKeyHex: string
  private readonly callbacks: SignalRMarketHubConnectionOptions
  private connection: HubConnectionLike | null = null
  private callbackChain: Promise<void> = Promise.resolve()
  private readonly joinedMarkets = new Set<string>()

  constructor(options: SignalRMarketHubConnectionOptions) {
    this.engineBaseUrl = options.engineBaseUrl.replace(/\/+$/, '')
    this.hubUrl = `${this.engineBaseUrl}/hubs/market`
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
    connection.onreconnected?.(() => {
      void this.invokeCallback(async () => {
        for (const marketId of this.joinedMarkets) await connection.invoke('JoinMarket', marketId)
        await this.callbacks.onReconnected?.()
      })
    })
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

  async trackMarket(marketId: string): Promise<void> {
    this.joinedMarkets.add(marketId)
    await this.connection?.invoke('JoinMarket', marketId)
  }

  private registerHandlers(connection: HubConnectionLike): void {
    connection.on('MarketStatusChanged', (value: unknown) => {
      void this.invokeCallback(async () => {
        await this.callbacks.onMarketStatusChanged?.(parseMarketStatusChanged(value))
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

export function parseMarketStatusChanged(value: unknown): MarketStatusChanged {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('MarketStatusChanged payload is invalid')
  }
  const status = value as Record<string, unknown>
  const keys = Object.keys(status).sort()
  if (keys.join('\0') !== ['closedAt', 'conditionId', 'finalOutcome', 'state'].join('\0')) {
    throw new Error('MarketStatusChanged payload fields are invalid')
  }
  const conditionId = typeof status.conditionId === 'string' ? status.conditionId.toLowerCase() : ''
  if (!/^[0-9a-f]{64}$/.test(conditionId)) {
    throw new Error('MarketStatusChanged condition is invalid')
  }
  if (status.state !== 'open' && status.state !== 'closed') {
    throw new Error('MarketStatusChanged state is invalid')
  }
  const closedAt = optionalString(status.closedAt, 'MarketStatusChanged closed time')
  const finalOutcome = optionalString(status.finalOutcome, 'MarketStatusChanged final outcome')
  if (
    (status.state === 'open' && (closedAt !== null || finalOutcome !== null)) ||
    (status.state === 'closed' && closedAt === null)
  ) {
    throw new Error('MarketStatusChanged lifecycle fields are invalid')
  }
  return { conditionId, state: status.state, closedAt, finalOutcome }
}

function optionalString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`)
  return value
}
