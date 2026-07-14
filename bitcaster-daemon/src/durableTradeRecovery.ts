import {
  CheckStateEnum,
  type ProofState,
} from '@cashu/cashu-ts'
import { createHash } from 'node:crypto'
import {
  createDurableTradeRecoveryResultAccumulator,
  recoverDurableTradeSessions,
  reduceDurableTradeSession,
  validateDurableProofOperationLink,
  validateDurableTradeSession,
  type DurableTradeAtomicTransitionPort,
  type DurableProofOperationRepository,
  type DurableTradeProofOperationLink,
  type DurableTradeRecoveryPorts,
  type DurableTradeRecoveryResult,
  type DurableTradeRetryRequest,
  type DurableTradeSession,
  type DurableTradeSessionRepository,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import {
  assertProofOperationCustodyBound,
  ensureState,
  markProofOperationMintSubmitted,
  readCanonicalProofOperationRecoveryPage,
  readActiveSwapIdsPage,
  readStateScope,
  updateState,
  type DaemonState,
  type ProofOperationRecord,
} from './state.ts'
import type { TradeRuntimeConnection } from './tradeRuntime.ts'
import type { DaemonSwapExecutor } from './swapExecutor.ts'
import {
  validateDaemonDurableOperationBinding,
  validateDaemonTradeAuthorityBinding,
} from './durableTradeBinding.ts'
import { readProfile } from './profile.ts'
import { readOrderEphemeralSecret } from './secrets.ts'
import {
  createDaemonRecoveryWalletProvider,
  recoverExactDaemonProofOperation,
  type DaemonRecoveryWalletProvider,
  type ExactDaemonProofOperationAction,
} from './swapProtocolAdapter.ts'

export async function getDaemonProofOperationByDurableId(operationId: string) {
  return findOperationRecord(operationId)
}

const DAEMON_RECOVERY_PAGE_LIMIT = 64

/**
 * Adapts the daemon's normalized SQLite store to the SDK recovery repositories.
 * Proof rows retain the concrete Cashu request while this layer exposes only
 * the SDK recovery identity.
 */
export function createDaemonDurableTradeRepositories(snapshot: DaemonState): {
  sessions: DurableTradeSessionRepository
  operations: DurableProofOperationRepository
} {
  return {
    sessions: createDaemonSessionRepository(snapshot),
    operations: createDaemonOperationRepository(snapshot),
  }
}

export interface DaemonDurableTradeRecoveryRunner {
  recover(): Promise<{
    durableRecovery: DurableTradeRecoveryResult
    activeSwaps: number
  }>
  /** Arms event gating before the TradeHub can deliver recovery-sensitive events. */
  armBootstrap(): void
  /** Runs the first coordinator pass and releases events queued during bootstrap. */
  finishBootstrap(): Promise<{
    durableRecovery: DurableTradeRecoveryResult
    activeSwaps: number
  }>
  /**
   * Owns the complete runtime-event transaction: durable journal first,
   * coordinator recovery second, then the executor side effect.
   */
  runTradeEvent<T>(
    tradeId: string,
    persist: () => Promise<T>,
    action: (persisted: T) => Promise<void>,
  ): Promise<void>
  /** Re-enters the owner for a legacy swap retry after exact recovery. */
  recoverTrade(tradeId: string): Promise<void>
  /** Re-enters recovery for a retained exact operation, never fresh swap work. */
  recoverTradeOperation(tradeId: string, operationId: string): Promise<void>
}

export interface DaemonDurableTradeRecoveryRunnerOptions {
  executor: DaemonSwapExecutor
  connection: TradeRuntimeConnection
  /** Test-only seam; production always uses the SDK coordinator below. */
  recoverDurableSessions?: (input: {
    scheduleRetry: (request: DurableTradeRetryRequest) => Promise<void>
    tradeId?: string
  }) => Promise<DurableTradeRecoveryResult>
  loadState?: () => Promise<DaemonState>
  nowMs?: () => number
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

/**
 * Runs coordinator-owned exact recovery before the legacy active-swap sweep.
 * Startup, timers, manual RPC, and runtime events enter one queue so the
 * legacy executor cannot select fresh proofs while a durable link is active.
 */
export function createDaemonDurableTradeRecoveryRunner(
  input: DaemonDurableTradeRecoveryRunnerOptions,
): DaemonDurableTradeRecoveryRunner {
  return new DaemonDurableTradeRecoveryCoordinator(input)
}

/** Runs the SDK-owned recovery policy using daemon-specific storage and transport. */
export async function recoverDaemonDurableTradeSessions(input: {
  executor: DaemonSwapExecutor
  connection: TradeRuntimeConnection
  tradeId?: string
  scheduleRetry?: (request: DurableTradeRetryRequest) => Promise<void>
  /** Test seam; production always dispatches to the persisted-operation adapter. */
  exactOperationAdapter?: (
    record: ProofOperationRecord,
    action: ExactDaemonProofOperationAction,
  ) => Promise<void>
  /** Test seam for SDK policy tests; production always validates local authority. */
  authorityPreflight?: (
    tradeId: string,
    snapshot: DaemonState,
  ) => Promise<void>
}): Promise<DurableTradeRecoveryResult> {
  const recoveryWalletProvider = createDaemonRecoveryWalletProvider()
  if (input.tradeId !== undefined) {
    return recoverDaemonDurableTrade(
      input.tradeId,
      input,
      recoveryWalletProvider,
    )
  }
  const combined = createDurableTradeRecoveryResultAccumulator()
  let cursor: string | null = null
  do {
    const page = await readRecoveryStorage(() =>
      readCanonicalProofOperationRecoveryPage({
        cursor,
        limit: DAEMON_RECOVERY_PAGE_LIMIT,
      }),
    )
    const tradeWork = page.work.filter(
      (work): work is typeof work & { binding: { kind: 'trade'; tradeId: string } } =>
        work.binding.kind === 'trade',
    )
    if (tradeWork.length > 0) {
      const tradeIds = [...new Set(
        tradeWork.map((work) => work.binding.tradeId),
      )]
      const snapshot = await readRecoveryStorage(async () => {
        const state = await readStateScope({ tradeIds, swapIds: tradeIds })
        if (!state) throw new Error('daemon SQLite state row is missing')
        return state
      })
      for (const tradeId of tradeIds) {
        await (input.authorityPreflight ?? assertDaemonTradeRecoveryAuthority)(
          tradeId,
          snapshot,
        )
      }
      for (const work of tradeWork) {
        const operation = snapshot.proofOperations[work.retainedOperationKey]
        if (operation === undefined) {
          throw new Error('canonical trade work has no exact daemon operation')
        }
        if (
          operation.state !== 'prepared' &&
          operation.state !== 'mint-submitted' &&
          operation.state !== 'completed'
        ) {
          throw new Error(
            'canonical trade work has a terminal daemon projection',
          )
        }
        if (operation.durableTradeRecovery?.tradeId !== work.binding.tradeId) {
          throw new Error('canonical trade work has a foreign trade binding')
        }
        await assertProofOperationCustodyBound(operation)
      }
      const ports = createDaemonDurableTradeRecoveryPorts(
        snapshot,
        input,
        recoveryWalletProvider,
      )
      const recovered = await recoverDurableTradeSessions(ports)
      combined.append(recovered)
    }
    cursor = page.nextCursor
  } while (cursor !== null)
  return combined.finish()
}

async function recoverDaemonDurableTrade(
  tradeId: string,
  input: Parameters<typeof recoverDaemonDurableTradeSessions>[0],
  recoveryWalletProvider: DaemonRecoveryWalletProvider,
): Promise<DurableTradeRecoveryResult> {
  const snapshot = await readRecoveryStorage(async () => {
    const state = await readStateScope({
      tradeIds: [tradeId],
      swapIds: [tradeId],
    })
    if (!state) throw new Error('daemon SQLite state row is missing')
    return state
  })
  if (snapshot.durableTradeSessions[tradeId] === undefined) {
    return { sessions: [], orphans: [] }
  }
  await (input.authorityPreflight ?? assertDaemonTradeRecoveryAuthority)(
    tradeId,
    snapshot,
  )
  return recoverDurableTradeSessions(
    createDaemonDurableTradeRecoveryPorts(
      snapshot,
      input,
      recoveryWalletProvider,
    ),
  )
}

async function assertDaemonTradeRecoveryAuthority(
  tradeId: string,
  snapshot: DaemonState,
): Promise<void> {
  const profile = await readProfile()
  const session = snapshot.durableTradeSessions[tradeId]
  const swap = snapshot.swaps[tradeId]
  if (profile === null || session === undefined || swap === undefined) {
    throw new Error('durable trade recovery authority is incomplete')
  }
  const retainedKeyId = session.ephemeralKeyHandle.keyId
  const retainedKey = await readOrderEphemeralSecret(retainedKeyId)
  if (retainedKey === null) {
    throw new Error('durable trade recovery retained key is missing')
  }
  const bindingError = validateDaemonTradeAuthorityBinding({
    tradeId,
    session,
    swap,
    retainedKeyId,
    retainedKey,
    profileMintUrl: profile.mintUrl,
  })
  if (bindingError !== null) {
    throw new Error(`durable trade recovery authority is invalid: ${bindingError}`)
  }
}

async function readRecoveryStorage<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (cause) {
    throw new Error('durable trade recovery storage is unavailable', { cause })
  }
}

function createDaemonDurableTradeRecoveryPorts(
  snapshot: DaemonState,
  input: Parameters<typeof recoverDaemonDurableTradeSessions>[0],
  recoveryWalletProvider: DaemonRecoveryWalletProvider,
): DurableTradeRecoveryPorts {
  return {
    ...createDaemonDurableTradeRepositories(snapshot),
    mint: {
      inspect: (operation) =>
        inspectDaemonOperation(operation, recoveryWalletProvider),
      restoreExactPersistedOutputs: async (operation) => {
        await dispatchBoundDaemonOperation(
          operation,
          'restore',
          input.exactOperationAdapter,
          recoveryWalletProvider,
        )
      },
      resumeExactPreparedOperation: async (operation) => {
        await dispatchBoundDaemonOperation(
          operation,
          'resume',
          input.exactOperationAdapter,
          recoveryWalletProvider,
        )
      },
    },
    transport: {
      joinTrade: async (tradeId) => {
        await input.connection.joinTrade(tradeId)
      },
      sendCipher: async (tradeId, messageType, ciphertext) => {
        await input.connection.sendSwapMessage(tradeId, messageType, ciphertext)
      },
    },
    clock: { nowMs: () => Date.now() },
    hashCiphertext: async (ciphertext) =>
      createHash('sha256').update(ciphertext).digest('hex'),
    scheduleRetry: input.scheduleRetry,
    atomicTransition: daemonAtomicTransition,
  }
}

class DaemonDurableTradeRecoveryCoordinator implements DaemonDurableTradeRecoveryRunner {
  private tail: Promise<void> = Promise.resolve()
  private bootstrap: Promise<{
    durableRecovery: DurableTradeRecoveryResult
    activeSwaps: number
  }> | null = null
  private bootstrapArmed = false
  private bootstrapGate: Promise<void> | null = null
  private releaseBootstrapGate: (() => void) | null = null
  private readonly retryTimers = new Map<
    string,
    {
    request: DurableTradeRetryRequest
    dueMs: number
    timer: ReturnType<typeof setTimeout>
    }
  >()
  private readonly loadState: () => Promise<DaemonState>
  private readonly nowMs: () => number
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly recoverDurableSessions: (input: {
    scheduleRetry: (request: DurableTradeRetryRequest) => Promise<void>
    tradeId?: string
  }) => Promise<DurableTradeRecoveryResult>
  private readonly input: DaemonDurableTradeRecoveryRunnerOptions
  private readonly usesInjectedStateLoader: boolean

  constructor(input: DaemonDurableTradeRecoveryRunnerOptions) {
    this.input = input
    this.usesInjectedStateLoader = input.loadState !== undefined
    this.loadState = input.loadState ?? ensureState
    this.nowMs = input.nowMs ?? Date.now
    this.setTimer = input.setTimer ?? setTimeout
    this.clearTimer = input.clearTimer ?? clearTimeout
    this.recoverDurableSessions =
      input.recoverDurableSessions ??
      ((ports) =>
        recoverDaemonDurableTradeSessions({
        executor: input.executor,
        connection: input.connection,
        scheduleRetry: ports.scheduleRetry,
        tradeId: ports.tradeId,
      }))
  }

  armBootstrap(): void {
    if (this.bootstrapArmed || this.bootstrap) return
    this.bootstrapArmed = true
    this.bootstrapGate = new Promise<void>((resolve) => {
      this.releaseBootstrapGate = resolve
    })
  }

  finishBootstrap(): Promise<{
    durableRecovery: DurableTradeRecoveryResult
    activeSwaps: number
  }> {
    if (this.bootstrap) return this.bootstrap
    this.bootstrapArmed = true
    this.bootstrap = this.enqueue(() => this.runCoordinator())
    void this.bootstrap.then(
      () => this.releaseBootstrapGate?.(),
      () => this.releaseBootstrapGate?.(),
    )
    return this.bootstrap
  }

  async recover(): Promise<{
    durableRecovery: DurableTradeRecoveryResult
    activeSwaps: number
  }> {
    await this.waitForBootstrap()
    return this.enqueue(() => this.runCoordinator())
  }

  async runTradeEvent<T>(
    tradeId: string,
    persist: () => Promise<T>,
    action: (persisted: T) => Promise<void>,
  ): Promise<void> {
    await this.waitForBootstrap()
    await this.enqueue(async () => {
      // Persist inbound protocol state before executor work, but keep that
      // write under the same owner as the SDK's session CAS transition.
      const persisted = await persist()
      const recovery = await this.runCoordinator(tradeId)
      if (
        hasFailedClosedRecovery(recovery.durableRecovery, tradeId) ||
        !(await this.hasValidDurableSession(tradeId))
      )
        return
      await action(persisted)
    })
  }

  async recoverTradeOperation(
    tradeId: string,
    operationId: string,
  ): Promise<void> {
    await this.waitForBootstrap()
    await this.enqueue(async () => {
      if (!(await this.isRetryEligible({ tradeId, operationId }))) {
        return
      }
      await this.runCoordinator(tradeId)
    })
  }

  async recoverTrade(tradeId: string): Promise<void> {
    await this.waitForBootstrap()
    await this.enqueue(async () => {
      await this.runCoordinator(tradeId)
    })
  }

  private async waitForBootstrap(): Promise<void> {
    if (this.bootstrap) {
      await this.bootstrap
      return
    }
    if (this.bootstrapArmed && this.bootstrapGate) {
      await this.bootstrapGate
      await this.bootstrap
    }
  }

  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action, action)
    this.tail = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async runCoordinator(tradeId?: string): Promise<{
    durableRecovery: DurableTradeRecoveryResult
    activeSwaps: number
  }> {
    const durableRecovery = await this.recoverDurableSessions({
      scheduleRetry: async (request) => this.scheduleRetry(request),
      ...(tradeId === undefined ? {} : { tradeId }),
    })
    if (hasFailedClosedRecovery(durableRecovery)) {
      await this.clearTerminalRetries(tradeId)
      return { durableRecovery, activeSwaps: 0 }
    }
    const activeSwaps = await this.resumeActiveSwaps(tradeId)
    await this.clearTerminalRetries(tradeId)
    return { durableRecovery, activeSwaps }
  }

  private async resumeActiveSwaps(tradeId?: string): Promise<number> {
    if (tradeId !== undefined) {
      const state = this.usesInjectedStateLoader
        ? selectTradeState(await this.loadState(), tradeId)
        : await requireActiveTradeState(tradeId)
      return (await this.input.executor.resumeActiveSwaps(state)).activeSwaps
    }
    return this.usesInjectedStateLoader
      ? (await this.input.executor.resumeActiveSwaps(await this.loadState()))
          .activeSwaps
      : resumeActiveSwapsPaged(this.input.executor)
  }

  private async scheduleRetry(
    request: DurableTradeRetryRequest,
  ): Promise<void> {
    if (!(await this.isRetryEligible(request))) return
    const key = retryTimerKey(request)
    const dueMs = this.nowMs() + request.delayMs
    const existing = this.retryTimers.get(key)
    if (existing && existing.dueMs <= dueMs) return
    if (existing) this.clearTimer(existing.timer)
    const timer = this.setTimer(() => {
      this.retryTimers.delete(key)
      void this.recoverTradeOperation(
        request.tradeId,
        request.operationId,
      ).catch(() => undefined)
    }, request.delayMs)
    timer.unref?.()
    this.retryTimers.set(key, { request, dueMs, timer })
  }

  private async clearTerminalRetries(tradeId?: string): Promise<void> {
    // Global recovery pages can cover many unrelated trades. Outstanding
    // one-shot timers revalidate themselves when they fire; do not turn each
    // global pass into one SQLite read per timer.
    if (tradeId === undefined) return
    for (const [key, entry] of this.retryTimers) {
      if (entry.request.tradeId !== tradeId) continue
      if (await this.isRetryEligible(entry.request)) continue
      this.clearTimer(entry.timer)
      this.retryTimers.delete(key)
    }
  }

  private async isRetryEligible(
    request: Pick<DurableTradeRetryRequest, 'tradeId' | 'operationId'>,
  ): Promise<boolean> {
    const state = this.usesInjectedStateLoader
      ? await this.loadState()
      : await requireTradeRecoveryState(request.tradeId, request.operationId)
    const session = state.durableTradeSessions[request.tradeId]
    const record = Object.values(state.proofOperations).find(
      (candidate) =>
        candidate.durableTradeRecovery?.operationId === request.operationId,
    )
    const operation = record?.durableTradeRecovery
    if (
      !session ||
      !record ||
      !operation ||
      operation.state === 'reconciled' ||
      validateDaemonDurableOperationBinding({ session, record, operation }) !==
        null
    ) {
      return false
    }
    const deadlineSecs =
      session.role === 'seller'
      ? session.sellerLocktimeSecs
      : session.buyerLocktimeSecs
    return this.nowMs() < deadlineSecs * 1_000
  }

  private async hasValidDurableSession(tradeId: string): Promise<boolean> {
    const state = this.usesInjectedStateLoader
      ? await this.loadState()
      : await requireTradeRecoveryState(tradeId)
    const session = state.durableTradeSessions[tradeId]
    return (
      session !== undefined && validateDurableTradeSession(session) === null
    )
  }
}

async function requireActiveTradeState(tradeId: string): Promise<DaemonState> {
  const state = await readStateScope({
    tradeIds: [tradeId],
    swapIds: [tradeId],
    orderIdsFromSwapIds: [tradeId],
  })
  if (!state) throw new Error('daemon SQLite state row is missing')
  return state
}

function selectTradeState(state: DaemonState, tradeId: string): DaemonState {
  const selected = structuredClone(state)
  selected.durableTradeSessions = selectKey(selected.durableTradeSessions, tradeId)
  selected.swaps = selectKey(selected.swaps, tradeId)
  selected.proofOperations = Object.fromEntries(
    Object.entries(selected.proofOperations).filter(
      ([, operation]) => operation.durableTradeRecovery?.tradeId === tradeId,
    ),
  )
  selected.orders = Object.fromEntries(
    Object.entries(selected.orders).filter(([, order]) =>
      order.tradeIds.includes(tradeId),
    ),
  )
  selected.wallet.proofs = []
  return selected
}

function selectKey<T>(values: Record<string, T>, key: string): Record<string, T> {
  const value = values[key]
  return value === undefined ? {} : { [key]: value }
}

export function hasFailedClosedRecovery(
  recovery: DurableTradeRecoveryResult,
  tradeId?: string,
): boolean {
  return (
    recovery.summary?.failedClosed === true ||
    recovery.sessions.some(
      (result) =>
        result.kind === 'failed-closed' &&
        (tradeId === undefined || result.tradeId === tradeId),
    ) ||
    recovery.orphans.some((result) => result.kind === 'failed-closed') ||
    recovery.pendingIntents?.some(
      (result) =>
        result.kind === 'failed-closed' &&
        (tradeId === undefined || result.tradeId === tradeId),
    ) === true
  )
}

function retryTimerKey(
  request: Pick<DurableTradeRetryRequest, 'tradeId' | 'operationId'>,
): string {
  return `${request.tradeId}\u0000${request.operationId}`
}

function createDaemonSessionRepository(
  snapshot: DaemonState,
): DurableTradeSessionRepository {
  return {
  async get(tradeId) {
      return (
        (await readStateScope({ tradeIds: [tradeId] }))?.durableTradeSessions[
          tradeId
        ] ?? null
      )
  },
  async listRecoverable() {
      return Object.values(snapshot.durableTradeSessions).map((session) =>
        structuredClone(session),
      )
  },
  async create(session) {
    const error = validateDurableTradeSession(session)
    if (error) throw new Error(error)
      return updateState({ tradeIds: [session.tradeId] }, (state) => {
      const existing = state.durableTradeSessions[session.tradeId]
      if (existing) return existing
      state.durableTradeSessions[session.tradeId] = structuredClone(session)
      return session
    })
  },
  async compareAndSwap(tradeId, expectedRevision, next) {
    const error = validateDurableTradeSession(next)
    if (error) throw new Error(error)
      return updateState({ tradeIds: [tradeId] }, (state) => {
      const existing = state.durableTradeSessions[tradeId]
      if (!existing || existing.revision !== expectedRevision) return null
        if (
          next.tradeId !== tradeId ||
          next.revision !== expectedRevision + 1
        ) {
          throw new Error(
            'durable trade session compare-and-swap has an invalid revision',
          )
      }
      state.durableTradeSessions[tradeId] = structuredClone(next)
      return next
    })
  },
  async remove(tradeId, expectedRevision) {
      return updateState({ tradeIds: [tradeId] }, (state) => {
      const existing = state.durableTradeSessions[tradeId]
      if (!existing || existing.revision !== expectedRevision) return false
      delete state.durableTradeSessions[tradeId]
      return true
    })
  },
}
}

function createDaemonOperationRepository(
  snapshot: DaemonState,
): DurableProofOperationRepository {
  return {
  async get(operationId) {
    return findOperation(operationId)
  },
  async listByTrade(tradeId) {
      const state = await readStateScope({ tradeIds: [tradeId] })
    return Object.values(state?.proofOperations ?? {})
      .map((record) => record.durableTradeRecovery)
        .filter(
          (link): link is DurableTradeProofOperationLink =>
            link !== undefined && link.tradeId === tradeId,
        )
  },
  async listRecoverable() {
      return Object.values(snapshot.proofOperations)
      .map((record) => record.durableTradeRecovery)
        .filter(
          (link): link is DurableTradeProofOperationLink =>
            link !== undefined && link.state !== 'reconciled',
        )
        .map((link) => structuredClone(link))
  },
  async prepare() {
      throw new Error(
        'daemon durable proof operations are prepared with their concrete Cashu request',
      )
  },
  async markMintSubmitted(operationId) {
      return advanceDaemonOperationFromCurrentState(
        operationId,
        'mint-submitted',
      )
  },
  async markReconciled(operationId) {
    return advanceDaemonOperationFromCurrentState(operationId, 'reconciled')
  },
}
}

async function requireTradeRecoveryState(
  tradeId: string,
  durableOperationId?: string,
): Promise<DaemonState> {
  const state = await readStateScope({
    tradeIds: [tradeId],
    ...(durableOperationId === undefined
      ? {}
      : { durableOperationIds: [durableOperationId] }),
  })
  if (!state) throw new Error('daemon SQLite state row is missing')
  return state
}

async function resumeActiveSwapsPaged(
  executor: DaemonSwapExecutor,
): Promise<number> {
  let activeSwaps = 0
  let cursor: string | null = null
  do {
    const page = await readActiveSwapIdsPage({
      cursor,
      limit: DAEMON_RECOVERY_PAGE_LIMIT,
    })
    if (page.ids.length > 0) {
      const state = await readStateScope({
        tradeIds: page.ids,
        swapIds: page.ids,
        orderIdsFromSwapIds: page.ids,
      })
      if (!state) throw new Error('daemon SQLite state row is missing')
      activeSwaps += (await executor.resumeActiveSwaps(state)).activeSwaps
    }
    cursor = page.nextCursor
  } while (cursor !== null)
  return activeSwaps
}

/**
 * The daemon stores sessions and proof-operation rows in one SQLite transaction.
 * Advancing only one projection would open a crash window where the next
 * recovery run could no longer prove which exact action is safe.
 */
const daemonAtomicTransition: DurableTradeAtomicTransitionPort = {
  async advance(input) {
    if (
      validateDurableTradeSession(input.session) !== null ||
      validateDurableProofOperationLink(input.operation) !== null
    ) {
      return null
    }
    const expectedSession = expectedAtomicSession(input)
    if (expectedSession === null) return null
    let stored = await findAtomicTransitionState(input.operation)
    if (stored === null) return null
    if (isExpectedAtomicState(stored, expectedSession, input.state)) {
      await assertProofOperationCustodyBound(stored.record)
      return {
        session: stored.session,
        operation: stored.operation,
      }
    }
    if (
      input.state !== 'mint-submitted' ||
      !sameDurableSessionSnapshot(stored.session, input.session) ||
      stored.operation.state !== 'prepared' ||
      stored.record.state !== 'prepared'
    ) return null
    await markProofOperationMintSubmitted(stored.record.operationId)
    stored = await findAtomicTransitionState(input.operation)
    if (stored === null || !isExpectedAtomicState(
      stored,
      expectedSession,
      input.state,
    )) return null
    await assertProofOperationCustodyBound(stored.record)
    return { session: stored.session, operation: stored.operation }
  },
}

function expectedAtomicSession(
  input: Parameters<DurableTradeAtomicTransitionPort['advance']>[0],
): DurableTradeSession | null {
  try {
    return reduceDurableTradeSession(
      input.session,
      input.state === 'mint-submitted'
        ? { kind: 'mint-submitted', operationId: input.operation.operationId }
        : {
            kind: 'proof-operation-reconciled',
            operationId: input.operation.operationId,
          },
    )
  } catch {
    return null
  }
}

async function findAtomicTransitionState(
  operation: DurableTradeProofOperationLink,
): Promise<{
  record: ProofOperationRecord
  session: DurableTradeSession
  operation: DurableTradeProofOperationLink
} | null> {
  const bound = await findBoundDaemonOperation(operation)
  const storedOperation = bound?.record.durableTradeRecovery
  if (bound === null || storedOperation === undefined) return null
  if (!sameDurableOperationIdentity(storedOperation, operation)) return null
  return { ...bound, operation: storedOperation }
}

function isExpectedAtomicState(
  stored: {
    record: ProofOperationRecord
    session: DurableTradeSession
    operation: DurableTradeProofOperationLink
  },
  expectedSession: DurableTradeSession,
  expectedState: 'mint-submitted' | 'reconciled',
): boolean {
  return sameDurableSessionSnapshot(stored.session, expectedSession) &&
    stored.operation.state === expectedState &&
    proofRecordHasAdvanced(stored.record.state, expectedState)
}

async function findOperation(
  operationId: string,
): Promise<DurableTradeProofOperationLink | null> {
  const record = await findOperationRecord(operationId)
  if (!record?.durableTradeRecovery) return null
  return record.durableTradeRecovery
}

async function advanceDaemonOperationFromCurrentState(
  operationId: string,
  state: 'mint-submitted' | 'reconciled',
): Promise<DurableTradeProofOperationLink> {
  const snapshot = await readStateScope({ durableOperationIds: [operationId] })
  const record = Object.values(snapshot?.proofOperations ?? {}).find(
    (candidate) => candidate.durableTradeRecovery?.operationId === operationId,
  )
  const operation = record?.durableTradeRecovery
  const session = operation
    ? snapshot?.durableTradeSessions[operation.tradeId]
    : undefined
  if (!record || !operation || !session) {
    throw new Error(`Missing durable proof operation ${operationId}`)
  }
  const bindingError = validateDaemonDurableOperationBinding({
    session,
    record,
    operation,
  })
  if (bindingError) {
    throw new Error(
      `Durable proof operation ${operationId} has an invalid binding: ${bindingError}`,
    )
  }
  const advanced = await daemonAtomicTransition.advance({
    session,
    operation,
    state,
  })
  if (!advanced) {
    throw new Error(
      `Durable proof operation ${operationId} could not advance atomically`,
    )
  }
  return advanced.operation
}

async function findOperationRecord(operationId: string) {
  const state = await readStateScope({ durableOperationIds: [operationId] })
  return (
    Object.values(state?.proofOperations ?? {}).find(
    (record) => record.durableTradeRecovery?.operationId === operationId,
  ) ?? null
  )
}

async function inspectDaemonOperation(
  operation: DurableTradeProofOperationLink,
  recoveryWalletProvider: DaemonRecoveryWalletProvider,
) {
  const bound = await findBoundDaemonOperation(operation)
  if (!bound) return { kind: 'foreign' as const }
  const { record } = bound
  await assertProofOperationCustodyBound(record)
  if (record.state === 'completed')
    return { kind: 'prepared-spent-restorable' as const }
  if (record.inputs.some((proof) => !proof.id))
    return { kind: 'corrupt' as const }

  const unit =
    typeof record.metadata.unit === 'string' ? record.metadata.unit : 'sat'
  const wallet = await recoveryWalletProvider.getWallet({
    mintUrl: record.mintUrl,
    unit,
  })
  if (!wallet.checkProofsStates)
    throw new Error(
      'Cashu wallet adapter does not support proof-state recovery checks',
    )
  // Wallet metadata is reusable within this serialized pass, but proof states
  // are not: an earlier exact recovery action may have changed the mint state.
  const states = await wallet.checkProofsStates(
    record.inputs.map(({ id, secret }) => ({ id: id!, secret })),
  )
  if (allStates(states, CheckStateEnum.SPENT)) {
    return { kind: 'prepared-spent-restorable' as const }
  }
  if (allStates(states, CheckStateEnum.UNSPENT)) {
    // NUT-07 proves the exact inputs were not consumed, so retrying the
    // persisted request is safe even after its prior transport response was lost.
    return { kind: 'prepared-unspent' as const }
  }
  return { kind: 'pending-or-mixed' as const }
}

async function dispatchBoundDaemonOperation(
  operation: DurableTradeProofOperationLink,
  action: ExactDaemonProofOperationAction,
  exactOperationAdapter:
    | ((
    record: ProofOperationRecord,
    action: ExactDaemonProofOperationAction,
      ) => Promise<void>)
    | undefined,
  recoveryWalletProvider: DaemonRecoveryWalletProvider,
): Promise<void> {
  const bound = await findBoundDaemonOperation(operation)
  if (!bound)
    throw new Error(
      `Durable proof operation ${operation.operationId} has an invalid binding`,
    )
  await assertProofOperationCustodyBound(bound.record)
  if (exactOperationAdapter !== undefined) {
    await exactOperationAdapter(bound.record, action)
    return
  }
  await recoverExactDaemonProofOperation(bound.record, action, {
    recoveryWalletProvider,
  })
}

async function findBoundDaemonOperation(
  operation: DurableTradeProofOperationLink,
): Promise<{
  record: ProofOperationRecord
  session: DurableTradeSession
} | null> {
  const snapshot = await readStateScope({
    durableOperationIds: [operation.operationId],
  })
  const record = Object.values(snapshot?.proofOperations ?? {}).find(
    (candidate) =>
      candidate.durableTradeRecovery?.operationId === operation.operationId,
  )
  if (!record) return null
  const session = snapshot?.durableTradeSessions[operation.tradeId]
  if (
    !session ||
    validateDaemonDurableOperationBinding({ session, record, operation }) !==
      null
  ) {
    return null
  }
  return { record, session }
}

function allStates(states: ProofState[], expected: string): boolean {
  return states.length > 0 && states.every((state) => state.state === expected)
}

function sameDurableSessionSnapshot(
  left: DurableTradeSession,
  right: DurableTradeSession,
): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function sameDurableOperationIdentity(
  left: DurableTradeProofOperationLink,
  right: DurableTradeProofOperationLink,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.operationKey === right.operationKey &&
    left.tradeId === right.tradeId &&
    left.role === right.role &&
    left.stage === right.stage &&
    left.kind === right.kind
  )
}

function proofRecordHasAdvanced(
  state: 'prepared' | 'mint-submitted' | 'completed' | 'Failed',
  transition: 'mint-submitted' | 'reconciled',
): boolean {
  switch (transition) {
    case 'mint-submitted':
      return state === 'mint-submitted'
    case 'reconciled':
      return state === 'completed'
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}
