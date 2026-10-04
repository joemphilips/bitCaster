import {
  PaymentRequest,
  PaymentRequestTransportType,
  type PaymentRequestPayload,
} from '@cashu/cashu-ts'
import { schnorr } from '@noble/curves/secp256k1.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { CTF_COLLATERAL_UNIT, type CtfCollateralUnit } from './marketUnits.ts'
import { amountToNumber } from './proofSelection.ts'

export interface PaymentRequestReceiveKeyPair {
  readonly privateKey: Uint8Array
  readonly privateKeyHex: string
  readonly publicKey: string
}

/** Use the wallet seed. The login signer is not the payment receive identity. */
export function derivePaymentRequestReceiveKeyPair(
  walletSeed: Uint8Array,
): PaymentRequestReceiveKeyPair {
  if (!(walletSeed instanceof Uint8Array) || walletSeed.length !== 64) {
    throw new Error('payment receive identity requires a 64-byte wallet seed')
  }
  const privateKey = walletSeed.slice(0, 32)
  try {
    return {
      privateKey,
      privateKeyHex: bytesToHex(privateKey),
      publicKey: bytesToHex(schnorr.getPublicKey(privateKey)),
    }
  } catch {
    throw new Error('payment receive identity has an invalid private key')
  }
}

export interface CreatedCashuPaymentRequest {
  readonly encoded: string
  readonly id: string
  readonly request: PaymentRequest
}

/** The adapter supplies the receive identity's nprofile and records the pending request. */
export function createAmountlessCashuPaymentRequest(input: {
  readonly id: string
  readonly mintUrl: string
  readonly nprofile: string
}): CreatedCashuPaymentRequest {
  if (!input.id || !input.mintUrl || !input.nprofile.startsWith('nprofile1')) {
    throw new Error('payment request requires an id, mint, and receive nprofile')
  }
  const request = new PaymentRequest(
    [{ type: PaymentRequestTransportType.NOSTR, target: input.nprofile, tags: [['n', '17']] }],
    input.id,
    undefined,
    CTF_COLLATERAL_UNIT,
    [normalizePaymentRequestMintUrl(input.mintUrl)],
    undefined,
  )
  return { encoded: request.toEncodedRequest(), id: input.id, request }
}

export interface PendingCashuPaymentRequestBinding {
  readonly id: string
  readonly mintUrl: string
  readonly walletScopeId: string
}

export interface MatchedCashuPaymentRequestMessage {
  readonly payload: PaymentRequestPayload & { id: string }
  readonly normalizedMint: string
  readonly unit: CtfCollateralUnit
}

/** Match transport data before mint I/O. This does not verify or credit proofs. */
export function readPendingCashuPaymentRequestMessage(input: {
  readonly content: string
  readonly walletScopeId: string
  readonly readPending: (id: string) => PendingCashuPaymentRequestBinding | undefined
}): MatchedCashuPaymentRequestMessage | null {
  try {
    const value: unknown = JSON.parse(input.content)
    if (
      !isRecord(value) ||
      typeof value.id !== 'string' ||
      value.id.length === 0 ||
      typeof value.mint !== 'string' ||
      value.mint.length === 0 ||
      !Array.isArray(value.proofs) ||
      value.proofs.length === 0 ||
      !value.proofs.every(isProofMessage)
    )
      return null
    const normalizedMint = normalizePaymentRequestMintUrl(value.mint)
    const pending = input.readPending(value.id)
    if (
      pending === undefined ||
      pending.id !== value.id ||
      pending.walletScopeId !== input.walletScopeId ||
      pending.mintUrl !== normalizedMint
    )
      return null
    switch (value.unit) {
      case CTF_COLLATERAL_UNIT:
        break
      default:
        return null
    }
    return {
      payload: value as PaymentRequestPayload & { id: string },
      normalizedMint,
      unit: CTF_COLLATERAL_UNIT,
    }
  } catch {
    return null
  }
}

/** Keep request URL matching consistent with the existing browser adapter. */
export function normalizePaymentRequestMintUrl(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.hash = ''
    parsed.search = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return url.trim().replace(/\/+$/, '')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isProofMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.secret === 'string' &&
    value.secret.length > 0 &&
    typeof value.C === 'string' &&
    value.C.length > 0 &&
    isAmountMessage(value.amount)
  )
}

function isAmountMessage(value: unknown): boolean {
  if (typeof value === 'string' && !/^[1-9][0-9]*$/.test(value)) return false
  return (typeof value === 'number' || typeof value === 'string') && amountToNumber(value) > 0
}
