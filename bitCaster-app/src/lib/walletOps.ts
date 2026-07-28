import { PaymentRequest, PaymentRequestTransportType, type Proof } from "@cashu/cashu-ts";
import { decodeToken, receiveAndStoreTokenRecoverably } from "@/lib/cashu";
import { deriveNostrKeyPair, getNostrNprofile } from "@/lib/nip17";
import { normalizeUrl } from "@/lib/url";
import { useSettingsStore } from "@/stores/settings";
import { useWalletStore, type StoredMint } from "@/stores/wallet";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  COLLATERAL_UNIT_REGISTRY,
  cashuAmountToMarketSubunits,
  type CashuProofUnit,
  type MarketBaseAsset,
} from "@bitcaster/client-sdk/marketUnits";
import {
  effectiveRelayUrls,
  isAllowedNostrRelayUrl,
  isKnownPublicNostrRelayUrl,
} from "@/lib/relayDefaults";
import { validateProductWalletTokenImport } from "@bitcaster/client-sdk/tokenImportValidation";
import { resolveTokenImportKeysets } from "@/lib/tokenImportKeysetResolver";
import { usePaymentRequestInbox } from "@/stores/paymentRequestInbox";

export type WalletIngressSource = "paste" | "scan" | "nip17";

export interface IngressMintRegistrationResult {
  added: boolean;
  mintUrl: string;
  source: WalletIngressSource;
}

export interface IngressReceiveCashuTokenResult extends IngressMintRegistrationResult {
  amountSubunits: number;
  baseAsset: MarketBaseAsset;
  unit: CashuProofUnit;
  proofs: Proof[];
}

export interface DecodedWalletPaymentRequest {
  request: PaymentRequest;
  source: WalletIngressSource;
}

export interface CreatedWalletPaymentRequest {
  encoded: string;
  id: string;
  request: PaymentRequest;
}

export function getActiveMint(): StoredMint | undefined {
  const store = useWalletStore.getState();
  return store.mints.find((m) => m.url === store.activeMintUrl);
}

export function getKnownMints(): StoredMint[] {
  return [...useWalletStore.getState().mints];
}

export async function userAddAndSelectMint(url: string): Promise<void> {
  await useWalletStore.getState()._addMint(url);
}

export async function refreshMintInfoWithoutActivating(url: string): Promise<void> {
  await useWalletStore.getState()._addMintWithoutActivating(url);
}

export function userSwitchActiveMint(url: string): void {
  useWalletStore.getState()._setActiveMint(url);
}

export function userRemoveMint(url: string): void {
  useWalletStore.getState()._removeMint(normalizeUrl(url));
}

export function normalizeRelayUrl(wssUrl: string): string {
  const trimmed = wssUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Relay URL must start with wss://");
  }
  if (parsed.protocol !== "wss:" && parsed.protocol !== "ws:") {
    throw new Error("Relay URL must start with wss:// or local ws://");
  }
  const normalized = trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
  if (isKnownPublicNostrRelayUrl(normalized)) {
    throw new Error("Public Nostr relays are not supported. Use a bitCaster-owned relay.");
  }
  if (!isAllowedNostrRelayUrl(normalized)) {
    throw new Error("Relay URL must be the configured bitCaster relay or a local relay.");
  }
  return normalized;
}

export function getRelayUrlValidationError(wssUrl: string): string | null {
  if (!wssUrl.trim()) return null;
  try {
    normalizeRelayUrl(wssUrl);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

export function userAddRelay(wssUrl: string): void {
  useSettingsStore.getState().addRelay(normalizeRelayUrl(wssUrl));
}

export function userRemoveRelay(wssUrl: string): void {
  const store = useSettingsStore.getState();
  store.removeRelay(wssUrl);
  const normalized = normalizeRelayUrl(wssUrl);
  if (normalized !== wssUrl) {
    store.removeRelay(normalized);
  }
}

export async function ingressRegisterMint(
  url: string,
  source: WalletIngressSource,
): Promise<IngressMintRegistrationResult> {
  const mintUrl = normalizeUrl(url);
  const store = useWalletStore.getState();
  if (store.mints.some((m) => m.url === mintUrl)) {
    return { added: false, mintUrl, source };
  }
  await store._addMintWithoutActivating(mintUrl);
  return { added: true, mintUrl, source };
}

export async function ingressReceiveCashuToken(
  token: string,
  source: WalletIngressSource,
  options?: { mintUrl?: string },
): Promise<IngressReceiveCashuTokenResult> {
  const validated = await validateProductWalletTokenImport({
    encodedToken: token,
    decode: decodeToken,
    resolveKeysets: resolveTokenImportKeysets,
    allowInsecureLoopbackHttp: isLocalDevelopmentOrigin(),
  });
  if (validated.canonicalMintUrls.length !== 1) {
    throw new Error("Wallet receive supports exactly one mint per Cashu token");
  }
  const validatedMintUrl = validated.canonicalMintUrls[0];
  if (!validatedMintUrl) throw new Error("Cashu token did not contain a mint");
  const mintUrl = options?.mintUrl ? normalizeUrl(options.mintUrl) : validatedMintUrl;
  if (mintUrl !== validatedMintUrl) throw new Error("Cashu token mint does not match the request");
  const unit = validated.unit;
  const baseAsset = COLLATERAL_UNIT_REGISTRY[unit].baseAsset;
  const registration = await ingressRegisterMint(mintUrl, source);
  const proofs = await receiveAndStoreTokenRecoverably(
    validated.encodedToken,
    mintUrl,
    baseAsset,
    unit,
  );
  return {
    ...registration,
    proofs,
    unit,
    baseAsset,
    amountSubunits: sumProofSubunits(proofs, unit),
  };
}

function isLocalDevelopmentOrigin(): boolean {
  return (
    import.meta.env.DEV ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1"
  );
}

export async function decodeWalletIngressToken(token: string) {
  return decodeToken(token);
}

function sumProofSubunits(proofs: Proof[], unit: CashuProofUnit): number {
  let total = 0;
  for (const proof of proofs) {
    total += cashuAmountToMarketSubunits(amountToNumber(proof.amount), unit);
    if (!Number.isSafeInteger(total)) {
      throw new Error(`Received Cashu amount exceeds safe integer range for ${unit}`);
    }
  }
  return total;
}

export async function ingressDecodePaymentRequest(
  text: string,
  source: WalletIngressSource,
): Promise<DecodedWalletPaymentRequest> {
  return {
    request: PaymentRequest.fromEncodedRequest(text),
    source,
  };
}

export function userCreatePaymentRequest(mintUrl: string): CreatedWalletPaymentRequest {
  const mnemonic = useWalletStore.getState().mnemonic;
  if (!mnemonic) {
    throw new Error("Wallet not set up");
  }

  const keyPair = deriveNostrKeyPair(mnemonic);
  const configuredRelays = effectiveRelayUrls(useSettingsStore.getState().relays);
  const nprofile = getNostrNprofile(
    keyPair.publicKey,
    configuredRelays.length > 0 ? configuredRelays : undefined,
  );

  // cashu-ts leaves the id undefined unless we provide one; the NIP-17 inbox
  // needs it echoed back by the payer to correlate the received token.
  const id = crypto.randomUUID().split("-")[0];
  const canonicalMintUrl = normalizeUrl(mintUrl);
  const request = new PaymentRequest(
    [
      {
        type: PaymentRequestTransportType.NOSTR,
        target: nprofile,
        tags: [["n", "17"]],
      },
    ],
    id,
    undefined,
    "sat",
    [canonicalMintUrl],
    undefined,
  );
  usePaymentRequestInbox.getState().registerPending(id, canonicalMintUrl);

  return {
    encoded: request.toEncodedRequest(),
    id,
    request,
  };
}
