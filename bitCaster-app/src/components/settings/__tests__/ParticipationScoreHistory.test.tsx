import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ParticipationScoreHistoryResponse } from "@bitcaster/client-sdk/engineClient";
import { ParticipationScoreHistory } from "../ParticipationScoreHistory";
import en from "@/i18n/locales/en.json";
import ja from "@/i18n/locales/ja.json";

const HISTORY: ParticipationScoreHistoryResponse = {
  balance: -97,
  entries: [
    {
      kind: "reused-output-penalty",
      amountScore: -100,
      balanceAfter: -97,
      occurredAt: "2026-08-21T00:00:03Z",
    },
    {
      kind: "invalid-capability-validation",
      amountScore: -15,
      balanceAfter: 3,
      occurredAt: "2026-08-21T00:00:02Z",
    },
    {
      kind: "capability-binding",
      amountScore: -2,
      balanceAfter: 18,
      occurredAt: "2026-08-21T00:00:01Z",
    },
    { kind: "purchase", amountScore: 20, balanceAfter: 20, occurredAt: "2026-08-21T00:00:00Z" },
  ],
};

const KINDS = [
  "purchase",
  "capability-binding",
  "invalid-capability-validation",
  "reused-output-penalty",
] as const;

describe("Participation Score history", () => {
  it("shows the balance and one row for each change, newest first, with its signed amount", async () => {
    render(<ParticipationScoreHistory load={vi.fn().mockResolvedValue(HISTORY)} />);

    const list = await screen.findByRole("list", { name: en.participationScore.history });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.getAttribute("data-kind"))).toEqual([
      "reused-output-penalty",
      "invalid-capability-validation",
      "capability-binding",
      "purchase",
    ]);
    expect(rows[0]).toHaveTextContent(en.participationScore.kinds["reused-output-penalty"]);
    expect(rows[0]).toHaveTextContent("-100");
    expect(rows[3]).toHaveTextContent(en.participationScore.kinds.purchase);
    expect(rows[3]).toHaveTextContent("+20");
    expect(screen.getByTestId("participation-score-balance")).toHaveTextContent("-97");
  });

  it("names the penalty without exposing its group or digest", async () => {
    render(
      <ParticipationScoreHistory
        load={vi.fn().mockResolvedValue({ balance: -100, entries: [HISTORY.entries[0]] })}
      />,
    );
    const row = await screen.findByRole("listitem");
    expect(row.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("shows an empty history", async () => {
    render(
      <ParticipationScoreHistory load={vi.fn().mockResolvedValue({ balance: 0, entries: [] })} />,
    );
    expect(await screen.findByText(en.participationScore.historyEmpty)).toBeVisible();
  });

  it("shows an unavailable history and loads again on retry", async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("private provider detail"))
      .mockResolvedValue(HISTORY);
    render(<ParticipationScoreHistory load={load} />);

    expect(await screen.findByText(en.participationScore.historyUnavailable)).toBeVisible();
    expect(screen.queryByText(/private provider detail/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: en.common.retry }));
    expect(await screen.findByRole("list", { name: en.participationScore.history })).toBeVisible();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["en", en],
    ["ja", ja],
  ] as const)("%s names every history kind", (_locale, catalogue) => {
    for (const kind of KINDS) expect(catalogue.participationScore.kinds[kind]).toMatch(/\S/);
    expect(catalogue.participationScore.history).toMatch(/\S/);
    expect(catalogue.participationScore.historyEmpty).toMatch(/\S/);
    expect(catalogue.participationScore.historyUnavailable).toMatch(/\S/);
  });
});
