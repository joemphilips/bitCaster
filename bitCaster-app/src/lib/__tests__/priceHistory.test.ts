import { describe, expect, it } from "vitest";
import { latestPricePointsPerSecond } from "../priceHistory";

describe("confirmed price history ordering", () => {
  const older = { eventOrder: "001", timestamp: "2026-09-27T00:00:00.900Z", price: 40 };
  const newer = { eventOrder: "002", timestamp: "2026-09-27T00:00:00.100Z", price: 55 };

  it.each([
    ["REST then live", [older, newer]],
    ["live then REST", [newer, older]],
    ["duplicate live delivery", [newer, older, newer]],
  ])("keeps the canonical newest event for one plotted second: %s", (_, points) => {
    expect(latestPricePointsPerSecond(points)).toEqual([newer]);
  });

  it("keeps different plotted seconds in time order", () => {
    const later = { eventOrder: "003", timestamp: "2026-09-27T00:00:01Z", price: 60 };
    expect(latestPricePointsPerSecond([later, newer, older])).toEqual([newer, later]);
  });
});
