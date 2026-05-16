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
  MintKeyset,
  OutputConfig,
  OutputDataLike,
  Proof,
  ProofState,
  SendConfig,
  SerializedBlindedMessage,
  SerializedBlindedSignature,
  SwapPreview,
  Token,
} from '@cashu/cashu-ts'
import {
  CheckStateEnum,
  Mint as CashuMint,
  OutputData,
  Wallet as CashuWallet,
  hashToCurve,
} from '@cashu/cashu-ts'
import { schnorr } from '@noble/curves/secp256k1.js'
import {
  type EphemeralKeypair,
  computeSharedSecret,
  deriveEncryptionKey,
  encrypt,
  decrypt,
  hexToBytes,
} from './ecdh'
import {
  type AdaptorPoint,
  generateAdaptorPoint,
  preSign,
  preVerify,
  adapt,
  extract,
} from './adaptor'
import { normalizeUrl } from './url'

// ---------------------------------------------------------------------------
// Swap context
// ---------------------------------------------------------------------------

export interface SwapContext {
  tradeId: string
  role: 'seller' | 'buyer'
  ephemeralKey: EphemeralKeypair
  counterpartyPubkey: string
  /**
   * Unix seconds — seller's (Alice's) YES-proof locktime `T_YES`. Per the
   * spec this MUST be later than the buyer's `T_sat` so that Bob has time to
   * extract `t` after Alice spends. See
   * bitCaster-doc/src/content/docs/technical/protocol/atomic-swap.md
   * §"Locktime Constraints" — the invariant is `T_YES > T_sat + Δ`.
   */
  sellerLocktime: number
  /**
   * Unix seconds — buyer's (Bob's) sat-proof locktime `T_sat`. Shorter than
   * the seller's locktime by at least `MIN_LOCKTIME_DELTA_SECS`.
   */
  buyerLocktime: number
  mintUrl: string
}

// ---------------------------------------------------------------------------
// Locktime invariants (defense-in-depth)
// ---------------------------------------------------------------------------

/**
 * Minimum gap between the seller's and buyer's locktimes, in seconds. Mirrors
 * the wallet-service's constant of the same name and the engine's
 * `MinLocktimeDelta` value.
 */
export const MIN_LOCKTIME_DELTA_SECS = 5
const CASHU_SWAP_UNIT = 'sat'

interface LockedProofResult {
  lockedProofs: Proof[]
  changeProofs: Proof[]
}

export interface StoredOutputData {
  blindedMessage: SerializedBlindedMessage
  blindingFactor: string
  secret: string
}

export type ProofOperationKind = 'swap-lock' | 'swap-claim' | 'ctf-split'
export type ProofOperationState = 'prepared' | 'completed' | 'failed'

export interface ProofOperationRecord {
  operationId: string
  kind: ProofOperationKind
  state: ProofOperationState
  mintUrl: string
  inputs: Proof[]
  outputs: Record<string, StoredOutputData[]>
  metadata: Record<string, unknown>
  resultProofs?: Record<string, Proof[]>
  lastError?: string | null
  createdAt: number
  updatedAt: number
}

export interface PrepareProofOperationInput {
  operationId: string
  kind: ProofOperationKind
  mintUrl: string
  inputs: Proof[]
  outputs: Record<string, StoredOutputData[]>
  metadata?: Record<string, unknown>
}

export interface ProofOperationStore {
  getProofOperation(operationId: string): Promise<ProofOperationRecord | null>
  prepareProofOperation(input: PrepareProofOperationInput): Promise<ProofOperationRecord>
  markProofOperationCompleted(
    operationId: string,
    resultProofs: Record<string, Proof[]>,
  ): Promise<ProofOperationRecord>
}

interface ProofOperationOptions {
  operationId?: string
  proofOperationStore?: ProofOperationStore
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
    return 'Trade rejected: invalid locktime values from engine.'
  }
  if (sellerLocktime <= buyerLocktime + MIN_LOCKTIME_DELTA_SECS) {
    return (
      `Trade rejected: locktime ordering violates protocol invariant ` +
      `(sellerLocktime=${sellerLocktime}, buyerLocktime=${buyerLocktime}). ` +
      `Seller's locktime must exceed buyer's by at least ` +
      `${MIN_LOCKTIME_DELTA_SECS}s.`
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Internal wire messages
// ---------------------------------------------------------------------------

interface AdaptorPointMsg {
  point: string   // hex-encoded 33-byte T = t·G
}

interface LockedProofsMsg {
  proofs: Proof[]
  /** Array of hex-encoded 65-byte pre-sigs, one per proof */
  preSigs: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer)
  return new Uint8Array(buf)
}

async function messageToHash(secret: string): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(secret)
  return sha256(enc)
}

function hexStr(bytes: Uint8Array): string {
  return bytesToHex(bytes)
}

function encodeProofsMsg(msg: LockedProofsMsg): string {
  return JSON.stringify(msg)
}

function decodeProofsMsg(raw: string): LockedProofsMsg {
  return JSON.parse(raw) as LockedProofsMsg
}

function encodeAdaptorPointMsg(msg: AdaptorPointMsg): string {
  return JSON.stringify(msg)
}

function decodeAdaptorPointMsg(raw: string): AdaptorPointMsg {
  return JSON.parse(raw) as AdaptorPointMsg
}

// ---------------------------------------------------------------------------
// Encryption helpers using ECDH shared key
// ---------------------------------------------------------------------------

async function buildSharedKey(ctx: SwapContext): Promise<CryptoKey> {
  const shared = computeSharedSecret(
    ctx.ephemeralKey.privateKey,
    ctx.counterpartyPubkey,
  )
  return deriveEncryptionKey(shared)
}

async function encryptMsg(ctx: SwapContext, plaintext: string): Promise<string> {
  const key = await buildSharedKey(ctx)
  return encrypt(key, plaintext)
}

async function decryptMsg(ctx: SwapContext, ciphertext: string): Promise<string> {
  const key = await buildSharedKey(ctx)
  return decrypt(key, ciphertext)
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
  adaptorPointCipher: string
  lockedProofsCipher: string
  adaptorPoint: AdaptorPoint
  lockedProofs: Proof[]
  changeProofs: Proof[]
}> {
  // Ask the mint to swap Alice's proofs into P2PK-locked proofs. Rewriting a
  // proof secret locally invalidates its mint signature (`C`).
  const { lockedProofs, changeProofs } = await lockProofsForSwap(
    ctx,
    proofs,
    ctx.sellerLocktime,
    options.operationId,
    options.proofOperationStore,
  )
  return sellerPreparePrelockedSwap(ctx, lockedProofs, changeProofs)
}

/**
 * Seller step for proofs that were already minted with the swap P2PK lock.
 * Used by CTF maker-as-splitter settlement, where CDK rejects normal swaps
 * of conditional inputs but accepts P2PK conditional outputs from `/ctf/split`.
 */
export async function sellerPreparePrelockedSwap(
  ctx: SwapContext,
  lockedProofs: Proof[],
  changeProofs: Proof[] = [],
): Promise<{
  adaptorPointCipher: string
  lockedProofsCipher: string
  adaptorPoint: AdaptorPoint
  lockedProofs: Proof[]
  changeProofs: Proof[]
}> {
  const adaptorPoint = generateAdaptorPoint()

  // Pre-sign each proof's secret
  const privBytes = ctx.ephemeralKey.privateKey
  const preSigs = await Promise.all(
    lockedProofs.map(async (proof) => {
      const msgHash = await messageToHash(proof.secret)
      const sig = preSign(privBytes, msgHash, adaptorPoint.point)
      return hexStr(sig)
    }),
  )

  const adaptorPointMsg: AdaptorPointMsg = {
    point: hexStr(adaptorPoint.point),
  }

  const lockedProofsMsg: LockedProofsMsg = { proofs: lockedProofs, preSigs }

  const adaptorPointCipher = await encryptMsg(
    ctx,
    encodeAdaptorPointMsg(adaptorPointMsg),
  )
  const lockedProofsCipher = await encryptMsg(
    ctx,
    encodeProofsMsg(lockedProofsMsg),
  )

  return {
    adaptorPointCipher,
    lockedProofsCipher,
    adaptorPoint,
    lockedProofs,
    changeProofs,
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
  const plaintext = await decryptMsg(ctx, bobLockedProofsCipher)
  const { proofs: bobProofs, preSigs: bobPreSigsHex } =
    decodeProofsMsg(plaintext)

  // Verify each pre-sig
  const counterpartyPubBytes = hexToBytes(ctx.counterpartyPubkey)
  for (let i = 0; i < bobProofs.length; i++) {
    const msgHash = await messageToHash(bobProofs[i].secret)
    const preSigBytes = hexToBytes(bobPreSigsHex[i])
    const valid = preVerify(
      counterpartyPubBytes,
      msgHash,
      preSigBytes,
      adaptorPoint.point,
    )
    if (!valid) throw new Error(`Bob pre-sig ${i} failed verification`)
  }

  // Adapt each pre-sig
  const adaptedWitnesses = await Promise.all(
    bobProofs.map(async (proof, i) => {
      const msgHash = await messageToHash(proof.secret)
      const preSigBytes = hexToBytes(bobPreSigsHex[i])
      const sig = adapt(preSigBytes, adaptorPoint.secret)
      const ownSig = schnorr.sign(msgHash, ctx.ephemeralKey.privateKey)
      return {
        proof,
        adaptedSig: hexStr(sig),
        ownSig: hexStr(ownSig),
      }
    }),
  )

  // Attach adapted signatures as NUT-11 witnesses
  const inputProofs = adaptedWitnesses.map(({ proof, adaptedSig, ownSig }) => ({
    ...proof,
    witness: JSON.stringify({ signatures: [adaptedSig, ownSig] }),
  }))

  return receiveProofsAtMint(
    ctx.mintUrl,
    inputProofs,
    options.operationId,
    options.proofOperationStore,
  )
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
  lockedProofsCipher: string
  adaptorPointHex: string
  lockedProofs: Proof[]
  changeProofs: Proof[]
  preSigsHex: string[]
  sellerPreSigsHex: string[]
}> {
  // Decrypt Alice's messages
  const aptPlain = await decryptMsg(ctx, aliceAdaptorPointCipher)
  const lockedPlain = await decryptMsg(ctx, aliceLockedProofsCipher)

  const { point: adaptorPointHex } = decodeAdaptorPointMsg(aptPlain)
  const {
    proofs: aliceProofs,
    preSigs: alicePreSigsHex,
  } = decodeProofsMsg(lockedPlain)

  const adaptorPointBytes = hexToBytes(adaptorPointHex)
  const counterpartyPubBytes = hexToBytes(ctx.counterpartyPubkey)

  // Verify Alice's pre-sigs
  for (let i = 0; i < aliceProofs.length; i++) {
    const msgHash = await messageToHash(aliceProofs[i].secret)
    const preSigBytes = hexToBytes(alicePreSigsHex[i])
    const valid = preVerify(
      counterpartyPubBytes,
      msgHash,
      preSigBytes,
      adaptorPointBytes,
    )
    if (!valid) throw new Error(`Alice pre-sig ${i} failed verification`)
  }

  const { lockedProofs, changeProofs } = await lockProofsForSwap(
    ctx,
    satProofs,
    ctx.buyerLocktime,
    options.operationId,
    options.proofOperationStore,
  )

  // Pre-sign Bob's proofs with the same adaptor point T
  const privBytes = ctx.ephemeralKey.privateKey
  const preSigsHex = await Promise.all(
    lockedProofs.map(async (proof) => {
      const msgHash = await messageToHash(proof.secret)
      const sig = preSign(privBytes, msgHash, adaptorPointBytes)
      return hexStr(sig)
    }),
  )

  const lockedProofsMsg: LockedProofsMsg = { proofs: lockedProofs, preSigs: preSigsHex }
  const lockedProofsCipher = await encryptMsg(
    ctx,
    encodeProofsMsg(lockedProofsMsg),
  )

  return {
    lockedProofsCipher,
    adaptorPointHex,
    lockedProofs,
    changeProofs,
    preSigsHex,
    sellerPreSigsHex: alicePreSigsHex,
  }
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
    const secretBytes = new TextEncoder().encode(p.secret)
    const point = hashToCurve(secretBytes)
    return point.toHex(true)
  })

  const res = await fetch(`${mintUrl}/v1/checkstate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Ys }),
  })
  if (!res.ok) return null

  interface CheckStateEntry {
    Y: string
    state: string
    witness?: string
  }

  const { states } = (await res.json()) as { states: CheckStateEntry[] }
  const spent = states.find(
    (s: CheckStateEntry) => s.state === 'SPENT' && s.witness,
  )
  if (!spent?.witness) return null

  const witnessObj = JSON.parse(spent.witness) as { signatures: string[] }
  const sigHex = witnessObj.signatures?.[0]
  if (!sigHex) return null

  // Correlate the spent Y back to the original preSigsHex index via the
  // Ys array (same order as spentProofs / preSigsHex).
  const yToIndex = new Map(Ys.map((y, i) => [y, i]))
  const idx = yToIndex.get(spent.Y)
  if (idx === undefined || !preSigsHex[idx]) return null

  const sig = hexToBytes(sigHex)
  const preSig = hexToBytes(preSigsHex[idx])
  return extract(sig, preSig)
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
  const lockedPlain = await decryptMsg(ctx, aliceLockedProofsCipher)
  const { proofs: aliceProofs } = decodeProofsMsg(lockedPlain)

  // Adapt each of Alice's pre-sigs
  const adaptedSigs = alicePreSigsHex.map((hex) => {
    const preSig = hexToBytes(hex)
    return hexStr(adapt(preSig, adaptorSecret))
  })

  const inputProofs = await Promise.all(
    aliceProofs.map(async (proof, i) => ({
      ...proof,
      witness: JSON.stringify({
        signatures: [
          adaptedSigs[i],
          hexStr(schnorr.sign(await messageToHash(proof.secret), ctx.ephemeralKey.privateKey)),
        ],
      }),
    })),
  )

  try {
    return await receiveProofsAtMint(
      ctx.mintUrl,
      inputProofs,
      options.operationId,
      options.proofOperationStore,
    )
  } catch (error) {
    if (!isConditionalSwapInputError(error)) throw error
    // CDK currently rejects normal `/swap` inputs that use conditional CTF
    // keysets. At this point Bob has valid adaptor-revealed witnesses for
    // Alice's P2PK-locked outcome proofs, so keep those witnessed proofs as
    // the claimed position rather than attempting an unsupported refresh.
    return inputProofs
  }
}

export function buildReceiveToken(mintUrl: string, proofs: Proof[]): Token {
  return { mint: mintUrl, unit: CASHU_SWAP_UNIT, proofs }
}

async function lockProofsForSwap(
  ctx: SwapContext,
  sourceProofs: Proof[],
  locktime: number,
  operationId?: string,
  proofOperationStore?: ProofOperationStore,
): Promise<LockedProofResult> {
  const mint = new CashuMint(ctx.mintUrl)
  const { wallet, sendConfig, inputFeeSats } = await walletForSourceProofs(
    mint,
    sourceProofs,
  )

  const amount = sumProofs(sourceProofs) - inputFeeSats
  if (amount <= 0) throw new Error('Not enough proofs to cover Cashu swap fees')

  const outputConfig: OutputConfig = {
    send: {
      type: 'p2pk',
      options: {
        pubkey: [ctx.ephemeralKey.publicKey, ctx.counterpartyPubkey],
        requiredSignatures: 2,
        locktime,
        refundKeys: [ctx.ephemeralKey.publicKey],
        sigFlag: 'SIG_INPUTS',
      },
    },
    keep: { type: 'random' },
  }
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
    )
  }

  const { send, keep } = await wallet.send(amount, sourceProofs, sendConfig, outputConfig)
  return { lockedProofs: send, changeProofs: keep }
}

async function receiveProofsAtMint(
  mintUrl: string,
  inputProofs: Proof[],
  operationId?: string,
  proofOperationStore?: ProofOperationStore,
): Promise<Proof[]> {
  const mint = new CashuMint(mintUrl)
  const { wallet } = await walletForSourceProofs(mint, inputProofs)
  const token = buildReceiveToken(mintUrl, inputProofs)
  if (operationId) {
    return receiveProofsWithOperation(
      operationId,
      mintUrl,
      wallet,
      token,
      requiredProofOperationStore(operationId, proofOperationStore),
    )
  }
  return wallet.receive(token, { proofsWeHave: [] })
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
  const existing = await proofOperationStore.getProofOperation(operationId)
  if (existing) {
    assertProofOperationMatches(existing, 'swap-lock', mintUrl, sourceProofs)
    const result = await resumeProofOperation(wallet, existing, proofOperationStore)
    return {
      lockedProofs: result.send ?? [],
      changeProofs: result.keep ?? [],
    }
  }

  const preview = await wallet.prepareSwapToSend(
    amount,
    sourceProofs,
    sendConfig,
    outputConfig,
  )
  await proofOperationStore.prepareProofOperation({
    operationId,
    kind: 'swap-lock',
    mintUrl,
    inputs: preview.inputs,
    outputs: {
      send: serializeOutputDataArray(preview.sendOutputs ?? []),
      keep: serializeOutputDataArray(preview.keepOutputs ?? []),
    },
    metadata: swapPreviewMetadata(preview),
  })

  const result = await wallet.completeSwap(preview)
  const final = { send: result.send, keep: result.keep }
  await proofOperationStore.markProofOperationCompleted(operationId, final)
  return { lockedProofs: final.send, changeProofs: final.keep }
}

async function receiveProofsWithOperation(
  operationId: string,
  mintUrl: string,
  wallet: CashuWallet,
  token: Token,
  proofOperationStore: ProofOperationStore,
): Promise<Proof[]> {
  const existing = await proofOperationStore.getProofOperation(operationId)
  if (existing) {
    assertProofOperationMatches(existing, 'swap-claim', mintUrl, token.proofs)
    const result = await resumeProofOperation(wallet, existing, proofOperationStore)
    return result.keep ?? []
  }

  const preview = await wallet.prepareSwapToReceive(
    token,
    { proofsWeHave: [] },
    { type: 'random' },
  )
  await proofOperationStore.prepareProofOperation({
    operationId,
    kind: 'swap-claim',
    mintUrl,
    inputs: preview.inputs,
    outputs: {
      keep: serializeOutputDataArray(preview.keepOutputs ?? []),
    },
    metadata: swapPreviewMetadata(preview),
  })

  const result = await wallet.completeSwap(preview)
  const final = { keep: result.keep }
  await proofOperationStore.markProofOperationCompleted(operationId, final)
  return final.keep
}

async function resumeProofOperation(
  wallet: CashuWallet,
  entry: ProofOperationRecord,
  proofOperationStore: ProofOperationStore,
): Promise<Record<string, Proof[]>> {
  if (entry.state === 'completed') {
    return structuredClone(entry.resultProofs ?? {})
  }
  if (entry.state === 'failed') {
    throw new Error(
      `Proof operation ${entry.operationId} previously failed: ${entry.lastError ?? 'unknown error'}`,
    )
  }

  const states = await wallet.checkProofsStates(
    entry.inputs.map(({ secret }) => ({ secret })),
  )
  if (allStates(states, CheckStateEnum.SPENT)) {
    const restored = await restoreOutputGroups(entry.mintUrl, entry.outputs)
    if (entry.kind === 'swap-lock') {
      restored.keep = [...(restored.keep ?? []), ...readUnselectedProofs(entry)]
    }
    await proofOperationStore.markProofOperationCompleted(entry.operationId, restored)
    return restored
  }
  if (allStates(states, CheckStateEnum.UNSPENT)) {
    const result = await wallet.completeSwap(entryToSwapPreview(entry))
    const final: Record<string, Proof[]> =
      entry.kind === 'swap-lock'
        ? { send: result.send, keep: result.keep }
        : { keep: result.keep }
    await proofOperationStore.markProofOperationCompleted(entry.operationId, final)
    return final
  }

  throw new Error(`Proof operation ${entry.operationId} is still pending at the mint`)
}

function requiredProofOperationStore(
  operationId: string,
  proofOperationStore: ProofOperationStore | undefined,
): ProofOperationStore {
  if (!proofOperationStore) {
    throw new Error(`Proof operation ${operationId} requires a proofOperationStore`)
  }
  return proofOperationStore
}

async function walletForSourceProofs(
  mint: CashuMint,
  sourceProofs: Proof[],
): Promise<{
  wallet: CashuWallet
  sendConfig: SendConfig | undefined
  inputFeeSats: number
}> {
  const wallet = new CashuWallet(mint, { unit: CASHU_SWAP_UNIT })
  await wallet.loadMint()
  try {
    return {
      wallet,
      sendConfig: undefined,
      inputFeeSats: wallet.getFeesForProofs(sourceProofs),
    }
  } catch (error) {
    if (!isUnknownKeysetError(error)) throw error
  }

  const sourceKeysetId = singleProofKeysetId(sourceProofs)
  const mintInfo = await mint.getInfo()
  const keys = await fetchMintKeys(mint, sourceKeysetId)
  const keyset: MintKeyset = {
    id: sourceKeysetId,
    unit: CASHU_SWAP_UNIT,
    active: true,
    input_fee_ppk: 0,
  }
  const conditionalWallet = new CashuWallet(mint, {
    unit: CASHU_SWAP_UNIT,
    keysetId: sourceKeysetId,
    keys,
    keysets: [keyset],
    mintInfo,
  })
  // CTF conditional keyset ids are condition-derived, so cashu-ts' standard
  // NUT-02 keyset-id verifier can clear the keys during cache load.
  conditionalWallet.keyChain.getKeyset(sourceKeysetId).keys = keys.keys
  return {
    wallet: conditionalWallet,
    sendConfig: { keysetId: sourceKeysetId },
    inputFeeSats: 0,
  }
}

function serializeOutputDataArray(
  outputs: Array<Pick<OutputDataLike, 'blindedMessage' | 'blindingFactor' | 'secret'>>,
): StoredOutputData[] {
  return outputs.map((output) => ({
    blindedMessage: {
      amount: Number(output.blindedMessage.amount),
      id: output.blindedMessage.id,
      B_: output.blindedMessage.B_,
    },
    blindingFactor: output.blindingFactor.toString(16),
    secret: bytesToHex(output.secret),
  }))
}

function deserializeOutputGroups(
  groups: Record<string, StoredOutputData[]>,
): Record<string, OutputData[]> {
  return Object.fromEntries(
    Object.entries(groups).map(([group, outputs]) => [
      group,
      outputs.map(
        (output) =>
          new OutputData(
            output.blindedMessage,
            BigInt(`0x${output.blindingFactor}`),
            hexToBytes(output.secret),
          ),
      ),
    ]),
  )
}

async function restoreOutputGroups(
  mintUrl: string,
  outputs: Record<string, StoredOutputData[]>,
): Promise<Record<string, Proof[]>> {
  const mint = new CashuMint(mintUrl)
  const rows = Object.entries(deserializeOutputGroups(outputs)).flatMap(
    ([group, groupOutputs]) =>
      groupOutputs.map((output, index) => ({ group, index, output })),
  )
  if (rows.length === 0) return {}

  const response = await mint.restore({
    outputs: rows.map((row) => row.output.blindedMessage),
  })
  if (response.signatures.length !== response.outputs.length) {
    throw new Error('Mint restore response had mismatched output/signature counts')
  }
  const signaturesByOutput = new Map<string, SerializedBlindedSignature>()
  response.outputs.forEach((output, index) => {
    signaturesByOutput.set(blindedMessageKey(output), response.signatures[index])
  })

  const keysets = new Map<string, MintKeys>()
  const getKeyset = async (keysetId: string): Promise<MintKeys> => {
    const cached = keysets.get(keysetId)
    if (cached) return cached
    const keysetResponse = await mint.getKeys(keysetId)
    const keyset = keysetResponse.keysets.find((candidate) => candidate.id === keysetId)
    if (!keyset) throw new Error(`Mint did not return keys for keyset ${keysetId}`)
    keysets.set(keysetId, keyset)
    return keyset
  }

  const restored: Record<string, Proof[]> = {}
  for (const row of rows) {
    const signature = signaturesByOutput.get(blindedMessageKey(row.output.blindedMessage))
    if (!signature) {
      throw new Error(`Mint restore did not return signature for output ${row.group}[${row.index}]`)
    }
    const keyset = await getKeyset(row.output.blindedMessage.id)
    const proof = row.output.toProof(signature, keyset)
    restored[row.group] = [...(restored[row.group] ?? []), proof]
  }
  return restored
}

async function fetchMintKeys(mint: CashuMint, keysetId: string): Promise<MintKeys> {
  const response = await mint.getKeys(keysetId)
  const keyset = response.keysets.find((candidate) => candidate.id === keysetId)
  if (!keyset) {
    throw new Error(`Mint did not return keys for keyset ${keysetId}`)
  }
  return keyset
}

function singleProofKeysetId(proofs: Proof[]): string {
  const ids = new Set(proofs.map((proof) => proof.id).filter(Boolean))
  if (ids.size !== 1) {
    throw new Error('Atomic swap proof set must use exactly one keyset')
  }
  return [...ids][0]
}

function isUnknownKeysetError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /No keyset found|Keyset '.+' not found/i.test(message)
}

function isConditionalSwapInputError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /Inputs must use the same conditional keyset/i.test(message)
}

function assertProofOperationMatches(
  entry: ProofOperationRecord,
  kind: ProofOperationRecord['kind'],
  mintUrl: string,
  inputs: Proof[],
): void {
  if (
    entry.kind !== kind ||
    entry.mintUrl !== normalizeUrl(mintUrl) ||
    proofInputFingerprint(entry.inputs) !== proofInputFingerprint(inputs)
  ) {
    throw new Error(`Proof operation ${entry.operationId} does not match this swap step`)
  }
}

function proofInputFingerprint(proofs: Proof[]): string {
  return JSON.stringify(
    proofs.map((proof) => ({
      id: proof.id,
      amount: proof.amount,
      secret: proof.secret,
      C: proof.C,
    })),
  )
}

function allStates(states: ProofState[], expected: string): boolean {
  return states.length > 0 && states.every((state) => state.state === expected)
}

function swapPreviewMetadata(preview: SwapPreview): Record<string, unknown> {
  return {
    amount: preview.amount,
    fees: preview.fees,
    keysetId: preview.keysetId,
    unselectedProofs: preview.unselectedProofs ?? [],
  }
}

function entryToSwapPreview(entry: ProofOperationRecord): SwapPreview {
  return {
    amount: readNumberMetadata(entry, 'amount'),
    fees: readNumberMetadata(entry, 'fees'),
    keysetId: readStringMetadata(entry, 'keysetId'),
    inputs: entry.inputs,
    sendOutputs: deserializeOutputGroups({ send: entry.outputs.send ?? [] }).send ?? [],
    keepOutputs: deserializeOutputGroups({ keep: entry.outputs.keep ?? [] }).keep ?? [],
    unselectedProofs: readUnselectedProofs(entry),
  }
}

function readUnselectedProofs(entry: ProofOperationRecord): Proof[] {
  const value = entry.metadata.unselectedProofs
  return Array.isArray(value) ? (structuredClone(value) as Proof[]) : []
}

function readNumberMetadata(entry: ProofOperationRecord, key: string): number {
  const value = entry.metadata[key]
  if (typeof value !== 'number') {
    throw new Error(`Proof operation ${entry.operationId} is missing numeric metadata ${key}`)
  }
  return value
}

function readStringMetadata(entry: ProofOperationRecord, key: string): string {
  const value = entry.metadata[key]
  if (typeof value !== 'string') {
    throw new Error(`Proof operation ${entry.operationId} is missing string metadata ${key}`)
  }
  return value
}

function blindedMessageKey(output: SerializedBlindedMessage): string {
  return `${output.id}:${output.B_}`
}

function sumProofs(proofs: Proof[]): number {
  return proofs.reduce((total, proof) => total + proof.amount, 0)
}

// ---------------------------------------------------------------------------
// High-level convenience wrappers
// ---------------------------------------------------------------------------

export type { AdaptorPoint }
export { generateAdaptorPoint }
