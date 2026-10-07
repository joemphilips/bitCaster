import { deriveKeysetId, type Proof } from "@cashu/cashu-ts";
import {
  createDurableCustodyProofOperation,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk";
import { bindDurableCustodyProofOperation } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import type { DurableCustodyProofOperationInput } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import {
  decodeBrowserCustodyConditionalKeysetRow,
  type BrowserCustodyProofRow,
} from "../stores/durable-custody-types";
import type { BitcasterDB } from "../stores/proof-db";
import {
  prepareDurableCustodyMintOperationAuthority,
  type DurableCustodyMintKeysetAuthority,
} from "@bitcaster/client-sdk/durableCustodyMintResult";
import { prepareCtfVerifiedLosingAuthority } from "@bitcaster/client-sdk/conditionOracleEvidence";
import { browserD4OracleEvidence } from "./browserD4OracleFixture";

/** Prepare the exact CTF operation and its authenticated rejection without committing it. */
export async function prepareBrowserCtfTerminalOperation(input: {
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly database: BitcasterDB;
  readonly scope: DurableCustodyScope;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly operationId: string;
  readonly mintUrl: string;
  readonly proofs: readonly Proof[];
  readonly predecessorProofs: readonly BrowserCustodyProofRow[];
  readonly publicKey: string;
  readonly classifiedAtMs?: number;
}) {
  const held = input.predecessorProofs[0]!;
  if (held.conditionId === null || held.outcomeCollection === null)
    throw new Error("test conditional holding is missing");
  const outcomes = held.outcomeCollection === "Alpha" ? ["Alpha", "Beta"] : ["YES", "NO"];
  const oracle = browserD4OracleEvidence(
    input.scope.scopeId,
    input.mintUrl,
    outcomes[1]!,
    outcomes,
  );
  const regularId = deriveKeysetId({ "1": input.publicKey }, { unit: "msat", versionByte: 1 });
  const keysets: DurableCustodyMintKeysetAuthority[] = [];
  for (const id of new Set(input.proofs.map((proof) => proof.id))) {
    const raw = await input.database.custodyConditionalKeysets.get([
      input.scope.scopeId,
      input.mintUrl,
      "msat",
      id,
    ]);
    if (raw === undefined) throw new Error("test conditional keyset authority is missing");
    const keyset = decodeBrowserCustodyConditionalKeysetRow(raw);
    keysets.push({
      canonicalMintUrl: input.mintUrl,
      id,
      unit: "msat",
      keys: keyset.denominationPublicKeys,
      inputFeePpk: keyset.inputFeePpk,
      finalExpiry: keyset.finalExpiryUnixSeconds,
      identity: {
        kind: "conditional",
        conditionId: keyset.conditionId,
        outcomeCollection: keyset.outcomeCollection,
        outcomeCollectionId: keyset.outcomeCollectionId,
      },
    });
  }
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
            id: regularId,
            B_: input.publicKey,
          },
          blindingFactor: "7",
          secret: `output-${input.operationId}`,
        },
      ],
    },
    metadata: {
      unit: "msat",
      conditionId: held.conditionId,
      outcomeCollection: held.outcomeCollection,
      oracleResolutionContext: oracle.context,
    },
  };
  const prepared = prepareDurableCustodyMintOperationAuthority({
    operation,
    keysets: [
      ...keysets,
      {
        canonicalMintUrl: input.mintUrl,
        id: regularId,
        unit: "msat",
        keys: { "1": input.publicKey },
        inputFeePpk: 0,
        finalExpiry: null,
        identity: { kind: "regular" },
      },
    ],
  });
  const artifacts = {
    requestBody: prepared.exactRequest,
    output: prepared.exactOutput,
    privateMaterial: prepared.exactAuthority,
  };
  const facts = {
    ...prepared.facts,
    binding: {
      kind: "wallet" as const,
      activityId: input.operationId,
      stage: "ctf-redeem" as const,
    },
    horizon: { ...prepared.facts.horizon, notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
  };
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
    losingAuthority: prepareCtfVerifiedLosingAuthority({
      resolution: oracle.context,
      operationId: input.operationId,
      mintUrl: input.mintUrl,
      conditionId: held.conditionId,
      outcomeCollection: held.outcomeCollection,
      inputs: input.proofs,
      inputKeysets: keysets,
    }),
    predecessorDisposition: "retain",
    selectedSuccessorProofIds: [],
  });
  return { operation, record, artifacts, rejection };
}

/** Commit the exact CTF operation and its authenticated terminal rejection. */
export async function commitBrowserCtfTerminalOperation(input: {
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly database: BitcasterDB;
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
  readonly exactAuthority: ReturnType<typeof prepareDurableCustodyExactArtifact>;
  readonly rejectionReferenceArtifactId: string;
}> {
  const { record, artifacts, rejection } = await prepareBrowserCtfTerminalOperation(input);
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
    exactAuthority: artifacts.privateMaterial,
    rejectionReferenceArtifactId:
      committed.operation.terminalMintRejection.exactRejection.artifactId,
  };
}
