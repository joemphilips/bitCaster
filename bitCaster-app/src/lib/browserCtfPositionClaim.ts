import type { CounterSource, MintKeys } from "@cashu/cashu-ts";
import {
  deriveDurableCustodyOperationId,
  type DurableCustodyOwnerAuthorization,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import {
  buildKeysetRedeemOperationId,
  type AuthenticatedCtfRedeemTerminalEvidence,
  type RedeemWallet,
  type RestoreOutputGroups,
} from "@bitcaster/client-sdk/ctfRedeem";
import {
  assertDurableCustodyMintOperationAuthority,
  prepareDurableCustodyAuthenticatedTerminalMintRejection,
  reconcileDurableCustodyAuthenticatedTerminalMintRejection,
} from "@bitcaster/client-sdk/durableCustodyMintResult";
import { amountToNumber } from "@bitcaster/client-sdk/proofSelection";
import type { BrowserCtfRedeemLeg } from "./browserCtfRedeemSelection";
import { readBrowserCanonicalCtfRedeemLegs } from "./browserCtfRedeemSelection";
import {
  bindBrowserCanonicalCtfRedeemLeg,
  recoverBrowserCanonicalCtfRedeemOperation,
  type BrowserCanonicalCtfRedeemRecoveryResult,
} from "./browserCtfRedeemCoordinator";
import { browserWalletScope } from "./browserCtfRangeOrderSource";
import type { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import type { BrowserCustodyProofRow } from "../stores/durable-custody-types";
import type { BitcasterDB } from "../stores/proof-db";
import { normalizeUrl } from "./url";
import { withWalletProfileLock } from "./walletProfileLock";

const RECOVERABLE_PAGE_LIMIT = 256;
const ERROR_MESSAGE_LIMIT = 160;

/** The proof identity captured by an exclusion confirmation. */
export interface BrowserCanonicalCtfPositionClaimTarget {
  readonly proofId: string;
  readonly revision: number;
  readonly proofFingerprint: string;
}

export interface BrowserCanonicalCtfPositionClaimContext {
  readonly seed: Uint8Array;
  readonly mintUrl: string;
  readonly prepareNewLegAuthority: () => Promise<BrowserCanonicalCtfPositionClaimPreparation>;
  readonly counterSource: CounterSource;
  readonly database: BitcasterDB;
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly owner: DurableCustodyOwnerAuthorization;
  readonly wallet: RedeemWallet;
  readonly restoreOutputs: (
    mintUrl: string,
    outputs: Parameters<RestoreOutputGroups>[1],
    regularKeyset: MintKeys,
  ) => ReturnType<RestoreOutputGroups>;
  readonly observedAtMs: number;
  readonly lockManager?: Pick<LockManager, "request">;
  /** Refresh is advisory. A refresh failure cannot undo committed custody. */
  readonly onCommittedLeg?: (input: {
    readonly keysetId: string;
    readonly payoutAmount: number;
  }) => void | Promise<void>;
}

export interface BrowserCanonicalCtfPositionClaimPreparation {
  readonly regularKeyset: MintKeys;
  readonly oracleWitness: string;
}

export interface BrowserCanonicalCtfPositionIdentity {
  readonly conditionId: string;
  readonly outcomeCollection: string;
}

export interface BrowserCanonicalCtfPositionClaimInput {
  readonly position: BrowserCanonicalCtfPositionIdentity;
  readonly context: BrowserCanonicalCtfPositionClaimContext;
  /** Claim only these captured proof identities. */
  readonly targets?: readonly BrowserCanonicalCtfPositionClaimTarget[];
  /** Stop after the first committed payout. */
  readonly stopOnCommittedPayout?: boolean;
  /** Caller already owns the profile lock across recovery and mint I/O. */
  readonly walletProfileLockHeld?: boolean;
}

export type BrowserCanonicalCtfPositionClaimResult =
  | BrowserCanonicalCtfPositionClaimCompleted
  | BrowserCanonicalCtfPositionClaimStopped
  | BrowserCanonicalCtfPositionClaimPending
  | BrowserCanonicalCtfPositionClaimError;

interface BrowserCanonicalCtfPositionClaimBase {
  readonly committedPayoutAmount: number;
  readonly committedLegs: number;
  readonly losingLegs: number;
  readonly pendingLegs: number;
}

export interface BrowserCanonicalCtfPositionClaimCompleted extends BrowserCanonicalCtfPositionClaimBase {
  readonly kind: "completed";
  readonly pendingLegs: 0;
  readonly error: null;
}

export interface BrowserCanonicalCtfPositionClaimStopped extends BrowserCanonicalCtfPositionClaimBase {
  readonly kind: "stopped";
  readonly reason: "winning-payout";
  readonly error: null;
}

export interface BrowserCanonicalCtfPositionClaimPending extends BrowserCanonicalCtfPositionClaimBase {
  readonly kind: "pending";
  readonly reason: "mint-response-pending" | "recovery-pending";
  readonly error: null;
}

export interface BrowserCanonicalCtfPositionClaimError extends BrowserCanonicalCtfPositionClaimBase {
  readonly kind: "error";
  readonly error: { readonly code: "claim-failed"; readonly message: string };
}

interface ClaimTotals {
  committedPayoutAmount: number;
  committedLegs: number;
  losingLegs: number;
  pendingLegs: number;
}

interface ExactTargetState {
  readonly targets: Map<string, BrowserCanonicalCtfPositionClaimTarget>;
  readonly rows: Map<string, BrowserCustodyProofRow>;
  readonly covered: Set<string>;
}

const alreadyHeldLockManager: Pick<LockManager, "request"> = {
  request: (async (_name: string, _options: LockOptions, action: LockGrantedCallback<unknown>) =>
    action(null)) as LockManager["request"],
};

/** Claim one canonical CTF asset through independent durable keyset legs. */
export async function claimBrowserCanonicalCtfPosition(
  input: BrowserCanonicalCtfPositionClaimInput,
): Promise<BrowserCanonicalCtfPositionClaimResult> {
  const scope = browserWalletScope(input.context.seed);
  if (input.walletProfileLockHeld) return claimWhileLocked(input, scope);
  return withWalletProfileLock(
    scope.scopeId,
    () => claimWhileLocked(input, scope),
    input.context.lockManager,
  );
}

async function claimWhileLocked(
  input: BrowserCanonicalCtfPositionClaimInput,
  scope: DurableCustodyScope,
): Promise<BrowserCanonicalCtfPositionClaimResult> {
  const context = input.context;
  const normalizedMint = normalizeUrl(context.mintUrl);
  const totals: ClaimTotals = {
    committedPayoutAmount: 0,
    committedLegs: 0,
    losingLegs: 0,
    pendingLegs: 0,
  };
  let pendingReason: BrowserCanonicalCtfPositionClaimPending["reason"] | null = null;
  let failure: string | null = null;
  const processedOperationIds = new Set<string>();
  let newLegAuthority: Promise<BrowserCanonicalCtfPositionClaimPreparation> | null = null;
  const prepareNewLegAuthority = () => {
    newLegAuthority ??= Promise.resolve().then(() => context.prepareNewLegAuthority());
    return newLegAuthority;
  };
  let exact: ExactTargetState | null = null;
  if (input.targets !== undefined) {
    try {
      exact = await readExactTargetState(input, scope, normalizedMint);
    } catch (error) {
      return {
        kind: "error",
        ...totals,
        error: { code: "claim-failed", message: boundedErrorMessage(error) },
      };
    }
  }

  try {
    for await (const record of readMatchingRecoverableOperations({
      identity: input.position,
      scope,
      normalizedMint,
      adapter: context.adapter,
      targetIds: exact?.targets,
      exact,
    })) {
      processedOperationIds.add(record.operation.operationId);
      const operationProofIds = record.operation.reservation.inputs.map(({ proofId }) => proofId);
      try {
        const outcome = await runRecovery(input, scope, record.operation.operationId);
        markTargetOutcome(exact, operationProofIds, outcome);
        await noteRecoveryOutcome({
          context,
          keysetId: record.operation.reservation.inputs[0]?.keysetId ?? "unknown",
          outcome,
        });
        if (
          await mergeLegOutcome({
            totals,
            outcome,
            stopOnCommittedPayout: input.stopOnCommittedPayout === true,
            markPending: (reason) => {
              pendingReason = pendingReason ?? reason;
            },
            markFailure: (message) => {
              failure = failure ?? message;
            },
          })
        ) {
          return stoppedResult(totals);
        }
      } catch (error) {
        if (isPendingError(error)) {
          totals.pendingLegs += 1;
          pendingReason = pendingReason ?? "mint-response-pending";
        } else {
          failure = failure ?? boundedErrorMessage(error);
        }
      }
    }
  } catch (error) {
    if (isPendingError(error)) {
      totals.pendingLegs += 1;
      pendingReason = pendingReason ?? "recovery-pending";
    } else {
      failure = failure ?? boundedErrorMessage(error);
    }
  }

  try {
    const legs = readBrowserCanonicalCtfRedeemLegs({
      scopeId: scope.scopeId,
      mintUrl: normalizedMint,
      conditionId: input.position.conditionId,
      outcomeCollection: input.position.outcomeCollection,
      database: context.database,
    });
    for await (const canonicalLeg of legs) {
      const leg = exact === null ? canonicalLeg : exactLeg(canonicalLeg, exact);
      if (leg === null) continue;
      const operationId = durableOperationIdForLeg(
        scope.scopeId,
        normalizedMint,
        input.position,
        leg,
      );
      if (processedOperationIds.has(operationId)) continue;
      processedOperationIds.add(operationId);
      try {
        const existing = await context.adapter.readOperation(scope, operationId);
        if (existing?.operation.result.state === "applied") {
          markTargetCovered(
            exact,
            leg.rows.map(({ proofId }) => proofId),
          );
          continue;
        }
        if (existing !== null && existing.operation.terminalMintRejection !== null) {
          markTargetCovered(
            exact,
            leg.rows.map(({ proofId }) => proofId),
          );
          totals.losingLegs += 1;
          continue;
        }
        if (existing !== null) {
          requireOperationTargetSubset(existing, exact?.targets);
          requireOperationTargetFingerprints(existing, exact);
        }

        if (existing === null) {
          const preparation = await prepareNewLegAuthority();
          try {
            await bindBrowserCanonicalCtfRedeemLeg({
              seed: context.seed,
              mintUrl: normalizedMint,
              conditionId: input.position.conditionId,
              outcomeCollection: input.position.outcomeCollection,
              oracleWitness: preparation.oracleWitness,
              leg,
              regularKeyset: preparation.regularKeyset,
              counterSource: context.counterSource,
              database: context.database,
              adapter: context.adapter,
              owner: context.owner,
              lockManager: alreadyHeldLockManager,
            });
          } catch (error) {
            if (!isPersistedRecoveryRace(error)) throw error;
          }
        }

        const outcome = await runRecovery(input, scope, operationId);
        markTargetOutcome(
          exact,
          leg.rows.map(({ proofId }) => proofId),
          outcome,
        );
        await noteRecoveryOutcome({ context, keysetId: leg.keyset.keysetId, outcome });
        if (
          await mergeLegOutcome({
            totals,
            outcome,
            stopOnCommittedPayout: input.stopOnCommittedPayout === true,
            markPending: (reason) => {
              pendingReason = pendingReason ?? reason;
            },
            markFailure: (message) => {
              failure = failure ?? message;
            },
          })
        ) {
          return stoppedResult(totals);
        }
      } catch (error) {
        if (isPendingError(error)) {
          totals.pendingLegs += 1;
          pendingReason = pendingReason ?? "mint-response-pending";
        } else {
          failure = failure ?? boundedErrorMessage(error);
        }
      }
    }
  } catch (error) {
    if (isPendingError(error)) {
      totals.pendingLegs += 1;
      pendingReason = pendingReason ?? "recovery-pending";
    } else {
      failure = failure ?? boundedErrorMessage(error);
    }
  }

  if (exact !== null && failure === null && totals.pendingLegs === 0) {
    for (const proofId of exact.targets.keys()) {
      if (!exact.covered.has(proofId) && !isTerminalTarget(exact.rows.get(proofId))) {
        failure = "confirmed CTF proof target is missing or changed";
        break;
      }
    }
  }
  if (failure !== null) {
    return {
      kind: "error",
      ...totals,
      error: { code: "claim-failed", message: failure },
    };
  }
  if (totals.pendingLegs > 0) {
    return {
      kind: "pending",
      ...totals,
      reason: pendingReason ?? "recovery-pending",
      error: null,
    };
  }
  return { kind: "completed", ...totals, pendingLegs: 0, error: null };
}

async function runRecovery(
  input: BrowserCanonicalCtfPositionClaimInput,
  scope: DurableCustodyScope,
  operationId: string,
): Promise<BrowserCanonicalCtfRedeemRecoveryResult> {
  const context = input.context;
  const result = await recoverBrowserCanonicalCtfRedeemOperation({
    seed: context.seed,
    mintUrl: context.mintUrl,
    conditionId: input.position.conditionId,
    outcomeCollection: input.position.outcomeCollection,
    operationId,
    wallet: context.wallet,
    restoreOutputs: context.restoreOutputs,
    adapter: context.adapter,
    owner: context.owner,
    observedAtMs: context.observedAtMs,
  });
  if (result.kind === "losing") {
    await reconcileBrowserCanonicalCtfRedeemTerminal({
      scope,
      operationId,
      evidence: result.evidence,
      context,
    });
  }
  return result;
}

async function noteRecoveryOutcome(input: {
  readonly context: BrowserCanonicalCtfPositionClaimContext;
  readonly keysetId: string;
  readonly outcome: BrowserCanonicalCtfRedeemRecoveryResult;
}): Promise<void> {
  if (input.outcome.kind !== "redeemed" || input.context.onCommittedLeg === undefined) return;
  const payoutAmount = input.outcome.proofs.reduce(
    (sum, proof) => sum + amountToNumber(proof.amount),
    0,
  );
  try {
    await input.context.onCommittedLeg({ keysetId: input.keysetId, payoutAmount });
  } catch {
    // Custody already committed. Refresh is advisory only.
  }
}

async function mergeLegOutcome(input: {
  readonly totals: ClaimTotals;
  readonly outcome: BrowserCanonicalCtfRedeemRecoveryResult;
  readonly stopOnCommittedPayout: boolean;
  readonly markPending: (reason: BrowserCanonicalCtfPositionClaimPending["reason"]) => void;
  readonly markFailure: (message: string) => void;
}): Promise<boolean> {
  switch (input.outcome.kind) {
    case "redeemed":
      input.totals.committedPayoutAmount += input.outcome.proofs.reduce(
        (sum, proof) => sum + amountToNumber(proof.amount),
        0,
      );
      input.totals.committedLegs += 1;
      return input.stopOnCommittedPayout;
    case "already-completed":
      return false;
    case "losing":
    case "already-losing":
      input.totals.losingLegs += 1;
      return false;
    case "pending":
      input.totals.pendingLegs += 1;
      input.markPending("recovery-pending");
      return false;
    default:
      input.markFailure("browser CTF redeem returned an unknown recovery result");
      return false;
  }
}

function stoppedResult(totals: ClaimTotals): BrowserCanonicalCtfPositionClaimStopped {
  return { kind: "stopped", ...totals, reason: "winning-payout", error: null };
}

async function readExactTargetState(
  input: BrowserCanonicalCtfPositionClaimInput,
  scope: DurableCustodyScope,
  normalizedMint: string,
): Promise<ExactTargetState> {
  const targets = new Map<string, BrowserCanonicalCtfPositionClaimTarget>();
  const rows = new Map<string, BrowserCustodyProofRow>();
  for (const target of input.targets ?? []) {
    if (targets.has(target.proofId)) throw new Error("confirmed CTF proof targets are duplicated");
    if (
      !Number.isSafeInteger(target.revision) ||
      target.revision < 0 ||
      target.proofFingerprint.length === 0
    ) {
      throw new Error("confirmed CTF proof target is invalid");
    }
    targets.set(target.proofId, target);
    const row = await input.context.adapter.readProof(scope.scopeId, target.proofId);
    if (row === null) throw new Error("confirmed CTF proof target is missing");
    if (
      row.scopeId !== scope.scopeId ||
      row.normalizedMint !== normalizedMint ||
      row.assetKind !== "conditional" ||
      row.conditionId !== input.position.conditionId ||
      row.outcomeCollection !== input.position.outcomeCollection
    ) {
      throw new Error("confirmed CTF proof target asset authority is foreign");
    }
    if (row.proofFingerprint !== target.proofFingerprint) {
      throw new Error("confirmed CTF proof target body changed");
    }
    rows.set(target.proofId, row);
  }
  return { targets, rows, covered: new Set() };
}

function exactLeg(leg: BrowserCtfRedeemLeg, exact: ExactTargetState): BrowserCtfRedeemLeg | null {
  const targetRows = leg.rows.filter(({ proofId }) => exact.targets.has(proofId));
  if (targetRows.length === 0) return null;
  const keysetTargetIds = [...exact.rows.values()]
    .filter(({ keysetId }) => keysetId === leg.keyset.keysetId)
    .map(({ proofId }) => proofId);
  if (
    keysetTargetIds.length !== targetRows.length ||
    keysetTargetIds.some((proofId) => !targetRows.some((row) => row.proofId === proofId))
  ) {
    throw new Error("confirmed CTF proof target set changed");
  }
  for (const row of targetRows) {
    const target = exact.targets.get(row.proofId)!;
    if (
      row.selectability !== "selectable" ||
      row.revision !== target.revision ||
      row.proofFingerprint !== target.proofFingerprint
    ) {
      throw new Error("confirmed CTF proof target revision changed");
    }
  }
  const selected = new Set(targetRows.map(({ proofId }) => proofId));
  return {
    keyset: leg.keyset,
    rows: targetRows,
    proofs: leg.rows.flatMap((row, index) =>
      selected.has(row.proofId) && leg.proofs[index] !== undefined ? [leg.proofs[index]!] : [],
    ),
  };
}

function markTargetOutcome(
  exact: ExactTargetState | null,
  proofIds: readonly string[],
  outcome: BrowserCanonicalCtfRedeemRecoveryResult,
): void {
  if (exact === null) return;
  if (
    outcome.kind === "redeemed" ||
    outcome.kind === "already-completed" ||
    outcome.kind === "losing" ||
    outcome.kind === "already-losing"
  ) {
    markTargetCovered(exact, proofIds);
  }
}

function markTargetCovered(exact: ExactTargetState | null, proofIds: readonly string[]): void {
  if (exact === null) return;
  for (const proofId of proofIds) {
    if (exact.targets.has(proofId)) exact.covered.add(proofId);
  }
}

function isTerminalTarget(row: BrowserCustodyProofRow | undefined): boolean {
  return row?.selectability === "spent" || row?.selectability === "verified-losing";
}

function requireOperationTargetSubset(
  record: DurableCustodyRecord,
  targets: Map<string, BrowserCanonicalCtfPositionClaimTarget> | undefined,
): void {
  if (targets === undefined) return;
  const proofIds = record.operation.reservation.inputs.map(({ proofId }) => proofId);
  const overlap = proofIds.some((proofId) => targets.has(proofId));
  if (overlap && proofIds.some((proofId) => !targets.has(proofId))) {
    throw new Error("recoverable CTF operation overlaps an unconfirmed proof target");
  }
}

function requireOperationTargetFingerprints(
  record: DurableCustodyRecord,
  exact: ExactTargetState | null,
): void {
  if (exact === null) return;
  for (const { proofId } of record.operation.reservation.inputs) {
    const target = exact.targets.get(proofId);
    if (target === undefined) continue;
    const row = exact.rows.get(proofId);
    if (row === undefined || row.proofFingerprint !== target.proofFingerprint) {
      throw new Error("recoverable CTF proof target body changed");
    }
  }
}

async function* readMatchingRecoverableOperations(input: {
  readonly identity: BrowserCanonicalCtfPositionIdentity;
  readonly scope: DurableCustodyScope;
  readonly normalizedMint: string;
  readonly adapter: BrowserDurableCustodyAdapter;
  readonly targetIds: Map<string, BrowserCanonicalCtfPositionClaimTarget> | undefined;
  readonly exact: ExactTargetState | null;
}): AsyncGenerator<DurableCustodyRecord> {
  const seen = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const current = await input.adapter.listRecoverablePage({
      scope: input.scope,
      cursor,
      limit: RECOVERABLE_PAGE_LIMIT,
    });
    for (const record of current.records) {
      if (
        record.operation.semanticKind !== "ctf-redeem" ||
        seen.has(record.operation.operationId)
      ) {
        continue;
      }
      const exact = await input.adapter.readOperation(input.scope, record.operation.operationId);
      if (exact === null || exact.operation.operationId !== record.operation.operationId) {
        throw new Error("browser CTF claim recovery operation is foreign");
      }
      const snapshot = await input.adapter.readOperationSnapshot(
        input.scope,
        record.operation.operationId,
      );
      if (snapshot === null) throw new Error("browser CTF claim recovery operation is missing");
      const exactReference = snapshot.record.operation.privateMaterial.exactPrivateMaterial;
      const exactAuthority = snapshot.artifacts.find(
        ({ reference }) => reference.artifactId === exactReference.artifactId,
      )?.artifact;
      if (exactAuthority === undefined) {
        throw new Error("browser CTF claim recovery authority is missing");
      }
      const authority = assertDurableCustodyMintOperationAuthority(snapshot.record, exactAuthority);
      const metadata = authority.operation.metadata;
      if (
        authority.operation.mintUrl !== input.normalizedMint ||
        metadata?.conditionId !== input.identity.conditionId ||
        metadata?.outcomeCollection !== input.identity.outcomeCollection
      ) {
        continue;
      }
      requireOperationTargetSubset(exact, input.targetIds);
      requireOperationTargetFingerprints(exact, input.exact);
      const proofIds = exact.operation.reservation.inputs.map(({ proofId }) => proofId);
      if (
        input.targetIds !== undefined &&
        !proofIds.some((proofId) => input.targetIds!.has(proofId))
      ) {
        continue;
      }
      seen.add(record.operation.operationId);
      yield exact;
    }
    if (current.nextCursor === null) return;
    if (current.nextCursor === cursor) {
      throw new Error("browser CTF claim recovery cursor did not advance");
    }
    cursor = current.nextCursor;
  }
}

function durableOperationIdForLeg(
  scopeId: string,
  mintUrl: string,
  position: BrowserCanonicalCtfPositionIdentity,
  leg: BrowserCtfRedeemLeg,
): string {
  const retainedOperationKey = buildKeysetRedeemOperationId({
    mintUrl,
    unit: "msat",
    conditionId: position.conditionId,
    keysetId: leg.keyset.keysetId,
    proofs: leg.proofs,
  });
  return deriveDurableCustodyOperationId(scopeId, {
    retainedOperationKey,
    binding: { kind: "wallet", activityId: retainedOperationKey, stage: "ctf-redeem" },
  });
}

async function reconcileBrowserCanonicalCtfRedeemTerminal(input: {
  readonly scope: DurableCustodyScope;
  readonly operationId: string;
  readonly evidence: AuthenticatedCtfRedeemTerminalEvidence;
  readonly context: BrowserCanonicalCtfPositionClaimContext;
}): Promise<void> {
  const snapshot = await input.context.adapter.readOperationSnapshot(
    input.scope,
    input.operationId,
  );
  if (snapshot === null) throw new Error("browser CTF claim terminal operation is missing");
  if (snapshot.record.operation.terminalMintRejection !== null) return;
  const exactReference = snapshot.record.operation.privateMaterial.exactPrivateMaterial;
  const exactAuthority = snapshot.artifacts.find(
    ({ reference }) => reference.artifactId === exactReference.artifactId,
  )?.artifact;
  if (exactAuthority === undefined) {
    throw new Error("browser CTF claim terminal authority is missing");
  }
  const prepared = prepareDurableCustodyAuthenticatedTerminalMintRejection({
    record: snapshot.record,
    exactAuthority,
    evidence: input.evidence,
  });
  const authorization = { ...input.context.owner, observedAtMs: input.context.observedAtMs };
  await input.context.adapter.transact(
    {
      scope: input.scope,
      owner: authorization,
      operationRows: [
        { operationId: input.operationId, expectedRevision: snapshot.record.revision },
      ],
    },
    (transaction) =>
      reconcileDurableCustodyAuthenticatedTerminalMintRejection({
        transaction,
        record: snapshot.record,
        prepared,
        authorization,
      }),
  );
}

function isPendingError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /(?:timed? ?out|timeout|network error|failed to fetch|connection reset|temporarily unavailable)/i.test(
    message,
  );
}

function isPersistedRecoveryRace(error: unknown): boolean {
  return error instanceof Error && /requires persisted recovery/.test(error.message);
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "browser CTF claim failed";
  const normalized = message.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length > ERROR_MESSAGE_LIMIT
    ? `${normalized.slice(0, ERROR_MESSAGE_LIMIT - 1)}…`
    : normalized || "browser CTF claim failed";
}
