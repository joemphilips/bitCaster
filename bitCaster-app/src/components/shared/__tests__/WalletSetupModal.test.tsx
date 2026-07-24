import { render, screen } from "@testing-library/react";
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
  it("disables seedphrase import and shows a word-count error until the phrase has 12 or 24 words", async () => {
    renderWalletSetupModal();

    await userEvent.click(screen.getByRole("button", { name: /import existing wallet/i }));
    const textarea = screen.getByLabelText(/enter your seedphrase/i);
    const restoreButton = screen.getByRole("button", { name: /restore wallet/i });

    await userEvent.type(textarea, "abandon ability able about");

    expect(screen.getByText(/seedphrase must be 12 or 24 words/i)).toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea).toHaveClass("border-rose-500");
    expect(restoreButton).toBeDisabled();
  });

  it("disables seedphrase import and shows the invalid BIP-39 word", async () => {
    renderWalletSetupModal();

    await userEvent.click(screen.getByRole("button", { name: /import existing wallet/i }));
    const textarea = screen.getByLabelText(/enter your seedphrase/i);
    const restoreButton = screen.getByRole("button", { name: /restore wallet/i });

    await userEvent.type(
      textarea,
      "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzzzzz",
    );

    expect(screen.getByText(/invalid word: zzzzzzz/i)).toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-invalid", "true");
    expect(textarea).toHaveClass("border-rose-500");
    expect(restoreButton).toBeDisabled();
  });

  it("enables seedphrase import for valid BIP-39 words and submits normalized words", async () => {
    const { onImportSeed } = renderWalletSetupModal();

    await userEvent.click(screen.getByRole("button", { name: /import existing wallet/i }));
    const textarea = screen.getByLabelText(/enter your seedphrase/i);
    const restoreButton = screen.getByRole("button", { name: /restore wallet/i });

    await userEvent.type(textarea, `  ${validSeedPhrase.toUpperCase()}  `);

    expect(screen.queryByText(/seedphrase must be 12 or 24 words/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/invalid word:/i)).not.toBeInTheDocument();
    expect(textarea).toHaveAttribute("aria-invalid", "false");
    expect(restoreButton).toBeEnabled();

    await userEvent.click(restoreButton);

    expect(onImportSeed).toHaveBeenCalledWith(validSeedPhrase.split(" "));
  });
});
