/** Display repair hints carry no custody or settlement authority. */
export interface MarketResyncRequiredMessage {
  token: string
  conditionId: string | null
}

export interface OrderResyncRequiredMessage {
  token: string
}

const TOKEN = /^[0-9a-f]{32}$/
const CONDITION = /^[0-9a-f]{64}$/

function requireToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length !== 32 || !TOKEN.test(value)) {
    throw new TypeError('Invalid display resync token')
  }
}

function requireRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid display resync message')
  }
  const own = Reflect.ownKeys(value)
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  ) {
    throw new TypeError('Invalid display resync message fields')
  }
  return value as Record<string, unknown>
}

export function decodeMarketResyncRequired(value: unknown): MarketResyncRequiredMessage {
  const record = requireRecord(value, ['token', 'conditionId'])
  requireToken(record.token)
  if (
    record.conditionId !== null &&
    (typeof record.conditionId !== 'string' ||
      record.conditionId.length !== 64 ||
      !CONDITION.test(record.conditionId))
  ) {
    throw new TypeError('Invalid display resync condition')
  }
  return { token: record.token, conditionId: record.conditionId as string | null }
}

export function decodeOrderResyncRequired(value: unknown): OrderResyncRequiredMessage {
  const record = requireRecord(value, ['token'])
  requireToken(record.token)
  return { token: record.token }
}

export interface DisplayResyncScheduler {
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>
  random(): number
}

export interface DisplayResyncRepairOptions {
  /** Resolve only after every required snapshot was read and applied to this scope. */
  repair(signal: AbortSignal): Promise<void>
  /** Optional diagnostics. Throwing here does not discard the pending repair. */
  onError?(error: unknown): void
  scheduler?: DisplayResyncScheduler
  /** Initial delay is random from zero to this bound, once per idle-to-pending repair. Range: 0–1000 ms. */
  initialJitterMs?: number
}

export interface DisplayResyncRepair {
  /** True only when a new demand is accepted. Equality coalesces opaque tokens. */
  request(token: string): boolean
  /** Record a local read demand. Start immediately; do not interrupt failure backoff. */
  invalidate(): void
  /** Includes retries and any newer token received during the active repair. */
  whenIdle(): Promise<void>
  /** Abort and await the actual repair and delay, including non-cooperative repair code. */
  dispose(): Promise<void>
  readonly pending: boolean
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** One coordinator belongs to one current route or identity scope. Dispose it on scope change. */
export function createDisplayResyncRepair(
  options: DisplayResyncRepairOptions,
): DisplayResyncRepair {
  const initialJitterMs = options.initialJitterMs ?? 0
  if (!Number.isInteger(initialJitterMs) || initialJitterMs < 0 || initialJitterMs > 1000) {
    throw new TypeError('Invalid initial display repair jitter')
  }
  const scheduler = options.scheduler ?? { sleep, random: Math.random }
  const controller = new AbortController()
  let active: string | symbol | null = null
  let dirty: string | symbol | null = null
  let completed: string | symbol | null = null
  let runner: Promise<void> | null = null
  let idle = Promise.resolve()
  let resolveIdle: (() => void) | null = null
  let disposed = false
  let disposal: Promise<void> | null = null
  let initialDelay: AbortController | null = null
  let immediateStart = false

  const report = (error: unknown) => {
    try {
      options.onError?.(error)
    } catch {
      /* Diagnostics cannot discard repair. */
    }
  }

  const randomUnit = () => {
    let sample = 0.5
    try {
      sample = scheduler.random()
    } catch (error) {
      report(error)
    }
    return Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5
  }

  const wait = async (milliseconds: number, signal = controller.signal) => {
    if (milliseconds === 0) return
    try {
      await scheduler.sleep(milliseconds, signal)
    } catch (error) {
      if (disposed || signal.aborted) throw error
      report(error)
      await sleep(milliseconds, signal)
    }
  }

  const pump = async () => {
    let failures = 0
    try {
      active = dirty
      // Only remote controls spread initial fan-out. Local invalidation can
      // interrupt this initial delay, but never the failure retry delay below.
      if (!disposed && !immediateStart && typeof active === 'string' && initialJitterMs > 0) {
        const delay = new AbortController()
        initialDelay = delay
        const abort = () => delay.abort(controller.signal.reason)
        controller.signal.addEventListener('abort', abort, { once: true })
        try {
          await wait(Math.round(initialJitterMs * randomUnit()), delay.signal)
        } catch (error) {
          if (!delay.signal.aborted) throw error
        } finally {
          controller.signal.removeEventListener('abort', abort)
          initialDelay = null
        }
      }
      immediateStart = false
      while (!disposed && dirty !== null) {
        active = dirty
        try {
          await options.repair(controller.signal)
          if (disposed) break
          completed = active
          if (dirty === active) dirty = null
          failures = 0
        } catch (error) {
          if (disposed) break
          report(error)
          failures = Math.min(failures + 1, 7)
          const ceiling = Math.min(10_000, 250 * 2 ** (failures - 1))
          // Retry only a recorded gap. A newer token during this wait remains
          // dirty and its next complete snapshot repair supersedes this attempt.
          await wait(Math.round(ceiling * (0.5 + randomUnit() * 0.5)))
        }
      }
    } catch (error) {
      if (!disposed) report(error)
    } finally {
      active = null
      runner = null
      if (disposed || dirty === null) {
        dirty = null
        resolveIdle?.()
        resolveIdle = null
      }
    }
  }

  const start = () => {
    if (runner !== null || disposed) return
    if (resolveIdle === null)
      idle = new Promise<void>((resolve) => {
        resolveIdle = resolve
      })
    runner = Promise.resolve().then(pump)
  }

  return {
    request(token) {
      requireToken(token)
      if (disposed || token === active || token === dirty || token === completed) return false
      dirty = token
      start()
      return true
    },
    invalidate() {
      if (disposed) return
      dirty = Symbol('local display invalidation')
      if (active === null || initialDelay !== null) immediateStart = true
      initialDelay?.abort()
      start()
    },
    whenIdle: () => idle,
    dispose() {
      if (disposal !== null) return disposal
      disposed = true
      controller.abort(new DOMException('Display repair disposed', 'AbortError'))
      disposal = (runner ?? Promise.resolve()).then(() => {
        dirty = null
      })
      return disposal
    },
    get pending() {
      return dirty !== null
    },
  }
}
