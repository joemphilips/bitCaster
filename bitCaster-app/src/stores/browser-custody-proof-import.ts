import {
  applyDurableCustodyProofImport,
  bindDurableCustodyProofImport,
  stageDurableCustodyProofImport,
  type PreparedDurableCustodyProofImport,
} from "@bitcaster/client-sdk/durableCustodyProofImport";
import type {
  DurableCustodyOwnerAuthorization,
  DurableCustodyScope,
  DurableCustodySuccessorAdmissionEvidence,
} from "@bitcaster/client-sdk/durableCustody";
import { BrowserDurableCustodyAdapter } from "./durable-custody-db";
import type { BrowserCustodyProofRow } from "./durable-custody-types";
import { db, type BitcasterDB } from "./proof-db";

export interface BrowserCustodyProofImportInput {
  readonly scope: DurableCustodyScope;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly prepared: PreparedDurableCustodyProofImport;
  readonly proofs: readonly BrowserCustodyProofRow[];
  readonly database?: BitcasterDB;
  readonly injectFault?: "before-commit" | "after-commit";
}

/** Commit one SDK-prepared proof import and its exact proof rows atomically. */
export async function commitBrowserCustodyProofImport(
  input: BrowserCustodyProofImportInput,
): Promise<void> {
  const database = input.database ?? db;
  const adapter = new BrowserDurableCustodyAdapter(database);
  const operationId = input.prepared.record.operation.operationId;
  const proofs = requireExactImportProofs(input);
  await transactCurrent(adapter, input, (transaction) => {
    bindDurableCustodyProofImport({ transaction, prepared: input.prepared });
  });
  await transactCurrent(adapter, input, (transaction) => {
    stageDurableCustodyProofImport({
      transaction,
      prepared: input.prepared,
      authorization: input.owner,
    });
  });
  await transactCurrent(
    adapter,
    input,
    (transaction) => {
      applyDurableCustodyProofImport({
        transaction,
        prepared: input.prepared,
        authorization: input.owner,
        successorAdmission: successorAdmission(input, proofs),
      });
    },
    {
      successorProofs: {
        [operationId]: proofs.map((proof) => ({ proof, expectedRevision: null })),
      },
      ...(input.injectFault === undefined ? {} : { injectFault: input.injectFault }),
    },
  );
}

async function transactCurrent(
  adapter: BrowserDurableCustodyAdapter,
  input: BrowserCustodyProofImportInput,
  apply: Parameters<BrowserDurableCustodyAdapter["transact"]>[1],
  options: Parameters<BrowserDurableCustodyAdapter["transact"]>[2] = {},
): Promise<void> {
  const operationId = input.prepared.record.operation.operationId;
  const current = await adapter.readOperation(input.scope, operationId);
  await adapter.transact(
    {
      scope: input.scope,
      owner: input.owner,
      operationRows: [{ operationId, expectedRevision: current?.revision ?? null }],
    },
    apply,
    options,
  );
}

function requireExactImportProofs(
  input: BrowserCustodyProofImportInput,
): readonly BrowserCustodyProofRow[] {
  if (
    input.prepared.record.scope.scopeId !== input.scope.scopeId ||
    input.prepared.record.scope.scopeKind !== input.scope.scopeKind
  ) {
    throw new Error("browser proof import scope is foreign");
  }
  const byId = new Map(input.proofs.map((proof) => [proof.proofId, proof]));
  if (
    byId.size !== input.proofs.length ||
    byId.size !== input.prepared.successorProofIds.length ||
    input.prepared.successorProofIds.some((proofId) => !byId.has(proofId))
  ) {
    throw new Error("browser proof import set is incomplete");
  }
  return input.prepared.successorProofIds.map((proofId) => {
    const proof = byId.get(proofId)!;
    const context = input.prepared.record.operation.custodyContext;
    if (
      proof.scopeId !== input.scope.scopeId ||
      proof.normalizedMint !== context.normalizedMint ||
      proof.unit !== context.unit ||
      proof.revision !== 0 ||
      proof.selectability !== "selectable" ||
      proof.reservationOperationId !== null
    ) {
      throw new Error("browser proof import authority is invalid");
    }
    return proof;
  });
}

function successorAdmission(
  input: BrowserCustodyProofImportInput,
  proofs: readonly BrowserCustodyProofRow[],
): DurableCustodySuccessorAdmissionEvidence {
  const operationId = input.prepared.record.operation.operationId;
  return {
    scopeId: input.scope.scopeId,
    operationId,
    admissionId: `proof-import:${operationId}`,
    proofRows: proofs.map(({ proofId }) => ({
      proofId,
      expectedRevision: null,
      admittedRevision: 0,
    })),
  };
}
