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
import { createDurableCustodyProofMaterialRecord } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { verifyDurableWalletConditionalKeyset } from "@bitcaster/client-sdk/recoverableWalletStorage";
import { db, type BitcasterDB } from "./proof-db";
import {
  advanceBrowserProofBackupAuthorityRow,
  advanceBrowserRemoteProofBackupAuthorityRow,
  createBrowserProofBackupAuthorityRow,
  requireBrowserProofDerivationLocator,
  requireBrowserProofBackupAuthorityForProof,
  sameBrowserProofDerivationLocator,
  type BrowserProofDerivationLocatorAuthority,
} from "./browser-proof-backup-authority";
import type {
  BrowserCustodyActiveWorkRow,
  BrowserCustodyArtifactRow,
  BrowserCustodyConditionalKeysetRow,
  BrowserCustodyOperationRow,
  BrowserCustodyProofRow,
  BrowserCustodyConditionalKeysetAuthority,
  BrowserCustodyProofUnit,
  BrowserCustodyReservationRow,
  BrowserCustodyScopeRow,
} from "./durable-custody-types";
import { decodeBrowserCustodyConditionalKeysetAuthority } from "./durable-custody-types";
import { decodeBrowserCustodyConditionalKeysetRow } from "./durable-custody-types";
import { decodeBrowserCustodyProofRow } from "./durable-custody-types";
import { advanceBrowserV2DesiredAssetsForProofChanges } from "./browser-encrypted-wallet-backup-v2-desired-asset";

export { decodeBrowserCustodyProofRow } from "./durable-custody-types";

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
  readonly derivationLocator: BrowserProofDerivationLocatorAuthority;
  readonly conditionalKeyset?: BrowserCustodyConditionalKeysetAuthority;
}

interface PersistedBrowserCustodyProof {
  readonly proof: BrowserCustodyProofRow;
  readonly derivationLocator: BrowserProofDerivationLocatorAuthority | undefined;
}

interface PersistedBrowserCustodyProofRequest extends PersistedBrowserCustodyProof {
  readonly key: [string, string];
  readonly successorAdmissionOperationId: string | undefined;
  readonly predecessorFallbackOperationId: string | undefined;
  readonly conditionalKeyset: BrowserCustodyConditionalKeysetAuthority | undefined;
}

interface BrowserCustodyProofBackupAuthorityState {
  readonly authorities: ReadonlyMap<
    string,
    ReturnType<typeof requireBrowserProofBackupAuthorityForProof> | null
  >;
  readonly proofs: ReadonlyMap<string, BrowserCustodyProofRow>;
}

interface BrowserCustodyProofBackupPayloadChange {
  readonly beforeProof: BrowserCustodyProofRow | null;
  readonly beforeLocator: BrowserProofDerivationLocatorAuthority;
  readonly afterProof: BrowserCustodyProofRow;
  readonly afterLocator: BrowserProofDerivationLocatorAuthority;
}

interface ConditionalKeysetWritePlan {
  readonly key: [string, string, string, string];
  readonly proofs: readonly PersistedBrowserCustodyProofRequest[];
  readonly requested: BrowserCustodyConditionalKeysetAuthority | undefined;
  readonly requiresPersistedAuthority: boolean;
}

interface ConditionalKeysetWriteResult {
  readonly additions: readonly BrowserCustodyConditionalKeysetRow[];
  readonly authorities: ReadonlyMap<string, BrowserCustodyConditionalKeysetRow>;
}

interface BrowserCustodyProofPersistenceResult {
  readonly changes: readonly BrowserCustodyProofBackupPayloadChange[];
  readonly conditionalKeysets: ReadonlyMap<string, BrowserCustodyConditionalKeysetRow>;
}

export interface BrowserCustodyTransactionOptions {
  readonly predecessorProofs?: Readonly<Record<string, readonly BrowserCustodyProofRow[]>>;
  readonly successorProofs?: Readonly<Record<string, readonly StagedBrowserCustodyProof[]>>;
  readonly conditionalKeysets?: Readonly<Record<string, BrowserCustodyConditionalKeysetAuthority>>;
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
      this.#database.custodyProofBackupAuthorities,
      this.#database.custodyConditionalKeysets,
      this.#database.encryptedWalletBackupV2DesiredAssets,
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
        terminalProofIds: proofState.terminalProofIds,
        successorProofs: options.successorProofs ?? {},
        successorAdmissionOperationIds: stagedSuccessorAdmissionOperationIds(options),
        predecessorFallbackOperationIds: stagedPredecessorFallbackOperationIds(options),
        conditionalKeysets: stagedConditionalKeysets(options),
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

  async retireAbortedInputsAndAdmitRefunds(input: {
    scopeId: string;
    operationId: string;
    refundProofs: readonly StagedBrowserCustodyProof[];
    observedAtMs: number;
    injectFault?: "before-commit" | "after-commit";
  }): Promise<void> {
    await this.#database.transaction(
      "rw",
      [
        this.#database.custodyOperations,
        this.#database.custodyProofs,
        this.#database.custodyReservations,
        this.#database.custodyProofBackupAuthorities,
        this.#database.custodyConditionalKeysets,
        this.#database.encryptedWalletBackupV2DesiredAssets,
      ],
      async () => {
        const operationRow = await this.#database.custodyOperations.get([
          input.scopeId,
          input.operationId,
        ]);
        if (!operationRow) throw new Error("browser refunded operation is missing");
        const operation = decodeOperationRow(operationRow).record;
        if (
          operation.operation.state !== "aborted" ||
          operation.operation.result.state !== "none"
        ) {
          throw new Error("browser refunded operation lifecycle is invalid");
        }
        const reservations = (
          await this.#database.custodyReservations
            .where("[scopeId+operationId]")
            .equals([input.scopeId, input.operationId])
            .toArray()
        ).map(decodeReservationRow);
        const expectedProofIds = operation.operation.proofStorage.lineage.predecessorProofIds;
        if (
          reservations.length !== expectedProofIds.length ||
          reservations.some(({ proofId }) => !expectedProofIds.includes(proofId))
        ) {
          throw new Error("browser refunded reservation authority is incomplete");
        }
        const proofRows = await this.#database.custodyProofs.bulkGet(
          expectedProofIds.map((proofId) => [input.scopeId, proofId]),
        );
        const retired = proofRows.map((row) => {
          if (!row) throw new Error("browser refunded predecessor proof is missing");
          const proof = decodeBrowserCustodyProofRow(row);
          if (
            proof.selectability !== "locked" ||
            proof.reservationOperationId !== input.operationId
          ) {
            throw new Error("browser refunded predecessor proof authority is invalid");
          }
          return decodeBrowserCustodyProofRow({
            ...proof,
            revision: proof.revision + 1,
            selectability: "spent",
            reservationOperationId: null,
          });
        });
        const refunds = input.refundProofs.map((staged) => ({
          proof: decodeBrowserCustodyProofRow(staged.proof),
          derivationLocator: requireBrowserProofDerivationLocator(staged.derivationLocator),
          conditionalKeyset: staged.conditionalKeyset,
        }));
        if (
          refunds.some(
            ({ proof }) =>
              proof.scopeId !== input.scopeId ||
              proof.selectability !== "selectable" ||
              proof.reservationOperationId !== null,
          )
        ) {
          throw new Error("browser refund proof authority is invalid");
        }
        const retiredPersistence = await this.#persistProofRowsWithBackupAuthority(
          retired.map((proof) => ({ proof, derivationLocator: undefined })),
          input.observedAtMs,
        );
        await this.#database.custodyReservations.bulkDelete(
          expectedProofIds.map((proofId) => [input.scopeId, proofId]),
        );
        const refundsPersisted = await this.#persistProofRowsWithBackupAuthority(
          refunds,
          input.observedAtMs,
          () => input.operationId,
        );
        await advanceBrowserV2DesiredAssetsForProofChanges(
          this.#database,
          input.scopeId,
          [...retiredPersistence.changes, ...refundsPersisted.changes].map(desiredAssetProofChange),
          conditionalKeysetLookup(
            retiredPersistence.conditionalKeysets,
            refundsPersisted.conditionalKeysets,
          ),
        );
        if (input.injectFault === "before-commit") {
          throw new Error("injected browser refund custody fault before commit");
        }
      },
    );
    if (input.injectFault === "after-commit") {
      throw new Error("injected browser refund custody fault after commit");
    }
  }

  async readOperation(
    scope: DurableCustodyScope,
    operationId: string,
  ): Promise<DurableCustodyRecord | null> {
    const row = await this.#database.custodyOperations.get([scope.scopeId, operationId]);
    return row ? decodeOperationRow(row).record : null;
  }

  async readProof(scopeId: string, proofId: string): Promise<BrowserCustodyProofRow | null> {
    return this.#database.transaction(
      "r",
      [this.#database.custodyProofs, this.#database.custodyProofBackupAuthorities],
      async () => {
        const [row, authority] = await Promise.all([
          this.#database.custodyProofs.get([scopeId, proofId]),
          this.#database.custodyProofBackupAuthorities.get([scopeId, proofId]),
        ]);
        if (!row) {
          if (authority) throw new Error("browser proof backup authority has no proof body");
          return null;
        }
        const proof = decodeBrowserCustodyProofRow(row);
        requireBrowserProofBackupAuthorityForProof(authority, proof);
        return proof;
      },
    );
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
    terminalProofIds: ReadonlySet<string>;
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
    const [proofRows, reservationRows, backupAuthorities] = await Promise.all([
      this.#database.custodyProofs.bulkGet(keys),
      this.#database.custodyReservations.bulkGet(keys),
      this.#database.custodyProofBackupAuthorities.bulkGet(keys),
    ]);
    const proofs = new Map<string, BrowserCustodyProofRow>();
    const authorities = new Map<
      string,
      ReturnType<typeof requireBrowserProofBackupAuthorityForProof>
    >();
    const reservations = new Map<string, BrowserCustodyReservationRow>();
    const terminalProofIds = new Set<string>();
    proofRows.forEach((row, index) => {
      if (row) {
        const decoded = decodeBrowserCustodyProofRow(row);
        const authority = requireBrowserProofBackupAuthorityForProof(
          backupAuthorities[index],
          decoded,
        );
        proofs.set(decoded.proofId, decoded);
        authorities.set(decoded.proofId, authority);
        if (authority.terminalOperationId !== null) terminalProofIds.add(decoded.proofId);
      } else if (backupAuthorities[index]) {
        throw new Error("browser proof backup authority has no proof body");
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
    assertStagedSuccessorLocatorReplays(options.successorProofs, authorities);
    return { proofs, reservations, terminalProofIds };
  }

  async #persistTransaction(
    selection: DurableCustodyTransactionSelection,
    transaction: StagedBrowserCustodyTransaction,
  ): Promise<void> {
    await this.#persistChangedOperations(transaction);
    await this.#persistChangedArtifacts(transaction);
    const proofPersistence = await this.#persistChangedProofs(
      transaction,
      selection.owner.observedAtMs,
    );
    if (proofPersistence.changes.length > 0) {
      await advanceBrowserV2DesiredAssetsForProofChanges(
        this.#database,
        selection.scope.scopeId,
        proofPersistence.changes.map(desiredAssetProofChange),
        conditionalKeysetLookup(proofPersistence.conditionalKeysets),
      );
    }
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

  async #persistChangedProofs(
    transaction: StagedBrowserCustodyTransaction,
    observedAtMs: number,
  ): Promise<BrowserCustodyProofPersistenceResult> {
    const changed: PersistedBrowserCustodyProof[] = [];
    for (const proofId of transaction.changedProofIds) {
      const proof = transaction.proofs.get(proofId);
      if (!proof) throw new Error("browser custody changed proof is absent");
      changed.push({
        proof: decodeBrowserCustodyProofRow(proof),
        derivationLocator: transaction.derivationLocatorForProof(proofId),
      });
    }
    return this.#persistProofRowsWithBackupAuthority(
      changed,
      observedAtMs,
      (proofId) => transaction.successorAdmissionOperationIdForProof(proofId),
      (proofId) => transaction.predecessorFallbackOperationIdForProof(proofId),
      (proofId) => transaction.conditionalKeysetForProof(proofId),
    );
  }

  async #persistProofRowsWithBackupAuthority(
    proofs: readonly PersistedBrowserCustodyProof[],
    observedAtMs: number,
    admissionOperationIdForProof: (proofId: string) => string | undefined = () => undefined,
    predecessorFallbackOperationIdForProof: (proofId: string) => string | undefined = () =>
      undefined,
    conditionalKeysetForProof: (
      proofId: string,
    ) => BrowserCustodyConditionalKeysetAuthority | undefined = () => undefined,
  ): Promise<BrowserCustodyProofPersistenceResult> {
    const requests = persistedProofRequests(
      proofs,
      admissionOperationIdForProof,
      predecessorFallbackOperationIdForProof,
      conditionalKeysetForProof,
    );
    if (requests.length === 0) return { changes: [], conditionalKeysets: new Map() };
    const current = await this.#readCurrentProofBackupAuthorities(requests);
    const authorities = requests.map((request) =>
      nextProofBackupAuthority(
        request,
        current.authorities.get(proofIdentity(request.key)),
        observedAtMs,
      ),
    );
    const keysets = await this.#prepareConditionalKeysetWrites(requests, current);
    await Promise.all([
      this.#database.custodyProofs.bulkPut(requests.map(({ proof }) => proof)),
      this.#database.custodyProofBackupAuthorities.bulkPut(authorities),
      keysets.additions.length === 0
        ? Promise.resolve()
        : this.#database.custodyConditionalKeysets.bulkAdd(keysets.additions),
    ]);
    const changes = requests.map((request, index) => {
      const before = current.authorities.get(proofIdentity(request.key));
      const after = authorities[index];
      if (before === undefined || after === undefined) {
        throw new Error("browser custody proof backup authority is missing");
      }
      return {
        beforeProof: current.proofs.get(proofIdentity(request.key)) ?? null,
        beforeLocator:
          before === null ? null : requireBrowserProofDerivationLocator(before.derivationLocator),
        afterProof: request.proof,
        afterLocator: requireBrowserProofDerivationLocator(after.derivationLocator),
      };
    });
    return { changes, conditionalKeysets: keysets.authorities };
  }

  async #readCurrentProofBackupAuthorities(
    requests: readonly PersistedBrowserCustodyProofRequest[],
  ): Promise<BrowserCustodyProofBackupAuthorityState> {
    const keys = requests.map(({ key }) => key);
    const [proofRows, authorityRows] = await Promise.all([
      this.#database.custodyProofs.bulkGet(keys),
      this.#database.custodyProofBackupAuthorities.bulkGet(keys),
    ]);
    const authorities = new Map<
      string,
      ReturnType<typeof requireBrowserProofBackupAuthorityForProof> | null
    >();
    requests.forEach((request, index) => {
      const proofRow = proofRows[index];
      const authorityRow = authorityRows[index];
      if ((proofRow === undefined) !== (authorityRow === undefined)) {
        throw new Error("browser proof and backup authority are incomplete");
      }
      authorities.set(
        proofIdentity(request.key),
        authorityRow === undefined
          ? null
          : requireBrowserProofBackupAuthorityForProof(
              authorityRow,
              decodeBrowserCustodyProofRow(proofRow),
            ),
      );
    });
    const proofs = new Map<string, BrowserCustodyProofRow>();
    proofRows.forEach((row, index) => {
      if (row !== undefined) {
        proofs.set(proofIdentity(requests[index]!.key), decodeBrowserCustodyProofRow(row));
      }
    });
    return { authorities, proofs };
  }

  async #prepareConditionalKeysetWrites(
    requests: readonly PersistedBrowserCustodyProofRequest[],
    current: BrowserCustodyProofBackupAuthorityState,
  ): Promise<ConditionalKeysetWriteResult> {
    const plans = conditionalKeysetWritePlans(requests, current.authorities);
    if (plans.length === 0) return { additions: [], authorities: new Map() };
    const persisted = await this.#database.custodyConditionalKeysets.bulkGet(
      plans.map(({ key }) => key),
    );
    const additions: BrowserCustodyConditionalKeysetRow[] = [];
    const authorities = new Map<string, BrowserCustodyConditionalKeysetRow>();
    plans.forEach((plan, index) => {
      const result = validateConditionalKeysetWritePlan(plan, persisted[index]);
      if (result.add) additions.push(result.authority);
      authorities.set(conditionalKeysetIdentity(plan.key), result.authority);
    });
    return { additions, authorities };
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

function persistedProofRequests(
  proofs: readonly PersistedBrowserCustodyProof[],
  admissionOperationIdForProof: (proofId: string) => string | undefined,
  predecessorFallbackOperationIdForProof: (proofId: string) => string | undefined,
  conditionalKeysetForProof: (
    proofId: string,
  ) => BrowserCustodyConditionalKeysetAuthority | undefined,
): readonly PersistedBrowserCustodyProofRequest[] {
  if (proofs.length > TRANSACTION_PROOF_ROW_LIMIT_MAX) {
    throw new Error("browser custody proof row limit is exceeded");
  }
  const identities = new Set<string>();
  return proofs.map((staged) => {
    const proof = decodeBrowserCustodyProofRow(staged.proof);
    const key: [string, string] = [proof.scopeId, proof.proofId];
    const identity = proofIdentity(key);
    if (identities.has(identity))
      throw new Error("browser custody proof write set duplicates a proof");
    identities.add(identity);
    const suppliedKeyset = conditionalKeysetForProof(proof.proofId);
    return {
      proof,
      key,
      derivationLocator:
        staged.derivationLocator === undefined
          ? undefined
          : requireBrowserProofDerivationLocator(staged.derivationLocator),
      successorAdmissionOperationId: admissionOperationIdForProof(proof.proofId),
      predecessorFallbackOperationId: predecessorFallbackOperationIdForProof(proof.proofId),
      conditionalKeyset:
        suppliedKeyset === undefined
          ? undefined
          : decodeBrowserCustodyConditionalKeysetAuthority(suppliedKeyset),
    };
  });
}

function nextProofBackupAuthority(
  request: PersistedBrowserCustodyProofRequest,
  current: ReturnType<typeof requireBrowserProofBackupAuthorityForProof> | null | undefined,
  observedAtMs: number,
) {
  if (current === undefined) throw new Error("browser custody proof authority is missing");
  const locator =
    request.derivationLocator === undefined ? authorityLocator(current) : request.derivationLocator;
  if (current !== null) {
    if (current.backupState === "remote-backed") {
      return advanceBrowserRemoteProofBackupAuthorityRow(
        current,
        request.proof,
        observedAtMs,
        locator,
      );
    }
    return advanceBrowserProofBackupAuthorityRow(
      current,
      request.proof,
      observedAtMs,
      locator,
      request.successorAdmissionOperationId ?? current.admissionOperationId,
    );
  }
  return createBrowserProofBackupAuthorityRow(
    request.proof,
    observedAtMs,
    locator,
    requiredAdmissionOperationId(
      request.successorAdmissionOperationId ?? request.predecessorFallbackOperationId,
    ),
  );
}

function conditionalKeysetWritePlans(
  requests: readonly PersistedBrowserCustodyProofRequest[],
  current: ReadonlyMap<
    string,
    ReturnType<typeof requireBrowserProofBackupAuthorityForProof> | null
  >,
): readonly ConditionalKeysetWritePlan[] {
  const plans = new Map<string, ConditionalKeysetWritePlan>();
  for (const request of requests) {
    const { proof, conditionalKeyset } = request;
    if (proof.assetKind === "regular") {
      if (conditionalKeyset !== undefined) {
        throw new Error("ordinary proof has conditional keyset authority");
      }
      continue;
    }
    if (conditionalKeyset !== undefined && !matchesConditionalKeyset(proof, conditionalKeyset)) {
      throw new Error("conditional proof keyset authority is missing or foreign");
    }
    const existing = current.get(proofIdentity(request.key));
    if (existing === undefined) throw new Error("browser custody proof authority is missing");
    if (existing === null && conditionalKeyset === undefined) {
      throw new Error("conditional proof keyset authority is missing or foreign");
    }
    const key: [string, string, string, string] = [
      proof.scopeId,
      proof.normalizedMint,
      proof.unit,
      proof.keysetId,
    ];
    const identity = conditionalKeysetIdentity(key);
    const plan = plans.get(identity);
    if (!plan) {
      plans.set(identity, {
        key,
        proofs: [request],
        requested: conditionalKeyset,
        requiresPersistedAuthority: existing !== null && conditionalKeyset === undefined,
      });
      continue;
    }
    if (
      plan.requested !== undefined &&
      conditionalKeyset !== undefined &&
      !sameConditionalKeyset(plan.requested, conditionalKeyset)
    ) {
      throw new Error("conditional keyset authority conflicts");
    }
    plans.set(identity, {
      ...plan,
      proofs: [...plan.proofs, request],
      requested: plan.requested ?? conditionalKeyset,
      requiresPersistedAuthority:
        plan.requiresPersistedAuthority || (existing !== null && conditionalKeyset === undefined),
    });
  }
  return [...plans.values()];
}

function validateConditionalKeysetWritePlan(
  plan: ConditionalKeysetWritePlan,
  persisted: BrowserCustodyConditionalKeysetRow | undefined,
): { readonly authority: BrowserCustodyConditionalKeysetRow; readonly add: boolean } {
  if (persisted === undefined) {
    if (plan.requested === undefined || plan.requiresPersistedAuthority) {
      throw new Error("conditional proof keyset authority is missing");
    }
    verifyBrowserConditionalKeysetAuthority(plan.requested);
    return { authority: { ...plan.requested, scopeId: plan.key[0] }, add: true };
  }
  const current = decodeBrowserCustodyConditionalKeysetRow(persisted);
  if (!matchesConditionalKeysetKey(current, plan.key)) {
    throw new Error("conditional proof keyset authority is foreign");
  }
  if (plan.proofs.some(({ proof }) => !matchesConditionalKeyset(proof, current))) {
    throw new Error("conditional proof keyset authority is foreign");
  }
  if (plan.requested !== undefined && !sameConditionalKeyset(current, plan.requested)) {
    throw new Error("conditional keyset authority conflicts");
  }
  verifyBrowserConditionalKeysetAuthority(current);
  return { authority: current, add: false };
}

function conditionalKeysetLookup(
  ...sources: readonly ReadonlyMap<string, BrowserCustodyConditionalKeysetRow>[]
) {
  return (proof: BrowserCustodyProofRow): BrowserCustodyConditionalKeysetRow | undefined => {
    if (proof.assetKind === "regular") return undefined;
    const identity = conditionalKeysetIdentity([
      proof.scopeId,
      proof.normalizedMint,
      proof.unit,
      proof.keysetId,
    ]);
    for (const source of sources) {
      const keyset = source.get(identity);
      if (keyset !== undefined) return keyset;
    }
    return undefined;
  };
}

function proofIdentity(key: readonly [string, string]): string {
  return JSON.stringify(key);
}

function conditionalKeysetIdentity(key: readonly [string, string, string, string]): string {
  return JSON.stringify(key);
}

function matchesConditionalKeysetKey(
  keyset: BrowserCustodyConditionalKeysetRow,
  key: readonly [string, string, string, string],
): boolean {
  return (
    keyset.scopeId === key[0] &&
    keyset.normalizedMint === key[1] &&
    keyset.unit === key[2] &&
    keyset.keysetId === key[3]
  );
}

function verifyBrowserConditionalKeysetAuthority(
  keyset: BrowserCustodyConditionalKeysetAuthority,
): void {
  verifyDurableWalletConditionalKeyset({
    mint: keyset.normalizedMint,
    unit: keyset.unit,
    outcomeLabel: keyset.outcomeCollection,
    registeredAtUnixSeconds: keyset.registeredAtUnixSeconds,
    mintKeys: {
      id: keyset.keysetId,
      unit: keyset.unit,
      keys: keyset.denominationPublicKeys,
      input_fee_ppk: keyset.inputFeePpk,
      final_expiry: keyset.finalExpiryUnixSeconds,
      conditional: {
        conditionId: keyset.conditionId,
        outcomeCollection: keyset.outcomeCollection,
        outcomeCollectionId: keyset.outcomeCollectionId,
        registeredAt: keyset.registeredAtUnixSeconds,
      },
    },
    conditionalMetadata: {
      conditionId: keyset.conditionId,
      outcomeCollection: keyset.outcomeCollection,
      outcomeCollectionId: keyset.outcomeCollectionId,
      registeredAt: keyset.registeredAtUnixSeconds,
    },
  });
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
  readonly #derivationLocators: ReadonlyMap<string, BrowserProofDerivationLocatorAuthority>;
  readonly #successorAdmissionOperationIds: ReadonlyMap<string, string>;
  readonly #predecessorFallbackOperationIds: ReadonlyMap<string, string>;
  readonly #conditionalKeysets: ReadonlyMap<string, BrowserCustodyConditionalKeysetAuthority>;
  readonly #terminalProofIds: ReadonlySet<string>;

  constructor(input: {
    scopeState: DurableCustodyScopeState;
    operations: Map<string, DurableCustodyRecord | null>;
    artifacts: Map<string, BrowserCustodyArtifactRow>;
    proofs: Map<string, BrowserCustodyProofRow>;
    reservations: Map<string, BrowserCustodyReservationRow>;
    terminalProofIds: ReadonlySet<string>;
    successorProofs: Readonly<Record<string, readonly StagedBrowserCustodyProof[]>>;
    successorAdmissionOperationIds: ReadonlyMap<string, string>;
    predecessorFallbackOperationIds: ReadonlyMap<string, string>;
    conditionalKeysets: ReadonlyMap<string, BrowserCustodyConditionalKeysetAuthority>;
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
    this.#terminalProofIds = new Set(input.terminalProofIds);
    this.#successorProofs = input.successorProofs;
    this.#derivationLocators = stagedDerivationLocators(input.successorProofs);
    this.#successorAdmissionOperationIds = input.successorAdmissionOperationIds;
    this.#predecessorFallbackOperationIds = input.predecessorFallbackOperationIds;
    this.#conditionalKeysets = input.conditionalKeysets;
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

  derivationLocatorForProof(proofId: string): BrowserProofDerivationLocatorAuthority | undefined {
    return this.#derivationLocators.get(proofId);
  }

  successorAdmissionOperationIdForProof(proofId: string): string | undefined {
    return this.#successorAdmissionOperationIds.get(proofId);
  }

  predecessorFallbackOperationIdForProof(proofId: string): string | undefined {
    return this.#predecessorFallbackOperationIds.get(proofId);
  }

  conditionalKeysetForProof(proofId: string): BrowserCustodyConditionalKeysetAuthority | undefined {
    return this.#conditionalKeysets.get(proofId);
  }

  #reserveProof(operation: DurableCustodyRecord, proofId: string, inputPosition: number): void {
    const existingReservation = this.reservations.get(proofId);
    const proof = this.proofs.get(proofId);
    if (!proof) throw new Error("browser custody reserved proof is absent");
    if (this.#terminalProofIds.has(proofId)) {
      throw new Error("browser custody terminal proof cannot be reserved");
    }
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
      requireBrowserProofDerivationLocator(row.derivationLocator);
      successorCandidates.push(decodeBrowserCustodyProofRow(row.proof));
    }
  }
  return { predecessorCandidates, successorCandidates };
}

function stagedSuccessorAdmissionOperationIds(
  options: BrowserCustodyTransactionOptions,
): ReadonlyMap<string, string> {
  const admissions = new Map<string, string>();
  for (const [operationId, proofs] of Object.entries(options.successorProofs ?? {})) {
    for (const { proof } of proofs)
      recordAdmissionOperation(admissions, proof.proofId, operationId);
  }
  return admissions;
}

function stagedPredecessorFallbackOperationIds(
  options: BrowserCustodyTransactionOptions,
): ReadonlyMap<string, string> {
  const fallbacks = new Map<string, string>();
  for (const [operationId, proofs] of Object.entries(options.predecessorProofs ?? {})) {
    for (const proof of proofs) recordAdmissionOperation(fallbacks, proof.proofId, operationId);
  }
  return fallbacks;
}

function stagedConditionalKeysets(
  options: BrowserCustodyTransactionOptions,
): ReadonlyMap<string, BrowserCustodyConditionalKeysetAuthority> {
  const keysets = new Map(
    Object.entries(options.conditionalKeysets ?? {}).map(([proofId, keyset]) => [
      proofId,
      decodeBrowserCustodyConditionalKeysetAuthority(keyset),
    ]),
  );
  for (const proofs of Object.values(options.successorProofs ?? {})) {
    for (const staged of proofs) {
      if (staged.proof.assetKind === "conditional") {
        if (!staged.conditionalKeyset) {
          throw new Error("conditional proof keyset authority is missing");
        }
        const current = keysets.get(staged.proof.proofId);
        if (current && !sameConditionalKeyset(current, staged.conditionalKeyset)) {
          throw new Error("conditional proof keyset authority conflicts");
        }
        keysets.set(staged.proof.proofId, staged.conditionalKeyset);
      } else if (staged.conditionalKeyset !== undefined) {
        throw new Error("ordinary proof has conditional keyset authority");
      }
    }
  }
  return keysets;
}

function matchesConditionalKeyset(
  proof: BrowserCustodyProofRow,
  keyset: BrowserCustodyConditionalKeysetAuthority,
): boolean {
  return (
    keyset.normalizedMint === proof.normalizedMint &&
    keyset.unit === proof.unit &&
    keyset.keysetId === proof.keysetId &&
    keyset.conditionId === proof.conditionId &&
    keyset.outcomeCollection === proof.outcomeCollection &&
    keyset.curve === proof.curve
  );
}

function sameConditionalKeyset(
  left: BrowserCustodyConditionalKeysetAuthority & { scopeId?: string },
  right: BrowserCustodyConditionalKeysetAuthority & { scopeId?: string },
): boolean {
  return (
    left.normalizedMint === right.normalizedMint &&
    left.unit === right.unit &&
    left.keysetId === right.keysetId &&
    left.conditionId === right.conditionId &&
    left.outcomeCollection === right.outcomeCollection &&
    left.outcomeCollectionId === right.outcomeCollectionId &&
    left.registeredAtUnixSeconds === right.registeredAtUnixSeconds &&
    left.finalExpiryUnixSeconds === right.finalExpiryUnixSeconds &&
    left.curve === right.curve &&
    left.inputFeePpk === right.inputFeePpk &&
    sameTextRecord(left.denominationPublicKeys, right.denominationPublicKeys)
  );
}

function sameTextRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function recordAdmissionOperation(
  admissions: Map<string, string>,
  proofId: string,
  operationId: string,
): void {
  const current = admissions.get(proofId);
  if (current !== undefined && current !== operationId) {
    throw new Error("browser custody proof admission operation conflicts");
  }
  admissions.set(proofId, operationId);
}

function requiredAdmissionOperationId(value: string | undefined): string {
  if (value === undefined) throw new Error("browser custody proof admission operation is missing");
  return value;
}

function assertStagedSuccessorLocatorReplays(
  successorProofs: Readonly<Record<string, readonly StagedBrowserCustodyProof[]>> | undefined,
  authorities: ReadonlyMap<string, ReturnType<typeof requireBrowserProofBackupAuthorityForProof>>,
): void {
  for (const successors of Object.values(successorProofs ?? {})) {
    for (const staged of successors) {
      const authority = authorities.get(staged.proof.proofId);
      if (
        authority &&
        !sameBrowserProofDerivationLocator(authorityLocator(authority), staged.derivationLocator)
      ) {
        throw new Error("browser custody proof derivation locator conflicts");
      }
    }
  }
}

function stagedDerivationLocators(
  successorProofs: Readonly<Record<string, readonly StagedBrowserCustodyProof[]>>,
): ReadonlyMap<string, BrowserProofDerivationLocatorAuthority> {
  const locators = new Map<string, BrowserProofDerivationLocatorAuthority>();
  for (const successors of Object.values(successorProofs)) {
    for (const staged of successors) {
      if (locators.has(staged.proof.proofId)) {
        throw new Error("browser custody proof derivation locator is duplicated");
      }
      locators.set(
        staged.proof.proofId,
        requireBrowserProofDerivationLocator(staged.derivationLocator),
      );
    }
  }
  return locators;
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

function proofPayloadChanged(change: BrowserCustodyProofBackupPayloadChange): boolean {
  const beforeActive =
    change.beforeProof !== null &&
    (change.beforeProof.selectability === "selectable" ||
      change.beforeProof.selectability === "locked");
  const afterActive =
    change.afterProof.selectability === "selectable" ||
    change.afterProof.selectability === "locked";
  if (beforeActive !== afterActive) return true;
  if (!beforeActive) return false;
  if (change.beforeProof === null) return true;
  return !(
    change.beforeProof.proofId === change.afterProof.proofId &&
    sameBytes(change.beforeProof.proofBody, change.afterProof.proofBody) &&
    change.beforeProof.normalizedMint === change.afterProof.normalizedMint &&
    change.beforeProof.unit === change.afterProof.unit &&
    change.beforeProof.assetKind === change.afterProof.assetKind &&
    change.beforeProof.conditionId === change.afterProof.conditionId &&
    change.beforeProof.outcomeCollection === change.afterProof.outcomeCollection &&
    sameNullableBrowserProofDerivationLocator(change.beforeLocator, change.afterLocator)
  );
}

function sameNullableBrowserProofDerivationLocator(
  left: BrowserProofDerivationLocatorAuthority,
  right: BrowserProofDerivationLocatorAuthority,
): boolean {
  if (left === null || right === null) return left === right;
  return sameBrowserProofDerivationLocator(left, right);
}

function desiredAssetProofChange(
  change: BrowserCustodyProofBackupPayloadChange,
): import("./browser-encrypted-wallet-backup-v2-desired-asset").BrowserV2DesiredAssetProofChange {
  return {
    beforeProof: change.beforeProof,
    afterProof: change.afterProof,
    payloadChanged: proofPayloadChanged(change),
  };
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
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

function authorityLocator(
  authority: { readonly derivationLocator: unknown } | null,
): BrowserProofDerivationLocatorAuthority {
  return authority === null
    ? null
    : requireBrowserProofDerivationLocator(authority.derivationLocator);
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

function assertNever(value: never): never {
  throw new Error(`unexpected browser custody value: ${String(value)}`);
}
