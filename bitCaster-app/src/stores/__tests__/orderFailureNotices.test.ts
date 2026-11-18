import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ORDER_FAILURE_NOTICES_MAX,
  ORDER_FAILURE_NOTICES_STORAGE_KEY,
  markEndedOrderFailureNotices,
  orderFailureNoticeKey,
  useOrderFailureNotices,
  type NewOrderFailureNotice,
} from "../orderFailureNotices";

// The journal records of these operations are gone, so each bound sees them ended.
vi.mock("@/stores/ctf-range-order-db", () => ({
  readCtfRangePreparation: vi.fn().mockResolvedValue(null),
}));

function notice(operationId: string, overrides: Partial<NewOrderFailureNotice> = {}) {
  return {
    scopeId: "scope-1",
    operationId,
    orderId: `order-${operationId}`,
    marketId: "condition-Alpha",
    reason: "OwnOutputReused" as const,
    ...overrides,
  };
}

function stored(operationId: string, scopeId = "scope-1") {
  return useOrderFailureNotices.getState().notices[orderFailureNoticeKey(scopeId, operationId)];
}

const realGetItem = Storage.prototype.getItem;
const realSetItem = Storage.prototype.setItem;

/**
 * A reload starts with no memory state and reads the persisted state again.
 * Clearing the memory state also writes it, so put the stored bytes back.
 */
async function reload() {
  const bytes = realGetItem.call(localStorage, ORDER_FAILURE_NOTICES_STORAGE_KEY);
  useOrderFailureNotices.setState({ notices: {} });
  if (bytes === null) localStorage.removeItem(ORDER_FAILURE_NOTICES_STORAGE_KEY);
  else realSetItem.call(localStorage, ORDER_FAILURE_NOTICES_STORAGE_KEY, bytes);
  await useOrderFailureNotices.persist.rehydrate();
}

/** Writes of this store to browser storage. */
function noticeWrites() {
  const spy = vi.spyOn(Storage.prototype, "setItem");
  return () => spy.mock.calls.filter(([key]) => key === ORDER_FAILURE_NOTICES_STORAGE_KEY).length;
}

/** Record notices, the oldest first, at `fromMs + index`. */
function recordMany(
  count: number,
  make: (index: number) => NewOrderFailureNotice,
  options: { dismissed: boolean; fromMs: number },
) {
  const { record, dismiss } = useOrderFailureNotices.getState();
  for (let index = 1; index <= count; index++) {
    const item = make(index);
    record(item, options.fromMs + index);
    if (options.dismissed) dismiss(item.scopeId, item.operationId);
  }
}

beforeEach(() => {
  localStorage.clear();
  useOrderFailureNotices.setState({ notices: {} });
});
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("order failure notices", () => {
  it("keeps a recorded reason and its dismissal for each operation after a reload", async () => {
    const { record, dismiss } = useOrderFailureNotices.getState();
    record(notice("operation-1"), 10);
    record(notice("operation-2", { reason: "Unspecified" }), 20);
    dismiss("scope-1", "operation-1");

    await reload();

    expect(stored("operation-1")).toEqual({
      ...notice("operation-1"),
      recordedAtMs: 10,
      dismissed: true,
      ended: false,
    });
    expect(stored("operation-2")).toEqual({
      ...notice("operation-2", { reason: "Unspecified" }),
      recordedAtMs: 20,
      dismissed: false,
      ended: false,
    });
  });

  it("does not show a dismissed reason again when the same failure is read again", () => {
    const { record, dismiss } = useOrderFailureNotices.getState();
    record(notice("operation-1"), 10);
    dismiss("scope-1", "operation-1");
    record(notice("operation-1"), 30);

    expect(stored("operation-1")).toMatchObject({ recordedAtMs: 10, dismissed: true });
  });

  it("replaces a generic reason with a later specific reason and keeps the dismissal", () => {
    const { record, dismiss } = useOrderFailureNotices.getState();
    record(notice("operation-1", { reason: "Unspecified" }), 10);
    dismiss("scope-1", "operation-1");
    record(notice("operation-1", { reason: "GroupOutputReused" }), 30);

    expect(stored("operation-1")).toEqual({
      ...notice("operation-1", { reason: "GroupOutputReused" }),
      recordedAtMs: 10,
      dismissed: true,
      ended: false,
    });
  });

  it("never replaces a specific reason with the generic one", () => {
    const { record } = useOrderFailureNotices.getState();
    record(notice("operation-1", { reason: "OwnOutputReused" }), 10);
    record(notice("operation-1", { reason: "Unspecified" }), 30);

    expect(stored("operation-1")?.reason).toBe("OwnOutputReused");
  });

  it("keeps the same operation of two wallets apart", () => {
    const { record, dismiss } = useOrderFailureNotices.getState();
    record(notice("operation-1"), 10);
    record(notice("operation-1", { scopeId: "scope-2" }), 20);
    dismiss("scope-2", "operation-1");

    expect(stored("operation-1")?.dismissed).toBe(false);
    expect(stored("operation-1", "scope-2")?.dismissed).toBe(true);
  });

  it("writes nothing when a record, a dismissal, an end mark or the bound changes nothing", async () => {
    const { record, dismiss, evictBeyondLimit } = useOrderFailureNotices.getState();
    record(notice("operation-1"), 10);
    dismiss("scope-1", "operation-1");
    const writes = noticeWrites();

    record(notice("operation-1"), 20);
    record(notice("operation-1", { reason: "Unspecified" }), 30);
    dismiss("scope-1", "operation-1");
    dismiss("scope-1", "missing");
    evictBeyondLimit("scope-1");
    await markEndedOrderFailureNotices("scope-1", async () => true);

    expect(writes()).toBe(0);
  });

  it("dismisses in this page when the dismissal cannot be stored, and shows the reason again after a reload", async () => {
    useOrderFailureNotices.getState().record(notice("operation-1"), 10);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });

    expect(() => useOrderFailureNotices.getState().dismiss("scope-1", "operation-1")).not.toThrow();
    expect(stored("operation-1")?.dismissed).toBe(true);

    await reload();
    expect(stored("operation-1")?.dismissed).toBe(false);
  });

  it("starts empty when the stored state cannot be read", async () => {
    useOrderFailureNotices.getState().record(notice("operation-1"), 10);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    await expect(reload()).resolves.toBeUndefined();
    expect(useOrderFailureNotices.getState().notices).toEqual({});
  });

  it("merges the notices of another tab: it keeps both sides, a dismissal and a specific reason", async () => {
    const { record } = useOrderFailureNotices.getState();
    record(notice("operation-1", { reason: "Unspecified" }), 10);
    record(notice("operation-3"), 30);
    // The other tab dismissed operation 1, found its reason, and recorded operation 2.
    const other = {
      [orderFailureNoticeKey("scope-1", "operation-1")]: {
        ...notice("operation-1", { reason: "GroupOutputReused" }),
        recordedAtMs: 10,
        dismissed: true,
        ended: false,
      },
      [orderFailureNoticeKey("scope-1", "operation-2")]: {
        ...notice("operation-2"),
        recordedAtMs: 20,
        dismissed: false,
        ended: false,
      },
    };
    realSetItem.call(
      localStorage,
      ORDER_FAILURE_NOTICES_STORAGE_KEY,
      JSON.stringify({ state: { notices: other }, version: 0 }),
    );

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ORDER_FAILURE_NOTICES_STORAGE_KEY,
        storageArea: localStorage,
      }),
    );

    await vi.waitFor(() => expect(stored("operation-2")).toBeDefined());
    expect(stored("operation-1")).toMatchObject({
      reason: "GroupOutputReused",
      dismissed: true,
    });
    expect(stored("operation-3")).toMatchObject({ dismissed: false });
  });

  it("keeps the dismissal of this tab when another tab still holds the notice undismissed", async () => {
    const { record, dismiss } = useOrderFailureNotices.getState();
    record(notice("operation-1", { reason: "OwnOutputReused" }), 10);
    dismiss("scope-1", "operation-1");
    realSetItem.call(
      localStorage,
      ORDER_FAILURE_NOTICES_STORAGE_KEY,
      JSON.stringify({
        state: {
          notices: {
            [orderFailureNoticeKey("scope-1", "operation-1")]: {
              ...notice("operation-1", { reason: "Unspecified" }),
              recordedAtMs: 10,
              dismissed: false,
              ended: true,
            },
            [orderFailureNoticeKey("scope-1", "operation-2")]: {
              ...notice("operation-2"),
              recordedAtMs: 20,
              dismissed: false,
              ended: false,
            },
          },
        },
        version: 0,
      }),
    );

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: ORDER_FAILURE_NOTICES_STORAGE_KEY,
        storageArea: localStorage,
      }),
    );

    await vi.waitFor(() => expect(stored("operation-2")).toBeDefined());
    expect(stored("operation-1")).toMatchObject({
      reason: "OwnOutputReused",
      dismissed: true,
      ended: true,
    });
  });

  it("drops a stored notice with an unknown reason or field, and keeps the valid ones", async () => {
    const valid = { ...notice("operation-1"), recordedAtMs: 10, dismissed: false, ended: false };
    const generic = {
      ...notice("operation-6", { reason: "Unspecified" }),
      recordedAtMs: 10,
      dismissed: false,
      ended: true,
    };
    const entry = (value: { scopeId: string; operationId: string; [field: string]: unknown }) =>
      [orderFailureNoticeKey(value.scopeId, value.operationId), value] as const;
    localStorage.setItem(
      ORDER_FAILURE_NOTICES_STORAGE_KEY,
      JSON.stringify({
        state: {
          notices: Object.fromEntries([
            entry(valid),
            entry(generic),
            entry({ ...valid, operationId: "operation-2", reason: "SomeNewReason" }),
            entry({ ...valid, operationId: "operation-3", dismissed: "no" }),
            [orderFailureNoticeKey("scope-1", "operation-4"), { ...valid, operationId: "other" }],
            entry({ ...valid, operationId: "operation-5", extra: true }),
            entry({ ...valid, operationId: "operation-7", orderId: "" }),
            entry({ ...valid, operationId: "operation-8", orderId: null }),
            entry({ ...valid, operationId: "operation-9", ended: 1 }),
          ]),
        },
        version: 0,
      }),
    );

    await reload();

    expect(useOrderFailureNotices.getState().notices).toEqual(
      Object.fromEntries([entry(valid), entry(generic)]),
    );
  });

  it("lets two tabs of different wallets settle: only their own records write", async () => {
    // Two module instances are two tabs. Both read and write the same storage.
    vi.resetModules();
    const tabA = await import("../orderFailureNotices");
    vi.resetModules();
    const tabB = await import("../orderFailureNotices");
    const tabs = [tabA, tabB];
    const writes = noticeWrites();
    const share = async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: ORDER_FAILURE_NOTICES_STORAGE_KEY,
          storageArea: localStorage,
        }),
      );
      for (const tab of tabs) await tab.useOrderFailureNotices.persist.rehydrate();
    };
    const perTab = ORDER_FAILURE_NOTICES_MAX - 40;
    for (let index = 1; index <= perTab; index++) {
      await tabA.recordOrderFailureNotice(notice(`a-${index}`, { scopeId: "scope-a" }), index);
      await share();
      await tabB.recordOrderFailureNotice(notice(`b-${index}`, { scopeId: "scope-b" }), index);
      await share();
    }
    const afterOwnWrites = writes();
    // Each own record writes at most its notice, its end mark and its bound.
    expect(afterOwnWrites).toBeLessThanOrEqual(2 * perTab * 3);

    // Changes that this tab did not make never make it write.
    for (let round = 0; round < 5; round++) await share();
    expect(writes()).toBe(afterOwnWrites);
    for (let index = 1; index <= perTab; index++) {
      expect(
        tabA.useOrderFailureNotices.getState().notices[
          orderFailureNoticeKey("scope-a", `a-${index}`)
        ],
      ).toBeDefined();
      expect(
        tabB.useOrderFailureNotices.getState().notices[
          orderFailureNoticeKey("scope-b", `b-${index}`)
        ],
      ).toBeDefined();
    }
  });

  it("marks the ended operations of the current wallet only", async () => {
    const { record } = useOrderFailureNotices.getState();
    record(notice("ended"), 1);
    record(notice("active"), 2);
    record(notice("unreadable"), 3);
    record(notice("other", { scopeId: "scope-2" }), 4);
    const isActive = vi.fn(async (_scopeId: string, operationId: string) => {
      if (operationId === "unreadable") throw new Error("journal unavailable");
      return operationId === "active";
    });

    await markEndedOrderFailureNotices("scope-1", isActive);

    expect(stored("ended")?.ended).toBe(true);
    expect(stored("active")?.ended).toBe(false);
    expect(stored("unreadable")?.ended).toBe(false);
    expect(stored("other", "scope-2")?.ended).toBe(false);
    expect(isActive.mock.calls.map(([scopeId]) => scopeId)).not.toContain("scope-2");
  });

  it("keeps the notices of other wallets", async () => {
    const { record } = useOrderFailureNotices.getState();
    record(notice("operation-1"), 10);
    record(notice("operation-2", { scopeId: "scope-2" }), 20);

    await markEndedOrderFailureNotices("scope-1", async () => false);
    useOrderFailureNotices.getState().evictBeyondLimit("scope-1");

    expect(stored("operation-2", "scope-2")).toBeDefined();
    expect(stored("operation-1")?.ended).toBe(true);
  });

  it("above the limit, evicts the oldest ended notices that the current wallet does not show", async () => {
    // Undismissed failures of the current wallet: ended, but still shown.
    recordMany(ORDER_FAILURE_NOTICES_MAX - 4, (index) => notice(`current-${index}`), {
      dismissed: false,
      fromMs: 0,
    });
    // Another wallet: two ended undismissed, one undismissed with an active journal.
    recordMany(3, (index) => notice(`other-${index}`, { scopeId: "scope-2" }), {
      dismissed: false,
      fromMs: 1_000,
    });
    // Dismissed failures of the current wallet; the second is still active.
    recordMany(3, (index) => notice(`dismissed-${index}`), { dismissed: true, fromMs: 2_000 });
    await markEndedOrderFailureNotices(
      "scope-1",
      async (_scopeId, operationId) => operationId === "dismissed-2",
    );
    await markEndedOrderFailureNotices(
      "scope-2",
      async (_scopeId, operationId) => operationId === "other-3",
    );
    const total = () => Object.keys(useOrderFailureNotices.getState().notices).length;
    expect(total()).toBe(ORDER_FAILURE_NOTICES_MAX + 2);

    useOrderFailureNotices.getState().evictBeyondLimit("scope-1");

    expect(total()).toBe(ORDER_FAILURE_NOTICES_MAX);
    // The oldest evictable notices are the ended ones of the other wallet.
    expect(stored("other-1", "scope-2")).toBeUndefined();
    expect(stored("other-2", "scope-2")).toBeUndefined();
    expect(stored("other-3", "scope-2")).toBeDefined();
    expect(stored("dismissed-1")).toBeDefined();
    expect(stored("dismissed-2")).toBeDefined();
    expect(stored("current-1")).toBeDefined();
  });

  it("never evicts an active or unchecked notice, or an undismissed one of the current wallet", async () => {
    recordMany(ORDER_FAILURE_NOTICES_MAX, (index) => notice(`current-${index}`), {
      dismissed: false,
      fromMs: 0,
    });
    recordMany(2, (index) => notice(`dismissed-${index}`), { dismissed: true, fromMs: 1_000 });
    // Every current failure ended. The journal of dismissed-1 is active, and
    // the journal of dismissed-2 cannot be read.
    await markEndedOrderFailureNotices("scope-1", async (_scopeId, operationId) => {
      if (operationId === "dismissed-2") throw new Error("journal unavailable");
      return operationId === "dismissed-1";
    });

    useOrderFailureNotices.getState().evictBeyondLimit("scope-1");

    expect(Object.keys(useOrderFailureNotices.getState().notices)).toHaveLength(
      ORDER_FAILURE_NOTICES_MAX + 2,
    );
  });
});
