/**
 * Atomic swap orchestration for bitCaster.
 *
 * Ties together ECDH key agreement, adaptor signatures, P2PK spending
 * conditions, and the Cashu mint to execute the 9-step atomic swap protocol
 * defined in bitCaster-doc/src/content/docs/technical/protocol/atomic-swap.md.
 *
 *   Seller (Alice) flow:
 *     Step 4 — generateAdaptorPoint → send T to Bob via hub
 *     Step 5 — lock YES proofs to Bob's pubkey, preSign, send {proofs, s'_A} to Bob
 *     Step 7 — receive Bob's {proofs, s'_B}, verify, adapt(s'_B, t), swap at mint
 *
 *   Buyer (Bob) flow:
 *     Step 6 — receive Alice's {proofs, s'_A}, verify, lock sats to Alice's pubkey,
 *               preSign, send {proofs, s'_B} to Alice
 *     Step 8 — poll NUT-07 until Alice's sats spent, extract t = s_B - s'_B
 *     Step 9 — adapt Alice's pre-sigs, swap Alice's YES proofs at mint
 */

import type {
  MintKeys,
  OutputConfig,
  OutputDataLike,
  P2PKOptions,
  Proof,
  ProofState,
  SendConfig,
  SerializedBlindedMessage,
  SerializedBlindedSignature,
  SwapPreview,
  Token,
  ConditionalSwapPreview,
} from "@cashu/cashu-ts";
import {
  Amount,
  CheckStateEnum,
  Mint as CashuMint,
  OutputData,
  Wallet as CashuWallet,
  hashToCurve,
} from "@cashu/cashu-ts";
import { schnorr } from "@noble/curves/secp256k1.js";
import {
  type EphemeralKeypair,
  computeSharedSecret,
  deriveEncryptionKey,
  encrypt,
  decrypt,
  hexToBytes,
} from "./ecdh.ts";
import {
  type AdaptorPoint,
  generateAdaptorPoint,
  preSign,
  preVerify,
  adapt,
  extract,
} from "./adaptor.ts";
import { normalizeUrl } from "./url.ts";

// ---------------------------------------------------------------------------
// Swap context
// ---------------------------------------------------------------------------

export interface SwapContext {
  tradeId: string;
  role: "seller" | "buyer";
  ephemeralKey: EphemeralKeypair;
  counterpartyPubkey: string;
  /**
   * Unix seconds — seller's (Alice's) YES-proof locktime `T_YES`. Per the
   * spec this MUST be later than the buyer's `T_sat` so that Bob has time to
   * extract `t` after Alice spends. See
   * bitCaster-doc/src/content/docs/technical/protocol/atomic-swap.md
   * §"Locktime Constraints" — the invariant is `T_YES > T_sat + Δ`.
   */
  sellerLocktime: number;
  /**
   * Unix seconds — buyer's (Bob's) sat-proof locktime `T_sat`. Shorter than
   * the seller's locktime by at least `MIN_LOCKTIME_DELTA_SECS`.
   */
  buyerLocktime: number;
  mintUrl: string;
}

// ---------------------------------------------------------------------------
// Locktime invariants (defense-in-depth)
// ---------------------------------------------------------------------------

/**
 * Minimum gap between the seller's and buyer's locktimes, in seconds. Mirrors
 * the wallet-service's constant of the same name and the engine's
 * `MinLocktimeDelta` value.
 */
export const MIN_LOCKTIME_DELTA_SECS = 5;
const CASHU_SWAP_UNIT = "sat";

interface LockedProofResult {
  lockedProofs: Proof[];
  changeProofs: Proof[];
}

export interface PartialLockHeldFailure {
  kind: "PartialLockHeld";
  refundLocktime: number;
  affectedKeysets: string[];
  detail: string;
}

export interface PartialLockHeldDetails {
  failure: PartialLockHeldFailure;
  spentProofs: Proof[];
  lockedProofs: Proof[];
  changeProofs: Proof[];
}

export type PartialLockHeldError = Error & {
  failure: PartialLockHeldFailure;
  partialLock: PartialLockHeldDetails;
};

export interface StoredOutputData {
  blindedMessage: {
    amount: number;
    id: string;
    B_: string;
  };
  blindingFactor: string;
  secret: string;
}

export type ProofOperationKind =
  | "swap-lock"
  | "swap-claim"
  | "conditional-keyset-swap"
  | "ctf-split"
  | "ctf-redeem"
  | "proof-split";
export type ProofOperationState = "prepared" | "completed" | "failed";

export interface ProofOperationRecord {
  operationId: string;
  kind: ProofOperationKind;
  state: ProofOperationState;
  mintUrl: string;
  inputs: Proof[];
  outputs: Record<string, StoredOutputData[]>;
  metadata: Record<string, unknown>;
  resultProofs?: Record<string, Proof[]>;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PrepareProofOperationInput {
  operationId: string;
  kind: ProofOperationKind;
  mintUrl: string;
  inputs: Proof[];
  outputs: Record<string, StoredOutputData[]>;
  metadata?: Record<string, unknown>;
}

export interface ProofOperationStore {
  getProofOperation(operationId: string): Promise<ProofOperationRecord | null>;
  prepareProofOperation(
    input: PrepareProofOperationInput,
  ): Promise<ProofOperationRecord>;
  markProofOperationCompleted(
    operationId: string,
    resultProofs: Record<string, Proof[]>,
  ): Promise<ProofOperationRecord>;
}

interface ProofOperationOptions {
  operationId?: string;
  proofOperationStore?: ProofOperationStore;
}

export interface ExactProofSplitResult {
  sendProofs: Proof[];
  changeProofs: Proof[];
  spentProofs: Proof[];
}

/**
 * Validates the protocol's locktime ordering invariant before any proofs are
 * locked or pre-signed.
 *
 * The atomic-swap spec requires `T_YES > T_sat + Δ` (i.e.
 * `sellerLocktime > buyerLocktime + MIN_LOCKTIME_DELTA_SECS`). A buggy or
 * malicious engine emitting an inverted ordering would let the seller refund
 * their YES proofs after Bob already locked sats — and still claim Bob's
 * sats while `T_sat` is unexpired, stealing both sides of the trade. See
 * bitCaster-doc/src/content/docs/technical/protocol/atomic-swap.md
 * §"Locktime Constraints".
 *
 * Returns `null` when the ordering is valid, otherwise a user-facing error
 * message suitable for display.
 */
export function validateLocktimeOrdering(
  sellerLocktime: number,
  buyerLocktime: number,
): string | null {
  if (!Number.isFinite(sellerLocktime) || !Number.isFinite(buyerLocktime)) {
    return "Trade rejected: invalid locktime values from engine.";
  }
  if (sellerLocktime <= buyerLocktime + MIN_LOCKTIME_DELTA_SECS) {
    return (
      `Trade rejected: locktime ordering violates protocol invariant ` +
      `(sellerLocktime=${sellerLocktime}, buyerLocktime=${buyerLocktime}). ` +
      `Seller's locktime must exceed buyer's by at least ` +
      `${MIN_LOCKTIME_DELTA_SECS}s.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Internal wire messages
// ---------------------------------------------------------------------------

interface AdaptorPointMsg {
  point: string; // hex-encoded 33-byte T = t·G
}

interface LockedProofsMsg {
  proofs: Proof[];
  /** Array of hex-encoded 65-byte pre-sigs, one per proof */
  preSigs: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest("SHA-256", data.buffer as ArrayBuffer);
  return new Uint8Array(buf);
}

async function messageToHash(secret: string): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(secret);
  return sha256(enc);
}

function hexStr(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

function encodeProofsMsg(msg: LockedProofsMsg): string {
  return JSON.stringify(msg);
}

function decodeProofsMsg(raw: string): LockedProofsMsg {
  return JSON.parse(raw) as LockedProofsMsg;
}

function encodeAdaptorPointMsg(msg: AdaptorPointMsg): string {
  return JSON.stringify(msg);
}

function decodeAdaptorPointMsg(raw: string): AdaptorPointMsg {
  return JSON.parse(raw) as AdaptorPointMsg;
}

// ---------------------------------------------------------------------------
// Encryption helpers using ECDH shared key
// ---------------------------------------------------------------------------

async function buildSharedKey(ctx: SwapContext): Promise<CryptoKey> {
  const shared = computeSharedSecret(
    ctx.ephemeralKey.privateKey,
    ctx.counterpartyPubkey,
  );
  return deriveEncryptionKey(shared);
}

async function encryptMsg(
  ctx: SwapContext,
  plaintext: string,
): Promise<string> {
  const key = await buildSharedKey(ctx);
  return encrypt(key, plaintext);
}

async function decryptMsg(
  ctx: SwapContext,
  ciphertext: string,
): Promise<string> {
  const key = await buildSharedKey(ctx);
  return decrypt(key, ciphertext);
}

// ---------------------------------------------------------------------------
// Seller (Alice) flow
// ---------------------------------------------------------------------------

/**
 * Step 4 + 5: Alice generates adaptor point, locks her YES proofs to Bob's
 * pubkey, pre-signs, and returns the ciphertexts to send via the TradeHub.
 *
 * Returns two ciphertexts ready for `sendSwapMessage`:
 *   - `adaptorPointCipher` → messageType 'adaptor-point'
 *   - `lockedProofsCipher` → messageType 'locked-proofs-seller'
 *
 * Also returns the adaptor secret for step 7.
 */
export async function sellerPrepareSwap(
  ctx: SwapContext,
  proofs: Proof[],
  options: ProofOperationOptions = {},
): Promise<{
  adaptorPointCipher: string;
  lockedProofsCipher: string;
  adaptorPoint: AdaptorPoint;
  lockedProofs: Proof[];
  changeProofs: Proof[];
}> {
  // Ask the mint to swap Alice's proofs into P2PK-locked proofs. Rewriting a
  // proof secret locally invalidates its mint signature (`C`).
  const { lockedProofs, changeProofs } = await lockProofsForSwap(
    ctx,
    proofs,
    ctx.sellerLocktime,
    options.operationId,
    options.proofOperationStore,
  );
  return sellerPreparePrelockedSwap(ctx, lockedProofs, changeProofs);
}

/**
 * Seller step for proofs that were **already** minted with the swap P2PK lock.
 *
 * Precondition: every proof in `lockedProofs` must carry a NUT-10 P2PK secret
 * 2-of-2-locked to the swap's ephemeral + counterparty keys. This helper only
 * pre-signs — it never locks — so handing it raw, unlocked outcome proofs would
 * make the atomic swap non-atomic. Callers holding unlocked CTF outcome proofs
 * must run {@link sellerLockOutcomeProofs} first; callers using
 * `splitRootCompleteSetForSwap` already receive P2PK-locked proofs.
 *
 * The precondition is verified by {@link assertProofsAtomicSwapLocked}; that
 * check is wired in as a hard guard together with the Phase 1 seller
 * call-site cutover (see docs/plans/p19-cashu-ts-ctf-native.md).
 */
export async function sellerPreparePrelockedSwap(
  ctx: SwapContext,
  lockedProofs: Proof[],
  changeProofs: Proof[] = [],
): Promise<{
  adaptorPointCipher: string;
  lockedProofsCipher: string;
  adaptorPoint: AdaptorPoint;
  lockedProofs: Proof[];
  changeProofs: Proof[];
}> {
  assertProofsAtomicSwapLocked(ctx, lockedProofs);
  const protocolLockedProofs = lockedProofs.map(stripLocalProofMetadata);
  const adaptorPoint = generateAdaptorPoint();

  // Pre-sign each proof's secret
  const privBytes = ctx.ephemeralKey.privateKey;
  const preSigs = await Promise.all(
    protocolLockedProofs.map(async (proof) => {
      const msgHash = await messageToHash(proof.secret);
      const sig = preSign(privBytes, msgHash, adaptorPoint.point);
      return hexStr(sig);
    }),
  );

  const adaptorPointMsg: AdaptorPointMsg = {
    point: hexStr(adaptorPoint.point),
  };

  const lockedProofsMsg: LockedProofsMsg = {
    proofs: protocolLockedProofs,
    preSigs,
  };

  const adaptorPointCipher = await encryptMsg(
    ctx,
    encodeAdaptorPointMsg(adaptorPointMsg),
  );
  const lockedProofsCipher = await encryptMsg(
    ctx,
    encodeProofsMsg(lockedProofsMsg),
  );

  return {
    adaptorPointCipher,
    lockedProofsCipher,
    adaptorPoint,
    lockedProofs: protocolLockedProofs,
    changeProofs,
  };
}

export async function splitProofsForExactSend(params: {
  mintUrl: string;
  sourceProofs: Proof[];
  amountSats: number;
  preserveSourceKeyset?: boolean;
  operationId?: string;
  proofOperationStore?: ProofOperationStore;
}): Promise<ExactProofSplitResult> {
  if (!Number.isSafeInteger(params.amountSats) || params.amountSats <= 0) {
    throw new Error("amountSats must be a positive safe integer");
  }
  if (params.sourceProofs.length === 0) {
    throw new Error("Exact proof split requires source proofs");
  }

  const preserveSourceKeyset =
    params.preserveSourceKeyset ??
    params.sourceProofs.some(hasLocalCtfProofMetadata);
  if (preserveSourceKeyset) {
    const mint = new CashuMint(params.mintUrl);
    const keyset = await fetchMintKeys(
      mint,
      singleProofKeysetId(params.sourceProofs),
    );
    const netInput =
      sumProofs(params.sourceProofs) -
      conditionalInputFee(params.sourceProofs.length, keyset);
    if (netInput < params.amountSats) {
      throw new Error(
        `Exact proof split input nets ${netInput} sats, need ${params.amountSats}`,
      );
    }
    const groups: ConditionalSwapOutputGroup[] = [
      { label: "send", kind: "random", amount: params.amountSats },
    ];
    const changeAmount = netInput - params.amountSats;
    if (changeAmount > 0) {
      groups.push({ label: "keep", kind: "random", amount: changeAmount });
    }
    const result = await conditionalKeysetSwap(
      params.mintUrl,
      params.sourceProofs,
      groups,
      {
        operationId: params.operationId,
        proofOperationStore: params.proofOperationStore,
      },
    );
    return {
      sendProofs: result.send ?? [],
      changeProofs: result.keep ?? [],
      spentProofs: params.sourceProofs,
    };
  }

  const mint = new CashuMint(params.mintUrl);
  const { wallet, sendConfig } = await walletForSourceProofs(
    mint,
    params.sourceProofs,
  );
  const outputConfig: OutputConfig = {
    send: { type: "random" },
    keep: { type: "random" },
  };

  if (params.operationId) {
    const result = await splitProofsForExactSendWithOperation(
      params.operationId,
      params.mintUrl,
      wallet,
      params.amountSats,
      params.sourceProofs,
      sendConfig,
      outputConfig,
      requiredProofOperationStore(
        params.operationId,
        params.proofOperationStore,
      ),
    );
    return {
      sendProofs: result.send,
      changeProofs: result.keep,
      spentProofs: params.sourceProofs,
    };
  }

  const result = await wallet.send(
    params.amountSats,
    params.sourceProofs,
    sendConfig,
    outputConfig,
  );
  return {
    sendProofs: result.send,
    changeProofs: result.keep,
    spentProofs: params.sourceProofs,
  };
}

// ---------------------------------------------------------------------------
// Conditional-keyset (CTF) swap primitives
// ---------------------------------------------------------------------------

/** One labelled group of outputs for a {@link conditionalKeysetSwap}. */
export interface ConditionalSwapOutputGroup {
  /** Caller-chosen key the returned proofs are grouped under. */
  label: string;
  /** `"p2pk"` mints NUT-11 P2PK-locked outputs; `"random"` mints plain outputs. */
  kind: "p2pk" | "random";
  /** Total sat value of this group. */
  amount: number;
  /** Required when `kind === "p2pk"`. */
  p2pk?: P2PKOptions;
}

type SwapOutputData = OutputDataLike & {
  toProof(signature: SerializedBlindedSignature, keyset: MintKeys): Proof;
};

/**
 * Keyset-pinned NUT-03 swap for CTF conditional proofs.
 *
 * Every input proof must belong to a single conditional keyset `K`; every
 * output blinded message is minted against `K`. CDK permits this because all
 * inputs and outputs share `(condition_id, outcome_collection_id)` — a regular
 * NUT-03 swap within one conditional keyset. The cashu-ts CTF wallet API owns
 * the keyset-pinned output construction; this wrapper only adds bitCaster's
 * proof-operation persistence and grouped return shape.
 *
 * @returns proofs grouped by {@link ConditionalSwapOutputGroup.label}
 */
export async function conditionalKeysetSwap(
  mintUrl: string,
  sourceProofs: Proof[],
  groups: ConditionalSwapOutputGroup[],
  options: ProofOperationOptions = {},
): Promise<Record<string, Proof[]>> {
  if (sourceProofs.length === 0) {
    throw new Error("conditionalKeysetSwap requires at least one source proof");
  }
  if (groups.length === 0) {
    throw new Error("conditionalKeysetSwap requires at least one output group");
  }
  const wallet = new CashuWallet(new CashuMint(mintUrl), {
    unit: CASHU_SWAP_UNIT,
    enableCtf: true,
  });
  const prepare = async () =>
    wallet.prepareConditionalSwap({
      inputs: sourceProofs.map(stripLocalProofMetadata),
      outputs: groups,
    });
  if (options.operationId) {
    const proofOperationStore = requiredProofOperationStore(
      options.operationId,
      options.proofOperationStore,
    );
    const existing = await proofOperationStore.getProofOperation(
      options.operationId,
    );
    if (existing) {
      assertProofOperationMatches(
        existing,
        "conditional-keyset-swap",
        mintUrl,
        sourceProofs,
      );
      return resumeConditionalKeysetSwap(wallet, existing, proofOperationStore);
    }
    const preview = await prepare();
    await proofOperationStore.prepareProofOperation({
      operationId: options.operationId,
      kind: "conditional-keyset-swap",
      mintUrl,
      inputs: normalizeProofArray(preview.inputs),
      outputs: serializeOutputDataArrayByLabel(preview.outputDataByLabel),
      metadata: { keysetId: preview.keysetId },
    });
    const result = await completeConditionalKeysetSwapPreview(wallet, preview);
    await proofOperationStore.markProofOperationCompleted(
      options.operationId,
      result,
    );
    return result;
  }
  const preview = await prepare();
  return completeConditionalKeysetSwapPreview(wallet, preview);
}

async function completeConditionalKeysetSwapPreview(
  wallet: CashuWallet,
  preview: ConditionalSwapPreview,
): Promise<Record<string, Proof[]>> {
  assertConditionalSwapOutputsPinned(preview);
  try {
    return normalizeProofGroups(await wallet.completeConditionalSwap(preview));
  } catch (error) {
    throw enrichConditionalSwapError(error, preview);
  }
}

export function assertConditionalSwapOutputsPinned(
  preview: ConditionalSwapPreview,
): void {
  for (const [label, outputs] of Object.entries(preview.outputDataByLabel)) {
    const mismatched = outputs.find(
      (output) => output.blindedMessage.id !== preview.keysetId,
    );
    if (mismatched) {
      throw new Error(
        `conditionalKeysetSwap output ${label} uses keyset ` +
          `${mismatched.blindedMessage.id}; expected ${preview.keysetId}`,
      );
    }
  }
}

function enrichConditionalSwapError(
  error: unknown,
  preview: ConditionalSwapPreview,
): Error {
  const rows = Object.entries(preview.outputDataByLabel).flatMap(
    ([label, outputs]) =>
      outputs.map((output) => ({
        label,
        id: output.blindedMessage.id,
        amount: amountToNumber(output.blindedMessage.amount),
      })),
  );
  const message = error instanceof Error ? error.message : String(error);
  const enriched = new Error(
    `${message} (conditionalKeysetSwap keyset=${preview.keysetId}; ` +
      `inputIds=${[...new Set(preview.inputs.map((proof) => proof.id))].join(",")}; ` +
      `outputs=${JSON.stringify(rows)})`,
  );
  if (error instanceof Error && error.stack) enriched.stack = error.stack;
  return enriched;
}

/**
 * Convert unlocked CTF outcome proofs into genuinely NUT-11 P2PK 2-of-2-locked
 * outcome proofs for the atomic swap, staying on the source conditional keyset.
 *
 * Handles oversized inventory: when the proofs net more than `amount`, the
 * surplus is returned as `changeProofs` (same conditional keyset, unlocked) in
 * the same single mint round-trip. This is the one correct seller-lock path for
 * conditional proofs — callers must never hand raw, unlocked outcome proofs to
 * {@link sellerPreparePrelockedSwap}.
 */
export async function sellerLockOutcomeProofs(
  ctx: SwapContext,
  outcomeProofs: Proof[],
  amount: number,
  options: ProofOperationOptions = {},
): Promise<LockedProofResult> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(
      "sellerLockOutcomeProofs: amount must be a positive integer",
    );
  }
  if (outcomeProofs.length === 0) {
    throw new Error("sellerLockOutcomeProofs requires outcome proofs to lock");
  }
  const mint = new CashuMint(ctx.mintUrl);
  const p2pk: P2PKOptions = {
    pubkey: [ctx.ephemeralKey.publicKey, ctx.counterpartyPubkey],
    requiredSignatures: 2,
    locktime: ctx.sellerLocktime,
    refundKeys: [ctx.ephemeralKey.publicKey],
    sigFlag: "SIG_INPUTS",
  };

  const lockedProofs: Proof[] = [];
  const changeProofs: Proof[] = [];
  const spentProofs: Proof[] = [];
  const affectedKeysets: string[] = [];
  const proofGroups = groupProofsByKeyset(outcomeProofs);
  requireDurableOperationForMultiKeyset(
    proofGroups.size,
    options,
    "sellerLockOutcomeProofs",
  );
  for (const [keysetId, proofs] of proofGroups) {
    try {
      const keyset = await fetchMintKeys(mint, keysetId);
      const feeSats = conditionalInputFee(proofs.length, keyset);
      const netInput = sumProofs(proofs) - feeSats;
      if (netInput < amount) {
        throw new Error(
          `sellerLockOutcomeProofs: outcome proofs for keyset ${keysetId} net ${netInput} sats, need ${amount} to lock`,
        );
      }

      const groups: ConditionalSwapOutputGroup[] = [
        { label: "lock", kind: "p2pk", amount, p2pk },
      ];
      const changeAmount = netInput - amount;
      if (changeAmount > 0) {
        groups.push({ label: "change", kind: "random", amount: changeAmount });
      }

      const swapped = await conditionalKeysetSwap(
        ctx.mintUrl,
        proofs,
        groups,
        proofOperationOptionsForKeyset(options, keysetId, proofGroups.size),
      );
      lockedProofs.push(...(swapped.lock ?? []));
      changeProofs.push(...(swapped.change ?? []));
      spentProofs.push(...proofs);
      affectedKeysets.push(keysetId);
    } catch (error) {
      if (lockedProofs.length === 0) throw error;
      throw partialLockHeldError(error, {
        refundLocktime: ctx.sellerLocktime,
        affectedKeysets,
        spentProofs,
        lockedProofs,
        changeProofs,
      });
    }
  }
  return {
    lockedProofs,
    changeProofs,
  };
}

function partialLockHeldError(
  error: unknown,
  partial: Omit<PartialLockHeldDetails, "failure"> & {
    refundLocktime: number;
    affectedKeysets: string[];
  },
): PartialLockHeldError {
  const detail = error instanceof Error ? error.message : String(error);
  const failure: PartialLockHeldFailure = {
    kind: "PartialLockHeld",
    refundLocktime: partial.refundLocktime,
    affectedKeysets: partial.affectedKeysets,
    detail,
  };
  const out = new Error(
    `sellerLockOutcomeProofs partially locked ${partial.affectedKeysets.length} keyset leg(s): ${detail}`,
  ) as PartialLockHeldError;
  if (error instanceof Error && error.stack) out.stack = error.stack;
  out.failure = failure;
  out.partialLock = { ...partial, failure };
  return out;
}

/** Input fee in sats for a swap whose inputs all share one keyset. */
function conditionalInputFee(proofCount: number, keyset: MintKeys): number {
  const feePpk = keyset.input_fee_ppk ?? 0;
  return Math.ceil((proofCount * feePpk) / 1000);
}

interface P2PKLock {
  pubkeys: string[];
  requiredSignatures: number;
}

/**
 * Parse a NUT-10 `P2PK` well-known secret. Returns the locked pubkey set and
 * required-signature count, or `null` when the secret is not a P2PK condition
 * (e.g. a plain random secret on an unlocked proof).
 */
function parseP2PKLock(secret: string): P2PKLock | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed[0] !== "P2PK") return null;
  const body = parsed[1] as { data?: unknown; tags?: unknown };
  if (typeof body?.data !== "string") return null;
  const pubkeys = [body.data];
  let requiredSignatures = 1;
  const tags = Array.isArray(body.tags) ? body.tags : [];
  for (const tag of tags) {
    if (!Array.isArray(tag) || tag.length < 2) continue;
    if (tag[0] === "pubkeys") {
      for (const pk of tag.slice(1)) {
        if (typeof pk === "string") pubkeys.push(pk);
      }
    } else if (tag[0] === "n_sigs") {
      const n = Number(tag[1]);
      if (Number.isInteger(n) && n > 0) requiredSignatures = n;
    }
  }
  return { pubkeys, requiredSignatures };
}

/**
 * Assert every proof carries a NUT-10 P2PK secret 2-of-2-locked to exactly
 * `[ctx.ephemeralKey.publicKey, ctx.counterpartyPubkey]`.
 *
 * This is the hard precondition of {@link sellerPreparePrelockedSwap}: that
 * helper only pre-signs proof secrets, it never locks them. Handing it raw,
 * unlocked outcome proofs would make the atomic swap non-atomic — a taker could
 * claim the seller's outcome proofs without ever paying (P03 violation). Lock
 * outcome proofs through {@link sellerLockOutcomeProofs} first.
 */
export function assertProofsAtomicSwapLocked(
  ctx: SwapContext,
  proofs: Proof[],
): void {
  if (proofs.length === 0) {
    throw new Error("assertProofsAtomicSwapLocked: no proofs to verify");
  }
  const expected = new Set(
    [ctx.ephemeralKey.publicKey, ctx.counterpartyPubkey].map((k) =>
      k.toLowerCase(),
    ),
  );
  for (const proof of proofs) {
    const lock = parseP2PKLock(proof.secret);
    if (!lock) {
      throw new Error(
        "sellerPreparePrelockedSwap requires P2PK-locked proofs — received a " +
          "proof with no NUT-10 P2PK spending condition. Lock outcome proofs " +
          "via sellerLockOutcomeProofs before pre-signing.",
      );
    }
    if (lock.requiredSignatures !== 2) {
      throw new Error(
        `sellerPreparePrelockedSwap requires a 2-of-2 P2PK lock; proof ` +
          `requires ${lock.requiredSignatures} signature(s)`,
      );
    }
    const got = new Set(lock.pubkeys.map((k) => k.toLowerCase()));
    if (got.size !== expected.size || [...expected].some((k) => !got.has(k))) {
      throw new Error(
        "sellerPreparePrelockedSwap: proof is P2PK-locked to the wrong pubkey " +
          "set — expected the swap's ephemeral and counterparty keys",
      );
    }
  }
}

/**
 * Step 7: Alice receives Bob's locked sat proofs, verifies, adapts
 * pre-sigs with her adaptor secret, and swaps at the mint.
 *
 * @returns fresh sat proofs received from the mint
 */
export async function sellerClaimSwap(
  ctx: SwapContext,
  adaptorPoint: AdaptorPoint,
  bobLockedProofsCipher: string,
  options: ProofOperationOptions = {},
): Promise<Proof[]> {
  const plaintext = await decryptMsg(ctx, bobLockedProofsCipher);
  const { proofs: bobProofs, preSigs: bobPreSigsHex } =
    decodeProofsMsg(plaintext);

  // Verify each pre-sig
  const counterpartyPubBytes = hexToBytes(ctx.counterpartyPubkey);
  for (let i = 0; i < bobProofs.length; i++) {
    const msgHash = await messageToHash(bobProofs[i].secret);
    const preSigBytes = hexToBytes(bobPreSigsHex[i]);
    const valid = preVerify(
      counterpartyPubBytes,
      msgHash,
      preSigBytes,
      adaptorPoint.point,
    );
    if (!valid) throw new Error(`Bob pre-sig ${i} failed verification`);
  }

  // Adapt each pre-sig
  const adaptedWitnesses = await Promise.all(
    bobProofs.map(async (proof, i) => {
      const msgHash = await messageToHash(proof.secret);
      const preSigBytes = hexToBytes(bobPreSigsHex[i]);
      const sig = adapt(preSigBytes, adaptorPoint.secret);
      const ownSig = schnorr.sign(msgHash, ctx.ephemeralKey.privateKey);
      return {
        proof,
        adaptedSig: hexStr(sig),
        ownSig: hexStr(ownSig),
      };
    }),
  );

  // Attach adapted signatures as NUT-11 witnesses
  const inputProofs = adaptedWitnesses.map(({ proof, adaptedSig, ownSig }) => ({
    ...proof,
    witness: JSON.stringify({ signatures: [adaptedSig, ownSig] }),
  }));

  return receiveProofsAtMint(
    ctx.mintUrl,
    inputProofs,
    options.operationId,
    options.proofOperationStore,
  );
}

// ---------------------------------------------------------------------------
// Buyer (Bob) flow
// ---------------------------------------------------------------------------

/**
 * Step 6: Bob receives Alice's adaptor point and locked proofs, verifies,
 * locks his sat proofs to Alice's pubkey, pre-signs, and returns
 * the ciphertext ready for `sendSwapMessage`.
 *
 * @returns { lockedProofsCipher, lockedProofs, preSigsHex, sellerPreSigsHex }
 */
export async function buyerPrepareSwap(
  ctx: SwapContext,
  aliceAdaptorPointCipher: string,
  aliceLockedProofsCipher: string,
  satProofs: Proof[],
  options: ProofOperationOptions = {},
): Promise<{
  lockedProofsCipher: string;
  adaptorPointHex: string;
  lockedProofs: Proof[];
  changeProofs: Proof[];
  preSigsHex: string[];
  sellerPreSigsHex: string[];
}> {
  // Decrypt Alice's messages
  const aptPlain = await decryptMsg(ctx, aliceAdaptorPointCipher);
  const lockedPlain = await decryptMsg(ctx, aliceLockedProofsCipher);

  const { point: adaptorPointHex } = decodeAdaptorPointMsg(aptPlain);
  const { proofs: aliceProofs, preSigs: alicePreSigsHex } =
    decodeProofsMsg(lockedPlain);

  const adaptorPointBytes = hexToBytes(adaptorPointHex);
  const counterpartyPubBytes = hexToBytes(ctx.counterpartyPubkey);

  // Verify Alice's pre-sigs
  for (let i = 0; i < aliceProofs.length; i++) {
    const msgHash = await messageToHash(aliceProofs[i].secret);
    const preSigBytes = hexToBytes(alicePreSigsHex[i]);
    const valid = preVerify(
      counterpartyPubBytes,
      msgHash,
      preSigBytes,
      adaptorPointBytes,
    );
    if (!valid) throw new Error(`Alice pre-sig ${i} failed verification`);
  }

  const { lockedProofs, changeProofs } = await lockProofsForSwap(
    ctx,
    satProofs,
    ctx.buyerLocktime,
    options.operationId,
    options.proofOperationStore,
  );

  // Pre-sign Bob's proofs with the same adaptor point T
  const privBytes = ctx.ephemeralKey.privateKey;
  const preSigsHex = await Promise.all(
    lockedProofs.map(async (proof) => {
      const msgHash = await messageToHash(proof.secret);
      const sig = preSign(privBytes, msgHash, adaptorPointBytes);
      return hexStr(sig);
    }),
  );

  const lockedProofsMsg: LockedProofsMsg = {
    proofs: lockedProofs,
    preSigs: preSigsHex,
  };
  const lockedProofsCipher = await encryptMsg(
    ctx,
    encodeProofsMsg(lockedProofsMsg),
  );

  return {
    lockedProofsCipher,
    adaptorPointHex,
    lockedProofs,
    changeProofs,
    preSigsHex,
    sellerPreSigsHex: alicePreSigsHex,
  };
}

/**
 * Step 8: Bob polls the Cashu mint's NUT-07 checkstate endpoint for his
 * spent sat proofs to extract the adaptor secret t.
 *
 * Returns `null` if proofs have not been spent yet (caller should retry).
 */
export async function buyerExtractSecret(
  mintUrl: string,
  spentProofs: Proof[],
  preSigsHex: string[],
): Promise<Uint8Array | null> {
  // NUT-07 checkstate: Y = hashToCurve(secret) per NUT-00/NUT-07.
  // hashToCurve takes a Uint8Array and returns a WeierstrassPoint; we need
  // the compressed hex representation for the API request.
  const Ys = spentProofs.map((p) => {
    const secretBytes = new TextEncoder().encode(p.secret);
    const point = hashToCurve(secretBytes);
    return point.toHex(true);
  });

  const res = await fetch(`${mintUrl}/v1/checkstate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ Ys }),
  });
  if (!res.ok) return null;

  interface CheckStateEntry {
    Y: string;
    state: string;
    witness?: string;
  }

  const { states } = (await res.json()) as { states: CheckStateEntry[] };
  const spent = states.find(
    (s: CheckStateEntry) => s.state === "SPENT" && s.witness,
  );
  if (!spent?.witness) return null;

  const witnessObj = JSON.parse(spent.witness) as { signatures: string[] };
  const sigHex = witnessObj.signatures?.[0];
  if (!sigHex) return null;

  // Correlate the spent Y back to the original preSigsHex index via the
  // Ys array (same order as spentProofs / preSigsHex).
  const yToIndex = new Map(Ys.map((y, i) => [y, i]));
  const idx = yToIndex.get(spent.Y);
  if (idx === undefined || !preSigsHex[idx]) return null;

  const sig = hexToBytes(sigHex);
  const preSig = hexToBytes(preSigsHex[idx]);
  return extract(sig, preSig);
}

/**
 * Step 9: Bob adapts Alice's pre-sigs with the extracted secret and
 * swaps Alice's YES proofs at the mint.
 *
 * @returns fresh conditional token proofs
 */
export async function buyerClaimSwap(
  ctx: SwapContext,
  adaptorSecret: Uint8Array,
  aliceLockedProofsCipher: string,
  alicePreSigsHex: string[],
  options: ProofOperationOptions = {},
): Promise<Proof[]> {
  const lockedPlain = await decryptMsg(ctx, aliceLockedProofsCipher);
  const { proofs: aliceProofs } = decodeProofsMsg(lockedPlain);

  // Adapt each of Alice's pre-sigs
  const adaptedSigs = alicePreSigsHex.map((hex) => {
    const preSig = hexToBytes(hex);
    return hexStr(adapt(preSig, adaptorSecret));
  });

  const inputProofs = await Promise.all(
    aliceProofs.map(async (proof, i) => ({
      ...proof,
      witness: JSON.stringify({
        signatures: [
          adaptedSigs[i],
          hexStr(
            schnorr.sign(
              await messageToHash(proof.secret),
              ctx.ephemeralKey.privateKey,
            ),
          ),
        ],
      }),
    })),
  );

  return claimConditionalProofsAtMint(ctx.mintUrl, inputProofs, options);
}

export function buildReceiveToken(mintUrl: string, proofs: Proof[]): Token {
  return { mint: mintUrl, unit: CASHU_SWAP_UNIT, proofs };
}

async function lockProofsForSwap(
  ctx: SwapContext,
  sourceProofs: Proof[],
  locktime: number,
  operationId?: string,
  proofOperationStore?: ProofOperationStore,
): Promise<LockedProofResult> {
  const mint = new CashuMint(ctx.mintUrl);
  const { wallet, sendConfig, inputFeeSats } = await walletForSourceProofs(
    mint,
    sourceProofs,
  );

  const amount = sumProofs(sourceProofs) - inputFeeSats;
  if (amount <= 0)
    throw new Error("Not enough proofs to cover Cashu swap fees");

  const outputConfig: OutputConfig = {
    send: {
      type: "p2pk",
      options: {
        pubkey: [ctx.ephemeralKey.publicKey, ctx.counterpartyPubkey],
        requiredSignatures: 2,
        locktime,
        refundKeys: [ctx.ephemeralKey.publicKey],
        sigFlag: "SIG_INPUTS",
      },
    },
    keep: { type: "random" },
  };
  if (operationId) {
    return lockProofsWithOperation(
      operationId,
      ctx.mintUrl,
      wallet,
      amount,
      sourceProofs,
      sendConfig,
      outputConfig,
      requiredProofOperationStore(operationId, proofOperationStore),
    );
  }

  const { send, keep } = await wallet.send(
    amount,
    sourceProofs,
    sendConfig,
    outputConfig,
  );
  return { lockedProofs: send, changeProofs: keep };
}

async function claimConditionalProofsAtMint(
  mintUrl: string,
  inputProofs: Proof[],
  options: ProofOperationOptions,
): Promise<Proof[]> {
  const mint = new CashuMint(mintUrl);
  const claimedProofs: Proof[] = [];
  const proofGroups = groupProofsByKeyset(inputProofs);
  requireDurableOperationForMultiKeyset(
    proofGroups.size,
    options,
    "buyerClaimSwap",
  );
  for (const [keysetId, proofs] of proofGroups) {
    const keyset = await fetchMintKeys(mint, keysetId);
    const netAmount =
      sumProofs(proofs) - conditionalInputFee(proofs.length, keyset);
    if (netAmount <= 0) {
      throw new Error(
        `buyerClaimSwap: conditional claim proofs for keyset ${keysetId} are exhausted by input fees`,
      );
    }
    const result = await conditionalKeysetSwap(
      mintUrl,
      proofs,
      [{ label: "keep", kind: "random", amount: netAmount }],
      proofOperationOptionsForKeyset(options, keysetId, proofGroups.size),
    );
    claimedProofs.push(...(result.keep ?? []));
  }
  return claimedProofs;
}

async function receiveProofsAtMint(
  mintUrl: string,
  inputProofs: Proof[],
  operationId?: string,
  proofOperationStore?: ProofOperationStore,
): Promise<Proof[]> {
  const mint = new CashuMint(mintUrl);
  const { wallet } = await walletForSourceProofs(mint, inputProofs);
  const token = buildReceiveToken(mintUrl, inputProofs);
  if (operationId) {
    return receiveProofsWithOperation(
      operationId,
      mintUrl,
      wallet,
      token,
      requiredProofOperationStore(operationId, proofOperationStore),
    );
  }
  return wallet.receive(token, { proofsWeHave: [] });
}

async function lockProofsWithOperation(
  operationId: string,
  mintUrl: string,
  wallet: CashuWallet,
  amount: number,
  sourceProofs: Proof[],
  sendConfig: SendConfig | undefined,
  outputConfig: OutputConfig,
  proofOperationStore: ProofOperationStore,
): Promise<LockedProofResult> {
  const existing = await proofOperationStore.getProofOperation(operationId);
  if (existing) {
    assertProofOperationMatches(existing, "swap-lock", mintUrl, sourceProofs);
    const result = await resumeProofOperation(
      wallet,
      existing,
      proofOperationStore,
    );
    return {
      lockedProofs: result.send ?? [],
      changeProofs: result.keep ?? [],
    };
  }

  const preview = await wallet.prepareSwapToSend(
    amount,
    sourceProofs,
    sendConfig,
    outputConfig,
  );
  await proofOperationStore.prepareProofOperation({
    operationId,
    kind: "swap-lock",
    mintUrl,
    inputs: normalizeProofArray(preview.inputs),
    outputs: {
      send: serializeOutputDataArray(preview.sendOutputs ?? []),
      keep: serializeOutputDataArray(preview.keepOutputs ?? []),
    },
    metadata: swapPreviewMetadata(preview),
  });

  const result = await wallet.completeSwap(preview);
  const final = normalizeProofGroups({ send: result.send, keep: result.keep });
  await proofOperationStore.markProofOperationCompleted(operationId, final);
  return { lockedProofs: final.send, changeProofs: final.keep };
}

async function splitProofsForExactSendWithOperation(
  operationId: string,
  mintUrl: string,
  wallet: CashuWallet,
  amount: number,
  sourceProofs: Proof[],
  sendConfig: SendConfig | undefined,
  outputConfig: OutputConfig,
  proofOperationStore: ProofOperationStore,
): Promise<{ send: Proof[]; keep: Proof[] }> {
  const existing = await proofOperationStore.getProofOperation(operationId);
  if (existing) {
    assertProofOperationMatches(existing, "proof-split", mintUrl, sourceProofs);
    const result = await resumeProofOperation(
      wallet,
      existing,
      proofOperationStore,
    );
    return {
      send: result.send ?? [],
      keep: result.keep ?? [],
    };
  }

  const preview = await wallet.prepareSwapToSend(
    amount,
    sourceProofs,
    sendConfig,
    outputConfig,
  );
  await proofOperationStore.prepareProofOperation({
    operationId,
    kind: "proof-split",
    mintUrl,
    inputs: normalizeProofArray(preview.inputs),
    outputs: {
      send: serializeOutputDataArray(preview.sendOutputs ?? []),
      keep: serializeOutputDataArray(preview.keepOutputs ?? []),
    },
    metadata: swapPreviewMetadata(preview),
  });

  const result = await wallet.completeSwap(preview);
  const final = normalizeProofGroups({ send: result.send, keep: result.keep });
  await proofOperationStore.markProofOperationCompleted(operationId, final);
  return { send: final.send ?? [], keep: final.keep ?? [] };
}

async function receiveProofsWithOperation(
  operationId: string,
  mintUrl: string,
  wallet: CashuWallet,
  token: Token,
  proofOperationStore: ProofOperationStore,
): Promise<Proof[]> {
  const existing = await proofOperationStore.getProofOperation(operationId);
  if (existing) {
    assertProofOperationMatches(existing, "swap-claim", mintUrl, token.proofs);
    const result = await resumeProofOperation(
      wallet,
      existing,
      proofOperationStore,
    );
    return result.keep ?? [];
  }

  const preview = await wallet.prepareSwapToReceive(
    token,
    { proofsWeHave: [] },
    { type: "random" },
  );
  await proofOperationStore.prepareProofOperation({
    operationId,
    kind: "swap-claim",
    mintUrl,
    inputs: normalizeProofArray(preview.inputs),
    outputs: {
      keep: serializeOutputDataArray(preview.keepOutputs ?? []),
    },
    metadata: swapPreviewMetadata(preview),
  });

  const result = await wallet.completeSwap(preview);
  const final = normalizeProofGroups({ keep: result.keep });
  await proofOperationStore.markProofOperationCompleted(operationId, final);
  return final.keep;
}

async function resumeProofOperation(
  wallet: CashuWallet,
  entry: ProofOperationRecord,
  proofOperationStore: ProofOperationStore,
): Promise<Record<string, Proof[]>> {
  if (entry.state === "completed") {
    return normalizeProofGroups(structuredClone(entry.resultProofs ?? {}));
  }
  if (entry.state === "failed") {
    throw new Error(
      `Proof operation ${entry.operationId} previously failed: ${entry.lastError ?? "unknown error"}`,
    );
  }

  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  );
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await restoreOutputGroups(entry.mintUrl, entry.outputs);
    if (operationKeepsUnselectedInputs(entry.kind)) {
      restored.keep = [
        ...(restored.keep ?? []),
        ...readUnselectedProofs(entry),
      ];
    }
    const final = normalizeProofGroups(restored);
    await proofOperationStore.markProofOperationCompleted(
      entry.operationId,
      final,
    );
    return final;
  }
  if (allStates(states, CheckStateEnum.UNSPENT)) {
    const result = await wallet.completeSwap(entryToSwapPreview(entry));
    const final: Record<string, Proof[]> = operationReturnsSendProofs(
      entry.kind,
    )
      ? { send: result.send, keep: result.keep }
      : { keep: result.keep };
    const normalized = normalizeProofGroups(final);
    await proofOperationStore.markProofOperationCompleted(
      entry.operationId,
      normalized,
    );
    return normalized;
  }

  throw new Error(
    `Proof operation ${entry.operationId} is still pending at the mint`,
  );
}

async function resumeConditionalKeysetSwap(
  wallet: CashuWallet,
  entry: ProofOperationRecord,
  proofOperationStore: ProofOperationStore,
): Promise<Record<string, Proof[]>> {
  if (entry.state === "completed") {
    return normalizeProofGroups(structuredClone(entry.resultProofs ?? {}));
  }
  if (entry.state === "failed") {
    throw new Error(
      `Proof operation ${entry.operationId} previously failed: ${entry.lastError ?? "unknown error"}`,
    );
  }

  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ id, secret }) => ({ id, secret })),
  );
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await restoreOutputGroups(
      entry.mintUrl,
      entry.outputs,
      OutputData,
      CashuMint,
      normalizeCtfSignature,
    );
    const final = normalizeProofGroups(restored);
    await proofOperationStore.markProofOperationCompleted(
      entry.operationId,
      final,
    );
    return final;
  }
  if (allStates(states, CheckStateEnum.UNSPENT)) {
    const keysetId =
      typeof entry.metadata.keysetId === "string"
        ? entry.metadata.keysetId
        : singleProofKeysetId(entry.inputs);
    const result = await completeConditionalKeysetSwapPreview(wallet, {
      keysetId,
      inputs: entry.inputs,
      outputDataByLabel: deserializeOutputGroups(entry.outputs, OutputData),
    });
    const final = normalizeProofGroups(result);
    await proofOperationStore.markProofOperationCompleted(
      entry.operationId,
      final,
    );
    return final;
  }

  throw new Error(
    `Proof operation ${entry.operationId} is still pending at the mint`,
  );
}

function operationReturnsSendProofs(kind: ProofOperationKind): boolean {
  return kind === "swap-lock" || kind === "proof-split";
}

function operationKeepsUnselectedInputs(kind: ProofOperationKind): boolean {
  return operationReturnsSendProofs(kind);
}

function requiredProofOperationStore(
  operationId: string,
  proofOperationStore: ProofOperationStore | undefined,
): ProofOperationStore {
  if (!proofOperationStore) {
    throw new Error(
      `Proof operation ${operationId} requires a proofOperationStore`,
    );
  }
  return proofOperationStore;
}

async function walletForSourceProofs(
  mint: CashuMint,
  sourceProofs: Proof[],
): Promise<{
  wallet: CashuWallet;
  sendConfig: SendConfig | undefined;
  inputFeeSats: number;
}> {
  const wallet = new CashuWallet(mint, { unit: CASHU_SWAP_UNIT });
  await wallet.loadMint();
  return {
    wallet,
    sendConfig: undefined,
    inputFeeSats: amountToNumber(wallet.getFeesForProofs(sourceProofs)),
  };
}

function hasLocalCtfProofMetadata(proof: Proof): boolean {
  const candidate = proof as Proof & {
    conditionId?: unknown;
    condition_id?: unknown;
    outcomeCollection?: unknown;
    outcome_collection?: unknown;
  };
  return (
    typeof candidate.conditionId === "string" ||
    typeof candidate.condition_id === "string" ||
    typeof candidate.outcomeCollection === "string" ||
    typeof candidate.outcome_collection === "string"
  );
}

function serializeOutputDataArray(
  outputs: Array<
    Pick<OutputDataLike, "blindedMessage" | "blindingFactor" | "secret">
  >,
): StoredOutputData[] {
  return outputs.map((output) => ({
    blindedMessage: {
      amount: amountToNumber(output.blindedMessage.amount),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor.toString(16),
    secret: bytesToHex(output.secret),
  }));
}

function toWireBlindedMessage(
  output: SerializedBlindedMessage,
): SerializedBlindedMessage {
  return {
    ...output,
    amount: amountToNumber(output.amount) as never,
  };
}

function serializeOutputDataArrayByLabel(
  groups: Record<
    string,
    Array<Pick<OutputDataLike, "blindedMessage" | "blindingFactor" | "secret">>
  >,
): Record<string, StoredOutputData[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([label, outputs]) => [
      label,
      serializeOutputDataArray(outputs),
    ]),
  );
}

function deserializeOutputGroups(
  groups: Record<string, StoredOutputData[]>,
  outputDataCtor: typeof OutputData = OutputData,
): Record<string, SwapOutputData[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, outputs]) => [
      group,
      outputs.map(
        (output) =>
          new outputDataCtor(
            {
              ...output.blindedMessage,
              amount: ctfAmount(output.blindedMessage.amount),
            } as never,
            BigInt(`0x${output.blindingFactor}`),
            hexToBytes(output.secret),
          ) as SwapOutputData,
      ),
    ]),
  );
}

async function restoreOutputGroups(
  mintUrl: string,
  outputs: Record<string, StoredOutputData[]>,
  outputDataCtor: typeof OutputData = OutputData,
  mintCtor: typeof CashuMint = CashuMint,
  normalizeSignature: (
    signature: SerializedBlindedSignature,
  ) => SerializedBlindedSignature = (signature) => signature,
): Promise<Record<string, Proof[]>> {
  const mint = new mintCtor(mintUrl);
  const rows = Object.entries(
    deserializeOutputGroups(outputs, outputDataCtor),
  ).flatMap(([group, groupOutputs]) =>
    groupOutputs.map((output, index) => ({ group, index, output })),
  );
  if (rows.length === 0) return {};

  const response = await mint.restore({
    outputs: rows.map((row) => toWireBlindedMessage(row.output.blindedMessage)),
  });
  if (response.signatures.length !== response.outputs.length) {
    throw new Error(
      "Mint restore response had mismatched output/signature counts",
    );
  }
  const signaturesByOutput = new Map<string, SerializedBlindedSignature>();
  response.outputs.forEach((output, index) => {
    signaturesByOutput.set(
      blindedMessageKey(output),
      response.signatures[index],
    );
  });

  const keysets = new Map<string, MintKeys>();
  const getKeyset = async (keysetId: string): Promise<MintKeys> => {
    const cached = keysets.get(keysetId);
    if (cached) return cached;
    const keysetResponse = await mint.getKeys(keysetId);
    const keyset = keysetResponse.keysets.find(
      (candidate) => candidate.id === keysetId,
    );
    if (!keyset)
      throw new Error(`Mint did not return keys for keyset ${keysetId}`);
    keysets.set(keysetId, keyset);
    return keyset;
  };

  const restored: Record<string, Proof[]> = {};
  for (const row of rows) {
    const signature = signaturesByOutput.get(
      blindedMessageKey(row.output.blindedMessage),
    );
    if (!signature) {
      throw new Error(
        `Mint restore did not return signature for output ${row.group}[${row.index}]`,
      );
    }
    const keyset = await getKeyset(row.output.blindedMessage.id);
    const proof = row.output.toProof(normalizeSignature(signature), keyset);
    restored[row.group] = [...(restored[row.group] ?? []), proof];
  }
  return normalizeProofGroups(restored);
}

function normalizeCtfSignature(
  signature: SerializedBlindedSignature,
): SerializedBlindedSignature {
  const amount = signature.amount as unknown;
  const hasCtfAmountShape =
    amount &&
    typeof amount === "object" &&
    "isZero" in amount &&
    typeof amount.isZero === "function" &&
    "equals" in amount &&
    typeof amount.equals === "function";
  return {
    ...signature,
    amount: (hasCtfAmountShape
      ? amount
      : Amount.from(amountToNumber(amount))) as never,
  };
}

async function fetchMintKeys(
  mint: CashuMint,
  keysetId: string,
): Promise<MintKeys> {
  const response = await mint.getKeys(keysetId);
  const keyset = response.keysets.find(
    (candidate) => candidate.id === keysetId,
  );
  if (!keyset) {
    throw new Error(`Mint did not return keys for keyset ${keysetId}`);
  }
  return keyset;
}

function singleProofKeysetId(proofs: Proof[]): string {
  const ids = new Set(proofs.map((proof) => proof.id).filter(Boolean));
  if (ids.size !== 1) {
    throw new Error("Atomic swap proof set must use exactly one keyset");
  }
  return [...ids][0];
}

function groupProofsByKeyset(proofs: Proof[]): Map<string, Proof[]> {
  const groups = new Map<string, Proof[]>();
  for (const proof of proofs) {
    if (!proof.id) {
      throw new Error("Atomic swap proof is missing its keyset id");
    }
    const group = groups.get(proof.id);
    if (group) group.push(proof);
    else groups.set(proof.id, [proof]);
  }
  return groups;
}

function proofOperationOptionsForKeyset(
  options: ProofOperationOptions,
  keysetId: string,
  groupCount: number,
): ProofOperationOptions {
  if (!options.operationId || groupCount === 1) return options;
  return {
    ...options,
    operationId: `${options.operationId}/keyset/${encodeURIComponent(keysetId)}`,
  };
}

function requireDurableOperationForMultiKeyset(
  groupCount: number,
  options: ProofOperationOptions,
  operationName: string,
): void {
  if (groupCount <= 1) return;
  if (options.operationId && options.proofOperationStore) return;
  throw new Error(
    `${operationName}: multi-keyset conditional swaps require a proof operation store`,
  );
}

function stripLocalProofMetadata(proof: Proof): Proof {
  return {
    id: proof.id,
    amount: amountToNumber(proof.amount) as never,
    secret: proof.secret,
    C: proof.C,
    ...(proof.witness ? { witness: proof.witness } : {}),
  };
}

function assertProofOperationMatches(
  entry: ProofOperationRecord,
  kind: ProofOperationRecord["kind"],
  mintUrl: string,
  inputs: Proof[],
): void {
  if (
    entry.kind !== kind ||
    entry.mintUrl !== normalizeUrl(mintUrl) ||
    proofInputFingerprint(entry.inputs) !== proofInputFingerprint(inputs)
  ) {
    throw new Error(
      `Proof operation ${entry.operationId} does not match this swap step`,
    );
  }
}

function proofInputFingerprint(proofs: Proof[]): string {
  return JSON.stringify(
    proofs.map((proof) => ({
      id: proof.id,
      amount: amountToNumber(proof.amount),
      secret: proof.secret,
      C: proof.C,
    })),
  );
}

function allStates(states: ProofState[], expected: string): boolean {
  return states.length > 0 && states.every((state) => state.state === expected);
}

function swapPreviewMetadata(preview: SwapPreview): Record<string, unknown> {
  return {
    amount: amountToNumber(preview.amount),
    fees: amountToNumber(preview.fees),
    keysetId: preview.keysetId,
    unselectedProofs: normalizeProofArray(preview.unselectedProofs ?? []),
  };
}

function entryToSwapPreview(entry: ProofOperationRecord): SwapPreview {
  return {
    amount: readNumberMetadata(entry, "amount"),
    fees: readNumberMetadata(entry, "fees"),
    keysetId: readStringMetadata(entry, "keysetId"),
    inputs: entry.inputs,
    sendOutputs:
      deserializeOutputGroups({ send: entry.outputs.send ?? [] }).send ?? [],
    keepOutputs:
      deserializeOutputGroups({ keep: entry.outputs.keep ?? [] }).keep ?? [],
    unselectedProofs: readUnselectedProofs(entry),
  } as unknown as SwapPreview;
}

function readUnselectedProofs(entry: ProofOperationRecord): Proof[] {
  const value = entry.metadata.unselectedProofs;
  return Array.isArray(value) ? (structuredClone(value) as Proof[]) : [];
}

function readNumberMetadata(entry: ProofOperationRecord, key: string): number {
  const value = entry.metadata[key];
  if (typeof value !== "number") {
    throw new Error(
      `Proof operation ${entry.operationId} is missing numeric metadata ${key}`,
    );
  }
  return value;
}

function readStringMetadata(entry: ProofOperationRecord, key: string): string {
  const value = entry.metadata[key];
  if (typeof value !== "string") {
    throw new Error(
      `Proof operation ${entry.operationId} is missing string metadata ${key}`,
    );
  }
  return value;
}

function blindedMessageKey(output: SerializedBlindedMessage): string {
  return `${output.id}:${output.B_}`;
}

function sumProofs(proofs: Proof[]): number {
  return proofs.reduce(
    (total, proof) => total + amountToNumber(proof.amount),
    0,
  );
}

function amountToNumber(amount: unknown): number {
  if (typeof amount === "number") return validateAmountNumber(amount);
  if (typeof amount === "bigint") return validateAmountNumber(Number(amount));
  if (typeof amount === "string") return validateAmountNumber(Number(amount));
  if (
    amount &&
    typeof amount === "object" &&
    "toNumber" in amount &&
    typeof amount.toNumber === "function"
  ) {
    return validateAmountNumber(Number(amount.toNumber()));
  }
  if (amount && typeof amount === "object" && "value" in amount) {
    return amountToNumber((amount as { value: unknown }).value);
  }
  return validateAmountNumber(Number(amount));
}

function validateAmountNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Cashu amount must be a non-negative safe integer");
  }
  return value;
}

function ctfAmount(amount: unknown): never {
  return Amount.from(amountToNumber(amount)) as never;
}

function normalizeProof(proof: Proof): Proof {
  return {
    ...proof,
    amount: amountToNumber(proof.amount) as never,
  };
}

function normalizeProofArray(proofs: Proof[]): Proof[] {
  return proofs.map(normalizeProof);
}

function normalizeProofGroups(
  groups: Record<string, Proof[]>,
): Record<string, Proof[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([label, proofs]) => [
      label,
      normalizeProofArray(proofs),
    ]),
  );
}

// ---------------------------------------------------------------------------
// High-level convenience wrappers
// ---------------------------------------------------------------------------

export type { AdaptorPoint };
export { generateAdaptorPoint };
