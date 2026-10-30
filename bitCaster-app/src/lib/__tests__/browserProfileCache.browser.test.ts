import { afterEach, beforeEach, expect, it } from "vitest";
import { finalizeEvent } from "nostr-tools/pure";
import {
  prepareNostrProfileEdit,
  readNostrProfileEditSnapshot,
  selectNostrProfileEditBase,
} from "@bitcaster/client-sdk/nostrProfile";

const tabs: Window[] = [];
const key = new Uint8Array(32).fill(1);
const original = finalizeEvent(
  { kind: 0, created_at: 10, tags: [], content: '{"name":"Original","custom":{"keep":true}}' },
  key,
);
const saved = finalizeEvent(
  {
    kind: 0,
    created_at: 20,
    tags: [],
    content: '{"name":"Saved","display_name":"Keep display","custom":{"keep":true,"new":7}}',
  },
  key,
);

beforeEach(() => localStorage.clear());
afterEach(() => {
  for (const tab of tabs.splice(0)) tab.close();
});

async function openProfileTab() {
  const tab = window.open("about:blank", "_blank");
  if (!tab) throw new Error("Independent profile tab is unavailable.");
  tabs.push(tab);
  const module = await new Promise<typeof import("../browserProfileCache")>((resolve, reject) => {
    const target = tab as Window & {
      profileLoaded?: (module: typeof import("../browserProfileCache")) => void;
      profileFailed?: () => void;
    };
    target.profileLoaded = resolve;
    target.profileFailed = () => reject(new Error("Independent profile module is unavailable."));
    const script = tab.document.createElement("script");
    script.type = "module";
    script.textContent = `import(${JSON.stringify(`${location.origin}/src/lib/browserProfileCache.ts`)}).then(window.profileLoaded, window.profileFailed)`;
    tab.document.head.append(script);
  });
  return { tab, module };
}

it("serializes two browsing contexts through retention and preserves the saved base over stale relay replies", async () => {
  const a = await openProfileTab();
  const b = await openProfileTab();
  let release!: () => void;
  let entered!: () => void;
  const holding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const firstEdit = a.module.withBrowserProfileEditSession(saved.pubkey, async (session) => {
    entered();
    await holding;
    session.retain(saved);
  });
  await admitted;
  let secondEntered = false;
  const secondEdit = b.module.withBrowserProfileEditSession(saved.pubkey, async (session) => {
    secondEntered = true;
    const stale = await readNostrProfileEditSnapshot(
      saved.pubkey,
      ["wss://fixture.example"],
      async (_, __, receive) => receive(original),
    );
    const base = selectNostrProfileEditBase(saved.pubkey, stale, session.read());
    const updated = finalizeEvent(
      prepareNostrProfileEdit(saved.pubkey, base, { about: "Second edit" }, 21),
      key,
    );
    session.retain(updated);
  });
  try {
    await expect
      .poll(async () =>
        (await navigator.locks.query()).pending?.some(
          (lock) => lock.name === `bitcaster:nostr-profile:${saved.pubkey}`,
        ),
      )
      .toBe(true);
    expect(secondEntered).toBe(false);
  } finally {
    release();
  }
  await Promise.all([firstEdit, secondEdit]);
  a.tab.localStorage.setItem(
    "bitcaster-settings",
    JSON.stringify({ state: { nostrProfile: null } }),
  );
  a.tab.close();
  b.tab.close();
  const fresh = await openProfileTab();
  await fresh.module.withBrowserProfileEditSession(saved.pubkey, async (session) => {
    const record = session.read()!;
    expect(JSON.parse(record.content)).toEqual({
      name: "Saved",
      display_name: "Keep display",
      custom: { keep: true, new: 7 },
      about: "Second edit",
    });
  });
});
