import Dexie from "dexie";
import {
  assertDurableCustodyArtifactMatchesReference,
  classifyDurableCustodyActiveWork,
  decodeDurableCustodyRecord,
  deriveDurableCustodyOperationId,
  type DurableCustodyRecord,
} from "@bitcaster/client-sdk/durableCustody";
import { DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX } from "@bitcaster/client-sdk/durableCustodyProofImport";
import type { BrowserCustodyProofRow } from "../stores/durable-custody-types";
import type { BitcasterDB } from "../stores/proof-db";

interface ReimportCleanupInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly sourceOperationId: string;
  readonly admitted: readonly {
    readonly proof: BrowserCustodyProofRow;
    readonly operationId: string | null;
  }[];
}

/** Call after remote-origin replacement in the transaction that admitted these proofs. */
export async function retireBrowserEncryptedWalletBackupV2ReimportJournals(
  input: ReimportCleanupInput,
): Promise<void> {
  const transaction = Dexie.currentTransaction;
  if (transaction?.db !== input.database || transaction.mode !== "readwrite") {
    throw new Error("browser V2 reimport cleanup requires the admission transaction");
  }
  const pageSize = DURABLE_CUSTODY_PROOF_IMPORT_PAGE_PROOF_LIMIT_MAX;
  for (let offset = 0; offset < input.admitted.length; offset += pageSize) {
    const page = input.admitted.slice(offset, offset + pageSize);
    const source =
      offset === 0
        ? input.sourceOperationId
        : `${input.sourceOperationId}:page:${offset / pageSize}`;
    const operationId = deriveDurableCustodyOperationId(input.scopeId, {
      retainedOperationKey: `completed-proof-import:${source}`,
      binding: { kind: "wallet", stage: "receive", activityId: source },
    });
    // The captured IDs must identify this exact batch, including each bounded page.
    if (page.some((entry) => entry.operationId !== operationId)) continue;
    if (!(await isRedundantPage(input, page, source, operationId))) continue;
    if (!(await hasNoRetainedReferences(input.database, input.scopeId, operationId))) continue;
    await input.database.custodyArtifacts
      .where("[scopeId+operationId]")
      .equals([input.scopeId, operationId])
      .delete();
    await input.database.custodyOperations.delete([input.scopeId, operationId]);
  }
}

async function isRedundantPage(
  input: ReimportCleanupInput,
  page: ReimportCleanupInput["admitted"],
  source: string,
  operationId: string,
): Promise<boolean> {
  const row = await input.database.custodyOperations.get([input.scopeId, operationId]);
  if (row === undefined || row.scopeId !== input.scopeId || row.operationId !== operationId)
    return false;
  const record = decodeDurableCustodyRecord(row.record);
  const operation = record.operation;
  if (
    record.scope.scopeId !== input.scopeId ||
    operation.operationId !== operationId ||
    row.revision !== record.revision ||
    row.operationState !== operation.state ||
    row.nextAttemptAtMs !== operation.retry.nextAttemptAtMs ||
    operation.state !== "reconciled" ||
    operation.semanticKind !== "generic-receive" ||
    operation.binding.kind !== "wallet" ||
    operation.binding.stage !== "receive" ||
    operation.binding.activityId !== source ||
    operation.exactRequest.idempotencyKey !== source ||
    operation.terminalReplayEvidenceRequired ||
    operation.reservation.inputs.length !== 0 ||
    operation.exactRequest.inputProofIds.length !== 0 ||
    operation.result.state !== "applied" ||
    classifyDurableCustodyActiveWork(record) !== "none" ||
    !hasExactSuccessorAdmission(record, page)
  )
    return false;
  return await hasExactProofMaterial(input.database, record, page);
}

function hasExactSuccessorAdmission(
  record: DurableCustodyRecord,
  page: ReimportCleanupInput["admitted"],
): boolean {
  const operation = record.operation;
  const operationId = operation.operationId;
  const lineage = operation.proofStorage.lineage;
  const admission = lineage.successorAdmission;
  if (
    lineage.predecessorProofIds.length !== 0 ||
    admission === null ||
    admission.scopeId !== record.scope.scopeId ||
    admission.operationId !== operationId ||
    admission.proofRows.length !== page.length ||
    !sameProofIds(lineage.successorProofIds, page) ||
    lineage.selectedSuccessorProofIds === null ||
    !sameProofIds(lineage.selectedSuccessorProofIds, page) ||
    page.some(({ proof }, index) => {
      const admitted = admission.proofRows[index];
      return (
        proof.scopeId !== record.scope.scopeId ||
        proof.normalizedMint !== operation.custodyContext.normalizedMint ||
        proof.unit !== operation.custodyContext.unit ||
        proof.selectability !== "selectable" ||
        proof.reservationOperationId !== null ||
        admitted?.proofId !== proof.proofId ||
        admitted.expectedRevision !== null ||
        admitted.admittedRevision !== proof.revision
      );
    })
  )
    return false;
  return true;
}

async function hasExactProofMaterial(
  database: BitcasterDB,
  record: DurableCustodyRecord,
  page: ReimportCleanupInput["admitted"],
): Promise<boolean> {
  const operation = record.operation;
  const operationId = operation.operationId;
  const reference = operation.outputPlan.exactOutput;
  const artifact = await database.custodyArtifacts.get([
    record.scope.scopeId,
    operationId,
    reference.artifactId,
  ]);
  if (
    artifact === undefined ||
    artifact.scopeId !== record.scope.scopeId ||
    artifact.operationId !== operationId ||
    artifact.artifactId !== reference.artifactId
  )
    return false;
  assertDurableCustodyArtifactMatchesReference(reference, artifact.artifact);
  const output = artifact.artifact.artifact as { proofs?: unknown };
  return (
    Array.isArray(output?.proofs) &&
    output.proofs.length === page.length &&
    output.proofs.every((entry: unknown, index: number) => {
      if (typeof entry !== "object" || entry === null) return false;
      const material = entry as { proofId?: unknown; proofFingerprint?: unknown };
      return (
        material.proofId === page[index]!.proof.proofId &&
        material.proofFingerprint === page[index]!.proof.proofFingerprint
      );
    })
  );
}

function sameProofIds(ids: readonly string[], page: ReimportCleanupInput["admitted"]): boolean {
  return (
    ids.length === page.length &&
    new Set(ids).size === ids.length &&
    ids.every((id, index) => id === page[index]!.proof.proofId)
  );
}

async function hasNoRetainedReferences(
  database: BitcasterDB,
  scopeId: string,
  operationId: string,
): Promise<boolean> {
  const [activeWork, reservation, authority] = await Promise.all([
    database.custodyActiveWork.get([scopeId, operationId]),
    database.custodyReservations
      .where("[scopeId+operationId]")
      .equals([scopeId, operationId])
      .first(),
    database.custodyProofBackupAuthorities
      .where("[scopeId+admissionOperationId]")
      .equals([scopeId, operationId])
      .first(),
  ]);
  return activeWork === undefined && reservation === undefined && authority === undefined;
}
