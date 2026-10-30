import "fake-indexeddb/auto";
import { Buffer } from "node:buffer";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  createDurableCustodyDispatchIntent,
  createDurableProofOperationFacts,
  claimDurableCustodyScope,
  reduceDurableCustodyState,
  prepareDurableCustodyExactArtifact,
  encodeBoundedDurableArtifact,
  DURABLE_CUSTODY_RECORD_BYTES_MAX,
  type DurableCustodyRecord,
} from "@bitcaster/client-sdk/durableCustody";
import { encodeCtfRangeOrderPreparationArtifact } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import { useMarketTradeRecovery } from "../useMarketTradeRecovery";
import {
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import {
  insertCtfRangePreparation,
  transitionCtfRangePreparation,
  bindCtfRangePreparationCapability,
} from "@/stores/ctf-range-order-db";
import { db } from "@/stores/proof-db";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { useOrderSettlementObservations } from "@/stores/orderSettlementObservations";

const local = vi.hoisted(() => ({ activeScopeId: null as string | null }));
vi.mock("@/lib/browserWalletProfile", async () => ({
  ...(await vi.importActual<typeof import("@/lib/browserWalletProfile")>(
    "@/lib/browserWalletProfile",
  )),
  activeBrowserWalletScopeId: () => local.activeScopeId,
}));

const mnemonic =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
afterEach(async () => {
  await db.ctfRangePreparations.clear();
  await db.custodyOperations.clear();
  usePendingTradesStore.setState({ byOrderId: {} });
  useOrderSettlementObservations.setState({ byOrderId: {} });
  local.activeScopeId = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("observes real IndexedDB result application without another pending or status update", async () => {
  // fake IndexedDB uses Node structuredClone. Match its byte-array realm so
  // canonical SDK decoders see the same Uint8Array type after persistence.
  vi.stubGlobal("Uint8Array", Object.getPrototypeOf(Buffer));
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected network request."));
  const walletId = browserWalletIdFromMnemonic(mnemonic)!;
  const scopeId = browserWalletScopeIdFromMnemonic(mnemonic)!;
  local.activeScopeId = scopeId;
  const scope = { scopeKind: "wallet" as const, walletId, scopeId };
  const rangeOperationId = "consumer-result-change";
  const orderId = "44444444-4444-4444-8444-444444444444";
  const journal = {
    scopeId,
    rangeOperationId,
    sourceOperationId: `${rangeOperationId}:source`,
    authorizationId: `${rangeOperationId}:auth`,
    clientOrderId: "consumer-client",
    orderRouteId: "condition-with-dashes-Yes",
    normalizedMint: "https://mint.example",
    conditionId: "condition-with-dashes",
    unit: "msat" as const,
    tokenSide: "Outcome" as const,
    side: "Buy" as const,
    priceSubunits: 500,
    amountSubunits: 1000,
    minimumFillAmountSubunits: 1000,
    divisibility: 1000 as const,
    authorizationExpiresAtUnixSeconds: 1000,
    preparationBytes: encodeCtfRangeOrderPreparationArtifact({ version: 1 }),
    feeConsentBytes: null,
    createdAtMs: 1,
  };
  await insertCtfRangePreparation(journal);
  await transitionCtfRangePreparation({
    scopeId,
    rangeOperationId,
    expectedRevision: 0,
    from: "prepared",
    to: "capability-requested",
    updatedAtMs: 2,
  });
  await bindCtfRangePreparationCapability({
    scopeId,
    rangeOperationId,
    expectedRevision: 1,
    capability: {
      artifactId: "11111111-1111-4111-8111-111111111111",
      bindingDigest: "22".repeat(32),
      artifactDigest: "33".repeat(32),
      orderId,
    },
    updatedAtMs: 3,
  });
  await transitionCtfRangePreparation({
    scopeId,
    rangeOperationId,
    expectedRevision: 2,
    from: "capability-bound",
    to: "order-submitted",
    updatedAtMs: 4,
  });
  // This test owns the reactive consumer. Coordinator tests prove the full
  // production writer. Here SDK transitions supply canonical stored records.
  const artifact = prepareDurableCustodyExactArtifact({ fixture: "small consumer result" });
  const record = createDurableCustodyDispatchIntent({
    scope,
    retainedOperationKey: rangeOperationId,
    semanticKind: "wallet-send",
    normalizedMint: journal.normalizedMint,
    inventoryAccountId: null,
    facts: createDurableProofOperationFacts({
      unit: "msat",
      binding: { kind: "wallet", activityId: rangeOperationId, stage: "send" },
      horizon: { notBeforeMs: null, notAfterMs: null, safetyMarginMs: 0 },
      hasOutputs: false,
      inputKeysetRequirement: "none",
      keysets: [
        {
          keysetId: `01${"11".repeat(32)}`,
          unit: "msat",
          curve: "secp256k1",
          publicKeys: { "1": `02${"11".repeat(32)}` },
          keysetExpiryMs: null,
          requireDleq: false,
          usedByInputs: false,
          usedByOutputs: false,
        },
      ],
    }),
    reservation: { reservationId: "consumer-reservation", parentReservationId: null, inputs: [] },
    proofLineage: {
      predecessorProofIds: [],
      successorProofIds: [],
      successorAdmissionMode: "exact",
    },
    exactRequest: {
      requestId: "consumer-request",
      requestFingerprint: artifact.fingerprint,
      payloadHandle: "consumer-request-body",
      inputProofIds: [],
      outputPlanFingerprint: artifact.fingerprint,
      method: "POST",
      path: "/v1/swap",
      idempotencyKey: rangeOperationId,
      body: artifact,
    },
    outputPlan: {
      outputPlanId: "consumer-output",
      outputPlanFingerprint: artifact.fingerprint,
      outputMaterialHandle: "consumer-output-body",
      exactOutput: artifact,
    },
    privateMaterial: {
      materialHandle: "consumer-private",
      useId: "consumer-use",
      publicFingerprint: artifact.fingerprint,
      exactPrivateMaterial: artifact,
    },
  });
  await writeRecord(record);
  const trade = {
    walletId,
    orderId,
    clientOrderId: journal.clientOrderId,
    marketId: journal.orderRouteId,
    submittedAt: 4,
    baseAsset: "sat" as const,
    divisibility: 1000 as const,
  };
  usePendingTradesStore.setState({ byOrderId: { [orderId]: trade } });
  const pendingBefore = usePendingTradesStore.getState().byOrderId;
  const { result, unmount } = renderHook(() =>
    useMarketTradeRecovery({ mnemonic, conditionId: journal.conditionId, signerRevision: 1 }),
  );
  await waitFor(() => expect(result.current.stages).toEqual(["order-pending"]));
  const firstKey = result.current.invalidationKey;
  const scopeState = claimDurableCustodyScope(
    {
      schemaVersion: 1,
      scope,
      fencingEpoch: 0,
      owner: null,
      effectiveClock: { highWaterMarkMs: 0 },
    },
    { incarnationId: "consumer-test", observedAtMs: 5, leaseExpiresAtMs: 100 },
  );
  const authorization = {
    incarnationId: "consumer-test",
    fencingEpoch: scopeState.fencingEpoch,
    observedAtMs: 5,
  };
  let state = reduceDurableCustodyState(
    { scopeState, operation: record },
    {
      kind: "stage-verified-result",
      authorization,
      expectedRevision: record.revision,
      resultHandle: "consumer-result",
      resultFingerprint: artifact.fingerprint,
      outputPlanFingerprint: artifact.fingerprint,
      exactResult: artifact,
      selectedSuccessorProofIds: [],
    },
  );
  await act(async () => writeRecord(state.operation));
  await waitFor(() => expect(result.current.stages).toEqual(["wallet-recovery"]));
  state = reduceDurableCustodyState(state, {
    kind: "apply-verified-result",
    authorization,
    expectedRevision: state.operation.revision,
    successorAdmission: {
      scopeId,
      operationId: record.operation.operationId,
      admissionId: "consumer-admission",
      proofRows: [],
    },
  });
  await act(async () => writeRecord(state.operation));
  await waitFor(() => expect(result.current.stages).toEqual(["result-saved"]));
  expect(result.current.invalidationKey).not.toBe(firstKey);
  expect(usePendingTradesStore.getState().byOrderId).toBe(pendingBefore);
  expect(useOrderSettlementObservations.getState().byOrderId).toEqual({});
  expect(result.current.suppressFundingHint).toBe(true);
  expect(network).not.toHaveBeenCalled();
  unmount();
});

async function writeRecord(record: DurableCustodyRecord): Promise<void> {
  await db.custodyOperations.put({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    revision: record.revision,
    operationState: record.operation.state,
    nextAttemptAtMs: record.operation.retry.nextAttemptAtMs,
    estimatedBytes: encodeBoundedDurableArtifact(record, DURABLE_CUSTODY_RECORD_BYTES_MAX)
      .byteLength,
    record,
  });
}
