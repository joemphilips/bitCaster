import type {
  DurableCustodyTransaction,
  DurableCustodyTransactionInput,
} from '@bitcaster-market/client-sdk/durableCustody'
import type { DatabaseSync } from 'node:sqlite'
import {
  applyDurableCustodyWorkInDatabase,
} from './durableCustodySqliteStore.ts'
import { openProfileDatabase } from './profile.ts'
import {
  applyWalletProofDeltaInState,
  applyDaemonStateWorkInDatabase,
  releaseWalletProofsForRecoveryAbortInState,
  reserveWalletProofsForPrepareInState,
  walletProofSelectorsForRecoveryAbort,
  type DaemonWalletProofDelta,
  type LocalSwapRecord,
  type PrepareProofOperationInput,
  type ProofOperationRecord,
  type DaemonState,
} from './state.ts'
import {
  deriveDaemonWalletProofIdFromProof,
  type DaemonStateRowScope,
} from './stateSqlite.ts'
import type { DurableTradeSession } from '@bitcaster-market/client-sdk/durableTradeRecovery'

export interface DaemonCustodyUnitOfWorkTransaction {
  database: DatabaseSync
  custody: DurableCustodyTransaction
  state: DaemonCustodyStateEffects
  now: string
}

/** Narrow exact daemon facts that may accompany one canonical custody commit. */
export interface DaemonCustodyStateEffects {
  getProofOperation(operationId: string): ProofOperationRecord | null
  putProofOperation(operation: ProofOperationRecord): void
  getTradeSession(tradeId: string): DurableTradeSession | null
  putTradeSession(session: DurableTradeSession): void
  getSwap(tradeId: string): LocalSwapRecord | null
  putSwap(swap: LocalSwapRecord): void
  reserveWalletProofs(input: PrepareProofOperationInput, now: string): void
  applyWalletProofDelta(delta: DaemonWalletProofDelta): void
  releaseWalletProofsForRecoveryAbort(
    operation: ProofOperationRecord,
    now: string,
    restoreReservationId?: string | null,
  ): void
}

let faultHook:
  | ((stage: 'before-commit' | 'after-commit') => void)
  | undefined

/** Test-only crash seam for the combined custody/state transaction. */
export function setDaemonCustodyUnitOfWorkFaultHookForTest(
  hook: ((stage: 'before-commit' | 'after-commit') => void) | undefined,
): void {
  faultHook = hook
}

/**
 * The daemon's sole combined write boundary for canonical SDK custody and
 * exact client-private rows. The callback is synchronous, so no foreign await
 * can split the SQLite transaction.
 */
export class DaemonCustodyUnitOfWork {
  async transact<T>(
    input: DurableCustodyTransactionInput & {
      stateScope: DaemonStateRowScope
    },
    apply: (transaction: DaemonCustodyUnitOfWorkTransaction) => T,
  ): Promise<T> {
    const database = openProfileDatabase()
    try {
      database.exec('BEGIN IMMEDIATE')
      try {
        const result = applyDurableCustodyWorkInDatabase(
          database,
          input,
          (custody) =>
            applyDaemonStateWorkInDatabase(
              database,
              input.stateScope,
              (state, now) => apply({
                database,
                custody,
                state: createStateEffects(state, input.stateScope),
                now,
              }),
            ),
        )
        faultHook?.('before-commit')
        database.exec('COMMIT')
        faultHook?.('after-commit')
        return result
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // The transaction may have committed before an after-commit fault.
        }
        throw error
      }
    } finally {
      database.close()
    }
  }
}

function createStateEffects(
  state: DaemonState,
  scope: DaemonStateRowScope,
): DaemonCustodyStateEffects {
  return {
    getProofOperation(operationId) {
      assertSelected(scope.proofOperationIds, operationId, 'proof operation')
      return cloneOrNull(state.proofOperations[operationId])
    },
    putProofOperation(operation) {
      assertSelected(scope.proofOperationIds, operation.operationId, 'proof operation')
      state.proofOperations[operation.operationId] = structuredClone(operation)
    },
    getTradeSession(tradeId) {
      assertSelected(scope.tradeIds, tradeId, 'trade session')
      return cloneOrNull(state.durableTradeSessions[tradeId])
    },
    putTradeSession(session) {
      assertSelected(scope.tradeIds, session.tradeId, 'trade session')
      state.durableTradeSessions[session.tradeId] = structuredClone(session)
    },
    getSwap(tradeId) {
      assertSelected(scope.swapIds, tradeId, 'swap')
      return cloneOrNull(state.swaps[tradeId])
    },
    putSwap(swap) {
      assertSelected(scope.swapIds, swap.tradeId, 'swap')
      state.swaps[swap.tradeId] = structuredClone(swap)
    },
    reserveWalletProofs(input, now) {
      assertWalletPrepareSelected(scope, input)
      reserveWalletProofsForPrepareInState(state, input, now)
    },
    applyWalletProofDelta(delta) {
      assertWalletDeltaSelected(scope, delta)
      applyWalletProofDeltaInState(state, delta)
    },
    releaseWalletProofsForRecoveryAbort(operation, now, restoreReservationId) {
      assertWalletAbortSelected(scope, operation)
      releaseWalletProofsForRecoveryAbortInState(
        state,
        operation,
        now,
        restoreReservationId,
      )
    },
  }
}

function assertWalletAbortSelected(
  scope: DaemonStateRowScope,
  operation: ProofOperationRecord,
): void {
  if (scope.walletProofs === 'all') return
  const selectors = walletProofSelectorsForRecoveryAbort(operation)
  if (selectors === undefined) return
  const permitted = selectedWalletProofIds(scope)
  const selected = selectors.flatMap((selector) => selector.proofIds ?? [])
  if (selected.some((proofId) => !permitted.has(proofId))) {
    throw new Error('wallet proof abort is outside its exact state scope')
  }
}

function assertWalletPrepareSelected(
  scope: DaemonStateRowScope,
  input: PrepareProofOperationInput,
): void {
  const reservation = input.walletProofReservation
  if (reservation === undefined || scope.walletProofs === 'all') return
  const permitted = selectedWalletProofIds(scope)
  const changed = input.inputs.map((proof) =>
    deriveDaemonWalletProofIdFromProof(
      input.mintUrl,
      reservation.unit,
      proof,
    ),
  )
  if (changed.some((proofId) => !permitted.has(proofId))) {
    throw new Error('wallet proof reservation is outside its exact state scope')
  }
}

function assertWalletDeltaSelected(
  scope: DaemonStateRowScope,
  delta: DaemonWalletProofDelta,
): void {
  if (scope.walletProofs === 'all') return
  const permitted = selectedWalletProofIds(scope)
  const changed = [
    ...delta.deleteProofIds,
    ...delta.upsertProofs.map((proof) =>
      deriveDaemonWalletProofIdFromProof(proof.mintUrl, proof.unit, proof.proof),
    ),
  ]
  if (changed.some((proofId) => !permitted.has(proofId))) {
    throw new Error('wallet proof delta is outside its exact state scope')
  }
}

function selectedWalletProofIds(scope: DaemonStateRowScope): Set<string> {
  if (scope.walletProofs === 'all') return new Set()
  return new Set(
    scope.walletProofs?.flatMap((selector) => selector.proofIds ?? []) ?? [],
  )
}

function assertSelected(
  selection: readonly string[] | 'all' | undefined,
  id: string,
  label: string,
): void {
  if (selection !== 'all' && !selection?.includes(id)) {
    throw new Error(`daemon custody ${label} is outside its state scope`)
  }
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value)
}
