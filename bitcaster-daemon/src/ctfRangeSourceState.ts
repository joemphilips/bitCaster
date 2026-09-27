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
import {
  deserializeDurableCustodyOutput,
  type DurableCustodyProofOperationInput,
} from '@bitcaster-market/client-sdk/durableCustodyProofOperation'
import {
  assertDurableCustodyMintOperationAuthority,
  prepareDurableCustodyMintOperationAuthority,
  prepareDurableCustodyVerifiedMintResult,
  readDurableCustodyVerifiedMintResult,
  stageDurableCustodyPreparedMintResult,
  type DurableCustodyMintKeysetAuthority,
  type DurableCustodyVerifiedMintResult,
} from '@bitcaster-market/client-sdk/durableCustodyMintResult'
import {
  decodeCtfRangeOrderPreparationFromRecord,
  type PersistedCtfRangeOrderPreparation,
} from '@bitcaster-market/client-sdk/ctfRangeOrderProtocol'
import type { DurableCtfRangeOperation } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import {
  ctfRangeMixedSourceChangeDerivationLocators,
  validateCtfRangeMixedSourceOperation,
  type CtfRangeMixedSourceResult,
} from '@bitcaster-market/client-sdk/ctfRangeCollateralSourceOperation'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import {
  readDaemonProofOperationFromDatabase,
  readDaemonReservedWalletProofsFromDatabase,
  replaceDaemonReservedWalletProofsFromDatabase,
  completeRangeSourceFromDatabase,
  completeCtfConsolidationTargetFromDatabase,
  type CashuProofRecord,
  type ProofOperationRecord,
  type StoredOutputData,
  type StoredProofAsset,
} from './state.ts'
import { serializeOutputDataArray } from './walletOps.ts'
import { readRangePreparation, toSdkRangePreparationRecord } from './ctfRangeOrderJournalSqlite.ts'
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
        path:
          input.operation.kind === 'ctf-range-conditional-source' &&
          input.operation.metadata?.sourceMode === 'mixed-source-ctf-convert'
            ? '/v1/ctf/convert'
            : '/v1/swap',
        idempotencyKey: input.operation.operationId,
        ...artifacts,
      },
    }),
  }
}

export function createDaemonRangeMixedSourceBinding(input: {
  scope: DurableCustodyScope
  operation: DurableCustodyProofOperationInput
  preparation: PersistedCtfRangeOrderPreparation
  keysets: readonly DurableCustodyMintKeysetAuthority[]
  reservationId: string
}) {
  const operation = validateCtfRangeMixedSourceOperation(input.operation, input.preparation)
  const binding = createDaemonRangeSourceBinding({
    scope: input.scope,
    operation,
    keysets: input.keysets,
    reservationId: input.reservationId,
  })
  return { ...binding, operation, preparation: input.preparation }
}

export function bindDaemonRangeSourceInTransaction(
  database: DatabaseSync,
  binding: ReturnType<typeof createDaemonRangeSourceBinding>,
  inputs: readonly Proof[],
  asset: StoredProofAsset,
  fence: CustodyScopeFence,
  nowMs: number,
): void {
  bindDaemonRangeSourceInputsInTransaction(
    database,
    binding,
    inputs.map((proof) => ({ proof, asset })),
    fence,
    nowMs,
  )
}

export function bindDaemonRangeMixedSourceInTransaction(
  database: DatabaseSync,
  binding: ReturnType<typeof createDaemonRangeMixedSourceBinding>,
  fence: CustodyScopeFence,
  nowMs: number,
): void {
  const metadata = binding.operation.metadata!
  const offeredInputCount = metadata.offeredInputCount as number
  const conditionalAsset = mixedConditionalAsset(binding.preparation)
  const collateralAsset = mixedCollateralAsset(binding.preparation)
  const inputs = binding.operation.inputs.map((proof) => toProof(proof as CashuProofRecord))
  bindDaemonRangeSourceInputsInTransaction(
    database,
    binding,
    inputs.map((proof, index) => ({
      proof,
      asset: index < offeredInputCount ? conditionalAsset : collateralAsset,
    })),
    fence,
    nowMs,
  )
}

function bindDaemonRangeSourceInputsInTransaction(
  database: DatabaseSync,
  binding: ReturnType<typeof createDaemonRangeSourceBinding>,
  inputs: readonly { readonly proof: Proof; readonly asset: StoredProofAsset }[],
  fence: CustodyScopeFence,
  nowMs: number,
): void {
  const store = new DurableCustodySqliteStore(database)
  if (inputs.length !== binding.record.operation.reservation.inputs.length) {
    throw new Error('daemon range source canonical input count is invalid')
  }
  for (const { proof, asset } of inputs) {
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

export function stageDaemonRangeMixedSourceResult(
  database: DatabaseSync,
  custodyOperationId: string,
  result: CtfRangeMixedSourceResult,
  fence: CustodyScopeFence,
  nowMs: number,
): void {
  stageDaemonRangeSourceResult(
    database,
    custodyOperationId,
    {
      authorization: result.authorization,
      'offered-change': result.offeredChange,
      'collateral-change': result.collateralChange,
    },
    fence,
    nowMs,
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

export function readDaemonRangeMixedSourceResult(
  database: DatabaseSync,
  custodyOperationId: string,
  scopeId: string,
): CtfRangeMixedSourceResult | null {
  const store = new DurableCustodySqliteStore(database)
  const record = store.getOperation(custodyOperationId)
  if (record === null || record.scope.scopeId !== scopeId) {
    throw new Error('mixed range source custody operation is missing or foreign')
  }
  if (record.operation.semanticKind !== 'ctf-range-conditional-source') {
    throw new Error('mixed range source custody operation kind is invalid')
  }
  if (record.operation.result.state === 'none') return null
  if (record.operation.result.exactResult === null) {
    throw new Error('mixed range source custody result authority is missing')
  }
  return mixedSourceResultFromPrepared(readVerifiedCustodyMintResult(database, record))
}

function mixedSourceResultFromPrepared(
  prepared: DurableCustodyVerifiedMintResult,
): CtfRangeMixedSourceResult {
  const authorization: Proof[] = []
  const offeredChange: Proof[] = []
  const collateralChange: Proof[] = []
  for (const { group, proof } of prepared.proofs) {
    switch (group) {
      case 'authorization':
        authorization.push(proof)
        break
      case 'offered-change':
        offeredChange.push(proof)
        break
      case 'collateral-change':
        collateralChange.push(proof)
        break
      default:
        throw new Error('mixed range source result group is invalid')
    }
  }
  if (authorization.length === 0) {
    throw new Error('mixed range source authorization result is missing')
  }
  return { authorization, offeredChange, collateralChange }
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
    {
      authorization: sourceAsset(operation),
      keep: sourceAsset(operation),
    },
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
  const groups = applyRangePreparationSuccessors(
    database,
    record,
    { consolidated: asset },
    fence,
    nowMs,
  )
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
  successorAssets: Readonly<Record<string, StoredProofAsset>>,
  fence: CustodyScopeFence,
  nowMs: number,
): Record<string, CashuProofRecord[]> {
  const groups =
    record.operation.semanticKind === 'proof-consolidation'
      ? ['consolidated']
      : ['authorization', 'keep']
  const prepared = readRangePreparationVerifiedResult(database, record, fence)
  return applyVerifiedRangePreparationSuccessors(
    database,
    record,
    prepared,
    successorAssets,
    groups,
    fence,
    nowMs,
  )
}

function readRangePreparationVerifiedResult(
  database: DatabaseSync,
  record: DurableCustodyRecord,
  fence: CustodyScopeFence,
): DurableCustodyVerifiedMintResult {
  if (record.scope.scopeId !== fence.scopeId || record.operation.result.exactResult === null) {
    throw new Error('range preparation result is missing or foreign')
  }
  return readVerifiedCustodyMintResult(database, record)
}

function readVerifiedCustodyMintResult(
  database: DatabaseSync,
  record: DurableCustodyRecord,
): DurableCustodyVerifiedMintResult {
  if (record.operation.result.exactResult === null) {
    throw new Error('range preparation result is missing')
  }
  const store = new DurableCustodySqliteStore(database)
  return readDurableCustodyVerifiedMintResult({
    record,
    exactAuthority: sourceArtifact(
      store,
      record,
      record.operation.privateMaterial.exactPrivateMaterial,
    ),
    exactResult: sourceArtifact(store, record, record.operation.result.exactResult),
  })
}

function applyVerifiedRangePreparationSuccessors(
  database: DatabaseSync,
  record: DurableCustodyRecord,
  prepared: DurableCustodyVerifiedMintResult,
  successorAssets: Readonly<Record<string, StoredProofAsset>>,
  expectedGroups: readonly string[],
  fence: CustodyScopeFence,
  nowMs: number,
): Record<string, CashuProofRecord[]> {
  if (Object.keys(successorAssets).sort().join('\0') !== [...expectedGroups].sort().join('\0')) {
    throw new Error('range preparation successor assets are invalid')
  }
  const groups = Object.fromEntries(expectedGroups.map((group) => [group, []])) as Record<
    string,
    CashuProofRecord[]
  >
  for (const { group, proof } of prepared.proofs) {
    if (groups[group] === undefined || successorAssets[group] === undefined) {
      throw new Error('range preparation result group is invalid')
    }
    groups[group]!.push({ ...proof, amount: amountToNumber(proof.amount) })
  }
  if (record.operation.result.state === 'applied') return groups
  const custodyId = record.operation.operationId
  const successors = prepared.proofs.map(({ group, material, dleqState }) => {
    const asset = successorAssets[group]!
    return {
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
    }
  })
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
    case 'offered-change':
    case 'collateral-change':
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
  if (source?.metadata.sourceMode === 'mixed-source-ctf-convert') {
    return commitDaemonMixedCtfRangeSource(database, source, operation, fence, nowMs)
  }
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

function commitDaemonMixedCtfRangeSource(
  database: DatabaseSync,
  source: ProofOperationRecord,
  operation: DurableCtfRangeOperation,
  fence: CustodyScopeFence,
  nowMs: number,
): CommittedDaemonCtfRangeSource {
  if (source.state === 'Failed') {
    throw new Error(`daemon mixed CTF range source failed: ${source.lastError ?? 'unknown error'}`)
  }
  const preparationRecord = readRangePreparation(database, fence.scopeId, operation.operationId)
  if (preparationRecord === null) {
    throw new Error('daemon mixed CTF range preparation authority is missing')
  }
  const preparation = decodeCtfRangeOrderPreparationFromRecord(
    toSdkRangePreparationRecord(preparationRecord),
  )
  const sourceOperation = assertMixedSourceAuthority(source, operation, preparation)
  const custodyId = requireText(source.metadata.custodySourceOperationId, 'source custody identity')
  const custodyRecord = new DurableCustodySqliteStore(database).getOperation(custodyId)
  if (
    custodyRecord === null ||
    custodyRecord.scope.scopeId !== fence.scopeId ||
    custodyRecord.operation.semanticKind !== 'ctf-range-conditional-source'
  ) {
    throw new Error('daemon mixed range source custody operation is missing or foreign')
  }
  const alreadyApplied = custodyRecord.operation.result.state === 'applied'
  const successors = applyMixedRangePreparationSuccessors(
    database,
    custodyRecord,
    sourceOperation,
    preparation,
    fence,
    nowMs,
  )
  assertExactAuthorizationProofs(successors.authorization ?? [], operation)
  if (alreadyApplied) {
    const current = readDaemonProofOperationFromDatabase(database, source.operationId)
    if (current?.state !== 'completed') {
      throw new Error('daemon mixed range source committed target is missing')
    }
    return { authorization: successors.authorization!.map(toProof) }
  }
  const offeredInputCount = sourceOperation.metadata!.offeredInputCount as number
  const collateralInputCount = sourceOperation.metadata!.collateralInputCount as number
  completeCtfConsolidationTargetFromDatabase(database, {
    operationId: source.operationId,
    resultProofs: {
      'offered-change': successors['offered-change']!,
      'collateral-change': successors['collateral-change']!,
    },
    inputAssets: [
      ...Array.from({ length: offeredInputCount }, () => mixedConditionalAsset(preparation)),
      ...Array.from({ length: collateralInputCount }, () => mixedCollateralAsset(preparation)),
    ],
    successorAssets: {
      'offered-change': mixedConditionalAsset(preparation),
      'collateral-change': mixedCollateralAsset(preparation),
    },
    nowMs,
  })
  return { authorization: successors.authorization!.map(toProof) }
}

function assertMixedSourceAuthority(
  source: ProofOperationRecord,
  operation: DurableCtfRangeOperation,
  preparation: PersistedCtfRangeOrderPreparation,
): DurableCustodyProofOperationInput {
  if (
    source.operationId !== operation.sourceOperationId ||
    (source.state !== 'prepared' && source.state !== 'completed') ||
    source.kind !== 'conditional-keyset-swap' ||
    source.mintUrl !== operation.mintUrl ||
    source.metadata.purpose !== SOURCE_PURPOSE ||
    source.metadata.rangeOperationId !== operation.operationId ||
    source.metadata.unit !== operation.unit ||
    source.metadata.endpoint !== 'POST /v1/ctf/convert'
  ) {
    throw new Error('daemon mixed CTF range source operation authority is invalid')
  }
  assertMixedOuterOperation(operation, preparation)
  const sourceOperation = validateCtfRangeMixedSourceOperation(
    source.metadata.exactSourceOperation,
    preparation,
  )
  if (
    sourceOperation.operationId !== source.operationId ||
    sourceOperation.metadata?.sourceMode !== source.metadata.sourceMode ||
    sourceOperation.metadata?.endpoint !== source.metadata.endpoint ||
    !sameProofGroups(source.inputs, sourceOperation.inputs) ||
    !samePersistedMixedOutputs(source.outputs, storedSourceOutputs(sourceOperation))
  ) {
    throw new Error('daemon mixed CTF range source input or output authority differs')
  }
  return sourceOperation
}

function assertMixedOuterOperation(
  operation: DurableCtfRangeOperation,
  preparation: PersistedCtfRangeOrderPreparation,
): void {
  const conditional = mixedConditionalAsset(preparation)
  if (
    preparation.side !== 'Sell' ||
    operation.operationId !== preparation.operationId ||
    operation.sourceOperationId !== preparation.sourceOperationId ||
    operation.mintUrl !== preparation.mintUrl ||
    operation.unit !== 'msat' ||
    operation.conditionId !== preparation.conditionId ||
    operation.offerKeysetId !== preparation.offerKeyset.id ||
    operation.receiveKeysetId !== preparation.receiveKeyset.id ||
    operation.offerAsset.kind !== 'conditional' ||
    operation.offerAsset.conditionId !== conditional.conditionId ||
    operation.offerAsset.outcomeCollection !== conditional.outcomeSetId ||
    operation.receiveAsset.kind !== 'regular'
  ) {
    throw new Error('daemon mixed CTF range source does not match outer preparation')
  }
}

function sameProofGroups(
  target: readonly ComparableProof[],
  source: readonly ComparableProof[],
): boolean {
  return (
    target.length === source.length &&
    target.every((proof, index) => sameProof(proof, source[index]!))
  )
}

/**
 * Convert exact source outputs to the stored form of a daemon target proof
 * operation. Exact output restore decodes target outputs in this form.
 */
export function storedSourceOutputs(
  operation: DurableCustodyProofOperationInput,
): Record<string, StoredOutputData[]> {
  return Object.fromEntries(
    Object.entries(operation.outputs).map(([label, outputs]) => [
      label,
      serializeOutputDataArray(outputs.map(deserializeDurableCustodyOutput)),
    ]),
  )
}

function samePersistedMixedOutputs(
  target: Readonly<
    Record<
      string,
      readonly {
        readonly blindedMessage: {
          readonly amount: unknown
          readonly id: string
          readonly B_: string
        }
        readonly blindingFactor: string
        readonly secret: string
        readonly ephemeralE?: string
      }[]
    >
  >,
  source: DurableCustodyProofOperationInput['outputs'],
): boolean {
  const groups = ['authorization', 'offered-change', 'collateral-change']
  if (Object.keys(target).sort().join('\0') !== [...groups].sort().join('\0')) return false
  return groups.every((group) => {
    const targetOutputs = target[group]!
    const sourceOutputs = source[group]!
    return (
      targetOutputs.length === sourceOutputs.length &&
      targetOutputs.every((output, index) => {
        const expected = sourceOutputs[index]!
        return (
          amountToNumber(output.blindedMessage.amount) ===
            amountToNumber(expected.blindedMessage.amount) &&
          output.blindedMessage.id === expected.blindedMessage.id &&
          output.blindedMessage.B_ === expected.blindedMessage.B_ &&
          output.blindingFactor === expected.blindingFactor &&
          output.secret === expected.secret &&
          (output.ephemeralE ?? null) === (expected.ephemeralE ?? null)
        )
      })
    )
  })
}

function applyMixedRangePreparationSuccessors(
  database: DatabaseSync,
  record: DurableCustodyRecord,
  sourceOperation: DurableCustodyProofOperationInput,
  preparation: PersistedCtfRangeOrderPreparation,
  fence: CustodyScopeFence,
  nowMs: number,
): Record<string, CashuProofRecord[]> {
  if (
    record === null ||
    record.scope.scopeId !== fence.scopeId ||
    record.operation.semanticKind !== 'ctf-range-conditional-source' ||
    record.operation.result.exactResult === null
  ) {
    throw new Error('daemon mixed range source verified result is missing or foreign')
  }
  const store = new DurableCustodySqliteStore(database)
  const exactAuthority = sourceArtifact(
    store,
    record,
    record.operation.privateMaterial.exactPrivateMaterial,
  )
  const authority = assertDurableCustodyMintOperationAuthority(record, exactAuthority)
  const custodySourceOperation = validateCtfRangeMixedSourceOperation(
    authority.operation,
    preparation,
  )
  if (
    custodySourceOperation.operationId !== sourceOperation.operationId ||
    custodySourceOperation.kind !== sourceOperation.kind ||
    custodySourceOperation.mintUrl !== sourceOperation.mintUrl ||
    !sameProofGroups(custodySourceOperation.inputs, sourceOperation.inputs) ||
    !samePersistedMixedOutputs(custodySourceOperation.outputs, sourceOperation.outputs)
  ) {
    throw new Error('daemon mixed range source custody operation differs')
  }
  const prepared = readDurableCustodyVerifiedMintResult({
    record,
    exactAuthority,
    exactResult: sourceArtifact(store, record, record.operation.result.exactResult),
  })
  const result = mixedSourceResultFromPrepared(prepared)
  const locators = ctfRangeMixedSourceChangeDerivationLocators(sourceOperation, preparation, {
    offeredChange: result.offeredChange,
    collateralChange: result.collateralChange,
  })
  if (
    locators.offeredChange.length !== result.offeredChange.length ||
    locators.collateralChange.length !== result.collateralChange.length
  ) {
    throw new Error('daemon mixed range source change derivation is incomplete')
  }
  return applyVerifiedRangePreparationSuccessors(
    database,
    record,
    prepared,
    {
      authorization: mixedConditionalAsset(preparation),
      'offered-change': mixedConditionalAsset(preparation),
      'collateral-change': mixedCollateralAsset(preparation),
    },
    ['authorization', 'offered-change', 'collateral-change'],
    fence,
    nowMs,
  )
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

function mixedConditionalAsset(
  preparation: PersistedCtfRangeOrderPreparation,
): Extract<StoredProofAsset, { kind: 'Outcome' }> {
  const keyset = preparation.offerKeyset
  if (
    preparation.side !== 'Sell' ||
    !('conditionId' in keyset) ||
    !('outcomeCollection' in keyset) ||
    typeof keyset.outcomeCollection !== 'string' ||
    keyset.conditionId !== preparation.conditionId ||
    keyset.canonicalMintUrl !== preparation.mintUrl
  ) {
    throw new Error('daemon mixed range offered asset authority is invalid')
  }
  return {
    kind: 'Outcome',
    conditionId: keyset.conditionId,
    outcomeSetId: keyset.outcomeCollection,
    baseAsset: 'sat',
    unit: 'msat',
  }
}

function mixedCollateralAsset(preparation: PersistedCtfRangeOrderPreparation): StoredProofAsset {
  const keyset = preparation.receiveKeyset
  if (
    preparation.side !== 'Sell' ||
    'conditionId' in keyset ||
    keyset.canonicalMintUrl !== preparation.mintUrl
  ) {
    throw new Error('daemon mixed range collateral asset authority is invalid')
  }
  return { kind: 'sats', baseAsset: 'sat', unit: 'msat' }
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
