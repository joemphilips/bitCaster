import type { Proof } from "@cashu/cashu-ts";
import {
  createDurableProofOperationFacts,
  createDurableCustodyProofOperation,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk";
import { bindDurableCustodyProofOperation } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import type { DurableCustodyProofOperationInput } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import type { BrowserCustodyProofRow } from "../stores/durable-custody-types";

/** Commit the exact CTF operation and its authenticated terminal rejection. */
export async function commitBrowserCtfTerminalOperation(input: {
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly scope: DurableCustodyScope;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly operationId: string;
  readonly mintUrl: string;
  readonly proofs: readonly Proof[];
  readonly predecessorProofs: readonly BrowserCustodyProofRow[];
  readonly publicKey: string;
  readonly classifiedAtMs?: number;
}): Promise<{
  readonly operationId: string;
  readonly rejection: ReturnType<typeof prepareDurableCustodyExactArtifact>;
  readonly rejectionReferenceArtifactId: string;
}> {
  const operation: DurableCustodyProofOperationInput = {
    operationId: input.operationId,
    kind: "ctf-redeem",
    mintUrl: input.mintUrl,
    inputs: input.proofs,
    outputs: {
      regular: [
        {
          blindedMessage: {
            amount: 1,
            id: input.proofs[0]!.id,
            B_: input.publicKey,
          },
          blindingFactor: "7",
          secret: `output-${input.operationId}`,
        },
      ],
    },
    metadata: { unit: "msat" },
  };
  const artifacts = {
    requestBody: prepareDurableCustodyExactArtifact(operation),
    output: prepareDurableCustodyExactArtifact(operation.outputs),
    privateMaterial: prepareDurableCustodyExactArtifact(operation),
  };
  const facts = createDurableProofOperationFacts({
    unit: "msat",
    binding: { kind: "wallet", activityId: input.operationId, stage: "ctf-redeem" },
    horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
    hasOutputs: true,
    inputKeysetRequirement: "required",
    keysets: [
      {
        keysetId: input.proofs[0]!.id!,
        unit: "msat",
        curve: "secp256k1",
        publicKeys: { "1": input.publicKey },
        keysetExpiryMs: null,
        requireDleq: false,
        usedByInputs: true,
        usedByOutputs: true,
      },
    ],
  });
  const record = createDurableCustodyProofOperation({
    scope: input.scope,
    operation,
    facts,
    inventoryAccountId: null,
    exactBoundary: {
      method: "POST",
      path: "/v1/redeem_outcome",
      idempotencyKey: input.operationId,
      requestBody: artifacts.requestBody,
      output: artifacts.output,
      privateMaterial: artifacts.privateMaterial,
    },
  });
  const operationId = record.operation.operationId;
  await input.adapter.transact(
    {
      scope: input.scope,
      owner: input.owner,
      operationRows: [{ operationId, expectedRevision: null }],
    },
    (transaction) => bindDurableCustodyProofOperation(transaction, record, artifacts),
    { predecessorProofs: { [operationId]: [...input.predecessorProofs] } },
  );

  const rejection = prepareDurableCustodyExactArtifact({
    schemaVersion: 1,
    kind: "authenticated-terminal-mint-rejection",
    operationId,
    semanticKind: "ctf-redeem",
    normalizedMint: input.mintUrl,
    requestFingerprint: record.operation.exactRequest.requestFingerprint,
    code: 13015,
    transportProvenance: "authenticated-mint-transport",
    transportOperationId: record.operation.retainedOperationKey,
    rejectionBody: { code: 13015 },
    predecessorDisposition: "retain",
    selectedSuccessorProofIds: [],
  });
  const owner = { ...input.owner, observedAtMs: input.classifiedAtMs ?? 20 };
  await input.adapter.transact(
    {
      scope: input.scope,
      owner,
      operationRows: [{ operationId, expectedRevision: 0 }],
    },
    (transaction) =>
      transaction.reconcileAuthenticatedTerminalMintRejection!({
        operationId,
        expectedRevision: 0,
        authorization: owner,
        rejectionHandle: `terminal:${rejection.fingerprint}`,
        rejectionFingerprint: rejection.fingerprint,
        exactRejection: rejection,
        code: 13015,
        predecessorDisposition: "retain",
      }),
  );
  const committed = await input.adapter.readOperation(input.scope, operationId);
  if (committed === null || committed.operation.terminalMintRejection === null) {
    throw new Error("test terminal operation was not committed");
  }
  return {
    operationId,
    rejection,
    rejectionReferenceArtifactId:
      committed.operation.terminalMintRejection.exactRejection.artifactId,
  };
}
