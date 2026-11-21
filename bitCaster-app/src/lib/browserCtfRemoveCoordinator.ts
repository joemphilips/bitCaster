import {
  classifyDurableCustodyActiveWork,
  decodeDurableCustodyRecord,
  deriveDurableCustodyArtifactFingerprint,
  encryptedWalletBackupV2LocalAssetKey,
  type EncryptedWalletBackupV2AssetIdentity,
} from "@bitcaster/client-sdk";
import {
  decodeDurableCustodyScopeInput,
  type DurableCustodyExactArtifact,
  type DurableCustodyRecord,
  type DurableCustodyScope,
} from "@bitcaster/client-sdk/durableCustody";
import { readDurableCustodyVerifiedLosingMintRejection } from "@bitcaster/client-sdk/durableCustodyMintResult";
import { serializeDurableCustodyProofArtifact } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { deriveRootCtfOutcomeCollectionId } from "@bitcaster/client-sdk/durableCtfRangeOperation";
import {
  createBrowserCompletedLocalProofRemovalMarkerRow,
  decodeBrowserProofBackupAuthorityTableRow,
  requireBrowserLiveProofBackupAuthorityTableRow,
  requireBrowserProofBackupAuthorityForProof,
  type BrowserProofBackupAuthorityRow,
} from "../stores/browser-proof-backup-authority";
import { BrowserDurableCustodyAdapter } from "../stores/durable-custody-db";
import {
  decodeBrowserCustodyProofRow,
  type BrowserCustodyProofRow,
} from "../stores/durable-custody-types";
import {
  storedProofFromCustodyRow,
  storedProofFromRow,
  type BitcasterDB,
} from "../stores/proof-db";
import { withWalletProfileLock } from "./walletProfileLock";

/**
 * The removal of a verified losing CTF token (ADR-034 recovery index
 * amendment, "Removal of a losing token"). The recovery index holds no
 * proofs, so the removal is local only: one local transaction removes the
 * proof body and records the completed local-removal marker. Reserved and
 * uncertain proofs stay excluded. A later seed restore can bring back a
 * removed losing token.
 */

const MAX_PROOFS = 512;
const ORACLE_NOT_ATTESTED_OUTCOME_CODE = 13015;

export interface BrowserCtfRemoveTarget {
  readonly proofId: string;
  readonly proofFingerprint: string;
  readonly proofRevision: number;
}

export interface BrowserCtfRemoveInput {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly asset: EncryptedWalletBackupV2AssetIdentity;
  readonly targets: readonly BrowserCtfRemoveTarget[];
  readonly observedAtMs?: number;
  readonly lockManager?: Pick<LockManager, "request">;
  readonly signal?: AbortSignal;
  readonly isCurrentProfile?: () => boolean;
  readonly fault?: "before-commit";
}

export type BrowserCtfRemoveResult = { readonly kind: "completed" };

/** Remove the exact verified losing proofs of one CTF asset in one local transaction. */
export async function startBrowserCtfRemove(
  input: BrowserCtfRemoveInput,
): Promise<BrowserCtfRemoveResult> {
  requireRemoveIdentity(input);
  const targets = sortedRemoveTargets(input.targets);
  const observedAtMs = input.observedAtMs ?? Date.now();
  const localAssetKey = encryptedWalletBackupV2LocalAssetKey(input.asset);
  return withWalletProfileLock(
    input.scopeId,
    async () => {
      requireCurrent(input);
      return input.database.transaction("rw", removalTables(input.database), async () => {
        if (
          await completedLocalRemovalReplay(input.database, input.scopeId, localAssetKey, targets)
        ) {
          return { kind: "completed" } as const;
        }
        await removeVerifiedLosingProofs(input, localAssetKey, targets, observedAtMs);
        return { kind: "completed" } as const;
      });
    },
    input.lockManager,
    input.signal,
  );
}

async function removeVerifiedLosingProofs(
  input: BrowserCtfRemoveInput,
  localAssetKey: string,
  targets: readonly BrowserCtfRemoveTarget[],
  observedAtMs: number,
): Promise<void> {
  const keys = targets.map(({ proofId }) => [input.scopeId, proofId] as [string, string]);
  const rawProofs = await input.database.custodyProofs.bulkGet(keys);
  if (rawProofs.some((proof) => proof === undefined)) {
    throw new Error("browser CTF local removal proof set is incomplete");
  }
  const proofs = rawProofs.map((proof) => decodeBrowserCustodyProofRow(proof));
  requireExactRemovalTargets(targets, proofs);
  const rawAuthorities = await input.database.custodyProofBackupAuthorities.bulkGet(keys);
  const authorities = new Map<string, BrowserProofBackupAuthorityRow>();
  const { conditionId, outcomeCollectionId } = removalAsset(input.asset);
  for (const [index, proof] of proofs.entries()) {
    const authority = requireBrowserProofBackupAuthorityForProof(
      requireBrowserLiveProofBackupAuthorityTableRow(rawAuthorities[index], keys[index]!),
      proof,
    );
    if (
      proof.scopeId !== input.scopeId ||
      proof.normalizedMint !== input.asset.mintUrl ||
      proof.unit !== input.asset.unit ||
      proof.assetKind !== "conditional" ||
      proof.conditionId !== conditionId ||
      proof.outcomeCollection === null ||
      deriveRootCtfOutcomeCollectionId({
        conditionId,
        outcomeCollection: proof.outcomeCollection,
      }) !== outcomeCollectionId ||
      proof.selectability !== "verified-losing" ||
      proof.reservationOperationId !== null
    ) {
      throw new Error("browser CTF local removal proof binding is foreign");
    }
    if (
      authority.backupState !== "local-only" ||
      authority.proofState !== "verified-losing" ||
      authority.terminalAuthority?.kind !== "local-operation" ||
      authority.terminalOperationId !== authority.terminalAuthority.operationId
    ) {
      throw new Error("browser CTF local removal authority is not eligible");
    }
    await requireProofReconciliationFence(input.database, proof, authority);
    await requireLocalTerminalAuthority(input, proof, authority);
    authorities.set(proof.proofId, authority);
  }

  requireCurrent(input);
  await removeLegacyCacheRows(input.database, proofs, authorities);
  await input.database.custodyProofs.bulkDelete(keys);
  await input.database.custodyProofBackupAuthorities.bulkPut(
    proofs.map((proof) =>
      createBrowserCompletedLocalProofRemovalMarkerRow({
        scopeId: proof.scopeId,
        proofId: proof.proofId,
        proofFingerprint: proof.proofFingerprint,
        proofRevision: proof.revision,
        localAssetKey,
        terminalOperationId: authorities.get(proof.proofId)!.terminalOperationId!,
        completedAtMs: observedAtMs,
      }),
    ),
  );
  if (input.fault === "before-commit") {
    throw new Error("browser CTF local removal commit fault");
  }
  requireCurrent(input);
}

async function completedLocalRemovalReplay(
  database: BitcasterDB,
  scopeId: string,
  localAssetKey: string,
  targets: readonly BrowserCtfRemoveTarget[],
): Promise<boolean> {
  const rows = await database.custodyProofBackupAuthorities.bulkGet(
    targets.map(({ proofId }) => [scopeId, proofId]),
  );
  if (rows.some((row) => row === undefined)) return false;
  return rows.every((row, index) => {
    try {
      const marker = decodeBrowserProofBackupAuthorityTableRow(row);
      const target = targets[index]!;
      return (
        "recordKind" in marker &&
        marker.recordKind === "completed-local-removal" &&
        marker.scopeId === scopeId &&
        marker.proofId === target.proofId &&
        marker.localAssetKey === localAssetKey &&
        marker.proofFingerprint === target.proofFingerprint &&
        marker.proofRevision === target.proofRevision
      );
    } catch {
      return false;
    }
  });
}

/** The committed losing redeem that classified this proof (NUT-CTF 13015). */
async function requireLocalTerminalAuthority(
  input: Pick<BrowserCtfRemoveInput, "database" | "scopeId">,
  proof: BrowserCustodyProofRow,
  authority: BrowserProofBackupAuthorityRow,
): Promise<void> {
  const terminalOperationId = authority.terminalOperationId;
  if (terminalOperationId === null) {
    throw new Error("browser CTF local removal terminal operation is missing");
  }
  const snapshot = await new BrowserDurableCustodyAdapter(input.database).readOperationSnapshot(
    requireWalletScope(input.scopeId),
    terminalOperationId,
  );
  if (snapshot === null) throw new Error("browser CTF local terminal operation is missing");
  const record = snapshot.record;
  validateLocalTerminalOperation(
    record,
    exactArtifact(
      snapshot.artifacts,
      record.operation.terminalMintRejection?.exactRejection.artifactId,
    ),
    exactArtifact(
      snapshot.artifacts,
      record.operation.privateMaterial.exactPrivateMaterial.artifactId,
    ),
    proof,
    terminalOperationId,
  );
}

/** Recheck retained losing authority before treating an exact Claim target as terminal. */
export async function requireBrowserCtfVerifiedLosingProofAuthority(
  database: BitcasterDB,
  proof: BrowserCustodyProofRow,
): Promise<void> {
  if (proof.selectability !== "verified-losing") {
    throw new Error("browser CTF losing proof classification is required");
  }
  const raw = await database.custodyProofBackupAuthorities.get([proof.scopeId, proof.proofId]);
  const authority = requireBrowserProofBackupAuthorityForProof(raw, proof);
  // Only a committed local losing redeem classifies a proof. The remote seal
  // kinds came from the encrypted proof backup, which no release wrote.
  if (authority.terminalAuthority?.kind !== "local-operation") {
    throw new Error("browser CTF losing proof authority is not a local operation");
  }
  await requireLocalTerminalAuthority({ database, scopeId: proof.scopeId }, proof, authority);
}

function exactArtifact(
  artifacts: readonly {
    readonly reference: { readonly artifactId: string };
    readonly artifact: DurableCustodyExactArtifact;
  }[],
  artifactId: string | undefined,
): DurableCustodyExactArtifact {
  const matches =
    artifactId === undefined
      ? []
      : artifacts.filter(({ reference }) => reference.artifactId === artifactId);
  if (matches.length !== 1) throw new Error("browser CTF local terminal artifact is invalid");
  return matches[0]!.artifact;
}

function validateLocalTerminalOperation(
  record: DurableCustodyRecord,
  exactRejection: DurableCustodyExactArtifact,
  exactAuthority: DurableCustodyExactArtifact,
  proof: BrowserCustodyProofRow,
  operationId: string,
): void {
  const operation = record.operation;
  const reservationInput = operation.reservation.inputs.find(
    ({ proofId }) => proofId === proof.proofId,
  );
  if (
    record.scope.scopeId !== proof.scopeId ||
    operation.operationId !== operationId ||
    operation.semanticKind !== "ctf-redeem" ||
    operation.state !== "aborted" ||
    operation.custodyContext.normalizedMint !== proof.normalizedMint ||
    operation.custodyContext.unit !== proof.unit ||
    operation.exactRequest.inputProofIds.filter((proofId) => proofId === proof.proofId).length !==
      1 ||
    reservationInput === undefined ||
    reservationInput.keysetId !== proof.keysetId ||
    reservationInput.curve !== proof.curve
  ) {
    throw new Error("browser CTF removal local terminal operation is foreign");
  }
  const rejection = readDurableCustodyVerifiedLosingMintRejection({
    record,
    exactRejection,
    exactAuthority,
  });
  if (
    rejection.operationId !== operationId ||
    rejection.normalizedMint !== proof.normalizedMint ||
    rejection.code !== ORACLE_NOT_ATTESTED_OUTCOME_CODE
  ) {
    throw new Error("browser CTF removal local terminal rejection is foreign");
  }
}

async function requireProofReconciliationFence(
  database: BitcasterDB,
  proof: BrowserCustodyProofRow,
  authority: BrowserProofBackupAuthorityRow,
): Promise<void> {
  if (proof.reservationOperationId !== null) {
    throw new Error("browser CTF removal proof is reserved");
  }
  if (await database.custodyReservations.get([proof.scopeId, proof.proofId])) {
    throw new Error("browser CTF removal proof reservation conflicts");
  }
  const operationId = authority.admissionOperationId;
  if (operationId === null) return;
  const [operationRow, activeWork] = await Promise.all([
    database.custodyOperations.get([proof.scopeId, operationId]),
    database.custodyActiveWork.get([proof.scopeId, operationId]),
  ]);
  if (activeWork !== undefined) throw new Error("browser CTF removal unfinished custody work");
  if (operationRow === undefined) return;
  const record = decodeDurableCustodyRecord(operationRow.record);
  if (
    record.scope.scopeId !== proof.scopeId ||
    record.operation.operationId !== operationId ||
    operationRow.scopeId !== proof.scopeId ||
    operationRow.operationId !== operationId ||
    operationRow.revision !== record.revision ||
    operationRow.operationState !== record.operation.state ||
    operationRow.nextAttemptAtMs !== record.operation.retry.nextAttemptAtMs ||
    !record.operation.proofStorage.lineage.successorProofIds.includes(proof.proofId) ||
    (record.operation.proofStorage.lineage.successorAdmission !== null &&
      !record.operation.proofStorage.lineage.successorAdmission.proofRows.some(
        ({ proofId }) => proofId === proof.proofId,
      ))
  ) {
    throw new Error("browser CTF removal creator operation is foreign");
  }
  if (classifyDurableCustodyActiveWork(record) !== "none") {
    throw new Error("browser CTF removal unfinished custody work");
  }
}

async function removeLegacyCacheRows(
  database: BitcasterDB,
  proofs: readonly BrowserCustodyProofRow[],
  authorities: ReadonlyMap<string, BrowserProofBackupAuthorityRow>,
): Promise<void> {
  const rows = await database.proofs.bulkGet(
    proofs.map((proof) => storedProofFromCustodyRow(proof).secret),
  );
  const secrets: string[] = [];
  for (const [index, raw] of rows.entries()) {
    if (raw === undefined) continue;
    const proof = proofs[index]!;
    const cached = storedProofFromRow(raw);
    const expected = storedProofFromCustodyRow(proof);
    if (
      cached.mintUrl !== expected.mintUrl ||
      cached.unit !== expected.unit ||
      cached.id !== expected.id ||
      cached.C !== expected.C ||
      Number(cached.amount) !== Number(expected.amount) ||
      cached.conditionId !== expected.conditionId ||
      cached.outcomeCollection !== expected.outcomeCollection ||
      deriveDurableCustodyArtifactFingerprint(serializeDurableCustodyProofArtifact(cached)) !==
        proof.proofFingerprint
    ) {
      throw new Error("browser CTF removal legacy cache conflicts");
    }
    if (cached.reservedBy !== undefined) throw new Error("browser CTF removal cache is reserved");
    const authority = authorities.get(proof.proofId);
    if (
      cached.terminalOperationId !== undefined &&
      authority?.terminalAuthority?.kind !== "local-operation"
    ) {
      throw new Error("browser CTF removal cache terminal authority conflicts");
    }
    secrets.push(raw.secret);
  }
  if (secrets.length > 0) await database.proofs.bulkDelete(secrets);
}

function removalTables(database: BitcasterDB) {
  return [
    database.custodyProofs,
    database.custodyProofBackupAuthorities,
    database.custodyReservations,
    database.custodyOperations,
    database.custodyArtifacts,
    database.custodyActiveWork,
    database.proofs,
  ] as const;
}

function removalAsset(asset: EncryptedWalletBackupV2AssetIdentity): {
  readonly conditionId: string;
  readonly outcomeCollectionId: string;
} {
  const parts = asset.assetIdentity.split(":");
  if (
    parts.length !== 3 ||
    parts[0] !== "ctf" ||
    !/^[0-9a-f]{64}$/.test(parts[1]!) ||
    !/^[0-9a-f]{64}$/.test(parts[2]!)
  ) {
    throw new Error("browser CTF local removal asset is invalid");
  }
  return { conditionId: parts[1]!, outcomeCollectionId: parts[2]! };
}

function requireExactRemovalTargets(
  targets: readonly BrowserCtfRemoveTarget[],
  proofs: readonly BrowserCustodyProofRow[],
): void {
  const proofsById = new Map(proofs.map((proof) => [proof.proofId, proof]));
  if (
    targets.length !== proofs.length ||
    targets.some((target) => {
      const proof = proofsById.get(target.proofId);
      return (
        proof === undefined ||
        proof.proofFingerprint !== target.proofFingerprint ||
        proof.revision !== target.proofRevision
      );
    })
  ) {
    throw new Error("browser CTF removal caller proof tuples are stale");
  }
}

function sortedRemoveTargets(
  value: readonly BrowserCtfRemoveTarget[],
): readonly BrowserCtfRemoveTarget[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PROOFS) {
    throw new Error("browser CTF removal proof set is invalid");
  }
  const targets = Array.from(value, (target) => {
    if (
      target === null ||
      typeof target !== "object" ||
      typeof target.proofId !== "string" ||
      !/^[0-9a-f]{64}$/.test(target.proofId) ||
      typeof target.proofFingerprint !== "string" ||
      !/^[0-9a-f]{64}$/.test(target.proofFingerprint) ||
      !Number.isSafeInteger(target.proofRevision) ||
      target.proofRevision < 0
    ) {
      throw new Error("browser CTF removal proof tuple is invalid");
    }
    return {
      proofId: target.proofId,
      proofFingerprint: target.proofFingerprint,
      proofRevision: target.proofRevision,
    };
  });
  targets.sort((left, right) =>
    left.proofId < right.proofId ? -1 : left.proofId > right.proofId ? 1 : 0,
  );
  if (
    targets.some((target, index) => index > 0 && targets[index - 1]!.proofId === target.proofId)
  ) {
    throw new Error("browser CTF removal proof set is duplicated");
  }
  return targets;
}

function requireRemoveIdentity(input: BrowserCtfRemoveInput): void {
  requireWalletScope(input.scopeId);
  if (!input.asset.assetIdentity.startsWith("ctf:") || input.asset.unit !== "msat") {
    throw new Error("browser CTF removal requires a CTF asset");
  }
}

function requireWalletScope(
  scopeId: string,
): Extract<DurableCustodyScope, { scopeKind: "wallet" }> {
  const scope = decodeDurableCustodyScopeInput(scopeId);
  if (scope.scopeKind !== "wallet") {
    throw new Error("browser CTF removal wallet scope is foreign");
  }
  return { ...scope, scopeId };
}

function requireCurrent(input: { readonly isCurrentProfile?: () => boolean }): void {
  if (input.isCurrentProfile?.() === false) throw new Error("browser CTF removal profile is stale");
}
