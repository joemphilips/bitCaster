import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ResolutionInfo } from "../ResolutionInfo";
import type { ResolutionDetails } from "@/types/market-detail";

describe("ResolutionInfo", () => {
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
});
