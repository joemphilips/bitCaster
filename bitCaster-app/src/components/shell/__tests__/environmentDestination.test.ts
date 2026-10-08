import { describe, expect, it } from "vitest";
import { resolveEnvironmentDestination } from "../environmentDestination";

const currentOrigin = "https://mainnet.example";

describe("environment destination", () => {
  it.each([
    ["mainnet", "https://testnet.example", "testnet", "https://testnet.example/"],
    ["testnet", "https://mainnet.example/", "mainnet", "https://mainnet.example/"],
  ])("resolves explicit %s settings", (environment, origin, alternate, href) => {
    expect(resolveEnvironmentDestination(environment, origin, "http://localhost:5173")).toEqual({
      environment: alternate,
      href,
    });
  });

  it.each([undefined, "", "production", "development", "MAINNET", " testnet", null, false])(
    "hides the link for an absent or unknown environment (%s)",
    (environment) => {
      expect(
        resolveEnvironmentDestination(environment, "https://testnet.example", currentOrigin),
      ).toBeNull();
    },
  );

  it.each([
    undefined,
    null,
    "",
    "/",
    "//testnet.example",
    "http://testnet.example",
    "javascript:alert(1)",
    "https://",
    "https://testnet.example/path",
    "https://testnet.example/path/..",
    "https://testnet.example/.",
    "https://testnet.example//",
    "https://testnet.example/%2e",
    "https://testnet.example?",
    "https://testnet.example/?wallet=secret",
    "https://testnet.example#",
    "https://testnet.example/#backup",
    "https://user:password@testnet.example",
    "https://@testnet.example",
    "https://testnet.example\\path",
    " https://testnet.example",
    "https://testnet.example\n",
    "https://testnet.example:invalid",
    "https://mainnet.example",
    "https://MAINNET.example:443/",
  ])("rejects an unsafe or same-origin target (%s)", (target) => {
    expect(resolveEnvironmentDestination("mainnet", target, currentOrigin)).toBeNull();
  });

  it("fails closed when the current origin is unavailable", () => {
    expect(resolveEnvironmentDestination("mainnet", "https://testnet.example", "")).toBeNull();
  });
});
