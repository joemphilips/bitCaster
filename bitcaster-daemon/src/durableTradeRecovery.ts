import {
  CheckStateEnum,
  Mint as CashuMint,
  Wallet as CashuWallet,
  type ProofState,
} from '@cashu/cashu-ts'
import { createHash } from 'node:crypto'
import {
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
  ensureState,
  readState,
  updateState,
  type DaemonState,
  type ProofOperationRecord,
} from './state.ts'
import type { TradeRuntimeConnection } from './tradeRuntime.ts'
import type { DaemonSwapExecutor } from './swapExecutor.ts'
import { validateDaemonDurableOperationBinding } from './durableTradeBinding.ts'
import {
  recoverExactDaemonProofOperation,
  type ExactDaemonProofOperationAction,
} from './swapProtocolAdapter.ts'

export async function getDaemonProofOperationByDurableId(operationId: string) {
  return findOperationRecord(operationId)
}

/**
 * Adapts the daemon's single atomically-renamed state file to the SDK recovery
 * repositories. Proof rows retain the concrete Cashu request while this layer
 * exposes only the SDK recovery identity.
 */
export function createDaemonDurableTradeRepositories(): {
  sessions: DurableTradeSessionRepository
  operations: DurableProofOperationRepository
} {
  return { sessions: daemonSessions, operations: daemonOperations }
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
  }) => Promise<DurableTradeRecoveryResult>
  loadState?: () => Promise<DaemonState>
  nowMs?: () => number
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
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
  scheduleRetry?: (request: DurableTradeRetryRequest) => Promise<void>
  /** Test seam; production always dispatches to the persisted-operation adapter. */
  exactOperationAdapter?: (
    record: ProofOperationRecord,
    action: ExactDaemonProofOperationAction,
  ) => Promise<void>
}): Promise<DurableTradeRecoveryResult> {
  const repositories = createDaemonDurableTradeRepositories()
  const ports: DurableTradeRecoveryPorts = {
    ...repositories,
    mint: {
      inspect: inspectDaemonOperation,
      restoreExactPersistedOutputs: async (operation) => {
        await dispatchBoundDaemonOperation(operation, 'restore', input.exactOperationAdapter)
      },
      resumeExactPreparedOperation: async (operation) => {
        await dispatchBoundDaemonOperation(operation, 'resume', input.exactOperationAdapter)
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
  return recoverDurableTradeSessions(ports)
}

class DaemonDurableTradeRecoveryCoordinator implements DaemonDurableTradeRecoveryRunner {
  private tail: Promise<void> = Promise.resolve()
  private bootstrap: Promise<{ durableRecovery: DurableTradeRecoveryResult; activeSwaps: number }> | null = null
  private bootstrapArmed = false
  private bootstrapGate: Promise<void> | null = null
  private releaseBootstrapGate: (() => void) | null = null
  private readonly retryTimers = new Map<string, {
    request: DurableTradeRetryRequest
    dueMs: number
    timer: ReturnType<typeof setTimeout>
  }>()
  private readonly loadState: () => Promise<DaemonState>
  private readonly nowMs: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void
  private readonly recoverDurableSessions: (input: {
    scheduleRetry: (request: DurableTradeRetryRequest) => Promise<void>
  }) => Promise<DurableTradeRecoveryResult>
  private readonly input: DaemonDurableTradeRecoveryRunnerOptions

  constructor(input: DaemonDurableTradeRecoveryRunnerOptions) {
    this.input = input
    this.loadState = input.loadState ?? ensureState
    this.nowMs = input.nowMs ?? Date.now
    this.setTimer = input.setTimer ?? setTimeout
    this.clearTimer = input.clearTimer ?? clearTimeout
    this.recoverDurableSessions = input.recoverDurableSessions ??
      ((ports) => recoverDaemonDurableTradeSessions({
        executor: input.executor,
        connection: input.connection,
        scheduleRetry: ports.scheduleRetry,
      }))
  }

  armBootstrap(): void {
    if (this.bootstrapArmed || this.bootstrap) return
    this.bootstrapArmed = true
    this.bootstrapGate = new Promise<void>((resolve) => {
      this.releaseBootstrapGate = resolve
    })
  }

  finishBootstrap(): Promise<{ durableRecovery: DurableTradeRecoveryResult; activeSwaps: number }> {
    if (this.bootstrap) return this.bootstrap
    this.bootstrapArmed = true
    this.bootstrap = this.enqueue(() => this.runCoordinator())
    void this.bootstrap.then(
      () => this.releaseBootstrapGate?.(),
      () => this.releaseBootstrapGate?.(),
    )
    return this.bootstrap
  }

  async recover(): Promise<{ durableRecovery: DurableTradeRecoveryResult; activeSwaps: number }> {
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
      const recovery = await this.runCoordinator()
      if (hasFailedClosedRecovery(recovery.durableRecovery, tradeId) ||
        !await this.hasValidDurableSession(tradeId)) return
      await action(persisted)
    })
  }

  async recoverTradeOperation(tradeId: string, operationId: string): Promise<void> {
    await this.waitForBootstrap()
    await this.enqueue(async () => {
      if (!await this.isRetryEligible({ tradeId, operationId })) {
        return
      }
      await this.runCoordinator()
    })
  }

  async recoverTrade(_tradeId: string): Promise<void> {
    await this.waitForBootstrap()
    await this.enqueue(async () => {
      await this.runCoordinator()
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
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }

  private async runCoordinator(): Promise<{
    durableRecovery: DurableTradeRecoveryResult
    activeSwaps: number
  }> {
    const durableRecovery = await this.recoverDurableSessions({
      scheduleRetry: async (request) => this.scheduleRetry(request),
    })
    await this.clearTerminalRetries()
    if (hasFailedClosedRecovery(durableRecovery)) {
      return { durableRecovery, activeSwaps: 0 }
    }
    const { activeSwaps } = await this.input.executor.resumeActiveSwaps(await this.loadState())
    await this.clearTerminalRetries()
    return { durableRecovery, activeSwaps }
  }

  private async scheduleRetry(request: DurableTradeRetryRequest): Promise<void> {
    if (!await this.isRetryEligible(request)) return
    const key = retryTimerKey(request)
    const dueMs = this.nowMs() + request.delayMs
    const existing = this.retryTimers.get(key)
    if (existing && existing.dueMs <= dueMs) return
    if (existing) this.clearTimer(existing.timer)
    const timer = this.setTimer(() => {
      this.retryTimers.delete(key)
      void this.recoverTradeOperation(request.tradeId, request.operationId).catch(() => undefined)
    }, request.delayMs)
    timer.unref?.()
    this.retryTimers.set(key, { request, dueMs, timer })
  }

  private async clearTerminalRetries(): Promise<void> {
    for (const [key, entry] of this.retryTimers) {
      if (await this.isRetryEligible(entry.request)) continue
      this.clearTimer(entry.timer)
      this.retryTimers.delete(key)
    }
  }

  private async isRetryEligible(request: Pick<DurableTradeRetryRequest, 'tradeId' | 'operationId'>): Promise<boolean> {
    const state = await this.loadState()
    const session = state.durableTradeSessions[request.tradeId]
    const record = Object.values(state.proofOperations).find(
      (candidate) => candidate.durableTradeRecovery?.operationId === request.operationId,
    )
    const operation = record?.durableTradeRecovery
    if (!session || !record || !operation || operation.state === 'reconciled' ||
      validateDaemonDurableOperationBinding({ session, record, operation }) !== null) {
      return false
    }
    const deadlineSecs = session.role === 'seller'
      ? session.sellerLocktimeSecs
      : session.buyerLocktimeSecs
    return this.nowMs() < deadlineSecs * 1_000
  }

  private async hasValidDurableSession(tradeId: string): Promise<boolean> {
    const session = (await this.loadState()).durableTradeSessions[tradeId]
    return session !== undefined && validateDurableTradeSession(session) === null
  }
}

function hasFailedClosedRecovery(recovery: DurableTradeRecoveryResult, tradeId?: string): boolean {
  return recovery.sessions.some((result) =>
    result.kind === 'failed-closed' && (tradeId === undefined || result.tradeId === tradeId)) ||
    recovery.orphans.some((result) => result.kind === 'failed-closed')
}

function retryTimerKey(request: Pick<DurableTradeRetryRequest, 'tradeId' | 'operationId'>): string {
  return `${request.tradeId}\u0000${request.operationId}`
}

const daemonSessions: DurableTradeSessionRepository = {
  async get(tradeId) {
    return (await readState())?.durableTradeSessions[tradeId] ?? null
  },
  async listRecoverable() {
    return Object.values((await readState())?.durableTradeSessions ?? {})
  },
  async create(session) {
    const error = validateDurableTradeSession(session)
    if (error) throw new Error(error)
    return updateState((state) => {
      const existing = state.durableTradeSessions[session.tradeId]
      if (existing) return existing
      state.durableTradeSessions[session.tradeId] = structuredClone(session)
      return session
    })
  },
  async compareAndSwap(tradeId, expectedRevision, next) {
    const error = validateDurableTradeSession(next)
    if (error) throw new Error(error)
    return updateState((state) => {
      const existing = state.durableTradeSessions[tradeId]
      if (!existing || existing.revision !== expectedRevision) return null
      if (next.tradeId !== tradeId || next.revision !== expectedRevision + 1) {
        throw new Error('durable trade session compare-and-swap has an invalid revision')
      }
      state.durableTradeSessions[tradeId] = structuredClone(next)
      return next
    })
  },
  async remove(tradeId, expectedRevision) {
    return updateState((state) => {
      const existing = state.durableTradeSessions[tradeId]
      if (!existing || existing.revision !== expectedRevision) return false
      delete state.durableTradeSessions[tradeId]
      return true
    })
  },
}

const daemonOperations: DurableProofOperationRepository = {
  async get(operationId) {
    return findOperation(operationId)
  },
  async listByTrade(tradeId) {
    const state = await readState()
    return Object.values(state?.proofOperations ?? {})
      .map((record) => record.durableTradeRecovery)
      .filter((link): link is DurableTradeProofOperationLink =>
        link !== undefined && link.tradeId === tradeId)
  },
  async listRecoverable() {
    const state = await readState()
    return Object.values(state?.proofOperations ?? {})
      .map((record) => record.durableTradeRecovery)
      .filter((link): link is DurableTradeProofOperationLink =>
        link !== undefined && link.state !== 'reconciled')
  },
  async prepare() {
    throw new Error('daemon durable proof operations are prepared with their concrete Cashu request')
  },
  async markMintSubmitted(operationId) {
    return advanceDaemonOperationFromCurrentState(operationId, 'mint-submitted')
  },
  async markReconciled(operationId) {
    return advanceDaemonOperationFromCurrentState(operationId, 'reconciled')
  },
}

/**
 * The daemon stores sessions and proof-operation rows in one atomically
 * renamed file. Advancing only one of those projections opens a crash window
 * where the next recovery run can no longer prove which exact action is safe.
 */
const daemonAtomicTransition: DurableTradeAtomicTransitionPort = {
  async advance(input) {
    if (validateDurableTradeSession(input.session) !== null ||
      validateDurableProofOperationLink(input.operation) !== null) {
      return null
    }
    return updateState((state) => {
      const storedSession = state.durableTradeSessions[input.session.tradeId]
      const record = Object.values(state.proofOperations).find(
        (candidate) => candidate.durableTradeRecovery?.operationId === input.operation.operationId,
      )
      const storedOperation = record?.durableTradeRecovery
      if (!storedSession || !record || !storedOperation ||
        validateDurableProofOperationLink(storedOperation) !== null ||
        !sameDurableOperationIdentity(storedOperation, input.operation) ||
        validateDaemonDurableOperationBinding({
          session: storedSession,
          record,
          operation: input.operation,
        }) !== null) {
        return null
      }

      let expectedSession
      try {
        expectedSession = reduceDurableTradeSession(
          input.session,
          input.state === 'mint-submitted'
            ? { kind: 'mint-submitted', operationId: input.operation.operationId }
            : { kind: 'proof-operation-reconciled', operationId: input.operation.operationId },
        )
      } catch {
        return null
      }
      const nextOperation = expectedSession.proofOperations.find(
        (candidate) => candidate.operationId === input.operation.operationId,
      )
      if (!nextOperation || nextOperation.state !== input.state ||
        !sameDurableOperationIdentity(nextOperation, input.operation) ||
        !proofRecordMayAdvance(record.state, input.state)) {
        return null
      }

      // The normal daemon execution path may have completed the same atomic
      // file transaction while the exact mint adapter was returning. Returning
      // that precise already-advanced snapshot makes recovery idempotent
      // without accepting a stale or differently-bound session.
      if (sameDurableSessionSnapshot(storedSession, expectedSession) &&
        storedOperation.state === input.state &&
        proofRecordHasAdvanced(record.state, input.state)) {
        return { session: storedSession, operation: storedOperation }
      }
      if (!sameDurableSessionSnapshot(storedSession, input.session)) return null

      state.durableTradeSessions[expectedSession.tradeId] = expectedSession
      record.durableTradeRecovery = nextOperation
      if (input.state === 'mint-submitted') record.state = 'mint-submitted'
      return { session: expectedSession, operation: nextOperation }
    })
  },
}

async function findOperation(operationId: string): Promise<DurableTradeProofOperationLink | null> {
  const record = await findOperationRecord(operationId)
  if (!record?.durableTradeRecovery) return null
  return record.durableTradeRecovery
}

async function advanceDaemonOperationFromCurrentState(
  operationId: string,
  state: 'mint-submitted' | 'reconciled',
): Promise<DurableTradeProofOperationLink> {
  const snapshot = await readState()
  const record = Object.values(snapshot?.proofOperations ?? {}).find(
    (candidate) => candidate.durableTradeRecovery?.operationId === operationId,
  )
  const operation = record?.durableTradeRecovery
  const session = operation ? snapshot?.durableTradeSessions[operation.tradeId] : undefined
  if (!record || !operation || !session) {
    throw new Error(`Missing durable proof operation ${operationId}`)
  }
  const bindingError = validateDaemonDurableOperationBinding({
    session,
    record,
    operation,
  })
  if (bindingError) {
    throw new Error(`Durable proof operation ${operationId} has an invalid binding: ${bindingError}`)
  }
  const advanced = await daemonAtomicTransition.advance({ session, operation, state })
  if (!advanced) {
    throw new Error(`Durable proof operation ${operationId} could not advance atomically`)
  }
  return advanced.operation
}

async function findOperationRecord(operationId: string) {
  const state = await readState()
  return Object.values(state?.proofOperations ?? {}).find(
    (record) => record.durableTradeRecovery?.operationId === operationId,
  ) ?? null
}

async function inspectDaemonOperation(operation: DurableTradeProofOperationLink) {
  const bound = await findBoundDaemonOperation(operation)
  if (!bound) return { kind: 'foreign' as const }
  const { record } = bound
  if (record.state === 'completed') return { kind: 'prepared-spent-restorable' as const }
  if (record.inputs.some((proof) => !proof.id)) return { kind: 'corrupt' as const }

  const unit = typeof record.metadata.unit === 'string' ? record.metadata.unit : 'sat'
  const wallet = new CashuWallet(new CashuMint(record.mintUrl), { unit })
  await wallet.loadMint()
  if (!wallet.checkProofsStates) throw new Error('Cashu wallet adapter does not support proof-state recovery checks')
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
  exactOperationAdapter: ((
    record: ProofOperationRecord,
    action: ExactDaemonProofOperationAction,
  ) => Promise<void>) | undefined,
): Promise<void> {
  const bound = await findBoundDaemonOperation(operation)
  if (!bound) throw new Error(`Durable proof operation ${operation.operationId} has an invalid binding`)
  await (exactOperationAdapter ?? recoverExactDaemonProofOperation)(bound.record, action)
}

async function findBoundDaemonOperation(
  operation: DurableTradeProofOperationLink,
): Promise<{ record: ProofOperationRecord; session: DurableTradeSession } | null> {
  const snapshot = await readState()
  const record = Object.values(snapshot?.proofOperations ?? {}).find(
    (candidate) => candidate.durableTradeRecovery?.operationId === operation.operationId,
  )
  if (!record) return null
  const session = snapshot?.durableTradeSessions[operation.tradeId]
  if (!session || validateDaemonDurableOperationBinding({ session, record, operation }) !== null) {
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
  return left.operationId === right.operationId &&
    left.operationKey === right.operationKey &&
    left.tradeId === right.tradeId &&
    left.role === right.role &&
    left.stage === right.stage &&
    left.kind === right.kind
}

function proofRecordMayAdvance(
  state: 'prepared' | 'mint-submitted' | 'completed' | 'Failed',
  transition: 'mint-submitted' | 'reconciled',
): boolean {
  switch (transition) {
    case 'mint-submitted':
      return state === 'prepared' || state === 'mint-submitted'
    case 'reconciled':
      return state === 'completed'
  }
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
