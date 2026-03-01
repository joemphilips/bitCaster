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
  CashuMint,
  CashuWallet,
  getEncodedTokenV4,
  getDecodedToken,
  type Proof,
  type MintQuoteResponse,
  type MeltQuoteResponse,
  type Token,
} from "@cashu/cashu-ts";
import { useWalletStore } from "@/stores/wallet";

// ---------------------------------------------------------------------------
// Default mint (can be overridden at runtime)
// ---------------------------------------------------------------------------

const DEFAULT_MINT_URL = import.meta.env.VITE_MINT_URL ?? "http://localhost:3338";

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
  amountSats: number
): Promise<MintQuoteResponse> {
  const wallet = await getWallet();
  return wallet.createMintQuote(amountSats);
}

/** Mint proofs after the invoice in `quote` has been paid. */
export async function mintProofs(
  amountSats: number,
  quote: MintQuoteResponse
): Promise<Proof[]> {
  const wallet = await getWallet();
  return wallet.mintProofs(amountSats, quote.quote);
}

/** Encode proofs as a cashuV4 token string ready to share. */
export function encodeToken(proofs: Proof[], mintUrl?: string): string {
  const token: Token = { mint: mintUrl ?? _mintUrl, proofs };
  return getEncodedTokenV4(token);
}

/** Decode a cashu token string into proofs. */
export function decodeToken(tokenStr: string): Token {
  return getDecodedToken(tokenStr);
}

/** Receive a cashu token string and return the redeemed proofs. */
export async function receiveToken(tokenStr: string): Promise<Proof[]> {
  const wallet = await getWallet();
  return wallet.receive(tokenStr);
}

/**
 * Send `amountSats` using the provided proofs.
 * Returns `{ keep, send }` — store `keep` proofs, share `send` proofs.
 */
export async function sendProofs(
  amountSats: number,
  proofs: Proof[]
): Promise<{ keep: Proof[]; send: Proof[] }> {
  const wallet = await getWallet();
  return wallet.send(amountSats, proofs);
}

/** Create a melt quote for a Lightning invoice. */
export async function createMeltQuote(
  invoice: string
): Promise<MeltQuoteResponse> {
  const wallet = await getWallet();
  return wallet.createMeltQuote(invoice);
}

/** Melt proofs to pay a Lightning invoice. */
export async function meltProofs(
  quote: MeltQuoteResponse,
  proofs: Proof[]
): Promise<{ paid: boolean; change: Proof[] }> {
  const wallet = await getWallet();
  const response = await wallet.meltProofs(quote, proofs);
  return {
    paid: response.quote.state === "PAID",
    change: response.change ?? [],
  };
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
