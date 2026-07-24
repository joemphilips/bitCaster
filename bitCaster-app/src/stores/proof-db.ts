import Dexie, { type Table } from "dexie";
import type { Proof } from "@cashu/cashu-ts";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import {
  COLLATERAL_UNIT_REGISTRY,
  normalizeMarketBaseAsset,
  parseCashuProofUnit,
  type CashuProofUnit,
} from "@bitcaster/client-sdk/marketUnits";
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
  /** Base asset for this proof's amount sub-units. Missing legacy rows are sats. */
  baseAsset?: string;
  /** Exact Cashu keyset unit. Missing legacy rows are excluded from spend operations. */
  unit?: CashuProofUnit;
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
  | "ctf-merge"
  | "ctf-redeem"
  | "ctf-condition-registration"
  | "regular-split"
  | "proof-split"
  | "token-receive";
export type ProofOperationState = "prepared" | "completed" | "Failed";

export interface ProofOperationRecord {
  operationId: string;
  kind: ProofOperationKind;
  state: ProofOperationState;
  mintUrl: string;
  inputs: Proof[];
  outputs: Record<string, StoredOutputData[]>;
  metadata: Record<string, unknown> & { unit?: CashuProofUnit };
  resultProofs?: Record<string, Proof[]>;
  lastError?: string | null;
  /** Structured mint error code for failed operations, when available. */
  failureCode?: number | undefined;
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
    const rows = await db.proofs.where("mintUrl").equals(normalizeUrl(mintUrl)).toArray();
    const normalized = rows.map(normalizeStoredProof);
    return options.includeReserved ? normalized : normalized.filter((p) => !p.reservedBy);
  }
  const rows = await db.proofs.toArray();
  const normalized = rows.map(normalizeStoredProof);
  return options.includeReserved ? normalized : normalized.filter((p) => !p.reservedBy);
}

/**
 * Return regular proofs grouped by base asset for UI display only.
 * WARNING: this may combine different Cashu units (for example sat + msat)
 * and is unsafe for spend/settlement operations. Use `getUnitProofs` there.
 */
export async function getBaseProofs(
  mintUrl?: string,
  options: { includeReserved?: boolean; baseAsset?: string | null } = {},
): Promise<StoredProof[]> {
  const proofs = await getProofs(mintUrl, {
    includeReserved: options.includeReserved,
  });
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  return proofs.filter((p) => !isCtfProof(p) && normalizeStoredProofBaseAsset(p) === baseAsset);
}

/**
 * Return regular proofs by exact Cashu unit for spend/settlement operations.
 * Legacy rows without an explicit `unit` are intentionally excluded fail-closed.
 */
export async function getUnitProofs(
  mintUrl: string | undefined,
  options: { includeReserved?: boolean; unit: CashuProofUnit | string },
): Promise<StoredProof[]> {
  const unit = parseCashuProofUnit(options.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${options.unit}'`);
  const proofs = await getProofs(mintUrl, {
    includeReserved: options.includeReserved,
  });
  return proofs.filter((p) => !isCtfProof(p) && normalizeStoredProofUnit(p) === unit);
}

export async function selectAndReserveUnitProofs(
  mintUrl: string | undefined,
  options: { unit: CashuProofUnit | string; minimumAmount?: number },
  reservedBy: string,
): Promise<StoredProof[]> {
  const unit = parseCashuProofUnit(options.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${options.unit}'`);
  const normalizedMintUrl = mintUrl ? normalizeUrl(mintUrl) : undefined;
  const minimumAmount = options.minimumAmount ?? 0;
  let selected: StoredProof[] = [];

  await db.transaction("rw", db.proofs, async () => {
    const rows = normalizedMintUrl
      ? await db.proofs.where("mintUrl").equals(normalizedMintUrl).toArray()
      : await db.proofs.toArray();
    const spendable = rows
      .map(normalizeStoredProof)
      .filter(
        (proof) =>
          !proof.reservedBy && !isCtfProof(proof) && normalizeStoredProofUnit(proof) === unit,
      );

    const picked: StoredProof[] = [];
    let pickedAmount = 0;
    for (const proof of spendable) {
      picked.push(proof);
      pickedAmount += amountToNumber(proof.amount);
      if (minimumAmount > 0 && pickedAmount >= minimumAmount) break;
    }
    if (minimumAmount > 0 && pickedAmount < minimumAmount) {
      throw new Error("Insufficient spendable proofs for requested amount");
    }

    const currentRows = await db.proofs.bulkGet(picked.map((proof) => proof.secret));
    if (currentRows.length !== picked.length) {
      throw new Error("Selected proof reservation failed: proof set changed");
    }
    const current = currentRows.map((row) => (row ? normalizeStoredProof(row) : undefined));
    if (current.some((row) => !row || row.reservedBy)) {
      throw new Error("Selected proof reservation failed: proof already reserved or missing");
    }

    selected = current.filter((row): row is StoredProof => !!row);
    if (selected.length > 0) {
      await db.proofs.bulkPut(
        selected.map((proof) => normalizeStoredProof({ ...proof, reservedBy })),
      );
    }
  });

  return selected;
}

export async function getOutcomeProofs(
  mintUrl: string,
  conditionId: string,
  outcomeCollection: string,
  options: { includeReserved?: boolean; baseAsset?: string | null } = {},
): Promise<StoredProof[]> {
  const normalizedMintUrl = normalizeUrl(mintUrl);
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  const indexed = await db.proofs
    .where("[mintUrl+conditionId+outcomeCollection]")
    .equals([normalizedMintUrl, conditionId, outcomeCollection])
    .toArray();
  if (indexed.length > 0) {
    const normalized = indexed
      .map(normalizeStoredProof)
      .filter((proof) => normalizeStoredProofBaseAsset(proof) === baseAsset);
    return options.includeReserved ? normalized : normalized.filter((proof) => !proof.reservedBy);
  }

  const proofs = await getProofs(normalizedMintUrl, options);
  return proofs.filter((p) => {
    const candidate = p as StoredProof & {
      condition_id?: string;
      outcome_collection?: string;
    };
    const proofConditionId = candidate.conditionId ?? candidate.condition_id;
    const proofOutcome = candidate.outcomeCollection ?? candidate.outcome_collection;
    return (
      proofConditionId === conditionId &&
      proofOutcome === outcomeCollection &&
      normalizeStoredProofBaseAsset(p) === baseAsset
    );
  });
}

/**
 * Return ALL of a condition's CTF proofs at a mint, regardless of how the
 * outcome was labelled when persisted.
 *
 * A composite ("A|B") position lives as proofs spanning MULTIPLE primitive
 * keysets, and settlement persists them inconsistently: sometimes under the
 * composite `outcomeCollection="A|B"` label, sometimes per-primitive
 * (`outcomeCollection="A"` / `"B"`). A label-scoped query (`getOutcomeProofs`)
 * therefore misses proofs. The redeem path must bucket by the proof's real
 * `keyset_id` (`Proof.id`), so it needs every CTF proof of the condition —
 * not a label slice. This query gathers them by `conditionId` only.
 */
export async function getConditionCtfProofs(
  mintUrl: string,
  conditionId: string,
  options: { includeReserved?: boolean; baseAsset?: string | null } = {},
): Promise<StoredProof[]> {
  const proofs = await getProofs(mintUrl, options);
  const baseAsset = normalizeMarketBaseAsset(options.baseAsset);
  return proofs.filter((p) => {
    if (!isCtfProof(p)) return false;
    const candidate = p as StoredProof & { condition_id?: string };
    const proofConditionId = candidate.conditionId ?? candidate.condition_id;
    return proofConditionId === conditionId && normalizeStoredProofBaseAsset(p) === baseAsset;
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
      ...validateStoredProofUnitInvariant(p),
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
      ...validateStoredProofUnitInvariant(p),
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

export async function reserveProofs(secrets: string[], reservedBy: string): Promise<void> {
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

export async function releaseProofReservation(reservedBy: string): Promise<void> {
  const rows = await db.proofs.filter((proof) => proof.reservedBy === reservedBy).toArray();
  if (rows.length === 0) return;
  await db.proofs.bulkPut(
    rows.map(({ reservedBy: _reservedBy, ...row }) => normalizeStoredProof(row)),
  );
}

export async function releaseProofReservationsBySecret(secrets: string[]): Promise<void> {
  const rows = await db.proofs.bulkGet(secrets);
  const changed = rows
    .filter((row): row is StoredProof => !!row)
    .map(({ reservedBy: _reservedBy, ...row }) => normalizeStoredProof(row));
  if (changed.length === 0) return;
  await db.proofs.bulkPut(changed);
}

export async function getReservedProofs(reservedBy: string): Promise<StoredProof[]> {
  const rows = await db.proofs.filter((proof) => proof.reservedBy === reservedBy).toArray();
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
    baseAsset: normalizeStoredProofBaseAsset(proof),
    unit: normalizeStoredProofUnit(proof),
  };
}

function normalizeStoredProofBaseAsset(proof: StoredProof): string {
  const unit = parseCashuProofUnit(proof.unit);
  if (unit && !proof.baseAsset) return COLLATERAL_UNIT_REGISTRY[unit].baseAsset;
  return normalizeMarketBaseAsset(proof.baseAsset);
}

export function normalizeStoredProofUnit(proof: StoredProof): CashuProofUnit | undefined {
  return parseCashuProofUnit(proof.unit) ?? undefined;
}

function validateStoredProofUnitInvariant(proof: StoredProof): StoredProof {
  if (!proof.unit) return proof;
  const unit = parseCashuProofUnit(proof.unit);
  if (!unit) throw new Error(`Unsupported Cashu proof unit '${proof.unit}'`);
  const unitInfo = COLLATERAL_UNIT_REGISTRY[unit];
  const baseAsset = proof.baseAsset
    ? normalizeMarketBaseAsset(proof.baseAsset)
    : unitInfo.baseAsset;
  if (unitInfo.baseAsset !== baseAsset) {
    throw new Error(
      `Stored proof unit '${proof.unit}' is not compatible with base asset '${proof.baseAsset}'`,
    );
  }
  return proof;
}

export async function getProofOperation(operationId: string): Promise<ProofOperationRecord | null> {
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
        if (input.operationIdPrefix && !operation.operationId.startsWith(input.operationIdPrefix)) {
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
    failureCode: undefined,
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
    failureCode: undefined,
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
    state: "Failed",
    lastError: error instanceof Error ? error.message : String(error),
    failureCode: mintErrorCode(error),
    updatedAt: Date.now(),
  };
  await db.proofOperations.put(updated);
  return updated;
}

function mintErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

async function getRequiredProofOperation(operationId: string): Promise<ProofOperationRecord> {
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
    throw new Error(`Proof operation ${input.operationId} already exists with different inputs`);
  }
}
