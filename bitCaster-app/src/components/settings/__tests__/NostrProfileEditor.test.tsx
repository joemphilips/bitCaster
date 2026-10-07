import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { BrowserProfileError, type BrowserProfileSaveResult } from "@/lib/browserNostrProfile";
import { NostrProfileEditor } from "../NostrProfileEditor";

const event = finalizeEvent(
  { kind: 0, created_at: 20, tags: [], content: '{"name":"Old"}' },
  new Uint8Array(32).fill(1),
);
const baseline = {
  publicKey: event.pubkey,
  fields: { name: "Canonical", about: "Bio", picture: "" },
};
const saved: BrowserProfileSaveResult = {
  publicKey: event.pubkey,
  event,
  status: "saved",
  published: true,
  retained: true,
  acceptedRelays: ["wss://accepted.example"],
  rejectedRelays: ["wss://rejected.example"],
  unacknowledgedRelays: ["wss://uncertain.example"],
  unsentRelays: [],
};

afterEach(() => vi.useRealTimers());

async function editor(
  save = vi.fn().mockResolvedValue(saved),
  load = vi.fn().mockResolvedValue(baseline),
) {
  const rendered = render(<NostrProfileEditor load={load} save={save} />);
  await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Canonical"));
  return { ...rendered, save, load };
}

describe("Nostr profile editor", () => {
  it("loads canonical fields and supplies only changed fields, including explicit empty clears", async () => {
    const f = await editor();
    expect(screen.getByLabelText("Description")).toHaveValue("Bio");
    expect(screen.getByLabelText("Picture URL")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText(/Profile saved/);
    expect(f.save.mock.calls[0]?.[0]).toEqual({ about: "" });
    expect(screen.getByTestId("nostr-profile-result")).toHaveTextContent(
      "Accepted: 1 · Rejected: 1 · No acknowledgment: 1 · Not sent: 0",
    );
    expect(screen.getByRole("button", { name: "Save profile" })).toBeDisabled();
  });

  it.each(["read-failed", "base-unavailable", "signing-failed"] as const)(
    "keeps the draft after %s and keeps the error until explicit dismissal",
    async (code) => {
      await editor(vi.fn().mockRejectedValue(new BrowserProfileError(code)));
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved draft" } });
      fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
      await screen.findByRole("alert");
      expect(screen.getByLabelText("Name")).toHaveValue("Unsaved draft");
      expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled();
      vi.useFakeTimers();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(screen.getByRole("alert")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss profile message" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("reports accepted publication with local retention failure and preserves the draft", async () => {
    await editor(
      vi
        .fn()
        .mockResolvedValue({ ...saved, status: "published-retention-failed", retained: false }),
    );
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Published draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /accepted by a relay.*could not retain/i,
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Published draft");
  });

  it("cancels the current operation with a signal and preserves an already-accepted result truthfully", async () => {
    let finish!: (result: BrowserProfileSaveResult) => void;
    const save = vi.fn(
      (_patch, _signal) =>
        new Promise<BrowserProfileSaveResult>((resolve) => {
          finish = resolve;
        }),
    );
    await editor(save);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(save.mock.calls[0]?.[1].aborted).toBe(true);
    await act(async () => {
      finish({ ...saved, status: "cancelled" });
    });
    expect(screen.getByRole("alert")).toHaveTextContent(/cancelled after publication started/i);
    expect(screen.getByLabelText("Name")).toHaveValue("Draft");
  });

  it("reloads untouched fields without replacing an unsaved dirty field", async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(baseline)
      .mockResolvedValue({
        ...baseline,
        fields: { name: "Relay name", about: "New relay bio", picture: "new.png" },
      });
    await editor(undefined, load);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload metadata" }));
    await waitFor(() => expect(screen.getByLabelText("Description")).toHaveValue("New relay bio"));
    expect(screen.getByLabelText("Name")).toHaveValue("Draft");
    expect(screen.getByLabelText("Picture URL")).toHaveValue("new.png");
  });

  it("ignores completion after unmount and aborts new sends for the old editor", async () => {
    let finish!: (result: BrowserProfileSaveResult) => void;
    const save = vi.fn(
      (_patch, _signal) =>
        new Promise<BrowserProfileSaveResult>((resolve) => {
          finish = resolve;
        }),
    );
    const f = await editor(save);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    f.unmount();
    expect(save.mock.calls[0]?.[1].aborted).toBe(true);
    await act(async () => {
      finish(saved);
    });
    expect(screen.queryByTestId("nostr-profile-result")).not.toBeInTheDocument();
  });
});
