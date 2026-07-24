import { describe, expect, it } from "vitest";
import { getMintQuoteRateInfo, parseBolt11AmountSats } from "../mintQuoteRate";

describe("parseBolt11AmountSats", () => {
  it("parses common bolt11 BTC multipliers", () => {
    expect(parseBolt11AmountSats("lnbc10u1pjexample")).toBe(1000);
    expect(parseBolt11AmountSats("lnbc2500n1pjexample")).toBe(250);
  });
});

describe("getMintQuoteRateInfo", () => {
  it("uses mint-provided rate-like extra fields first", () => {
    const quote = {
      quote: "q",
      request: "lnbc10u1pjexample",
      unit: "usd",
      amount: 100,
      state: "UNPAID",
      expiry: null,
      extra_json: { rate: 0.42 },
    };
    expect(getMintQuoteRateInfo(quote as never, 100)).toEqual({
      label: "0.42",
      source: "mint",
      fieldName: "rate",
    });
  });

  it("falls back to implied invoice sats per requested fiat cent", () => {
    const quote = {
      quote: "q",
      request: "lnbc10u1pjexample",
      unit: "usd",
      amount: 100,
      state: "UNPAID",
      expiry: null,
    };
    expect(getMintQuoteRateInfo(quote as never, 100)).toEqual({
      label: "10 sat/cent",
      source: "implied",
    });
  });
});
