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

import type { Proof, Token } from '@cashu/cashu-ts'
import { Mint as CashuMint, Wallet as CashuWallet, hashToCurve } from '@cashu/cashu-ts'
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
import { createP2PKSecret } from './p2pk'

// ---------------------------------------------------------------------------
// Swap context
// ---------------------------------------------------------------------------

export interface SwapContext {
  tradeId: string
  role: 'seller' | 'buyer'
  ephemeralKey: EphemeralKeypair
  counterpartyPubkey: string
  /** Unix seconds — seller's locktime (should be shorter per spec) */
  sellerLocktime: number
  /** Unix seconds — buyer's locktime (longer so Bob can extract t) */
  buyerLocktime: number
  mintUrl: string
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
): Promise<{
  adaptorPointCipher: string
  lockedProofsCipher: string
  adaptorPoint: AdaptorPoint
  lockedProofs: Proof[]
}> {
  const adaptorPoint = generateAdaptorPoint()

  // Build P2PK-locked proofs pointing to Bob's pubkey
  const locktime = ctx.sellerLocktime
  const lockedProofs = proofs.map((proof) => ({
    ...proof,
    secret: createP2PKSecret({
      recipientPubkey: ctx.counterpartyPubkey,
      locktime,
      refundPubkey: ctx.ephemeralKey.publicKey,
    }),
  }))

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

  return { adaptorPointCipher, lockedProofsCipher, adaptorPoint, lockedProofs }
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
      const preSigBytes = hexToBytes(bobPreSigsHex[i])
      const sig = adapt(preSigBytes, adaptorPoint.secret)
      return {
        proof,
        adaptedSig: hexStr(sig),
      }
    }),
  )

  // Attach adapted signatures as NUT-11 witnesses
  const inputProofs = adaptedWitnesses.map(({ proof, adaptedSig }) => ({
    ...proof,
    witness: JSON.stringify({ signatures: [adaptedSig] }),
  }))

  // Swap at mint — wrap proofs in a Token object as required by cashu-ts v3
  const mint = new CashuMint(ctx.mintUrl)
  const wallet = new CashuWallet(mint, { unit: 'sat' })
  await wallet.loadMint()

  const token: Token = { mint: ctx.mintUrl, proofs: inputProofs }
  return wallet.receive(token, { proofsWeHave: [] })
}

// ---------------------------------------------------------------------------
// Buyer (Bob) flow
// ---------------------------------------------------------------------------

/**
 * Step 6: Bob receives Alice's adaptor point and locked proofs, verifies,
 * locks his sat proofs to Alice's pubkey, pre-signs, and returns
 * the ciphertext ready for `sendSwapMessage`.
 *
 * @returns { lockedProofsCipher, lockedProofs, preSigsHex }
 */
export async function buyerPrepareSwap(
  ctx: SwapContext,
  aliceAdaptorPointCipher: string,
  aliceLockedProofsCipher: string,
  satProofs: Proof[],
): Promise<{
  lockedProofsCipher: string
  adaptorPointHex: string
  lockedProofs: Proof[]
  preSigsHex: string[]
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

  // Lock Bob's sat proofs to Alice's pubkey
  const locktime = ctx.buyerLocktime
  const lockedProofs = satProofs.map((proof) => ({
    ...proof,
    secret: createP2PKSecret({
      recipientPubkey: ctx.counterpartyPubkey,
      locktime,
      refundPubkey: ctx.ephemeralKey.publicKey,
    }),
  }))

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

  return { lockedProofsCipher, adaptorPointHex, lockedProofs, preSigsHex }
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
): Promise<Proof[]> {
  const lockedPlain = await decryptMsg(ctx, aliceLockedProofsCipher)
  const { proofs: aliceProofs } = decodeProofsMsg(lockedPlain)

  // Adapt each of Alice's pre-sigs
  const adaptedSigs = alicePreSigsHex.map((hex) => {
    const preSig = hexToBytes(hex)
    return hexStr(adapt(preSig, adaptorSecret))
  })

  const inputProofs = aliceProofs.map((proof, i) => ({
    ...proof,
    witness: JSON.stringify({ signatures: [adaptedSigs[i]] }),
  }))

  const mint = new CashuMint(ctx.mintUrl)
  const wallet = new CashuWallet(mint, { unit: 'sat' })
  await wallet.loadMint()

  const token: Token = { mint: ctx.mintUrl, proofs: inputProofs }
  return wallet.receive(token, { proofsWeHave: [] })
}

// ---------------------------------------------------------------------------
// High-level convenience wrappers
// ---------------------------------------------------------------------------

export type { AdaptorPoint }
export { generateAdaptorPoint }
