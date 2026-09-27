import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PLChart } from "../PLChart";
import type { PLChartData } from "@/types/portfolio";

const chartData: PLChartData = {
  "1D": [{ timestamp: "2026-01-01T00:00:00Z", cumulativePL: 1_000 }],
  "1W": [],
  "1M": [],
  ALL: [{ timestamp: "2026-01-01T00:00:00Z", cumulativePL: 1_000 }],
};

describe("PLChart", () => {
  it("suppresses value changes and the chart while valuation is unknown", () => {
    render(
      <PLChart
        chartData={chartData}
        selectedTimeRange="ALL"
        totalValueSats={0}
        totalValueKnown={false}
      />,
    );

    expect(screen.queryByText(/estimated portfolio value change/i)).not.toBeInTheDocument();
    expect(document.querySelector("svg")).not.toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });

  it("labels monitoring deltas as estimated portfolio-value changes that include cash flows", () => {
    render(
      <PLChart
        chartData={{
          "1D": [
            { timestamp: "2026-01-01T00:00:00Z", cumulativePL: 1_000 },
            { timestamp: "2026-01-02T00:00:00Z", cumulativePL: 1_500 },
          ],
          "1W": [],
          "1M": [],
          ALL: [],
        }}
        selectedTimeRange="1D"
        totalValueSats={1_500}
        totalValueKnown
      />,
    );

    expect(
      screen.getByText(
        "Estimated portfolio value change. Cash flows are included. This is not investment return.",
      ),
    ).toBeInTheDocument();
    expect(document.querySelector("svg")).toBeInTheDocument();
  });
});
