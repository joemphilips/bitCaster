// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
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
} from "@cashu/cashu-ts";
import {
  admitDurableOutgoingCashuToken,
  createDurableOutgoingCashuTransfer,
  DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX,
  type DurableOutgoingCashuTransfer,
} from "@bitcaster/client-sdk/durableOutgoingCashuTransfer";
import {
  serializeDurableWalletProof,
  hydrateDurableWalletSendPreview,
  serializeDurableWalletSendOperation,
} from "@bitcaster/client-sdk/durableWalletOperation";
import { deriveDurableCustodyArtifactFingerprint } from "@bitcaster/client-sdk/durableCustody";
import {
  listBrowserDurableOutgoingCashuDue,
  listBrowserDurableOutgoingCashuDueMints,
  executeBrowserDurableOutgoingCashuTransfer,
  recoverBrowserDurableOutgoingCashuTransfer,
  recoverBrowserDurableOutgoingCashuDuePage,
} from "../browserDurableOutgoingCashuTransfer";
import { BitcasterDB, type BrowserOutgoingCashuTransferRow } from "../../stores/proof-db";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { createBrowserProofBackupAuthorityRow } from "../../stores/browser-proof-backup-authority";

const MINT = "https://mint.example";
const SCOPE = "wallet-scope";
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7]);
const KEYS = { "1": bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) };
const KEYSET_ID = deriveKeysetId(KEYS);
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser durable outgoing Cashu store", () => {
  it("orders one mint due page by due time then transfer ID", async () => {
    const database = createDatabase();
    await database.outgoingCashuTransfers.bulkPut([
      row(transfer("c", 20)),
      row(transfer("b", 10)),
      row(transfer("a", 10)),
    ]);

    const first = await listBrowserDurableOutgoingCashuDue({
      scopeId: SCOPE,
      mintUrl: MINT,
      dueBeforeMs: 20,
      cursor: null,
      limit: 2,
      maximumBytes: 4 * 1024 * 1024,
      database,
    });
    const second = await listBrowserDurableOutgoingCashuDue({
      scopeId: SCOPE,
      mintUrl: MINT,
      dueBeforeMs: 20,
      cursor: first.nextCursor,
      limit: 2,
      maximumBytes: 4 * 1024 * 1024,
      database,
    });

    expect(first.transfers.map(({ transferId }) => transferId)).toEqual(["a", "b"]);
    expect(second.transfers.map(({ transferId }) => transferId)).toEqual(["c"]);
    expect(second.nextCursor).toBeNull();
  });

  it("discovers due mints by due time before mint", async () => {
    const database = createDatabase();
    const laterMint = transfer("later-mint", 20);
    const earlierMint = transferForScope("earlier-mint", 10, SCOPE, "https://a-mint.example");
    await database.outgoingCashuTransfers.bulkPut([row(laterMint), row(earlierMint)]);

    await expect(
      listBrowserDurableOutgoingCashuDueMints({
        scopeId: SCOPE,
        dueBeforeMs: 20,
        database,
      }),
    ).resolves.toEqual({ mints: ["https://a-mint.example", MINT], hasMore: false });
  });

  it("reads no more than one due-page of keys while discovering due mints", async () => {
    const database = createDatabase();
    const backlog = Array.from(
      { length: DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX },
      (_, index) => row(transferForScope(`backlog-${index.toString().padStart(3, "0")}`, 0, SCOPE)),
    );
    await database.outgoingCashuTransfers.bulkPut([
      ...backlog,
      row(transferForScope("later-mint", 1, SCOPE, "https://later-mint.example")),
    ]);

    await expect(
      listBrowserDurableOutgoingCashuDueMints({ scopeId: SCOPE, dueBeforeMs: 1, database }),
    ).resolves.toEqual({ mints: [MINT], hasMore: true });

    await database.outgoingCashuTransfers.bulkDelete(
      backlog.map(({ scopeId, transferId }) => [scopeId, transferId]),
    );
    await expect(
      listBrowserDurableOutgoingCashuDueMints({ scopeId: SCOPE, dueBeforeMs: 1, database }),
    ).resolves.toEqual({ mints: ["https://later-mint.example"], hasMore: false });
  });

  it("does not let completed delivery-pending rows starve prepared mint recovery", async () => {
    const database = createDatabase();
    const completed = Array.from(
      { length: DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX + 1 },
      (_, index) => row(admittedTransfer(`complete-${index.toString().padStart(3, "0")}`, SCOPE)),
    );
    await database.outgoingCashuTransfers.bulkPut([
      ...completed,
      row(transfer("prepared-after-completed", 0)),
    ]);

    const page = await listBrowserDurableOutgoingCashuDue({
      scopeId: SCOPE,
      mintUrl: MINT,
      dueBeforeMs: 0,
      cursor: null,
      limit: DURABLE_OUTGOING_CASHU_RECOVERY_PAGE_LIMIT_MAX,
      maximumBytes: 4 * 1024 * 1024,
      database,
    });

    expect(page.transfers.map(({ transferId }) => transferId)).toEqual([
      "prepared-after-completed",
    ]);
    expect(page.nextCursor).toBeNull();
  });

  it("stops materializing a due page at its exact byte bound", async () => {
    const database = createDatabase();
    await database.outgoingCashuTransfers.bulkPut([row(transfer("a", 0)), row(transfer("b", 0))]);
    const size = (
      await listBrowserDurableOutgoingCashuDue({
        scopeId: SCOPE,
        mintUrl: MINT,
        dueBeforeMs: 0,
        cursor: null,
        limit: 1,
        maximumBytes: 4 * 1024 * 1024,
        database,
      })
    ).storedBytes;
    const page = await listBrowserDurableOutgoingCashuDue({
      scopeId: SCOPE,
      mintUrl: MINT,
      dueBeforeMs: 0,
      cursor: null,
      limit: 2,
      maximumBytes: size,
      database,
    });

    expect(page.transfers.map(({ transferId }) => transferId)).toEqual(["a"]);
    expect(page.nextCursor).toEqual({ dueAtMs: 0, transferId: "a" });
  });

  it("does not report more work when an exact-full due page is final", async () => {
    const database = createDatabase();
    await database.outgoingCashuTransfers.put(row(transfer("a", 0)));
    const full = await listBrowserDurableOutgoingCashuDue({
      scopeId: SCOPE,
      mintUrl: MINT,
      dueBeforeMs: 0,
      cursor: null,
      limit: 1,
      maximumBytes: 4 * 1024 * 1024,
      database,
    });
    const exact = await listBrowserDurableOutgoingCashuDue({
      scopeId: SCOPE,
      mintUrl: MINT,
      dueBeforeMs: 0,
      cursor: null,
      limit: 2,
      maximumBytes: full.storedBytes,
      database,
    });

    expect(exact.transfers.map(({ transferId }) => transferId)).toEqual(["a"]);
    expect(exact.nextCursor).toBeNull();
  });

  it("keeps pending token authority out of encrypted proof backup tables", async () => {
    const database = createDatabase();
    await database.outgoingCashuTransfers.put(row(transfer("pending", 0)));

    expect(await database.outgoingCashuTransfers.count()).toBe(1);
    expect(await database.custodyProofBackupAuthorities.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
  });

  it("rejects a due record that exceeds the requested byte bound", async () => {
    const database = createDatabase();
    await database.outgoingCashuTransfers.bulkPut([
      row(transfer("c", 20)),
      row(transfer("b", 10)),
      row(transfer("a", 10)),
    ]);

    await expect(
      listBrowserDurableOutgoingCashuDue({
        scopeId: SCOPE,
        mintUrl: MINT,
        dueBeforeMs: 20,
        cursor: null,
        limit: 2,
        maximumBytes: 1,
        database,
      }),
    ).rejects.toThrow("byte limit");
  });

  it("recovers a persisted delivery-pending transfer without presenting its token", async () => {
    const database = createDatabase();
    const seed = new Uint8Array(64).fill(9);
    const scope = browserWalletScope(seed);
    const pending = admittedTransfer("restart", scope.scopeId);
    await database.outgoingCashuTransfers.put({
      ...row(pending),
      scopeId: scope.scopeId,
      transfer: pending,
    });
    const wallet = {
      completeSwap: vi.fn(),
      checkProofsStates: vi.fn(),
      getKeyset: vi.fn(),
    };

    const result = await recoverBrowserDurableOutgoingCashuTransfer({
      transferId: pending.transferId,
      wallet,
      restoreExactOutputs: vi.fn(),
      context: {
        seed,
        database,
        requireCapturedProfile: vi.fn(),
        lockManager: { request: async (_name, _options, action) => action(null as never) } as Pick<
          LockManager,
          "request"
        >,
      },
    });

    expect(result?.deliveryState).toBe("delivery-pending");
    expect(wallet.completeSwap).not.toHaveBeenCalled();
    expect(wallet.checkProofsStates).not.toHaveBeenCalled();
  });

  it("continues a due page after one recovery fails and defers only that transfer", async () => {
    const fixture = await executionFixture();
    fixture.wallet.completeSwap.mockRejectedValueOnce(new Error("mint interrupted"));
    await expect(executeBrowserDurableOutgoingCashuTransfer(fixture.input)).rejects.toThrow(
      "mint interrupted",
    );
    fixture.wallet.checkProofsStates.mockResolvedValue([
      {
        Y: hashToCurve(new TextEncoder().encode("input-execute")).toHex(true),
        state: CheckStateEnum.UNSPENT,
        witness: null,
      },
    ]);
    const failed = transferForScope("a-failed", 0, fixture.scope.scopeId);
    await fixture.database.outgoingCashuTransfers.put(row(failed));
    const walletForMint = vi.fn(async () => fixture.wallet);

    const first = await recoverBrowserDurableOutgoingCashuDuePage({
      mintUrl: MINT,
      dueBeforeMs: 1_000,
      cursor: null,
      walletForMint,
      restoreExactOutputs: fixture.restoreExactOutputs,
      context: fixture.context,
    });
    const retried = await fixture.database.outgoingCashuTransfers.get([
      fixture.scope.scopeId,
      failed.transferId,
    ]);
    const restart = await recoverBrowserDurableOutgoingCashuDuePage({
      mintUrl: MINT,
      dueBeforeMs: 1_000,
      cursor: null,
      walletForMint,
      restoreExactOutputs: fixture.restoreExactOutputs,
      context: fixture.context,
    });

    expect(first.failed).toBe(1);
    expect(fixture.wallet.completeSwap).toHaveBeenCalledTimes(2);
    expect(retried?.transfer.recovery).toEqual({ attemptCount: 1, dueAtMs: 6_000 });
    expect(restart.transfers).toEqual([]);
    expect(walletForMint).toHaveBeenCalledOnce();
  });

  it("loads one wallet per mint and unit while recovering a page", async () => {
    const database = createDatabase();
    const seed = new Uint8Array(64).fill(6);
    const scope = browserWalletScope(seed);
    await database.outgoingCashuTransfers.bulkPut([
      row(transferForScope("a", 0, scope.scopeId)),
      row(transferForScope("b", 0, scope.scopeId)),
    ]);
    const wallet = {
      completeSwap: vi.fn(),
      checkProofsStates: vi.fn(),
      getKeyset: vi.fn(),
    };
    const walletForMint = vi.fn(async () => wallet);

    const page = await recoverBrowserDurableOutgoingCashuDuePage({
      mintUrl: MINT,
      dueBeforeMs: 0,
      cursor: null,
      walletForMint,
      restoreExactOutputs: vi.fn(),
      context: recoveryContext(seed, database),
    });

    expect(page.failed).toBe(2);
    expect(walletForMint).toHaveBeenCalledOnce();
    expect(walletForMint).toHaveBeenCalledWith(MINT, "sat");
  });

  it("caches a rejected wallet factory promise for every row in one page", async () => {
    const database = createDatabase();
    const seed = new Uint8Array(64).fill(7);
    const scope = browserWalletScope(seed);
    await database.outgoingCashuTransfers.bulkPut([
      row(transferForScope("a", 0, scope.scopeId)),
      row(transferForScope("b", 0, scope.scopeId)),
    ]);
    const walletForMint = vi.fn(async () => {
      throw new Error("wallet factory failed");
    });

    const page = await recoverBrowserDurableOutgoingCashuDuePage({
      mintUrl: MINT,
      dueBeforeMs: 0,
      cursor: null,
      walletForMint,
      restoreExactOutputs: vi.fn(),
      context: recoveryContext(seed, database),
    });

    expect(page.failed).toBe(2);
    expect(walletForMint).toHaveBeenCalledOnce();
  });

  it("continues a due page when a higher retry revision records concurrent progress", async () => {
    const database = createDatabase();
    const seed = new Uint8Array(64).fill(8);
    const scope = browserWalletScope(seed);
    const stale = transferForScope("stale", 0, scope.scopeId);
    const later = transferForScope("later", 0, scope.scopeId);
    await database.outgoingCashuTransfers.bulkPut([row(stale), row(later)]);
    let lockCalls = 0;
    const context = recoveryContext(seed, database, {
      request: async (_name, _options, action) => {
        lockCalls += 1;
        if (lockCalls === 2) {
          await database.outgoingCashuTransfers.put(
            row({ ...stale, recovery: { dueAtMs: 0, attemptCount: 0 }, revision: 1 }),
          );
        }
        return action(null as never);
      },
    } as Pick<LockManager, "request">);
    const wallet = { completeSwap: vi.fn(), checkProofsStates: vi.fn(), getKeyset: vi.fn() };

    const page = await recoverBrowserDurableOutgoingCashuDuePage({
      mintUrl: MINT,
      dueBeforeMs: 0,
      cursor: null,
      walletForMint: vi.fn(async () => wallet),
      restoreExactOutputs: vi.fn(),
      context,
    });
    expect(lockCalls).toBe(4);
    expect(page.failed).toBe(2);

    expect(
      (await database.outgoingCashuTransfers.get([scope.scopeId, stale.transferId]))?.transfer
        .revision,
    ).toBe(1);
    expect(
      (await database.outgoingCashuTransfers.get([scope.scopeId, later.transferId]))?.transfer
        .recovery,
    ).toEqual({ attemptCount: 1, dueAtMs: 6_000 });
  });

  it("persists exact pre-mint authority and atomically admits the exact minted token", async () => {
    const fixture = await executionFixture();

    const result = await executeBrowserDurableOutgoingCashuTransfer(fixture.input);

    expect(fixture.prepareWalletSendOperation).toHaveBeenCalledOnce();
    expect(fixture.wallet.completeSwap).toHaveBeenCalledOnce();
    expect(result.deliveryState).toBe("delivery-pending");
    expect(result.token?.encodedToken).toHaveLength(result.token?.encodedLength ?? 0);
    expect(
      (await fixture.database.custodyOperations.toArray())[0]?.record.operation.result.state,
    ).toBe("applied");
    expect(
      (await fixture.database.custodyProofs.get([fixture.scope.scopeId, fixture.inputProofId]))
        ?.selectability,
    ).toBe("spent");
    expect(
      (await fixture.database.outgoingCashuTransfers.get([fixture.scope.scopeId, "execute"]))
        ?.transfer.deliveryState,
    ).toBe("delivery-pending");
    expect(await fixture.database.outgoingCashuTransferAdmissions.count()).toBe(0);
  });

  it("rolls back post-mint custody admission and token authority before commit", async () => {
    const fixture = await executionFixture("before-commit");

    await expect(executeBrowserDurableOutgoingCashuTransfer(fixture.input)).rejects.toThrow(
      "injected browser custody fault before commit",
    );

    expect(fixture.wallet.completeSwap).toHaveBeenCalledOnce();
    expect(
      (await fixture.database.custodyOperations.toArray())[0]?.record.operation.result.state,
    ).toBe("none");
    expect(
      (await fixture.database.outgoingCashuTransfers.get([fixture.scope.scopeId, "execute"]))
        ?.transfer.deliveryState,
    ).toBe("prepared");
    expect(
      (await fixture.database.outgoingCashuTransfers.get([fixture.scope.scopeId, "execute"]))
        ?.admissionState,
    ).toBe("reserved");
    expect(await fixture.database.outgoingCashuTransferAdmissions.count()).toBe(1);
    expect(
      (await fixture.database.custodyProofs.get([fixture.scope.scopeId, fixture.inputProofId]))
        ?.selectability,
    ).toBe("locked");
  });

  it("fails physical storage admission before mint I/O", async () => {
    const fixture = await executionFixture();
    vi.spyOn(fixture.database.outgoingCashuTransferAdmissions, "put").mockRejectedValueOnce(
      new DOMException("quota", "QuotaExceededError"),
    );

    await expect(executeBrowserDurableOutgoingCashuTransfer(fixture.input)).rejects.toThrow(
      "quota",
    );

    expect(fixture.wallet.completeSwap).not.toHaveBeenCalled();
    expect(await fixture.database.outgoingCashuTransfers.count()).toBe(0);
    expect(await fixture.database.custodyOperations.count()).toBe(0);
  });

  it("retains post-commit authority and recovers without fresh selection or mint I/O", async () => {
    const fixture = await executionFixture("after-commit");

    await expect(executeBrowserDurableOutgoingCashuTransfer(fixture.input)).rejects.toThrow(
      "injected browser custody fault after commit",
    );
    const preparedCalls = fixture.prepareWalletSendOperation.mock.calls.length;
    const mintCalls = fixture.wallet.completeSwap.mock.calls.length;
    const recovered = await recoverBrowserDurableOutgoingCashuTransfer({
      transferId: "execute",
      wallet: fixture.wallet,
      restoreExactOutputs: fixture.restoreExactOutputs,
      context: fixture.context,
    });

    expect(recovered?.deliveryState).toBe("delivery-pending");
    expect(fixture.prepareWalletSendOperation).toHaveBeenCalledTimes(preparedCalls);
    expect(fixture.wallet.completeSwap).toHaveBeenCalledTimes(mintCalls);
    expect(
      (await fixture.database.custodyOperations.toArray())[0]?.record.operation.result.state,
    ).toBe("applied");
  });

  it("retries the exact persisted operation after a pre-mint transport failure", async () => {
    const fixture = await executionFixture();
    fixture.wallet.completeSwap.mockRejectedValueOnce(new Error("mint interrupted"));

    await expect(executeBrowserDurableOutgoingCashuTransfer(fixture.input)).rejects.toThrow(
      "mint interrupted",
    );
    const restarted = walletFor(fixture.sendProof);
    restarted.checkProofsStates.mockResolvedValue([
      {
        Y: hashToCurve(new TextEncoder().encode("input-execute")).toHex(true),
        state: CheckStateEnum.UNSPENT,
        witness: null,
      },
    ]);
    const recovered = await recoverBrowserDurableOutgoingCashuTransfer({
      transferId: "execute",
      wallet: restarted,
      restoreExactOutputs: fixture.restoreExactOutputs,
      context: fixture.context,
    });

    expect(recovered?.deliveryState).toBe("delivery-pending");
    expect(fixture.prepareWalletSendOperation).toHaveBeenCalledOnce();
    expect(restarted.completeSwap).toHaveBeenCalledOnce();
  });

  it("fences a transfer to its originating browser profile scope", async () => {
    const fixture = await executionFixture();
    await executeBrowserDurableOutgoingCashuTransfer(fixture.input);
    const foreignWallet = walletFor(fixture.sendProof);

    const foreign = await recoverBrowserDurableOutgoingCashuTransfer({
      transferId: "execute",
      wallet: foreignWallet,
      restoreExactOutputs: fixture.restoreExactOutputs,
      context: { ...fixture.context, seed: new Uint8Array(64).fill(4) },
    });

    expect(foreign).toBeNull();
    expect(foreignWallet.completeSwap).not.toHaveBeenCalled();
    expect(await fixture.database.outgoingCashuTransfers.count()).toBe(1);
  });

  it("stores only the exact keep proof derivation locator", async () => {
    const fixture = await executionFixture(undefined, true);

    await executeBrowserDurableOutgoingCashuTransfer(fixture.input);

    const keep = (await fixture.database.custodyProofs.toArray()).find(
      ({ selectability }) => selectability === "selectable",
    );
    expect(keep).toBeDefined();
    expect(
      await fixture.database.custodyProofBackupAuthorities.get([
        fixture.scope.scopeId,
        keep!.proofId,
      ]),
    ).toMatchObject({
      derivationLocator: {
        schemaVersion: 1,
        kind: "nut13",
        keysetId: KEYSET_ID,
        counter: 2,
      },
    });
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(1);
  });

  it("rejects a keep locator with the wrong counter before post-mint admission", async () => {
    const fixture = await executionFixture(undefined, true);

    await expect(
      executeBrowserDurableOutgoingCashuTransfer({
        ...fixture.input,
        keepProofDerivationLocators: [
          { schemaVersion: 1, kind: "nut13", keysetId: KEYSET_ID, counter: 3 },
        ],
      }),
    ).rejects.toThrow("locator conflicts");
    expect(fixture.wallet.completeSwap).not.toHaveBeenCalled();
    expect(await fixture.database.outgoingCashuTransfers.count()).toBe(0);
    expect(await fixture.database.outgoingCashuTransferAdmissions.count()).toBe(0);
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
  });

  it("rejects reordered keep locators before post-mint admission", async () => {
    const fixture = await executionFixture(undefined, true, 2);

    await expect(
      executeBrowserDurableOutgoingCashuTransfer({
        ...fixture.input,
        keepProofDerivationLocators: [
          { schemaVersion: 1, kind: "nut13", keysetId: KEYSET_ID, counter: 3 },
          { schemaVersion: 1, kind: "nut13", keysetId: KEYSET_ID, counter: 2 },
        ],
      }),
    ).rejects.toThrow("locator conflicts");
    expect(fixture.wallet.completeSwap).not.toHaveBeenCalled();
    expect(await fixture.database.outgoingCashuTransfers.count()).toBe(0);
    expect(await fixture.database.outgoingCashuTransferAdmissions.count()).toBe(0);
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
  });
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`browser-durable-outgoing-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

function transfer(transferId: string, dueAtMs: number): DurableOutgoingCashuTransfer {
  return transferForScope(transferId, dueAtMs, SCOPE);
}

function transferForScope(
  transferId: string,
  dueAtMs: number,
  scopeId: string,
  mintUrl = MINT,
): DurableOutgoingCashuTransfer {
  const output = OutputData.createSingleDeterministicData(
    1,
    new Uint8Array(64).fill(7),
    transferId.charCodeAt(0),
    "0000000000000001",
  );
  return createDurableOutgoingCashuTransfer({
    transferId,
    walletScopeId: scopeId,
    requestedAmount: "1",
    walletSendOperation: serializeDurableWalletSendOperation({
      operationId: `wallet-send:${transferId}`,
      mintUrl,
      unit: "sat",
      preview: {
        amount: Amount.from(1),
        fees: Amount.zero(),
        keysetId: "0000000000000001",
        inputs: [
          {
            id: "0000000000000001",
            amount: Amount.from(1),
            secret: `input-${transferId}`,
            C: "02" + "1".repeat(64),
          },
        ],
        sendOutputs: [output],
        keepOutputs: [],
        unselectedProofs: [],
      },
    }),
    deliveryIntent: {
      policy: "bearer-spend-classification",
      tokenBytesLimit: 1024,
      tokenProofLimit: 1,
    },
    dueAtMs,
  });
}

function admittedTransfer(transferId: string, scopeId: string): DurableOutgoingCashuTransfer {
  const prepared = transferForScope(transferId, 0, scopeId);
  const output = prepared.walletSendOperation.preview.sendOutputs[0]!;
  const proof = {
    id: output.blindedMessage.id,
    amount: Amount.from(output.blindedMessage.amount),
    secret: output.secret,
    C: "02" + "2".repeat(64),
  };
  const identity = (entry: { id: string; secret: string; C: string }) =>
    deriveDurableCustodyArtifactFingerprint({ id: entry.id, secret: entry.secret, C: entry.C });
  return admitDurableOutgoingCashuToken({
    transfer: prepared,
    keepProofs: [],
    sendProofs: [serializeDurableWalletProof(proof)],
    encodedToken: getEncodedTokenV4({ mint: MINT, unit: "sat", proofs: [proof] }),
    custodyRevisions: [...prepared.walletSendOperation.preview.inputs, proof].map((entry) => ({
      proofIdentity: identity(entry),
      revision: 0,
    })),
    dueAtMs: 0,
  });
}

function row(transfer: DurableOutgoingCashuTransfer): BrowserOutgoingCashuTransferRow {
  return {
    scopeId: transfer.walletScopeId,
    mintUrl: transfer.mintUrl,
    mintRecoveryState: transfer.deliveryState === "prepared" ? "pending" : "complete",
    localAuthorityState:
      transfer.deliveryState === "recipient-acknowledged" ||
      transfer.deliveryState === "bearer-spent" ||
      transfer.deliveryState === "reclaimed"
        ? "terminal"
        : "nonterminal",
    dueAtMs: transfer.recovery.dueAtMs,
    transferId: transfer.transferId,
    admissionState: "consumed",
    transfer,
  };
}

function recoveryContext(
  seed: Uint8Array,
  database: BitcasterDB,
  lockManager: Pick<LockManager, "request"> = {
    request: async (_name, _options, action) => action(null as never),
  } as Pick<LockManager, "request">,
) {
  return {
    seed,
    database,
    now: () => 1_000,
    requireCapturedProfile: vi.fn(),
    lockManager,
  };
}

async function executionFixture(
  injectFault?: "before-commit" | "after-commit",
  includeKeep = false,
  keepCount = includeKeep ? 1 : 0,
) {
  const database = createDatabase();
  const seed = new Uint8Array(64).fill(3);
  const scope = browserWalletScope(seed);
  const operation = executionOperation(keepCount, seed);
  const inputProof = operation.preview.inputs[0]!;
  const inputProofId = await addInputProof(database, scope.scopeId, inputProof);
  const preview = hydrateDurableWalletSendPreview(operation);
  const sendProof = proofForOutput(preview.sendOutputs![0]!);
  const keepOutputs = preview.keepOutputs ?? [];
  if (keepOutputs.length !== keepCount) throw new Error("keep fixture outputs are invalid");
  const wallet = walletFor(sendProof, keepOutputs.map(proofForOutput));
  const prepareWalletSendOperation = vi.fn(async () => operation);
  const restoreExactOutputs = vi.fn();
  const context = {
    seed,
    database,
    now: () => 1_000,
    randomId: () => "test",
    requireCapturedProfile: vi.fn(),
    lockManager: { request: async (_name, _options, action) => action(null as never) } as Pick<
      LockManager,
      "request"
    >,
    ...(injectFault === undefined ? {} : { injectFault }),
  };
  return {
    database,
    scope,
    operation,
    inputProofId,
    sendProof,
    wallet,
    prepareWalletSendOperation,
    restoreExactOutputs,
    context,
    input: {
      transfer: {
        transferId: "execute",
        mintUrl: MINT,
        unit: "sat",
        requestedAmount: "1",
        deliveryIntent: {
          policy: "bearer-spend-classification" as const,
          tokenBytesLimit: 4 * 1024,
          tokenProofLimit: 1,
        },
      },
      prepareWalletSendOperation,
      keepProofDerivationLocators: Array.from({ length: keepCount }, (_, index) => ({
        schemaVersion: 1 as const,
        kind: "nut13" as const,
        keysetId: KEYSET_ID,
        counter: index + 2,
      })),
      wallet,
      restoreExactOutputs,
      context,
    },
  };
}

function executionOperation(keepCount: number, seed: Uint8Array) {
  const sendOutput = OutputData.createSingleDeterministicData(1, seed, 1, KEYSET_ID);
  return serializeDurableWalletSendOperation({
    operationId: "wallet-send:execute",
    mintUrl: MINT,
    unit: "sat",
    preview: {
      amount: Amount.from(keepCount + 1),
      fees: Amount.zero(),
      keysetId: KEYSET_ID,
      inputs: [
        {
          id: KEYSET_ID,
          amount: Amount.from(keepCount + 1),
          secret: "input-execute",
          C: "02" + "1".repeat(64),
        },
      ],
      sendOutputs: [sendOutput],
      keepOutputs: Array.from({ length: keepCount }, (_, index) =>
        OutputData.createSingleDeterministicData(1, seed, index + 2, KEYSET_ID),
      ),
      unselectedProofs: [],
    },
  });
}

async function addInputProof(
  database: BitcasterDB,
  scopeId: string,
  proof: { id: string; amount: string; secret: string; C: string },
): Promise<string> {
  const row = createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: MINT,
    unit: "sat",
    proof: { id: proof.id, amount: Amount.from(proof.amount), secret: proof.secret, C: proof.C },
    asset: { kind: "regular" },
    receivedAtMs: 0,
  });
  await database.custodyProofs.put(row);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(row, 0, null, "initial-admission"),
  );
  return row.proofId;
}

function walletFor(sendProof: Proof, keepProofs: Proof[] = []) {
  return {
    completeSwap: vi.fn(async () => ({
      keep: keepProofs,
      send: [sendProof],
    })),
    checkProofsStates: vi.fn(),
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
