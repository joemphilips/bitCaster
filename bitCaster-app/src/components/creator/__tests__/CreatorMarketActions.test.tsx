import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { nip19 } from "nostr-tools";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import i18n from "@/i18n";
import { CreatorMarketActions, CreatorMarketActionsProvider } from "../CreatorMarketActions";

const oracleKey = generateSecretKey();
const h = vi.hoisted(() => ({
  owners: { markets: [], importedOracles: [] },
  settings: { nostrSignerMode: "nsec", nsecSecret: null as string | null },
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
    (selector: (state: typeof h.settings) => unknown) => selector(h.settings),
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
    signed: false,
    publicationState: null as "publishing" | "published" | "failed" | null,
    status: {
      binding: {
        conditionId: "aa".repeat(32),
        oraclePubkey: getPublicKey(oracleKey),
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
function signIn(key: Uint8Array | null) {
  h.settings = key
    ? { nostrSignerMode: "nsec", nsecSecret: nip19.nsecEncode(key) }
    : { nostrSignerMode: "none", nsecSecret: null };
}
beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.resetAllMocks();
  signIn(oracleKey);
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
it.each([
  ["publishing", "Sending result…"],
  ["published", "Published"],
  ["failed", "Couldn't publish. Retrying automatically."],
] as const)(
  "shows one %s state for a saved outcome without delivery controls",
  async (state, label) => {
    const row = local();
    row.chosenOutcome = "NO";
    row.signed = true;
    row.publicationState = state;
    row.status.preparationPending = false;
    row.status.initial = { prepared: false, acknowledgedRelays: 0, totalRelays: 1 };
    row.status.terminal = {
      ...row.status.terminal,
      prepared: true,
      replacementAcknowledgedRelays: 1,
    };
    h.local.mockResolvedValue({ rows: [row], nextOffset: null });
    show();
    expect(await screen.findByText(`Saved outcome: NO · ${label}`)).toBeVisible();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/Engine|Relay|backup/)).toBeNull();
  },
);
it.each([
  ["failed", "Couldn't publish. Retrying automatically.", false],
  ["published", "Published", true],
] as const)(
  "asks the user to keep local data when the relay copy of a %s result has no saved outcome",
  async (state, label, terminal) => {
    const row = local();
    row.chosenOutcome = "NO";
    row.signed = true;
    row.publicationState = state;
    // A relay holds the initial backup. It was prepared before the choice, so it has no outcome.
    row.status.preparationPending = terminal;
    row.status.initial = { prepared: true, acknowledgedRelays: 1, totalRelays: 1 };
    h.local.mockResolvedValue({ rows: [row], nextOffset: null });
    show();
    expect(await screen.findByText(`Saved outcome: NO · ${label}`)).toBeVisible();
    expect(screen.getByText(i18n.t("oracleBackup.notOnRelay"))).toBeVisible();
  },
);
it("shows no backup message while the saved result is sending", async () => {
  const row = local();
  row.chosenOutcome = "NO";
  row.signed = true;
  row.publicationState = "publishing";
  row.status.preparationPending = false;
  row.status.initial = { prepared: true, acknowledgedRelays: 0, totalRelays: 1 };
  h.local.mockResolvedValue({ rows: [row], nextOffset: null });
  show();
  expect(await screen.findByText("Saved outcome: NO · Sending result…")).toBeVisible();
  expect(screen.queryByText(i18n.t("oracleBackup.notOnRelay"))).toBeNull();
});
it("shows no backup state while a relay holds the current backup", async () => {
  const row = local();
  row.status.preparationPending = false;
  row.status.destinations.relayUrls = ["wss://one.example", "wss://two.example"];
  row.status.initial = { prepared: true, acknowledgedRelays: 1, totalRelays: 2 };
  h.local.mockResolvedValue({ rows: [row], nextOffset: null });
  show();
  await screen.findByRole("button", { name: "Close market" });
  expect(screen.queryByText(i18n.t("oracleBackup.notOnRelay"))).toBeNull();
  expect(screen.queryByText(i18n.t("oracleBackup.keyRequired"))).toBeNull();
  expect(screen.queryByText(/delivery/)).toBeNull();
});
it.each(["initial", "terminal", "no relays"] as const)(
  "asks the user to keep local data when no relay acknowledged the current %s backup",
  async (stage) => {
    const row = local();
    row.status.preparationPending = false;
    if (stage === "terminal") {
      row.chosenOutcome = "NO";
      row.signed = true;
      row.publicationState = "published";
      row.status.initial = { prepared: false, acknowledgedRelays: 0, totalRelays: 1 };
      row.status.terminal = { ...row.status.terminal, prepared: true };
    } else {
      const total = stage === "no relays" ? 0 : 1;
      row.status.noRelays = total === 0;
      row.status.initial = { prepared: true, acknowledgedRelays: 0, totalRelays: total };
    }
    h.local.mockResolvedValue({ rows: [row], nextOffset: null });
    show();
    expect(await screen.findByText(i18n.t("oracleBackup.notOnRelay"))).toBeVisible();
    expect(screen.queryByText(i18n.t("oracleBackup.keyRequired"))).toBeNull();
  },
);
it.each(["backup preparation", "interrupted signing"] as const)(
  "asks for the oracle key only when %s needs it",
  async (work) => {
    const row = local();
    row.chosenOutcome = "NO";
    row.publicationState = "publishing";
    if (work === "backup preparation") {
      row.signed = true;
      row.status.preparationPending = true;
      row.status.initial = { prepared: true, acknowledgedRelays: 1, totalRelays: 1 };
    } else {
      row.status.preparationPending = false;
      row.status.initial = { prepared: true, acknowledgedRelays: 1, totalRelays: 1 };
    }
    h.local.mockResolvedValue({ rows: [row], nextOffset: null });
    signIn(null);
    const view = show();
    expect(await screen.findByText(i18n.t("oracleBackup.keyRequired"))).toBeVisible();
    view.unmount();
    signIn(generateSecretKey());
    const other = show();
    expect(await screen.findByText(i18n.t("oracleBackup.keyRequired"))).toBeVisible();
    other.unmount();
    signIn(oracleKey);
    show();
    await screen.findByText("Saved outcome: NO · Sending result…");
    expect(screen.queryByText(i18n.t("oracleBackup.keyRequired"))).toBeNull();
  },
);
it("keeps a failed status read visible until explicit dismissal", async () => {
  h.local.mockRejectedValue(new Error("private diagnostic"));
  show();
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(i18n.t("oracleBackup.failed"));
  expect(alert).not.toHaveTextContent("private diagnostic");
  fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
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
