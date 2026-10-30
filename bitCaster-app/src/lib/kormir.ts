/** Browser oracle preparation uses captured local authority under the creator document lock. */
import type {
  Kormir as KormirType,
  Announcement as KormirAnnouncement,
  Attestation as KormirAttestation,
} from "./kormir-wasm-pkg/kormir_wasm";
import {
  normalizeOracleAnnouncementTags,
  decodePrivateNostrSignerKey,
  OracleBackupError,
  type OracleBackupValidator,
} from "@bitcaster/client-sdk";
import { OracleBackupDeliveryError } from "@bitcaster/client-sdk/oracleBackupDelivery";
import { hexToBytes } from "nostr-tools/utils";
import { useSettingsStore } from "@/stores/settings";
import { getNostrSignerRevision } from "./nostrSignerRevision";
import { withCreatorDocumentLock } from "./browserCreatorDocumentLock";

export type Kormir = KormirType;
export type { KormirAnnouncement, KormirAttestation };
export type PreparedOracleArtifact = { artifactHex: string; eventJson: string };

/** Validate private authority without constructing an oracle or changing IndexedDB. */
export const browserOracleBackupValidator: OracleBackupValidator = {
  async validateAuthority(privateDtoJson, expectedOraclePubkey) {
    try {
      const module = await loadKormirModule();
      return JSON.parse(
        module.Kormir.validate_enum_authority(privateDtoJson, expectedOraclePubkey),
      );
    } catch {
      // The WASM input contains private authority. Do not expose nested errors.
      throw new OracleBackupError("invalid-record");
    }
  },
};

export async function decodeOracleAnnouncement(artifactHex: string) {
  const module = await loadKormirModule();
  const value = await module.Kormir.decode_announcement(artifactHex);
  try {
    return {
      eventId: value.event_id,
      oraclePubkey: normalizeKormirPublicKey(value.oracle_public_key),
      outcomes: [...value.outcomes],
      noncePoints: [...value.oracle_nonces],
      announcementSignature: value.announcement_signature,
    };
  } finally {
    value.free();
  }
}

export async function decodeOracleAttestation(artifactHex: string) {
  const module = await loadKormirModule();
  const value = await module.Kormir.decode_attestation(artifactHex);
  try {
    return {
      eventId: value.event_id,
      oraclePubkey: normalizeKormirPublicKey(value.oracle_public_key),
      outcomes: [...value.outcomes],
      signatures: [...value.signatures],
    };
  } finally {
    value.free();
  }
}

type KormirModule = typeof import("./kormir-wasm-pkg/kormir_wasm");
let modulePromise: Promise<KormirModule> | null = null;
let identityGeneration = 0;
useSettingsStore.subscribe((current, previous) => {
  if (
    current.nostrSignerMode !== previous.nostrSignerMode ||
    current.nsecSecret !== previous.nsecSecret
  )
    identityGeneration += 1;
});

export function __setKormirModuleForTest(mod: KormirModule | null): void {
  modulePromise = mod ? Promise.resolve(mod) : null;
  identityGeneration += 1;
}

async function loadKormirModule(): Promise<KormirModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const mod = await import("./kormir-wasm-pkg/kormir_wasm");
      await mod.default();
      return mod;
    })().catch(() => {
      modulePromise = null;
      throw new BrowserOracleMutationError("authority-unavailable");
    });
  }
  return modulePromise;
}

/** Login stages identity changes without loading WASM or writing oracle authority. */
export function setPendingKormirNsec(_nsec: string | null): void {
  identityGeneration += 1;
}

/** Reset invalidates captured admissions; it does not remove retained oracle data. */
export function resetKormir(): void {
  identityGeneration += 1;
}

export class BrowserOracleMutationError extends Error {
  constructor(
    readonly reason:
      | "identity-unavailable"
      | "identity-changed"
      | "authority-unavailable"
      | "key-conflict"
      | "import-incomplete"
      | "expired",
  ) {
    super(
      reason === "import-incomplete"
        ? "Complete the oracle backup import before signing."
        : reason === "key-conflict"
          ? "The retained local oracle data was preserved. Use the original oracle key where available."
          : reason === "authority-unavailable"
            ? "Local oracle data is unavailable. Retry recovery without changing the oracle outcome."
            : reason === "expired"
              ? "The local oracle mutation has expired."
              : reason === "identity-changed"
                ? "The oracle identity changed. Retry with the original oracle key."
                : "Use the original local oracle key to prepare this operation.",
    );
  }
}

/** Capture before async work. Loading WASM happens before document lock admission. */
export async function prepareBrowserOracleMutation(expectedPubkey?: string) {
  const settings = useSettingsStore.getState();
  let identity: ReturnType<typeof decodePrivateNostrSignerKey>;
  try {
    identity = decodePrivateNostrSignerKey(settings.nsecSecret ?? "");
  } catch {
    throw new BrowserOracleMutationError("identity-unavailable");
  }
  if (
    settings.nostrSignerMode !== "nsec" ||
    (expectedPubkey !== undefined && identity.publicKeyHex !== expectedPubkey)
  )
    throw new BrowserOracleMutationError("identity-unavailable");
  const capturedKey = settings.nsecSecret!;
  const generation = identityGeneration;
  const signerRevision = getNostrSignerRevision();
  const isCurrent = () =>
    generation === identityGeneration && signerRevision === getNostrSignerRevision();
  const requireCurrent = () => {
    if (!isCurrent()) throw new BrowserOracleMutationError("identity-changed");
  };
  const module = await loadKormirModule();
  let used = false;
  return {
    publicKey: identity.publicKeyHex,
    isCurrent,
    requireCurrent,
    /** The caller already owns the creator document lock. Do not reacquire it here. */
    async withCoreLocked<T>(
      action: (core: Kormir, privateKey: Uint8Array) => Promise<T>,
    ): Promise<T> {
      requireCurrent();
      if (used) throw new BrowserOracleMutationError("expired");
      used = true;
      let core: Kormir | undefined;
      let active = true;
      try {
        // Restore is guarded by the provider. Construction must read the actual stored key.
        await module.Kormir.restore(capturedKey);
        core = await module.Kormir.new([]);
        if (normalizeKormirPublicKey(core.get_public_key()) !== identity.publicKeyHex)
          throw new BrowserOracleMutationError("authority-unavailable");
        const admitted = new Proxy(core, {
          get(target, property) {
            const value = Reflect.get(target, property);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (!active) throw new BrowserOracleMutationError("expired");
              return value.apply(target, args);
            };
          },
        });
        return await action(admitted, hexToBytes(identity.secretKeyHex));
      } catch (error) {
        if (
          error instanceof BrowserOracleMutationError ||
          error instanceof OracleBackupError ||
          error instanceof OracleBackupDeliveryError
        )
          throw error;
        if (error === module.JsError.SigningKeyConflict)
          throw new BrowserOracleMutationError("key-conflict");
        throw new BrowserOracleMutationError("authority-unavailable");
      } finally {
        active = false;
        core?.free();
      }
    },
  };
}

export type BrowserOracleMutation = Awaited<ReturnType<typeof prepareBrowserOracleMutation>>;

/** Standalone preparation uses the same lock as creator-document handoff. */
export async function withBrowserOracleMutation<T>(
  expectedPubkey: string,
  action: (core: Kormir) => Promise<T>,
): Promise<T> {
  const admission = await prepareBrowserOracleMutation(expectedPubkey);
  const result = await withCreatorDocumentLock(() => admission.withCoreLocked(action));
  admission.requireCurrent();
  return result;
}

export async function prepareEnumAnnouncement(
  core: Kormir,
  eventId: string,
  outcomes: string[],
  maturityEpoch: number,
  title = eventId,
  description = title,
): Promise<PreparedOracleArtifact> {
  const tags = normalizeOracleAnnouncementTags(title, description);
  const prepared = await core.prepare_enum_event(
    eventId,
    outcomes,
    maturityEpoch,
    tags.title,
    tags.description,
  );
  try {
    return { artifactHex: prepared.artifact_hex, eventJson: prepared.nostr_event_json };
  } finally {
    prepared.free();
  }
}

export async function prepareEnumAttestation(
  core: Kormir,
  eventId: string,
  outcome: string,
  announcementEventJson: string,
  announcementHex?: string,
): Promise<PreparedOracleArtifact> {
  if (announcementHex) await core.import_enum_event(announcementHex);
  const prepared = await core.prepare_enum_attestation(eventId, outcome, announcementEventJson);
  try {
    return { artifactHex: prepared.artifact_hex, eventJson: prepared.nostr_event_json };
  } finally {
    prepared.free();
  }
}

function normalizeKormirPublicKey(pubkey: string): string {
  const trimmed = pubkey.trim().toLowerCase();
  return /^(02|03)[0-9a-f]{64}$/.test(trimmed) ? trimmed.slice(2) : trimmed;
}
