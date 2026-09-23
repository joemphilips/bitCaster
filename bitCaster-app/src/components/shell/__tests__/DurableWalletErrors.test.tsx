import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DurableWalletErrors } from "../DurableWalletErrors";

const mocks = vi.hoisted(() => ({
  acknowledge: vi.fn().mockResolvedValue(undefined),
  readPage: vi.fn(),
  scopeId: "scope-1",
  page: {
    messages: [
      {
        scopeId: "scope-1",
        operationId: "range-1",
        revision: 3,
        code: "mint-source-uncertain",
        kind: "funds",
        status: "active",
        observedAtMs: 10,
        acknowledgedAtMs: null,
      },
    ],
    nextCursor: null,
  },
}));

vi.mock("dexie-react-hooks", () => ({
  useLiveQuery: (query: () => unknown) => {
    query();
    return mocks.page;
  },
}));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: () => mocks.scopeId,
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: (selector: (state: { mnemonic: string }) => unknown) =>
    selector({ mnemonic: "seed words" }),
}));
vi.mock("@/stores/ctf-range-order-messages", () => ({
  acknowledgeBrowserCtfRangeMessage: mocks.acknowledge,
  pageActiveBrowserCtfRangeMessages: mocks.readPage,
}));

describe("DurableWalletErrors", () => {
  beforeEach(() => vi.clearAllMocks());

  it("restores a durable funds error and acknowledges only its exact revision", () => {
    render(<DurableWalletErrors />);

    expect(screen.getByRole("alert")).toHaveTextContent(
      "The mint result is uncertain. Funds recovery is pending.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss this wallet alert" }));

    expect(mocks.acknowledge).toHaveBeenCalledWith({
      scopeId: "scope-1",
      operationId: "range-1",
      revision: 3,
      code: "mint-source-uncertain",
      acknowledgedAtMs: expect.any(Number),
    });
  });

  it("can read later alerts without dismissing an unresolved alert", () => {
    const cursor = {
      observedAtMs: 10,
      operationId: "range-1",
      revision: 3,
      code: "mint-source-uncertain",
    };
    Object.assign(mocks.page, { nextCursor: cursor });
    render(<DurableWalletErrors />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(mocks.readPage).toHaveBeenLastCalledWith({
      scopeId: "scope-1",
      limit: 8,
      after: cursor,
    });
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "First alerts" }));
    expect(mocks.readPage).toHaveBeenLastCalledWith({ scopeId: "scope-1", limit: 8 });
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    Object.assign(mocks.page, { nextCursor: null });
  });

  it("keeps First available when a later page becomes empty", () => {
    Object.assign(mocks.page, {
      nextCursor: {
        observedAtMs: 10,
        operationId: "range-1",
        revision: 3,
        code: "mint-source-uncertain",
      },
    });
    const view = render(<DurableWalletErrors />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    const messages = mocks.page.messages;
    Object.assign(mocks.page, { messages: [], nextCursor: null });
    view.rerender(<DurableWalletErrors />);
    expect(screen.getByRole("button", { name: "First alerts" })).toBeVisible();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    Object.assign(mocks.page, { messages });
  });

  it("starts at the first page when the wallet scope changes", () => {
    Object.assign(mocks.page, {
      nextCursor: {
        observedAtMs: 10,
        operationId: "range-1",
        revision: 3,
        code: "mint-source-uncertain",
      },
    });
    const view = render(<DurableWalletErrors />);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    mocks.scopeId = "scope-2";
    Object.assign(mocks.page, { nextCursor: null });
    view.rerender(<DurableWalletErrors />);
    expect(mocks.readPage).toHaveBeenLastCalledWith({ scopeId: "scope-2", limit: 8 });
    expect(screen.queryByRole("button", { name: "First alerts" })).not.toBeInTheDocument();
    expect(mocks.acknowledge).not.toHaveBeenCalled();
    mocks.scopeId = "scope-1";
  });
});
