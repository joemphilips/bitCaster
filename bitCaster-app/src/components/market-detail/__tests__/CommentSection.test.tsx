import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import "@/i18n";
import { CommentSection } from "../CommentSection";
import type { Comment } from "@/types/market-detail";

afterEach(cleanup);

describe("CommentSection", () => {
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
