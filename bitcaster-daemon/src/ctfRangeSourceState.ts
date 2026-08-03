import type { DatabaseSync } from 'node:sqlite'
import { isDeepStrictEqual } from 'node:util'
import type { Proof } from '@cashu/cashu-ts'
import type { DurableCtfRangeOperation } from '@bitcaster-market/client-sdk/durableCtfRangeOperation'
import { amountToNumber } from '@bitcaster-market/client-sdk/proofSelection'
import {
  readDaemonProofOperationFromDatabase,
  readDaemonReservedWalletProofsFromDatabase,
  replaceDaemonReservedWalletProofsFromDatabase,
  type CashuProofRecord,
  type ProofOperationRecord,
  type StoredProofAsset,
} from './state.ts'

const SOURCE_PURPOSE = 'ctf-range-authorization-source'

export interface CommittedDaemonCtfRangeSource {
  readonly authorization: Proof[]
}

export function commitDaemonCtfRangeSource(
  database: DatabaseSync,
  operation: DurableCtfRangeOperation,
  nowMs: number,
): CommittedDaemonCtfRangeSource {
  const source = readDaemonProofOperationFromDatabase(database, operation.sourceOperationId)
  assertSourceOperation(source, operation)
  if (source === null) throw new Error('daemon CTF range source operation authority is invalid')
  const reservationId = requireText(source.metadata.reservationId, 'source reservation')
  const results = requireSourceResults(source)
  const authorization = results.authorization ?? []
  assertExactAuthorizationProofs(authorization, operation)
  const reserved = readDaemonReservedWalletProofsFromDatabase(
    database,
    operation.mintUrl,
    reservationId,
  )
  if (
    reserved.length !== source.inputs.length ||
    !source.inputs.every((inputProof) =>
      reserved.some(
        (candidate) =>
          candidate.mintUrl === operation.mintUrl &&
          candidate.state === 'reserved' &&
          sameProof(candidate.proof, inputProof),
      ),
    )
  ) {
    throw new Error('daemon CTF range source reservation is incomplete')
  }
  replaceDaemonReservedWalletProofsFromDatabase(database, {
    mintUrl: operation.mintUrl,
    reservationId,
    expectedCount: reserved.length,
    keepProofs: results.keep ?? [],
    asset: sourceAsset(operation),
    nowMs,
  })
  return {
    authorization: authorization.map(toProof),
  }
}

function assertSourceOperation(
  source: ProofOperationRecord | null,
  operation: DurableCtfRangeOperation,
): void {
  if (
    source === null ||
    source.state !== 'completed' ||
    source.mintUrl !== operation.mintUrl ||
    source.metadata.purpose !== SOURCE_PURPOSE ||
    source.metadata.rangeOperationId !== operation.operationId ||
    source.metadata.unit !== operation.unit
  ) {
    throw new Error('daemon CTF range source operation authority is invalid')
  }
  const expectedKind =
    operation.offerAsset.kind === 'regular' ? 'wallet-send' : 'conditional-keyset-swap'
  if (source.kind !== expectedKind) {
    throw new Error('daemon CTF range source operation kind is invalid')
  }
}

function requireSourceResults(source: ProofOperationRecord): Record<string, CashuProofRecord[]> {
  const results = source.resultProofs
  if (results === undefined || Object.keys(results).sort().join('\0') !== 'authorization\0keep') {
    throw new Error('daemon CTF range source result groups are invalid')
  }
  return results
}

function assertExactAuthorizationProofs(
  proofs: readonly CashuProofRecord[],
  operation: DurableCtfRangeOperation,
): void {
  if (
    proofs.length !== operation.inputs.length ||
    proofs.some((proof, index) => !sameProof(proof, operation.inputs[index]!))
  ) {
    throw new Error('daemon CTF range source authorization result is foreign')
  }
}

function sourceAsset(operation: DurableCtfRangeOperation): StoredProofAsset {
  return operation.offerAsset.kind === 'regular'
    ? { kind: 'sats', baseAsset: 'sat', unit: operation.unit }
    : {
        kind: 'Outcome',
        conditionId: operation.offerAsset.conditionId,
        outcomeSetId: operation.offerAsset.outcomeCollection,
        baseAsset: 'sat',
        unit: operation.unit,
      }
}

interface ComparableProof {
  readonly id?: string
  readonly amount: unknown
  readonly secret: string
  readonly C: string
  readonly dleq?: unknown
  readonly witness?: unknown
  readonly p2pk_e?: string | null
  readonly p2pkE?: string | null
}

function sameProof(left: ComparableProof, right: ComparableProof): boolean {
  return (
    left.id === right.id &&
    amountToNumber(left.amount) === amountToNumber(right.amount) &&
    left.secret === right.secret &&
    left.C === right.C &&
    isDeepStrictEqual(left.dleq ?? null, right.dleq ?? null) &&
    isDeepStrictEqual(left.witness ?? null, right.witness ?? null) &&
    (left.p2pk_e ?? left.p2pkE ?? null) === (right.p2pk_e ?? right.p2pkE ?? null)
  )
}

function toProof(value: CashuProofRecord): Proof {
  return {
    ...structuredClone(value),
    id: requireText(value.id, 'authorization keyset'),
    amount: amountToNumber(value.amount) as never,
  } as Proof
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`daemon CTF range ${label} is invalid`)
  }
  return value
}
