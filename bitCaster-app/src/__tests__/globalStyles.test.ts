import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Vitest replaces CSS modules with empty text, and jsdom has no line layout.
// Read the stylesheet that the browser receives.
const styles = readFileSync("src/index.css", "utf8");
const supportsBlock =
  styles.match(/@supports \(word-break: auto-phrase\) \{([\s\S]*?)\n\}/)?.[1] ?? "";

describe("global styles", () => {
  it("breaks Japanese interface text between phrases where the browser supports it", () => {
    // Only the root sets phrase breaking. Elements inherit it, so an excluded container also
    // resets its descendants.
    expect(supportsBlock).toMatch(/html:lang\(ja\)\s*\{\s*word-break: auto-phrase;\s*\}/);
  });

  it("keeps normal breaking for typed text and user content", () => {
    const exclusion = supportsBlock.match(
      /html:lang\(ja\)\s+:is\(([^)]*)\)\s*\{\s*word-break: normal;/,
    );
    const selectors = exclusion?.[1].split(",").map((selector) => selector.trim());
    expect(selectors).toEqual(
      expect.arrayContaining(["input", "textarea", "[contenteditable]", "[data-user-content]"]),
    );
  });
});
