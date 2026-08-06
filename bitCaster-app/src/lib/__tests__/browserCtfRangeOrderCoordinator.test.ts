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
  hashToCurve,
  OutputData,
  pointFromHex,
  selectCtfRangeAmounts,
  type ConditionalSwapPreview,
  type CounterSource,
  type Proof,
  type ProofState,
  type SerializedBlindedMessage,
  type SerializedBlindedSignature,
  type SwapPreview,
} from "@cashu/cashu-ts";
import { deserializeDurableCustodyOutput } from "@bitcaster/client-sdk/durableCustodyProofOperation";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  CtfRangeRecoveryTransportError,
  restoreDurableCtfRangeRefundOutputs,
} from "@bitcaster/client-sdk/ctfRangeRecoveryTransport";
import { deserializeOutputGroups, type restoreOutputGroups } from "@bitcaster/client-sdk/ctfSplit";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyOperationId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import {
  buildDurableCtfRangeRecoveryQuery,
  createDurableCtfRangeResultEnvelope,
  deriveDurableCtfRangeRefundOperationId,
  deriveRootCtfOutcomeCollectionId,
  type DurableCtfRangeAllManifestRecovery,
  type DurableCtfRangeOperation,
} from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  buildPersistedCtfRangeOrderPreparation,
  createCtfRangeOrderPreparationKeysetResolver,
  type CtfRangeOrderRequest,
  type PersistedCtfRangeOrderPreparation,
} from "@bitcaster/client-sdk/ctfRangeOrderProtocol";
import {
  decodeSettlementCapabilityArtifactBytes,
  deriveSettlementCapabilityArtifactDigest,
} from "@bitcaster/client-sdk/settlementCapabilityArtifact";
import type {
  CreateSettlementCapabilityRequest,
  OrderStatusResponse,
  SettlementCapabilityResponse,
  SettlementCapabilityResultResponse,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from "@bitcaster/client-sdk/engineClient";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  BrowserCtfRangeOrderCoordinator,
  BrowserCtfRangeOrderError,
  type BrowserCtfRangeEngine,
  type BrowserCtfRangeOrderCoordinatorDependencies,
} from "../browserCtfRangeOrderCoordinator";
import { decodeBrowserPersistedSourceResult } from "../browserCtfRangeOrderSource";
import { BrowserDurableCustodyAdapter } from "../../stores/durable-custody-db";
import {
  readCtfRangePreparation,
  readCtfRangePreparationConsolidations,
} from "../../stores/ctf-range-order-db";
import { BitcasterDB, getProofOperation, type StoredProof } from "../../stores/proof-db";

const CONDITION_ID = "ab".repeat(32);
const OUTCOME_COLLECTION = "YES";
const COMPLEMENT_COLLECTION = "NO";
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
const COMPLEMENT_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: COMPLEMENT_COLLECTION,
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
const COMPLEMENT_KEYSET_ID = deriveConditionalKeysetId({
  keys: KEYS,
  unit: "msat",
  input_fee_ppk: INPUT_FEE_PPK,
  final_expiry: FINAL_EXPIRY,
  conditionId: CONDITION_ID,
  outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
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
  it("rejects a conditional keyset without final expiry before mint dispatch", async () => {
    const preparation = persistedPreparation("range-missing-final-expiry");
    const unsupported = {
      ...preparation,
      receiveKeyset: { ...preparation.receiveKeyset, finalExpiry: null },
    } as PersistedCtfRangeOrderPreparation;
    let mintCalls = 0;
    const engine = engineMock();
    const database = createDatabase([storedSourceProof(sourceProof(unsupported.offerKeyset.id))]);
    const coordinator = createCoordinator(
      database,
      sourceWallet({
        onComplete: async () => {
          mintCalls += 1;
        },
      }),
      engine,
    );

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation: unsupported,
        candidates: [sourceProof(unsupported.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "source-preparation-failed" });

    expect(mintCalls).toBe(0);
    expect(engine.createCalls).toBe(0);
    expect(await database.proofOperations.count()).toBe(0);
  });

  it("durably consolidates one exact fragmented proof page", async () => {
    const preparation = persistedPreparation("range-consolidation");
    const inputs = [
      sourceProof(preparation.offerKeyset.id, 2, "fragment-a"),
      sourceProof(preparation.offerKeyset.id, 2, "fragment-b"),
      sourceProof(preparation.offerKeyset.id, 2, "fragment-c"),
    ];
    const database = createDatabase(inputs.map((proof) => storedSourceProof(proof)));
    const contexts: [string, string, string][] = [];
    const coordinator = createCoordinator(database, sourceWallet(), engineMock(), {
      createCounterSource: (scopeId, mintUrl, unit) => {
        contexts.push([scopeId, mintUrl, unit]);
        return inMemoryCounterSource();
      },
    });

    await coordinator.consolidateRound({
      seed: SEED,
      preparation,
      round: 0,
      inputs,
      plannedRound: { inputs: ["2", "2", "2"], outputs: ["4", "1"], fee: "1" },
    });

    const operationId = `${preparation.sourceOperationId}:consolidation:0`;
    expect(await getProofOperation(operationId, database)).toMatchObject({ state: "completed" });
    expect(
      await readCtfRangePreparationConsolidations(
        walletScopeId(),
        preparation.operationId,
        database,
      ),
    ).toEqual([expect.objectContaining({ round: 0, operationId, reservationId: operationId })]);
    expect(
      (await database.proofs.toArray())
        .map(({ amount }) => amountToNumber(amount))
        .sort((left, right) => right - left),
    ).toEqual([4, 1]);
    expect(contexts).toEqual([
      [walletScopeId(), preparation.mintUrl, preparation.offerKeyset.unit],
    ]);
  });

  it("restores an exact committed consolidation after local completion is interrupted", async () => {
    const preparation = persistedPreparation("range-consolidation-recovery");
    const inputs = [
      sourceProof(preparation.offerKeyset.id, 2, "fragment-a"),
      sourceProof(preparation.offerKeyset.id, 2, "fragment-b"),
      sourceProof(preparation.offerKeyset.id, 2, "fragment-c"),
    ];
    const database = createDatabase(inputs.map((proof) => storedSourceProof(proof)));
    const interrupted = createCoordinator(
      database,
      sourceWallet({ onComplete: async () => Promise.reject(new Error("local crash")) }),
      engineMock(),
    );

    await expect(
      interrupted.consolidateRound({
        seed: SEED,
        preparation,
        round: 0,
        inputs,
        plannedRound: { inputs: ["2", "2", "2"], outputs: ["4", "1"], fee: "1" },
      }),
    ).rejects.toMatchObject({ code: "mint-source-uncertain" });

    const incomplete = createCoordinator(
      database,
      sourceWallet({ inputState: "SPENT" }),
      engineMock(),
      { restoreOutputs: async () => ({}) },
    );
    await expect(incomplete.recoverPage({ seed: SEED, limit: 8 })).resolves.toMatchObject({
      recoveredOperationIds: [],
      pending: [expect.objectContaining({ operationId: preparation.operationId })],
    });
    expect(
      await getProofOperation(`${preparation.sourceOperationId}:consolidation:0`, database),
    ).toMatchObject({ state: "prepared" });
    expect((await database.proofs.toArray()).filter(({ reservedBy }) => reservedBy).length).toBe(3);

    const recovered = createCoordinator(
      database,
      sourceWallet({ inputState: "SPENT" }),
      engineMock(),
      {
        restoreOutputs: async (_mintUrl, groups) =>
          Object.fromEntries(
            Object.entries(deserializeOutputGroups(groups)).map(([label, outputs]) => [
              label,
              outputs.map(signOutput),
            ]),
          ),
      },
    );
    await expect(recovered.recoverPage({ seed: SEED, limit: 8 })).resolves.toMatchObject({
      recoveredOperationIds: [preparation.operationId],
      pending: [],
    });
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("terminal");
    expect(
      (await database.proofs.toArray())
        .map(({ amount }) => amountToNumber(amount))
        .sort((left, right) => right - left),
    ).toEqual([4, 1]);
  });

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
          sourceCustodyOperationId(preparation.sourceOperationId),
        );
        expect(source?.operation.state).toBe("transport-attempted");
        expect(
          (await readCtfRangePreparation(scopeId, preparation.operationId, database))
            ?.lifecycleState,
        ).toBe("prepared");
        expect(await database.proofs.get("source-proof")).toMatchObject({
          reservedBy: sourceCustodyOperationId(preparation.sourceOperationId),
        });
      },
    });
    const engine = engineMock({
      onCreate: async () => {
        calls.push("capability");
        expect(
          (
            await custody.readOperation(
              walletScope(),
              sourceCustodyOperationId(preparation.sourceOperationId),
            )
          )?.operation.state,
        ).toBe("reconciled");
        expect(
          await custody.readOperation(walletScope(), custodyOperationId(preparation.operationId)),
        ).not.toBeNull();
      },
      onSubmit: async (request) => {
        calls.push("submit");
        expect(request.walletId).toBe(walletScope().walletId);
      },
    });
    const contexts: [string, string, string][] = [];
    const coordinator = createCoordinator(database, wallet, engine, {
      createCounterSource: (scopeId, mintUrl, unit) => {
        contexts.push([scopeId, mintUrl, unit]);
        return inMemoryCounterSource();
      },
    });

    const response = await coordinator.prepareAndSubmit({
      seed: SEED,
      preparation,
      candidates: [sourceProof(preparation.offerKeyset.id)],
    });

    expect(response.orderId).toBe("44444444-4444-4444-8444-444444444444");
    expect(calls).toEqual(["mint-source", "capability", "submit"]);
    expect(contexts).toEqual([
      [walletScopeId(), preparation.mintUrl, preparation.offerKeyset.unit],
    ]);
    expect(
      (
        await custody.readOperation(
          walletScope(),
          sourceCustodyOperationId(preparation.sourceOperationId),
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
    const mirroredProofs = await database.proofs.toArray();
    expect(mirroredProofs.some(({ secret }) => secret === "source-proof")).toBe(false);
    expect(mirroredProofs.length).toBeGreaterThan(0);
    expect(
      mirroredProofs.every(
        ({ reservedBy }) => reservedBy === custodyOperationId(preparation.operationId),
      ),
    ).toBe(true);
  });

  it("keeps complementary Sell change selectable with multi-input authorization", async () => {
    const preparation = persistedPreparation("range-sell-complement", "FAK", {
      side: "Sell",
      tokenSide: "Complement",
    });
    expect(preparation.offerKeyset.id).toBe(COMPLEMENT_KEYSET_ID);
    const sourceProofs = [
      sourceProof(preparation.offerKeyset.id, 5_001, "sell-source-a"),
      sourceProof(preparation.offerKeyset.id, 5_001, "sell-source-b"),
    ];
    const database = createDatabase(
      sourceProofs.map((proof) =>
        storedSourceProof(proof, {
          conditionId: CONDITION_ID,
          outcomeCollection: COMPLEMENT_COLLECTION,
        }),
      ),
    );
    const coordinator = createCoordinator(database, sourceWallet(), engineMock());

    await coordinator.prepareAndSubmit({ seed: SEED, preparation, candidates: sourceProofs });

    const outerOperationId = custodyOperationId(preparation.operationId);
    const legacyProofs = await database.proofs.toArray();
    expect(legacyProofs.some(({ reservedBy }) => reservedBy === outerOperationId)).toBe(true);
    expect(legacyProofs.some(({ reservedBy }) => reservedBy === undefined)).toBe(true);
    expect(
      legacyProofs.every(
        ({ conditionId, outcomeCollection }) =>
          conditionId === CONDITION_ID && outcomeCollection === COMPLEMENT_COLLECTION,
      ),
    ).toBe(true);
    expect(legacyProofs.map(({ secret }) => secret)).not.toContain("sell-source-a");
    expect(legacyProofs.map(({ secret }) => secret)).not.toContain("sell-source-b");
    const custodyProofs = await database.custodyProofs.toArray();
    const backupAuthorities = new Map(
      (await database.custodyProofBackupAuthorities.toArray()).map((row) => [row.proofId, row]),
    );
    expect(custodyProofs.filter(({ selectability }) => selectability === "spent")).toHaveLength(2);
    expect(custodyProofs.some(({ selectability }) => selectability === "locked")).toBe(true);
    expect(custodyProofs.some(({ selectability }) => selectability === "selectable")).toBe(true);
    expect(
      custodyProofs
        .filter(({ selectability }) => selectability === "locked")
        .every(({ proofId }) => {
          const authority = backupAuthorities.get(proofId);
          return authority?.derivationLocator === null;
        }),
    ).toBe(true);
    expect(
      custodyProofs
        .filter(({ selectability }) => selectability === "selectable")
        .every(({ proofId }) => {
          const authority = backupAuthorities.get(proofId);
          return (
            authority?.derivationLocator?.kind === "nut13" &&
            authority.derivationLocator.keysetId === preparation.offerKeyset.id &&
            Number.isSafeInteger(authority.derivationLocator.counter)
          );
        }),
    ).toBe(true);
  });

  it("rolls back durable source preparation when the legacy proof mirror is missing", async () => {
    const database = createDatabase();
    await database.open();
    await database.proofs.clear();
    const preparation = persistedPreparation("range-missing-proof-mirror");
    const engine = engineMock();
    const coordinator = createCoordinator(database, sourceWallet(), engine);

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "custody-commit-failed" });

    expect(await database.ctfRangePreparations.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.custodyArtifacts.count()).toBe(0);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.custodyReservations.count()).toBe(0);
    expect(engine.createCalls).toBe(0);
    expect(engine.submitCalls).toBe(0);
  });

  it("rolls back durable source application when legacy proof replacement fails", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-proof-replacement-fault");
    database.proofs.hook("deleting", () => {
      throw new Error("injected legacy proof deletion failure");
    });
    const engine = engineMock();
    const coordinator = createCoordinator(database, sourceWallet(), engine);

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "custody-commit-failed" });

    const custody = new BrowserDurableCustodyAdapter(database);
    expect(
      (
        await custody.readOperation(
          walletScope(),
          sourceCustodyOperationId(preparation.sourceOperationId),
        )
      )?.operation.result.state,
    ).toBe("verified-staged");
    expect(
      await custody.readOperation(walletScope(), custodyOperationId(preparation.operationId)),
    ).toBeNull();
    expect(await database.proofs.get("source-proof")).toMatchObject({
      reservedBy: sourceCustodyOperationId(preparation.sourceOperationId),
    });
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("prepared");
    expect(engine.createCalls).toBe(0);
    expect(engine.submitCalls).toBe(0);
  });

  it("recovers an exact uncertain mint source without creating or submitting a capability", async () => {
    const preparation = persistedPreparation("range-uncertain");
    const candidate = sourceProof(preparation.offerKeyset.id, 16);
    const database = createDatabase([storedSourceProof(candidate)]);
    let completeCalls = 0;
    const wallet = sourceWallet({
      onComplete: async () => {
        completeCalls += 1;
        if (completeCalls === 1) throw new Error(`lost response ${sourceProof("x").secret}`);
      },
    });
    const engine = engineMock();
    let reservations = 0;
    const coordinator = createCoordinator(database, wallet, engine, {
      counterSource: inMemoryCounterSource(() => {
        reservations += 1;
      }),
    });

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [candidate],
      }),
    ).rejects.toMatchObject({ code: "mint-source-uncertain" });
    expect(engine.createCalls).toBe(0);
    expect(engine.submitCalls).toBe(0);
    expect(reservations).toBe(1);

    const recovered = await coordinator.recoverPage({ seed: SEED, limit: 8 });

    expect(recovered.recoveredOperationIds).toEqual([]);
    expect(recovered.pending).toMatchObject([
      { operationId: preparation.operationId, code: "recovery-pending" },
    ]);
    expect(completeCalls).toBe(2);
    expect(engine.createCalls).toBe(0);
    expect(engine.submitCalls).toBe(0);
    expect(reservations).toBe(1);
    const custody = new BrowserDurableCustodyAdapter(database);
    expect(
      (
        await custody.readOperation(
          walletScope(),
          sourceCustodyOperationId(preparation.sourceOperationId),
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

  it("does not persist a source operation before counter recovery is ready", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-counter-recovery-pending");
    const engine = engineMock();
    const counterSource = inMemoryCounterSource();
    counterSource.reserve = async () => {
      throw new Error("The wallet counter recovery is incomplete.");
    };
    const coordinator = createCoordinator(database, sourceWallet(), engine, { counterSource });

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id, 16)],
      }),
    ).rejects.toMatchObject({ code: "source-preparation-failed" });

    expect(await database.ctfRangePreparations.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(engine.createCalls).toBe(0);
    expect(engine.submitCalls).toBe(0);
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
    expect(recovery.pending).toMatchObject([
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
          sourceCustodyOperationId(preparation.sourceOperationId),
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
          sourceCustodyOperationId(preparation.sourceOperationId),
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
    const [releasedProof] = await database.proofs.toArray();
    expect(releasedProof?.secret).toBe("source-proof");
    expect(releasedProof).not.toHaveProperty("reservedBy");
  });

  it("rolls back expiry release when the legacy proof mirror cannot be released", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-source-release-fault");
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
    database.proofs.hook("updating", () => {
      throw new Error("injected legacy proof release failure");
    });

    now = preparation.expiry * 1_000;
    await expect(coordinator.recoverPage({ seed: SEED, limit: 8 })).rejects.toThrow(
      "injected legacy proof release failure",
    );

    const custody = new BrowserDurableCustodyAdapter(database);
    expect(
      (
        await custody.readOperation(
          walletScope(),
          sourceCustodyOperationId(preparation.sourceOperationId),
        )
      )?.operation.state,
    ).toBe("transport-attempted");
    expect(await database.custodyReservations.count()).toBe(1);
    expect((await database.custodyProofs.toArray()).map((proof) => proof.selectability)).toEqual([
      "locked",
    ]);
    expect(await database.proofs.get("source-proof")).toMatchObject({
      reservedBy: sourceCustodyOperationId(preparation.sourceOperationId),
    });
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("prepared");
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

    expect(recovery.pending).toMatchObject([
      { operationId: preparation.operationId, code: "recovery-pending" },
    ]);
    expect(engine.createCalls).toBe(1);
    expect(engine.submitCalls).toBe(1);
    expect(engine.statusCalls).toBe(1);
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("order-submitted");
    expect(
      (await database.proofs.toArray()).every(
        ({ reservedBy }) => reservedBy === custodyOperationId(preparation.operationId),
      ),
    ).toBe(true);
  });

  it("retries only the exact persisted capability request after a lost response", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-capability-lost");
    const requests: CreateSettlementCapabilityRequest[] = [];
    let failResponse = true;
    const engine = engineMock({
      onCreate: async (request) => {
        requests.push(structuredClone(request));
        if (failResponse) {
          failResponse = false;
          throw new Error("lost capability response");
        }
      },
    });
    const coordinator = createCoordinator(database, sourceWallet(), engine);

    await expect(
      coordinator.prepareAndSubmit({
        seed: SEED,
        preparation,
        candidates: [sourceProof(preparation.offerKeyset.id)],
      }),
    ).rejects.toMatchObject({ code: "capability-creation-failed" });
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("capability-requested");

    const recovery = await coordinator.recoverPage({ seed: SEED, limit: 8 });

    expect(recovery.pending).toMatchObject([
      { operationId: preparation.operationId, code: "recovery-pending" },
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(engine.createCalls).toBe(2);
    expect(engine.submitCalls).toBe(0);
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("capability-bound");
  });

  it("isolates a transient outer recovery failure from the next page record", async () => {
    const first = persistedPreparation("range-page-first");
    const second = persistedPreparation("range-page-second");
    const firstProof = sourceProof(first.offerKeyset.id, 4, "page-source-first");
    const secondProof = sourceProof(second.offerKeyset.id, 4, "page-source-second");
    const database = createDatabase([
      storedSourceProof(firstProof),
      storedSourceProof(secondProof),
    ]);
    const preparations = new Map([
      [first.operationId, first],
      [second.operationId, second],
    ]);
    const coordinator = createCoordinator(database, sourceWallet(), engineMock(), {
      createMintRecovery: (operation) => {
        const preparation = preparations.get(operation.operationId);
        if (preparation === undefined) throw new Error("unexpected range operation");
        const resolveKeyset = createCtfRangeOrderPreparationKeysetResolver(preparation);
        return {
          async loadExactVerificationContext() {
            throw new Error("unexpected exact result recovery");
          },
          async loadUncertainRecoveryObservation(input) {
            if (operation.operationId === first.operationId) {
              throw new CtfRangeRecoveryTransportError(
                "injected NUT-09 transport failure",
                new Error("offline"),
              );
            }
            const allManifestRecovery = {
              queriedOutputs: buildDurableCtfRangeRecoveryQuery(operation, null).outputs,
              restoredOutputs: [],
              signatures: [],
              queryCompleted: false,
            };
            return {
              allManifestRecovery,
              resolveKeyset,
              observation: {
                selection: input.selection,
                inputStates: [],
                ...allManifestRecovery,
                now: input.now,
              },
            };
          },
        };
      },
    });
    await coordinator.prepareAndSubmit({
      seed: SEED,
      preparation: first,
      candidates: [firstProof],
    });
    await coordinator.prepareAndSubmit({
      seed: SEED,
      preparation: second,
      candidates: [secondProof],
    });

    const recovery = await coordinator.recoverPage({ seed: SEED, limit: 8 });

    expect(recovery.recoveredOperationIds).toEqual([]);
    expect(recovery.pending).toMatchObject([
      { operationId: first.operationId, code: "recovery-pending" },
      { operationId: second.operationId, code: "recovery-pending" },
    ]);
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
    expect(journal?.lifecycleState).toBe("capability-requested");
    expect(journal?.capability).toBeNull();
    await expect(coordinator.recoverPage({ seed: SEED, limit: 8 })).resolves.toMatchObject({
      recoveredOperationIds: [],
      pending: [
        {
          operationId: preparation.operationId,
          revision: 1,
          code: "capability-validation-failed",
        },
      ],
    });
    expect(
      (await database.proofs.toArray()).every(
        ({ reservedBy }) => reservedBy === custodyOperationId(preparation.operationId),
      ),
    ).toBe(true);
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
    expect(await coordinator.recoverPage({ seed: SEED, limit: 8 })).toMatchObject({
      pending: [{ operationId: preparation.operationId, code: "recovery-pending" }],
    });
    expect(
      (await database.proofs.toArray()).every(
        ({ reservedBy }) => reservedBy === custodyOperationId(preparation.operationId),
      ),
    ).toBe(true);
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

  it("refunds the exact outer authorization after expiry and makes it selectable", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-outer-refund");
    let now = 20_000;
    let refundTransportUnavailable = true;
    const wallet = sourceWallet();
    const engine = engineMock({ resultFailure: true });
    const recoveryOptions = {
      now: () => now,
      createMintRecovery: refundableRecovery(preparation),
      executeRefundSwap: async (_mintUrl, request) => ({
        signatures: (() => {
          if (refundTransportUnavailable) {
            refundTransportUnavailable = false;
            throw new Error("refund transport is offline");
          }
          return request.outputs.map(signBlindedMessage);
        })(),
      }),
    } satisfies Parameters<typeof createCoordinator>[3];
    const coordinator = createCoordinator(database, wallet, engine, recoveryOptions);
    await coordinator.prepareAndSubmit({
      seed: SEED,
      preparation,
      candidates: [sourceProof(preparation.offerKeyset.id)],
    });

    now = preparation.expiry * 1_000;
    const restarted = createCoordinator(database, wallet, engine, recoveryOptions);
    expect(await restarted.recoverPage({ seed: SEED, limit: 8 })).toMatchObject({
      recoveredOperationIds: [],
      pending: [{ operationId: preparation.operationId, code: "recovery-pending" }],
    });
    const recovery = await restarted.recoverPage({ seed: SEED, limit: 8 });

    expect(recovery).toEqual({
      recoveredOperationIds: [preparation.operationId],
      pending: [],
      nextCursor: null,
    });
    const outerOperationId = custodyOperationId(preparation.operationId);
    const custody = await new BrowserDurableCustodyAdapter(database).readOperation(
      walletScope(),
      outerOperationId,
    );
    expect(custody?.operation.state).toBe("aborted");
    expect(await database.custodyReservations.count()).toBe(0);
    expect(
      (await database.custodyProofs.toArray()).filter(
        ({ selectability }) => selectability === "selectable",
      ),
    ).toHaveLength(1);
    const refundId = deriveDurableCtfRangeRefundOperationId(preparation.operationId);
    expect(await database.proofOperations.get(refundId)).toMatchObject({
      state: "completed",
      metadata: { rangeOperationId: preparation.operationId },
    });
    const legacyProofs = await database.proofs.toArray();
    expect(legacyProofs).toHaveLength(1);
    expect(legacyProofs[0]).not.toHaveProperty("reservedBy");
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("terminal");
  });

  it("uses exact mint recovery after expiry when the engine result is malformed", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-malformed-engine-result");
    let now = 20_000;
    const engine = engineMock({
      result: () => ({ resultId: "foreign" }) as SettlementCapabilityResultResponse,
    });
    const coordinator = createCoordinator(database, sourceWallet(), engine, {
      now: () => now,
      createMintRecovery: refundableRecovery(preparation),
      executeRefundSwap: async (_mintUrl, request) => ({
        signatures: request.outputs.map(signBlindedMessage),
      }),
    });
    await coordinator.prepareAndSubmit({
      seed: SEED,
      preparation,
      candidates: [sourceProof(preparation.offerKeyset.id)],
    });

    now = preparation.expiry * 1_000;
    expect(await coordinator.recoverPage({ seed: SEED, limit: 8 })).toMatchObject({
      recoveredOperationIds: [preparation.operationId],
      pending: [],
    });
    expect(
      (
        await new BrowserDurableCustodyAdapter(database).readOperation(
          walletScope(),
          custodyOperationId(preparation.operationId),
        )
      )?.operation.state,
    ).toBe("aborted");
  });

  it("rolls back outer refund completion and restores the exact refund after restart", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-outer-refund-rollback");
    let now = 20_000;
    const coordinator = createCoordinator(database, sourceWallet(), engineMock(), {
      now: () => now,
      createMintRecovery: refundableRecovery(preparation),
      executeRefundSwap: async (_mintUrl, request) => ({
        signatures: request.outputs.map(signBlindedMessage),
      }),
    });
    await coordinator.prepareAndSubmit({
      seed: SEED,
      preparation,
      candidates: [sourceProof(preparation.offerKeyset.id)],
    });
    let injectFailure = true;
    database.proofs.hook("deleting", () => {
      if (!injectFailure) return;
      injectFailure = false;
      throw new Error("injected outer refund mirror failure");
    });

    now = preparation.expiry * 1_000;
    await expect(coordinator.recoverPage({ seed: SEED, limit: 8 })).rejects.toThrow(
      "injected outer refund mirror failure",
    );

    const outerOperationId = custodyOperationId(preparation.operationId);
    expect(
      (
        await new BrowserDurableCustodyAdapter(database).readOperation(
          walletScope(),
          outerOperationId,
        )
      )?.operation.state,
    ).toBe("dispatch-intent");
    expect(await database.custodyReservations.count()).toBeGreaterThan(0);
    const refundOperationId = deriveDurableCtfRangeRefundOperationId(preparation.operationId);
    const preparedRefund = await database.proofOperations.get(refundOperationId);
    expect(preparedRefund).toMatchObject({ state: "prepared" });
    if (preparedRefund === undefined) throw new Error("prepared refund is missing");
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("order-submitted");

    const mutatedRefund = structuredClone(preparedRefund);
    mutatedRefund.inputs[0] = {
      ...mutatedRefund.inputs[0]!,
      witness: { signatures: ["00".repeat(64)] },
    };
    await database.proofOperations.put(mutatedRefund);
    await expect(coordinator.recoverPage({ seed: SEED, limit: 8 })).rejects.toThrow(
      "refund differs from persisted authority",
    );
    await database.proofOperations.put(preparedRefund);

    const restarted = createCoordinator(
      database,
      sourceWallet({ inputState: "SPENT" }),
      engineMock(),
      { now: () => now, restoreRefundOutputs: restoreSignedRefundOutputs },
    );
    expect(await restarted.recoverPage({ seed: SEED, limit: 8 })).toMatchObject({
      recoveredOperationIds: [preparation.operationId],
      pending: [],
    });
    expect(await database.proofOperations.get(refundOperationId)).toMatchObject({
      state: "completed",
    });
    expect(
      (
        await new BrowserDurableCustodyAdapter(database).readOperation(
          walletScope(),
          outerOperationId,
        )
      )?.operation.state,
    ).toBe("aborted");
  });

  it("recovers a lost result acknowledgement after exact local application", async () => {
    const database = createDatabase();
    const preparation = persistedPreparation("range-confirmed-result");
    let confirmed: ReturnType<typeof confirmedRangeRecovery> | undefined;
    const engine = engineMock({
      acknowledgeFailureOnce: true,
      result: () => {
        if (confirmed === undefined) throw new Error("confirmed fixture was not initialized");
        return confirmedEngineResult(
          confirmed.operation,
          confirmed.selection,
          confirmed.signatures,
        );
      },
    });
    const coordinator = createCoordinator(database, sourceWallet(), engine, {
      createMintRecovery: (operation) => {
        confirmed = confirmedRangeRecovery(operation, preparation);
        return {
          async loadExactVerificationContext() {
            if (confirmed === undefined) throw new Error("confirmed fixture is missing");
            return {
              allManifestRecovery: confirmed.allManifestRecovery,
              resolveKeyset: confirmed.resolveKeyset,
            };
          },
          async loadUncertainRecoveryObservation() {
            throw new Error("unexpected uncertain recovery");
          },
        };
      },
    });
    await coordinator.prepareAndSubmit({
      seed: SEED,
      preparation,
      candidates: [sourceProof(preparation.offerKeyset.id)],
    });

    expect(await coordinator.recoverPage({ seed: SEED, limit: 8 })).toMatchObject({
      recoveredOperationIds: [],
      pending: [{ operationId: preparation.operationId, code: "recovery-pending" }],
    });
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("order-submitted");
    expect(
      (
        await new BrowserDurableCustodyAdapter(database).readOperation(
          walletScope(),
          custodyOperationId(preparation.operationId),
        )
      )?.operation.state,
    ).toBe("reconciled");
    expect(
      (await database.proofs.toArray()).every(({ reservedBy }) => reservedBy === undefined),
    ).toBe(true);

    const recovery = await coordinator.recoverPage({ seed: SEED, limit: 8 });

    expect(recovery.recoveredOperationIds).toEqual([preparation.operationId]);
    expect(recovery.pending).toEqual([]);
    expect(engine.acknowledgeCalls).toBe(2);
    const outer = await new BrowserDurableCustodyAdapter(database).readOperation(
      walletScope(),
      custodyOperationId(preparation.operationId),
    );
    expect(outer?.operation.state).toBe("reconciled");
    expect(await database.custodyReservations.count()).toBe(0);
    expect(
      (await database.proofs.toArray()).every(({ reservedBy }) => reservedBy === undefined),
    ).toBe(true);
    expect(
      (await readCtfRangePreparation(walletScopeId(), preparation.operationId, database))
        ?.lifecycleState,
    ).toBe("terminal");
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
    restoreRefundOutputs?: BrowserCtfRangeOrderCoordinatorDependencies["restoreRefundOutputs"];
    createMintRecovery?: BrowserCtfRangeOrderCoordinatorDependencies["createMintRecovery"];
    executeRefundSwap?: BrowserCtfRangeOrderCoordinatorDependencies["executeRefundSwap"];
    now?: () => number;
    counterSource?: CounterSource;
    createCounterSource?: (scopeId: string, mintUrl: string, unit: string) => CounterSource;
  } = {},
) {
  let now = 20_000;
  return new BrowserCtfRangeOrderCoordinator({
    database,
    wallet,
    engine,
    now: options.now ?? (() => now++),
    randomId: () => crypto.randomUUID(),
    lockManager: options.lockManager ?? immediateLockManager(),
    createCounterSource:
      options.createCounterSource ?? (() => options.counterSource ?? inMemoryCounterSource()),
    ...(options.isDefinitiveOrderRejection === undefined
      ? {}
      : { isDefinitiveOrderRejection: options.isDefinitiveOrderRejection }),
    ...(options.restoreOutputs === undefined ? {} : { restoreOutputs: options.restoreOutputs }),
    ...(options.restoreRefundOutputs === undefined
      ? {}
      : { restoreRefundOutputs: options.restoreRefundOutputs }),
    ...(options.executeRefundSwap === undefined
      ? {}
      : { executeRefundSwap: options.executeRefundSwap }),
    createMintRecovery:
      options.createMintRecovery ??
      (() => ({
        async loadExactVerificationContext() {
          return {
            allManifestRecovery: {
              queriedOutputs: [],
              restoredOutputs: [],
              signatures: [],
              queryCompleted: false,
            },
            resolveKeyset: () => undefined,
          };
        },
        async loadUncertainRecoveryObservation(input) {
          const verification = await this.loadExactVerificationContext(input.record);
          return {
            ...verification,
            observation: {
              selection: input.selection,
              inputStates: [],
              ...verification.allManifestRecovery,
              now: input.now,
            },
          };
        },
      })),
  });
}

function inMemoryCounterSource(onReserve: () => void = () => {}): CounterSource {
  const next = new Map<string, number>();
  return {
    async reserve(keysetId, count) {
      onReserve();
      const start = next.get(keysetId) ?? 0;
      next.set(keysetId, start + count);
      return { start, count };
    },
    async advanceToAtLeast(keysetId, minNext) {
      next.set(keysetId, Math.max(next.get(keysetId) ?? 0, minNext));
    },
  };
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
      outputs: {
        send: { type: "custom"; data: OutputData[] } | { type: "random" };
        keep: { type: "custom"; data: OutputData[] } | { type: "random" };
      },
    ): Promise<SwapPreview> {
      const inputTotal = proofs.reduce((total, proof) => total + amountToNumber(proof.amount), 0);
      const keepAmount = inputTotal - amount - 1;
      return {
        amount: Amount.from(amount),
        fees: Amount.from(1),
        keysetId: config.keysetId,
        inputs: proofs,
        sendOutputs:
          outputs.send.type === "custom"
            ? outputs.send.data
            : OutputData.createRandomData(Amount.from(amount), {
                id: config.keysetId,
                keys: KEYS,
              }),
        keepOutputs:
          keepAmount > 0
            ? outputs.keep.type === "custom"
              ? outputs.keep.data
              : OutputData.createRandomData(Amount.from(keepAmount), {
                  id: config.keysetId,
                  keys: KEYS,
                })
            : [],
        unselectedProofs: [],
      };
    },
    async completeSwap(preview: SwapPreview): Promise<{ keep: Proof[]; send: Proof[] }> {
      await input.onComplete?.();
      return {
        keep: (preview.keepOutputs ?? []).map(signOutput),
        send: (preview.sendOutputs ?? []).map(signOutput),
      };
    },
    async prepareConditionalSwap(options: {
      keysetId: string;
      inputs: Proof[];
      outputs: Array<
        | { label: string; kind: "custom"; data: OutputData[] }
        | { label: string; kind: "random"; amount: number }
      >;
    }): Promise<ConditionalSwapPreview> {
      return {
        keysetId: options.keysetId,
        inputs: options.inputs,
        outputDataByLabel: Object.fromEntries(
          options.outputs.map((output) => [
            output.label,
            output.kind === "custom"
              ? output.data
              : OutputData.createRandomData(Amount.from(output.amount), {
                  id: options.keysetId,
                  keys: KEYS,
                }),
          ]),
        ),
      };
    },
    async completeConditionalSwap(
      preview: ConditionalSwapPreview,
    ): Promise<Record<string, Proof[]>> {
      await input.onComplete?.();
      return Object.fromEntries(
        Object.entries(preview.outputDataByLabel).map(([label, outputs]) => [
          label,
          outputs.map(signOutput),
        ]),
      );
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

function refundableRecovery(preparation: PersistedCtfRangeOrderPreparation) {
  const resolveKeyset = createCtfRangeOrderPreparationKeysetResolver(preparation);
  return (
    operation: Parameters<
      NonNullable<BrowserCtfRangeOrderCoordinatorDependencies["createMintRecovery"]>
    >[0],
  ) => {
    const allManifestRecovery: DurableCtfRangeAllManifestRecovery = {
      queriedOutputs: buildDurableCtfRangeRecoveryQuery(operation, null).outputs,
      restoredOutputs: [],
      signatures: [],
      queryCompleted: true,
    };
    return {
      async loadExactVerificationContext() {
        return { allManifestRecovery, resolveKeyset };
      },
      async loadUncertainRecoveryObservation(input: { selection: string | null; now: number }) {
        return {
          allManifestRecovery,
          resolveKeyset,
          observation: {
            selection: input.selection,
            inputStates: operation.inputs.map(({ secret }) => ({
              Y: hashToCurve(new TextEncoder().encode(secret)).toHex(true),
              state: "UNSPENT" as const,
              witness: null,
            })),
            ...allManifestRecovery,
            now: input.now,
          },
        };
      },
    };
  };
}

function confirmedRangeRecovery(
  operation: DurableCtfRangeOperation,
  preparation: PersistedCtfRangeOrderPreparation,
) {
  const inputTotal = operation.inputs.reduce((total, proof) => total + BigInt(proof.amount), 0n);
  const debit = BigInt(operation.policy.maxDebit);
  const rateN = BigInt(operation.policy.rateN);
  const rateD = BigInt(operation.policy.rateD);
  const minimumReceive = BigInt(operation.policy.minReceive);
  const quotedReceive = (debit * rateN + rateD - 1n) / rateD;
  const receive = quotedReceive > minimumReceive ? quotedReceive : minimumReceive;
  const change = inputTotal - debit;
  const selected = selectCtfRangeAmounts(operation.manifest.entries, receive, change);
  const restoredOutputs = buildDurableCtfRangeRecoveryQuery(operation, selected.selection).outputs;
  const signatures = restoredOutputs.map(signBlindedMessage);
  return {
    operation,
    selection: selected.selection,
    signatures,
    allManifestRecovery: {
      queriedOutputs: buildDurableCtfRangeRecoveryQuery(operation, null).outputs,
      restoredOutputs,
      signatures,
      queryCompleted: true,
    },
    resolveKeyset: createCtfRangeOrderPreparationKeysetResolver(preparation),
  };
}

function confirmedEngineResult(
  operation: DurableCtfRangeOperation,
  selection: string,
  signatures: readonly SerializedBlindedSignature[],
): SettlementCapabilityResultResponse {
  const requestDigest = "ef".repeat(32);
  const envelope = createDurableCtfRangeResultEnvelope({
    operation,
    requestDigest,
    selection,
    signatures,
  });
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  return {
    resultId: "33333333-3333-4333-8333-333333333333",
    reference: {
      artifactId: "11111111-1111-4111-8111-111111111111",
      bindingDigest: "22".repeat(32),
    },
    operationId: operation.operationId,
    requestDigest,
    envelopeDigest: bytesToHex(sha256(bytes)),
    envelope: bytesToBase64(bytes),
    createdAt: "2026-07-31T00:00:00.000Z",
    acknowledgedAt: null,
    version: 1,
    settlementGroup: {
      groupId: "66666666-6666-4666-8666-666666666666",
      revision: 1,
      status: "Confirmed",
      coalescingDeadline: "2026-07-31T00:00:00.000Z",
      frozenAt: "2026-07-31T00:00:00.000Z",
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

const restoreSignedRefundOutputs: typeof restoreDurableCtfRangeRefundOutputs = async (input) =>
  restoreDurableCtfRangeRefundOutputs({
    ...input,
    mint: {
      async restore(payload) {
        return { outputs: payload.outputs, signatures: payload.outputs.map(signBlindedMessage) };
      },
      async check() {
        throw new Error("unexpected refund proof-state request");
      },
      async getKeys() {
        throw new Error("refund recovery must not fetch fresh mint keys");
      },
    },
  });

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
    result?: () => SettlementCapabilityResultResponse | null;
    resultFailure?: boolean;
    acknowledgeFailureOnce?: boolean;
  } = {},
): BrowserCtfRangeEngine & {
  createCalls: number;
  submitCalls: number;
  statusCalls: number;
  acknowledgeCalls: number;
} {
  let acknowledgeFailurePending = input.acknowledgeFailureOnce === true;
  return {
    createCalls: 0,
    submitCalls: 0,
    statusCalls: 0,
    acknowledgeCalls: 0,
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
    async getSettlementCapabilityResultByOperation() {
      if (input.resultFailure === true) throw new Error("engine result transport is offline");
      return input.result?.() ?? null;
    },
    async acknowledgeSettlementCapabilityResult(resultId, request) {
      this.acknowledgeCalls += 1;
      if (acknowledgeFailurePending) {
        acknowledgeFailurePending = false;
        throw new Error("lost result acknowledgement");
      }
      const result = input.result?.() ?? null;
      if (
        result === null ||
        result.resultId !== resultId ||
        result.version !== request.expectedVersion
      ) {
        return null;
      }
      return {
        ...result,
        acknowledgedAt: "2026-07-31T00:00:01.000Z",
        version: result.version + 1,
      };
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
    amountSubunits: 10_000,
    outcomeId: "YES",
    side: "Buy",
    price: 2,
    placedAt: "2026-07-31T09:00:00.000Z",
    timeInForce: "FAK",
    tokenSide: "Outcome",
    baseAsset: "sat",
    divisibility: 10_000,
    activeSettlementGroup: null,
    continuation: null,
  };
}

function persistedPreparation(
  operationId: string,
  timeInForce: "FAK" | "FOK" | "GTC" = "FAK",
  order: Partial<Pick<CtfRangeOrderRequest, "side" | "tokenSide">> = {},
) {
  return buildPersistedCtfRangeOrderPreparation({
    request: { ...rangeRequest(timeInForce), ...order },
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
    minimumFillAmountSubunits: 10_000,
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
        registeredAt: 10,
      },
      {
        canonicalMintUrl: MINT_URL,
        id: COMPLEMENT_KEYSET_ID,
        unit: "msat" as const,
        active: true as const,
        keys: KEYS,
        inputFeePpk: INPUT_FEE_PPK,
        finalExpiry: FINAL_EXPIRY,
        conditionId: CONDITION_ID,
        outcomeCollection: COMPLEMENT_COLLECTION,
        outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
        registeredAt: 10,
      },
    ],
    maxInputs: 64,
    maxPoolEntries: 128,
    observation: {
      canonicalMintUrl: MINT_URL,
      freshness: "fresh" as const,
      observedAt: 20,
      maxExpirySeconds: FINAL_EXPIRY,
      conditionKeysetIds: [OUTCOME_KEYSET_ID, COMPLEMENT_KEYSET_ID],
      conditionalKeysets: [
        {
          keysetId: OUTCOME_KEYSET_ID,
          conditionId: CONDITION_ID,
          unit: "msat",
          inputFeePpk: INPUT_FEE_PPK,
          finalExpiry: FINAL_EXPIRY,
          outcomeCollectionId: OUTCOME_COLLECTION_ID,
          outcomeCollection: OUTCOME_COLLECTION,
          registeredAt: 10,
          keys: KEYS,
        },
        {
          keysetId: COMPLEMENT_KEYSET_ID,
          conditionId: CONDITION_ID,
          unit: "msat",
          inputFeePpk: INPUT_FEE_PPK,
          finalExpiry: FINAL_EXPIRY,
          outcomeCollectionId: COMPLEMENT_COLLECTION_ID,
          outcomeCollection: COMPLEMENT_COLLECTION,
          registeredAt: 10,
          keys: KEYS,
        },
      ],
    },
  };
}

function sourceProof(keysetId: string, amount = 4, secret = "source-proof"): Proof {
  return { id: keysetId, amount: Amount.from(amount), secret, C: MINT_PUBLIC_KEY };
}

function storedSourceProof(
  proof: Proof,
  conditional?: { conditionId: string; outcomeCollection: string },
): StoredProof {
  return {
    ...proof,
    mintUrl: MINT_URL,
    baseAsset: "sat",
    unit: "msat",
    receivedAt: 1,
    ...(conditional === undefined
      ? {}
      : {
          ...conditional,
          marketId: `${conditional.conditionId}-${conditional.outcomeCollection}`,
        }),
  };
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

function signBlindedMessage(output: SerializedBlindedMessage): SerializedBlindedSignature {
  const signature = createBlindSignature(pointFromHex(output.B_), MINT_PRIVATE_KEY, output.id);
  const dleq = createDLEQProof(pointFromHex(output.B_), MINT_PRIVATE_KEY);
  return {
    id: signature.id,
    amount: output.amount,
    C_: signature.C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  };
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

function sourceCustodyOperationId(retainedOperationKey: string): string {
  const scope = walletScope();
  return deriveDurableCustodyOperationId(scope.scopeId, {
    retainedOperationKey,
    binding: {
      kind: "wallet",
      activityId: retainedOperationKey,
      stage: "capability-preparation",
    },
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

function bytesToBase64(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value));
}

function sequentialId(...ids: string[]): () => string {
  let index = 0;
  return () => ids[index++] ?? "unexpected-id";
}

function createDatabase(
  proofs: StoredProof[] = [storedSourceProof(sourceProof(REGULAR_KEYSET_ID))],
): BitcasterDB {
  const database = new BitcasterDB(`bitcaster-browser-range-${crypto.randomUUID()}`);
  database.on("populate", (transaction) =>
    transaction.table("proofs").bulkAdd(
      proofs.map((proof) => ({
        ...proof,
        scopeId: walletScopeId(),
        amount: amountToNumber(proof.amount),
      })),
    ),
  );
  openDatabases.push(database);
  return database;
}
