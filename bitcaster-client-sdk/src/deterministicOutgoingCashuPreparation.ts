import type { OperationCounters, OutputData, Proof, SwapPreview } from '@cashu/cashu-ts'
import { locateSeedDerivedProofLineage } from './durableSeedDerivedProofLineage.ts'
import type { DurableWalletProofDerivationLocator } from './durableWalletProofDerivationLocator.ts'

export interface DeterministicOutgoingCashuWallet {
  prepareSwapToSend(
    amount: number,
    proofs: Proof[],
    config: {
      includeFees: false
      keysetId: string
      onCountersReserved: (counters: OperationCounters) => void
    },
    outputConfig: {
      send: { type: 'deterministic'; counter: 0 }
      keep: { type: 'deterministic'; counter: 0 }
    },
  ): Promise<SwapPreview>
  getKeyset(keysetId?: string): { id: string }
}

export interface PreparedDeterministicOutgoingCashuSend {
  readonly preview: SwapPreview
  readonly counters: OperationCounters
  readonly keepProofDerivationLocators: readonly DurableWalletProofDerivationLocator[]
}

/** Prepare one deterministic V2 send and locate every retained change output. */
export async function prepareDeterministicOutgoingCashuSend(input: {
  readonly amount: number
  readonly proofs: readonly Proof[]
  readonly seed: Uint8Array
  readonly wallet: DeterministicOutgoingCashuWallet
  readonly diagnosticLabel: string
}): Promise<PreparedDeterministicOutgoingCashuSend> {
  const keysetId = requireCanonicalV2Keyset(input)
  const { preview, counters } = await prepareDeterministicPreview(input, keysetId)
  assertExactOutputPlan(input.diagnosticLabel, preview, counters)
  const keepProofDerivationLocators = locateKeepOutputLocators(input, preview, counters)
  return {
    preview,
    counters,
    keepProofDerivationLocators,
  }
}

function requireCanonicalV2Keyset(input: {
  readonly amount: number
  readonly wallet: DeterministicOutgoingCashuWallet
  readonly diagnosticLabel: string
}): string {
  if (!Number.isSafeInteger(input.amount) || input.amount < 1) {
    throw new Error(`${input.diagnosticLabel} amount is invalid`)
  }
  const keysetId = input.wallet.getKeyset().id
  if (!/^01[0-9a-f]{64}$/.test(keysetId)) {
    throw new Error(`${input.diagnosticLabel} requires a canonical V2 keyset`)
  }
  return keysetId
}

async function prepareDeterministicPreview(
  input: Parameters<typeof prepareDeterministicOutgoingCashuSend>[0],
  keysetId: string,
): Promise<{ readonly preview: SwapPreview; readonly counters: OperationCounters }> {
  const reservation: { value: OperationCounters | null } = { value: null }
  const preview = await input.wallet.prepareSwapToSend(
    input.amount,
    input.proofs as Proof[],
    {
      includeFees: false,
      keysetId,
      onCountersReserved: (reserved) => {
        if (reservation.value !== null) {
          throw new Error(`${input.diagnosticLabel} output counters were reserved twice`)
        }
        reservation.value = { ...reserved }
      },
    },
    {
      send: { type: 'deterministic', counter: 0 },
      keep: { type: 'deterministic', counter: 0 },
    },
  )
  if (reservation.value === null || reservation.value.keysetId !== preview.keysetId) {
    throw new Error(`${input.diagnosticLabel} output counter reservation is missing`)
  }
  return { preview, counters: reservation.value }
}

function assertExactOutputPlan(
  diagnosticLabel: string,
  preview: SwapPreview,
  counters: OperationCounters,
): void {
  const outputs = [...(preview.sendOutputs ?? []), ...(preview.keepOutputs ?? [])]
  if (outputs.length !== counters.count) {
    throw new Error(`${diagnosticLabel} output counter reservation conflicts with the output plan`)
  }
}

function locateKeepOutputLocators(
  input: Parameters<typeof prepareDeterministicOutgoingCashuSend>[0],
  preview: SwapPreview,
  counters: OperationCounters,
): DurableWalletProofDerivationLocator[] {
  const outputs = [...(preview.sendOutputs ?? []), ...(preview.keepOutputs ?? [])]
  const lineage = locateSeedDerivedProofLineage({
    seed: input.seed,
    keysetId: counters.keysetId,
    counterStart: counters.start,
    counterCount: counters.count,
    proofs: outputs.map(outputProofLineage),
  })
  const locators = new Map(lineage.map(({ secret, ...locator }) => [secret, locator] as const))
  return (preview.keepOutputs ?? []).map((output) => {
    const locator = locators.get(outputProofLineage(output).secret)
    if (locator === undefined) {
      throw new Error(`${input.diagnosticLabel} keep output locator is missing`)
    }
    return locator
  })
}

function outputProofLineage(output: OutputData): { readonly id: string; readonly secret: string } {
  return { id: output.blindedMessage.id, secret: new TextDecoder().decode(output.secret) }
}
