import { render, screen, type Matcher } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";

const mocks = vi.hoisted(() => ({
  retry: vi.fn(async () => undefined),
  dismiss: vi.fn(async () => undefined),
  wake: vi.fn(),
}));
vi.mock("@/lib/browserSeedPositionRestore", () => ({
  retryBrowserSeedPositionRestore: mocks.retry,
  dismissBrowserSeedRestoreResult: mocks.dismiss,
}));
vi.mock("@/lib/browserCtfRangeOrderRecoveryWake", () => ({
  publishBrowserCtfRangeRecoveryWake: mocks.wake,
}));

import { SeedRestoreResult } from "../SeedRestoreResult";

// Every restore result names the CLI command with a larger gap in one short
// line (ADR-051). A partial result also keeps one pointer to the CLI broad
// recovery, and Retry when it can change (ADR-039 "Restore order").

const GAP_COMMAND = "bitcaster wallet recover-seed --gap-limit 3000";
const ALL_CONDITIONS_COMMAND = "bitcaster wallet recover-seed --all-conditions";
const GAP_LINE = line(`Missing funds? Use ${GAP_COMMAND}.`);
const POINTER = line(`Some positions may be missing. Use ${ALL_CONDITIONS_COMMAND}.`);

/** The element whose whole text is the line. Its command is a child element. */
function line(text: string): Matcher {
  return (_, element) =>
    element?.textContent === text &&
    Array.from(element.children).every((child) => child.textContent !== text);
}

describe("SeedRestoreResult", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
  });

  it("shows nothing without a restore result", () => {
    const { container } = render(<SeedRestoreResult result={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows only the CLI gap line for a complete restore", () => {
    render(
      <SeedRestoreResult
        result={{ scopeId: "scope", partial: false, retryable: false, gapLineShown: true }}
      />,
    );

    expect(screen.getByText(GAP_LINE)).toBeInTheDocument();
    expect(screen.queryByText(POINTER)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("keeps the CLI pointer for a partial restore, and Retry starts no new restore", async () => {
    render(
      <SeedRestoreResult
        result={{ scopeId: "scope", partial: true, retryable: true, gapLineShown: true }}
      />,
    );

    expect(screen.getByText(POINTER)).toBeInTheDocument();
    expect(screen.getByText(GAP_LINE)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(mocks.retry).toHaveBeenCalledWith("scope");
    expect(mocks.wake).toHaveBeenCalledWith({ scopeId: "scope" });
  });

  it("shows the pointer without Retry when the engine holds no index", () => {
    render(
      <SeedRestoreResult
        result={{ scopeId: "scope", partial: true, retryable: false, gapLineShown: true }}
      />,
    );

    expect(screen.getByText(POINTER)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("closes only the CLI gap line, on an explicit keyboard-accessible action", async () => {
    render(
      <SeedRestoreResult
        result={{ scopeId: "scope", partial: false, retryable: false, gapLineShown: true }}
      />,
    );

    const close = screen.getByRole("button", { name: "Dismiss" });
    close.focus();
    await userEvent.keyboard("{Enter}");

    expect(mocks.dismiss).toHaveBeenCalledWith("scope");
  });

  it("keeps the partial pointer after the user closed the gap line", () => {
    render(
      <SeedRestoreResult
        result={{ scopeId: "scope", partial: true, retryable: false, gapLineShown: false }}
      />,
    );

    // ADR-039: one persistent pointer while the coverage is limited.
    expect(screen.getByText(POINTER)).toBeInTheDocument();
    expect(screen.queryByText(GAP_LINE)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
  });

  it("shows each command as code that breaks only between its tokens", () => {
    render(
      <SeedRestoreResult
        result={{ scopeId: "scope", partial: true, retryable: false, gapLineShown: true }}
      />,
    );

    const codes = Array.from(document.querySelectorAll("code"));
    expect(codes.map((code) => code.textContent)).toEqual([ALL_CONDITIONS_COMMAND, GAP_COMMAND]);
    for (const code of codes) {
      expect(code).toHaveClass("font-mono");
      expect(Array.from(code.children).map((token) => token.className)).toEqual(
        code.textContent!.split(" ").map(() => "whitespace-nowrap"),
      );
    }
  });

  it("has the same lines in Japanese", async () => {
    await i18n.changeLanguage("ja");
    render(
      <SeedRestoreResult
        result={{ scopeId: "scope", partial: true, retryable: false, gapLineShown: true }}
      />,
    );

    expect(
      screen.getByText(line(`資金が見つからない場合は ${GAP_COMMAND} を使ってください。`)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        line(
          `一部のポジションが見つからない可能性があります。${ALL_CONDITIONS_COMMAND} を使ってください。`,
        ),
      ),
    ).toBeInTheDocument();
  });
});
