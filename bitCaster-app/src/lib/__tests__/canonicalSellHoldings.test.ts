// @vitest-environment node
import "fake-indexeddb/auto";
import { Amount, type Proof } from "@cashu/cashu-ts";
import { liveQuery } from "dexie";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import { createBrowserCustodyProofRow } from "@/stores/durable-custody-db";
import { BitcasterDB } from "@/stores/proof-db";
import {
  canonicalSellHoldingsIdentityKey,
  readCanonicalMarketSellHoldings,
  sellHoldingsForCurrentIdentity,
} from "../canonicalSellHoldings";

const MINT_URL = "https://mint.example";
const CONDITION_ID = "aa".repeat(32);
const OTHER_CONDITION_ID = "bb".repeat(32);
const SCOPE_ID = deriveDurableCustodyScopeId({
  scopeKind: "wallet",
  walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(9)),
});
const database = new BitcasterDB(`canonical-sell-holdings-${crypto.randomUUID()}`);

afterEach(async () => {
  await database.custodyProofs.clear();
});

function proof(secret: string, amount: number): Proof {
  return {
    id: `01${"11".repeat(32)}`,
    amount: Amount.from(amount),
    secret,
    C: `02${"22".repeat(32)}`,
  };
}

function conditionalProof(input: {
  secret: string;
  amount: number;
  conditionId?: string;
  collection: string;
  mintUrl?: string;
  selectability?: "selectable" | "locked" | "pending-removal" | "spent";
}) {
  const row = createBrowserCustodyProofRow({
    scopeId: SCOPE_ID,
    normalizedMint: input.mintUrl ?? MINT_URL,
    unit: "msat",
    proof: proof(input.secret, input.amount),
    asset: {
      kind: "conditional",
      conditionId: input.conditionId ?? CONDITION_ID,
      outcomeCollection: input.collection,
    },
    receivedAtMs: 1,
  });
  const selectability = input.selectability ?? "selectable";
  return {
    ...row,
    selectability,
    reservationOperationId: selectability === "locked" ? `reservation-${input.secret}` : null,
  };
}

describe("canonical Sell holdings", () => {
  it("uses exact mint and condition rows, excludes reserved/spent/pending amounts, and groups collections", async () => {
    await database.custodyProofs.bulkPut([
      conditionalProof({ secret: "yes-a", amount: 1_000, collection: "Yes" }),
      conditionalProof({
        secret: "yes-reserved",
        amount: 9_000,
        collection: "Yes",
        selectability: "locked",
      }),
      conditionalProof({
        secret: "yes-pending",
        amount: 20_000,
        collection: "Yes",
        selectability: "pending-removal",
      }),
      conditionalProof({
        secret: "yes-spent",
        amount: 30_000,
        collection: "Yes",
        selectability: "spent",
      }),
      conditionalProof({ secret: "no-a", amount: 3_000, collection: "No" }),
      conditionalProof({
        secret: "complement-a",
        amount: 4_000,
        collection: "Bob|Carol",
      }),
      conditionalProof({
        secret: "other-condition",
        amount: 50_000,
        collection: "Yes",
        conditionId: OTHER_CONDITION_ID,
      }),
      conditionalProof({
        secret: "other-mint",
        amount: 60_000,
        collection: "Yes",
        mintUrl: "https://other-mint.example",
      }),
    ]);

    const result = await readCanonicalMarketSellHoldings(
      {
        routeId: CONDITION_ID,
        conditionId: CONDITION_ID,
        scopeId: SCOPE_ID,
        mintUrl: MINT_URL,
      },
      database,
    );

    expect(result.byOutcomeSetId.get("Yes")).toEqual({
      selectableSubunits: 1_000,
      reservedSubunits: 9_000,
    });
    expect(result.byOutcomeSetId.get("No")).toEqual({
      selectableSubunits: 3_000,
      reservedSubunits: 0,
    });
    expect(result.byOutcomeSetId.get("Bob|Carol")).toEqual({
      selectableSubunits: 4_000,
      reservedSubunits: 0,
    });
  });

  it("shows stale route or wallet-profile results as loading", async () => {
    const identity = {
      routeId: CONDITION_ID,
      conditionId: CONDITION_ID,
      scopeId: SCOPE_ID,
      mintUrl: MINT_URL,
    };
    const result = await readCanonicalMarketSellHoldings(identity, database);
    const currentKey = canonicalSellHoldingsIdentityKey(identity);

    expect(sellHoldingsForCurrentIdentity(result, currentKey)).toEqual({
      status: "ready",
      byOutcomeSetId: new Map(),
    });
    expect(sellHoldingsForCurrentIdentity(result, `${currentKey}:other-route`)).toEqual({
      status: "loading",
    });
    expect(sellHoldingsForCurrentIdentity(result, `${currentKey}:other-profile`)).toEqual({
      status: "loading",
    });
  });

  it("refreshes the selectable total when canonical custody changes", async () => {
    const identity = {
      routeId: CONDITION_ID,
      conditionId: CONDITION_ID,
      scopeId: SCOPE_ID,
      mintUrl: MINT_URL,
    };
    const row = conditionalProof({ secret: "live-refresh", amount: 2_000, collection: "Yes" });
    await database.custodyProofs.put(row);

    let resolveInitial!: (
      value: Awaited<ReturnType<typeof readCanonicalMarketSellHoldings>>,
    ) => void;
    let resolveUpdated!: (
      value: Awaited<ReturnType<typeof readCanonicalMarketSellHoldings>>,
    ) => void;
    const initial = new Promise<Awaited<ReturnType<typeof readCanonicalMarketSellHoldings>>>(
      (resolve) => {
        resolveInitial = resolve;
      },
    );
    const updated = new Promise<Awaited<ReturnType<typeof readCanonicalMarketSellHoldings>>>(
      (resolve) => {
        resolveUpdated = resolve;
      },
    );
    let emissionCount = 0;
    const subscription = liveQuery(() =>
      readCanonicalMarketSellHoldings(identity, database),
    ).subscribe({
      next: (value) => {
        emissionCount += 1;
        if (emissionCount === 1) resolveInitial(value);
        if (emissionCount === 2) resolveUpdated(value);
      },
    });

    try {
      expect((await initial).byOutcomeSetId.get("Yes")?.selectableSubunits).toBe(2_000);
      await database.custodyProofs.update([SCOPE_ID, row.proofId], { selectability: "spent" });
      expect((await updated).byOutcomeSetId.get("Yes")).toBeUndefined();
    } finally {
      subscription.unsubscribe();
    }
  });
});
