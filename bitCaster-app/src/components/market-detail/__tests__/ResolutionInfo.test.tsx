import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const { readExplanation } = vi.hoisted(() => ({ readExplanation: vi.fn() }));
vi.mock("@/lib/oracleAttestation", () => ({
  readBrowserResolutionExplanation: (...args: unknown[]) => readExplanation(...args),
}));
import { ResolutionInfo } from "../ResolutionInfo";
import type { ResolutionDetails } from "@/types/market-detail";

describe("ResolutionInfo", () => {
  it("loads the verified companion after paint and renders HTML-looking content as plain text", async () => {
    readExplanation.mockResolvedValueOnce("<b>Official result</b>\nSecond line");
    const { container } = render(
      <ResolutionInfo
        resolution={{
          conditionId: "condition",
          criteria: "Rule",
          source: "oracle",
          resolutionDate: null,
          status: "resolved",
          finalOutcome: "YES",
        }}
      />,
    );
    expect(screen.getByText("Final Outcome")).toBeVisible();
    expect(await screen.findByText(/<b>Official result<\/b>/)).toBeVisible();
    expect(container.querySelector("b")).toBeNull();
    expect(screen.getByRole("region", { name: "Verified oracle explanation" })).toBeVisible();
  });
  it("keeps optional explanation failure separate from verified resolution", async () => {
    readExplanation.mockRejectedValueOnce(new Error("relay unavailable"));
    render(
      <ResolutionInfo
        resolution={{
          conditionId: "other",
          criteria: "Rule",
          source: "oracle",
          resolutionDate: null,
          status: "resolved",
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
  });
  it.each([
    { status: "open" as const, finalOutcome: undefined },
    { status: "resolved" as const, finalOutcome: "Yes" },
  ])(
    "keeps $status resolution details visible without a missing date",
    ({ status, finalOutcome }) => {
      const resolution: ResolutionDetails = {
        criteria: "Use the official final result.",
        source: "oracle",
        resolutionDate: null,
        status,
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
          status: "resolved",
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
});
