import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import { BrowserProfileError, type BrowserProfileSaveResult } from "@/lib/browserNostrProfile";
import { NostrMediaUploadError } from "@bitcaster/client-sdk/nostrMediaUpload";
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
    expect(screen.getByTestId("nostr-profile-result")).not.toHaveTextContent("Accepted:");
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

function imageReceipt() {
  const controller = new AbortController();
  return {
    url: "https://blossom.nostr.build/image.png",
    sha256: "a".repeat(64),
    size: 3,
    type: "image/png" as const,
    uploaded: 1,
    publicKeyHex: event.pubkey,
    signal: controller.signal,
    requireCurrent: vi.fn(),
    dispose: vi.fn(),
    controller,
  };
}
const avatar = new File(["synthetic fixture"], "avatar.png", { type: "image/png" });

describe("profile image interaction", () => {
  async function imageEditor(
    upload = vi.fn().mockResolvedValue(imageReceipt()),
    save = vi.fn().mockResolvedValue(saved),
  ) {
    const rendered = render(
      <NostrProfileEditor load={vi.fn().mockResolvedValue(baseline)} save={save} upload={upload} />,
    );
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Canonical"));
    return { ...rendered, upload, save };
  }
  function drop() {
    fireEvent.drop(screen.getByTestId("profile-image-drop"), { dataTransfer: { files: [avatar] } });
  }
  it("routes picker and drop through one uploader and previews only its public URL", async () => {
    const f = await imageEditor();
    fireEvent.change(screen.getByLabelText("Choose image"), { target: { files: [avatar] } });
    await waitFor(() =>
      expect(screen.getByLabelText("Picture URL")).toHaveValue(
        "https://blossom.nostr.build/image.png",
      ),
    );
    expect(screen.getByAltText("Profile image preview")).toHaveAttribute(
      "src",
      "https://blossom.nostr.build/image.png",
    );
    drop();
    await waitFor(() => expect(f.upload).toHaveBeenCalledTimes(2));
  });
  it("retains uploaded receipt for publication retry without uploading twice", async () => {
    const receipt = imageReceipt();
    const save = vi
      .fn()
      .mockRejectedValueOnce(new BrowserProfileError("read-failed"))
      .mockResolvedValue(saved);
    const f = await imageEditor(vi.fn().mockResolvedValue(receipt), save);
    drop();
    await waitFor(() => expect(screen.getByLabelText("Picture URL")).toHaveValue(receipt.url));
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByRole("alert");
    expect(screen.getByLabelText("Picture URL")).toHaveValue(receipt.url);
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile saved.");
    expect(f.upload).toHaveBeenCalledOnce();
    expect(save.mock.calls[0]?.[0]).toEqual({ picture: receipt.url });
  });
  it("does not publish an uploaded image after the signer changes", async () => {
    const receipt = imageReceipt();
    const f = await imageEditor(vi.fn().mockResolvedValue(receipt));
    drop();
    await waitFor(() => expect(screen.getByLabelText("Picture URL")).toHaveValue(receipt.url));
    receipt.requireCurrent.mockImplementation(() => {
      throw new BrowserProfileError("selection-changed");
    });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByRole("alert");
    expect(f.save).not.toHaveBeenCalled();
  });
  it("cancels a pending upload, ignores its late receipt, and prevents a second active upload", async () => {
    let resolve!: (receipt: ReturnType<typeof imageReceipt>) => void;
    const f = await imageEditor(
      vi.fn().mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      ),
    );
    drop();
    drop();
    expect(f.upload).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(f.upload.mock.calls[0]?.[1].aborted).toBe(true);
    const receipt = imageReceipt();
    await act(async () => {
      resolve(receipt);
    });
    expect(receipt.dispose).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Picture URL")).toHaveValue("");
    expect(f.save).not.toHaveBeenCalled();
  });
  it("keeps the prior picture after an upload failure and permits explicit retry", async () => {
    const receipt = imageReceipt();
    const f = await imageEditor(
      vi
        .fn()
        .mockRejectedValueOnce(new NostrMediaUploadError("rate-limited"))
        .mockResolvedValue(receipt),
    );
    fireEvent.change(screen.getByLabelText("Picture URL"), {
      target: { value: "https://example.com/old.png" },
    });
    drop();
    expect(await screen.findByRole("alert")).toHaveTextContent("Wait before trying again");
    expect(screen.getByLabelText("Picture URL")).toHaveValue("https://example.com/old.png");
    drop();
    await waitFor(() => expect(screen.getByLabelText("Picture URL")).toHaveValue(receipt.url));
    expect(f.upload).toHaveBeenCalledTimes(2);
  });

  it("disposes the retained signer subscription when the editor unmounts", async () => {
    const receipt = imageReceipt();
    const f = await imageEditor(vi.fn().mockResolvedValue(receipt));
    drop();
    await waitFor(() => expect(screen.getByLabelText("Picture URL")).toHaveValue(receipt.url));
    f.unmount();
    expect(receipt.dispose).toHaveBeenCalledOnce();
  });

  it("releases an uploaded receipt when the user replaces its URL", async () => {
    const receipt = imageReceipt();
    await imageEditor(vi.fn().mockResolvedValue(receipt));
    drop();
    await waitFor(() => expect(screen.getByLabelText("Picture URL")).toHaveValue(receipt.url));
    fireEvent.change(screen.getByLabelText("Picture URL"), {
      target: { value: "https://example.com/new.png" },
    });
    expect(receipt.dispose).toHaveBeenCalledOnce();
  });
});
