import { bootstrapFreshDaemonProfile } from '../src/profileBootstrap.ts'
import { claimCustodyScopeLease } from '../src/profileFencing.ts'

export const RECOVERY_COUNTER_BINDING = {
  normalizedMint: 'https://mint.example',
  unit: 'sat' as const,
}

export async function createSeedRecoveryProfile(input: {
  readonly directory: string
  readonly walletSeedHex: string
  readonly nostrSecretKeyHex: string
  readonly incarnationId: string
}) {
  const profile = await bootstrapFreshDaemonProfile({
    directory: input.directory,
    engineBaseUrl: 'https://engine.example',
    mintUrl: 'https://mint.example',
    walletSeedHex: input.walletSeedHex,
    nostrSecretKeyHex: input.nostrSecretKeyHex,
    initializedAtMs: 1,
  })
  const fence = await claimCustodyScopeLease(input.directory, {
    scopeId: profile.walletScopeId,
    incarnationId: input.incarnationId,
    observedAtMs: 2,
  })
  return { profile, fence }
}

export function emptyRecoveryWallet(keysetId: string, starts: number[]) {
  return {
    async loadMint() {},
    keyChain: { getKeysets: () => [{ id: keysetId }] },
    getKeyset: () => ({ id: keysetId, unit: 'sat', keys: {} }),
    async restore(start: number, count: number) {
      if (count !== 300) throw new Error('seed recovery page size is invalid')
      starts.push(start)
      return { proofs: [] }
    },
    async checkProofsStates() {
      throw new Error('empty recovery batch must not call NUT-07')
    },
  }
}

export async function withDaemonHome(directory: string, run: () => Promise<void>): Promise<void> {
  const previous = process.env.BITCASTER_DAEMON_HOME
  process.env.BITCASTER_DAEMON_HOME = directory
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.BITCASTER_DAEMON_HOME
    else process.env.BITCASTER_DAEMON_HOME = previous
  }
}
