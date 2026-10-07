import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { OracleBackups } from "../OracleBackups";

const h = vi.hoisted(() => ({
  owners: { markets: [], importedOracles: [] },
  list: vi.fn(),
  restore: vi.fn(),
  local: vi.fn(),
  backup: vi.fn(),
  publication: vi.fn(),
}));
vi.mock("@/lib/browserOracleBackupAccess", () => ({
  listBrowserOracleBackups: h.list,
  restoreBrowserOracleBackup: h.restore,
  localBrowserOracleBackupStatuses: h.local,
}));
vi.mock("@/lib/browserOracleBackupDelivery", () => ({
  deliverBrowserOracleBackup: h.backup,
}));
vi.mock("@/lib/oracleAttestation", () => ({
  publishBrowserOracleOutcome: h.publication,
}));
vi.mock("@/stores/settings", () => ({
  useSettingsStore: (selector: (state: { nostrSignerMode: string }) => unknown) =>
    selector({ nostrSignerMode: "nsec" }),
}));
vi.mock("@/stores/creatorMarkets", () => ({
  useCreatorMarketsStore: (
    selector: (state: { markets: never[]; importedOracles: never[] }) => unknown,
  ) => selector(h.owners),
}));

function local() {
  return {
    conditionId: "aa".repeat(32),
    available: true as const,
    title: "Restored event",
    kind: "imported",
    outcomes: ["YES", "NO"],
    chosenOutcome: null as string | null,
    status: {
      binding: {
        conditionId: "aa".repeat(32),
        oraclePubkey: "bb".repeat(32),
        oracleEventId: "restored-event",
        announcementEventId: "cc".repeat(32),
        outcomes: ["YES", "NO"],
      },
      destinations: {
        mintUrl: "https://mint.original.example",
        engineUrl: "https://engine.original.example",
        relayUrls: ["wss://relay.original.example"],
      },
      publication: { state: "unresolved", relayPublished: false, engineSynchronized: false },
      importComplete: true,
      preparationPending: true,
      initial: { prepared: false, acknowledgedRelays: 0, totalRelays: 1 },
      terminal: {
        prepared: false,
        replacementAcknowledgedRelays: 0,
        deletionRequired: false,
        deletionAcknowledgedRelays: 0,
        localCommitPending: false,
      },
      noRelays: false,
    },
  };
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.resetAllMocks();
  h.local.mockResolvedValue({ rows: [local()], nextOffset: null });
  h.backup.mockResolvedValue({ failures: [] });
  h.publication.mockResolvedValue({ failures: [] });
});
afterEach(cleanup);

it("restores a selected exact event independently and shows durable pending status", async () => {
  const eventId = "dd".repeat(32);
  h.list.mockResolvedValue({
    descriptors: [
      {
        backupEventId: eventId,
        oracleEventId: "Remote event",
        state: "unresolved",
        createdAt: 100,
        sourceRelay: "wss://source.example",
      },
    ],
    cursor: null,
    discovery: "relay-dependent",
    partialReasons: ["relay-dependent-history"],
    observedRelayComplete: true,
  });
  render(<OracleBackups />);
  await screen.findByText(
    "Backup preparation is pending. Use the original local oracle key to retry.",
  );
  fireEvent.click(screen.getByRole("button", { name: "List oracle backups" }));
  fireEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
  await waitFor(() => expect(h.restore).toHaveBeenCalledWith(eventId, "wss://source.example"));
  expect(screen.getByText(/Discovery depends on each relay/)).toBeVisible();
  expect(screen.getByText("https://engine.original.example")).toBeVisible();
});

it("shows frozen-source refusal without raw diagnostics and permits explicit dismissal", async () => {
  h.restore.mockRejectedValue({
    reason: "terminal-backup-source-not-admitted",
    message: "PRIVATE HELPER DIAGNOSTIC",
  });
  render(<OracleBackups />);
  fireEvent.change(screen.getByLabelText("Backup event ID"), {
    target: { value: "dd".repeat(32) },
  });
  fireEvent.change(screen.getByLabelText("Source relay URL"), {
    target: { value: "wss://source.example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Restore exact event" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("This version was not imported.");
  expect(alert).not.toHaveTextContent("PRIVATE");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByText("Backup preparation is pending. Use the original local oracle key to retry."),
  ).toBeVisible();
});

it("restored unresolved authority uses the selected outcome and original relays", async () => {
  render(<OracleBackups />);
  await screen.findByText("Restored event");
  fireEvent.change(screen.getByRole("combobox", { name: "Choose outcome" }), {
    target: { value: "YES" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Publish selected outcome" }));
  await waitFor(() => expect(h.publication).toHaveBeenCalled());
  const args = h.publication.mock.calls[0];
  expect(args[0]).toBe("aa".repeat(32));
  expect(args[1]).toBe("YES");
  expect(args[3]).toEqual(["wss://relay.original.example"]);
  expect(args[6]).toEqual({ engineDelivery: "synchronize", republishAttestation: false });
});

it("terminal owner requests explicit identical republication without selecting another outcome", async () => {
  const terminal = local();
  terminal.chosenOutcome = "YES";
  terminal.status.publication = {
    state: "terminal",
    relayPublished: true,
    engineSynchronized: true,
  };
  terminal.status.preparationPending = false;
  h.local.mockResolvedValue({ rows: [terminal], nextOffset: null });
  render(<OracleBackups />);
  fireEvent.click(await screen.findByRole("button", { name: "Republish exact resolution" }));
  await waitFor(() => expect(h.publication).toHaveBeenCalled());
  expect(h.publication.mock.calls[0][1]).toBe("YES");
  expect(h.publication.mock.calls[0][6]).toEqual({
    engineDelivery: "synchronize",
    republishAttestation: true,
  });
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("requests the selected local status page without retaining earlier page rows", async () => {
  h.local.mockImplementation(async ({ localOffset }: { localOffset: number }) => ({
    rows: [{ ...local(), title: localOffset === 0 ? "First local page" : "Second local page" }],
    nextOffset: localOffset === 0 ? 20 : null,
  }));
  render(<OracleBackups />);
  await screen.findByText("First local page");
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("Second local page");
  expect(h.local).toHaveBeenLastCalledWith({ localOffset: 20 });
  expect(screen.queryByText("First local page")).toBeNull();
});
