import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WalletSetupModal } from "../WalletSetupModal";

const validSeedPhrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function renderWalletSetupModal() {
  const onImportSeed = vi.fn();

  render(<WalletSetupModal onClose={vi.fn()} onCreateNew={vi.fn()} onImportSeed={onImportSeed} />);

  return { onImportSeed };
}

describe("WalletSetupModal", () => {
  it("shows a warning and only the replacement seed action in replace mode", async () => {
    const onImportSeed = vi.fn();
    render(
      <WalletSetupModal
        mode="replace"
        onClose={vi.fn()}
        onCreateNew={vi.fn()}
        onImportSeed={onImportSeed}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Replace This Wallet" })).toBeInTheDocument();
    expect(screen.getByText(/back up your current seed phrase/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /create new wallet/i })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /import existing wallet/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replace Wallet" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Seed word 1"), { target: { value: validSeedPhrase } });
    await userEvent.click(screen.getByRole("button", { name: "Replace Wallet" }));

    expect(onImportSeed).toHaveBeenCalledWith(validSeedPhrase.split(" "));
  });

  it("keeps an empty or incomplete phrase from being imported", async () => {
    renderWalletSetupModal();

    await userEvent.click(screen.getByRole("button", { name: /import existing wallet/i }));
    const textarea = screen.getByLabelText("Seed word 1");
    const restoreButton = screen.getByRole("button", { name: /restore wallet/i });

    expect(restoreButton).toBeDisabled();

    fireEvent.change(textarea, { target: { value: "abandon ability able about" } });

    expect(screen.getByText(/enter all 12 or 24 seed words/i)).toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea).toHaveClass("border-rose-500");
    expect(restoreButton).toBeDisabled();
  });

  it("rejects a valid-word phrase with an invalid checksum", async () => {
    renderWalletSetupModal();

    await userEvent.click(screen.getByRole("button", { name: /import existing wallet/i }));
    const textarea = screen.getByLabelText("Seed word 1");
    const restoreButton = screen.getByRole("button", { name: /restore wallet/i });

    fireEvent.change(textarea, {
      target: { value: "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo abandon" },
    });

    expect(screen.getByText(/this seedphrase is not valid/i)).toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(restoreButton).toBeDisabled();
  });

  it("accepts a valid 24-word phrase", async () => {
    renderWalletSetupModal();

    await userEvent.click(screen.getByRole("button", { name: /import existing wallet/i }));
    const textarea = screen.getByLabelText("Seed word 1");
    const restoreButton = screen.getByRole("button", { name: /restore wallet/i });
    const valid24SeedPhrase = [...Array(23).fill("abandon"), "art"].join(" ");

    fireEvent.paste(textarea, { clipboardData: { getData: () => valid24SeedPhrase } });

    expect(screen.getAllByRole("textbox")).toHaveLength(24);
    expect(restoreButton).toBeEnabled();
  });

  it("disables seedphrase import and shows the invalid BIP-39 word", async () => {
    renderWalletSetupModal();

    await userEvent.click(screen.getByRole("button", { name: /import existing wallet/i }));
    const textarea = screen.getByLabelText("Seed word 1");
    const restoreButton = screen.getByRole("button", { name: /restore wallet/i });

    fireEvent.change(textarea, {
      target: {
        value:
          "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzzzzz",
      },
    });

    expect(screen.getByText(/invalid word: zzzzzzz/i)).toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea).toHaveClass("border-rose-500");
    expect(restoreButton).toBeDisabled();
  });

  it("enables seedphrase import for valid BIP-39 words and submits normalized words", async () => {
    const { onImportSeed } = renderWalletSetupModal();

    await userEvent.click(screen.getByRole("button", { name: /import existing wallet/i }));
    const textarea = screen.getByLabelText("Seed word 1");
    const restoreButton = screen.getByRole("button", { name: /restore wallet/i });

    fireEvent.paste(textarea, {
      clipboardData: { getData: () => `  ${validSeedPhrase.toUpperCase()}  ` },
    });

    expect(screen.queryByText(/enter all 12 or 24 seed words/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/invalid word:/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/this seedphrase is not valid/i)).not.toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-invalid", "false");
    expect(restoreButton).toBeEnabled();

    await userEvent.click(restoreButton);

    expect(onImportSeed).toHaveBeenCalledWith(validSeedPhrase.split(" "));
  });

  it("supports individual words, mode selection and keyboard navigation", async () => {
    renderWalletSetupModal();
    await userEvent.click(screen.getByRole("button", { name: /import existing wallet/i }));
    const first = screen.getByLabelText("Seed word 1");
    await userEvent.type(first, "abandon ");
    expect(screen.getByLabelText("Seed word 2")).toHaveFocus();
    await userEvent.selectOptions(screen.getByRole("combobox"), "24");
    expect(screen.getAllByRole("textbox")).toHaveLength(24);
    expect(first).toHaveValue("abandon");
    expect(screen.getByRole("button", { name: /restore wallet/i })).toBeDisabled();
  });

  it("rejects oversized paste without importing a truncated phrase", async () => {
    renderWalletSetupModal();
    await userEvent.click(screen.getByRole("button", { name: /import existing wallet/i }));
    const first = screen.getByLabelText("Seed word 1");
    fireEvent.paste(first, { clipboardData: { getData: () => validSeedPhrase } });
    fireEvent.paste(first, { clipboardData: { getData: () => validSeedPhrase + " abandon" } });
    expect(screen.getByRole("alert")).toHaveTextContent("12 or 24");
    expect(screen.getByRole("button", { name: /restore wallet/i })).toBeDisabled();
  });

  it("locks replacement fields and dismissal while import is pending", () => {
    const onClose = vi.fn();
    render(
      <WalletSetupModal
        mode="replace"
        isCreating
        onClose={onClose}
        onCreateNew={vi.fn()}
        onImportSeed={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Seed word 1")).toBeDisabled();
    expect(screen.getByRole("combobox")).toBeDisabled();
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps the existing native cancel path available while creation is busy", () => {
    const onClose = vi.fn();
    render(
      <WalletSetupModal
        isCreating
        onClose={onClose}
        onCreateNew={vi.fn()}
        onImportSeed={vi.fn()}
      />,
    );

    fireEvent(
      screen.getByRole("dialog", { name: "Wallet Setup" }),
      new Event("cancel", { cancelable: true }),
    );

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses only when its layout backdrop is clicked", () => {
    const onClose = vi.fn();
    render(<WalletSetupModal onClose={onClose} onCreateNew={vi.fn()} onImportSeed={vi.fn()} />);

    fireEvent.click(screen.getByRole("heading", { name: "Wallet Setup" }));

    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("wallet-setup-dialog-backdrop"));

    expect(onClose).toHaveBeenCalledOnce();
  });
});
