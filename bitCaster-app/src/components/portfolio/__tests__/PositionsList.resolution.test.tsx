import { render, screen, within } from "@testing-library/react";
import { I18nextProvider } from "react-i18next";
import { describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { PositionsList } from "../PositionsList";
import type { Position } from "@/types/portfolio";

// A deadline closed the market, and the oracle has not answered.
const pastDeadline: Position = {
  id: "pos-pending",
  marketId: "mkt-pending-Yes",
  marketTitle: "Will the oracle answer?",
  marketImageUrl: "",
  baseAsset: "sat",
  divisibility: 1_000,
  mintUrl: "https://mint.example",
  side: "Outcome",
  outcomeId: "Yes",
  outcomeLabel: "Yes",
  shares: 5,
  currentValueSats: 0,
  valueKnown: false,
  status: "closed",
  isWinner: false,
  isLoser: false,
  isPending: true,
  finalOutcome: null,
  closedDate: "2026-01-01T00:00:00Z",
  acquiredDate: "2025-12-01T00:00:00Z",
};

describe("PositionsList resolution state", () => {
  it.each([
    ["en", "Awaiting resolution", /resolved|won|lost/i],
    ["ja", "結果判定待ち", /結果判定済み|当たり|ハズレ/],
  ] as const)(
    "shows a past-deadline position without an outcome as awaiting resolution in %s",
    (language, label, resolvedPattern) => {
      render(
        <I18nextProvider i18n={i18n.cloneInstance({ lng: language })}>
          <PositionsList
            positions={[pastDeadline]}
            positionsTab="closed"
            onViewPosition={() => {}}
            onClaimPayout={() => {}}
            onDiscardLostPosition={() => {}}
          />
        </I18nextProvider>,
      );

      const row = screen.getByRole("button", { name: /Will the oracle answer\?/ });
      expect(within(row).getByText(label)).toBeInTheDocument();
      expect(row.textContent).not.toMatch(resolvedPattern);
      expect(within(row).queryByRole("button")).toBeNull();
    },
  );
});
