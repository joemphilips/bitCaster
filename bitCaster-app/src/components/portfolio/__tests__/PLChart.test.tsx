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
  it("suppresses P/L amounts and the chart while valuation is unknown", () => {
    render(
      <PLChart
        chartData={chartData}
        selectedTimeRange="ALL"
        totalValueSats={0}
        totalValueKnown={false}
      />,
    );

    expect(screen.queryByText(/this period/i)).not.toBeInTheDocument();
    expect(document.querySelector("svg")).not.toBeInTheDocument();
    expect(screen.getAllByText("—")).toHaveLength(2);
  });
});
