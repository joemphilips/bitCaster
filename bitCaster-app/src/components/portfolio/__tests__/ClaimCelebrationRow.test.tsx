import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nextProvider } from "react-i18next";
import i18n from "@/i18n";
import type { ClaimCelebration } from "@/types/portfolio";
import { ClaimCelebrationRow } from "../ClaimCelebrationRow";

const celebration: ClaimCelebration = {
  id: "completed-claim",
  expiresAtMs: 3000,
  creditedAmountSubunits: 1234,
  position: {
    id: "position",
    marketId: "market",
    marketTitle: "Will Bitcoin reach the forecast price?",
    marketImageUrl: "",
    mintUrl: "https://mint.example",
    baseAsset: "sat",
    side: "yes",
    currentValueSats: 0,
    status: "closed",
    isWinner: true,
    isLoser: false,
    isPending: false,
    acquiredDate: "2026-10-08T00:00:00Z",
  },
};

afterEach(async () => {
  cleanup();
  vi.useRealTimers();
  await i18n.changeLanguage("en");
});

describe("ClaimCelebrationRow", () => {
  it.each(["en", "ja"])(
    "keeps exact payout and a non-actionable countdown in %s",
    async (locale) => {
      await i18n.changeLanguage(locale);
      vi.useFakeTimers();
      vi.setSystemTime(0);
      render(
        <I18nextProvider i18n={i18n}>
          <ClaimCelebrationRow celebration={celebration} />
        </I18nextProvider>,
      );
      expect(screen.getByRole("group", { name: "1.234 sats" })).toBeInTheDocument();
      expect(screen.getByRole("status")).toHaveTextContent(
        locale === "en" ? "Congratulations! You've earned" : "おめでとうございます！",
      );
      expect(screen.queryByRole("button")).not.toBeInTheDocument();
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
      act(() => vi.advanceTimersByTime(1500));
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
      act(() => vi.advanceTimersByTime(1500));
      expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
      // Only the page can expire the snapshot. The countdown cannot change custody.
      expect(screen.getByTestId("claim-celebration")).toBeInTheDocument();
    },
  );
});
