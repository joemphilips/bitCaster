import type { DatabaseSync } from 'node:sqlite'
import type { CounterSource } from '@cashu/cashu-ts'
import { createSpeculativeCounterTranscript } from '@bitcaster-market/client-sdk/speculativeCounterTranscript'
import {
  redeemOutcomeLegWithOperation,
  type RedeemWallet,
} from '@bitcaster-market/client-sdk/ctfRedeem'
import {
  readDaemonCounterSnapshots,
  readDaemonProofOperationFromDatabase,
  commitDaemonCounterTranscript,
  DaemonCounterSnapshotConflictError,
} from './state.ts'
import { profileDir } from './profile.ts'
import { createDaemonStateSqliteSession } from './stateSqlite.ts'
import type { CustodyScopeFence } from './profileFencing.ts'

class SavedRedeemPreparation extends Error {
  readonly operationId: string
  constructor(operationId: string) {
    super('redeem preparation must recover its saved authority')
    this.operationId = operationId
  }
}

/** Owns only speculative counters. The caller's store must validate all saved owner authority. */
export function createSpeculativeRedeemPreparation(input: {
  readonly operationId: string
  readonly mintUrl: string
  readonly seed: Uint8Array
  readonly fence: CustodyScopeFence
  readonly wallet: RedeemWallet
}) {
  let transcript: ReturnType<typeof createSpeculativeCounterTranscript> | undefined
  let preparing = false
  let keysetId: string | undefined
  const mint = input.wallet.mint
  let load: Promise<void> | undefined
  let keysets: ReturnType<NonNullable<RedeemWallet['mint']>['getKeySets']> | undefined
  const keys = new Map<
    string | undefined,
    ReturnType<NonNullable<RedeemWallet['mint']>['getKeys']>
  >()
  const wallet: RedeemWallet = {
    loadMint: () => (load ??= input.wallet.loadMint()),
    redeemOutcomeProofs: input.wallet.redeemOutcomeProofs.bind(input.wallet),
    ...(input.wallet.checkProofsStates
      ? { checkProofsStates: input.wallet.checkProofsStates.bind(input.wallet) }
      : {}),
    ...(mint
      ? {
          mint: {
            getKeySets: () =>
              (keysets ??= mint.getKeySets().then((value) => structuredClone(value))),
            getKeys: (id?: string) => {
              let pending = keys.get(id)
              if (!pending) {
                pending = mint.getKeys(id).then((value) => structuredClone(value))
                keys.set(id, pending)
              }
              return pending
            },
            ...(mint.getCtfCondition ? { getCtfCondition: mint.getCtfCondition.bind(mint) } : {}),
          },
        }
      : {}),
  }
  const source: CounterSource = {
    reserve: async (id, count) => {
      if (!/^01[0-9a-f]{64}$/.test(id) || (keysetId !== undefined && keysetId !== id))
        throw new Error('redeem output counter keyset is foreign')
      keysetId = id
      transcript ??= createSpeculativeCounterTranscript(
        await readDaemonCounterSnapshots({
          storage: createDaemonStateSqliteSession(profileDir()),
          mutation: { fence: input.fence, observedAtMs: Date.now() },
          keysetIds: [id],
          binding: { normalizedMint: input.mintUrl, unit: 'msat' },
        }),
      )
      return transcript.counterSource.reserve(id, count)
    },
    advanceToAtLeast: async () => {
      throw new Error('redeem preparation cannot advance counters')
    },
  }
  return {
    wallet,
    prepared() {
      preparing = false
    },
    beforePrepare(database: DatabaseSync) {
      preparing = true
      if (readDaemonProofOperationFromDatabase(database, input.operationId) !== null)
        throw new SavedRedeemPreparation(input.operationId)
      if (!transcript) throw new Error('redeem counter transcript is absent')
      commitDaemonCounterTranscript(
        database,
        input.fence.scopeId,
        { normalizedMint: input.mintUrl, unit: 'msat' },
        transcript,
        Date.now(),
      )
    },
    async run(params: Parameters<typeof redeemOutcomeLegWithOperation>[0]) {
      if (params.operationId !== input.operationId || params.mintUrl !== input.mintUrl)
        throw new Error('redeem preparation identity is foreign')
      for (let attempt = 0; attempt < 3; attempt++) {
        transcript = undefined
        preparing = false
        try {
          return await redeemOutcomeLegWithOperation({
            ...params,
            wallet,
            deterministicPreparation: { seed: input.seed, counterSource: source },
          })
        } catch (error) {
          if (!preparing) throw error
          // An owner-bound read must prove presence or absence. Never suppress its failures.
          const saved = await params.proofOperationStore.getProofOperation(input.operationId)
          if (saved) return redeemOutcomeLegWithOperation({ ...params, wallet })
          if (!(error instanceof DaemonCounterSnapshotConflictError) || attempt === 2) throw error
        }
      }
      throw new Error('redeem counter attempts exhausted')
    },
  }
}
