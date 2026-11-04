// @vitest-environment node
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  encodeCtfRangeOrderPreparationArtifact,
  type CtfRangeOrderPreparationIdentity,
} from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import {
  browserWalletIdFromMnemonic,
  browserWalletScopeIdFromMnemonic,
} from "@/lib/browserWalletProfile";
import { hasLocalOrdersInProgress } from "@/lib/nostrLogoutGuard";
import { insertCtfRangePreparation } from "@/stores/ctf-range-order-db";
import { usePendingTradesStore } from "@/stores/pendingTrades";
import { BitcasterDB } from "@/stores/proof-db";
import { useWalletStore } from "@/stores/wallet";

const WALLET =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER_WALLET = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
const openDatabases: BitcasterDB[] = [];

function createDatabase(): BitcasterDB {
  const database = new BitcasterDB(`bitcaster-logout-guard-${crypto.randomUUID()}`);
  openDatabases.push(database);
  return database;
}

function preparation(scopeId: string): CtfRangeOrderPreparationIdentity {
  return {
    scopeId,
    rangeOperationId: "range-1",
    sourceOperationId: "range-1:source",
    authorizationId: "range-1:authorization",
    clientOrderId: "client-1",
    orderRouteId: "condition-a-YES",
    normalizedMint: "https://mint.example",
    conditionId: "condition-a",
    unit: "msat",
    tokenSide: "Outcome",
    side: "Buy",
    priceSubunits: 500,
    amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000,
    divisibility: 1_000,
    authorizationExpiresAtUnixSeconds: 1_000,
    preparationBytes: encodeCtfRangeOrderPreparationArtifact({ version: 1 }),
    feeConsentBytes: null,
    createdAtMs: 1,
  };
}

beforeEach(() => {
  usePendingTradesStore.setState({ byOrderId: {} });
  useWalletStore.setState({ mnemonic: WALLET });
});

afterEach(async () => {
  usePendingTradesStore.setState({ byOrderId: {} });
  useWalletStore.setState({ mnemonic: "" });
  for (const database of openDatabases.splice(0)) {
    database.close();
    await database.delete();
  }
});

describe("local orders in progress for a logout", () => {
  it("finds none without pending orders or active journal work", async () => {
    expect(await hasLocalOrdersInProgress(createDatabase())).toBe(false);
  });

  it("finds a pending order of any wallet, because a restore of that wallet needs the signer", async () => {
    usePendingTradesStore.getState().add({
      orderId: "order-1",
      walletId: browserWalletIdFromMnemonic(OTHER_WALLET)!,
      marketId: "condition-a-YES",
      submittedAt: 1,
      baseAsset: "sat",
      divisibility: 1_000,
    });

    expect(await hasLocalOrdersInProgress(createDatabase())).toBe(true);
  });

  it("finds an active range order in the journal of the active wallet", async () => {
    const database = createDatabase();
    await insertCtfRangePreparation(
      preparation(browserWalletScopeIdFromMnemonic(WALLET)!),
      database,
    );

    expect(await hasLocalOrdersInProgress(database)).toBe(true);
  });

  it("does not count journal work of another wallet scope", async () => {
    const database = createDatabase();
    await insertCtfRangePreparation(
      preparation(browserWalletScopeIdFromMnemonic(OTHER_WALLET)!),
      database,
    );

    expect(await hasLocalOrdersInProgress(database)).toBe(false);
  });

  it("counts an unreadable journal as work in progress", async () => {
    const database = createDatabase();
    database.close({ disableAutoOpen: true });

    expect(await hasLocalOrdersInProgress(database)).toBe(true);
  });
});
