import {
  applyDurableCustodyTransaction,
  decodeDurableCustodyRecord,
  decodeDurableCustodyScopeState,
  isDurableCustodyProofReservationActive,
  reduceDurableCustodyState,
  type DurableCustodyOperationTransition,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
  type DurableCustodyScopeState,
  type DurableCustodyTransaction,
  type DurableCustodyTransactionWork,
} from "@bitcaster/client-sdk/durableCustody";
import {
  classifyDurableBearerSpendCustodyHandoffPlan,
  type DurableBearerSpendCustodyHandoffPlan,
} from "@bitcaster/client-sdk/durableBearerSpendDelivery";
import {
  activeMarker,
  sameValue,
  type ActiveMarker,
  type CustodySnapshot,
  type DexieCustodyOperationRow,
  type DexieCustodyProofReservationRow,
  type DexieCustodySessionLinkRow,
  type TradeBinding,
} from "./durable-custody-dexie-model";

interface PutDeliveryInput {
  operationId: string;
  deliveryKind: "cipher" | "settlement" | "wallet-send";
  payloadHandle: string;
  payloadFingerprint: string;
  expiresAtMs: number | null;
  state: "pending" | "acknowledged" | "expired";
}

/** Prepared outside the write transaction and committed with exact snapshot CAS. */
export class DexieDurableCustodyPlan<T> {
  readonly transaction: PlannedCustodyTransaction;
  readonly result: T;

  constructor(
    readonly snapshot: CustodySnapshot,
    owner: DurableCustodyOwnerAuthorization,
    operationIds: readonly string[],
    apply: DurableCustodyTransactionWork<T>,
  ) {
    this.transaction = new PlannedCustodyTransaction(
      snapshot,
      owner,
      operationIds,
    );
    this.result = applyDurableCustodyTransaction(this.transaction, apply);
    this.transaction.assertIntegrity();
  }
}

export class PlannedCustodyTransaction implements DurableCustodyTransaction {
  private state: DurableCustodyScopeState;
  private readonly scope: DurableCustodyScope;
  private readonly owner: DurableCustodyOwnerAuthorization;
  private readonly selected: ReadonlySet<string>;
  private readonly operations = new Map<string, DurableCustodyRecord | null>();
  private readonly links = new Map<string, DexieCustodySessionLinkRow | null>();
  private readonly reservations = new Map<
    string,
    DexieCustodyProofReservationRow[]
  >();
  private readonly active = new Map<string, ActiveMarker | null>();
  private readonly touched = new Set<string>();

  constructor(
    snapshot: CustodySnapshot,
    owner: DurableCustodyOwnerAuthorization,
    operationIds: readonly string[],
  ) {
    this.scope = snapshot.scope;
    this.owner = owner;
    this.selected = new Set(operationIds);
    this.state = authorizeScopeOwner(snapshot.stateRow.state, owner);
    for (const operationId of operationIds) {
      const operationRow = snapshot.operationRows.get(operationId);
      this.operations.set(operationId, operationRow?.record ?? null);
      this.links.set(operationId, snapshot.linkRows.get(operationId) ?? null);
      this.reservations.set(
        operationId,
        structuredClone(
          snapshot.reservationsByOperation.get(operationId) ?? [],
        ),
      );
      this.active.set(operationId, operationRow?.active ?? null);
    }
  }

  getScopeState(): DurableCustodyScopeState {
    return structuredClone(this.state);
  }

  putScopeState(value: DurableCustodyScopeState): void {
    const next = decodeDurableCustodyScopeState(value, this.scope);
    if (next.fencingEpoch !== this.state.fencingEpoch) {
      throw new Error("custody fencing epoch changes require claimScope");
    }
    if (!sameOwner(this.state.owner, next.owner)) {
      throw new Error("custody owner changes require claimScope");
    }
    if (
      next.effectiveClock.highWaterMarkMs <
      this.state.effectiveClock.highWaterMarkMs
    ) {
      throw new Error("custody effective clock moves backwards");
    }
    this.state = next;
  }

  getOperation(operationId: string): DurableCustodyRecord | null {
    this.assertSelected(operationId);
    return cloneOrNull(this.operations.get(operationId) ?? null);
  }

  putOperation(value: DurableCustodyRecord): void {
    const record = decodeDurableCustodyRecord(value, this.scope);
    const operationId = record.operation.operationId;
    this.assertSelected(operationId);
    const existing = this.operations.get(operationId) ?? null;
    if (existing) {
      if (sameValue(existing, record)) return;
      throw new Error(
        "existing custody operations must advance through an SDK reducer transition",
      );
    }
    assertInitialOperation(record);
    this.operations.set(operationId, record);
    this.touched.add(operationId);
  }

  getSessionLink(sessionId: string, operationId: string): TradeBinding | null {
    this.assertSelected(operationId);
    const row = this.links.get(operationId) ?? null;
    if (!row) return null;
    if (row.sessionId !== sessionId) {
      throw new Error("custody session link is foreign");
    }
    this.assertLinkMatchesOperation(row);
    return structuredClone(row.binding);
  }

  putSessionLink(operationId: string, link: TradeBinding): void {
    const record = this.requireOperation(operationId);
    if (
      record.operation.binding.kind !== "trade" ||
      !sameValue(record.operation.binding, link)
    ) {
      throw new Error("custody session link is foreign");
    }
    const next = linkRow(this.scope, operationId, link);
    const existing = this.links.get(operationId) ?? null;
    if (existing && !sameValue(existing, next)) {
      throw new Error(
        "custody session link is already owned by another operation",
      );
    }
    this.links.set(operationId, next);
    this.touched.add(operationId);
  }

  reserveExactInputs(input: {
    operationId: string;
    reservationId: string;
    proofIds: readonly string[];
  }): void {
    const record = this.requireOperation(input.operationId);
    if (!isDurableCustodyProofReservationActive(record)) {
      throw new Error("terminal custody operation cannot reserve proofs");
    }
    const expected = record.operation.reservation;
    const expectedProofIds = expected.inputs.map(({ proofId }) => proofId);
    if (
      expected.reservationId !== input.reservationId ||
      !sameValue(expectedProofIds, input.proofIds) ||
      new Set(input.proofIds).size !== input.proofIds.length
    ) {
      throw new Error("custody reservation inputs are not exact");
    }
    const rows = reservationRows(record);
    const existing = this.reservations.get(input.operationId) ?? [];
    if (existing.length > 0 && !sameValue(existing, rows)) {
      throw new Error("custody reservation is incomplete or foreign");
    }
    this.reservations.set(input.operationId, rows);
    this.touched.add(input.operationId);
  }

  transitionOperation(input: {
    operationId: string;
    transition: DurableCustodyOperationTransition;
  }): void {
    this.reduceOperation(input.operationId, {
      ...input.transition,
      ...this.owner,
    });
  }

  stageVerifiedResult(input: {
    operationId: string;
    outputPlanFingerprint: string;
    resultHandle: string;
    resultFingerprint: string;
  }): void {
    this.transitionOperation({
      operationId: input.operationId,
      transition: { kind: "verified-result-staged", ...input },
    });
  }

  applyVerifiedResult(input: {
    operationId: string;
    outputPlanFingerprint: string;
    resultHandle: string;
    resultFingerprint: string;
  }): void {
    const record = this.requireOperation(input.operationId);
    const result = record.operation.result;
    if (
      result.state !== "verified-staged" ||
      result.outputPlanFingerprint !== input.outputPlanFingerprint ||
      result.resultHandle !== input.resultHandle ||
      result.resultFingerprint !== input.resultFingerprint
    ) {
      throw new Error("verified result is foreign or not staged");
    }
    this.transitionOperation({
      operationId: input.operationId,
      transition: {
        kind: "reconciled",
        recoverySource:
          record.operation.state === "transport-attempted"
            ? "transport-attempted"
            : "verified-result-staged",
      },
    });
  }

  putDelivery(input: PutDeliveryInput): void {
    const validWalletSend =
      input.deliveryKind === "wallet-send" &&
      input.expiresAtMs === null &&
      input.state !== "expired";
    const validExpiringDelivery =
      input.deliveryKind !== "wallet-send" && input.expiresAtMs !== null;
    if (!validWalletSend && !validExpiringDelivery) {
      throw new Error("non-expiring outbox delivery policy is invalid");
    }
    const current = this.requireOperation(input.operationId);
    const deliveryId = `delivery:${input.operationId}:${input.deliveryKind}`;
    if (current.operation.delivery.deliveryKind === "none") {
      this.beginPendingDelivery(current, input, deliveryId);
      return;
    }
    assertSameDelivery(current, input, deliveryId);
    if (input.state === "pending") {
      if (current.operation.delivery.state !== "pending") {
        throw new Error("outbox delivery cannot return to pending");
      }
      return;
    }
    if (input.deliveryKind === "wallet-send") {
      throw new Error(
        "wallet-send delivery requires a closed terminal decision",
      );
    }
    this.transitionOperation({
      operationId: input.operationId,
      transition: { kind: "delivery-resolved", deliveryState: input.state },
    });
  }

  rebuildActiveWorkIndex(): void {
    for (const operationId of this.touched) {
      this.active.set(
        operationId,
        activeMarker(this.requireOperation(operationId)),
      );
    }
  }

  assertIntegrity(): void {
    for (const operationId of this.touched) {
      const operation = this.requireOperation(operationId);
      this.assertOperationRelations(operation);
      if (this.active.get(operationId) !== activeMarker(operation)) {
        throw new Error("custody active-work index is missing or stale");
      }
    }
  }

  adoptBearerSpendCustodyHandoff(
    plan: DurableBearerSpendCustodyHandoffPlan,
  ): void {
    const operationId = plan.custodyState.operation.operation.operationId;
    const previousCustodyState = {
      scopeState: this.getScopeState(),
      operation: this.requireOperation(operationId),
    };
    classifyDurableBearerSpendCustodyHandoffPlan({
      previousCustodyState,
      plan,
    });
    this.state = decodeDurableCustodyScopeState(
      plan.custodyState.scopeState,
      this.scope,
    );
    this.operations.set(
      operationId,
      decodeDurableCustodyRecord(plan.custodyState.operation, this.scope),
    );
    this.touched.add(operationId);
    this.rebuildActiveWorkIndex();
    this.assertIntegrity();
  }

  scopeState(): DurableCustodyScopeState {
    return structuredClone(this.state);
  }

  operationRows(): DexieCustodyOperationRow[] {
    return [...this.touched].map((operationId) => ({
      operationId,
      scopeId: this.scope.scopeId,
      active: this.active.get(operationId)!,
      bindingKind: this.requireOperation(operationId).operation.binding.kind,
      record: this.requireOperation(operationId),
    }));
  }

  linkRows(): DexieCustodySessionLinkRow[] {
    return [...this.touched].flatMap((operationId) => {
      const row = this.links.get(operationId) ?? null;
      return row ? [structuredClone(row)] : [];
    });
  }

  reservationRows(): DexieCustodyProofReservationRow[] {
    return [...this.touched].flatMap((operationId) =>
      structuredClone(this.reservations.get(operationId) ?? []),
    );
  }

  reservationOperationIds(): string[] {
    return [...this.touched];
  }

  private beginPendingDelivery(
    current: DurableCustodyRecord,
    input: PutDeliveryInput,
    deliveryId: string,
  ): void {
    if (input.state !== "pending") {
      throw new Error("outbox delivery must begin pending");
    }
    const next = structuredClone(current);
    next.revision += 1;
    next.operation.delivery = {
      deliveryKind: "outbox",
      deliveryId,
      payloadHandle: input.payloadHandle,
      payloadFingerprint: input.payloadFingerprint,
      expiresAtMs: input.expiresAtMs,
      state: "pending",
    };
    this.updateOperation(next);
  }

  private requireOperation(operationId: string): DurableCustodyRecord {
    const operation = this.getOperation(operationId);
    if (!operation) throw new Error("custody operation is missing");
    return operation;
  }

  private reduceOperation(
    operationId: string,
    transition: Parameters<typeof reduceDurableCustodyState>[1],
  ): void {
    const reduced = reduceDurableCustodyState(
      { scopeState: this.state, operation: this.requireOperation(operationId) },
      transition,
    );
    this.state = reduced.scopeState;
    this.updateOperation(reduced.operation);
  }

  private updateOperation(value: DurableCustodyRecord): void {
    const next = decodeDurableCustodyRecord(value, this.scope);
    const previous = this.requireOperation(next.operation.operationId);
    if (next.revision !== previous.revision + 1) {
      throw new Error("custody operation revision is not monotonic");
    }
    this.operations.set(next.operation.operationId, next);
    if (!isDurableCustodyProofReservationActive(next)) {
      this.reservations.set(next.operation.operationId, []);
    }
    this.touched.add(next.operation.operationId);
  }

  private assertSelected(operationId: string): void {
    if (!this.selected.has(operationId)) {
      throw new Error("custody transaction operation was not selected");
    }
  }

  private assertLinkMatchesOperation(row: DexieCustodySessionLinkRow): void {
    const operation = this.requireOperation(row.operationId);
    if (
      operation.operation.binding.kind !== "trade" ||
      !sameValue(operation.operation.binding, row.binding)
    ) {
      throw new Error("custody session link is foreign");
    }
  }

  private assertOperationRelations(operation: DurableCustodyRecord): void {
    const operationId = operation.operation.operationId;
    const link = this.links.get(operationId) ?? null;
    if (operation.operation.binding.kind === "trade") {
      if (!link) throw new Error("custody operation session link is missing");
      this.assertLinkMatchesOperation(link);
    } else if (link) {
      throw new Error("wallet custody operation has a session link");
    }
    if (
      !sameValue(
        this.reservations.get(operationId) ?? [],
        activeReservationRows(operation),
      )
    ) {
      throw new Error("custody operation reservation is missing or foreign");
    }
  }
}

function linkRow(
  scope: DurableCustodyScope,
  operationId: string,
  binding: TradeBinding,
): DexieCustodySessionLinkRow {
  return {
    operationId,
    scopeId: scope.scopeId,
    sessionId: binding.sessionId,
    binding: structuredClone(binding),
  };
}

function reservationRows(
  record: DurableCustodyRecord,
): DexieCustodyProofReservationRow[] {
  return record.operation.reservation.inputs.map((input, inputPosition) => ({
    proofId: input.proofId,
    scopeId: record.scope.scopeId,
    operationId: record.operation.operationId,
    reservationId: record.operation.reservation.reservationId,
    inputPosition,
    keysetId: input.keysetId,
    curve: input.curve,
  }));
}

function activeReservationRows(
  record: DurableCustodyRecord,
): DexieCustodyProofReservationRow[] {
  return isDurableCustodyProofReservationActive(record)
    ? reservationRows(record)
    : [];
}

function authorizeScopeOwner(
  state: DurableCustodyScopeState,
  owner: DurableCustodyOwnerAuthorization,
): DurableCustodyScopeState {
  if (
    !state.owner ||
    !owner.incarnationId ||
    !Number.isSafeInteger(owner.fencingEpoch) ||
    !Number.isSafeInteger(owner.observedAtMs) ||
    owner.observedAtMs < 0 ||
    state.owner.incarnationId !== owner.incarnationId ||
    state.fencingEpoch !== owner.fencingEpoch
  ) {
    throw new Error("custody owner epoch is foreign");
  }
  const effectiveNowMs = Math.max(
    state.effectiveClock.highWaterMarkMs,
    owner.observedAtMs,
  );
  if (effectiveNowMs >= state.owner.leaseExpiresAtMs) {
    throw new Error("custody owner lease has expired");
  }
  const next = structuredClone(state);
  next.effectiveClock.highWaterMarkMs = effectiveNowMs;
  return next;
}

function assertInitialOperation(record: DurableCustodyRecord): void {
  if (
    record.revision !== 0 ||
    record.operation.state !== "dispatch-intent" ||
    record.operation.result.state !== "none" ||
    record.operation.delivery.deliveryKind !== "none" ||
    record.operation.retry.attempt !== 0 ||
    record.operation.retry.nextAttemptAtMs !== null ||
    record.operation.retry.reason !== "none" ||
    record.terminalTombstone !== null
  ) {
    throw new Error("new custody operation is not a dispatch intent");
  }
}

function assertSameDelivery(
  record: DurableCustodyRecord,
  input: PutDeliveryInput,
  deliveryId: string,
): void {
  const current = record.operation.delivery;
  if (
    current.deliveryId !== deliveryId ||
    current.payloadHandle !== input.payloadHandle ||
    current.payloadFingerprint !== input.payloadFingerprint ||
    current.expiresAtMs !== input.expiresAtMs
  ) {
    throw new Error("outbox delivery is foreign");
  }
}

function sameOwner(
  left: DurableCustodyScopeState["owner"],
  right: DurableCustodyScopeState["owner"],
): boolean {
  return (
    left?.incarnationId === right?.incarnationId &&
    left?.leaseExpiresAtMs === right?.leaseExpiresAtMs
  );
}

function cloneOrNull<T>(value: T | null): T | null {
  return value === null ? null : structuredClone(value);
}
