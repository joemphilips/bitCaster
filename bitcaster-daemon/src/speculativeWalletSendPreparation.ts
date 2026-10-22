import type { CounterSource, OperationCounters, Proof } from '@cashu/cashu-ts'
import { createSpeculativeCounterTranscript } from '@bitcaster-market/client-sdk/speculativeCounterTranscript'
import { prepareDeterministicOutgoingCashuSend } from '@bitcaster-market/client-sdk/deterministicOutgoingCashuPreparation'
import { readDaemonCounterSnapshots } from './state.ts'
import type { DaemonStateSqliteSession } from './stateSqlite.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { CashuWalletLike } from './walletOps.ts'

/** Only a provider owner that reconciled its attempted identity may issue this signal. */
export class OutgoingPreparationRetryError extends Error {
  readonly reason: 'counter' | 'score-selection' | 'funding-successor'
  constructor(reason: 'counter' | 'score-selection' | 'funding-successor') {
    super('outgoing preparation must be selected again')
    this.name = 'OutgoingPreparationRetryError'
    this.reason = reason
  }
}

/** One budget covers counter conflicts and all owner-specific replans. */
export async function retryOutgoingPreparation<T>(attempt: () => Promise<T>): Promise<T> {
  for (let index = 0; index < 3; index++) {
    try {
      return await attempt()
    } catch (error) {
      if (!(error instanceof OutgoingPreparationRetryError) || index === 2) throw error
    }
  }
  throw new Error('outgoing preparation attempts exhausted')
}

export async function prepareSpeculativeWalletSend(input: {
  readonly storage: DaemonStateSqliteSession
  readonly fence: CustodyScopeFence
  readonly nowMs: number
  readonly mintUrl: string
  readonly amount: number
  readonly proofs: readonly Proof[]
  readonly seed: Uint8Array
  readonly createWallet: (source: CounterSource) => CashuWalletLike
}) {
  let transcript: ReturnType<typeof createSpeculativeCounterTranscript> | undefined
  const source: CounterSource = {
    reserve: async (id, count) => {
      if (!transcript) throw new Error('send counter transcript is not attached')
      return transcript.counterSource.reserve(id, count)
    },
    advanceToAtLeast: async (id, next) => {
      if (!transcript) throw new Error('send counter transcript is not attached')
      return transcript.counterSource.advanceToAtLeast(id, next)
    },
  }
  const wallet = input.createWallet(source)
  await wallet.loadMint()
  if (!wallet.getKeyset || !wallet.prepareSwapToSend)
    throw new Error('wallet does not support deterministic send preparation')
  const keyset = wallet.getKeyset()
  if (!/^01[0-9a-f]{64}$/.test(keyset.id) || keyset.unit !== 'msat')
    throw new Error('send output keyset is invalid')
  transcript = createSpeculativeCounterTranscript(
    await readDaemonCounterSnapshots({
      storage: input.storage,
      mutation: { fence: input.fence, observedAtMs: input.nowMs },
      keysetIds: [keyset.id],
      binding: { normalizedMint: input.mintUrl, unit: 'msat' },
    }),
  )
  let callbacks = 0
  let observed: OperationCounters | undefined
  const preparation = await prepareDeterministicOutgoingCashuSend({
    amount: input.amount,
    proofs: input.proofs,
    seed: input.seed,
    diagnosticLabel: 'durable outgoing Cashu send',
    wallet: {
      getKeyset: (id) => wallet.getKeyset!(id ?? keyset.id),
      prepareSwapToSend: async (amount, proofs, config, outputs) =>
        wallet.prepareSwapToSend!(
          amount,
          proofs,
          {
            ...config,
            onCountersReserved: (range: OperationCounters) => {
              callbacks++
              observed = { ...range }
              config.onCountersReserved(range)
            },
          },
          outputs,
        ),
    },
  })
  const allocations = transcript.allocations()
  const allocation = allocations[0]
  const outputs = [
    ...(preparation.preview.sendOutputs ?? []),
    ...(preparation.preview.keepOutputs ?? []),
  ]
  if (
    callbacks !== 1 ||
    !observed ||
    allocations.length !== 1 ||
    !allocation ||
    allocation.keysetId !== keyset.id ||
    preparation.counters.keysetId !== keyset.id ||
    observed.keysetId !== keyset.id ||
    observed.start !== allocation.start ||
    observed.count !== allocation.count ||
    preparation.counters.start !== allocation.start ||
    preparation.counters.count !== allocation.count ||
    outputs.length !== allocation.count ||
    outputs.some((output) => output.blindedMessage.id !== keyset.id)
  )
    throw new Error('send counter transcript does not match output plan')
  return { wallet, preparation, transcript }
}
