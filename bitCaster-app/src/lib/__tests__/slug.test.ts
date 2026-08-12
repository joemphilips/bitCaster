import { describe, it, expect } from "vitest";
import { slugifyEventTitle, buildEventId } from "../slug";

describe("slugifyEventTitle", () => {
  it("lowercases ASCII letters", () => {
    expect(slugifyEventTitle("HELLO")).toBe("hello");
  });

  it("replaces spaces with underscores", () => {
    expect(slugifyEventTitle("What is the Bitcoin Price?")).toBe("what_is_the_bitcoin_price");
  });

  it("collapses runs of non-alphanumeric characters", () => {
    expect(slugifyEventTitle("foo!!!bar   baz")).toBe("foo_bar_baz");
  });

  it("strips leading and trailing underscores", () => {
    expect(slugifyEventTitle("  ?Hello? ")).toBe("hello");
  });

  it("preserves digits", () => {
    expect(slugifyEventTitle("BTC at $100,000 by 2026")).toBe("btc_at_100_000_by_2026");
  });

  it("removes diacritics via NFKD normalization", () => {
    expect(slugifyEventTitle("Café price")).toBe("cafe_price");
  });

  it("returns an empty string for titles with no usable characters", () => {
    expect(slugifyEventTitle("???")).toBe("");
    expect(slugifyEventTitle("   ")).toBe("");
  });

  it("truncates very long titles", () => {
    const long = "a".repeat(200);
    const slug = slugifyEventTitle(long);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).toBe("a".repeat(64));
  });
});

describe("buildEventId", () => {
  it("appends a random hex suffix to the slug", () => {
    const id = buildEventId("What is the Bitcoin Price?");
    expect(id).toMatch(/^what_is_the_bitcoin_price_[0-9a-f]{12}$/);
  });

  it("produces distinct ids for identical titles", () => {
    const a = buildEventId("same title");
    const b = buildEventId("same title");
    expect(a).not.toBe(b);
  });

  it("falls back to a default base when the slug would be empty", () => {
    const id = buildEventId("???");
    expect(id).toMatch(/^market_[0-9a-f]{12}$/);
  });

  it("keeps the full id within the 64-character limit", () => {
    const id = buildEventId("a".repeat(200));
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(/_[0-9a-f]{12}$/);
  });
});
