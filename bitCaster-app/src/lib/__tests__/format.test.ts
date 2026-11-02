import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { formatTimeAgo } from "../format";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await i18n.changeLanguage("en");
});

describe("formatTimeAgo", () => {
  it.each([
    ["en", 0, "Just now"],
    ["en", 4 * MINUTE, "4m ago"],
    ["en", 2 * 60 * MINUTE, "2h ago"],
    ["en", 3 * 24 * 60 * MINUTE, "3d ago"],
    ["en", 10 * 24 * 60 * MINUTE, "Oct 23"],
    ["ja", 0, "たった今"],
    ["ja", 4 * MINUTE, "4分前"],
    ["ja", 2 * 60 * MINUTE, "2時間前"],
    ["ja", 3 * 24 * 60 * MINUTE, "3日前"],
    ["ja", 10 * 24 * 60 * MINUTE, "10月23日"],
  ])("formats an age in %s (%i ms)", async (language, age, expected) => {
    await i18n.changeLanguage(language);

    expect(formatTimeAgo(NOW - age)).toBe(expected);
  });

  it("accepts an ISO string and a Date, and names an invalid time", async () => {
    await i18n.changeLanguage("ja");

    expect(formatTimeAgo(new Date(NOW - 4 * MINUTE).toISOString())).toBe("4分前");
    expect(formatTimeAgo(new Date(NOW - 4 * MINUTE))).toBe("4分前");
    expect(formatTimeAgo("not a time")).toBe("最近");
  });
});
