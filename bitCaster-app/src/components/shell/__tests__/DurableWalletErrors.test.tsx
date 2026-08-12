import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DurableWalletErrors } from "../DurableWalletErrors";

const mocks = vi.hoisted(() => ({
  acknowledge: vi.fn().mockResolvedValue(undefined),
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

vi.mock("dexie-react-hooks", () => ({ useLiveQuery: () => mocks.page }));
vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: () => "scope-1",
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: (selector: (state: { mnemonic: string }) => unknown) =>
    selector({ mnemonic: "seed words" }),
}));
vi.mock("@/stores/ctf-range-order-messages", () => ({
  acknowledgeBrowserCtfRangeMessage: mocks.acknowledge,
  pageActiveBrowserCtfRangeMessages: vi.fn(),
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
});
