import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { CommentSection } from "../CommentSection";
import { ToastContainer } from "@/components/ui/Toast";
import { useToastStore } from "@/stores/toast";
import type { Comment } from "@/types/market-detail";

const fetchProfile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/nostr", () => ({ fetchPublicNostrProfile: fetchProfile }));
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchProfile.mockReset();
  useToastStore.setState({ toasts: [] });
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else delete (navigator as { clipboard?: unknown }).clipboard;
});

// NIP-19 specification example: this hex public key encodes to this npub.
const authorHex = "3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d";
const authorNpub = "npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6";

function authorComment(userId: string, userDisplayName = "Trader"): Comment {
  return {
    id: "author-comment",
    userId,
    userDisplayName,
    timestamp: "2026-05-25T10:00:00Z",
    content: "Author comment",
    trade: null,
    likeCount: 0,
    isLiked: false,
  };
}

function renderComments(element: ReactElement, language = "en") {
  return render(
    <I18nextProvider i18n={language === "en" ? i18n : i18n.cloneInstance({ lng: language })}>
      <MemoryRouter>
        {element}
        <ToastContainer />
      </MemoryRouter>
    </I18nextProvider>,
  );
}

function stubClipboard(writeText: ((text: string) => Promise<void>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

describe("CommentSection", () => {
  it("states that comments are unavailable instead of showing an empty list", () => {
    renderComments(<CommentSection comments={[]} unavailable />);

    expect(screen.getByText("Comments are not available now.")).toBeVisible();
    expect(screen.queryByText(/No comments yet/)).not.toBeInTheDocument();
    expect(screen.queryByText("(0)")).not.toBeInTheDocument();
  });

  it("keeps loaded comments when a later read is unavailable", () => {
    const comment: Comment = {
      id: "kept-comment",
      userId: "public-author",
      userDisplayName: "Trader",
      timestamp: "2026-05-25T10:00:00.000Z",
      content: "A loaded comment",
      trade: null,
      likeCount: 0,
      isLiked: false,
    };
    renderComments(<CommentSection comments={[comment]} unavailable />);

    expect(screen.getByText("A loaded comment")).toBeVisible();
    expect(screen.getByText("(1)")).toBeVisible();
    expect(screen.queryByText("Comments are not available now.")).not.toBeInTheDocument();
  });

  it("shows a comment with its author and text without an inert like control or count", () => {
    const comment: Comment = {
      id: "confirmed-comment",
      userId: "public-author",
      userDisplayName: "Trader",
      timestamp: "2026-05-25T10:00:00.000Z",
      content: "A confirmed comment",
      trade: null,
      likeCount: 937,
      isLiked: true,
    };
    renderComments(<CommentSection comments={[comment]} />);

    expect(screen.getByText("Trader")).toBeVisible();
    expect(screen.getByText("A confirmed comment")).toBeVisible();
    expect(screen.getByText("A confirmed comment")).toHaveAttribute("data-user-content");
    expect(screen.queryByText("937")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

it("resolves only visible authors and renders public names as text", async () => {
  let enter!: IntersectionObserverCallback;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        enter = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  let resolve!: (value: unknown) => void;
  fetchProfile.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  renderComments(
    <CommentSection
      comments={[
        {
          id: "comment",
          userId: "a".repeat(64),
          userDisplayName: "aaaaaaaa…aaaaaaaa",
          timestamp: "2026-05-25T10:00:00Z",
          content: "Body",
          trade: null,
          likeCount: 0,
          isLiked: false,
        },
      ]}
    />,
  );
  expect(screen.getByText("aaaaaaaa…aaaaaaaa")).toBeVisible();
  expect(fetchProfile).not.toHaveBeenCalled();
  act(() =>
    enter([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
  );
  expect(fetchProfile).toHaveBeenCalledExactlyOnceWith("a".repeat(64), expect.any(AbortSignal));
  await act(async () =>
    resolve({
      pubkey: "a".repeat(64),
      displayName: "<script>Alice</script>",
      avatar: "javascript:bad",
    }),
  );
  expect(screen.getByText("<script>Alice</script>")).toBeVisible();
  expect(
    screen.getByRole("button", { name: "Copy <script>Alice</script>'s Nostr ID" }),
  ).toBeVisible();
  expect(document.querySelector("script,img")).toBeNull();
});

it.each([
  ["data:image/gif;base64,R0lGODlhAQABAAAAACw=", true],
  ["https://img.example/alice.png", true],
  ["data:text/html;base64,PHNjcmlwdD4=", false],
  ["https://printer.local/alice.png", false],
])(
  "loads the public comment avatar %s only by the profile picture rule",
  async (avatar, loaded) => {
    let enter!: IntersectionObserverCallback;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          enter = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    fetchProfile.mockResolvedValue({ pubkey: "a".repeat(64), displayName: "Alice", avatar });
    renderComments(
      <CommentSection
        comments={[
          {
            id: "comment",
            userId: "a".repeat(64),
            userDisplayName: "aaaaaaaa…aaaaaaaa",
            timestamp: "2026-05-25T10:00:00Z",
            content: "Body",
            trade: null,
            likeCount: 0,
            isLiked: false,
          },
        ]}
      />,
    );
    await act(async () =>
      enter([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver),
    );
    expect(await screen.findByText("Alice")).toBeVisible();
    if (loaded)
      expect(screen.getByRole("img", { name: "Alice", hidden: true })).toHaveAttribute(
        "src",
        avatar,
      );
    else expect(document.querySelector("img")).toBeNull();
  },
);

it("constrains long names while keeping their accessible text and replaces failed avatars", () => {
  const name = "A".repeat(65536);
  renderComments(
    <CommentSection
      comments={[
        {
          id: "long-author",
          userId: "fallback-author",
          userDisplayName: name,
          userAvatarUrl: "https://example.com/missing.png",
          timestamp: "2026-05-25T10:00:00Z",
          content: "Comment",
          trade: null,
          likeCount: 0,
          isLiked: false,
        },
      ]}
    />,
  );
  const label = screen.getByText(name);
  expect(label).toHaveClass("block", "truncate");
  expect(label).toHaveAttribute("title", name);
  const image = screen.getByRole("img", { name });
  fireEvent.error(image);
  expect(screen.queryByRole("img")).not.toBeInTheDocument();
  expect(screen.getByText("A")).toBeVisible();
});

describe("CommentSection author identity", () => {
  it("links the author's avatar and name to the author's profile page", () => {
    renderComments(
      <CommentSection
        comments={[
          { ...authorComment(authorHex), userAvatarUrl: "https://img.example/trader.png" },
        ]}
      />,
    );

    const nameLink = screen.getByRole("link", { name: "Trader" });
    expect(nameLink).toHaveAttribute("href", `/user/${authorNpub}`);
    expect(nameLink).not.toContainElement(
      screen.getByRole("button", { name: "Copy Trader's Nostr ID" }),
    );
    // The avatar repeats the name link for pointer users only.
    const avatar = screen.getByRole("img", { name: "Trader", hidden: true });
    const avatarLink = avatar.closest("a");
    expect(avatarLink).toHaveAttribute("href", `/user/${authorNpub}`);
    expect(avatarLink).toHaveAttribute("tabindex", "-1");
    expect(avatarLink).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByRole("link")).toEqual([nameLink]);
  });

  it("links the letter avatar when the author has no picture", () => {
    renderComments(<CommentSection comments={[authorComment(authorHex)]} />);

    expect(screen.getByText("T").closest("a")).toHaveAttribute("href", `/user/${authorNpub}`);
  });

  it("copies the author's npub and reports success after the write completes", async () => {
    const user = userEvent.setup();
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const writeText = vi.fn(() => pending);
    stubClipboard(writeText);
    renderComments(<CommentSection comments={[authorComment(authorHex)]} />);

    await user.click(screen.getByRole("button", { name: "Copy Trader's Nostr ID" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(authorNpub);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    await act(async () => {
      complete();
      await pending;
    });
    expect(screen.getByRole("status")).toHaveTextContent("Nostr ID copied.");
  });

  it.each(["rejected", "unavailable"])(
    "reports an author copy failure when the clipboard is %s",
    async (state) => {
      const user = userEvent.setup();
      stubClipboard(
        state === "unavailable" ? undefined : vi.fn().mockRejectedValue(new Error("denied")),
      );
      renderComments(<CommentSection comments={[authorComment(authorHex)]} />);

      await user.click(screen.getByRole("button", { name: "Copy Trader's Nostr ID" }));
      expect(await screen.findByRole("status")).toHaveTextContent("Could not copy the Nostr ID.");
      expect(useToastStore.getState().toasts).toEqual([
        expect.objectContaining({ type: "error", message: "Could not copy the Nostr ID." }),
      ]);
    },
  );

  it("names each author's copy control after the author and keeps the icon and toast", async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    renderComments(
      <CommentSection
        comments={[
          { ...authorComment(authorHex, "Alice"), id: "alice" },
          { ...authorComment("b".repeat(64), "Bob"), id: "bob" },
        ]}
      />,
    );

    const alice = screen.getByRole("button", { name: "Copy Alice's Nostr ID" });
    const bob = screen.getByRole("button", { name: "Copy Bob's Nostr ID" });
    for (const copy of [alice, bob]) {
      expect(copy.textContent).toBe("");
      expect(copy.querySelectorAll("svg")).toHaveLength(1);
    }
    await user.click(bob);
    expect(await screen.findByRole("status")).toHaveTextContent("Nostr ID copied.");
  });

  it("labels the author copy control and its result in Japanese", async () => {
    const user = userEvent.setup();
    stubClipboard(vi.fn().mockResolvedValue(undefined));
    renderComments(<CommentSection comments={[authorComment(authorHex)]} />, "ja");

    await user.click(screen.getByRole("button", { name: "TraderのNostr IDをコピー" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Nostr IDをコピーしました。");
  });

  it.each([
    ["a non-key value", "public-author"],
    ["an uppercase hex key", authorHex.toUpperCase()],
    ["a short hex key", authorHex.slice(1)],
    ["an npub", authorNpub],
  ])("shows no profile link and no copy control for %s", (_, userId) => {
    renderComments(<CommentSection comments={[authorComment(userId)]} />);

    expect(screen.getByText("Trader")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Nostr ID/ })).not.toBeInTheDocument();
  });

  it("truncates a long linked name and keeps the copy control outside the truncation", () => {
    const name = "A".repeat(500);
    renderComments(<CommentSection comments={[authorComment(authorHex, name)]} />);

    const label = screen.getByText(name);
    expect(label).toHaveClass("block", "truncate");
    expect(label).toHaveAttribute("title", name);
    expect(label.closest("a")).toHaveAttribute("href", `/user/${authorNpub}`);
    const copy = screen.getByRole("button", { name: `Copy ${name}'s Nostr ID` });
    expect(copy).toHaveClass("shrink-0");
    expect(label).not.toContainElement(copy);
  });
});
