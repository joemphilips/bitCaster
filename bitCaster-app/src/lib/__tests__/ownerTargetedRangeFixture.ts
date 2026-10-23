import { OutputData, createCtfSelectionBitmap } from "@cashu/cashu-ts";
import assert from "node:assert/strict";
import { mapDurableCtfRangeSuccessorProofs } from "../../../../bitcaster-client-sdk/src/durableCtfRangeCustody.ts";
import {
  createDurableCtfRangeCustodyBinding,
  createDurableCtfRangeResultEnvelope,
  prepareDurableCtfRangeVerifiedResult,
  toDurableCtfRangeProofOperationInput,
} from "../../../../bitcaster-client-sdk/src/durableCtfRangeOperation.ts";
import { deserializeDurableCustodyProofArtifact } from "../../../../bitcaster-client-sdk/src/durableCustodyProofMaterial.ts";
import { bindDurableCustodyProofOperation } from "../../../../bitcaster-client-sdk/src/durableCustodyProofOperationRecord.ts";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
  resolveDurableCustodyProofOperationFacts,
} from "../../../../bitcaster-client-sdk/src/index.ts";
import { FaultInjectingDurableCustodyAdapter } from "../../../../bitcaster-client-sdk/test/support/faultInjectingDurableCustodyAdapter.ts";
import { signedOwnerRangeFixture } from "../../../../bitcaster-client-sdk/test/support/signedOwnerRangeFixture.ts";

async function stagedFixture(plain: boolean, side: "Buy" | "Sell" = "Buy", zero = false) {
  const fixture = signedOwnerRangeFixture({
    plain,
    side,
    ...(zero ? { offerStart: 0, receiveStart: 0 } : {}),
  });
  const { operation, preparation, seed, keys } = fixture;
  const walletId = deriveDurableCustodyWalletId(seed);
  const scope = {
    scopeKind: "wallet" as const,
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
  const mintKeysets = new Map(
    [operation.keysetAuthority.offer, operation.keysetAuthority.receive].map((authority) => [
      authority.keysetId,
      {
        canonicalMintUrl: operation.mintUrl,
        id: authority.keysetId,
        unit: authority.unit,
        keys,
        inputFeePpk: authority.inputFeePpk,
        finalExpiry: authority.finalExpiry,
      },
    ]),
  );
  const binding = createDurableCtfRangeCustodyBinding({
    scope,
    operation,
    facts: await resolveDurableCustodyProofOperationFacts({
      operation: toDurableCtfRangeProofOperationInput(operation),
      resolveMintKeys: async () =>
        new Map(
          [...mintKeysets].map(([id, k]) => [
            id,
            { id, unit: k.unit, keys: k.keys, final_expiry: k.finalExpiry ?? undefined },
          ]),
        ),
      requireDleq: true,
    }),
    mintKeysets,
    inventoryAccountId: null,
    boundary: {
      method: "POST",
      path: "/v1/range-authorizations",
      idempotencyKey: operation.authorizationId,
      requestBody: { authorizationId: operation.authorizationId },
    },
  });
  const receive = BigInt(operation.policy.minReceive);
  const selected = operation.manifest.entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) => (BigInt(entry.amount) & (entry.role === "receive" ? receive : 1n)) !== 0n,
    );
  const selection = createCtfSelectionBitmap(
    operation.manifest.entries.length,
    selected.map((x) => x.index),
  );
  const result = prepareDurableCtfRangeVerifiedResult({
    record: binding.record,
    operation,
    envelope: createDurableCtfRangeResultEnvelope({
      operation,
      requestDigest: "ef".repeat(32),
      selection,
      signatures: selected.map(({ entry }) =>
        fixture.signBlindedMessage(OutputData.deserialize(entry.outputData).blindedMessage),
      ),
    }),
    resolveKeyset: (_url, id) => mintKeysets.get(id),
  });
  assert.equal(result.kind, "confirmed");
  if (result.kind !== "confirmed") throw new Error("fixture result not verified");
  const adapter = new FaultInjectingDurableCustodyAdapter({
    schemaVersion: 1,
    scope,
    fencingEpoch: 1,
    owner: { incarnationId: "process-1", leaseExpiresAtMs: 1000 },
    effectiveClock: { highWaterMarkMs: 10 },
  });
  adapter.run((tx) => bindDurableCustodyProofOperation(tx, binding.record, binding.artifacts));
  adapter.run((tx) =>
    tx.stageVerifiedResult({
      operationId: binding.record.operation.operationId,
      expectedRevision: 0,
      authorization: { incarnationId: "process-1", fencingEpoch: 1, observedAtMs: 20 },
      outputPlanFingerprint: binding.record.operation.outputPlan.outputPlanFingerprint,
      resultHandle: result.resultHandle,
      resultFingerprint: result.resultFingerprint,
      exactResult: result.exactResult,
      selectedSuccessorProofIds: result.selectedSuccessorProofIds,
    }),
  );
  return { fixture, operation, preparation, seed, record: adapter.readOperation()!, result };
}

/** Reuse the accepted signed range fixture and real verified-result mapper. */
export async function ownerTargetedRangeFixture(side: "Buy" | "Sell") {
  const { fixture, operation, preparation, seed, record, result } = await stagedFixture(true, side);
  const successors = mapDurableCtfRangeSuccessorProofs(
    { record, operation, result: result.result, preparation, seed },
    (value) => value,
  );
  const successor = successors
    .filter((value) => value.classification.conditionId !== null)
    .sort((a, b) => Number(b.material.amount) - Number(a.material.amount))[0]!;
  const metadata = preparation.expiryObservation.conditionalKeysets.find(
    (value) => value.keysetId === successor.material.keysetId,
  )!;
  const asset = {
    kind: "ctf" as const,
    conditionId: operation.conditionId,
    outcomeLabel: metadata.outcomeCollection as string,
    outcomeCollectionId: metadata.outcomeCollectionId as string,
    registeredAt: metadata.registeredAt as number,
    finalExpiry: metadata.finalExpiry as number,
  };
  const proof = deserializeDurableCustodyProofArtifact({ schemaVersion: 1, ...successor.proof });
  if (preparation.version !== 3) throw new Error("expected counter preparation");
  const nextCounter =
    successor.material.keysetId === preparation.offerKeyset.id
      ? preparation.offerCounterStart + preparation.offerCounterCount
      : preparation.receiveCounterStart + preparation.receiveCounterCount;
  return {
    seed,
    asset,
    proof,
    locator: successor.derivationLocator,
    keys: fixture.keys,
    inputFeePpk: metadata.inputFeePpk as number,
    nextCounter,
    signOutput: fixture.signOutput,
  };
}
