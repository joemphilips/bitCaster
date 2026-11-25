import { Amount, normalizeProofAmounts, selectProofsRotating } from '@cashu/cashu-ts'
import type { Proof, SelectProofs } from '@cashu/cashu-ts'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'
import { DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX } from './durableCustody.ts'

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
 * needs. It selects a set whenever one exists. It uses the fewest inputs when a closer match has
 * more inputs than custody accepts. Stale keysets that it must spend whole can still exceed that
 * limit, as in the cashu-ts rotation.
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
        selectBounded(candidates, target, 0) ??
        [])
  const send = selected.map(({ proof }) => proof)
  const sent = new Set(send)
  return { keep: normalized.filter((proof) => !sent.has(proof)), send }
}

function toCandidates(
  proofs: readonly Proof[],
  keyChain: KeyChainReader,
  includeFees: boolean,
): Candidate[] {
  const secrets = new Set<string>()
  return largestFirst(
    proofs.map((proof) => {
      if (secrets.has(proof.secret)) throw new Error('A proof may appear only once in a selection')
      secrets.add(proof.secret)
      const keyset = keyChain.getKeyset(proof.id)
      if (!keyChain.isUnitKeyset(proof.id)) {
        throw new Error(`Keyset '${proof.id}' is not a keyset for this wallet unit`)
      }
      const amount = 1_000n * proof.amount.toBigInt()
      const fee = BigInt(keyset.fee)
      return { proof, net: includeFees ? amount - fee : amount, cost: amount + fee }
    }),
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
    const bucketNet = totalNet(bucket)
    // The mint rounds the whole fee up, so a surplus below one unit is still an exact cover.
    if (bucketNet - remaining >= 1_000n) {
      const rest = selectBounded(bucket, remaining, forced.length)
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

/** Select the closest match, or the fewest inputs when the closest match exceeds the input limit. */
function selectBounded(
  candidates: readonly Candidate[],
  target: bigint,
  forcedInputs: number,
): Candidate[] | null {
  const closest = selectClosest(candidates, target)
  if (closest === null || forcedInputs + closest.length <= DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX)
    return closest
  return selectFewest(candidates, target)
}

/**
 * The random-greedy search of cashu-ts (RGLI) with repeatable orders. Each trial takes candidates in
 * one mixed order until they cover the target, replaces them to remove surplus, and drops what is
 * redundant. Each step keeps the cover, so a set is found whenever all candidates can cover it. The
 * set with the least cost wins.
 */
function selectClosest(candidates: readonly Candidate[], target: bigint): Candidate[] | null {
  // A candidate that costs its whole value as a fee cannot help.
  const economical = largestFirst(candidates.filter(({ net }) => net > 0n)).reverse()
  if (totalNet(economical) < target) return null
  const single = economical.find(({ net }) => net >= target)
  // A candidate larger than the smallest one that covers the target alone adds only surplus.
  const pool = single === undefined ? economical : economical.filter(({ net }) => net <= single.net)
  let best = single === undefined ? null : [single]
  for (const order of mixedOrders(pool, target)) {
    const trial = dropRedundant(reduceSurplus(firstCover(order, target), pool, target), target)
    if (best === null || totalCost(trial) < totalCost(best)) best = trial
    // The mint rounds the whole fee up, so a surplus below one unit is an exact cover.
    if (totalNet(trial) - target < 1_000n) break
  }
  return best
}

/**
 * Repeatable orders that mix small and large candidates. Largest first would leave the small proofs
 * in the wallet until a payment needs more of them than custody accepts. The digest includes the
 * target, so no proof stays last for every payment. It does not leave this function.
 */
function* mixedOrders(candidates: readonly Candidate[], target: bigint): Generator<Candidate[]> {
  const keyed = candidates.map((candidate) => {
    const digest = sha256(utf8ToBytes(`${target}:${candidate.proof.secret}`))
    return { candidate, keys: new DataView(digest.buffer, digest.byteOffset, digest.byteLength) }
  })
  // Each 32-bit word of the digest gives one order.
  for (let offset = 0; offset < sha256.outputLen; offset += 4) {
    yield [...keyed]
      .sort((a, b) => a.keys.getUint32(offset) - b.keys.getUint32(offset))
      .map(({ candidate }) => candidate)
  }
}

function firstCover(order: readonly Candidate[], target: bigint): Candidate[] {
  let total = 0n
  const end = order.findIndex(({ net }) => (total += net) >= target)
  return order.slice(0, end + 1)
}

/** Replace each candidate with the smallest unused one that still covers the target. */
function reduceSurplus(
  selected: readonly Candidate[],
  pool: readonly Candidate[],
  target: bigint,
): Candidate[] {
  const used = new Set(selected)
  const unused = pool.filter((candidate) => !used.has(candidate))
  const result = [...selected]
  let surplus = totalNet(selected) - target
  for (const [index, current] of result.entries()) {
    if (surplus < 1_000n) break
    const replacementIndex = firstAtLeast(unused, current.net - surplus)
    const replacement = unused[replacementIndex]
    if (replacement === undefined || replacement.net >= current.net) continue
    result[index] = replacement
    surplus -= current.net - replacement.net
    unused.splice(replacementIndex, 1)
    unused.splice(firstAtLeast(unused, current.net), 0, current)
  }
  return result
}

/** Drop the smallest candidates that the rest can do without. */
function dropRedundant(selected: readonly Candidate[], target: bigint): Candidate[] {
  let surplus = totalNet(selected) - target
  return largestFirst(selected)
    .reverse()
    .filter(({ net }) => {
      if (net > surplus) return true
      surplus -= net
      return false
    })
}

/** The first index, in an order of rising net value, with at least this net value. */
function firstAtLeast(rising: readonly Candidate[], net: bigint): number {
  let low = 0
  let high = rising.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (rising[middle]!.net >= net) high = middle
    else low = middle + 1
  }
  return low
}

/** The smallest possible input count: the largest candidates, then the smallest that completes. */
function selectFewest(candidates: readonly Candidate[], target: bigint): Candidate[] | null {
  const ordered = largestFirst(candidates)
  const selected: Candidate[] = []
  let remaining = target
  for (const [index, candidate] of ordered.entries()) {
    if (candidate.net <= 0n) return null
    if (candidate.net >= remaining) {
      selected.push(
        ordered
          .slice(index)
          .filter(({ net }) => net >= remaining)
          .at(-1)!,
      )
      return selected
    }
    selected.push(candidate)
    remaining -= candidate.net
  }
  return null
}

function largestFirst(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort(compareCandidates)
}

function totalNet(candidates: readonly Candidate[]): bigint {
  return candidates.reduce((total, { net }) => total + net, 0n)
}

function totalCost(candidates: readonly Candidate[]): bigint {
  return candidates.reduce((total, { cost }) => total + cost, 0n)
}

/** Largest net value first. Ties use the proof identity, so the input order has no effect. */
function compareCandidates(a: Candidate, b: Candidate): number {
  return (
    compare(b.net, a.net) ||
    compare(a.cost, b.cost) ||
    compare(a.proof.id, b.proof.id) ||
    compare(a.proof.secret, b.proof.secret)
  )
}

function compare<T extends bigint | string>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0
}
