import { Amount, normalizeProofAmounts, selectProofsRotating } from '@cashu/cashu-ts'
import type { Proof, SelectProofs } from '@cashu/cashu-ts'

type KeyChainReader = Parameters<SelectProofs>[2]

interface Candidate {
  readonly proof: Proof
  /** Thousandths of a unit that the proof adds to the net amount: 1000 * amount - input fee. */
  readonly net: bigint
  /** Thousandths of a unit that the proof takes from the wallet: 1000 * amount + input fee. */
  readonly cost: bigint
}

/**
 * The proof selector of every bitCaster wallet. Pass it as the `selectProofs` wallet option.
 *
 * The result depends only on the proofs, the amount, the keyset fees, and the flags. The cashu-ts
 * selectors use random numbers, so two calls can select sets with different input fees. A debit
 * that a user approved from a quote would then not cover the later execution.
 *
 * The selector keeps the cashu-ts keyset rotation: it spends the stale keysets first (older
 * versions, inactive before active). It selects the closest match within the last keyset that it
 * needs. It selects a set whenever one exists.
 *
 * An exact match has no quote and no execution fee here. It stays with the cashu-ts selector.
 */
export const selectWalletProofs: SelectProofs = (
  proofs,
  amountToSelect,
  keyChain,
  includeFees = false,
  exactMatch = false,
  logger,
) => {
  if (exactMatch) {
    return selectProofsRotating(proofs, amountToSelect, keyChain, includeFees, exactMatch, logger)
  }
  const normalized = normalizeProofAmounts(proofs)
  const target = 1_000n * Amount.from(amountToSelect).toBigInt()
  const candidates = toCandidates(normalized, keyChain, includeFees)
  const selected =
    target <= 0n
      ? []
      : (selectStaleKeysetsFirst(candidates, keyChain, target) ??
        selectClosest(candidates, target) ??
        [])
  const send = selected.map(({ proof }) => proof)
  const sent = new Set(send)
  return { keep: normalized.filter((proof) => !sent.has(proof)), send }
}

/** Largest net value first. Ties use the proof identity, so the input order has no effect. */
function toCandidates(
  proofs: readonly Proof[],
  keyChain: KeyChainReader,
  includeFees: boolean,
): Candidate[] {
  const secrets = new Set<string>()
  const candidates = proofs.map((proof) => {
    if (secrets.has(proof.secret)) throw new Error('A proof may appear only once in a selection')
    secrets.add(proof.secret)
    const keyset = keyChain.getKeyset(proof.id)
    if (!keyChain.isUnitKeyset(proof.id)) {
      throw new Error(`Keyset '${proof.id}' is not a keyset for this wallet unit`)
    }
    const amount = 1_000n * proof.amount.toBigInt()
    const fee = BigInt(keyset.fee)
    return { proof, net: includeFees ? amount - fee : amount, cost: amount + fee }
  })
  return candidates.sort(
    (a, b) =>
      compare(b.net, a.net) ||
      compare(a.cost, b.cost) ||
      compare(a.proof.id, b.proof.id) ||
      compare(a.proof.secret, b.proof.secret),
  )
}

/** Force the whole stale keysets below the target, then select the rest from the next keyset. */
function selectStaleKeysetsFirst(
  candidates: readonly Candidate[],
  keyChain: KeyChainReader,
  target: bigint,
): Candidate[] | null {
  const forced: Candidate[] = []
  let remaining = target
  for (const bucket of stalenessBuckets(candidates, keyChain)) {
    const bucketNet = bucket.reduce((total, { net }) => total + net, 0n)
    // The mint rounds the whole fee up, so a surplus below one unit is still an exact cover.
    if (bucketNet - remaining >= 1_000n) {
      const rest = selectClosest(bucket, remaining)
      return rest === null ? null : [...forced, ...rest]
    }
    for (const candidate of bucket) forced.push(candidate)
    remaining -= bucketNet
    if (remaining <= 0n) return forced
  }
  return null
}

function stalenessBuckets(
  candidates: readonly Candidate[],
  keyChain: KeyChainReader,
): readonly Candidate[][] {
  const buckets = new Map<number, Candidate[]>()
  for (const candidate of candidates) {
    const keyset = keyChain.getKeyset(candidate.proof.id)
    const version = keyset.hasHexId ? Number.parseInt(candidate.proof.id.slice(0, 2), 16) + 1 : 0
    const staleness = version * 2 + (keyset.isActive ? 1 : 0)
    const bucket = buckets.get(staleness)
    if (bucket === undefined) buckets.set(staleness, [candidate])
    else bucket.push(candidate)
  }
  if (buckets.size <= 1) return []
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, bucket]) => bucket)
}

/**
 * Take each candidate that fits, then cover the rest with the smallest candidate left. A candidate
 * that did not fit is larger than the rest, so this succeeds whenever all candidates can cover the
 * target. One candidate alone replaces this set when it leaves less surplus.
 */
function selectClosest(candidates: readonly Candidate[], target: bigint): Candidate[] | null {
  let remaining = target
  let cover: Candidate | null = null
  let single: Candidate | null = null
  let taken: Candidate[] = []
  for (const candidate of candidates) {
    // A candidate that costs its whole value as a fee cannot help.
    if (candidate.net <= 0n) break
    if (candidate.net >= target) single = candidate
    if (candidate.net <= remaining) {
      taken.push(candidate)
      remaining -= candidate.net
    } else {
      cover = candidate
    }
  }
  if (remaining > 0n) {
    if (cover === null) return null
    remaining -= cover.net
    taken.push(cover)
    taken = taken.filter((candidate) => {
      if (candidate === cover || remaining + candidate.net > 0n) return true
      remaining += candidate.net
      return false
    })
  }
  if (single !== null && single.cost <= taken.reduce((total, { cost }) => total + cost, 0n)) {
    return [single]
  }
  return taken
}

function compare<T extends bigint | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0
}
