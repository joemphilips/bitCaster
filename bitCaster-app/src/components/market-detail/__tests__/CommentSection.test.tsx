import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@/i18n";
import { CommentSection } from "../CommentSection";
import type { Comment } from "@/types/market-detail";

const fetchProfile = vi.hoisted(() => vi.fn());
vi.mock("@/lib/nostr", () => ({ fetchPublicNostrProfile: fetchProfile }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchProfile.mockReset();
});

describe("CommentSection", () => {
  it("states that comments are unavailable instead of showing an empty list", () => {
    render(<CommentSection comments={[]} unavailable />);

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
    render(<CommentSection comments={[comment]} unavailable />);

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
    render(<CommentSection comments={[comment]} />);

    expect(screen.getByText("Trader")).toBeVisible();
    expect(screen.getByText("A confirmed comment")).toBeVisible();
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
  render(
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
  expect(document.querySelector("script,img")).toBeNull();
});

it("constrains long names while keeping their accessible text and replaces failed avatars", () => {
  const name = "A".repeat(65536);
  render(
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
