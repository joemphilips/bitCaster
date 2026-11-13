import { render, screen } from "@testing-library/react";
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

const GAP_LINE = "Missing funds? Use bitcaster wallet recover-seed --gap-limit 3000.";
const POINTER =
  "Some positions may be missing. Use bitcaster wallet recover-seed --all-conditions.";

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
    render(<SeedRestoreResult result={{ scopeId: "scope", partial: false, retryable: false }} />);

    expect(screen.getByText(GAP_LINE)).toBeInTheDocument();
    expect(screen.queryByText(POINTER)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("keeps the CLI pointer for a partial restore, and Retry starts no new restore", async () => {
    render(<SeedRestoreResult result={{ scopeId: "scope", partial: true, retryable: true }} />);

    expect(screen.getByText(POINTER)).toBeInTheDocument();
    expect(screen.getByText(GAP_LINE)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(mocks.retry).toHaveBeenCalledWith("scope");
    expect(mocks.wake).toHaveBeenCalledWith({ scopeId: "scope" });
  });

  it("shows the pointer without Retry when the engine holds no index", () => {
    render(<SeedRestoreResult result={{ scopeId: "scope", partial: true, retryable: false }} />);

    expect(screen.getByText(POINTER)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("closes only on an explicit, keyboard-accessible action", async () => {
    render(<SeedRestoreResult result={{ scopeId: "scope", partial: true, retryable: false }} />);

    const close = screen.getByRole("button", { name: "Dismiss" });
    close.focus();
    await userEvent.keyboard("{Enter}");

    expect(mocks.dismiss).toHaveBeenCalledWith("scope");
  });

  it("has the same lines in Japanese", async () => {
    await i18n.changeLanguage("ja");
    render(<SeedRestoreResult result={{ scopeId: "scope", partial: true, retryable: false }} />);

    expect(
      screen.getByText(
        "資金が見つからない場合は bitcaster wallet recover-seed --gap-limit 3000 を使ってください。",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "一部のポジションが見つからない可能性があります。bitcaster wallet recover-seed --all-conditions を使ってください。",
      ),
    ).toBeInTheDocument();
  });
});
