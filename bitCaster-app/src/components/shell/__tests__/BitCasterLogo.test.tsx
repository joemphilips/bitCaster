import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BitCasterLogo } from "../BitCasterLogo";

describe("BitCasterLogo", () => {
  it("renders the bitCaster wordmark together with the (β) marker", () => {
    render(<BitCasterLogo />);
    const svg = screen.getByRole("img", { name: /bitcaster.*beta/i });
    expect(svg).toBeInTheDocument();
    // Both <text> nodes are present so the lockup reads "bitCaster (β)" to AT.
    expect(svg.textContent).toContain("bitCaster");
    expect(svg.textContent).toContain("(β)");
  });

  it("renders the beta marker smaller than the wordmark per Q6", () => {
    const { container } = render(<BitCasterLogo />);
    const texts = container.querySelectorAll("text");
    expect(texts).toHaveLength(2);
    const wordmarkSize = Number(texts[0]!.getAttribute("font-size"));
    const betaSize = Number(texts[1]!.getAttribute("font-size"));
    expect(betaSize).toBeLessThan(wordmarkSize);
    // 50–60% of cap-height anchor expectation from the plan.
    const ratio = betaSize / wordmarkSize;
    expect(ratio).toBeGreaterThanOrEqual(0.45);
    expect(ratio).toBeLessThanOrEqual(0.65);
  });

  it("uses currentColor so the existing Tailwind text-color cascade controls theming", () => {
    const { container } = render(<BitCasterLogo />);
    container.querySelectorAll("text").forEach((node) => {
      expect(node.getAttribute("fill")).toBe("currentColor");
    });
    const underline = container.querySelector("line");
    expect(underline?.getAttribute("stroke")).toBe("currentColor");
  });

  it("passes through className for sizing", () => {
    const { container } = render(<BitCasterLogo className="h-8 w-auto" />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("class")).toBe("h-8 w-auto");
  });
});
