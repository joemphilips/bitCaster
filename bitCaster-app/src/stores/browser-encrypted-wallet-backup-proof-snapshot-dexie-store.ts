import {
  deriveEncryptedWalletBackupProofCommitment,
  verifyEncryptedWalletBackupConditionalKeyset,
  type EncryptedWalletBackupCommittedProofSnapshot,
  type EncryptedWalletBackupProofInput,
  type EncryptedWalletBackupRestoreProofRecord,
  type EncryptedWalletBackupProofSnapshotStore,
} from "@bitcaster/client-sdk/encryptedWalletBackup";
import {
  readVerifiedCtfLosingOutcomeEvidence,
  type AuthenticatedCtfRedeemTerminalEvidence,
} from "@bitcaster/client-sdk/ctfRedeem";
import type {
  CtfCommittedProofOperationStore,
  CtfProofOperationRecord,
} from "@bitcaster/client-sdk/ctfSplit";
import {
  classifyDurableCustodyActiveWork,
  isDurableCustodyProofReservationActive,
} from "@bitcaster/client-sdk/durableCustody";
import Dexie from "dexie";
import { browserWalletDatabaseName } from "../lib/browserWalletProfile";
import { decodeDurableCustodyRecord } from "@bitcaster/client-sdk/durableCustody";
import { decodeDurableCustodyProofMaterialRecord } from "@bitcaster/client-sdk/durableCustodyProofMaterial";
import { decodeDurableWalletStorageClassification } from "@bitcaster/client-sdk/recoverableWalletStorage";
import { decodeBrowserCustodyProofRow } from "./durable-custody-db";
import { requireBrowserProofBackupAuthorityForProof } from "./browser-proof-backup-authority";
import type {
  BrowserCustodyConditionalKeysetAuthority,
  BrowserCustodyConditionalKeysetRow,
} from "./durable-custody-types";
import { decodeBrowserCustodyConditionalKeysetRow } from "./durable-custody-types";
import type { BitcasterDB, EncryptedWalletBackupDexieRestoreProofRow } from "./proof-db";

/** At most 42 physical candidates. Each candidate can require six application rows. */
const PROOF_SNAPSHOT_PAGE_CANDIDATE_LIMIT = 42;
const PROOF_SNAPSHOT_PAGE_ROW_LIMIT = 256;
const PROOF_SNAPSHOT_PAGE_BYTES_LIMIT = 1024 * 1024;

export interface BrowserEncryptedWalletBackupProofSnapshotPage {
  readonly items: readonly BrowserEncryptedWalletBackupProofSnapshotPageItem[];
  readonly nextCursor: string | null;
}

/** Exact proof inputs that share the page transaction with their snapshot authority. */
export interface BrowserEncryptedWalletBackupProofSnapshotPageItem {
  readonly snapshot: EncryptedWalletBackupCommittedProofSnapshot;
  readonly proofInput: Pick<
    EncryptedWalletBackupProofInput,
    | "mint"
    | "unit"
    | "derivationLocator"
    | "proof"
    | "proofKind"
    | "ctfMetadata"
    | "terminalEvidence"
    | "createdAtUnixSeconds"
    | "updatedAtUnixSeconds"
  >;
}

export interface BrowserEncryptedWalletBackupProofSnapshotDatabaseProfile {
  readonly database: BitcasterDB;
  readonly scopeId: string;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
}

/** Reads one exact eligible proof snapshot from browser custody storage. */
export class BrowserEncryptedWalletBackupProofSnapshotDexieStore implements EncryptedWalletBackupProofSnapshotStore {
  readonly #database: BitcasterDB;
  readonly #scopeId: string;
  readonly #snapshotId: string;
  readonly #snapshotRevision: number;

  constructor(profile: BrowserEncryptedWalletBackupProofSnapshotDatabaseProfile) {
    requireProfile(profile);
    this.#database = profile.database;
    this.#scopeId = profile.scopeId;
    this.#snapshotId = profile.snapshotId;
    this.#snapshotRevision = profile.snapshotRevision;
  }

  async withCommittedProofSnapshot<T>(
    stableProofId: string,
    read: (row: EncryptedWalletBackupCommittedProofSnapshot) => T,
  ): Promise<T> {
    return this.#database.transaction(
      "r",
      [
        this.#database.custodyProofs,
        this.#database.custodyProofBackupAuthorities,
        this.#database.custodyOperations,
        this.#database.custodyReservations,
        this.#database.custodyConditionalKeysets,
        this.#database.proofOperations,
        this.#database.encryptedWalletBackupRestoreProofs,
      ],
      async () => {
        const row = await this.#read(stableProofId);
        const returned = read(row);
        if (isThenable(returned)) throw new Error("proof snapshot callback must be synchronous");
        return returned;
      },
    );
  }

  /**
   * Reads one indexed first-snapshot page in strict proof-id order.
   *
   * The byte count is the UTF-8 length of canonical JSON for the exact source
   * rows used by returned snapshots and the returned snapshots themselves.
   */
  async listEligibleCommittedProofSnapshotPage(
    exclusiveProofId: string | null,
  ): Promise<BrowserEncryptedWalletBackupProofSnapshotPage> {
    requireCursor(exclusiveProofId);
    return this.#database.transaction(
      "r",
      [
        this.#database.custodyProofs,
        this.#database.custodyProofBackupAuthorities,
        this.#database.custodyOperations,
        this.#database.custodyReservations,
        this.#database.custodyConditionalKeysets,
        this.#database.proofOperations,
        this.#database.encryptedWalletBackupRestoreProofs,
      ],
      () => this.#listPage(exclusiveProofId),
    );
  }

  async withEligibleCommittedProofSnapshotPage<T>(
    exclusiveProofId: string | null,
    read: (page: BrowserEncryptedWalletBackupProofSnapshotPage) => T,
  ): Promise<T> {
    requireCursor(exclusiveProofId);
    return this.#database.transaction(
      "r",
      [
        this.#database.custodyProofs,
        this.#database.custodyProofBackupAuthorities,
        this.#database.custodyOperations,
        this.#database.custodyReservations,
        this.#database.custodyConditionalKeysets,
        this.#database.proofOperations,
        this.#database.encryptedWalletBackupRestoreProofs,
      ],
      async () => {
        const page = await this.#listPage(exclusiveProofId);
        const returned = read(page);
        if (isThenable(returned)) {
          throw new Error("proof snapshot page callback must be synchronous");
        }
        return returned;
      },
    );
  }

  async #read(stableProofId: string): Promise<EncryptedWalletBackupCommittedProofSnapshot> {
    const [rawProof, rawAuthority, reservation, rawRestore] = await Promise.all([
      this.#database.custodyProofs.get([this.#scopeId, stableProofId]),
      this.#database.custodyProofBackupAuthorities.get([this.#scopeId, stableProofId]),
      this.#database.custodyReservations.get([this.#scopeId, stableProofId]),
      this.#database.encryptedWalletBackupRestoreProofs.get([this.#scopeId, stableProofId]),
    ]);
    const candidate = decodeCandidate(
      { rawProof, rawAuthority, reservation, rawRestore },
      this.#scopeId,
    );
    const conditional = await this.#conditionalEvidence(candidate.proof);
    if (candidate.remote !== null) {
      const terminalOperation = await this.#terminalOperation(candidate);
      const terminalEvidence = await this.#terminalEvidence(candidate, terminalOperation);
      return (
        createRemoteEligibleSnapshotItem({
          candidate,
          conditional,
          terminalEvidence,
          snapshotId: this.#snapshotId,
          snapshotRevision: this.#snapshotRevision,
        })?.snapshot ?? failMissingRemoteSuccessor(candidate)
      );
    }
    const operation = await this.#database.custodyOperations.get([
      this.#scopeId,
      localAdmissionOperationId(candidate),
    ]);
    const admission = decodeExactAdmission(operation, candidate);
    const terminalOperation = await this.#terminalOperation(candidate);
    const terminalEvidence = await this.#terminalEvidence(candidate, terminalOperation);
    return createEligibleSnapshotItem({
      candidate,
      admission,
      conditional,
      terminalEvidence,
      snapshotId: this.#snapshotId,
      snapshotRevision: this.#snapshotRevision,
    }).snapshot;
  }

  async #listPage(
    exclusiveProofId: string | null,
  ): Promise<BrowserEncryptedWalletBackupProofSnapshotPage> {
    const candidates = await this.#readPageCandidates(exclusiveProofId);
    const selected = selectPageCandidates(candidates);
    const joins = await this.#readPageJoins(selected.candidates);
    return this.#materializePage(exclusiveProofId, candidates, selected, joins);
  }

  async #readPageCandidates(exclusiveProofId: string | null): Promise<ProofSnapshotCandidate[]> {
    const lower: readonly unknown[] =
      exclusiveProofId === null ? [this.#scopeId, Dexie.minKey] : [this.#scopeId, exclusiveProofId];
    const authorities = await this.#database.custodyProofBackupAuthorities
      .where("[scopeId+proofId]")
      .between(lower, [this.#scopeId, Dexie.maxKey], exclusiveProofId === null, true)
      .limit(PROOF_SNAPSHOT_PAGE_CANDIDATE_LIMIT)
      .toArray();
    const proofIds = authorities.map(authorityProofId);
    const keys = proofIds.map((proofId) => [this.#scopeId, proofId] as [string, string]);
    const [proofs, reservations, restores] = await Promise.all([
      this.#database.custodyProofs.bulkGet(keys),
      this.#database.custodyReservations.bulkGet(keys),
      this.#database.encryptedWalletBackupRestoreProofs.bulkGet(keys),
    ]);
    const candidates = authorities.map((rawAuthority, index) =>
      decodeCandidate(
        {
          rawAuthority,
          rawProof: proofs[index],
          reservation: reservations[index],
          rawRestore: restores[index],
        },
        this.#scopeId,
      ),
    );
    return candidates;
  }

  async #readPageJoins(candidates: readonly ProofSnapshotCandidate[]) {
    const operationIds = new Set<string>();
    const terminalOperationIds = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.remote === null) operationIds.add(localAdmissionOperationId(candidate));
      if (candidate.authority.terminalOperationId !== null) {
        terminalOperationIds.add(candidate.authority.terminalOperationId);
      }
    }
    const operationKeys = [...operationIds].map(
      (operationId) => [this.#scopeId, operationId] as [string, string],
    );
    const terminalOperationKeys = [...terminalOperationIds];
    const keysetInputs = candidates
      .filter(({ proof }) => proof.assetKind === "conditional")
      .map(
        ({ proof }) =>
          [this.#scopeId, proof.normalizedMint, proof.unit, proof.keysetId] as [
            string,
            string,
            string,
            string,
          ],
      );
    const distinctKeysetInputs = deduplicateKeys(keysetInputs);
    const [operationRows, terminalOperationRows, keysetRows] = await Promise.all([
      this.#database.custodyOperations.bulkGet(operationKeys),
      this.#database.proofOperations.bulkGet(terminalOperationKeys),
      this.#database.custodyConditionalKeysets.bulkGet(distinctKeysetInputs),
    ]);
    return {
      operations: new Map(operationKeys.map((key, index) => [key[1], operationRows[index]])),
      terminalOperations: new Map(
        terminalOperationKeys.map((operationId, index) => [
          operationId,
          terminalOperationRows[index],
        ]),
      ),
      keysets: new Map(
        distinctKeysetInputs.map((key, index) => [key.slice(1).join("\u0000"), keysetRows[index]]),
      ),
    };
  }

  /** Candidate rows are capped at 64. The byte limit covers returned page rows and distinct joins. */
  async #materializePage(
    exclusiveProofId: string | null,
    candidates: readonly ProofSnapshotCandidate[],
    selected: PageCandidateSelection,
    joins: PageJoins,
  ): Promise<BrowserEncryptedWalletBackupProofSnapshotPage> {
    const items: BrowserEncryptedWalletBackupProofSnapshotPageItem[] = [];
    const verifiedKeysets = verifyDistinctPageKeysets(selected.candidates, joins.keysets);
    let bytes = 0;
    const consumedOperations = new Set<string>();
    const consumedTerminalOperations = new Set<string>();
    const consumedKeysets = new Set<string>();
    let cursor = exclusiveProofId;
    for (const candidate of selected.candidates) {
      const operationId = candidate.remote === null ? localAdmissionOperationId(candidate) : null;
      const terminalOperationId = candidate.authority.terminalOperationId;
      const key = candidate.proof.assetKind === "conditional" ? keysetKey(candidate.proof) : null;
      const candidateRows = [
        candidate.authority,
        candidate.proof,
        candidate.reservation,
        ...(candidate.remote === null ? [] : [candidate.remote]),
        ...(candidate.remote === null && !consumedOperations.has(operationId!)
          ? [joins.operations.get(operationId!)]
          : []),
        ...(terminalOperationId === null || consumedTerminalOperations.has(terminalOperationId)
          ? []
          : [joins.terminalOperations.get(terminalOperationId)]),
        ...(key === null || consumedKeysets.has(key) ? [] : [joins.keysets.get(key)]),
      ];
      const conditional =
        candidate.proof.assetKind === "regular"
          ? await this.#conditionalEvidence(candidate.proof)
          : verifiedKeysets.get(key!)!;
      const item =
        candidate.remote !== null
          ? createRemoteEligibleSnapshotItem({
              candidate,
              conditional,
              terminalEvidence: await this.#terminalEvidence(
                candidate,
                terminalOperationId === null
                  ? undefined
                  : joins.terminalOperations.get(terminalOperationId),
              ),
              snapshotId: this.#snapshotId,
              snapshotRevision: this.#snapshotRevision,
            })
          : createLocalEligibleSnapshotItem({
              candidate,
              admission: decodeExactAdmission(joins.operations.get(operationId!), candidate),
              conditional,
              terminalEvidence: await this.#terminalEvidence(
                candidate,
                terminalOperationId === null
                  ? undefined
                  : joins.terminalOperations.get(terminalOperationId),
              ),
              snapshotId: this.#snapshotId,
              snapshotRevision: this.#snapshotRevision,
            });
      const nextBytes =
        bytes + canonicalBytes(candidateRows) + (item === null ? 0 : canonicalBytes(item));
      if (nextBytes > PROOF_SNAPSHOT_PAGE_BYTES_LIMIT) {
        if (cursor === exclusiveProofId)
          throw new Error("proof snapshot candidate exceeds the page byte limit");
        return { items, nextCursor: cursor };
      }
      bytes = nextBytes;
      cursor = candidate.proof.proofId;
      if (operationId !== null) consumedOperations.add(operationId);
      if (terminalOperationId !== null) consumedTerminalOperations.add(terminalOperationId);
      if (key !== null) consumedKeysets.add(key);
      if (item !== null) items.push(item);
    }
    return {
      items,
      nextCursor:
        selected.hasDeferred || candidates.length === PROOF_SNAPSHOT_PAGE_CANDIDATE_LIMIT
          ? cursor
          : null,
    };
  }

  async #conditionalEvidence(
    proof: ReturnType<typeof decodeBrowserCustodyProofRow>,
  ): Promise<ConditionalEvidence | null> {
    if (proof.assetKind === "regular") {
      if (proof.conditionId !== null || proof.outcomeCollection !== null) {
        throw new Error("ordinary proof has conditional authority");
      }
      return null;
    }
    const keyset = await this.#database.custodyConditionalKeysets.get([
      this.#scopeId,
      proof.normalizedMint,
      proof.unit,
      proof.keysetId,
    ]);
    return verifyStoredConditionalKeyset(keyset, proof);
  }

  async #terminalOperation(candidate: ProofSnapshotCandidate): Promise<unknown> {
    const operationId = candidate.authority.terminalOperationId;
    return operationId === null ? undefined : this.#database.proofOperations.get(operationId);
  }

  async #terminalEvidence(
    candidate: ProofSnapshotCandidate,
    operation: unknown,
  ): Promise<AuthenticatedCtfRedeemTerminalEvidence | null> {
    const operationId = candidate.authority.terminalOperationId;
    if (operationId === null) return null;
    if (candidate.proof.assetKind !== "conditional") {
      throw new Error("ordinary proof cannot have a CTF terminal operation");
    }
    const proof = decodeDurableCustodyProofMaterialRecord(candidate.proof).proof;
    return readVerifiedCtfLosingOutcomeEvidence({
      store: exactCommittedOperationStore(operationId, operation),
      operationId,
      proof,
    });
  }
}

function verifyDistinctPageKeysets(
  candidates: readonly ProofSnapshotCandidate[],
  keysets: ReadonlyMap<string, BrowserCustodyConditionalKeysetRow | undefined>,
): ReadonlyMap<string, ConditionalEvidence> {
  const verified = new Map<string, ConditionalEvidence>();
  for (const candidate of candidates) {
    if (candidate.proof.assetKind !== "conditional") continue;
    const key = keysetKey(candidate.proof);
    if (!verified.has(key)) {
      verified.set(key, verifyStoredConditionalKeyset(keysets.get(key), candidate.proof));
    }
  }
  return verified;
}

function verifyStoredConditionalKeyset(
  value: BrowserCustodyConditionalKeysetRow | undefined,
  proof: ReturnType<typeof decodeBrowserCustodyProofRow>,
): {
  readonly evidence: ReturnType<typeof verifyEncryptedWalletBackupConditionalKeyset>;
  readonly tuple: Pick<
    BrowserCustodyConditionalKeysetAuthority,
    "outcomeCollectionId" | "registeredAtUnixSeconds" | "finalExpiryUnixSeconds"
  >;
} {
  const decoded = value === undefined ? undefined : decodeBrowserCustodyConditionalKeysetRow(value);
  if (
    !decoded ||
    decoded.normalizedMint !== proof.normalizedMint ||
    decoded.unit !== proof.unit ||
    decoded.keysetId !== proof.keysetId ||
    decoded.conditionId !== proof.conditionId ||
    decoded.outcomeCollection !== proof.outcomeCollection ||
    decoded.curve !== proof.curve
  ) {
    throw new Error("conditional keyset authority is missing or foreign");
  }
  const evidence = verifyEncryptedWalletBackupConditionalKeyset({
    mint: decoded.normalizedMint,
    unit: decoded.unit,
    outcomeLabel: decoded.outcomeCollection,
    registeredAtUnixSeconds: decoded.registeredAtUnixSeconds,
    mintKeys: {
      id: decoded.keysetId,
      unit: decoded.unit,
      keys: decoded.denominationPublicKeys,
      input_fee_ppk: decoded.inputFeePpk,
      final_expiry: decoded.finalExpiryUnixSeconds,
      conditional: {
        conditionId: decoded.conditionId,
        outcomeCollection: decoded.outcomeCollection,
        outcomeCollectionId: decoded.outcomeCollectionId,
        registeredAt: decoded.registeredAtUnixSeconds,
      },
    },
    conditionalMetadata: {
      conditionId: decoded.conditionId,
      outcomeCollection: decoded.outcomeCollection,
      outcomeCollectionId: decoded.outcomeCollectionId,
      registeredAt: decoded.registeredAtUnixSeconds,
    },
  });
  return {
    evidence,
    tuple: {
      outcomeCollectionId: decoded.outcomeCollectionId,
      registeredAtUnixSeconds: decoded.registeredAtUnixSeconds,
      finalExpiryUnixSeconds: decoded.finalExpiryUnixSeconds,
    },
  };
}

interface ProofSnapshotCandidate {
  readonly proof: ReturnType<typeof decodeBrowserCustodyProofRow>;
  readonly authority: ReturnType<typeof requireBrowserProofBackupAuthorityForProof>;
  readonly reservation: { readonly operationId: string } | null;
  /** Exact indexed restore row. It is source data and part of page accounting. */
  readonly remote: EncryptedWalletBackupDexieRestoreProofRow | null;
}

interface PageCandidateSelection {
  readonly candidates: readonly ProofSnapshotCandidate[];
  readonly hasDeferred: boolean;
}

interface PageJoins {
  readonly operations: ReadonlyMap<string, unknown>;
  readonly terminalOperations: ReadonlyMap<string, unknown>;
  readonly keysets: ReadonlyMap<string, BrowserCustodyConditionalKeysetRow | undefined>;
}

function selectPageCandidates(
  candidates: readonly ProofSnapshotCandidate[],
): PageCandidateSelection {
  const selected: ProofSnapshotCandidate[] = [];
  const operationIds = new Set<string>();
  const terminalOperationIds = new Set<string>();
  const conditionalKeys = new Set<string>();
  let rows = candidates.reduce(
    (total, candidate) => total + 3 + (candidate.remote === null ? 0 : 1),
    0,
  );
  for (const candidate of candidates) {
    const operationId = candidate.remote === null ? localAdmissionOperationId(candidate) : null;
    const operationAdded = operationId === null || operationIds.has(operationId) ? 0 : 1;
    const terminalOperationId = candidate.authority.terminalOperationId;
    const terminalOperationAdded =
      terminalOperationId !== null && !terminalOperationIds.has(terminalOperationId) ? 1 : 0;
    const key = candidate.proof.assetKind === "conditional" ? keysetKey(candidate.proof) : null;
    const keysetAdded = key !== null && !conditionalKeys.has(key) ? 1 : 0;
    if (
      rows + operationAdded + terminalOperationAdded + keysetAdded >
      PROOF_SNAPSHOT_PAGE_ROW_LIMIT
    ) {
      break;
    }
    rows += operationAdded + terminalOperationAdded + keysetAdded;
    if (operationId !== null) operationIds.add(operationId);
    if (terminalOperationId !== null) terminalOperationIds.add(terminalOperationId);
    if (key !== null) conditionalKeys.add(key);
    selected.push(candidate);
  }
  if (selected.length === 0 && candidates.length > 0) {
    throw new Error("proof snapshot candidate exceeds the page row limit");
  }
  return { candidates: selected, hasDeferred: selected.length < candidates.length };
}

function decodeCandidate(
  input: {
    readonly rawProof: unknown;
    readonly rawAuthority: unknown;
    readonly reservation: unknown;
    readonly rawRestore: unknown;
  },
  scopeId: string,
): ProofSnapshotCandidate {
  if (input.rawProof === undefined || input.rawAuthority === undefined) {
    throw new Error("proof snapshot authority is missing");
  }
  const proof = decodeBrowserCustodyProofRow(input.rawProof);
  const authority = requireBrowserProofBackupAuthorityForProof(input.rawAuthority, proof);
  if (proof.scopeId !== scopeId || authority.scopeId !== scopeId) {
    throw new Error("proof snapshot authority is foreign");
  }
  const reservation = decodeReservation(input.reservation, scopeId, proof.proofId);
  if (
    (reservation === null) !== (proof.reservationOperationId === null) ||
    (reservation !== null && reservation.operationId !== proof.reservationOperationId)
  ) {
    throw new Error("proof snapshot reservation authority is stale");
  }
  return {
    proof,
    authority,
    reservation,
    remote:
      authority.backupState === "remote-backed"
        ? decodeRemoteRestore(input.rawRestore, proof, authority)
        : null,
  };
}

function localAdmissionOperationId(candidate: ProofSnapshotCandidate): string {
  if (
    candidate.authority.backupState !== "local-only" ||
    candidate.authority.admissionOperationId === null
  ) {
    throw new Error("remote-backed proof has no local admission operation");
  }
  return candidate.authority.admissionOperationId;
}

function decodeRemoteRestore(
  value: unknown,
  proof: ReturnType<typeof decodeBrowserCustodyProofRow>,
  authority: ReturnType<typeof requireBrowserProofBackupAuthorityForProof>,
): EncryptedWalletBackupDexieRestoreProofRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("remote-backed proof restore authority is missing");
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 4 ||
    !["scopeId", "proofId", "storageClassification", "proof"].every((field) => field in row)
  ) {
    throw new Error("remote-backed proof restore authority is foreign");
  }
  const classification = decodeDurableWalletStorageClassification(row.storageClassification);
  const restore = row.proof as EncryptedWalletBackupRestoreProofRecord | null;
  if (
    row.scopeId !== proof.scopeId ||
    row.proofId !== proof.proofId ||
    restore === null ||
    typeof restore !== "object" ||
    restore.proofId !== proof.proofId ||
    restore.disposition !== "selectable" ||
    restore.nonselectableReason !== null ||
    restore.terminalEvidence !== null ||
    classification.recordId !== proof.proofId ||
    classification.recordKind !== "deterministic-proof" ||
    classification.storageClass !== "remotely-backed-deterministic-proof" ||
    classification.proofCommitment !== restore.proofCommitment ||
    authority.backupRecordId !== proof.proofId ||
    authority.backupRecordCommitment !== restore.proofCommitment ||
    authority.recordCreatedAtUnixSeconds !== restore.createdAtUnixSeconds ||
    (authority.terminalOperationId === null &&
      authority.recordUpdatedAtUnixSeconds !== restore.updatedAtUnixSeconds) ||
    (authority.terminalOperationId !== null &&
      authority.recordUpdatedAtUnixSeconds < restore.updatedAtUnixSeconds) ||
    !sameSnapshotValue(authority.derivationLocator, restore.derivationLocator) ||
    !sameRemoteProofBody(proof, restore)
  ) {
    throw new Error("remote-backed proof restore authority is foreign");
  }
  return row as unknown as EncryptedWalletBackupDexieRestoreProofRow;
}

function sameRemoteProofBody(
  proof: ReturnType<typeof decodeBrowserCustodyProofRow>,
  restore: EncryptedWalletBackupRestoreProofRecord,
): boolean {
  const body = decodeDurableCustodyProofMaterialRecord(proof).proof;
  return (
    proof.normalizedMint === restore.mint &&
    proof.unit === restore.unit &&
    body.id === restore.proof.id &&
    body.amount === restore.proof.amount &&
    body.secret === restore.proof.secret &&
    body.C === restore.proof.C &&
    sameSnapshotValue(body.dleq, restore.proof.dleq ?? null)
  );
}

function sameSnapshotValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameSnapshotValue(item, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameSnapshotValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function decodeReservation(
  value: unknown,
  scopeId: string,
  proofId: string,
): { readonly operationId: string } | null {
  if (value === undefined) return null;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("proof snapshot reservation authority is invalid");
  }
  const row = value as Record<string, unknown>;
  const fields = ["scopeId", "proofId", "operationId", "reservationId", "inputPosition"];
  if (
    Object.keys(row).length !== fields.length ||
    fields.some((field) => !(field in row)) ||
    row.scopeId !== scopeId ||
    row.proofId !== proofId ||
    !validText(row.operationId) ||
    !validText(row.reservationId) ||
    !Number.isSafeInteger(row.inputPosition) ||
    (row.inputPosition as number) < 0
  ) {
    throw new Error("proof snapshot reservation authority is invalid");
  }
  return { operationId: row.operationId };
}

function decodeExactAdmission(value: unknown, candidate: ProofSnapshotCandidate) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("proof admission operation is missing");
  }
  const row = value as Record<string, unknown>;
  const fields = [
    "scopeId",
    "operationId",
    "revision",
    "operationState",
    "nextAttemptAtMs",
    "estimatedBytes",
    "record",
  ];
  if (
    Object.keys(row).length !== fields.length ||
    fields.some((field) => !(field in row)) ||
    row.scopeId !== candidate.proof.scopeId ||
    row.operationId !== candidate.authority.admissionOperationId
  ) {
    throw new Error("proof admission operation is foreign");
  }
  let record: ReturnType<typeof decodeDurableCustodyRecord>;
  try {
    record = decodeDurableCustodyRecord(row.record);
  } catch {
    throw new Error("proof admission operation is not terminal");
  }
  const admission = record.operation.proofStorage.lineage.successorAdmission;
  if (
    row.revision !== record.revision ||
    row.operationState !== record.operation.state ||
    row.nextAttemptAtMs !== record.operation.retry.nextAttemptAtMs ||
    !Number.isSafeInteger(row.estimatedBytes) ||
    (row.estimatedBytes as number) < 1 ||
    record.scope.scopeId !== candidate.proof.scopeId ||
    record.operation.operationId !== candidate.authority.admissionOperationId ||
    record.operation.state !== "reconciled" ||
    record.operation.result.state !== "applied" ||
    admission === null ||
    admission.scopeId !== candidate.proof.scopeId ||
    admission.operationId !== candidate.authority.admissionOperationId ||
    !admission.proofRows.some(({ proofId }) => proofId === candidate.proof.proofId)
  ) {
    throw new Error("proof admission operation is not terminal");
  }
  return record;
}

function isFirstSnapshotEligible(
  candidate: ProofSnapshotCandidate,
  admission: ReturnType<typeof decodeDurableCustodyRecord>,
): boolean {
  const proofBody = decodeDurableCustodyProofMaterialRecord(candidate.proof).proof;
  return (
    candidate.proof.selectability === "selectable" &&
    candidate.reservation === null &&
    candidate.authority.derivationLocator !== null &&
    proofBody.id === candidate.proof.keysetId &&
    proofBody.witness === null &&
    proofBody.p2pkE === null &&
    !hasEffectiveProofPin(admission) &&
    classifyDurableCustodyActiveWork(admission) === "none"
  );
}

function createLocalEligibleSnapshotItem(input: {
  readonly candidate: ProofSnapshotCandidate;
  readonly admission: ReturnType<typeof decodeDurableCustodyRecord>;
  readonly conditional: ConditionalEvidence | null;
  readonly terminalEvidence: AuthenticatedCtfRedeemTerminalEvidence | null;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
}): BrowserEncryptedWalletBackupProofSnapshotPageItem | null {
  return isFirstSnapshotEligible(input.candidate, input.admission)
    ? createEligibleSnapshotItem(input)
    : null;
}

function createRemoteEligibleSnapshotItem(input: {
  readonly candidate: ProofSnapshotCandidate;
  readonly conditional: ConditionalEvidence | null;
  readonly terminalEvidence: AuthenticatedCtfRedeemTerminalEvidence | null;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
}): BrowserEncryptedWalletBackupProofSnapshotPageItem | null {
  const remote = input.candidate.remote;
  if (remote === null || remote.proof === null) {
    throw new Error("remote-backed proof snapshot is not eligible");
  }
  const restore = remote.proof;
  if (input.candidate.proof.selectability === "spent") return null;
  if (
    input.candidate.proof.selectability !== "selectable" &&
    input.candidate.proof.selectability !== "locked"
  ) {
    throw new Error("remote-backed proof snapshot state is invalid");
  }
  if (
    (input.candidate.proof.selectability === "locked") !==
    (input.candidate.reservation !== null)
  ) {
    throw new Error("remote-backed proof snapshot reservation is stale");
  }
  const ctfMetadata = remoteCtfMetadata(input.candidate, restore, input.conditional);
  if (
    (input.candidate.authority.terminalOperationId === null) !==
    (input.terminalEvidence === null)
  ) {
    throw new Error("remote-backed proof terminal authority is stale");
  }
  const committed = deriveEncryptedWalletBackupProofCommitment({
    scopeId: input.candidate.proof.scopeId,
    mint: restore.mint,
    unit: restore.unit,
    derivationLocator: restore.derivationLocator,
    proof: restore.proof,
    proofKind: restore.proofKind,
    ctfMetadata,
    terminalEvidence: input.terminalEvidence,
    createdAtUnixSeconds: input.candidate.authority.recordCreatedAtUnixSeconds,
    updatedAtUnixSeconds: input.candidate.authority.recordUpdatedAtUnixSeconds,
  });
  if (committed.proofId !== restore.proofId) {
    throw new Error("remote-backed proof commitment is foreign");
  }
  if (
    input.candidate.authority.terminalOperationId === null &&
    committed.commitment !== restore.proofCommitment
  ) {
    throw new Error("remote-backed proof commitment is foreign");
  }
  const snapshot = Object.freeze({
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    revision: input.snapshotRevision,
    proofId: restore.proofId,
    proofCommitment: committed.commitment,
    proofKind: restore.proofKind,
    ctfMetadata,
    terminalOperationId: input.candidate.authority.terminalOperationId,
    conditionalKeysetEvidence: input.conditional?.evidence ?? null,
    provenance: "wallet-seed",
    operationBinding: "terminally-unlinked",
    reserved: false,
    ambiguousMintOperation: false,
    proofPins: absentPins(),
    derivationLocator: restore.derivationLocator,
  });
  return Object.freeze({
    snapshot,
    proofInput: Object.freeze({
      mint: restore.mint,
      unit: restore.unit,
      derivationLocator: restore.derivationLocator,
      proof: Object.freeze({ ...restore.proof }),
      proofKind: restore.proofKind,
      ctfMetadata,
      terminalEvidence: input.terminalEvidence,
      createdAtUnixSeconds: input.candidate.authority.recordCreatedAtUnixSeconds,
      updatedAtUnixSeconds: input.candidate.authority.recordUpdatedAtUnixSeconds,
    }),
  });
}

function failMissingRemoteSuccessor(candidate: ProofSnapshotCandidate): never {
  if (candidate.proof.selectability === "spent") {
    throw new Error("spent remote-backed proof requires a successor snapshot page");
  }
  throw new Error("remote-backed proof snapshot is not eligible");
}

function remoteCtfMetadata(
  candidate: ProofSnapshotCandidate,
  restore: EncryptedWalletBackupRestoreProofRecord,
  conditional: ConditionalEvidence | null,
) {
  if (restore.proofKind === "ordinary") {
    if (
      restore.ctfMetadata !== null ||
      conditional !== null ||
      candidate.proof.assetKind !== "regular"
    ) {
      throw new Error("remote-backed ordinary proof metadata is foreign");
    }
    return null;
  }
  if (
    restore.ctfMetadata === null ||
    conditional === null ||
    candidate.proof.assetKind !== "conditional"
  ) {
    throw new Error("remote-backed CTF proof metadata is foreign");
  }
  if (
    restore.ctfMetadata.conditionId !== candidate.proof.conditionId ||
    restore.ctfMetadata.outcomeLabel !== candidate.proof.outcomeCollection ||
    restore.ctfMetadata.outcomeCollectionId !== conditional.tuple.outcomeCollectionId ||
    restore.ctfMetadata.registeredAtUnixSeconds !== conditional.tuple.registeredAtUnixSeconds ||
    restore.ctfMetadata.finalExpiryUnixSeconds !== conditional.tuple.finalExpiryUnixSeconds
  ) {
    throw new Error("remote-backed CTF proof metadata is foreign");
  }
  return restore.ctfMetadata;
}

function hasEffectiveProofPin(admission: ReturnType<typeof decodeDurableCustodyRecord>): boolean {
  return admission.operation.proofStorage.pinReasons.some(
    (pin) => pin !== "active-reservation" || isDurableCustodyProofReservationActive(admission),
  );
}

function createEligibleSnapshotItem(input: {
  readonly candidate: ProofSnapshotCandidate;
  readonly admission: ReturnType<typeof decodeDurableCustodyRecord>;
  readonly conditional: ConditionalEvidence | null;
  readonly terminalEvidence: AuthenticatedCtfRedeemTerminalEvidence | null;
  readonly snapshotId: string;
  readonly snapshotRevision: number;
}): BrowserEncryptedWalletBackupProofSnapshotPageItem {
  if (!isFirstSnapshotEligible(input.candidate, input.admission)) {
    throw new Error("proof snapshot is not eligible");
  }
  const { proof, authority } = input.candidate;
  const proofBody = decodeDurableCustodyProofMaterialRecord(proof).proof;
  const proofKind = proof.assetKind === "regular" ? "ordinary" : "ctf";
  const ctfMetadata =
    input.conditional === null
      ? null
      : {
          conditionId: proof.conditionId!,
          outcomeLabel: proof.outcomeCollection!,
          outcomeCollectionId: input.conditional.tuple.outcomeCollectionId,
          registeredAtUnixSeconds: input.conditional.tuple.registeredAtUnixSeconds,
          finalExpiryUnixSeconds: input.conditional.tuple.finalExpiryUnixSeconds,
        };
  const committed = deriveEncryptedWalletBackupProofCommitment({
    scopeId: proof.scopeId,
    mint: proof.normalizedMint,
    unit: proof.unit,
    derivationLocator: authority.derivationLocator!,
    proof: {
      id: proofBody.id,
      amount: proofBody.amount,
      secret: proofBody.secret,
      C: proofBody.C,
      ...(proofBody.dleq === null || proofBody.dleq === undefined
        ? {}
        : { dleq: proofBody.dleq as { e: string; s: string; r: string } }),
    },
    proofKind,
    ctfMetadata,
    terminalEvidence: input.terminalEvidence,
    createdAtUnixSeconds: authority.recordCreatedAtUnixSeconds,
    updatedAtUnixSeconds: authority.recordUpdatedAtUnixSeconds,
  });
  if (committed.proofId !== proof.proofId) {
    throw new Error("proof snapshot derivation authority is foreign");
  }
  const snapshot = Object.freeze({
    schemaVersion: 1,
    snapshotId: input.snapshotId,
    revision: input.snapshotRevision,
    proofId: proof.proofId,
    proofCommitment: committed.commitment,
    proofKind,
    ctfMetadata,
    terminalOperationId: authority.terminalOperationId,
    conditionalKeysetEvidence: input.conditional?.evidence ?? null,
    provenance: "wallet-seed",
    operationBinding: "terminally-unlinked",
    reserved: false,
    ambiguousMintOperation: false,
    proofPins: absentPins(),
    derivationLocator: authority.derivationLocator!,
  });
  return Object.freeze({
    snapshot,
    proofInput: Object.freeze({
      mint: proof.normalizedMint,
      unit: proof.unit,
      derivationLocator: authority.derivationLocator!,
      proof: Object.freeze({
        id: proofBody.id,
        amount: proofBody.amount,
        secret: proofBody.secret,
        C: proofBody.C,
        ...(proofBody.dleq === null || proofBody.dleq === undefined
          ? {}
          : { dleq: proofBody.dleq as { e: string; s: string; r: string } }),
      }),
      proofKind,
      ctfMetadata,
      terminalEvidence: input.terminalEvidence,
      createdAtUnixSeconds: authority.recordCreatedAtUnixSeconds,
      updatedAtUnixSeconds: authority.recordUpdatedAtUnixSeconds,
    }),
  });
}

function exactCommittedOperationStore(
  operationId: string,
  value: unknown,
): CtfCommittedProofOperationStore {
  return {
    async withCommittedProofOperation<T>(
      requestedOperationId: string,
      read: (operation: CtfProofOperationRecord) => T,
    ): Promise<T> {
      if (requestedOperationId !== operationId || !isRecord(value)) {
        throw new Error("CTF terminal operation is missing or foreign");
      }
      const returned = read(value as unknown as CtfProofOperationRecord);
      if (isThenable(returned)) {
        throw new Error("CTF terminal operation callback must be synchronous");
      }
      return returned;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function absentPins() {
  return {
    openOrderCollateral: "absent" as const,
    outbox: "absent" as const,
    retryCursor: "absent" as const,
    replayTombstone: "absent" as const,
    dependentWork: "absent" as const,
  };
}

interface ConditionalEvidence {
  readonly evidence: ReturnType<typeof verifyEncryptedWalletBackupConditionalKeyset>;
  readonly tuple: Pick<
    BrowserCustodyConditionalKeysetAuthority,
    "outcomeCollectionId" | "registeredAtUnixSeconds" | "finalExpiryUnixSeconds"
  >;
}

function authorityProofId(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("browser proof backup authority is invalid");
  }
  const proofId = (value as { proofId?: unknown }).proofId;
  if (typeof proofId !== "string" || !/^[0-9a-f]{64}$/.test(proofId)) {
    throw new Error("browser proof backup authority is invalid");
  }
  return proofId;
}

function keysetKey(proof: ReturnType<typeof decodeBrowserCustodyProofRow>): string {
  return [proof.normalizedMint, proof.unit, proof.keysetId].join("\u0000");
}

function canonicalBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).length;
}

function deduplicateKeys<T extends readonly string[]>(keys: readonly T[]): T[] {
  const distinct = new Map<string, T>();
  for (const key of keys) distinct.set(key.join("\u0000"), key);
  return [...distinct.values()];
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (value instanceof Uint8Array) return `{"$bytes":${JSON.stringify(bytesToHex(value))}}`;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  throw new Error("proof snapshot page byte measurement is invalid");
}

function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function requireCursor(value: string | null): void {
  if (value !== null && (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))) {
    throw new Error("proof snapshot cursor is invalid");
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function requireProfile(profile: BrowserEncryptedWalletBackupProofSnapshotDatabaseProfile): void {
  if (
    !(profile.database instanceof Dexie) ||
    typeof profile.scopeId !== "string" ||
    profile.scopeId.length < 1 ||
    profile.database.name !== browserWalletDatabaseName(profile.scopeId) ||
    typeof profile.snapshotId !== "string" ||
    profile.snapshotId.length < 1 ||
    !Number.isSafeInteger(profile.snapshotRevision) ||
    profile.snapshotRevision < 0
  ) {
    throw new Error("proof snapshot database profile is invalid");
  }
}
