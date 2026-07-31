import type { Proof } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyOperationId,
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  prepareDurableCustodyExactArtifact,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import {
  decodeDurableCustodyProofOperationInput,
  resolveDurableCustodyProofOperationFacts,
  type DurableCustodyProofOperationInput,
} from "@bitcaster/client-sdk/durableCustodyProofOperation";
import { createDurableCustodyProofOperation } from "@bitcaster/client-sdk/durableCustodyProofOperationRecord";
import {
  deserializeDurableCustodyProofArtifact,
  serializeDurableCustodyProofArtifact,
} from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import {
  createDurableCtfRangeCustodyBinding,
  toDurableCtfRangeProofOperationInput,
  type DurableCtfRangeMintKeyset,
  type DurableCtfRangeOperation,
} from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  completeCtfRangeOrderAuthorization,
  prepareCtfRangeOrderAuthorization,
} from "@bitcaster/client-sdk/ctfRangeOrderPreparation";
import type { CtfRangeSourceResult } from "@bitcaster/client-sdk/ctfRangeSourceOperation";
import {
  ctfRangeOrderPreparationKeysetLookup,
  encodePersistedCtfRangeOrderPreparation,
  exactCtfRangeOrderPreparationMintKeysets,
  type PersistedCtfRangeOrderPreparation,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import type { CreateSettlementCapabilityRequest } from "@bitcaster/client-sdk/engineClient";
import {
  createBrowserCustodyProofRow,
  type BrowserCustodyProofAsset,
  type BrowserDurableCustodyAdapter,
  type StagedBrowserCustodyProof,
} from "../stores/durable-custody-db";
import type { BrowserCustodyProofRow } from "../stores/durable-custody-types";

export function browserWalletScope(
  seed: Uint8Array,
): Extract<DurableCustodyScope, { scopeKind: "wallet" }> {
  const walletId = deriveDurableCustodyWalletId(seed);
  return {
    scopeKind: "wallet",
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
}

export function browserCustodyOperationId(
  scope: DurableCustodyScope,
  retainedOperationKey: string,
): string {
  return deriveDurableCustodyOperationId(scope.scopeId, {
    retainedOperationKey,
    binding: { kind: "wallet", activityId: retainedOperationKey, stage: "send" },
  });
}

export function browserRangeJournalIdentity(
  scope: DurableCustodyScope,
  preparation: PersistedCtfRangeOrderPreparation,
  createdAtMs: number,
) {
  return {
    scopeId: scope.scopeId,
    rangeOperationId: preparation.operationId,
    sourceOperationId: preparation.sourceOperationId,
    sourceKind: preparation.sourceKind,
    predecessorRangeOperationId: preparation.predecessorRangeOperationId,
    authorizationId: preparation.authorizationId,
    clientOrderId: preparation.request.clientOrderId,
    orderRouteId: preparation.request.marketId,
    normalizedMint: preparation.mintUrl,
    conditionId: preparation.conditionId,
    unit: "msat" as const,
    tokenSide: preparation.request.tokenSide,
    side: preparation.side,
    priceSubunits: preparation.priceNumerator,
    amountSubunits: preparation.amountSubunits,
    divisibility: preparation.divisibility,
    authorizationExpiresAtUnixSeconds: preparation.expiry,
    preparationBytes: encodePersistedCtfRangeOrderPreparation(preparation),
    createdAtMs,
  };
}

export async function createBrowserRangeSourceBinding(
  scope: DurableCustodyScope,
  preparation: PersistedCtfRangeOrderPreparation,
  operation: DurableCustodyProofOperationInput,
) {
  const facts = await resolveFacts(
    operation,
    exactCtfRangeOrderPreparationMintKeysets(preparation),
    false,
  );
  const artifacts = {
    requestBody: prepareDurableCustodyExactArtifact(operation),
    output: prepareDurableCustodyExactArtifact(operation.outputs),
    privateMaterial: prepareDurableCustodyExactArtifact(operation),
  };
  return {
    artifacts,
    record: createDurableCustodyProofOperation({
      scope,
      operation,
      facts,
      inventoryAccountId: null,
      exactBoundary: {
        method: "POST",
        path: "/v1/swap",
        idempotencyKey: operation.operationId,
        ...artifacts,
      },
    }),
  };
}

export async function createBrowserRangeBinding(
  scope: DurableCustodyScope,
  preparation: PersistedCtfRangeOrderPreparation,
  operation: DurableCtfRangeOperation,
  request: CreateSettlementCapabilityRequest,
) {
  const keysets = exactCtfRangeOrderPreparationMintKeysets(preparation);
  const facts = await resolveFacts(toDurableCtfRangeProofOperationInput(operation), keysets, true);
  return createDurableCtfRangeCustodyBinding({
    scope,
    operation,
    facts,
    mintKeysets: keysets,
    inventoryAccountId: null,
    boundary: {
      method: "POST",
      path: "/api/v1/settlement-capabilities",
      idempotencyKey: request.stageIdempotencyKey,
      requestBody: request,
    },
  });
}

export function completeBrowserRangeOperation(input: {
  preparation: PersistedCtfRangeOrderPreparation;
  seed: Uint8Array;
  proofs: readonly Proof[];
  allowInsecureLoopbackHttp: boolean;
}): DurableCtfRangeOperation {
  const { version: _, request: _request, ...authority } = input.preparation;
  return completeCtfRangeOrderAuthorization({
    preparation: prepareCtfRangeOrderAuthorization({ seed: input.seed, ...authority }),
    inputs: input.proofs,
    keysetLookup: ctfRangeOrderPreparationKeysetLookup(input.preparation),
    expiryObservation: input.preparation.expiryObservation,
    allowInsecureLoopbackHttp: input.allowInsecureLoopbackHttp,
  });
}

export function browserSourceProofRows(
  scope: DurableCustodyScope,
  preparation: PersistedCtfRangeOrderPreparation,
  result: CtfRangeSourceResult,
  receivedAtMs: number,
): StagedBrowserCustodyProof[] {
  return [...result.authorization, ...result.keep].map((proof) => ({
    proof: createProofRow(scope, preparation, proof, receivedAtMs),
    expectedRevision: null,
  }));
}

export function browserPersistedSourceResult(result: CtfRangeSourceResult) {
  return {
    schemaVersion: 1 as const,
    authorization: result.authorization.map(serializeDurableCustodyProofArtifact),
    keep: result.keep.map(serializeDurableCustodyProofArtifact),
  };
}

export function browserSourceOperationFromSnapshot(
  record: DurableCustodyRecord,
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
): DurableCustodyProofOperationInput {
  const reference = record.operation.privateMaterial.exactPrivateMaterial;
  const row = findArtifact(artifacts, reference.artifactId, "range source private authority");
  const operation = decodeDurableCustodyProofOperationInput(row.artifact.artifact);
  if (operation.operationId !== record.operation.retainedOperationKey) {
    throw new Error("range source private authority is foreign");
  }
  return operation;
}

export function browserSourceResultFromSnapshot(
  record: DurableCustodyRecord,
  artifacts: readonly { reference: { artifactId: string }; artifact: { artifact: unknown } }[],
): CtfRangeSourceResult {
  if (record.operation.result.state !== "verified-staged") {
    throw new Error("range source result is not staged");
  }
  const reference = record.operation.result.exactResult;
  if (reference === null) throw new Error("range source result reference is missing");
  const row = findArtifact(artifacts, reference.artifactId, "range source result authority");
  return decodeBrowserPersistedSourceResult(row.artifact.artifact);
}

export function decodeBrowserPersistedSourceResult(value: unknown): CtfRangeSourceResult {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("range source result authority is invalid");
  }
  if (Object.keys(value).sort().join(",") !== "authorization,keep,schemaVersion") {
    throw new Error("range source result fields are invalid");
  }
  if (!Array.isArray(value.authorization) || !Array.isArray(value.keep)) {
    throw new Error("range source result proof groups are invalid");
  }
  if (value.authorization.length + value.keep.length > 512) {
    throw new Error("range source result exceeds the aggregate proof limit");
  }
  return {
    authorization: decodeProofGroup(value.authorization),
    keep: decodeProofGroup(value.keep),
  };
}

export function requireBrowserStagedResult(record: DurableCustodyRecord): {
  resultHandle: string;
  resultFingerprint: string;
} {
  const result = record.operation.result;
  if (
    result.state !== "verified-staged" ||
    typeof result.resultHandle !== "string" ||
    typeof result.resultFingerprint !== "string"
  ) {
    throw new Error("range source staged result authority is invalid");
  }
  return { resultHandle: result.resultHandle, resultFingerprint: result.resultFingerprint };
}

export async function requireBrowserCustodyOperation(
  custody: BrowserDurableCustodyAdapter,
  scope: DurableCustodyScope,
  operationId: string,
): Promise<DurableCustodyRecord> {
  const record = await custody.readOperation(scope, operationId);
  if (record === null) throw new Error("browser range custody operation is missing");
  return record;
}

export function browserCustodySelection(
  scope: DurableCustodyScope,
  owner: DurableCustodyOwnerAuthorization,
  operationId: string,
  expectedRevision: number | null,
) {
  return { scope, owner, operationRows: [{ operationId, expectedRevision }] };
}

export function browserOwnerAt(
  owner: DurableCustodyOwnerAuthorization,
  observedAtMs: number,
): DurableCustodyOwnerAuthorization {
  return { ...owner, observedAtMs };
}

function createProofRow(
  scope: DurableCustodyScope,
  preparation: PersistedCtfRangeOrderPreparation,
  proof: Proof,
  receivedAtMs: number,
): BrowserCustodyProofRow {
  return createBrowserCustodyProofRow({
    scopeId: scope.scopeId,
    normalizedMint: preparation.mintUrl,
    unit: "msat",
    proof,
    asset: sourceAsset(preparation),
    receivedAtMs,
  });
}

function sourceAsset(preparation: PersistedCtfRangeOrderPreparation): BrowserCustodyProofAsset {
  switch (preparation.side) {
    case "Buy":
      return { kind: "regular" };
    case "Sell":
      return conditionalSourceAsset(preparation);
    default:
      return assertNever(preparation.side);
  }
}

function conditionalSourceAsset(
  preparation: PersistedCtfRangeOrderPreparation,
): BrowserCustodyProofAsset {
  const keyset = preparation.offerKeyset as PersistedCtfRangeOrderPreparation["offerKeyset"] & {
    conditionId?: unknown;
    outcomeCollection?: unknown;
  };
  if (typeof keyset.conditionId !== "string" || typeof keyset.outcomeCollection !== "string") {
    throw new Error("conditional range source asset is invalid");
  }
  return {
    kind: "conditional",
    conditionId: keyset.conditionId,
    outcomeCollection: keyset.outcomeCollection,
  };
}

async function resolveFacts(
  operation: DurableCustodyProofOperationInput,
  keysets: ReadonlyMap<string, DurableCtfRangeMintKeyset>,
  requireDleq: boolean,
) {
  return resolveDurableCustodyProofOperationFacts({
    operation,
    resolveMintKeys: async (_mintUrl, ids) =>
      new Map(ids.map((id) => [id, requireMintKeyset(keysets, id)])),
    requireDleq,
  });
}

function requireMintKeyset(keysets: ReadonlyMap<string, DurableCtfRangeMintKeyset>, id: string) {
  const keyset = keysets.get(id);
  if (keyset === undefined) throw new Error("range keyset authority is missing");
  return {
    id,
    unit: keyset.unit,
    keys: keyset.keys,
    ...(keyset.finalExpiry === null ? {} : { final_expiry: keyset.finalExpiry }),
  };
}

function findArtifact<T extends { reference: { artifactId: string } }>(
  artifacts: readonly T[],
  artifactId: string,
  label: string,
): T {
  const row = artifacts.find(({ reference }) => reference.artifactId === artifactId);
  if (row === undefined) throw new Error(`${label} is missing`);
  return row;
}

function decodeProofGroup(value: unknown): Proof[] {
  if (!Array.isArray(value)) {
    throw new Error("range source result proof group is invalid");
  }
  return value.map(deserializeDurableCustodyProofArtifact);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`unhandled browser range source variant: ${String(value)}`);
}
