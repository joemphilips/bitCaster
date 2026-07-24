import { describe, expect, it } from "vitest";
import { migratePartialLockFailureState } from "../partialLockFailures";

describe("partial-lock failure store migration", () => {
  it("BrowserPartialLockMigration_FlatShape_ProducesCanonicalShape", () => {
    const migrated = migratePartialLockFailureState(
      {
        byTradeId: {
          "trade-1": {
            tradeId: "trade-1",
            orderId: "order-1",
            mintUrl: "https://mint.example",
            refundLocktime: 1_777_000_000,
            affectedKeysets: ["keyset-B", "keyset-C"],
            detail: "legacy partial lock",
            conditionId: "condition-1",
            outcomeCollection: "B",
            marketId: "condition-1-B",
            createdAt: 123,
          },
        },
      },
      1,
    ) as {
      byTradeId: Record<
        string,
        {
          outcomeByKeyset: Record<
            string,
            {
              conditionId: string;
              outcomeCollection: string;
              marketId: string;
            }
          >;
        }
      >;
    };

    expect(migrated.byTradeId["trade-1"].outcomeByKeyset).toEqual({
      "keyset-B": {
        conditionId: "condition-1",
        outcomeCollection: "B",
        marketId: "condition-1-B",
      },
      "keyset-C": {
        conditionId: "condition-1",
        outcomeCollection: "B",
        marketId: "condition-1-B",
      },
    });
  });
});
