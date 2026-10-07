import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { advanceNostrSignerRevision } from "@/lib/nostrSignerRevision";
import i18n from "@/i18n";
import { CreatorOracleRecovery } from "../CreatorOracleRecovery";

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
  useSettingsStore: Object.assign(
    (selector: (state: { nostrSignerMode: string }) => unknown) =>
      selector({ nostrSignerMode: "nsec" }),
    { subscribe: vi.fn(() => () => {}) },
  ),
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
    readiness: "ready" as "ready" | "needs-restore" | "unavailable",
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
  h.local.mockImplementation(async ({ kind }) => ({
    rows: kind === "imported" ? [local()] : [],
    nextOffset: null,
  }));
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
  render(<CreatorOracleRecovery onPublish={h.publication} />);
  await screen.findByText(
    "Backup preparation is pending. Use the original local oracle key to retry.",
  );
  fireEvent.click(screen.getByTestId("creator-oracle-advanced-summary"));
  fireEvent.click(screen.getByRole("button", { name: "List oracle backups" }));
  fireEvent.click(await screen.findByRole("button", { name: "Restore this version" }));
  await waitFor(() =>
    expect(h.restore).toHaveBeenCalledWith(eventId, "wss://source.example", {
      requireCurrent: expect.any(Function),
    }),
  );
  expect(screen.getByText(/Discovery depends on each relay/)).toBeVisible();
  expect(screen.getByText("https://engine.original.example")).toBeVisible();
});

it("shows frozen-source refusal without raw diagnostics and permits explicit dismissal", async () => {
  h.restore.mockRejectedValue({
    reason: "terminal-backup-source-not-admitted",
    message: "PRIVATE HELPER DIAGNOSTIC",
  });
  render(<CreatorOracleRecovery onPublish={h.publication} />);
  fireEvent.click(screen.getByTestId("creator-oracle-advanced-summary"));
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
  render(<CreatorOracleRecovery onPublish={h.publication} />);
  await screen.findByText("Restored event");
  fireEvent.change(screen.getByRole("combobox", { name: "Choose outcome" }), {
    target: { value: "YES" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Publish selected outcome" }));
  await waitFor(() => expect(h.publication).toHaveBeenCalled());
  const args = h.publication.mock.calls[0];
  expect(args[0]).toBe("aa".repeat(32));
  expect(args[1]).toBe("YES");
  expect(args[2]).toBe(false);
  expect(args[3]).toEqual(["wss://relay.original.example"]);
  expect(args[4]).toBe(false);
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
  h.local.mockImplementation(async ({ kind }) => ({
    rows: kind === "imported" ? [terminal] : [],
    nextOffset: null,
  }));
  render(<CreatorOracleRecovery onPublish={h.publication} />);
  fireEvent.click(await screen.findByRole("button", { name: "Republish exact resolution" }));
  await waitFor(() => expect(h.publication).toHaveBeenCalled());
  expect(h.publication.mock.calls[0][1]).toBe("YES");
  expect(h.publication.mock.calls[0][2]).toBe(true);
  expect(h.publication.mock.calls[0][4]).toBe(true);
  expect(screen.queryByRole("combobox")).toBeNull();
});

it("requests the selected local status page without retaining earlier page rows", async () => {
  h.local.mockImplementation(
    async ({ localOffset, kind }: { localOffset: number; kind: string }) => ({
      rows:
        kind === "imported"
          ? [{ ...local(), title: localOffset === 0 ? "First local page" : "Second local page" }]
          : [],
      nextOffset: kind === "imported" && localOffset === 0 ? 20 : null,
    }),
  );
  render(<CreatorOracleRecovery onPublish={h.publication} />);
  await screen.findByText("First local page");
  fireEvent.click(screen.getByRole("button", { name: "Next page" }));
  await screen.findByText("Second local page");
  expect(h.local).toHaveBeenCalledWith({
    localOffset: 20,
    kind: "imported",
    requireCurrent: expect.any(Function),
  });
  expect(screen.queryByText("First local page")).toBeNull();
});

it("blocks new signing until restoration and retains immutable exact retries", async () => {
  const row = local();
  row.readiness = "needs-restore";
  h.local.mockImplementation(async ({ kind }) => ({
    rows: kind === "imported" ? [row] : [],
    nextOffset: null,
  }));
  const view = render(<CreatorOracleRecovery onPublish={h.publication} />);
  expect(await screen.findByRole("combobox", { name: "Choose outcome" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Publish selected outcome" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry oracle backup" })).toBeDisabled();
  view.unmount();
  row.chosenOutcome = "YES";
  h.local.mockImplementation(async ({ kind }) => ({
    rows: kind === "imported" ? [row] : [],
    nextOffset: null,
  }));
  render(<CreatorOracleRecovery onPublish={h.publication} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved resolution" }));
  expect(h.publication).toHaveBeenCalledWith(
    row.conditionId,
    "YES",
    false,
    ["wss://relay.original.example"],
    true,
  );
});

it("discards an action failure after unmount without raw feedback", async () => {
  let reject!: (failure: unknown) => void;
  h.backup.mockReturnValue(
    new Promise((_resolve, failure) => {
      reject = failure;
    }),
  );
  const view = render(<CreatorOracleRecovery onPublish={h.publication} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry oracle backup" }));
  view.unmount();
  const calls = h.local.mock.calls.length;
  reject(new Error("PRIVATE DIAGNOSTIC"));
  await Promise.resolve();
  await Promise.resolve();
  expect(h.local.mock.calls).toHaveLength(calls);
});

it("preserves created backup delivery without duplicate outcome controls", async () => {
  h.local.mockImplementation(async ({ kind }) => ({
    rows: kind === "created" ? [{ ...local(), kind: "created" }] : [],
    nextOffset: null,
  }));
  render(<CreatorOracleRecovery onPublish={h.publication} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry oracle backup" }));
  await waitFor(() =>
    expect(h.backup).toHaveBeenCalledWith("aa".repeat(32), {
      requireCurrent: expect.any(Function),
    }),
  );
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByTestId("creator-imported-oracle")).toBeNull();
  expect(screen.getByTestId("creator-created-oracle-backup")).toBeVisible();
});

it("keeps prepared encrypted retries available when signing data is missing", async () => {
  const row = local();
  row.readiness = "needs-restore";
  row.status.initial.prepared = true;
  h.local.mockImplementation(async ({ kind }) => ({
    rows: kind === "imported" ? [row] : [],
    nextOffset: null,
  }));
  render(<CreatorOracleRecovery onPublish={h.publication} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry oracle backup" }));
  await waitFor(() =>
    expect(h.backup).toHaveBeenCalledWith(row.conditionId, {
      requireCurrent: expect.any(Function),
    }),
  );
});

it("ignores an old identity failure and permits another action", async () => {
  let reject!: (failure: unknown) => void;
  h.backup.mockReturnValueOnce(
    new Promise((_resolve, failure) => {
      reject = failure;
    }),
  );
  render(<CreatorOracleRecovery onPublish={h.publication} />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry oracle backup" }));
  act(() => advanceNostrSignerRevision());
  await screen.findByText("Restored event");
  await act(async () => {
    reject(new Error("PRIVATE DIAGNOSTIC"));
    await Promise.resolve();
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Retry oracle backup" })).toBeEnabled();
});

it("invalidates exact restore admission when the Creator controls unmount", async () => {
  let completeQuery!: () => void;
  const importAuthority = vi.fn();
  h.restore.mockImplementation(async (_event, _relay, { requireCurrent }) => {
    await new Promise<void>((resolve) => {
      completeQuery = resolve;
    });
    requireCurrent();
    importAuthority();
  });
  const view = render(<CreatorOracleRecovery onPublish={h.publication} />);
  fireEvent.click(screen.getByTestId("creator-oracle-advanced-summary"));
  fireEvent.change(screen.getByLabelText("Backup event ID"), {
    target: { value: "dd".repeat(32) },
  });
  fireEvent.change(screen.getByLabelText("Source relay URL"), {
    target: { value: "wss://source.example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Restore exact event" }));
  expect(h.restore).toHaveBeenCalledOnce();
  view.unmount();
  await act(async () => {
    completeQuery();
    await Promise.resolve();
  });
  expect(importAuthority).not.toHaveBeenCalled();
});

it.each(["imported", "created"] as const)(
  "keeps %s pagination on the current page during a pending backup retry",
  async (ownerKind) => {
    let finish!: (result: { failures: never[] }) => void;
    h.backup.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    h.local.mockImplementation(async ({ kind, localOffset }) => ({
      rows:
        kind === ownerKind
          ? [
              {
                ...local(),
                kind: ownerKind,
                title: localOffset === 0 ? "Current oracle page" : "Next oracle page",
              },
            ]
          : [],
      nextOffset: kind === ownerKind && localOffset === 0 ? 20 : null,
    }));
    render(<CreatorOracleRecovery onPublish={h.publication} />);
    await screen.findByText("Current oracle page");
    const next = screen.getByRole("button", { name: "Next page" });
    const retry = screen.getByRole("button", { name: "Retry oracle backup" });
    act(() => {
      fireEvent.click(retry);
      fireEvent.click(next);
    });
    expect(screen.queryByText("Current oracle page") !== null).toBe(true);
    expect(next).toBeDisabled();
    expect(
      h.local.mock.calls.some(
        ([options]) => options.kind === ownerKind && options.localOffset === 20,
      ),
    ).toBe(false);
    await act(async () => {
      finish({ failures: [] });
      await Promise.resolve();
    });
    await waitFor(() => expect(next).toBeEnabled());
    fireEvent.click(next);
    await screen.findByText("Next oracle page");
    expect(screen.getByRole("button", { name: "Retry oracle backup" })).toBeEnabled();
    h.backup.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const previous = screen.getByRole("button", { name: "Previous page" });
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Retry oracle backup" }));
      fireEvent.click(previous);
    });
    expect(previous).toBeDisabled();
    expect(screen.queryByText("Next oracle page") !== null).toBe(true);
    await act(async () => {
      finish({ failures: [] });
      await Promise.resolve();
    });
    await waitFor(() => expect(previous).toBeEnabled());
    fireEvent.click(previous);
    await screen.findByText("Current oracle page");
    expect(screen.getByRole("button", { name: "Retry oracle backup" })).toBeEnabled();
  },
);

it.each(["imported", "created"] as const)(
  "invalidates the pending %s readiness probe when its view unmounts",
  async (ownerKind) => {
    let continueProbe!: () => void;
    const privateProbe = vi.fn();
    h.local.mockImplementation(async ({ kind, requireCurrent }) => {
      if (kind !== ownerKind) return { rows: [], nextOffset: null };
      await new Promise<void>((resolve) => {
        continueProbe = resolve;
      });
      requireCurrent();
      privateProbe();
      return { rows: [], nextOffset: null };
    });
    const view = render(<CreatorOracleRecovery onPublish={h.publication} />);
    expect(
      h.local.mock.calls.every(([options]) => typeof options.requireCurrent === "function"),
    ).toBe(true);
    view.unmount();
    await act(async () => {
      continueProbe();
      await Promise.resolve();
    });
    expect(privateProbe.mock.calls.length === 0).toBe(true);
  },
);

it.each([
  ["Retry saved resolution", false],
  ["Republish exact resolution", true],
] as const)(
  "preserves fully delivered created-owner %s with its saved outcome",
  async (label, republish) => {
    const row = local();
    row.kind = "created";
    row.readiness = "unavailable";
    row.chosenOutcome = "YES";
    row.status.publication = { state: "terminal", relayPublished: true, engineSynchronized: true };
    h.local.mockImplementation(async ({ kind }) => ({
      rows: kind === "created" ? [row] : [],
      nextOffset: null,
    }));
    render(<CreatorOracleRecovery onPublish={h.publication} />);
    fireEvent.click(await screen.findByRole("button", { name: label }));
    expect(h.publication).toHaveBeenCalledWith(
      row.conditionId,
      "YES",
      republish,
      ["wss://relay.original.example"],
      true,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
  },
);
