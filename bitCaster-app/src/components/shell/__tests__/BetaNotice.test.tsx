import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { BetaNotice } from "../BetaNotice";

afterEach(async () => {
  cleanup();
  vi.unstubAllEnvs();
  await i18n.changeLanguage("en");
});

describe("BetaNotice", () => {
  it("states the beta, real funds and limited capacity in both languages", async () => {
    vi.stubEnv("VITE_BETA_NOTICE", "true");
    await i18n.changeLanguage("en");
    const { rerender } = render(<BetaNotice />);
    expect(screen.getByRole("note").textContent).toBe(
      "Beta: this service uses real funds and has limited capacity.",
    );
    await i18n.changeLanguage("ja");
    rerender(<BetaNotice />);
    expect(screen.getByRole("note").textContent).toBe(
      "ベータ版：実際の資金を扱います。容量には制限があります。",
    );
  });

  it("renders nothing when the build does not enable it", () => {
    vi.stubEnv("VITE_BETA_NOTICE", "");
    render(<BetaNotice />);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
