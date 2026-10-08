import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BitCasterLogo } from "../BitCasterLogo";

describe("BitCasterLogo", () => {
  it("renders the bitCaster wordmark without a beta suffix", () => {
    render(<BitCasterLogo />);
    expect(screen.getByRole("img", { name: "bitCaster" }).textContent).toBe("bitCaster");
    expect(screen.queryByText(/beta|β/i)).not.toBeInTheDocument();
  });

  it("preserves an explicit accessible label", () => {
    render(<BitCasterLogo ariaLabel="bitCaster home" />);
    expect(screen.getByRole("img", { name: "bitCaster home" })).toBeInTheDocument();
  });

  it("inherits the header color and accepts size classes", () => {
    const { container } = render(<BitCasterLogo className="h-8 w-auto" />);
    expect(screen.getByRole("img", { name: "bitCaster" })).toHaveClass("h-8", "w-auto");
    expect(container.querySelector("text")).toHaveAttribute("fill", "currentColor");
  });
});
