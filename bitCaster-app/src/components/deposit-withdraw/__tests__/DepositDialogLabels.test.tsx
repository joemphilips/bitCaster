import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import type { DepositWithdrawProps } from "@/types/deposit-withdraw";
import { DepositWithdraw } from "../DepositWithdraw";
import { InvoiceDisplay } from "../InvoiceDisplay";
import { MeltConfirmation } from "../MeltConfirmation";
import { MintSelector } from "../MintSelector";
import { PaymentRequestDisplay } from "../PaymentRequestDisplay";
import { TokenDisplay } from "../TokenDisplay";

vi.mock("@/lib/walletOps", () => ({ userAddAndSelectMint: vi.fn() }));

const MINT = {
  id: "https://mint.example",
  name: "Mint A",
  url: "https://mint.example",
  balanceSats: 0,
};

function viewProps(
  currentView: DepositWithdrawProps["currentView"],
  mode: DepositWithdrawProps["mode"] = "deposit",
): DepositWithdrawProps {
  return {
    mode,
    currentView,
    mints: [MINT],
    selectedMintId: MINT.id,
    amountSats: 0,
    lightningInput: "",
  };
}

function expectEveryButtonNamed() {
  for (const button of screen.getAllByRole("button")) expect(button).toHaveAccessibleName();
}

beforeEach(async () => {
  await i18n.changeLanguage("ja");
});

afterEach(async () => {
  cleanup();
  await i18n.changeLanguage("en");
});

describe("deposit and withdrawal dialog labels", () => {
  it.each([
    ["chooser", "deposit", "入金"],
    ["chooser", "withdraw", "出金"],
    ["deposit-ecash", "deposit", "Ecashで入金"],
    ["deposit-lightning", "deposit", "Lightningで入金"],
    ["send-ecash", "withdraw", "Ecashを送る"],
    ["pay-lightning", "withdraw", "Lightningで支払う"],
  ] as const)("names every %s (%s) control in Japanese", (currentView, mode, title) => {
    render(<DepositWithdraw {...viewProps(currentView, mode)} />);

    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent(title);
    expectEveryButtonNamed();
  });

  it("closes the method chooser from a named control and has no inactive expand control", () => {
    const onClose = vi.fn();
    render(<DepositWithdraw {...viewProps("chooser")} onClose={onClose} />);

    expect(screen.getAllByRole("button").map((button) => button.textContent || "")).toEqual([
      "",
      "Ecash",
      "Lightning",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "閉じる" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("translates the Lightning deposit form and names the backspace key", () => {
    const onNumpadPress = vi.fn();
    render(
      <DepositWithdraw
        {...viewProps("deposit-lightning")}
        amountSats={12}
        onNumpadPress={onNumpadPress}
      />,
    );

    expect(screen.getByRole("button", { name: "インボイスを作成" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Mint A/ })).toHaveTextContent("利用可能: 0 sats");
    expect(screen.queryByText(/Deposit Lightning|Create Invoice|available/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "最後の数字を削除" }));
    expect(onNumpadPress).toHaveBeenCalledWith("backspace");
  });

  it("translates the mint selector sheet and names its close control", () => {
    render(<MintSelector mints={[MINT]} selectedMintId={MINT.id} />);
    fireEvent.click(screen.getByRole("button", { name: /Mint A/ }));

    const sheet = screen.getByRole("dialog", { name: "ミントを選択" });
    expect(within(sheet).getByRole("heading", { name: "ミントを選択" })).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "ミントを追加" })).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("dialog", { name: "ミントを選択" })).toBeNull();
  });

  it.each([
    ["invoice", () => <InvoiceDisplay bolt11="lnbc1example" amountSats={1} status="pending" />],
    [
      "melt confirmation",
      () => <MeltConfirmation amountSats={1} feeSats={1} invoice="lnbc1example" isPaying={false} />,
    ],
    [
      "payment request",
      () => <PaymentRequestDisplay paymentRequestEncoded="creqAexample" status="waiting" />,
    ],
    ["token", () => <TokenDisplay token="cashuBexample" amountSats={1} proofCount={1} />],
  ])("names every %s control in Japanese", (_, view) => {
    render(view());

    expectEveryButtonNamed();
    expect(screen.getAllByRole("button", { name: "閉じる" })).toHaveLength(1);
  });
});
