import type { Filter } from 'nostr-tools/filter'
import { isLoopbackHttpUrl } from '@bitcaster-market/client-sdk/engineUrlSecurity'
import { normalizeNostrRelayUrls } from '@bitcaster-market/client-sdk/nostrRelays'
import {
  resolveConditionResult,
  type ConditionOracleWitness,
  type ConditionResolution,
  type OracleAttestationRelayFilter,
  type RegisteredConditionAuthority,
} from '@bitcaster-market/client-sdk/conditionResolution'
import {
  bindRegisteredDlcConditionAuthority,
  requireVerifiedConditionOracleEvidence,
  unverifiedConditionOracleEvidence,
  type ConditionOracleEvidence,
} from '@bitcaster-market/client-sdk/conditionOracleEvidence'
import type { RedeemWallet } from '@bitcaster-market/client-sdk/ctfRedeem'
import {
  prepareDlcConditionResolutionEvidence,
  type ManagedConditionInventoryBinding,
} from '@bitcaster-market/client-sdk/managedConditionInventory'
import { queryNativeActivityRelay } from './nativeActivityRelay.ts'
import {
  createNativeOracleCreationStore,
  nativeOracleDestinations,
} from './nativeOracleCreationStore.ts'
import { profileDir, type DaemonProfile } from './profile.ts'
import type { CustodyScopeFence } from './profileFencing.ts'
import { createWallet, type WalletOpsDependencies, type WalletOpsSecrets } from './walletOps.ts'

/** One resolution read, with the mint and the relays, cannot hold its caller longer than this. */
export const CONDITION_RESOLUTION_READ_TIMEOUT_MS = 10_000
/** The most relays that one resolution reads. */
const CONDITION_RESOLUTION_RELAYS_MAX = 8

export type ConditionRelayQuery = (
  url: string,
  filter: OracleAttestationRelayFilter,
  signal: AbortSignal,
) => Promise<readonly unknown[]>

/**
 * The result of a condition, read without the matching engine: the mint
 * record first, then the oracle attestation on the relays.
 */
export interface DaemonConditionResolution {
  read(
    conditionId: string,
    options: {
      readonly signal: AbortSignal
      /** Decide from the announced maturity whether a pending condition gets a relay read. */
      readonly readRelays: (maturityEpoch: number) => boolean
    },
  ): Promise<ConditionResolution>
}

export function createDaemonConditionResolution(input: {
  readonly profile: DaemonProfile
  readonly secrets: WalletOpsSecrets
  readonly walletDependencies?: WalletOpsDependencies
  readonly relayUrls: (conditionId: string) => Promise<readonly string[]>
  readonly queryRelay?: ConditionRelayQuery
}): DaemonConditionResolution {
  const queryRelay = input.queryRelay ?? queryOracleRelay
  return {
    read: (conditionId, options) =>
      resolveConditionResult({
        conditionId,
        mintUrl: input.profile.mintUrl,
        allowInsecureLoopbackHttp: isLoopbackHttpUrl(input.profile.mintUrl),
        readMintCondition: async () => {
          const wallet = createWallet(
            input.profile.mintUrl,
            input.secrets,
            input.walletDependencies ?? {},
            'sat',
            'msat',
          ) as unknown as RedeemWallet
          if (wallet.mint?.getCtfCondition === undefined)
            throw new Error('mint condition information is unavailable')
          return wallet.mint.getCtfCondition(conditionId, undefined, {
            include_oracle_sigs: true,
            signal: options.signal,
          })
        },
        relays: {
          when: options.readRelays,
          read: async (filter) => {
            const urls = (await input.relayUrls(conditionId)).slice(
              0,
              CONDITION_RESOLUTION_RELAYS_MAX,
            )
            // One relay that fails does not stop the reads of the others.
            const pages = await Promise.all(
              urls.map((url) => queryRelay(url, filter, options.signal).catch(() => [])),
            )
            return pages.flat()
          },
        },
      }),
  }
}

async function queryOracleRelay(
  url: string,
  filter: OracleAttestationRelayFilter,
  signal: AbortSignal,
): Promise<readonly unknown[]> {
  return (
    await queryNativeActivityRelay(
      url,
      { kinds: [...filter.kinds], authors: [...filter.authors], limit: filter.limit } as Filter,
      { signal },
    )
  ).events
}

/**
 * The relays where the oracle can publish its attestation. When this profile
 * created the oracle, its publication relays come first. The configured
 * relays follow, because the condition registration does not name relays.
 */
export function daemonOracleRelayUrls(
  configured: () => readonly string[],
): (conditionId: string) => Promise<string[]> {
  return async (conditionId) => {
    const record =
      await createNativeOracleCreationStore(profileDir()).readAuthorityByConditionId(conditionId)
    return normalizeNostrRelayUrls([
      ...(record?.announcement == null ? [] : nativeOracleDestinations(record).relayUrls),
      ...configured(),
    ])
  }
}

/** Bind verified result evidence to one custody binding, as a redemption context. */
export function verifiedConditionEvidence(
  binding: ManagedConditionInventoryBinding,
  registeredAuthority: RegisteredConditionAuthority,
  attestedOutcome: string,
  oracleWitness: ConditionOracleWitness,
): Extract<ConditionOracleEvidence, { status: 'verified' }> {
  return requireVerifiedConditionOracleEvidence({
    registered: bindRegisteredDlcConditionAuthority(binding, registeredAuthority),
    evidence: prepareDlcConditionResolutionEvidence(attestedOutcome, oracleWitness).evidence,
  })
}

/** The oracle evidence of a position claim. A failed read leaves the claim unverified. */
export async function resolveDaemonConditionOracleEvidence(input: {
  readonly profile: DaemonProfile
  readonly fence: CustodyScopeFence
  readonly conditionId: string
  readonly resolution: DaemonConditionResolution
}): Promise<{ readonly evidence: ConditionOracleEvidence; readonly resolvedOutcome?: string }> {
  let read: ConditionResolution
  try {
    read = await input.resolution.read(input.conditionId, {
      signal: AbortSignal.timeout(CONDITION_RESOLUTION_READ_TIMEOUT_MS),
      readRelays: () => true,
    })
  } catch {
    return { evidence: unverifiedConditionOracleEvidence('unavailable') }
  }
  const state = read.state
  switch (state.status) {
    case 'resolved':
      try {
        return {
          evidence: verifiedConditionEvidence(
            {
              scopeId: input.fence.scopeId,
              normalizedMint: input.profile.mintUrl,
              unit: 'msat',
              conditionId: input.conditionId,
              canonicalParentCollectionId: null,
            },
            read.registeredAuthority,
            state.attestedOutcome,
            state.oracleWitness,
          ),
          resolvedOutcome: state.attestedOutcome,
        }
      } catch {
        return { evidence: unverifiedConditionOracleEvidence('invalid') }
      }
    case 'unverified':
      return {
        evidence: unverifiedConditionOracleEvidence(state.reason),
        resolvedOutcome: state.reportedOutcome,
      }
    case 'pending':
      return { evidence: unverifiedConditionOracleEvidence('missing') }
    case 'refused':
      return { evidence: unverifiedConditionOracleEvidence('invalid') }
    default:
      return assertNever(state)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled condition resolution state: ${JSON.stringify(value)}`)
}
