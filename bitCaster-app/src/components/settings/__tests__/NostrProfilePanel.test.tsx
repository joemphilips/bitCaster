import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { NostrProfilePanel } from "../NostrProfilePanel";
import type { BrowserProfileSaveResult } from "@/lib/browserNostrProfile";

const profile = {
  pubkey: "a".repeat(64),
  displayName: "Aki Nakamura",
  avatar: "https://example.test/aki.png",
  bio: "Bitcoin researcher.\nIndependent forecasts.",
  nip05: "",
  nip05verified: false,
};
const baseline = {
  publicKey: profile.pubkey,
  fields: { name: "Aki Nakamura", picture: profile.avatar, about: profile.bio },
};
const saved: BrowserProfileSaveResult = {
  publicKey: profile.pubkey,
  event: finalizeEvent(
    { kind: 0, created_at: 1, tags: [], content: "{}" },
    new Uint8Array(32).fill(1),
  ),
  status: "saved",
  published: true,
  retained: true,
  acceptedRelays: ["wss://example.test"],
  rejectedRelays: [],
  unacknowledgedRelays: [],
  unsentRelays: [],
};

function panel(
  save = vi.fn().mockResolvedValue(saved),
  load = vi.fn().mockResolvedValue(baseline),
) {
  render(
    <NostrProfilePanel
      profile={profile}
      status="found"
      retry={vi.fn()}
      retrying={false}
      load={load}
      save={save}
    />,
  );
  return { load, save };
}
async function edit() {
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  // Wait for the real deferred module, not a machine-dependent cold transform deadline.
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Aki Nakamura"));
}

describe("public profile card and editor", () => {
  it("shows the shared identity card before fetching editable metadata", async () => {
    const { load } = panel();
    expect(screen.getByTestId("identity-profile")).toHaveTextContent("Aki Nakamura");
    expect(screen.getByTestId("identity-profile")).toHaveTextContent("Independent forecasts.");
    expect(screen.getByRole("img", { name: "Aki Nakamura" })).toHaveAttribute(
      "src",
      profile.avatar,
    );
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("button", { name: /upload avatar/i })).toBeNull();
    expect(load).not.toHaveBeenCalled();
    await edit();
    expect(load).toHaveBeenCalledOnce();
  });

  it("discards an idle draft on Cancel and opens fresh metadata next time", async () => {
    const { save } = panel();
    await edit();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Discard this" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(save).not.toHaveBeenCalled();
    await edit();
    expect(screen.getByLabelText("Name")).toHaveValue("Aki Nakamura");
  });

  it("closes a pending metadata read with one Cancel and ignores its late result", async () => {
    let finish!: (value: typeof baseline) => void;
    const load = vi.fn(
      () =>
        new Promise<typeof baseline>((resolve) => {
          finish = resolve;
        }),
    );
    panel(undefined, load);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await screen.findByTestId("nostr-profile-editor");
    fireEvent.click(screen.getByTestId("nostr-profile-cancel"));
    expect(screen.queryByTestId("nostr-profile-editor")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
    await act(async () => finish(baseline));
    expect(screen.queryByTestId("nostr-profile-editor")).toBeNull();
  });

  it("returns to the card after Save and retains the publication result", async () => {
    const { save } = panel();
    await edit();
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Updated research" },
    });
    fireEvent.click(screen.getByTestId("nostr-profile-save"));
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
    expect(save.mock.calls[0]?.[0]).toEqual({ about: "Updated research" });
    expect(screen.getByTestId("nostr-profile-result")).toHaveTextContent("Profile saved");
    expect(screen.getByRole("button", { name: "Edit" })).toBeVisible();
  });

  it("keeps an accepted-but-cancelled result and its draft visible", async () => {
    let finish!: (result: BrowserProfileSaveResult) => void;
    const save = vi.fn(
      (_patch, _signal) =>
        new Promise<BrowserProfileSaveResult>((resolve) => {
          finish = resolve;
        }),
    );
    panel(save);
    await edit();
    fireEvent.change(screen.getByLabelText("Description"), {
      target: { value: "Pending publication" },
    });
    fireEvent.click(screen.getByTestId("nostr-profile-save"));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(save.mock.calls[0]?.[1].aborted).toBe(true);
    await act(async () => finish({ ...saved, status: "cancelled" }));
    expect(screen.getByLabelText("Description")).toHaveValue("Pending publication");
    expect(screen.getByRole("alert")).toHaveTextContent("cancelled after publication");
  });

  it.each(["fetching", "not-found", "unavailable"] as const)(
    "distinguishes a %s profile read",
    (status) => {
      render(<NostrProfilePanel profile={null} status={status} retry={vi.fn()} retrying={false} />);
      const messages = {
        fetching: "Fetching profile",
        "not-found": "No public profile was found",
        unavailable: "could not be refreshed",
      };
      expect(screen.getByText(new RegExp(messages[status]))).toBeVisible();
    },
  );
});
