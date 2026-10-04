import type { Proof } from '@cashu/cashu-ts'
import type { DurableWalletOutputData } from '@bitcaster-market/client-sdk/durableWalletOperation'
import {
  NativeBolt11MintQuoteCoordinator,
  type NativeBolt11MintQuoteCoordinatorOptions,
  type NativeBolt11MintQuoteRecoveryItem,
  type NativeBolt11MintQuoteView,
  type NativeBolt11MintQuoteWallet,
} from './nativeBolt11MintQuoteCoordinator.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { StoredOutputData } from './state.ts'
import { createWallet, restoreOutputGroups } from './walletOps.ts'
import {
  createBoundedRecoveryPager,
  type BoundedRecoveryPage,
  type NormalizedRecoveryOutcome,
} from './boundedRecoveryPager.ts'

const RESTORE_GROUP = 'native-bolt11-mint-quote'

export type NativeLightningRecoveryPage = BoundedRecoveryPage

export interface NativeLightningOps {
  createInvoice(amountMsat: number): Promise<NativeBolt11MintQuoteView>
  showInvoice(quoteRecordId: string): Promise<NativeBolt11MintQuoteView | null>
  hideInvoice(quoteRecordId: string): Promise<NativeBolt11MintQuoteView>
  replaceInvoice(
    quoteRecordId: string,
    amountMsat: number,
  ): Promise<NativeLightningInvoiceReplacement>
  recoverPage(): Promise<NativeLightningRecoveryPage>
  restartRecoveryScan(): void
}

export interface NativeLightningInvoiceReplacement {
  readonly invoice: NativeBolt11MintQuoteView
}

export type NativeBolt11MintQuoteCoordinatorLike = Pick<
  NativeBolt11MintQuoteCoordinator,
  'create' | 'get' | 'hide' | 'recoverActivePage'
>

/** Build the invoice-only SDK adapter for one fenced daemon runtime. */
export function createNativeLightningOps(input: {
  readonly directory: string
  readonly mintUrl: string
  readonly walletSeedHex: string
  readonly getCustodyFence: () => CustodyScopeFence
  readonly now?: () => number
}): NativeLightningOps {
  const coordinatorOptions: NativeBolt11MintQuoteCoordinatorOptions = {
    directory: input.directory,
    getFence: input.getCustodyFence,
    walletFor: async (mintUrl, unit) =>
      createWallet(
        mintUrl,
        { walletSeedHex: input.walletSeedHex },
        { getCustodyFence: input.getCustodyFence },
        'sat',
        unit,
      ) as unknown as NativeBolt11MintQuoteWallet,
    restoreExactOutputs: (restore) => restoreNativeMintOutputs(restore),
    ...(input.now === undefined ? {} : { now: input.now }),
  }
  return createNativeLightningOpsWithCoordinator(
    new NativeBolt11MintQuoteCoordinator(coordinatorOptions),
    input.mintUrl,
  )
}

/** Keep quote lifecycle policy and cursor aggregation testable without a mint. */
export function createNativeLightningOpsWithCoordinator(
  coordinator: NativeBolt11MintQuoteCoordinatorLike,
  mintUrl: string,
): NativeLightningOps {
  const recovery = createNativeLightningRecoveryPager((cursor) =>
    coordinator.recoverActivePage({ cursor }),
  )

  return {
    createInvoice: async (amountMsat) => {
      const invoice = await coordinator.create({ mintUrl, amountMsat })
      recovery.restart()
      return invoice
    },
    showInvoice: (quoteRecordId) => coordinator.get(quoteRecordId),
    hideInvoice: (quoteRecordId) => coordinator.hide(quoteRecordId),
    replaceInvoice: async (quoteRecordId, amountMsat) => {
      const previous = await coordinator.get(quoteRecordId)
      if (previous === null) throw new Error('native BOLT11 mint quote was not found')

      try {
        await coordinator.hide(quoteRecordId)
        return { invoice: await coordinator.create({ mintUrl, amountMsat }) }
      } finally {
        recovery.restart()
      }
    },
    recoverPage: recovery.recoverPage,
    restartRecoveryScan: recovery.restart,
  }
}

export function createNativeLightningRecoveryPager(
  recover: (cursor: string | null) => Promise<{
    readonly outcomes: readonly NativeBolt11MintQuoteRecoveryItem[]
    readonly nextCursor: string | null
    readonly hasMore: boolean
  }>,
): { recoverPage(): Promise<NativeLightningRecoveryPage>; restart(): void } {
  const pager = createBoundedRecoveryPager(recover, normalizeNativeLightningOutcome)
  return { recoverPage: pager.recoverPage, restart: pager.restart }
}

function normalizeNativeLightningOutcome(
  outcome: NativeBolt11MintQuoteRecoveryItem,
): NormalizedRecoveryOutcome {
  switch (outcome.outcome) {
    case 'recovered':
      return { kind: 'recovered', operationId: outcome.quoteRecordId }
    case 'unpaid':
    case 'pending':
      return { kind: 'retry' }
    case 'error':
      return {
        kind: 'blocking',
        operationId: `native-bolt11-mint-quote:${outcome.quoteRecordId}`,
        error: 'invoice recovery needs attention',
      }
    default:
      return assertNever(outcome)
  }
}

function assertNever(value: never): never {
  throw new Error(`native BOLT11 invoice recovery outcome is unsupported: ${String(value)}`)
}

async function restoreNativeMintOutputs(input: {
  readonly mintUrl: string
  readonly unit: string
  readonly outputs: readonly DurableWalletOutputData[]
}): Promise<readonly Proof[]> {
  if (input.unit !== 'msat') throw new Error('native BOLT11 invoice output unit is invalid')
  const outputs = input.outputs.map((output): StoredOutputData => {
    const amount = Number(output.blindedMessage.amount)
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error('native BOLT11 invoice output amount is invalid')
    }
    return {
      blindedMessage: {
        amount,
        id: output.blindedMessage.id,
        B_: output.blindedMessage.B_,
      },
      blindingFactor: output.blindingFactor,
      secret: output.secret,
      ...(output.ephemeralE === null ? {} : { ephemeralE: output.ephemeralE }),
    }
  })
  const restored = await restoreOutputGroups(input.mintUrl, { [RESTORE_GROUP]: outputs })
  const proofs = restored[RESTORE_GROUP]
  if (!proofs || proofs.length !== outputs.length) {
    throw new Error('native BOLT11 invoice output restore was incomplete')
  }
  return proofs
}
