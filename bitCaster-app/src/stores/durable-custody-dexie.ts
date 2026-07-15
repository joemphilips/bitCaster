import Dexie from "dexie";
import {
  claimDurableCustodyScope,
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeState,
  decodeDurableCustodyTransactionOperationIds,
  releaseDurableCustodyScope,
  renewDurableCustodyScope,
  validateDurableCustodyScopeRegistration,
  type DurableCustodyRecoveryPage,
  type DurableCustodyRecoveryPageInput,
  type DurableCustodyScope,
  type DurableCustodyScopeClaimInput,
  type DurableCustodyScopeLeaseInput,
  type DurableCustodyScopeReleaseInput,
  type DurableCustodyScopeState,
  type DurableCustodyStore,
  type DurableCustodyTransactionInput,
  type DurableCustodyTransactionWork,
} from "@bitcaster/client-sdk/durableCustody";
import {
  activeMarker,
  assertRecoveryPageInput,
  assertScopeRow,
  canonicalScope,
  decodeOperationRow,
  decodeSnapshot,
  initialScopeState,
  marketInventoryKey,
  sameValue,
  scopeRow,
  type CustodySnapshot,
  type DexieCustodyProofReservationRow,
  type DexieCustodyScopeStateRow,
} from "./durable-custody-dexie-model";
import {
  DexieDurableCustodyPlan,
  type PlannedCustodyTransaction,
} from "./durable-custody-transaction-plan";
import type { BitcasterDB } from "./proof-db";

export type {
  DexieCustodyOperationRow,
  DexieCustodyProofReservationRow,
  DexieCustodyScopeRow,
  DexieCustodyScopeStateRow,
  DexieCustodySessionLinkRow,
} from "./durable-custody-dexie-model";
export { DexieDurableCustodyPlan } from "./durable-custody-transaction-plan";

/** IndexedDB implementation of the shared bounded custody transaction port. */
export class DexieDurableCustodyStore implements DurableCustodyStore {
  constructor(private readonly database: BitcasterDB) {}

  async registerScope(
    requested: DurableCustodyScope,
  ): Promise<DurableCustodyScopeState> {
    const scope = canonicalScope(requested);
    return this.database.transaction(
      "rw",
      this.database.custodyScopes,
      this.database.custodyScopeStates,
      async () => this.registerScopeInTransaction(scope),
    );
  }

  async readScope(
    requested: DurableCustodyScope,
  ): Promise<DurableCustodyScopeState | null> {
    const scope = canonicalScope(requested);
    return this.database.transaction(
      "r",
      this.database.custodyScopes,
      this.database.custodyScopeStates,
      async () => {
        const row = await this.database.custodyScopes.get(scope.scopeId);
        if (!row) return null;
        assertScopeRow(row, scope);
        return this.readScopeState(scope);
      },
    );
  }

  async claimScope(
    input: DurableCustodyScopeClaimInput,
  ): Promise<DurableCustodyScopeState> {
    const scope = canonicalScope(input.scope);
    return this.updateScopeState(scope, (previous) =>
      claimDurableCustodyScope(previous, {
        kind: "owner-claimed",
        nextIncarnationId: input.incarnationId,
        nextFencingEpoch: previous.fencingEpoch + 1,
        observedAtMs: input.observedAtMs,
        nextLeaseExpiresAtMs: input.leaseExpiresAtMs,
      }),
    );
  }

  async renewScope(
    input: DurableCustodyScopeLeaseInput,
  ): Promise<DurableCustodyScopeState> {
    const scope = canonicalScope(input.scope);
    return this.updateScopeState(scope, (previous) =>
      renewDurableCustodyScope(previous, {
        kind: "owner-renewed",
        incarnationId: input.incarnationId,
        fencingEpoch: input.fencingEpoch,
        observedAtMs: input.observedAtMs,
        nextLeaseExpiresAtMs: input.leaseExpiresAtMs,
      }),
    );
  }

  async releaseScope(
    input: DurableCustodyScopeReleaseInput,
  ): Promise<DurableCustodyScopeState> {
    const scope = canonicalScope(input.scope);
    return this.updateScopeState(scope, (previous) =>
      releaseDurableCustodyScope(previous, {
        kind: "owner-released",
        incarnationId: input.incarnationId,
        fencingEpoch: input.fencingEpoch,
        observedAtMs: input.observedAtMs,
      }),
    );
  }

  async prepareTransaction<T>(
    input: DurableCustodyTransactionInput,
    apply: DurableCustodyTransactionWork<T>,
  ): Promise<DexieDurableCustodyPlan<T>> {
    const scope = canonicalScope(input.scope);
    const operationIds = decodeDurableCustodyTransactionOperationIds(
      input.operationIds,
    );
    const snapshot = await this.readSnapshot(scope, operationIds);
    return new DexieDurableCustodyPlan(
      snapshot,
      input.owner,
      operationIds,
      apply,
    );
  }

  async transact<T>(
    input: DurableCustodyTransactionInput,
    apply: DurableCustodyTransactionWork<T>,
  ): Promise<T> {
    const plan = await this.prepareTransaction(input, apply);
    return this.commitPreparedTransaction(plan);
  }

  async commitPreparedTransaction<T>(
    plan: DexieDurableCustodyPlan<T>,
  ): Promise<T> {
    return this.database.transaction(
      "rw",
      ...this.transactionTables(),
      async () => this.commitPreparedTransactionInCurrentTransaction(plan),
    );
  }

  async commitPreparedTransactionInCurrentTransaction<T>(
    plan: DexieDurableCustodyPlan<T>,
  ): Promise<T> {
    await this.assertSnapshotCurrent(plan.snapshot);
    await this.assertReservationOwnership(plan);
    await this.writePlan(plan.transaction);
    return plan.result;
  }

  async listRecoverablePage(
    input: DurableCustodyRecoveryPageInput,
  ): Promise<DurableCustodyRecoveryPage> {
    const scope = canonicalScope(input.scope);
    assertRecoveryPageInput(input);
    return this.database.transaction(
      "r",
      this.database.custodyScopes,
      this.database.custodyOperations,
      async () => this.readRecoverablePage(scope, input),
    );
  }

  async rebuildActiveWorkIndex(
    requested: DurableCustodyScope,
  ): Promise<"rebuilt"> {
    const scope = canonicalScope(requested);
    await this.database.transaction(
      "rw",
      this.database.custodyScopes,
      this.database.custodyOperations,
      async () => {
        await this.requireScope(scope);
        await this.database.custodyOperations
          .where("scopeId")
          .equals(scope.scopeId)
          .modify((row) => {
            row.active = activeMarker(
              decodeDurableCustodyRecord(row.record, scope),
            );
          });
      },
    );
    return "rebuilt";
  }

  transactionTables() {
    return [
      this.database.custodyScopes,
      this.database.custodyScopeStates,
      this.database.custodyOperations,
      this.database.custodySessionLinks,
      this.database.custodyProofReservations,
    ] as const;
  }

  private async readRecoverablePage(
    scope: DurableCustodyScope,
    input: DurableCustodyRecoveryPageInput,
  ): Promise<DurableCustodyRecoveryPage> {
    await this.requireScope(scope);
    const lower = [scope.scopeId, 1, input.cursor ?? Dexie.minKey];
    const upper = [scope.scopeId, 1, Dexie.maxKey];
    const rows = await this.database.custodyOperations
      .where("[scopeId+active+operationId]")
      .between(lower, upper, input.cursor === null, true)
      .limit(input.limit + 1)
      .toArray();
    const records = rows
      .slice(0, input.limit)
      .map((row) => decodeOperationRow(row, scope));
    return {
      records,
      nextCursor:
        rows.length > input.limit && records.length > 0
          ? records[records.length - 1]!.operation.operationId
          : null,
    };
  }

  private async registerScopeInTransaction(
    scope: DurableCustodyScope,
  ): Promise<DurableCustodyScopeState> {
    const existing = await this.database.custodyScopes.get(scope.scopeId);
    if (existing) {
      assertScopeRow(existing, scope);
      return this.readScopeState(scope);
    }
    await this.assertNoScopeConflict(scope);
    const state = initialScopeState(scope);
    await this.database.custodyScopes.add(scopeRow(scope));
    await this.database.custodyScopeStates.add({ scopeId: scope.scopeId, state });
    return structuredClone(state);
  }

  private async assertNoScopeConflict(scope: DurableCustodyScope): Promise<void> {
    if (scope.scopeKind === "wallet") return;
    const [sameMarket, sameInventory] = await Promise.all([
      this.database.custodyScopes.where("marketId").equals(scope.marketId).first(),
      this.database.custodyScopes
        .where("inventoryKey")
        .equals(marketInventoryKey(scope))
        .first(),
    ]);
    for (const row of [sameMarket, sameInventory]) {
      if (row) validateDurableCustodyScopeRegistration(row.scope, scope);
    }
  }

  private async updateScopeState(
    scope: DurableCustodyScope,
    reduce: (previous: DurableCustodyScopeState) => DurableCustodyScopeState,
  ): Promise<DurableCustodyScopeState> {
    return this.database.transaction(
      "rw",
      this.database.custodyScopes,
      this.database.custodyScopeStates,
      async () => {
        await this.requireScope(scope);
        const next = reduce(await this.readScopeState(scope));
        await this.database.custodyScopeStates.put({
          scopeId: scope.scopeId,
          state: next,
        });
        return structuredClone(next);
      },
    );
  }

  private async readSnapshot(
    scope: DurableCustodyScope,
    operationIds: readonly string[],
  ): Promise<CustodySnapshot> {
    return this.database.transaction(
      "r",
      ...this.transactionTables(),
      async () => {
        await this.requireScope(scope);
        const [stateRow, operationRows, linkRows, reservations] =
          await Promise.all([
            this.requireScopeStateRow(scope),
            this.database.custodyOperations.bulkGet([...operationIds]),
            this.database.custodySessionLinks.bulkGet([...operationIds]),
            this.readReservations(operationIds),
          ]);
        return decodeSnapshot(
          scope,
          stateRow,
          operationIds,
          operationRows,
          linkRows,
          reservations,
        );
      },
    );
  }

  private async assertSnapshotCurrent(snapshot: CustodySnapshot): Promise<void> {
    await this.requireScope(snapshot.scope);
    const operationIds = [...snapshot.operationRows.keys()];
    const [stateRow, operationRows, linkRows, reservations] = await Promise.all([
      this.requireScopeStateRow(snapshot.scope),
      this.database.custodyOperations.bulkGet(operationIds),
      this.database.custodySessionLinks.bulkGet(operationIds),
      this.readReservations(operationIds),
    ]);
    const current = decodeSnapshot(
      snapshot.scope,
      stateRow,
      operationIds,
      operationRows,
      linkRows,
      reservations,
    );
    if (!sameValue(current, snapshot)) {
      throw new Error("custody transaction snapshot changed before commit");
    }
  }

  private async assertReservationOwnership<T>(
    plan: DexieDurableCustodyPlan<T>,
  ): Promise<void> {
    const requested = plan.transaction.reservationRows();
    const current = await this.database.custodyProofReservations.bulkGet(
      requested.map((row) => row.proofId),
    );
    requested.forEach((row, index) => {
      const owner = current[index];
      if (owner && !sameValue(owner, row)) {
        throw new Error("proof reservation is already owned");
      }
    });
  }

  private async writePlan(
    transaction: PlannedCustodyTransaction,
  ): Promise<void> {
    const state = transaction.scopeState();
    await this.database.custodyScopeStates.put({
      scopeId: state.scope.scopeId,
      state,
    });
    await putIfAny(
      transaction.operationRows(),
      (rows) => this.database.custodyOperations.bulkPut(rows),
    );
    await putIfAny(
      transaction.linkRows(),
      (rows) => this.database.custodySessionLinks.bulkPut(rows),
    );
    for (const operationId of transaction.reservationOperationIds()) {
      await this.database.custodyProofReservations
        .where("operationId")
        .equals(operationId)
        .delete();
    }
    await putIfAny(
      transaction.reservationRows(),
      (rows) => this.database.custodyProofReservations.bulkPut(rows),
    );
  }

  private readReservations(
    operationIds: readonly string[],
  ): Promise<DexieCustodyProofReservationRow[]> {
    if (operationIds.length === 0) return Promise.resolve([]);
    return this.database.custodyProofReservations
      .where("operationId")
      .anyOf([...operationIds])
      .toArray();
  }

  private async requireScope(scope: DurableCustodyScope): Promise<void> {
    const row = await this.database.custodyScopes.get(scope.scopeId);
    if (!row) throw new Error("custody scope is not registered");
    assertScopeRow(row, scope);
  }

  private async readScopeState(
    scope: DurableCustodyScope,
  ): Promise<DurableCustodyScopeState> {
    return (await this.requireScopeStateRow(scope)).state;
  }

  private async requireScopeStateRow(
    scope: DurableCustodyScope,
  ): Promise<DexieCustodyScopeStateRow> {
    const row = await this.database.custodyScopeStates.get(scope.scopeId);
    if (!row || row.scopeId !== scope.scopeId) {
      throw new Error("custody scope state is missing");
    }
    return {
      scopeId: scope.scopeId,
      state: decodeDurableCustodyScopeState(row.state, scope),
    };
  }
}

async function putIfAny<T>(
  rows: readonly T[],
  put: (rows: readonly T[]) => Promise<unknown>,
): Promise<void> {
  if (rows.length > 0) await put(rows);
}
