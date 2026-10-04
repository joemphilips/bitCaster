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
  onreconnecting?(callback: () => void): void
  onclose?(callback: () => void): void
}

export interface SignalRMarketHubConnectionOptions {
  engineBaseUrl: string
  nostrSecretKeyHex: string
  onMarketStatusChanged?: (status: MarketStatusChanged) => Promise<void>
  onReconnected?: () => Promise<void>
  onMarketInvalidated?: (conditionId: string) => Promise<void>
  onDisconnected?: () => void
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
  private readonly nostrSecretKeyHex: string
  private readonly callbacks: SignalRMarketHubConnectionOptions
  private session: MarketHubSession | null = null
  private readonly owners = new Map<object, Set<string>>()
  private readonly valuationOwners = new Map<object, Set<string>>()
  private readonly managedOwner = {}
  private desiredMarkets = new Set<string>()
  private desiredValuations = new Set<string>()
  private desiredConditions = new Set<string>()
  private readonly pending = new Map<string, MarketStatusChanged | null>()
  private reconnectPending = false
  private delivering = false

  constructor(options: SignalRMarketHubConnectionOptions) {
    this.hubUrl = `${options.engineBaseUrl.replace(/\/+$/, '')}/hubs/market`
    this.nostrSecretKeyHex = options.nostrSecretKeyHex
    this.callbacks = options
  }

  async start(): Promise<void> {
    if (this.session !== null) return this.session.start
    const session = this.createSession()
    this.session = session
    this.registerHandlers(session)
    this.registerLifecycle(session)
    // Retain the connection before awaiting start so stop can cancel setup.
    session.start = Promise.resolve().then(async () => {
      if (this.session !== session) throw new Error('market hub start was cancelled')
      try {
        await session.connection.start()
        if (this.session !== session) throw new Error('market hub start was cancelled')
        session.ready = true
        await this.synchronize(session)
      } catch (error) {
        if (this.session === session) this.session = null
        await session.connection.stop().catch(() => undefined)
        throw error
      }
    })
    return session.start
  }

  private createSession(): MarketHubSession {
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
    return {
      connection,
      ready: false,
      epoch: 0,
      joined: new Set(),
      valuations: new Set(),
      start: Promise.resolve(),
      synchronizing: null,
    }
  }

  private registerLifecycle(session: MarketHubSession): void {
    const { connection } = session
    const disconnected = () => {
      if (this.session !== session) return
      session.ready = false
      session.epoch += 1
      session.joined.clear()
      session.valuations.clear()
      this.pending.clear()
      this.reconnectPending = false
      this.callbacks.onDisconnected?.()
    }
    connection.onreconnecting?.(disconnected)
    connection.onclose?.(() => {
      disconnected()
      if (this.session === session) this.session = null
    })
    connection.onreconnected?.(() => {
      if (this.session !== session) return
      session.ready = true
      session.epoch += 1
      session.joined.clear()
      session.valuations.clear()
      void this.synchronize(session)
        .then(() => {
          if (this.session !== session || !session.ready) return
          this.reconnectPending = true
          void this.deliver()
        })
        .catch((error: unknown) => this.report(error))
    })
  }

  async stop(): Promise<void> {
    const session = this.session
    this.session = null
    this.pending.clear()
    this.reconnectPending = false
    await session?.connection.stop()
  }

  async trackMarket(marketId: string): Promise<void> {
    await this.setMarkets(this.managedOwner, [
      ...(this.owners.get(this.managedOwner) ?? []),
      marketId,
    ])
  }

  setManagedMarkets(marketIds: readonly string[]): Promise<void> {
    return this.setMarkets(this.managedOwner, marketIds)
  }

  async setMarkets(owner: object, marketIds: readonly string[]): Promise<void> {
    const desired = new Set(marketIds)
    if ([...desired].some((id) => !/^[0-9a-f]{64}-[a-zA-Z0-9]+$/.test(id)))
      throw new Error('market hub route identity is invalid')
    if (desired.size === 0) this.owners.delete(owner)
    else this.owners.set(owner, desired)
    this.desiredMarkets = new Set([...this.owners.values()].flatMap((ids) => [...ids]))
    this.updateDesiredConditions()
    if (this.session !== null) await this.synchronize(this.session)
  }

  async setPortfolioValuationConditions(
    owner: object,
    conditionIds: readonly string[],
  ): Promise<void> {
    if (conditionIds.length > 200 || conditionIds.some((id) => !/^[0-9a-fA-F]{1,128}$/.test(id)))
      throw new Error('invalid portfolio valuation subscription selection')
    const selected = new Set(conditionIds)
    const combined = new Set([
      ...[...this.valuationOwners].filter(([key]) => key !== owner).flatMap(([, ids]) => [...ids]),
      ...selected,
    ])
    // One connection has one server-side limit. Refuse overflow before replacing any owner.
    if (combined.size > 200)
      throw new Error('at most 200 portfolio valuation conditions are allowed')
    if (selected.size === 0) this.valuationOwners.delete(owner)
    else this.valuationOwners.set(owner, selected)
    this.desiredValuations = combined
    this.updateDesiredConditions()
    if (this.session !== null) await this.synchronize(this.session)
  }

  releasePortfolioValuationConditions(owner: object): Promise<void> {
    return this.setPortfolioValuationConditions(owner, [])
  }

  private updateDesiredConditions(): void {
    this.desiredConditions = new Set([
      ...[...this.desiredMarkets].map((id) => id.slice(0, 64)),
      ...this.desiredValuations,
    ])
    for (const conditionId of this.pending.keys())
      if (!this.desiredConditions.has(conditionId)) this.pending.delete(conditionId)
  }

  releaseMarkets(owner: object): Promise<void> {
    return this.setMarkets(owner, [])
  }

  isConnected(): boolean {
    return this.session?.ready ?? false
  }

  private synchronize(session: MarketHubSession): Promise<void> {
    if (session.synchronizing !== null)
      return session.synchronizing.then(() => {
        if (
          this.session === session &&
          session.ready &&
          (!sameSet(session.joined, this.desiredMarkets) ||
            !sameSet(session.valuations, this.desiredValuations))
        )
          return this.synchronize(session)
      })
    const task = Promise.resolve()
      .then(async () => {
        while (this.session === session && session.ready) {
          const remove = [...session.joined].find((id) => !this.desiredMarkets.has(id))
          const add = [...this.desiredMarkets].find((id) => !session.joined.has(id))
          const marketId = remove ?? add
          const epoch = session.epoch
          if (marketId === undefined) {
            if (sameSet(session.valuations, this.desiredValuations)) return
            const desired = new Set(this.desiredValuations)
            await session.connection.invoke(
              'SetPortfolioValuationSubscriptions',
              [...desired].sort(),
            )
            if (session.epoch === epoch) session.valuations = desired
            continue
          }
          await session.connection.invoke(
            remove === undefined ? 'JoinMarket' : 'LeaveMarket',
            marketId,
          )
          if (session.epoch !== epoch) continue
          if (remove === undefined) session.joined.add(marketId)
          else session.joined.delete(marketId)
        }
      })
      .finally(() => {
        if (session.synchronizing === task) session.synchronizing = null
      })
    session.synchronizing = task
    return task
  }

  private registerHandlers(session: MarketHubSession): void {
    const { connection } = session
    connection.on('MarketStatusChanged', (value: unknown) => {
      if (this.session !== session || !session.ready) return
      const conditionId =
        value !== null && typeof value === 'object'
          ? (value as { conditionId?: unknown }).conditionId
          : undefined
      if (
        typeof conditionId === 'string' &&
        this.desiredValuations.has(conditionId) &&
        ![...this.desiredMarkets].some((id) => id.slice(0, 64) === conditionId)
      ) {
        this.invalidate(conditionId)
        // Valuation IDs keep public wire identity. Route retirement uses its stricter decoder.
        return
      }
      try {
        const status = parseMarketStatusChanged(value)
        this.invalidate(status.conditionId, status)
      } catch (error) {
        this.report(error)
      }
    })
    for (const event of ['OrderBookUpdated', 'OrderCancelled'])
      connection.on(event, (value: unknown) => {
        if (
          this.session !== session ||
          !session.ready ||
          value === null ||
          typeof value !== 'object'
        )
          return
        const marketId = (value as { marketId?: unknown }).marketId
        if (typeof marketId === 'string' && this.desiredMarkets.has(marketId))
          this.invalidate(marketId.slice(0, 64))
      })
    for (const event of ['ConfirmedTradeRecorded', 'MarketFundingUpdated', 'MarketCommentsChanged'])
      connection.on(event, (value: unknown) => {
        if (
          this.session !== session ||
          !session.ready ||
          value === null ||
          typeof value !== 'object'
        )
          return
        const conditionId = (value as { conditionId?: unknown }).conditionId
        if (typeof conditionId === 'string') this.invalidate(conditionId)
      })
  }

  private invalidate(conditionId: string, status?: MarketStatusChanged): void {
    if (!this.desiredConditions.has(conditionId)) return
    // A slow consumer needs the next snapshot, not a queue of obsolete deltas.
    this.pending.set(conditionId, status ?? this.pending.get(conditionId) ?? null)
    void this.deliver()
  }

  private async deliver(): Promise<void> {
    if (this.delivering) return
    this.delivering = true
    try {
      while (this.session !== null && (this.reconnectPending || this.pending.size > 0)) {
        const session = this.session
        try {
          if (this.reconnectPending) {
            this.reconnectPending = false
            await this.callbacks.onReconnected?.()
            continue
          }
          const [conditionId, status] = this.pending.entries().next().value!
          this.pending.delete(conditionId)
          if (status !== null) await this.callbacks.onMarketStatusChanged?.(status)
          if (this.session === session && this.desiredConditions.has(conditionId))
            await this.callbacks.onMarketInvalidated?.(conditionId)
        } catch (error) {
          this.report(error)
        }
      }
    } finally {
      this.delivering = false
    }
  }

  private report(error: unknown): void {
    this.callbacks.onError?.(error instanceof Error ? error : new Error('market hub failed'))
  }
}

interface MarketHubSession {
  connection: HubConnectionLike
  start: Promise<void>
  ready: boolean
  epoch: number
  joined: Set<string>
  valuations: Set<string>
  synchronizing: Promise<void> | null
}

function sameSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((id) => right.has(id))
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
