import { PaymentRequest, PaymentRequestTransportType, type Proof } from '@cashu/cashu-ts'
import { decodeToken, receiveToken } from '@/lib/cashu'
import { proofsWithOptionalConditionalMetadata } from '@/lib/conditionalKeysetMetadata'
import { deriveNostrKeyPair, getNostrNprofile } from '@/lib/nip17'
import { normalizeUrl } from '@/lib/url'
import { useSettingsStore } from '@/stores/settings'
import { useWalletStore, type StoredMint } from '@/stores/wallet'
import { amountToNumber } from '@bitcaster/client-sdk/proofSelection'

export type WalletIngressSource = 'paste' | 'scan' | 'nip17'

export interface IngressMintRegistrationResult {
  added: boolean
  mintUrl: string
  source: WalletIngressSource
}

export interface IngressReceiveCashuTokenResult extends IngressMintRegistrationResult {
  amountSats: number
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
  if (parsed.protocol !== 'wss:') {
    throw new Error('Relay URL must start with wss://')
  }
  return trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
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
): Promise<IngressMintRegistrationResult> {
  const mintUrl = normalizeUrl(url)
  const store = useWalletStore.getState()
  if (store.mints.some((m) => m.url === mintUrl)) {
    return { added: false, mintUrl, source }
  }
  await store._addMintWithoutActivating(mintUrl)
  return { added: true, mintUrl, source }
}

export async function ingressReceiveCashuToken(
  token: string,
  source: WalletIngressSource,
  options?: { mintUrl?: string },
): Promise<IngressReceiveCashuTokenResult> {
  const mintUrl = options?.mintUrl
    ? normalizeUrl(options.mintUrl)
    : normalizeUrl((await decodeToken(token)).mint)
  const registration = await ingressRegisterMint(mintUrl, source)
  const receivedProofs = await receiveToken(token, mintUrl)
  const proofs = await proofsWithOptionalConditionalMetadata({
    mintUrl,
    proofs: receivedProofs,
  })
  return {
    ...registration,
    proofs,
    amountSats: proofs.reduce((sum, p) => sum + amountToNumber(p.amount), 0),
  }
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
  const configuredRelays = useSettingsStore.getState().relays.map((r) => r.url)
  const nprofile = getNostrNprofile(
    keyPair.publicKey,
    configuredRelays.length > 0 ? configuredRelays : undefined,
  )

  // cashu-ts leaves the id undefined unless we provide one; the NIP-17 inbox
  // needs it echoed back by the payer to correlate the received token.
  const id = crypto.randomUUID().split('-')[0]
  const request = new PaymentRequest(
    [{
      type: PaymentRequestTransportType.NOSTR,
      target: nprofile,
      tags: [['n', '17']],
    }],
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
