import { createConditionOracleEvidenceResolver } from '@bitcaster-market/client-sdk/conditionOracleEvidence'
import type { RedeemWallet } from '@bitcaster-market/client-sdk/ctfRedeem'
import type { ManagedConditionRetirementEngine } from './managedConditionRetirement.ts'
import type { DaemonProfile } from './profile.ts'
import type { CustodyScopeFence } from './profileFencing.ts'

const resolver = createConditionOracleEvidenceResolver()

export async function resolveDaemonConditionOracleEvidence(input: {
  readonly profile: DaemonProfile
  readonly fence: CustodyScopeFence
  readonly conditionId: string
  readonly engine: ManagedConditionRetirementEngine
  readonly wallet: RedeemWallet
}) {
  const signal = AbortSignal.timeout(5_000)
  return resolver.resolveFromMint({
    binding: {
      scopeId: input.fence.scopeId,
      normalizedMint: input.profile.mintUrl,
      unit: 'msat',
      conditionId: input.conditionId,
      canonicalParentCollectionId: null,
    },
    fetchInitialAttestation: () => input.engine.getConditionAttestation(input.conditionId, signal),
    fetchRegisteredAuthority: async () => {
      const response = await input.engine.getConditionAttestation(input.conditionId, signal)
      if (response === null || response.conditionId !== input.conditionId)
        throw new Error('intended condition registration is unavailable')
      return response.registeredAuthority
    },
    fetchConditionInfo: async (includeOracleSigs) => {
      if (input.wallet.mint?.getCtfCondition === undefined)
        throw new Error('mint condition information is unavailable')
      return input.wallet.mint.getCtfCondition(input.conditionId, undefined, {
        include_oracle_sigs: includeOracleSigs,
        signal,
      })
    },
  })
}
