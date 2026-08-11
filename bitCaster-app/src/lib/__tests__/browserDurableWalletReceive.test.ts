// @vitest-environment node
import "fake-indexeddb/auto";
import { bytesToHex } from "@noble/curves/utils.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import {
  Amount,
  CheckStateEnum,
  OutputData,
  createBlindSignature,
  createDLEQProof,
  deriveKeysetId,
  getEncodedTokenV4,
  hashToCurve,
  pointFromHex,
  type Proof,
  type SwapPreview,
} from "@cashu/cashu-ts";
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

const MINT = "https://mint.example";
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7]);
const KEYS = { "1": bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) };
const KEYSET_ID = deriveKeysetId(KEYS);
const seed = new Uint8Array(64).fill(1);
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser durable ordinary receive", () => {
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
        unit: "sat",
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
    const recovered = await recoverBrowserDurableWalletReceives({
      context,
      walletForMint: async () => restarted,
    });

    expect(recovered.pending).toBe(0);
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
          unit: "sat",
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
        unit: "sat",
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
          unit: "sat",
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
        unit: "sat",
        wallet: first,
        context: receiveContext(database, "before-commit"),
      }),
    ).rejects.toThrow("injected browser custody fault before commit");
    expect((await database.custodyOperations.toArray())[0]?.record.operation.result.state).toBe(
      "verified-staged",
    );
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
        unit: "sat",
        wallet: first,
        context: receiveContext(database, "after-commit"),
      }),
    ).rejects.toThrow("injected browser custody fault after commit");
    expect((await database.custodyOperations.toArray())[0]?.record.operation.result.state).toBe(
      "applied",
    );
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
        unit: "sat",
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
        unit: "sat",
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
        unit: "sat",
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
        unit: "sat",
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
      unit: "sat",
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
        unit: "sat",
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
        unit: "sat",
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
        unit: "sat",
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
        unit: "sat",
        wallet: first,
        context: receiveContext(database, undefined, "a"),
      }),
    ).rejects.toThrow("first crash");
    await expect(
      receiveBrowserDurableWalletToken({
        token: "second-token",
        mintUrl: MINT,
        unit: "sat",
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
          unit: "sat",
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
        unit: "sat",
        proof,
        asset: { kind: "regular" },
        receivedAtMs: 1,
      }),
      selectability: "locked",
      reservationOperationId: "order-1",
    });
    const legacy = { ...proof, mintUrl: MINT, baseAsset: "sat" as const, unit: "sat" as const };
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

function admittedBearerTransfer(scopeId: string): DurableOutgoingCashuTransfer {
  const sendOutput = OutputData.createSingleDeterministicData(1, seed, 20, KEYSET_ID);
  const prepared = createDurableOutgoingCashuTransfer({
    transferId: "bearer-withdrawal:1",
    walletScopeId: scopeId,
    requestedAmount: "1",
    walletSendOperation: serializeDurableWalletSendOperation({
      operationId: "wallet-send:bearer-withdrawal:1",
      mintUrl: MINT,
      unit: "sat",
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
    encodedToken: getEncodedTokenV4({ mint: MINT, unit: "sat", proofs: [proof] }),
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
    getKeyset: vi.fn(() => ({
      id: KEYSET_ID,
      unit: "sat",
      keys: KEYS,
      fee: 0,
      verify: () => true,
    })),
  };
}

function signatureForOutput(output: OutputData) {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    KEYSET_ID,
  );
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY);
  return {
    id: KEYSET_ID,
    amount: output.blindedMessage.amount,
    C_: signature.C_.toHex(true),
    dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
  };
}

function proofForOutput(output: OutputData): Proof {
  return output.toProof(signatureForOutput(output), { id: KEYSET_ID, keys: KEYS });
}

function statesFor(preview: SwapPreview, state: CheckStateEnum | "UNKNOWN") {
  return preview.inputs.map((proof) => ({
    Y: hashToCurve(new TextEncoder().encode(proof.secret)).toHex(true),
    state,
    witness: null,
  }));
}
