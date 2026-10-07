import { Amount, type MeltPreview, type MeltQuoteResponse, type Proof } from '@cashu/cashu-ts'
import {
  deriveDurableCustodyArtifactFingerprint,
  deriveDurableCustodyWalletId,
} from '@bitcaster-market/client-sdk/durableCustody'
import { serializeDurableWalletMeltOperation } from '@bitcaster-market/client-sdk/durableWalletOperation'
import {
  computeInputFeeSubunitsForProofs,
  amountToNumber,
} from '@bitcaster-market/client-sdk/proofSelection'
import {
  isWalletPaymentOperationId,
  isWalletPaymentQuote,
  type WalletPaymentQuote,
} from '@bitcaster-market/client-sdk/walletPaymentQuote'
import type { DaemonProfile } from './profile.ts'
import { profileDir } from './profile.ts'
import {
  createWallet,
  type CashuWalletLike,
  type WalletOpsDependencies,
  type WalletOpsSecrets,
} from './walletOps.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import { readAvailableWalletProofsFenced } from './state.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import { DurableCustodySqliteStore } from './durableCustodySqliteStore.ts'
import { withDurableCustodyFencedRead } from './durableCustodyUnitOfWork.ts'
import {
  NativeWalletMeltCoordinator,
  type NativeWalletMeltApprovalContext,
  type NativeWalletMeltStatusProjection,
  type NativeWalletMeltWallet,
} from './nativeWalletMeltCoordinator.ts'

const WALLET_MELT_OPERATION_PREFIX = 'wallet-melt:'

export interface NativeWalletPaymentWallet extends NativeWalletMeltWallet {
  loadMint(): Promise<unknown>
  createMeltQuoteBolt11(invoice: string): Promise<MeltQuoteResponse>
  prepareMelt(
    method: 'bolt11',
    quote: MeltQuoteResponse,
    proofs: readonly Proof[],
  ): Promise<MeltPreview<MeltQuoteResponse>>
  selectProofsToSend(
    proofs: Proof[],
    amountToSend: number,
    includeFees?: boolean,
    exactMatch?: boolean,
  ): { readonly keep: Proof[]; readonly send: Proof[] }
}

export type NativeWalletPaymentQuoteView = WalletPaymentQuote

export interface NativeWalletPaymentApproval extends WalletPaymentQuote {
  readonly approvedMaxDebitMsat: number
}

export interface NativeWalletPaymentResult {
  readonly operationId: string
  readonly state: 'paid' | 'unpaid' | 'pending'
  readonly changeCount: number
}

export interface NativeWalletPaymentRecoveryItem {
  readonly operationId: string
  readonly outcome: 'recovered' | 'pending' | 'error'
  readonly error?: string
}

export interface NativeWalletPaymentRecoveryPage {
  readonly outcomes: readonly NativeWalletPaymentRecoveryItem[]
  readonly nextCursor: string | null
  readonly hasMore: boolean
}

export interface NativeWalletPaymentOpsOptions {
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly getFence: () => CustodyScopeFence
  readonly deps?: WalletOpsDependencies
  readonly directory?: string
  readonly now?: () => number
  readonly walletFor?: (
    mintUrl: string,
    unit: 'msat',
  ) => Promise<NativeWalletPaymentWallet> | NativeWalletPaymentWallet
}

/** Native wallet payment quotes and saved melt operations for the configured mint. */
export class NativeWalletPaymentOps {
  readonly #profile: DaemonProfile
  readonly #secrets: WalletOpsSecrets
  readonly #getFence: () => CustodyScopeFence
  readonly #deps: WalletOpsDependencies
  readonly #directory: string
  readonly #now: () => number
  readonly #walletFor: NonNullable<NativeWalletPaymentOpsOptions['walletFor']> | undefined
  readonly #coordinator: NativeWalletMeltCoordinator

  constructor(options: NativeWalletPaymentOpsOptions) {
    this.#profile = options.profile
    this.#secrets = options.secrets
    this.#getFence = options.getFence
    this.#deps = {
      ...options.deps,
      getCustodyFence: options.deps?.getCustodyFence ?? options.getFence,
    }
    this.#directory = options.directory ?? profileDir()
    this.#now = options.now ?? Date.now
    this.#walletFor = options.walletFor
    this.#coordinator = new NativeWalletMeltCoordinator(
      this.#directory,
      options.getFence,
      this.#now,
    )
  }

  /** Inspect the exact invoice and spendable input fee without preparing outputs or reserving funds. */
  async quote(input: { readonly invoice: string }): Promise<NativeWalletPaymentQuoteView> {
    requireInvoice(input.invoice)
    const mintUrl = requireConfiguredMint(this.#profile)
    const wallet = await this.#loadedWallet(mintUrl)
    const quote = await wallet.createMeltQuoteBolt11(input.invoice)
    assertFreshQuote(quote, input.invoice, this.#now())
    const selected = await selectCanonicalInputs({
      mintUrl,
      quote,
      wallet,
      getFence: this.#getFence,
      now: this.#now,
    })
    const amountMsat = amountToNumber(quote.amount)
    const feeReserveMsat = amountToNumber(quote.fee_reserve)
    const totalWalletDebitMsat = checkedAdd(
      checkedAdd(amountMsat, feeReserveMsat),
      selected.inputFeeMsat,
    )
    assertInputCoverage(selected.inputs, totalWalletDebitMsat)
    return {
      operationId: meltOperationId(mintUrl, quote),
      walletId: deriveDurableCustodyWalletId(Buffer.from(this.#secrets.walletSeedHex, 'hex')),
      mintUrl,
      unit: 'msat',
      method: 'bolt11',
      invoice: input.invoice,
      quoteId: quote.quote,
      amountMsat,
      feeReserveMsat,
      selectedInputFeeMsat: selected.inputFeeMsat,
      totalWalletDebitMsat,
      expiryUnixSeconds: quote.expiry,
      state: 'UNPAID',
    }
  }

  /** Prepare and execute one explicitly approved payment, or retry its saved exact operation. */
  async pay(input: NativeWalletPaymentApproval): Promise<NativeWalletPaymentResult> {
    const approval = requirePaymentApproval(input, this.#profile, this.#secrets)
    const saved = await this.#coordinator.readStatus(approval.operationId)
    if (saved !== null) {
      assertSavedApproval(saved, approval)
      const wallet = isLocallyComplete(saved)
        ? terminalOnlyWallet()
        : await this.#loadedWallet(approval.mintUrl)
      return this.#execute(approval.operationId, wallet)
    }

    return this.#payNewApproval(approval)
  }

  /** Return only the validated local operation and approval facts. This method never pays. */
  async status(input: {
    readonly operationId: string
  }): Promise<NativeWalletMeltStatusProjection | null> {
    requireOperationId(input.operationId)
    return this.#coordinator.readStatus(input.operationId)
  }

  /** Recover one bounded page from the shared custody active-work index. */
  async recoverActivePage(input: {
    readonly cursor: string | null
  }): Promise<NativeWalletPaymentRecoveryPage> {
    const fence = this.#getFence()
    const active = await withDurableCustodyFencedRead(
      createDaemonStateSqliteSession(this.#directory),
      fence,
      this.#now(),
      (database) =>
        new DurableCustodySqliteStore(database).listActiveWorkPage(fence.scopeId, input.cursor),
    )
    const outcomes: NativeWalletPaymentRecoveryItem[] = []
    for (const row of active.rows) {
      try {
        const saved = await this.#coordinator.readActiveMeltStatus(row.operationId)
        if (saved === null) continue
        const wallet = isLocallyComplete(saved)
          ? terminalOnlyWallet()
          : await this.#loadedWallet(saved.mintUrl)
        try {
          const result = await this.#coordinator.recover({
            operationId: saved.operationId,
            wallet,
          })
          outcomes.push({
            operationId: saved.operationId,
            outcome: result.state === 'paid' ? 'recovered' : 'pending',
          })
        } catch {
          const current = await this.#coordinator.readStatus(saved.operationId)
          outcomes.push({
            operationId: saved.operationId,
            outcome:
              current !== null &&
              current.operationState !== 'aborted' &&
              current.resultState !== 'applied'
                ? 'pending'
                : 'error',
            ...(current === null ||
            current.operationState === 'aborted' ||
            current.resultState === 'applied'
              ? { error: 'native wallet payment recovery failed' }
              : {}),
          })
        }
      } catch {
        outcomes.push({
          operationId: row.operationId,
          outcome: 'error',
          error: 'native wallet payment recovery failed',
        })
      }
    }
    return {
      outcomes,
      nextCursor: active.nextCursor,
      hasMore: active.nextCursor !== null,
    }
  }

  async #payNewApproval(approval: NativeWalletPaymentApproval): Promise<NativeWalletPaymentResult> {
    const wallet = await this.#loadedWallet(approval.mintUrl)
    const quote = await wallet.checkMeltQuote('bolt11', approval.quoteId)
    assertApprovalQuote(approval, quote, this.#now())
    const selected = await selectCanonicalInputs({
      mintUrl: approval.mintUrl,
      quote,
      wallet,
      getFence: this.#getFence,
      now: this.#now,
    })
    const totalWalletDebitMsat = checkedAdd(
      checkedAdd(approval.amountMsat, approval.feeReserveMsat),
      selected.inputFeeMsat,
    )
    if (totalWalletDebitMsat > approval.approvedMaxDebitMsat) {
      throw new Error('native wallet payment exceeds the approved maximum debit')
    }
    assertInputCoverage(selected.inputs, totalWalletDebitMsat)
    const preview = await wallet.prepareMelt('bolt11', quote, selected.inputs)
    const operation = serializeDurableWalletMeltOperation({
      operationId: approval.operationId,
      mintUrl: approval.mintUrl,
      unit: 'msat',
      preview,
    })
    const approvalContext: NativeWalletMeltApprovalContext = {
      invoice: approval.invoice,
      expiryUnixSeconds: approval.expiryUnixSeconds,
      amountMsat: approval.amountMsat,
      feeReserveMsat: approval.feeReserveMsat,
      quotedSelectedInputFeeMsat: approval.selectedInputFeeMsat,
    }
    await this.#coordinator.prepare({
      operation,
      wallet,
      approvalContext,
      approvedMaxDebitMsat: approval.approvedMaxDebitMsat,
    })
    return this.#execute(approval.operationId, wallet)
  }

  async #execute(
    operationId: string,
    wallet: NativeWalletMeltWallet,
  ): Promise<NativeWalletPaymentResult> {
    try {
      return publicResult(await this.#coordinator.execute({ operationId, wallet }))
    } catch (error) {
      const current = await this.#coordinator.readStatus(operationId)
      if (
        current !== null &&
        current.operationState !== 'aborted' &&
        current.resultState !== 'applied'
      ) {
        return { operationId, state: 'pending', changeCount: 0 }
      }
      throw error
    }
  }

  async #loadedWallet(mintUrl: string): Promise<NativeWalletPaymentWallet> {
    const wallet = this.#walletFor
      ? await this.#walletFor(mintUrl, 'msat')
      : (createWallet(mintUrl, this.#secrets, this.#deps, 'sat', 'msat') as CashuWalletLike &
          NativeWalletPaymentWallet)
    await wallet.loadMint()
    return wallet
  }
}

async function selectCanonicalInputs(input: {
  readonly mintUrl: string
  readonly quote: MeltQuoteResponse
  readonly wallet: NativeWalletPaymentWallet
  readonly getFence: () => CustodyScopeFence
  readonly now: () => number
}): Promise<{ readonly inputs: Proof[]; readonly inputFeeMsat: number }> {
  const amountMsat = amountToNumber(input.quote.amount)
  const feeReserveMsat = amountToNumber(input.quote.fee_reserve)
  const target = checkedAdd(amountMsat, feeReserveMsat)
  const available = await readAvailableWalletProofsFenced({
    mintUrl: input.mintUrl,
    asset: { kind: 'sats', baseAsset: 'sat', unit: 'msat' },
    mutation: { fence: input.getFence(), observedAtMs: input.now() },
  })
  const candidates = available.map(({ proof }) => proof as Proof)
  const selected = input.wallet.selectProofsToSend(candidates, target, true).send
  if (selected.length === 0) throw new Error('native wallet payment has insufficient msat proofs')
  const fees: Record<string, number> = {}
  for (const keysetId of new Set(selected.map(({ id }) => id))) {
    const keyset = input.wallet.getKeyset(keysetId)
    if (
      !keyset ||
      keyset.id !== keysetId ||
      keyset.unit !== 'msat' ||
      keyset.conditional !== undefined ||
      keyset.verify?.() !== true ||
      !Number.isSafeInteger(keyset.fee) ||
      keyset.fee! < 0
    ) {
      throw new Error('native wallet payment keyset authority is invalid')
    }
    fees[keysetId] = keyset.fee!
  }
  return {
    inputs: selected,
    inputFeeMsat: computeInputFeeSubunitsForProofs(selected, fees),
  }
}

function assertFreshQuote(quote: MeltQuoteResponse, invoice: string, nowMs: number): void {
  assertQuoteShape(quote, invoice)
  if (quote.state !== 'UNPAID' || quote.expiry <= Math.floor(nowMs / 1_000)) {
    throw new Error('native wallet payment quote is not currently payable')
  }
}

function assertApprovalQuote(
  approval: NativeWalletPaymentApproval,
  quote: MeltQuoteResponse,
  nowMs: number,
): void {
  assertQuoteShape(quote, approval.invoice)
  if (
    quote.quote !== approval.quoteId ||
    amountToNumber(quote.amount) !== approval.amountMsat ||
    amountToNumber(quote.fee_reserve) !== approval.feeReserveMsat ||
    quote.expiry !== approval.expiryUnixSeconds ||
    quote.expiry <= Math.floor(nowMs / 1_000) ||
    quote.state !== 'UNPAID'
  ) {
    throw new Error('native wallet payment quote changed or is not unpaid')
  }
}

function assertQuoteShape(quote: MeltQuoteResponse, invoice: string): void {
  if (
    typeof quote.quote !== 'string' ||
    quote.quote.length === 0 ||
    quote.quote.length > 2_048 ||
    quote.unit !== 'msat' ||
    quote.request !== invoice ||
    !Number.isSafeInteger(quote.expiry) ||
    quote.expiry <= 0
  ) {
    throw new Error('native wallet payment quote authority is foreign or malformed')
  }
  const amountMsat = amountToNumber(quote.amount)
  const feeReserveMsat = amountToNumber(quote.fee_reserve)
  if (amountMsat <= 0 || feeReserveMsat < 0) {
    throw new Error('native wallet payment quote amounts are invalid')
  }
}

function requirePaymentApproval(
  value: NativeWalletPaymentApproval,
  profile: DaemonProfile,
  secrets: WalletOpsSecrets,
): NativeWalletPaymentApproval {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('native wallet payment approval is invalid')
  }
  if (!Object.hasOwn(value, 'approvedMaxDebitMsat')) {
    throw new Error('native wallet payment approval has unexpected fields')
  }
  const { approvedMaxDebitMsat, ...quote } = value
  if (!isWalletPaymentQuote(quote)) {
    throw new Error('native wallet payment approval is invalid')
  }
  requireInvoice(quote.invoice)
  const mintUrl = requireConfiguredMint(profile)
  const walletId = deriveDurableCustodyWalletId(Buffer.from(secrets.walletSeedHex, 'hex'))
  if (
    quote.walletId !== walletId ||
    quote.mintUrl !== mintUrl ||
    quote.operationId !== meltOperationIdFromView(quote)
  ) {
    throw new Error('native wallet payment approval is foreign')
  }
  positiveSafeInteger(approvedMaxDebitMsat, 'approved maximum debit')
  if (approvedMaxDebitMsat < quote.totalWalletDebitMsat) {
    throw new Error('native wallet payment approval is below the quoted total debit')
  }
  return { ...quote, approvedMaxDebitMsat }
}

function assertSavedApproval(
  saved: NativeWalletMeltStatusProjection,
  approval: NativeWalletPaymentApproval,
): void {
  if (
    saved.operationId !== approval.operationId ||
    saved.walletId !== approval.walletId ||
    saved.mintUrl !== approval.mintUrl ||
    saved.unit !== approval.unit ||
    saved.method !== approval.method ||
    saved.quoteId !== approval.quoteId ||
    saved.invoice !== approval.invoice ||
    saved.expiryUnixSeconds !== approval.expiryUnixSeconds ||
    saved.amountMsat !== approval.amountMsat ||
    saved.feeReserveMsat !== approval.feeReserveMsat ||
    saved.quotedSelectedInputFeeMsat !== approval.selectedInputFeeMsat ||
    saved.approvedMaxDebitMsat !== approval.approvedMaxDebitMsat
  ) {
    throw new Error('native wallet payment retry conflicts with saved quote or approval')
  }
}

function isLocallyComplete(status: NativeWalletMeltStatusProjection): boolean {
  return (
    status.resultState === 'verified-staged' ||
    status.resultState === 'applied' ||
    status.operationState === 'aborted'
  )
}

function publicResult(result: {
  readonly operationId: string
  readonly state: 'paid' | 'unpaid'
  readonly proofs: readonly Proof[]
}): NativeWalletPaymentResult {
  return {
    operationId: result.operationId,
    state: result.state,
    changeCount: result.proofs.length,
  }
}

function terminalOnlyWallet(): NativeWalletMeltWallet {
  const noTransport = async (): Promise<never> => {
    throw new Error('native wallet payment terminal result attempted transport')
  }
  return {
    checkMeltQuote: noTransport,
    completeMelt: noTransport,
    createMeltChangeProofs() {
      throw new Error('native wallet payment terminal result requested change proofs')
    },
    getKeyset() {
      throw new Error('native wallet payment terminal result requested a keyset')
    },
  }
}

function meltOperationId(mintUrl: string, quote: MeltQuoteResponse): string {
  return `${WALLET_MELT_OPERATION_PREFIX}${deriveDurableCustodyArtifactFingerprint({
    mintUrl,
    unit: 'msat',
    quote: { quote: quote.quote, amount: Amount.from(quote.amount).toString() },
  })}`
}

function meltOperationIdFromView(quote: WalletPaymentQuote): string {
  return `${WALLET_MELT_OPERATION_PREFIX}${deriveDurableCustodyArtifactFingerprint({
    mintUrl: quote.mintUrl,
    unit: quote.unit,
    quote: { quote: quote.quoteId, amount: String(quote.amountMsat) },
  })}`
}

function requireOperationId(value: string): void {
  if (!isWalletPaymentOperationId(value)) {
    throw new Error('native wallet payment operation id is invalid')
  }
}

function requireInvoice(value: string): void {
  if (typeof value !== 'string' || value.length === 0 || value.length > 10_000) {
    throw new Error('native wallet payment invoice is invalid')
  }
}

function requireConfiguredMint(profile: DaemonProfile): string {
  if (typeof profile.mintUrl !== 'string' || profile.mintUrl.length === 0) {
    throw new Error('native wallet payment requires a configured mint')
  }
  return profile.mintUrl
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`native wallet payment ${label} is invalid`)
  }
  return value
}

function assertInputCoverage(proofs: readonly Proof[], debitMsat: number): void {
  const amount = proofs.reduce((total, proof) => checkedAdd(total, amountToNumber(proof.amount)), 0)
  if (amount < debitMsat) {
    throw new Error('native wallet payment selected inputs do not cover the approved debit')
  }
}

function checkedAdd(left: number, right: number): number {
  const result = left + right
  if (!Number.isSafeInteger(result) || left < 0 || right < 0) {
    throw new Error('native wallet payment amount exceeds the safe integer range')
  }
  return result
}
