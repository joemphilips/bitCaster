import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const { readExplanation } = vi.hoisted(() => ({ readExplanation: vi.fn() }));
vi.mock("@/lib/oracleAttestation", () => ({
  readBrowserResolutionExplanation: (...args: unknown[]) => readExplanation(...args),
}));
import { ResolutionInfo } from "../ResolutionInfo";
import type { ResolutionDetails } from "@/types/market-detail";

describe("ResolutionInfo", () => {
  beforeEach(() => {
    readExplanation.mockReset();
  });
  it("loads the verified companion after paint and renders HTML-looking content as plain text", async () => {
    readExplanation.mockResolvedValueOnce("<b>Official result</b>\nSecond line");
    const { container } = render(
      <ResolutionInfo
        resolution={{
          conditionId: "condition",
          criteria: "Rule",
          source: "oracle",
          resolutionDate: null,
          finalOutcome: "YES",
        }}
      />,
    );
    expect(screen.getByText("Final Outcome")).toBeVisible();
    expect(await screen.findByText(/<b>Official result<\/b>/)).toBeVisible();
    // Oracle text keeps normal line breaking in Japanese.
    expect(screen.getByText(/<b>Official result<\/b>/)).toHaveAttribute("data-user-content");
    expect(screen.getByText("Rule").closest("[data-user-content]")).toBe(
      screen.getByTestId("market-markdown"),
    );
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("region", { name: "Verified oracle explanation" })).toBeVisible();
  });
  it("reads the companion once more after a failed read", async () => {
    readExplanation
      .mockRejectedValueOnce(new Error("relay silent"))
      .mockResolvedValueOnce("Official result");
    render(
      <ResolutionInfo
        resolution={{
          conditionId: "retried",
          criteria: "Rule",
          source: "oracle",
          resolutionDate: null,
          finalOutcome: "YES",
        }}
      />,
    );
    expect(await screen.findByText("Official result")).toBeVisible();
    expect(readExplanation).toHaveBeenCalledTimes(2);
    expect(
      screen.queryByText(
        "The optional explanation is unavailable. Verified resolution is unchanged.",
      ),
    ).not.toBeInTheDocument();
  });
  it("keeps optional explanation failure separate from verified resolution", async () => {
    readExplanation.mockRejectedValue(new Error("relay unavailable"));
    render(
      <ResolutionInfo
        resolution={{
          conditionId: "other",
          criteria: "Rule",
          source: "oracle",
          resolutionDate: null,
          finalOutcome: "NO",
        }}
      />,
    );
    expect(
      await screen.findByText(
        "The optional explanation is unavailable. Verified resolution is unchanged.",
      ),
    ).toBeVisible();
    expect(screen.getByText("NO")).toBeVisible();
    expect(readExplanation).toHaveBeenCalledTimes(2);
  });
  it.each([{ finalOutcome: undefined }, { finalOutcome: "Yes" }])(
    "keeps resolution details with outcome $finalOutcome visible without a missing date",
    ({ finalOutcome }) => {
      const resolution: ResolutionDetails = {
        criteria: "Use the official final result.",
        source: "oracle",
        resolutionDate: null,
        finalOutcome,
      };

      render(<ResolutionInfo resolution={resolution} />);

      expect(screen.getByText("Resolution Criteria")).toBeInTheDocument();
      expect(screen.getByText("Use the official final result.")).toBeInTheDocument();
      if (finalOutcome) {
        expect(screen.getByText("Final Outcome")).toBeInTheDocument();
        expect(screen.getByText(finalOutcome)).toBeInTheDocument();
      } else {
        expect(screen.queryByText("Final Outcome")).not.toBeInTheDocument();
      }
      expect(screen.queryByText("Resolution Date")).not.toBeInTheDocument();
      expect(screen.queryByText(/January 1, 1970/)).not.toBeInTheDocument();
    },
  );

  it("uses the exact categorical winner color as a swatch, not label text", () => {
    render(
      <ResolutionInfo
        resolution={{
          criteria: "Use the official final result.",
          source: "oracle",
          resolutionDate: null,
          finalOutcome: "Alpha",
        }}
        outcomes={[
          { id: "alpha", label: "Alpha", odds: null, color: "#BADA55" },
          { id: "beta", label: "Beta", odds: null, color: "#112233" },
        ]}
      />,
    );

    const finalOutcome = screen.getByText("Alpha");
    expect(finalOutcome).toHaveClass("text-slate-900");
    expect(
      finalOutcome.parentElement?.querySelector('[data-testid="outcome-color-swatch"]'),
    ).toHaveStyle({
      backgroundColor: "#BADA55",
    });
  });

  it("renders the resolution criteria as safe Markdown", () => {
    render(
      <ResolutionInfo
        resolution={{
          criteria:
            "Resolves **Yes** per [the source](https://example.com).\n\n<img src=x onerror=alert(1)>",
          source: "oracle",
          resolutionDate: null,
        }}
      />,
    );

    const criteria = screen.getByTestId("market-markdown");
    expect(criteria.querySelector("strong")).toHaveTextContent("Yes");
    expect(criteria.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "the source" })).toHaveAttribute(
      "rel",
      "noopener noreferrer nofollow ugc",
    );
    expect(readExplanation).not.toHaveBeenCalled();
  });
});
