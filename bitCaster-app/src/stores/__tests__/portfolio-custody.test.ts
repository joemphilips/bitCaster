// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount } from "@cashu/cashu-ts";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { afterEach, describe, expect, it } from "vitest";
import { createBrowserCustodyProofRow } from "../durable-custody-db";
import { BitcasterDB } from "../proof-db";
import { readCanonicalPortfolioCustody } from "../portfolio-custody";

const MINT = "https://mint.example";
const OTHER_MINT = "https://other-mint.example";
const CONDITION = "aa".repeat(32);
const SCOPE = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: "11".repeat(32) });
const OTHER_SCOPE = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: "22".repeat(32),
});
const KEYSET = `01${"33".repeat(32)}`;
const OTHER_KEYSET = `01${"44".repeat(32)}`;
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`portfolio-custody-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

function proofRow(
  secret: string,
  options: {
    scopeId?: string;
    mint?: string;
    keysetId?: string;
    amount?: number;
    asset?:
      | { kind: "regular" }
      | { kind: "conditional"; conditionId: string; outcomeCollection: string };
    receivedAtMs?: number;
    revision?: number;
    selectability?: "selectable" | "locked" | "verified-losing" | "pending-removal" | "spent";
  } = {},
) {
  const selectability = options.selectability ?? "selectable";
  const row = createBrowserCustodyProofRow({
    scopeId: options.scopeId ?? SCOPE,
    normalizedMint: options.mint ?? MINT,
    unit: "msat",
    proof: {
      id: options.keysetId ?? KEYSET,
      amount: Amount.from(options.amount ?? 1),
      secret,
      C: `02${"55".repeat(32)}`,
    },
    asset: options.asset ?? { kind: "regular" },
    receivedAtMs: options.receivedAtMs ?? 1,
  });
  return {
    ...row,
    revision: options.revision ?? row.revision,
    selectability,
    reservationOperationId: selectability === "locked" ? "reservation-1" : null,
  };
}

describe("canonical Portfolio custody reader", () => {
  it("projects normal and losing custody metadata without desired or keyset rows", async () => {
    const database = createDatabase();
    const selectable = proofRow("selectable", { amount: 7, receivedAtMs: 10 });
    const locked = proofRow("locked", { amount: 8, revision: 2, selectability: "locked" });
    const losing = proofRow("losing", {
      amount: 9,
      keysetId: OTHER_KEYSET,
      asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection: "NO" },
      receivedAtMs: 12,
      revision: 3,
      selectability: "verified-losing",
    });
    const pendingRemoval = proofRow("pending-removal", {
      amount: 10,
      keysetId: OTHER_KEYSET,
      asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection: "NO" },
      receivedAtMs: 13,
      revision: 4,
      selectability: "pending-removal",
    });
    await database.custodyProofs.bulkPut([selectable, locked, losing, pendingRemoval]);

    const result = await readCanonicalPortfolioCustody(SCOPE, database);

    expect(result).toHaveLength(4);
    expect(result).toEqual(
      expect.arrayContaining([
        {
          normalizedMint: MINT,
          unit: "msat",
          assetKind: "regular",
          conditionId: null,
          outcomeCollection: null,
          baseAsset: "sat",
          amount: 7,
          claimRecoveryPending: false,
          keysetId: KEYSET,
          proofId: selectable.proofId,
          revision: 0,
          selectability: "selectable",
          reservationOperationId: null,
          receivedAtMs: 10,
        },
        expect.objectContaining({
          amount: 8,
          keysetId: KEYSET,
          proofId: locked.proofId,
          revision: 2,
          selectability: "locked",
          reservationOperationId: "reservation-1",
        }),
        expect.objectContaining({
          normalizedMint: MINT,
          unit: "msat",
          assetKind: "conditional",
          conditionId: CONDITION,
          outcomeCollection: "NO",
          baseAsset: "sat",
          amount: 9,
          keysetId: OTHER_KEYSET,
          proofId: losing.proofId,
          revision: 3,
          selectability: "verified-losing",
          reservationOperationId: null,
          receivedAtMs: 12,
        }),
        expect.objectContaining({
          proofId: pendingRemoval.proofId,
          revision: 4,
          selectability: "pending-removal",
          reservationOperationId: null,
        }),
      ]),
    );
    expect(result?.every((row) => !Object.hasOwn(row, "proofBody"))).toBe(true);
    expect(result?.every((row) => !Object.hasOwn(row, "secret"))).toBe(true);
    expect(await database.custodyConditionalKeysets.count()).toBe(0);
    expect(await database.encryptedWalletBackupV2DesiredAssets.count()).toBe(0);
  });

  it("isolates the scope and excludes spent canonical rows", async () => {
    const database = createDatabase();
    const selected = proofRow("selected", { amount: 4 });
    const spent = proofRow("spent", { amount: 5, selectability: "spent" });
    const otherScope = proofRow("other-scope", { scopeId: OTHER_SCOPE, amount: 6 });
    const otherMint = proofRow("other-mint", { mint: OTHER_MINT, amount: 7 });
    await database.custodyProofs.bulkPut([selected, spent, otherScope, otherMint]);

    const result = await readCanonicalPortfolioCustody(SCOPE, database);
    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ proofId: selected.proofId, normalizedMint: MINT, amount: 4 }),
        expect.objectContaining({
          proofId: otherMint.proofId,
          normalizedMint: OTHER_MINT,
          amount: 7,
        }),
      ]),
    );
  });

  it("reads all current-scope metadata rows beyond a single page", async () => {
    const database = createDatabase();
    const rows = Array.from({ length: 513 }, (_, index) =>
      proofRow(`large-${index}`, { amount: index + 1 }),
    );
    await database.custodyProofs.bulkPut(rows);

    const result = await readCanonicalPortfolioCustody(SCOPE, database);

    expect(result).toHaveLength(rows.length);
    expect(new Set(result?.map(({ proofId }) => proofId)).size).toBe(rows.length);
  });

  it("returns an empty projection when the current scope has no desired row or proofs", async () => {
    const database = createDatabase();

    await expect(readCanonicalPortfolioCustody(SCOPE, database)).resolves.toEqual([]);
  });
});
