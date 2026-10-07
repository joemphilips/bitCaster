import type NDK from "@nostr-dev-kit/ndk";
import type { NDKSigner } from "@nostr-dev-kit/ndk";
import { getEventHash, type Event, type EventTemplate } from "nostr-tools/pure";
import {
  decodeNostrProfileEvent,
  prepareNostrProfileEdit,
  readNostrProfile,
  readNostrProfileEditSnapshot,
  selectNostrProfileEditBase,
  signNostrProfileEdit,
  validateNostrProfilePatch,
  type NostrProfilePatch,
} from "@bitcaster/client-sdk/nostrProfile";
import { useSettingsStore } from "@/stores/settings";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "./nostrSignerRevision";
import { awaitAbortable } from "@bitcaster/client-sdk/engineClient";
import { effectiveRelayUrls } from "./relayDefaults";
import { withBrowserProfileEditSession } from "./browserProfileCache";
import { queryBrowserProfileRelay, publishBrowserProfileRelay } from "./browserProfileRelay";

export type BrowserProfileErrorCode =
  | "unavailable"
  | "read-failed"
  | "base-unavailable"
  | "invalid-input"
  | "signing-failed"
  | "selection-changed"
  | "cancelled"
  | "cache-unavailable";

export class BrowserProfileError extends Error {
  constructor(readonly code: BrowserProfileErrorCode) {
    super("Nostr profile operation could not complete.");
  }
}

export interface BrowserNostrProfileOptions {
  readonly getNdk?: () => NDK;
  readonly websocketImplementation?: typeof WebSocket;
  readonly withSession?: typeof withBrowserProfileEditSession;
  readonly nowSeconds?: () => number;
  readonly readTimeoutMs?: number;
  readonly publishTimeoutMs?: number;
}

export interface BrowserProfileSelection {
  readonly publicKey: string;
  readonly signer: NDKSigner;
  readonly relays: readonly string[];
  readonly signal: AbortSignal;
  requireCurrent(): void;
  dispose(): void;
}

export async function captureBrowserNostrProfileSelection(
  options: BrowserNostrProfileOptions = {},
  signal?: AbortSignal,
): Promise<BrowserProfileSelection> {
  const initial = useSettingsStore.getState();
  const mode = initial.nostrSignerMode,
    secret = initial.nsecSecret;
  const revision = getNostrSignerRevision();
  const relays = effectiveRelayUrls(initial.relays),
    relayKey = JSON.stringify(relays);
  let invalidated = false;
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const invalidate = () => {
    invalidated = true;
    abort();
  };
  const unsubscribeRevision = subscribeToNostrSignerRevision(invalidate);
  const unsubscribe = useSettingsStore.subscribe((current, previous) => {
    if (
      current.nostrSignerMode !== previous.nostrSignerMode ||
      current.nsecSecret !== previous.nsecSecret ||
      JSON.stringify(effectiveRelayUrls(current.relays)) !== relayKey
    )
      invalidate();
  });
  const dispose = () => {
    unsubscribe();
    unsubscribeRevision();
    signal?.removeEventListener("abort", abort);
  };
  let ndk: NDK | undefined, signer: NDKSigner | undefined;
  const requireCurrent = () => {
    if (signal?.aborted) throw new BrowserProfileError("cancelled");
    const current = useSettingsStore.getState();
    if (
      invalidated ||
      getNostrSignerRevision() !== revision ||
      current.nostrSignerMode !== mode ||
      current.nsecSecret !== secret ||
      JSON.stringify(effectiveRelayUrls(current.relays)) !== relayKey ||
      (ndk && ndk.signer !== signer)
    )
      throw new BrowserProfileError("selection-changed");
  };
  try {
    requireCurrent();
    if (mode === "none") throw new BrowserProfileError("unavailable");
    ndk = options.getNdk?.() ?? (await import("./nostr")).getNdk();
    signer = ndk.signer;
    requireCurrent();
    if (!signer) throw new BrowserProfileError("unavailable");
    const user = await awaitAbortable(signer.user(), lifetime.signal);
    requireCurrent();
    if (!/^[0-9a-f]{64}$/.test(user.pubkey)) throw new BrowserProfileError("unavailable");
    return {
      publicKey: user.pubkey,
      signer,
      relays,
      signal: lifetime.signal,
      requireCurrent,
      dispose,
    };
  } catch (error) {
    dispose();
    requireCurrent();
    throw error instanceof BrowserProfileError ? error : new BrowserProfileError("unavailable");
  }
}

function profileQuery(selection: BrowserProfileSelection, options: BrowserNostrProfileOptions) {
  return (
    url: string,
    filter: Parameters<typeof queryBrowserProfileRelay>[1],
    onEvent: (event: Event) => void,
  ) =>
    queryBrowserProfileRelay(url, filter, onEvent, {
      ...selection,
      websocketImplementation: options.websocketImplementation,
      timeoutMs: options.readTimeoutMs,
    });
}

export function readBrowserSignerProfile(
  selection: BrowserProfileSelection,
  options: BrowserNostrProfileOptions = {},
) {
  selection.requireCurrent();
  return readNostrProfile(selection.publicKey, selection.relays, profileQuery(selection, options));
}

async function editBase(
  selection: BrowserProfileSelection,
  retained: Event | null,
  options: BrowserNostrProfileOptions,
) {
  selection.requireCurrent();
  let snapshot;
  try {
    snapshot = await readNostrProfileEditSnapshot(
      selection.publicKey,
      selection.relays,
      profileQuery(selection, options),
    );
  } catch {
    selection.requireCurrent();
    throw new BrowserProfileError("read-failed");
  }
  selection.requireCurrent();
  try {
    return selectNostrProfileEditBase(selection.publicKey, snapshot, retained);
  } catch {
    throw new BrowserProfileError("base-unavailable");
  }
}

export interface BrowserProfileEditView {
  readonly publicKey: string;
  readonly fields: { readonly name: string; readonly about: string; readonly picture: string };
}

export async function loadBrowserNostrProfileEdit(
  signal?: AbortSignal,
  options: BrowserNostrProfileOptions = {},
): Promise<BrowserProfileEditView> {
  const selection = await captureBrowserNostrProfileSelection(options, signal);
  try {
    return await (options.withSession ?? withBrowserProfileEditSession)(
      selection.publicKey,
      async (session) => {
        selection.requireCurrent();
        const base = await editBase(selection, session.read(), options);
        const metadata = JSON.parse(base?.content ?? "{}") as Record<string, unknown>;
        const text = (key: string) =>
          typeof metadata[key] === "string" ? (metadata[key] as string) : "";
        return {
          publicKey: selection.publicKey,
          fields: { name: text("name"), about: text("about"), picture: text("picture") },
        };
      },
      selection.signal,
    );
  } catch (error) {
    selection.requireCurrent();
    throw error instanceof BrowserProfileError
      ? error
      : new BrowserProfileError("cache-unavailable");
  } finally {
    selection.dispose();
  }
}

export interface BrowserProfileSaveResult {
  readonly publicKey: string;
  readonly status:
    | "saved"
    | "not-acknowledged"
    | "published-retention-failed"
    | "selection-changed"
    | "cancelled";
  readonly event: Event;
  readonly published: boolean;
  readonly retained: boolean;
  readonly acceptedRelays: readonly string[];
  readonly rejectedRelays: readonly string[];
  readonly unacknowledgedRelays: readonly string[];
  readonly unsentRelays: readonly string[];
}

async function signProfile(
  selection: BrowserProfileSelection,
  template: EventTemplate,
): Promise<Event> {
  selection.requireCurrent();
  try {
    return await signNostrProfileEdit(selection.publicKey, template, async (request) => {
      selection.requireCurrent();
      const unsigned = { ...request, pubkey: selection.publicKey };
      const id = getEventHash(unsigned);
      const sig = await awaitAbortable(selection.signer.sign(unsigned), selection.signal);
      return { ...unsigned, id, sig };
    });
  } catch {
    selection.requireCurrent();
    throw new BrowserProfileError("signing-failed");
  }
}

async function deliverProfile(
  selection: BrowserProfileSelection,
  event: Event,
  options: BrowserNostrProfileOptions,
) {
  const acceptedRelays: string[] = [],
    rejectedRelays: string[] = [],
    unacknowledgedRelays: string[] = [],
    unsentRelays: string[] = [];
  for (const url of selection.relays) {
    const status = await publishBrowserProfileRelay(url, event, {
      ...selection,
      websocketImplementation: options.websocketImplementation,
      timeoutMs: options.publishTimeoutMs,
    });
    switch (status) {
      case "accepted":
        acceptedRelays.push(url);
        break;
      case "rejected":
        rejectedRelays.push(url);
        break;
      case "unacknowledged":
        unacknowledgedRelays.push(url);
        break;
      case "unsent":
        unsentRelays.push(url);
        break;
    }
  }
  return { acceptedRelays, rejectedRelays, unacknowledgedRelays, unsentRelays };
}

export async function saveBrowserNostrProfileEdit(
  value: NostrProfilePatch,
  signal?: AbortSignal,
  options: BrowserNostrProfileOptions = {},
): Promise<BrowserProfileSaveResult> {
  let patch: NostrProfilePatch;
  try {
    patch = validateNostrProfilePatch(value);
  } catch {
    throw new BrowserProfileError("invalid-input");
  }
  const selection = await captureBrowserNostrProfileSelection(options, signal);
  try {
    return await (options.withSession ?? withBrowserProfileEditSession)(
      selection.publicKey,
      (session) => saveInSession(selection, patch, options, session),
      selection.signal,
    );
  } catch (error) {
    selection.requireCurrent();
    throw error instanceof BrowserProfileError
      ? error
      : new BrowserProfileError("cache-unavailable");
  } finally {
    selection.dispose();
  }
}

type ProfileEditSession = Parameters<Parameters<typeof withBrowserProfileEditSession>[1]>[0];
type ProfileDelivery = Pick<
  BrowserProfileSaveResult,
  "acceptedRelays" | "rejectedRelays" | "unacknowledgedRelays" | "unsentRelays"
>;

async function saveInSession(
  selection: BrowserProfileSelection,
  patch: NostrProfilePatch,
  options: BrowserNostrProfileOptions,
  session: ProfileEditSession,
): Promise<BrowserProfileSaveResult> {
  selection.requireCurrent();
  const base = await editBase(selection, session.read(), options);
  let template: EventTemplate;
  try {
    template = prepareNostrProfileEdit(
      selection.publicKey,
      base,
      patch,
      (options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))(),
    );
  } catch {
    throw new BrowserProfileError("invalid-input");
  }
  const event = await signProfile(selection, template);
  const delivery = await deliverProfile(selection, event, options);
  const published = delivery.acceptedRelays.length > 0;
  if (published) {
    try {
      session.retain(event);
    } catch {
      return {
        publicKey: selection.publicKey,
        event,
        status: "published-retention-failed",
        published,
        retained: false,
        ...delivery,
      };
    }
  }
  return finishProfileSave(selection, event, delivery, published);
}

function finishProfileSave(
  selection: BrowserProfileSelection,
  event: Event,
  delivery: ProfileDelivery,
  retained: boolean,
): BrowserProfileSaveResult {
  let changed: "selection-changed" | "cancelled" | null = null;
  try {
    selection.requireCurrent();
  } catch (error) {
    changed =
      error instanceof BrowserProfileError && error.code === "cancelled"
        ? "cancelled"
        : "selection-changed";
  }
  if (!changed && retained) {
    try {
      useSettingsStore
        .getState()
        .setProfile(decodeNostrProfileEvent(event, selection.publicKey), "found");
    } catch {
      /* The dedicated signed record is durable even if the display cache write fails. */
    }
  }
  return {
    publicKey: selection.publicKey,
    event,
    status: changed ?? (retained ? "saved" : "not-acknowledged"),
    published: delivery.acceptedRelays.length > 0,
    retained,
    ...delivery,
  };
}
