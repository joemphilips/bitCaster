import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import type { Proof } from '@cashu/cashu-ts'
import {
  applyDurableCustodyTransaction,
  type DurableCustodyScope,
  type DurableCustodyRecord,
  type DurableCustodyArtifactReference,
} from '@bitcaster-market/client-sdk/durableCustody'
import {
  bindDurableCustodyProofOperation,
  createDurableCustodyProofOperation,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperationRecord'
import type { DurableCustodyProofOperationInput } from '@bitcaster-market/client-sdk/durableCustodyProofOperation'
import {
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  readDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
  type DurableCustodyMintKeysetAuthority,
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import type { DurableCtfRangeOperation } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import {
  readDaemonProofOperationFromDatabase,
  readDaemonReservedWalletProofsFromDatabase,
  replaceDaemonReservedWalletProofsFromDatabase,
  completeRangeSourceFromDatabase,
  completeCtfConsolidationTargetFromDatabase,
  type CashuProofRecord,
  type ProofOperationRecord,
  type StoredProofAsset,
} from './state.ts'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import { DurableCustodyTransactionSqlite } from './durableCustodyTransactionSqlite.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import {
  createCustodyProofSqliteRow,
  createCustodyProofSqliteRowFromMaterial,
} from './custodyProofSqliteRow.ts'

const SOURCE_PURPOSE = 'ctf-range-authorization-source'

export function createDaemonRangeSourceBinding(input: {
  scope: DurableCustodyScope
  operation: DurableCustodyProofOperationInput
  keysets: readonly DurableCustodyMintKeysetAuthority[]
  reservationId: string
}) {
  const authority = prepareDurableCustodyMintOperationAuthority(input)
  const artifacts = {
    requestBody: authority.exactRequest,
    output: authority.exactOutput,
    privateMaterial: authority.exactAuthority,
  }
  return {
    artifacts,
    record: createDurableCustodyProofOperation({
      scope: input.scope,
      operation: input.operation,
      facts: authority.facts,
      inventoryAccountId: null,
      reservationId: input.reservationId,
      exactBoundary: {
        method: 'POST',
        path: '/v1/swap',
        idempotencyKey: input.operation.operationId,
        ...artifacts,
      },
    }),
  }
}

export function bindDaemonRangeSourceInTransaction(
  database: DatabaseSync,
  binding: ReturnType<typeof createDaemonRangeSourceBinding>,
  inputs: readonly Proof[],
  asset: StoredProofAsset,
  fence: CustodyScopeFence,
  nowMs: number,
): void {
  const store = new DurableCustodySqliteStore(database)
  for (const proof of inputs) {
    const expected = createCustodyProofSqliteRow({
      scopeId: binding.record.scope.scopeId,
      normalizedMint: binding.record.operation.custodyContext.normalizedMint,
      unit: 'msat',
      proof: {
        ...proof,
        dleq: proof.dleq ?? null,
        witness: proof.witness ?? null,
        p2pkE: proof.p2pk_e ?? null,
      },
      baseAsset: 'sat',
      conditionId: asset.kind === 'Outcome' ? asset.conditionId : null,
      outcomeSetId: asset.kind === 'Outcome' ? asset.outcomeSetId : null,
      productBinding: null,
      signatureVerified: true,
      dleqState: proof.dleq == null ? 'not-present' : 'verified',
      nut07State: 'UNSPENT',
      selectability: 'retained',
      storageClass: 'terminal-replay-retained',
      reservationOperationId: null,
      revision: 0,
      nowMs,
    })
    const actual = store.getProof(binding.record.scope.scopeId, expected.proofId)
    if (
      actual === null ||
      actual.proofFingerprint !== expected.proofFingerprint ||
      actual.amount !== expected.amount ||
      actual.keysetId !== expected.keysetId ||
      actual.normalizedMint !== expected.normalizedMint ||
      actual.unit !== expected.unit ||
      actual.conditionId !== expected.conditionId ||
      actual.outcomeSetId !== expected.outcomeSetId ||
      actual.baseAsset !== expected.baseAsset ||
      actual.productBinding !== expected.productBinding
    ) {
      throw new Error('daemon range source canonical input is missing or foreign')
    }
  }
  applyDurableCustodyTransaction(
    new DurableCustodyTransactionSqlite(database, fence.scopeId, nowMs),
    {
      scope: binding.record.scope,
      owner: {
        incarnationId: fence.incarnationId,
        fencingEpoch: fence.fencingEpoch,
        observedAtMs: nowMs,
      },
      operationRows: [
        { operationId: binding.record.operation.operationId, expectedRevision: null },
      ],
    },
    (transaction) =>
      bindDurableCustodyProofOperation(transaction, binding.record, binding.artifacts),
  )
}

export interface CommittedDaemonCtfRangeSource {
  readonly authorization: Proof[]
}

export function releaseDaemonRangePreparationReservation(
  database: DatabaseSync,
  custodyOperationId: string,
  fence: CustodyScopeFence,
  nowMs: number,
): void {
  const record = new DurableCustodySqliteStore(database).getOperation(custodyOperationId)
  if (record === null || record.scope.scopeId !== fence.scopeId) {
    throw new Error('range preparation custody operation is missing or foreign')
  }
  const authorization = {
    incarnationId: fence.incarnationId,
    fencingEpoch: fence.fencingEpoch,
    observedAtMs: nowMs,
  }
  applyDurableCustodyTransaction(
    new DurableCustodyTransactionSqlite(database, fence.scopeId, nowMs),
    {
      scope: record.scope,
      owner: authorization,
      operationRows: [{ operationId: custodyOperationId, expectedRevision: record.revision }],
    },
    (transaction) =>
      transaction.transitionOperation({
        operationId: custodyOperationId,
        expectedRevision: record.revision,
        transition: {
          kind: 'release-unspent-reservation',
          expectedRevision: record.revision,
          authorization,
        },
      }),
  )
}

function sourceArtifact(
  store: DurableCustodySqliteStore,
  record: DurableCustodyRecord,
  reference: DurableCustodyArtifactReference,
) {
  const stored = store.getArtifact({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    expectedOperationRevision: record.revision,
    reference,
  })
  if (stored === null) throw new Error('range source custody artifact is missing')
  return stored.artifact
}

export function stageDaemonRangeSourceResult(
  database: DatabaseSync,
  custodyOperationId: string,
  result: Record<string, readonly Proof[]>,
  fence: CustodyScopeFence,
  nowMs: number,
): void {
  const store = new DurableCustodySqliteStore(database)
  const record = store.getOperation(custodyOperationId)
  if (record === null) throw new Error('range source custody operation is missing')
  const prepared = prepareDurableCustodyVerifiedMintResult({
    record,
    exactAuthority: sourceArtifact(
      store,
      record,
      record.operation.privateMaterial.exactPrivateMaterial,
    ),
    result,
  })
  applyDurableCustodyTransaction(
    new DurableCustodyTransactionSqlite(database, fence.scopeId, nowMs),
    {
      scope: record.scope,
      owner: {
        incarnationId: fence.incarnationId,
        fencingEpoch: fence.fencingEpoch,
        observedAtMs: nowMs,
      },
      operationRows: [{ operationId: custodyOperationId, expectedRevision: record.revision }],
    },
    (transaction) =>
      stageDurableCustodyPreparedMintResult({
        transaction,
        record,
        prepared,
        authorization: {
          incarnationId: fence.incarnationId,
          fencingEpoch: fence.fencingEpoch,
          observedAtMs: nowMs,
        },
      }),
  )
}

export function readDaemonRangeSourceResult(
  database: DatabaseSync,
  custodyOperationId: string,
  scopeId: string,
): { authorization: Proof[]; keep: Proof[] } | null {
  const store = new DurableCustodySqliteStore(database)
  const record = store.getOperation(custodyOperationId)
  if (record === null || record.scope.scopeId !== scopeId) {
    throw new Error('range source custody operation is missing or foreign')
  }
  if (record.operation.result.state === 'none') return null
  if (record.operation.result.exactResult === null) {
    throw new Error('range source custody result authority is missing')
  }
  const prepared = readDurableCustodyVerifiedMintResult({
    record,
    exactAuthority: sourceArtifact(
      store,
      record,
      record.operation.privateMaterial.exactPrivateMaterial,
    ),
    exactResult: sourceArtifact(store, record, record.operation.result.exactResult),
  })
  const result: { authorization: Proof[]; keep: Proof[] } = { authorization: [], keep: [] }
  for (const { group, proof } of prepared.proofs) {
    switch (group) {
      case 'authorization':
      case 'keep':
        result[group].push(proof)
        break
      default:
        throw new Error('range source result group is invalid')
    }
  }
  return result
}

function applySourceSuccessors(
  database: DatabaseSync,
  source: ProofOperationRecord,
  operation: DurableCtfRangeOperation,
  fence: CustodyScopeFence,
  nowMs: number,
): ProofOperationRecord {
  const store = new DurableCustodySqliteStore(database)
  const custodyId = requireText(source.metadata.custodySourceOperationId, 'source custody identity')
  const record = store.getOperation(custodyId)
  if (record === null || record.operation.result.exactResult === null) {
    throw new Error('range source verified result is missing')
  }
  const groups = applyRangePreparationSuccessors(
    database,
    record,
    sourceAsset(operation),
    fence,
    nowMs,
  )
  return completeRangeSourceFromDatabase(database, source.operationId, groups, nowMs)
}

export function commitDaemonRangeConsolidation(
  database: DatabaseSync,
  source: ProofOperationRecord,
  asset: StoredProofAsset,
  fence: CustodyScopeFence,
  nowMs: number,
): void {
  const custodyId = requireText(
    source.metadata.custodySourceOperationId,
    'consolidation custody identity',
  )
  const record = new DurableCustodySqliteStore(database).getOperation(custodyId)
  if (record === null || record.operation.semanticKind !== 'proof-consolidation') {
    throw new Error('range consolidation custody operation is missing or foreign')
  }
  const groups = applyRangePreparationSuccessors(database, record, asset, fence, nowMs)
  if (record.operation.result.state === 'applied') {
    const current = readDaemonProofOperationFromDatabase(database, source.operationId)
    if (current?.state !== 'completed') {
      throw new Error('range consolidation committed target is missing')
    }
    // Target completion was atomic with canonical admission. A missing target
    // successor can now belong to a later spend; replay must not reinsert it.
    return
  }
  completeCtfConsolidationTargetFromDatabase(database, {
    operationId: source.operationId,
    resultProofs: groups,
    inputAssets: source.inputs.map(() => asset),
    successorAssets: { consolidated: asset },
    nowMs,
  })
}

function applyRangePreparationSuccessors(
  database: DatabaseSync,
  record: DurableCustodyRecord,
  asset: StoredProofAsset,
  fence: CustodyScopeFence,
  nowMs: number,
): Record<string, CashuProofRecord[]> {
  if (record.scope.scopeId !== fence.scopeId || record.operation.result.exactResult === null) {
    throw new Error('range preparation result is missing or foreign')
  }
  const store = new DurableCustodySqliteStore(database)
  const custodyId = record.operation.operationId
  const prepared = readDurableCustodyVerifiedMintResult({
    record,
    exactAuthority: sourceArtifact(
      store,
      record,
      record.operation.privateMaterial.exactPrivateMaterial,
    ),
    exactResult: sourceArtifact(store, record, record.operation.result.exactResult),
  })
  const groups: Record<string, CashuProofRecord[]> =
    record.operation.semanticKind === 'proof-consolidation'
      ? { consolidated: [] }
      : { authorization: [], keep: [] }
  for (const { group, proof } of prepared.proofs) {
    if (groups[group] === undefined) throw new Error('range preparation result group is invalid')
    groups[group]!.push({ ...proof, amount: amountToNumber(proof.amount) })
  }
  if (record.operation.result.state === 'applied') return groups
  const successors = prepared.proofs.map(({ group, material, dleqState }) => ({
    proof: createCustodyProofSqliteRowFromMaterial({
      scopeId: record.scope.scopeId,
      normalizedMint: record.operation.custodyContext.normalizedMint,
      unit: 'msat',
      material,
      baseAsset: 'sat',
      conditionId: asset.kind === 'Outcome' ? asset.conditionId : null,
      outcomeSetId: asset.kind === 'Outcome' ? asset.outcomeSetId : null,
      productBinding: null,
      signatureVerified: true,
      dleqState,
      nut07State: 'UNSPENT',
      selectability: sourceSuccessorSelectability(group),
      storageClass: record.operation.proofStorage.storageClass,
      reservationOperationId: null,
      revision: 0,
      nowMs,
    }),
    expectedRevision: null,
  }))
  const transaction = new DurableCustodyTransactionSqlite(database, fence.scopeId, nowMs, [record])
  transaction.stageSuccessorProofCas(custodyId, successors)
  transaction.applyVerifiedResult({
    operationId: custodyId,
    expectedRevision: record.revision,
    authorization: {
      incarnationId: fence.incarnationId,
      fencingEpoch: fence.fencingEpoch,
      observedAtMs: nowMs,
    },
    outputPlanFingerprint: record.operation.outputPlan.outputPlanFingerprint,
    resultHandle: requireText(record.operation.result.resultHandle, 'result handle'),
    resultFingerprint: prepared.resultFingerprint,
    successorAdmission: {
      scopeId: record.scope.scopeId,
      operationId: custodyId,
      admissionId: `range-source:${prepared.resultFingerprint}`,
      proofRows: successors.map(({ proof }) => ({
        proofId: proof.proofId,
        expectedRevision: null,
        admittedRevision: proof.revision,
      })),
    },
  })
  transaction.rebuildActiveWorkIndex({
    scopeId: fence.scopeId,
    operationRows: [{ operationId: custodyId, expectedRevision: record.revision + 1 }],
  })
  return groups
}

function sourceSuccessorSelectability(group: string): 'selectable' | 'retained' {
  switch (group) {
    case 'authorization':
      // Retained inputs require a target-wallet reservation. This successor is
      // instead locked by the range bind before the enclosing transaction commits.
      return 'selectable'
    case 'keep':
    case 'consolidated':
      return 'retained'
    default:
      throw new Error('range source result group is invalid')
  }
}

export function commitDaemonCtfRangeSource(
  database: DatabaseSync,
  operation: DurableCtfRangeOperation,
  nowMs: number,
  fence: CustodyScopeFence,
): CommittedDaemonCtfRangeSource {
  let source = readDaemonProofOperationFromDatabase(database, operation.sourceOperationId)
  if (source !== null) {
    source = applySourceSuccessors(database, source, operation, fence, nowMs)
  }
  assertSourceOperation(source, operation)
  if (source === null) throw new Error('daemon CTF range source operation authority is invalid')
  const reservationId = requireText(source.metadata.reservationId, 'source reservation')
  const results = requireSourceResults(source)
  const authorization = results.authorization ?? []
  assertExactAuthorizationProofs(authorization, operation)
  const reserved = readDaemonReservedWalletProofsFromDatabase(
    database,
    operation.mintUrl,
    reservationId,
  )
  if (
    reserved.length !== source.inputs.length ||
    !source.inputs.every((inputProof) =>
      reserved.some(
        (candidate) =>
          candidate.mintUrl === operation.mintUrl &&
          candidate.state === 'reserved' &&
          sameProof(candidate.proof, inputProof),
      ),
    )
  ) {
    throw new Error('daemon CTF range source reservation is incomplete')
  }
  replaceDaemonReservedWalletProofsFromDatabase(database, {
    mintUrl: operation.mintUrl,
    reservationId,
    expectedCount: reserved.length,
    keepProofs: results.keep ?? [],
    asset: sourceAsset(operation),
    nowMs,
  })
  return {
    authorization: authorization.map(toProof),
  }
}

function assertSourceOperation(
  source: ProofOperationRecord | null,
  operation: DurableCtfRangeOperation,
): void {
  if (
    source === null ||
    source.state !== 'completed' ||
    source.mintUrl !== operation.mintUrl ||
    source.metadata.purpose !== SOURCE_PURPOSE ||
    source.metadata.rangeOperationId !== operation.operationId ||
    source.metadata.unit !== operation.unit
  ) {
    throw new Error('daemon CTF range source operation authority is invalid')
  }
  const expectedKind =
    operation.offerAsset.kind === 'regular' ? 'wallet-send' : 'conditional-keyset-swap'
  if (source.kind !== expectedKind) {
    throw new Error('daemon CTF range source operation kind is invalid')
  }
}

function requireSourceResults(source: ProofOperationRecord): Record<string, CashuProofRecord[]> {
  const results = source.resultProofs
  if (results === undefined || Object.keys(results).sort().join('\0') !== 'authorization\0keep') {
    throw new Error('daemon CTF range source result groups are invalid')
  }
  return results
}

function assertExactAuthorizationProofs(
  proofs: readonly CashuProofRecord[],
  operation: DurableCtfRangeOperation,
): void {
  if (
    proofs.length !== operation.inputs.length ||
    proofs.some((proof, index) => !sameProof(proof, operation.inputs[index]!))
  ) {
    throw new Error('daemon CTF range source authorization result is foreign')
  }
}

function sourceAsset(operation: DurableCtfRangeOperation): StoredProofAsset {
  return operation.offerAsset.kind === 'regular'
    ? { kind: 'sats', baseAsset: 'sat', unit: operation.unit }
    : {
        kind: 'Outcome',
        conditionId: operation.offerAsset.conditionId,
        outcomeSetId: operation.offerAsset.outcomeCollection,
        baseAsset: 'sat',
        unit: operation.unit,
      }
}

interface ComparableProof {
  readonly id?: string
  readonly amount: unknown
  readonly secret: string
  readonly C: string
  readonly dleq?: unknown
  readonly witness?: unknown
  readonly p2pk_e?: string | null
  readonly p2pkE?: string | null
}

function sameProof(left: ComparableProof, right: ComparableProof): boolean {
  return (
    left.id === right.id &&
    amountToNumber(left.amount) === amountToNumber(right.amount) &&
    left.secret === right.secret &&
    left.C === right.C &&
    isDeepStrictEqual(left.dleq ?? null, right.dleq ?? null) &&
    isDeepStrictEqual(left.witness ?? null, right.witness ?? null) &&
    (left.p2pk_e ?? left.p2pkE ?? null) === (right.p2pk_e ?? right.p2pkE ?? null)
  )
}

function toProof(value: CashuProofRecord): Proof {
  return {
    ...structuredClone(value),
    id: requireText(value.id, 'authorization keyset'),
    amount: amountToNumber(value.amount) as never,
  } as Proof
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`daemon CTF range ${label} is invalid`)
  }
  return value
}
