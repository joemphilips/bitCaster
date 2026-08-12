import type { operations } from "@/generated/api";

type HasCursor<T> = "cursor" extends keyof T ? true : false;
type AssetQuery = operations["getAssetMonitoringAssets"]["parameters"]["query"];
type PortfolioQuery = operations["getPortfolio"]["parameters"]["query"];

const assetCursorSupported: HasCursor<AssetQuery> = true;
const portfolioCursorSupported: HasCursor<PortfolioQuery> = false;

describe("portfolio pagination contract", () => {
  it("continues asset pages through the asset-monitoring endpoint", () => {
    expect(assetCursorSupported).toBe(true);
    expect(portfolioCursorSupported).toBe(false);
  });
});
