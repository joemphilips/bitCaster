import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import {
  readVerifiedCtfLosingOutcomeEvidence,
  readAuthenticatedCtfRedeemTerminalEvidence,
} from '@bitcaster-market/client-sdk/ctfRedeem'
import {
  deriveDurableCustodyProofId,
  DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
} from '@bitcaster-market/client-sdk/durableCustody'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import { createDurableCustodyProofMaterialRecord } from '@bitcaster-market/client-sdk/durableCustodyProofMaterial'
import type { DaemonProfile } from './profile.ts'
import { profileDir } from './profile.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { WalletClaimPositionParams, WalletRemovePreview } from './protocol.ts'
import {
  createDaemonStateSqliteSession,
  type StateSqliteTransactionOptions,
} from './stateSqlite.ts'
import {
  withDurableCustodyFencedRead,
  withDurableCustodyUnitOfWork,
} from './durableCustodyUnitOfWork.ts'
import {
  readDaemonProofOperationFromDatabase,
  readDaemonWalletProofFromDatabase,
  POSITION_CLAIM_PURPOSE,
} from './state.ts'

interface RemoveContext {
  readonly profile: DaemonProfile
  readonly fence: CustodyScopeFence
  readonly isCustodyReady: () => boolean
}

type Target = WalletRemovePreview['targets'][number]
type Row = Record<string, unknown>
const HASH = /^[0-9a-f]{64}$/

/** Local retirement keeps full history. No mint or monitoring client is accepted. */
export async function previewDaemonPositionRemove(
  input: RemoveContext & WalletClaimPositionParams,
): Promise<WalletRemovePreview> {
  validatePosition(input)
  const session = createDaemonStateSqliteSession(profileDir())
  const preview = await withDurableCustodyFencedRead(
    session,
    input.fence,
    Date.now(),
    (database) => {
      requireReady(input)
      const targets: Target[] = []
      const operations = new Set<string>()
      let bytes = 0
      // Only metadata is read until the page budget permits loading exact artifacts.
      for (const candidate of database
        .prepare(
          `SELECT proof.proof_id, length(proof.proof_body) AS proof_bytes,
      proof.reserved_by, proof.normalized_mint, proof.unit, proof.keyset_id, proof.secret,
      length(proof.secret) + length(proof.normalized_mint) + length(proof.signature) + length(proof.condition_id) + length(proof.outcome_set_id) + coalesce(length(proof.reserved_by), 0) + 512 AS metadata_bytes,
      coalesce(length(operation.operation_id), 0) + coalesce(length(operation.reservation_id), 0) + coalesce(length(operation.last_error), 0) + coalesce(length(operation.normalized_mint), 0) + 512 AS operation_metadata_bytes,
      coalesce(length(request.body), 0) + coalesce(length(outputs.body), 0) AS operation_bytes
      FROM target_wallet_proofs AS proof
      LEFT JOIN target_proof_operations AS operation ON operation.scope_id = proof.scope_id AND operation.operation_id = proof.reserved_by
      LEFT JOIN custody_artifacts AS request ON request.scope_id = operation.scope_id AND request.artifact_id = operation.request_artifact_id
      LEFT JOIN custody_artifacts AS outputs ON outputs.scope_id = operation.scope_id AND outputs.artifact_id = operation.output_artifact_id
      WHERE proof.scope_id = ? AND proof.normalized_mint = ? AND proof.condition_id = ? AND proof.outcome_set_id = ?
        AND proof.asset_kind = 'outcome' AND proof.unit = 'msat' AND proof.retired_at_ms IS NULL
      ORDER BY proof.proof_id LIMIT ?`,
        )
        .iterate(
          input.fence.scopeId,
          input.profile.mintUrl,
          input.conditionId,
          input.outcomeCollection,
          DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
        )) {
        const operationId = String(candidate.reserved_by)
        const custodyId = deriveDurableCustodyProofId({
          scopeId: input.fence.scopeId,
          normalizedMint: String(candidate.normalized_mint),
          unit: String(candidate.unit),
          keysetId: String(candidate.keyset_id),
          secret: String(candidate.secret),
        })
        const canonicalBytes = Number(
          (
            database
              .prepare(
                'SELECT length(proof_body) + 65536 AS bytes FROM custody_proofs WHERE scope_id = ? AND proof_id = ?',
              )
              .get(input.fence.scopeId, custodyId) as { bytes: number } | undefined
          )?.bytes ?? 0,
        )
        const estimated =
          Number(candidate.proof_bytes) +
          Number(candidate.metadata_bytes) +
          canonicalBytes +
          4096 +
          operationId.length +
          (operations.has(operationId)
            ? 0
            : Number(candidate.operation_bytes) + Number(candidate.operation_metadata_bytes) + 2048)
        if (bytes + estimated > DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX) {
          if (targets.length === 0)
            throw new Error('removal target exceeds the bounded artifact page')
          break
        }
        const target = captureTarget(database, input, String(candidate.proof_id))
        bytes += estimated
        operations.add(operationId)
        targets.push(target)
      }
      const value: WalletRemovePreview = {
        version: 1,
        scopeId: input.fence.scopeId,
        mintUrl: input.profile.mintUrl,
        conditionId: input.conditionId,
        outcomeCollection: input.outcomeCollection,
        targets,
        batchDigest: '',
        moreProofsRemain: hasOtherProofs(
          database,
          input,
          targets.map((target) => target.proofId),
        ),
      }
      value.batchDigest = previewDigest(value)
      return value
    },
  )
  await verifyTargets(input, preview)
  return preview
}

export async function removeDaemonPosition(
  input: RemoveContext & {
    readonly preview: WalletRemovePreview
    readonly acknowledge: true
    readonly transactionOptions?: StateSqliteTransactionOptions
  },
): Promise<{
  state: 'completed'
  retiredProofCount: number
  operationIds: string[]
  moreProofsRemain: boolean
}> {
  validatePreview(input)
  const evidence = await verifyTargets(input, input.preview)
  return withDurableCustodyUnitOfWork(
    profileDir(),
    input.fence,
    Date.now(),
    (database) => {
      requireReady(input)
      assertBatchBytes(database, input, input.preview)
      // Check every target before the first mutation. Retrying this manifest never discovers replacements.
      for (const target of input.preview.targets) {
        const current = captureTarget(
          database,
          previewPosition(input, input.preview),
          target.proofId,
          true,
        )
        if (!isDeepStrictEqual(current, target)) throw new Error('removal preview changed')
        const sealed = readAuthenticatedCtfRedeemTerminalEvidence(evidence.get(target.proofId)!)
        if (
          sealed.operationId !== target.operationId ||
          sealed.normalizedMint !== input.profile.mintUrl
        )
          throw new Error('removal terminal evidence is foreign')
      }
      for (const target of input.preview.targets) {
        const custodyId = canonicalId(database, input, target.proofId)
        const result = database
          .prepare(
            `UPDATE target_wallet_proofs SET retired_by_operation_id = ?, retired_at_ms = ?, retired_custody_proof_id = ?
        WHERE scope_id = ? AND proof_id = ? AND retired_at_ms IS NULL AND state = 'locked' AND reserved_by = ?`,
          )
          .run(
            target.operationId,
            Date.now(),
            custodyId,
            input.fence.scopeId,
            target.proofId,
            target.operationId,
          )
        if (result.changes === 0) {
          const row = nativeRow(database, input.fence.scopeId, target.proofId)
          if (
            row.retired_by_operation_id !== target.operationId ||
            row.retired_custody_proof_id !== custodyId
          )
            throw new Error('retirement marker is foreign')
        }
      }
      return {
        state: 'completed' as const,
        retiredProofCount: input.preview.targets.length,
        operationIds: [...new Set(input.preview.targets.map((target) => target.operationId))],
        moreProofsRemain: hasOtherProofs(database, previewPosition(input, input.preview), []),
      }
    },
    input.transactionOptions,
  )
}

async function verifyTargets(input: RemoveContext, preview: WalletRemovePreview) {
  const evidence = new Map<
    string,
    Awaited<ReturnType<typeof readVerifiedCtfLosingOutcomeEvidence>>
  >()
  const session = createDaemonStateSqliteSession(profileDir())
  await withDurableCustodyFencedRead(session, input.fence, Date.now(), (database) => {
    requireReady(input)
    assertBatchBytes(database, input, preview)
  })
  for (const target of preview.targets) {
    const sealed = await readVerifiedCtfLosingOutcomeEvidence({
      operationId: target.operationId,
      proof: await withDurableCustodyFencedRead(session, input.fence, Date.now(), (database) => {
        const proof = readDaemonWalletProofFromDatabase(database, target.proofId)
        if (proof === null || typeof proof.proof.id !== 'string')
          throw new Error('removal proof is missing')
        return { id: proof.proof.id, secret: proof.proof.secret }
      }),
      store: {
        withCommittedProofOperation: async (operationId, callback) =>
          withDurableCustodyFencedRead(session, input.fence, Date.now(), (database) => {
            captureTarget(database, previewPosition(input, preview), target.proofId, true)
            const operation = readDaemonProofOperationFromDatabase(database, operationId)
            if (operation === null) throw new Error('removal operation is missing')
            return callback(operation as Parameters<typeof callback>[0])
          }),
      },
    })
    evidence.set(target.proofId, sealed)
  }
  return evidence
}

function captureTarget(
  database: DatabaseSync,
  input: RemoveContext & WalletClaimPositionParams,
  proofId: string,
  allowRetired = false,
): Target {
  const row = nativeRow(database, input.fence.scopeId, proofId)
  const proof = readDaemonWalletProofFromDatabase(database, proofId)!
  const operationId = proof.reservedBy
  if (
    proof.mintUrl !== input.profile.mintUrl ||
    proof.asset.kind !== 'Outcome' ||
    proof.asset.conditionId !== input.conditionId ||
    proof.asset.outcomeSetId !== input.outcomeCollection ||
    proof.state !== 'locked' ||
    typeof operationId !== 'string' ||
    (!allowRetired && proof.retirement !== undefined)
  )
    throw new Error('removal target is not an exact losing proof')
  const operation = readDaemonProofOperationFromDatabase(database, operationId)
  if (
    operation === null ||
    operation.kind !== 'ctf-redeem' ||
    operation.state !== 'Failed' ||
    operation.failureCode !== 13015 ||
    operation.mintUrl !== proof.mintUrl ||
    operation.metadata.purpose !== POSITION_CLAIM_PURPOSE ||
    operation.metadata.reservationId !== operationId ||
    operation.metadata.conditionId !== input.conditionId ||
    operation.metadata.outcomeSetId !== input.outcomeCollection ||
    operation.inputs.filter(
      (candidate) =>
        candidate.id === proof.proof.id &&
        candidate.secret === proof.proof.secret &&
        candidate.C === proof.proof.C &&
        amountToNumber(candidate.amount) === amountToNumber(proof.proof.amount),
    ).length !== 1
  )
    throw new Error('removal lacks exact terminal operation authority')
  const custodyId = canonicalId(database, input, proofId)
  const canonical = canonicalRow(database, input.fence.scopeId, custodyId)
  if (
    canonical !== undefined &&
    (canonical.normalized_mint !== proof.mintUrl ||
      canonical.condition_id !== input.conditionId ||
      canonical.outcome_set_id !== input.outcomeCollection ||
      canonical.unit !== 'msat' ||
      canonical.nut07_state !== 'UNSPENT' ||
      canonical.reservation_operation_id !== null ||
      (canonical.selectability !== 'selectable' && canonical.selectability !== 'retained'))
  ) {
    throw new Error('removal canonical authority is reserved or uncertain')
  }
  if (canonical !== undefined) {
    const material = createDurableCustodyProofMaterialRecord({
      scopeId: input.fence.scopeId,
      normalizedMint: proof.mintUrl,
      unit: proof.asset.unit,
      proof: {
        id: proof.proof.id!,
        amount: amountToNumber(proof.proof.amount),
        secret: proof.proof.secret,
        C: proof.proof.C,
        dleq: proof.proof.dleq ?? null,
        p2pkE: proof.proof.p2pk_e ?? null,
        witness: proof.proof.witness ?? null,
      },
    })
    if (
      canonical.proof_fingerprint !== material.proofFingerprint ||
      !Buffer.from(canonical.proof_body as Uint8Array).equals(material.proofBody)
    ) {
      throw new Error('removal canonical proof body is foreign')
    }
  }
  assertNoDependentWork(database, input.fence.scopeId, custodyId, operationId)
  if (
    database
      .prepare(
        `SELECT 1 FROM target_proof_operations AS operation
    JOIN custody_artifacts AS request ON request.scope_id = operation.scope_id AND request.artifact_id = operation.request_artifact_id
    WHERE operation.scope_id = ? AND operation.normalized_mint = ? AND operation.state = 'prepared'
      AND EXISTS (SELECT 1 FROM json_each(CAST(request.body AS TEXT), '$.inputs') AS input
        WHERE json_extract(input.value, '$.id') = ? AND json_extract(input.value, '$.secret') = ?) LIMIT 1`,
      )
      .get(input.fence.scopeId, proof.mintUrl, proof.proof.id!, proof.proof.secret) !== undefined
  )
    throw new Error('removal target has pending native work')
  return {
    proofId,
    keysetId: proof.proof.id!,
    amountSubunits: amountToNumber(proof.proof.amount),
    proofSnapshot: rowDigest(row, true),
    operationId,
    operationSnapshot: digest(operation),
    canonicalSnapshot: canonical === undefined ? null : rowDigest(canonical),
  }
}

function assertNoDependentWork(
  database: DatabaseSync,
  scopeId: string,
  proofId: string,
  operationId: string,
): void {
  const blocked = database
    .prepare(
      `SELECT 1 FROM custody_proof_reservations WHERE scope_id = ? AND proof_id = ?
    UNION ALL SELECT 1 FROM order_collateral_proofs AS proof JOIN order_collateral_pins AS pin ON pin.scope_id = proof.scope_id AND pin.pin_id = proof.pin_id
      WHERE proof.scope_id = ? AND proof.proof_id = ? AND pin.pin_state = 'active'
    UNION ALL SELECT 1 FROM custody_operation_inputs AS input JOIN custody_operations AS operation ON operation.scope_id = input.scope_id AND operation.operation_id = input.operation_id
      WHERE input.scope_id = ? AND input.proof_id = ? AND (operation.operation_state IN ('dispatch-intent', 'transport-attempted') OR
        EXISTS (SELECT 1 FROM custody_active_work AS work WHERE work.scope_id = input.scope_id AND work.operation_id = input.operation_id) OR
        EXISTS (SELECT 1 FROM custody_wallet_receive_active_work AS work WHERE work.scope_id = input.scope_id AND work.operation_id = input.operation_id) OR
        EXISTS (SELECT 1 FROM custody_deliveries AS delivery WHERE delivery.scope_id = input.scope_id AND delivery.operation_id = input.operation_id AND delivery.state = 'pending'))
    UNION ALL SELECT 1 FROM custody_proof_lineage AS lineage WHERE lineage.scope_id = ? AND lineage.proof_id = ? AND (
      EXISTS (SELECT 1 FROM custody_operation_pins AS pin WHERE pin.scope_id = lineage.scope_id AND pin.operation_id = lineage.operation_id
        AND pin.pin_reason IN ('active-reservation', 'pending-outbox', 'active-retry-cursor')) OR
      EXISTS (SELECT 1 FROM custody_active_work AS work WHERE work.scope_id = lineage.scope_id AND work.operation_id = lineage.operation_id) OR
      EXISTS (SELECT 1 FROM custody_wallet_receive_active_work AS work WHERE work.scope_id = lineage.scope_id AND work.operation_id = lineage.operation_id) OR
      EXISTS (SELECT 1 FROM custody_deliveries AS delivery WHERE delivery.scope_id = lineage.scope_id AND delivery.operation_id = lineage.operation_id AND delivery.state = 'pending'))
    UNION ALL SELECT 1 FROM target_wallet_proofs WHERE scope_id = ? AND reserved_by = ? AND state = 'reserved' LIMIT 1`,
    )
    .get(
      scopeId,
      proofId,
      scopeId,
      proofId,
      scopeId,
      proofId,
      scopeId,
      proofId,
      scopeId,
      operationId,
    )
  if (blocked !== undefined) throw new Error('removal target has dependent custody work')
}

function assertBatchBytes(
  database: DatabaseSync,
  input: RemoveContext,
  preview: WalletRemovePreview,
): void {
  let bytes = Buffer.byteLength(JSON.stringify(preview))
  const operations = new Set<string>()
  for (const target of preview.targets) {
    const metadata = database
      .prepare(
        `SELECT length(proof_body) + length(secret) + length(signature) + length(outcome_set_id) + length(reserved_by) + 1024 AS bytes,
      normalized_mint, unit, keyset_id, secret FROM target_wallet_proofs WHERE scope_id = ? AND proof_id = ?`,
      )
      .get(input.fence.scopeId, target.proofId) as Row | undefined
    if (metadata === undefined) throw new Error('removal target is missing')
    bytes += Number(metadata.bytes)
    const custodyId = deriveDurableCustodyProofId({
      scopeId: input.fence.scopeId,
      normalizedMint: String(metadata.normalized_mint),
      unit: String(metadata.unit),
      keysetId: String(metadata.keyset_id),
      secret: String(metadata.secret),
    })
    bytes += Number(
      (
        database
          .prepare(
            'SELECT length(proof_body) + 65536 AS bytes FROM custody_proofs WHERE scope_id = ? AND proof_id = ?',
          )
          .get(input.fence.scopeId, custodyId) as { bytes: number } | undefined
      )?.bytes ?? 0,
    )
    if (!operations.has(target.operationId)) {
      const operation = database
        .prepare(
          `SELECT length(request.body) + length(outputs.body) + length(operation.operation_id) + coalesce(length(operation.reservation_id), 0) + 2048 AS bytes
        FROM target_proof_operations AS operation JOIN custody_artifacts AS request ON request.scope_id = operation.scope_id AND request.artifact_id = operation.request_artifact_id
        JOIN custody_artifacts AS outputs ON outputs.scope_id = operation.scope_id AND outputs.artifact_id = operation.output_artifact_id
        WHERE operation.scope_id = ? AND operation.operation_id = ? AND operation.state = 'failed' AND operation.failure_code = 13015`,
        )
        .get(input.fence.scopeId, target.operationId) as { bytes: number } | undefined
      if (operation === undefined) throw new Error('removal lacks bounded terminal evidence')
      bytes += operation.bytes
      operations.add(target.operationId)
    }
    if (bytes > DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX)
      throw new Error('removal batch exceeds the bounded artifact page')
  }
}

function canonicalId(database: DatabaseSync, input: RemoveContext, proofId: string): string {
  const proof = readDaemonWalletProofFromDatabase(database, proofId)
  if (proof === null || proof.proof.id === undefined) throw new Error('removal proof is missing')
  return deriveDurableCustodyProofId({
    scopeId: input.fence.scopeId,
    normalizedMint: proof.mintUrl,
    unit: proof.asset.unit,
    keysetId: proof.proof.id,
    secret: proof.proof.secret,
  })
}
function previewPosition(
  input: RemoveContext,
  preview: WalletRemovePreview,
): RemoveContext & WalletClaimPositionParams {
  return {
    profile: input.profile,
    fence: input.fence,
    isCustodyReady: input.isCustodyReady,
    conditionId: preview.conditionId,
    outcomeCollection: preview.outcomeCollection,
  }
}
function canonicalRow(database: DatabaseSync, scopeId: string, proofId: string): Row | undefined {
  return database
    .prepare('SELECT * FROM custody_proofs WHERE scope_id = ? AND proof_id = ?')
    .get(scopeId, proofId) as Row | undefined
}
function nativeRow(database: DatabaseSync, scopeId: string, proofId: string): Row {
  const row = database
    .prepare('SELECT * FROM target_wallet_proofs WHERE scope_id = ? AND proof_id = ?')
    .get(scopeId, proofId) as Row | undefined
  if (row === undefined) throw new Error('removal target is missing')
  return row
}
function rowDigest(row: Row, native = false): string {
  const {
    proof_body,
    retired_by_operation_id,
    retired_at_ms,
    retired_custody_proof_id,
    ...metadata
  } = row
  const hash = createHash('sha256')
    .update(proof_body as Uint8Array)
    .update(JSON.stringify(metadata))
  if (!native)
    hash.update(JSON.stringify([retired_by_operation_id, retired_at_ms, retired_custody_proof_id]))
  return hash.digest('hex')
}
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
function previewDigest(preview: WalletRemovePreview): string {
  return digest({ ...preview, batchDigest: '' })
}
function requireReady(input: RemoveContext): void {
  if (!input.isCustodyReady()) throw new Error('new custody writes are not permitted')
}
function validatePosition(input: WalletClaimPositionParams): void {
  if (
    !HASH.test(input.conditionId) ||
    typeof input.outcomeCollection !== 'string' ||
    input.outcomeCollection.length < 1 ||
    input.outcomeCollection.length > 16384 ||
    input.outcomeCollection.split('|').some((part) => part.length === 0 || part.trim() !== part) ||
    new Set(input.outcomeCollection.split('|')).size !== input.outcomeCollection.split('|').length
  )
    throw new Error('removal position is invalid')
}
function validatePreview(
  input: RemoveContext & { preview: WalletRemovePreview; acknowledge: true },
): void {
  const preview = input.preview
  validatePosition(preview)
  if (
    input.acknowledge !== true ||
    preview.version !== 1 ||
    preview.scopeId !== input.fence.scopeId ||
    preview.mintUrl !== input.profile.mintUrl ||
    !Array.isArray(preview.targets) ||
    preview.targets.length < 1 ||
    preview.targets.length > DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX ||
    Buffer.byteLength(JSON.stringify(preview)) > DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX ||
    preview.batchDigest !== previewDigest(preview) ||
    new Set(preview.targets.map((target) => target.proofId)).size !== preview.targets.length ||
    preview.targets.some(
      (target) =>
        !HASH.test(target.proofId) ||
        !HASH.test(target.proofSnapshot) ||
        !HASH.test(target.operationSnapshot) ||
        (target.canonicalSnapshot !== null && !HASH.test(target.canonicalSnapshot)),
    )
  )
    throw new Error('exact removal acknowledgement is invalid')
}
function hasOtherProofs(
  database: DatabaseSync,
  input: RemoveContext & WalletClaimPositionParams,
  excluded: string[],
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 FROM target_wallet_proofs WHERE scope_id = ? AND normalized_mint = ? AND condition_id = ? AND outcome_set_id = ?
    AND retired_at_ms IS NULL ${excluded.length === 0 ? '' : `AND proof_id NOT IN (${excluded.map(() => '?').join(',')})`} LIMIT 1`,
      )
      .get(
        input.fence.scopeId,
        input.profile.mintUrl,
        input.conditionId,
        input.outcomeCollection,
        ...excluded,
      ) !== undefined
  )
}
