import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NDKPrivateKeySigner } from "@nostr-dev-kit/ndk";
import type NDK from "@nostr-dev-kit/ndk";
import { finalizeEvent, type Event as NostrEvent } from "nostr-tools/pure";
import type { Filter } from "nostr-tools/filter";
import { nip19 } from "nostr-tools";
import { useSettingsStore } from "@/stores/settings";
import {
  loadBrowserNostrProfileEdit,
  saveBrowserNostrProfileEdit,
  type BrowserNostrProfileOptions,
} from "@/lib/browserNostrProfile";
import { NostrProfileEditor } from "../NostrProfileEditor";

const key = new Uint8Array(32).fill(7);
const nsec = nip19.nsecEncode(key);
const answering = "wss://answering.example";
const down = "wss://down.example";
const index = "wss://index.example";
const outbox = "wss://outbox.example";
const warning =
  "Some relays did not answer. If you have a profile on another relay, saving replaces it.";
const originalLocks = Object.getOwnPropertyDescriptor(navigator, "locks");

/** Each relay answers a REQ with its stored events of the requested kinds. */
function relayNetwork(stored: Readonly<Record<string, readonly NostrEvent[]>>, failing: string[]) {
  const requests: string[] = [];
  const publications: string[] = [];
  class RelaySocket {
    readyState = 0;
    onopen: WebSocket["onopen"] = null;
    onclose: WebSocket["onclose"] = null;
    onerror: WebSocket["onerror"] = null;
    onmessage: WebSocket["onmessage"] = null;
    constructor(readonly url: string) {
      queueMicrotask(() => {
        if (failing.includes(url)) {
          this.onerror?.call(this as unknown as WebSocket, new Event("error"));
          return;
        }
        this.readyState = 1;
        this.onopen?.call(this as unknown as WebSocket, new Event("open"));
      });
    }
    deliver(frame: unknown[]) {
      this.onmessage?.call(
        this as unknown as WebSocket,
        new MessageEvent("message", { data: JSON.stringify(frame) }),
      );
    }
    send(raw: string) {
      const [type, id, ...rest] = JSON.parse(raw) as [string, string, ...Filter[]];
      if (type === "REQ") {
        requests.push(this.url);
        queueMicrotask(() => {
          for (const event of stored[this.url] ?? [])
            if (rest.some((filter) => filter.kinds?.includes(event.kind)))
              this.deliver(["EVENT", id, event]);
          this.deliver(["EOSE", id]);
        });
      }
      if (type === "EVENT") {
        const event = id as unknown as NostrEvent;
        publications.push(this.url);
        queueMicrotask(() => this.deliver(["OK", event.id, true, ""]));
      }
    }
    close() {
      this.readyState = 3;
    }
  }
  const ndk = { signer: new NDKPrivateKeySigner(nsec) } as unknown as NDK;
  const options: BrowserNostrProfileOptions = {
    getNdk: () => ndk,
    websocketImplementation: RelaySocket as unknown as typeof WebSocket,
    indexRelays: [index],
    nowSeconds: () => 100,
  };
  return { requests, publications, options };
}

function renderEditor(network: ReturnType<typeof relayNetwork>) {
  render(
    <NostrProfileEditor
      load={(signal) => loadBrowserNostrProfileEdit(signal, network.options)}
      save={(patch, signal) => saveBrowserNostrProfileEdit(patch, signal, network.options)}
    />,
  );
}

const signed = (kind: number, created_at: number, content: string, tags: string[][] = []) =>
  finalizeEvent({ kind, created_at, tags, content }, key);

beforeEach(() => {
  localStorage.clear();
  useSettingsStore.setState({
    nostrSignerMode: "nsec",
    nsecSecret: nsec,
    nostrProfile: null,
    relays: [answering, down].map((url) => ({ url, connectionStatus: "disconnected" })),
  });
  let queue = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, _options: unknown, action: () => Promise<unknown>) => {
        const running = queue.catch(() => {}).then(action);
        queue = running.then(
          () => {},
          () => {},
        );
        return running;
      },
    },
  });
});
afterEach(() => {
  if (originalLocks) Object.defineProperty(navigator, "locks", originalLocks);
  else Reflect.deleteProperty(navigator, "locks");
  localStorage.clear();
});

describe("profile editor with a relay that does not answer", () => {
  it("opens for a key with no profile, warns, and saves when one relay accepts", async () => {
    const network = relayNetwork({}, [down]);
    renderEditor(network);
    expect(await screen.findByText(warning)).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
    // The index relay is read, but the save publishes only to the selected relays.
    expect(network.requests).toContain(index);
    expect(network.publications).toEqual([answering]);
    expect(useSettingsStore.getState().nostrProfile?.displayName).toBe("New key");
  });

  it("shows a profile that only a write relay of the relay list holds", async () => {
    const relayList = signed(10002, 5, "", [
      ["r", outbox],
      ["r", "wss://read-only.example", "read"],
    ]);
    const network = relayNetwork(
      {
        [index]: [relayList],
        [outbox]: [signed(0, 6, '{"name":"Outbox name","about":"Outbox bio"}')],
      },
      [down],
    );
    renderEditor(network);
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Outbox name"));
    expect(screen.getByLabelText("Description")).toHaveValue("Outbox bio");
    expect(screen.queryByText(warning)).not.toBeInTheDocument();
    expect(network.requests).not.toContain("wss://read-only.example");
  });

  it("reads no index relay when the profile indexer setting is off", async () => {
    useSettingsStore.setState({ profileIndexerEnabled: false });
    const relayList = signed(10002, 5, "", [["r", outbox]]);
    const network = relayNetwork(
      {
        [answering]: [relayList],
        [outbox]: [signed(0, 6, '{"name":"Outbox name"}')],
      },
      [down],
    );
    renderEditor(network);
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveValue("Outbox name"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
    // The selected relays and the write relays are still read for the edit and the save.
    expect(network.requests.filter((url) => url === outbox)).toHaveLength(2);
    expect(network.requests).not.toContain(index);
  });

  it("refuses the edit when no relay answers", async () => {
    const network = relayNetwork({}, [answering, down, index]);
    renderEditor(network);
    expect(await screen.findByRole("alert")).toHaveTextContent("The profile read failed.");
    expect(screen.queryByText(warning)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save profile" })).toBeEnabled());
    expect(screen.getByRole("alert")).toHaveTextContent("The profile read failed.");
    expect(network.publications).toEqual([]);
  });
});
