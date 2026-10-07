import type { OracleBackupScanCursor } from "@bitcaster/client-sdk/oracleBackupAccess";
import { decodePrivateNostrSignerKey } from "@bitcaster/client-sdk";
import { useSettingsStore } from "@/stores/settings";
import { browserOracleOwnerAuthority, useCreatorMarketsStore } from "@/stores/creatorMarkets";
import { assertNever } from "./enumDiscipline";
import { effectiveRelayUrls } from "./relayDefaults";
import { getNostrSignerRevision, subscribeToNostrSignerRevision } from "./nostrSignerRevision";
import { browserOracleAuthorityReadiness } from "./browserOracleBackup";
import { listBrowserOracleBackups, restoreBrowserOracleBackup } from "./browserOracleBackupAccess";
import { deliverBrowserOracleBackup } from "./browserOracleBackupDelivery";

const PAGE_LIMIT = 4;
const OWNER_PAGE_SIZE = 20;
export interface BrowserOracleRecoveryCheckpoint {
  ownerOffset: number;
  cursor: OracleBackupScanCursor | null;
  ownersComplete?: boolean;
  discoveryComplete?: boolean;
}
export interface BrowserOracleRecoveryPass {
  publicKey: string;
  relayUrls: readonly string[];
  signal: AbortSignal;
  requireCurrent(): void;
}
const defaultAdapters = {
  owners: () => useCreatorMarketsStore.getState().readOracleOwners(),
  readiness: (id: string, requireCurrent?: () => void) =>
    browserOracleAuthorityReadiness(id, useCreatorMarketsStore, requireCurrent),
  deliver: deliverBrowserOracleBackup,
  list: listBrowserOracleBackups,
  restore: restoreBrowserOracleBackup,
};

/** Each batch has a fixed budget. Yield before continuing a progressing cursor. */
export async function runBrowserOracleRecoveryPass(
  pass: BrowserOracleRecoveryPass,
  checkpoint: BrowserOracleRecoveryCheckpoint,
  adapters = defaultAdapters,
): Promise<boolean> {
  pass.requireCurrent();
  const owners = checkpoint.ownersComplete ? [] : await adapters.owners();
  pass.requireCurrent();
  const end = Math.min(owners.length, checkpoint.ownerOffset + PAGE_LIMIT * OWNER_PAGE_SIZE);
  for (let index = checkpoint.ownerOffset; index < end; index++) {
    pass.requireCurrent();
    const owner = owners[index];
    const { binding, destinations } = browserOracleOwnerAuthority(owner);
    if (binding.oraclePubkey !== pass.publicKey || !destinations) continue;
    // Retained public retry is independent of private readiness. Its saved destinations remain fixed.
    let saved;
    switch (owner.kind) {
      case "created":
        saved = owner.market.oracle?.backupDelivery;
        break;
      case "imported":
        saved = owner.oracle.backupDelivery;
        break;
      default:
        return assertNever(owner);
    }
    const readiness = saved?.current
      ? "ready"
      : await adapters.readiness(binding.conditionId, pass.requireCurrent);
    pass.requireCurrent();
    if (readiness === "ready") {
      try {
        await adapters.deliver(binding.conditionId, { requireCurrent: pass.requireCurrent });
      } catch {
        pass.requireCurrent();
        // One owner's refused delivery must not block authenticated restoration for another.
      }
      pass.requireCurrent();
    }
  }
  if (!checkpoint.ownersComplete) {
    checkpoint.ownerOffset = end;
    checkpoint.ownersComplete = end >= owners.length;
  }
  if (!pass.relayUrls.length) checkpoint.discoveryComplete = true;
  if (checkpoint.discoveryComplete) return !checkpoint.ownersComplete;
  const options = {
    relayUrls: pass.relayUrls,
    signal: pass.signal,
    requireCurrent: pass.requireCurrent,
  };
  for (let page = 0; page < PAGE_LIMIT; page++) {
    pass.requireCurrent();
    const previous = checkpoint.cursor;
    const result = await adapters.list(previous, options);
    pass.requireCurrent();
    // observedRelayComplete means the relay history is exhausted, not that this page reached EOSE.
    // The SDK marks failed/incomplete requests in partialReasons and retains their cursor.
    if (result.partialReasons.some((reason) => reason !== "relay-dependent-history")) {
      checkpoint.discoveryComplete = true;
      return !checkpoint.ownersComplete;
    }
    for (const descriptor of result.descriptors) {
      pass.requireCurrent();
      const readiness = await adapters.readiness(descriptor.conditionId, pass.requireCurrent);
      pass.requireCurrent();
      switch (readiness) {
        case "ready":
          break;
        case "needs-restore":
          await adapters.restore(descriptor.backupEventId, descriptor.sourceRelay, options);
          pass.requireCurrent();
          break;
        case "unavailable":
          // Corruption, key conflict, and failed reads are never permission to overwrite.
          checkpoint.discoveryComplete = true;
          return !checkpoint.ownersComplete;
        default:
          return assertNever(readiness);
      }
    }
    const next = result.cursor;
    if (!next || JSON.stringify(next) === JSON.stringify(previous)) {
      checkpoint.cursor = next;
      checkpoint.discoveryComplete = true;
      return !checkpoint.ownersComplete;
    }
    checkpoint.cursor = next;
  }
  return true;
}

export interface BrowserOracleRecoveryDriverOptions {
  runPass?: (
    pass: BrowserOracleRecoveryPass,
    checkpoint: BrowserOracleRecoveryCheckpoint,
  ) => Promise<boolean | void>;
}

/** One root-owned driver. Store updates do not schedule scans unless eligibility changes. */
export function startBrowserOracleRecovery(options: BrowserOracleRecoveryDriverOptions = {}) {
  let disposed = false;
  let generation = 0;
  let running = false;
  let queued = false;
  let scheduled = false;
  let externalWake = false;
  let scheduledTimer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let checkpoint: BrowserOracleRecoveryCheckpoint = { ownerOffset: 0, cursor: null };
  const scope = () => {
    const settings = useSettingsStore.getState();
    return JSON.stringify([
      settings.nostrSignerMode,
      settings.nsecSecret,
      getNostrSignerRevision(),
      effectiveRelayUrls(settings.relays),
    ]);
  };
  let selectedScope = scope();
  const schedule = () => {
    if (disposed || scheduled || running || !queued) return;
    scheduled = true;
    scheduledTimer = setTimeout(() => {
      scheduled = false;
      void drain();
    }, 0);
  };
  const wake = () => {
    if (disposed) return;
    externalWake = true;
    queued = true;
    schedule();
  };
  const changed = () => {
    const next = scope();
    if (next === selectedScope) return;
    selectedScope = next;
    generation++;
    controller?.abort();
    checkpoint = { ownerOffset: 0, cursor: null };
    wake();
  };
  const drain = async () => {
    if (running || disposed || !queued) return;
    queued = false;
    const settings = useSettingsStore.getState();
    if (settings.nostrSignerMode !== "nsec") return;
    let identity: ReturnType<typeof decodePrivateNostrSignerKey>;
    try {
      identity = decodePrivateNostrSignerKey(settings.nsecSecret ?? "");
    } catch {
      return;
    }
    running = true;
    const observed = generation;
    if (externalWake) {
      checkpoint = {
        ownerOffset: checkpoint.ownersComplete ? 0 : checkpoint.ownerOffset,
        ownersComplete: false,
        cursor: checkpoint.cursor,
        discoveryComplete: false,
      };
      externalWake = false;
    }
    const capturedCheckpoint = checkpoint;
    const capturedController = new AbortController();
    controller = capturedController;
    const requireCurrent = () => {
      if (disposed || observed !== generation || capturedController.signal.aborted)
        throw new Error("Oracle recovery identity changed.");
    };
    try {
      if (!useCreatorMarketsStore.persist.hasHydrated())
        await useCreatorMarketsStore.persist.rehydrate();
      requireCurrent();
      const continues = await (options.runPass ?? runBrowserOracleRecoveryPass)(
        {
          publicKey: identity.publicKeyHex,
          relayUrls: effectiveRelayUrls(settings.relays),
          signal: capturedController.signal,
          requireCurrent,
        },
        capturedCheckpoint,
      );
      requireCurrent();
      if (continues) queued = true;
    } catch {
      // Original durable preparation and delivery failures remain available in Creator.
      // Retry only on a new readiness/reconnect wake, never in a failure loop.
    } finally {
      running = false;
      if (controller === capturedController) controller = null;
      schedule();
    }
  };
  const unsubscribeSettings = useSettingsStore.subscribe(changed);
  const unsubscribeSigner = subscribeToNostrSignerRevision(changed);
  globalThis.addEventListener("online", wake);
  wake();
  return () => {
    disposed = true;
    generation++;
    controller?.abort();
    if (scheduledTimer !== undefined) clearTimeout(scheduledTimer);
    unsubscribeSettings();
    unsubscribeSigner();
    globalThis.removeEventListener("online", wake);
  };
}
