import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ShellRoutes } from "../App";

vi.mock("@/components/shell", async () => {
  const actual = await vi.importActual<typeof import("@/components/shell")>("@/components/shell");
  return { ...actual, DurableWalletErrors: () => null };
});
vi.mock("@/components/shell/SettlementProgress", () => ({ SettlementProgress: () => null }));
vi.mock("@/pages/MarketsPage", () => ({ MarketsPage: () => <div>Markets page</div> }));
vi.mock("@/pages/MarketDetailPage", () => ({ MarketDetailPage: () => <div>Market detail</div> }));
vi.mock("@/pages/PortfolioPage", () => ({ PortfolioPage: () => <div>Portfolio page</div> }));
vi.mock("@/pages/CreatorPage", () => ({ CreatorPage: () => <div>Creator page</div> }));
vi.mock("@/pages/SettingsPage", () => ({ SettingsPage: () => <div>Settings page</div> }));
vi.mock("@/pages/MintDetailPage", () => ({ MintDetailPage: () => <div>Mint page</div> }));
vi.mock("@/pages/UserPage", () => ({ UserPage: () => <div>User page</div> }));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { nostrProfile: null }) => unknown) =>
    selector({ nostrProfile: null }),
}));
vi.mock("@/stores/wallet", () => ({
  DEFAULT_MINT_URL: "https://mint.example",
  useBalance: () => 0,
  useWalletStore: (selector: (state: { mnemonic: string; mints: [] }) => unknown) =>
    selector({ mnemonic: "", mints: [] }),
}));

function NavigationControls() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output data-testid="route">
        {location.pathname}
        {location.search}
      </output>
      <button type="button" onClick={() => navigate("/markets")}>
        Clear URL
      </button>
      <button type="button" onClick={() => navigate("/markets?search=restored")}>
        Restore search
      </button>
    </>
  );
}

describe("ShellRoutes search URL authority", () => {
  it("initializes both search boxes from the route and follows clear/navigation", () => {
    render(
      <MemoryRouter initialEntries={["/markets?search=Bitcoin%20Oracle"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <ShellRoutes canReadOrderStatus={false} />
                <NavigationControls />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const desktopInput = screen.getByPlaceholderText("Search markets...");
    expect(desktopInput).toHaveValue("Bitcoin Oracle");
    expect(screen.getByTestId("route")).toHaveTextContent("/markets?search=Bitcoin%20Oracle");

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    const searchInputs = screen.getAllByPlaceholderText("Search markets...");
    expect(searchInputs).toHaveLength(2);
    expect(searchInputs[1]).toHaveValue("Bitcoin Oracle");

    fireEvent.change(searchInputs[1]!, { target: { value: "Bitcoin" } });
    expect(screen.getByTestId("route")).toHaveTextContent("/markets?search=Bitcoin");
    expect(searchInputs[0]).toHaveValue("Bitcoin");
    expect(searchInputs[1]).toHaveValue("Bitcoin");

    fireEvent.change(searchInputs[1]!, { target: { value: "Bitcoin " } });
    expect(screen.getByTestId("route")).toHaveTextContent("/markets?search=Bitcoin%20");
    expect(searchInputs[0]).toHaveValue("Bitcoin ");
    expect(searchInputs[1]).toHaveValue("Bitcoin ");

    fireEvent.change(searchInputs[1]!, { target: { value: "Bitcoin O" } });
    expect(screen.getByTestId("route")).toHaveTextContent("/markets?search=Bitcoin%20O");
    expect(searchInputs[0]).toHaveValue("Bitcoin O");
    expect(searchInputs[1]).toHaveValue("Bitcoin O");

    fireEvent.click(screen.getByRole("button", { name: "Clear URL" }));
    expect(screen.getByTestId("route")).toHaveTextContent("/markets");
    expect(searchInputs[0]).toHaveValue("");
    expect(searchInputs[1]).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: "Restore search" }));
    expect(screen.getByTestId("route")).toHaveTextContent("/markets?search=restored");
    expect(screen.getAllByPlaceholderText("Search markets...")[0]).toHaveValue("restored");
    expect(screen.getAllByPlaceholderText("Search markets...")[1]).toHaveValue("restored");
  });

  it("keeps every character from rapid typing while route commits are deferred", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/markets"]}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <ShellRoutes canReadOrderStatus={false} />
                <NavigationControls />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByPlaceholderText("Search markets..."), "no match");

    expect(screen.getByPlaceholderText("Search markets...")).toHaveValue("no match");
    expect(screen.getByTestId("route")).toHaveTextContent("/markets?search=no%20match");
  });
});
