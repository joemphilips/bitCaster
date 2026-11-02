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

  it("surfaces error on failed add and stays expanded so the user can retry", async () => {
    const user = userEvent.setup();
    const onAddMint = vi.fn().mockRejectedValue(new Error("Failed to connect"));
    render(<AddMintForm onAddMint={onAddMint} />);

    await user.click(screen.getByTestId("add-mint-trigger"));
    await user.type(screen.getByTestId("add-mint-url-input"), "https://broken.example.com");
    await user.click(screen.getByTestId("add-mint-submit"));

    expect(await screen.findByTestId("add-mint-error")).toHaveTextContent("Failed to connect");
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
