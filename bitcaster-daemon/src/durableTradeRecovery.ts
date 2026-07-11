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
  type DurableTradeSession,
  type DurableTradeSessionRepository,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import {
  ensureState,
  readState,
  updateState,
} from './state.ts'
import type { TradeRuntimeConnection } from './tradeRuntime.ts'
import type { DaemonSwapExecutor } from './swapExecutor.ts'

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
}

/**
 * Runs coordinator-owned exact recovery before the legacy active-swap sweep.
 * Both daemon startup and the manual RPC use this one ordering so the legacy
 * executor cannot select fresh proofs while a durable link remains active.
 */
export function createDaemonDurableTradeRecoveryRunner(input: {
  executor: DaemonSwapExecutor
  connection: TradeRuntimeConnection
}): DaemonDurableTradeRecoveryRunner {
  return {
    async recover() {
      const durableRecovery = await recoverDaemonDurableTradeSessions(input)
      const { activeSwaps } = await input.executor.resumeActiveSwaps(await ensureState())
      return { durableRecovery, activeSwaps }
    },
  }
}

/** Runs the SDK-owned recovery policy using daemon-specific storage and transport. */
export async function recoverDaemonDurableTradeSessions(input: {
  executor: DaemonSwapExecutor
  connection: TradeRuntimeConnection
}): Promise<DurableTradeRecoveryResult> {
  const repositories = createDaemonDurableTradeRepositories()
  const ports: DurableTradeRecoveryPorts = {
    ...repositories,
    mint: {
      inspect: inspectDaemonOperation,
      restoreExactPersistedOutputs: async (operation) => {
        await input.executor.resumeDurableProofOperation(requireOperationKey(operation))
      },
      resumeExactPreparedOperation: async (operation) => {
        await input.executor.resumeDurableProofOperation(requireOperationKey(operation))
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
    atomicTransition: daemonAtomicTransition,
  }
  return recoverDurableTradeSessions(ports)
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
        !sameDurableOperationIdentity(storedOperation, input.operation)) {
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
  if (!operation || !session) {
    throw new Error(`Missing durable proof operation ${operationId}`)
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
  const record = await findOperationRecord(operation.operationId)
  if (!record) return { kind: 'corrupt' as const }
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

function requireOperationKey(operation: DurableTradeProofOperationLink): string {
  if (!operation.operationKey) throw new Error(`Durable proof operation ${operation.operationId} has no local key`)
  return operation.operationKey
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
