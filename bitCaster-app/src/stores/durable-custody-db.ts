import type { Proof } from "@cashu/cashu-ts";
import {
  applyDurableCustodyTransaction,
  assertDurableCustodyArtifactMatchesReference,
  claimDurableCustodyScope,
  createDurableCustodyArtifactReference,
  decodeCanonicalMintOrigin,
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeId,
  decodeDurableCustodyScopeState,
  durableCustodyArtifactReferences,
  encodeBoundedDurableArtifact,
  isDurableCustodyActiveRecoveryRecord,
  reduceDurableCustodyState,
  releaseDurableCustodyScope,
  DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX,
  DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX,
  DURABLE_CUSTODY_RECORD_BYTES_MAX,
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX,
  DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX,
  type DurableCustodyArtifactRow,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyPageStore,
  type DurableCustodyRecord,
  type DurableCustodyScope,
  type DurableCustodyScopeState,
  type DurableCustodyTransaction,
  type DurableCustodyTransactionSelection,
  type DurableCustodyTransition,
} from "@bitcaster/client-sdk/durableCustody";
import {
  createDurableCustodyProofMaterialRecord,
  decodeDurableCustodyProofMaterialRecord,
} from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { db, type BitcasterDB } from "./proof-db";
import type {
  BrowserCustodyActiveWorkRow,
  BrowserCustodyArtifactRow,
  BrowserCustodyOperationRow,
  BrowserCustodyProofRow,
  BrowserCustodyProofSelectability,
  BrowserCustodyProofUnit,
  BrowserCustodyReservationRow,
  BrowserCustodyScopeRow,
} from "./durable-custody-types";

const ROW_TEXT_BYTES_MAX = 64 * 1_024;
const TRANSACTION_PROOF_ROW_LIMIT_MAX =
  DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX + DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX;

export type BrowserCustodyProofAsset =
  | {
      readonly kind: "regular";
      readonly conditionId?: never;
      readonly outcomeCollection?: never;
    }
  | {
      readonly kind: "conditional";
      readonly conditionId: string;
      readonly outcomeCollection: string;
    };

export interface StagedBrowserCustodyProof {
  readonly proof: BrowserCustodyProofRow;
  readonly expectedRevision: number | null;
}

export interface BrowserCustodyTransactionOptions {
  readonly predecessorProofs?: Readonly<Record<string, readonly BrowserCustodyProofRow[]>>;
  readonly successorProofs?: Readonly<Record<string, readonly StagedBrowserCustodyProof[]>>;
  readonly injectFault?: "before-commit" | "after-commit";
}

type ApplyVerifiedResultInput = Parameters<DurableCustodyTransaction["applyVerifiedResult"]>[0];

export function createBrowserCustodyProofRow(input: {
  readonly scopeId: string;
  readonly normalizedMint: string;
  readonly unit: BrowserCustodyProofUnit;
  readonly proof: Proof;
  readonly asset: BrowserCustodyProofAsset;
  readonly receivedAtMs: number;
}): BrowserCustodyProofRow {
  decodeDurableCustodyScopeId(input.scopeId);
  const normalizedMint = decodeCanonicalMintOrigin(input.normalizedMint);
  const asset = normalizeProofAsset(input.asset, input.unit);
  const material = createDurableCustodyProofMaterialRecord({
    scopeId: input.scopeId,
    normalizedMint,
    unit: input.unit,
    proof: {
      id: input.proof.id,
      amount: input.proof.amount,
      secret: input.proof.secret,
      C: input.proof.C,
      dleq: input.proof.dleq ?? null,
      p2pkE: input.proof.p2pk_e ?? null,
      witness: input.proof.witness ?? null,
    },
  });
  return decodeBrowserCustodyProofRow({
    scopeId: input.scopeId,
    normalizedMint,
    unit: input.unit,
    ...asset,
    baseAsset: "sat",
    ...material,
    revision: 0,
    selectability: "selectable",
    reservationOperationId: null,
    receivedAtMs: requireTime(input.receivedAtMs, "proof received time"),
  });
}

export function decodeBrowserCustodyProofRow(value: unknown): BrowserCustodyProofRow {
  const row = exactRecord(value, [
    "scopeId",
    "normalizedMint",
    "unit",
    "assetKind",
    "conditionId",
    "outcomeCollection",
    "baseAsset",
    "proofId",
    "keysetId",
    "amount",
    "proofBody",
    "proofFingerprint",
    "curve",
    "dleqPresence",
    "revision",
    "selectability",
    "reservationOperationId",
    "receivedAtMs",
  ]);
  const scopeId = decodeDurableCustodyScopeId(row.scopeId);
  const normalizedMint = decodeCanonicalMintOrigin(row.normalizedMint);
  const unit = closedValue(row.unit, ["sat", "msat"], "proof unit");
  const asset = decodeProofAsset(row, unit);
  const material = decodeDurableCustodyProofMaterialRecord({
    scopeId,
    normalizedMint,
    unit,
    proofId: requiredText(row.proofId, "proof id"),
    keysetId: requiredText(row.keysetId, "keyset id"),
    amount: positiveSafeInteger(row.amount, "proof amount"),
    proofBody: requireBytes(row.proofBody, "proof body"),
    proofFingerprint: requiredText(row.proofFingerprint, "proof fingerprint"),
    curve: closedValue(row.curve, ["secp256k1", "bls12-381"], "proof curve"),
    dleqPresence: closedValue(row.dleqPresence, ["not-present", "present"], "DLEQ presence"),
  }).record;
  const selectability = closedValue(
    row.selectability,
    ["selectable", "locked", "spent"],
    "proof selectability",
  );
  const reservationOperationId =
    row.reservationOperationId === null
      ? null
      : requiredText(row.reservationOperationId, "proof reservation operation");
  assertReservationState(selectability, reservationOperationId);
  if (row.baseAsset !== "sat") throw new Error("browser custody proof base asset is invalid");
  return {
    scopeId,
    normalizedMint,
    unit,
    ...asset,
    baseAsset: "sat",
    ...material,
    revision: nonnegativeSafeInteger(row.revision, "proof revision"),
    selectability,
    reservationOperationId,
    receivedAtMs: requireTime(row.receivedAtMs, "proof received time"),
  };
}

export class BrowserDurableCustodyAdapter implements DurableCustodyPageStore {
  readonly #database: BitcasterDB;

  constructor(database: BitcasterDB = db) {
    this.#database = database;
  }

  async ensureScope(scope: DurableCustodyScope, observedAtMs: number): Promise<void> {
    const expected = initialScopeState(scope, observedAtMs);
    await this.#database.transaction("rw", this.#database.custodyScopes, async () => {
      const existing = await this.#database.custodyScopes.get(scope.scopeId);
      if (!existing) {
        await this.#database.custodyScopes.add({ scopeId: scope.scopeId, state: expected });
        return;
      }
      const current = decodeScopeRow(existing).state;
      if (!sameScope(current.scope, expected.scope)) {
        throw new Error("browser custody scope conflicts with persisted state");
      }
    });
  }

  async claimScope(
    scope: DurableCustodyScope,
    input: { incarnationId: string; observedAtMs: number; leaseExpiresAtMs: number },
  ): Promise<DurableCustodyOwnerAuthorization> {
    await this.ensureScope(scope, input.observedAtMs);
    return this.#database.transaction("rw", this.#database.custodyScopes, async () => {
      const current = await this.#requiredScope(scope.scopeId);
      const next = claimDurableCustodyScope(current.state, input);
      await this.#database.custodyScopes.put({ scopeId: scope.scopeId, state: next });
      return {
        incarnationId: input.incarnationId,
        fencingEpoch: next.fencingEpoch,
        observedAtMs: input.observedAtMs,
      };
    });
  }

  async releaseScope(
    scope: DurableCustodyScope,
    authorization: DurableCustodyOwnerAuthorization,
  ): Promise<void> {
    await this.#database.transaction("rw", this.#database.custodyScopes, async () => {
      const current = await this.#requiredScope(scope.scopeId);
      const next = releaseDurableCustodyScope(current.state, authorization);
      await this.#database.custodyScopes.put({ scopeId: scope.scopeId, state: next });
    });
  }

  async transact<T>(
    selection: DurableCustodyTransactionSelection,
    apply: (transaction: DurableCustodyTransaction) => T,
    options: BrowserCustodyTransactionOptions = {},
  ): Promise<T> {
    const tables = [
      this.#database.custodyScopes,
      this.#database.custodyOperations,
      this.#database.custodyArtifacts,
      this.#database.custodyProofs,
      this.#database.custodyReservations,
      this.#database.custodyActiveWork,
    ];
    const result = await this.#database.transaction("rw", tables, async () => {
      const scope = (await this.#requiredScope(selection.scope.scopeId)).state;
      const operationRows = await this.#loadSelectedOperations(selection);
      const artifacts = await this.#loadArtifacts(selection.scope.scopeId, operationRows);
      const proofState = await this.#loadProofState(
        selection.scope.scopeId,
        operationRows,
        options,
      );
      const transaction = new StagedBrowserCustodyTransaction({
        scopeState: scope,
        operations: operationRows,
        artifacts,
        proofs: proofState.proofs,
        reservations: proofState.reservations,
        successorProofs: options.successorProofs ?? {},
      });
      const output = applyDurableCustodyTransaction(transaction, selection, apply);
      await this.#persistTransaction(selection, transaction);
      if (options.injectFault === "before-commit") {
        throw new Error("injected browser custody fault before commit");
      }
      return output;
    });
    if (options.injectFault === "after-commit") {
      throw new Error("injected browser custody fault after commit");
    }
    return result;
  }

  async readOperation(
    scope: DurableCustodyScope,
    operationId: string,
  ): Promise<DurableCustodyRecord | null> {
    const row = await this.#database.custodyOperations.get([scope.scopeId, operationId]);
    return row ? decodeOperationRow(row).record : null;
  }

  async readProof(scopeId: string, proofId: string): Promise<BrowserCustodyProofRow | null> {
    const row = await this.#database.custodyProofs.get([scopeId, proofId]);
    return row ? decodeBrowserCustodyProofRow(row) : null;
  }

  async readOperationSnapshot(
    scope: DurableCustodyScope,
    operationId: string,
  ): Promise<{
    record: DurableCustodyRecord;
    artifacts: readonly DurableCustodyArtifactRow[];
  } | null> {
    return this.#database.transaction(
      "r",
      [this.#database.custodyOperations, this.#database.custodyArtifacts],
      async () => {
        const operation = await this.readOperation(scope, operationId);
        if (!operation) return null;
        const references = durableCustodyArtifactReferences(operation);
        const rows = await this.#database.custodyArtifacts.bulkGet(
          references.map(({ artifactId }) => [scope.scopeId, operationId, artifactId]),
        );
        return {
          record: operation,
          artifacts: rows.map((row, index) => {
            if (!row) throw new Error("browser custody referenced artifact is missing");
            const decoded = decodeArtifactRow(row);
            const expected = references[index]!;
            if (
              decoded.scopeId !== scope.scopeId ||
              decoded.operationId !== operationId ||
              !sameArtifactReference(decoded.reference, expected)
            ) {
              throw new Error("browser custody artifact row authority is foreign");
            }
            assertDurableCustodyArtifactMatchesReference(expected, decoded.artifact);
            return {
              reference: expected,
              artifact: decoded.artifact,
              revision: decoded.revision,
            };
          }),
        };
      },
    );
  }

  async listRecoverablePage(input: {
    scope: DurableCustodyScope;
    cursor: string | null;
    limit: number;
  }): Promise<{ records: DurableCustodyRecord[]; nextCursor: string | null }> {
    const limit = recoveryLimit(input.limit);
    const cursor = decodeRecoveryCursor(input.cursor);
    return this.#database.transaction(
      "r",
      [
        this.#database.custodyScopes,
        this.#database.custodyOperations,
        this.#database.custodyActiveWork,
      ],
      () => this.#listRecoverablePageSnapshot(input.scope, cursor, limit),
    );
  }

  async #listRecoverablePageSnapshot(
    scope: DurableCustodyScope,
    cursor: ReturnType<typeof decodeRecoveryCursor>,
    limit: number,
  ): Promise<{ records: DurableCustodyRecord[]; nextCursor: string | null }> {
    const scopeState = (await this.#requiredScope(scope.scopeId)).state;
    if (!sameScope(scopeState.scope, scope)) {
      throw new Error("browser custody recovery scope is foreign");
    }
    const lower: readonly unknown[] = cursor
      ? [scope.scopeId, cursor.nextAttemptAtMs, cursor.operationId]
      : [scope.scopeId];
    const upper: readonly unknown[] = [scope.scopeId, []];
    const rows = await this.#database.custodyActiveWork
      .where("[scopeId+nextAttemptAtMs+operationId]")
      .between(lower, upper, cursor === null, true)
      .limit(limit + 1)
      .toArray();
    const activeRows = rows.map(decodeActiveWorkRow);
    const operationRows = await this.#database.custodyOperations.bulkGet(
      activeRows.map(({ operationId }) => [scope.scopeId, operationId]),
    );
    const entries: Array<{
      active: BrowserCustodyActiveWorkRow;
      record: DurableCustodyRecord;
    }> = [];
    let totalBytes = 0;
    for (const [index, active] of activeRows.slice(0, limit).entries()) {
      const row = operationRows[index];
      if (!row) throw new Error("browser custody active operation is missing");
      const operationRow = decodeOperationRow(row);
      const operation = operationRow.record;
      if (
        active.scopeId !== scope.scopeId ||
        active.operationId !== operation.operation.operationId ||
        active.estimatedBytes !== operationRow.estimatedBytes ||
        (operationRow.nextAttemptAtMs === null
          ? active.nextAttemptAtMs > scopeState.effectiveClock.highWaterMarkMs
          : active.nextAttemptAtMs !== operationRow.nextAttemptAtMs) ||
        !isDurableCustodyActiveRecoveryRecord(operation)
      ) {
        throw new Error("browser custody active work authority is foreign");
      }
      const bytes = operationBytes(operation);
      const separatorBytes = entries.length === 0 ? 0 : 1;
      if (
        entries.length > 0 &&
        totalBytes + separatorBytes + bytes > DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX
      )
        break;
      entries.push({ active, record: operation });
      totalBytes += separatorBytes + bytes;
    }
    return fitRecoveryPage(entries, rows.length > entries.length);
  }

  async #requiredScope(scopeId: string): Promise<BrowserCustodyScopeRow> {
    const row = await this.#database.custodyScopes.get(scopeId);
    if (!row) throw new Error("browser custody scope is missing");
    return decodeScopeRow(row);
  }

  async #loadSelectedOperations(
    selection: DurableCustodyTransactionSelection,
  ): Promise<Map<string, DurableCustodyRecord | null>> {
    const rows = await this.#database.custodyOperations.bulkGet(
      selection.operationRows.map(({ operationId }) => [selection.scope.scopeId, operationId]),
    );
    return new Map(
      rows.map((row, index) => {
        const operationId = selection.operationRows[index]!.operationId;
        return [operationId, row ? decodeOperationRow(row).record : null];
      }),
    );
  }

  async #loadArtifacts(
    scopeId: string,
    operations: ReadonlyMap<string, DurableCustodyRecord | null>,
  ): Promise<Map<string, BrowserCustodyArtifactRow>> {
    const result = new Map<string, BrowserCustodyArtifactRow>();
    for (const operationId of operations.keys()) {
      const rows = await this.#database.custodyArtifacts
        .where("[scopeId+operationId]")
        .equals([scopeId, operationId])
        .toArray();
      for (const row of rows) {
        const decoded = decodeArtifactRow(row);
        result.set(artifactKey(operationId, decoded.artifactId), decoded);
      }
    }
    return result;
  }

  async #loadProofState(
    scopeId: string,
    operations: ReadonlyMap<string, DurableCustodyRecord | null>,
    options: BrowserCustodyTransactionOptions,
  ): Promise<{
    proofs: Map<string, BrowserCustodyProofRow>;
    reservations: Map<string, BrowserCustodyReservationRow>;
  }> {
    const { predecessorCandidates, successorCandidates } = collectTransactionProofs(
      operations,
      options,
    );
    const proofIds = new Set([
      ...[...operations.values()].flatMap((record) =>
        record ? record.operation.reservation.inputs.map(({ proofId }) => proofId) : [],
      ),
      ...predecessorCandidates.map(({ proofId }) => proofId),
      ...successorCandidates.map(({ proofId }) => proofId),
    ]);
    const keys = [...proofIds].map((proofId) => [scopeId, proofId] as [string, string]);
    const [proofRows, reservationRows] = await Promise.all([
      this.#database.custodyProofs.bulkGet(keys),
      this.#database.custodyReservations.bulkGet(keys),
    ]);
    const proofs = new Map<string, BrowserCustodyProofRow>();
    const reservations = new Map<string, BrowserCustodyReservationRow>();
    proofRows.forEach((row) => {
      if (row) {
        const decoded = decodeBrowserCustodyProofRow(row);
        proofs.set(decoded.proofId, decoded);
      }
    });
    reservationRows.forEach((row) => {
      if (row) {
        const decoded = decodeReservationRow(row);
        reservations.set(decoded.proofId, decoded);
      }
    });
    for (const candidate of predecessorCandidates) {
      if (candidate.scopeId !== scopeId) throw new Error("browser custody proof scope is foreign");
      const existing = proofs.get(candidate.proofId);
      if (existing) {
        assertSameProofAuthority(existing, candidate);
      } else {
        proofs.set(candidate.proofId, candidate);
      }
    }
    return { proofs, reservations };
  }

  async #persistTransaction(
    selection: DurableCustodyTransactionSelection,
    transaction: StagedBrowserCustodyTransaction,
  ): Promise<void> {
    await this.#persistChangedOperations(transaction);
    await this.#persistChangedArtifacts(transaction);
    await this.#persistChangedProofs(transaction);
    await this.#persistReservations(selection.scope.scopeId, transaction);
    await this.#rebuildActiveWork(selection, transaction);
    await this.#persistEffectiveClock(selection, transaction.scopeState);
  }

  async #persistChangedOperations(transaction: StagedBrowserCustodyTransaction): Promise<void> {
    for (const operationId of transaction.changedOperationIds) {
      const record = transaction.operations.get(operationId);
      if (!record) throw new Error("browser custody changed operation is absent");
      await this.#database.custodyOperations.put(operationRow(record));
    }
  }

  async #persistChangedArtifacts(transaction: StagedBrowserCustodyTransaction): Promise<void> {
    for (const key of transaction.changedArtifactKeys) {
      const artifact = transaction.artifacts.get(key);
      if (!artifact) throw new Error("browser custody changed artifact is absent");
      await this.#database.custodyArtifacts.put(decodeArtifactRow(artifact));
    }
  }

  async #persistChangedProofs(transaction: StagedBrowserCustodyTransaction): Promise<void> {
    for (const proofId of transaction.changedProofIds) {
      const proof = transaction.proofs.get(proofId);
      if (!proof) throw new Error("browser custody changed proof is absent");
      await this.#database.custodyProofs.put(decodeBrowserCustodyProofRow(proof));
    }
  }

  async #persistReservations(
    scopeId: string,
    transaction: StagedBrowserCustodyTransaction,
  ): Promise<void> {
    for (const proofId of transaction.deletedReservationIds) {
      await this.#database.custodyReservations.delete([scopeId, proofId]);
    }
    for (const proofId of transaction.changedReservationIds) {
      const reservation = transaction.reservations.get(proofId);
      if (!reservation) throw new Error("browser custody changed reservation is absent");
      await this.#database.custodyReservations.put(decodeReservationRow(reservation));
    }
  }

  async #rebuildActiveWork(
    selection: DurableCustodyTransactionSelection,
    transaction: StagedBrowserCustodyTransaction,
  ): Promise<void> {
    const rebuild = new Set([
      ...transaction.changedOperationIds,
      ...transaction.rebuildOperationIds,
    ]);
    for (const operationId of rebuild) {
      await this.#database.custodyActiveWork.delete([selection.scope.scopeId, operationId]);
      const record = transaction.operations.get(operationId);
      if (!record || !isDurableCustodyActiveRecoveryRecord(record)) continue;
      await this.#database.custodyActiveWork.put(
        decodeActiveWorkRow({
          scopeId: selection.scope.scopeId,
          operationId,
          nextAttemptAtMs: record.operation.retry.nextAttemptAtMs ?? selection.owner.observedAtMs,
          estimatedBytes: operationBytes(record),
        }),
      );
    }
  }

  async #persistEffectiveClock(
    selection: DurableCustodyTransactionSelection,
    scopeState: DurableCustodyScopeState,
  ): Promise<void> {
    const nextScope = decodeDurableCustodyScopeState({
      ...scopeState,
      effectiveClock: {
        highWaterMarkMs: Math.max(
          scopeState.effectiveClock.highWaterMarkMs,
          selection.owner.observedAtMs,
        ),
      },
    });
    await this.#database.custodyScopes.put({
      scopeId: selection.scope.scopeId,
      state: nextScope,
    });
  }
}

class StagedBrowserCustodyTransaction implements DurableCustodyTransaction {
  readonly scopeState: DurableCustodyScopeState;
  readonly operations: Map<string, DurableCustodyRecord | null>;
  readonly artifacts: Map<string, BrowserCustodyArtifactRow>;
  readonly proofs: Map<string, BrowserCustodyProofRow>;
  readonly reservations: Map<string, BrowserCustodyReservationRow>;
  readonly changedOperationIds = new Set<string>();
  readonly changedArtifactKeys = new Set<string>();
  readonly changedProofIds = new Set<string>();
  readonly changedReservationIds = new Set<string>();
  readonly deletedReservationIds = new Set<string>();
  readonly rebuildOperationIds = new Set<string>();
  readonly #successorProofs: Readonly<Record<string, readonly StagedBrowserCustodyProof[]>>;

  constructor(input: {
    scopeState: DurableCustodyScopeState;
    operations: Map<string, DurableCustodyRecord | null>;
    artifacts: Map<string, BrowserCustodyArtifactRow>;
    proofs: Map<string, BrowserCustodyProofRow>;
    reservations: Map<string, BrowserCustodyReservationRow>;
    successorProofs: Readonly<Record<string, readonly StagedBrowserCustodyProof[]>>;
  }) {
    this.scopeState = decodeDurableCustodyScopeState(input.scopeState);
    this.operations = new Map(
      [...input.operations].map(([id, record]) => [
        id,
        record === null ? null : decodeDurableCustodyRecord(record),
      ]),
    );
    this.artifacts = new Map(input.artifacts);
    this.proofs = new Map(input.proofs);
    this.reservations = new Map(input.reservations);
    this.#successorProofs = input.successorProofs;
  }

  getScopeState(): DurableCustodyScopeState {
    return structuredClone(this.scopeState);
  }

  getOperation(operationId: string): DurableCustodyRecord | null {
    const record = this.operations.get(operationId);
    return record === undefined || record === null ? null : structuredClone(record);
  }

  putOperation(input: Parameters<DurableCustodyTransaction["putOperation"]>[0]): void {
    if (
      input.expectedRevision !== null ||
      this.operations.get(input.record.operation.operationId) !== null
    ) {
      throw new Error("browser custody operation insertion CAS is stale");
    }
    const record = decodeDurableCustodyRecord(input.record);
    this.operations.set(record.operation.operationId, record);
    this.changedOperationIds.add(record.operation.operationId);
  }

  getArtifact(input: Parameters<DurableCustodyTransaction["getArtifact"]>[0]) {
    const row = this.artifacts.get(artifactKey(input.operationId, input.reference.artifactId));
    return row ? stripArtifactRow(row) : null;
  }

  putArtifact(input: Parameters<DurableCustodyTransaction["putArtifact"]>[0]): void {
    const key = artifactKey(input.operationId, input.reference.artifactId);
    const existing = this.artifacts.get(key);
    if (existing) {
      if (input.expectedArtifactRevision !== existing.revision) {
        throw new Error("browser custody artifact CAS is stale");
      }
      assertDurableCustodyArtifactMatchesReference(existing.reference, input.artifact);
      return;
    }
    if (input.expectedArtifactRevision !== null) {
      throw new Error("browser custody artifact CAS is stale");
    }
    assertDurableCustodyArtifactMatchesReference(input.reference, input.artifact);
    const row = decodeArtifactRow({
      scopeId: input.scopeId,
      operationId: input.operationId,
      artifactId: input.reference.artifactId,
      reference: input.reference,
      artifact: input.artifact,
      revision: 0,
    });
    this.artifacts.set(key, row);
    this.changedArtifactKeys.add(key);
  }

  reserveExactInputs(input: Parameters<DurableCustodyTransaction["reserveExactInputs"]>[0]): void {
    const operation = this.#requiredOperation(input.operationId, input.expectedRevision);
    const expected = operation.operation.reservation;
    if (
      expected.reservationId !== input.reservationId ||
      expected.inputs.length !== input.proofIds.length ||
      expected.inputs.some(({ proofId }, index) => proofId !== input.proofIds[index])
    ) {
      throw new Error("browser custody reservation authority is foreign");
    }
    input.proofIds.forEach((proofId, inputPosition) => {
      this.#reserveProof(operation, proofId, inputPosition);
    });
  }

  transitionOperation(
    input: Parameters<DurableCustodyTransaction["transitionOperation"]>[0],
  ): void {
    const current = this.#requiredOperation(input.operationId, input.expectedRevision);
    this.#applyTransition(input.operationId, input.expectedRevision, input.transition);
    if (input.transition.kind === "stage-outbox") {
      this.#stageTransitionArtifact(input.operationId, input.transition.exactPayload, "delivery");
    } else if (input.transition.kind === "release-unspent-reservation") {
      this.#releasePredecessors(current);
    }
  }

  stageVerifiedResult(
    input: Parameters<DurableCustodyTransaction["stageVerifiedResult"]>[0],
  ): void {
    this.#applyTransition(input.operationId, input.expectedRevision, {
      kind: "stage-verified-result",
      authorization: input.authorization,
      expectedRevision: input.expectedRevision,
      outputPlanFingerprint: input.outputPlanFingerprint,
      resultHandle: input.resultHandle,
      resultFingerprint: input.resultFingerprint,
      exactResult: input.exactResult,
      selectedSuccessorProofIds: input.selectedSuccessorProofIds,
    });
    this.#stageTransitionArtifact(input.operationId, input.exactResult, "result");
  }

  applyVerifiedResult(input: ApplyVerifiedResultInput): void {
    const operation = this.#requiredOperation(input.operationId, input.expectedRevision);
    const selected = this.#verifyStagedResult(operation, input);
    this.#admitSuccessors(operation, input, selected);
    this.#applyTransition(input.operationId, input.expectedRevision, {
      kind: "apply-verified-result",
      authorization: input.authorization,
      expectedRevision: input.expectedRevision,
      successorAdmission: input.successorAdmission,
    });
    this.#retirePredecessors(operation);
  }

  #verifyStagedResult(
    operation: DurableCustodyRecord,
    input: ApplyVerifiedResultInput,
  ): readonly string[] {
    const result = operation.operation.result;
    if (
      result.state !== "verified-staged" ||
      result.exactResult === null ||
      result.outputPlanFingerprint !== input.outputPlanFingerprint ||
      result.resultHandle !== input.resultHandle ||
      result.resultFingerprint !== input.resultFingerprint
    ) {
      throw new Error("browser custody staged result authority is foreign");
    }
    const artifact = this.artifacts.get(
      artifactKey(input.operationId, result.exactResult.artifactId),
    );
    if (!artifact) throw new Error("browser custody staged result artifact is absent");
    assertDurableCustodyArtifactMatchesReference(result.exactResult, artifact.artifact);
    const selected = operation.operation.proofStorage.lineage.selectedSuccessorProofIds;
    const successors = this.#successorProofs[input.operationId] ?? [];
    if (
      selected === null ||
      selected.length !== successors.length ||
      selected.length !== input.successorAdmission.proofRows.length
    ) {
      throw new Error("browser custody successor proof admission is incomplete");
    }
    return selected;
  }

  #admitSuccessors(
    operation: DurableCustodyRecord,
    input: ApplyVerifiedResultInput,
    selected: readonly string[],
  ): void {
    const successors = this.#successorProofs[input.operationId] ?? [];
    successors.forEach((candidate, index) => {
      const proof = decodeBrowserCustodyProofRow(candidate.proof);
      const evidence = input.successorAdmission.proofRows[index];
      if (
        proof.proofId !== selected[index] ||
        evidence?.proofId !== proof.proofId ||
        evidence.expectedRevision !== candidate.expectedRevision ||
        evidence.admittedRevision !== proof.revision ||
        proof.scopeId !== operation.scope.scopeId ||
        proof.normalizedMint !== operation.operation.custodyContext.normalizedMint ||
        proof.unit !== operation.operation.custodyContext.unit
      ) {
        throw new Error("browser custody successor proof authority is foreign");
      }
      this.#putProofCas(proof, candidate.expectedRevision);
    });
  }

  rebuildActiveWorkIndex(
    input: Parameters<DurableCustodyTransaction["rebuildActiveWorkIndex"]>[0],
  ): void {
    input.operationRows.forEach(({ operationId }) => this.rebuildOperationIds.add(operationId));
  }

  #reserveProof(operation: DurableCustodyRecord, proofId: string, inputPosition: number): void {
    const existingReservation = this.reservations.get(proofId);
    const proof = this.proofs.get(proofId);
    if (!proof) throw new Error("browser custody reserved proof is absent");
    if (
      proof.scopeId !== operation.scope.scopeId ||
      proof.normalizedMint !== operation.operation.custodyContext.normalizedMint ||
      proof.unit !== operation.operation.custodyContext.unit
    ) {
      throw new Error("browser custody reserved proof asset is foreign");
    }
    if (existingReservation) {
      if (
        existingReservation.operationId !== operation.operation.operationId ||
        existingReservation.reservationId !== operation.operation.reservation.reservationId ||
        existingReservation.inputPosition !== inputPosition ||
        proof.selectability !== "locked" ||
        proof.reservationOperationId !== operation.operation.operationId
      ) {
        throw new Error("browser custody proof reservation replay is foreign");
      }
      return;
    }
    if (proof.selectability !== "selectable" || proof.reservationOperationId !== null) {
      throw new Error("browser custody proof reservation CAS lost");
    }
    const next = decodeBrowserCustodyProofRow({
      ...proof,
      revision: incrementRevision(proof.revision, "proof"),
      selectability: "locked",
      reservationOperationId: operation.operation.operationId,
    });
    const reservation = decodeReservationRow({
      scopeId: operation.scope.scopeId,
      proofId,
      operationId: operation.operation.operationId,
      reservationId: operation.operation.reservation.reservationId,
      inputPosition,
    });
    this.proofs.set(proofId, next);
    this.reservations.set(proofId, reservation);
    this.changedProofIds.add(proofId);
    this.changedReservationIds.add(proofId);
    this.deletedReservationIds.delete(proofId);
  }

  #putProofCas(proof: BrowserCustodyProofRow, expectedRevision: number | null): void {
    const existing = this.proofs.get(proof.proofId);
    if (existing === undefined) {
      if (expectedRevision !== null || proof.revision !== 0) {
        throw new Error("browser custody successor proof CAS is stale");
      }
    } else {
      if (
        expectedRevision !== existing.revision ||
        proof.revision !== expectedRevision ||
        !sameProofRow(existing, proof)
      ) {
        throw new Error("browser custody successor proof CAS is stale");
      }
    }
    this.proofs.set(proof.proofId, proof);
    this.changedProofIds.add(proof.proofId);
  }

  #retirePredecessors(operation: DurableCustodyRecord): void {
    for (const { proofId } of operation.operation.reservation.inputs) {
      const proof = this.proofs.get(proofId);
      if (
        !proof ||
        proof.selectability !== "locked" ||
        proof.reservationOperationId !== operation.operation.operationId
      ) {
        throw new Error("browser custody predecessor proof CAS lost");
      }
      this.proofs.set(
        proofId,
        decodeBrowserCustodyProofRow({
          ...proof,
          revision: incrementRevision(proof.revision, "proof"),
          selectability: "spent",
          reservationOperationId: null,
        }),
      );
      this.reservations.delete(proofId);
      this.changedProofIds.add(proofId);
      this.changedReservationIds.delete(proofId);
      this.deletedReservationIds.add(proofId);
    }
  }

  #releasePredecessors(operation: DurableCustodyRecord): void {
    for (const { proofId } of operation.operation.reservation.inputs) {
      const proof = this.proofs.get(proofId);
      if (
        !proof ||
        proof.selectability !== "locked" ||
        proof.reservationOperationId !== operation.operation.operationId
      ) {
        throw new Error("browser custody predecessor proof release CAS lost");
      }
      this.proofs.set(
        proofId,
        decodeBrowserCustodyProofRow({
          ...proof,
          revision: incrementRevision(proof.revision, "proof"),
          selectability: "selectable",
          reservationOperationId: null,
        }),
      );
      this.reservations.delete(proofId);
      this.changedProofIds.add(proofId);
      this.changedReservationIds.delete(proofId);
      this.deletedReservationIds.add(proofId);
    }
  }

  #applyTransition(
    operationId: string,
    expectedRevision: number,
    transition: DurableCustodyTransition,
  ): void {
    const current = this.#requiredOperation(operationId, expectedRevision);
    const next = reduceDurableCustodyState(
      { scopeState: this.scopeState, operation: current },
      transition,
    ).operation;
    this.operations.set(operationId, next);
    this.changedOperationIds.add(operationId);
    this.rebuildOperationIds.add(operationId);
  }

  #stageTransitionArtifact(
    operationId: string,
    artifact: Parameters<DurableCustodyTransaction["putArtifact"]>[0]["artifact"],
    kind: "result" | "delivery",
  ): void {
    const reference = createDurableCustodyArtifactReference(
      `artifact:${operationId}:${kind}`,
      artifact,
    );
    const key = artifactKey(operationId, reference.artifactId);
    const existing = this.artifacts.get(key);
    if (existing) {
      assertDurableCustodyArtifactMatchesReference(existing.reference, artifact);
      return;
    }
    const row = decodeArtifactRow({
      scopeId: this.scopeState.scope.scopeId,
      operationId,
      artifactId: reference.artifactId,
      reference,
      artifact,
      revision: 0,
    });
    this.artifacts.set(key, row);
    this.changedArtifactKeys.add(key);
  }

  #requiredOperation(operationId: string, revision: number): DurableCustodyRecord {
    const operation = this.operations.get(operationId);
    if (!operation || operation.revision !== revision) {
      throw new Error("browser custody operation revision CAS is stale");
    }
    return operation;
  }
}

function collectTransactionProofs(
  operations: ReadonlyMap<string, DurableCustodyRecord | null>,
  options: BrowserCustodyTransactionOptions,
): {
  predecessorCandidates: BrowserCustodyProofRow[];
  successorCandidates: BrowserCustodyProofRow[];
} {
  const predecessorCandidates: BrowserCustodyProofRow[] = [];
  const successorCandidates: BrowserCustodyProofRow[] = [];
  let totalRows = 0;
  for (const operationId in options.predecessorProofs ?? {}) {
    if (!Object.hasOwn(options.predecessorProofs ?? {}, operationId)) continue;
    const rows = options.predecessorProofs?.[operationId];
    validateProofOptionRows(operationId, rows, operations, DURABLE_CUSTODY_INPUT_PROOF_LIMIT_MAX);
    totalRows = addProofOptionRows(totalRows, rows!.length);
    for (const row of rows!) predecessorCandidates.push(decodeBrowserCustodyProofRow(row));
  }
  for (const operationId in options.successorProofs ?? {}) {
    if (!Object.hasOwn(options.successorProofs ?? {}, operationId)) continue;
    const rows = options.successorProofs?.[operationId];
    validateProofOptionRows(operationId, rows, operations, DURABLE_CUSTODY_RESULT_PROOF_LIMIT_MAX);
    totalRows = addProofOptionRows(totalRows, rows!.length);
    for (const row of rows!) {
      if (
        row.expectedRevision !== null &&
        (!Number.isSafeInteger(row.expectedRevision) || row.expectedRevision < 0)
      ) {
        throw new Error("browser custody proof option revision is invalid");
      }
      successorCandidates.push(decodeBrowserCustodyProofRow(row.proof));
    }
  }
  return { predecessorCandidates, successorCandidates };
}

function validateProofOptionRows(
  operationId: string,
  rows: readonly unknown[] | undefined,
  operations: ReadonlyMap<string, DurableCustodyRecord | null>,
  limit: number,
): void {
  if (!operations.has(operationId)) {
    throw new Error("browser custody proof option operation is not selected");
  }
  if (!Array.isArray(rows) || rows.length > limit) {
    throw new Error("browser custody proof option row limit is exceeded");
  }
}

function addProofOptionRows(current: number, added: number): number {
  const next = current + added;
  if (next > TRANSACTION_PROOF_ROW_LIMIT_MAX) {
    throw new Error("browser custody transaction proof row limit is exceeded");
  }
  return next;
}

function fitRecoveryPage(
  entriesValue: readonly {
    active: BrowserCustodyActiveWorkRow;
    record: DurableCustodyRecord;
  }[],
  hasAdditionalRows: boolean,
): { records: DurableCustodyRecord[]; nextCursor: string | null } {
  if (entriesValue.length === 0) return { records: [], nextCursor: null };
  let low = 1;
  let high = entriesValue.length;
  let best: { records: DurableCustodyRecord[]; nextCursor: string | null } | null = null;
  while (low <= high) {
    const count = Math.floor((low + high) / 2);
    const page = recoveryPageCandidate(entriesValue, count, hasAdditionalRows);
    try {
      encodeBoundedDurableArtifact(page, DURABLE_CUSTODY_RECOVERY_PAGE_BYTES_MAX);
      best = page;
      low = count + 1;
    } catch {
      high = count - 1;
    }
  }
  if (best === null) {
    throw new Error("browser custody recovery record exceeds the page byte limit");
  }
  return best;
}

function recoveryPageCandidate(
  entries: readonly {
    active: BrowserCustodyActiveWorkRow;
    record: DurableCustodyRecord;
  }[],
  count: number,
  hasAdditionalRows: boolean,
): { records: DurableCustodyRecord[]; nextCursor: string | null } {
  const selected = entries.slice(0, count);
  const last = selected.at(-1)!;
  return {
    records: selected.map(({ record }) => record),
    nextCursor:
      hasAdditionalRows || count < entries.length
        ? encodeRecoveryCursor({
            nextAttemptAtMs: last.active.nextAttemptAtMs,
            operationId: last.active.operationId,
          })
        : null,
  };
}

function initialScopeState(
  scope: DurableCustodyScope,
  observedAtMs: number,
): DurableCustodyScopeState {
  return decodeDurableCustodyScopeState({
    schemaVersion: 1,
    scope,
    fencingEpoch: 0,
    owner: null,
    effectiveClock: { highWaterMarkMs: requireTime(observedAtMs, "scope creation time") },
  });
}

function operationRow(recordValue: DurableCustodyRecord): BrowserCustodyOperationRow {
  const record = decodeDurableCustodyRecord(recordValue);
  return decodeOperationRow({
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    revision: record.revision,
    operationState: record.operation.state,
    nextAttemptAtMs: record.operation.retry.nextAttemptAtMs,
    estimatedBytes: operationBytes(record),
    record,
  });
}

function decodeOperationRow(value: unknown): BrowserCustodyOperationRow {
  const row = exactRecord(value, [
    "scopeId",
    "operationId",
    "revision",
    "operationState",
    "nextAttemptAtMs",
    "estimatedBytes",
    "record",
  ]);
  const record = decodeDurableCustodyRecord(row.record);
  const nextAttemptAtMs =
    row.nextAttemptAtMs === null ? null : requireTime(row.nextAttemptAtMs, "operation retry time");
  if (
    row.scopeId !== record.scope.scopeId ||
    row.operationId !== record.operation.operationId ||
    row.revision !== record.revision ||
    row.operationState !== record.operation.state ||
    nextAttemptAtMs !== record.operation.retry.nextAttemptAtMs ||
    row.estimatedBytes !== operationBytes(record)
  ) {
    throw new Error("browser custody operation row authority is foreign");
  }
  return {
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    revision: record.revision,
    operationState: record.operation.state,
    nextAttemptAtMs,
    estimatedBytes: operationBytes(record),
    record,
  };
}

function decodeArtifactRow(value: unknown): BrowserCustodyArtifactRow {
  const row = exactRecord(value, [
    "scopeId",
    "operationId",
    "artifactId",
    "reference",
    "artifact",
    "revision",
  ]);
  const scopeId = decodeDurableCustodyScopeId(row.scopeId);
  const operationId = requiredText(row.operationId, "artifact operation");
  const artifactId = requiredText(row.artifactId, "artifact id");
  const reference = row.reference as BrowserCustodyArtifactRow["reference"];
  const artifact = row.artifact as BrowserCustodyArtifactRow["artifact"];
  assertDurableCustodyArtifactMatchesReference(reference, artifact);
  if (reference.artifactId !== artifactId) {
    throw new Error("browser custody artifact identity is foreign");
  }
  return {
    scopeId,
    operationId,
    artifactId,
    reference: { ...reference },
    artifact: structuredClone(artifact),
    revision: nonnegativeSafeInteger(row.revision, "artifact revision"),
  };
}

function stripArtifactRow(row: BrowserCustodyArtifactRow): DurableCustodyArtifactRow {
  const decoded = decodeArtifactRow(row);
  return {
    reference: decoded.reference,
    artifact: decoded.artifact,
    revision: decoded.revision,
  };
}

function decodeScopeRow(value: unknown): BrowserCustodyScopeRow {
  const row = exactRecord(value, ["scopeId", "state"]);
  const state = decodeDurableCustodyScopeState(row.state);
  if (row.scopeId !== state.scope.scopeId) {
    throw new Error("browser custody scope row authority is foreign");
  }
  return { scopeId: state.scope.scopeId, state };
}

function decodeReservationRow(value: unknown): BrowserCustodyReservationRow {
  const row = exactRecord(value, [
    "scopeId",
    "proofId",
    "operationId",
    "reservationId",
    "inputPosition",
  ]);
  return {
    scopeId: decodeDurableCustodyScopeId(row.scopeId),
    proofId: requiredText(row.proofId, "reservation proof"),
    operationId: requiredText(row.operationId, "reservation operation"),
    reservationId: requiredText(row.reservationId, "reservation id"),
    inputPosition: nonnegativeSafeInteger(row.inputPosition, "reservation input position"),
  };
}

function decodeActiveWorkRow(value: unknown): BrowserCustodyActiveWorkRow {
  const row = exactRecord(value, ["scopeId", "operationId", "nextAttemptAtMs", "estimatedBytes"]);
  const estimatedBytes = positiveSafeInteger(row.estimatedBytes, "active work bytes");
  if (estimatedBytes > ROW_TEXT_BYTES_MAX) {
    throw new Error("browser custody active work byte estimate is invalid");
  }
  return {
    scopeId: decodeDurableCustodyScopeId(row.scopeId),
    operationId: requiredText(row.operationId, "active work operation"),
    nextAttemptAtMs: requireTime(row.nextAttemptAtMs, "active work retry time"),
    estimatedBytes,
  };
}

function normalizeProofAsset(
  value: BrowserCustodyProofAsset,
  unit: BrowserCustodyProofUnit,
): Pick<BrowserCustodyProofRow, "assetKind" | "conditionId" | "outcomeCollection"> {
  switch (value.kind) {
    case "regular":
      if (value.conditionId !== undefined || value.outcomeCollection !== undefined) {
        throw new Error("regular browser custody proof has conditional metadata");
      }
      return { assetKind: "regular", conditionId: null, outcomeCollection: null };
    case "conditional":
      if (unit !== "msat") throw new Error("conditional browser custody proof requires msat");
      return {
        assetKind: "conditional",
        conditionId: requiredText(value.conditionId, "condition"),
        outcomeCollection: requiredText(value.outcomeCollection, "outcome collection"),
      };
    default:
      return assertNever(value);
  }
}

function decodeProofAsset(
  row: Record<string, unknown>,
  unit: BrowserCustodyProofUnit,
): Pick<BrowserCustodyProofRow, "assetKind" | "conditionId" | "outcomeCollection"> {
  const kind = closedValue(row.assetKind, ["regular", "conditional"], "proof asset kind");
  switch (kind) {
    case "regular":
      if (row.conditionId !== null || row.outcomeCollection !== null) {
        throw new Error("regular browser custody proof has conditional metadata");
      }
      return normalizeProofAsset({ kind }, unit);
    case "conditional":
      return normalizeProofAsset(
        {
          kind,
          conditionId: requiredText(row.conditionId, "condition"),
          outcomeCollection: requiredText(row.outcomeCollection, "outcome collection"),
        },
        unit,
      );
    default:
      return assertNever(kind);
  }
}

function assertSameProofAuthority(
  existingValue: BrowserCustodyProofRow,
  expectedValue: BrowserCustodyProofRow,
): void {
  const existing = decodeBrowserCustodyProofRow(existingValue);
  const expected = decodeBrowserCustodyProofRow(expectedValue);
  if (
    existing.scopeId !== expected.scopeId ||
    existing.proofId !== expected.proofId ||
    existing.proofFingerprint !== expected.proofFingerprint ||
    existing.normalizedMint !== expected.normalizedMint ||
    existing.unit !== expected.unit ||
    existing.assetKind !== expected.assetKind ||
    existing.conditionId !== expected.conditionId ||
    existing.outcomeCollection !== expected.outcomeCollection
  ) {
    throw new Error("browser custody proof conflicts with persisted authority");
  }
}

function sameProofRow(
  leftValue: BrowserCustodyProofRow,
  rightValue: BrowserCustodyProofRow,
): boolean {
  const left = decodeBrowserCustodyProofRow(leftValue);
  const right = decodeBrowserCustodyProofRow(rightValue);
  return (
    left.scopeId === right.scopeId &&
    left.normalizedMint === right.normalizedMint &&
    left.unit === right.unit &&
    left.assetKind === right.assetKind &&
    left.conditionId === right.conditionId &&
    left.outcomeCollection === right.outcomeCollection &&
    left.baseAsset === right.baseAsset &&
    left.proofId === right.proofId &&
    left.keysetId === right.keysetId &&
    left.amount === right.amount &&
    sameBytes(left.proofBody, right.proofBody) &&
    left.proofFingerprint === right.proofFingerprint &&
    left.curve === right.curve &&
    left.dleqPresence === right.dleqPresence &&
    left.revision === right.revision &&
    left.selectability === right.selectability &&
    left.reservationOperationId === right.reservationOperationId &&
    left.receivedAtMs === right.receivedAtMs
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function assertReservationState(
  selectability: BrowserCustodyProofSelectability,
  reservationOperationId: string | null,
): void {
  if (
    (selectability === "locked" && reservationOperationId === null) ||
    (selectability !== "locked" && reservationOperationId !== null)
  ) {
    throw new Error("browser custody proof reservation state is invalid");
  }
}

function sameScope(left: DurableCustodyScope, right: DurableCustodyScope): boolean {
  if (left.scopeKind !== right.scopeKind || left.scopeId !== right.scopeId) return false;
  switch (left.scopeKind) {
    case "wallet":
      return right.scopeKind === "wallet" && left.walletId === right.walletId;
    case "condition-inventory":
      return (
        right.scopeKind === "condition-inventory" &&
        left.conditionId === right.conditionId &&
        left.inventoryAccountId === right.inventoryAccountId &&
        left.normalizedMint === right.normalizedMint &&
        left.unit === right.unit
      );
    default:
      return assertNever(left);
  }
}

function sameArtifactReference(
  left: BrowserCustodyArtifactRow["reference"],
  right: BrowserCustodyArtifactRow["reference"],
): boolean {
  return (
    left.artifactId === right.artifactId &&
    left.encoding === right.encoding &&
    left.fingerprint === right.fingerprint &&
    left.byteLength === right.byteLength
  );
}

function operationBytes(record: DurableCustodyRecord): number {
  return encodeBoundedDurableArtifact(record, DURABLE_CUSTODY_RECORD_BYTES_MAX).byteLength;
}

function artifactKey(operationId: string, artifactId: string): string {
  return `${operationId}\u0000${artifactId}`;
}

function incrementRevision(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER) {
    throw new Error(`browser custody ${label} revision is exhausted`);
  }
  return value + 1;
}

function recoveryLimit(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > DURABLE_CUSTODY_RECOVERY_PAGE_LIMIT_MAX
  ) {
    throw new Error("browser custody recovery page limit is invalid");
  }
  return value;
}

function encodeRecoveryCursor(value: { nextAttemptAtMs: number; operationId: string }): string {
  return `${requireTime(value.nextAttemptAtMs, "cursor time")}:${encodeURIComponent(
    requiredText(value.operationId, "cursor operation"),
  )}`;
}

function decodeRecoveryCursor(
  value: string | null,
): { nextAttemptAtMs: number; operationId: string } | null {
  if (value === null) return null;
  const separator = value.indexOf(":");
  if (separator < 1) throw new Error("browser custody recovery cursor is invalid");
  const time = Number(value.slice(0, separator));
  let operationId: string;
  try {
    operationId = decodeURIComponent(value.slice(separator + 1));
  } catch {
    throw new Error("browser custody recovery cursor is invalid");
  }
  const decoded = {
    nextAttemptAtMs: requireTime(time, "cursor time"),
    operationId: requiredText(operationId, "cursor operation"),
  };
  if (encodeRecoveryCursor(decoded) !== value) {
    throw new Error("browser custody recovery cursor is not canonical");
  }
  return decoded;
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("browser custody database row is invalid");
  }
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join("\u0000") !== [...fields].sort().join("\u0000")) {
    throw new Error("browser custody database row fields are invalid");
  }
  return row;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > ROW_TEXT_BYTES_MAX) {
    throw new Error(`browser custody ${label} is invalid`);
  }
  return value;
}

function requireBytes(value: unknown, label: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1) {
    throw new Error(`browser custody ${label} is invalid`);
  }
  return value;
}

function requireTime(value: unknown, label: string): number {
  return nonnegativeSafeInteger(value, label);
}

function positiveSafeInteger(value: unknown, label: string): number {
  const number = nonnegativeSafeInteger(value, label);
  if (number < 1) throw new Error(`browser custody ${label} is invalid`);
  return number;
}

function nonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`browser custody ${label} is invalid`);
  }
  return value;
}

function closedValue<const T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`browser custody ${label} is invalid`);
  }
  return value as T;
}

function assertNever(value: never): never {
  throw new Error(`unexpected browser custody value: ${String(value)}`);
}
