import { isDeepStrictEqual } from 'node:util'
import {
  createDurableOrderCollateralPin,
  durableOrderCollateralPinId,
  reduceDurableOrderCollateralPin,
  type DurableOrderCollateralPin,
  type DurableOrderPreflightSplit,
  type DurableOrderSubmissionRequest,
} from '@bitcaster-market/client-sdk/durableOrderCollateral'
import { applyDurableCustodyWorkInDatabase } from './durableCustodySqliteStore.ts'
import type { DaemonDurableCustodyLease } from './durableCustodyLifecycle.ts'
import {
  assertOrderCollateralPinOwnsProofs,
  insertOrderCollateralPinInDatabase,
  readPreparedOrderCollateralPageInDatabase,
  readPreparingOrderCollateralPageInDatabase,
  readOrderCollateralPinInDatabase,
  reconcileOrderCollateralFillInDatabase,
  reconcileOrderCollateralTransformInDatabase,
  replaceOrderCollateralPinInDatabase,
} from './durableOrderCollateralSqlite.ts'
import { openProfileDatabase } from './profile.ts'
import {
  applyDaemonStateWorkInDatabase,
  type DaemonState,
  type StoredProofRecord,
} from './state.ts'
import {
  deriveDaemonWalletProofId,
  deriveDaemonWalletProofIdFromProof,
  type DaemonStateRowScope,
} from './stateSqlite.ts'

type CollateralProofRecord = Pick<
  StoredProofRecord,
  'proof' | 'mintUrl' | 'unit' | 'asset'
>

interface DaemonOrderCollateralAuthority {
  readonly scope: DaemonDurableCustodyLease['scope']
  assertActive(): void
  authorization(): ReturnType<DaemonDurableCustodyLease['authorization']>
}

export class DaemonOrderCollateralCoordinator {
  private readonly authority: DaemonOrderCollateralAuthority

  constructor(authority: DaemonOrderCollateralAuthority) {
    this.authority = authority
  }

  async prepare(input: {
    clientOrderId: string
    marketId: string
    mintUrl: string
    unit: string
    orderAmount: number
    requiredAmount: number
    submissionRequest: DurableOrderSubmissionRequest
    preflightSplit?: DurableOrderPreflightSplit | null
    preparing?: boolean
    proofs: readonly StoredProofRecord[]
  }): Promise<DurableOrderCollateralPin> {
    this.authority.assertActive()
    const pin = createDurableOrderCollateralPin({
      ...input,
      scopeId: this.authority.scope.scopeId,
      proofs: input.proofs.map(toCollateralProof),
    })
    return this.transact((database) => {
      const proofIds = pin.proofs.map((proof) => proof.proofId)
      const prepared = applyDaemonStateWorkInDatabase(
        database,
        { walletProofs: [{ proofIds }] },
        (state, now) => {
          reserveExactProofRows(state.wallet.proofs, pin, now)
          return insertOrderCollateralPinInDatabase(database, pin)
        },
      )
      return prepared
    })
  }

  async bindOrObserve(input: {
    pinId: string
    orderId: string
    status: string
    remainingAmount: number
  }): Promise<DurableOrderCollateralPin> {
    this.authority.assertActive()
    return this.transact((database) => {
      const current = requirePin(database, this.authority.scope.scopeId, input.pinId)
      const next = reduceDurableOrderCollateralPin(current, {
        kind: current.orderId === null ? 'bind-engine-order' : 'observe-engine-order',
        expectedRevision: current.revision,
        orderId: input.orderId,
        status: input.status,
        remainingAmount: input.remainingAmount,
      })
      return replaceAndReleaseProjection(database, current, next)
    })
  }

  async readPreparedPage(input: {
    cursor?: string | null
    limit: number
  }) {
    this.authority.assertActive()
    return this.transact((database) =>
      readPreparedOrderCollateralPageInDatabase(database, {
        scopeId: this.authority.scope.scopeId,
        ...input,
      }))
  }

  async readPreparingPage(input: {
    cursor?: string | null
    limit: number
  }) {
    this.authority.assertActive()
    return this.transact((database) =>
      readPreparingOrderCollateralPageInDatabase(database, {
        scopeId: this.authority.scope.scopeId,
        ...input,
      }))
  }

  async commitAcceptedSubmission<Result>(input: {
    pinId: string
    orderId: string
    status: string
    remainingAmount: number
    stateScope: DaemonStateRowScope
    applyState: (state: DaemonState, now: string) => Result
  }): Promise<{ pin: DurableOrderCollateralPin; result: Result }> {
    this.authority.assertActive()
    return this.transact((database) => {
      const current = requirePin(database, this.authority.scope.scopeId, input.pinId)
      const next = reduceDurableOrderCollateralPin(current, {
        kind: current.orderId === null ? 'bind-engine-order' : 'observe-engine-order',
        expectedRevision: current.revision,
        orderId: input.orderId,
        status: input.status,
        remainingAmount: input.remainingAmount,
      })
      const stateScope = withCollateralWalletScope(input.stateScope, current, [])
      return applyDaemonStateWorkInDatabase(database, stateScope, (state, now) => {
        const result = input.applyState(state, now)
        replaceOrderCollateralPinInDatabase(database, current, next)
        alignOrderCollateralProjection(state, next, [], now)
        return { pin: next, result }
      })
    })
  }

  async releaseBeforeSubmit(pinId: string): Promise<DurableOrderCollateralPin> {
    this.authority.assertActive()
    return this.transact((database) => {
      const current = requirePin(database, this.authority.scope.scopeId, pinId)
      const next = reduceDurableOrderCollateralPin(current, {
        kind: 'release-before-submit',
        expectedRevision: current.revision,
        reason: 'pre-submit-rejected',
      })
      return replaceAndReleaseProjection(database, current, next)
    })
  }

  async finishPreparation(pinId: string): Promise<DurableOrderCollateralPin> {
    this.authority.assertActive()
    return this.transact((database) => {
      const current = requirePin(database, this.authority.scope.scopeId, pinId)
      const next = reduceDurableOrderCollateralPin(current, {
        kind: 'finish-preparation',
        expectedRevision: current.revision,
      })
      return replaceOrderCollateralPinInDatabase(database, current, next)
    })
  }

  async releaseTerminal(input: {
    pinId: string
    orderId: string
    status: 'cancelled' | 'failed' | 'expired'
    tradeIds: readonly string[]
  }): Promise<DurableOrderCollateralPin> {
    this.authority.assertActive()
    return this.transact((database) => {
      const current = requirePin(
        database,
        this.authority.scope.scopeId,
        input.pinId,
      )
      assertEveryTradeFillReconciled(
        database,
        this.authority.scope.scopeId,
        input.pinId,
        input.tradeIds,
      )
      const next = reduceDurableOrderCollateralPin(current, {
        kind: current.orderId === null ? 'bind-engine-order' : 'observe-engine-order',
        expectedRevision: current.revision,
        orderId: input.orderId,
        status: input.status,
        remainingAmount: 0,
      })
      return replaceAndReleaseProjection(database, current, next)
    })
  }

  async assertOwnsProofs(
    pinId: string,
    proofs: readonly StoredProofRecord[],
  ): Promise<DurableOrderCollateralPin> {
    this.authority.assertActive()
    return this.transact((database) => {
      const proofIds = proofs.map(deriveDaemonWalletProofId)
      assertOrderCollateralPinOwnsProofs(
        database,
        this.authority.scope.scopeId,
        pinId,
        proofIds,
      )
      return requirePin(database, this.authority.scope.scopeId, pinId)
    })
  }

  async classifyProofs(
    pinId: string,
    input: {
      mintUrl: string
      unit: string
      proofs: readonly Pick<StoredProofRecord['proof'], 'id' | 'secret'>[]
    },
  ): Promise<'all' | 'none'> {
    this.authority.assertActive()
    return this.transact((database) => {
      const pin = requirePin(
        database,
        this.authority.scope.scopeId,
        pinId,
      )
      const owned = new Set(pin.proofs.map((proof) => proof.proofId))
      const matches = input.proofs.map((proof) => owned.has(
        deriveDaemonWalletProofIdFromProof(
          input.mintUrl,
          input.unit,
          proof,
        ),
      ))
      if (matches.every(Boolean)) return 'all'
      if (matches.every((match) => !match)) return 'none'
      throw new Error('custody operation mixes pinned and foreign proofs')
    })
  }

  async readProofIds(pinId: string): Promise<string[]> {
    this.authority.assertActive()
    return this.transact((database) => {
      const pin = requirePin(
        database,
        this.authority.scope.scopeId,
        pinId,
      )
      if (pin.state === 'released') {
        throw new Error('order collateral pin is released')
      }
      return pin.proofs.map((proof) => proof.proofId)
    })
  }

  async commitFill(input: {
    pinId: string
    orderId: string
    tradeId: string
    fillOrderAmount: number
    operationKeys: readonly string[]
    releaseProofs: readonly StoredProofRecord[]
    replacementProofs: readonly CollateralProofRecord[]
    stateScope: DaemonStateRowScope
    applyState: (state: DaemonState, now: string) => void
  }): Promise<DurableOrderCollateralPin> {
    this.authority.assertActive()
    return this.transact((database) => {
      const current = requirePin(
        database,
        this.authority.scope.scopeId,
        input.pinId,
      )
      const stateScope = withCollateralWalletScope(
        input.stateScope,
        current,
        input.replacementProofs,
      )
      return applyDaemonStateWorkInDatabase(database, stateScope, (state, now) => {
        const next = reconcileOrderCollateralFillInDatabase(database, {
          scopeId: this.authority.scope.scopeId,
          pinId: input.pinId,
          orderId: input.orderId,
          tradeId: input.tradeId,
          fillOrderAmount: input.fillOrderAmount,
          operationKeys: input.operationKeys,
          releaseProofIds: input.releaseProofs.map(deriveDaemonWalletProofId),
          replacementProofs: input.replacementProofs.map(toCollateralProof),
        })
        input.applyState(state, now)
        alignOrderCollateralProjection(state, next, input.replacementProofs, now)
        return next
      })
    })
  }

  async commitTransform(input: {
    pinId: string
    transformId: string
    operationKeys: readonly string[]
    replacementProofs: readonly CollateralProofRecord[]
    stateScope: DaemonStateRowScope
    applyState: (state: DaemonState, now: string) => void
  }): Promise<DurableOrderCollateralPin> {
    this.authority.assertActive()
    return this.transact((database) => {
      const current = requirePin(
        database,
        this.authority.scope.scopeId,
        input.pinId,
      )
      const stateScope = withCollateralWalletScope(
        input.stateScope,
        current,
        input.replacementProofs,
      )
      return applyDaemonStateWorkInDatabase(database, stateScope, (state, now) => {
        const next = reconcileOrderCollateralTransformInDatabase(database, {
          scopeId: this.authority.scope.scopeId,
          pinId: input.pinId,
          transformId: input.transformId,
          operationKeys: input.operationKeys,
          replacementProofs: input.replacementProofs.map(toCollateralProof),
        })
        input.applyState(state, now)
        alignOrderCollateralProjection(state, next, input.replacementProofs, now)
        return next
      })
    })
  }

  private transact<T>(work: (database: ReturnType<typeof openProfileDatabase>) => T): T {
    const database = openProfileDatabase()
    try {
      database.exec('BEGIN IMMEDIATE')
      try {
        const result = applyDurableCustodyWorkInDatabase(
          database,
          {
            scope: this.authority.scope,
            owner: this.authority.authorization(),
          },
          () => work(database),
        )
        faultHook?.('before-commit')
        database.exec('COMMIT')
        faultHook?.('after-commit')
        return result
      } catch (error) {
        try {
          database.exec('ROLLBACK')
        } catch {
          // The transaction may already have ended while reporting corruption.
        }
        throw error
      }
    } finally {
      database.close()
    }
  }
}

let installedCoordinator: DaemonOrderCollateralCoordinator | undefined
let faultHook: ((stage: 'before-commit' | 'after-commit') => void) | undefined

export function setDaemonOrderCollateralFaultHookForTest(
  hook: typeof faultHook,
): void {
  faultHook = hook
}

export function installDaemonOrderCollateralCoordinator(
  coordinator: DaemonOrderCollateralCoordinator,
): () => void {
  if (installedCoordinator !== undefined) {
    throw new Error('daemon order collateral coordinator is already installed')
  }
  installedCoordinator = coordinator
  return () => {
    if (installedCoordinator === coordinator) installedCoordinator = undefined
  }
}

export function requireDaemonOrderCollateralCoordinator(): DaemonOrderCollateralCoordinator {
  if (installedCoordinator === undefined) {
    throw new Error('daemon order collateral coordinator is unavailable')
  }
  return installedCoordinator
}

function toCollateralProof(record: CollateralProofRecord) {
  const proofId = collateralProofId(record)
  if (!record.proof.id) throw new Error('order collateral proof has no keyset id')
  return {
    proofId,
    keysetId: record.proof.id,
    amount: Number(record.proof.amount),
    asset: record.asset.kind === 'sats'
      ? { kind: 'base' as const }
      : {
          kind: 'outcome' as const,
          conditionId: record.asset.conditionId,
          outcomeSetId: record.asset.outcomeSetId,
        },
  }
}

function withCollateralWalletScope(
  scope: DaemonStateRowScope,
  pin: DurableOrderCollateralPin,
  replacements: readonly CollateralProofRecord[],
): DaemonStateRowScope {
  if (scope.walletProofs === 'all') return scope
  const proofIds = [
    ...pin.proofs.map((proof) => proof.proofId),
    ...replacements.map(collateralProofId),
  ]
  return {
    ...scope,
    walletProofs: [
      ...(scope.walletProofs ?? []),
      { proofIds: [...new Set(proofIds)] },
    ],
  }
}

function alignOrderCollateralProjection(
  state: DaemonState,
  pin: DurableOrderCollateralPin,
  replacements: readonly CollateralProofRecord[],
  now: string,
): void {
  const replacementIds = new Set(replacements.map(collateralProofId))
  const pinProofIds = new Set(pin.proofs.map((proof) => proof.proofId))
  for (const row of state.wallet.proofs) {
    const proofId = deriveDaemonWalletProofId(row)
    if (pin.state !== 'released' && pinProofIds.has(proofId)) {
      row.state = 'reserved'
      row.reservedBy = pin.pinId
      row.updatedAt = now
      continue
    }
    if ((pin.state === 'released' && row.reservedBy === pin.pinId)
      || replacementIds.has(proofId)) {
      row.state = 'available'
      delete row.reservedBy
      row.updatedAt = now
    }
  }
  if (pin.state !== 'released') {
    const projected = new Set(state.wallet.proofs.map(deriveDaemonWalletProofId))
    if ([...replacementIds].some((proofId) => !projected.has(proofId))) {
      throw new Error('order collateral replacement proof was not projected')
    }
  }
}

function collateralProofId(record: CollateralProofRecord): string {
  return deriveDaemonWalletProofIdFromProof(
    record.mintUrl,
    record.unit,
    record.proof,
  )
}

function reserveExactProofRows(
  rows: StoredProofRecord[],
  pin: DurableOrderCollateralPin,
  now: string,
): void {
  const expected = new Map(pin.proofs.map((proof) => [proof.proofId, proof]))
  if (rows.length !== expected.size) {
    throw new Error('order collateral selection changed before reservation')
  }
  for (const row of rows) {
    const proof = expected.get(deriveDaemonWalletProofId(row))
    if (proof === undefined || !proofMatchesPin(row, pin, proof)) {
      throw new Error('order collateral proof projection is foreign')
    }
    if (row.state === 'reserved' && row.reservedBy === pin.pinId) continue
    if (row.state !== 'available') {
      throw new Error('order collateral proof is no longer available')
    }
    row.state = 'reserved'
    row.reservedBy = pin.pinId
    row.updatedAt = now
  }
}

function proofMatchesPin(
  row: StoredProofRecord,
  pin: DurableOrderCollateralPin,
  proof: DurableOrderCollateralPin['proofs'][number],
): boolean {
  const asset = row.asset.kind === 'sats'
    ? { kind: 'base' as const }
    : {
        kind: 'outcome' as const,
        conditionId: row.asset.conditionId,
        outcomeSetId: row.asset.outcomeSetId,
      }
  return row.mintUrl === pin.mintUrl
    && row.unit === pin.unit
    && row.proof.id === proof.keysetId
    && Number(row.proof.amount) === proof.amount
    && isDeepStrictEqual(asset, proof.asset)
}

function replaceAndReleaseProjection(
  database: ReturnType<typeof openProfileDatabase>,
  current: DurableOrderCollateralPin,
  next: DurableOrderCollateralPin,
): DurableOrderCollateralPin {
  if (next.state !== 'released') {
    return replaceOrderCollateralPinInDatabase(database, current, next)
  }
  const proofIds = current.proofs.map((proof) => proof.proofId)
  return applyDaemonStateWorkInDatabase(
    database,
    { walletProofs: [{ proofIds }] },
    (state, now) => {
      for (const proof of state.wallet.proofs) {
        if (proof.state !== 'reserved' || proof.reservedBy !== current.pinId) continue
        proof.state = 'available'
        delete proof.reservedBy
        proof.updatedAt = now
      }
      return replaceOrderCollateralPinInDatabase(database, current, next)
    },
  )
}

function requirePin(
  database: ReturnType<typeof openProfileDatabase>,
  scopeId: string,
  pinId: string,
): DurableOrderCollateralPin {
  const pin = readOrderCollateralPinInDatabase(database, scopeId, pinId)
  if (pin === null) throw new Error('order collateral pin is missing')
  return pin
}

function assertEveryTradeFillReconciled(
  database: ReturnType<typeof openProfileDatabase>,
  scopeId: string,
  pinId: string,
  tradeIds: readonly string[],
): void {
  if (new Set(tradeIds).size !== tradeIds.length) {
    throw new Error('terminal order collateral trade set is invalid')
  }
  const read = database.prepare(
    `SELECT 1 FROM custody_order_collateral_fills
      WHERE scope_id = ? AND pin_id = ? AND trade_id = ?`,
  )
  if (tradeIds.some((tradeId) => read.get(scopeId, pinId, tradeId) === undefined)) {
    throw new Error('terminal order collateral has an unreconciled fill')
  }
}

export { durableOrderCollateralPinId }
