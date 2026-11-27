import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserOracleOwner } from "@/stores/creatorMarkets";
import { browserOracleSavedEngineUrl } from "../browserOraclePublicationRetry";

function imported(engineUrl: string): BrowserOracleOwner {
  return {
    kind: "imported",
    oracle: { destinations: { engineUrl, mintUrl: "https://mint.example", relayUrls: [] } },
  } as unknown as BrowserOracleOwner;
}

function created(engineUrl: string | undefined): BrowserOracleOwner {
  return {
    kind: "created",
    market: { oracle: engineUrl === undefined ? undefined : { engineBaseUrl: engineUrl } },
  } as unknown as BrowserOracleOwner;
}

describe("browserOracleSavedEngineUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("keeps the saved engine of the market", () => {
    expect(browserOracleSavedEngineUrl(imported("https://engine.example"))).toBe(
      "https://engine.example",
    );
    expect(browserOracleSavedEngineUrl(created("https://engine.example"))).toBe(
      "https://engine.example",
    );
    expect(browserOracleSavedEngineUrl(created(undefined))).toBeNull();
  });

  it("reads a record of a former host of this site through the current host", () => {
    // The site moved to this host. The former host serves no API, but the engine is the same.
    vi.stubEnv(
      "VITE_FORMER_ENGINE_ORIGINS",
      "https://former.example, https://other-former.example",
    );
    for (const saved of [
      "https://former.example",
      "https://former.example/",
      "https://other-former.example",
    ]) {
      expect(browserOracleSavedEngineUrl(imported(saved))).toBe(window.location.origin);
      expect(browserOracleSavedEngineUrl(created(saved))).toBe(window.location.origin);
    }
    // Another engine stays: it can belong to another deployment.
    expect(browserOracleSavedEngineUrl(imported("https://engine.example"))).toBe(
      "https://engine.example",
    );
    expect(browserOracleSavedEngineUrl(imported("https://former.example.evil"))).toBe(
      "https://former.example.evil",
    );
  });
});
