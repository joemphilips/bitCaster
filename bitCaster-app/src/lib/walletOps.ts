import { PaymentRequest, PaymentRequestTransportType, type Proof, type Token } from '@cashu/cashu-ts'
import { decodeToken } from '@/lib/cashu'
import { deriveNostrKeyPair, getNostrNprofile } from '@/lib/nip17'
import { normalizeUrl } from '@/lib/url'
import { useSettingsStore } from '@/stores/settings'
import { useWalletStore, type StoredMint } from '@/stores/wallet'
import { amountToNumber } from '@bitcaster/client-sdk/proofSelection'
import { parseCashuProofUnit, type CashuProofUnit } from '@bitcaster/client-sdk/marketUnits'
import { effectiveRelayUrls, isAllowedNostrRelayUrl, isKnownPublicNostrRelayUrl } from '@/lib/relayDefaults'
import { receiveGuiCashuToken } from '@/stores/gui-ordinary-wallet-operation'
import { currentGuiWalletId } from '@/stores/proof-db'

export type WalletIngressSource = 'paste' | 'scan' | 'nip17'

export interface IngressMintRegistrationResult {
  added: boolean
  mintUrl: string
  source: WalletIngressSource
}

export interface IngressReceiveCashuTokenResult extends IngressMintRegistrationResult {
  amountSats: number
  unit: CashuProofUnit
  proofs: Proof[]
}

export interface DecodedWalletPaymentRequest {
  request: PaymentRequest
  source: WalletIngressSource
}

export interface CreatedWalletPaymentRequest {
  encoded: string
  id: string
  request: PaymentRequest
}

export function parseInboundCashuUnit(value: unknown): CashuProofUnit {
  if (value === undefined) return 'sat'
  if (typeof value !== 'string') {
    throw new Error('Unsupported Cashu token unit')
  }
  const unit = parseCashuProofUnit(value)
  if (unit === null) {
    throw new Error('Unsupported Cashu token unit')
  }
  return unit
}

export function getActiveMint(): StoredMint | undefined {
  const store = useWalletStore.getState()
  return store.mints.find((m) => m.url === store.activeMintUrl)
}

export function getKnownMints(): StoredMint[] {
  return [...useWalletStore.getState().mints]
}

export async function userAddAndSelectMint(url: string): Promise<void> {
  await useWalletStore.getState()._addMint(url)
}

export async function refreshMintInfoWithoutActivating(url: string): Promise<void> {
  await useWalletStore.getState()._addMintWithoutActivating(url)
}

export function userSwitchActiveMint(url: string): void {
  useWalletStore.getState()._setActiveMint(url)
}

export function userRemoveMint(url: string): void {
  useWalletStore.getState()._removeMint(normalizeUrl(url))
}

export function normalizeRelayUrl(wssUrl: string): string {
  const trimmed = wssUrl.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('Relay URL must start with wss://')
  }
  if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
    throw new Error('Relay URL must start with wss:// or local ws://')
  }
  const normalized = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  if (isKnownPublicNostrRelayUrl(normalized)) {
    throw new Error('Public Nostr relays are not supported. Use a bitCaster-owned relay.')
  }
  if (!isAllowedNostrRelayUrl(normalized)) {
    throw new Error('Relay URL must be the configured bitCaster relay or a local relay.')
  }
  return normalized
}

export function getRelayUrlValidationError(wssUrl: string): string | null {
  if (!wssUrl.trim()) return null
  try {
    normalizeRelayUrl(wssUrl)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export function userAddRelay(wssUrl: string): void {
  useSettingsStore.getState().addRelay(normalizeRelayUrl(wssUrl))
}

export function userRemoveRelay(wssUrl: string): void {
  const store = useSettingsStore.getState()
  store.removeRelay(wssUrl)
  const normalized = normalizeRelayUrl(wssUrl)
  if (normalized !== wssUrl) {
    store.removeRelay(normalized)
  }
}

export async function ingressRegisterMint(
  url: string,
  source: WalletIngressSource,
  expectedWalletId: string = currentGuiWalletId(),
): Promise<IngressMintRegistrationResult> {
  assertCurrentWallet(expectedWalletId)
  const mintUrl = normalizeUrl(url)
  const store = useWalletStore.getState()
  if (store.mints.some((m) => m.url === mintUrl)) {
    return { added: false, mintUrl, source }
  }
  await store._addMintWithoutActivating(mintUrl, { expectedWalletId })
  assertCurrentWallet(expectedWalletId)
  return { added: true, mintUrl, source }
}

export async function ingressReceiveCashuToken(
  token: string,
  source: WalletIngressSource,
  options?: { mintUrl?: string; decodedToken?: Token },
): Promise<IngressReceiveCashuTokenResult> {
  const expectedWalletId = currentGuiWalletId()
  assertCurrentWallet(expectedWalletId)
  // Always decode to read the token's unit field (NUT-00). The caller may
  // supply an explicit mintUrl override (e.g. from a payment-request context);
  // in that case the decoded mint URL is ignored but the unit is still used.
  // Fall back to 'sat' for tokens that pre-date NUT-00 unit tagging.
  const decoded =
    options?.decodedToken ??
    (await fencedWalletAwait(expectedWalletId, () => decodeToken(token)))
  const mintUrl = options?.mintUrl ? normalizeUrl(options.mintUrl) : normalizeUrl(decoded.mint)
  const unit = parseInboundCashuUnit(decoded.unit)
  const registration = await fencedWalletAwait(expectedWalletId, () =>
    ingressRegisterMint(mintUrl, source, expectedWalletId),
  )
  const proofs = await fencedWalletAwait(expectedWalletId, () =>
    receiveGuiCashuToken({
      expectedWalletId,
      token: decoded,
      mintUrl,
      unit,
    }),
  )
  return {
    ...registration,
    proofs,
    unit,
    amountSats: proofs.reduce((sum, p) => sum + amountToNumber(p.amount), 0),
  }
}

async function fencedWalletAwait<T>(
  expectedWalletId: string,
  action: () => Promise<T>,
): Promise<T> {
  assertCurrentWallet(expectedWalletId)
  const result = await action()
  assertCurrentWallet(expectedWalletId)
  return result
}

function assertCurrentWallet(expectedWalletId: string): void {
  if (currentGuiWalletId() !== expectedWalletId) {
    throw new Error('Active wallet seed changed during Cashu token ingress')
  }
}

export async function decodeWalletCashuToken(token: string): Promise<Token> {
  return decodeToken(token)
}

export async function ingressDecodePaymentRequest(
  text: string,
  source: WalletIngressSource,
): Promise<DecodedWalletPaymentRequest> {
  return {
    request: PaymentRequest.fromEncodedRequest(text),
    source,
  }
}

export function userCreatePaymentRequest(mintUrl: string): CreatedWalletPaymentRequest {
  const mnemonic = useWalletStore.getState().mnemonic
  if (!mnemonic) {
    throw new Error('Wallet not set up')
  }

  const keyPair = deriveNostrKeyPair(mnemonic)
  const configuredRelays = effectiveRelayUrls(useSettingsStore.getState().relays)
  const nprofile = getNostrNprofile(keyPair.publicKey, configuredRelays.length > 0 ? configuredRelays : undefined)

  // cashu-ts leaves the id undefined unless we provide one; the NIP-17 inbox
  // needs it echoed back by the payer to correlate the received token.
  const id = crypto.randomUUID().split('-')[0]
  const request = new PaymentRequest(
    [
      {
        type: PaymentRequestTransportType.NOSTR,
        target: nprofile,
        tags: [['n', '17']],
      },
    ],
    id,
    undefined,
    'sat',
    [normalizeUrl(mintUrl)],
    undefined,
  )

  return {
    encoded: request.toEncodedRequest(),
    id,
    request,
  }
}
