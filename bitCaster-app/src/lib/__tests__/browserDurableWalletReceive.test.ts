// @vitest-environment node
import "fake-indexeddb/auto";
import { bytesToHex } from "@noble/curves/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  Amount,
  CheckStateEnum,
  Keyset,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveConditionalKeysetId,
  deriveKeysetId,
  getEncodedTokenV4,
  hashToCurve,
  pointFromHex,
  type Proof,
  type SwapPreview,
  type ConditionalSwapPreview,
} from "@cashu/cashu-ts";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortPreparedBrowserDurableWalletReceive,
  bindPreparedBrowserDurableWalletReceiveOperation,
  prepareBrowserDurableWalletReceiveOperation,
  readBrowserCurrentCustodyProofPage,
  receiveBrowserDurableWalletToken,
  recoverBrowserDurableWalletReceives,
  type BrowserDurableWalletReceiveContext,
  type BrowserDurableWalletReceiveWallet,
} from "../browserDurableWalletReceive";
import {
  admitDurableOutgoingCashuToken,
  classifyDurableOutgoingBearerProofStates,
  createDurableOutgoingCashuTransfer,
  markDurableOutgoingCashuReclaimRecipientSpent,
  prepareDurableOutgoingCashuReclaim,
  type DurableOutgoingCashuTransfer,
} from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import {
  deriveDurableWalletProofY,
  hydrateDurableWalletProof,
  serializeDurableWalletProof,
  serializeDurableWalletReceiveOperation,
  serializeDurableWalletSendOperation,
} from "@bitcaster/client-sdk/durableWalletOperation";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import { browserOutgoingCashuTransferRow } from "../browserDurableOutgoingCashuTransfer";
import { addProofs, addProofsIfMissing, BitcasterDB } from "../../stores/proof-db";
import {
  BrowserDurableCustodyAdapter,
  createBrowserCustodyProofRow,
} from "../../stores/durable-custody-db";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { browserWalletDatabaseName } from "../browserWalletProfile";

const requireNewWritePermission = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../browserWalletNewWritePermission", () => ({
  requireBrowserWalletNewWritePermission: requireNewWritePermission,
}));

const MINT = "https://mint.example";
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7]);
const KEYS = { "1": bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) };
const KEYSET_ID = deriveKeysetId(KEYS, { unit: "msat", versionByte: 1 });
const CONDITION_ID = "ab".repeat(32);
const OUTCOME_COLLECTION = "YES";
const OUTCOME_COLLECTION_ID = deriveRootCtfOutcomeCollectionId({
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
});
const CONDITIONAL_KEYS = {
  "1": KEYS["1"]!,
  "2": KEYS["1"]!,
  "4": KEYS["1"]!,
  "8": KEYS["1"]!,
  "10": KEYS["1"]!,
};
const CONDITIONAL_KEYSET_ID = deriveConditionalKeysetId({
  keys: CONDITIONAL_KEYS,
  unit: "msat",
  input_fee_ppk: 100,
  conditionId: CONDITION_ID,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
});
const CONDITIONAL_METADATA = {
  conditionId: CONDITION_ID,
  outcomeCollection: OUTCOME_COLLECTION,
  outcomeCollectionId: OUTCOME_COLLECTION_ID,
  registeredAt: 1,
};
const seed = new Uint8Array(64).fill(1);
const databases: BitcasterDB[] = [];

afterEach(async () => {
  requireNewWritePermission.mockClear();
  requireNewWritePermission.mockResolvedValue(undefined);
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser durable ordinary receive", () => {
  it("rejects a V3 conditional input before keyset loading or funds mutation", async () => {
    const database = createConditionalDatabase();
    const proof = { ...conditionalInputProof(), id: `02${"aa".repeat(32)}` };
    const receiveWallet = conditionalWallet(proof);
    const ensureCounterReady = vi.fn(async () => undefined);

    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-conditional-token",
        mintUrl: MINT,
        unit: "msat",
        asset: "conditional",
        conditionalInputProofs: [proof],
        ensureConditionalCounterReady: ensureCounterReady,
        wallet: receiveWallet,
        context: receiveContext(database),
      }),
    ).rejects.toThrow(/canonical NUT-02 V2 keyset id/);

    expect(receiveWallet.keyChain!.loadConditionalKeyset).not.toHaveBeenCalled();
    expect(receiveWallet.prepareConditionalSwap).not.toHaveBeenCalled();
    expect(receiveWallet.completeConditionalSwap).not.toHaveBeenCalled();
    expect(receiveWallet.checkProofsStates).not.toHaveBeenCalled();
    expect(ensureCounterReady).not.toHaveBeenCalled();
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.walletCounterCursors.count()).toBe(0);
  });

  it("receives conditional proofs through one durable fee-conserving operation", async () => {
    const database = createConditionalDatabase();
    const inputProof = conditionalInputProof();
    const receiveWallet = conditionalWallet(inputProof);
    const context = receiveContext(database);
    await markConditionalCounterReady(database);
    const readiness = vi.fn(async () => {
      expect(await database.walletCounterCursors.count()).toBe(0);
    });

    const received = await receiveBrowserDurableWalletToken({
      token: "cashuB-conditional-token",
      mintUrl: MINT,
      unit: "msat",
      asset: "conditional",
      conditionalInputProofs: [inputProof],
      ensureConditionalCounterReady: readiness,
      wallet: receiveWallet,
      context,
    });

    expect(readiness).toHaveBeenCalledOnce();
    expect(receiveWallet.prepareConditionalSwap).toHaveBeenCalledOnce();
    expect(receiveWallet.completeConditionalSwap).toHaveBeenCalledOnce();
    expect(receiveWallet.completeSwap).not.toHaveBeenCalled();
    expect(received).toHaveLength(2);
    const rows = await database.custodyProofs.toArray();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.assetKind === "conditional")).toBe(true);
    expect(rows.every((row) => row.conditionId === CONDITION_ID)).toBe(true);
    expect(rows.every((row) => row.outcomeCollection === OUTCOME_COLLECTION)).toBe(true);
    expect(await database.custodyConditionalKeysets.count()).toBe(1);
    const operations = await database.custodyOperations.toArray();
    expect(operations).toHaveLength(1);
    const receiveOperation = operations[0]!;
    expect(receiveOperation.record.operation.semanticKind).toBe("generic-receive");
    expect(receiveOperation.record.operation.proofStorage.pinReasons).toEqual([]);
    expect(receiveOperation.operationId).toBe(receiveOperation.record.operation.operationId);

    const desiredRows = await database.encryptedWalletBackupV2DesiredAssets.toArray();
    expect(desiredRows).toHaveLength(1);
    expect(desiredRows[0]).toMatchObject({
      mintUrl: MINT,
      unit: "msat",
      assetIdentity: `ctf:${CONDITION_ID}:${OUTCOME_COLLECTION_ID}`,
      activeProofCount: 2,
      desiredAction: "replace",
      syncState: "pending",
    });

    const receivedProofIds = new Set(rows.map((row) => row.proofId));
    const authorities = await database.custodyProofBackupAuthorities.toArray();
    expect(authorities).toHaveLength(2);
    expect(receivedProofIds.size).toBe(2);
    for (const authority of authorities) {
      if (!("backupState" in authority)) {
        throw new Error("received conditional proof authority is not a proof row");
      }
      expect(receivedProofIds.has(authority.proofId)).toBe(true);
      expect(authority.backupState).toBe("local-only");
      expect(authority.admissionOperationId).toBe(receiveOperation.operationId);
      expect(authority.derivationLocator).toMatchObject({
        kind: "nut13",
        keysetId: CONDITIONAL_KEYSET_ID,
      });
    }

    expect(
      await database.walletCounterCursors.get([
        browserWalletScope(seed).scopeId,
        CONDITIONAL_KEYSET_ID,
      ]),
    ).toMatchObject({ next: 2 });
  });

  it("rejects a self-consistent conditional fee plan that conflicts with the verified keyset fee", async () => {
    const database = createConditionalDatabase();
    const inputProof = conditionalInputProof();
    const receiveWallet = conditionalWallet(inputProof);
    const output = OutputData.createSingleData(8, CONDITIONAL_KEYSET_ID, "wrong-fee-output", 31n);
    const preparedOperation = serializeDurableWalletReceiveOperation({
      operationId: "wallet-receive:wrong-conditional-fee",
      mintUrl: MINT,
      unit: "msat",
      asset: "conditional",
      inputFeePpk: 2_000,
      preview: {
        keysetId: CONDITIONAL_KEYSET_ID,
        inputs: [inputProof],
        outputDataByLabel: { receive: [output] },
      },
      derivationRange: {
        keysetId: CONDITIONAL_KEYSET_ID,
        counterStart: 0,
        counterCount: 1,
      },
    });

    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-conditional-token",
        mintUrl: MINT,
        unit: "msat",
        asset: "conditional",
        preparedOperation,
        wallet: receiveWallet,
        context: receiveContext(database),
      }),
    ).rejects.toThrow(/fee conflicts with keyset authority/);

    expect(receiveWallet.completeConditionalSwap).not.toHaveBeenCalled();
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.walletCounterCursors.count()).toBe(0);
  });

  it.each([
    ["background", "empty"],
    ["background", "partial"],
    ["direct", "empty"],
    ["direct", "partial"],
  ] as const)(
    "keeps conditional %s recovery with %s restore unresolved without outgoing abort authority",
    async (entryPoint, restoreShape) => {
      const database = createConditionalDatabase();
      const inputProof = conditionalInputProof();
      const first = conditionalWallet(inputProof);
      vi.mocked(first.completeConditionalSwap!).mockRejectedValueOnce(
        new Error("simulated conditional receive interruption"),
      );
      const context = receiveContext(database);
      await markConditionalCounterReady(database);
      const preparedOperation = await prepareBrowserDurableWalletReceiveOperation(
        {
          token: "cashuB-conditional-token",
          mintUrl: MINT,
          unit: "msat",
          asset: "conditional",
          conditionalInputProofs: [inputProof],
          ensureConditionalCounterReady: async () => undefined,
          wallet: first,
          context,
        },
        () => "conditional-recovery-entry-point",
      );
      await expect(
        receiveBrowserDurableWalletToken({
          token: "cashuB-conditional-token",
          mintUrl: MINT,
          unit: "msat",
          asset: "conditional",
          conditionalInputProofs: [inputProof],
          preparedOperation,
          ensureConditionalCounterReady: async () => undefined,
          wallet: first,
          context,
        }),
      ).rejects.toThrow("simulated conditional receive interruption");
      const operation = (await database.custodyOperations.toArray())[0];
      if (!operation) throw new Error("conditional receive operation was not persisted");
      expect(operation.record.operation.result.state).toBe("none");
      const restart = conditionalWallet(inputProof);
      vi.mocked(restart.checkProofsStates).mockResolvedValue(
        statesForProofs([inputProof], CheckStateEnum.SPENT) as never,
      );
      if (restoreShape === "empty") {
        vi.mocked(restart.mint.restore).mockResolvedValue({ outputs: [], signatures: [] });
      } else {
        vi.mocked(restart.mint.restore).mockImplementation(async ({ outputs }) => ({
          outputs: [outputs[0]!],
          signatures: [{ substituted: "partial" }],
        }));
      }

      if (entryPoint === "background") {
        const recovered = await recoverBrowserDurableWalletReceives({
          context,
          walletForMint: async () => restart,
        });
        expect(recovered).toMatchObject({ pending: 1, repaired: [] });
      } else {
        await expect(
          receiveBrowserDurableWalletToken({
            token: "cashuB-conditional-token",
            mintUrl: MINT,
            unit: "msat",
            preparedOperation,
            skipBind: true,
            recoveryMode: "recover",
            wallet: restart,
            context,
          }),
        ).rejects.toThrow(
          restoreShape === "empty"
            ? "wallet receive inputs were spent elsewhere"
            : "wallet receive did not reach a terminal state",
        );
      }
      expect(restart.completeConditionalSwap).not.toHaveBeenCalled();
      expect(await database.custodyOperations.count()).toBe(1);
      expect(await database.custodyProofs.count()).toBe(0);
      expect(await database.proofs.count()).toBe(0);
    },
  );

  it("rejects sat before mint, custody, or counter writes", async () => {
    const database = createDatabase();
    const preview = receivePreview();
    const receiveWallet = wallet(preview, proofForOutput(preview.keepOutputs![0]!));

    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-sat-token",
        mintUrl: MINT,
        unit: "sat",
        wallet: receiveWallet,
        context: receiveContext(database),
      }),
    ).rejects.toThrow(/requires msat/);
    expect(receiveWallet.prepareSwapToReceive).not.toHaveBeenCalled();
    expect(await database.custodyScopes.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.walletCounterAssociations.count()).toBe(0);
    expect(await database.walletCounterCursors.count()).toBe(0);

    const prepared = await prepareBrowserDurableWalletReceiveOperation(
      {
        token: "cashuB-msat-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: receiveWallet,
        context: receiveContext(database),
      },
      () => "prepared",
    );
    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-sat-token",
        mintUrl: MINT,
        unit: "msat",
        preparedOperation: { ...prepared, unit: "sat" },
        wallet: receiveWallet,
        context: receiveContext(database),
      }),
    ).rejects.toThrow(/requires msat/);
    expect(await database.custodyScopes.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
  });

  it("rejects sat during legacy cache repair before legacy proof writes", async () => {
    const database = createDatabase();
    const scopeId = browserWalletScope(seed).scopeId;
    await database.custodyProofs.put(
      createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: MINT,
        unit: "sat",
        proof: {
          id: KEYSET_ID,
          amount: Amount.from(1),
          secret: "sat-cache-proof",
          C: "sat-cache-signature",
        },
        asset: { kind: "regular" },
        receivedAtMs: 1,
      }),
    );

    await expect(
      readBrowserCurrentCustodyProofPage({
        context: receiveContext(database),
        selectability: "selectable",
        cursor: null,
      }),
    ).rejects.toThrow(/requires msat/);
    expect(await database.proofs.count()).toBe(0);
  });

  it("refuses a new receive before deterministic output preparation", async () => {
    const database = createDatabase();
    const preview = receivePreview();
    const receiveWallet = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    requireNewWritePermission.mockRejectedValueOnce(
      new Error(
        "Another browser changed this wallet. Reload to start recovery before making a new wallet change.",
      ),
    );

    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: receiveWallet,
        context: receiveContext(database),
      }),
    ).rejects.toThrow("Another browser changed this wallet");

    expect(receiveWallet.prepareSwapToReceive).not.toHaveBeenCalled();
    expect(await database.custodyScopes.count()).toBe(0);
    expect(await database.custodyOperations.count()).toBe(0);
  });

  it("persists the exact preview before mint completion and replays it after an all-UNSPENT restart", async () => {
    const database = createDatabase();
    const preview = receivePreview();
    const first = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    vi.mocked(first.completeSwap).mockRejectedValueOnce(new Error("simulated crash"));
    const context = receiveContext(database);

    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context,
      }),
    ).rejects.toThrow("simulated crash");
    expect(first.completeSwap).toHaveBeenCalledOnce();
    expect((await database.custodyOperations.toArray())[0]?.record.operation.result.state).toBe(
      "none",
    );

    const restarted = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    vi.mocked(restarted.checkProofsStates).mockResolvedValue(
      statesFor(preview, CheckStateEnum.UNSPENT) as never,
    );
    requireNewWritePermission.mockClear();
    requireNewWritePermission.mockRejectedValue(
      new Error(
        "Another browser changed this wallet. Reload to start recovery before making a new wallet change.",
      ),
    );
    const recovered = await recoverBrowserDurableWalletReceives({
      context,
      walletForMint: async () => restarted,
    });

    expect(recovered.pending).toBe(0);
    expect(requireNewWritePermission).not.toHaveBeenCalled();
    expect(first.prepareSwapToReceive).toHaveBeenCalledOnce();
    expect(restarted.prepareSwapToReceive).not.toHaveBeenCalled();
    expect(restarted.completeSwap).toHaveBeenCalledWith(
      expect.objectContaining({
        keepOutputs: expect.arrayContaining([
          expect.objectContaining({ secret: preview.keepOutputs![0]!.secret }),
        ]),
      }),
    );
  });

  it("recovers a receive in its bound database after the active profile changes during mint execution", async () => {
    const originalDatabase = createDatabase();
    const replacementDatabase = createDatabase();
    const scopeId = browserWalletScope(seed).scopeId;
    let activeProfile = "original";
    const context: BrowserDurableWalletReceiveContext = {
      ...receiveContext(originalDatabase),
      requireCapturedProfile: () => {
        if (activeProfile !== "original") {
          throw new Error("The wallet profile changed during mint recovery.");
        }
      },
    };
    const preview = receivePreview();
    const output = proofForOutput(preview.keepOutputs![0]!);
    const receivingWallet = wallet(preview, output);
    let exactAuthorityBoundBeforeMint = false;
    vi.mocked(receivingWallet.completeSwap).mockImplementation(async () => {
      const operation = (await originalDatabase.custodyOperations.toArray())[0];
      if (operation) {
        const privateArtifactId =
          operation.record.operation.privateMaterial.exactPrivateMaterial.artifactId;
        const authority = await originalDatabase.custodyArtifacts.get([
          scopeId,
          operation.operationId,
          privateArtifactId,
        ]);
        exactAuthorityBoundBeforeMint =
          operation.record.operation.result.state === "none" && authority !== undefined;
      }
      activeProfile = "replacement";
      return { keep: [output], send: [] };
    });

    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: receivingWallet,
        context,
      }),
    ).rejects.toThrow("The wallet profile changed during mint recovery.");

    expect(exactAuthorityBoundBeforeMint).toBe(true);
    expect(await originalDatabase.custodyOperations.count()).toBe(1);
    expect(
      (await originalDatabase.custodyOperations.toArray())[0]?.record.operation.result.state,
    ).toBe("none");
    expect(await originalDatabase.custodyProofs.count()).toBe(0);
    expect(await replacementDatabase.custodyOperations.count()).toBe(0);
    expect(await replacementDatabase.custodyProofs.count()).toBe(0);

    activeProfile = "original";
    const restartedWallet = wallet(preview, output);
    vi.mocked(restartedWallet.checkProofsStates).mockResolvedValue(
      statesFor(preview, CheckStateEnum.SPENT) as never,
    );
    const recovered = await recoverBrowserDurableWalletReceives({
      context,
      walletForMint: async () => restartedWallet,
    });

    expect(recovered).toMatchObject({
      pending: 0,
      repaired: [expect.objectContaining({ secret: outputSecret(preview) })],
    });
    expect(restartedWallet.completeSwap).not.toHaveBeenCalled();
    expect(await originalDatabase.custodyProofs.count()).toBe(1);
    expect(await replacementDatabase.custodyOperations.count()).toBe(0);
    expect(await replacementDatabase.custodyProofs.count()).toBe(0);
  });

  it("does not mask a receive failure when scope release also fails", async () => {
    const database = createDatabase();
    const preview = receivePreview();
    const first = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    vi.mocked(first.completeSwap).mockRejectedValueOnce(new Error("simulated receive failure"));
    const release = vi
      .spyOn(BrowserDurableCustodyAdapter.prototype, "releaseScope")
      .mockRejectedValueOnce(new Error("simulated release failure"));

    try {
      await expect(
        receiveBrowserDurableWalletToken({
          token: "cashuB-token",
          mintUrl: MINT,
          unit: "msat",
          wallet: first,
          context: receiveContext(database),
        }),
      ).rejects.toThrow("simulated receive failure");
    } finally {
      release.mockRestore();
    }
  });

  it("restores only persisted outputs when every input is SPENT", async () => {
    const database = createDatabase();
    const preview = receivePreview();
    const first = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    vi.mocked(first.completeSwap).mockRejectedValueOnce(new Error("simulated crash"));
    const context = receiveContext(database);
    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context,
      }),
    ).rejects.toThrow();

    const restarted = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    vi.mocked(restarted.checkProofsStates).mockResolvedValue(
      statesFor(preview, CheckStateEnum.SPENT) as never,
    );
    const recovered = await recoverBrowserDurableWalletReceives({
      context,
      walletForMint: async () => restarted,
    });

    expect(recovered.pending).toBe(0);
    expect(restarted.completeSwap).not.toHaveBeenCalled();
    expect(restarted.mint.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [expect.objectContaining({ B_: preview.keepOutputs![0]!.blindedMessage.B_ })],
      }),
    );
  });

  it.each([CheckStateEnum.PENDING, "UNKNOWN"] as const)(
    "keeps %s recovery nonterminal",
    async (state) => {
      const database = createDatabase();
      const preview = receivePreview();
      const first = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
      vi.mocked(first.completeSwap).mockRejectedValueOnce(new Error("simulated crash"));
      const context = receiveContext(database);
      await expect(
        receiveBrowserDurableWalletToken({
          token: "cashuB-token",
          mintUrl: MINT,
          unit: "msat",
          wallet: first,
          context,
        }),
      ).rejects.toThrow();
      const restarted = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
      vi.mocked(restarted.checkProofsStates).mockResolvedValue(statesFor(preview, state) as never);

      await expect(
        recoverBrowserDurableWalletReceives({ context, walletForMint: async () => restarted }),
      ).resolves.toMatchObject({ pending: 1 });
      expect(restarted.completeSwap).not.toHaveBeenCalled();
      expect(restarted.mint.restore).not.toHaveBeenCalled();
    },
  );

  it("resumes a verified staged result without another mint call", async () => {
    const database = createDatabase();
    const preview = receivePreview();
    const first = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context: receiveContext(database, "before-commit"),
      }),
    ).rejects.toThrow("injected browser custody fault before commit");
    expect((await database.custodyOperations.toArray())[0]?.record.operation.result.state).toBe(
      "verified-staged",
    );
    expect(
      (await database.custodyOperations.toArray())[0]?.record.operation.proofStorage.pinReasons,
    ).toEqual(["active-reservation"]);
    expect(await database.custodyProofs.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);

    const restarted = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    const recovered = await recoverBrowserDurableWalletReceives({
      context: receiveContext(database),
      walletForMint: async () => restarted,
    });

    expect(recovered).toMatchObject({
      pending: 0,
      repaired: [expect.objectContaining({ secret: outputSecret(preview) })],
    });
    expect(restarted.completeSwap).not.toHaveBeenCalled();
    expect(restarted.checkProofsStates).not.toHaveBeenCalled();
    expect(restarted.mint.restore).not.toHaveBeenCalled();
    expect((await database.custodyOperations.toArray())[0]?.record.operation.result.state).toBe(
      "applied",
    );
    expect(
      (await database.custodyOperations.toArray())[0]?.record.operation.proofStorage.pinReasons,
    ).toEqual([]);
    expect(await database.custodyProofs.count()).toBe(1);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);
  });

  it("repairs the display cache from current inventory after an after-commit failure", async () => {
    const database = createDatabase();
    const preview = receivePreview();
    const first = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context: receiveContext(database, "after-commit"),
      }),
    ).rejects.toThrow("injected browser custody fault after commit");
    expect((await database.custodyOperations.toArray())[0]?.record.operation.result.state).toBe(
      "applied",
    );
    expect(
      (await database.custodyOperations.toArray())[0]?.record.operation.proofStorage.pinReasons,
    ).toEqual([]);
    expect(await database.custodyProofs.count()).toBe(1);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);

    const restarted = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    const recovered = await recoverBrowserDurableWalletReceives({
      context: receiveContext(database),
      walletForMint: async () => restarted,
    });
    const page = await readBrowserCurrentCustodyProofPage({
      context: receiveContext(database),
      selectability: "selectable",
      cursor: null,
    });

    expect(recovered).toMatchObject({ pending: 0, repaired: [] });
    expect(page.proofs).toEqual([expect.objectContaining({ secret: outputSecret(preview) })]);
    expect(page.nextCursor).toBeNull();
    expect(restarted.completeSwap).not.toHaveBeenCalled();
    expect(restarted.checkProofsStates).not.toHaveBeenCalled();
    expect(restarted.mint.restore).not.toHaveBeenCalled();
  });

  it("commits bearer reclaim authority with the receive and resumes the exact operation", async () => {
    const database = createDatabase();
    const scopeId = browserWalletScope(seed).scopeId;
    const outgoing = admittedBearerTransfer(scopeId);
    const inputProof = outgoing.token!.proofs[0]!;
    const preview = receivePreviewForProof(inputProof);
    const successor = proofForOutput(preview.keepOutputs![0]!);
    const first = wallet(preview, successor, 21);
    const faultContext = receiveContext(database, "after-commit", "reclaim");
    const token = outgoing.token!.encodedToken;
    const operation = await prepareBrowserDurableWalletReceiveOperation(
      {
        operationId: "bearer-reclaim:1",
        token,
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context: faultContext,
      },
      () => "unused",
    );
    const { prepared, terminal } = bearerReclaimStates(outgoing, operation);

    await expect(
      receiveBrowserDurableWalletToken({
        operationId: operation.operationId,
        preparedOperation: operation,
        token,
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context: faultContext,
        outgoingTransferOnPrepare: browserOutgoingCashuTransferRow(scopeId, prepared, "consumed"),
        completeOutgoingTransfer: () =>
          browserOutgoingCashuTransferRow(scopeId, terminal, "consumed"),
      }),
    ).rejects.toThrow("injected browser custody fault after commit");

    expect((await database.custodyOperations.toArray())[0]?.record.operation.result.state).toBe(
      "applied",
    );
    expect((await database.outgoingCashuTransfers.toArray())[0]?.transfer.deliveryState).toBe(
      "bearer-spent",
    );
    expect(await database.custodyProofs.count()).toBe(1);

    const restarted = wallet(preview, successor, 21);
    await expect(
      receiveBrowserDurableWalletToken({
        operationId: operation.operationId,
        preparedOperation: operation,
        skipBind: true,
        token,
        mintUrl: MINT,
        unit: "msat",
        wallet: restarted,
        context: receiveContext(database),
        completeOutgoingTransfer: () =>
          browserOutgoingCashuTransferRow(scopeId, terminal, "consumed"),
      }),
    ).resolves.toEqual([expect.objectContaining({ secret: successor.secret })]);
    expect(restarted.prepareSwapToReceive).not.toHaveBeenCalled();
    expect(restarted.completeSwap).not.toHaveBeenCalled();
    expect(restarted.checkProofsStates).not.toHaveBeenCalled();
  });

  it("atomically aborts a reclaim receive when the recipient spent every bearer proof", async () => {
    const database = createDatabase();
    const scopeId = browserWalletScope(seed).scopeId;
    const outgoing = admittedBearerTransfer(scopeId);
    const preview = receivePreviewForProof(outgoing.token!.proofs[0]!);
    const first = wallet(preview, proofForOutput(preview.keepOutputs![0]!), 31);
    const context = receiveContext(database);
    const operation = await prepareBrowserDurableWalletReceiveOperation(
      {
        operationId: "bearer-reclaim:recipient-spent",
        token: outgoing.token!.encodedToken,
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context,
      },
      () => "unused",
    );
    const { prepared } = bearerReclaimStates(outgoing, operation);
    await bindPreparedBrowserDurableWalletReceiveOperation({
      operation,
      wallet: first,
      outgoingTransfer: browserOutgoingCashuTransferRow(scopeId, prepared, "consumed"),
      context,
    });
    expect(await database.custodyOperations.count()).toBe(1);
    expect(await database.outgoingCashuTransfers.count()).toBe(1);
    vi.mocked(first.checkProofsStates).mockResolvedValue([
      { Y: deriveDurableWalletProofY(prepared.reclaim!.proofs[0]!), state: "SPENT" },
    ] as never);
    vi.mocked(first.mint.restore).mockResolvedValue({ outputs: [], signatures: [] });
    const token = getEncodedTokenV4({
      mint: MINT,
      unit: "msat",
      proofs: prepared.reclaim!.proofs.map(hydrateDurableWalletProof),
    });

    await expect(
      receiveBrowserDurableWalletToken({
        operationId: operation.operationId,
        preparedOperation: operation,
        skipBind: true,
        recoveryMode: "recover",
        token,
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context,
        abortOutgoingTransfer: ({ custodyOperationId }) =>
          abortPreparedBrowserDurableWalletReceive({
            custodyOperationId,
            transferId: prepared.transferId,
            terminalOutgoingTransfer: browserOutgoingCashuTransferRow(
              scopeId,
              markDurableOutgoingCashuReclaimRecipientSpent(prepared),
              "consumed",
            ),
            context,
          }),
      }),
    ).resolves.toEqual([]);
    expect(await database.custodyOperations.get([scopeId, operation.operationId])).toBeUndefined();
    expect((await database.outgoingCashuTransfers.toArray())[0]?.transfer.deliveryState).toBe(
      "bearer-spent",
    );
    expect(await database.custodyProofs.count()).toBe(0);
  });

  it("keeps a substituted staged result nonterminal", async () => {
    const database = createDatabase();
    const preview = receivePreview();
    const first = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context: receiveContext(database, "before-commit"),
      }),
    ).rejects.toThrow();
    const result = (await database.custodyArtifacts.toArray()).find(({ reference }) =>
      reference.artifactId.endsWith(":result"),
    );
    if (!result) throw new Error("test result artifact is missing");
    await database.custodyArtifacts.put({
      ...result,
      artifact: { ...result.artifact, artifact: { substituted: true } },
    });

    const restarted = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    await expect(
      recoverBrowserDurableWalletReceives({
        context: receiveContext(database),
        walletForMint: async () => restarted,
      }),
    ).resolves.toMatchObject({ pending: 1, repaired: [] });
    expect(await database.custodyProofs.count()).toBe(0);
    expect(restarted.completeSwap).not.toHaveBeenCalled();
    expect(restarted.checkProofsStates).not.toHaveBeenCalled();
  });

  it("rejects substituted receive authority before any recovery mint call", async () => {
    const database = createDatabase();
    const preview = receivePreview();
    const first = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    vi.mocked(first.completeSwap).mockRejectedValueOnce(new Error("simulated crash"));
    const context = receiveContext(database);
    await expect(
      receiveBrowserDurableWalletToken({
        token: "cashuB-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context,
      }),
    ).rejects.toThrow("simulated crash");
    const operation = (await database.custodyOperations.toArray())[0];
    if (!operation) throw new Error("test operation is missing");
    const privateArtifactId =
      operation.record.operation.privateMaterial.exactPrivateMaterial.artifactId;
    const authority = await database.custodyArtifacts.get([
      operation.scopeId,
      operation.operationId,
      privateArtifactId,
    ]);
    if (!authority) throw new Error("test authority is missing");
    await database.custodyArtifacts.put({
      ...authority,
      artifact: { ...authority.artifact, artifact: { substituted: true } },
    });

    const restarted = wallet(preview, proofForOutput(preview.keepOutputs![0]!));
    await expect(
      recoverBrowserDurableWalletReceives({ context, walletForMint: async () => restarted }),
    ).resolves.toMatchObject({ pending: 1, repaired: [] });

    expect(restarted.completeSwap).not.toHaveBeenCalled();
    expect(restarted.checkProofsStates).not.toHaveBeenCalled();
    expect(restarted.mint.restore).not.toHaveBeenCalled();
  });

  it("advances past one invalid receive so a later receive can recover", async () => {
    const database = createDatabase();
    const firstPreview = receivePreview(0, "first-input");
    const secondPreview = receivePreview(1, "second-input");
    const first = wallet(firstPreview, proofForOutput(firstPreview.keepOutputs![0]!));
    const second = wallet(secondPreview, proofForOutput(secondPreview.keepOutputs![0]!), 1);
    vi.mocked(first.completeSwap).mockRejectedValueOnce(new Error("first crash"));
    vi.mocked(second.completeSwap).mockRejectedValueOnce(new Error("second crash"));
    await expect(
      receiveBrowserDurableWalletToken({
        token: "first-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: first,
        context: receiveContext(database, undefined, "a"),
      }),
    ).rejects.toThrow("first crash");
    await expect(
      receiveBrowserDurableWalletToken({
        token: "second-token",
        mintUrl: MINT,
        unit: "msat",
        wallet: second,
        context: receiveContext(database, undefined, "b"),
      }),
    ).rejects.toThrow("second crash");
    const operations = (await database.custodyOperations.toArray()).sort((left, right) =>
      left.operationId.localeCompare(right.operationId),
    );
    const firstOperation = operations[0];
    if (!firstOperation) throw new Error("first test operation is missing");
    const authorityId =
      firstOperation.record.operation.privateMaterial.exactPrivateMaterial.artifactId;
    const authority = await database.custodyArtifacts.get([
      firstOperation.scopeId,
      firstOperation.operationId,
      authorityId,
    ]);
    if (!authority) throw new Error("first test authority is missing");
    await database.custodyArtifacts.put({
      ...authority,
      artifact: { ...authority.artifact, artifact: { substituted: true } },
    });
    const context = receiveContext(database, undefined, "recovery");
    const firstPass = await recoverBrowserDurableWalletReceives({
      context,
      walletForMint: async () => {
        throw new Error("invalid authority must fail before wallet creation");
      },
    });
    const restartedSecond = wallet(
      secondPreview,
      proofForOutput(secondPreview.keepOutputs![0]!),
      1,
    );
    vi.mocked(restartedSecond.checkProofsStates).mockResolvedValue(
      statesFor(secondPreview, CheckStateEnum.UNSPENT) as never,
    );

    const secondPass = await recoverBrowserDurableWalletReceives({
      context,
      afterOperationId: firstPass.lastAttemptedOperationId,
      walletForMint: async () => restartedSecond,
    });

    expect(firstPass).toMatchObject({ pending: 1, repaired: [] });
    expect(secondPass.lastAttemptedOperationId).toBe(operations[1]?.operationId);
    expect(restartedSecond.checkProofsStates).toHaveBeenCalledOnce();
    expect(secondPass).toMatchObject({
      pending: 1,
      repaired: [expect.objectContaining({ secret: outputSecret(secondPreview) })],
    });
    expect(restartedSecond.completeSwap).toHaveBeenCalledOnce();
  });

  it("pages current canonical proof cache repair without overlap", async () => {
    const database = createDatabase();
    const scopeId = browserWalletScope(seed).scopeId;
    await database.custodyProofs.bulkPut(
      Array.from({ length: 65 }, (_, index) =>
        createBrowserCustodyProofRow({
          scopeId,
          normalizedMint: MINT,
          unit: "msat",
          proof: {
            id: KEYSET_ID,
            amount: Amount.from(1),
            secret: `page-secret-${index.toString().padStart(2, "0")}`,
            C: `page-signature-${index}`,
          },
          asset: { kind: "regular" },
          receivedAtMs: index,
        }),
      ),
    );
    const context = receiveContext(database);

    const first = await readBrowserCurrentCustodyProofPage({
      context,
      selectability: "selectable",
      cursor: null,
    });
    const second = await readBrowserCurrentCustodyProofPage({
      context,
      selectability: "selectable",
      cursor: first.nextCursor,
    });

    expect(first.proofs).toHaveLength(64);
    expect(first.nextCursor).not.toBeNull();
    expect(second.proofs).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.proofs, ...second.proofs].map(({ secret }) => secret)).size).toBe(65);
  });

  it("keeps a real Dexie legacy reservation during canonical cache repair", async () => {
    const database = createDatabase();
    const proof = {
      id: KEYSET_ID,
      amount: Amount.from(1),
      secret: "locked-cache-proof",
      C: "locked-cache-signature",
    };
    const scopeId = browserWalletScope(seed).scopeId;
    await database.custodyProofs.put({
      ...createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: MINT,
        unit: "msat",
        proof,
        asset: { kind: "regular" },
        receivedAtMs: 1,
      }),
      selectability: "locked",
      reservationOperationId: "order-1",
    });
    const legacy = { ...proof, mintUrl: MINT, baseAsset: "sat" as const, unit: "msat" as const };
    await addProofs([{ ...legacy, reservedBy: "order-1" }], database);

    await addProofsIfMissing([legacy], database);

    expect((await database.proofs.get(proof.secret))?.reservedBy).toBe("order-1");
    expect((await database.custodyProofs.toArray())[0]?.reservationOperationId).toBe("order-1");
  });
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`browser-durable-receive-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

function createConditionalDatabase(): BitcasterDB {
  const database = new BitcasterDB(browserWalletDatabaseName(browserWalletScope(seed).scopeId));
  databases.push(database);
  return database;
}

function receiveContext(
  database: BitcasterDB,
  injectFault?: "before-commit" | "after-commit",
  idPrefix = "id",
): BrowserDurableWalletReceiveContext {
  let time = 1_000;
  return {
    seed,
    database,
    now: () => ++time,
    randomId: (() => {
      let value = 0;
      return () => `${idPrefix}-${++value}`;
    })(),
    lockManager: {
      request: async (_name: string, _options: LockOptions, callback: () => Promise<unknown>) =>
        callback(),
    } as Pick<LockManager, "request">,
    requireCapturedProfile: () => undefined,
    ...(injectFault === undefined ? {} : { injectFault }),
  };
}

function conditionalInputProof(): Proof {
  return proofForOutput(
    OutputData.createSingleData(10, CONDITIONAL_KEYSET_ID, "conditional-import-input", 27n),
  );
}

function conditionalWallet(inputProof: Proof): BrowserDurableWalletReceiveWallet {
  const conditionalKeyset = Keyset.fromMintApi(
    {
      id: CONDITIONAL_KEYSET_ID,
      unit: "msat",
      active: true,
      input_fee_ppk: 100,
      conditional: CONDITIONAL_METADATA,
    },
    {
      id: CONDITIONAL_KEYSET_ID,
      unit: "msat",
      active: true,
      input_fee_ppk: 100,
      keys: CONDITIONAL_KEYS,
      conditional: CONDITIONAL_METADATA,
    },
  );
  const regularPreview = receivePreview();
  const regularWallet = wallet(regularPreview, proofForOutput(regularPreview.keepOutputs![0]!));
  return {
    ...regularWallet,
    prepareConditionalSwap: vi.fn(
      async ({ keysetId, inputs, outputs }: import("@cashu/cashu-ts").ConditionalSwapOptions) => ({
        keysetId: keysetId ?? inputs[0]!.id,
        inputs: inputs as Proof[],
        outputDataByLabel: Object.fromEntries(
          outputs.map((group) => [group.label, group.kind === "custom" ? [...group.data] : []]),
        ),
      }),
    ),
    completeConditionalSwap: vi.fn(async (preview: ConditionalSwapPreview) => ({
      receive: (preview.outputDataByLabel.receive ?? []).map(proofForOutput),
    })),
    checkProofsStates: vi.fn(
      async () => statesForProofs([inputProof], CheckStateEnum.UNSPENT) as never,
    ),
    keyChain: {
      loadConditionalKeyset: vi.fn(async () => conditionalKeyset),
      registerConditionalKeyset: vi.fn(() => conditionalKeyset),
    },
    getKeyset: vi.fn((keysetId?: string) => {
      if (keysetId !== undefined && keysetId !== CONDITIONAL_KEYSET_ID) {
        throw new Error("unexpected conditional receive keyset");
      }
      return conditionalKeyset;
    }),
    mint: {
      restore: vi.fn(async () => ({ outputs: [], signatures: [] })),
    },
  };
}

async function markConditionalCounterReady(database: BitcasterDB): Promise<void> {
  await database.walletCounterAssociations.put({
    scopeId: browserWalletScope(seed).scopeId,
    normalizedMint: MINT,
    unit: "msat",
    keysetId: CONDITIONAL_KEYSET_ID,
    recoveryComplete: true,
  });
}

function admittedBearerTransfer(scopeId: string): DurableOutgoingCashuTransfer {
  const sendOutput = OutputData.createSingleDeterministicData(1, seed, 20, KEYSET_ID);
  const prepared = createDurableOutgoingCashuTransfer({
    transferId: "bearer-withdrawal:1",
    walletScopeId: scopeId,
    requestedAmount: "1",
    walletSendOperation: serializeDurableWalletSendOperation({
      operationId: "wallet-send:bearer-withdrawal:1",
      mintUrl: MINT,
      unit: "msat",
      preview: {
        amount: Amount.from(1),
        fees: Amount.zero(),
        keysetId: KEYSET_ID,
        inputs: [
          {
            id: KEYSET_ID,
            amount: Amount.from(1),
            secret: "withdrawal-input",
            C: "02" + "1".repeat(64),
          },
        ],
        sendOutputs: [sendOutput],
        keepOutputs: [],
        unselectedProofs: [],
      },
    }),
    deliveryIntent: {
      policy: "bearer-spend-classification",
      tokenBytesLimit: 4_096,
      tokenProofLimit: 1,
    },
    dueAtMs: 1,
  });
  const proof = proofForOutput(sendOutput);
  const serialized = serializeDurableWalletProof(proof);
  const proofRevision = (entry: { id: string; secret: string; C: string }) => ({
    proofIdentity: deriveDurableCustodyArtifactFingerprint({
      id: entry.id,
      secret: entry.secret,
      C: entry.C,
    }),
    revision: 0,
  });
  return admitDurableOutgoingCashuToken({
    transfer: prepared,
    keepProofs: [],
    sendProofs: [serialized],
    encodedToken: getEncodedTokenV4({ mint: MINT, unit: "msat", proofs: [proof] }),
    custodyRevisions: [
      ...prepared.walletSendOperation.preview.inputs.map(proofRevision),
      proofRevision(serialized),
    ],
    dueAtMs: 2,
  });
}

function bearerReclaimStates(
  outgoing: DurableOutgoingCashuTransfer,
  operation: Awaited<ReturnType<typeof prepareBrowserDurableWalletReceiveOperation>>,
): { prepared: DurableOutgoingCashuTransfer; terminal: DurableOutgoingCashuTransfer } {
  const Y = deriveDurableWalletProofY(outgoing.token!.proofs[0]!);
  const unspent = [{ Y, state: "UNSPENT" as const }];
  const classified = classifyDurableOutgoingBearerProofStates({
    transfer: outgoing,
    states: unspent,
    dueAtMs: 3,
  }).transfer;
  const prepared = prepareDurableOutgoingCashuReclaim({
    transfer: classified,
    reclaimId: operation.operationId,
    states: unspent,
    dueAtMs: 4,
    walletReceiveOperation: operation,
  });
  let terminal = outgoing;
  for (const dueAtMs of [3, 4, 5]) {
    terminal = classifyDurableOutgoingBearerProofStates({
      transfer: terminal,
      states: unspent,
      dueAtMs,
    }).transfer;
  }
  terminal = classifyDurableOutgoingBearerProofStates({
    transfer: terminal,
    states: [{ Y, state: "SPENT" }],
    dueAtMs: 6,
  }).transfer;
  return { prepared, terminal };
}

function receivePreviewForProof(
  input: Parameters<typeof hydrateDurableWalletProof>[0],
): SwapPreview {
  return {
    ...receivePreview(21),
    inputs: [hydrateDurableWalletProof(input)],
  } as SwapPreview;
}

function receivePreview(counter = 0, inputSecret = "input-secret"): SwapPreview {
  const output = OutputData.createSingleDeterministicData(1, seed, counter, KEYSET_ID);
  return {
    amount: Amount.from(1),
    fees: Amount.zero(),
    keysetId: KEYSET_ID,
    inputs: [{ id: KEYSET_ID, amount: Amount.from(1), secret: inputSecret, C: "input-C" }],
    sendOutputs: [],
    keepOutputs: [output],
    unselectedProofs: [],
  } as SwapPreview;
}

function outputSecret(preview: SwapPreview): string {
  return new TextDecoder().decode(preview.keepOutputs![0]!.secret);
}

function wallet(
  preview: SwapPreview,
  proof: Proof,
  counterStart = 0,
): BrowserDurableWalletReceiveWallet {
  const restoreSignature = signatureForOutput(preview.keepOutputs![0]!);
  const regularKeyset = Keyset.fromMintApi(
    { id: KEYSET_ID, unit: "msat", active: true },
    { id: KEYSET_ID, unit: "msat", active: true, keys: KEYS },
  );
  return {
    prepareSwapToReceive: vi.fn(async (_token, options) => {
      options?.onCountersReserved?.({
        keysetId: KEYSET_ID,
        start: counterStart,
        count: preview.keepOutputs!.length,
        next: counterStart + preview.keepOutputs!.length,
      });
      return preview;
    }),
    completeSwap: vi.fn(async () => ({ keep: [proof], send: [] })),
    checkProofsStates: vi.fn(),
    mint: {
      restore: vi.fn(
        async ({ outputs }: { outputs: Array<{ amount: Amount; id: string; B_: string }> }) => ({
          outputs,
          signatures: [restoreSignature],
        }),
      ),
    },
    getKeyset: vi.fn(() => regularKeyset),
  };
}

function signatureForOutput(output: OutputData) {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    output.blindedMessage.id,
  );
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY);
  return {
    id: output.blindedMessage.id,
    amount: output.blindedMessage.amount,
    C_: signature.C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  };
}

function proofForOutput(output: OutputData): Proof {
  return output.toProof(signatureForOutput(output), {
    id: output.blindedMessage.id,
    keys: output.blindedMessage.id === CONDITIONAL_KEYSET_ID ? CONDITIONAL_KEYS : KEYS,
  });
}

function statesFor(preview: SwapPreview, state: CheckStateEnum | "UNKNOWN") {
  return statesForProofs(preview.inputs, state);
}

function statesForProofs(proofs: readonly Proof[], state: CheckStateEnum | "UNKNOWN") {
  return proofs.map((proof) => ({
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state,
    witness: null,
  }));
}
