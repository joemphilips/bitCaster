/**
 * cashu-ts wallet helpers for bitCaster.
 *
 * Responsibilities:
 *  - Initialize a CashuWallet connected to a configured mint
 *  - Provide typed helpers for CTF (Conditional Token Framework) operations
 *    as specified in NUT-CTF, NUT-CTF-split-merge, and NUT-CTF-numeric
 *  - Wrap common operations: mint, send, receive, melt
 */

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  getEncodedTokenV4,
  getDecodedToken,
  type Proof,
  type MintQuoteResponse,
  type MeltQuoteResponse,
  type PartialMintQuoteResponse,
  type Token,
} from "@cashu/cashu-ts";
import { useWalletStore } from "@/stores/wallet";
import { normalizeUrl } from "@/lib/url";

// ---------------------------------------------------------------------------
// Default mint (can be overridden at runtime)
// ---------------------------------------------------------------------------

const DEFAULT_MINT_URL = normalizeUrl(import.meta.env.VITE_MINT_URL ?? "http://localhost:8085");

/**
 * Small sats buffer added to top-up prefills to cover NUT-05 melt fees and
 * the counterparty's expected fee contribution during atomic-swap. Users can
 * raise this in the UI; the prefill just avoids the common case where the
 * user funds exactly `deficit` and then can't afford mint-side overhead.
 */
export const FEE_BUFFER_SATS = 10;

// ---------------------------------------------------------------------------
// Singleton wallet — delegates to wallet store when available
// ---------------------------------------------------------------------------

let _wallet: CashuWallet | null = null;
let _mintUrl: string = DEFAULT_MINT_URL;

/** Return the shared CashuWallet, initialising it lazily. */
export async function getWallet(mintUrl?: string): Promise<CashuWallet> {
  // If the wallet store has a mnemonic, delegate to it for deterministic secrets
  const store = useWalletStore.getState();
  if (store.mnemonic) {
    return store.getWallet(mintUrl);
  }

  // Fallback for pre-setup usage
  const url = mintUrl ?? _mintUrl;

  if (!_wallet || mintUrl !== _mintUrl) {
    _mintUrl = url;
    const mint = new CashuMint(url);
    _wallet = new CashuWallet(mint, { unit: "sat" });
    await _wallet.loadMint();
  }

  return _wallet;
}

// ---------------------------------------------------------------------------
// Basic wallet operations
// ---------------------------------------------------------------------------

/** Request a Lightning invoice to fund the wallet. */
export async function createMintQuote(
  amountSats: number,
  mintUrl?: string
): Promise<MintQuoteResponse> {
  const wallet = await getWallet(mintUrl);
  return wallet.createMintQuote(amountSats);
}

/** Mint proofs after the invoice in `quote` has been paid. */
export async function mintProofs(
  amountSats: number,
  quote: MintQuoteResponse,
  mintUrl?: string
): Promise<Proof[]> {
  const wallet = await getWallet(mintUrl);
  return wallet.mintProofs(amountSats, quote.quote);
}

/** Encode proofs as a cashuV4 token string ready to share. */
export function encodeToken(proofs: Proof[], mintUrl?: string): string {
  const token: Token = { mint: mintUrl ?? _mintUrl, proofs };
  return getEncodedTokenV4(token);
}

/** Decode a cashu token string into proofs.
 *  Fetches mint keyset IDs to expand v1 short keyset IDs when needed.
 *  Searches ALL configured mints' keysets (not just active) for cross-mint tokens. */
export async function decodeToken(tokenStr: string): Promise<Token> {
  // First try without keysets (works for v0 keyset IDs and full-length IDs)
  try {
    return getDecodedToken(tokenStr);
  } catch {
    // v1 short keyset IDs need expansion — try all configured mints' stored keysets first
    const store = useWalletStore.getState();
    const allStoredKeysetIds = store.mints
      .flatMap(m => m.keysets ?? [])
      .map(k => k.id);

    if (allStoredKeysetIds.length > 0) {
      try {
        return getDecodedToken(tokenStr, allStoredKeysetIds);
      } catch {
        // Fall through to fetch from active mint
      }
    }

    // P8 fix: a v4 cashuB token from an unconfigured mint (e.g. a testnut
    // token pasted from cashu.me) lands here. The active-mint fallback below
    // would fetch the WRONG keysets and throw "Couldn't map short keyset ID".
    // Pre-extract the mint URL from the v4 CBOR payload so we can fetch
    // keysets from the issuing mint.
    const mintFromToken = extractMintUrlFromV4Token(tokenStr);
    const mintUrl = mintFromToken ?? store.activeMintUrl ?? _mintUrl;
    const mint = new CashuMint(mintUrl);
    const { keysets } = await mint.getKeySets();
    const keysetIds = keysets.map(k => k.id);
    return getDecodedToken(tokenStr, keysetIds);
  }
}

/**
 * Extract the mint URL from a v4 cashuB token's CBOR payload without needing
 * keyset knowledge. Used as a pre-decode step so that a token issued by an
 * unconfigured mint (e.g. testnut.cashu.space pasted from cashu.me) can have
 * its keysets fetched directly rather than against the user's active mint —
 * which would otherwise throw "Couldn't map short keyset ID" and break the
 * receive flow. Returns null if the token isn't v4 or the parse fails.
 */
export function extractMintUrlFromV4Token(tokenStr: string): string | null {
  if (!tokenStr.startsWith("cashuB")) return null;
  try {
    const b64 = tokenStr.slice(6).replaceAll("-", "+").replaceAll("_", "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return walkCborForMintUrl(bytes);
  } catch {
    return null;
  }
}

// Minimal CBOR walker: read the top-level map and return the value of the
// "m" key (the v4 cashu mint-url field). Supports the small subset of CBOR
// that cashu v4 emits — see NUT-00 §3.2.
function walkCborForMintUrl(b: Uint8Array): string | null {
  if ((b[0] & 0xe0) !== 0xa0) return null; // top-level must be a map
  const [n, start] = readLen(b, 0);
  let i = start;
  for (let e = 0; e < n; e++) {
    const [key, j] = readString(b, i);
    if (key === "m") return readString(b, j)[0];
    i = skipValue(b, j);
  }
  return null;
}

function readLen(b: Uint8Array, i: number): [number, number] {
  const ai = b[i] & 0x1f;
  if (ai < 24) return [ai, i + 1];
  if (ai === 24) return [b[i + 1], i + 2];
  if (ai === 25) return [(b[i + 1] << 8) | b[i + 2], i + 3];
  if (ai === 26) return [((b[i + 1] << 24) | (b[i + 2] << 16) | (b[i + 3] << 8) | b[i + 4]) >>> 0, i + 5];
  throw new Error("CBOR len > uint32");
}

function readString(b: Uint8Array, i: number): [string, number] {
  const major = b[i] >> 5;
  if (major !== 3 && major !== 2) throw new Error("CBOR not string");
  const [len, j] = readLen(b, i);
  return [new TextDecoder().decode(b.slice(j, j + len)), j + len];
}

function skipValue(b: Uint8Array, i: number): number {
  const major = b[i] >> 5;
  if (major === 0 || major === 1 || major === 7) return readLen(b, i)[1];
  if (major === 2 || major === 3) { const [len, j] = readLen(b, i); return j + len; }
  if (major === 4) { const [n, j] = readLen(b, i); let p = j; for (let k = 0; k < n; k++) p = skipValue(b, p); return p; }
  if (major === 5) { const [n, j] = readLen(b, i); let p = j; for (let k = 0; k < n; k++) { p = skipValue(b, p); p = skipValue(b, p); } return p; }
  if (major === 6) return skipValue(b, readLen(b, i)[1]);
  throw new Error("CBOR major " + major);
}

/** Receive a cashu token string and return the redeemed proofs. */
export async function receiveToken(tokenStr: string, mintUrl?: string): Promise<Proof[]> {
  const wallet = await getWallet(mintUrl);
  return wallet.receive(tokenStr);
}

/**
 * Ensure `mintUrl` is registered in the wallet store before redeeming proofs
 * issued by it. Returns true when the mint was newly added, false when it was
 * already configured. Throws if `addMint` itself fails (network unreachable,
 * non-Cashu endpoint, etc.) — callers must surface the error to the user
 * rather than swallow it; otherwise the redeemed proofs would be orphaned.
 *
 * Mirrors the cashu.me parity behaviour the NIP-17 listener already relies
 * on: a token from an unconfigured mint silently mints under a synthetic
 * wallet (see `getWallet` fallback), and the resulting proofs never appear
 * in any UI surface because no `StoredMint` row exists to enumerate them.
 */
export async function ensureMintRegistered(mintUrl: string): Promise<boolean> {
  const normalized = normalizeUrl(mintUrl);
  const store = useWalletStore.getState();
  if (store.mints.some((m) => m.url === normalized)) return false;
  // P8 security review Finding 3: `addMint` retargets `activeMintUrl` as a
  // side effect. From an untrusted-input ingress (clipboard token, NIP-17
  // DM, scanned QR), that silently switches the user's wallet to an
  // attacker-chosen mint. Use the no-activate variant: register the mint so
  // proofs land somewhere the UI can enumerate, but leave the active mint
  // alone. The user can switch via Settings if they want.
  await store.addMintWithoutActivating(normalized);
  return true;
}

/**
 * Send `amountSats` using the provided proofs.
 * Returns `{ keep, send }` — store `keep` proofs, share `send` proofs.
 */
export async function sendProofs(
  amountSats: number,
  proofs: Proof[],
  mintUrl?: string
): Promise<{ keep: Proof[]; send: Proof[] }> {
  const wallet = await getWallet(mintUrl);
  return wallet.send(amountSats, proofs);
}

/** Create a melt quote for a Lightning invoice. */
export async function createMeltQuote(
  invoice: string,
  mintUrl?: string
): Promise<MeltQuoteResponse> {
  const wallet = await getWallet(mintUrl);
  return wallet.createMeltQuote(invoice);
}

/** Melt proofs to pay a Lightning invoice. */
export async function meltProofs(
  quote: MeltQuoteResponse,
  proofs: Proof[],
  mintUrl?: string
): Promise<{ paid: boolean; change: Proof[] }> {
  const wallet = await getWallet(mintUrl);
  const response = await wallet.meltProofs(quote, proofs);
  return {
    paid: response.quote.state === "PAID",
    change: response.change ?? [],
  };
}

/** Check the status of a mint quote. */
export async function checkMintQuote(
  quoteId: string,
  mintUrl?: string
): Promise<PartialMintQuoteResponse> {
  const wallet = await getWallet(mintUrl);
  return wallet.checkMintQuote(quoteId);
}

/**
 * Discriminated terminal result of `waitForMintQuotePaid`.
 *
 * - `PAID`    — the mint reported the bolt11 paid; caller should mint proofs.
 * - `EXPIRED` — the bolt11's `expiry` (unix-seconds) has passed; the quote is
 *               unrecoverable and the caller MUST request a new one.
 * - `ERROR`   — terminal poll failure (e.g. mint returned a non-recoverable
 *               error, or `ISSUED` arrived before we minted — see below).
 *
 * `ISSUED` from the mint is treated as terminal `ERROR`: it means the proofs
 * for this quote were already minted by some other client/session, and the
 * mint will refuse to issue them again. There is no recovery from inside this
 * helper — the caller surfaces the error and the user re-requests.
 */
export type MintQuoteWaitResult =
  | { status: "PAID"; quote: PartialMintQuoteResponse }
  | { status: "EXPIRED"; quote?: PartialMintQuoteResponse }
  | { status: "ERROR"; error: Error; quote?: PartialMintQuoteResponse };

export interface WaitForMintQuoteOptions {
  /** Bolt11 expiry as unix-seconds. Defaults to the quote's own `expiry`. */
  expiresAtSec?: number;
  /** Poll interval. Default 2s — short enough to mask <3s fakewallet latency. */
  pollIntervalMs?: number;
  /** Fired on each non-terminal poll error so the UI can surface diagnostics
   *  without tearing the wait down. */
  onTransientError?: (error: Error) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Subscribe to mint quote payment updates. Runs NUT-17 WS and polling
 * concurrently — whichever sees PAID first wins — so we don't hang when the
 * WS silently drops its subscription ACK (cashu-ts only registers the sub
 * listener *after* the ACK; if it never arrives, no error, no callback).
 *
 * Returns an unsubscribe function that tears down both paths AND the expiry
 * timer. The single `onResult` callback fires exactly once with a terminal
 * `MintQuoteWaitResult` (or never, if the caller unsubscribes first).
 *
 * Bounded by the bolt11's `expiry`: once that timestamp passes the wait
 * resolves to `EXPIRED` instead of polling forever — the bug behind P8's
 * "Waiting for payment…" forever symptom.
 */
export async function waitForMintQuotePaid(
  quote: MintQuoteResponse,
  onResult: (result: MintQuoteWaitResult) => void,
  options: WaitForMintQuoteOptions = {},
  mintUrl?: string
): Promise<() => void> {
  const wallet = await getWallet(mintUrl);
  const expiresAtSec = options.expiresAtSec ?? quote.expiry;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  let done = false;
  const isDone = () => done;
  const fire = (result: MintQuoteWaitResult) => {
    if (done) return;
    done = true;
    onResult(result);
  };

  const wsUnsub = subscribeWsForPaid(wallet, quote.quote, fire, isDone);
  const expiryTimer = scheduleExpiryTimer(expiresAtSec, fire);
  const pollHandle = startMintQuotePoll(wallet, quote.quote, pollIntervalMs, fire, isDone, options.onTransientError);

  return () => {
    done = true;
    pollHandle.cancel();
    if (expiryTimer) clearTimeout(expiryTimer);
    wsUnsub.cancel();
  };
}

/** Map a poll-observed MintQuoteState into a terminal result, or `null` if
 *  we should keep polling. Total mapping — a new upstream variant breaks
 *  compilation, not silently. */
function classifyPollState(q: PartialMintQuoteResponse): MintQuoteWaitResult | null {
  switch (q.state) {
    case "PAID":
      return { status: "PAID", quote: q };
    case "ISSUED":
      return {
        status: "ERROR",
        quote: q,
        error: new Error(
          "Mint reports quote already issued — proofs were minted elsewhere; request a new invoice."
        ),
      };
    case "UNPAID":
      return null;
    default:
      return assertNeverState(q.state);
  }
}

function startMintQuotePoll(
  wallet: CashuWallet,
  quoteId: string,
  intervalMs: number,
  fire: (r: MintQuoteWaitResult) => void,
  isDone: () => boolean,
  onTransientError?: (e: Error) => void
): { cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (isDone()) return;
    try {
      const q = await wallet.checkMintQuote(quoteId);
      const terminal = classifyPollState(q);
      if (terminal) { fire(terminal); return; }
    } catch (e) {
      onTransientError?.(e as Error);
    }
    if (!isDone()) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, intervalMs);
  return { cancel: () => { if (timer) clearTimeout(timer); } };
}

function subscribeWsForPaid(
  wallet: CashuWallet,
  quoteId: string,
  fire: (r: MintQuoteWaitResult) => void,
  isDone: () => boolean
): { cancel: () => void } {
  let unsub: (() => void) | null = null;
  wallet.on
    .mintQuotePaid(
      quoteId,
      (response: PartialMintQuoteResponse) =>
        fire({ status: "PAID", quote: response }),
      (error: Error) => {
        // Surface as a transient error — polling will continue and may still
        // resolve to PAID or EXPIRED. Don't fire a terminal ERROR on a WS hiccup.
        console.warn("[cashu] mintQuotePaid WS error", error);
      }
    )
    .then((u) => {
      if (isDone()) u();
      else unsub = u;
    })
    .catch((e) => {
      console.warn("[cashu] mintQuotePaid WS subscribe failed, polling only", e);
    });
  return { cancel: () => unsub?.() };
}

function scheduleExpiryTimer(
  expiresAtSec: number | undefined,
  fire: (r: MintQuoteWaitResult) => void
): ReturnType<typeof setTimeout> | null {
  if (!expiresAtSec || !Number.isFinite(expiresAtSec)) return null;
  const msUntilExpiry = expiresAtSec * 1000 - Date.now();
  if (msUntilExpiry <= 0) {
    // Already expired at call time — fire on next tick so the caller's
    // returned-unsub handle is set before the callback runs.
    return setTimeout(() => fire({ status: "EXPIRED" }), 0);
  }
  return setTimeout(() => fire({ status: "EXPIRED" }), msUntilExpiry);
}

function assertNeverState(s: never): never {
  throw new Error(`unhandled MintQuoteState: ${JSON.stringify(s)}`);
}

// ---------------------------------------------------------------------------
// CTF (Conditional Token Framework) types — NUT-CTF
// ---------------------------------------------------------------------------

/**
 * A condition_id uniquely identifies a specific outcome of a prediction market.
 * It is a 32-byte hex string derived by the mint from the oracle announcement.
 */
export type ConditionId = string;

/**
 * A CTF proof is a regular Cashu proof whose keyset is bound to a condition_id.
 * At settlement, the mint will only allow spending the proof whose outcome
 * matches the oracle's attestation.
 */
export interface CtfProof extends Proof {
  /** The condition_id this proof is locked to. */
  conditionId: ConditionId;
}

/**
 * Represents a prediction market position:
 *  - `conditionId` identifies the outcome
 *  - `proofs` are the CTF-locked ecash tokens
 *  - `amountSats` is the total face value
 */
export interface MarketPosition {
  conditionId: ConditionId;
  proofs: CtfProof[];
  amountSats: number;
}

// ---------------------------------------------------------------------------
// CTF helpers (stubs — full implementation follows NUT-CTF API shape)
// ---------------------------------------------------------------------------

/**
 * Mint CTF tokens for a given condition_id (NUT-CTF §3 — Mint CTF tokens).
 *
 * The mint will return proofs locked to the supplied conditionId.
 * These proofs can only be spent if the oracle attests to that condition.
 *
 * @param conditionId - hex condition_id from the mint's /v1/ctf/conditions endpoint
 * @param amountSats  - amount to lock
 * @param quote       - a paid MintQuoteResponse
 */
export async function mintCtfProofs(
  conditionId: ConditionId,
  amountSats: number,
  quote: MintQuoteResponse
): Promise<CtfProof[]> {
  const wallet = await getWallet();
  // NUT-CTF extends CashuWallet with a conditionId option on mintProofs.
  // Once cashu-ts ships NUT-CTF support this call becomes:
  //   wallet.mintProofs(amountSats, quote.quote, { conditionId })
  const proofs = await wallet.mintProofs(amountSats, quote.quote);
  return proofs.map((p) => ({ ...p, conditionId }));
}

/**
 * Settle CTF tokens after oracle attestation (NUT-CTF §5 — Settle).
 *
 * The wallet sends the winning CTF proofs to the mint along with the
 * oracle's attestation signature, and receives regular sat proofs in return.
 *
 * @param position - the winning MarketPosition
 * @returns regular Cashu proofs redeemable as sats
 */
export async function settleCtfPosition(
  position: MarketPosition
): Promise<Proof[]> {
  // Placeholder: NUT-CTF settlement will use a dedicated mint endpoint.
  // For now we swap the proofs normally (mint verifies condition internally).
  const wallet = await getWallet();
  const { send: settled } = await wallet.send(
    position.amountSats,
    position.proofs
  );
  return settled;
}
