import {
  applyDurableCustodyProofImport,
  bindDurableCustodyProofImport,
  stageDurableCustodyProofImport,
  type PreparedDurableCustodyProofImport,
} from "@bitcaster/client-sdk/durableCustodyProofImport";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import type {
  DurableCustodyOwnerAuthorization,
  DurableCustodyScope,
  DurableCustodySuccessorAdmissionEvidence,
} from "@bitcaster/client-sdk/durableCustody";
import { BrowserDurableCustodyAdapter, type StagedBrowserCustodyProof } from "./durable-custody-db";
import { db, type BitcasterDB } from "./proof-db";

export interface BrowserCustodyProofImportInput {
  readonly scope: DurableCustodyScope;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly prepared: PreparedDurableCustodyProofImport;
  readonly proofs: readonly StagedBrowserCustodyProof[];
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
        inventoryAuthorityFingerprint: inventoryAuthorityFingerprint(proofs),
      });
    },
    {
      successorProofs: {
        [operationId]: proofs,
      },
      ...(input.injectFault === undefined ? {} : { injectFault: input.injectFault }),
    },
  );
}

function inventoryAuthorityFingerprint(proofs: readonly StagedBrowserCustodyProof[]): string {
  return deriveDurableCustodyArtifactFingerprint({
    schemaVersion: 1,
    proofs: proofs.map(({ proof }) => ({
      proofId: proof.proofId,
      proofFingerprint: proof.proofFingerprint,
      assetKind: proof.assetKind,
      conditionId: proof.conditionId,
      outcomeCollection: proof.outcomeCollection,
      baseAsset: proof.baseAsset,
    })),
  });
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
): readonly StagedBrowserCustodyProof[] {
  if (
    input.prepared.record.scope.scopeId !== input.scope.scopeId ||
    input.prepared.record.scope.scopeKind !== input.scope.scopeKind
  ) {
    throw new Error("browser proof import scope is foreign");
  }
  const preparedProofs = decodePreparedImportOutput(input.prepared.artifacts.output.artifact);
  if (
    preparedProofs.length !== input.prepared.successorProofIds.length ||
    preparedProofs.some((proof, index) => proof.proofId !== input.prepared.successorProofIds[index])
  ) {
    throw new Error("browser proof import prepared output is invalid");
  }
  const preparedById = new Map(preparedProofs.map((proof) => [proof.proofId, proof]));
  const byId = new Map(input.proofs.map((staged) => [staged.proof.proofId, staged]));
  if (
    byId.size !== input.proofs.length ||
    byId.size !== input.prepared.successorProofIds.length ||
    input.prepared.successorProofIds.some((proofId) => !byId.has(proofId))
  ) {
    throw new Error("browser proof import set is incomplete");
  }
  return input.prepared.successorProofIds.map((proofId) => {
    const staged = byId.get(proofId)!;
    const proof = staged.proof;
    const prepared = preparedById.get(proof.proofId);
    if (prepared === undefined || proof.proofFingerprint !== prepared.proofFingerprint) {
      throw new Error("browser proof import row artifact mismatch");
    }
    const context = input.prepared.record.operation.custodyContext;
    if (
      staged.expectedRevision !== null ||
      proof.scopeId !== input.scope.scopeId ||
      proof.normalizedMint !== context.normalizedMint ||
      proof.unit !== context.unit ||
      proof.revision !== 0 ||
      proof.selectability !== "selectable" ||
      proof.reservationOperationId !== null
    ) {
      throw new Error("browser proof import authority is invalid");
    }
    return staged;
  });
}

function decodePreparedImportOutput(
  value: unknown,
): readonly { readonly proofId: string; readonly proofFingerprint: string }[] {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "inventoryAuthorityFingerprint,proofs"
  ) {
    throw new Error("browser proof import prepared output is invalid");
  }
  const output = value as { inventoryAuthorityFingerprint?: unknown; proofs?: unknown };
  if (
    typeof output.inventoryAuthorityFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(output.inventoryAuthorityFingerprint) ||
    !Array.isArray(output.proofs) ||
    output.proofs.length === 0
  ) {
    throw new Error("browser proof import prepared output is invalid");
  }
  const proofs = output.proofs.map((proof) => {
    if (
      typeof proof !== "object" ||
      proof === null ||
      Array.isArray(proof) ||
      Object.keys(proof).sort().join(",") !== "proofFingerprint,proofId"
    ) {
      throw new Error("browser proof import prepared output is invalid");
    }
    const entry = proof as { proofId?: unknown; proofFingerprint?: unknown };
    if (
      typeof entry.proofId !== "string" ||
      entry.proofId.length === 0 ||
      typeof entry.proofFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.proofFingerprint)
    ) {
      throw new Error("browser proof import prepared output is invalid");
    }
    return { proofId: entry.proofId, proofFingerprint: entry.proofFingerprint };
  });
  if (new Set(proofs.map(({ proofId }) => proofId)).size !== proofs.length) {
    throw new Error("browser proof import prepared output is invalid");
  }
  return proofs;
}

function successorAdmission(
  input: BrowserCustodyProofImportInput,
  proofs: readonly StagedBrowserCustodyProof[],
): DurableCustodySuccessorAdmissionEvidence {
  const operationId = input.prepared.record.operation.operationId;
  return {
    scopeId: input.scope.scopeId,
    operationId,
    admissionId: `proof-import:${operationId}`,
    proofRows: proofs.map(({ proof }) => ({
      proofId: proof.proofId,
      expectedRevision: null,
      admittedRevision: 0,
    })),
  };
}
