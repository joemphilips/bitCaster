import "fake-indexeddb/auto";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveDurableCustodyScopeId, deriveDurableCustodyWalletId } from "@bitcaster/client-sdk/durableCustody";
import { encodeCtfRangeOrderPreparationArtifact, type CtfRangeOrderPreparationRecord } from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import type { SettlementGroupStatus } from "@bitcaster/client-sdk/engineClient";
import { BitcasterDB } from "@/stores/proof-db";
import { SettlementProgress } from "../SettlementProgress";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";

const mocks = vi.hoisted(() => ({ read: vi.fn(), scopeId: "", signerRevision: 0, signerListeners: new Set<() => void>() }));
vi.mock("@/lib/settlementProgressReader", () => ({ readSettlementProgress: mocks.read }));
vi.mock("@/lib/browserWalletProfile", () => ({ browserWalletScopeIdFromMnemonic: () => mocks.scopeId }));
vi.mock("@/stores/wallet", () => ({ useWalletStore: (select: (state: { mnemonic: string }) => unknown) => select({ mnemonic: "test" }) }));
vi.mock("@/lib/nostr", () => ({
  getNostrSignerRevision: () => mocks.signerRevision,
  subscribeToNostrSignerRevision: (listener: () => void) => {
    mocks.signerListeners.add(listener);
    return () => mocks.signerListeners.delete(listener);
  },
}));
vi.mock("@/stores/ctf-range-order-db", async (original) => {
  const actual = await original<typeof import("@/stores/ctf-range-order-db")>();
  return { ...actual, pageActiveCtfRangePreparations: (input: Parameters<typeof actual.pageActiveCtfRangePreparations>[0]) =>
    actual.pageActiveCtfRangePreparations(input, database) };
});

let database: BitcasterDB;
beforeEach(() => {
  database = new BitcasterDB(`progress-ui-${crypto.randomUUID()}`);
  // fake-indexeddb clones bytes in Node's realm, outside jsdom's Uint8Array.
  database.ctfRangePreparations.hook("reading", (record) => record && ({
    ...record, preparationBytes: Uint8Array.from(Object.values(record.preparationBytes)),
  }));
  mocks.scopeId = fixture().scopeId;
  mocks.signerRevision = 0;
  mocks.read.mockReset().mockResolvedValue(group("Reconciling"));
});
afterEach(async () => { database.close(); await database.delete(); });

const dictionaries = [en.settlementProgress, ja.settlementProgress] satisfies Record<SettlementGroupStatus, string>[];
const statuses = ["Prepared", "SubmissionPending", "Reconciling", "Confirmed", "DefinitivelyRejected",
  "Refundable", "ExpiredBeforeSubmission", "RejectedBeforeSubmission"] as const;

describe("active settlement progress", () => {
  it("keeps public content visible when the local journal cannot be read", async () => {
    await database.ctfRangePreparations.put({ ...fixture(), preparationBytes: new Uint8Array([0]) });
    render(<><main>Public market</main><SettlementProgress canReadStatus /></>);
    expect(await screen.findByText("Wallet progress is unavailable. Keep your wallet data and reload to try again.")).toBeVisible();
    expect(screen.getByRole("main")).toHaveTextContent("Public market");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("pages at eight operations without deleting journal rows", async () => {
    for (let index = 1; index <= 9; index++) {
      const record = fixture();
      await database.ctfRangePreparations.put({ ...record, rangeOperationId: `range-${index}`,
        clientOrderId: `client-${index}`, createdAtMs: index, updatedAtMs: index + 1,
        capability: { ...record.capability!, orderId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}` } });
    }
    render(<SettlementProgress canReadStatus={false} />);
    let region = await screen.findByRole("region", { name: en.settlementProgress.title });
    expect(within(region).getAllByRole("listitem")).toHaveLength(8);
    fireEvent.click(within(region).getByRole("button", { name: "Next" }));
    await waitFor(() => {
      region = screen.getByRole("region", { name: en.settlementProgress.title });
      expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    });
    fireEvent.click(within(region).getByRole("button", { name: en.settlementProgress.first }));
    await waitFor(() => expect(screen.getAllByRole("listitem")).toHaveLength(8));
    expect(await database.ctfRangePreparations.count()).toBe(9);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each(["wallet", "signer"])("ignores a pending result after the %s changes", async (change) => {
    const record = fixture();
    const otherScope = deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(8)) });
    await database.ctfRangePreparations.bulkPut([record, { ...record, scopeId: otherScope }]);
    let finish!: (value: ReturnType<typeof group>) => void;
    mocks.read.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValue(group("Refundable"));
    const view = render(<SettlementProgress canReadStatus />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    const oldSignal = mocks.read.mock.calls[0][2] as AbortSignal;
    act(() => {
      if (change === "wallet") mocks.scopeId = otherScope;
      else { mocks.signerRevision++; for (const notify of mocks.signerListeners) notify(); }
    });
    view.rerender(<SettlementProgress canReadStatus />);
    expect(await screen.findByText(en.settlementProgress.Refundable)).toBeVisible();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finish(group("Confirmed")));
    expect(screen.queryByText(en.settlementProgress.Confirmed)).not.toBeInTheDocument();
  });

  it.each(statuses)("shows %s from an authoritative observation", async (status) => {
    await database.ctfRangePreparations.put(fixture());
    mocks.read.mockResolvedValue(group(status));
    render(<SettlementProgress canReadStatus />);
    expect(await screen.findByText(en.settlementProgress[status])).toBeVisible();
    for (const dictionary of dictionaries) expect(dictionary[status]).not.toBe("");
    expect(screen.getByText(en.settlementProgress.fees)).toBeVisible();
  });

  it("reconstructs progress from the reopened journal without the pending-trade cache", async () => {
    await database.ctfRangePreparations.put(fixture());
    database.close();
    await database.open();
    render(<SettlementProgress canReadStatus />);
    expect(await screen.findByText(en.settlementProgress.Reconciling)).toBeVisible();
    expect(mocks.read).toHaveBeenCalledWith("condition-a-Alpha", "11111111-1111-4111-8111-111111111111", expect.any(AbortSignal));
  });

  it("keeps local preparation distinct and makes no unauthenticated read", async () => {
    await database.ctfRangePreparations.put(fixture());
    const view = render(<SettlementProgress canReadStatus={false} />);
    expect(await screen.findByText(en.settlementProgress.authenticationRequired)).toBeVisible();
    expect(mocks.read).not.toHaveBeenCalled();
    await act(async () => { await database.ctfRangePreparations.put({ ...fixture(), capability: null, lifecycleState: "prepared" }); });
    expect(await screen.findByText(en.settlementProgress.localPreparation)).toBeVisible();
    view.rerender(<SettlementProgress canReadStatus />);
    expect(await screen.findByText(en.settlementProgress.localPreparation)).toBeVisible();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("removes terminal journal rows without claiming a trade or refund outcome", async () => {
    await database.ctfRangePreparations.put(fixture());
    render(<SettlementProgress canReadStatus />);
    await screen.findByText(en.settlementProgress.Reconciling);
    await act(async () => { await database.ctfRangePreparations.put({ ...fixture(), lifecycleState: "terminal" }); });
    await waitFor(() => expect(screen.queryByRole("region", { name: en.settlementProgress.title })).not.toBeInTheDocument());
    expect(screen.queryByText(en.settlementProgress.Confirmed)).not.toBeInTheDocument();
  });
});

function group(status: SettlementGroupStatus) {
  return { groupId: "group-1", status, revision: 1, coalescingDeadline: "2026-09-07T00:00:00Z", frozenAt: null };
}

function fixture(): CtfRangeOrderPreparationRecord {
  return {
    scopeId: deriveDurableCustodyScopeId({ scopeKind: "wallet", walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(7)) }),
    rangeOperationId: "range-1", sourceOperationId: "source-1", authorizationId: "auth-1", clientOrderId: "client-1",
    orderRouteId: "condition-a-Alpha", normalizedMint: "https://mint.example", conditionId: "condition-a",
    unit: "msat", tokenSide: "Outcome", side: "Buy", priceSubunits: 500, amountSubunits: 1_000,
    minimumFillAmountSubunits: 1_000, divisibility: 1_000, authorizationExpiresAtUnixSeconds: 1_000,
    preparationBytes: encodeCtfRangeOrderPreparationArtifact({ version: 1 }), createdAtMs: 1, updatedAtMs: 2,
    lifecycleState: "order-submitted", revision: 3,
    capability: { artifactId: "11111111-1111-4111-8111-111111111111", orderId: "11111111-1111-4111-8111-111111111111",
      bindingDigest: "22".repeat(32), artifactDigest: "33".repeat(32) },
  };
}
