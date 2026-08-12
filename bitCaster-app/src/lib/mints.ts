/**
 * Mint capability detection.
 *
 * The `/v1/info` response includes a `nuts` map keyed by NUT identifier
 * (numeric for standard NUTs, or a literal name for non-numbered NUTs).
 * NUT-CTF advertises itself under the literal `"CTF"` key in cdk-mintd
 * (see `cdk/crates/cashu/src/nuts/nut06.rs` — `#[serde(rename = "CTF")]`).
 *
 * This helper is pure so unit tests can pin the marker convention without
 * spinning up a live mint, and so the Settings UI can decide whether to
 * render the "Ecash only" badge solely from a `getInfo()` response shape.
 */

import {
  parseCtfSettingsFromMintInfo,
  type CtfRegistrationFeeSettings as CtfMintSettings,
} from "@bitcaster/client-sdk/ctfRegistration";

export interface MintCapabilities {
  /** Mint advertises NUT-CTF support (the conditional-token framework). */
  ctf: boolean;
  ctfSettings?: CtfMintSettings;
}

export function getMintIconUrl(
  mintUrl: string,
  info: Record<string, unknown> | undefined | null,
): string | undefined {
  const explicit =
    typeof info?.icon_url === "string"
      ? info.icon_url
      : typeof info?.iconUrl === "string"
        ? info.iconUrl
        : undefined;
  if (explicit) return explicit;
  try {
    return new URL("/favicon.ico", mintUrl).toString();
  } catch {
    return undefined;
  }
}

/**
 * Probe a mint's `/v1/info` response for known capabilities. Accepts either
 * a fully-typed cashu-ts response or the loosely-typed `Record<string, unknown>`
 * the wallet store persists, since the cashu-ts type definition does not
 * declare the "CTF" key.
 */
export function detectMintCapabilities(
  info: Record<string, unknown> | undefined | null,
): MintCapabilities {
  if (info == null) return { ctf: false };
  const nuts = info.nuts as Record<string, unknown> | undefined;
  if (nuts == null) return { ctf: false };
  const ctfRaw = nuts.CTF;
  const ctf =
    ctfRaw != null && typeof ctfRaw === "object" ? (ctfRaw as Record<string, unknown>) : undefined;
  return {
    ctf: ctfRaw != null,
    ctfSettings: ctf == null ? undefined : parseCtfSettings(ctf),
  };
}

function parseCtfSettings(ctf: Record<string, unknown>): CtfMintSettings | undefined {
  try {
    return parseCtfSettingsFromMintInfo({ nuts: { CTF: ctf } });
  } catch {
    return undefined;
  }
}
