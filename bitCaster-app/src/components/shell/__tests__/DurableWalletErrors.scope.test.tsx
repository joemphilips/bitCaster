import "fake-indexeddb/auto";
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DurableWalletErrors } from "../DurableWalletErrors";

const mocks = vi.hoisted(() => ({
  scopeId: "scope-a",
  page: vi.fn(),
  acknowledge: vi.fn(),
}));

vi.mock("@/lib/browserWalletProfile", () => ({
  browserWalletScopeIdFromMnemonic: () => mocks.scopeId,
}));
vi.mock("@/stores/wallet", () => ({
  useWalletStore: (selector: (state: { mnemonic: string }) => unknown) =>
    selector({ mnemonic: "test wallet" }),
}));
vi.mock("@/stores/ctf-range-order-messages", () => ({
  pageActiveBrowserCtfRangeMessages: mocks.page,
  acknowledgeBrowserCtfRangeMessage: mocks.acknowledge,
}));

it("hides old wallet alerts while the new wallet query is pending", async () => {
  let resolveNewPage!: (page: ReturnType<typeof alertPage>) => void;
  const pending = new Promise<ReturnType<typeof alertPage>>((resolve) => {
    resolveNewPage = resolve;
  });
  mocks.page.mockImplementation(({ scopeId }: { scopeId: string }) =>
    scopeId === "scope-a" ? Promise.resolve(alertPage(scopeId)) : pending,
  );
  const view = render(<DurableWalletErrors />);
  expect(await screen.findByRole("alert")).toHaveTextContent("scope-a-operation");

  mocks.scopeId = "scope-b";
  view.rerender(<DurableWalletErrors />);
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Dismiss this wallet alert" })).not.toBeInTheDocument();

  resolveNewPage(alertPage("scope-b"));
  expect(await screen.findByRole("alert")).toHaveTextContent("scope-b-operation");
  expect(screen.queryByText(/scope-a-operation/)).not.toBeInTheDocument();
  expect(mocks.acknowledge).not.toHaveBeenCalled();
});

function alertPage(scopeId: string) {
  return {
    messages: [{
      scopeId, operationId: `${scopeId}-operation`, revision: 1,
      code: "recovery-pending", kind: "funds", status: "active",
      observedAtMs: 10, acknowledgedAtMs: null,
    }],
    nextCursor: null,
  };
}
