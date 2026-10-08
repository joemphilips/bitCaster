import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { advanceNostrSignerRevision } from "@/lib/nostrSignerRevision";
import i18n from "@/i18n";
import { CreatorMarketActions, CreatorMarketActionsProvider } from "../CreatorMarketActions";

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
  h.local.mockImplementation(async () => ({
    rows: [local()],
    nextOffset: null,
  }));
  h.backup.mockResolvedValue({ failures: [] });
  h.publication.mockResolvedValue({ failures: [] });
});
afterEach(cleanup);

function show() {
  return render(
    <CreatorMarketActionsProvider conditionIds={[local().conditionId]}>
      <CreatorMarketActions
        conditionId={local().conditionId}
        title="Restored event"
        onPublish={h.publication}
        publicationBusy={false}
      />
    </CreatorMarketActionsProvider>,
  );
}
it("offers ordinary resolution without manual discovery or exact restore controls", async () => {
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Close market" }));
  expect(h.publication).toHaveBeenCalledWith({
    conditionId: local().conditionId,
    title: "Restored event",
    outcomes: ["YES", "NO"],
    chosenOutcome: null,
    republish: false,
    relayUrls: ["wss://relay.original.example"],
  });
  expect(h.list).not.toHaveBeenCalled();
  expect(h.restore).not.toHaveBeenCalled();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByText("Advanced oracle recovery")).toBeNull();
});
it("refuses new signing while restoration is incomplete", async () => {
  const row = local();
  row.readiness = "needs-restore";
  row.status.importComplete = false;
  h.local.mockResolvedValue({ rows: [row], nextOffset: null });
  show();
  expect(await screen.findByRole("button", { name: "Close market" })).toBeDisabled();
});
it("preserves exact saved retries without private signing authority", async () => {
  const row = local();
  row.readiness = "needs-restore";
  row.chosenOutcome = "NO";
  row.status.terminal.prepared = true;
  h.local.mockResolvedValue({ rows: [row], nextOffset: null });
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Republish exact resolution" }));
  expect(h.publication.mock.calls[0][0]).toMatchObject({ chosenOutcome: "NO", republish: true });
  expect(screen.getByRole("button", { name: "Retry saved resolution" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Retry oracle backup" })).toBeEnabled();
});
it("keeps a failed delivery visible until explicit dismissal", async () => {
  h.backup.mockRejectedValue(new Error("private diagnostic"));
  show();
  fireEvent.click(await screen.findByRole("button", { name: "Retry oracle backup" }));
  expect(await screen.findByRole("alert")).not.toHaveTextContent("private diagnostic");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
it.each(["unmount", "signer"])("invalidates pending delivery after %s", async (change) => {
  let proceed!: () => void;
  const next = vi.fn();
  h.backup.mockImplementation(async (_id, { requireCurrent }) => {
    await new Promise<void>((resolve) => {
      proceed = resolve;
    });
    requireCurrent();
    next();
    return { failures: [] };
  });
  const view = show();
  fireEvent.click(await screen.findByRole("button", { name: "Retry oracle backup" }));
  await waitFor(() => expect(h.backup).toHaveBeenCalledTimes(1));
  if (change === "unmount") view.unmount();
  else act(() => advanceNostrSignerRevision());
  await act(async () => {
    proceed();
    await Promise.resolve();
  });
  expect(next).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});
it("bounds status reads to the visible page", async () => {
  show();
  await screen.findByRole("button", { name: "Close market" });
  expect(h.local).toHaveBeenCalledWith(
    expect.objectContaining({ conditionIds: [local().conditionId] }),
  );
});

it("shares one enumeration for multiple visible rows", async () => {
  const rows = [local(), { ...local(), conditionId: "dd".repeat(32) }];
  h.local.mockResolvedValue({ rows, nextOffset: null });
  render(
    <CreatorMarketActionsProvider conditionIds={rows.map((row) => row.conditionId)}>
      {rows.map((row) => (
        <CreatorMarketActions
          key={row.conditionId}
          conditionId={row.conditionId}
          title={row.title}
          onPublish={h.publication}
          publicationBusy={false}
        />
      ))}
    </CreatorMarketActionsProvider>,
  );
  await waitFor(() =>
    expect(screen.getAllByRole("button", { name: "Close market" })).toHaveLength(2),
  );
  expect(h.local).toHaveBeenCalledTimes(1);
  expect(h.local).toHaveBeenCalledWith(
    expect.objectContaining({ conditionIds: rows.map((row) => row.conditionId) }),
  );
});
it("does not claim delivery confirmation for a prepared backup without relays", async () => {
  const row = local();
  row.status.noRelays = true;
  row.status.destinations.relayUrls = [];
  row.status.preparationPending = false;
  row.status.initial = { prepared: true, acknowledgedRelays: 0, totalRelays: 0 };
  h.local.mockResolvedValue({ rows: [row], nextOffset: null });
  show();
  await screen.findByRole("button", { name: "Close market" });
  expect(screen.getByText(i18n.t("oracleBackup.noRelays"))).toBeInTheDocument();
  expect(screen.queryByText(i18n.t("oracleBackup.deliveryConfirmed"))).toBeNull();
});
it("ignores a stale page status response after navigation", async () => {
  const first = local();
  const second = { ...local(), conditionId: "dd".repeat(32), title: "Second event" };
  let finishFirst!: (value: unknown) => void;
  h.local.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
  );
  h.local.mockResolvedValue({ rows: [second], nextOffset: null });
  const page = (row: ReturnType<typeof local>) => (
    <CreatorMarketActionsProvider conditionIds={[row.conditionId]}>
      <CreatorMarketActions
        key={row.conditionId}
        conditionId={row.conditionId}
        title={row.title}
        onPublish={h.publication}
        publicationBusy={false}
      />
    </CreatorMarketActionsProvider>
  );
  const view = render(page(first));
  view.rerender(page(second));
  await screen.findByRole("button", { name: "Close market" });
  await act(async () => finishFirst({ rows: [first], nextOffset: null }));
  fireEvent.click(screen.getByRole("button", { name: "Close market" }));
  expect(h.publication).toHaveBeenCalledWith(
    expect.objectContaining({ conditionId: second.conditionId }),
  );
  expect(screen.queryByRole("alert")).toBeNull();
});
