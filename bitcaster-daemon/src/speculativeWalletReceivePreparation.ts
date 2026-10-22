import type { CounterSource, OperationCounters, Proof } from '@cashu/cashu-ts'
import {
  createSpeculativeCounterTranscript,
  type SpeculativeCounterTranscript,
} from '@bitcaster-market/client-sdk/speculativeCounterTranscript'
import {
  serializeDurableWalletReceiveOperation,
  type DurableWalletReceiveOperation,
} from '@bitcaster-market/client-sdk/durableWalletOperation'
import { readDaemonCounterSnapshots } from './state.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import type { CashuWalletLike } from './walletOps.ts'

export interface PreparedDaemonWalletReceive {
  readonly operation: DurableWalletReceiveOperation
  readonly transcript: SpeculativeCounterTranscript
  readonly rebuild?: () => Promise<{
    prepared: PreparedDaemonWalletReceive
    wallet: CashuWalletLike
  }>
}

/** Build private outputs without changing any durable counter or journal. */
export async function prepareSpeculativeWalletReceive(input: {
  readonly encodedToken: string
  readonly mintUrl: string
  readonly unit: 'sat' | 'msat'
  readonly operationId: string
  readonly directory: string
  readonly getFence: () => CustodyScopeFence
  readonly now?: () => number
  readonly createWallet: (source: CounterSource) => CashuWalletLike
  readonly proofsWeHave?: () => Promise<Array<Pick<Proof, 'amount'>>>
}): Promise<{ prepared: PreparedDaemonWalletReceive; wallet: CashuWalletLike }> {
  const { mintUrl, unit, operationId } = input
  const now = input.now ?? Date.now
  let transcript: ReturnType<typeof createSpeculativeCounterTranscript> | undefined
  const source: CounterSource = {
    reserve: async (id, count) => {
      if (!transcript) throw new Error('receive counter transcript is not attached')
      return transcript.counterSource.reserve(id, count)
    },
    advanceToAtLeast: async (id, next) => {
      if (!transcript) throw new Error('receive counter transcript is not attached')
      return transcript.counterSource.advanceToAtLeast(id, next)
    },
  }
  const wallet = input.createWallet(source)
  await wallet.loadMint()
  const keysetId = wallet.keysetId ?? wallet.getKeyset?.()?.id
  if (
    !keysetId ||
    !/^01[0-9a-f]{64}$/.test(keysetId) ||
    wallet.getKeyset?.(keysetId)?.unit !== unit
  )
    throw new Error('receive output keyset is invalid')
  transcript = createSpeculativeCounterTranscript(
    await readDaemonCounterSnapshots({
      storage: createDaemonStateSqliteSession(input.directory),
      mutation: { fence: input.getFence(), observedAtMs: now() },
      keysetIds: [keysetId],
      binding: { normalizedMint: mintUrl, unit },
    }),
  )
  const proofsWeHave = await input.proofsWeHave?.()
  if (!wallet.prepareSwapToReceive) {
    throw new Error('cashu wallet does not support durable receive preparation')
  }
  let reserved: OperationCounters | undefined
  let callbacks = 0
  const preview = await wallet.prepareSwapToReceive(
    input.encodedToken,
    {
      proofsWeHave,
      keysetId,
      onCountersReserved: (range) => {
        callbacks += 1
        reserved = range
      },
    },
    { type: 'deterministic', counter: 0 },
  )
  const allocations = transcript.allocations()
  const allocation = allocations[0]
  if (
    callbacks !== 1 ||
    reserved === undefined ||
    allocations.length !== 1 ||
    !allocation ||
    reserved.keysetId !== keysetId ||
    allocation.keysetId !== keysetId ||
    reserved.start !== allocation.start ||
    reserved.count !== allocation.count ||
    preview.keepOutputs?.length !== allocation.count ||
    preview.keepOutputs?.some((output) => output.blindedMessage.id !== keysetId)
  ) {
    throw new Error('daemon wallet receive did not reserve a deterministic output range')
  }
  const operation = serializeDurableWalletReceiveOperation({
    operationId,
    mintUrl,
    unit,
    preview,
    derivationRange: {
      keysetId: reserved.keysetId,
      counterStart: reserved.start,
      counterCount: reserved.count,
    },
  })
  return {
    prepared: {
      operation,
      transcript,
      rebuild: () => prepareSpeculativeWalletReceive(input),
    },
    wallet,
  }
}

export function assertTranscriptRange(prepared: PreparedDaemonWalletReceive): void {
  const range = prepared.operation.derivationRange
  const allocations = prepared.transcript.allocations()
  const allocation = allocations[0]
  if (
    !range ||
    allocations.length !== 1 ||
    !allocation ||
    allocation.keysetId !== range.keysetId ||
    allocation.start !== range.counterStart ||
    allocation.count !== range.counterCount ||
    prepared.operation.preview.keepOutputs.some(
      (output) => output.blindedMessage.id !== range.keysetId,
    )
  ) {
    throw new Error('receive counter transcript does not match output range')
  }
}
