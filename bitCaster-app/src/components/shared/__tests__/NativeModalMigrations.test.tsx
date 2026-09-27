import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { BackupSecretsReminderModal } from "../BackupSecretsReminderModal";
import { NostrAccountChooserModal } from "../NostrAccountChooserModal";
import { NostrAuthRequiredModal } from "../NostrAuthRequiredModal";

describe("migrated shared native modals", () => {
  it("routes native cancel to the Nostr authentication owner", () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <NostrAuthRequiredModal onClose={onClose} />
      </MemoryRouter>,
    );

    fireEvent(
      screen.getByRole("dialog", { name: "Authentication required" }),
      new Event("cancel", { cancelable: true }),
    );

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses Nostr authentication only when its layout backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <NostrAuthRequiredModal onClose={onClose} />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("heading", { name: "Authentication required" }));

    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("nostr-auth-required-dialog-backdrop"));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("keeps the Nostr chooser dismissible while account creation is busy", () => {
    const onClose = vi.fn();
    render(
      <NostrAccountChooserModal
        isCreating
        onClose={onClose}
        onUseExisting={vi.fn()}
        onCreateImplicit={vi.fn()}
      />,
    );

    fireEvent(
      screen.getByRole("dialog", { name: "Do you have a Nostr account?" }),
      new Event("cancel", { cancelable: true }),
    );

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses the Nostr chooser only when its layout backdrop is clicked", () => {
    const onClose = vi.fn();
    render(
      <NostrAccountChooserModal
        isCreating
        onClose={onClose}
        onUseExisting={vi.fn()}
        onCreateImplicit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("heading", { name: "Do you have a Nostr account?" }));

    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("nostr-account-chooser-dialog-backdrop"));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("routes native cancel to the Nostr backup reminder owner", () => {
    const onDismiss = vi.fn();
    render(<BackupSecretsReminderModal onDismiss={onDismiss} onOpenSettings={vi.fn()} />);

    fireEvent(
      screen.getByRole("dialog", { name: "Back up your Nostr key" }),
      new Event("cancel", { cancelable: true }),
    );

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("dismisses the Nostr backup reminder only when its layout backdrop is clicked", () => {
    const onDismiss = vi.fn();
    render(<BackupSecretsReminderModal onDismiss={onDismiss} onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole("heading", { name: "Back up your Nostr key" }));

    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("backup-secrets-reminder-dialog-backdrop"));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
