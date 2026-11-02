import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { AddMintForm } from "../AddMintForm";

describe("AddMintForm", () => {
  it("starts collapsed and expands the input row when the trigger is clicked", async () => {
    const user = userEvent.setup();
    render(<AddMintForm onAddMint={vi.fn().mockResolvedValue(undefined)} />);

    expect(screen.queryByTestId("add-mint-url-input")).not.toBeInTheDocument();
    await user.click(screen.getByTestId("add-mint-trigger"));
    expect(screen.getByTestId("add-mint-url-input")).toBeInTheDocument();
  });

  it("invokes onAddMint with the entered URL and collapses on success", async () => {
    const user = userEvent.setup();
    const onAddMint = vi.fn().mockResolvedValue(undefined);
    render(<AddMintForm onAddMint={onAddMint} />);

    await user.click(screen.getByTestId("add-mint-trigger"));
    await user.type(screen.getByTestId("add-mint-url-input"), "https://mint.example.com");
    await user.click(screen.getByTestId("add-mint-submit"));

    expect(onAddMint).toHaveBeenCalledWith("https://mint.example.com");
    expect(screen.queryByTestId("add-mint-url-input")).not.toBeInTheDocument();
  });

  it("shows a localized connection error, not the raw error text, and stays expanded", async () => {
    const user = userEvent.setup();
    const onAddMint = vi
      .fn()
      .mockRejectedValue(new Error("Failed to connect — mint is unreachable or invalid"));
    render(<AddMintForm onAddMint={onAddMint} />);

    await user.click(screen.getByTestId("add-mint-trigger"));
    await user.type(screen.getByTestId("add-mint-url-input"), "https://broken.example.com");
    await user.click(screen.getByTestId("add-mint-submit"));

    const error = await screen.findByTestId("add-mint-error");
    expect(error).toHaveTextContent(/^Could not connect to the mint\.$/);
    expect(error).not.toHaveTextContent(/unreachable/);
    expect(screen.getByTestId("add-mint-url-input")).toBeInTheDocument();
  });

  it("labels the form in Japanese and names a failure without a message", async () => {
    await i18n.changeLanguage("ja");
    try {
      const user = userEvent.setup();
      render(<AddMintForm onAddMint={vi.fn().mockRejectedValue(new Error(""))} />);

      await user.click(screen.getByRole("button", { name: "ミントを追加" }));
      await user.type(screen.getByTestId("add-mint-url-input"), "https://broken.example.com");
      expect(screen.getByRole("button", { name: "キャンセル" })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "追加" }));

      expect(await screen.findByTestId("add-mint-error")).toHaveTextContent(
        "ミントに接続できませんでした。",
      );
    } finally {
      await i18n.changeLanguage("en");
    }
  });

  it("puts the actions below the URL field when the row is narrow", async () => {
    const user = userEvent.setup();
    render(<AddMintForm onAddMint={vi.fn()} />);
    await user.click(screen.getByTestId("add-mint-trigger"));

    const input = screen.getByTestId("add-mint-url-input");
    // jsdom has no layout. The row wraps, and the field fills a narrow row.
    expect(input.parentElement).toHaveClass("flex-wrap");
    expect(input).toHaveClass("basis-full", "min-w-0", "sm:basis-0");
    for (const name of ["Add", "Cancel"])
      expect(screen.getByRole("button", { name })).toHaveClass("shrink-0");
  });

  it("ignores empty submissions", async () => {
    const user = userEvent.setup();
    const onAddMint = vi.fn().mockResolvedValue(undefined);
    render(<AddMintForm onAddMint={onAddMint} />);

    await user.click(screen.getByTestId("add-mint-trigger"));
    await user.click(screen.getByTestId("add-mint-submit"));

    expect(onAddMint).not.toHaveBeenCalled();
  });

  it("respects the sheet variant for visual differentiation in bottom sheets", () => {
    render(<AddMintForm onAddMint={vi.fn()} variant="sheet" />);
    const trigger = screen.getByTestId("add-mint-trigger");
    expect(trigger.className).toContain("border-dashed");
  });
});
