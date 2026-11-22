import { HttpResponseError } from '@cashu/cashu-ts'
import {
  classifyCashuMintFailure,
  type CashuMintRefusal,
} from '@bitcaster-market/client-sdk/mintRefusal'

/**
 * Bounded text for errors that hold a mint HTTP answer (ADR-037 mint refusal
 * settlement). A mint answer can quote long text, such as a blinded message
 * or a proof Y point. RPC replies, recovery status, and daemon log lines get
 * fixed text instead. A coded refusal also keeps the SDK's bounded detail.
 */

// The cause depth that `classifyCashuMintFailure` reads.
const MINT_ERROR_CAUSE_DEPTH_MAX = 4

/** Fixed text for an error that holds a mint answer, or null when it holds none. */
export function boundedMintAnswer(
  error: unknown,
): { readonly error: string; readonly mintError?: CashuMintRefusal } | null {
  const failure = classifyCashuMintFailure(error)
  if (failure.kind === 'refusal') {
    return {
      error: `mint request was refused (mint code ${failure.code})`,
      mintError: { code: failure.code, detail: failure.detail },
    }
  }
  let current: unknown = error
  for (let depth = 0; depth < MINT_ERROR_CAUSE_DEPTH_MAX && current instanceof Error; depth += 1) {
    if (current instanceof HttpResponseError) {
      return { error: `mint request failed (HTTP ${current.status})` }
    }
    current = (current as { cause?: unknown }).cause
  }
  return null
}

/** The text of an error for a status or a log line. A mint answer gets fixed text. */
export function boundedErrorText(error: unknown): string {
  return boundedMintAnswer(error)?.error ?? (error instanceof Error ? error.message : String(error))
}
