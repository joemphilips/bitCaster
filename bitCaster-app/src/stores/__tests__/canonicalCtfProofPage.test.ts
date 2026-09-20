// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { createBrowserCustodyProofRow } from "../durable-custody-db";
import type { BrowserCustodyProofRow } from "../durable-custody-types";
import { BitcasterDB, getCanonicalCtfProofPage } from "../proof-db";

const MINT = "https://mint.example";
const OTHER_MINT = "https://other-mint.example";
const CONDITION = "aa".repeat(32);
const OTHER_CONDITION = "bb".repeat(32);
const SCOPE = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: "11".repeat(32) });
const OTHER_SCOPE = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: "22".repeat(32) });
const KEYSET_A = `01${"33".repeat(32)}`;
const KEYSET_B = `01${"44".repeat(32)}`;
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`canonical-ctf-page-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}

function ctfProof(
  secret: string,
  options: {
    scopeId?: string;
    mint?: string;
    conditionId?: string;
    keysetId?: string;
    selectability?: "selectable" | "locked" | "spent";
  } = {},
) {
  const row = createBrowserCustodyProofRow({
    scopeId: options.scopeId ?? SCOPE,
    normalizedMint: options.mint ?? MINT,
    unit: "msat",
    proof: {
      id: options.keysetId ?? KEYSET_A,
      amount: 1 as never,
      secret,
      C: `02${"55".repeat(32)}`,
    },
    asset: {
      kind: "conditional",
      conditionId: options.conditionId ?? CONDITION,
      outcomeCollection: "Alpha",
    },
    receivedAtMs: 1,
  });
  const selectability = options.selectability ?? "selectable";
  return {
    ...row,
    selectability,
    reservationOperationId: selectability === "locked" ? "operation" : null,
  };
}

describe("canonical CTF proof pages", () => {
  it("pages all proof holdings across actual keysets without a holding cap", async () => {
    const database = createDatabase();
    const count = 257;
    const rows = Array.from({ length: count }, (_, index) =>
      ctfProof(`proof-${index}`, { keysetId: index % 2 === 0 ? KEYSET_A : KEYSET_B }),
    );
    await database.custodyProofs.bulkPut(rows);

    const selected: BrowserCustodyProofRow[] = [];
    let afterProofId: string | null = null;
    do {
      const page = await getCanonicalCtfProofPage(
        MINT,
        { scopeId: SCOPE, conditionId: CONDITION, selectability: "selectable", afterProofId },
        database,
      );
      selected.push(...page.proofs);
      afterProofId = page.nextProofId;
    } while (afterProofId !== null);

    expect(selected).toHaveLength(count);
    expect(new Set(selected.map(({ proofId }) => proofId)).size).toBe(count);
    expect(new Set(selected.map(({ keysetId }) => keysetId))).toEqual(
      new Set([KEYSET_A, KEYSET_B]),
    );
  });

  it("selects only the exact scope, mint, condition, and selectable state", async () => {
    const database = createDatabase();
    await database.custodyProofs.bulkPut([
      ctfProof("selected"),
      ctfProof("other-scope", { scopeId: OTHER_SCOPE }),
      ctfProof("other-mint", { mint: OTHER_MINT }),
      ctfProof("other-condition", { conditionId: OTHER_CONDITION }),
      ctfProof("locked", { selectability: "locked" }),
      ctfProof("spent", { selectability: "spent" }),
    ]);

    const selectable = await getCanonicalCtfProofPage(
      MINT,
      { scopeId: SCOPE, conditionId: CONDITION, selectability: "selectable", limit: 5 },
      database,
    );
    const locked = await getCanonicalCtfProofPage(
      MINT,
      { scopeId: SCOPE, conditionId: CONDITION, selectability: "locked", limit: 5 },
      database,
    );

    expect(selectable.proofs.map(({ proofId }) => proofId)).toEqual([ctfProof("selected").proofId]);
    expect(locked.proofs.map(({ proofId }) => proofId)).toEqual([ctfProof("locked").proofId]);
  });

  it("rejects invalid condition, cursor, state, or page size", async () => {
    const database = createDatabase();
    const required = {
      scopeId: SCOPE,
      conditionId: CONDITION,
      selectability: "selectable" as const,
    };
    await expect(
      getCanonicalCtfProofPage(MINT, { ...required, conditionId: "condition" }, database),
    ).rejects.toThrow(/condition ID/);
    await expect(
      getCanonicalCtfProofPage(MINT, { ...required, afterProofId: "bad" }, database),
    ).rejects.toThrow(/cursor/);
    await expect(
      getCanonicalCtfProofPage(MINT, { ...required, selectability: "spent" as never }, database),
    ).rejects.toThrow(/state/);
    await expect(
      getCanonicalCtfProofPage(MINT, { ...required, limit: 257 }, database),
    ).rejects.toThrow(/page limit/);
  });
});
