import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vitest replaces CSS modules with empty text, and jsdom has no line layout.
// Read the stylesheet that the browser receives.
const styles = readFileSync("src/index.css", "utf8");

describe("global styles", () => {
  it("breaks Japanese text between phrases where the browser supports it", () => {
    const supportsBlock = styles.match(/@supports \(word-break: auto-phrase\) \{([\s\S]*?)\n\}/);
    expect(supportsBlock?.[1]).toMatch(/:lang\(ja\)\s*\{\s*word-break: auto-phrase;\s*\}/);
  });
});
