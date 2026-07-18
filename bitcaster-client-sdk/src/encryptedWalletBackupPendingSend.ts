import { hexToBytes } from "@noble/hashes/utils.js";
import { classifyCashuSecret } from "./cashuProofArtifact.ts";
import {
  deriveDurableCustodyArtifactFingerprint,
  type DurableCustodyState,
} from "./durableCustody.ts";
import { encodeCanonicalBackupCbor } from "./encryptedWalletBackupCbor.ts";
import {
  classifyDurableBearerSpendCustodyHandoffPlan,
  decodeDurableBearerSpendDeliveryRecord,
  deriveDurableBearerSpendDeliveryRecordFingerprint,
  encodeDurableBearerSpendDeliveryRecord,
  requireDurableBearerSpendOriginalProofLineage,
  rehydrateDurableBearerSpendCustodyHandoffPlan,
  type DurableBearerSpendCustodyHandoffPlan,
  type DurableBearerSpendDeliveryRecord,
} from "./durableBearerSpendDelivery.ts";
import {
  decodeDurableWalletOperation,
  deriveDurableWalletOperationAuthority,
  type DurableWalletSendOperation,
} from "./durableWalletOperation.ts";
import type { DurableWalletSendExactPayload } from "./durableWalletSendExactPayload.ts";
import {
  describeDurableWalletSendExactPayload,
  rehydrateDurableWalletSendExactPayload,
} from "./durableWalletSendExactPayload.ts";
import { requireDurableWalletSendExactPayloadCapability } from "./durableWalletSendExactPayloadAuthority.ts";
import {
  describeDurableWalletSendToken,
  requireExactDurableWalletSendToken,
} from "./durableWalletSendDelivery.ts";
import {
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD,
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD,
  issuePreparedEncryptedWalletBackupRecord,
  type PreparedEncryptedWalletBackupRecord,
} from "./encryptedWalletBackupRecord.ts";
import type { EncryptedWalletBackupKeyHandle } from "./encryptedWalletBackup.ts";
import {
  decodeEncryptedWalletBackupPendingSendParentPayload,
  derivePendingSendLogicalRecordId,
  derivePendingSendParentCommitment,
  derivePendingSendParentFragmentCommitment,
  derivePendingSendParentFragmentRecordId,
  encodeEncryptedWalletBackupPendingSendParentArtifact,
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES,
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT,
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
  projectEncryptedWalletBackupPendingSendOperation,
  validateEncryptedWalletBackupPendingSendParentFragments,
  type DecodedEncryptedWalletBackupPendingSendParentFragment,
  type EncryptedWalletBackupPendingSendOperation,
} from "./encryptedWalletBackupPendingSendParentCodec.ts";
import {
  decodeEncryptedWalletBackupPendingSendProgressionPayload,
  derivePendingSendProgressionCommitment,
  derivePendingSendProgressionFragmentCommitment,
  derivePendingSendProgressionFragmentRecordId,
  encodePendingSendProgressionCode,
  validateEncryptedWalletBackupPendingSendProgressionFragments,
  type DecodedEncryptedWalletBackupPendingSendProgressionFragment,
  type EncryptedWalletBackupPendingSendChildProgression,
} from "./encryptedWalletBackupPendingSendProgressionCodec.ts";
import { requireEncryptedWalletBackupKeyWalletId } from "./encryptedWalletBackupKeyAuthority.ts";

export {
  decodeEncryptedWalletBackupPendingSendParentFragment,
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES,
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT,
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
  type DecodedEncryptedWalletBackupPendingSendParentFragment,
  type EncryptedWalletBackupPendingSendOperation,
} from "./encryptedWalletBackupPendingSendParentCodec.ts";
export {
  decodeEncryptedWalletBackupPendingSendProgressionFragment,
  type DecodedEncryptedWalletBackupPendingSendProgressionFragment,
  type EncryptedWalletBackupPendingSendChildProgression,
} from "./encryptedWalletBackupPendingSendProgressionCodec.ts";

const MAX_FRAGMENT_COUNT =
  ENCRYPTED_WALLET_BACKUP_PENDING_SEND_MAX_FRAGMENT_COUNT;
const IDENTIFIER_MAX_BYTES = 512;

export type EncryptedWalletBackupPendingSendProgression =
  | "parent"
  | EncryptedWalletBackupPendingSendChildProgression;

export interface EncryptedWalletBackupCommittedPendingSendSnapshot {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly revision: number;
  readonly recordId: string;
  readonly progression: EncryptedWalletBackupPendingSendProgression;
  readonly parentCommitment: string | null;
  readonly walletOperation: unknown;
  readonly walletResultGroups: unknown;
  readonly exactPayloadMetadata: unknown;
  readonly previousCustodyState: DurableCustodyState;
  readonly handoffPlan: DurableBearerSpendCustodyHandoffPlan;
  readonly deliveryRecord: unknown;
  readonly encodedToken: string;
}

export interface EncryptedWalletBackupPendingSendSnapshotStore {
  withCommittedPendingSendSnapshot<T>(
    recordId: string,
    read: (row: EncryptedWalletBackupCommittedPendingSendSnapshot) => T,
  ): Promise<T>;
}

export interface PreparedEncryptedWalletBackupPendingSendParent {
  readonly logicalRecordId: string;
  readonly parentCommitment: string;
  readonly fragmentCount: number;
  readonly records: readonly PreparedEncryptedWalletBackupPendingSendParentFragment[];
}

export interface PreparedEncryptedWalletBackupPendingSendParentFragment extends PreparedEncryptedWalletBackupRecord {
  readonly recordId: string;
  readonly commitment: string;
  readonly recordKindCode: typeof ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD;
}

export interface PreparedEncryptedWalletBackupPendingSendProgression {
  readonly logicalRecordId: string;
  readonly parentCommitment: string;
  readonly progression: EncryptedWalletBackupPendingSendChildProgression;
  readonly childCommitment: string;
  readonly fragmentCount: number;
  readonly records: readonly PreparedEncryptedWalletBackupPendingSendProgressionFragment[];
}

export interface PreparedEncryptedWalletBackupPendingSendProgressionFragment extends PreparedEncryptedWalletBackupRecord {
  readonly recordId: string;
  readonly commitment: string;
  readonly recordKindCode: typeof ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD;
}

export interface RestoredEncryptedWalletBackupPendingSendParent {
  readonly recordId: string;
  readonly logicalRecordId: string;
  readonly parentCommitment: string;
  readonly walletOperation: EncryptedWalletBackupPendingSendOperation;
  readonly deliveryRecord: DurableBearerSpendDeliveryRecord;
  readonly encodedToken: string;
}

export interface RestoredEncryptedWalletBackupPendingSendProgression {
  readonly recordId: string;
  readonly logicalRecordId: string;
  readonly parentCommitment: string;
  readonly progression: EncryptedWalletBackupPendingSendChildProgression;
  readonly childCommitment: string;
  readonly deliveryRecord: DurableBearerSpendDeliveryRecord;
}

export interface RestoredEncryptedWalletBackupPendingSend {
  readonly parent: RestoredEncryptedWalletBackupPendingSendParent;
  readonly progression: RestoredEncryptedWalletBackupPendingSendProgression | null;
  readonly deliveryRecord: DurableBearerSpendDeliveryRecord;
}

export function deriveEncryptedWalletBackupPendingSendRecordId(input: {
  readonly walletId: string;
  readonly parentOperationId: string;
  readonly deliveryId: string;
}): string {
  return deriveDurableCustodyArtifactFingerprint({
    domain: "encrypted-wallet-backup-pending-send-record/v1",
    walletId: requireFingerprint(input.walletId, "pending-send wallet id"),
    parentOperationId: requireIdentifier(
      input.parentOperationId,
      "pending-send parent operation id",
    ),
    deliveryId: requireIdentifier(input.deliveryId, "pending-send delivery id"),
  });
}

interface ValidatedPendingSendSnapshot {
  readonly recordId: string;
  readonly snapshotId: string;
  readonly revision: number;
  readonly walletOperation: DurableWalletSendOperation;
  readonly exactPayloadMetadata: ReturnType<
    typeof describeDurableWalletSendExactPayload
  >;
  readonly deliveryRecord: DurableBearerSpendDeliveryRecord;
  readonly encodedToken: string;
}

export async function prepareEncryptedWalletBackupPendingSendParent(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly recordId: string;
  readonly snapshotStore: EncryptedWalletBackupPendingSendSnapshotStore;
}): Promise<PreparedEncryptedWalletBackupPendingSendParent> {
  return withCommittedSnapshot(input, (row) => {
    if (row.progression !== "parent" || row.parentCommitment !== null) {
      throw new Error("pending-send parent snapshot is invalid");
    }
    const snapshot = validateSnapshot(row, input.keyHandle, input.recordId);
    requireInitialParentState(snapshot.deliveryRecord);
    const fragments = prepareParentFragments(snapshot);
    const parentCommitment = derivePendingSendParentCommitment(
      fragments[0]!.logicalRecordId,
      fragments.map(({ commitment }) => commitment),
    );
    const records = Object.freeze(
      fragments.map((fragment) =>
        issueParentFragmentRecord(
          input.keyHandle,
          snapshot,
          fragment,
          parentCommitment,
        ),
      ),
    );
    return Object.freeze({
      logicalRecordId: fragments[0]!.logicalRecordId,
      parentCommitment,
      fragmentCount: records.length,
      records,
    });
  });
}

export async function prepareEncryptedWalletBackupPendingSendProgression(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly recordId: string;
  readonly snapshotStore: EncryptedWalletBackupPendingSendSnapshotStore;
}): Promise<PreparedEncryptedWalletBackupPendingSendProgression> {
  return withCommittedSnapshot(input, (row) => {
    if (row.progression === "parent" || row.parentCommitment === null) {
      throw new Error("pending-send progression snapshot is invalid");
    }
    const snapshot = validateProgressionSnapshot(
      row,
      input.keyHandle,
      input.recordId,
    );
    const drafts = prepareProgressionFragments(
      snapshot,
      row.parentCommitment,
      row.progression,
    );
    const childCommitment = derivePendingSendProgressionCommitment({
      logicalRecordId: drafts[0]!.logicalRecordId,
      parentCommitment: row.parentCommitment,
      progression: row.progression,
      fragmentCommitments: drafts.map(({ commitment }) => commitment),
    });
    const records = drafts.map((draft) =>
      issueProgressionFragmentRecord({
        keyHandle: input.keyHandle,
        snapshot,
        draft,
        childCommitment,
      }),
    );
    return Object.freeze({
      logicalRecordId: drafts[0]!.logicalRecordId,
      parentCommitment: row.parentCommitment,
      progression: row.progression,
      childCommitment,
      fragmentCount: records.length,
      records: Object.freeze(records),
    });
  });
}

export function aggregateEncryptedWalletBackupPendingSendParentFragments(
  fragments: readonly DecodedEncryptedWalletBackupPendingSendParentFragment[],
): RestoredEncryptedWalletBackupPendingSendParent {
  const verified =
    validateEncryptedWalletBackupPendingSendParentFragments(fragments);
  const payload = decodeEncryptedWalletBackupPendingSendParentPayload(
    verified.payload,
  );
  if (
    derivePendingSendLogicalRecordId(payload.recordId) !==
    verified.logicalRecordId
  ) {
    throw new Error("pending-send logical record id is invalid");
  }
  validateRestoredParent(payload);
  return Object.freeze({
    recordId: payload.recordId,
    logicalRecordId: verified.logicalRecordId,
    parentCommitment: verified.parentCommitment,
    walletOperation: payload.walletOperation,
    deliveryRecord: payload.deliveryRecord,
    encodedToken: payload.encodedToken,
  });
}

export function aggregateEncryptedWalletBackupPendingSendProgressionFragments(
  fragments: readonly DecodedEncryptedWalletBackupPendingSendProgressionFragment[],
): RestoredEncryptedWalletBackupPendingSendProgression {
  const verified =
    validateEncryptedWalletBackupPendingSendProgressionFragments(fragments);
  const payload = decodeEncryptedWalletBackupPendingSendProgressionPayload(
    verified.payload,
  );
  if (
    derivePendingSendLogicalRecordId(payload.recordId) !==
    verified.logicalRecordId
  ) {
    throw new Error("pending-send progression logical record id is invalid");
  }
  requireProgressionState(verified.progression, payload.deliveryRecord);
  return Object.freeze({
    recordId: payload.recordId,
    logicalRecordId: verified.logicalRecordId,
    parentCommitment: verified.parentCommitment,
    progression: verified.progression,
    childCommitment: verified.childCommitment,
    deliveryRecord: payload.deliveryRecord,
  });
}

export function bindEncryptedWalletBackupPendingSendRestore(input: {
  readonly parent: RestoredEncryptedWalletBackupPendingSendParent;
  readonly progression: RestoredEncryptedWalletBackupPendingSendProgression | null;
}): RestoredEncryptedWalletBackupPendingSend {
  const parent = input.parent;
  if (input.progression === null) {
    return Object.freeze({
      parent,
      progression: null,
      deliveryRecord: restoredParentDelivery(parent.deliveryRecord),
    });
  }
  requireProgressionParentBinding(parent, input.progression);
  const progression = restoredProgression(input.progression);
  return Object.freeze({
    parent,
    progression,
    deliveryRecord: progression.deliveryRecord,
  });
}

function restoredProgression(
  progression: RestoredEncryptedWalletBackupPendingSendProgression,
): RestoredEncryptedWalletBackupPendingSendProgression {
  switch (progression.progression) {
    case "cancellation-intent":
    case "partial":
      return Object.freeze({
        ...progression,
        deliveryRecord: Object.freeze({
          ...progression.deliveryRecord,
          origin: "restored" as const,
        }),
      });
    case "recipient-finalization":
    case "reclaim-completion":
      return progression;
  }
}

async function withCommittedSnapshot<T>(
  input: {
    readonly recordId: string;
    readonly snapshotStore: EncryptedWalletBackupPendingSendSnapshotStore;
  },
  prepare: (row: EncryptedWalletBackupCommittedPendingSendSnapshot) => T,
): Promise<T> {
  const recordId = requireIdentifier(input.recordId, "pending-send record id");
  if (
    input.snapshotStore === null ||
    typeof input.snapshotStore !== "object" ||
    typeof input.snapshotStore.withCommittedPendingSendSnapshot !== "function"
  ) {
    throw new Error("pending-send snapshot store is invalid");
  }
  let callbackOpen = true;
  let callbackCount = 0;
  let issued: T | undefined;
  let returned: T;
  try {
    returned = await input.snapshotStore.withCommittedPendingSendSnapshot(
      recordId,
      (row) => {
        if (!callbackOpen || callbackCount++ !== 0) {
          throw new Error("pending-send snapshot callback is invalid");
        }
        issued = prepare(row);
        return issued;
      },
    );
  } finally {
    callbackOpen = false;
  }
  if (issued === undefined || returned !== issued || callbackCount !== 1) {
    throw new Error(
      "pending-send snapshot transaction must be synchronous and exact",
    );
  }
  return issued;
}

function validateSnapshot(
  row: EncryptedWalletBackupCommittedPendingSendSnapshot,
  keyHandle: EncryptedWalletBackupKeyHandle,
  requestedRecordId: string,
): ValidatedPendingSendSnapshot {
  const decoded = decodePendingSendSnapshot(row);
  const { recordId, walletOperation, deliveryRecord } = decoded;
  requireStableSnapshotIdentity({
    keyHandle,
    requestedRecordId,
    recordId,
    walletOperation,
    deliveryRecord,
    previousCustodyState: row.previousCustodyState,
    handoffPlan: row.handoffPlan,
  });
  const exactPayload = rehydrateDurableWalletSendExactPayload({
    metadata: row.exactPayloadMetadata,
    walletOperation,
    resultGroups: row.walletResultGroups,
    encodedToken: row.encodedToken,
  });
  const payload = requireDurableWalletSendExactPayloadCapability(exactPayload);
  const exactPayloadMetadata =
    describeDurableWalletSendExactPayload(exactPayload);
  requireExactPayloadBinding({ row, walletOperation, deliveryRecord, payload });
  requireCustodyHandoffBinding(row, deliveryRecord, exactPayload);
  return {
    ...decoded,
    exactPayloadMetadata,
    encodedToken: row.encodedToken,
  };
}

function validateProgressionSnapshot(
  row: EncryptedWalletBackupCommittedPendingSendSnapshot,
  keyHandle: EncryptedWalletBackupKeyHandle,
  requestedRecordId: string,
): ValidatedPendingSendSnapshot {
  if (row.progression === "parent") {
    throw new Error("pending-send progression snapshot is invalid");
  }
  const decoded = decodePendingSendSnapshot(row);
  const initialRecord = decodeDurableBearerSpendDeliveryRecord(
    row.handoffPlan.bearerRecord,
  );
  requireInitialParentState(initialRecord);
  requireStableSnapshotIdentity({
    keyHandle,
    requestedRecordId,
    recordId: decoded.recordId,
    walletOperation: decoded.walletOperation,
    deliveryRecord: initialRecord,
    previousCustodyState: row.previousCustodyState,
    handoffPlan: row.handoffPlan,
  });
  const exactPayload = rehydrateDurableWalletSendExactPayload({
    metadata: row.exactPayloadMetadata,
    walletOperation: decoded.walletOperation,
    resultGroups: row.walletResultGroups,
    encodedToken: row.encodedToken,
  });
  const payload = requireDurableWalletSendExactPayloadCapability(exactPayload);
  requireExactPayloadBinding({
    row,
    walletOperation: decoded.walletOperation,
    deliveryRecord: initialRecord,
    payload,
  });
  requireCustodyHandoffBinding(row, initialRecord, exactPayload);
  requireProgressionParentRecordBinding(initialRecord, decoded.deliveryRecord);
  requireProgressionState(row.progression, decoded.deliveryRecord);
  return {
    ...decoded,
    exactPayloadMetadata: describeDurableWalletSendExactPayload(exactPayload),
    encodedToken: row.encodedToken,
  };
}

function decodePendingSendSnapshot(
  row: EncryptedWalletBackupCommittedPendingSendSnapshot,
): Pick<
  ValidatedPendingSendSnapshot,
  "recordId" | "snapshotId" | "revision" | "walletOperation" | "deliveryRecord"
> {
  if (
    row === null ||
    typeof row !== "object" ||
    row.schemaVersion !== 1 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 0
  ) {
    throw new Error("pending-send snapshot is invalid");
  }
  const snapshotId = requireIdentifier(row.snapshotId, "snapshot id");
  const recordId = requireIdentifier(row.recordId, "pending-send record id");
  const walletOperation = decodeDurableWalletOperation(row.walletOperation);
  if (walletOperation.kind !== "wallet-send") {
    throw new Error("pending-send wallet operation is invalid");
  }
  requireOrdinaryOperation(walletOperation);
  const deliveryRecord = decodeDurableBearerSpendDeliveryRecord(
    row.deliveryRecord,
  );
  requireOrdinaryDelivery(deliveryRecord);
  return {
    recordId,
    snapshotId,
    revision: row.revision,
    walletOperation,
    deliveryRecord,
  };
}

function requireStableSnapshotIdentity(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly requestedRecordId: string;
  readonly recordId: string;
  readonly walletOperation: DurableWalletSendOperation;
  readonly deliveryRecord: DurableBearerSpendDeliveryRecord;
  readonly previousCustodyState: DurableCustodyState;
  readonly handoffPlan: DurableBearerSpendCustodyHandoffPlan;
}): void {
  const walletId = requireEncryptedWalletBackupKeyWalletId(input.keyHandle);
  const expectedRecordId = deriveEncryptedWalletBackupPendingSendRecordId({
    walletId,
    parentOperationId: input.deliveryRecord.parentOperationId,
    deliveryId: input.deliveryRecord.deliveryId,
  });
  if (
    input.requestedRecordId !== expectedRecordId ||
    input.recordId !== expectedRecordId ||
    input.deliveryRecord.walletId !== walletId ||
    input.walletOperation.operationId !==
      input.previousCustodyState.operation.operation.retainedOperationKey ||
    input.deliveryRecord.parentOperationId !==
      input.previousCustodyState.operation.operation.operationId ||
    !custodyStateUsesWallet(input.previousCustodyState, walletId) ||
    !custodyStateUsesWallet(input.handoffPlan.custodyState, walletId)
  ) {
    throw new Error("pending-send snapshot identity is invalid");
  }
}

function custodyStateUsesWallet(
  state: DurableCustodyState,
  walletId: string,
): boolean {
  return (
    state.operation.scope.scopeKind === "wallet" &&
    state.operation.scope.walletId === walletId &&
    state.scopeState.scope.scopeKind === "wallet" &&
    state.scopeState.scope.walletId === walletId &&
    state.operation.scope.scopeId === state.scopeState.scope.scopeId
  );
}

function requireExactPayloadBinding(input: {
  readonly row: EncryptedWalletBackupCommittedPendingSendSnapshot;
  readonly walletOperation: DurableWalletSendOperation;
  readonly deliveryRecord: DurableBearerSpendDeliveryRecord;
  readonly payload: ReturnType<
    typeof requireDurableWalletSendExactPayloadCapability
  >;
}): void {
  const { row, walletOperation, deliveryRecord, payload } = input;
  const operationAuthority =
    deriveDurableWalletOperationAuthority(walletOperation);
  if (
    payload.policyKind !== "user-export" ||
    payload.walletOperationId !== walletOperation.operationId ||
    payload.walletRequestFingerprint !==
      operationAuthority.requestFingerprint ||
    payload.walletOutputPlanFingerprint !==
      operationAuthority.outputPlanFingerprint ||
    payload.encodedToken !== row.encodedToken ||
    payload.tokenDigest !== deliveryRecord.tokenDigest ||
    payload.encodedTokenBytes !== deliveryRecord.tokenByteLength ||
    payload.payloadHandle !== deliveryRecord.payloadHandle ||
    payload.mintUrl !== deliveryRecord.mintUrl ||
    payload.unit !== deliveryRecord.unit
  ) {
    throw new Error("pending-send exact payload is invalid");
  }
}

function requireCustodyHandoffBinding(
  row: EncryptedWalletBackupCommittedPendingSendSnapshot,
  deliveryRecord: DurableBearerSpendDeliveryRecord,
  exactPayload: DurableWalletSendExactPayload,
): void {
  const handoffPlan = rehydrateDurableBearerSpendCustodyHandoffPlan({
    bearerRecord: deliveryRecord,
    previousCustodyState: row.previousCustodyState,
    exactPayload,
    persistedPlan: row.handoffPlan,
  });
  if (
    classifyDurableBearerSpendCustodyHandoffPlan({
      previousCustodyState: row.previousCustodyState,
      plan: handoffPlan,
    }) !== "reconciliation-only" ||
    deriveDurableBearerSpendDeliveryRecordFingerprint(
      handoffPlan.bearerRecord,
    ) !== deriveDurableBearerSpendDeliveryRecordFingerprint(deliveryRecord)
  ) {
    throw new Error("pending-send custody handoff is invalid");
  }
}

interface PendingSendParentFragmentDraft {
  readonly logicalRecordId: string;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly totalBytes: number;
  readonly fragment: Uint8Array;
  readonly commitment: string;
}

function prepareParentFragments(
  snapshot: ValidatedPendingSendSnapshot,
): readonly PendingSendParentFragmentDraft[] {
  const logicalRecordId = derivePendingSendLogicalRecordId(snapshot.recordId);
  const payload = encodeParentPayload(snapshot);
  return fragmentParentPayload(logicalRecordId, payload);
}

function encodeParentPayload(
  snapshot: ValidatedPendingSendSnapshot,
): Uint8Array {
  return encodeCanonicalBackupCbor([
    1,
    snapshot.recordId,
    encodeEncryptedWalletBackupPendingSendParentArtifact(
      projectEncryptedWalletBackupPendingSendOperation(
        snapshot.walletOperation,
      ),
      "wallet operation",
    ),
    encodeEncryptedWalletBackupPendingSendParentArtifact(
      snapshot.exactPayloadMetadata,
      "exact payload",
    ),
    encodeDurableBearerSpendDeliveryRecord(
      snapshot.deliveryRecord,
      ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
    ),
    new TextEncoder().encode(snapshot.encodedToken),
    snapshot.deliveryRecord.proofEntries.map((entry) =>
      entry.kind === "active" ? entry.proof.secret : entry.Y,
    ),
  ]);
}

function fragmentParentPayload(
  logicalRecordId: string,
  payload: Uint8Array,
): readonly PendingSendParentFragmentDraft[] {
  const fragmentCount = Math.ceil(
    payload.byteLength / ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES,
  );
  if (fragmentCount < 1 || fragmentCount > MAX_FRAGMENT_COUNT) {
    throw new Error("pending-send fragment count is invalid");
  }
  return Array.from({ length: fragmentCount }, (_, fragmentIndex) => {
    const start =
      fragmentIndex * ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES;
    const fragment = payload.slice(
      start,
      start + ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES,
    );
    if (
      fragment.byteLength < 1 ||
      (fragmentIndex + 1 < fragmentCount &&
        fragment.byteLength !==
          ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES)
    ) {
      throw new Error("pending-send fragment length is invalid");
    }
    const commitment = derivePendingSendParentFragmentCommitment({
      logicalRecordId,
      fragmentIndex,
      fragmentCount,
      totalBytes: payload.byteLength,
      fragment,
    });
    return {
      logicalRecordId,
      fragmentIndex,
      fragmentCount,
      totalBytes: payload.byteLength,
      fragment,
      commitment,
    };
  });
}

function issueParentFragmentRecord(
  keyHandle: EncryptedWalletBackupKeyHandle,
  snapshot: ValidatedPendingSendSnapshot,
  fragment: PendingSendParentFragmentDraft,
  parentCommitment: string,
): PreparedEncryptedWalletBackupPendingSendParentFragment {
  const recordId = derivePendingSendParentFragmentRecordId(
    fragment.logicalRecordId,
    fragment.fragmentIndex,
  );
  const canonicalRecord = encodeCanonicalBackupCbor([
    1,
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD,
    hexToBytes(recordId),
    hexToBytes(fragment.commitment),
    hexToBytes(fragment.logicalRecordId),
    hexToBytes(parentCommitment),
    fragment.fragmentIndex,
    fragment.fragmentCount,
    fragment.totalBytes,
    fragment.fragment,
  ]);
  const handle = Object.freeze({
    recordId,
    commitment: fragment.commitment,
    recordKindCode: ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD,
  });
  return issuePreparedEncryptedWalletBackupRecord(handle, {
    recordId,
    commitment: fragment.commitment,
    recordKindCode: ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD,
    keyHandle,
    canonicalRecord,
    snapshotId: snapshot.snapshotId,
    snapshotRevision: snapshot.revision,
    manifestEntry: [
      ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_FRAGMENT_RECORD,
      hexToBytes(recordId),
      hexToBytes(fragment.commitment),
      hexToBytes(fragment.logicalRecordId),
      hexToBytes(parentCommitment),
      fragment.fragmentIndex,
      fragment.fragmentCount,
    ],
  });
}

interface PendingSendProgressionFragmentDraft {
  readonly logicalRecordId: string;
  readonly parentCommitment: string;
  readonly progression: EncryptedWalletBackupPendingSendChildProgression;
  readonly fragmentIndex: number;
  readonly fragmentCount: number;
  readonly totalBytes: number;
  readonly fragment: Uint8Array;
  readonly commitment: string;
}

function prepareProgressionFragments(
  snapshot: ValidatedPendingSendSnapshot,
  parentCommitment: string,
  progression: EncryptedWalletBackupPendingSendChildProgression,
): readonly PendingSendProgressionFragmentDraft[] {
  const logicalRecordId = derivePendingSendLogicalRecordId(snapshot.recordId);
  const payload = encodeCanonicalBackupCbor([
    1,
    snapshot.recordId,
    encodeDurableBearerSpendDeliveryRecord(
      snapshot.deliveryRecord,
      ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PARENT_BYTES_MAX,
    ),
  ]);
  const fragmentCount = Math.ceil(
    payload.byteLength / ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES,
  );
  if (fragmentCount < 1 || fragmentCount > MAX_FRAGMENT_COUNT) {
    throw new Error("pending-send progression fragment count is invalid");
  }
  return Array.from({ length: fragmentCount }, (_, fragmentIndex) => {
    const start =
      fragmentIndex * ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES;
    const fragment = payload.slice(
      start,
      start + ENCRYPTED_WALLET_BACKUP_PENDING_SEND_FRAGMENT_BYTES,
    );
    const draft = {
      logicalRecordId,
      parentCommitment,
      progression,
      fragmentIndex,
      fragmentCount,
      totalBytes: payload.byteLength,
      fragment,
    };
    return {
      ...draft,
      commitment: derivePendingSendProgressionFragmentCommitment(draft),
    };
  });
}

function issueProgressionFragmentRecord(input: {
  readonly keyHandle: EncryptedWalletBackupKeyHandle;
  readonly snapshot: ValidatedPendingSendSnapshot;
  readonly draft: PendingSendProgressionFragmentDraft;
  readonly childCommitment: string;
}): PreparedEncryptedWalletBackupPendingSendProgressionFragment {
  const { draft } = input;
  const recordId = derivePendingSendProgressionFragmentRecordId(draft);
  const canonicalRecord = encodeCanonicalBackupCbor([
    1,
    ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD,
    hexToBytes(recordId),
    hexToBytes(draft.commitment),
    hexToBytes(draft.logicalRecordId),
    hexToBytes(draft.parentCommitment),
    encodePendingSendProgressionCode(draft.progression),
    hexToBytes(input.childCommitment),
    draft.fragmentIndex,
    draft.fragmentCount,
    draft.totalBytes,
    draft.fragment,
  ]);
  const handle = Object.freeze({
    recordId,
    commitment: draft.commitment,
    recordKindCode: ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD,
  });
  return issuePreparedEncryptedWalletBackupRecord(handle, {
    ...handle,
    keyHandle: input.keyHandle,
    canonicalRecord,
    snapshotId: input.snapshot.snapshotId,
    snapshotRevision: input.snapshot.revision,
    manifestEntry: [
      ENCRYPTED_WALLET_BACKUP_PENDING_SEND_PROGRESSION_RECORD,
      hexToBytes(recordId),
      hexToBytes(draft.commitment),
      hexToBytes(draft.logicalRecordId),
      hexToBytes(draft.parentCommitment),
      encodePendingSendProgressionCode(draft.progression),
      hexToBytes(input.childCommitment),
      draft.fragmentIndex,
      draft.fragmentCount,
    ],
  });
}

function validateRestoredParent(
  input: ReturnType<typeof decodeEncryptedWalletBackupPendingSendParentPayload>,
): void {
  requireOrdinaryProjectedOperation(input.walletOperation);
  requireOrdinaryDelivery(input.deliveryRecord);
  requireInitialParentState(input.deliveryRecord);
  const descriptor = describeDurableWalletSendToken(input.encodedToken);
  const activeProofs = input.deliveryRecord.proofEntries.map((entry) => {
    if (entry.kind !== "active")
      throw new Error("pending-send parent state is invalid");
    return entry.proof;
  });
  const stableRecordId = deriveEncryptedWalletBackupPendingSendRecordId({
    walletId: input.deliveryRecord.walletId,
    parentOperationId: input.deliveryRecord.parentOperationId,
    deliveryId: input.deliveryRecord.deliveryId,
  });
  requireExactDurableWalletSendToken({
    encodedToken: input.encodedToken,
    mintUrl: input.deliveryRecord.mintUrl,
    unit: input.deliveryRecord.unit,
    sendProofs: activeProofs,
  });
  if (
    input.recordId !== stableRecordId ||
    input.exactPayloadMetadata.walletOperationId !==
      input.walletOperation.operationId ||
    input.exactPayloadMetadata.walletRequestFingerprint !==
      input.walletOperation.requestFingerprint ||
    input.exactPayloadMetadata.walletOutputPlanFingerprint !==
      input.walletOperation.outputPlanFingerprint ||
    input.exactPayloadMetadata.payloadHandle !==
      input.deliveryRecord.payloadHandle ||
    input.exactPayloadMetadata.tokenDigest !== descriptor.tokenDigest ||
    input.exactPayloadMetadata.encodedTokenBytes !== descriptor.byteLength ||
    input.exactPayloadMetadata.mintUrl !== input.deliveryRecord.mintUrl ||
    input.exactPayloadMetadata.unit !== input.deliveryRecord.unit ||
    input.proofOrder.some((item, index) => item !== activeProofs[index]!.secret)
  ) {
    throw new Error("pending-send parent binding is invalid");
  }
}

function requireProgressionParentBinding(
  parent: RestoredEncryptedWalletBackupPendingSendParent,
  progression: RestoredEncryptedWalletBackupPendingSendProgression,
): void {
  if (
    progression.recordId !== parent.recordId ||
    progression.logicalRecordId !== parent.logicalRecordId ||
    progression.parentCommitment !== parent.parentCommitment
  ) {
    throw new Error("pending-send progression parent binding is invalid");
  }
  requireProgressionParentRecordBinding(
    parent.deliveryRecord,
    progression.deliveryRecord,
  );
  requireProgressionState(progression.progression, progression.deliveryRecord);
}

function requireProgressionParentRecordBinding(
  parent: DurableBearerSpendDeliveryRecord,
  progression: DurableBearerSpendDeliveryRecord,
): void {
  requireOrdinaryDelivery(progression);
  const originalProofs = parent.proofEntries.map((entry) => {
    if (entry.kind !== "active") {
      throw new Error("pending-send progression parent is invalid");
    }
    return entry.proof;
  });
  requireDurableBearerSpendOriginalProofLineage(progression, originalProofs);
  const immutableFieldsMatch =
    progression.deliveryId === parent.deliveryId &&
    progression.walletId === parent.walletId &&
    progression.parentOperationId === parent.parentOperationId &&
    progression.payloadHandle === parent.payloadHandle &&
    progression.mintUrl === parent.mintUrl &&
    progression.unit === parent.unit &&
    progression.tokenDigest === parent.tokenDigest &&
    progression.tokenByteLength === parent.tokenByteLength &&
    progression.createdAtMs === parent.createdAtMs &&
    progression.origin === "local";
  if (!immutableFieldsMatch) {
    throw new Error("pending-send progression delivery binding is invalid");
  }
}

function requireProgressionState(
  progression: EncryptedWalletBackupPendingSendChildProgression,
  record: DurableBearerSpendDeliveryRecord,
): void {
  switch (progression) {
    case "cancellation-intent":
      if (
        record.state.kind !== "pending" ||
        record.reclaim.kind !== "prepared"
      ) {
        throw new Error("pending-send cancellation intent is invalid");
      }
      return;
    case "partial":
      if (
        record.state.kind !== "pending" ||
        record.state.classification !== "mixed" ||
        record.state.proofStates === null ||
        !record.state.proofStates.includes("SPENT") ||
        !record.state.proofStates.includes("UNSPENT") ||
        record.reclaim.kind !== "none"
      ) {
        throw new Error("pending-send partial state is invalid");
      }
      return;
    case "recipient-finalization":
      if (
        record.state.kind !== "consumed" ||
        record.state.actor !== "recipient" ||
        (record.reclaim.kind !== "none" && record.reclaim.kind !== "prepared")
      ) {
        throw new Error("pending-send recipient finalization is invalid");
      }
      return;
    case "reclaim-completion":
      if (
        record.state.kind !== "consumed" ||
        record.state.actor !== "sender-reclaim" ||
        record.reclaim.kind !== "completed"
      ) {
        throw new Error("pending-send reclaim completion is invalid");
      }
      return;
    default:
      return assertNeverProgression(progression);
  }
}

function restoredParentDelivery(
  record: DurableBearerSpendDeliveryRecord,
): DurableBearerSpendDeliveryRecord {
  return decodeDurableBearerSpendDeliveryRecord({
    ...record,
    origin: "restored",
  });
}

function requireInitialParentState(
  record: DurableBearerSpendDeliveryRecord,
): void {
  if (
    record.origin !== "local" ||
    record.reclaim.kind !== "none" ||
    record.state.kind !== "pending" ||
    record.state.classification !== "unverified" ||
    record.state.proofStates !== null ||
    record.proofEntries.some((entry) => entry.kind !== "active")
  ) {
    throw new Error("pending-send parent state is invalid");
  }
}

function requireOrdinaryOperation(operation: DurableWalletSendOperation): void {
  requireOrdinaryOperationArtifacts({
    proofs: [
      ...operation.preview.inputs,
      ...operation.preview.unselectedProofs,
    ],
    outputs: [
      ...operation.preview.sendOutputs,
      ...operation.preview.keepOutputs,
    ],
  });
}

function requireOrdinaryProjectedOperation(
  operation: EncryptedWalletBackupPendingSendOperation,
): void {
  requireOrdinaryOperationArtifacts({
    proofs: operation.preview.inputs,
    outputs: [
      ...operation.preview.sendOutputs,
      ...operation.preview.keepOutputs,
    ],
  });
}

function requireOrdinaryOperationArtifacts(input: {
  readonly proofs: readonly Readonly<{
    id: string;
    secret: string;
    witness: string | null;
    p2pkE: string | null;
  }>[];
  readonly outputs: readonly Readonly<{
    blindedMessage: Readonly<{ id: string }>;
    secret: string;
    ephemeralE: string | null;
  }>[];
}): void {
  if (
    input.proofs.some(
      (proof) =>
        isConditionalKeysetId(proof.id) ||
        classifyCashuSecret(proof.secret) === "conditional" ||
        proof.witness !== null ||
        proof.p2pkE !== null,
    ) ||
    input.outputs.some(
      (output) =>
        isConditionalKeysetId(output.blindedMessage.id) ||
        classifyOutputSecret(output.secret) === "conditional" ||
        output.ephemeralE !== null,
    )
  ) {
    throw new Error(
      "conditional pending-send operation is not backup eligible",
    );
  }
}

function classifyOutputSecret(secret: string) {
  try {
    return classifyCashuSecret(
      new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(secret)),
    );
  } catch {
    throw new Error("pending-send output secret is invalid");
  }
}

function requireOrdinaryDelivery(
  record: DurableBearerSpendDeliveryRecord,
): void {
  if (
    record.proofEntries.some(
      (entry) =>
        isConditionalKeysetId(
          entry.kind === "active" ? entry.proof.id : entry.keysetId,
        ) ||
        (entry.kind === "active" &&
          (classifyCashuSecret(entry.proof.secret) === "conditional" ||
            entry.proof.witness !== undefined ||
            entry.proof.p2pk_e !== undefined)),
    )
  ) {
    throw new Error("conditional pending-send record is not backup eligible");
  }
}

function isConditionalKeysetId(value: string): boolean {
  return /^(?:01|02)(?:[0-9a-f]{14}|[0-9a-f]{64})$/i.test(value);
}

function requireIdentifier(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  const length = new TextEncoder().encode(value).byteLength;
  if (length < 1 || length > IDENTIFIER_MAX_BYTES) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertNeverProgression(value: never): never {
  throw new Error(`unhandled pending-send progression: ${String(value)}`);
}
