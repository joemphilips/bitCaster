import { verifyCtfConditionRegistration } from '@bitcaster-market/client-sdk/ctfConditionRegistration'
import {
  readMintConditionResolution,
  type ConditionResolution,
} from '@bitcaster-market/client-sdk/conditionResolution'
import { readAllocationBoundedJsonResponse } from '@bitcaster-market/client-sdk/boundedJsonResponse'
import { isLoopbackHttpUrl } from '@bitcaster-market/client-sdk'

export type MintCtfCondition =
  | { readonly status: 'not-found' }
  | { readonly status: 'not-pending' }
  | {
      readonly status: 'pending'
      readonly registration: ReturnType<typeof verifyCtfConditionRegistration>
    }

/**
 * The mint record of a condition, verified against its registration. A
 * convert needs a condition without a result. The engine is not read.
 */
export async function readMintCtfCondition(input: {
  readonly mintUrl: string
  readonly conditionId: string
  readonly fetch?: typeof globalThis.fetch
}): Promise<MintCtfCondition> {
  const response = await (input.fetch ?? globalThis.fetch)(
    `${input.mintUrl.replace(/\/$/, '')}/v1/conditions/${encodeURIComponent(input.conditionId)}`,
    { signal: AbortSignal.timeout(15_000) },
  )
  if (response.status === 404) return { status: 'not-found' }
  if (!response.ok) throw new Error('mint condition registration is unavailable')
  const condition = await readAllocationBoundedJsonResponse(response, 2 * 1024 * 1024)
  const registrationInput = {
    condition,
    mintUrl: input.mintUrl,
    conditionId: input.conditionId,
    allowInsecureLoopbackHttp: isLoopbackHttpUrl(input.mintUrl),
  }
  const registration = verifyCtfConditionRegistration(registrationInput)
  return mintConditionIsPending(readMintConditionResolution(registrationInput).state)
    ? { status: 'pending', registration }
    : { status: 'not-pending' }
}

/** Each mint condition state is mapped. */
function mintConditionIsPending(state: ConditionResolution['state']): boolean {
  switch (state.status) {
    case 'pending':
      return true
    case 'resolved':
    case 'unverified':
    case 'refused':
      return false
    default:
      throw new Error(`unhandled mint condition state: ${JSON.stringify(state)}`)
  }
}
