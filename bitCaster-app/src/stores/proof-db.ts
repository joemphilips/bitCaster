import Dexie, { type Table } from "dexie";
import type { Proof } from "@cashu/cashu-ts";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import { normalizeUrl } from "../lib/url";

export interface StoredProof extends Proof {
  mintUrl: string;
  /** Local-only reservation owner. Reserved proofs are hidden from spendable balances. */
  reservedBy?: string;
  /** NUT-CTF condition id when this proof is bound to a conditional keyset. */
  conditionId?: string;
  /** NUT-CTF outcome collection label, e.g. "YES" or "Alice|Bob". */
  outcomeCollection?: string;
  /** Convenience mirror for the app's per-outcome market id. */
  marketId?: string;
  /** Timestamp (ms since epoch) when this proof was added to the wallet */
  receivedAt?: number;
}

export interface StoredOutputData {
  blindedMessage: {
    amount: number;
    id: string;
    B_: string;
  };
  blindingFactor: string;
  secret: string;
}

export type ProofOperationKind =
  | "swap-lock"
  | "swap-claim"
  | "conditional-keyset-swap"
  | "swap-refund"
  | "ctf-split"
  | "ctf-redeem"
  | "ctf-condition-registration"
  | "regular-split"
  | "proof-split";
export type ProofOperationState = "prepared" | "completed" | "failed";

export interface ProofOperationRecord {
  operationId: string;
  kind: ProofOperationKind;
  state: ProofOperationState;
  mintUrl: string;
  inputs: Proof[];
  outputs: Record<string, StoredOutputData[]>;
  metadata: Record<string, unknown>;
  resultProofs?: Record<string, Proof[]>;
  lastError?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface PrepareProofOperationInput {
  operationId: string;
  kind: ProofOperationKind;
  mintUrl: string;
  inputs: Proof[];
  outputs: Record<string, StoredOutputData[]>;
  metadata?: Record<string, unknown>;
}

export function isCtfProof(proof: StoredProof | Proof): boolean {
  const candidate = proof as Proof & {
    conditionId?: unknown;
    condition_id?: unknown;
    outcomeCollection?: unknown;
    outcome_collection?: unknown;
  };
  return (
    typeof candidate.conditionId === "string" ||
    typeof candidate.condition_id === "string" ||
    typeof candidate.outcomeCollection === "string" ||
    typeof candidate.outcome_collection === "string"
  );
}

class BitcasterDB extends Dexie {
  proofs!: Table<StoredProof>;
  proofOperations!: Table<ProofOperationRecord>;

  constructor() {
    super("bitcaster");
    this.version(1).stores({
      proofs: "secret, id, C, amount, mintUrl",
    });
    this.version(2).stores({
      proofs: "secret, id, C, amount, mintUrl, receivedAt",
    });
    this.version(3).stores({
      proofs: "secret, id, C, amount, mintUrl, receivedAt",
      proofOperations: "operationId, state, kind, mintUrl, updatedAt",
    });
    this.version(4).stores({
      proofs:
        "secret, id, C, amount, mintUrl, receivedAt, conditionId, outcomeCollection, [conditionId+outcomeCollection], [mintUrl+conditionId+outcomeCollection]",
      proofOperations: "operationId, state, kind, mintUrl, updatedAt",
    });
  }
}

export const db = new BitcasterDB();

export async function getProofs(
  mintUrl?: string,
  options: { includeReserved?: boolean } = {},
): Promise<StoredProof[]> {
  if (mintUrl) {
    const rows = await db.proofs
      .where("mintUrl")
      .equals(normalizeUrl(mintUrl))
      .toArray();
    const normalized = rows.map(normalizeStoredProof);
    return options.includeReserved
      ? normalized
      : normalized.filter((p) => !p.reservedBy);
  }
  const rows = await db.proofs.toArray();
  const normalized = rows.map(normalizeStoredProof);
  return options.includeReserved
    ? normalized
    : normalized.filter((p) => !p.reservedBy);
}

export async function getBaseProofs(mintUrl?: string): Promise<StoredProof[]> {
  const proofs = await getProofs(mintUrl);
  return proofs.filter((p) => !isCtfProof(p));
}

export async function getOutcomeProofs(
  mintUrl: string,
  conditionId: string,
  outcomeCollection: string,
  options: { includeReserved?: boolean } = {},
): Promise<StoredProof[]> {
  const normalizedMintUrl = normalizeUrl(mintUrl);
  const indexed = await db.proofs
    .where("[mintUrl+conditionId+outcomeCollection]")
    .equals([normalizedMintUrl, conditionId, outcomeCollection])
    .toArray();
  if (indexed.length > 0) {
    const normalized = indexed.map(normalizeStoredProof);
    return options.includeReserved
      ? normalized
      : normalized.filter((proof) => !proof.reservedBy);
  }

  const proofs = await getProofs(normalizedMintUrl, options);
  return proofs.filter((p) => {
    const candidate = p as StoredProof & {
      condition_id?: string;
      outcome_collection?: string;
    };
    const proofConditionId = candidate.conditionId ?? candidate.condition_id;
    const proofOutcome =
      candidate.outcomeCollection ?? candidate.outcome_collection;
    return (
      proofConditionId === conditionId && proofOutcome === outcomeCollection
    );
  });
}

// Central normalization point — proofs arrive from many receive paths
// (deposit, atomic-swap change, NIP-17 payload) where `mintUrl` may come
// from a decoded token or a raw wallet config. Normalizing on write means
// the balance query (`getProofs(activeMintUrl)`) never has to worry about
// trailing-slash / protocol-case drift.
export async function addProofs(proofs: StoredProof[]): Promise<void> {
  const now = Date.now();
  const stamped = proofs.map((p) =>
    normalizeStoredProof({
      ...p,
      receivedAt: p.receivedAt ?? now,
    }),
  );
  await db.proofs.bulkPut(stamped);
}

export async function removeProofs(secrets: string[]): Promise<void> {
  await db.proofs.bulkDelete(secrets);
}

export async function replaceProofs(
  spentSecrets: string[],
  freshProofs: StoredProof[],
): Promise<void> {
  const uniqueSpentSecrets = [...new Set(spentSecrets)];
  const now = Date.now();
  const stamped = freshProofs.map((p) =>
    normalizeStoredProof({
      ...p,
      receivedAt: p.receivedAt ?? now,
    }),
  );
  await db.transaction("rw", db.proofs, async () => {
    if (uniqueSpentSecrets.length > 0) {
      await db.proofs.bulkDelete(uniqueSpentSecrets);
    }
    if (stamped.length > 0) {
      await db.proofs.bulkPut(stamped);
    }
  });
}

export async function reserveProofs(
  secrets: string[],
  reservedBy: string,
): Promise<void> {
  const secretSet = new Set(secrets);
  await db.transaction("rw", db.proofs, async () => {
    const rows = await db.proofs.bulkGet(secrets);
    await db.proofs.bulkPut(
      rows
        .filter((row): row is StoredProof => !!row && secretSet.has(row.secret))
        .map((row) => normalizeStoredProof({ ...row, reservedBy })),
    );
  });
}

export async function releaseProofReservation(
  reservedBy: string,
): Promise<void> {
  const rows = await db.proofs
    .filter((proof) => proof.reservedBy === reservedBy)
    .toArray();
  if (rows.length === 0) return;
  await db.proofs.bulkPut(
    rows.map(({ reservedBy: _reservedBy, ...row }) =>
      normalizeStoredProof(row),
    ),
  );
}

export async function releaseProofReservationsBySecret(
  secrets: string[],
): Promise<void> {
  const rows = await db.proofs.bulkGet(secrets);
  const changed = rows
    .filter((row): row is StoredProof => !!row)
    .map(({ reservedBy: _reservedBy, ...row }) => normalizeStoredProof(row));
  if (changed.length === 0) return;
  await db.proofs.bulkPut(changed);
}

export async function getReservedProofs(
  reservedBy: string,
): Promise<StoredProof[]> {
  const rows = await db.proofs
    .filter((proof) => proof.reservedBy === reservedBy)
    .toArray();
  return rows.map(normalizeStoredProof);
}

// One-shot migration: existing rows may have un-normalized mintUrl values
// stored before addProofs normalized on write. Callers should gate this on
// a persisted flag so it runs once per device.
export async function normalizeStoredMintUrls(): Promise<number> {
  const rows = await db.proofs.toArray();
  let changed = 0;
  await db.transaction("rw", db.proofs, async () => {
    for (const row of rows) {
      const normalized = normalizeUrl(row.mintUrl);
      if (normalized !== row.mintUrl) {
        await db.proofs.put({ ...row, mintUrl: normalized });
        changed++;
      }
    }
  });
  return changed;
}

function normalizeStoredProof(proof: StoredProof): StoredProof {
  return {
    ...proof,
    amount: amountToNumber(proof.amount) as never,
    mintUrl: normalizeUrl(proof.mintUrl),
  };
}

export async function getProofOperation(
  operationId: string,
): Promise<ProofOperationRecord | null> {
  return (await db.proofOperations.get(operationId)) ?? null;
}

export async function getProofOperations(
  input: {
    mintUrl?: string;
    states?: ProofOperationState[];
    kinds?: ProofOperationKind[];
    operationIdPrefix?: string;
  } = {},
): Promise<ProofOperationRecord[]> {
  const mintUrl = input.mintUrl ? normalizeUrl(input.mintUrl) : undefined;
  const stateSet = input.states ? new Set(input.states) : null;
  const kindSet = input.kinds ? new Set(input.kinds) : null;
  return (
    await db.proofOperations
      .filter((operation) => {
        if (mintUrl && operation.mintUrl !== mintUrl) return false;
        if (stateSet && !stateSet.has(operation.state)) return false;
        if (kindSet && !kindSet.has(operation.kind)) return false;
        if (
          input.operationIdPrefix &&
          !operation.operationId.startsWith(input.operationIdPrefix)
        ) {
          return false;
        }
        return true;
      })
      .toArray()
  ).map((operation) => ({
    ...operation,
    mintUrl: normalizeUrl(operation.mintUrl),
  }));
}

export async function prepareProofOperation(
  input: PrepareProofOperationInput,
): Promise<ProofOperationRecord> {
  const existing = await getProofOperation(input.operationId);
  if (existing) {
    assertCompatibleProofOperation(existing, input);
    return existing;
  }

  const now = Date.now();
  const record: ProofOperationRecord = {
    operationId: input.operationId,
    kind: input.kind,
    state: "prepared",
    mintUrl: normalizeUrl(input.mintUrl),
    inputs: structuredClone(input.inputs),
    outputs: structuredClone(input.outputs),
    metadata: structuredClone(input.metadata ?? {}),
    resultProofs: undefined,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.proofOperations.put(record);
  return record;
}

export async function markProofOperationCompleted(
  operationId: string,
  resultProofs: Record<string, Proof[]>,
): Promise<ProofOperationRecord> {
  const existing = await getRequiredProofOperation(operationId);
  const updated: ProofOperationRecord = {
    ...existing,
    state: "completed",
    resultProofs: structuredClone(resultProofs),
    lastError: null,
    updatedAt: Date.now(),
  };
  await db.proofOperations.put(updated);
  return updated;
}

export async function markProofOperationFailed(
  operationId: string,
  error: unknown,
): Promise<ProofOperationRecord> {
  const existing = await getRequiredProofOperation(operationId);
  const updated: ProofOperationRecord = {
    ...existing,
    state: "failed",
    lastError: error instanceof Error ? error.message : String(error),
    updatedAt: Date.now(),
  };
  await db.proofOperations.put(updated);
  return updated;
}

async function getRequiredProofOperation(
  operationId: string,
): Promise<ProofOperationRecord> {
  const existing = await getProofOperation(operationId);
  if (!existing) throw new Error(`Missing proof operation ${operationId}`);
  return existing;
}

function assertCompatibleProofOperation(
  existing: ProofOperationRecord,
  input: PrepareProofOperationInput,
): void {
  if (
    existing.kind !== input.kind ||
    existing.mintUrl !== normalizeUrl(input.mintUrl) ||
    JSON.stringify(existing.inputs) !== JSON.stringify(input.inputs)
  ) {
    throw new Error(
      `Proof operation ${input.operationId} already exists with different inputs`,
    );
  }
}
