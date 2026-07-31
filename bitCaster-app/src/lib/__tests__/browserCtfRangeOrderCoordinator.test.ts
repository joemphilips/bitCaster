// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex } from "@noble/curves/utils.js";
import {
  Amount,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  pointFromHex,
  type ConditionalSwapPreview,
  type OutputData,
  type Proof,
  type ProofState,
  type SwapPreview,
} from "@cashu/cashu-ts";
import { deserializeDurableCustodyOutput } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import type { restoreOutputGroups } from "@bitcaster/client-sdk/ctfSplit";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  buildPersistedCtfRangeOrderPreparation,
  type CtfRangeOrderRequest,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import {
  decodeSettlementCapabilityArtifactBytes,
  deriveSettlementCapabilityArtifactDigest,
} from "@bitcaster/client-sdk/settlementCapabilityArtifact";
import type {
  CreateSettlementCapabilityRequest,
  OrderStatusResponse,
  SettlementCapabilityResponse,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from "@bitcaster/client-sdk/engineClient";
import {
  BrowserCtfRangeOrderCoordinator,
  BrowserCtfRangeOrderError,
  type BrowserCtfRangeEngine,
  type BrowserCtfRangeOrderCoordinatorDependencies,
} from "../browserCtfRangeOrderCoordinator";
import { decodeBrowserPersistedSourceResult } from "../browserCtfRangeOrderSource";
import { BrowserDurableCustodyAdapter } from "../../stores/durable-custody-db";
import { readCtfRangePreparation } from "../../stores/ctf-range-order-db";
import { BitcasterDB } from "../../stores/proof-db";

const CONDITION_ID = "ab".repeat(32);
const OUTCOME_COLLECTION = "YES";
const COORDINATOR_PUBLIC_KEY = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const MINT_PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 1]);
const MINT_PUBLIC_KEY = bytesToHex(secp256k1.getPublicKey(MINT_PRIVATE_KEY, true));
const KEYS = Object.fromEntries(
  Array.from({ length: 20 }, (_, index) => [(1 << index).toString(), MINT_PUBLIC_KEY]),
);
const INPUT_FEE_PPK = 100;
const FINAL_EXPIRY = 1_000;
const MINT_URL = "https://mint.example";
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
});
const REGULAR_KEYSET_ID = deriveKeysetId(KEYS, {
  unit: "msat",
  input_fee_ppk: INPUT_FEE_PPK,
  expiry: FINAL_EXPIRY,
  versionByte: 1,
});
const OUTCOME_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: "msat",
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
});
const SEED = new Uint8Array(64).fill(7);
const openDatabases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser CTF range order coordinator", () => {
  it("persists exact source authority before mint I/O and submits one verified capability", async () => {
    const database = createDatabase();
    const custody = new BrowserDurableCustodyAdapter(database);
    const preparation = persistedPreparation("range-success");
    const scopeId = walletScopeId();
    const calls: string[] = [];
    const wallet = sourceWallet({
      onComplete: async () => {
        calls.push("mint-source");
        const source = await custody.readOperation(
          walletScope(),
          custodyOperationId(preparation.sourceOperationId),
        );
        expect(source?.operation.state).toBe("transport-attempted");
        expect(
          (await readCtfRangePreparation(scopeId, preparation.operationId, database))
            ?.lifecycleState,
        ).toBe("prepared");
      },
    });
    const engine = engineMock({
      onCreate: async () => {
        calls.push("capability");
        expect(
          (
            await custody.readOperation(
              walletScope(),
              custodyOperationId(preparation.sourceOperationId),
            )
          )?.operation.state,
        ).toBe("reconciled");
        expect(
          await custody.readOperation(walletScope(), custodyOperationId(preparation.operationId)),
        ).not.toBeNull();
      },
      onSubmit: async () => {
        calls.push("submit");
      },
    });
    const coordinator = createCoordinator(database, wallet, engine);

    const response = await coordinator.prepareAndSubmit({
      seed: SEED,
      preparation,
      candidates: [sourceProof(preparation.offerKeyset.id)],
    });

    expect(response.orderId).toBe("44444444-4444-4444-8444-444444444444");
    expect(calls).toEqual(["mint-source", "capability", "submit"]);
    expect(
      (
        await custody.readOperation(
          walletScope(),
          custodyOperationId(preparation.sourceOperationId),
        )
      )?.operation.state,
    ).toBe("reconciled");
    expect(
      (await custody.readOperation(walletScope(), custodyOperationId(preparation.operationId)))
        ?.operation.state,
    ).toBe("dispatch-intent");
    const journal = await readCtfRangePreparation(scopeId, preparation.operationId, database);
    expect(journal?.lifecycleState).toBe("order-submitted");
    expect(journal?.capability?.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("recovers an exact uncertain mint source without creating or submitting a capability", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-uncertain");
    let completeCalls = 0;
    const wallet = sourceWallet({
      onComplete: async () => {
        completeCalls += 1;
        if (completeCalls === 1) throw new Error(`lost response ${sourceProof("x").secret}`);
      },
    });
    const engine = engineMock();
    const coordinator = createCoordinator(database, wallet, engine);

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "mint-source-uncertain" });
    expect(engine.createCalls).toBe(0);
    expect(engine.submitCalls).toBe(0);

    const recovered = await coordinator.recoverPage({ seed: SEED, limit: 8 });

    expect(recovered.recoveredOperationIds).toEqual([]);
    expect(recovered.pending).toEqual([
      { operationId: preparation.operationId, code: "recovery-pending" },
    ]);
    expect(completeCalls).toBe(2);
    expect(engine.createCalls).toBe(0);
    expect(engine.submitCalls).toBe(0);
    const custody = new BrowserDurableCustodyAdapter(database);
    expect(
      (
        await custody.readOperation(
          walletScope(),
          custodyOperationId(preparation.sourceOperationId),
        )
      )?.operation.state,
    ).toBe("reconciled");
    expect(
      (await custody.readOperation(walletScope(), custodyOperationId(preparation.operationId)))
        ?.operation.state,
    ).toBe("dispatch-intent");
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("prepared");
  });

  it("restores exact persisted outputs when uncertain source inputs are spent", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-source-restore");
    let completeCalls = 0;
    const wallet = sourceWallet({
      inputState: "SPENT",
      onComplete: async () => {
        completeCalls += 1;
        throw new Error("lost mint response");
      },
    });
    const engine = engineMock();
    const coordinator = createCoordinator(database, wallet, engine, {
      restoreOutputs: restoreSignedOutputGroups,
    });

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "mint-source-uncertain" });

    const recovery = await coordinator.recoverPage({ seed: SEED, limit: 8 });

    expect(recovery.recoveredOperationIds).toEqual([]);
    expect(recovery.pending).toEqual([
      { operationId: preparation.operationId, code: "recovery-pending" },
    ]);
    expect(completeCalls).toBe(1);
    expect(engine.createCalls).toBe(0);
    expect(engine.submitCalls).toBe(0);
    const custody = new BrowserDurableCustodyAdapter(database);
    expect(
      (
        await custody.readOperation(
          walletScope(),
          custodyOperationId(preparation.sourceOperationId),
        )
      )?.operation.state,
    ).toBe("reconciled");
    expect(
      (await custody.readOperation(walletScope(), custodyOperationId(preparation.operationId)))
        ?.operation.state,
    ).toBe("dispatch-intent");
  });

  it("atomically releases exact unspent source proofs at expiry", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-source-expired");
    let now = 20_000;
    const coordinator = createCoordinator(
      database,
      sourceWallet({ onComplete: async () => Promise.reject(new Error("uncertain")) }),
      engineMock(),
      { now: () => now },
    );
    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "mint-source-uncertain" });

    now = preparation.expiry * 1_000;
    const recovery = await coordinator.recoverPage({ seed: SEED, limit: 8 });

    expect(recovery.recoveredOperationIds).toEqual([preparation.operationId]);
    expect(recovery.pending).toEqual([]);
    expect(
      (
        await new BrowserDurableCustodyAdapter(database).readOperation(
          walletScope(),
          custodyOperationId(preparation.sourceOperationId),
        )
      )?.operation.state,
    ).toBe("aborted");
    expect(await database.custodyReservations.count()).toBe(0);
    expect((await database.custodyProofs.toArray()).map((proof) => proof.selectability)).toEqual([
      "selectable",
    ]);
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("terminal");
  });

  it("never retries submission after a lost order acknowledgement", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-submit-lost");
    const wallet = sourceWallet();
    const engine = engineMock({ submitFailure: true, orderStatus: discoveredOrderStatus() });
    const coordinator = createCoordinator(database, wallet, engine);

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "order-submission-uncertain" });
    expect(engine.createCalls).toBe(1);
    expect(engine.submitCalls).toBe(1);
    expect(engine.statusCalls).toBe(0);

    const recovery = await coordinator.recoverPage({ seed: SEED, limit: 8 });

    expect(recovery.pending).toEqual([
      { operationId: preparation.operationId, code: "recovery-pending" },
    ]);
    expect(engine.createCalls).toBe(1);
    expect(engine.submitCalls).toBe(1);
    expect(engine.statusCalls).toBe(1);
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("order-submitted");
  });

  it("does not bind or submit a foreign engine capability", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-foreign-capability");
    const engine = engineMock({ foreignCapability: true });
    const coordinator = createCoordinator(database, sourceWallet(), engine);

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "capability-validation-failed" });

    expect(engine.createCalls).toBe(1);
    expect(engine.submitCalls).toBe(0);
    const journal = await readCtfRangePreparation(
      walletScopeId(),
      preparation.operationId,
      database,
    );
    expect(journal?.lifecycleState).toBe("prepared");
    expect(journal?.capability).toBeNull();
  });

  it("marks only a classified definitive submission rejection as rejected", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-definitive-rejection");
    const engine = engineMock({ submitFailure: true });
    const coordinator = createCoordinator(database, sourceWallet(), engine, {
      isDefinitiveOrderRejection: () => true,
    });

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "order-submission-rejected" });

    expect(engine.submitCalls).toBe(1);
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("submission-rejected");
  });

  it("does not classify a foreign submit response as a definitive rejection", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-foreign-submit");
    const engine = engineMock({ foreignOrderResponse: true });
    const coordinator = createCoordinator(database, sourceWallet(), engine, {
      isDefinitiveOrderRejection: () => true,
    });

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "order-submission-uncertain" });

    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("capability-bound");
  });

  it("keeps a matching but resting immediate-order response uncertain", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-resting-submit");
    const coordinator = createCoordinator(
      database,
      sourceWallet(),
      engineMock({ restingOrderResponse: true }),
    );

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "order-submission-uncertain" });

    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("capability-bound");
  });

  it.each([
    ["partial FOK", "FOK", { status: "partially_filled" }],
    ["foreign divisibility", "FAK", { divisibility: 1_000_000 }],
  ] as const)("keeps a %s response uncertain", async (_label, timeInForce, submitResponse) => {
    const database = createDatabase();
    const preparation = persistedPreparation(`range-${timeInForce}-invalid-submit`, timeInForce);
    const coordinator = createCoordinator(database, sourceWallet(), engineMock({ submitResponse }));

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "order-submission-uncertain" });
  });

  it("does not classify a post-submit journal failure as a definitive rejection", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-journal-failure");
    const engine = engineMock({
      onSubmit: async () => {
        database.ctfRangePreparations.hook("updating", () => {
          throw new Error("injected journal failure");
        });
      },
    });
    const coordinator = createCoordinator(database, sourceWallet(), engine, {
      isDefinitiveOrderRejection: () => true,
    });

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "order-submission-uncertain" });

    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("capability-bound");
  });

  it("propagates durable preparation corruption instead of hiding it as pending", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-corrupt");
    const coordinator = createCoordinator(
      database,
      sourceWallet({ onComplete: async () => Promise.reject(new Error("uncertain")) }),
      engineMock(),
    );
    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "mint-source-uncertain" });
    await database.ctfRangePreparations.update([walletScopeId(), preparation.operationId], {
      preparationBytes: new Uint8Array([0]),
    });

    await expect(coordinator.recoverPage({ seed: SEED, limit: 8 })).rejects.toThrow();
  });

  it("propagates a foreign discovered order status", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-foreign-status");
    const foreignStatus = { ...discoveredOrderStatus(), marketId: `${CONDITION_ID}-NO` };
    const engine = engineMock({ submitFailure: true, orderStatus: foreignStatus });
    const coordinator = createCoordinator(database, sourceWallet(), engine);
    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "order-submission-uncertain" });

    await expect(coordinator.recoverPage({ seed: SEED, limit: 8 })).rejects.toThrow(
      "foreign range order status",
    );
  });

  it("accepts FOK and acquires the exact exclusive profile lock", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-fok", "FOK");
    const locks: Array<{ name: string; mode: LockMode | undefined }> = [];
    const coordinator = createCoordinator(database, sourceWallet(), engineMock(), {
      lockManager: recordingLockManager(locks),
    });

    await coordinator.prepareAndSubmit({
      seed: SEED,
      preparation,
      candidates: [sourceProof(preparation.offerKeyset.id)],
    });

    expect(locks).toEqual([
      { name: `bitcaster:wallet-profile:${walletScopeId()}`, mode: "exclusive" },
    ]);
  });

  it("rejects an invalid recovery page limit", async () => {
    const coordinator = createCoordinator(createDatabase(), sourceWallet(), engineMock());
    await expect(coordinator.recoverPage({ seed: SEED, limit: 0 })).rejects.toThrow();
  });

  it("rejects an aggregate source result above 512 proofs before decoding", () => {
    const proof = { id: "invalid", amount: 1, secret: "s", C: "c" };
    expect(() =>
      decodeBrowserPersistedSourceResult({
        schemaVersion: 1,
        authorization: Array<unknown>(257).fill(proof),
        keep: Array<unknown>(256).fill(proof),
      }),
    ).toThrow("aggregate proof limit");
  });

  it("rejects GTC before any durable or network mutation", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-gtc", "GTC");
    const engine = engineMock();
    const coordinator = createCoordinator(database, sourceWallet(), engine);

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toBeInstanceOf(BrowserCtfRangeOrderError);
    expect(await database.ctfRangePreparations.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(engine.createCalls).toBe(0);
  });
});

function createCoordinator(
  database: BitcasterDB,
  wallet: ReturnType<typeof sourceWallet>,
  engine: ReturnType<typeof engineMock>,
  options: {
    isDefinitiveOrderRejection?: (error: unknown) => boolean;
    lockManager?: Pick<LockManager, "request">;
    restoreOutputs?: BrowserCtfRangeOrderCoordinatorDependencies["restoreOutputs"];
    now?: () => number;
  } = {},
) {
  let now = 20_000;
  return new BrowserCtfRangeOrderCoordinator({
    database,
    custody: new BrowserDurableCustodyAdapter(database),
    wallet,
    engine,
    now: options.now ?? (() => now++),
    randomId: () => crypto.randomUUID(),
    lockManager: options.lockManager ?? immediateLockManager(),
    ...(options.isDefinitiveOrderRejection === undefined
      ? {}
      : { isDefinitiveOrderRejection: options.isDefinitiveOrderRejection }),
    ...(options.restoreOutputs === undefined ? {} : { restoreOutputs: options.restoreOutputs }),
  });
}

function sourceWallet(
  input: {
    onComplete?: () => Promise<void>;
    inputState?: ProofState["state"];
  } = {},
) {
  return {
    async prepareSwapToSend(
      amount: number,
      proofs: Proof[],
      config: { includeFees: false; keysetId: string },
      outputs: { send: { type: "custom"; data: OutputData[] }; keep: { type: "random" } },
    ): Promise<SwapPreview> {
      return {
        amount: Amount.from(amount),
        fees: Amount.from(1),
        keysetId: config.keysetId,
        inputs: proofs,
        sendOutputs: outputs.send.data,
        keepOutputs: [],
        unselectedProofs: [],
      };
    },
    async completeSwap(preview: SwapPreview): Promise<{ keep: Proof[]; send: Proof[] }> {
      await input.onComplete?.();
      return { keep: [], send: (preview.sendOutputs ?? []).map(signOutput) };
    },
    async prepareConditionalSwap(): Promise<ConditionalSwapPreview> {
      throw new Error("unexpected conditional source");
    },
    async completeConditionalSwap(): Promise<Record<string, Proof[]>> {
      throw new Error("unexpected conditional source");
    },
    async checkProofsStates(proofs: Array<Pick<Proof, "id" | "secret">>) {
      return proofs.map(
        (_, index): ProofState => ({
          Y: `source-y-${index}`,
          state: input.inputState ?? "UNSPENT",
          witness: null,
        }),
      );
    },
  };
}

const restoreSignedOutputGroups: typeof restoreOutputGroups = async (_mintUrl, groups) =>
  Object.fromEntries(
    Object.entries(groups).map(([label, outputs]) => [
      label,
      outputs.map((output) => signOutput(deserializeDurableCustodyOutput(output))),
    ]),
  );

function engineMock(
  input: {
    onCreate?: (request: CreateSettlementCapabilityRequest) => Promise<void>;
    onSubmit?: (request: SubmitOrderRequest) => Promise<void>;
    submitFailure?: boolean;
    orderStatus?: OrderStatusResponse | null;
    foreignCapability?: boolean;
    foreignOrderResponse?: boolean;
    restingOrderResponse?: boolean;
    submitResponse?: Partial<SubmitOrderResponse>;
  } = {},
): BrowserCtfRangeEngine & {
  createCalls: number;
  submitCalls: number;
  statusCalls: number;
} {
  return {
    createCalls: 0,
    submitCalls: 0,
    statusCalls: 0,
    async createSettlementCapability(request) {
      this.createCalls += 1;
      await input.onCreate?.(request);
      const artifact = decodeSettlementCapabilityArtifactBytes(base64Bytes(request.artifact));
      const digest = deriveSettlementCapabilityArtifactDigest(artifact);
      return capabilityResponse(
        request,
        input.foreignCapability === true ? "ff".repeat(32) : digest,
      );
    },
    async submitOrder(_marketId, request) {
      this.submitCalls += 1;
      await input.onSubmit?.(request);
      if (input.submitFailure === true) throw new Error("lost acknowledgement");
      const response = { ...submitResponse(), ...input.submitResponse };
      if (input.foreignOrderResponse === true) {
        return { ...response, orderId: "55555555-5555-4555-8555-555555555555" };
      }
      return input.restingOrderResponse === true
        ? { ...response, status: "resting", remainingAmountSubunits: 10_000 }
        : response;
    },
    async getOrderStatus() {
      this.statusCalls += 1;
      return input.orderStatus ?? null;
    },
  };
}

function capabilityResponse(
  request: CreateSettlementCapabilityRequest,
  artifactDigest: string,
): SettlementCapabilityResponse {
  return {
    reference: {
      artifactId: "11111111-1111-4111-8111-111111111111",
      bindingDigest: "22".repeat(32),
    },
    orderId: "44444444-4444-4444-8444-444444444444",
    clientOrderId: request.clientOrderId,
    marketId: request.marketId,
    artifactDigest,
    state: "bound",
    version: 1,
    authorizationExpiresAt: "2026-07-31T10:00:00.000Z",
    stageExpiresAt: "2026-07-31T10:00:00.000Z",
    settlementGroup: null,
  };
}

function submitResponse(): SubmitOrderResponse {
  return {
    orderId: "44444444-4444-4444-8444-444444444444",
    status: "filled",
    remainingAmountSubunits: 0,
    fills: [],
    pendingPubkeySubmissions: [],
    baseAsset: "sat",
    divisibility: 10_000,
    activeSettlementGroup: null,
  };
}

function discoveredOrderStatus(): OrderStatusResponse {
  return {
    orderId: "44444444-4444-4444-8444-444444444444",
    marketId: `${CONDITION_ID}-YES`,
    status: "resting",
    remainingAmountSubunits: 10_000,
    filledAmountSubunits: 0,
    fills: [],
    tokenSide: "Outcome",
    baseAsset: "sat",
    divisibility: 10_000,
    activeSettlementGroup: null,
  };
}

function persistedPreparation(operationId: string, timeInForce: "FAK" | "FOK" | "GTC" = "FAK") {
  return buildPersistedCtfRangeOrderPreparation({
    request: rangeRequest(timeInForce),
    coordinatorPublicKey: COORDINATOR_PUBLIC_KEY,
    mintFacts: reviewedMintFacts(),
    market: {
      outcomes: [
        { id: "yes-id", label: "YES" },
        { id: "no-id", label: "NO" },
      ],
    },
    nowUnixSeconds: 20,
    randomId: sequentialId(operationId, `${operationId}:authorization`),
  });
}

function rangeRequest(timeInForce: "FAK" | "FOK" | "GTC"): CtfRangeOrderRequest {
  return {
    clientOrderId: `client-${timeInForce.toLowerCase()}`,
    marketId: `${CONDITION_ID}-YES`,
    conditionId: CONDITION_ID,
    outcomeId: "yes-id",
    tokenSide: "Outcome",
    side: "Buy",
    price: 2,
    amountSubunits: 10_000,
    baseAsset: "sat",
    collateralUnit: "msat",
    divisibility: 10_000,
    timeInForce,
    expiresAt: null,
    mintUrl: MINT_URL,
  };
}

function reviewedMintFacts() {
  return {
    regular: [
      {
        canonicalMintUrl: MINT_URL,
        id: REGULAR_KEYSET_ID,
        unit: "msat" as const,
        active: true as const,
        keys: KEYS,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
      },
    ],
    conditional: [
      {
        canonicalMintUrl: MINT_URL,
        id: OUTCOME_KEYSET_ID,
        unit: "msat" as const,
        active: true as const,
        keys: KEYS,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
        conditionId: CONDITION_ID,
        outcomeCollection: OUTCOME_COLLECTION,
        outcomeCollectionId: OUTCOME_COLLECTION_ID,
      },
    ],
    maxInputs: 64,
    maxPoolEntries: 128,
    observation: {
      canonicalMintUrl: MINT_URL,
      freshness: "fresh" as const,
      observedAt: 20,
      maxExpirySeconds: FINAL_EXPIRY,
      conditionKeysetIds: [OUTCOME_KEYSET_ID],
      conditionalKeysets: [
        {
          keysetId: OUTCOME_KEYSET_ID,
          conditionId: CONDITION_ID,
          unit: "msat",
          inputFeePpk: INPUT_FEE_PPK,
          finalExpiry: FINAL_EXPIRY,
          outcomeCollectionId: OUTCOME_COLLECTION_ID,
          keys: KEYS,
        },
      ],
    },
  };
}

function sourceProof(keysetId: string): Proof {
  return { id: keysetId, amount: Amount.from(4), secret: "source-proof", C: MINT_PUBLIC_KEY };
}

function signOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    MINT_PRIVATE_KEY,
    output.blindedMessage.id,
  );
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), MINT_PRIVATE_KEY);
  return output.toProof(
    {
      id: signature.id,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: output.blindedMessage.id, keys: KEYS },
  );
}

function walletScope() {
  const walletId = deriveDurableCustodyWalletId(SEED);
  return {
    scopeKind: "wallet" as const,
    walletId,
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId }),
  };
}

function walletScopeId(): string {
  return walletScope().scopeId;
}

function custodyOperationId(retainedOperationKey: string): string {
  const scope = walletScope();
  return deriveDurableCustodyOperationId(scope.scopeId, {
    retainedOperationKey,
    binding: { kind: "wallet", activityId: retainedOperationKey, stage: "send" },
  });
}

function immediateLockManager(): Pick<LockManager, "request"> {
  return {
    request: (async (_name: string, _options: LockOptions, callback: (lock: Lock) => unknown) =>
      callback({ name: "test", mode: "exclusive" } as Lock)) as LockManager["request"],
  };
}

function recordingLockManager(
  calls: Array<{ name: string; mode: LockMode | undefined }>,
): Pick<LockManager, "request"> {
  return {
    request: (async (name: string, options: LockOptions, callback: (lock: Lock) => unknown) => {
      calls.push({ name, mode: options.mode });
      return callback({ name, mode: "exclusive" } as Lock);
    }) as LockManager["request"],
  };
}

function base64Bytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function sequentialId(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? "unexpected-id";
}

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`bitcaster-browser-range-${crypto.randomUUID()}`);
  openDatabases.push(database);
  return database;
}
