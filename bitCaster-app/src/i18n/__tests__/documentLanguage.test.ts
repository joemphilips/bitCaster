import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("document language", () => {
  it("marks the document with the active language from start and on each change", async () => {
    // The test setup initializes i18n before this file runs.
    expect(i18n.resolvedLanguage).toBe("en");
    expect(document.documentElement.lang).toBe("en");

    await i18n.changeLanguage("ja");
    expect(document.documentElement.lang).toBe("ja");

    await i18n.changeLanguage("en");
    expect(document.documentElement.lang).toBe("en");
  });
});
