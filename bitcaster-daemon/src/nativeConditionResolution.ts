import type { Filter } from 'nostr-tools/filter'
import { isLoopbackHttpUrl } from '@bitcaster-market/client-sdk/engineUrlSecurity'
import { normalizeNostrRelayUrls } from '@bitcaster-market/client-sdk/nostrRelays'
import {
  resolveConditionResult,
  type ConditionOracleWitness,
  type ConditionResolution,
  type OracleAttestationRelayFilter,
  type OracleAttestationRelays,
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

/** One page query to one oracle relay. */
export type ConditionRelayQuery = OracleAttestationRelays['query']

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
          urls: () => input.relayUrls(conditionId),
          query: queryRelay,
          signal: options.signal,
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
      {
        kinds: [...filter.kinds],
        authors: [...filter.authors],
        limit: filter.limit,
        ...(filter.until === undefined ? {} : { until: filter.until }),
      } as Filter,
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

/** The RPC code of a claim that the mint cannot redeem now. Nothing is saved. */
export const POSITION_CLAIM_RESULT_UNAVAILABLE_CODE = 'position-claim-result-unavailable'

/**
 * The daemon cannot read a result with which the mint redeems this claim. A
 * redeem operation that the mint must refuse holds custody readiness and its
 * proof reservations until the mint records a result. Thus the claim saves no
 * operation. A later claim reads the result again.
 */
export class PositionClaimResultUnavailableError extends Error {
  readonly code = POSITION_CLAIM_RESULT_UNAVAILABLE_CODE
}

/**
 * The result of a position claim. The claim continues with verified oracle
 * evidence, or with a result that the mint recorded: then the mint redeems an
 * input without a witness. Each other state refuses the claim.
 */
export async function readDaemonPositionClaimResult(input: {
  readonly profile: DaemonProfile
  readonly fence: CustodyScopeFence
  readonly conditionId: string
  readonly outcomeCollection: string
  readonly resolution: DaemonConditionResolution
}): Promise<{ readonly evidence: ConditionOracleEvidence; readonly resolvedOutcome: string }> {
  let read: ConditionResolution
  try {
    read = await input.resolution.read(input.conditionId, {
      signal: AbortSignal.timeout(CONDITION_RESOLUTION_READ_TIMEOUT_MS),
      readRelays: () => true,
    })
  } catch {
    throw new PositionClaimResultUnavailableError(
      'the condition result could not be read from the mint; try again later',
    )
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
        // The evidence does not bind this claim. Only a mint record can replace it.
        if (state.source !== 'mint') throw noVerifiedResult()
        return mintRecordedResult(input.outcomeCollection, state.attestedOutcome, 'invalid')
      }
    case 'unverified':
      return mintRecordedResult(input.outcomeCollection, state.reportedOutcome, state.reason)
    case 'pending':
      throw noVerifiedResult()
    case 'refused':
      throw new PositionClaimResultUnavailableError(
        `the mint does not redeem this condition by an oracle result (${state.mintStatus})`,
      )
    default:
      return assertNever(state)
  }
}

/**
 * Without verified evidence the mint redeems by its recorded result. It must
 * refuse a collection that does not hold that outcome, and an unverified
 * refusal does not prove a loss. Thus that claim could never finish.
 */
function mintRecordedResult(
  outcomeCollection: string,
  recordedOutcome: string,
  reason: 'missing' | 'invalid',
): { readonly evidence: ConditionOracleEvidence; readonly resolvedOutcome: string } {
  if (!outcomeCollection.split('|').includes(recordedOutcome))
    throw new PositionClaimResultUnavailableError(
      'the mint reports another outcome without verified oracle evidence',
    )
  return { evidence: unverifiedConditionOracleEvidence(reason), resolvedOutcome: recordedOutcome }
}

function noVerifiedResult(): PositionClaimResultUnavailableError {
  return new PositionClaimResultUnavailableError(
    'the condition has no verified result yet; try again later',
  )
}

function assertNever(value: never): never {
  throw new Error(`unhandled condition resolution state: ${JSON.stringify(value)}`)
}
