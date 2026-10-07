// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { deriveDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import { createBrowserCustodyProofRow } from "../../stores/durable-custody-db";
import { BitcasterDB } from "../../stores/proof-db";
import { readBrowserCanonicalCtfRedeemLegs } from "../browserCtfRedeemSelection";

const MINT = "https://mint.example";
const CONDITION = "aa".repeat(32);
const SCOPE = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: "11".repeat(32) });
const KEYSET_A = `01${"22".repeat(32)}`;
const KEYSET_B = `01${"33".repeat(32)}`;
const KEYSET_C = `01${"55".repeat(32)}`;
const PUBLIC_KEY = `02${"44".repeat(32)}`;
const databases: BitcasterDB[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }
});

function database(): BitcasterDB {
  const result = new BitcasterDB(`ctf-redeem-selection-${crypto.randomUUID()}`);
  databases.push(result);
  return result;
}

function proof(secret: string, keysetId = KEYSET_A, outcomeCollection = "Alpha") {
  return createBrowserCustodyProofRow({
    scopeId: SCOPE,
    normalizedMint: MINT,
    unit: "msat",
    proof: { id: keysetId, amount: 1 as never, secret, C: PUBLIC_KEY },
    asset: { kind: "conditional", conditionId: CONDITION, outcomeCollection },
    receivedAtMs: 1,
  });
}

async function putKeyset(
  target: BitcasterDB,
  keysetId: string,
  outcomeCollection = "Alpha",
  outcomeCollectionId = deriveRootCtfOutcomeCollectionId({
    conditionId: CONDITION,
    outcomeCollection,
  }),
) {
  await target.custodyConditionalKeysets.put({
    schemaVersion: 1,
    scopeId: SCOPE,
    normalizedMint: MINT,
    unit: "msat",
    keysetId,
    denominationPublicKeys: { "1": PUBLIC_KEY },
    inputFeePpk: 0,
    conditionId: CONDITION,
    outcomeCollection,
    outcomeCollectionId,
    registeredAtUnixSeconds: 0,
    finalExpiryUnixSeconds: null,
    curve: "secp256k1",
  });
}

describe("canonical CTF redeem selection", () => {
  it("streams all holdings in bounded actual-keyset legs", async () => {
    const target = database();
    await putKeyset(target, KEYSET_A);
    await putKeyset(target, KEYSET_B);
    await target.custodyProofs.bulkPut(
      Array.from({ length: 257 }, (_, index) =>
        proof(`ctf-proof-${index}`, index % 2 === 0 ? KEYSET_A : KEYSET_B),
      ),
    );

    const legs = [];
    for await (const leg of readBrowserCanonicalCtfRedeemLegs({
      scopeId: SCOPE,
      mintUrl: MINT,
      conditionId: CONDITION,
      outcomeCollection: "Alpha",
      database: target,
      pageLimit: 64,
    })) {
      legs.push(leg);
    }

    expect(legs.reduce((total, leg) => total + leg.proofs.length, 0)).toBe(257);
    expect(legs.every((leg) => leg.proofs.length <= 64)).toBe(true);
    expect(new Set(legs.map((leg) => leg.keyset.keysetId))).toEqual(new Set([KEYSET_A, KEYSET_B]));
    expect(new Set(legs.flatMap((leg) => leg.rows.map((row) => row.proofId))).size).toBe(257);
  });

  it("refuses missing or conflicting conditional keyset authority", async () => {
    const target = database();
    await target.custodyProofs.put(proof("one"));
    const firstLeg = () =>
      readBrowserCanonicalCtfRedeemLegs({
        scopeId: SCOPE,
        mintUrl: MINT,
        conditionId: CONDITION,
        outcomeCollection: "Alpha",
        database: target,
      }).next();
    await expect(firstLeg()).rejects.toThrow(/keyset authority is missing/);

    await putKeyset(target, KEYSET_A, "Beta");
    await expect(firstLeg()).rejects.toThrow(/authority conflict/);
  });

  it("selects only the requested outcome collection within one condition", async () => {
    const target = database();
    await putKeyset(target, KEYSET_A);
    await putKeyset(target, KEYSET_C, "Beta");
    await target.custodyProofs.bulkPut([proof("alpha", KEYSET_A), proof("beta", KEYSET_C, "Beta")]);

    const legs = [];
    for await (const leg of readBrowserCanonicalCtfRedeemLegs({
      scopeId: SCOPE,
      mintUrl: MINT,
      conditionId: CONDITION,
      outcomeCollection: "Alpha",
      database: target,
    })) {
      legs.push(leg);
    }

    expect(legs.map((leg) => leg.keyset.outcomeCollection)).toEqual(["Alpha"]);
    expect(legs.flatMap((leg) => leg.rows.map((row) => row.proofId))).toEqual([
      proof("alpha", KEYSET_A).proofId,
    ]);
  });

  it("refuses a matching label with a different canonical collection ID", async () => {
    const target = database();
    await putKeyset(target, KEYSET_A, "Alpha", "cc".repeat(32));
    await target.custodyProofs.put(proof("alpha"));

    const firstLeg = () =>
      readBrowserCanonicalCtfRedeemLegs({
        scopeId: SCOPE,
        mintUrl: MINT,
        conditionId: CONDITION,
        outcomeCollection: "Alpha",
        database: target,
      }).next();
    const refused = await firstLeg().then(
      () => false,
      (error: unknown) => error instanceof Error && /asset authority conflict/.test(error.message),
    );
    expect(refused).toBe(true);
  });
});
