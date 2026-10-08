import { useSettingsStore } from "@/stores/settings";
import { useWalletStore } from "@/stores/wallet";
import type { NostrSignerMode } from "@/types/settings";
import { generateSecretKey, nip19 } from "nostr-tools";
import { getPublicKey } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import {
  disconnectNostrSigner,
  hasInstalledNostrSigner,
  fetchAndStoreNostrProfile,
  loginWithExtension,
  loginWithNsec,
  loginWithNsecOrNcryptsec,
  rehydrateNostrSigner,
} from "@/lib/nostr";

import {
  beginNostrIdentityAttempt,
  captureNostrIdentityAttempt,
  type NostrIdentityAttempt,
} from "./nostrIdentityAttempt";
import type { NostrIdentityState } from "@/stores/settings";

export interface IdentityActionResult {
  superseded?: boolean;
  ok: boolean;
  error?: string;
}

export interface CreatorPubkeyInput {
  nostrSignerMode: NostrSignerMode;
  nsecSecret: string | null | undefined;
  nostrProfilePubkey?: string | null | undefined;
}

export interface NsecIdentity {
  privateKeyHex: string;
  publicKey: string;
}

let rehydratePromise: Promise<void> | null = null;

export function resolveCreatorPubkey(input: CreatorPubkeyInput): string | null {
  return resolveSignerPubkey(input);
}

function resolveSignerPubkey(input: CreatorPubkeyInput): string | null {
  if (input.nostrSignerMode === "nsec" && input.nsecSecret) {
    try {
      return nsecIdentity(input.nsecSecret).publicKey;
    } catch {
      return normalizePubkey(input.nostrProfilePubkey);
    }
  }

  if (input.nostrSignerMode === "nip07") {
    return normalizePubkey(input.nostrProfilePubkey);
  }

  return null;
}

export function resolveNsecIdentity(nsec: string | null | undefined): NsecIdentity | null {
  if (!nsec) return null;
  try {
    return nsecIdentity(nsec);
  } catch {
    return null;
  }
}

function nsecIdentity(nsec: string): NsecIdentity {
  const privateKey = privateKeyBytesFromNsec(nsec);
  return {
    privateKeyHex: bytesToHex(privateKey),
    publicKey: getPublicKey(privateKey),
  };
}

function privateKeyBytesFromNsec(nsec: string): Uint8Array {
  const trimmed = nsec.trim();
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") throw new Error("Expected an nsec private key");
    return decoded.data;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return hexToBytes(trimmed);
  }
  throw new Error("Expected an nsec1... or 64-character hex private key");
}

function normalizePubkey(pubkey: string | null | undefined): string | null {
  const normalized = pubkey?.trim().toLowerCase();
  return normalized && /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function waitForSettingsHydration(): Promise<void> {
  if (useSettingsStore.persist.hasHydrated()) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
  });
}

export function rehydratePersistedNostrIdentity(): Promise<void> {
  // Capture before hydration: a later explicit user action takes precedence.
  if (!rehydratePromise) {
    const attempt = captureNostrIdentityAttempt();
    rehydratePromise = waitForSettingsHydration().then(() => {
      if (attempt.isCurrent()) return rehydrateNostrSigner(attempt);
    });
  }
  return rehydratePromise;
}

export function disconnectNostrIdentity(): void {
  disconnectNostrSigner();
  useSettingsStore.getState().commitNostrIdentity({
    nostrSignerMode: "none",
    nsecSecret: null,
    signerSource: "none",
    signerBackupState: "none",
  });
}

export async function refreshNostrProfile(): Promise<void> {
  await fetchAndStoreNostrProfile();
}

async function connectIdentity(
  install: (
    attempt: NostrIdentityAttempt,
    commit: (nsec: string | null) => void,
  ) => Promise<unknown>,
  identity: Omit<NostrIdentityState, "nsecSecret">,
  error: string,
): Promise<IdentityActionResult> {
  const attempt = beginNostrIdentityAttempt();
  const settings = useSettingsStore.getState();
  settings.setSignerConnectionStatus("connecting");
  try {
    await install(attempt, (nsecSecret) => {
      attempt.requireCurrent();
      useSettingsStore.getState().commitNostrIdentity({ ...identity, nsecSecret });
    });
    if (!attempt.isCurrent()) return { ok: false, superseded: true };
    void refreshNostrProfile();
    return { ok: true };
  } catch {
    if (!attempt.isCurrent()) return { ok: false, superseded: true };
    // A refused replacement does not delete the previous key or provenance.
    useSettingsStore
      .getState()
      .setSignerConnectionStatus(hasInstalledNostrSigner() ? "connected" : "disconnected");
    return { ok: false, error };
  }
}

export async function userConnectNostrSignerMode(
  mode: NostrSignerMode,
): Promise<IdentityActionResult> {
  switch (mode) {
    case "nip07":
      return connectIdentity(
        (attempt, onCommit) => loginWithExtension({ attempt, onCommit }),
        { nostrSignerMode: "nip07", signerSource: "nip07", signerBackupState: "confirmed" },
        "Failed to connect with NIP-07 extension",
      );
    case "none":
      disconnectNostrIdentity();
      return { ok: true };
    case "nsec":
      return { ok: false, error: "A private key is required." };
    default:
      throw new Error("Unsupported signer mode.");
  }
}

export async function userConnectNsecIdentity(
  nsec: string,
  passphrase?: string,
): Promise<IdentityActionResult> {
  return connectIdentity(
    (attempt, onCommit) => loginWithNsecOrNcryptsec(nsec, passphrase, { attempt, onCommit }),
    { nostrSignerMode: "nsec", signerSource: "user-nsec", signerBackupState: "confirmed" },
    "Invalid private key or connection failed",
  );
}

export async function createGeneratedNostrIdentity(): Promise<IdentityActionResult> {
  return connectIdentity(
    (attempt, onCommit) =>
      loginWithNsec(nip19.nsecEncode(generateSecretKey()), { attempt, onCommit }),
    {
      nostrSignerMode: "nsec",
      signerSource: "implicit-generated",
      signerBackupState: "needs_backup",
    },
    "Failed to create Nostr key",
  );
}

export async function createImplicitWalletAndNostrIdentity(): Promise<IdentityActionResult> {
  const wallet = useWalletStore.getState();
  const attempt = captureNostrIdentityAttempt();
  try {
    await wallet.ensureImplicitWallet();
    if (!attempt.isCurrent()) return { ok: false, superseded: true };
    if (useSettingsStore.getState().nostrSignerMode === "none") {
      const result = await createGeneratedNostrIdentity();
      if (!result.ok) return result;
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Failed to create local wallet",
    };
  }
}
