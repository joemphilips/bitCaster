import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MarketStatusChanged } from "@/lib/marketHub";
import type { HeldPositionCloseReconcilerOptions } from "@/lib/heldPositionCloseNotifications";

const mocks = vi.hoisted(() => ({
  mnemonic: "wallet words",
  activeScope: "scope:wallet words" as string | null,
  statusHandlers: [] as Array<(status: MarketStatusChanged) => void>,
  reconcilerOptions: [] as HeldPositionCloseReconcilerOptions[],
  request: vi.fn(async (_live?: unknown) => {}),
  dispose: vi.fn(),
  readCustody: vi.fn(async (_scopeId: string) => []),
}));

vi.mock("@/stores/wallet", () => ({
  useWalletStore: (selector: (state: { mnemonic: string }) => unknown) =>
    selector({ mnemonic: mocks.mnemonic }),
}));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: (mnemonic: string) => (mnemonic ? `scope:${mnemonic}` : null),
  activeBrowserWalletScopeId: () => mocks.activeScope,
}));
vi.mock("@/stores/portfolio-custody", () => ({
  readCanonicalPortfolioCustody: mocks.readCustody,
}));
vi.mock("@/lib/marketHub", () => ({
  onAnyMarketStatusChanged: (handler: (status: MarketStatusChanged) => void) => {
    mocks.statusHandlers.push(handler);
    return () => {
      mocks.statusHandlers.splice(mocks.statusHandlers.indexOf(handler), 1);
    };
  },
}));
vi.mock("@/lib/heldPositionCloseNotifications", () => ({
  createHeldPositionCloseReconciler: (options: HeldPositionCloseReconcilerOptions) => {
    mocks.reconcilerOptions.push(options);
    return { request: mocks.request, dispose: mocks.dispose };
  },
}));

import { useHeldPositionCloseNotifications } from "../useHeldPositionCloseNotifications";

let visibility: DocumentVisibilityState = "visible";

function setVisibility(value: DocumentVisibilityState) {
  visibility = value;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  mocks.mnemonic = "wallet words";
  mocks.activeScope = "scope:wallet words";
  mocks.statusHandlers.length = 0;
  mocks.reconcilerOptions.length = 0;
  mocks.request.mockClear();
  mocks.dispose.mockClear();
  mocks.readCustody.mockClear();
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
});

afterEach(() => {
  Reflect.deleteProperty(document, "visibilityState");
});

describe("useHeldPositionCloseNotifications", () => {
  it("reconciles once at start for the active wallet custody", async () => {
    renderHook(() => useHeldPositionCloseNotifications());

    expect(mocks.request.mock.calls).toEqual([[]]);
    const [options] = mocks.reconcilerOptions;
    expect(options.scopeId).toBe("scope:wallet words");
    expect(options.isCurrent()).toBe(true);
    await options.readCustody();
    expect(mocks.readCustody).toHaveBeenCalledWith("scope:wallet words");
    mocks.activeScope = "scope:other";
    expect(options.isCurrent()).toBe(false);
  });

  it("does nothing without a wallet", () => {
    mocks.mnemonic = "";

    renderHook(() => useHeldPositionCloseNotifications());
    setVisibility("visible");

    expect(mocks.reconcilerOptions).toHaveLength(0);
    expect(mocks.request).not.toHaveBeenCalled();
    expect(mocks.statusHandlers).toHaveLength(0);
  });

  it("reconciles again when the tab becomes visible", () => {
    renderHook(() => useHeldPositionCloseNotifications());
    mocks.request.mockClear();

    setVisibility("hidden");
    expect(mocks.request).not.toHaveBeenCalled();
    setVisibility("visible");
    expect(mocks.request.mock.calls).toEqual([[]]);
  });

  it("passes a live close to the reconcile and ignores an open status", () => {
    renderHook(() => useHeldPositionCloseNotifications());
    mocks.request.mockClear();
    const conditionId = "c".repeat(64);
    const closed: MarketStatusChanged = {
      conditionId,
      state: "closed",
      closedAt: "2026-11-02T00:00:00Z",
      finalOutcome: "YES",
    };

    mocks.statusHandlers[0]({ conditionId, state: "open", closedAt: null, finalOutcome: null });
    expect(mocks.request).not.toHaveBeenCalled();
    mocks.statusHandlers[0](closed);
    expect(mocks.request.mock.calls).toEqual([[closed]]);
  });

  it("stops every trigger on unmount", () => {
    const { unmount } = renderHook(() => useHeldPositionCloseNotifications());
    mocks.request.mockClear();

    unmount();
    setVisibility("visible");

    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect(mocks.statusHandlers).toHaveLength(0);
    expect(mocks.request).not.toHaveBeenCalled();
  });
});
