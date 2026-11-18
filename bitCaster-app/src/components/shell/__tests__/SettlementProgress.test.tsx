import "fake-indexeddb/auto";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveDurableCustodyScopeId,
  deriveDurableCustodyWalletId,
} from "@bitcaster/client-sdk/durableCustody";
import {
  encodeCtfRangeOrderPreparationArtifact,
  type CtfRangeOrderPreparationRecord,
} from "@bitcaster/client-sdk/ctfRangeOrderJournal";
import type {
  OrderLifecycleStatus,
  OrderSettlementFailureReason,
  SettlementGroupStatus,
  SettlementGroupSummary,
} from "@bitcaster/client-sdk/engineClient";
import { BitcasterDB } from "@/stores/proof-db";
import { useOrderSettlementObservations } from "@/stores/orderSettlementObservations";
import { useNotificationsStore, type Notification } from "@/stores/notifications";
import { recordBrowserCtfRangeMessage } from "@/stores/ctf-range-order-messages";
import {
  ORDER_FAILURE_NOTICES_MAX,
  ORDER_FAILURE_NOTICES_STORAGE_KEY,
  orderFailureNoticeKey,
  useOrderFailureNotices,
} from "@/stores/orderFailureNotices";
import { publishSettlementProgressHint } from "@/lib/settlementProgressHints";
import { SETTLEMENT_COMPLETION_NOTICE_MS } from "@/hooks/useSettlementProgress";
import { SettlementProgress } from "../SettlementProgress";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  readFailure: vi.fn(),
  scopeId: "",
  walletId: "a".repeat(64),
  signerRevision: 0,
  signerListeners: new Set<() => void>(),
}));
vi.mock("@/lib/settlementProgressReader", () => ({
  readSettlementProgress: mocks.read,
  readSettlementFailure: mocks.readFailure,
}));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: () => mocks.scopeId,
  browserWalletIdFromMnemonic: () => mocks.walletId,
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: (select: (state: { mnemonic: string }) => unknown) =>
    select({ mnemonic: "test" }),
}));
vi.mock("@/lib/nostr", () => ({
  getNostrSignerRevision: () => mocks.signerRevision,
  subscribeToNostrSignerRevision: (listener: () => void) => {
    mocks.signerListeners.add(listener);
    return () => mocks.signerListeners.delete(listener);
  },
}));
vi.mock("@/stores/ctf-range-order-db", async (original) => {
  const actual = await original<typeof import("@/stores/ctf-range-order-db")>();
  return {
    ...actual,
    pageActiveCtfRangePreparations: (
      input: Parameters<typeof actual.pageActiveCtfRangePreparations>[0],
    ) => actual.pageActiveCtfRangePreparations(input, database),
    readCtfRangePreparation: (scopeId: string, rangeOperationId: string) =>
      actual.readCtfRangePreparation(scopeId, rangeOperationId, database),
  };
});
vi.mock("@/stores/ctf-range-order-messages", async (original) => {
  const actual = await original<typeof import("@/stores/ctf-range-order-messages")>();
  return {
    ...actual,
    readBrowserCtfRangeOrderRefusalOperations: (scopeId: string, operationIds: readonly string[]) =>
      actual.readBrowserCtfRangeOrderRefusalOperations(scopeId, operationIds, database),
  };
});

let database: BitcasterDB;
beforeEach(() => {
  database = new BitcasterDB(`progress-ui-${crypto.randomUUID()}`);
  // fake-indexeddb clones bytes in Node's realm, outside jsdom's Uint8Array.
  database.ctfRangePreparations.hook(
    "reading",
    (record) =>
      record && {
        ...record,
        preparationBytes: Uint8Array.from(Object.values(record.preparationBytes)),
      },
  );
  mocks.scopeId = fixture().scopeId;
  mocks.signerRevision = 0;
  mocks.read.mockReset().mockResolvedValue(statusRead(group("Reconciling")));
  mocks.readFailure.mockReset().mockResolvedValue(null);
  useOrderSettlementObservations.setState({ byOrderId: {} });
  localStorage.clear();
  useOrderFailureNotices.setState({ notices: {} });
  useNotificationsStore.setState({ items: [] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  database.close();
  await database.delete();
  localStorage.clear();
});

/** Group states in which the order can still complete. */
const progressStatuses = [
  "Prepared",
  "SubmissionPending",
  "Reconciling",
  "Confirmed",
] as const satisfies readonly SettlementGroupStatus[];
/** Group states that fail the order: the engine marks it `failed`, and a FOK order never rests. */
const failedStatuses = [
  "DefinitivelyRejected",
  "Refundable",
  "ExpiredBeforeSubmission",
  "RejectedBeforeSubmission",
] as const satisfies readonly SettlementGroupStatus[];
const dictionaries = [en.settlementProgress, ja.settlementProgress] satisfies Record<
  (typeof progressStatuses)[number],
  string
>[];

describe("active settlement progress", () => {
  it("keeps public content visible when the local journal cannot be read", async () => {
    await database.ctfRangePreparations.put({
      ...fixture(),
      preparationBytes: new Uint8Array([0]),
    });
    render(
      <>
        <main>Public market</main>
        <SettlementProgress canReadStatus />
      </>,
    );
    expect(
      await screen.findByText(
        "Wallet progress is unavailable. Keep your wallet data and reload to try again.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("main")).toHaveTextContent("Public market");
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("pages at eight operations without deleting journal rows", async () => {
    for (let index = 1; index <= 9; index++) {
      const record = fixture();
      await database.ctfRangePreparations.put({
        ...record,
        rangeOperationId: `range-${index}`,
        clientOrderId: `client-${index}`,
        createdAtMs: index,
        updatedAtMs: index + 1,
        capability: {
          ...record.capability!,
          orderId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
        },
      });
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
    const otherScope = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(8)),
    });
    await database.ctfRangePreparations.bulkPut([record, { ...record, scopeId: otherScope }]);
    let finish!: (value: ReturnType<typeof statusRead>) => void;
    mocks.read
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValue(statusRead(group("SubmissionPending")));
    const view = render(<SettlementProgress canReadStatus />);
    await waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
    const oldSignal = mocks.read.mock.calls[0][2] as AbortSignal;
    act(() => {
      if (change === "wallet") mocks.scopeId = otherScope;
      else {
        mocks.signerRevision++;
        for (const notify of mocks.signerListeners) notify();
      }
    });
    view.rerender(<SettlementProgress canReadStatus />);
    expect(await screen.findByText(en.settlementProgress.SubmissionPending)).toBeVisible();
    expect(oldSignal.aborted).toBe(true);
    await act(async () => finish(statusRead(group("Confirmed"))));
    expect(screen.queryByText(en.settlementProgress.Confirmed)).not.toBeInTheDocument();
  });

  it.each(progressStatuses)("shows %s from an authoritative observation", async (status) => {
    await database.ctfRangePreparations.put(fixture());
    mocks.read.mockResolvedValue(statusRead(group(status)));
    render(<SettlementProgress canReadStatus />);
    const active = await screen.findByRole("region", { name: en.settlementProgress.title });
    await waitFor(() =>
      expect(within(active).getByText(en.settlementProgress[status])).toBeVisible(),
    );
    for (const dictionary of dictionaries) expect(dictionary[status]).not.toBe("");
    expect(within(active).getByText(en.settlementProgress.fees)).toBeVisible();
    expect(
      screen.queryByRole("region", { name: en.settlementProgress.failedTitle }),
    ).not.toBeInTheDocument();
  });

  it.each(failedStatuses)(
    "shows %s as a failed trade with the generic reason, not under the in-progress heading",
    async (status) => {
      await database.ctfRangePreparations.put(fixture());
      mocks.read.mockResolvedValue(statusRead(group(status)));
      render(<SettlementProgress canReadStatus />);
      const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
      expect(within(failed).getByText(en.settlementProgress.failed)).toBeVisible();
      expect(
        within(failed).getByRole("button", { name: en.settlementProgress.dismissFailure }),
      ).toBeVisible();
      expect(
        screen.queryByRole("region", { name: en.settlementProgress.title }),
      ).not.toBeInTheDocument();
      expect(stored("range-1")).toMatchObject({ reason: "Unspecified", dismissed: false });
    },
  );

  it.each(["OwnOutputReused", "GroupOutputReused"] as const)(
    "shows the %s reason under a failure heading, not under the in-progress heading",
    async (reason) => {
      await database.ctfRangePreparations.put(fixture());
      mocks.read.mockResolvedValue(statusRead(group("DefinitivelyRejected")));
      mocks.readFailure.mockResolvedValue(failure(reason));
      render(<SettlementProgress canReadStatus />);
      const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
      expect(within(failed).getByText(en.settlementProgress[reason])).toBeVisible();
      // The failure uses the error colour role of the wallet alerts, not neutral text.
      expect(
        within(failed).getByRole("heading", { name: en.settlementProgress.failedTitle }),
      ).toBeVisible();
      expect(failed.className).toMatch(/\btext-rose-800\b/);
      expect(
        screen.queryByRole("region", { name: en.settlementProgress.title }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(en.settlementProgress.failed)).not.toBeInTheDocument();
      expect(ja.settlementProgress[reason]).toMatch(/\S/);
      expect(ja.settlementProgress[reason]).not.toBe(en.settlementProgress[reason]);
    },
  );

  it("keeps other operations under the in-progress heading next to a failure", async () => {
    const record = fixture();
    await database.ctfRangePreparations.bulkPut([
      record,
      {
        ...record,
        rangeOperationId: "range-2",
        clientOrderId: "client-2",
        capability: null,
        lifecycleState: "prepared",
        createdAtMs: 3,
        updatedAtMs: 4,
      },
    ]);
    mocks.read.mockResolvedValue(statusRead(group("DefinitivelyRejected")));
    mocks.readFailure.mockResolvedValue(failure("OwnOutputReused"));
    render(<SettlementProgress canReadStatus />);
    const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    expect(within(failed).getAllByRole("listitem")).toHaveLength(1);
    const active = screen.getByRole("region", { name: en.settlementProgress.title });
    expect(within(active).getAllByRole("listitem")).toHaveLength(1);
    expect(within(active).getByText(en.settlementProgress.prepared)).toBeVisible();
    expect(
      within(active).queryByText(en.settlementProgress.OwnOutputReused),
    ).not.toBeInTheDocument();
  });

  it("keeps a temporary status read failure under the in-progress heading", async () => {
    await database.ctfRangePreparations.put(fixture());
    mocks.read.mockRejectedValue(new Error("offline"));
    render(<SettlementProgress canReadStatus />);
    const active = await screen.findByRole("region", { name: en.settlementProgress.title });
    await waitFor(() =>
      expect(within(active).getByText(en.settlementProgress.unavailable)).toBeVisible(),
    );
    await waitFor(() =>
      expect(
        within(active).getByRole("button", { name: en.settlementProgress.refresh }),
      ).toBeEnabled(),
    );
    expect(
      screen.queryByRole("region", { name: en.settlementProgress.failedTitle }),
    ).not.toBeInTheDocument();
    expect(
      within(active).queryByRole("button", { name: en.settlementProgress.dismissFailure }),
    ).toBeNull();
    expect(useOrderFailureNotices.getState().notices).toEqual({});
  });

  it("shows the generic reason when the engine records none for a rejection", async () => {
    await database.ctfRangePreparations.put(fixture());
    mocks.read.mockResolvedValue(statusRead(group("DefinitivelyRejected")));
    render(<SettlementProgress canReadStatus />);
    const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    await waitFor(() => expect(mocks.readFailure).toHaveBeenCalledTimes(1));
    expect(within(failed).getByText(en.settlementProgress.failed)).toBeVisible();
    expect(stored("range-1")?.reason).toBe("Unspecified");
  });

  it("replaces the generic reason when a later read finds the specific reason, and keeps a dismissal", async () => {
    await database.ctfRangePreparations.put(fixture());
    mocks.read.mockResolvedValue(statusRead(group("DefinitivelyRejected")));
    mocks.readFailure
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(failure("OwnOutputReused"));
    render(<SettlementProgress canReadStatus />);
    const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    await waitFor(() => expect(mocks.readFailure).toHaveBeenCalledTimes(1));
    expect(within(failed).getByText(en.settlementProgress.failed)).toBeVisible();

    // The next settlement hint for this order reads the reason again.
    act(() =>
      publishSettlementProgressHint({
        orderId: fixture().capability!.orderId,
        marketId: fixture().orderRouteId,
      }),
    );
    expect(await within(failed).findByText(en.settlementProgress.OwnOutputReused)).toBeVisible();
    expect(within(failed).queryByText(en.settlementProgress.failed)).not.toBeInTheDocument();

    // A dismissed generic failure stays dismissed when its reason is found.
    act(() => {
      useOrderFailureNotices.setState({ notices: {} });
      useOrderFailureNotices.getState().record({
        scopeId: fixture().scopeId,
        operationId: "range-1",
        orderId: fixture().capability!.orderId,
        marketId: fixture().orderRouteId,
        reason: "Unspecified",
      });
      useOrderFailureNotices.getState().dismiss(fixture().scopeId, "range-1");
    });
    act(() =>
      publishSettlementProgressHint({
        orderId: fixture().capability!.orderId,
        marketId: fixture().orderRouteId,
      }),
    );
    await waitFor(() => expect(stored("range-1")?.reason).toBe("OwnOutputReused"));
    expect(stored("range-1")?.dismissed).toBe(true);
    expect(
      screen.queryByRole("region", { name: en.settlementProgress.failedTitle }),
    ).not.toBeInTheDocument();
  });

  it("keeps the failure reason after the refund ends the operation, until the user dismisses it", async () => {
    const preparing = {
      ...fixture(),
      rangeOperationId: "range-2",
      clientOrderId: "client-2",
      capability: null,
      lifecycleState: "prepared" as const,
      createdAtMs: 3,
      updatedAtMs: 4,
    };
    await database.ctfRangePreparations.bulkPut([fixture(), preparing]);
    mocks.read.mockResolvedValue(statusRead(group("DefinitivelyRejected")));
    mocks.readFailure.mockResolvedValue(failure("OwnOutputReused"));
    const view = render(<SettlementProgress canReadStatus />);
    await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    expect(await screen.findByText(en.settlementProgress.prepared)).toBeVisible();

    // Wallet recovery refunds the order and ends its journal operation. The
    // other operation ends in the same write, so the in-progress section
    // closes when the panel has read the ended journal.
    await act(async () => {
      await database.ctfRangePreparations.bulkPut([
        { ...fixture(), lifecycleState: "terminal" },
        { ...preparing, lifecycleState: "terminal" },
      ]);
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: en.settlementProgress.title }),
      ).not.toBeInTheDocument(),
    );
    const failed = screen.getByRole("region", { name: en.settlementProgress.failedTitle });
    expect(within(failed).getByText(en.settlementProgress.OwnOutputReused)).toBeVisible();
    expect(screen.queryByText(en.settlementProgress.terminal)).not.toBeInTheDocument();

    // A reload recreates the failure from the persisted notice.
    view.unmount();
    await reloadNotices();
    const reloaded = render(<SettlementProgress canReadStatus />);
    const again = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    expect(within(again).getByText(en.settlementProgress.OwnOutputReused)).toBeVisible();

    const dismiss = within(again).getAllByRole("button", {
      name: en.settlementProgress.dismissFailure,
    });
    expect(dismiss).toHaveLength(1);
    fireEvent.click(dismiss[0]);
    expect(
      screen.queryByRole("region", { name: en.settlementProgress.failedTitle }),
    ).not.toBeInTheDocument();

    // The dismissal of this order stays after a reload. Another failure that
    // is still shown proves that the panel rendered the reloaded notices.
    reloaded.unmount();
    useOrderFailureNotices.getState().record({
      scopeId: fixture().scopeId,
      operationId: "range-3",
      orderId: "33333333-3333-4333-8333-333333333333",
      marketId: fixture().orderRouteId,
      reason: "Unspecified",
    });
    await reloadNotices();
    expect(stored("range-1")?.dismissed).toBe(true);
    render(<SettlementProgress canReadStatus />);
    const remaining = await screen.findByRole("region", {
      name: en.settlementProgress.failedTitle,
    });
    expect(within(remaining).getAllByRole("listitem")).toHaveLength(1);
    expect(within(remaining).getByText(en.settlementProgress.failed)).toBeVisible();
    expect(
      within(remaining).queryByText(en.settlementProgress.OwnOutputReused),
    ).not.toBeInTheDocument();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("shows a dismissed reason again after a reload when the dismissal could not be stored", async () => {
    await database.ctfRangePreparations.put(fixture());
    mocks.read.mockResolvedValue(statusRead(group("DefinitivelyRejected")));
    mocks.readFailure.mockResolvedValue(failure("GroupOutputReused"));
    const view = render(<SettlementProgress canReadStatus />);
    const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    fireEvent.click(
      within(failed).getByRole("button", { name: en.settlementProgress.dismissFailure }),
    );
    expect(
      screen.queryByRole("region", { name: en.settlementProgress.failedTitle }),
    ).not.toBeInTheDocument();
    // A dismissed failure does not return under the in-progress heading.
    expect(
      screen.queryByRole("region", { name: en.settlementProgress.title }),
    ).not.toBeInTheDocument();

    view.unmount();
    await reloadNotices();
    render(<SettlementProgress canReadStatus />);
    const again = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    expect(within(again).getByText(en.settlementProgress.GroupOutputReused)).toBeVisible();
  });

  it("keeps the failure of another wallet for its return, and does not show it here", async () => {
    const otherScope = deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(8)),
    });
    useOrderFailureNotices.getState().record({
      scopeId: otherScope,
      operationId: "range-9",
      orderId: "99999999-9999-4999-8999-999999999999",
      marketId: "condition-a-Alpha",
      reason: "OwnOutputReused",
    });
    await database.ctfRangePreparations.put(fixture());
    const view = render(<SettlementProgress canReadStatus />);
    await screen.findByText(en.settlementProgress.Reconciling);
    expect(
      screen.queryByRole("region", { name: en.settlementProgress.failedTitle }),
    ).not.toBeInTheDocument();
    expect(Object.values(useOrderFailureNotices.getState().notices)).toHaveLength(1);

    // The user switches back to that wallet.
    act(() => {
      mocks.scopeId = otherScope;
    });
    view.rerender(<SettlementProgress canReadStatus />);
    const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    expect(within(failed).getByText(en.settlementProgress.OwnOutputReused)).toBeVisible();
  });

  it("keeps paging when every operation on the first page failed", async () => {
    for (let index = 1; index <= 9; index++) {
      const record = fixture();
      await database.ctfRangePreparations.put({
        ...record,
        rangeOperationId: `range-${index}`,
        clientOrderId: `client-${index}`,
        createdAtMs: index,
        updatedAtMs: index + 1,
        ...(index === 9
          ? { lifecycleState: "prepared" as const, capability: null }
          : {
              capability: {
                ...record.capability!,
                orderId: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
              },
            }),
      });
    }
    mocks.read.mockResolvedValue(statusRead(group("Refundable")));
    render(<SettlementProgress canReadStatus />);
    const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    await waitFor(() => expect(within(failed).getAllByRole("listitem")).toHaveLength(8));
    const active = screen.getByRole("region", { name: en.settlementProgress.title });
    expect(within(active).queryAllByRole("listitem")).toHaveLength(0);
    fireEvent.click(within(active).getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(
        within(screen.getByRole("region", { name: en.settlementProgress.title })).getByText(
          en.settlementProgress.prepared,
        ),
      ).toBeVisible(),
    );
  });

  it("names a failed order by its market title, or by its outcome", async () => {
    await database.ctfRangePreparations.put(fixture());
    mocks.read.mockResolvedValue(statusRead(group("Refundable")));
    useNotificationsStore.setState({ items: [failedNotification("Will Alice win the cup?")] });
    render(<SettlementProgress canReadStatus />);
    const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    expect(within(failed).getByText("Order on “Will Alice win the cup?”")).toBeVisible();
    expect(failed).not.toHaveTextContent(/Operation/);
    act(() => useNotificationsStore.setState({ items: [] }));
    expect(within(failed).getByText("Order on “Alpha”")).toBeVisible();
  });

  // Each tab bounds the notices after its own record or dismissal only. A
  // bound after another tab's write evicts that tab's notices, the union
  // merge brings them back, and the two tabs write to each other without end.
  it("does not write the notices again after another tab changes them", async () => {
    const { record, markEnded } = useOrderFailureNotices.getState();
    const keys: string[] = [];
    for (let index = 1; index <= ORDER_FAILURE_NOTICES_MAX; index++) {
      record(
        {
          scopeId: fixture().scopeId,
          operationId: `ended-${index}`,
          orderId: `order-ended-${index}`,
          marketId: fixture().orderRouteId,
          reason: "Unspecified",
        },
        index,
      );
      keys.push(orderFailureNoticeKey(fixture().scopeId, `ended-${index}`));
    }
    markEnded(keys);
    render(<SettlementProgress canReadStatus={false} />);
    const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    expect(within(failed).getAllByRole("listitem")).toHaveLength(ORDER_FAILURE_NOTICES_MAX);
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    // A tab of another wallet records a failure of an ended operation.
    const otherKey = orderFailureNoticeKey("other-scope", "other-1");
    const bytes = realGetItem.call(localStorage, ORDER_FAILURE_NOTICES_STORAGE_KEY)!;
    const state = JSON.parse(bytes) as { state: { notices: Record<string, unknown> } };
    state.state.notices[otherKey] = {
      scopeId: "other-scope",
      operationId: "other-1",
      orderId: "order-other-1",
      marketId: fixture().orderRouteId,
      reason: "Unspecified",
      recordedAtMs: 0,
      dismissed: false,
      ended: true,
    };
    realSetItem.call(localStorage, ORDER_FAILURE_NOTICES_STORAGE_KEY, JSON.stringify(state));
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ORDER_FAILURE_NOTICES_STORAGE_KEY,
        storageArea: localStorage,
      }),
    );
    await waitFor(() => expect(useOrderFailureNotices.getState().notices[otherKey]).toBeDefined());
    // Let the effects and the journal-free bound of this render finish.
    await act(async () => {
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();
    });

    expect(useOrderFailureNotices.getState().notices[otherKey]).toBeDefined();
    expect(setItem.mock.calls.filter(([key]) => key === ORDER_FAILURE_NOTICES_STORAGE_KEY)).toEqual(
      [],
    );
  });

  it("keeps the dismissal of an active failed order when older failures are evicted", async () => {
    // Dismissed failures of ended operations: their journal records are gone.
    const { record, dismiss } = useOrderFailureNotices.getState();
    for (let index = 1; index <= ORDER_FAILURE_NOTICES_MAX; index++) {
      record(
        {
          scopeId: fixture().scopeId,
          operationId: `ended-${index}`,
          orderId: `order-ended-${index}`,
          marketId: fixture().orderRouteId,
          reason: "Unspecified",
        },
        index,
      );
      dismiss(fixture().scopeId, `ended-${index}`);
    }
    await database.ctfRangePreparations.put(fixture());
    mocks.read.mockResolvedValue(statusRead(group("Refundable")));
    render(<SettlementProgress canReadStatus />);
    const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
    expect(within(failed).getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(
      within(failed).getByRole("button", { name: en.settlementProgress.dismissFailure }),
    );
    await waitFor(() => expect(stored("ended-1")).toBeUndefined());
    expect(stored("ended-2")?.dismissed).toBe(true);
    expect(stored("range-1")?.dismissed).toBe(true);
    expect(
      screen.queryByRole("region", { name: en.settlementProgress.title }),
    ).not.toBeInTheDocument();
  });

  it("reconstructs progress from the reopened journal without the pending-trade cache", async () => {
    await database.ctfRangePreparations.put(fixture());
    database.close();
    await database.open();
    render(<SettlementProgress canReadStatus />);
    expect(await screen.findByText(en.settlementProgress.Reconciling)).toBeVisible();
    expect(mocks.read).toHaveBeenCalledWith(
      "condition-a-Alpha",
      "11111111-1111-4111-8111-111111111111",
      expect.any(AbortSignal),
    );
  });

  it("keeps local preparation distinct and makes no unauthenticated read", async () => {
    await database.ctfRangePreparations.put(fixture());
    const view = render(<SettlementProgress canReadStatus={false} />);
    expect(await screen.findByText(en.settlementProgress.authenticationRequired)).toBeVisible();
    expect(mocks.read).not.toHaveBeenCalled();
    await act(async () => {
      await database.ctfRangePreparations.put({
        ...fixture(),
        capability: null,
        lifecycleState: "prepared",
      });
    });
    expect(await screen.findByText(en.settlementProgress.prepared)).toBeVisible();
    view.rerender(<SettlementProgress canReadStatus />);
    expect(await screen.findByText(en.settlementProgress.prepared)).toBeVisible();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    ["prepared", "prepared", null],
    ["capability-requested", "capabilityRequested", null],
    ["capability-bound", "capabilityBound", "capability"],
  ] as const)(
    "shows the exact local %s state without reading remote status",
    async (lifecycleState, message, capability) => {
      await database.ctfRangePreparations.put({
        ...fixture(),
        lifecycleState,
        capability: capability === null ? null : fixture().capability,
      });
      render(<SettlementProgress canReadStatus />);
      expect(await screen.findByText(en.settlementProgress[message])).toBeVisible();
      expect(mocks.read).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["order-request-rejected", null, true],
    ["submission-rejected", "capability", true],
    ["order-request-rejected", null, false],
  ] as const)(
    "shows a stopped %s order attempt as ended without a trade under the in-progress heading",
    async (lifecycleState, capability, canReadStatus) => {
      await database.ctfRangePreparations.put({
        ...fixture(),
        lifecycleState,
        capability: capability === null ? null : fixture().capability,
      });
      render(<SettlementProgress canReadStatus={canReadStatus} />);
      const active = await screen.findByRole("region", { name: en.settlementProgress.title });
      expect(
        await within(active).findByText(en.settlementProgress.endedWithoutTrade),
      ).toBeVisible();
      expect(
        screen.queryByRole("region", { name: en.settlementProgress.failedTitle }),
      ).not.toBeInTheDocument();
      expect(useOrderFailureNotices.getState().notices).toEqual({});
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.readFailure).not.toHaveBeenCalled();
    },
  );

  it("shows a refused order request only in its wallet alert", async () => {
    const record = fixture();
    await database.ctfRangePreparations.bulkPut([
      { ...record, lifecycleState: "order-request-rejected", capability: null },
      {
        ...record,
        rangeOperationId: "range-2",
        clientOrderId: "client-2",
        capability: null,
        lifecycleState: "prepared",
        createdAtMs: 3,
        updatedAtMs: 4,
      },
    ]);
    await recordBrowserCtfRangeMessage(
      {
        scopeId: record.scopeId,
        operationId: record.rangeOperationId,
        revision: record.revision - 1,
        code: "order-submission-uncertain",
        kind: "order",
        observedAtMs: 5,
      },
      database,
    );
    render(<SettlementProgress canReadStatus />);
    const items = () =>
      within(screen.getByRole("region", { name: en.settlementProgress.title })).getAllByRole(
        "listitem",
      );
    await waitFor(() => expect(items()).toHaveLength(2));
    // An order alert that is not a refusal keeps the neutral text.
    expect(items()[0]).toHaveTextContent(en.settlementProgress.endedWithoutTrade);

    // The wallet records the engine refusal as an order alert after the journal write.
    await act(async () => {
      await recordBrowserCtfRangeMessage(
        {
          scopeId: record.scopeId,
          operationId: record.rangeOperationId,
          revision: record.revision,
          code: "order-submission-rejected",
          kind: "order",
          observedAtMs: 10,
        },
        database,
      );
    });
    await waitFor(() => expect(items()).toHaveLength(1));
    expect(items()[0]).toHaveTextContent(en.settlementProgress.prepared);
    expect(screen.queryByText(en.settlementProgress.endedWithoutTrade)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: en.settlementProgress.failedTitle }),
    ).not.toBeInTheDocument();
    expect(useOrderFailureNotices.getState().notices).toEqual({});
  });

  it.each(["failed", "rejected_capacity"] as const)(
    "shows an accepted order that ended %s with no settlement group as a failed trade",
    async (status) => {
      await database.ctfRangePreparations.put(fixture());
      mocks.read.mockResolvedValue(statusRead(null, status));
      render(<SettlementProgress canReadStatus />);
      const failed = await screen.findByRole("region", { name: en.settlementProgress.failedTitle });
      expect(within(failed).getByText(en.settlementProgress.failed)).toBeVisible();
      expect(
        screen.queryByRole("region", { name: en.settlementProgress.title }),
      ).not.toBeInTheDocument();
      expect(mocks.readFailure).not.toHaveBeenCalled();
    },
  );

  it.each(["cancelled", "expired"] as const)(
    "shows an order that ended %s without a trade under the in-progress heading",
    async (status) => {
      await database.ctfRangePreparations.put(fixture());
      mocks.read.mockResolvedValue(statusRead(null, status));
      render(<SettlementProgress canReadStatus />);
      const active = await screen.findByRole("region", { name: en.settlementProgress.title });
      expect(
        await within(active).findByText(en.settlementProgress.endedWithoutTrade),
      ).toBeVisible();
      expect(
        screen.queryByRole("region", { name: en.settlementProgress.failedTitle }),
      ).not.toBeInTheDocument();
      expect(useOrderFailureNotices.getState().notices).toEqual({});
    },
  );

  it("shows the accepted submission state while settlement status is still unknown", async () => {
    mocks.read.mockResolvedValue(null);
    await database.ctfRangePreparations.put(fixture());
    render(<SettlementProgress canReadStatus />);
    expect(await screen.findByText(en.settlementProgress.orderSubmitted)).toBeVisible();
    expect(mocks.read).toHaveBeenCalledWith(
      "condition-a-Alpha",
      "11111111-1111-4111-8111-111111111111",
      expect.any(AbortSignal),
    );
  });

  it("removes terminal journal rows without claiming a trade or refund outcome", async () => {
    await database.ctfRangePreparations.put(fixture());
    render(<SettlementProgress canReadStatus />);
    await screen.findByText(en.settlementProgress.Reconciling);
    await act(async () => {
      await database.ctfRangePreparations.put({ ...fixture(), lifecycleState: "terminal" });
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: en.settlementProgress.title }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(en.settlementProgress.Confirmed)).not.toBeInTheDocument();
    expect(screen.queryByText(en.settlementProgress.complete)).not.toBeInTheDocument();
  });

  it("replaces a pending status when the order observation reports the order filled", async () => {
    await database.ctfRangePreparations.put(fixture());
    mocks.read.mockResolvedValue(statusRead(group("SubmissionPending")));
    render(<SettlementProgress canReadStatus />);
    expect(await screen.findByText(en.settlementProgress.SubmissionPending)).toBeVisible();
    act(() =>
      useOrderSettlementObservations.setState({
        byOrderId: {
          [fixture().capability!.orderId]: {
            walletId: mocks.walletId,
            signerRevision: 0,
            marketId: fixture().orderRouteId,
            orderId: fixture().capability!.orderId,
            status: "filled",
            group: { ...group("Confirmed"), revision: 2 },
          },
        },
      }),
    );
    expect(screen.getByText(en.settlementProgress.Confirmed)).toBeVisible();
    expect(screen.queryByText(en.settlementProgress.SubmissionPending)).not.toBeInTheDocument();
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });

  it("shows a short final state when a confirmed trade's journal becomes terminal, then closes", async () => {
    await database.ctfRangePreparations.put(fixture());
    mocks.read.mockResolvedValue(statusRead(group("Confirmed")));
    render(<SettlementProgress canReadStatus />);
    expect(
      await screen.findByText(en.settlementProgress.Confirmed, undefined, { timeout: 5_000 }),
    ).toBeVisible();
    // The live query uses zero-delay timeouts, so a fake clock stalls it. Hold
    // only the close timeout and run it explicitly. The hook test owns its delay.
    const closes: Array<() => void> = [];
    const realSetTimeout = globalThis.setTimeout;
    const schedule = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      handler: () => void,
      delay?: number,
    ) => {
      if (delay !== SETTLEMENT_COMPLETION_NOTICE_MS) return realSetTimeout(handler, delay);
      closes.push(handler);
      return realSetTimeout(() => {}, 0);
    }) as typeof setTimeout);
    try {
      await act(async () => {
        await database.ctfRangePreparations.put({ ...fixture(), lifecycleState: "terminal" });
      });
      // The terminal read can remove and remount the region. Wait on the live
      // document, then acquire the current region for the remaining assertions.
      expect(
        await screen.findByText(en.settlementProgress.complete, undefined, {
          timeout: 5_000,
        }),
      ).toBeVisible();
      const region = screen.getByRole("region", { name: en.settlementProgress.title });
      expect(within(region).getByText(en.settlementProgress.complete)).toBeVisible();
      expect(within(region).queryByText(en.settlementProgress.Confirmed)).not.toBeInTheDocument();
      expect(within(region).queryByText(en.settlementProgress.fees)).not.toBeInTheDocument();
      expect(
        within(region).queryByRole("button", { name: en.settlementProgress.refresh }),
      ).not.toBeInTheDocument();
      expect(closes).toHaveLength(1);
      act(() => closes[0]());
      expect(
        screen.queryByRole("region", { name: en.settlementProgress.title }),
      ).not.toBeInTheDocument();
    } finally {
      schedule.mockRestore();
    }
    expect(ja.settlementProgress.complete).not.toBe("");
  }, 15_000);
});

const realGetItem = Storage.prototype.getItem;
const realSetItem = Storage.prototype.setItem;

/**
 * A reload starts with no memory state and reads the persisted notices again.
 * Clearing the memory state also writes it, so put the stored bytes back.
 */
async function reloadNotices() {
  const bytes = realGetItem.call(localStorage, ORDER_FAILURE_NOTICES_STORAGE_KEY);
  useOrderFailureNotices.setState({ notices: {} });
  if (bytes === null) localStorage.removeItem(ORDER_FAILURE_NOTICES_STORAGE_KEY);
  else realSetItem.call(localStorage, ORDER_FAILURE_NOTICES_STORAGE_KEY, bytes);
  await act(() => useOrderFailureNotices.persist.rehydrate());
}

function stored(operationId: string) {
  return useOrderFailureNotices.getState().notices[
    orderFailureNoticeKey(fixture().scopeId, operationId)
  ];
}

function statusRead(
  readGroup: SettlementGroupSummary | null,
  status: OrderLifecycleStatus = "matched",
) {
  return { status, group: readGroup };
}

function failedNotification(marketTitle: string): Notification {
  return {
    id: `${fixture().capability!.orderId}-failed`,
    kind: "Failed",
    orderId: fixture().capability!.orderId,
    marketId: fixture().orderRouteId,
    filledAmountSubunits: 0,
    remainingAmountSubunits: 1_000,
    unit: "sat",
    divisibility: 1_000,
    marketTitle,
    occurredAt: 1,
    read: false,
  };
}

function failure(reason: OrderSettlementFailureReason) {
  return { groupId: "group-1", reason, failedAt: "2026-09-07T00:00:01Z" };
}

function group(status: SettlementGroupStatus): SettlementGroupSummary {
  return {
    groupId: "group-1",
    status,
    revision: 1,
    coalescingDeadline: "2026-09-07T00:00:00Z",
    frozenAt: null,
  };
}

function fixture(): CtfRangeOrderPreparationRecord {
  return {
    scopeId: deriveDurableCustodyScopeId({
      scopeKind: "wallet",
      walletId: deriveDurableCustodyWalletId(new Uint8Array(32).fill(7)),
    }),
    rangeOperationId: "range-1",
    sourceOperationId: "source-1",
    authorizationId: "auth-1",
    clientOrderId: "client-1",
    orderRouteId: "condition-a-Alpha",
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
    updatedAtMs: 2,
    lifecycleState: "order-submitted",
    revision: 3,
    capability: {
      artifactId: "11111111-1111-4111-8111-111111111111",
      orderId: "11111111-1111-4111-8111-111111111111",
      bindingDigest: "22".repeat(32),
      artifactDigest: "33".repeat(32),
    },
  };
}
