// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount } from "@cashu/cashu-ts";
import { afterEach, describe, expect, it } from "vitest";
import { browserWalletScope } from "@/lib/browserCtfRangeOrderSource";
import { createBrowserCustodyProofRow } from "@/stores/durable-custody-db";
import { addProofs, BitcasterDB, type StoredProof } from "@/stores/proof-db";
import { readCanonicalLocalFunds } from "../usePortfolioState";

const mintUrl = "https://mint.example";
const seed = new Uint8Array(64).fill(9);
const scopeId = browserWalletScope(seed).scopeId;
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("readCanonicalLocalFunds", () => {
  it("does not turn an unavailable custody authority into a known empty balance", async () => {
    const legacyOnly = { custodyProofs: undefined } as unknown as BitcasterDB;

    await expect(
      readCanonicalLocalFunds(scopeId, [{ url: mintUrl }], legacyOnly),
    ).resolves.toBeNull();
  });

  it("does not resurrect a spent legacy-cache input after canonical payment", async () => {
    const database = new BitcasterDB(`portfolio-custody-${crypto.randomUUID()}`);
    databases.push(database);
    const spent = proof("spent-input", 22_016_958);
    const current = proof("current-change", 7_997);

    await addProofs([spent], database);
    await database.custodyProofs.bulkPut([
      {
        ...createBrowserCustodyProofRow({
          scopeId,
          normalizedMint: mintUrl,
          unit: "msat",
          proof: spent,
          asset: { kind: "regular" },
          receivedAtMs: 1,
        }),
        selectability: "spent",
      },
      createBrowserCustodyProofRow({
        scopeId,
        normalizedMint: mintUrl,
        unit: "msat",
        proof: current,
        asset: { kind: "regular" },
        receivedAtMs: 2,
      }),
    ]);

    await expect(readCanonicalLocalFunds(scopeId, [{ url: mintUrl }], database)).resolves.toEqual([
      {
        id: `${mintUrl}:msat:sat`,
        unit: "sats",
        amount: 7_997,
        mintUrl,
        mintName: "mint.example",
      },
    ]);
  });
});

function proof(secret: string, amount: number): StoredProof {
  return {
    id: `01${"a".repeat(64)}`,
    amount: Amount.from(amount),
    secret,
    C: "02",
    mintUrl,
    baseAsset: "sat",
    unit: "msat",
  };
}
