// @vitest-environment node
import "fake-indexeddb/auto";
import Dexie from "dexie";
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
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  listBrowserDurableOutgoingCashuDue,
  listBrowserDurableOutgoingCashuDueMints,
  executeBrowserDurableOutgoingCashuTransfer,
  findBrowserDurableOutgoingBearerTransfer,
  findBrowserDurableOutgoingCashuTransferByRecipientBinding,
  recoverBrowserDurableOutgoingCashuTransfer,
  recoverBrowserDurableOutgoingCashuDuePage,
} from "../browserDurableOutgoingCashuTransfer";
import {
  BitcasterDB,
  BOUNDED_CANONICAL_RANGE_PROOF_LIMIT_MAX,
  getBoundedCanonicalRangeProofsForKeyset,
  getBoundedCanonicalSatProofs,
  getBoundedCanonicalRegularProofs,
  MARKET_FUNDING_INPUT_PROOF_LIMIT_MAX,
  type BrowserOutgoingCashuTransferRow,
} from "../../stores/proof-db";
import { browserWalletScope } from "../browserCtfRangeOrderSource";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import {
  advanceBrowserProofBackupAuthorityRow,
  createBrowserProofBackupAuthorityRow,
} from "../../stores/browser-proof-backup-authority";
import { claimBrowserParticipationScoreDeliveryPointer } from "../browserParticipationScoreDeliveryPointer";

const MINT = "https://mint.example";
const SCOPE = "wallet-scope";
const PRIVATE_KEY = Uint8Array.from([...new Uint8Array(31), 7]);
const KEYS = { "1": bytesToHex(secp256k1.getPublicKey(PRIVATE_KEY, true)) };
const KEYSET_ID = deriveKeysetId(KEYS);
const FEE_KEYSET_ID = deriveKeysetId(KEYS, { input_fee_ppk: 500 });
const OLD_V2_KEYSET_ID = `01${"22".repeat(32)}`;
const SELECTOR_SCOPE_ID = browserWalletScope(new Uint8Array(64).fill(8)).scopeId;
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("browser durable outgoing Cashu store", () => {
  it("migrates the bounded bearer-resume index and rejects an ambiguous mint", async () => {
    const name = `browser-outgoing-v13-${crypto.randomUUID()}`;
    const seed = new Uint8Array(64).fill(9);
    const scopeId = browserWalletScope(seed).scopeId;
    const first = row(admittedTransfer("bearer-a", scopeId));
    const second = row(admittedTransfer("bearer-b", scopeId));
    const legacy = new Dexie(name);
    legacy.version(13).stores({
      outgoingCashuTransfers:
        "&[scopeId+transferId], [scopeId+mintUrl+mintRecoveryState+dueAtMs+transferId], [scopeId+mintRecoveryState+dueAtMs+mintUrl+transferId], [scopeId+localAuthorityState+transferId], [scopeId+recipientBinding+transferId]",
    });
    await legacy.open();
    await legacy
      .table("outgoingCashuTransfers")
      .bulkPut([first, second].map(({ bearerMintUrl: _ignored, ...record }) => record));
    legacy.close();

    const database = new BitcasterDB(name);
    databases.push(database);
    await database.open();
    expect(
      (await database.outgoingCashuTransfers.toArray()).every((row) => row.bearerMintUrl === MINT),
    ).toBe(true);
    await expect(
      findBrowserDurableOutgoingBearerTransfer({
        mintUrl: MINT,
        context: recoveryContext(seed, database),
      }),
    ).rejects.toThrow(/ambiguous/);
  });
  it("finds one exact recipient binding without scanning other transfers", async () => {
    const database = createDatabase();
    const seed = new Uint8Array(64).fill(3);
    const scope = browserWalletScope(seed);
    const binding = "a".repeat(64);
    await database.outgoingCashuTransfers.bulkPut([
      row(recipientTransfer("recipient", binding, scope.scopeId)),
      row(transferForScope("other", 0, scope.scopeId)),
    ]);

    await expect(
      findBrowserDurableOutgoingCashuTransferByRecipientBinding({
        productBindingSha256: binding,
        context: recoveryContext(seed, database),
      }),
    ).resolves.toMatchObject({ transferId: "recipient" });
  });

  it("bounds largest-first market-funding candidates beyond one selection page", async () => {
    const database = createDatabase();
    const proofCount = MARKET_FUNDING_INPUT_PROOF_LIMIT_MAX + 1;
    const rows = Array.from({ length: proofCount }, (_, index) =>
      custodyProof(SELECTOR_SCOPE_ID, "msat", {
        secret: `funding-${index.toString().padStart(5, "0")}`,
        amount: index + 1,
        id: KEYSET_ID,
      }),
    );
    await database.custodyProofs.bulkPut(rows);

    const selected = await getBoundedCanonicalRegularProofs(
      MINT,
      { scopeId: SELECTOR_SCOPE_ID, unit: "msat" },
      database,
    );

    expect(selected).toHaveLength(MARKET_FUNDING_INPUT_PROOF_LIMIT_MAX);
    expect(amountToNumber(selected[0]!.amount)).toBe(proofCount);
    expect(amountToNumber(selected.at(-1)!.amount)).toBe(2);
  });

  it("includes an exact recovered canonical V2 market-funding keyset", async () => {
    const database = createDatabase();
    await database.custodyProofs.bulkPut([
      custodyProof(SELECTOR_SCOPE_ID, "msat", {
        secret: "active-market-proof",
        amount: 1,
        id: KEYSET_ID,
      }),
      custodyProof(SELECTOR_SCOPE_ID, "msat", {
        secret: "recovered-v2-market-proof",
        amount: 8,
        id: OLD_V2_KEYSET_ID,
      }),
    ]);

    const selected = await getBoundedCanonicalRegularProofs(
      MINT,
      { scopeId: SELECTOR_SCOPE_ID, unit: "msat" },
      database,
    );

    expect(selected.map(({ secret }) => secret)).toEqual([
      "recovered-v2-market-proof",
      "active-market-proof",
    ]);
  });

  it("selects range proofs only from the exact canonical custody authority", async () => {
    const database = createDatabase();
    const exact = custodyProof(SELECTOR_SCOPE_ID, "msat", {
      secret: "range-exact",
      amount: 8,
      id: KEYSET_ID,
    });
    const locked = custodyProof(SELECTOR_SCOPE_ID, "msat", {
      secret: "range-locked",
      amount: 16,
      id: KEYSET_ID,
    });
    const spent = custodyProof(SELECTOR_SCOPE_ID, "msat", {
      secret: "range-spent",
      amount: 32,
      id: KEYSET_ID,
    });
    const foreignScope = custodyProof(
      browserWalletScope(new Uint8Array(64).fill(9)).scopeId,
      "msat",
      {
        secret: "range-foreign-scope",
        amount: 64,
        id: KEYSET_ID,
      },
    );
    const foreignAsset = createBrowserCustodyProofRow({
      scopeId: SELECTOR_SCOPE_ID,
      normalizedMint: MINT,
      unit: "msat",
      proof: {
        id: KEYSET_ID,
        amount: Amount.from(128),
        secret: "range-foreign-asset",
        C: `02${"1".repeat(64)}`,
      },
      asset: { kind: "conditional", conditionId: "condition", outcomeCollection: "YES" },
      receivedAtMs: 0,
    });
    await database.custodyProofs.bulkPut([
      exact,
      { ...locked, selectability: "locked", reservationOperationId: "operation" },
      { ...spent, selectability: "spent" },
      foreignScope,
      foreignAsset,
    ]);
    await database.proofs.put({
      secret: "range-legacy-only",
      amount: 256,
      id: KEYSET_ID,
      C: `02${"1".repeat(64)}`,
      mintUrl: MINT,
      baseAsset: "sat",
      unit: "msat",
    });

    const selected = await getBoundedCanonicalRangeProofsForKeyset(
      MINT,
      {
        scopeId: SELECTOR_SCOPE_ID,
        unit: "msat",
        keysetId: KEYSET_ID,
        asset: { kind: "regular" },
      },
      database,
    );

    expect(selected.map(({ secret }) => secret)).toEqual(["range-exact"]);
  });

  it("selects the largest exact-keyset proof beyond the first 512 primary keys", async () => {
    const database = createDatabase();
    const smallCandidates = Array.from({ length: 1_500 }, (_, index) =>
      custodyProof(SELECTOR_SCOPE_ID, "msat", {
        secret: `range-small-${index.toString().padStart(4, "0")}`,
        amount: 1,
        id: KEYSET_ID,
      }),
    );
    const large = Array.from({ length: 64 }, (_, index) =>
      custodyProof(SELECTOR_SCOPE_ID, "msat", {
        secret: `range-large-${index.toString().padStart(2, "0")}`,
        amount: 10_000,
        id: KEYSET_ID,
      }),
    ).sort((left, right) => right.proofId.localeCompare(left.proofId))[0]!;
    const preceding = smallCandidates
      .filter(({ proofId }) => proofId < large.proofId)
      .sort((left, right) => left.proofId.localeCompare(right.proofId))
      .slice(0, BOUNDED_CANONICAL_RANGE_PROOF_LIMIT_MAX);
    expect(preceding).toHaveLength(BOUNDED_CANONICAL_RANGE_PROOF_LIMIT_MAX);
    await database.custodyProofs.bulkPut([...preceding, large]);

    const selected = await getBoundedCanonicalRangeProofsForKeyset(
      MINT,
      {
        scopeId: SELECTOR_SCOPE_ID,
        unit: "msat",
        keysetId: KEYSET_ID,
        asset: { kind: "regular" },
      },
      database,
    );

    expect(selected).toHaveLength(BOUNDED_CANONICAL_RANGE_PROOF_LIMIT_MAX);
    expect(amountToNumber(selected[0]!.amount)).toBe(10_000);
  }, 15_000);

  it("selects one exact conditional range asset and rejects a V3 keyset", async () => {
    const database = createDatabase();
    const conditional = (outcomeCollection: string, secret: string) =>
      createBrowserCustodyProofRow({
        scopeId: SELECTOR_SCOPE_ID,
        normalizedMint: MINT,
        unit: "msat",
        proof: {
          id: KEYSET_ID,
          amount: Amount.from(4),
          secret,
          C: `02${"1".repeat(64)}`,
        },
        asset: { kind: "conditional", conditionId: "condition", outcomeCollection },
        receivedAtMs: 0,
      });
    await database.custodyProofs.bulkPut([
      conditional("YES", "range-yes"),
      conditional("NO", "range-no"),
    ]);

    await expect(
      getBoundedCanonicalRangeProofsForKeyset(
        MINT,
        {
          scopeId: SELECTOR_SCOPE_ID,
          unit: "msat",
          keysetId: KEYSET_ID,
          asset: {
            kind: "conditional",
            conditionId: "condition",
            outcomeCollection: "YES",
          },
        },
        database,
      ),
    ).resolves.toMatchObject([{ secret: "range-yes" }]);
    await expect(
      getBoundedCanonicalRangeProofsForKeyset(
        MINT,
        {
          scopeId: SELECTOR_SCOPE_ID,
          unit: "msat",
          keysetId: `02${"1".repeat(64)}`,
          asset: { kind: "regular" },
        },
        database,
      ),
    ).rejects.toThrow("requires a V2 keyset");
  });

  it("reads one bounded custody page without scanning higher-sorted legacy history", async () => {
    const database = createDatabase();
    await database.proofs.bulkPut(
      Array.from({ length: MARKET_FUNDING_INPUT_PROOF_LIMIT_MAX + 1 }, (_, index) => ({
        secret: `legacy-history-${index}`,
        amount: 20_000 + index,
        id: KEYSET_ID,
        C: `C-legacy-history-${index}`,
        mintUrl: MINT,
        baseAsset: "sat",
        unit: "msat" as const,
      })),
    );
    await database.custodyProofs.bulkPut([
      custodyProof(SELECTOR_SCOPE_ID, "msat", {
        secret: "custody-small",
        amount: 1,
        id: KEYSET_ID,
      }),
      custodyProof(SELECTOR_SCOPE_ID, "msat", {
        secret: "custody-large",
        amount: 2,
        id: OLD_V2_KEYSET_ID,
      }),
    ]);
    const legacyRead = vi.spyOn(database.proofs, "toArray");
    const custodyQuery = vi.spyOn(database.custodyProofs, "where");

    const selected = await getBoundedCanonicalRegularProofs(
      MINT,
      { scopeId: SELECTOR_SCOPE_ID, unit: "msat" },
      database,
    );

    expect(selected.map(({ secret }) => secret)).toEqual(["custody-large", "custody-small"]);
    expect(legacyRead).not.toHaveBeenCalled();
    expect(custodyQuery).toHaveBeenCalledTimes(1);
  });

  it("selects bounded Participation Score proofs across canonical V2 keysets", async () => {
    const database = createDatabase();
    await database.custodyProofs.bulkPut([
      custodyProof(SELECTOR_SCOPE_ID, "sat", {
        secret: "active",
        amount: 1,
        id: KEYSET_ID,
      }),
      custodyProof(SELECTOR_SCOPE_ID, "sat", {
        secret: "old",
        amount: 8,
        id: OLD_V2_KEYSET_ID,
      }),
    ]);

    const selected = await getBoundedCanonicalSatProofs(
      MINT,
      { scopeId: SELECTOR_SCOPE_ID },
      database,
    );

    expect(selected.map(({ secret }) => secret)).toEqual(["old", "active"]);
  });

  it("does not admit a non-V2 proof into canonical custody", () => {
    expect(() =>
      custodyProof(SELECTOR_SCOPE_ID, "sat", {
        secret: "legacy",
        amount: 16,
        id: "00legacy",
      }),
    ).toThrow(/V2 keyset/);
  });

  it("does not depend on advertised historical keyset lists", async () => {
    const database = createDatabase();
    await database.custodyProofs.bulkPut(
      Array.from({ length: 130 }, (_, index) =>
        custodyProof(SELECTOR_SCOPE_ID, "sat", {
          secret: `historical-${index}`,
          amount: index + 1,
          id: `01${index.toString(16).padStart(64, "0")}`,
        }),
      ),
    );

    await expect(
      getBoundedCanonicalSatProofs(MINT, { scopeId: SELECTOR_SCOPE_ID }, database),
    ).resolves.toHaveLength(130);
  });

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

  it("uses one fresh post-mint time for successor admission and backup revision", async () => {
    const fixture = await executionFixture(undefined, true);
    let nowMs = 1_000;
    fixture.wallet.completeSwap.mockImplementation(async () => {
      nowMs = 2_000;
      return { keep: fixture.keepProofs, send: [fixture.sendProof] };
    });

    await expect(
      executeBrowserDurableOutgoingCashuTransfer({
        ...fixture.input,
        context: { ...fixture.context, now: () => nowMs },
      }),
    ).resolves.toMatchObject({ deliveryState: "delivery-pending" });

    const successor = (await fixture.database.custodyProofs.toArray()).find(
      ({ selectability }) => selectability === "selectable",
    );
    expect(successor).toMatchObject({ receivedAtMs: 2_000 });
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.toArray()).toEqual([
      expect.objectContaining({
        custodyRevision: "1",
        activeProofCount: 1,
        desiredAction: "replace",
      }),
    ]);
    expect(
      (await fixture.database.custodyOperations.toArray())[0]?.record.operation.result.state,
    ).toBe("applied");
  });

  it("fails closed when post-mint commit time reaches the claimed scope lease expiry", async () => {
    const fixture = await executionFixture(undefined, true);
    let nowMs = 1_000;
    fixture.wallet.completeSwap.mockImplementation(async () => {
      nowMs = 601_000;
      return { keep: fixture.keepProofs, send: [fixture.sendProof] };
    });

    await expect(
      executeBrowserDurableOutgoingCashuTransfer({
        ...fixture.input,
        context: { ...fixture.context, now: () => nowMs },
      }),
    ).rejects.toThrow("browser outgoing scope lease expired before post-mint commit");

    expect(
      (await fixture.database.custodyOperations.toArray())[0]?.record.operation.result.state,
    ).toBe("none");
    expect(await fixture.database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
  });

  it("runs the required funded preflight before the final outgoing lock", async () => {
    const fixture = await executionFixture();
    let outgoingLockHeld = false;
    const preflight = vi.fn(async () => {
      expect(outgoingLockHeld).toBe(false);
    });
    const context = {
      ...fixture.context,
      lockManager: {
        request: async (_name: string, _options: LockOptions, action: () => Promise<unknown>) => {
          outgoingLockHeld = true;
          try {
            return await action();
          } finally {
            outgoingLockHeld = false;
          }
        },
      } as Pick<LockManager, "request">,
    };

    await executeBrowserDurableOutgoingCashuTransfer({
      ...fixture.input,
      context,
      preflightFundedAsset: preflight,
    } as never);

    expect(preflight).toHaveBeenCalledOnce();
  });

  it("skips fresh funded recovery when the preliminary read finds a reusable transfer", async () => {
    const fixture = await executionFixture();
    await executeBrowserDurableOutgoingCashuTransfer(fixture.input);
    const preflight = vi.fn(async () => undefined);

    const reused = await executeBrowserDurableOutgoingCashuTransfer({
      ...fixture.input,
      reuseTransferId: true,
      preflightFundedAsset: preflight,
    });

    expect(reused.transferId).toBe("execute");
    expect(preflight).not.toHaveBeenCalled();
    expect(fixture.prepareWalletSendOperation).toHaveBeenCalledOnce();
  });

  it("reuses a transfer created after preflight without fresh preparation", async () => {
    const fixture = await executionFixture();
    const outerPrepare = vi.fn(async () => fixture.operation);

    const transfer = await executeBrowserDurableOutgoingCashuTransfer({
      ...fixture.input,
      reuseTransferId: true,
      prepareWalletSendOperation: outerPrepare,
      preflightFundedAsset: async () => {
        await executeBrowserDurableOutgoingCashuTransfer({
          ...fixture.input,
          reuseTransferId: true,
          preflightFundedAsset: async () => undefined,
        });
      },
    });

    expect(transfer.transferId).toBe("execute");
    expect(outerPrepare).not.toHaveBeenCalled();
    expect(fixture.prepareWalletSendOperation).toHaveBeenCalledOnce();
  });

  it("preserves a final wallet preparation error", async () => {
    const fixture = await executionFixture();
    const preparationError = new Error("counter reservation failed");

    await expect(
      executeBrowserDurableOutgoingCashuTransfer({
        ...fixture.input,
        prepareWalletSendOperation: vi.fn().mockRejectedValue(preparationError),
      }),
    ).rejects.toBe(preparationError);

    expect(await fixture.database.outgoingCashuTransfers.count()).toBe(0);
  });

  it("retains one unselected fee-aware candidate without rewriting its custody row", async () => {
    const fixture = await feeAwarePassthroughFixture();

    const result = await executeBrowserDurableOutgoingCashuTransfer(fixture.input);

    const passthrough = await fixture.database.custodyProofs.get([
      fixture.scope.scopeId,
      fixture.passthroughProofId,
    ]);
    expect(passthrough?.selectability).toBe("selectable");
    expect(passthrough?.reservationOperationId).toBeNull();
    expect(passthrough?.revision).toBe(1);
    expect(passthrough?.proofFingerprint).toBe(fixture.passthroughProofFingerprint);
    expect(
      result.token?.custodyRevisions.find(
        ({ proofIdentity }) => proofIdentity === fixture.passthroughProofIdentity,
      )?.revision,
    ).toBe(1);
    expect(
      (await fixture.database.custodyProofs.toArray()).filter(
        ({ proofId }) => proofId === fixture.passthroughProofId,
      ),
    ).toHaveLength(1);
    expect(
      (await fixture.database.custodyProofs.toArray()).filter(
        ({ selectability }) => selectability === "selectable",
      ),
    ).toHaveLength(3);
    expect(fixture.wallet.completeSwap).toHaveBeenCalledOnce();
  });

  it("serializes two-tab recipient reuse before proof selection and mint I/O", async () => {
    const fixture = await executionFixture();
    const productBinding = "a".repeat(64);
    const context = { ...fixture.context, lockManager: serialLockManager() };
    const common = {
      ...fixture.input,
      reuseRecipientBinding: true,
      context,
      transfer: {
        ...fixture.input.transfer,
        deliveryIntent: {
          policy: "durable-recipient-ack" as const,
          expectedSubject: "subject-1",
          opaqueProductBinding: productBinding,
          tokenBytesLimit: 4 * 1024,
          tokenProofLimit: 1,
        },
      },
    };

    const [first, second] = await Promise.all([
      executeBrowserDurableOutgoingCashuTransfer(common),
      executeBrowserDurableOutgoingCashuTransfer({
        ...common,
        transfer: { ...common.transfer, transferId: "execute-2" },
      }),
    ]);

    expect(first.transferId).toBe("execute");
    expect(second.transferId).toBe("execute");
    expect(fixture.prepareWalletSendOperation).toHaveBeenCalledOnce();
    expect(fixture.wallet.completeSwap).toHaveBeenCalledOnce();
    expect(await fixture.database.outgoingCashuTransfers.count()).toBe(1);
  });

  it("serializes two-tab exact-transfer reuse before proof selection and mint I/O", async () => {
    const fixture = await executionFixture();
    const context = { ...fixture.context, lockManager: serialLockManager() };
    const common = { ...fixture.input, reuseTransferId: true, context };

    const [first, second] = await Promise.all([
      executeBrowserDurableOutgoingCashuTransfer(common),
      executeBrowserDurableOutgoingCashuTransfer(common),
    ]);

    expect(first.transferId).toBe("execute");
    expect(second.transferId).toBe("execute");
    expect(fixture.prepareWalletSendOperation).toHaveBeenCalledOnce();
    expect(fixture.wallet.completeSwap).toHaveBeenCalledOnce();
    expect(await fixture.database.outgoingCashuTransfers.count()).toBe(1);
  });

  it("hands one concurrent Score pointer claim to one exact durable transfer", async () => {
    const fixture = await executionFixture();
    const context = { ...fixture.context, lockManager: serialLockManager() };
    const pointerInput = {
      accountSubject: "subject-1",
      mintUrl: MINT,
      purchaseEpoch: 0,
      context,
    };
    const [firstPointer, secondPointer] = await Promise.all([
      claimBrowserParticipationScoreDeliveryPointer({
        ...pointerInput,
        deliveryId: "3ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
      }),
      claimBrowserParticipationScoreDeliveryPointer({
        ...pointerInput,
        deliveryId: "4ab0f6ef-00f6-4ca3-bd69-1140528a0e83",
      }),
    ]);
    expect(firstPointer.deliveryId).toBe(secondPointer.deliveryId);
    const input = {
      ...fixture.input,
      reuseTransferId: true,
      context,
      transfer: { ...fixture.input.transfer, transferId: firstPointer.deliveryId },
    };

    const [first, second] = await Promise.all([
      executeBrowserDurableOutgoingCashuTransfer(input),
      executeBrowserDurableOutgoingCashuTransfer(input),
    ]);

    expect(first.transferId).toBe(firstPointer.deliveryId);
    expect(second.transferId).toBe(firstPointer.deliveryId);
    expect(fixture.prepareWalletSendOperation).toHaveBeenCalledOnce();
    expect(fixture.wallet.completeSwap).toHaveBeenCalledOnce();
    expect(await fixture.database.participationScoreDeliveryPointers.count()).toBe(1);
    expect(await fixture.database.outgoingCashuTransfers.count()).toBe(1);
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
    KEYSET_ID,
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
        keysetId: KEYSET_ID,
        inputs: [
          {
            id: KEYSET_ID,
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

function recipientTransfer(
  transferId: string,
  productBindingSha256: string,
  scopeId: string,
): DurableOutgoingCashuTransfer {
  const prepared = transferForScope(transferId, 0, scopeId);
  return createDurableOutgoingCashuTransfer({
    transferId,
    walletScopeId: scopeId,
    requestedAmount: prepared.requestedAmount,
    walletSendOperation: prepared.walletSendOperation,
    deliveryIntent: {
      policy: "durable-recipient-ack",
      expectedSubject: "subject-1",
      opaqueProductBinding: productBindingSha256,
      tokenBytesLimit: 1024,
      tokenProofLimit: 1,
    },
    dueAtMs: 0,
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
    bearerMintUrl:
      transfer.deliveryIntent.policy === "bearer-spend-classification" ? transfer.mintUrl : null,
    dueAtMs: transfer.recovery.dueAtMs,
    transferId: transfer.transferId,
    recipientBinding:
      transfer.deliveryIntent.policy === "durable-recipient-ack"
        ? transfer.deliveryIntent.opaqueProductBinding
        : null,
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

function serialLockManager(): Pick<LockManager, "request"> {
  let tail = Promise.resolve();
  return {
    request: async (_name, _options, action) => {
      const prior = tail;
      let release: () => void = () => {};
      tail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await prior;
      try {
        return await action(null as never);
      } finally {
        release();
      }
    },
  } as Pick<LockManager, "request">;
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
  const keepProofs = keepOutputs.map(proofForOutput);
  const wallet = walletFor(sendProof, keepProofs);
  const prepareWalletSendOperation = vi.fn(async () => operation);
  const preflightFundedAsset = vi.fn(async () => undefined);
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
    keepProofs,
    wallet,
    prepareWalletSendOperation,
    preflightFundedAsset,
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
      preflightFundedAsset,
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

async function feeAwarePassthroughFixture() {
  const database = createDatabase();
  const seed = new Uint8Array(64).fill(6);
  const scope = browserWalletScope(seed);
  const selectedInputs = [
    {
      id: FEE_KEYSET_ID,
      amount: Amount.from(999),
      secret: "fee-aware-input-one",
      C: "02" + "1".repeat(64),
    },
    {
      id: FEE_KEYSET_ID,
      amount: Amount.from(1_000),
      secret: "fee-aware-input-two",
      C: "02" + "2".repeat(64),
    },
  ];
  const passthroughProof = {
    id: FEE_KEYSET_ID,
    amount: Amount.from(64),
    secret: "fee-aware-unselected",
    C: "02" + "3".repeat(64),
  };
  const sendOutputs = [
    OutputData.createSingleDeterministicData(1, seed, 40, FEE_KEYSET_ID),
    OutputData.createSingleDeterministicData(1, seed, 41, FEE_KEYSET_ID),
  ];
  const keepOutputs = [
    OutputData.createSingleDeterministicData(1, seed, 42, FEE_KEYSET_ID),
    OutputData.createSingleDeterministicData(1, seed, 43, FEE_KEYSET_ID),
  ];
  const operation = serializeDurableWalletSendOperation({
    operationId: "wallet-send:fee-aware",
    mintUrl: MINT,
    unit: "sat",
    preview: {
      amount: Amount.from(2),
      fees: Amount.from(1),
      keysetId: FEE_KEYSET_ID,
      inputs: selectedInputs,
      sendOutputs,
      keepOutputs,
      unselectedProofs: [passthroughProof],
    },
  });
  await Promise.all(selectedInputs.map((proof) => addInputProof(database, scope.scopeId, proof)));
  const passthroughProofId = await addInputProof(database, scope.scopeId, passthroughProof);
  const originalPassthrough = await database.custodyProofs.get([scope.scopeId, passthroughProofId]);
  if (!originalPassthrough) throw new Error("fee-aware passthrough fixture is missing");
  const revisedPassthrough = { ...originalPassthrough, revision: 1 };
  const originalAuthority = await database.custodyProofBackupAuthorities.get([
    scope.scopeId,
    passthroughProofId,
  ]);
  if (!originalAuthority) throw new Error("fee-aware passthrough authority is missing");
  await database.custodyProofs.put(revisedPassthrough);
  await database.custodyProofBackupAuthorities.put(
    advanceBrowserProofBackupAuthorityRow(
      originalAuthority,
      revisedPassthrough,
      1,
      null,
      "initial-admission",
    ),
  );

  const preview = hydrateDurableWalletSendPreview(operation);
  const sendProofs = preview.sendOutputs!.map((output) => feeProofForOutput(output));
  const mintedKeepProofs = preview.keepOutputs!.map((output) => feeProofForOutput(output));
  const wallet = walletFor(sendProofs, [...mintedKeepProofs, passthroughProof], 500, FEE_KEYSET_ID);
  const prepareWalletSendOperation = vi.fn(async () => operation);
  const preflightFundedAsset = vi.fn(async () => undefined);
  const restoreExactOutputs = vi.fn();
  const context = {
    seed,
    database,
    now: () => 1_000,
    randomId: () => "fee-aware-test",
    requireCapturedProfile: vi.fn(),
    lockManager: { request: async (_name, _options, action) => action(null as never) } as Pick<
      LockManager,
      "request"
    >,
  };
  return {
    database,
    scope,
    wallet,
    preflightFundedAsset,
    passthroughProofId,
    passthroughProofFingerprint: originalPassthrough.proofFingerprint,
    passthroughProofIdentity: deriveDurableCustodyArtifactFingerprint({
      id: passthroughProof.id,
      secret: passthroughProof.secret,
      C: passthroughProof.C,
    }),
    input: {
      transfer: {
        transferId: "fee-aware",
        mintUrl: MINT,
        unit: "sat",
        requestedAmount: "2",
        deliveryIntent: {
          policy: "bearer-spend-classification" as const,
          tokenBytesLimit: 4 * 1024,
          tokenProofLimit: 2,
        },
      },
      prepareWalletSendOperation,
      preflightFundedAsset,
      keepProofDerivationLocators: [
        {
          schemaVersion: 1 as const,
          kind: "nut13" as const,
          keysetId: FEE_KEYSET_ID,
          counter: 42,
        },
        {
          schemaVersion: 1 as const,
          kind: "nut13" as const,
          keysetId: FEE_KEYSET_ID,
          counter: 43,
        },
      ],
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

function custodyProof(
  scopeId: string,
  unit: "sat" | "msat",
  input: { readonly secret: string; readonly amount: number; readonly id: string },
) {
  return createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: MINT,
    unit,
    proof: {
      id: input.id,
      amount: Amount.from(input.amount),
      secret: input.secret,
      C: `02${"1".repeat(64)}`,
    },
    asset: { kind: "regular" },
    receivedAtMs: 0,
  });
}

async function addInputProof(
  database: BitcasterDB,
  scopeId: string,
  proof: { id: string; amount: string | Amount; secret: string; C: string },
): Promise<string> {
  const row = createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: MINT,
    unit: "sat",
    proof: {
      id: proof.id,
      amount: Amount.from(proof.amount.toString()),
      secret: proof.secret,
      C: proof.C,
    },
    asset: { kind: "regular" },
    receivedAtMs: 0,
  });
  await database.custodyProofs.put(row);
  await database.custodyProofBackupAuthorities.put(
    createBrowserProofBackupAuthorityRow(row, 0, null, "initial-admission"),
  );
  return row.proofId;
}

function walletFor(
  sendProof: Proof | Proof[],
  keepProofs: Proof[] = [],
  fee = 0,
  keysetId = KEYSET_ID,
  keys = KEYS,
) {
  return {
    completeSwap: vi.fn(async () => ({
      keep: keepProofs,
      send: Array.isArray(sendProof) ? sendProof : [sendProof],
    })),
    checkProofsStates: vi.fn(),
    getKeyset: vi.fn(() => ({
      id: keysetId,
      unit: "sat",
      keys,
      fee,
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

function feeProofForOutput(output: OutputData): Proof {
  const signature = createBlindSignature(
    pointFromHex(output.blindedMessage.B_),
    PRIVATE_KEY,
    FEE_KEYSET_ID,
  );
  const dleq = createDLEQProof(pointFromHex(output.blindedMessage.B_), PRIVATE_KEY);
  return output.toProof(
    {
      id: FEE_KEYSET_ID,
      amount: output.blindedMessage.amount,
      C_: signature.C_.toHex(true),
      dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
    },
    { id: FEE_KEYSET_ID, keys: KEYS },
  );
}
