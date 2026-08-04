import type {
  EncryptedWalletBackupRestoreCurrentProofState,
  EncryptedWalletBackupRestoreProofRecord,
  EncryptedWalletBackupRestoreProofRow,
  EncryptedWalletBackupRestoreStore,
} from "@bitcaster/client-sdk/encryptedWalletBackup";
import { decodeDurableCustodyScopeId } from "@bitcaster/client-sdk/durableCustody";
import { decodeDurableWalletStorageClassification } from "@bitcaster/client-sdk/recoverableWalletStorage";
import { Amount } from "@cashu/cashu-ts";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import {
  createBrowserRemoteProofBackupAuthorityRow,
  requireBrowserProofBackupAuthorityForProof,
  type BrowserProofBackupAuthorityRow,
} from "./browser-proof-backup-authority";
import { createBrowserCustodyProofRow, decodeBrowserCustodyProofRow } from "./durable-custody-db";
import type { BrowserCustodyProofRow } from "./durable-custody-types";
import {
  BitcasterDB,
  type EncryptedWalletBackupDexieRestoreProofRow,
  type StoredProofRow,
} from "./proof-db";

const RESTORE_PROOF_BATCH_LIMIT = 64;

export interface BrowserEncryptedWalletBackupRestoreDatabaseProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
}

/** Persists one SDK-approved restored-proof page in one browser transaction. */
export class BrowserEncryptedWalletBackupRestoreDexieStore implements EncryptedWalletBackupRestoreStore {
  readonly #database: BitcasterDB;
  readonly #scopeId: string;

  constructor(profile: BrowserEncryptedWalletBackupRestoreDatabaseProfile) {
    requireProfile(profile);
    this.#database = profile.database;
    this.#scopeId = profile.scopeId;
  }

  async commitRestoredProofs<T>(
    input: Parameters<EncryptedWalletBackupRestoreStore["commitRestoredProofs"]>[0],
    commit: (current: readonly EncryptedWalletBackupRestoreCurrentProofState[]) => T,
  ): Promise<T> {
    const expected = requireExpected(input.expected, this.#scopeId);
    requireRestoreMode(input.restoreMode);
    requireCallback(commit);
    return this.#database.transaction("rw", restoreTables(this.#database), async () => {
      requireNotAborted(input.signal);
      const current = await this.#readCurrent(expected);
      const returned = commit(current);
      if (isThenable(returned))
        throw new Error("restored proof commit callback must be synchronous");
      requireNotAborted(input.signal);
      await this.#writeAccepted(expected, current);
      requireNotAborted(input.signal);
      return returned;
    });
  }

  async #readCurrent(
    expected: readonly RestoreCandidate[],
  ): Promise<readonly EncryptedWalletBackupRestoreCurrentProofState[]> {
    const keys = expected.map(({ proofId }) => [this.#scopeId, proofId] as [string, string]);
    const [restored, custody, reservations, authorities, classic] = await Promise.all([
      this.#database.encryptedWalletBackupRestoreProofs.bulkGet(keys),
      this.#database.custodyProofs.bulkGet(keys),
      this.#database.custodyReservations.bulkGet(keys),
      this.#database.custodyProofBackupAuthorities.bulkGet(keys),
      this.#database.proofs.bulkGet(expected.map(({ proof }) => proof.proof.secret)),
    ]);
    return expected.map((candidate, index) =>
      readCurrentCandidate({
        candidate,
        restored: restored[index],
        custody: custody[index],
        reservation: reservations[index],
        authority: authorities[index],
        classic: classic[index],
      }),
    );
  }

  async #writeAccepted(
    expected: readonly RestoreCandidate[],
    current: readonly EncryptedWalletBackupRestoreCurrentProofState[],
  ): Promise<void> {
    const changed = expected.filter(
      (candidate, index) => !sameRestoreState(current[index]!, candidate),
    );
    if (changed.length === 0) return;
    await this.#database.encryptedWalletBackupRestoreProofs.bulkPut(changed.map(toRestoreRow));
    await this.#database.proofs.bulkPut(changed.filter(isSelectable).map(({ classic }) => classic));
    await this.#database.custodyProofs.bulkPut(
      changed.filter(isSelectable).map(({ custody }) => custody),
    );
    await this.#database.custodyProofBackupAuthorities.bulkPut(
      changed.filter(isSelectable).map(({ authority }) => authority),
    );
    const retained = changed.filter((candidate) => !isSelectable(candidate));
    await this.#database.proofs.bulkDelete(retained.map(({ proof }) => proof.proof.secret));
    await this.#database.custodyProofs.bulkDelete(retained.map(toCustodyKey));
    await this.#database.custodyProofBackupAuthorities.bulkDelete(retained.map(toCustodyKey));
  }
}

interface RestoreCandidate extends EncryptedWalletBackupRestoreProofRow {
  readonly custody: BrowserCustodyProofRow;
  readonly classic: StoredProofRow;
  readonly authority: BrowserProofBackupAuthorityRow;
}

function restoreTables(database: BitcasterDB) {
  return [
    database.proofs,
    database.custodyProofs,
    database.custodyReservations,
    database.custodyProofBackupAuthorities,
    database.encryptedWalletBackupRestoreProofs,
  ];
}

function requireProfile(profile: BrowserEncryptedWalletBackupRestoreDatabaseProfile): void {
  if (
    typeof profile !== "object" ||
    profile === null ||
    !(profile.database instanceof BitcasterDB)
  ) {
    throw new Error("restored proof database profile is invalid");
  }
  const scopeId = decodeDurableCustodyScopeId(profile.scopeId);
  if (profile.database.name !== browserWalletDatabaseName(scopeId)) {
    throw new Error("restored proof database does not match the wallet scope");
  }
}

function requireExpected(
  rows: readonly EncryptedWalletBackupRestoreProofRow[],
  scopeId: string,
): readonly RestoreCandidate[] {
  if (!Array.isArray(rows) || rows.length > RESTORE_PROOF_BATCH_LIMIT) {
    throw new Error("restored proof batch exceeds the limit");
  }
  const identities = new Set<string>();
  return rows.map((row) => {
    const candidate = createRestoreCandidate(row, scopeId);
    if (identities.has(candidate.proofId)) throw new Error("restored proof batch is duplicated");
    identities.add(candidate.proofId);
    return candidate;
  });
}

function createRestoreCandidate(
  row: EncryptedWalletBackupRestoreProofRow,
  scopeId: string,
): RestoreCandidate {
  const storageClassification = decodeDurableWalletStorageClassification(row.storageClassification);
  const proof = requireRestoreProof(row.proof, row.proofId);
  if (
    storageClassification.recordId !== row.proofId ||
    storageClassification.recordKind !== "deterministic-proof" ||
    storageClassification.proofCommitment !== proof.proofCommitment
  ) {
    throw new Error("restored proof classification conflicts");
  }
  const custody = toCustodyProof(scopeId, proof);
  if (custody.proofId !== row.proofId) throw new Error("restored proof identifier conflicts");
  return {
    proofId: row.proofId,
    storageClassification,
    proof,
    custody,
    classic: toClassicProof(proof),
    authority: toBackupAuthority(custody, proof),
  };
}

function requireRestoreProof(
  proof: EncryptedWalletBackupRestoreProofRecord,
  proofId: string,
): EncryptedWalletBackupRestoreProofRecord {
  if (typeof proof !== "object" || proof === null || proof.proofId !== proofId) {
    throw new Error("restored proof body conflicts");
  }
  if (proof.unit !== "sat" && proof.unit !== "msat")
    throw new Error("restored proof unit is invalid");
  if (proof.proofKind === "ordinary" && proof.ctfMetadata !== null) {
    throw new Error("restored ordinary proof metadata conflicts");
  }
  if (proof.proofKind === "ctf" && proof.ctfMetadata === null) {
    throw new Error("restored CTF proof metadata is missing");
  }
  const proofBody = proof.proof as Record<string, unknown>;
  if ("p2pk_e" in proofBody || "witness" in proofBody) {
    throw new Error("restored proof contains unsupported spending authority");
  }
  return proof;
}

function toCustodyProof(
  scopeId: string,
  proof: EncryptedWalletBackupRestoreProofRecord,
): BrowserCustodyProofRow {
  return createBrowserCustodyProofRow({
    scopeId,
    normalizedMint: proof.mint,
    unit: requireBrowserUnit(proof.unit),
    proof: { ...proof.proof, amount: Amount.from(proof.proof.amount) },
    asset:
      proof.proofKind === "ordinary"
        ? { kind: "regular" }
        : {
            kind: "conditional",
            conditionId: proof.ctfMetadata!.conditionId,
            outcomeCollection: proof.ctfMetadata!.outcomeLabel,
          },
    receivedAtMs: proof.createdAtUnixSeconds * 1_000,
  });
}

function toClassicProof(proof: EncryptedWalletBackupRestoreProofRecord): StoredProofRow {
  return {
    ...proof.proof,
    amount: Number(proof.proof.amount),
    mintUrl: proof.mint,
    baseAsset: "sat",
    unit: requireBrowserUnit(proof.unit),
    receivedAt: proof.createdAtUnixSeconds * 1_000,
    ...(proof.ctfMetadata === null
      ? {}
      : {
          conditionId: proof.ctfMetadata.conditionId,
          outcomeCollection: proof.ctfMetadata.outcomeLabel,
        }),
  };
}

function toBackupAuthority(
  custody: BrowserCustodyProofRow,
  proof: EncryptedWalletBackupRestoreProofRecord,
): BrowserProofBackupAuthorityRow {
  return createBrowserRemoteProofBackupAuthorityRow({
    proof: custody,
    observedAtMs: proof.createdAtUnixSeconds * 1_000,
    derivationLocator: proof.derivationLocator,
    restoreProofId: proof.proofId,
    restoreProofCommitment: proof.proofCommitment,
  });
}

function requireBrowserUnit(value: string): "sat" | "msat" {
  if (value !== "sat" && value !== "msat") throw new Error("restored proof unit is invalid");
  return value;
}

function readCurrentCandidate(input: {
  readonly candidate: RestoreCandidate;
  readonly restored: EncryptedWalletBackupDexieRestoreProofRow | undefined;
  readonly custody: BrowserCustodyProofRow | undefined;
  readonly reservation: unknown;
  readonly authority: unknown;
  readonly classic: StoredProofRow | undefined;
}): EncryptedWalletBackupRestoreCurrentProofState {
  const { candidate, restored, custody, reservation, authority, classic } = input;
  if (reservation !== undefined) throw new Error("restored proof conflicts with browser authority");
  if (restored === undefined) {
    if (custody !== undefined || authority !== undefined || classic !== undefined) {
      throw new Error("restored proof conflicts with browser authority");
    }
    return { proofId: candidate.proofId, storageClassification: null, proof: null };
  }
  const current = decodeRestoreRow(restored, candidate.proofId, candidate.custody.scopeId);
  verifyCanonicalRows(current.proof, custody, authority, classic);
  return { proofId: candidate.proofId, ...current };
}

function decodeRestoreRow(
  row: EncryptedWalletBackupDexieRestoreProofRow,
  proofId: string,
  scopeId: string,
): Pick<EncryptedWalletBackupRestoreCurrentProofState, "storageClassification" | "proof"> {
  if (row.scopeId !== scopeId || row.proofId !== proofId) {
    throw new Error("stored restored proof identity conflicts");
  }
  const storageClassification = decodeDurableWalletStorageClassification(row.storageClassification);
  if (
    storageClassification.recordId !== proofId ||
    storageClassification.recordKind !== "deterministic-proof"
  ) {
    throw new Error("stored restored proof classification conflicts");
  }
  if (row.proof === null) return { storageClassification, proof: null };
  const proof = requireRestoreProof(row.proof, proofId);
  if (storageClassification.proofCommitment !== proof.proofCommitment) {
    throw new Error("stored restored proof classification conflicts");
  }
  return { storageClassification, proof };
}

function verifyCanonicalRows(
  current: EncryptedWalletBackupRestoreProofRecord | null,
  custody: BrowserCustodyProofRow | undefined,
  authority: unknown,
  classic: StoredProofRow | undefined,
): void {
  if (current === null) {
    if (custody !== undefined || authority !== undefined || classic !== undefined) {
      throw new Error("restored proof body conflicts");
    }
    return;
  }
  if (current.disposition === "user-retained-nonselectable") {
    if (custody !== undefined || authority !== undefined || classic !== undefined) {
      throw new Error("retained restored proof is selectable");
    }
    return;
  }
  if (custody === undefined || authority === undefined || classic === undefined) {
    throw new Error("restored proof body is incomplete");
  }
  const expectedCustody = toCustodyProof(custody.scopeId, current);
  const expectedAuthority = toBackupAuthority(expectedCustody, current);
  if (
    !sameCustody(custody, expectedCustody) ||
    !sameClassic(classic, toClassicProof(current)) ||
    !sameAuthority(authority, expectedCustody, expectedAuthority)
  ) {
    throw new Error("restored proof body conflicts");
  }
}

function sameRestoreState(
  current: EncryptedWalletBackupRestoreCurrentProofState,
  candidate: RestoreCandidate,
): boolean {
  return (
    current.storageClassification !== null &&
    current.proof !== null &&
    sameClassification(current.storageClassification, candidate.storageClassification) &&
    sameRestoreProof(current.proof, candidate.proof)
  );
}

function sameClassification(
  left: RestoreCandidate["storageClassification"],
  right: RestoreCandidate["storageClassification"],
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.recordId === right.recordId &&
    left.recordKind === right.recordKind &&
    left.storageClass === right.storageClass &&
    left.proofCommitment === right.proofCommitment &&
    left.purgeAfterMs === right.purgeAfterMs &&
    sameValues(left.pinReasons, right.pinReasons) &&
    sameValues(left.backupBinding, right.backupBinding)
  );
}

function sameRestoreProof(
  left: EncryptedWalletBackupRestoreProofRecord,
  right: EncryptedWalletBackupRestoreProofRecord,
): boolean {
  return (
    left.schemaVersion === right.schemaVersion &&
    left.realm === right.realm &&
    left.vaultId === right.vaultId &&
    left.generation === right.generation &&
    left.manifestDigest === right.manifestDigest &&
    left.parentGeneration === right.parentGeneration &&
    left.parentManifestDigest === right.parentManifestDigest &&
    left.chunkObjectId === right.chunkObjectId &&
    left.chunkDigest === right.chunkDigest &&
    left.proofId === right.proofId &&
    left.proofCommitment === right.proofCommitment &&
    left.mint === right.mint &&
    left.unit === right.unit &&
    left.proofKind === right.proofKind &&
    left.createdAtUnixSeconds === right.createdAtUnixSeconds &&
    left.updatedAtUnixSeconds === right.updatedAtUnixSeconds &&
    left.disposition === right.disposition &&
    left.nonselectableReason === right.nonselectableReason &&
    sameValues(left.derivationLocator, right.derivationLocator) &&
    sameValues(left.ctfMetadata, right.ctfMetadata) &&
    sameValues(left.terminalEvidence, right.terminalEvidence) &&
    sameProofBody(left.proof, right.proof)
  );
}

function sameProofBody(
  left: EncryptedWalletBackupRestoreProofRecord["proof"],
  right: EncryptedWalletBackupRestoreProofRecord["proof"],
): boolean {
  return (
    left.id === right.id &&
    left.amount === right.amount &&
    left.secret === right.secret &&
    left.C === right.C &&
    sameValues(left.dleq, right.dleq)
  );
}

function sameCustody(left: BrowserCustodyProofRow, right: BrowserCustodyProofRow): boolean {
  try {
    const decoded = decodeBrowserCustodyProofRow(left);
    return (
      decoded.scopeId === right.scopeId &&
      decoded.normalizedMint === right.normalizedMint &&
      decoded.unit === right.unit &&
      decoded.assetKind === right.assetKind &&
      decoded.conditionId === right.conditionId &&
      decoded.outcomeCollection === right.outcomeCollection &&
      decoded.baseAsset === right.baseAsset &&
      decoded.proofId === right.proofId &&
      decoded.keysetId === right.keysetId &&
      decoded.amount === right.amount &&
      decoded.proofFingerprint === right.proofFingerprint &&
      decoded.curve === right.curve &&
      decoded.dleqPresence === right.dleqPresence &&
      decoded.revision === right.revision &&
      decoded.selectability === right.selectability &&
      decoded.reservationOperationId === right.reservationOperationId &&
      decoded.receivedAtMs === right.receivedAtMs &&
      equalBytes(decoded.proofBody, right.proofBody)
    );
  } catch {
    throw new Error("stored custody proof conflicts");
  }
}

function sameAuthority(
  value: unknown,
  proof: BrowserCustodyProofRow,
  expected: BrowserProofBackupAuthorityRow,
): boolean {
  try {
    return sameValues(requireBrowserProofBackupAuthorityForProof(value, proof), expected);
  } catch {
    throw new Error("stored proof backup authority conflicts");
  }
}

function sameClassic(left: StoredProofRow, right: StoredProofRow): boolean {
  return (
    left.secret === right.secret &&
    left.id === right.id &&
    left.C === right.C &&
    left.amount === right.amount &&
    left.mintUrl === right.mintUrl &&
    left.reservedBy === right.reservedBy &&
    left.terminalOperationId === right.terminalOperationId &&
    left.conditionId === right.conditionId &&
    left.outcomeCollection === right.outcomeCollection &&
    left.marketId === right.marketId &&
    left.baseAsset === right.baseAsset &&
    left.unit === right.unit &&
    left.receivedAt === right.receivedAt &&
    sameValues(left.dleq, right.dleq) &&
    sameValues(left.p2pk_e, right.p2pk_e) &&
    sameValues(left.witness, right.witness)
  );
}

function sameValues(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameValues(item, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && sameValues(leftRecord[key], rightRecord[key]),
    )
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
  );
}

function toRestoreRow(candidate: RestoreCandidate): EncryptedWalletBackupDexieRestoreProofRow {
  return {
    scopeId: candidate.custody.scopeId,
    proofId: candidate.proofId,
    storageClassification: candidate.storageClassification,
    proof: candidate.proof,
  };
}

function toCustodyKey(candidate: RestoreCandidate): [string, string] {
  return [candidate.custody.scopeId, candidate.proofId];
}

function isSelectable(candidate: RestoreCandidate): boolean {
  return candidate.proof.disposition === "selectable";
}

function requireRestoreMode(value: unknown): void {
  if (value !== "complete-origin" && value !== "hydrate-existing") {
    throw new Error("restored proof mode is invalid");
  }
}

function requireCallback(
  value: unknown,
): asserts value is (current: readonly EncryptedWalletBackupRestoreCurrentProofState[]) => unknown {
  if (typeof value !== "function") throw new Error("restored proof commit callback is invalid");
}

function requireNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("restored proof commit is aborted");
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
