import {
  CheckStateEnum,
  Mint as CashuMint,
  Wallet as CashuWallet,
  type ProofState,
} from '@cashu/cashu-ts'
import { createHash } from 'node:crypto'
import {
  recoverDurableTradeSessions,
  validateDurableTradeSession,
  type DurableProofOperationRepository,
  type DurableTradeProofOperationLink,
  type DurableTradeRecoveryPorts,
  type DurableTradeRecoveryResult,
  type DurableTradeSessionRepository,
} from '@bitcaster-market/client-sdk/durableTradeRecovery'
import {
  markProofOperationMintSubmitted,
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
    const record = await findOperationRecord(operationId)
    if (!record) throw new Error(`Missing durable proof operation ${operationId}`)
    const updated = await markProofOperationMintSubmitted(record.operationId)
    if (!updated.durableTradeRecovery) throw new Error(`Missing durable proof operation ${operationId}`)
    return updated.durableTradeRecovery
  },
  async markReconciled(operationId) {
    return updateState((state) => {
      const record = Object.values(state.proofOperations).find(
        (candidate) => candidate.durableTradeRecovery?.operationId === operationId,
      )
      if (!record?.durableTradeRecovery) {
        throw new Error(`Missing durable proof operation ${operationId}`)
      }
      const link = { ...record.durableTradeRecovery, state: 'reconciled' as const }
      record.durableTradeRecovery = link
      return link
    })
  },
}

async function findOperation(operationId: string): Promise<DurableTradeProofOperationLink | null> {
  const record = await findOperationRecord(operationId)
  if (!record?.durableTradeRecovery) return null
  return record.durableTradeRecovery
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
